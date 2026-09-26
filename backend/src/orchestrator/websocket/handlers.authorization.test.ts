import { once } from 'node:events'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import type { FastifyRequest } from 'fastify'
import type { InterventionManager } from '../intervention.js'
import { SessionStore } from '../session-store.js'
import { WSBroadcaster } from './broadcaster.js'
import { orchestratorWSPlugin } from './handlers.js'

describe('orchestrator WebSocket authorization', () => {
    it('rejects controls and subscriptions for another teacher session', async () => {
        const app = Fastify({ logger: false })
        const sessionStore = new SessionStore()
        const owned = sessionStore.createSession('teacher-a')
        const other = sessionStore.createSession('teacher-b')
        const pause = vi.fn(async () => undefined)
        const broadcaster = new WSBroadcaster(app, (id) => sessionStore.getSessionOwner(id))
        const clientSockets: WebSocket[] = []
        try {
            app.addHook('onRequest', async (request: FastifyRequest) => {
                request.auth = { id: 'teacher-a' } as NonNullable<FastifyRequest['auth']>
            })
            await app.register(websocket)
            await app.register(orchestratorWSPlugin, {
                prefix: '/ws',
                broadcaster,
                sessionStore,
                intervention: { pause } as unknown as InterventionManager,
            })
            const address = await app.listen({ port: 0, host: '127.0.0.1' })
            const socket = new WebSocket(address.replace('http:', 'ws:') + '/ws/orchestrator')
            clientSockets.push(socket)
            const greeting = once(socket, 'message')
            await once(socket, 'open')
            await greeting // connection greeting

            let reply = once(socket, 'message')
            socket.send(JSON.stringify({ type: 'orch:pause', sessionId: other.id, taskId: 'task-1' }))
            expect(JSON.parse(String((await reply)[0]))).toMatchObject({ type: 'orch:error' })
            expect(pause).not.toHaveBeenCalled()

            reply = once(socket, 'message')
            socket.send(JSON.stringify({ type: 'orch:subscribe', filter: { sessionId: other.id } }))
            expect(JSON.parse(String((await reply)[0]))).toMatchObject({ type: 'orch:error' })

            socket.send(JSON.stringify({ type: 'orch:pause', sessionId: owned.id, taskId: 'task-1' }))
            await vi.waitFor(() => expect(pause).toHaveBeenCalledWith(owned.id, 'task-1'))
        } finally {
            for (const socket of clientSockets) socket.close()
            broadcaster.closeAll()
            await app.close()
        }
    })
})
