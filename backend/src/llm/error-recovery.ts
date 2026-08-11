/**
 * LLM 错误分层恢复系统
 *
 * 实现 5 层恢复策略（L1-L5），覆盖从网络抖动到死循环检测的全链路错误处理：
 *
 * L1 指数退避重试  — 网络错误 / 5xx / 429，带 jitter 的指数退避
 * L2 参数错回注    — 4xx 参数错误，将错误回注 system message 重新请求
 * L3 工具失败回注  — tool 调用返回错误，将错误注入对话让模型自我修正
 * L4 死循环检测    — 连续相同输出 / 工具调用未收敛，抛出 loop 错误
 * L5 优雅降级      — 所有重试失败，返回预定义 fallback 内容
 */

import { EventEmitter } from 'node:events'
import type { ChatMessage, Domain, Function } from './types.js'

// ─────────────────────────────────────────────────────────────
// LLMError — 统一错误类型
// ─────────────────────────────────────────────────────────────

export type ErrorLayer = 'L1' | 'L2' | 'L3' | 'L4' | 'L5'
export type ErrorType =
    | 'network'
    | 'rate-limit'
    | 'param'
    | 'server'
    | 'tool'
    | 'loop'
    | 'unknown'

/**
 * LLM 调用统一错误
 * layer 标识错误被哪一层处理，type 标识错误类别，retryable 标识是否可重试
 */
export class LLMError extends Error {
    constructor(
        public layer: ErrorLayer,
        public type: ErrorType,
        message: string,
        public retryable: boolean,
        public cause?: unknown,
    ) {
        super(message)
        this.name = 'LLMError'
    }
}

// ─────────────────────────────────────────────────────────────
// 回恢复选项
// ─────────────────────────────────────────────────────────────

export interface WrapOptions {
    agent: string
    task: string
    /** 最大重试次数，默认 3 */
    maxRetries?: number
    /** 重试回调（用于观测/日志） */
    onRetry?: (err: LLMError, attempt: number) => void
    /** L5 降级内容生成器（若提供，所有重试失败后调用以获取降级值） */
    fallback?: () => unknown | Promise<unknown>
    /** 请求中止信号；中止后不得继续退避或发起下一次供应商调用。 */
    signal?: AbortSignal
}

// ─────────────────────────────────────────────────────────────
// L4 循环检测条目
// ─────────────────────────────────────────────────────────────

interface LoopTracker {
    /** 最近输出的哈希数组 */
    outputs: string[]
    /** 最近工具调用签名数组 */
    toolSignatures: string[]
}

// ─────────────────────────────────────────────────────────────
// 降级内容表
// ─────────────────────────────────────────────────────────────

/**
 * 按 domain × function 预定义的降级返回内容
 * 降级内容必须明确标注"AI 生成（降级模式）"，避免用户误以为是正常输出
 */
const FALLBACK_CONTENT: Record<string, string> = {
    // mind 域
    'mind:diagnose': '[AI 生成（降级模式）] 认知诊断服务暂时不可用，请稍后重试或联系管理员。',
    'mind:profile': '[AI 生成（降级模式）] 学情画像生成服务暂时不可用，请稍后重试。',
    'mind:recommend': '[AI 生成（降级模式）] 推荐路径生成服务暂时不可用，请稍后重试。',
    'mind:verify': '[AI 生成（降级模式）] 验收服务暂时不可用，请稍后重试。',
    // eye 域
    'eye:vision-annotate': '[AI 生成（降级模式）] 视觉标注服务暂时不可用，请稍后重试。',
    'eye:asr': '[AI 生成（降级模式）] 语音识别服务暂时不可用，请稍后重试。',
    'eye:tts': '[AI 生成（降级模式）] 语音合成服务暂时不可用，请稍后重试。',
    // brush 域
    'brush:generate-question': '[AI 生成（降级模式）] 命题服务暂时不可用，请稍后重试。',
    'brush:grade': '[AI 生成（降级模式）] 批改服务暂时不可用，请稍后重试。',
    'brush:report': '[AI 生成（降级模式）] 报告生成服务暂时不可用，请稍后重试。',
    'brush:creative': '[AI 生成（降级模式）] 创意生成服务暂时不可用，请稍后重试。',
    // orchestrator 域
    'orchestrator:route': '[AI 生成（降级模式）] 路由决策服务暂时不可用，请稍后重试。',
    'orchestrator:summarize': '[AI 生成（降级模式）] 摘要服务暂时不可用，请稍后重试。',
    // verifier 域
    'verifier:verify': '[AI 生成（降级模式）] 独立验收服务暂时不可用，请稍后重试。',
}

// ─────────────────────────────────────────────────────────────
// ErrorRecovery — 错误恢复引擎
// ─────────────────────────────────────────────────────────────

/**
 * 5 层错误恢复引擎
 *
 * 继承 EventEmitter，在 L5 降级时推送 `llm:fallback` 事件
 */
export class ErrorRecovery extends EventEmitter {
    /** L4 循环检测状态：key = `${agent}:${task}` */
    private loopTrackers = new Map<string, LoopTracker>()
    /** L4 连续相同输出阈值 */
    private static readonly LOOP_OUTPUT_THRESHOLD = 3
    /** L4 连续工具调用未收敛阈值 */
    private static readonly LOOP_TOOL_THRESHOLD = 5

    /**
     * L1 + L5：包装函数，带指数退避重试与降级回退
     *
     * - L1：对 network / rate-limit / server 类型错误执行指数退避重试
     * - L5：所有重试失败后，若提供 fallback 则返回降级值，否则抛出最后错误
     *
     * @param fn 被包装的异步函数
     * @param opts 恢复选项
     */
    async wrap<T>(fn: () => Promise<T>, opts: WrapOptions): Promise<T> {
        const maxRetries = opts.maxRetries ?? 3
        let lastError: LLMError | undefined

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            this.throwIfAborted(opts.signal)
            try {
                return await fn()
            } catch (err) {
                const llmErr = this.classifyError(err)

                // L4 死循环错误：不可重试，直接抛出
                if (llmErr.type === 'loop') {
                    throw llmErr
                }

                // L2 参数错误 / L3 工具错误：不由 L1 重试，直接抛出由上层处理
                if (!llmErr.retryable) {
                    throw llmErr
                }

                lastError = llmErr

                // 已达最大重试次数，跳出
                if (attempt >= maxRetries) {
                    break
                }

                // L1 指数退避
                const delay = this.calcBackoff(llmErr, attempt)
                opts.onRetry?.(llmErr, attempt + 1)
                await this.sleep(delay, opts.signal)
            }
        }

        // L5 优雅降级
        if (opts.fallback) {
            const fallbackValue = await opts.fallback()
            this.emit('llm:fallback', {
                agent: opts.agent,
                task: opts.task,
                error: lastError?.message ?? 'unknown',
            })
            return fallbackValue as T
        }

        // 无降级方案，抛出最后的错误
        throw lastError ?? new LLMError('L5', 'unknown', '所有重试失败且无降级方案', false)
    }

    /**
     * L1 指数退避延迟计算
     *
     * - base 1s, factor 2, jitter ±25%, max 30s
     * - 429 限流时优先尊重 Retry-After header（通过 cause 携带）
     */
    private calcBackoff(err: LLMError, attempt: number): number {
        // 429 限流：尝试从 cause 中读取 Retry-After
        if (err.type === 'rate-limit') {
            const retryAfter = this.extractRetryAfter(err.cause)
            if (retryAfter !== null) {
                return Math.min(retryAfter * 1000, 30000)
            }
        }

        // 指数退避：base=1s, factor=2
        const base = 1000
        const exponential = base * Math.pow(2, attempt)
        // jitter ±25%
        const jitter = exponential * 0.25 * (Math.random() * 2 - 1)
        const delay = exponential + jitter
        return Math.min(Math.max(delay, 0), 30000)
    }

    /**
     * 从错误 cause 中提取 Retry-After 值（秒）
     * OpenAI SDK 的 RateLimitError 在 headers 中携带 retry-after
     */
    private extractRetryAfter(cause: unknown): number | null {
        if (cause && typeof cause === 'object' && 'headers' in cause) {
            const headers = (cause as { headers?: Record<string, string | undefined> }).headers
            const retryAfter = headers?.['retry-after'] ?? headers?.['Retry-After']
            if (retryAfter) {
                const seconds = parseFloat(retryAfter)
                if (!Number.isNaN(seconds)) {
                    return seconds
                }
            }
        }
        return null
    }

    /**
     * 将任意错误分类为 LLMError
     *
     * 错误分类规则：
     * - OpenAI APIConnectionError / 超时 → network（L1 可重试）
     * - OpenAI RateLimitError (429)     → rate-limit（L1 可重试）
     * - OpenAI InternalServerError (5xx)→ server（L1 可重试）
     * - OpenAI BadRequestError (4xx)    → param（L2 不可 L1 重试）
     * - 工具调用结果错误                  → tool（L3 不可 L1 重试）
     * - LLMError 实例                    → 透传（已分类）
     * - 其他                              → unknown（不可重试）
     */
    classifyError(err: unknown): LLMError {
        // 已经是 LLMError 则透传
        if (err instanceof LLMError) {
            return err
        }

        // OpenAI SDK 错误分类
        if (err && typeof err === 'object' && 'constructor' in err) {
            const ctor = (err as { constructor: { name: string } }).constructor
            const name = ctor.name

            if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') {
                return new LLMError('L1', 'network', `网络错误: ${(err as Error).message}`, true, err)
            }
            if (name === 'RateLimitError') {
                return new LLMError('L1', 'rate-limit', '请求被限流 (429)', true, err)
            }
            if (name === 'InternalServerError') {
                return new LLMError('L1', 'server', `服务端错误 (5xx): ${(err as Error).message}`, true, err)
            }
            if (name === 'APIUserAbortError') {
                return new LLMError('L1', 'network', '请求被中断', false, err)
            }
            if (
                name === 'BadRequestError' ||
                name === 'AuthenticationError' ||
                name === 'PermissionDeniedError' ||
                name === 'NotFoundError' ||
                name === 'UnprocessableEntityError' ||
                name === 'ConflictError'
            ) {
                return new LLMError('L2', 'param', `参数错误: ${(err as Error).message}`, false, err)
            }
            if (name === 'APIError') {
                const status = (err as { status?: number }).status
                if (status !== undefined && status >= 500) {
                    return new LLMError('L1', 'server', `服务端错误 (${status}): ${(err as Error).message}`, true, err)
                }
                if (status === 429) {
                    return new LLMError('L1', 'rate-limit', '请求被限流 (429)', true, err)
                }
                if (status !== undefined && status >= 400 && status < 500) {
                    return new LLMError('L2', 'param', `参数错误 (${status}): ${(err as Error).message}`, false, err)
                }
            }
        }

        // AbortError（用户中断）
        if (err instanceof Error && err.name === 'AbortError') {
            return new LLMError('L1', 'network', '请求被用户中断', false, err)
        }

        // 未知错误
        const message = err instanceof Error ? err.message : String(err)
        return new LLMError('L5', 'unknown', `未知错误: ${message}`, false, err)
    }

    // ─────────────────────────────────────────────────────────
    // L2：参数错回注
    // ─────────────────────────────────────────────────────────

    /**
     * 将参数错误信息回注到 system message，提示模型调整
     *
     * 策略：在消息列表开头插入一条 system message，告知模型上次调用因 X 失败
     * 仅对 tool_calls 失败、json 格式错等可恢复场景有效
     *
     * @param messages 原始消息列表
     * @param errorMessage 错误信息
     * @returns 新消息列表（含回注的 system message）
     */
    reinjectParamError(messages: ChatMessage[], errorMessage: string): ChatMessage[] {
        const note: ChatMessage = {
            role: 'system',
            content: `上次调用因以下原因失败，请调整你的输出：\n${errorMessage}\n\n请确保输出格式正确并重新生成。`,
        }
        return [note, ...messages]
    }

    // ─────────────────────────────────────────────────────────
    // L3：工具失败回注
    // ─────────────────────────────────────────────────────────

    /**
     * 将工具调用错误作为新的 tool message 注入对话，让模型自我修正
     *
     * @param messages 原始消息列表
     * @param toolCallId 失败的工具调用 ID
     * @param errorMessage 工具执行错误信息
     * @returns 新消息列表（追加 tool 角色消息）
     */
    reinjectToolError(
        messages: ChatMessage[],
        toolCallId: string,
        errorMessage: string,
    ): ChatMessage[] {
        const toolMsg: ChatMessage = {
            role: 'tool',
            tool_call_id: toolCallId,
            content: `工具调用失败: ${errorMessage}\n请根据此错误信息调整参数并重新调用。`,
        }
        return [...messages, toolMsg]
    }

    // ─────────────────────────────────────────────────────────
    // L4：死循环检测
    // ─────────────────────────────────────────────────────────

    /**
     * 追踪输出并检测死循环
     *
     * 触发条件：
     * - 同一 agent+task 连续 3 次返回相同输出
     * - 同一 agent+task 连续 5 次工具调用未收敛
     *
     * @param agent 智能体名
     * @param task 任务名
     * @param output 本次输出内容（用于相同输出检测）
     * @param toolSignature 本次工具调用签名（可选，用于工具收敛检测）
     * @returns 若检测到死循环则抛出 LLMError('L4', 'loop')，否则返回 void
     */
    trackOutput(agent: string, task: string, output: string, toolSignature?: string): void {
        const key = `${agent}:${task}`
        let tracker = this.loopTrackers.get(key)
        if (!tracker) {
            tracker = { outputs: [], toolSignatures: [] }
            this.loopTrackers.set(key, tracker)
        }

        // 输出相同检测
        tracker.outputs.push(this.hash(output))
        if (tracker.outputs.length > ErrorRecovery.LOOP_OUTPUT_THRESHOLD) {
            tracker.outputs.shift()
        }
        if (tracker.outputs.length >= ErrorRecovery.LOOP_OUTPUT_THRESHOLD) {
            const firstOutput = tracker.outputs[0]
            const allSame = firstOutput !== undefined && tracker.outputs.every((h) => h === firstOutput)
            if (allSame) {
                this.resetTracker(key)
                throw new LLMError(
                    'L4',
                    'loop',
                    `死循环检测：连续 ${ErrorRecovery.LOOP_OUTPUT_THRESHOLD} 次返回相同输出`,
                    false,
                )
            }
        }

        // 工具调用未收敛检测
        if (toolSignature) {
            tracker.toolSignatures.push(toolSignature)
            if (tracker.toolSignatures.length > ErrorRecovery.LOOP_TOOL_THRESHOLD) {
                tracker.toolSignatures.shift()
            }
            if (tracker.toolSignatures.length >= ErrorRecovery.LOOP_TOOL_THRESHOLD) {
                const firstSignature = tracker.toolSignatures[0]
                const allSame = firstSignature !== undefined
                    && tracker.toolSignatures.every((s) => s === firstSignature)
                if (allSame) {
                    this.resetTracker(key)
                    throw new LLMError(
                        'L4',
                        'loop',
                        `死循环检测：连续 ${ErrorRecovery.LOOP_TOOL_THRESHOLD} 次相同工具调用未收敛`,
                        false,
                    )
                }
            }
        }
    }

    /** 重置指定 agent+task 的循环检测状态 */
    resetTracker(key: string): void {
        this.loopTrackers.delete(key)
    }

    /** 清除所有循环检测状态 */
    resetAll(): void {
        this.loopTrackers.clear()
    }

    // ─────────────────────────────────────────────────────────
    // L5：降级内容
    // ─────────────────────────────────────────────────────────

    /**
     * 获取指定 domain × function 的降级内容
     *
     * @returns 降级文本，若未配置则返回通用降级消息
     */
    getFallback(domain: Domain, fn: Function): string {
        return FALLBACK_CONTENT[`${domain}:${fn}`] ?? '[AI 生成（降级模式）] 服务暂时不可用，请稍后重试。'
    }

    // ─────────────────────────────────────────────────────────
    // 工具方法
    // ─────────────────────────────────────────────────────────

    /** 简单哈希（用于输出相同性比较，非加密用途） */
    private hash(s: string): string {
        let h = 0
        for (let i = 0; i < s.length; i++) {
            const char = s.charCodeAt(i)
            h = (h << 5) - h + char
            h |= 0
        }
        return String(h)
    }

    private throwIfAborted(signal?: AbortSignal): void {
        if (!signal?.aborted) return
        throw new LLMError(
            'L1',
            'network',
            '请求被用户中断',
            false,
            new DOMException('Aborted', 'AbortError'),
        )
    }

    /** 可中断的退避；取消后清理定时器，禁止后台继续重试。 */
    private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
        this.throwIfAborted(signal)
        return new Promise((resolve, reject) => {
            const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
            const timer = setTimeout(() => {
                cleanup()
                resolve()
            }, ms)
            const onAbort = (): void => {
                clearTimeout(timer)
                cleanup()
                reject(new LLMError(
                    'L1',
                    'network',
                    '请求被用户中断',
                    false,
                    new DOMException('Aborted', 'AbortError'),
                ))
            }
            signal?.addEventListener('abort', onAbort, { once: true })
        })
    }
}
