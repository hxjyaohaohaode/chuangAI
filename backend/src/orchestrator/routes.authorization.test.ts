import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { Orchestrator } from './Orchestrator.js'
import type { InterventionManager } from './intervention.js'
import { orchestratorRoutes } from './routes.js'
import { SessionStore } from './session-store.js'
import { TraceStore } from '../observability/trace-store.js'
import { AuthService, installAuthBoundary } from '../security/auth.js'

describe('orchestrator resource authorization', () => {
    it('列表只返回当前主体，并在执行控制动作前拒绝其他主体会话', async () => {
        const app = Fastify({ logger: false })
        const sessionStore = new SessionStore()
        const ownerSession = sessionStore.createSession('teacher-owner')
        const otherSession = sessionStore.createSession('teacher-other')
        const pause = vi.fn(async () => undefined)
        const authService = new AuthService({
            mode: 'demo',
            sessionSecret: 'orchestrator-authorization-test-secret-at-least-32-bytes',
            sessionTtlSeconds: 3600,
            cookieSecure: 'false',
            teacherId: 'teacher-owner',
            teacherName: '测试教师',
            passwordScrypt: '',
            corsOrigins: [],
        })
        const issued = authService.issue({ id: 'teacher-owner', name: '测试教师', role: 'teacher' })
        const cookie = [
            `pr_session=${encodeURIComponent(issued.token)}`,
            `pr_csrf=${encodeURIComponent(issued.session.csrfToken)}`,
        ].join('; ')
        installAuthBoundary(app, authService)
        await app.register(orchestratorRoutes, {
            prefix: '/api/orchestrator',
            orchestrator: {} as Orchestrator,
            intervention: { pause } as unknown as InterventionManager,
            sessionStore,
            traceStore: new TraceStore(),
        })

        const list = await app.inject({
            method: 'GET', url: '/api/orchestrator/sessions', headers: { cookie },
        })
        expect(list.statusCode).toBe(200)
        expect(list.json().sessions).toEqual([
            expect.objectContaining({ id: ownerSession.id, teacherId: 'teacher-owner' }),
        ])

        expect((await app.inject({
            method: 'GET',
            url: `/api/orchestrator/sessions/${otherSession.id}`,
            headers: { cookie },
        })).statusCode).toBe(403)

        expect((await app.inject({
            method: 'POST',
            url: '/api/orchestrator/pause',
            headers: { cookie, 'x-csrf-token': issued.session.csrfToken },
            payload: { sessionId: otherSession.id, taskId: 'task-1' },
        })).statusCode).toBe(403)
        expect(pause).not.toHaveBeenCalled()

        expect((await app.inject({
            method: 'POST',
            url: '/api/orchestrator/pause',
            headers: { cookie, 'x-csrf-token': issued.session.csrfToken },
            payload: { sessionId: ownerSession.id, taskId: 'task-1' },
        })).statusCode).toBe(200)
        expect(pause).toHaveBeenCalledOnce()
        await app.close()
    })
})
