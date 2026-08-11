/**
 * 自我进化引擎（Task 22 —— P7 阶段实现）
 *
 * 整合既有基础设施（EvolutionMemoryRepository + PromptVersionRepository +
 * agentEvents 事件总线 + Orchestrator.reflect + InterventionManager.recordFeedback），
 * 补全"反馈→进化→应用"业务逻辑层闭环。
 *
 * 核心能力：
 * 1. 事件订阅：监听 grading:review / agent:call:error / agent:verify 三类事件
 * 2. 模式提炼：从教师修正/Agent错误/验收驳回中提炼进化模式（pattern）
 * 3. 记忆写入：将进化模式持久化到 evolution_memory 表
 * 4. Prompt 进化：当某 Agent 累计进化模式达到阈值时，调用 LLM 生成新 Prompt 版本
 * 5. 版本应用：新版本写入 prompt_versions 表并设为 active，下次 Agent 调用通过
 *    AgentContext.promptOverride 自动生效（BaseAgent.invoke L88 已支持）
 *
 * 设计原则：
 * - 零外部依赖（仅用 router / repos / agentEvents）
 * - 严格 TypeScript：零 any，适配 noUncheckedIndexedAccess
 * - 容错隔离：任何进化失败不阻塞主流程（进化是增强项，非必需项）
 * - 幂等安全：同一 pattern 重复写入不冲突
 *
 * 数据流：
 *   教师修正/Agent错误/验收驳回
 *     ↓ agentEvents.emit
 *   EvolutionEngine.handleEvent
 *     ↓ 提炼 pattern
 *   repos.evolutionMemory.create
 *     ↓ 累计达阈值
 *   EvolutionEngine.evolvePrompt
 *     ↓ LLM 生成新 systemPrompt
 *   repos.promptVersions.create + setActive
 *     ↓ 下次 Agent 调用
 *   AgentContext.promptOverride.systemPrompt 生效
 */

import { router } from '../../llm/index.js'
import { repos } from '../../db/index.js'
import { agentEvents, AGENT_EVENTS } from './events.js'
import type { AgentCallSuccessPayload, PromptEvolvedPayload, ABTestWonPayload } from './events.js'
import { safeJsonParse, buildContextBlock } from './prompts.js'
import type { AgentContext } from './types.js'
import type { WSBroadcaster } from '../../orchestrator/websocket/broadcaster.js'
import type { WSEvent } from '../../orchestrator/types.js'

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 教师批改修正事件名（与 grading.ts GRADING_REVIEW_EVENT 对齐） */
const GRADING_REVIEW_EVENT = 'grading:review'

/** 触发 Prompt 进化的累计模式阈值 */
const EVOLVE_THRESHOLD = 3

/** 滑动窗口：保留最近 N 条错误/驳回事件用于模式聚合 */
const SLIDING_WINDOW_SIZE = 20

/** 闭环4补全：A/B 测试最小样本数 —— 候选版本累计达到此样本后评估胜负 */
const MIN_AB_TEST_SAMPLES = 8

/** 闭环4补全：A/B 测试候选版本胜出阈值 —— 候选成功率需超出活跃成功率此幅度才胜出 */
const AB_TEST_WIN_MARGIN = 0.05

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 进化模式来源 */
export type EvolutionSource = 'teacher-correction' | 'agent-error' | 'verify-reject'

/** 进化模式记录（内存态，聚合后落盘） */
interface EvolutionPatternRecord {
    agentId: string
    source: EvolutionSource
    pattern: string
    timestamp: number
    /** 原始事件载荷摘要（供 LLM 进化时参考） */
    contextSnippet: string
}

/** 进化统计 */
export interface EvolutionStats {
    /** 各 Agent 的模式累计数 */
    patternCounts: Record<string, number>
    /** 已触发的 Prompt 进化次数 */
    totalEvolutions: number
    /** 最近一次进化时间 */
    lastEvolutionAt: number | null
}

/** 闭环4补全：A/B 测试候选版本跟踪记录 */
interface ABTestCandidate {
    /** 候选版本号 */
    version: string
    /** 候选版本 systemPrompt */
    systemPrompt: string
    /** 候选版本成功次数 */
    successCount: number
    /** 候选版本失败次数 */
    failureCount: number
    /** 活跃版本成功次数（同期对比） */
    activeSuccessCount: number
    /** 活跃版本失败次数（同期对比） */
    activeFailureCount: number
    /** A/B 测试开始时间 */
    startedAt: number
    /** 流量分配计数器（偶数用候选，奇数用活跃） */
    alternationCounter: number
}

// ─────────────────────────────────────────────────────────────
// 进化之眼基因谱 3D 可视化类型定义
// ─────────────────────────────────────────────────────────────

/** 版本谱系节点（进化之眼 3D 可视化用） */
export interface GenealogyNode {
    id: string
    agentId: string
    version: string
    isActive: boolean
    isCandidate: boolean
    createdAt: number
    changelog: string
    /** 质量分 0-1，决定 3D 球体大小 */
    quality: number
    improvementReward: number | null
    triggerPattern: string | null
    appliedAt: number | null
    /** 候选版本的成功次数（仅 isCandidate 时有值） */
    successCount: number | null
    /** 候选版本的失败次数（仅 isCandidate 时有值） */
    failureCount: number | null
}

/** 版本谱系边（进化关系） */
export interface GenealogyEdge {
    from: string
    to: string
    agentId: string
    pattern: string
    improvementReward: number | null
    createdAt: number
}

/** 版本谱系完整数据 */
export interface GenealogyData {
    nodes: GenealogyNode[]
    edges: GenealogyEdge[]
    agentIds: string[]
}

/** 进化模式列表项 */
export interface PatternItem {
    id: string
    agentId: string
    pattern: string
    source: EvolutionSource
    contextSnippet: string
    timestamp: number
    createdAt: number
}

/** A/B 测试候选信息（当前活跃测试） */
export interface ABTestCandidateInfo {
    agentId: string
    version: string
    startedAt: number
    samples: number
    candidateSuccessCount: number
    candidateFailureCount: number
    activeSuccessCount: number
    activeFailureCount: number
    candidateSuccessRate: number
    activeSuccessRate: number
    /** 候选成功率超出活跃的幅度 */
    margin: number
    minSamplesReached: boolean
}

/** A/B 测试历史项（已完成测试） */
export interface ABTestHistoryItem {
    agentId: string
    winningVersion: string
    candidateSuccessRate: number
    activeSuccessRate: number
    activatedAt: number
    pattern: string
}

/** A/B 测试结果数据 */
export interface ABTestResultData {
    active: ABTestCandidateInfo[]
    history: ABTestHistoryItem[]
    threshold: number
    minSamples: number
}

// ─────────────────────────────────────────────────────────────
// 自我进化引擎
// ─────────────────────────────────────────────────────────────

/**
 * 自我进化引擎
 *
 * 全局单例，在 orchestrator/index.ts initOrchestrator 时启动。
 * 订阅 agentEvents，异步处理进化逻辑，不阻塞任何主流程。
 */
export class EvolutionEngine {
    /** 滑动窗口：最近 N 条进化模式（内存态） */
    private readonly recentPatterns: EvolutionPatternRecord[] = []
    /** 已注册的事件监听器（供 shutdown 解绑） */
    private readonly listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = []
    /** 是否已启动 */
    private started = false
    /** 进化统计 */
    private evolutionCount = 0
    private lastEvolutionAt: number | null = null
    /** 闭环4补全：WebSocket 广播器（可选，用于推送进化事件到前端） */
    private broadcaster: WSBroadcaster | null = null
    /** 闭环4补全：A/B 测试候选版本跟踪 —— agentId → 候选记录 */
    private readonly abTestCandidates: Map<string, ABTestCandidate> = new Map()

    /**
     * 绑定 WebSocket 广播器（在 orchestrator/index.ts initOrchestrator 时调用）
     *
     * 绑定后，Prompt 进化和 A/B 测试胜出事件会通过 WS 推送到前端，
     * 前端据此刷新进化看板与版本管理面板。
     */
    attachBroadcaster(broadcaster: WSBroadcaster): void {
        this.broadcaster = broadcaster
    }

    /** 服务关闭/热重载时解除旧广播器引用，避免保留 Fastify 实例。 */
    detachBroadcaster(): void {
        this.broadcaster = null
    }

    /**
     * 启动自我进化引擎
     *
     * 订阅四类事件，异步处理。所有处理函数均包裹 try-catch，
     * 任何进化失败仅记录日志，不抛出。
     */
    start(): void {
        if (this.started) return
        this.started = true

        // 订阅教师批改修正事件
        this.subscribe(GRADING_REVIEW_EVENT, (payload: unknown) => {
            this.handleTeacherCorrection(payload).catch(() => {
                // 静默失败：进化是增强项，不阻塞批改流程
            })
        })

        // 订阅 Agent 调用错误事件
        this.subscribe(AGENT_EVENTS.CALL_ERROR, (payload: unknown) => {
            this.handleAgentError(payload).catch(() => { })
        })

        // 订阅验收驳回事件
        this.subscribe(AGENT_EVENTS.VERIFY, (payload: unknown) => {
            this.handleVerifyReject(payload).catch(() => { })
        })

        // 闭环4补全：订阅 Agent 调用成功事件，追踪 A/B 测试候选版本表现
        this.subscribe(AGENT_EVENTS.CALL_SUCCESS, (payload: unknown) => {
            this.handleABTestCallResult(payload).catch(() => { })
        })
    }

    /**
     * 停止自我进化引擎（解绑所有监听器）
     */
    stop(): void {
        for (const { event, fn } of this.listeners) {
            agentEvents.removeListener(event, fn)
        }
        this.listeners.length = 0
        this.started = false
    }

    /**
     * 获取指定 Agent 的当前 Prompt 版本覆盖
     *
     * 供编排官在构建 AgentContext 时调用，将活跃 Prompt 版本注入
     * ctx.promptOverride，从而让 BaseAgent.invoke 使用进化后的 Prompt。
     *
     * 闭环4补全（A/B 测试流量分配）：
     * 若该 Agent 存在 A/B 测试候选版本，则按 50/50 概率交替返回候选或活跃版本。
     * 候选版本通过 CALL_SUCCESS 事件追踪成功率，达到最小样本数后自动评估胜负。
     *
     * 若无活跃版本且无候选，返回 undefined（Agent 使用自身 buildSystemPrompt）。
     */
    getPromptOverride(agentId: string): { version: string; systemPrompt?: string } | undefined {
        try {
            const active = repos.promptVersions.findActiveByAgentId(agentId)
            const candidate = this.abTestCandidates.get(agentId)

            // A/B 测试流量分配：偶数计数用候选，奇数计数用活跃
            if (candidate && active) {
                candidate.alternationCounter += 1
                if (candidate.alternationCounter % 2 === 0) {
                    return {
                        version: candidate.version,
                        systemPrompt: candidate.systemPrompt,
                    }
                }
            }

            if (!active) return undefined
            return {
                version: active.version,
                systemPrompt: active.systemPrompt,
            }
        } catch {
            return undefined
        }
    }

    /**
     * 将 Prompt 覆盖注入 AgentContext
     *
     * 便捷工具：若 ctx 已有 promptOverride 则保留，否则从活跃版本填充。
     */
    injectPromptOverride(ctx: AgentContext, agentId: string): AgentContext {
        if (ctx.promptOverride) return ctx
        const override = this.getPromptOverride(agentId)
        if (!override) return ctx
        return { ...ctx, promptOverride: override }
    }

    /**
     * 获取进化统计
     */
    getStats(): EvolutionStats {
        const patternCounts: Record<string, number> = {}
        for (const rec of this.recentPatterns) {
            patternCounts[rec.agentId] = (patternCounts[rec.agentId] ?? 0) + 1
        }
        return {
            patternCounts,
            totalEvolutions: this.evolutionCount,
            lastEvolutionAt: this.lastEvolutionAt,
        }
    }

    /**
     * 获取版本谱系（进化之眼基因谱 3D 可视化数据源）
     *
     * 返回所有 Agent 的 Prompt 版本树：
     * - 节点：每个版本（含活跃/候选/inactive）
     * - 边：beforePrompt → afterPrompt 的进化关系
     * - 节点尺寸：由 successCount 决定（候选版本）或固定值（活跃版本）
     * - 节点颜色：active=accent-primary / candidate=accent-warning / inactive=text-tertiary
     *
     * 同时关联 evolution_memory 的 improvementReward 作为节点质量指标。
     */
    getGenealogy(): GenealogyData {
        try {
            // 1. 查询所有 Agent 的全部版本
            const allAgents = repos.promptVersions.findAll(500, 0)
            const agentIds = [...new Set(allAgents.map((v) => v.agentId))]

            const nodes: GenealogyNode[] = []
            const edges: GenealogyEdge[] = []

            for (const agentId of agentIds) {
                const versions = repos.promptVersions.findByAgentId(agentId)
                const memories = repos.evolutionMemory.findByAgentId(agentId)

                // 构建 version → memory 映射（afterPrompt 匹配 systemPrompt）
                const memoryByVersion = new Map<string, { reward: number | null; pattern: string | null; appliedAt: number | null }>()
                for (const mem of memories) {
                    if (mem.afterPrompt) {
                        const matchedVersion = versions.find((v) => v.systemPrompt === mem.afterPrompt)
                        if (matchedVersion) {
                            memoryByVersion.set(matchedVersion.version, {
                                reward: mem.improvementReward,
                                pattern: mem.pattern,
                                appliedAt: mem.appliedAt,
                            })
                        }
                    }
                }

                // 候选版本（A/B 测试中）
                const candidate = this.abTestCandidates.get(agentId)

                for (const v of versions) {
                    const mem = memoryByVersion.get(v.version)
                    const isCandidate = candidate?.version === v.version
                    const matchedCandidate = isCandidate ? candidate : undefined
                    const quality = this.computeNodeQuality(v, mem?.reward ?? null, matchedCandidate ?? null)
                    nodes.push({
                        id: v.id,
                        agentId: v.agentId,
                        version: v.version,
                        isActive: v.isActive,
                        isCandidate,
                        createdAt: v.createdAt,
                        changelog: v.changelog ?? '',
                        quality,
                        improvementReward: mem?.reward ?? null,
                        triggerPattern: mem?.pattern ?? null,
                        appliedAt: mem?.appliedAt ?? null,
                        successCount: matchedCandidate?.successCount ?? null,
                        failureCount: matchedCandidate?.failureCount ?? null,
                    })
                }

                // 构建进化边：beforePrompt → afterPrompt（来自 evolution_memory strategic 类型）
                const strategicMemories = memories.filter((m) => m.beforePrompt && m.afterPrompt)
                for (const mem of strategicMemories) {
                    const fromVersion = versions.find((v) => v.systemPrompt === mem.beforePrompt)
                    const toVersion = versions.find((v) => v.systemPrompt === mem.afterPrompt)
                    if (fromVersion && toVersion) {
                        edges.push({
                            from: fromVersion.id,
                            to: toVersion.id,
                            agentId,
                            pattern: mem.pattern,
                            improvementReward: mem.improvementReward,
                            createdAt: mem.createdAt,
                        })
                    }
                }
            }

            return { nodes, edges, agentIds }
        } catch {
            return { nodes: [], edges: [], agentIds: [] }
        }
    }

    /**
     * 获取进化模式列表（PatternPanel 数据源）
     *
     * 从 evolution_memory 表查询所有 tactical 类型模式，
     * 按时间倒序返回，供前端展示进化信号源。
     */
    getPatterns(limit = 100): PatternItem[] {
        try {
            // 查询所有 tactical 模式（按创建时间倒序）
            const memories = repos.evolutionMemory.findAll(limit, 0)
            return memories
                .filter((m) => m.type === 'tactical')
                .map((m) => {
                    const meta = m.metadata as { source?: EvolutionSource; contextSnippet?: string; timestamp?: number } | null
                    return {
                        id: m.id,
                        agentId: m.agentId,
                        pattern: m.pattern,
                        source: meta?.source ?? 'agent-error',
                        contextSnippet: meta?.contextSnippet ?? '',
                        timestamp: m.createdAt,
                        createdAt: m.createdAt,
                    } as PatternItem
                })
                .sort((a, b) => b.timestamp - a.timestamp)
        } catch {
            return []
        }
    }

    /**
     * 获取 A/B 测试结果（ABTestChart 数据源）
     *
     * 返回当前正在进行的 A/B 测试候选版本 + 历史已结束的测试结果。
     */
    getABTestResults(): ABTestResultData {
        try {
            const active: ABTestCandidateInfo[] = []
            const history: ABTestHistoryItem[] = []

            // 1. 当前活跃的 A/B 测试候选
            for (const [agentId, cand] of this.abTestCandidates.entries()) {
                const candidateUses = Math.floor(cand.alternationCounter / 2)
                const activeUses = Math.ceil(cand.alternationCounter / 2)
                const candidateRate = candidateUses > 0 ? cand.successCount / candidateUses : 0
                const activeRate = activeUses > 0 ? cand.activeSuccessCount / activeUses : 0

                active.push({
                    agentId,
                    version: cand.version,
                    startedAt: cand.startedAt,
                    samples: cand.alternationCounter,
                    candidateSuccessCount: cand.successCount,
                    candidateFailureCount: cand.failureCount,
                    activeSuccessCount: cand.activeSuccessCount,
                    activeFailureCount: cand.activeFailureCount,
                    candidateSuccessRate: Math.round(candidateRate * 1000) / 1000,
                    activeSuccessRate: Math.round(activeRate * 1000) / 1000,
                    margin: Math.round((candidateRate - activeRate) * 1000) / 1000,
                    minSamplesReached: cand.alternationCounter >= MIN_AB_TEST_SAMPLES * 2,
                })
            }

            // 2. 历史已完成的 A/B 测试（从 evolution_memory 中提取 abTestResult）
            const allMemories = repos.evolutionMemory.findAll(200, 0)
            for (const mem of allMemories) {
                if (!mem.abTestResult) continue
                const abResult = mem.abTestResult as {
                    winningVersion?: string
                    candidateSuccessRate?: number
                    activeSuccessRate?: number
                    activatedAt?: number
                }
                if (abResult.winningVersion) {
                    history.push({
                        agentId: mem.agentId,
                        winningVersion: abResult.winningVersion,
                        candidateSuccessRate: abResult.candidateSuccessRate ?? 0,
                        activeSuccessRate: abResult.activeSuccessRate ?? 0,
                        activatedAt: abResult.activatedAt ?? mem.appliedAt ?? mem.createdAt,
                        pattern: mem.pattern,
                    })
                }
            }

            return { active, history, threshold: AB_TEST_WIN_MARGIN, minSamples: MIN_AB_TEST_SAMPLES }
        } catch {
            return { active: [], history: [], threshold: AB_TEST_WIN_MARGIN, minSamples: MIN_AB_TEST_SAMPLES }
        }
    }

    /**
     * 计算节点质量分（0-1）—— 决定 3D 球体大小
     *
     * 评分维度：
     * - 活跃版本：基础 0.7 + improvementReward 加成
     * - 候选版本：基础 0.5 + 成功率加成
     * - inactive 版本：固定 0.3
     */
    private computeNodeQuality(
        version: { isActive: boolean },
        reward: number | null,
        candidate: ABTestCandidate | null,
    ): number {
        if (version.isActive) {
            const rewardBonus = reward !== null && Number.isFinite(reward) ? Math.min(0.3, Math.max(0, reward) * 0.3) : 0
            return Math.min(1, 0.7 + rewardBonus)
        }
        if (candidate) {
            const total = candidate.successCount + candidate.failureCount
            if (total === 0) return 0.5
            const rate = candidate.successCount / total
            return Math.min(0.9, 0.4 + rate * 0.5)
        }
        return 0.3
    }

    /**
     * 手动触发 Prompt 进化（供测试或管理员调用，亦由 recordPattern 阈值自动触发）
     *
     * 闭环4补全（A/B 测试流程）：
     * - 若该 Agent 无活跃版本（首次进化）：直接创建并激活，立即生效
     * - 若该 Agent 已有活跃版本：创建为候选（isActive: false），注册到 abTestCandidates，
     *   getPromptOverride 按 50/50 流量分配，达到 MIN_AB_TEST_SAMPLES 后自动评估胜负：
     *   - 候选胜出 → setActive 激活候选，发射 ab-test:won 事件
     *   - 候选未胜出 → 从内存清除候选（数据库记录保留为 inactive），维持原活跃版本
     *
     * 进化完成后始终发射 prompt:evolved 事件，前端据此刷新进化看板。
     */
    async evolvePrompt(agentId: string, triggerPattern: string): Promise<boolean> {
        try {
            const patterns = this.recentPatterns
                .filter((p) => p.agentId === agentId)
                .slice(-SLIDING_WINDOW_SIZE)

            const newPrompt = await this.generateEvolvedPrompt(agentId, triggerPattern, patterns)
            if (!newPrompt) return false

            const version = `evolved-${Date.now().toString(36)}`
            const existingActive = repos.promptVersions.findActiveByAgentId(agentId)

            if (!existingActive) {
                // 首次进化：无活跃版本 → 直接创建并激活
                repos.promptVersions.create({
                    id: version,
                    agentId,
                    version,
                    systemPrompt: newPrompt,
                    userPromptTemplate: null,
                    changelog: `基于 ${patterns.length} 条进化模式自动生成。触发模式：${triggerPattern.slice(0, 100)}`,
                    isActive: true,
                })
                repos.promptVersions.setActive(agentId, version)
            } else {
                // 后续进化：已有活跃版本 → 创建为候选，启动 A/B 测试
                repos.promptVersions.create({
                    id: version,
                    agentId,
                    version,
                    systemPrompt: newPrompt,
                    userPromptTemplate: null,
                    changelog: `A/B 测试候选版本。基于 ${patterns.length} 条进化模式生成。触发模式：${triggerPattern.slice(0, 100)}`,
                    isActive: false,
                })

                // 注册 A/B 测试候选跟踪记录
                this.abTestCandidates.set(agentId, {
                    version,
                    systemPrompt: newPrompt,
                    successCount: 0,
                    failureCount: 0,
                    activeSuccessCount: 0,
                    activeFailureCount: 0,
                    startedAt: Date.now(),
                    alternationCounter: 0,
                })
            }

            this.evolutionCount += 1
            this.lastEvolutionAt = Date.now()

            // 记录进化记忆（strategic 类型）
            repos.evolutionMemory.create({
                id: `evo-${version}`,
                type: 'strategic',
                agentId,
                pattern: triggerPattern,
                beforePrompt: existingActive?.systemPrompt ?? null,
                afterPrompt: newPrompt,
                improvementReward: null,
                abTestResult: null,
            })

            // 闭环4补全（BP4-3）：发射 prompt:evolved 事件
            const evolvedPayload: PromptEvolvedPayload = {
                agentId,
                version,
                triggerPattern: triggerPattern.slice(0, 200),
                evolvedAt: Date.now(),
            }
            agentEvents.emit(AGENT_EVENTS.PROMPT_EVOLVED, evolvedPayload)
            this.broadcastBusinessEvent('prompt:evolved', evolvedPayload)

            return true
        } catch {
            return false
        }
    }

    // ─────────────────────────────────────────────────────────
    // 事件处理
    // ─────────────────────────────────────────────────────────

    /**
     * 处理教师批改修正事件
     *
     * 事件载荷（grading.ts L811-820）：
     * { fileId, batchId, questionId, action, originalAttribution,
     *   teacherAttribution, teacherFeedback, timestamp }
     *
     * 提炼模式：教师将 AI 的认知归因修正为不同结论 → 该 Agent 在该类
     * 归因上存在系统性偏差，需进化 Prompt 强化该维度。
     */
    private async handleTeacherCorrection(payload: unknown): Promise<void> {
        const data = payload as {
            questionId?: string
            originalAttribution?: string
            teacherAttribution?: string
            teacherFeedback?: string
            timestamp?: number
        }
        if (!data || !data.originalAttribution || !data.teacherAttribution) return

        // 仅在 AI 归因与教师归因不同时记录
        if (data.originalAttribution === data.teacherAttribution) return

        const pattern = `认知归因偏差：AI 判定"${data.originalAttribution}"，教师修正为"${data.teacherAttribution}"`
        const snippet = data.teacherFeedback
            ? `教师反馈：${data.teacherFeedback.slice(0, 200)}`
            : '（无教师反馈文本）'

        this.recordPattern('brush.grade', 'teacher-correction', pattern, snippet)
    }

    /**
     * 处理 Agent 调用错误事件
     *
     * 事件载荷（events.ts AgentCallErrorPayload）：
     * { agentId, taskId, sessionId, error, errorName, timestamp }
     *
     * 提炼模式：按 errorName 分类聚合，同类错误累计达阈值触发进化。
     */
    private async handleAgentError(payload: unknown): Promise<void> {
        const data = payload as {
            agentId?: string
            error?: string
            errorName?: string
            timestamp?: number
        }
        if (!data || !data.agentId || !data.error) return

        const pattern = `调用错误 [${data.errorName ?? 'Unknown'}]：${data.error.slice(0, 150)}`
        this.recordPattern(data.agentId, 'agent-error', pattern, data.error.slice(0, 300))
    }

    /**
     * 处理验收驳回事件
     *
     * 事件载荷（events.ts AgentVerifyPayload）：
     * { targetAgentId, verdict, score, timestamp }
     *
     * 仅在 verdict 为 revise/reject 时记录。
     */
    private async handleVerifyReject(payload: unknown): Promise<void> {
        const data = payload as {
            targetAgentId?: string
            verdict?: string
            score?: number
            timestamp?: number
        }
        if (!data || !data.targetAgentId || !data.verdict) return
        if (data.verdict === 'pass') return

        const pattern = `验收${data.verdict === 'revise' ? '需修正' : '驳回'}（得分 ${data.score ?? 0}）`
        this.recordPattern(data.targetAgentId, 'verify-reject', pattern, `verdict=${data.verdict}, score=${data.score ?? 0}`)
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    /**
     * 记录进化模式
     *
     * 1. 写入滑动窗口（内存）
     * 2. 持久化到 evolution_memory 表（tactical 类型）
     * 3. 检查是否达到进化阈值，达到则触发 Prompt 进化
     */
    private recordPattern(
        agentId: string,
        source: EvolutionSource,
        pattern: string,
        contextSnippet: string,
    ): void {
        const record: EvolutionPatternRecord = {
            agentId,
            source,
            pattern,
            timestamp: Date.now(),
            contextSnippet,
        }

        // 写入滑动窗口
        this.recentPatterns.push(record)
        if (this.recentPatterns.length > SLIDING_WINDOW_SIZE * 3) {
            this.recentPatterns.splice(0, SLIDING_WINDOW_SIZE)
        }

        // 持久化（tactical 类型，供后续分析）
        try {
            repos.evolutionMemory.create({
                id: `pat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                type: 'tactical',
                agentId,
                pattern,
                beforePrompt: null,
                afterPrompt: null,
                improvementReward: null,
                abTestResult: null,
                metadata: { source, contextSnippet, timestamp: record.timestamp },
            })
        } catch {
            // 持久化失败不阻塞内存态
        }

        // 检查进化阈值
        const agentPatternCount = this.recentPatterns
            .filter((p) => p.agentId === agentId)
            .length

        if (agentPatternCount >= EVOLVE_THRESHOLD && agentPatternCount % EVOLVE_THRESHOLD === 0) {
            // 异步触发 Prompt 进化，不阻塞事件流
            this.evolvePrompt(agentId, pattern).catch(() => { })
        }
    }

    /**
     * 调用 LLM 生成进化后的 systemPrompt
     *
     * 策略：
     * 1. 检索该 Agent 当前活跃 Prompt 版本作为 beforePrompt
     * 2. 将最近 N 条进化模式注入 <evolution_patterns> 块
     * 3. 调用 orchestrator:summarize 路由（deepseek-v4-flash，低成本）
     * 4. 输出新 systemPrompt（JSON: { systemPrompt: string }）
     */
    private async generateEvolvedPrompt(
        agentId: string,
        triggerPattern: string,
        patterns: EvolutionPatternRecord[],
    ): Promise<string | null> {
        // 获取当前活跃 Prompt 作为基础
        const current = repos.promptVersions.findActiveByAgentId(agentId)
        const beforePrompt = current?.systemPrompt ?? `（Agent ${agentId} 的原始 systemPrompt，由子类 buildSystemPrompt 生成）`

        // 构建进化模式摘要
        const patternsText = patterns
            .map((p, i) => `[${i + 1}] [${p.source}] ${p.pattern}\n    上下文：${p.contextSnippet}`)
            .join('\n')

        const systemPrompt = `你是诗脉·启明的 Prompt 进化引擎。基于教师反馈、Agent 错误、验收驳回等进化信号，对指定 Agent 的 systemPrompt 进行进化优化。

## 进化原则
1. 保留原 Prompt 的核心角色定位与能力边界
2. 针对进化模式中的系统性偏差进行强化约束
3. 新增明确的"禁止/必须"规则，杜绝同类问题再发
4. 不破坏原 Prompt 的 JSON 输出约束与文化准确性约束
5. 进化后的 Prompt 应比原 Prompt 更精准、更鲁棒

## 输出要求
输出严格 JSON：{"systemPrompt": "进化后的完整 systemPrompt 文本"}
不输出任何解释文字或代码块包裹。`

        const userPrompt = buildContextBlock([
            { tag: 'agent_id', content: agentId },
            { tag: 'before_prompt', content: beforePrompt },
            { tag: 'trigger_pattern', content: triggerPattern },
            {
                tag: 'evolution_patterns',
                content: patternsText || '（无历史模式，仅基于触发模式进化）',
            },
        ])

        try {
            const result = await router.execute('orchestrator', 'summarize', {
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                jsonOutput: true,
                metadata: {
                    agent: 'evolution-engine',
                    task: 'prompt-evolution',
                },
            })

            const parsed = safeJsonParse(result.content) as { systemPrompt?: string }
            const evolved = parsed.systemPrompt
            if (!evolved || evolved.length < 50) return null
            return evolved
        } catch {
            return null
        }
    }

    // ─────────────────────────────────────────────────────────
    // 闭环4补全：A/B 测试内部方法
    // ─────────────────────────────────────────────────────────

    /**
     * 闭环4补全：处理 Agent 调用成功事件，追踪 A/B 测试候选版本表现
     *
     * AgentCallSuccessPayload 包含 promptVersion 字段，与候选/活跃版本号比对：
     * - 匹配候选版本 → candidate.successCount++
     * - 匹配活跃版本 → candidate.activeSuccessCount++
     * - 流量分配计数器达阈值后触发 evaluateABTest
     */
    private async handleABTestCallResult(payload: unknown): Promise<void> {
        const data = payload as Partial<AgentCallSuccessPayload>
        if (!data?.agentId || !data?.promptVersion) return

        const candidate = this.abTestCandidates.get(data.agentId)
        if (!candidate) return

        // 比对版本号：匹配候选 → 候选成功；否则 → 活跃成功
        if (data.promptVersion === candidate.version) {
            candidate.successCount += 1
        } else {
            candidate.activeSuccessCount += 1
        }

        // 检查流量分配计数器是否达到最小样本数（每版本至少 MIN_AB_TEST_SAMPLES 次）
        if (candidate.alternationCounter >= MIN_AB_TEST_SAMPLES * 2) {
            this.evaluateABTest(data.agentId)
        }
    }

    /**
     * 闭环4补全：评估 A/B 测试结果，自动激活胜出版本
     *
     * 比较候选与活跃版本的成功率：
     * - 候选成功率 ≥ 活跃成功率 + AB_TEST_WIN_MARGIN → 候选胜出，setActive 激活
     * - 否则 → 候选落选，从内存清除（数据库记录保留为 inactive），维持原活跃版本
     *
     * 候选胜出时发射 ab-test:won 事件，前端据此刷新进化看板。
     */
    private evaluateABTest(agentId: string): void {
        const candidate = this.abTestCandidates.get(agentId)
        if (!candidate) return

        // 基于流量分配计数器计算各版本总调用次数
        const candidateUses = Math.floor(candidate.alternationCounter / 2)
        const activeUses = Math.ceil(candidate.alternationCounter / 2)

        // 计算成功率（避免除零）
        const candidateRate = candidateUses > 0
            ? candidate.successCount / candidateUses
            : 0
        const activeRate = activeUses > 0
            ? candidate.activeSuccessCount / activeUses
            : 0

        if (candidateRate >= activeRate + AB_TEST_WIN_MARGIN) {
            // 候选胜出：激活候选版本
            try {
                repos.promptVersions.setActive(agentId, candidate.version)
            } catch {
                // 激活失败不阻塞，下次调用仍使用旧活跃版本
            }

            // 发射 ab-test:won 事件
            const wonPayload: ABTestWonPayload = {
                agentId,
                winningVersion: candidate.version,
                candidateSuccessRate: Math.round(candidateRate * 1000) / 1000,
                activeSuccessRate: Math.round(activeRate * 1000) / 1000,
                activatedAt: Date.now(),
            }
            agentEvents.emit(AGENT_EVENTS.AB_TEST_WON, wonPayload)
            this.broadcastBusinessEvent('ab-test:won', wonPayload)
        }

        // 无论胜负，清除 A/B 测试候选跟踪（测试结束）
        this.abTestCandidates.delete(agentId)
    }

    /**
     * 闭环4补全：通过 WS 广播业务事件到前端
     *
     * 将进化引擎的业务事件封装为 WSEvent（type: 'business:event'），
     * 通过 broadcaster 推送到前端，前端 wsDispatcher 据此分发到对应 store。
     */
    private broadcastBusinessEvent(
        businessEventType: string,
        businessEventPayload: unknown,
    ): void {
        if (!this.broadcaster) return
        try {
            const wsEvent: WSEvent = {
                type: 'business:event',
                timestamp: Date.now(),
                sessionId: '',
                payload: {
                    businessEventType,
                    businessEventPayload,
                },
            }
            this.broadcaster.broadcast(wsEvent)
        } catch {
            // WS 推送失败不影响进化主流程
        }
    }

    /**
     * 订阅事件（统一管理监听器，便于 shutdown）
     */
    private subscribe(event: string, fn: (payload: unknown) => void): void {
        const wrapped = (...args: unknown[]): void => fn(args[0])
        agentEvents.on(event, wrapped)
        this.listeners.push({ event, fn: wrapped })
    }
}

// ─────────────────────────────────────────────────────────────
// 全局单例
// ─────────────────────────────────────────────────────────────

/**
 * 自我进化引擎全局单例
 *
 * 在 orchestrator/index.ts initOrchestrator 时调用 evolutionEngine.start() 启动。
 */
export const evolutionEngine = new EvolutionEngine()
