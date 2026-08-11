import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuestionEntity } from '../db/types.js'
import type { Orchestrator } from '../orchestrator/Orchestrator.js'
import type { SessionStore } from '../orchestrator/session-store.js'
import type { WSBroadcaster } from '../orchestrator/websocket/broadcaster.js'

const mocks = vi.hoisted(() => ({
    findPoemById: vi.fn(),
    findAllPoems: vi.fn(),
    findQuestionById: vi.fn(),
    findAllQuestions: vi.fn(),
    createQuestion: vi.fn(),
    questionInvoke: vi.fn(),
    verifyInvoke: vi.fn(),
    aggregateSession: vi.fn(),
}))

vi.mock('../db/index.js', () => ({
    repos: {
        poems: {
            findById: mocks.findPoemById,
            findAll: mocks.findAllPoems,
        },
        questions: {
            findById: mocks.findQuestionById,
            findAll: mocks.findAllQuestions,
            create: mocks.createQuestion,
        },
        answers: { findByQuestionId: vi.fn(() => []) },
        lessons: { create: vi.fn() },
    },
}))

vi.mock('../agents/index.js', () => ({
    agents: {
        brush: { question: { invoke: mocks.questionInvoke } },
        mind: { verify: { invoke: mocks.verifyInvoke } },
    },
}))

vi.mock('../llm/index.js', () => ({
    billing: { aggregateSession: mocks.aggregateSession },
}))

import { workbenchRoutes } from './workbench.js'

const VALID_WEIGHTS = {
    记忆: 20,
    理解: 20,
    应用: 20,
    分析: 20,
    评价: 10,
    创造: 10,
}

function validQuestion(): QuestionEntity {
    return {
        id: 'question-001',
        poemId: 'poem-jingyesi',
        bloomLevel: '理解',
        type: '简答',
        stem: '诗中哪些词表现了思乡之情？',
        options: null,
        answer: '低头、思故乡。',
        analysis: '动作描写表现思乡。',
        distractorsAnalysis: null,
        difficulty: 2,
        estimatedTimeSec: 60,
        aiGenerated: true,
        promptVersion: 'test',
        createdAt: 1,
        createdBy: 'teacher-001',
        metadata: {},
    }
}

function generatePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        poemId: 'poem-jingyesi',
        gradeLevel: '3-4年级',
        questionTypes: ['选择', '简答'],
        bloomWeights: VALID_WEIGHTS,
        count: 2,
        teacherId: 'teacher-001',
        ...overrides,
    }
}

describe('workbench request/output boundaries', () => {
    let app: FastifyInstance | undefined
    const sessionStore = {
        createSession: vi.fn(() => ({ id: 'session-boundary-001' })),
        setStatus: vi.fn(),
        updateTaskState: vi.fn(),
    }
    const broadcaster = { broadcast: vi.fn() }

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.findPoemById.mockReturnValue(null)
        mocks.findAllPoems.mockReturnValue([])
        mocks.findQuestionById.mockReturnValue(null)
        mocks.findAllQuestions.mockReturnValue([])
        mocks.createQuestion.mockImplementation((input: QuestionEntity) => input)
        mocks.questionInvoke.mockResolvedValue({
            output: {
                questions: [{
                    id: 'question-generated-001',
                    poemId: 'poem-jingyesi',
                    bloomLevel: '理解',
                    type: '简答',
                    stem: '这首诗表达了什么感情？',
                    answer: '思乡之情。',
                    analysis: '由“低头思故乡”可知。',
                    difficulty: 2,
                    estimatedTimeSec: 60,
                    aiGenerated: true,
                }],
                coverage: VALID_WEIGHTS,
            },
        })
        mocks.verifyInvoke.mockResolvedValue({
            output: {
                targetAgentId: 'brush.question',
                verdict: 'pass',
                score: 100,
                strengths: ['契约完整'],
                issues: [],
                aiGenerated: true,
                confidence: 1,
            },
        })
        mocks.aggregateSession.mockReturnValue({
            totalCostYuan: 0,
            tokenUsage: { promptTokens: 0, completionTokens: 0 },
        })
    })

    afterEach(async () => {
        if (app) await app.close()
        app = undefined
    })

    async function createApp(): Promise<FastifyInstance> {
        app = Fastify({ logger: false })
        await app.register(workbenchRoutes, {
            prefix: '/api/workbench',
            orchestrator: {} as Orchestrator,
            sessionStore: sessionStore as unknown as SessionStore,
            broadcaster: broadcaster as unknown as WSBroadcaster,
        })
        return app
    }

    it('deduplicates bounded question types and excluded IDs before invoking the agent', async () => {
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/workbench/generate',
            payload: generatePayload({
                questionTypes: ['选择', '选择', '简答'],
                excludeUsedQuestions: ['used-001', 'used-001', 'used-002'],
            }),
        })

        expect(response.statusCode).toBe(200)
        await vi.waitFor(() => expect(mocks.questionInvoke).toHaveBeenCalledTimes(1))
        expect(mocks.questionInvoke.mock.calls[0]?.[0]).toMatchObject({
            questionTypes: ['选择', '简答'],
            excludeUsedQuestions: ['used-001', 'used-002'],
            bloomWeights: VALID_WEIGHTS,
        })
        await vi.waitFor(() => expect(mocks.aggregateSession).toHaveBeenCalled())
    })

    it('rejects non-finite/out-of-range/non-100/extra Bloom weights before side effects', async () => {
        const server = await createApp()
        const invalidWeights = [
            { ...VALID_WEIGHTS, 记忆: -1, 理解: 41 },
            { ...VALID_WEIGHTS, 记忆: 101, 理解: -61 },
            { ...VALID_WEIGHTS, 创造: 9 },
            { ...VALID_WEIGHTS, 记忆: null },
            { ...VALID_WEIGHTS, 未知: 0 },
        ]

        for (const bloomWeights of invalidWeights) {
            const response = await server.inject({
                method: 'POST',
                url: '/api/workbench/generate',
                payload: generatePayload({ bloomWeights }),
            })
            expect(response.statusCode, JSON.stringify(bloomWeights)).toBe(400)
        }
        const nonFinitePayload = JSON.stringify(generatePayload())
            .replace('"记忆":20', '"记忆":1e400')
        const nonFinite = await server.inject({
            method: 'POST',
            url: '/api/workbench/generate',
            headers: { 'content-type': 'application/json' },
            payload: nonFinitePayload,
        })
        expect(nonFinite.statusCode).toBe(400)
        expect(sessionStore.createSession).not.toHaveBeenCalled()
        expect(mocks.questionInvoke).not.toHaveBeenCalled()
    })

    it('enforces raw array caps before deduplication', async () => {
        const server = await createApp()
        const tooManyTypes = await server.inject({
            method: 'POST',
            url: '/api/workbench/generate',
            payload: generatePayload({ questionTypes: Array.from({ length: 7 }, () => '选择') }),
        })
        const tooManyExcluded = await server.inject({
            method: 'POST',
            url: '/api/workbench/generate',
            payload: generatePayload({
                excludeUsedQuestions: Array.from({ length: 501 }, (_, index) => `used-${index}`),
            }),
        })

        expect(tooManyTypes.statusCode).toBe(400)
        expect(tooManyExcluded.statusCode).toBe(400)
        expect(sessionStore.createSession).not.toHaveBeenCalled()
    })

    it('rejects invalid question array sizes and estimated time on refine', async () => {
        const server = await createApp()
        const baseQuestion = {
            id: 'question-001',
            poemId: 'poem-jingyesi',
            bloomLevel: '理解',
            type: '选择',
            stem: '诗中表达了什么情感？',
            options: ['思乡', '喜悦'],
            answer: '思乡',
            analysis: '由末句可知。',
            distractorsAnalysis: ['忽略语境'],
            difficulty: 2,
            estimatedTimeSec: 60,
            aiGenerated: true,
        }
        for (const question of [
            { ...baseQuestion, options: Array.from({ length: 9 }, (_, index) => `选项${index}`) },
            { ...baseQuestion, distractorsAnalysis: Array.from({ length: 9 }, (_, index) => `分析${index}`) },
            { ...baseQuestion, estimatedTimeSec: 4 },
            { ...baseQuestion, estimatedTimeSec: 3601 },
            { ...baseQuestion, stem: '   ' },
            { ...baseQuestion, unexpected: true },
        ]) {
            const response = await server.inject({
                method: 'POST',
                url: '/api/workbench/refine',
                payload: {
                    question,
                    instruction: '润色题干',
                    poemId: 'poem-jingyesi',
                    gradeLevel: '3-4年级',
                    teacherId: 'teacher-001',
                },
            })
            expect(response.statusCode).toBe(400)
        }
        expect(sessionStore.createSession).not.toHaveBeenCalled()
    })

    it('requires finite smart-compose percentages whose sum is exactly 100', async () => {
        const server = await createApp()
        for (const difficultyDistribution of [
            { easy: 40, medium: 30, hard: 20 },
            { easy: -1, medium: 61, hard: 40 },
            { easy: 101, medium: 0, hard: -1 },
            { easy: null, medium: 60, hard: 40 },
            { easy: 40, medium: 40, hard: 20, unexpected: 0 },
        ]) {
            const response = await server.inject({
                method: 'POST',
                url: '/api/workbench/smart-compose',
                payload: {
                    totalCount: 10,
                    difficultyDistribution,
                    knowledgePoints: ['思乡'],
                    totalScore: 100,
                },
            })
            expect(response.statusCode).toBe(400)
        }
        const nonFinite = await server.inject({
            method: 'POST',
            url: '/api/workbench/smart-compose',
            headers: { 'content-type': 'application/json' },
            payload: '{"totalCount":10,"difficultyDistribution":{"easy":1e400,"medium":0,"hard":0},"knowledgePoints":[],"totalScore":100}',
        })
        expect(nonFinite.statusCode).toBe(400)
        expect(mocks.findAllQuestions).not.toHaveBeenCalled()

        const accepted = await server.inject({
            method: 'POST',
            url: '/api/workbench/smart-compose',
            payload: {
                totalCount: 10,
                difficultyDistribution: { easy: 40, medium: 40, hard: 20 },
                knowledgePoints: ['思乡'],
                totalScore: 100,
            },
        })
        expect(accepted.statusCode).toBe(404)
        expect(mocks.findAllQuestions).toHaveBeenCalledTimes(1)
    })

    it('deduplicates export IDs and rejects unknown request fields', async () => {
        const server = await createApp()
        mocks.findQuestionById.mockReturnValue(validQuestion())
        const response = await server.inject({
            method: 'POST',
            url: '/api/workbench/export',
            payload: { questionIds: ['question-001', 'question-001'], format: 'json' },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({ count: 1, format: 'json' })
        expect(mocks.findQuestionById).toHaveBeenCalledTimes(1)

        const rejected = await server.inject({
            method: 'POST',
            url: '/api/workbench/export',
            payload: { questionIds: ['question-001'], format: 'json', unexpected: true },
        })
        expect(rejected.statusCode).toBe(400)

        const tooMany = await server.inject({
            method: 'POST',
            url: '/api/workbench/export',
            payload: {
                questionIds: Array.from({ length: 501 }, (_, index) => `question-${index}`),
                format: 'json',
            },
        })
        expect(tooMany.statusCode).toBe(400)
    })
})
