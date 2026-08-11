/**
 * Agent Runtime Store（P3 Agent 可见性）
 *
 * 职责：
 * 1. 订阅 WebSocket 推送的 agent:* 事件，实时维护 Agent 调用链
 * 2. 聚合每个 Agent 的健康指标（成功率/延迟/fallback/验收结果）
 * 3. 提供 selectors 供 AgentRuntimePanel / AgentHealthDashboard 渲染
 *
 * 事件来源（经 event-bridge.ts 桥接到 WebSocket）：
 * - agent:call:start    — Agent 调用开始
 * - agent:call:success  — Agent 调用成功
 * - agent:call:error    — Agent 调用失败
 * - agent:fallback      — Agent 触发降级
 * - agent:verify        — 验收 Agent 完成审核
 *
 * 设计要点：
 * - 调用链按 taskId 关联 start/success/error 三态，超时未匹配的 start 自动标记 stale
 * - 健康指标实时增量聚合，无需全量重算
 * - 调用历史上限 200 条（FIFO），避免内存膨胀
 * - verify 事件独立存储，按 targetAgentId 聚合到对应 Agent 的验收统计
 */

import { create } from 'zustand'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

export type AgentCallStatus = 'running' | 'success' | 'error' | 'stale'

export interface AgentCall {
    /** 调用唯一 id（agentId + taskId + startedAt） */
    id: string
    agentId: string
    domain: string
    function: string
    bloomLevel: string
    promptVersion: string
    taskId: string
    sessionId?: string
    inputPreview: string
    status: AgentCallStatus
    startedAt: number
    endedAt?: number
    latencyMs?: number
    usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number }
    error?: string
    errorName?: string
    fallbackReason?: string
    verifyVerdict?: 'pass' | 'revise' | 'reject'
    verifyScore?: number
}

export interface AgentHealth {
    agentId: string
    totalCalls: number
    successCount: number
    errorCount: number
    fallbackCount: number
    /** 加权平均延迟（近期权重更高） */
    avgLatencyMs: number
    lastCallAt: number
    /** 验收统计 */
    verifyPass: number
    verifyRevise: number
    verifyReject: number
    /** 最近一次调用状态 */
    lastStatus: AgentCallStatus
}

export interface AgentRuntimeState {
    /** 调用链路（最近 200 条，新的在前） */
    calls: AgentCall[]
    /** 健康指标 by agentId */
    health: Map<string, AgentHealth>
    /** 是否展开（供 UI 切换） */
    expanded: boolean

    // ── 动作 ──
    handleWSEvent: (event: { type: string; payload: unknown; timestamp: number; sessionId: string }) => void
    clearHistory: () => void
    setExpanded: (expanded: boolean) => void
    getCallsBySession: (sessionId: string) => AgentCall[]
    getCallsByAgent: (agentId: string) => AgentCall[]
    getOverallHealth: () => {
        totalAgents: number
        totalCalls: number
        overallSuccessRate: number
        overallAvgLatency: number
        activeCallCount: number
    }
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const MAX_CALLS = 200
/** running 状态超过 5 分钟视为 stale */
const STALE_THRESHOLD_MS = 5 * 60 * 1000

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

function makeCallId(agentId: string, taskId: string, startedAt: number): string {
    return `${agentId}:${taskId}:${startedAt}`
}

function getOrCreateHealth(
    health: Map<string, AgentHealth>,
    agentId: string,
): AgentHealth {
    let h = health.get(agentId)
    if (!h) {
        h = {
            agentId,
            totalCalls: 0,
            successCount: 0,
            errorCount: 0,
            fallbackCount: 0,
            avgLatencyMs: 0,
            lastCallAt: 0,
            verifyPass: 0,
            verifyRevise: 0,
            verifyReject: 0,
            lastStatus: 'running',
        }
        health.set(agentId, h)
    }
    return h
}

/**
 * 标记超时的 running 调用为 stale
 */
function markStaleCalls(calls: AgentCall[]): AgentCall[] {
    const now = Date.now()
    return calls.map((c) => {
        if (c.status === 'running' && now - c.startedAt > STALE_THRESHOLD_MS) {
            return { ...c, status: 'stale' as const }
        }
        return c
    })
}

// ─────────────────────────────────────────────────────────────
// Store 实现
// ─────────────────────────────────────────────────────────────

export const useAgentRuntimeStore = create<AgentRuntimeState>((set, get) => ({
    calls: [],
    health: new Map(),
    expanded: false,

    handleWSEvent: (event) => {
        const { type, payload, timestamp } = event
        if (!type.startsWith('agent:')) return

        const p = (payload ?? {}) as Record<string, unknown>

        switch (type) {
            case 'agent:call:start': {
                const agentId = p.agentId as string
                const taskId = p.taskId as string
                const startedAt = (p.timestamp as number) ?? timestamp
                const call: AgentCall = {
                    id: makeCallId(agentId, taskId, startedAt),
                    agentId,
                    domain: (p.domain as string) ?? '',
                    function: (p.function as string) ?? '',
                    bloomLevel: (p.bloomLevel as string) ?? '',
                    promptVersion: (p.promptVersion as string) ?? '',
                    taskId,
                    sessionId: p.sessionId as string | undefined,
                    inputPreview: (p.inputPreview as string) ?? '',
                    status: 'running',
                    startedAt,
                }
                set((s) => {
                    const calls = [call, ...s.calls].slice(0, MAX_CALLS)
                    const health = new Map(s.health)
                    const h = getOrCreateHealth(health, agentId)
                    health.set(agentId, {
                        ...h,
                        totalCalls: h.totalCalls + 1,
                        lastCallAt: startedAt,
                        lastStatus: 'running',
                    })
                    return { calls: markStaleCalls(calls), health }
                })
                break
            }
            case 'agent:call:success': {
                const agentId = p.agentId as string
                const taskId = p.taskId as string
                const endedAt = (p.timestamp as number) ?? timestamp
                const latencyMs = (p.latencyMs as number) ?? 0
                const usage = p.usage as { promptTokens: number; completionTokens: number; cachedTokens?: number } | undefined
                set((s) => {
                    const calls = s.calls.map((c) => {
                        // 匹配同 agentId + taskId 的 running 调用
                        if (c.agentId === agentId && c.taskId === taskId && c.status === 'running') {
                            return {
                                ...c,
                                status: 'success' as const,
                                endedAt,
                                latencyMs,
                                usage,
                            }
                        }
                        return c
                    })
                    const health = new Map(s.health)
                    const h = getOrCreateHealth(health, agentId)
                    // 增量平均延迟：new_avg = old_avg + (new_value - old_avg) / new_count
                    const newSuccessCount = h.successCount + 1
                    const newAvgLatency = h.avgLatencyMs + (latencyMs - h.avgLatencyMs) / Math.max(newSuccessCount, 1)
                    health.set(agentId, {
                        ...h,
                        successCount: newSuccessCount,
                        avgLatencyMs: newAvgLatency,
                        lastCallAt: endedAt,
                        lastStatus: 'success',
                    })
                    return { calls: markStaleCalls(calls), health }
                })
                break
            }
            case 'agent:call:error': {
                const agentId = p.agentId as string
                const taskId = p.taskId as string
                const endedAt = (p.timestamp as number) ?? timestamp
                const error = (p.error as string) ?? '未知错误'
                const errorName = (p.errorName as string) ?? 'Unknown'
                set((s) => {
                    const calls = s.calls.map((c) => {
                        if (c.agentId === agentId && c.taskId === taskId && c.status === 'running') {
                            return {
                                ...c,
                                status: 'error' as const,
                                endedAt,
                                error,
                                errorName,
                                latencyMs: endedAt - c.startedAt,
                            }
                        }
                        return c
                    })
                    const health = new Map(s.health)
                    const h = getOrCreateHealth(health, agentId)
                    health.set(agentId, {
                        ...h,
                        errorCount: h.errorCount + 1,
                        lastCallAt: endedAt,
                        lastStatus: 'error',
                    })
                    return { calls: markStaleCalls(calls), health }
                })
                break
            }
            case 'agent:fallback': {
                const agentId = p.agentId as string
                const taskId = p.taskId as string
                const reason = (p.reason as string) ?? '未知降级原因'
                set((s) => {
                    const calls = s.calls.map((c) => {
                        if (c.agentId === agentId && c.taskId === taskId) {
                            return { ...c, fallbackReason: reason }
                        }
                        return c
                    })
                    const health = new Map(s.health)
                    const h = getOrCreateHealth(health, agentId)
                    health.set(agentId, {
                        ...h,
                        fallbackCount: h.fallbackCount + 1,
                    })
                    return { calls, health }
                })
                break
            }
            case 'agent:verify': {
                const targetAgentId = p.targetAgentId as string
                const verdict = p.verdict as 'pass' | 'revise' | 'reject'
                const score = (p.score as number) ?? 0
                set((s) => {
                    const calls = s.calls.map((c) => {
                        // 关联到最近一条该 agent 的调用
                        if (c.agentId === targetAgentId && c.status === 'success' && !c.verifyVerdict) {
                            return { ...c, verifyVerdict: verdict, verifyScore: score }
                        }
                        return c
                    })
                    const health = new Map(s.health)
                    const h = getOrCreateHealth(health, targetAgentId)
                    if (verdict === 'pass') health.set(targetAgentId, { ...h, verifyPass: h.verifyPass + 1 })
                    else if (verdict === 'revise') health.set(targetAgentId, { ...h, verifyRevise: h.verifyRevise + 1 })
                    else health.set(targetAgentId, { ...h, verifyReject: h.verifyReject + 1 })
                    return { calls, health }
                })
                break
            }
            default:
                break
        }
    },

    clearHistory: () => {
        set({ calls: [], health: new Map() })
    },

    setExpanded: (expanded) => set({ expanded }),

    getCallsBySession: (sessionId) => {
        return get().calls.filter((c) => c.sessionId === sessionId)
    },

    getCallsByAgent: (agentId) => {
        return get().calls.filter((c) => c.agentId === agentId)
    },

    getOverallHealth: () => {
        const { calls, health } = get()
        let totalCalls = 0
        let totalSuccess = 0
        let totalLatency = 0
        let latencyCount = 0
        let activeCallCount = 0
        for (const h of health.values()) {
            totalCalls += h.totalCalls
            totalSuccess += h.successCount
            if (h.avgLatencyMs > 0) {
                totalLatency += h.avgLatencyMs
                latencyCount++
            }
        }
        for (const c of calls) {
            if (c.status === 'running') activeCallCount++
        }
        return {
            totalAgents: health.size,
            totalCalls,
            overallSuccessRate: totalCalls > 0 ? totalSuccess / totalCalls : 0,
            overallAvgLatency: latencyCount > 0 ? totalLatency / latencyCount : 0,
            activeCallCount,
        }
    },
}))
