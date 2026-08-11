import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    config: {
        demoMode: true,
        deepseek: { apiKey: 'test-key' },
    },
    deepseekStream: vi.fn(),
}))

vi.mock('../config.js', () => ({ config: mocks.config }))
vi.mock('../llm/index.js', () => ({
    managedLLM: {
        stream: mocks.deepseekStream,
        chat: vi.fn(),
    },
}))
vi.mock('../db/index.js', () => ({ db: {}, repos: {} }))
vi.mock('../agents/base/evolution-engine.js', () => ({ evolutionEngine: {} }))

import {
    evolutionPredictionResultSchema,
    evolutionRoutes,
} from './evolution.js'

type TestApp = Awaited<ReturnType<typeof Fastify>>

function parseSseData(payload: string): string[] {
    return payload
        .split(/\r?\n\r?\n/)
        .map((frame) => frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n'))
        .filter((data) => data.length > 0)
}

function jsonFrames(payload: string): Array<Record<string, unknown>> {
    return parseSseData(payload)
        .filter((data) => data !== '[DONE]')
        .map((data) => JSON.parse(data) as Record<string, unknown>)
}

function successfulModelStream() {
    return (async function* () {
        yield { reasoning: '先核对高频模式，再评估版本质量。' }
        yield { content: '{"predictions":[{"direction":"强化证据约束",' }
        yield { content: '"suggestion":"为高频错误模式增加出处核验与教师复核门。",' }
        yield { content: '"expectedImprovement":0.18,"confidence":0.84}],' }
        yield { content: '"confidence":0.82}' }
        yield { done: true, usage: { promptTokens: 20, completionTokens: 30 } }
    })()
}

describe('POST /api/evolution/predict SSE contract', () => {
    let app: TestApp | undefined

    beforeEach(() => {
        mocks.config.demoMode = true
        mocks.config.deepseek.apiKey = 'test-key'
        mocks.deepseekStream.mockReset()
    })

    afterEach(async () => {
        if (app) await app.close()
        app = undefined
    })

    async function createApp(): Promise<TestApp> {
        app = Fastify({ logger: false })
        await app.register(evolutionRoutes, { prefix: '/api/evolution' })
        return app
    }

    it('ends the demo path with exactly one validated done(result) followed by [DONE]', async () => {
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/evolution/predict',
            payload: {
                historicalPatterns: [
                    { pattern: '增加出处核验' },
                    { pattern: '增加出处核验' },
                ],
                currentVersions: [{ version: 'mind-v3', isActive: true, quality: 0.86 }],
                horizon: 7,
            },
        })

        expect(response.statusCode).toBe(200)
        expect(response.headers['content-type']).toContain('text/event-stream')
        const data = parseSseData(response.body)
        const frames = jsonFrames(response.body)
        const doneFrames = frames.filter((frame) => frame.type === 'done')

        expect(data.at(-1)).toBe('[DONE]')
        expect(doneFrames).toHaveLength(1)
        expect(frames.some((frame) => Object.hasOwn(frame, 'predictions') && !Object.hasOwn(frame, 'type'))).toBe(false)
        const result = doneFrames[0]?.result
        expect(evolutionPredictionResultSchema.safeParse(result).success).toBe(true)
        expect(result).toMatchObject({ aiGenerated: false })
        expect((result as { predictions: Array<Record<string, unknown>> }).predictions).not.toHaveLength(0)
        expect((result as { predictions: Array<Record<string, unknown>> }).predictions.every((prediction) => (
            typeof prediction.expectedImprovement === 'number'
            && Number.isFinite(prediction.expectedImprovement)
        ))).toBe(true)
        expect(mocks.deepseekStream).not.toHaveBeenCalled()
    })

    it('accumulates split model JSON and emits a validated AI result before [DONE]', async () => {
        mocks.config.demoMode = false
        mocks.deepseekStream.mockReturnValue(successfulModelStream())
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/evolution/predict',
            payload: {
                historicalPatterns: [{ pattern: '证据约束不足', source: 'teacher-feedback' }],
                currentVersions: [{ version: 'mind-v3', agentId: 'mind', isActive: true }],
                horizon: 7,
            },
        })

        expect(response.statusCode).toBe(200)
        const data = parseSseData(response.body)
        const frames = jsonFrames(response.body)
        const doneFrames = frames.filter((frame) => frame.type === 'done')
        const tokenFrames = frames.filter((frame) => frame.type === 'token')

        expect(data.at(-1)).toBe('[DONE]')
        expect(doneFrames).toHaveLength(1)
        expect(tokenFrames).toEqual([
            { type: 'token', token: '正在分析历史模式与版本质量。' },
        ])
        expect(response.body).not.toContain('先核对高频模式')
        expect(doneFrames[0]?.result).toEqual({
            predictions: [{
                direction: '强化证据约束',
                suggestion: '为高频错误模式增加出处核验与教师复核门。',
                expectedImprovement: 0.18,
                confidence: 0.84,
            }],
            confidence: 0.82,
            aiGenerated: true,
            generatedAt: expect.any(Number),
        })
        expect(mocks.deepseekStream).toHaveBeenCalledWith(expect.objectContaining({
            model: 'deepseek-v4-pro',
            thinking: 'high',
            jsonOutput: true,
            signal: expect.any(AbortSignal),
        }))
    })

    it('uses a non-empty validated local result when model JSON is malformed', async () => {
        mocks.config.demoMode = false
        mocks.deepseekStream.mockReturnValue((async function* () {
            yield { content: '{"predictions":[{"direction":"缺字段","suggestion":"没有 expectedImprovement","confidence":0.8}],"confidence":0.8}' }
        })())
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/evolution/predict',
            payload: {
                historicalPatterns: [{ pattern: '增加事实核验' }],
                currentVersions: [],
                horizon: 7,
            },
        })

        const data = parseSseData(response.body)
        const frames = jsonFrames(response.body)
        const doneFrames = frames.filter((frame) => frame.type === 'done')
        const result = doneFrames[0]?.result

        expect(data.at(-1)).toBe('[DONE]')
        expect(doneFrames).toHaveLength(1)
        expect(evolutionPredictionResultSchema.safeParse(result).success).toBe(true)
        expect(result).toMatchObject({ aiGenerated: false })
        expect((result as { predictions: unknown[] }).predictions.length).toBeGreaterThan(0)
        expect(response.body).not.toContain('没有 expectedImprovement')
        expect(frames).toContainEqual({
            type: 'token',
            token: '模型预测暂时不可用，已切换为本地统计预测。',
        })
    })

    it('never leaks a provider error and safely completes with local fallback', async () => {
        mocks.config.demoMode = false
        mocks.deepseekStream.mockReturnValue((async function* () {
            throw new Error('provider-secret-key=do-not-expose')
        })())
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/evolution/predict',
            payload: {
                historicalPatterns: [{ pattern: '降低幻觉' }],
                currentVersions: [{ version: 'eye-v2', isActive: true }],
            },
        })

        const data = parseSseData(response.body)
        const done = jsonFrames(response.body).find((frame) => frame.type === 'done')
        expect(response.body).not.toContain('provider-secret-key')
        expect(data.at(-1)).toBe('[DONE]')
        expect(done?.result).toMatchObject({ aiGenerated: false })
        expect(evolutionPredictionResultSchema.safeParse(done?.result).success).toBe(true)
    })
})
