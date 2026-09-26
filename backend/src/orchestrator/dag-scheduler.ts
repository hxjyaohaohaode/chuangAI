/** Deterministic execution kernel. Dependency declarations are the execution graph. */
import type { DAG, SubTask, SubTaskStatus } from './types.js'
import { cloneRuntimeData } from './runtime-data.js'
export class DAGErr extends Error {
    constructor(public readonly code: 'CYCLE' | 'MISSING_NODE' | 'INVALID_TRANSITION', message: string) { super(message); this.name = 'DAGErr' }
}
const TERMINAL = new Set<SubTaskStatus>(['success', 'failed', 'skipped'])
function copy(node: SubTask): SubTask {
    return { ...node, input: cloneRuntimeData(node.input), result: cloneRuntimeData(node.result), dependencies: [...node.dependencies] }
}
export const VALID_TRANSITIONS: Record<SubTaskStatus, readonly SubTaskStatus[]> = {
    pending: ['running', 'failed', 'skipped'], running: ['success', 'failed', 'paused', 'skipped'],
    paused: ['running', 'pending', 'failed', 'skipped'], success: [], failed: ['pending'], skipped: ['pending'],
}
export class DAGScheduler {
    private readonly nodes = new Map<string, SubTask>()
    private readonly successors = new Map<string, Set<string>>()
    private readonly revisions = new Map<string, number>()
    private readonly order: string[]
    constructor(dag: DAG) {
        if (dag.nodes.length > 2048) throw new DAGErr('MISSING_NODE', '执行图超过节点预算')
        for (const node of dag.nodes) {
            if (!node.id || this.nodes.has(node.id)) throw new DAGErr('MISSING_NODE', `重复或空节点 ID: ${node.id}`)
            if (!VALID_TRANSITIONS[node.status]) throw new DAGErr('INVALID_TRANSITION', '节点状态无效')
            this.nodes.set(node.id, copy(node)); this.revisions.set(node.id, 0)
        }
        const indegrees = new Map<string, number>()
        for (const node of this.nodes.values()) {
            const deps = new Set(node.dependencies)
            if (deps.size !== node.dependencies.length) throw new DAGErr('MISSING_NODE', `重复依赖: ${node.id}`)
            indegrees.set(node.id, deps.size)
            for (const dep of deps) {
                if (!this.nodes.has(dep)) throw new DAGErr('MISSING_NODE', `节点 ${node.id} 依赖不存在的节点: ${dep}`)
                const next = this.successors.get(dep) ?? new Set<string>(); next.add(node.id); this.successors.set(dep, next)
            }
        }
        const queue = [...indegrees].filter(([, count]) => count === 0).map(([id]) => id)
        this.order = []
        for (let i = 0; i < queue.length; i++) {
            const id = queue[i]!
            this.order.push(id)
            for (const next of this.successors.get(id) ?? []) {
                const count = indegrees.get(next)! - 1; indegrees.set(next, count)
                if (count === 0) queue.push(next)
            }
        }
        if (this.order.length !== this.nodes.size) throw new DAGErr('CYCLE', 'DAG 存在环，无法调度')
    }
    private require(id: string): SubTask { const node = this.nodes.get(id); if (!node) throw new DAGErr('MISSING_NODE', `节点不存在: ${id}`); return node }
    private transition(id: string, status: SubTaskStatus): SubTask {
        const node = this.require(id)
        if (!VALID_TRANSITIONS[node.status].includes(status)) throw new DAGErr('INVALID_TRANSITION', `节点 ${id} 不能从 ${node.status} 转为 ${status}`)
        node.status = status; return node
    }
    topologicalSort(): string[] { return [...this.order] }
    getRevision(id: string): number { this.require(id); return this.revisions.get(id)! }
    isCurrent(id: string, revision: number): boolean { return this.revisions.get(id) === revision && this.nodes.get(id)?.status === 'running' }
    getReadyNodes(): SubTask[] {
        this.propagateBlocked()
        return this.order.map(id => this.require(id)).filter(node => node.status === 'pending' && node.dependencies.every(dep => this.require(dep).status === 'success')).map(copy)
    }
    markRunning(id: string): void {
        const node = this.transition(id, 'running')
        this.revisions.set(id, this.getRevision(id) + 1)
        node.startedAt = Date.now(); delete node.endedAt; delete node.error; delete node.result
    }
    markDone(id: string, result: unknown, revision?: number): void {
        if (revision !== undefined && !this.isCurrent(id, revision)) return
        const cloned = cloneRuntimeData(result)
        const node = this.transition(id, 'success'); node.result = cloned; node.endedAt = Date.now()
    }
    markFailed(id: string, error: string, revision?: number): void {
        if (revision !== undefined && !this.isCurrent(id, revision)) return
        const node = this.transition(id, 'failed'); node.error = error.slice(0, 4000); node.endedAt = Date.now(); delete node.result
        this.propagateBlocked()
    }
    markSkipped(id: string, reason?: string): void {
        const node = this.transition(id, 'skipped'); node.error = reason?.slice(0, 4000); node.endedAt = Date.now(); delete node.result
        this.propagateBlocked()
    }
    markPaused(id: string): void { this.transition(id, 'paused') }
    getAffectedTaskIds(id: string): string[] {
        this.require(id)
        const visited = new Set([id]); const queue = [id]
        for (let i = 0; i < queue.length; i++) for (const next of this.successors.get(queue[i]!) ?? []) if (!visited.has(next)) { visited.add(next); queue.push(next) }
        return queue
    }
    /** Validate every affected task before changing any state. */
    modifyInput(id: string, input: unknown): void {
        const cloned = cloneRuntimeData(input)
        const affected = this.getAffectedTaskIds(id)
        if (affected.some(key => this.require(key).status === 'running')) throw new DAGErr('INVALID_TRANSITION', '存在运行中的任务或下游节点，请先暂停')
        for (const key of affected) {
            const node = this.require(key); node.status = 'pending'
            delete node.result; delete node.error; delete node.startedAt; delete node.endedAt
            this.revisions.set(key, this.getRevision(key) + 1)
        }
        this.require(id).input = cloned
    }
    private propagateBlocked(): void {
        for (const id of this.order) {
            const node = this.require(id)
            if (node.status !== 'pending' && node.status !== 'paused') continue
            const blocked = node.dependencies.find(dep => ['failed', 'skipped'].includes(this.require(dep).status))
            if (blocked) { node.status = 'skipped'; node.error = `依赖节点 ${blocked} 未成功，自动跳过`; node.endedAt = Date.now(); delete node.result }
        }
    }
    evaluateConditions(results: Map<string, unknown>): string[] {
        this.propagateBlocked()
        const skipped: string[] = []
        for (const id of this.order) {
            const node = this.require(id)
            if (node.status !== 'pending' || !node.condition || !node.dependencies.every(dep => this.require(dep).status === 'success')) continue
            try {
                const isolated = new Map([...results].map(([key, value]) => [key, cloneRuntimeData(value)]))
                if (!node.condition(isolated)) { this.markSkipped(id, '条件分支评估为 false，跳过执行'); skipped.push(id) }
            } catch (error) { this.markSkipped(id, `条件评估异常: ${error instanceof Error ? error.message : String(error)}`); skipped.push(id) }
        }
        return skipped
    }
    /** Cancel also terminalizes queued and paused work and invalidates late completions. */
    cancel(reason = '会话已中止'): void {
        for (const node of this.nodes.values()) {
            if (TERMINAL.has(node.status)) continue
            node.status = node.status === 'running' ? 'failed' : 'skipped'
            node.error = reason; node.endedAt = Date.now(); delete node.result
            this.revisions.set(node.id, this.getRevision(node.id) + 1)
        }
    }
    isComplete(): boolean { return [...this.nodes.values()].every(node => TERMINAL.has(node.status)) }
    hasPendingWork(): boolean { return [...this.nodes.values()].some(node => node.status === 'pending' || node.status === 'running') }
    snapshot(): { pending: number; running: number; paused: number; done: number; failed: number; skipped: number } {
        const result = { pending: 0, running: 0, paused: 0, done: 0, failed: 0, skipped: 0 }
        for (const node of this.nodes.values()) result[node.status === 'success' ? 'done' : node.status]++
        return result
    }
    getNode(id: string): SubTask | undefined { const node = this.nodes.get(id); return node ? copy(node) : undefined }
    getAllNodes(): SubTask[] { return this.order.map(id => copy(this.require(id))) }
    collectResults(): Map<string, unknown> { return new Map([...this.nodes.values()].filter(node => node.status === 'success' && node.result !== undefined).map(node => [node.id, cloneRuntimeData(node.result)])) }
    collectFailed(): string[] { return this.order.filter(id => this.require(id).status === 'failed') }
    collectSkipped(): string[] { return this.order.filter(id => this.require(id).status === 'skipped') }
}
