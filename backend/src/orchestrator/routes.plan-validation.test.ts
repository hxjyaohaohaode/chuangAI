import Fastify, { type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Orchestrator } from './Orchestrator.js'
import type { InterventionManager } from './intervention.js'
import type { SessionStore } from './session-store.js'
import type { TraceStore } from '../observability/trace-store.js'
import { orchestratorRoutes } from './routes.js'
import { validateExecutablePlan } from './plan-validation.js'

function createPlan(agentId = 'agent.safe') {
    return {
        intent: 'generate-questions',
        subTasks: [{ id: 'task-1', agentId, input: { count: 3 }, dependencies: [], status: 'pending' }],
        executionPlan: {
            nodes: [{ id: 'task-1', agentId, input: { count: 3 }, dependencies: [], status: 'pending' }],
            edges: [],
        },
        estimatedAgents: [agentId],
        estimatedDurationMs: 10_000,
        confidence: 0.9,
    }
}

describe('orchestrator route runtime input boundary', () => {
    let app: Awaited<ReturnType<typeof Fastify>> | undefined
    const session = {
        id: 'session-a',
        teacherId: 'teacher-a',
        classId: 'class-a',
        status: 'planning' as const,
        startedAt: 1,
        taskStates: new Map(),
        events: [],
    }
    const getSession = vi.fn(() => session)
    const setPlan = vi.fn()
    const setStatus = vi.fn()
    const updateSession = vi.fn()
    const updateTaskState = vi.fn()
    const appendReflection = vi.fn()
    const parseInstruction = vi.fn()
    const execute = vi.fn(() => new Promise<never>(() => undefined))
    const reflect = vi.fn()
    const validatePlanForExecution = vi.fn((value: unknown) => validateExecutablePlan(value, ['agent.safe']))
    const pause = vi.fn()
    const modifyAndRerun = vi.fn()
    const record = vi.fn()

    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(async () => {
        if (app) await app.close()
        app = undefined
    })

    async function createApp() {
        app = Fastify({ logger: false })
        app.addHook('onRequest', async (request: FastifyRequest) => {
            request.auth = {
                id: 'teacher-a',
                name: '测试教师',
                role: 'teacher',
                issuedAt: 1,
                expiresAt: Number.MAX_SAFE_INTEGER,
                csrfToken: 'test-csrf-token',
                sessionId: 'auth-session',
            }
        })
        await app.register(orchestratorRoutes, {
            prefix: '/api/orchestrator',
            orchestrator: {
                parseInstruction,
                validatePlanForExecution,
                execute,
                reflect,
            } as unknown as Orchestrator,
            intervention: {
                pause,
                resume: vi.fn(),
                abortSession: vi.fn(),
                modifyAndRerun,
            } as unknown as InterventionManager,
            sessionStore: {
                getSession,
                setPlan,
                setStatus,
                updateSession,
                updateTaskState,
                appendReflection,
                listSessions: vi.fn(() => []),
                createSession: vi.fn(),
            } as unknown as SessionStore,
            traceStore: { record, getTrace: vi.fn() } as unknown as TraceStore,
        })
        return app
    }

    it('rejects an unknown Agent before changing session state or starting execution', async () => {
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/orchestrator/execute',
            payload: { sessionId: 'session-a', classId: 'class-a', plan: createPlan('agent.forged') },
        })

        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({
            status: 'error',
            error: 'INVALID_EXECUTION_PLAN',
        })
        expect(setPlan).not.toHaveBeenCalled()
        expect(setStatus).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
        expect(record).not.toHaveBeenCalled()
    })

    it('uses the session class as authority and rejects a client class switch', async () => {
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/orchestrator/execute',
            payload: { sessionId: 'session-a', classId: 'class-b', plan: createPlan() },
        })

        expect(response.statusCode).toBe(409)
        expect(response.json()).toMatchObject({ error: 'SESSION_CLASS_MISMATCH' })
        expect(validatePlanForExecution).not.toHaveBeenCalled()
        expect(setPlan).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    })

    it('accepts a valid plan, persists only the normalized plan and executes with the session class', async () => {
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/orchestrator/execute',
            payload: { sessionId: 'session-a', plan: createPlan() },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({ status: 'ok', sessionId: 'session-a' })
        expect(setPlan).toHaveBeenCalledOnce()
        const persistedPlan = setPlan.mock.calls[0]?.[1]
        expect(persistedPlan.subTasks[0]).toMatchObject({ status: 'pending', agentId: 'agent.safe' })
        expect(persistedPlan.subTasks[0]).not.toHaveProperty('result')
        expect(setStatus).toHaveBeenCalledWith('session-a', 'executing')
        expect(execute).toHaveBeenCalledWith(
            persistedPlan,
            expect.objectContaining({
                sessionId: 'session-a',
                teacherId: 'teacher-a',
                classId: 'class-a',
            }),
        )
    })

    it('does not expose provider or credential details when plan parsing fails', async () => {
        parseInstruction.mockRejectedValueOnce(new Error('provider 401 secret-key=sk-sensitive upstream body'))
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/orchestrator/parse',
            payload: { instruction: '请生成一组课堂练习' },
        })

        expect(response.statusCode).toBe(500)
        expect(response.json()).toEqual({
            status: 'error',
            error: 'ORCHESTRATOR_PARSE_FAILED',
            message: '编排计划解析失败，请稍后重试',
        })
        expect(response.body).not.toContain('provider')
        expect(response.body).not.toContain('sk-sensitive')
    })

    it.each([
        ['parse instruction length', '/api/orchestrator/parse', { instruction: 'x'.repeat(10_001) }],
        ['pause identifier length', '/api/orchestrator/pause', { sessionId: 'session-a', taskId: 'x'.repeat(129) }],
        ['modify input size', '/api/orchestrator/modify', {
            sessionId: 'session-a',
            taskId: 'task-1',
            newInput: 'x'.repeat(20_001),
        }],
    ] as const)('rejects bounded input: %s', async (_label, url, payload) => {
        const server = await createApp()
        const response = await server.inject({ method: 'POST', url, payload })

        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({ status: 'error', error: 'VALIDATION_ERROR' })
        expect(parseInstruction).not.toHaveBeenCalled()
        expect(pause).not.toHaveBeenCalled()
        expect(modifyAndRerun).not.toHaveBeenCalled()
    })
})
