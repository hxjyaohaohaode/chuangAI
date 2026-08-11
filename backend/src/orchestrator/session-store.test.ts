import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { SessionStore, sessionCheckpointCodec } from './session-store.js'
import type { ParsedInstruction, SessionState, SubTask } from './types.js'
import { db } from '../db/index.js'

const TEST_TABLE = 'orchestrator_session_checkpoint_test'

beforeEach(() => {
    db.exec(`DROP TABLE IF EXISTS "${TEST_TABLE}"`)
})

afterAll(() => {
    db.exec(`DROP TABLE IF EXISTS "${TEST_TABLE}"`)
})

const diagnoseTask: SubTask = {
    id: 'diagnose',
    agentId: 'mind.diagnose',
    input: { classId: 'class-001' },
    dependencies: [],
    condition: () => true,
    status: 'pending',
}

const plan: ParsedInstruction = {
    intent: 'composite',
    subTasks: [{ ...diagnoseTask }],
    executionPlan: {
        nodes: [{ ...diagnoseTask }],
        edges: [],
    },
    estimatedAgents: ['mind.diagnose'],
    estimatedDurationMs: 1000,
    confidence: 0.9,
}

describe('SessionStore durable checkpoint semantics', () => {
    it('round-trips Map fields and drops non-serializable condition functions', () => {
        const session: SessionState = {
            id: 'session-1',
            teacherId: 'teacher-1',
            startedAt: 1,
            status: 'completed',
            currentPlan: plan,
            taskStates: new Map([['diagnose', { ...diagnoseTask }]]),
            events: [],
            executionResult: {
                sessionId: 'session-1',
                success: true,
                results: new Map([['diagnose', { ok: true }]]),
                failedTasks: [],
                skippedTasks: [],
                totalLatencyMs: 12,
                totalCostYuan: 0,
                agentInvocations: [],
            },
        }

        const restored = sessionCheckpointCodec.deserialize(sessionCheckpointCodec.serialize(session))
        expect(restored.taskStates).toBeInstanceOf(Map)
        expect(restored.taskStates.get('diagnose')?.input).toEqual({ classId: 'class-001' })
        expect(restored.taskStates.get('diagnose')?.condition).toBeUndefined()
        expect(restored.executionResult?.results.get('diagnose')).toEqual({ ok: true })
    })

    it('fails closed after an interrupted process and preserves a teacher-retry checkpoint', () => {
        const interrupted: SessionState = {
            id: 'session-2',
            teacherId: 'teacher-1',
            startedAt: 1,
            status: 'executing',
            currentPlan: plan,
            taskStates: new Map([
                ['diagnose', { ...diagnoseTask, status: 'running', startedAt: 2 }],
            ]),
            events: [],
        }
        const storage = new Map([['session-2', interrupted]])
        const store = new SessionStore({ storage, recoverInterrupted: true })

        const restored = store.getSession('session-2')
        expect(restored?.status).toBe('aborted')
        expect(restored?.currentPlan?.intent).toBe('composite')
        expect(restored?.taskStates.get('diagnose')?.status).toBe('failed')
        expect(restored?.taskStates.get('diagnose')?.error).toContain('教师确认')
    })

    it('replaces stale task state when a teacher approves a revised plan', () => {
        const store = new SessionStore()
        const session = store.createSession('teacher-1')
        store.updateTaskState(session.id, {
            id: 'stale', agentId: 'brush.report', input: {}, dependencies: [], status: 'failed',
        })
        store.setPlan(session.id, plan)

        const restored = store.getSession(session.id)
        expect(restored?.taskStates.has('stale')).toBe(false)
        expect(restored?.taskStates.get('diagnose')?.status).toBe('pending')
    })

    it('persists a checkpoint across store instances and fails closed on restart', () => {
        const firstProcess = new SessionStore({ durable: true, tableName: TEST_TABLE })
        const session = firstProcess.createSession('teacher-1', 'class-001')
        firstProcess.setPlan(session.id, plan)
        firstProcess.setStatus(session.id, 'executing')
        firstProcess.updateTaskState(session.id, {
            ...diagnoseTask, status: 'running', startedAt: 2,
        })

        const restartedProcess = new SessionStore({ durable: true, tableName: TEST_TABLE })
        const restored = restartedProcess.getSession(session.id)
        expect(restored?.status).toBe('aborted')
        expect(restored?.classId).toBe('class-001')
        expect(restored?.currentPlan?.subTasks).toHaveLength(1)
        expect(restored?.taskStates.get('diagnose')?.error).toContain('避免重复副作用')
    })
})
