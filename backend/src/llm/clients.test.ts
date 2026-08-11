import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
    constructorSpy: vi.fn(),
    chatCreate: vi.fn(),
    speechCreate: vi.fn(),
    transcriptionCreate: vi.fn(),
    toFile: vi.fn(),
}))

vi.mock('openai', () => {
    class MockOpenAI {
        static toFile = sdk.toFile
        chat = { completions: { create: sdk.chatCreate } }
        audio = {
            speech: { create: sdk.speechCreate },
            transcriptions: { create: sdk.transcriptionCreate },
        }

        constructor(options: unknown) {
            sdk.constructorSpy(options)
        }
    }

    return { default: MockOpenAI }
})

import { DeepSeekClient } from './deepseek-client.js'
import { MiMoClient } from './mimo-client.js'

const tool = {
    type: 'function' as const,
    function: {
        name: 'lookup_poem',
        description: '查询古诗',
        parameters: { type: 'object', properties: { title: { type: 'string' } } },
    },
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const result: T[] = []
    for await (const item of iterable) result.push(item)
    return result
}

describe('DeepSeekClient SDK contract', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('fails before the SDK boundary when the API key is missing', async () => {
        const client = new DeepSeekClient('   ', 'https://deepseek.test/v1')
        await expect(client.chat({
            model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '不得触网' }],
        })).rejects.toThrow('API 密钥未配置')
        await expect(collect(client.stream({
            model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '不得触网' }],
        }))).rejects.toThrow('API 密钥未配置')
        expect(sdk.chatCreate).not.toHaveBeenCalled()
    })

    it('maps messages, tools, JSON mode, usage and runtime key rotation', async () => {
        sdk.chatCreate.mockResolvedValue({
            choices: [{
                finish_reason: 'stop',
                message: {
                    content: '{"ok":true}',
                    reasoning_content: '先核验出处',
                    tool_calls: [{ id: 'tool-1', function: { name: 'lookup_poem', arguments: '{"title":"静夜思"}' } }],
                },
            }],
            usage: { prompt_tokens: 12, completion_tokens: 8, prompt_cache_hit_tokens: 4 },
        })
        const client = new DeepSeekClient('key-a', 'https://deepseek.test/v1')
        const controller = new AbortController()
        const result = await client.chat({
            model: 'deepseek-v4-pro',
            thinking: 'max',
            temperature: 0.2,
            maxTokens: 9000,
            jsonOutput: true,
            tools: [tool],
            signal: controller.signal,
            messages: [
                { role: 'system', content: '只输出证据充分的结论' },
                { role: 'assistant', content: [{ type: 'text', text: '草稿' }], tool_calls: [{ id: 'old', type: 'function', function: { name: 'lookup_poem', arguments: '{}' } }] },
                { role: 'tool', tool_call_id: 'old', content: [{ type: 'text', text: '静夜思' }] },
                { role: 'user', content: '分析' },
            ],
        })

        expect(result).toMatchObject({
            content: '{"ok":true}',
            reasoning: '先核验出处',
            usage: { promptTokens: 12, completionTokens: 8, cachedTokens: 4 },
            model: 'deepseek-v4-pro',
        })
        expect(result.toolCalls?.[0]?.function.name).toBe('lookup_poem')
        const body = sdk.chatCreate.mock.calls[0]?.[0] as Record<string, unknown>
        expect(body).toMatchObject({
            model: 'deepseek-v4-pro',
            reasoning_effort: 'max',
            temperature: 0.2,
            max_tokens: 9000,
            response_format: { type: 'json_object' },
        })
        expect(body.tools).toHaveLength(1)
        expect(sdk.chatCreate.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal })

        client.setApiKey('key-b')
        expect(sdk.constructorSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            apiKey: 'key-b', baseURL: 'https://deepseek.test/v1', maxRetries: 0,
        }))
    })

    it('streams reasoning, content, tool deltas and terminal usage', async () => {
        async function* chunks() {
            yield { choices: [] }
            yield { choices: [{ delta: { reasoning_content: '思考' } }] }
            yield { choices: [{ delta: { content: '回答' } }] }
            yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'lookup_poem', arguments: '{}' } }] } }] }
            yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, prompt_cache_hit_tokens: 2 } }
        }
        sdk.chatCreate.mockResolvedValue(chunks())
        const client = new DeepSeekClient('key', 'https://deepseek.test/v1')

        const result = await collect(client.stream({
            model: 'deepseek-v4-flash',
            thinking: 'high',
            messages: [{ role: 'user', content: '回答' }],
        }))

        expect(result).toEqual([
            { reasoning: '思考' },
            { content: '回答' },
            { toolCalls: [{ index: 0, id: 't1', function: { name: 'lookup_poem', arguments: '{}' } }] },
            { done: true, usage: { promptTokens: 5, completionTokens: 3, cachedTokens: 2 } },
        ])
        expect(sdk.chatCreate.mock.calls[0]?.[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } })
    })

    it('rejects unsupported max thinking and detects exhausted output budgets', async () => {
        const client = new DeepSeekClient('key', 'https://deepseek.test/v1')
        await expect(client.chat({
            model: 'deepseek-v4-flash', thinking: 'max', messages: [{ role: 'user', content: '分析' }],
        })).rejects.toThrow('仅 deepseek-v4-pro 支持')

        sdk.chatCreate.mockResolvedValue({
            choices: [{ finish_reason: 'length', message: { content: '', tool_calls: [] } }],
            usage: null,
        })
        await expect(client.chat({
            model: 'deepseek-v4-pro', thinking: 'high', maxTokens: 128, messages: [{ role: 'user', content: '分析' }],
        })).rejects.toThrow('max_tokens 截断')
    })
})

describe('MiMoClient SDK contract', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        sdk.toFile.mockResolvedValue({ name: 'audio.mp3' })
    })

    it('fails before text, audio and file SDK boundaries when the API key is missing', async () => {
        const client = new MiMoClient('', 'https://mimo.test/v1')
        await expect(client.chat({
            model: 'mimo-v2.5', messages: [{ role: 'user', content: '不得触网' }],
        })).rejects.toThrow('API 密钥未配置')
        await expect(collect(client.streamChat({
            model: 'mimo-v2.5', messages: [{ role: 'user', content: '不得触网' }],
        }))).rejects.toThrow('API 密钥未配置')
        await expect(client.tts({ model: 'mimo-v2.5-tts', text: '不得触网' }))
            .rejects.toThrow('API 密钥未配置')
        await expect(client.asr({
            model: 'mimo-v2.5-asr', audio: Buffer.from('not-audio'),
        })).rejects.toThrow('API 密钥未配置')
        expect(sdk.chatCreate).not.toHaveBeenCalled()
        expect(sdk.speechCreate).not.toHaveBeenCalled()
        expect(sdk.transcriptionCreate).not.toHaveBeenCalled()
        expect(sdk.toFile).not.toHaveBeenCalled()
    })

    it('maps multimodal chat and tool calls without exposing SDK-specific shapes', async () => {
        const pngDataUrl = `data:image/png;base64,${Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
        ]).toString('base64')}`
        sdk.chatCreate.mockResolvedValue({
            choices: [{ message: {
                content: '识别结果',
                reasoning_content: '逐区域核验',
                tool_calls: [{ id: 'm1', function: { name: 'lookup_poem', arguments: '{}' } }],
            } }],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
        })
        const client = new MiMoClient('key-a', 'https://mimo.test/v1')
        const result = await client.chat({
            model: 'mimo-v2.5', thinking: 'high', temperature: 0.1, maxTokens: 2048,
            messages: [{ role: 'user', content: '识别图片' }],
            images: [{ url: pngDataUrl, detail: 'high' }],
            tools: [tool],
        })

        expect(result).toMatchObject({
            content: '识别结果', reasoning: '逐区域核验',
            usage: { promptTokens: 20, completionTokens: 10 }, model: 'mimo-v2.5',
        })
        const body = sdk.chatCreate.mock.calls[0]?.[0] as { messages: Array<{ content: unknown }>; tools: unknown[] }
        expect(body.messages[0]?.content).toEqual([
            { type: 'text', text: '识别图片' },
            { type: 'image_url', image_url: { url: pngDataUrl, detail: 'high' } },
        ])
        expect(body.tools).toHaveLength(1)

        await expect(client.chat({
            model: 'mimo-v2.5',
            messages: [{ role: 'user', content: 'SSRF probe' }],
            images: [{ url: 'http://127.0.0.1:9/internal.png' }],
        })).rejects.toThrow('拒绝非受控图片引用')
        await expect(client.chat({
            model: 'mimo-v2.5',
            messages: [{
                role: 'user',
                content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
            }],
        })).rejects.toThrow('拒绝非受控图片引用')
        expect(sdk.chatCreate).toHaveBeenCalledTimes(1)

        client.setApiKey('key-b')
        expect(sdk.constructorSpy).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'key-b', baseURL: 'https://mimo.test/v1' }))
    })

    it('streams text, reasoning, tool calls and usage', async () => {
        async function* chunks() {
            yield { choices: [] }
            yield { choices: [{ delta: { reasoning_content: '看图' } }] }
            yield { choices: [{ delta: { content: '完成' } }] }
            yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'm1', function: { name: 'lookup_poem' } }] } }] }
            yield { choices: [], usage: { prompt_tokens: 9, completion_tokens: 6 } }
        }
        sdk.chatCreate.mockResolvedValue(chunks())
        const client = new MiMoClient('key', 'https://mimo.test/v1')
        const result = await collect(client.streamChat({
            model: 'mimo-v2.5-pro', messages: [{ role: 'user', content: '开始' }],
        }))
        expect(result).toEqual([
            { reasoning: '看图' },
            { content: '完成' },
            { toolCalls: [{ index: 0, id: 'm1', function: { name: 'lookup_poem' } }] },
            { done: true, usage: { promptTokens: 9, completionTokens: 6 } },
        ])
    })

    it('handles TTS and ASR buffer/base64 inputs, rejects URL fetching, with bounded confidence', async () => {
        const wav = Uint8Array.from([
            0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
            0x57, 0x41, 0x56, 0x45,
        ])
        sdk.speechCreate.mockResolvedValue(new Response(wav, {
            headers: { 'content-type': 'audio/wav' },
        }))
        sdk.transcriptionCreate.mockResolvedValue({
            text: '床前明月光', duration: '5.5', segments: [{ avg_logprob: -0.1 }, { avg_logprob: -2 }],
        })
        const client = new MiMoClient('key', 'https://mimo.test/v1')
        const tts = await client.tts({
            model: 'mimo-v2.5-tts', text: '床前明月光', voice: 'alloy', speed: 1.1, responseFormat: 'wav',
        })
        expect(tts.audio).toEqual(Buffer.from(wav))
        expect(tts).toMatchObject({ format: 'wav' })
        expect(tts.durationMs).toBeGreaterThanOrEqual(1250)

        const mp3 = Buffer.from('ID30000', 'ascii')
        const mp3Base64 = mp3.toString('base64')
        const fromBuffer = await client.asr({
            model: 'mimo-v2.5-asr', audio: mp3, language: 'zh', prompt: '古诗朗读',
        })
        expect(fromBuffer).toEqual({ text: '床前明月光', durationSec: 5.5, confidence: 0 })

        await client.asr({ model: 'mimo-v2.5-asr', audio: `data:audio/mp3;base64,${mp3Base64}` })
        await client.asr({ model: 'mimo-v2.5-asr', audio: mp3Base64 })
        await expect(client.asr({
            model: 'mimo-v2.5-asr', audio: 'https://audio.test/sample.mp3',
        })).rejects.toThrow('ASR 音频 URL 已禁用')
        await expect(client.asr({
            model: 'mimo-v2.5-asr', audio: 'not-valid-base64%',
        })).rejects.toThrow('ASR 音频必须是有效的 base64')
        await expect(client.asr({
            model: 'mimo-v2.5-asr', audio: Buffer.alloc(0),
        })).rejects.toThrow('ASR 音频大小必须为')
        await expect(client.asr({
            model: 'mimo-v2.5-asr', audio: Buffer.alloc(10 * 1024 * 1024 + 1),
        })).rejects.toThrow('ASR 音频大小必须为')
        expect(sdk.toFile).toHaveBeenCalledTimes(3)
        expect(sdk.toFile).toHaveBeenNthCalledWith(1, mp3, 'audio.mp3', { type: 'audio/mpeg' })
    })

    it('ASR 以魔数生成匹配的 MP3/WAV/WebM/OGG 文件名与 MIME', async () => {
        sdk.transcriptionCreate.mockResolvedValue({ text: 'ok', duration: '1' })
        const client = new MiMoClient('key', 'https://mimo.test/v1')
        const samples = [
            {
                bytes: Buffer.from('ID30000', 'ascii'), filename: 'recording.mp3',
                mime: 'audio/mp3', safeName: 'audio.mp3', safeMime: 'audio/mpeg',
            },
            {
                bytes: Buffer.from('RIFF0000WAVEfmt ', 'ascii'), filename: 'recording.wav',
                mime: 'audio/x-wav', safeName: 'audio.wav', safeMime: 'audio/wav',
            },
            {
                bytes: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]), filename: 'recording.webm',
                mime: 'audio/webm; codecs=opus', safeName: 'audio.webm', safeMime: 'audio/webm',
            },
            {
                bytes: Buffer.from('OggS0000', 'ascii'), filename: 'recording.ogg',
                mime: 'audio/ogg', safeName: 'audio.ogg', safeMime: 'audio/ogg',
            },
        ] as const

        for (const sample of samples) {
            await client.asr({
                model: 'mimo-v2.5-asr',
                audio: sample.bytes,
                audioFilename: sample.filename,
                audioMimeType: sample.mime,
            })
        }

        expect(sdk.toFile).toHaveBeenCalledTimes(samples.length)
        samples.forEach((sample, index) => {
            expect(sdk.toFile).toHaveBeenNthCalledWith(
                index + 1, sample.bytes, sample.safeName, { type: sample.safeMime },
            )
        })
    })

    it('ASR 对 MIME/扩展名冲突与未知魔数失败关闭，且不触达供应商', async () => {
        const client = new MiMoClient('key', 'https://mimo.test/v1')
        const wav = Buffer.from('RIFF0000WAVEfmt ', 'ascii')

        await expect(client.asr({
            model: 'mimo-v2.5-asr', audio: wav, audioMimeType: 'audio/mpeg',
        })).rejects.toThrow('声明类型与真实音频格式不一致')
        await expect(client.asr({
            model: 'mimo-v2.5-asr', audio: wav, audioFilename: 'recording.mp3',
        })).rejects.toThrow('扩展名与真实音频格式不一致')
        await expect(client.asr({
            model: 'mimo-v2.5-asr',
            audio: `data:audio/mpeg;base64,${wav.toString('base64')}`,
        })).rejects.toThrow('声明类型与真实音频格式不一致')
        await expect(client.asr({
            model: 'mimo-v2.5-asr', audio: Buffer.from('not-audio'),
        })).rejects.toThrow('不是可识别')
        await expect(client.asr({
            model: 'mimo-v2.5-asr', audio: wav, audioFilename: '../recording.wav',
        })).rejects.toThrow('不得包含路径')

        expect(sdk.toFile).not.toHaveBeenCalled()
        expect(sdk.transcriptionCreate).not.toHaveBeenCalled()
    })
})
