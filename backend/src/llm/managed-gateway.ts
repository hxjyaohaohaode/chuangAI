/**
 * 显式模型 Managed Gateway
 *
 * 与按 domain/function 选模的 LLMRouter 不同，本层严格保留调用方给定的
 * 官方模型与思考档，只补齐主动限流、重试边界、usage 计费、观测和中止语义。
 * 原始 DeepSeek/MiMo 客户端只应由 Router、此网关及供应商连通性探针使用。
 */

import { EventEmitter } from 'node:events'
import type {
    DeepSeekCallParams,
    DeepSeekClient,
    DeepSeekModel,
    DeepSeekResult,
} from './deepseek-client.js'
import type {
    MiMoClient,
    MimoAsrParams,
    MimoTextModel,
    MimoTextParams,
    MimoTextResult,
    MimoTtsParams,
} from './mimo-client.js'
import type { ErrorRecovery } from './error-recovery.js'
import { LLMError } from './error-recovery.js'
import type { TokenBilling } from './billing.js'
import {
    ProviderRateLimiter,
    RateLimitTimeoutError,
    type RateLimitProvider,
} from './rate-limiter.js'
import type { CallMetadata, ChatChunk } from './types.js'

export type ManagedTextParams = DeepSeekCallParams | MimoTextParams
export type ManagedTextResult = DeepSeekResult | MimoTextResult

export interface ManagedGatewayOptions {
    /** 非流式瞬态错误的最大重试次数；默认与 Router 一致为 3。 */
    maxRetries?: number
    /** 统一事件汇聚目标；生产环境传入 Router，沿用现有 EventBridge。 */
    eventSink?: Pick<EventEmitter, 'emit'>
}

interface ManagedCallContext {
    operation: 'chat' | 'stream' | 'tts' | 'asr'
    provider: 'deepseek' | 'mimo'
    rateProvider: RateLimitProvider
    model: string
    thinking?: string
    metadata: CallMetadata
    signal?: AbortSignal
    startedAt: number
}

interface UsageSnapshot {
    promptTokens: number
    completionTokens: number
    cachedTokens?: number
    audioDurationSec?: number
}

const DEEPSEEK_MODELS = new Set<string>(['deepseek-v4-pro', 'deepseek-v4-flash'])
const MIMO_TEXT_MODELS = new Set<string>(['mimo-v2.5', 'mimo-v2.5-pro'])

/**
 * 对显式指定的官方模型进行托管调用，不做 domain/function 路由，也不读取全局思考档。
 */
export class ManagedLLMGateway extends EventEmitter {
    private readonly maxRetries: number
    private readonly eventSink?: Pick<EventEmitter, 'emit'>

    constructor(
        private readonly deepseek: DeepSeekClient,
        private readonly mimo: MiMoClient,
        private readonly errorRecovery: ErrorRecovery,
        private readonly billing: TokenBilling,
        private readonly rateLimiter: ProviderRateLimiter = new ProviderRateLimiter(),
        options: ManagedGatewayOptions = {},
    ) {
        super()
        this.maxRetries = options.maxRetries ?? 3
        this.eventSink = options.eventSink
    }

    async chat(params: ManagedTextParams): Promise<ManagedTextResult> {
        const model = params.model
        const modelInfo = this.resolveTextModel(model)
        const context = this.buildContext('chat', modelInfo.provider, modelInfo.rateProvider, params)

        return this.runNonStreaming(
            context,
            async () => {
                this.assertTextCapabilities(params)
                if (modelInfo.provider === 'deepseek') {
                    return this.deepseek.chat(params as DeepSeekCallParams)
                }
                return this.mimo.chat(params as MimoTextParams)
            },
            (result) => ({ ...result.usage }),
        )
    }

    /**
     * 流式调用不自动重放：一旦已有分片交给消费者，重试会造成重复文本。
     * 仍统一覆盖限流、usage 计费、事件、安全错误与消费者提前关闭时的上游中止。
     */
    async *stream(params: ManagedTextParams): AsyncGenerator<ChatChunk> {
        const model = params.model
        const modelInfo = this.resolveTextModel(model)
        const linked = linkAbortSignal(params.signal)
        const context = this.buildContext('stream', modelInfo.provider, modelInfo.rateProvider, {
            ...params,
            signal: linked.controller.signal,
        })
        let release: (() => void) | undefined
        let completed = false
        let failureRecorded = false
        let usage: UsageSnapshot = { promptTokens: 0, completionTokens: 0 }

        this.emitStart(context)
        try {
            this.assertTextCapabilities(params)
            release = await this.rateLimiter.acquire(context.rateProvider, context.signal)
            const source = modelInfo.provider === 'deepseek'
                ? this.deepseek.stream({
                    ...(params as DeepSeekCallParams),
                    signal: context.signal,
                })
                : this.mimo.streamChat({
                    ...(params as MimoTextParams),
                    signal: context.signal,
                })

            for await (const chunk of source) {
                if (chunk.usage) usage = { ...chunk.usage }
                // 观测总线只记录分片形态，绝不复制正文或供应商 reasoning。
                this.publish('llm:stream:delta', {
                    domain: 'managed',
                    function: 'explicit-stream',
                    provider: context.provider,
                    model: context.model,
                    agent: context.metadata.agent,
                    task: context.metadata.task,
                    sessionId: context.metadata.sessionId,
                    chunk: {
                        hasContent: Boolean(chunk.content),
                        hasReasoning: Boolean(chunk.reasoning),
                        toolCallCount: chunk.toolCalls?.length ?? 0,
                        done: chunk.done ?? false,
                        hasUsage: Boolean(chunk.usage),
                    },
                    timestamp: Date.now(),
                })
                yield chunk
            }

            completed = true
            this.recordSuccess(context, usage)
        } catch (error) {
            failureRecorded = true
            const boundaryError = this.toBoundaryError(error)
            this.recordFailure(context, boundaryError)
            throw boundaryError
        } finally {
            release?.()
            if (!completed) linked.controller.abort('stream-consumer-closed')
            linked.cleanup()
            // 消费者 break/return 不会进入 catch，必须在 finally 形成可审计终态。
            if (!completed && !failureRecorded) {
                this.recordFailure(
                    context,
                    new LLMError('L1', 'network', '流式模型调用被提前终止', false),
                )
            }
        }
    }

    async tts(params: MimoTtsParams): Promise<Awaited<ReturnType<MiMoClient['tts']>>> {
        const context = this.buildContext('tts', 'mimo', 'mimo', params)
        return this.runNonStreaming(
            context,
            () => this.mimo.tts(params),
            () => ({ promptTokens: 0, completionTokens: 0 }),
        )
    }

    async asr(params: MimoAsrParams): Promise<Awaited<ReturnType<MiMoClient['asr']>>> {
        const context = this.buildContext('asr', 'mimo', 'mimo', params)
        return this.runNonStreaming(
            context,
            () => this.mimo.asr(params),
            (result) => ({
                promptTokens: 0,
                completionTokens: 0,
                audioDurationSec: result.durationSec,
            }),
        )
    }

    private async runNonStreaming<T>(
        context: ManagedCallContext,
        invoke: () => Promise<T>,
        extractUsage: (result: T) => UsageSnapshot,
    ): Promise<T> {
        this.emitStart(context)
        try {
            const result = await this.errorRecovery.wrap(
                async () => {
                    // 每个物理供应商请求（含重试）都重新获取 RPM/并发许可；
                    // 退避时不持有并发槽，避免慢故障拖垮其他课堂请求。
                    const release = await this.rateLimiter.acquire(context.rateProvider, context.signal)
                    try {
                        return await invoke()
                    } finally {
                        release()
                    }
                },
                {
                    agent: context.metadata.agent,
                    task: context.metadata.task,
                    maxRetries: this.maxRetries,
                    signal: context.signal,
                    onRetry: (error, attempt) => {
                        const safe = this.toBoundaryError(error)
                        this.publish('llm:call:error', {
                            ...this.eventBase(context),
                            error: `模型服务瞬态异常，准备第 ${attempt} 次重试`,
                            errorType: safe.type,
                            retrying: true,
                            attempt,
                            timestamp: Date.now(),
                        })
                    },
                },
            )

            this.recordSuccess(context, extractUsage(result))
            return result
        } catch (error) {
            const boundaryError = this.toBoundaryError(error)
            this.recordFailure(context, boundaryError)
            throw boundaryError
        }
    }

    private recordSuccess(context: ManagedCallContext, usage: UsageSnapshot): void {
        const latencyMs = Date.now() - context.startedAt
        const billingRecord = this.billing.record({
            agent: context.metadata.agent,
            task: context.metadata.task,
            sessionId: context.metadata.sessionId,
            provider: context.provider,
            model: context.model,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cachedTokens: usage.cachedTokens,
            audioDurationSec: usage.audioDurationSec,
            latencyMs,
            success: true,
            fallback: false,
        })
        this.publish('llm:call:success', {
            ...this.eventBase(context),
            latencyMs,
            costYuan: billingRecord.costYuan,
            fallback: false,
            timestamp: Date.now(),
        })
    }

    private recordFailure(context: ManagedCallContext, error: LLMError): void {
        const latencyMs = Date.now() - context.startedAt
        this.billing.record({
            agent: context.metadata.agent,
            task: context.metadata.task,
            sessionId: context.metadata.sessionId,
            provider: context.provider,
            model: context.model,
            promptTokens: 0,
            completionTokens: 0,
            latencyMs,
            success: false,
        })
        this.publish('llm:call:error', {
            ...this.eventBase(context),
            error: error.message,
            errorType: error.type,
            retrying: false,
            timestamp: Date.now(),
        })
    }

    private emitStart(context: ManagedCallContext): void {
        this.publish('llm:call:start', {
            ...this.eventBase(context),
            agent: context.metadata.agent,
            task: context.metadata.task,
            thinking: context.thinking,
            timestamp: context.startedAt,
        })
    }

    private eventBase(context: ManagedCallContext): Record<string, unknown> {
        return {
            domain: 'managed',
            function: `explicit-${context.operation}`,
            provider: context.provider,
            model: context.model,
            agent: context.metadata.agent,
            task: context.metadata.task,
            sessionId: context.metadata.sessionId,
            managed: true,
        }
    }

    private publish(event: string, payload: Record<string, unknown>): void {
        this.emit(event, payload)
        this.eventSink?.emit(event, payload)
    }

    private buildContext(
        operation: ManagedCallContext['operation'],
        provider: ManagedCallContext['provider'],
        rateProvider: RateLimitProvider,
        params: { model: string; thinking?: string; metadata?: CallMetadata; signal?: AbortSignal },
    ): ManagedCallContext {
        return {
            operation,
            provider,
            rateProvider,
            model: params.model,
            thinking: params.thinking,
            metadata: params.metadata ?? {
                agent: 'managed-llm',
                task: `${operation}:${params.model}`,
            },
            signal: params.signal,
            startedAt: Date.now(),
        }
    }

    private resolveTextModel(model: string): {
        provider: 'deepseek' | 'mimo'
        rateProvider: RateLimitProvider
    } {
        if (DEEPSEEK_MODELS.has(model)) {
            return {
                provider: 'deepseek',
                rateProvider: model === 'deepseek-v4-flash' ? 'deepseek-flash' : 'deepseek',
            }
        }
        if (MIMO_TEXT_MODELS.has(model)) {
            return { provider: 'mimo', rateProvider: 'mimo' }
        }
        throw new LLMError('L2', 'param', '仅允许使用官方 DeepSeek v4 或 MiMo v2.5 文本模型', false)
    }

    private assertTextCapabilities(params: ManagedTextParams): void {
        const runtime = params as ManagedTextParams & {
            images?: unknown[]
            thinking?: string
        }
        const hasImages = Array.isArray(runtime.images) && runtime.images.length > 0
        if (DEEPSEEK_MODELS.has(params.model) && hasImages) {
            throw new LLMError('L2', 'param', 'DeepSeek v4 为纯文本模型，禁止携带图片', false)
        }
        if (params.model === 'mimo-v2.5-pro' && hasImages) {
            throw new LLMError('L2', 'param', 'mimo-v2.5-pro 为纯文本模型，禁止携带图片', false)
        }
        if (runtime.thinking === 'max' && params.model !== 'deepseek-v4-pro') {
            throw new LLMError('L2', 'param', 'max 思考档仅 deepseek-v4-pro 支持', false)
        }
    }

    /** 对外错误不复制供应商响应、URL、密钥或 prompt，只保留可操作类别。 */
    private toBoundaryError(error: unknown): LLMError {
        const classified = error instanceof RateLimitTimeoutError
            ? new LLMError('L1', 'rate-limit', '模型服务主动限流等待超时', false, error)
            : this.errorRecovery.classifyError(error)
        const messageByType: Record<LLMError['type'], string> = {
            network: classified.retryable ? '模型服务网络异常，重试后仍未恢复' : '模型调用已中止',
            'rate-limit': '模型服务繁忙，请稍后重试',
            param: '模型调用参数不符合供应商约束',
            server: '模型服务暂时不可用，请稍后重试',
            tool: '模型工具调用失败',
            loop: '模型输出未收敛，调用已停止',
            unknown: '模型调用失败',
        }
        return new LLMError(
            classified.layer,
            classified.type,
            messageByType[classified.type],
            classified.retryable,
            classified.cause ?? error,
        )
    }
}

function linkAbortSignal(parent?: AbortSignal): {
    controller: AbortController
    cleanup: () => void
} {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(parent?.reason)
    if (parent?.aborted) onAbort()
    else parent?.addEventListener('abort', onAbort, { once: true })
    return {
        controller,
        cleanup: () => parent?.removeEventListener('abort', onAbort),
    }
}

// 导出模型类型仅用于调用方显式注解；不会扩展官方允许名单。
export type ManagedDeepSeekModel = DeepSeekModel
export type ManagedMimoTextModel = MimoTextModel
