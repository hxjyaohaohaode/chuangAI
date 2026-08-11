import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    config: {
        demoMode: true,
        wanImage: {
            model: 'wan2.7-image',
            baseUrl: 'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
            enabled: true,
        },
    },
    getKey: vi.fn(() => 'dashscope-test-key'),
    getOrCreateImage: vi.fn(),
    asr: vi.fn(),
    tts: vi.fn(),
    chat: vi.fn(),
    stream: vi.fn(),
}))

vi.mock('../config.js', () => ({ config: mocks.config }))
vi.mock('../lib/credentials.js', () => ({ getKey: mocks.getKey }))
vi.mock('../services/culture/image-cache.js', () => ({
    getOrCreateImage: mocks.getOrCreateImage,
}))
vi.mock('../llm/index.js', () => ({
    managedLLM: {
        asr: mocks.asr,
        tts: mocks.tts,
        chat: mocks.chat,
        stream: mocks.stream,
    },
}))

import {
    aiRoutes,
    calculateTextSimilarity,
    generateSilentWav,
    getWanConfigComplianceIssue,
} from './ai.js'

type MultipartPart =
    | { type: 'field'; name: string; value: string }
    | { type: 'file'; name?: string; filename?: string; contentType?: string; data: Buffer }

function makeWav(): Buffer {
    const buffer = Buffer.alloc(44)
    buffer.write('RIFF', 0, 'ascii')
    buffer.write('WAVE', 8, 'ascii')
    return buffer
}

function buildMultipart(parts: MultipartPart[]): { payload: Buffer; contentType: string } {
    const boundary = `----ai-contract-${Math.random().toString(16).slice(2)}`
    const chunks: Buffer[] = []
    for (const part of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'))
        if (part.type === 'field') {
            chunks.push(Buffer.from(
                `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
                'utf8',
            ))
        } else {
            chunks.push(Buffer.from(
                `Content-Disposition: form-data; name="${part.name ?? 'file'}"; filename="${part.filename ?? 'audio.wav'}"\r\n`
                + `Content-Type: ${part.contentType ?? 'audio/wav'}\r\n\r\n`,
                'utf8',
            ))
            chunks.push(part.data, Buffer.from('\r\n', 'utf8'))
        }
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
    return {
        payload: Buffer.concat(chunks),
        contentType: `multipart/form-data; boundary=${boundary}`,
    }
}

async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false })
    await app.register(multipart)
    await app.register(aiRoutes, { prefix: '/api/ai' })
    await app.ready()
    return app
}

beforeEach(() => {
    mocks.config.demoMode = true
    mocks.config.wanImage.model = 'wan2.7-image'
    mocks.config.wanImage.baseUrl = 'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
    mocks.config.wanImage.enabled = true
    mocks.getKey.mockReset()
    mocks.getKey.mockReturnValue('dashscope-test-key')
    mocks.getOrCreateImage.mockReset()
    mocks.getOrCreateImage.mockResolvedValue({
        url: '/uploads/generated/real.webp',
        cached: false,
        model: 'wan2.7-image',
        requestId: 'wan-request-1',
    })
    mocks.asr.mockReset()
    mocks.asr.mockResolvedValue({
        text: '床前明月',
        durationSec: 2.4,
        confidence: 0.82,
    })
    mocks.tts.mockReset()
    mocks.tts.mockResolvedValue({
        audio: Buffer.from('managed-audio'),
        format: 'mp3',
        durationMs: 1_250,
    })
    mocks.chat.mockReset()
    mocks.chat.mockResolvedValue({
        content: '托管模型回答',
        reasoning: '供应商私有推理，禁止出 API 边界',
        usage: { promptTokens: 11, completionTokens: 7 },
        latencyMs: 42,
        model: 'deepseek-v4-pro',
    })
    mocks.stream.mockReset()
})

describe('generateSilentWav', () => {
    it('returns a structurally valid PCM WAV instead of an empty disguised MP3', () => {
        const { buffer, durationMs } = generateSilentWav(8)

        expect(durationMs).toBe(2000)
        expect(buffer.length).toBe(44 + 2 * 16000 * 2)
        expect(buffer.toString('ascii', 0, 4)).toBe('RIFF')
        expect(buffer.toString('ascii', 8, 12)).toBe('WAVE')
        expect(buffer.toString('ascii', 12, 16)).toBe('fmt ')
        expect(buffer.readUInt16LE(20)).toBe(1)
        expect(buffer.readUInt32LE(24)).toBe(16000)
        expect(buffer.toString('ascii', 36, 40)).toBe('data')
        expect(buffer.readUInt32LE(40)).toBe(buffer.length - 44)
    })

    it('bounds malformed or excessive lengths to a safe allocation range', () => {
        expect(generateSilentWav(Number.NaN).durationMs).toBe(1000)
        const oversized = generateSilentWav(Number.MAX_SAFE_INTEGER)
        expect(oversized.durationMs).toBe(30_000)
        expect(oversized.buffer.length).toBe(960_044)
    })
})

describe('Wan2.7 official configuration boundary', () => {
    it('accepts only the documented Workspace MaaS Beijing endpoint and exact model', () => {
        expect(getWanConfigComplianceIssue(
            'wan2.7-image',
            'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        )).toBeNull()
        expect(getWanConfigComplianceIssue(
            'wan2.7-image-pro',
            'https://workspace-123.cn-beijing.maas.aliyuncs.com',
        )).toMatch(/模型必须/)
        expect(getWanConfigComplianceIssue(
            'wan2.7-image',
            'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        )).toMatch(/WorkspaceId/)
        expect(getWanConfigComplianceIssue(
            'wan2.7-image',
            'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/image-generation/generation',
        )).toMatch(/端点路径/)
    })

    it('returns an honest local demo image without claiming Wan generated it', async () => {
        const app = await buildApp()
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/ai/image-generate',
                payload: { prompt: '月夜水墨画', orientation: 'landscape', n: 1 },
            })
            const body = response.json()

            expect(response.statusCode).toBe(200)
            expect(body).toMatchObject({
                status: 'degraded',
                model: 'local-placeholder',
                requestedModel: 'wan2.7-image',
                aiGenerated: false,
                demo: true,
                degraded: true,
                degradationReason: 'demo-mode',
            })
            expect(body.images[0]).toMatchObject({
                model: 'local-placeholder',
                requestedModel: 'wan2.7-image',
                aiGenerated: false,
                demo: true,
                degraded: true,
            })
            const svg = Buffer.from(body.images[0].url.split(',')[1], 'base64').toString('utf8')
            expect(svg).toContain('本地演示占位图')
            expect(svg).toContain('未调用 wan2.7-image')
            expect(mocks.getOrCreateImage).not.toHaveBeenCalled()
        } finally {
            await app.close()
        }
    })

    it('fails closed on the legacy global DashScope endpoint', async () => {
        mocks.config.demoMode = false
        mocks.config.wanImage.baseUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
        const app = await buildApp()
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/ai/image-generate',
                payload: { prompt: '月夜水墨画', n: 1 },
            })
            expect(response.json()).toMatchObject({
                status: 'degraded',
                degradationReason: 'provider-noncompliant',
                aiGenerated: false,
                demo: false,
            })
            expect(mocks.getOrCreateImage).not.toHaveBeenCalled()
        } finally {
            await app.close()
        }
    })

    it('marks a missing Workspace endpoint or API key as unavailable without calling the provider', async () => {
        mocks.config.demoMode = false
        mocks.config.wanImage.baseUrl = ''
        mocks.getKey.mockReturnValue('')
        const app = await buildApp()
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/ai/image-generate',
                payload: { prompt: '月夜水墨画', n: 1 },
            })
            expect(response.json()).toMatchObject({
                status: 'degraded',
                degradationReason: 'provider-unavailable',
                aiGenerated: false,
                demo: false,
            })
            expect(mocks.getOrCreateImage).not.toHaveBeenCalled()
        } finally {
            await app.close()
        }
    })

    it('never labels a local SVG or unprotected provider URL as a real Wan result', async () => {
        mocks.config.demoMode = false
        mocks.getOrCreateImage.mockResolvedValue({
            url: 'data:image/svg+xml;base64,PHN2Zy8+',
            cached: false,
            model: 'wan2.7-image',
            requestId: 'forged-result',
        })
        const app = await buildApp()
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/ai/image-generate',
                payload: { prompt: '月夜水墨画', n: 1 },
            })
            expect(response.json()).toMatchObject({
                status: 'degraded',
                model: 'local-placeholder',
                degradationReason: 'provider-noncompliant',
                aiGenerated: false,
            })
        } finally {
            await app.close()
        }
    })

    it('returns the canonical image array on a real compliant call', async () => {
        mocks.config.demoMode = false
        const app = await buildApp()
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/ai/image-generate',
                payload: {
                    prompt: '月夜水墨画',
                    verse: '床前明月光',
                    orientation: 'portrait',
                    n: 1,
                },
            })
            const body = response.json()

            expect(response.statusCode).toBe(200)
            expect(body).toMatchObject({
                status: 'ok',
                model: 'wan2.7-image',
                requestedModel: 'wan2.7-image',
                requestId: 'wan-request-1',
                aiGenerated: true,
                demo: false,
                degraded: false,
            })
            expect(body.images).toHaveLength(1)
            expect(body.images[0]).toMatchObject({
                url: '/uploads/generated/real.webp',
                verse: '床前明月光',
                orientation: 'portrait',
                cached: false,
            })
        } finally {
            await app.close()
        }
    })
})

describe('MiMo ASR route contract', () => {
    it('never copies referenceText or awards a fake score in demo mode', async () => {
        const app = await buildApp()
        const multipartBody = buildMultipart([
            { type: 'field', name: 'referenceText', value: '床前明月光' },
            { type: 'file', data: makeWav() },
        ])
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/ai/asr',
                headers: { 'content-type': multipartBody.contentType },
                payload: multipartBody.payload,
            })
            const body = response.json()

            expect(response.statusCode).toBe(200)
            expect(body).toEqual({
                status: 'degraded',
                transcript: '',
                audioDurationSec: 0,
                model: 'local-placeholder',
                requestedModel: 'mimo-v2.5-asr',
                aiGenerated: false,
                demo: true,
                degraded: true,
                degradationReason: 'demo-mode',
            })
            expect(mocks.asr).not.toHaveBeenCalled()
        } finally {
            await app.close()
        }
    })

    it('maps real provider fields and computes similarity from the actual transcript', async () => {
        mocks.config.demoMode = false
        const app = await buildApp()
        const multipartBody = buildMultipart([
            { type: 'field', name: 'poemId', value: 'poem-1' },
            { type: 'field', name: 'referenceText', value: '床前明月光' },
            { type: 'field', name: 'language', value: 'zh' },
            { type: 'field', name: 'prompt', value: '唐诗朗读' },
            { type: 'file', data: makeWav() },
        ])
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/ai/asr',
                headers: { 'content-type': multipartBody.contentType },
                payload: multipartBody.payload,
            })
            const body = response.json()

            expect(response.statusCode).toBe(200)
            expect(body).toMatchObject({
                status: 'ok',
                transcript: '床前明月',
                audioDurationSec: 2.4,
                confidence: 0.82,
                similarityScore: 80,
                model: 'mimo-v2.5-asr',
                requestedModel: 'mimo-v2.5-asr',
                aiGenerated: true,
                demo: false,
                degraded: false,
            })
            expect(mocks.asr).toHaveBeenCalledWith(expect.objectContaining({
                model: 'mimo-v2.5-asr',
                audioFilename: 'audio.wav',
                audioMimeType: 'audio/wav',
                language: 'zh',
                prompt: '唐诗朗读',
            }))
        } finally {
            await app.close()
        }
    })

    it('rejects unknown multipart fields instead of silently ignoring drift', async () => {
        const app = await buildApp()
        const multipartBody = buildMultipart([
            { type: 'field', name: 'reference', value: '旧字段' },
            { type: 'file', data: makeWav() },
        ])
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/ai/asr',
                headers: { 'content-type': multipartBody.contentType },
                payload: multipartBody.payload,
            })
            expect(response.statusCode).toBe(400)
            expect(response.json()).toMatchObject({
                status: 'error',
                error: 'VALIDATION_ERROR',
            })
        } finally {
            await app.close()
        }
    })
})

describe('managed AI provider boundary', () => {
    it('routes TTS through managedLLM while preserving the canonical binary contract', async () => {
        mocks.config.demoMode = false
        const app = await buildApp()
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/ai/tts',
                payload: {
                    text: '床前明月光',
                    voice: 'default',
                    speed: 1.1,
                    responseFormat: 'mp3',
                },
            })

            expect(response.statusCode).toBe(200)
            expect(response.headers['content-type']).toContain('audio/mp3')
            expect(response.headers['x-model']).toBe('mimo-v2.5-tts')
            expect(response.headers['x-duration-ms']).toBe('1250')
            expect(response.rawPayload).toEqual(Buffer.from('managed-audio'))
            expect(mocks.tts).toHaveBeenCalledWith({
                model: 'mimo-v2.5-tts',
                text: '床前明月光',
                voice: 'default',
                speed: 1.1,
                responseFormat: 'mp3',
                metadata: { agent: 'ai-routes', task: 'tts' },
            })
        } finally {
            await app.close()
        }
    })

    it('preserves explicit DeepSeek/MiMo models and thinking levels without exposing private reasoning', async () => {
        mocks.config.demoMode = false
        const app = await buildApp()
        try {
            const deepseekResponse = await app.inject({
                method: 'POST',
                url: '/api/ai/chat',
                payload: {
                    messages: [{ role: 'user', content: '深度分析' }],
                    model: 'deepseek-v4-pro',
                    thinking: 'max',
                    temperature: 0.2,
                    maxTokens: 4096,
                    stream: false,
                },
            })
            const mimoResponse = await app.inject({
                method: 'POST',
                url: '/api/ai/chat',
                payload: {
                    messages: [{ role: 'user', content: '多模态之外的文本回答' }],
                    model: 'mimo-v2.5-pro',
                    thinking: 'high',
                    stream: false,
                },
            })

            expect(deepseekResponse.statusCode).toBe(200)
            expect(deepseekResponse.json()).toEqual({
                content: '托管模型回答',
                model: 'deepseek-v4-pro',
                latencyMs: 42,
                usage: { promptTokens: 11, completionTokens: 7 },
                demo: false,
            })
            expect(deepseekResponse.body).not.toContain('供应商私有推理')
            expect(mimoResponse.statusCode).toBe(200)
            expect(mimoResponse.json()).toMatchObject({ model: 'mimo-v2.5-pro', demo: false })
            expect(mocks.chat).toHaveBeenNthCalledWith(1, expect.objectContaining({
                model: 'deepseek-v4-pro',
                thinking: 'max',
                temperature: 0.2,
                maxTokens: 4096,
                metadata: { agent: 'ai-routes', task: 'chat' },
            }))
            expect(mocks.chat).toHaveBeenNthCalledWith(2, expect.objectContaining({
                model: 'mimo-v2.5-pro',
                thinking: 'high',
            }))
        } finally {
            await app.close()
        }
    })

    it('streams via managedLLM with one public terminal and no provider reasoning', async () => {
        mocks.config.demoMode = false
        mocks.stream.mockReturnValue((async function* () {
            yield { reasoning: '不得进入 SSE 的供应商推理' }
            yield { content: '公开正文' }
            yield {
                done: true,
                usage: { promptTokens: 5, completionTokens: 3, cachedTokens: 1 },
            }
        })())
        const app = await buildApp()
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/ai/chat',
                payload: {
                    messages: [{ role: 'user', content: '流式回答' }],
                    model: 'mimo-v2.5',
                    thinking: 'high',
                    stream: true,
                },
            })

            expect(response.statusCode).toBe(200)
            expect(response.headers['content-type']).toContain('text/event-stream')
            expect(response.body).toContain('公开正文')
            expect(response.body).not.toContain('不得进入 SSE')
            expect(response.body.match(/data: \[DONE\]/gu)).toHaveLength(1)
            expect(mocks.stream).toHaveBeenCalledWith(expect.objectContaining({
                model: 'mimo-v2.5',
                thinking: 'high',
                signal: expect.any(AbortSignal),
                metadata: { agent: 'ai-routes', task: 'chat-stream' },
            }))
        } finally {
            await app.close()
        }
    })
})

describe('calculateTextSimilarity', () => {
    it('normalizes punctuation while preserving real omissions', () => {
        expect(calculateTextSimilarity('床前明月光。', '床前明月光')).toBe(100)
        expect(calculateTextSimilarity('床前明月', '床前明月光')).toBe(80)
        expect(calculateTextSimilarity('', '床前明月光')).toBe(0)
    })
})
