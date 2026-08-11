/**
 * DAG 调度器
 *
 * 负责任务 DAG 的拓扑排序、就绪节点计算、条件分支评估与状态机推进。
 * 不直接执行 Agent 调用——由 Orchestrator 调用 getReadyNodes() 后
 * 自行调度执行，再通过 markDone / markFailed / markSkipped 回写结果。
 *
 * 设计要点：
 * 1. 拓扑排序基于 Kahn 算法（入度表 + BFS），支持检测环
 * 2. getReadyNodes 返回「依赖全部 success 且自身 pending」的节点
 * 3. 条件分支：依赖完成后由 evaluateConditions 评估，false 则标记 skipped
 * 4. 失败传播：依赖中存在 failed/skipped 时，当前节点默认 skipped
 *    （但若节点 condition 自定义处理则可改为 running）
 * 5. 状态机严格单向：pending → running → success/failed/paused/skipped
 * 6. snapshot 提供实时可观测统计
 */

import type { DAG, SubTask, SubTaskStatus } from './types.js'

// ─────────────────────────────────────────────────────────────
// 调度器异常
// ─────────────────────────────────────────────────────────────

export class DAGErr extends Error {
    constructor(
        public readonly code: 'CYCLE' | 'MISSING_NODE' | 'INVALID_TRANSITION',
        message: string,
    ) {
        super(message)
        this.name = 'DAGErr'
    }
}

// ─────────────────────────────────────────────────────────────
// DAGScheduler
// ─────────────────────────────────────────────────────────────

export class DAGScheduler {
    /** 节点表：taskId -> SubTask（运行时持续更新） */
    private readonly nodes = new Map<string, SubTask>()
    /** 反向索引：taskId -> 直接前驱 taskId 列表 */
    private readonly predecessors = new Map<string, Set<string>>()
    /** 正向索引：taskId -> 直接后继 taskId 列表 */
    private readonly successors = new Map<string, Set<string>>()

    constructor(dag: DAG) {
        // 初始化节点表
        for (const node of dag.nodes) {
            if (this.nodes.has(node.id)) {
                throw new DAGErr('MISSING_NODE', `重复的节点 ID: ${node.id}`)
            }
            // 深拷贝节点，避免外部 mutation 影响调度器状态
            this.nodes.set(node.id, { ...node, dependencies: [...node.dependencies] })
        }

        // 校验依赖项存在性 + 构建前驱/后继索引
        for (const node of dag.nodes) {
            const preds = new Set<string>()
            for (const dep of node.dependencies) {
                if (!this.nodes.has(dep)) {
                    throw new DAGErr(
                        'MISSING_NODE',
                        `节点 ${node.id} 依赖不存在的节点: ${dep}`,
                    )
                }
                preds.add(dep)
            }
            this.predecessors.set(node.id, preds)
        }

        // 构建后继索引
        for (const [nodeId, preds] of this.predecessors) {
            for (const pred of preds) {
                let succs = this.successors.get(pred)
                if (!succs) {
                    succs = new Set<string>()
                    this.successors.set(pred, succs)
                }
                succs.add(nodeId)
            }
        }

        // 环检测：执行拓扑排序，若结果不包含全部节点则存在环
        const sorted = this.topologicalSort()
        if (sorted.length !== this.nodes.size) {
            throw new DAGErr('CYCLE', 'DAG 存在环，无法调度')
        }
    }

    // ─────────────────────────────────────────────────────────
    // 拓扑排序（Kahn 算法）
    // ─────────────────────────────────────────────────────────

    /**
     * 拓扑排序
     *
     * 基于 Kahn 算法：每次取入度为 0 的节点加入结果，
     * 并移除其所有出边。若结果长度 < 节点数则存在环。
     *
     * @returns 拓扑序的 taskId 数组
     */
    topologicalSort(): string[] {
        // 计算入度（基于前驱集合）
        const inDegree = new Map<string, number>()
        for (const [nodeId, preds] of this.predecessors) {
            inDegree.set(nodeId, preds.size)
        }

        // 初始入度为 0 的节点入队
        const queue: string[] = []
        for (const [nodeId, deg] of inDegree) {
            if (deg === 0) queue.push(nodeId)
        }

        const result: string[] = []
        while (queue.length > 0) {
            const current = queue.shift()!
            result.push(current)

            // 移除 current 的所有出边：后继节点入度 -1
            const succs = this.successors.get(current)
            if (succs) {
                for (const succ of succs) {
                    const deg = inDegree.get(succ) ?? 0
                    const newDeg = deg - 1
                    inDegree.set(succ, newDeg)
                    if (newDeg === 0) queue.push(succ)
                }
            }
        }

        return result
    }

    // ─────────────────────────────────────────────────────────
    // 就绪节点计算
    // ─────────────────────────────────────────────────────────

    /**
     * 获取当前可执行的节点
     *
     * 条件：
     * 1. 节点状态为 pending
     * 2. 所有依赖节点状态为 success
     *
     * 注意：依赖中存在 failed/skipped 的节点不返回（由 propagateFailure 处理）
     *
     * @returns 可执行的 SubTask 列表（按拓扑序）
     */
    getReadyNodes(): SubTask[] {
        const ready: SubTask[] = []
        for (const [nodeId, preds] of this.predecessors) {
            const node = this.nodes.get(nodeId)
            if (!node) continue
            if (node.status !== 'pending') continue

            // 检查所有依赖是否成功
            let allDepsSuccess = true
            for (const pred of preds) {
                const predNode = this.nodes.get(pred)
                if (!predNode || predNode.status !== 'success') {
                    allDepsSuccess = false
                    break
                }
            }
            if (allDepsSuccess) {
                ready.push(node)
            }
        }
        // 按拓扑序排序，保证执行顺序稳定
        const order = this.topologicalSort()
        const orderIndex = new Map<string, number>()
        order.forEach((id, idx) => orderIndex.set(id, idx))
        ready.sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))
        return ready
    }

    // ─────────────────────────────────────────────────────────
    // 状态机推进
    // ─────────────────────────────────────────────────────────

    /**
     * 标记节点为 running
     *
     * @throws DAGErr 若节点不存在或状态不允许转换
     */
    markRunning(taskId: string): void {
        const node = this.nodes.get(taskId)
        if (!node) {
            throw new DAGErr('MISSING_NODE', `节点不存在: ${taskId}`)
        }
        if (node.status !== 'pending' && node.status !== 'paused') {
            throw new DAGErr(
                'INVALID_TRANSITION',
                `节点 ${taskId} 当前状态 ${node.status}，无法转为 running`,
            )
        }
        node.status = 'running'
        node.startedAt = node.startedAt ?? Date.now()
    }

    /**
     * 标记节点完成（success）
     */
    markDone(taskId: string, result: unknown): void {
        const node = this.nodes.get(taskId)
        if (!node) {
            throw new DAGErr('MISSING_NODE', `节点不存在: ${taskId}`)
        }
        node.status = 'success'
        node.result = result
        node.endedAt = Date.now()
    }

    /**
     * 标记节点失败（failed）
     *
     * 自动传播失败：依赖此节点的后继节点若状态为 pending，
     * 且未自定义 condition 处理失败，则标记为 skipped。
     */
    markFailed(taskId: string, error: string): void {
        const node = this.nodes.get(taskId)
        if (!node) {
            throw new DAGErr('MISSING_NODE', `节点不存在: ${taskId}`)
        }
        node.status = 'failed'
        node.error = error
        node.endedAt = Date.now()

        // 失败传播：直接后继中无 condition 的 pending 节点标记为 skipped
        this.propagateFailure(taskId)
    }

    /**
     * 标记节点跳过（skipped）
     */
    markSkipped(taskId: string, reason?: string): void {
        const node = this.nodes.get(taskId)
        if (!node) {
            throw new DAGErr('MISSING_NODE', `节点不存在: ${taskId}`)
        }
        node.status = 'skipped'
        if (reason) node.error = reason
        node.endedAt = Date.now()

        // 跳过也传播（跳过的节点相当于失败依赖）
        this.propagateFailure(taskId)
    }

    /**
     * 标记节点暂停（paused）
     *
     * 仅 running 状态可暂停。pending 状态的节点由 Orchestrator 通过
     * 不调度实现"暂停"。
     */
    markPaused(taskId: string): void {
        const node = this.nodes.get(taskId)
        if (!node) {
            throw new DAGErr('MISSING_NODE', `节点不存在: ${taskId}`)
        }
        if (node.status !== 'running') {
            throw new DAGErr(
                'INVALID_TRANSITION',
                `节点 ${taskId} 当前状态 ${node.status}，仅 running 可暂停`,
            )
        }
        node.status = 'paused'
    }

    /**
     * 修改节点输入（用于教师 modify 介入）
     *
     * 将节点状态重置为 pending，并清空结果与时间戳。
     * 已完成（success/failed/skipped）的节点可被重置。
     * running 状态的节点不可修改（应先 pause/abort）。
     */
    modifyInput(taskId: string, newInput: unknown): void {
        const node = this.nodes.get(taskId)
        if (!node) {
            throw new DAGErr('MISSING_NODE', `节点不存在: ${taskId}`)
        }
        if (node.status === 'running') {
            throw new DAGErr(
                'INVALID_TRANSITION',
                `节点 ${taskId} 正在运行，请先暂停或中止`,
            )
        }
        node.input = newInput
        node.status = 'pending'
        node.result = undefined
        node.error = undefined
        node.startedAt = undefined
        node.endedAt = undefined
    }

    // ─────────────────────────────────────────────────────────
    // 条件分支评估
    // ─────────────────────────────────────────────────────────

    /**
     * 评估所有 pending 节点的条件分支
     *
     * 对于依赖已全部完成的 pending 节点，若 condition 返回 false，
     * 则标记为 skipped。返回被跳过的节点 id 列表。
     *
     * @param results 已完成节点的结果映射
     * @returns 被条件跳过的 taskId 列表
     */
    evaluateConditions(results: Map<string, unknown>): string[] {
        const skipped: string[] = []
        for (const [nodeId, preds] of this.predecessors) {
            const node = this.nodes.get(nodeId)
            if (!node) continue
            if (node.status !== 'pending') continue
            if (!node.condition) continue

            // 检查依赖是否全部完成
            let allDepsDone = true
            for (const pred of preds) {
                const predNode = this.nodes.get(pred)
                if (!predNode || predNode.status !== 'success') {
                    allDepsDone = false
                    break
                }
            }
            if (!allDepsDone) continue

            // 评估条件
            try {
                if (!node.condition(results)) {
                    node.status = 'skipped'
                    node.error = '条件分支评估为 false，跳过执行'
                    node.endedAt = Date.now()
                    skipped.push(nodeId)
                    // 跳过也传播
                    this.propagateFailure(nodeId)
                }
            } catch (err) {
                // 条件评估抛错视为 false，记录原因
                node.status = 'skipped'
                node.error = `条件评估异常: ${err instanceof Error ? err.message : String(err)}`
                node.endedAt = Date.now()
                skipped.push(nodeId)
                this.propagateFailure(nodeId)
            }
        }
        return skipped
    }

    // ─────────────────────────────────────────────────────────
    // 完成度与快照
    // ─────────────────────────────────────────────────────────

    /**
     * 是否全部节点已终结（success / failed / skipped）
     */
    isComplete(): boolean {
        for (const node of this.nodes.values()) {
            if (node.status === 'pending' || node.status === 'running' || node.status === 'paused') {
                return false
            }
        }
        return true
    }

    /**
     * 是否存在未终结且未暂停的节点（用于判断是否还有可推进的工作）
     */
    hasPendingWork(): boolean {
        for (const node of this.nodes.values()) {
            if (node.status === 'pending' || node.status === 'running') {
                return true
            }
        }
        return false
    }

    /**
     * 当前状态快照
     */
    snapshot(): { pending: number; running: number; paused: number; done: number; failed: number; skipped: number } {
        let pending = 0
        let running = 0
        let paused = 0
        let done = 0
        let failed = 0
        let skipped = 0
        for (const node of this.nodes.values()) {
            switch (node.status) {
                case 'pending': pending++; break
                case 'running': running++; break
                case 'paused': paused++; break
                case 'success': done++; break
                case 'failed': failed++; break
                case 'skipped': skipped++; break
            }
        }
        return { pending, running, paused, done, failed, skipped }
    }

    /**
     * 获取节点当前状态（返回拷贝，避免外部 mutation）
     */
    getNode(taskId: string): SubTask | undefined {
        const node = this.nodes.get(taskId)
        if (!node) return undefined
        return { ...node, dependencies: [...node.dependencies] }
    }

    /**
     * 获取所有节点的当前状态快照
     */
    getAllNodes(): SubTask[] {
        return Array.from(this.nodes.values()).map((n) => ({
            ...n,
            dependencies: [...n.dependencies],
        }))
    }

    /**
     * 收集所有已完成节点的结果映射
     */
    collectResults(): Map<string, unknown> {
        const results = new Map<string, unknown>()
        for (const node of this.nodes.values()) {
            if (node.status === 'success' && node.result !== undefined) {
                results.set(node.id, node.result)
            }
        }
        return results
    }

    /**
     * 收集所有失败的 taskId
     */
    collectFailed(): string[] {
        const failed: string[] = []
        for (const node of this.nodes.values()) {
            if (node.status === 'failed') failed.push(node.id)
        }
        return failed
    }

    /**
     * 收集所有被跳过的 taskId
     */
    collectSkipped(): string[] {
        const skipped: string[] = []
        for (const node of this.nodes.values()) {
            if (node.status === 'skipped') skipped.push(node.id)
        }
        return skipped
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    /**
     * 失败传播
     *
     * 当 taskId 失败或被跳过时，递归地将依赖它的 pending 节点（无自定义 condition）
     * 标记为 skipped。带自定义 condition 的节点保留给 evaluateConditions 处理，
     * 允许 condition 函数读取失败状态并决定是否仍然执行。
     */
    private propagateFailure(taskId: string): void {
        const succs = this.successors.get(taskId)
        if (!succs) return

        for (const succ of succs) {
            const succNode = this.nodes.get(succ)
            if (!succNode) continue
            if (succNode.status !== 'pending') continue
            // 带自定义 condition 的节点不自动跳过，留给 evaluateConditions 决策
            if (succNode.condition) continue

            succNode.status = 'skipped'
            succNode.error = `依赖节点 ${taskId} 未成功，自动跳过`
            succNode.endedAt = Date.now()
            // 递归传播
            this.propagateFailure(succ)
        }
    }
}

// ─────────────────────────────────────────────────────────────
// 辅助导出：状态机合法转换表
// ─────────────────────────────────────────────────────────────

/**
 * 子任务状态机合法转换表
 *
 * 用于校验状态转换的合法性。key 为当前状态，value 为允许的下一状态集合。
 */
export const VALID_TRANSITIONS: Record<SubTaskStatus, readonly SubTaskStatus[]> = {
    pending: ['running', 'skipped'] as const,
    running: ['success', 'failed', 'paused'] as const,
    paused: ['running', 'skipped'] as const,
    success: [] as const,
    failed: ['pending'] as const,  // modifyAndRerun 时重置
    skipped: ['pending'] as const, // modifyAndRerun 时重置
} as const
