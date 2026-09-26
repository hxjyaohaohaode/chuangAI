import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentRuntimeStore } from './agent-runtime'

function dispatch(type: string, sessionId: string, payload: Record<string, unknown>, timestamp: number) {
    useAgentRuntimeStore.getState().handleWSEvent({
        type, sessionId, payload: { agentId: 'mind.diagnose', taskId: 'task-1', sessionId, timestamp, ...payload }, timestamp,
    })
}

describe('agent runtime event correlation', () => {
    const base = Date.now()
    beforeEach(() => useAgentRuntimeStore.getState().clearHistory())

    it('settles only the matching session and ignores duplicate or orphan terminal events', () => {
        dispatch('agent:call:start', 'session-a', {}, base)
        dispatch('agent:call:start', 'session-b', {}, base + 1)
        dispatch('agent:call:start', 'session-a', {}, base)
        expect(useAgentRuntimeStore.getState().calls).toHaveLength(2)

        dispatch('agent:call:success', 'session-a', { latencyMs: 20, usage: { promptTokens: 2, completionTokens: 3 } }, base + 20)
        dispatch('agent:call:success', 'session-a', { latencyMs: 20 }, base + 21)
        dispatch('agent:call:error', 'missing-session', { error: 'orphan' }, base + 22)

        const state = useAgentRuntimeStore.getState()
        expect(state.getCallsBySession('session-a')[0]?.status).toBe('success')
        expect(state.getCallsBySession('session-b')[0]?.status).toBe('running')
        expect(state.health.get('mind.diagnose')).toMatchObject({ totalCalls: 2, successCount: 1, errorCount: 0 })
    })

    it('attributes fallback and independent verification to one call', () => {
        dispatch('agent:call:start', 'session-a', {}, base)
        dispatch('agent:call:start', 'session-b', {}, base + 1)
        dispatch('agent:fallback', 'session-a', { reason: 'model timeout' }, base + 2)
        dispatch('agent:fallback', 'session-a', { reason: 'duplicate' }, base + 3)
        dispatch('agent:call:success', 'session-a', { latencyMs: 20 }, base + 20)
        dispatch('agent:verify', 'session-a', { targetAgentId: 'mind.diagnose', verdict: 'pass', score: 90 }, base + 21)
        dispatch('agent:verify', 'session-a', { targetAgentId: 'mind.diagnose', verdict: 'pass', score: 90 }, base + 22)

        const state = useAgentRuntimeStore.getState()
        expect(state.getCallsBySession('session-a')[0]).toMatchObject({
            fallbackReason: 'model timeout', verifyVerdict: 'pass', verifyScore: 90,
        })
        expect(state.getCallsBySession('session-b')[0]?.verifyVerdict).toBeUndefined()
        expect(state.health.get('mind.diagnose')).toMatchObject({ fallbackCount: 1, verifyPass: 1 })
    })
})
