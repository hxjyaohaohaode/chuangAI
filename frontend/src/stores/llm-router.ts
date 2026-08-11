/**
 * LLM Router Store（P4 LLM 路由透明）
 *
 * 职责：
 * 1. 订阅 WebSocket 推送的 llm:call:* 事件，实时维护 LLM 调用链
 * 2. 按 provider/model 聚合调用次数、成本、延迟、成功率
 * 3. 提供 selectors 供 LLMRouterPanel 渲染路由透明视图
 *
 * 事件来源（经 event-bridge.ts 桥接到 WebSocket）：
 * - llm:call:start    — LLM 调用开始（含 provider/model/thinking/agent/task）
 * - llm:call:success  — LLM 调用成功（含 latencyMs/costYuan/fallback）
 * - llm:call:error    — LLM 调用失败（含 error/errorType）
 *
 * 设计要点：
 * - 调用链按 agent+task 关联 start/success/error 三态
 * - 成本实时累加，按 provider/model 分桶
 * - 调用历史上限 100 条（FIFO），避免内存膨胀
 * - 路由矩阵为前端静态镜像（与后端 ROUTE_MATRIX 对齐），供可视化展示
 */

import { create } from 'zustand'
import { api } from '@/lib/api'
import { toast } from './toast'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

export type LLMCallStatus = 'running' | 'success' | 'error'

export interface LLMCall {
    /** 调用唯一 id（agent:task:startedAt） */
    id: string
    domain: string
    function: string
    provider: 'deepseek' | 'mimo' | string
    model: string
    thinking?: string
    agent: string
    task: string
    sessionId?: string
    status: LLMCallStatus
    startedAt: number
    endedAt?: number
    latencyMs?: number
    costYuan?: number
    fallback?: boolean
    error?: string
    errorType?: string
}

export interface ModelStat {
    provider: string
    model: string
    callCount: number
    successCount: number
    errorCount: number
    fallbackCount: number
    totalCostYuan: number
    avgLatencyMs: number
    /** 加权平均延迟的辅助计数器 */
    _latencySum: number
    _latencyCount: number
}

export interface LLMRouterState {
    /** 调用链路（最近 100 条，新的在前） */
    calls: LLMCall[]
    /** 模型统计 by `${provider}:${model}` */
    modelStats: Map<string, ModelStat>
    /** 总成本（元） */
    totalCostYuan: number
    /** 总调用数 */
    totalCalls: number
    /**
     * 全局思考模式覆盖（v5.0 创新点：深度思考模式 UI 暴露）
     * - null：未覆盖，使用路由矩阵预设
     * - 'low' / 'medium' / 'high' / 'max'：覆盖所有 LLM 调用的思考深度
     */
    thinkingMode: 'low' | 'medium' | 'high' | 'max' | null
    /** 思考模式切换加载中（乐观更新期间） */
    thinkingModeLoading: boolean

    // ── 动作 ──
    handleWSEvent: (event: { type: string; payload: unknown; timestamp: number; sessionId: string }) => void
    clearHistory: () => void
    getModelStatsList: () => ModelStat[]
    getOverallStats: () => {
        totalCalls: number
        totalCostYuan: number
        successRate: number
        avgLatencyMs: number
        deepseekCallCount: number
        mimoCallCount: number
        fallbackCount: number
    }
    /**
     * 设置全局思考模式（v5.0 创新点）
     * 乐观更新：立即更新 UI，后台 POST 确认，失败回滚 + toast
     */
    setThinkingMode: (mode: 'low' | 'medium' | 'high' | 'max' | null) => Promise<void>
    /** 初始化：从后端拉取当前思考模式（App 启动时调用一次） */
    initThinkingMode: () => Promise<void>
    /** 处理 thinking-mode:changed WS 事件（多 Tab 同步） */
    handleThinkingModeWSEvent: (event: { type: string; payload: unknown }) => void
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const MAX_CALLS = 100

// ─────────────────────────────────────────────────────────────
// 路由矩阵镜像（与后端 ROUTE_MATRIX 对齐，供前端可视化展示）
// ─────────────────────────────────────────────────────────────

export interface RouteMatrixEntry {
    domain: string
    function: string
    provider: 'deepseek' | 'mimo'
    model: string
    thinking?: string
    reason: string
}

export const ROUTE_MATRIX_MIRROR: RouteMatrixEntry[] = [
    { domain: 'mind', function: 'diagnose', provider: 'deepseek', model: 'deepseek-v4-pro', thinking: 'max', reason: '复杂认知诊断需深度推理' },
    { domain: 'mind', function: 'profile', provider: 'mimo', model: 'mimo-v2.5-pro', thinking: 'medium', reason: '多维画像需 1M 上下文' },
    { domain: 'mind', function: 'recommend', provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'medium', reason: '推荐路径规则化' },
    { domain: 'mind', function: 'verify', provider: 'deepseek', model: 'deepseek-v4-pro', thinking: 'high', reason: '验收需独立深度审核' },
    { domain: 'eye', function: 'vision-annotate', provider: 'mimo', model: 'mimo-v2.5', thinking: 'high', reason: '视觉标注必须多模态' },
    { domain: 'eye', function: 'asr', provider: 'mimo', model: 'mimo-v2.5-asr', reason: '语音识别专用模型' },
    { domain: 'eye', function: 'tts', provider: 'mimo', model: 'mimo-v2.5-tts', reason: '语音合成专用模型' },
    { domain: 'brush', function: 'generate-question', provider: 'deepseek', model: 'deepseek-v4-pro', thinking: 'max', reason: '命题需创造性深度思考' },
    { domain: 'brush', function: 'grade', provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'low', reason: '批改追求速度' },
    { domain: 'brush', function: 'report', provider: 'deepseek', model: 'deepseek-v4-pro', thinking: 'high', reason: '报告需综合分析' },
    { domain: 'brush', function: 'creative', provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'medium', reason: '创意素材性价比最优' },
    { domain: 'orchestrator', function: 'route', provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'low', reason: '路由决策需快速响应' },
    { domain: 'orchestrator', function: 'summarize', provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'low', reason: '摘要任务规则化' },
    { domain: 'verifier', function: 'verify', provider: 'deepseek', model: 'deepseek-v4-pro', thinking: 'high', reason: '独立验收需深度审核' },
]

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

function makeCallId(agent: string, task: string, startedAt: number): string {
    return `${agent}:${task}:${startedAt}`
}

function getOrCreateStat(
    stats: Map<string, ModelStat>,
    provider: string,
    model: string,
): ModelStat {
    const key = `${provider}:${model}`
    let s = stats.get(key)
    if (!s) {
        s = {
            provider,
            model,
            callCount: 0,
            successCount: 0,
            errorCount: 0,
            fallbackCount: 0,
            totalCostYuan: 0,
            avgLatencyMs: 0,
            _latencySum: 0,
            _latencyCount: 0,
        }
        stats.set(key, s)
    }
    return s
}

// ─────────────────────────────────────────────────────────────
// Store 实现
// ─────────────────────────────────────────────────────────────

export const useLLMRouterStore = create<LLMRouterState>((set, get) => ({
    calls: [],
    modelStats: new Map(),
    totalCostYuan: 0,
    totalCalls: 0,
    thinkingMode: null,
    thinkingModeLoading: false,

    handleWSEvent: (event) => {
        const { type, payload, timestamp } = event
        if (!type.startsWith('llm:call:')) return

        const p = (payload ?? {}) as Record<string, unknown>

        switch (type) {
            case 'llm:call:start': {
                const agent = (p.agent as string) ?? ''
                const task = (p.task as string) ?? ''
                const startedAt = (p.timestamp as number) ?? timestamp
                const call: LLMCall = {
                    id: makeCallId(agent, task, startedAt),
                    domain: (p.domain as string) ?? '',
                    function: (p.function as string) ?? '',
                    provider: (p.provider as string) ?? '',
                    model: (p.model as string) ?? '',
                    thinking: p.thinking as string | undefined,
                    agent,
                    task,
                    sessionId: p.sessionId as string | undefined,
                    status: 'running',
                    startedAt,
                }
                set((s) => {
                    const calls = [call, ...s.calls].slice(0, MAX_CALLS)
                    const modelStats = new Map(s.modelStats)
                    const stat = getOrCreateStat(modelStats, call.provider, call.model)
                    stat.callCount++
                    return {
                        calls,
                        modelStats,
                        totalCalls: s.totalCalls + 1,
                    }
                })
                break
            }
            case 'llm:call:success': {
                const agent = (p.agent as string) ?? ''
                const task = (p.task as string) ?? ''
                const provider = (p.provider as string) ?? ''
                const model = (p.model as string) ?? ''
                const endedAt = (p.timestamp as number) ?? timestamp
                const latencyMs = (p.latencyMs as number) ?? 0
                const costYuan = (p.costYuan as number) ?? 0
                const fallback = (p.fallback as boolean) ?? false
                set((s) => {
                    const calls = s.calls.map((c) => {
                        if (c.agent === agent && c.task === task && c.status === 'running') {
                            return {
                                ...c,
                                status: 'success' as const,
                                endedAt,
                                latencyMs,
                                costYuan,
                                fallback,
                            }
                        }
                        return c
                    })
                    const modelStats = new Map(s.modelStats)
                    const stat = getOrCreateStat(modelStats, provider, model)
                    stat.successCount++
                    if (fallback) stat.fallbackCount++
                    stat.totalCostYuan += costYuan
                    stat._latencySum += latencyMs
                    stat._latencyCount++
                    stat.avgLatencyMs = stat._latencySum / Math.max(stat._latencyCount, 1)
                    return {
                        calls,
                        modelStats,
                        totalCostYuan: s.totalCostYuan + costYuan,
                    }
                })
                break
            }
            case 'llm:call:error': {
                const agent = (p.agent as string) ?? ''
                const task = (p.task as string) ?? ''
                const provider = (p.provider as string) ?? ''
                const model = (p.model as string) ?? ''
                const endedAt = (p.timestamp as number) ?? timestamp
                const error = (p.error as string) ?? '未知错误'
                const errorType = (p.errorType as string) ?? 'unknown'
                set((s) => {
                    const calls = s.calls.map((c) => {
                        if (c.agent === agent && c.task === task && c.status === 'running') {
                            return {
                                ...c,
                                status: 'error' as const,
                                endedAt,
                                error,
                                errorType,
                                latencyMs: endedAt - c.startedAt,
                            }
                        }
                        return c
                    })
                    const modelStats = new Map(s.modelStats)
                    const stat = getOrCreateStat(modelStats, provider, model)
                    stat.errorCount++
                    return { calls, modelStats }
                })
                break
            }
            default:
                break
        }
    },

    clearHistory: () => {
        set({ calls: [], modelStats: new Map(), totalCostYuan: 0, totalCalls: 0 })
    },

    setThinkingMode: async (mode) => {
        const prevMode = get().thinkingMode
        // 乐观更新（规范 12.3：≤50ms 内反映预期结果）
        set({ thinkingMode: mode, thinkingModeLoading: true })
        try {
            await api.copilot.setThinkingMode(mode)
            // 成功：静默确认（规范 12.3：成功无额外 UI 反馈）
            set({ thinkingModeLoading: false })
        } catch (err) {
            // 失败：回滚 + toast（规范 12.3）
            set({ thinkingMode: prevMode, thinkingModeLoading: false })
            toast.error({
                title: '思考模式切换失败',
                message: err instanceof Error ? err.message : '已回滚到上一个模式',
            })
        }
    },

    initThinkingMode: async () => {
        try {
            const res = await api.copilot.getThinkingMode()
            set({ thinkingMode: res.mode })
        } catch {
            // 拉取失败静默，保持默认 null
        }
    },

    handleThinkingModeWSEvent: (event) => {
        // 处理 thinking-mode:changed 事件（多 Tab 同步）
        if (event.type !== 'thinking-mode:changed') return
        const payload = event.payload as { mode?: 'low' | 'medium' | 'high' | 'max' | null }
        if (!payload) return
        set({ thinkingMode: payload.mode ?? null })
    },

    getModelStatsList: () => {
        return Array.from(get().modelStats.values()).sort((a, b) => b.callCount - a.callCount)
    },

    getOverallStats: () => {
        const { modelStats, totalCostYuan, totalCalls } = get()
        let totalSuccess = 0
        let totalFallback = 0
        let totalLatency = 0
        let latencyCount = 0
        let deepseekCallCount = 0
        let mimoCallCount = 0
        for (const s of modelStats.values()) {
            totalSuccess += s.successCount
            totalFallback += s.fallbackCount
            if (s._latencyCount > 0) {
                totalLatency += s.avgLatencyMs
                latencyCount++
            }
            if (s.provider === 'deepseek') deepseekCallCount += s.callCount
            else if (s.provider === 'mimo') mimoCallCount += s.callCount
        }
        // successRate = successCount / totalCalls
        const successRate = totalCalls > 0 ? totalSuccess / totalCalls : 0
        return {
            totalCalls,
            totalCostYuan,
            successRate,
            avgLatencyMs: latencyCount > 0 ? totalLatency / latencyCount : 0,
            deepseekCallCount,
            mimoCallCount,
            fallbackCount: totalFallback,
        }
    },
}))
