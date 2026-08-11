import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { Orchestrator } from './Orchestrator.js'
import type { InterventionManager } from './intervention.js'
import { orchestratorRoutes } from './routes.js'
import { SessionStore } from './session-store.js'
import { TraceStore } from '../observability/trace-store.js'
import { AuthService, installAuthBoundary } from '../security/auth.js'

describe('orchestrator trace route authorization and failure paths', () => {
    it('fails closed for absent identity, wrong owner, unknown session and invalid limit', async () => {
        const app = Fastify({ logger: false })
        const sessionStore = new SessionStore()
        const traceStore = new TraceStore()
        const session = sessionStore.createSession('teacher-owner')
        const authService = new AuthService({
            mode: 'demo',
            sessionSecret: 'orchestrator-route-test-secret-with-at-least-32-bytes',
            sessionTtlSeconds: 3600,
            cookieSecure: 'false',
            teacherId: 'teacher-owner',
            teacherName: '测试教师',
            passwordScrypt: '',
            corsOrigins: [],
        })
        const issued = authService.issue({ id: 'teacher-owner', name: '测试教师', role: 'teacher' })
        const cookie = `pr_session=${encodeURIComponent(issued.token)}`
        installAuthBoundary(app, authService)
        traceStore.record('orchestrator:plan:created', {
            sessionId: session.id,
            timestamp: 100,
            prompt: 'must not appear',
        })
        await app.register(orchestratorRoutes, {
            prefix: '/api/orchestrator',
            orchestrator: {} as Orchestrator,
            intervention: {} as InterventionManager,
            sessionStore,
            traceStore,
        })

        const base = `/api/orchestrator/sessions/${session.id}/trace`
        expect((await app.inject({ method: 'GET', url: base })).statusCode).toBe(401)
        expect((await app.inject({
            method: 'GET', url: `${base}?teacherId=teacher-other`, headers: { cookie },
        })).statusCode).toBe(403)
        expect((await app.inject({
            method: 'GET', url: '/api/orchestrator/sessions/missing/trace?teacherId=teacher-owner', headers: { cookie },
        })).statusCode).toBe(404)
        expect((await app.inject({
            method: 'GET', url: `${base}?teacherId=teacher-owner&limit=0`, headers: { cookie },
        })).statusCode).toBe(400)

        const response = await app.inject({
            method: 'GET', url: `${base}?teacherId=teacher-owner&limit=50`, headers: { cookie },
        })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({
            status: 'ok',
            trace: {
                summary: { sessionId: session.id, eventCount: 1 },
                privacy: {
                    rawPromptsStored: false,
                    rawOutputsStored: false,
                    studentIdentityStored: false,
                },
            },
        })
        expect(response.body).not.toContain('must not appear')
        await app.close()
    })
})
