/**
 * 结构化事件订阅器（任务 B6.5）
 *
 * 订阅 LLMRouter 与 agentEvents 的事件总线，将事件转换为结构化日志。
 *
 * 订阅的事件：
 * - LLMRouter：
 *   - llm:call:start   → debug（调用开始）
 *   - llm:call:success → debug（成功，含 token / 费用 / 延迟）
 *   - llm:call:error   → error（失败，含错误类型）
 *   - llm:stream:delta → trace（流式分片，默认不输出）
 *
 * - agentEvents：
 *   - agent:call:start   → debug（Agent 调用开始）
 *   - agent:call:success → info（成功，含延迟 / token / prompt 版本）
 *   - agent:call:error   → error（失败）
 *   - agent:fallback     → warn（触发降级）
 *   - agent:verify       → info（验收结果）
 *
 * 重复订阅安全：每个 attach 函数返回一个 detach 函数，便于测试与卸载。
 */

import type { EventEmitter } from 'node:events'
import type { Logger } from 'pino'
import { llmLogger, agentLogger, logLlmCall, logAgentCall } from './index.js'

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 调用开始事件缓存 TTL：超时后清理，避免内存泄漏 */
const START_CACHE_TTL_MS = 60_000

// ─────────────────────────────────────────────────────────────
// LLM 事件订阅
// ─────────────────────────────────────────────────────────────

/**
 * LLM 事件载荷类型（与 src/llm/router.ts 中定义保持一致）
 */
interface LlmCallStartPayload {
    domain: string
    function: string
    provider: string
    model: string
    thinking?: string
    agent: string
    task: string
    timestamp: number
}

interface LlmCallSuccessPayload {
    domain: string
    function: string
    provider: string
    model: string
    latencyMs: number
    costYuan: number
    fallback: boolean
    timestamp: number
}

interface LlmCallErrorPayload {
    domain: string
    function: string
    provider: string
    model: string
    error: string
    errorType: string
    timestamp: number
}

/**
 * LLM 事件订阅器所依赖的最小接口
 * 由 LLMRouter 实现
 */
export interface LlmEventSource {
    on(event: 'llm:call:start', listener: (payload: LlmCallStartPayload) => void): unknown
    on(event: 'llm:call:success', listener: (payload: LlmCallSuccessPayload) => void): unknown
    on(event: 'llm:call:error', listener: (payload: LlmCallErrorPayload) => void): unknown
    off(event: 'llm:call:start', listener: (payload: LlmCallStartPayload) => void): unknown
    off(event: 'llm:call:success', listener: (payload: LlmCallSuccessPayload) => void): unknown
    off(event: 'llm:call:error', listener: (payload: LlmCallErrorPayload) => void): unknown
}

// 缓存 start 事件数据，用于 success/error 时补充 token 信息
interface StartCacheEntry {
    thinking?: string
    agent?: string
    task?: string
    startedAt: number
}
const startCache = new Map<string, StartCacheEntry>()

/**
 * 订阅 LLM 事件总线，输出结构化日志
 *
 * @param source LLMRouter 实例或任何实现 LlmEventSource 的对象
 * @param logger 可选的自定义 logger，默认使用 llmLogger()
 * @returns detach 函数，调用后取消所有订阅
 */
export function attachLlmEventLoggers(
    source: LlmEventSource,
    logger: Logger = llmLogger(),
): () => void {
    const ownedStartKeys = new Set<string>()
    const onStart = (payload: LlmCallStartPayload): void => {
        const key = `${payload.domain}:${payload.function}:${payload.timestamp}`
        ownedStartKeys.add(key)
        startCache.set(key, {
            thinking: payload.thinking,
            agent: payload.agent,
            task: payload.task,
            startedAt: payload.timestamp,
        })
        // 60 秒后清理，避免内存泄漏
        setTimeout(() => {
            startCache.delete(key)
            ownedStartKeys.delete(key)
        }, START_CACHE_TTL_MS).unref?.()

        logger.debug(
            {
                domain: payload.domain,
                function: payload.function,
                provider: payload.provider,
                model: payload.model,
                thinking: payload.thinking,
                agent: payload.agent,
                task: payload.task,
            },
            `LLM 调用开始 ${payload.provider}/${payload.model} ${payload.function}`,
        )
    }

    const onSuccess = (payload: LlmCallSuccessPayload): void => {
        const key = `${payload.domain}:${payload.function}:${payload.timestamp}`
        const start = startCache.get(key)

        logLlmCall(logger, {
            provider: payload.provider,
            model: payload.model,
            thinking: start?.thinking,
            domain: payload.domain,
            function: payload.function,
            promptTokens: 0,
            completionTokens: 0,
            latencyMs: payload.latencyMs,
            costYuan: payload.costYuan,
            status: payload.fallback ? 'fallback' : 'success',
            agent: start?.agent,
            task: start?.task,
        })

        startCache.delete(key)
        ownedStartKeys.delete(key)
    }

    const onError = (payload: LlmCallErrorPayload): void => {
        const key = `${payload.domain}:${payload.function}:${payload.timestamp}`
        const start = startCache.get(key)

        logLlmCall(logger, {
            provider: payload.provider,
            model: payload.model,
            thinking: start?.thinking,
            domain: payload.domain,
            function: payload.function,
            promptTokens: 0,
            completionTokens: 0,
            latencyMs: start ? Date.now() - start.startedAt : 0,
            costYuan: 0,
            status: 'error',
            agent: start?.agent,
            task: start?.task,
            error: payload.error,
            errorType: payload.errorType,
        })

        startCache.delete(key)
        ownedStartKeys.delete(key)
    }

    source.on('llm:call:start', onStart)
    source.on('llm:call:success', onSuccess)
    source.on('llm:call:error', onError)

    return () => {
        source.off('llm:call:start', onStart)
        source.off('llm:call:success', onSuccess)
        source.off('llm:call:error', onError)
        for (const key of ownedStartKeys) startCache.delete(key)
        ownedStartKeys.clear()
    }
}

// ─────────────────────────────────────────────────────────────
// Agent 事件订阅
// ─────────────────────────────────────────────────────────────

/**
 * Agent 事件载荷类型（与 src/agents/base/events.ts 中定义保持一致）
 */
interface AgentCallStartPayload {
    agentId: string
    domain: string
    function: string
    bloomLevel: string
    promptVersion: string
    taskId: string
    sessionId?: string
    inputPreview: string
    timestamp: number
}

interface AgentCallSuccessPayload {
    agentId: string
    taskId: string
    sessionId?: string
    output: unknown
    usage: { promptTokens: number; completionTokens: number; cachedTokens?: number }
    latencyMs: number
    promptVersion: string
    timestamp: number
}

interface AgentCallErrorPayload {
    agentId: string
    taskId: string
    sessionId?: string
    error: string
    errorName: string
    timestamp: number
}

interface AgentFallbackPayload {
    agentId: string
    taskId: string
    reason: string
    timestamp: number
}

interface AgentVerifyPayload {
    targetAgentId: string
    verdict: 'pass' | 'revise' | 'reject'
    score: number
    timestamp: number
}

/**
 * 订阅 Agent 事件总线，输出结构化日志
 *
 * @param eventBus agentEvents 单例
 * @param logger 可选的自定义 logger，默认使用 agentLogger()
 * @returns detach 函数，调用后取消所有订阅
 */
export function attachAgentEventLoggers(
    eventBus: EventEmitter,
    logger: Logger = agentLogger(),
): () => void {
    // 缓存 start 事件，用于 success/error 时补全字段
    const startCacheAgent = new Map<string, AgentCallStartPayload>()

    const onStart = (payload: AgentCallStartPayload): void => {
        startCacheAgent.set(payload.taskId, payload)
        setTimeout(() => startCacheAgent.delete(payload.taskId), START_CACHE_TTL_MS).unref?.()

        logger.debug(
            {
                agentId: payload.agentId,
                agentType: payload.domain,
                action: payload.function,
                bloomLevel: payload.bloomLevel,
                promptVersion: payload.promptVersion,
                taskId: payload.taskId,
                sessionId: payload.sessionId,
            },
            `Agent 调用开始 ${payload.agentId} ${payload.function}`,
        )
    }

    const onSuccess = (payload: AgentCallSuccessPayload): void => {
        const start = startCacheAgent.get(payload.taskId)

        logAgentCall(logger, {
            agentId: payload.agentId,
            agentType: start?.domain ?? 'unknown',
            action: start?.function ?? 'unknown',
            durationMs: payload.latencyMs,
            result: 'success',
            bloomLevel: start?.bloomLevel,
            promptVersion: payload.promptVersion,
            taskId: payload.taskId,
            sessionId: payload.sessionId,
            promptTokens: payload.usage.promptTokens,
            completionTokens: payload.usage.completionTokens,
        })

        startCacheAgent.delete(payload.taskId)
    }

    const onError = (payload: AgentCallErrorPayload): void => {
        const start = startCacheAgent.get(payload.taskId)
        const durationMs = start ? Date.now() - start.timestamp : 0

        logAgentCall(logger, {
            agentId: payload.agentId,
            agentType: start?.domain ?? 'unknown',
            action: start?.function ?? 'unknown',
            durationMs,
            result: 'error',
            bloomLevel: start?.bloomLevel,
            promptVersion: start?.promptVersion,
            taskId: payload.taskId,
            sessionId: payload.sessionId,
            error: payload.error,
        })

        startCacheAgent.delete(payload.taskId)
    }

    const onFallback = (payload: AgentFallbackPayload): void => {
        logAgentCall(logger, {
            agentId: payload.agentId,
            agentType: 'unknown',
            action: 'fallback',
            durationMs: 0,
            result: 'fallback',
            taskId: payload.taskId,
            fallbackReason: payload.reason,
        })
    }

    const onVerify = (payload: AgentVerifyPayload): void => {
        logger.info(
            {
                targetAgentId: payload.targetAgentId,
                verdict: payload.verdict,
                score: payload.score,
            },
            `Agent 验收 ${payload.targetAgentId} → ${payload.verdict} (score=${payload.score})`,
        )
    }

    eventBus.on('agent:call:start', onStart)
    eventBus.on('agent:call:success', onSuccess)
    eventBus.on('agent:call:error', onError)
    eventBus.on('agent:fallback', onFallback)
    eventBus.on('agent:verify', onVerify)

    return () => {
        eventBus.off('agent:call:start', onStart)
        eventBus.off('agent:call:success', onSuccess)
        eventBus.off('agent:call:error', onError)
        eventBus.off('agent:fallback', onFallback)
        eventBus.off('agent:verify', onVerify)
        startCacheAgent.clear()
    }
}
