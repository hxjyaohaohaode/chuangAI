import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeepSeekClient, DeepSeekResult } from './deepseek-client.js'
import type { MiMoClient, MimoTextResult } from './mimo-client.js'
import { TokenBilling } from './billing.js'
import { ErrorRecovery, LLMError } from './error-recovery.js'
import { ManagedLLMGateway } from './managed-gateway.js'
import { ProviderRateLimiter } from './rate-limiter.js'
import type { ChatChunk } from './types.js'

function deepseekResult(content = 'ok'): DeepSeekResult {
    return {
        content,
        usage: { promptTokens: 12, completionTokens: 7, cachedTokens: 2 },
        latencyMs: 25,
        model: 'deepseek-v4-pro',
    }
}

function mimoResult(content = 'vision-ok'): MimoTextResult {
    return {
        content,
        usage: { promptTokens: 20, completionTokens: 8 },
        latencyMs: 30,
        model: 'mimo-v2.5',
    }
}

function providerError(name: string, message: string): Error {
    const error = new Error(message)
    Object.defineProperty(error, 'constructor', {
        value: { name }, configurable: true,
    })
    return error
}

function harness(options: { maxRetries?: number } = {}) {
    const deepseekChat = vi.fn()
    const deepseekStream = vi.fn()
    const mimoChat = vi.fn()
    const mimoStream = vi.fn()
    const mimoTts = vi.fn()
    const mimoAsr = vi.fn()
    const deepseek = {
        chat: deepseekChat,
        stream: deepseekStream,
    } as unknown as DeepSeekClient
    const mimo = {
        chat: mimoChat,
        streamChat: mimoStream,
        tts: mimoTts,
        asr: mimoAsr,
    } as unknown as MiMoClient
    const billing = new TokenBilling()
    const recovery = new ErrorRecovery()
    const limiter = new ProviderRateLimiter()
    const sink = new EventEmitter()
    const gateway = new ManagedLLMGateway(
        deepseek,
        mimo,
        recovery,
        billing,
        limiter,
        { maxRetries: options.maxRetries ?? 0, eventSink: sink },
    )
    return {
        gateway,
        billing,
        limiter,
        sink,
        deepseekChat,
        deepseekStream,
        mimoChat,
        mimoStream,
        mimoTts,
        mimoAsr,
    }
}

async function collect(stream: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
    const chunks: ChatChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
}

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('ManagedLLMGateway explicit model governance', () => {
    it('保留 DeepSeek 模型/思考档/参数，并形成成功计费与统一事件', async () => {
        const h = harness()
        h.deepseekChat.mockResolvedValue(deepseekResult())
        const starts: Record<string, unknown>[] = []
        const successes: Record<string, unknown>[] = []
        h.sink.on('llm:call:start', (event) => starts.push(event as Record<string, unknown>))
        h.sink.on('llm:call:success', (event) => successes.push(event as Record<string, unknown>))

        const result = await h.gateway.chat({
            model: 'deepseek-v4-pro',
            thinking: 'max',
            messages: [{ role: 'user', content: '生成教案' }],
            maxTokens: 6000,
            jsonOutput: true,
            metadata: { agent: 'lesson-generator', task: 'generate', sessionId: 's-1' },
        })

        expect(result.content).toBe('ok')
        expect(h.deepseekChat).toHaveBeenCalledWith(expect.objectContaining({
            model: 'deepseek-v4-pro', thinking: 'max', maxTokens: 6000, jsonOutput: true,
        }))
        expect(h.mimoChat).not.toHaveBeenCalled()
        expect(h.billing.query({})).toEqual([
            expect.objectContaining({
                agent: 'lesson-generator', task: 'generate', sessionId: 's-1',
                model: 'deepseek-v4-pro', provider: 'deepseek',
                promptTokens: 12, completionTokens: 7, cachedTokens: 2, success: true,
            }),
        ])
        expect(starts).toEqual([expect.objectContaining({
            domain: 'managed', function: 'explicit-chat', model: 'deepseek-v4-pro',
            agent: 'lesson-generator', task: 'generate', managed: true,
        })])
        expect(successes).toHaveLength(1)
    })

    it('mimo-v2.5 多模态调用保持图片与 high 档，不漂移到 DeepSeek', async () => {
        const h = harness()
        h.mimoChat.mockResolvedValue(mimoResult())
        const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'

        await h.gateway.chat({
            model: 'mimo-v2.5',
            messages: [{ role: 'user', content: '识别手写答案' }],
            images: [{ url: image, detail: 'high' }],
            thinking: 'high',
            metadata: { agent: 'handwriting-ocr', task: 'ocr' },
        })

        expect(h.mimoChat).toHaveBeenCalledWith(expect.objectContaining({
            model: 'mimo-v2.5', thinking: 'high', images: [{ url: image, detail: 'high' }],
        }))
        expect(h.deepseekChat).not.toHaveBeenCalled()
        expect(h.billing.query({})[0]).toEqual(expect.objectContaining({
            provider: 'mimo', model: 'mimo-v2.5', success: true,
        }))
    })

    it('瞬态失败按物理请求重新限流，成功后只写一条逻辑计费记录', async () => {
        vi.useFakeTimers()
        vi.spyOn(Math, 'random').mockReturnValue(0.5)
        const h = harness({ maxRetries: 1 })
        const acquire = vi.spyOn(h.limiter, 'acquire')
        h.deepseekChat
            .mockRejectedValueOnce(providerError('APIConnectionError', 'temporary'))
            .mockResolvedValueOnce(deepseekResult('recovered'))

        const pending = h.gateway.chat({
            model: 'deepseek-v4-pro',
            messages: [{ role: 'user', content: '分析' }],
            metadata: { agent: 'grading', task: 'score' },
        })
        pending.catch(() => {})
        await vi.advanceTimersByTimeAsync(1100)

        await expect(pending).resolves.toEqual(expect.objectContaining({ content: 'recovered' }))
        expect(h.deepseekChat).toHaveBeenCalledTimes(2)
        expect(acquire).toHaveBeenCalledTimes(2)
        expect(h.billing.query({})).toHaveLength(1)
        expect(h.billing.query({})[0]?.success).toBe(true)
    })

    it('供应商错误不会把密钥或原始响应泄漏到事件与调用方', async () => {
        const h = harness()
        const errors: Record<string, unknown>[] = []
        h.sink.on('llm:call:error', (event) => errors.push(event as Record<string, unknown>))
        h.deepseekChat.mockRejectedValue(
            providerError('BadRequestError', 'api_key=sk-secret prompt=private-student-data'),
        )

        const promise = h.gateway.chat({
            model: 'deepseek-v4-flash',
            messages: [{ role: 'user', content: '分析' }],
        })
        await expect(promise).rejects.toMatchObject({
            type: 'param', message: '模型调用参数不符合供应商约束',
        })
        expect(JSON.stringify(errors)).not.toContain('sk-secret')
        expect(JSON.stringify(errors)).not.toContain('private-student-data')
        expect(h.billing.query({})[0]).toEqual(expect.objectContaining({ success: false }))
    })

    it('调用前已中止时不触达供应商，形成单一失败终态', async () => {
        const h = harness()
        const controller = new AbortController()
        controller.abort('browser-disconnected')
        const acquire = vi.spyOn(h.limiter, 'acquire')

        await expect(h.gateway.chat({
            model: 'deepseek-v4-flash',
            messages: [{ role: 'user', content: '摘要' }],
            signal: controller.signal,
        })).rejects.toBeInstanceOf(LLMError)

        expect(acquire).not.toHaveBeenCalled()
        expect(h.deepseekChat).not.toHaveBeenCalled()
        expect(h.billing.query({})).toHaveLength(1)
        expect(h.billing.query({})[0]?.success).toBe(false)
    })

    it('流式调用累计最终 usage 计费，观测分片不复制正文或 reasoning', async () => {
        const h = harness()
        h.deepseekStream.mockImplementation(() => (async function* () {
            yield { reasoning: '供应商私有推理' }
            yield { content: '面向教师的正文' }
            yield { done: true, usage: { promptTokens: 30, completionTokens: 10, cachedTokens: 5 } }
        })())
        const deltas: Record<string, unknown>[] = []
        h.sink.on('llm:stream:delta', (event) => deltas.push(event as Record<string, unknown>))

        const chunks = await collect(h.gateway.stream({
            model: 'deepseek-v4-pro',
            thinking: 'high',
            messages: [{ role: 'user', content: '报告' }],
            metadata: { agent: 'after-action-report', task: 'suggestions' },
        }))

        expect(chunks.some((chunk) => chunk.content === '面向教师的正文')).toBe(true)
        expect(JSON.stringify(deltas)).not.toContain('面向教师的正文')
        expect(JSON.stringify(deltas)).not.toContain('供应商私有推理')
        expect(h.billing.query({})[0]).toEqual(expect.objectContaining({
            promptTokens: 30, completionTokens: 10, cachedTokens: 5, success: true,
        }))
    })

    it('消费者提前关闭流后中止上游，并记录失败而不是伪成功', async () => {
        const h = harness()
        let upstreamSignal: AbortSignal | undefined
        h.deepseekStream.mockImplementation((params: { signal?: AbortSignal }) => {
            upstreamSignal = params.signal
            return (async function* () {
                yield { content: 'first' }
                yield { content: 'second' }
            })()
        })

        const stream = h.gateway.stream({
            model: 'deepseek-v4-flash',
            messages: [{ role: 'user', content: '实时建议' }],
        })
        await expect(stream.next()).resolves.toEqual({ value: { content: 'first' }, done: false })
        await stream.return(undefined)

        expect(upstreamSignal?.aborted).toBe(true)
        expect(h.billing.query({})).toHaveLength(1)
        expect(h.billing.query({})[0]?.success).toBe(false)
    })

    it('纯文本 mimo-v2.5-pro 拒绝图片且不调用供应商', async () => {
        const h = harness()
        await expect(h.gateway.chat({
            model: 'mimo-v2.5-pro',
            messages: [{ role: 'user', content: '分析' }],
            images: [{ url: 'data:image/png;base64,AAAA' }],
        })).rejects.toMatchObject({ type: 'param' })
        expect(h.mimoChat).not.toHaveBeenCalled()
    })

    it('ASR 以真实音频时长计费，TTS 仍按官方免费模型记录调用', async () => {
        const h = harness()
        h.mimoAsr.mockResolvedValue({ text: '床前明月光', durationSec: 7.2, confidence: 0.95 })
        h.mimoTts.mockResolvedValue({ audio: Buffer.from('audio'), format: 'mp3', durationMs: 1200 })

        await h.gateway.asr({
            model: 'mimo-v2.5-asr', audio: Buffer.from('voice'),
            metadata: { agent: 'recitation', task: 'asr' },
        })
        await h.gateway.tts({
            model: 'mimo-v2.5-tts', text: '床前明月光',
            metadata: { agent: 'recitation', task: 'tts' },
        })

        const records = h.billing.query({})
        expect(records).toHaveLength(2)
        expect(records[0]).toEqual(expect.objectContaining({
            model: 'mimo-v2.5-asr', audioDurationSec: 7.2, success: true,
        }))
        expect(records[1]).toEqual(expect.objectContaining({
            model: 'mimo-v2.5-tts', costYuan: 0, success: true,
        }))
    })
})
