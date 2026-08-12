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
            thinking: { type: 'enabled' },
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

    it('uses the official Flash max effort and detects exhausted output budgets', async () => {
        const client = new DeepSeekClient('key', 'https://deepseek.test/v1')
        sdk.chatCreate.mockResolvedValueOnce({
            choices: [{ finish_reason: 'stop', message: { content: '完成', tool_calls: [] } }],
            usage: null,
        })
        await client.chat({
            model: 'deepseek-v4-flash', thinking: 'max', messages: [{ role: 'user', content: '分析' }],
        })
        expect(sdk.chatCreate.mock.calls[0]?.[0]).toMatchObject({ reasoning_effort: 'max' })

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
        const body = sdk.chatCreate.mock.calls[0]?.[0] as {
            messages: Array<{ content: unknown }>
            tools: unknown[]
            max_completion_tokens: number
            thinking: { type: string }
            temperature?: number
        }
        expect(body.messages[0]?.content).toEqual([
            { type: 'text', text: '识别图片' },
            { type: 'image_url', image_url: { url: pngDataUrl, detail: 'high' } },
        ])
        expect(body.tools).toHaveLength(1)
        expect(body.max_completion_tokens).toBe(2048)
        expect(body.thinking).toEqual({ type: 'enabled' })
        expect(body).not.toHaveProperty('max_tokens')
        expect(body).not.toHaveProperty('reasoning_effort')
        expect(body).not.toHaveProperty('temperature')

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

    it('uses the official chat-completions contracts for TTS and ASR', async () => {
        const wav = Uint8Array.from([
            0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
            0x57, 0x41, 0x56, 0x45,
        ])
        sdk.chatCreate
            .mockResolvedValueOnce({
                choices: [{ message: { content: '', audio: { data: Buffer.from(wav).toString('base64') } } }],
                usage: { prompt_tokens: 10, completion_tokens: 20 },
            })
            .mockResolvedValue({
                choices: [{ message: { content: '床前明月光' } }],
                usage: { prompt_tokens: 30, completion_tokens: 6, seconds: 5.5 },
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
        expect(fromBuffer).toEqual({ text: '床前明月光', durationSec: 5.5 })

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
            model: 'mimo-v2.5-asr', audio: Buffer.alloc(Math.floor(10 * 1024 * 1024 * 3 / 4) + 1),
        })).rejects.toThrow('ASR 音频大小必须为')

        const ttsBody = sdk.chatCreate.mock.calls[0]?.[0]
        expect(ttsBody).toEqual({
            model: 'mimo-v2.5-tts',
            messages: [
                { role: 'user', content: '请以约 1.10 倍语速，清晰、自然地朗读下一条 assistant 消息。' },
                { role: 'assistant', content: '床前明月光' },
            ],
            audio: { format: 'wav', voice: 'mimo_default' },
        })
        const asrBody = sdk.chatCreate.mock.calls[1]?.[0]
        expect(asrBody).toEqual({
            model: 'mimo-v2.5-asr',
            messages: [{
                role: 'user',
                content: [{
                    type: 'input_audio',
                    input_audio: { data: `data:audio/mpeg;base64,${mp3Base64}` },
                }],
            }],
            asr_options: { language: 'zh' },
        })
        expect(asrBody).not.toHaveProperty('prompt')
        expect(sdk.speechCreate).not.toHaveBeenCalled()
        expect(sdk.transcriptionCreate).not.toHaveBeenCalled()
        expect(sdk.toFile).not.toHaveBeenCalled()
    })

    it('ASR 只接受官方支持的 MP3/WAV，并拒绝 WebM/OGG', async () => {
        sdk.chatCreate.mockResolvedValue({
            choices: [{ message: { content: 'ok' } }],
            usage: { seconds: 1 },
        })
        const client = new MiMoClient('key', 'https://mimo.test/v1')
        const accepted = [
            {
                bytes: Buffer.from('ID30000', 'ascii'), filename: 'recording.mp3',
                mime: 'audio/mp3', canonicalMime: 'audio/mpeg',
            },
            {
                bytes: Buffer.from('RIFF0000WAVEfmt ', 'ascii'), filename: 'recording.wav',
                mime: 'audio/x-wav', canonicalMime: 'audio/wav',
            },
        ] as const

        for (const sample of accepted) {
            await client.asr({
                model: 'mimo-v2.5-asr',
                audio: sample.bytes,
                audioFilename: sample.filename,
                audioMimeType: sample.mime,
            })
        }
        accepted.forEach((sample, index) => {
            const body = sdk.chatCreate.mock.calls[index]?.[0] as {
                messages: Array<{ content: Array<{ input_audio: { data: string } }> }>
            }
            expect(body.messages[0]?.content[0]?.input_audio.data).toBe(
                `data:${sample.canonicalMime};base64,${sample.bytes.toString('base64')}`,
            )
        })

        await expect(client.asr({
            model: 'mimo-v2.5-asr',
            audio: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]),
            audioFilename: 'recording.webm',
            audioMimeType: 'audio/webm; codecs=opus',
        })).rejects.toThrow('仅接受 MP3 或 WAV')
        await expect(client.asr({
            model: 'mimo-v2.5-asr',
            audio: Buffer.from('OggS0000', 'ascii'),
            audioFilename: 'recording.ogg',
            audioMimeType: 'audio/ogg',
        })).rejects.toThrow('仅接受 MP3 或 WAV')
        expect(sdk.chatCreate).toHaveBeenCalledTimes(2)
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

        expect(sdk.chatCreate).not.toHaveBeenCalled()
        expect(sdk.toFile).not.toHaveBeenCalled()
        expect(sdk.transcriptionCreate).not.toHaveBeenCalled()
    })

    it('TTS 对缺失、非法或伪造 base64 音频响应失败关闭', async () => {
        const client = new MiMoClient('key', 'https://mimo.test/v1')
        sdk.chatCreate.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] })
        await expect(client.tts({ model: 'mimo-v2.5-tts', text: '朗读' }))
            .rejects.toThrow('缺少 choices[0].message.audio.data')

        sdk.chatCreate.mockResolvedValueOnce({
            choices: [{ message: { audio: { data: 'not-base64%' } } }],
        })
        await expect(client.tts({ model: 'mimo-v2.5-tts', text: '朗读' }))
            .rejects.toThrow('不是合法且受限的 base64')

        sdk.chatCreate.mockResolvedValueOnce({
            choices: [{ message: { audio: { data: Buffer.from('not-mp3').toString('base64') } } }],
        })
        await expect(client.tts({ model: 'mimo-v2.5-tts', text: '朗读' }))
            .rejects.toThrow('魔数与请求格式 mp3 不一致')
    })
})
