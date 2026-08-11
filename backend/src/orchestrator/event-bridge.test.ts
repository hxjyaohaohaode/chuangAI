import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { TraceStore } from '../observability/trace-store.js'
import type { WSEvent } from './types.js'
import type { WSBroadcaster } from './websocket/broadcaster.js'
import { EventBridge } from './event-bridge.js'

describe('EventBridge persistent evidence integration', () => {
    it('broadcasts live events but persists only the sanitized projection', () => {
        const router = new EventEmitter()
        const recovery = new EventEmitter()
        const billing = new EventEmitter()
        const agentEvents = new EventEmitter()
        const broadcasts: WSEvent[] = []
        const broadcaster = {
            broadcast: (event: WSEvent) => broadcasts.push(event),
        } as unknown as WSBroadcaster
        const traceStore = new TraceStore()
        const bridge = new EventBridge(
            router, recovery, billing, agentEvents, broadcaster, traceStore,
        )

        agentEvents.emit('agent:call:start', {
            sessionId: 'session-bridge',
            agentId: 'mind.diagnose',
            taskId: 'task-1',
            promptVersion: 'v2.0.0',
            inputPreview: '学生隐私内容',
            timestamp: 100,
        })

        expect(broadcasts).toHaveLength(1)
        expect(broadcasts[0]?.sessionId).toBe('session-bridge')
        const trace = traceStore.getTrace('session-bridge')
        expect(trace.events).toHaveLength(1)
        expect(trace.events[0]).toMatchObject({
            agentId: 'mind.diagnose',
            promptVersion: 'v2.0.0',
        })
        expect(JSON.stringify(trace)).not.toContain('学生隐私内容')

        bridge.destroy()
        agentEvents.emit('agent:call:start', {
            sessionId: 'session-bridge', agentId: 'brush.question', timestamp: 200,
        })
        expect(broadcasts).toHaveLength(1)
        expect(traceStore.getTrace('session-bridge').events).toHaveLength(1)
    })
})
