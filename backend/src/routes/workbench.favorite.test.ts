import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuestionEntity } from '../db/types.js'
import type { Orchestrator } from '../orchestrator/Orchestrator.js'
import type { SessionStore } from '../orchestrator/session-store.js'
import type { WSBroadcaster } from '../orchestrator/websocket/broadcaster.js'

const mocks = vi.hoisted(() => ({
    findQuestionById: vi.fn(),
    updateQuestion: vi.fn(),
}))

vi.mock('../db/index.js', () => ({
    repos: {
        questions: {
            findById: mocks.findQuestionById,
            update: mocks.updateQuestion,
        },
    },
}))

// 收藏路由不调用 Agent 或计费；隔离这些重量级依赖，确保测试只验证 HTTP 契约与持久化语义。
vi.mock('../agents/index.js', () => ({ agents: {} }))
vi.mock('../llm/index.js', () => ({ billing: {} }))

import { workbenchRoutes } from './workbench.js'

function createQuestion(favorited = false): QuestionEntity {
    return {
        id: 'question-favorite-001',
        poemId: 'poem-jingyesi',
        bloomLevel: '理解',
        type: '简答',
        stem: '诗中哪些词表现了思乡之情？',
        options: null,
        answer: '低头、思故乡。',
        analysis: '通过动作描写表现思乡。',
        distractorsAnalysis: null,
        difficulty: 2,
        estimatedTimeSec: 60,
        aiGenerated: true,
        promptVersion: 'test',
        createdAt: 1,
        createdBy: 'teacher-001',
        metadata: { favorited, score: 5, auditTag: 'must-survive' },
    }
}

describe('workbench favorite target-state contract', () => {
    let app: Awaited<ReturnType<typeof Fastify>> | undefined
    let question: QuestionEntity | null

    beforeEach(() => {
        vi.clearAllMocks()
        question = createQuestion(false)
        mocks.findQuestionById.mockImplementation((id: string) => (
            question?.id === id ? question : null
        ))
        mocks.updateQuestion.mockImplementation((_id: string, patch: Partial<QuestionEntity>) => {
            if (!question) return null
            question = { ...question, ...patch }
            return question
        })
    })

    afterEach(async () => {
        if (app) await app.close()
        app = undefined
    })

    async function createApp() {
        app = Fastify({ logger: false })
        await app.register(workbenchRoutes, {
            prefix: '/api/workbench',
            orchestrator: {} as Orchestrator,
            sessionStore: {} as SessionStore,
            broadcaster: {} as WSBroadcaster,
        })
        return app
    }

    async function setFavorite(server: NonNullable<typeof app>, favorited: boolean) {
        return server.inject({
            method: 'POST',
            url: '/api/workbench/questions/question-favorite-001/favorite',
            payload: { favorited },
        })
    }

    it('keeps repeated same-target retries idempotent instead of toggling back', async () => {
        const server = await createApp()

        const first = await setFavorite(server, true)
        const retry = await setFavorite(server, true)

        expect(first.statusCode).toBe(200)
        expect(retry.statusCode).toBe(200)
        expect(first.json()).toEqual({ status: 'ok', questionId: question?.id, favorited: true })
        expect(retry.json()).toEqual({ status: 'ok', questionId: question?.id, favorited: true })
        expect(question?.metadata).toMatchObject({
            favorited: true,
            score: 5,
            auditTag: 'must-survive',
        })
        expect(mocks.updateQuestion).toHaveBeenCalledTimes(1)
    })

    it('supports independent tabs retrying explicit on and off targets', async () => {
        const server = await createApp()

        await setFavorite(server, true)
        await setFavorite(server, true)
        await setFavorite(server, false)
        const offRetry = await setFavorite(server, false)

        expect(offRetry.statusCode).toBe(200)
        expect(offRetry.json()).toMatchObject({ favorited: false })
        expect(question?.metadata).toMatchObject({ favorited: false, auditTag: 'must-survive' })
        // 每个真正的目标态变化只写一次；网络重试不产生额外写入。
        expect(mocks.updateQuestion).toHaveBeenCalledTimes(2)
    })

    it('rejects an implicit toggle request before reading or mutating storage', async () => {
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/workbench/questions/question-favorite-001/favorite',
            payload: {},
        })

        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({ status: 'error', error: 'VALIDATION_ERROR' })
        expect(mocks.findQuestionById).not.toHaveBeenCalled()
        expect(mocks.updateQuestion).not.toHaveBeenCalled()
    })

    it('returns 404 without writing when the question does not exist', async () => {
        const server = await createApp()
        question = null

        const response = await setFavorite(server, true)

        expect(response.statusCode).toBe(404)
        expect(response.json()).toEqual({
            status: 'error',
            error: 'NOT_FOUND',
            message: '题卡不存在',
        })
        expect(mocks.updateQuestion).not.toHaveBeenCalled()
    })
})
