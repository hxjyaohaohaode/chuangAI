/**
 * llm/router.ts 单元测试
 *
 * 覆盖：
 * - resolve()：路由矩阵解析（13 条路由 + 未知组合抛错）
 * - execute()：文本 / 多模态 / TTS / ASR 调用编排、事件发射、计费、限流
 * - execute() 错误路径与 fallback 降级
 * - executeStream()：流式调用与事件发射
 * - L4 死循环检测集成（trackOutput 调用）
 *
 * 设计原则：
 * - 4 个依赖（deepseek / mimo / errorRecovery / billing）全部 mock，隔离外部调用
 * - errorRecovery.wrap 直接执行 fn（绕过 L1 重试），通过 fallback 选项测试降级路径
 * - 使用真实 EventEmitter 验证事件链路
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { LLMRouter } from './router.js'
import { LLMError } from './error-recovery.js'
import type { DeepSeekClient } from './deepseek-client.js'
import type { MiMoClient } from './mimo-client.js'
import type { ErrorRecovery } from './error-recovery.js'
import type { TokenBilling, BillingRecord } from './billing.js'
import type { Domain, Function, ExecuteParams } from './types.js'

// ─────────────────────────────────────────────────────────────
// Mock 工厂
// ─────────────────────────────────────────────────────────────

function createDeepSeekMock() {
    return {
        chat: vi.fn(),
        stream: vi.fn(),
    }
}

function createMimoMock() {
    return {
        chat: vi.fn(),
        streamChat: vi.fn(),
        tts: vi.fn(),
        asr: vi.fn(),
    }
}

/**
 * 创建 ErrorRecovery mock
 *
 * 行为控制：
 * - useFallback=true  : fn 抛错时调用 fallback 函数返回降级值（模拟 L5 降级）
 * - useFallback=false : fn 抛错时重新抛出原始错误（模拟无降级，错误冒泡）
 *
 * 默认 useFallback=false，使错误路径测试可以验证错误冒泡；
 * 仅在 fallback 测试套件中显式传入 useFallback=true。
 */
function createErrorRecoveryMock(opts: { useFallback?: boolean } = {}) {
    const fallbackContent = '[AI 生成（降级模式）] 测试降级内容'
    const useFallback = opts.useFallback ?? false
    return {
        wrap: vi.fn(async (fn: () => Promise<unknown>, o: { fallback?: () => unknown }) => {
            try {
                return await fn()
            } catch (err) {
                if (useFallback && o.fallback) {
                    return o.fallback()
                }
                throw err
            }
        }),
        getFallback: vi.fn(() => fallbackContent),
        trackOutput: vi.fn(),
        classifyError: vi.fn((err: unknown) => {
            if (err instanceof LLMError) return err
            return new LLMError('L5', 'unknown', 'mock', false, err)
        }),
        resetAll: vi.fn(),
        _fallbackContent: fallbackContent,
        _useFallback: useFallback,
    }
}

function createBillingMock() {
    return {
        record: vi.fn((rec: Omit<BillingRecord, 'costYuan' | 'timestamp'>): BillingRecord => ({
            ...rec,
            timestamp: Date.now(),
            costYuan: 0.001,
        })),
        on: vi.fn(),
        emit: vi.fn(),
    }
}

function createRouter(deepseek: ReturnType<typeof createDeepSeekMock>,
    mimo: ReturnType<typeof createMimoMock>,
    errorRecovery: ReturnType<typeof createErrorRecoveryMock>,
    billing: ReturnType<typeof createBillingMock>) {
    // 构造函数参数顺序：deepseek, mimo, errorRecovery, billing
    return new LLMRouter(
        deepseek as unknown as DeepSeekClient,
        mimo as unknown as MiMoClient,
        errorRecovery as unknown as ErrorRecovery,
        billing as unknown as TokenBilling,
    )
}

// ─────────────────────────────────────────────────────────────
// resolve — 路由矩阵解析
// ─────────────────────────────────────────────────────────────

describe('LLMRouter — resolve 路由矩阵', () => {
    const router = createRouter(createDeepSeekMock(), createMimoMock(), createErrorRecoveryMock(), createBillingMock())

    it('mind:diagnose → deepseek-v4-pro + max', () => {
        const d = router.resolve('mind', 'diagnose')
        expect(d.provider).toBe('deepseek')
        expect(d.model).toBe('deepseek-v4-pro')
        expect(d.thinking).toBe('max')
    })

    it('mind:profile → mimo-v2.5-pro + medium', () => {
        const d = router.resolve('mind', 'profile')
        expect(d.provider).toBe('mimo')
        expect(d.model).toBe('mimo-v2.5-pro')
        expect(d.thinking).toBe('medium')
    })

    it('mind:recommend → deepseek-v4-flash + medium', () => {
        const d = router.resolve('mind', 'recommend')
        expect(d.provider).toBe('deepseek')
        expect(d.model).toBe('deepseek-v4-flash')
        expect(d.thinking).toBe('medium')
    })

    it('mind:verify → deepseek-v4-pro + high', () => {
        const d = router.resolve('mind', 'verify')
        expect(d.model).toBe('deepseek-v4-pro')
        expect(d.thinking).toBe('high')
    })

    it('eye:vision-annotate → mimo-v2.5 + high（多模态）', () => {
        const d = router.resolve('eye', 'vision-annotate')
        expect(d.provider).toBe('mimo')
        expect(d.model).toBe('mimo-v2.5')
        expect(d.thinking).toBe('high')
    })

    it('eye:asr → mimo-v2.5-asr（无 thinking）', () => {
        const d = router.resolve('eye', 'asr')
        expect(d.provider).toBe('mimo')
        expect(d.model).toBe('mimo-v2.5-asr')
        expect(d.thinking).toBeUndefined()
    })

    it('eye:tts → mimo-v2.5-tts（无 thinking）', () => {
        const d = router.resolve('eye', 'tts')
        expect(d.model).toBe('mimo-v2.5-tts')
        expect(d.thinking).toBeUndefined()
    })

    it('brush:generate-question → deepseek-v4-pro + max', () => {
        const d = router.resolve('brush', 'generate-question')
        expect(d.model).toBe('deepseek-v4-pro')
        expect(d.thinking).toBe('max')
    })

    it('brush:grade → deepseek-v4-flash + low', () => {
        const d = router.resolve('brush', 'grade')
        expect(d.model).toBe('deepseek-v4-flash')
        expect(d.thinking).toBe('low')
    })

    it('brush:report → deepseek-v4-pro + high', () => {
        const d = router.resolve('brush', 'report')
        expect(d.model).toBe('deepseek-v4-pro')
        expect(d.thinking).toBe('high')
    })

    it('brush:creative → deepseek-v4-flash + medium', () => {
        const d = router.resolve('brush', 'creative')
        expect(d.model).toBe('deepseek-v4-flash')
        expect(d.thinking).toBe('medium')
    })

    it('orchestrator:route → deepseek-v4-flash + low', () => {
        const d = router.resolve('orchestrator', 'route')
        expect(d.model).toBe('deepseek-v4-flash')
        expect(d.thinking).toBe('low')
    })

    it('orchestrator:summarize → deepseek-v4-flash + low', () => {
        const d = router.resolve('orchestrator', 'summarize')
        expect(d.model).toBe('deepseek-v4-flash')
        expect(d.thinking).toBe('low')
    })

    it('verifier:verify → deepseek-v4-pro + high', () => {
        const d = router.resolve('verifier', 'verify')
        expect(d.model).toBe('deepseek-v4-pro')
        expect(d.thinking).toBe('high')
    })

    it('路由决策包含 reason 字段', () => {
        const d = router.resolve('mind', 'diagnose')
        expect(d.reason).toBeTruthy()
        expect(typeof d.reason).toBe('string')
    })

    it('未知 domain 抛错', () => {
        expect(() => router.resolve('unknown' as Domain, 'diagnose')).toThrow(/路由矩阵未覆盖/)
    })

    it('未知 function 抛错', () => {
        expect(() => router.resolve('mind', 'unknown' as Function)).toThrow(/路由矩阵未覆盖/)
    })

    it('domain + function 都未知 抛错', () => {
        expect(() => router.resolve('unknown' as Domain, 'unknown' as Function)).toThrow(/路由矩阵未覆盖/)
    })
})

// ─────────────────────────────────────────────────────────────
// 全局思考模式覆盖 — 能力边界
// ─────────────────────────────────────────────────────────────

describe('LLMRouter — 全局思考模式覆盖不破坏专有能力路由', () => {
    let deepseek: ReturnType<typeof createDeepSeekMock>
    let mimo: ReturnType<typeof createMimoMock>
    let errorRecovery: ReturnType<typeof createErrorRecoveryMock>
    let billing: ReturnType<typeof createBillingMock>
    let router: LLMRouter

    beforeEach(() => {
        deepseek = createDeepSeekMock()
        mimo = createMimoMock()
        errorRecovery = createErrorRecoveryMock()
        billing = createBillingMock()
        router = createRouter(deepseek, mimo, errorRecovery, billing)
    })

    it('max 对纯文本 MiMo 路由仍升级为 deepseek-v4-pro + max', () => {
        router.setThinkingMode('max')

        expect(router.resolve('mind', 'profile')).toEqual(expect.objectContaining({
            provider: 'deepseek',
            model: 'deepseek-v4-pro',
            thinking: 'max',
        }))
    })

    it('max 不得把视觉请求改路由到纯文本 DeepSeek，并降级为 MiMo 可用的最高 high 档', () => {
        router.setThinkingMode('max')

        const decision = router.resolve('eye', 'vision-annotate')
        expect(decision).toEqual(expect.objectContaining({
            provider: 'mimo',
            model: 'mimo-v2.5',
            thinking: 'high',
        }))
        expect(decision.reason).toMatch(/视觉|多模态/)
        expect(decision.reason).toMatch(/max/)
    })

    it('max 不影响 ASR/TTS 专用模型', () => {
        router.setThinkingMode('max')

        expect(router.resolve('eye', 'asr')).toEqual(expect.objectContaining({
            provider: 'mimo',
            model: 'mimo-v2.5-asr',
            thinking: undefined,
        }))
        expect(router.resolve('eye', 'tts')).toEqual(expect.objectContaining({
            provider: 'mimo',
            model: 'mimo-v2.5-tts',
            thinking: undefined,
        }))
    })
})

// ─────────────────────────────────────────────────────────────
// execute — 文本调用
// ─────────────────────────────────────────────────────────────

describe('LLMRouter — execute 文本调用', () => {
    let deepseek: ReturnType<typeof createDeepSeekMock>
    let mimo: ReturnType<typeof createMimoMock>
    let errorRecovery: ReturnType<typeof createErrorRecoveryMock>
    let billing: ReturnType<typeof createBillingMock>
    let router: LLMRouter

    beforeEach(() => {
        deepseek = createDeepSeekMock()
        mimo = createMimoMock()
        errorRecovery = createErrorRecoveryMock()
        billing = createBillingMock()
        router = createRouter(deepseek, mimo, errorRecovery, billing)
    })

    it('deepseek 文本调用：调用 deepseek.chat 并返回 LLMResult', async () => {
        deepseek.chat.mockResolvedValue({
            content: '诊断结果',
            reasoning: '思考过程',
            usage: { promptTokens: 100, completionTokens: 50, cachedTokens: 10 },
            latencyMs: 200,
            model: 'deepseek-v4-pro',
        })

        const result = await router.execute('mind', 'diagnose', {
            messages: [{ role: 'user', content: '诊断学情' }],
        })

        expect(deepseek.chat).toHaveBeenCalledTimes(1)
        expect(deepseek.chat).toHaveBeenCalledWith(expect.objectContaining({
            model: 'deepseek-v4-pro',
            thinking: 'max',
        }))
        expect(result.content).toBe('诊断结果')
        expect(result.reasoning).toBe('思考过程')
        expect(result.provider).toBe('deepseek')
        expect(result.model).toBe('deepseek-v4-pro')
        expect(result.fallback).toBeUndefined()
    })

    it('mimo 文本调用：调用 mimo.chat 并返回 LLMResult', async () => {
        mimo.chat.mockResolvedValue({
            content: '画像结果',
            usage: { promptTokens: 100, completionTokens: 50 },
            latencyMs: 150,
            model: 'mimo-v2.5-pro',
        })

        const result = await router.execute('mind', 'profile', {
            messages: [{ role: 'user', content: '生成画像' }],
        })

        expect(mimo.chat).toHaveBeenCalledTimes(1)
        expect(mimo.chat).toHaveBeenCalledWith(expect.objectContaining({
            model: 'mimo-v2.5-pro',
            thinking: 'medium',
        }))
        expect(result.content).toBe('画像结果')
        expect(result.provider).toBe('mimo')
        expect(result.model).toBe('mimo-v2.5-pro')
    })

    it('参数透传：temperature / maxTokens / jsonOutput / tools', async () => {
        deepseek.chat.mockResolvedValue({
            content: 'ok', usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 1, model: 'deepseek-v4-pro',
        })

        await router.execute('mind', 'diagnose', {
            messages: [{ role: 'user', content: 'hi' }],
            temperature: 0.7,
            maxTokens: 2048,
            jsonOutput: true,
            tools: [{ type: 'function', function: { name: 'tool1' } }],
        })

        expect(deepseek.chat).toHaveBeenCalledWith(expect.objectContaining({
            temperature: 0.7,
            maxTokens: 2048,
            jsonOutput: true,
            tools: [{ type: 'function', function: { name: 'tool1' } }],
        }))
    })

    it('metadata 缺失时使用 domain/function 作为默认 agent/task', async () => {
        deepseek.chat.mockResolvedValue({
            content: 'ok', usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 1, model: 'deepseek-v4-pro',
        })

        await router.execute('mind', 'diagnose', {
            messages: [{ role: 'user', content: 'hi' }],
        })

        // billing.record 应被调用，agent='mind', task='diagnose'
        expect(billing.record).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'mind',
            task: 'diagnose',
        }))
    })

    it('metadata 显式提供时透传到 billing', async () => {
        deepseek.chat.mockResolvedValue({
            content: 'ok', usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 1, model: 'deepseek-v4-pro',
        })

        await router.execute('mind', 'diagnose', {
            messages: [{ role: 'user', content: 'hi' }],
            metadata: { agent: 'custom-agent', task: 'custom-task', sessionId: 'sess-1' },
        })

        expect(billing.record).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'custom-agent',
            task: 'custom-task',
            sessionId: 'sess-1',
        }))
    })

    it('成功时发射 llm:call:start 与 llm:call:success 事件', async () => {
        deepseek.chat.mockResolvedValue({
            content: 'ok', usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 1, model: 'deepseek-v4-pro',
        })

        const startEvents: unknown[] = []
        const successEvents: unknown[] = []
        router.on('llm:call:start', (p: unknown) => startEvents.push(p))
        router.on('llm:call:success', (p: unknown) => successEvents.push(p))

        await router.execute('mind', 'diagnose', {
            messages: [{ role: 'user', content: 'hi' }],
        })

        expect(startEvents).toHaveLength(1)
        expect(successEvents).toHaveLength(1)
        const startPayload = startEvents[0] as Record<string, unknown>
        expect(startPayload.domain).toBe('mind')
        expect(startPayload.function).toBe('diagnose')
        expect(startPayload.model).toBe('deepseek-v4-pro')
        const successPayload = successEvents[0] as Record<string, unknown>
        expect(successPayload.fallback).toBe(false)
    })

    it('调用 trackOutput 进行 L4 死循环检测（非 fallback 时）', async () => {
        deepseek.chat.mockResolvedValue({
            content: 'unique-output',
            usage: { promptTokens: 1, completionTokens: 1 },
            latencyMs: 1,
            model: 'deepseek-v4-pro',
        })

        await router.execute('mind', 'diagnose', {
            messages: [{ role: 'user', content: 'hi' }],
        })

        expect(errorRecovery.trackOutput).toHaveBeenCalledTimes(1)
        expect(errorRecovery.trackOutput).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(String),
            'unique-output',
            undefined,
        )
    })

    it('billing.record 被调用并包含 success: true', async () => {
        deepseek.chat.mockResolvedValue({
            content: 'ok',
            usage: { promptTokens: 100, completionTokens: 50, cachedTokens: 10 },
            latencyMs: 200,
            model: 'deepseek-v4-pro',
        })

        await router.execute('mind', 'diagnose', {
            messages: [{ role: 'user', content: 'hi' }],
        })

        expect(billing.record).toHaveBeenCalledTimes(1)
        const recArg = billing.record.mock.calls[0]![0] as Record<string, unknown>
        expect(recArg.success).toBe(true)
        expect(recArg.promptTokens).toBe(100)
        expect(recArg.completionTokens).toBe(50)
        expect(recArg.cachedTokens).toBe(10)
        expect(recArg.provider).toBe('deepseek')
        expect(recArg.model).toBe('deepseek-v4-pro')
    })
})

// ─────────────────────────────────────────────────────────────
// execute — 多模态 / TTS / ASR
// ─────────────────────────────────────────────────────────────

describe('LLMRouter — execute 多模态/TTS/ASR', () => {
    let deepseek: ReturnType<typeof createDeepSeekMock>
    let mimo: ReturnType<typeof createMimoMock>
    let errorRecovery: ReturnType<typeof createErrorRecoveryMock>
    let billing: ReturnType<typeof createBillingMock>
    let router: LLMRouter

    beforeEach(() => {
        deepseek = createDeepSeekMock()
        mimo = createMimoMock()
        errorRecovery = createErrorRecoveryMock()
        billing = createBillingMock()
        router = createRouter(deepseek, mimo, errorRecovery, billing)
    })

    it('vision-annotate：调用 mimo.chat with images + thinking:high', async () => {
        mimo.chat.mockResolvedValue({
            content: '图片标注',
            usage: { promptTokens: 100, completionTokens: 50 },
            latencyMs: 300,
            model: 'mimo-v2.5',
        })

        const result = await router.execute('eye', 'vision-annotate', {
            messages: [{ role: 'user', content: '识别图片' }],
            images: [{ url: 'data:image/png;base64,xxx', detail: 'high' }],
        })

        expect(mimo.chat).toHaveBeenCalledTimes(1)
        expect(mimo.chat).toHaveBeenCalledWith(expect.objectContaining({
            model: 'mimo-v2.5',
            thinking: 'high',
            images: [{ url: 'data:image/png;base64,xxx', detail: 'high' }],
        }))
        expect(result.content).toBe('图片标注')
        expect(result.provider).toBe('mimo')
        expect(result.model).toBe('mimo-v2.5')
    })

    it('vision-annotate 在全局 max 下仍由 MiMo 执行，且事件与计费使用真实 provider/model', async () => {
        router.setThinkingMode('max')
        mimo.chat.mockResolvedValue({
            content: '高强度图片标注',
            usage: { promptTokens: 80, completionTokens: 30 },
            latencyMs: 120,
            model: 'mimo-v2.5',
        })
        const startEvents: Array<Record<string, unknown>> = []
        const successEvents: Array<Record<string, unknown>> = []
        router.on('llm:call:start', (payload: Record<string, unknown>) => startEvents.push(payload))
        router.on('llm:call:success', (payload: Record<string, unknown>) => successEvents.push(payload))

        const result = await router.execute('eye', 'vision-annotate', {
            messages: [{ role: 'user', content: '识别图片' }],
            images: [{ url: 'data:image/png;base64,xxx', detail: 'high' }],
        })

        expect(deepseek.chat).not.toHaveBeenCalled()
        expect(mimo.chat).toHaveBeenCalledWith(expect.objectContaining({
            model: 'mimo-v2.5',
            thinking: 'high',
            images: [{ url: 'data:image/png;base64,xxx', detail: 'high' }],
        }))
        expect(result).toEqual(expect.objectContaining({
            provider: 'mimo',
            model: 'mimo-v2.5',
        }))
        expect(startEvents[0]).toEqual(expect.objectContaining({
            provider: 'mimo',
            model: 'mimo-v2.5',
            thinking: 'high',
        }))
        expect(successEvents[0]).toEqual(expect.objectContaining({
            provider: 'mimo',
            model: 'mimo-v2.5',
        }))
        expect(billing.record).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'mimo',
            model: 'mimo-v2.5',
            success: true,
        }))
    })

    it.each(['low', 'medium', 'high'] as const)(
        'vision-annotate 的 %s 全局覆盖会传给 MiMo，而不是被硬编码回 high',
        async (mode) => {
            router.setThinkingMode(mode)
            mimo.chat.mockResolvedValue({
                content: '快速图片标注',
                usage: { promptTokens: 20, completionTokens: 10 },
                latencyMs: 40,
                model: 'mimo-v2.5',
            })

            await router.execute('eye', 'vision-annotate', {
                messages: [{ role: 'user', content: '快速识别' }],
                images: [{ url: 'data:image/png;base64,xxx' }],
            })

            expect(mimo.chat).toHaveBeenCalledWith(expect.objectContaining({
                model: 'mimo-v2.5',
                thinking: mode,
            }))
        },
    )

    it('vision-annotate 在全局 max 下发生 L5 fallback 时仍标记 MiMo provider/model', async () => {
        const fallbackRecovery = createErrorRecoveryMock({ useFallback: true })
        router = createRouter(deepseek, mimo, fallbackRecovery, billing)
        router.setThinkingMode('max')
        mimo.chat.mockRejectedValue(new Error('mimo unavailable'))

        const result = await router.execute('eye', 'vision-annotate', {
            messages: [{ role: 'user', content: '识别图片' }],
            images: [{ url: 'data:image/png;base64,xxx' }],
        })

        expect(result).toEqual(expect.objectContaining({
            fallback: true,
            provider: 'mimo',
            model: 'mimo-v2.5',
        }))
        expect(billing.record).toHaveBeenCalledWith(expect.objectContaining({
            fallback: true,
            provider: 'mimo',
            model: 'mimo-v2.5',
        }))
    })

    it('tts：调用 mimo.tts，返回 audio + audioFormat', async () => {
        const audioBuf = Buffer.from('fake-audio')
        mimo.tts.mockResolvedValue({
            audio: audioBuf,
            format: 'mp3',
            durationMs: 1000,
        })

        const result = await router.execute('eye', 'tts', {
            text: '床前明月光',
            voice: 'alloy',
            speed: 1.0,
            responseFormat: 'mp3',
        })

        expect(mimo.tts).toHaveBeenCalledTimes(1)
        expect(mimo.tts).toHaveBeenCalledWith(expect.objectContaining({
            model: 'mimo-v2.5-tts',
            text: '床前明月光',
            voice: 'alloy',
            speed: 1.0,
            responseFormat: 'mp3',
        }))
        expect(result.audio).toBe(audioBuf)
        expect(result.audioFormat).toBe('mp3')
        expect(result.model).toBe('mimo-v2.5-tts')
        expect(result.content).toBe('')
    })

    it('tts 缺少 text 参数抛错', async () => {
        await expect(router.execute('eye', 'tts', {} as ExecuteParams))
            .rejects.toThrow(/TTS 调用需要 text 参数/)
    })

    it('asr：调用 mimo.asr，返回 text + audioDurationSec', async () => {
        mimo.asr.mockResolvedValue({
            text: '识别结果',
            durationSec: 5.2,
            confidence: 0.95,
        })

        const result = await router.execute('eye', 'asr', {
            audio: Buffer.from('fake-audio'),
            language: 'zh',
            prompt: '引导词',
        })

        expect(mimo.asr).toHaveBeenCalledTimes(1)
        expect(mimo.asr).toHaveBeenCalledWith(expect.objectContaining({
            model: 'mimo-v2.5-asr',
            language: 'zh',
            prompt: '引导词',
        }))
        expect(result.content).toBe('识别结果')
        expect(result.audioDurationSec).toBe(5.2)
        expect(result.confidence).toBe(0.95)
        expect(result.model).toBe('mimo-v2.5-asr')
    })

    it('asr 缺少 audio 参数抛错', async () => {
        await expect(router.execute('eye', 'asr', {} as ExecuteParams))
            .rejects.toThrow(/ASR 调用需要 audio 参数/)
    })
})

// ─────────────────────────────────────────────────────────────
// execute — 错误路径与降级
// ─────────────────────────────────────────────────────────────

describe('LLMRouter — execute 错误与降级', () => {
    let deepseek: ReturnType<typeof createDeepSeekMock>
    let mimo: ReturnType<typeof createMimoMock>
    let errorRecovery: ReturnType<typeof createErrorRecoveryMock>
    let billing: ReturnType<typeof createBillingMock>
    let router: LLMRouter

    beforeEach(() => {
        deepseek = createDeepSeekMock()
        mimo = createMimoMock()
        // 默认 useFallback=false，错误会重新抛出
        errorRecovery = createErrorRecoveryMock()
        billing = createBillingMock()
        router = createRouter(deepseek, mimo, errorRecovery, billing)
    })

    it('调用抛错时发射 llm:call:error 事件并重新抛出', async () => {
        const error = new Error('网络故障')
        deepseek.chat.mockRejectedValue(error)

        const errorEvents: unknown[] = []
        router.on('llm:call:error', (p: unknown) => errorEvents.push(p))

        await expect(router.execute('mind', 'diagnose', {
            messages: [{ role: 'user', content: 'hi' }],
        })).rejects.toThrow('网络故障')

        expect(errorEvents).toHaveLength(1)
        const payload = errorEvents[0] as Record<string, unknown>
        expect(payload.error).toBe('网络故障')
        expect(payload.errorType).toBe('unknown')
    })

    it('调用抛错时仍调用 billing.record（success: false）', async () => {
        deepseek.chat.mockRejectedValue(new Error('网络故障'))

        await expect(router.execute('mind', 'diagnose', {
            messages: [{ role: 'user', content: 'hi' }],
        })).rejects.toThrow()

        expect(billing.record).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            promptTokens: 0,
            completionTokens: 0,
        }))
    })

    describe('启用 fallback 降级', () => {
        beforeEach(() => {
            // 在 fallback 子套件中重新创建带 useFallback=true 的 router
            errorRecovery = createErrorRecoveryMock({ useFallback: true })
            router = createRouter(deepseek, mimo, errorRecovery, billing)
        })

        it('fallback 降级：返回 fallback 内容并标注 fallback=true', async () => {
            // errorRecovery.wrap 在 fn 失败时调用 fallback
            // 我们的 mock 已实现此逻辑
            deepseek.chat.mockRejectedValue(new Error('服务不可用'))

            const result = await router.execute('mind', 'diagnose', {
                messages: [{ role: 'user', content: 'hi' }],
            })

            expect(result.fallback).toBe(true)
            expect(result.content).toContain('降级模式')
            expect(result.usage.promptTokens).toBe(0)
            expect(result.usage.completionTokens).toBe(0)
        })

        it('fallback 降级时不调用 trackOutput（避免污染循环检测）', async () => {
            deepseek.chat.mockRejectedValue(new Error('服务不可用'))

            await router.execute('mind', 'diagnose', {
                messages: [{ role: 'user', content: 'hi' }],
            })

            expect(errorRecovery.trackOutput).not.toHaveBeenCalled()
        })

        it('fallback 降级时仍发射 success 事件（fallback: true）', async () => {
            deepseek.chat.mockRejectedValue(new Error('服务不可用'))

            const successEvents: unknown[] = []
            router.on('llm:call:success', (p: unknown) => successEvents.push(p))

            await router.execute('mind', 'diagnose', {
                messages: [{ role: 'user', content: 'hi' }],
            })

            expect(successEvents).toHaveLength(1)
            const payload = successEvents[0] as Record<string, unknown>
            expect(payload.fallback).toBe(true)
        })
    })

    it('非 Error 异常也被正确处理（String 化）', async () => {
        deepseek.chat.mockRejectedValue('string-error')

        const errorEvents: unknown[] = []
        router.on('llm:call:error', (p: unknown) => errorEvents.push(p))

        await expect(router.execute('mind', 'diagnose', {
            messages: [{ role: 'user', content: 'hi' }],
        })).rejects.toBe('string-error')

        const payload = errorEvents[0] as Record<string, unknown>
        expect(payload.error).toBe('string-error')
    })
})

// ─────────────────────────────────────────────────────────────
// executeStream — 流式调用
// ─────────────────────────────────────────────────────────────

describe('LLMRouter — executeStream 流式调用', () => {
    let deepseek: ReturnType<typeof createDeepSeekMock>
    let mimo: ReturnType<typeof createMimoMock>
    let errorRecovery: ReturnType<typeof createErrorRecoveryMock>
    let billing: ReturnType<typeof createBillingMock>
    let router: LLMRouter

    beforeEach(() => {
        deepseek = createDeepSeekMock()
        mimo = createMimoMock()
        errorRecovery = createErrorRecoveryMock()
        billing = createBillingMock()
        router = createRouter(deepseek, mimo, errorRecovery, billing)
    })

    it('deepseek 流式：逐分片 yield，事件只暴露形态，并按最终 usage 计费', async () => {
        async function* fakeStream() {
            yield { content: '分片1', reasoning: '供应商私有推理' }
            yield { content: '分片2' }
            yield { done: true, usage: { promptTokens: 10, completionTokens: 20, cachedTokens: 3 } }
        }
        deepseek.stream.mockReturnValue(fakeStream())

        const deltaEvents: unknown[] = []
        router.on('llm:stream:delta', (p: unknown) => deltaEvents.push(p))

        const chunks: unknown[] = []
        for await (const chunk of router.executeStream('mind', 'diagnose', {
            messages: [{ role: 'user', content: 'hi' }],
        })) {
            chunks.push(chunk)
        }

        expect(chunks.length).toBe(3)
        expect(deltaEvents.length).toBe(3)
        expect((deltaEvents[0] as { chunk: unknown }).chunk).toEqual({
            hasContent: true,
            hasReasoning: true,
            toolCallCount: 0,
            done: false,
            hasUsage: false,
        })
        expect(JSON.stringify(deltaEvents)).not.toContain('分片1')
        expect(JSON.stringify(deltaEvents)).not.toContain('供应商私有推理')
        expect(billing.record).toHaveBeenCalledTimes(1)
        expect(billing.record).toHaveBeenCalledWith(expect.objectContaining({
            promptTokens: 10,
            completionTokens: 20,
            cachedTokens: 3,
            success: true,
            fallback: false,
        }))
    })

    it('mimo 流式：调用 mimo.streamChat', async () => {
        async function* fakeStream() {
            yield { content: 'mimo-分片' }
        }
        mimo.streamChat.mockReturnValue(fakeStream())

        const chunks: unknown[] = []
        for await (const chunk of router.executeStream('mind', 'profile', {
            messages: [{ role: 'user', content: 'hi' }],
        })) {
            chunks.push(chunk)
        }

        expect(mimo.streamChat).toHaveBeenCalledTimes(1)
        expect(mimo.streamChat).toHaveBeenCalledWith(expect.objectContaining({
            model: 'mimo-v2.5-pro',
            thinking: 'medium',
        }))
        expect(chunks.length).toBe(1)
    })

    it('vision-annotate 流式在全局 max 下仍走 MiMo 端点并保留图片', async () => {
        router.setThinkingMode('max')
        async function* mimoVisionStream() {
            yield { content: '视觉分片' }
        }
        async function* forbiddenDeepSeekStream() {
            yield { content: '不应出现' }
        }
        mimo.streamChat.mockReturnValue(mimoVisionStream())
        deepseek.stream.mockReturnValue(forbiddenDeepSeekStream())

        const chunks: unknown[] = []
        for await (const chunk of router.executeStream('eye', 'vision-annotate', {
            messages: [{ role: 'user', content: '识别图片' }],
            images: [{ url: 'data:image/png;base64,xxx', detail: 'high' }],
        })) {
            chunks.push(chunk)
        }

        expect(deepseek.stream).not.toHaveBeenCalled()
        expect(mimo.streamChat).toHaveBeenCalledWith(expect.objectContaining({
            model: 'mimo-v2.5',
            thinking: 'high',
            images: [{ url: 'data:image/png;base64,xxx', detail: 'high' }],
        }))
        expect(chunks).toEqual([{ content: '视觉分片' }])
    })

    it('流式调用发射 llm:call:start 事件', async () => {
        async function* fakeStream() {
            yield { content: 'x' }
        }
        deepseek.stream.mockReturnValue(fakeStream())

        const startEvents: unknown[] = []
        router.on('llm:call:start', (p: unknown) => startEvents.push(p))

        for await (const _ of router.executeStream('mind', 'diagnose', {
            messages: [{ role: 'user', content: 'hi' }],
        })) {
            // consume
        }

        expect(startEvents).toHaveLength(1)
        const payload = startEvents[0] as Record<string, unknown>
        expect(payload.model).toBe('deepseek-v4-pro')
    })

    it('流式调用成功完成时发射 llm:call:success', async () => {
        async function* fakeStream() {
            yield { content: 'x' }
        }
        deepseek.stream.mockReturnValue(fakeStream())

        const successEvents: unknown[] = []
        router.on('llm:call:success', (p: unknown) => successEvents.push(p))

        for await (const _ of router.executeStream('mind', 'diagnose', {
            messages: [{ role: 'user', content: 'hi' }],
        })) {
            // consume
        }

        expect(successEvents).toHaveLength(1)
        const payload = successEvents[0] as Record<string, unknown>
        expect(payload.costYuan).toBe(0.001)
        expect(payload.fallback).toBe(false)
        expect(billing.record).toHaveBeenCalledTimes(1)
    })

    it('流式抛错时发射 llm:call:error 并重新抛出', async () => {
        async function* failingStream() {
            yield { content: '部分' }
            throw new Error('流中断')
        }
        deepseek.stream.mockReturnValue(failingStream())

        const errorEvents: unknown[] = []
        router.on('llm:call:error', (p: unknown) => errorEvents.push(p))

        await expect(async () => {
            for await (const _ of router.executeStream('mind', 'diagnose', {
                messages: [{ role: 'user', content: 'hi' }],
            })) {
                // consume
            }
        }).rejects.toThrow('流中断')

        expect(errorEvents).toHaveLength(1)
        expect((errorEvents[0] as Record<string, unknown>).error).toBe('模型流式调用失败')
        expect((errorEvents[0] as Record<string, unknown>).errorType).toBe('unknown')
        expect(billing.record).toHaveBeenCalledTimes(1)
        expect(billing.record).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            promptTokens: 0,
            completionTokens: 0,
        }))
    })

    it('消费者提前 return 时中止唯一上游调用并形成一次失败终态', async () => {
        let providerSignal: AbortSignal | undefined
        let sourceClosed = false
        deepseek.stream.mockImplementation((params: { signal?: AbortSignal }) => {
            providerSignal = params.signal
            return (async function* () {
                try {
                    yield { content: '只消费首片' }
                    yield { content: '不应被消费' }
                } finally {
                    sourceClosed = true
                }
            })()
        })

        const successEvents: unknown[] = []
        const errorEvents: unknown[] = []
        router.on('llm:call:success', (payload: unknown) => successEvents.push(payload))
        router.on('llm:call:error', (payload: unknown) => errorEvents.push(payload))

        const iterator = router.executeStream('mind', 'diagnose', {
            messages: [{ role: 'user', content: 'hi' }],
        })
        expect(await iterator.next()).toEqual({ done: false, value: { content: '只消费首片' } })
        await iterator.return(undefined)

        expect(deepseek.stream).toHaveBeenCalledTimes(1)
        expect(sourceClosed).toBe(true)
        expect(providerSignal?.aborted).toBe(true)
        expect(successEvents).toHaveLength(0)
        expect(errorEvents).toHaveLength(1)
        expect(errorEvents[0]).toMatchObject({
            error: '模型流式调用已中止',
            errorType: 'network',
        })
        expect(billing.record).toHaveBeenCalledTimes(1)
        expect(billing.record).toHaveBeenCalledWith(expect.objectContaining({ success: false }))
    })
})
