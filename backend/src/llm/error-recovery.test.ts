/**
 * llm/error-recovery.ts 单元测试
 *
 * 覆盖：
 * - LLMError 类：构造、属性、instanceof
 * - classifyError：OpenAI SDK 各类错误 → LLMError 分类
 * - wrap：L1 重试 + L5 降级 + onRetry 回调
 * - calcBackoff（通过 wrap 间接验证）：429 Retry-After 优先
 * - reinjectParamError / reinjectToolError：消息回注
 * - trackOutput：L4 死循环检测（连续相同输出 / 工具未收敛）
 * - getFallback：降级内容表
 *
 * 设计原则：
 * - 使用 vi.useFakeTimers 控制 sleep，避免真实等待
 * - 使用 advanceTimersByTimeAsync 刷新 microtask
 * - mock Math.random 控制 jitter，使退避时间可断言
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    ErrorRecovery,
    LLMError,
} from './error-recovery.js'
import type { ChatMessage } from './types.js'

// ─────────────────────────────────────────────────────────────
// 辅助：构造伪造的 OpenAI SDK 错误
// ─────────────────────────────────────────────────────────────

function makeOpenAIError(name: string, message: string, extras: Record<string, unknown> = {}): Error {
    const err = new Error(message)
    Object.defineProperty(err, 'constructor', { value: { name }, writable: true, configurable: true })
    Object.assign(err, extras)
    return err
}

// ─────────────────────────────────────────────────────────────
// LLMError 类
// ─────────────────────────────────────────────────────────────

describe('LLMError', () => {
    it('构造函数设置 layer/type/message/retryable/cause', () => {
        const cause = new Error('original')
        const err = new LLMError('L1', 'network', '网络错误', true, cause)
        expect(err.layer).toBe('L1')
        expect(err.type).toBe('network')
        expect(err.message).toBe('网络错误')
        expect(err.retryable).toBe(true)
        expect(err.cause).toBe(cause)
    })

    it('继承 Error，name 为 LLMError', () => {
        const err = new LLMError('L5', 'unknown', 'x', false)
        expect(err).toBeInstanceOf(Error)
        expect(err.name).toBe('LLMError')
    })

    it('cause 可选', () => {
        const err = new LLMError('L2', 'param', 'x', false)
        expect(err.cause).toBeUndefined()
    })
})

// ─────────────────────────────────────────────────────────────
// classifyError
// ─────────────────────────────────────────────────────────────

describe('ErrorRecovery — classifyError', () => {
    let er: ErrorRecovery

    beforeEach(() => {
        er = new ErrorRecovery()
    })

    it('LLMError 实例透传', () => {
        const original = new LLMError('L4', 'loop', '死循环', false)
        const result = er.classifyError(original)
        expect(result).toBe(original)
    })

    it('APIConnectionError → L1 network 可重试', () => {
        const err = makeOpenAIError('APIConnectionError', 'connect failed')
        const result = er.classifyError(err)
        expect(result.layer).toBe('L1')
        expect(result.type).toBe('network')
        expect(result.retryable).toBe(true)
    })

    it('APIConnectionTimeoutError → L1 network 可重试', () => {
        const err = makeOpenAIError('APIConnectionTimeoutError', 'timeout')
        const result = er.classifyError(err)
        expect(result.type).toBe('network')
        expect(result.retryable).toBe(true)
    })

    it('RateLimitError → L1 rate-limit 可重试', () => {
        const err = makeOpenAIError('RateLimitError', '429')
        const result = er.classifyError(err)
        expect(result.layer).toBe('L1')
        expect(result.type).toBe('rate-limit')
        expect(result.retryable).toBe(true)
    })

    it('InternalServerError → L1 server 可重试', () => {
        const err = makeOpenAIError('InternalServerError', '500')
        const result = er.classifyError(err)
        expect(result.layer).toBe('L1')
        expect(result.type).toBe('server')
        expect(result.retryable).toBe(true)
    })

    it('APIUserAbortError → L1 network 不可重试', () => {
        const err = makeOpenAIError('APIUserAbortError', 'aborted')
        const result = er.classifyError(err)
        expect(result.type).toBe('network')
        expect(result.retryable).toBe(false)
    })

    it('BadRequestError → L2 param 不可重试', () => {
        const err = makeOpenAIError('BadRequestError', 'bad request')
        const result = er.classifyError(err)
        expect(result.layer).toBe('L2')
        expect(result.type).toBe('param')
        expect(result.retryable).toBe(false)
    })

    it('AuthenticationError → L2 param 不可重试', () => {
        const err = makeOpenAIError('AuthenticationError', '401')
        const result = er.classifyError(err)
        expect(result.type).toBe('param')
        expect(result.retryable).toBe(false)
    })

    it('PermissionDeniedError → L2 param 不可重试', () => {
        const err = makeOpenAIError('PermissionDeniedError', '403')
        const result = er.classifyError(err)
        expect(result.type).toBe('param')
    })

    it('NotFoundError → L2 param 不可重试', () => {
        const err = makeOpenAIError('NotFoundError', '404')
        const result = er.classifyError(err)
        expect(result.type).toBe('param')
    })

    it('UnprocessableEntityError → L2 param 不可重试', () => {
        const err = makeOpenAIError('UnprocessableEntityError', '422')
        const result = er.classifyError(err)
        expect(result.type).toBe('param')
    })

    it('ConflictError → L2 param 不可重试', () => {
        const err = makeOpenAIError('ConflictError', '409')
        const result = er.classifyError(err)
        expect(result.type).toBe('param')
    })

    it('APIError + status 5xx → L1 server 可重试', () => {
        const err = makeOpenAIError('APIError', '503', { status: 503 })
        const result = er.classifyError(err)
        expect(result.layer).toBe('L1')
        expect(result.type).toBe('server')
        expect(result.retryable).toBe(true)
    })

    it('APIError + status 429 → L1 rate-limit 可重试', () => {
        const err = makeOpenAIError('APIError', '429', { status: 429 })
        const result = er.classifyError(err)
        expect(result.type).toBe('rate-limit')
        expect(result.retryable).toBe(true)
    })

    it('APIError + status 4xx → L2 param 不可重试', () => {
        const err = makeOpenAIError('APIError', '400', { status: 400 })
        const result = er.classifyError(err)
        expect(result.type).toBe('param')
        expect(result.retryable).toBe(false)
    })

    it('APIError 无 status → unknown', () => {
        const err = makeOpenAIError('APIError', 'unknown')
        const result = er.classifyError(err)
        expect(result.type).toBe('unknown')
    })

    it('AbortError（name 字段）→ L1 network 不可重试', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        const result = er.classifyError(err)
        expect(result.type).toBe('network')
        expect(result.retryable).toBe(false)
    })

    it('未知错误 → L5 unknown 不可重试', () => {
        const result = er.classifyError(new Error('something'))
        expect(result.layer).toBe('L5')
        expect(result.type).toBe('unknown')
        expect(result.retryable).toBe(false)
    })

    it('非 Error 值也被分类为 unknown', () => {
        const result = er.classifyError('string error')
        expect(result.type).toBe('unknown')
        expect(result.message).toContain('string error')
    })
})

// ─────────────────────────────────────────────────────────────
// wrap — L1 重试
// ─────────────────────────────────────────────────────────────

describe('ErrorRecovery — wrap L1 重试', () => {
    let er: ErrorRecovery

    beforeEach(() => {
        vi.useFakeTimers()
        // 固定 Math.random 使 jitter=0，便于断言
        vi.spyOn(Math, 'random').mockReturnValue(0)
        er = new ErrorRecovery()
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('fn 成功：直接返回，不重试', async () => {
        const fn = vi.fn().mockResolvedValue('ok')
        const result = await er.wrap(fn, { agent: 'a', task: 'b' })
        expect(result).toBe('ok')
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('可重试错误：在 maxRetries 内成功，不继续重试', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(makeOpenAIError('APIConnectionError', 'net'))
            .mockResolvedValueOnce('recovered')
        const onRetry = vi.fn()

        const promise = er.wrap(fn, { agent: 'a', task: 'b', maxRetries: 3, onRetry })
        // 防 unhandled rejection：在 advance 之前附加 handler
        promise.catch(() => {})
        // 触发首次失败与 sleep
        await vi.advanceTimersByTimeAsync(2000)
        const result = await promise

        expect(result).toBe('recovered')
        expect(fn).toHaveBeenCalledTimes(2)
        expect(onRetry).toHaveBeenCalledTimes(1)
        expect(onRetry).toHaveBeenCalledWith(expect.any(LLMError), 1)
    })

    it('不可重试错误：立即抛出，不重试', async () => {
        const fn = vi.fn().mockRejectedValue(makeOpenAIError('BadRequestError', 'bad'))
        const onRetry = vi.fn()

        await expect(er.wrap(fn, { agent: 'a', task: 'b', maxRetries: 3, onRetry }))
            .rejects.toThrow(/参数错误/)

        expect(fn).toHaveBeenCalledTimes(1)
        expect(onRetry).not.toHaveBeenCalled()
    })

    it('调用前已中止时不执行 fn，也不进入 fallback', async () => {
        const controller = new AbortController()
        controller.abort('request-closed')
        const fn = vi.fn().mockResolvedValue('should-not-run')
        const fallback = vi.fn().mockReturnValue('fallback')

        await expect(er.wrap(fn, {
            agent: 'a', task: 'b', signal: controller.signal, fallback,
        })).rejects.toMatchObject({ type: 'network', retryable: false })
        expect(fn).not.toHaveBeenCalled()
        expect(fallback).not.toHaveBeenCalled()
    })

    it('退避等待期间中止后立即停止，不再发起下一次调用', async () => {
        const controller = new AbortController()
        const fn = vi.fn().mockRejectedValue(makeOpenAIError('APIConnectionError', 'net'))
        const promise = er.wrap(fn, {
            agent: 'a', task: 'b', maxRetries: 3, signal: controller.signal,
        })
        promise.catch(() => {})
        await vi.advanceTimersByTimeAsync(1)
        controller.abort('request-closed')

        await expect(promise).rejects.toMatchObject({ type: 'network', retryable: false })
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('L4 loop 错误：立即抛出，不重试', async () => {
        const loopErr = new LLMError('L4', 'loop', '死循环', false)
        const fn = vi.fn().mockRejectedValue(loopErr)
        const onRetry = vi.fn()

        await expect(er.wrap(fn, { agent: 'a', task: 'b', maxRetries: 3, onRetry }))
            .rejects.toThrow(/死循环/)

        expect(fn).toHaveBeenCalledTimes(1)
        expect(onRetry).not.toHaveBeenCalled()
    })

    it('达到 maxRetries 后抛出最后错误', async () => {
        const fn = vi.fn().mockRejectedValue(makeOpenAIError('APIConnectionError', 'fail'))
        const onRetry = vi.fn()

        const promise = er.wrap(fn, { agent: 'a', task: 'b', maxRetries: 2, onRetry })
        promise.catch(() => {})
        // 推进足够时间让所有重试完成
        // 退避：1s + 2s = 3s（jitter=0）
        await vi.advanceTimersByTimeAsync(5000)
        await expect(promise).rejects.toThrow(/网络错误/)

        expect(fn).toHaveBeenCalledTimes(3) // 初始 + 2 次重试
        expect(onRetry).toHaveBeenCalledTimes(2)
    })

    it('maxRetries 默认为 3', async () => {
        const fn = vi.fn().mockRejectedValue(makeOpenAIError('APIConnectionError', 'fail'))
        const promise = er.wrap(fn, { agent: 'a', task: 'b' })
        promise.catch(() => {})
        // 退避：1s + 2s + 4s = 7s
        await vi.advanceTimersByTimeAsync(10000)
        await expect(promise).rejects.toThrow()
        expect(fn).toHaveBeenCalledTimes(4) // 初始 + 3 次重试
    })
})

// ─────────────────────────────────────────────────────────────
// wrap — L5 降级
// ─────────────────────────────────────────────────────────────

describe('ErrorRecovery — wrap L5 降级', () => {
    let er: ErrorRecovery

    beforeEach(() => {
        vi.useFakeTimers()
        vi.spyOn(Math, 'random').mockReturnValue(0)
        er = new ErrorRecovery()
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('所有重试失败 + 提供 fallback → 返回降级值', async () => {
        const fn = vi.fn().mockRejectedValue(makeOpenAIError('APIConnectionError', 'fail'))
        const fallback = vi.fn().mockReturnValue('fallback-value')

        const promise = er.wrap(fn, {
            agent: 'a', task: 'b', maxRetries: 1, fallback,
        })
        promise.catch(() => {})
        await vi.advanceTimersByTimeAsync(5000)
        const result = await promise

        expect(result).toBe('fallback-value')
        expect(fallback).toHaveBeenCalledTimes(1)
    })

    it('降级时发射 llm:fallback 事件', async () => {
        const fn = vi.fn().mockRejectedValue(makeOpenAIError('APIConnectionError', 'fail'))
        const fallback = vi.fn().mockReturnValue('fallback')

        const events: unknown[] = []
        er.on('llm:fallback', (p: unknown) => events.push(p))

        const promise = er.wrap(fn, {
            agent: 'agent-x', task: 'task-y', maxRetries: 0, fallback,
        })
        promise.catch(() => {})
        await vi.advanceTimersByTimeAsync(1000)
        await promise

        expect(events).toHaveLength(1)
        const payload = events[0] as Record<string, unknown>
        expect(payload.agent).toBe('agent-x')
        expect(payload.task).toBe('task-y')
    })

    it('fallback 可返回 Promise（异步降级）', async () => {
        const fn = vi.fn().mockRejectedValue(makeOpenAIError('APIConnectionError', 'fail'))
        const fallback = vi.fn().mockResolvedValue('async-fallback')

        const promise = er.wrap(fn, {
            agent: 'a', task: 'b', maxRetries: 0, fallback,
        })
        promise.catch(() => {})
        await vi.advanceTimersByTimeAsync(1000)
        const result = await promise
        expect(result).toBe('async-fallback')
    })

    it('所有重试失败 + 无 fallback → 抛出最后错误', async () => {
        const fn = vi.fn().mockRejectedValue(makeOpenAIError('APIConnectionError', 'fail'))

        const promise = er.wrap(fn, { agent: 'a', task: 'b', maxRetries: 0 })
        promise.catch(() => {})
        await vi.advanceTimersByTimeAsync(1000)
        await expect(promise).rejects.toThrow(/网络错误/)
    })

    it('所有重试失败 + 无 fallback + 无错误记录 → 抛出 unknown', async () => {
        // 边界场景：理论上不会发生，但实现有兜底
        // 直接构造一个 fn 抛出非错误值
        const fn = vi.fn().mockRejectedValue('string-err')

        const promise = er.wrap(fn, { agent: 'a', task: 'b', maxRetries: 0 })
        promise.catch(() => {})
        await vi.advanceTimersByTimeAsync(1000)
        await expect(promise).rejects.toThrow()
    })
})

// ─────────────────────────────────────────────────────────────
// wrap — 429 Retry-After
// ─────────────────────────────────────────────────────────────

describe('ErrorRecovery — wrap 429 Retry-After', () => {
    let er: ErrorRecovery

    beforeEach(() => {
        vi.useFakeTimers()
        vi.spyOn(Math, 'random').mockReturnValue(0)
        er = new ErrorRecovery()
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('429 + Retry-After header → 使用 header 值作为退避秒数', async () => {
        const retryAfterErr = makeOpenAIError('RateLimitError', '429', {
            headers: { 'retry-after': '5' },
        })
        const fn = vi.fn()
            .mockRejectedValueOnce(retryAfterErr)
            .mockResolvedValueOnce('ok')

        const onRetry = vi.fn()
        const promise = er.wrap(fn, { agent: 'a', task: 'b', maxRetries: 1, onRetry })
        promise.catch(() => {})

        // 推进 5 秒（Retry-After 指定）
        await vi.advanceTimersByTimeAsync(5500)
        const result = await promise

        expect(result).toBe('ok')
        expect(fn).toHaveBeenCalledTimes(2)
        expect(onRetry).toHaveBeenCalledWith(expect.any(LLMError), 1)
    })

    it('429 + Retry-After 大写 header 名 → 同样生效', async () => {
        const retryAfterErr = makeOpenAIError('RateLimitError', '429', {
            headers: { 'Retry-After': '3' },
        })
        const fn = vi.fn()
            .mockRejectedValueOnce(retryAfterErr)
            .mockResolvedValueOnce('ok')

        const promise = er.wrap(fn, { agent: 'a', task: 'b', maxRetries: 1 })
        promise.catch(() => {})
        await vi.advanceTimersByTimeAsync(3500)
        const result = await promise
        expect(result).toBe('ok')
    })

    it('429 + Retry-After 超过 30s → 钳为 30s', async () => {
        const retryAfterErr = makeOpenAIError('RateLimitError', '429', {
            headers: { 'retry-after': '60' },
        })
        const fn = vi.fn()
            .mockRejectedValueOnce(retryAfterErr)
            .mockResolvedValueOnce('ok')

        const promise = er.wrap(fn, { agent: 'a', task: 'b', maxRetries: 1 })
        promise.catch(() => {})
        // 推进 30s 应已足够（被钳为 30s）
        await vi.advanceTimersByTimeAsync(31000)
        const result = await promise
        expect(result).toBe('ok')
    })

    it('429 无 Retry-After header → 走指数退避', async () => {
        const retryAfterErr = makeOpenAIError('RateLimitError', '429')
        const fn = vi.fn()
            .mockRejectedValueOnce(retryAfterErr)
            .mockResolvedValueOnce('ok')

        const promise = er.wrap(fn, { agent: 'a', task: 'b', maxRetries: 1 })
        promise.catch(() => {})
        // 指数退避 attempt=0 → 1s
        await vi.advanceTimersByTimeAsync(1500)
        const result = await promise
        expect(result).toBe('ok')
    })

    it('429 + 非数字 Retry-After → 走指数退避', async () => {
        const retryAfterErr = makeOpenAIError('RateLimitError', '429', {
            headers: { 'retry-after': 'invalid' },
        })
        const fn = vi.fn()
            .mockRejectedValueOnce(retryAfterErr)
            .mockResolvedValueOnce('ok')

        const promise = er.wrap(fn, { agent: 'a', task: 'b', maxRetries: 1 })
        promise.catch(() => {})
        await vi.advanceTimersByTimeAsync(1500)
        const result = await promise
        expect(result).toBe('ok')
    })
})

// ─────────────────────────────────────────────────────────────
// reinjectParamError / reinjectToolError
// ─────────────────────────────────────────────────────────────

describe('ErrorRecovery — L2/L3 错误回注', () => {
    let er: ErrorRecovery

    beforeEach(() => {
        er = new ErrorRecovery()
    })

    it('reinjectParamError：在消息列表头部插入 system message', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: '原消息' },
        ]
        const result = er.reinjectParamError(messages, 'JSON 格式错误')
        expect(result.length).toBe(2)
        expect(result[0]!.role).toBe('system')
        expect(result[0]!.content).toContain('JSON 格式错误')
        expect(result[0]!.content).toContain('上次调用因以下原因失败')
        // 原消息保留
        expect(result[1]!.content).toBe('原消息')
    })

    it('reinjectParamError：不修改原数组', () => {
        const messages: ChatMessage[] = [{ role: 'user', content: 'x' }]
        const result = er.reinjectParamError(messages, 'err')
        expect(messages.length).toBe(1)
        expect(result).not.toBe(messages)
    })

    it('reinjectToolError：在消息列表尾部追加 tool message', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: '调用工具' },
        ]
        const result = er.reinjectToolError(messages, 'call-123', '工具执行失败')
        expect(result.length).toBe(2)
        expect(result[1]!.role).toBe('tool')
        expect(result[1]!.tool_call_id).toBe('call-123')
        expect(result[1]!.content).toContain('工具执行失败')
        expect(result[1]!.content).toContain('工具调用失败')
    })

    it('reinjectToolError：不修改原数组', () => {
        const messages: ChatMessage[] = [{ role: 'user', content: 'x' }]
        const result = er.reinjectToolError(messages, 'id', 'err')
        expect(messages.length).toBe(1)
        expect(result).not.toBe(messages)
    })
})

// ─────────────────────────────────────────────────────────────
// trackOutput — L4 死循环检测
// ─────────────────────────────────────────────────────────────

describe('ErrorRecovery — L4 死循环检测', () => {
    let er: ErrorRecovery

    beforeEach(() => {
        er = new ErrorRecovery()
    })

    it('连续 3 次相同输出 → 抛出 loop 错误', () => {
        const output = '相同输出'
        // 第 1、2 次不抛
        expect(() => er.trackOutput('a', 'b', output)).not.toThrow()
        expect(() => er.trackOutput('a', 'b', output)).not.toThrow()
        // 第 3 次抛出
        // 注意：抛出后 tracker 自动重置，所以用 try/catch 验证错误内容
        let caught: LLMError | undefined
        try {
            er.trackOutput('a', 'b', output)
        } catch (err) {
            caught = err as LLMError
        }
        expect(caught).toBeInstanceOf(LLMError)
        expect(caught?.message).toMatch(/死循环检测/)
        expect(caught?.message).toMatch(/连续 3 次返回相同输出/)
    })

    it('不同输出不触发', () => {
        expect(() => er.trackOutput('a', 'b', 'output-1')).not.toThrow()
        expect(() => er.trackOutput('a', 'b', 'output-2')).not.toThrow()
        expect(() => er.trackOutput('a', 'b', 'output-3')).not.toThrow()
    })

    it('不同 agent+task 独立计数', () => {
        const output = 'same'
        // agent:a + task:b 两次
        er.trackOutput('a', 'b', output)
        er.trackOutput('a', 'b', output)
        // agent:x + task:y 两次（独立计数）
        er.trackOutput('x', 'y', output)
        er.trackOutput('x', 'y', output)
        // a:b 第 3 次触发抛出（且重置 a:b 的 tracker）
        expect(() => er.trackOutput('a', 'b', output)).toThrow()
        // x:y 此时累计 2 次，再调用第 3 次也会触发
        expect(() => er.trackOutput('x', 'y', output)).toThrow()
    })

    it('触发后重置 tracker（再次连续 3 次才触发）', () => {
        const output = 'same'
        er.trackOutput('a', 'b', output)
        er.trackOutput('a', 'b', output)
        expect(() => er.trackOutput('a', 'b', output)).toThrow()
        // 重置后从 0 开始
        expect(() => er.trackOutput('a', 'b', output)).not.toThrow()
        expect(() => er.trackOutput('a', 'b', output)).not.toThrow()
        expect(() => er.trackOutput('a', 'b', output)).toThrow()
    })

    it('输出循环检测窗口超过阈值时滑动（仅最近 3 条）', () => {
        // 第 1、2 次相同
        er.trackOutput('a', 'b', 'A')
        er.trackOutput('a', 'b', 'A')
        // 第 3 次不同，不触发
        expect(() => er.trackOutput('a', 'b', 'B')).not.toThrow()
        // 此时 outputs = ['A', 'A', 'B']，shift 后窗口仅保留最近 3 条
        // 第 4 次 A：窗口变为 ['A', 'B', 'A']，不全相同
        expect(() => er.trackOutput('a', 'b', 'A')).not.toThrow()
    })

    it('连续 5 次相同工具签名 → 抛出 loop 错误', () => {
        const sig = 'tool-call-sig'
        for (let i = 0; i < 4; i++) {
            expect(() => er.trackOutput('a', 'b', `output-${i}`, sig)).not.toThrow()
        }
        // 第 5 次触发
        expect(() => er.trackOutput('a', 'b', 'output-5', sig)).toThrow(/连续 5 次相同工具调用未收敛/)
    })

    it('不同工具签名不触发', () => {
        for (let i = 0; i < 10; i++) {
            expect(() => er.trackOutput('a', 'b', `out-${i}`, `sig-${i}`)).not.toThrow()
        }
    })

    it('工具签名窗口超过阈值时滑动（仅最近 5 条）', () => {
        const sig = 'S'
        // 4 次相同
        for (let i = 0; i < 4; i++) {
            er.trackOutput('a', 'b', `o-${i}`, sig)
        }
        // 第 5 次不同签名，不触发
        expect(() => er.trackOutput('a', 'b', 'o-5', 'different')).not.toThrow()
    })

    it('resetTracker 清除指定 agent+task 状态', () => {
        const output = 'same'
        er.trackOutput('a', 'b', output)
        er.trackOutput('a', 'b', output)
        er.resetTracker('a:b')
        // 重置后从 0 开始，需 3 次才触发
        expect(() => er.trackOutput('a', 'b', output)).not.toThrow()
        expect(() => er.trackOutput('a', 'b', output)).not.toThrow()
        expect(() => er.trackOutput('a', 'b', output)).toThrow()
    })

    it('resetAll 清除所有状态', () => {
        er.trackOutput('a', 'b', 'x')
        er.trackOutput('c', 'd', 'y')
        er.resetAll()
        // 重置后不抛
        expect(() => er.trackOutput('a', 'b', 'x')).not.toThrow()
        expect(() => er.trackOutput('c', 'd', 'y')).not.toThrow()
    })

    it('loop 错误是 LLMError 实例，layer=L4, type=loop, retryable=false', () => {
        const output = 'same'
        try {
            er.trackOutput('a', 'b', output)
            er.trackOutput('a', 'b', output)
            er.trackOutput('a', 'b', output)
            throw new Error('should have thrown')
        } catch (err) {
            expect(err).toBeInstanceOf(LLMError)
            const e = err as LLMError
            expect(e.layer).toBe('L4')
            expect(e.type).toBe('loop')
            expect(e.retryable).toBe(false)
        }
    })
})

// ─────────────────────────────────────────────────────────────
// getFallback
// ─────────────────────────────────────────────────────────────

describe('ErrorRecovery — getFallback 降级内容', () => {
    let er: ErrorRecovery

    beforeEach(() => {
        er = new ErrorRecovery()
    })

    it('mind:diagnose 返回对应的降级内容', () => {
        const content = er.getFallback('mind', 'diagnose')
        expect(content).toContain('降级模式')
        expect(content).toContain('认知诊断')
    })

    it('eye:tts 返回对应的降级内容', () => {
        const content = er.getFallback('eye', 'tts')
        expect(content).toContain('语音合成')
    })

    it('brush:grade 返回对应的降级内容', () => {
        const content = er.getFallback('brush', 'grade')
        expect(content).toContain('批改')
    })

    it('verifier:verify 返回对应的降级内容', () => {
        const content = er.getFallback('verifier', 'verify')
        expect(content).toContain('独立验收')
    })

    it('所有降级内容都标注 "降级模式"', () => {
        // 遍历所有已知的 domain × function 组合
        const cases: Array<[string, string]> = [
            ['mind', 'diagnose'], ['mind', 'profile'], ['mind', 'recommend'], ['mind', 'verify'],
            ['eye', 'vision-annotate'], ['eye', 'asr'], ['eye', 'tts'],
            ['brush', 'generate-question'], ['brush', 'grade'], ['brush', 'report'], ['brush', 'creative'],
            ['orchestrator', 'route'], ['orchestrator', 'summarize'],
            ['verifier', 'verify'],
        ]
        for (const [d, f] of cases) {
            expect(er.getFallback(d as never, f as never)).toContain('降级模式')
        }
    })

    it('未配置的组合返回通用降级消息', () => {
        // 未知组合（绕过类型系统）
        const content = er.getFallback('unknown' as never, 'unknown' as never)
        expect(content).toContain('降级模式')
        expect(content).toContain('服务暂时不可用')
    })
})
