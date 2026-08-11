import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/index.js'
import { sanitizeTraceEvent, TraceStore } from './trace-store.js'

const TEST_TABLE = 'observability_trace_events_test'

beforeEach(() => {
    db.exec(`DROP TABLE IF EXISTS "${TEST_TABLE}"`)
})

afterAll(() => {
    db.exec(`DROP TABLE IF EXISTS "${TEST_TABLE}"`)
})

describe('TraceStore privacy and evidence semantics', () => {
    it('persists only allowlisted metadata and strips raw teaching content', () => {
        const event = sanitizeTraceEvent('agent:call:success', {
            sessionId: 'session-1',
            agentId: 'mind.diagnose',
            taskId: 'task-1',
            promptVersion: 'v2.0.0',
            latencyMs: 125,
            usage: { promptTokens: 10, completionTokens: 20, cachedTokens: 3 },
            timestamp: 1000,
            inputPreview: '学生张三的真实作答',
            output: { studentName: '张三', answer: '原始模型输出' },
            prompt: '系统提示词',
            apiKey: 'sk-secret',
            password: 'do-not-store',
        })

        expect(event).toMatchObject({
            sessionId: 'session-1',
            agentId: 'mind.diagnose',
            promptVersion: 'v2.0.0',
            phase: 'success',
            usage: { promptTokens: 10, completionTokens: 20, cachedTokens: 3 },
        })
        const serialized = JSON.stringify(event)
        expect(serialized).not.toContain('张三')
        expect(serialized).not.toContain('原始模型输出')
        expect(serialized).not.toContain('系统提示词')
        expect(serialized).not.toContain('sk-secret')
        expect(serialized).not.toContain('do-not-store')
    })

    it('ignores unsupported or sessionless events instead of creating ambiguous traces', () => {
        expect(sanitizeTraceEvent('agent:stream:delta', {
            sessionId: 'session-1', chunk: 'private',
        })).toBeUndefined()
        expect(sanitizeTraceEvent('agent:call:start', {
            agentId: 'mind.diagnose', inputPreview: 'private',
        })).toBeUndefined()
        expect(sanitizeTraceEvent('agent:call:start', null)).toBeUndefined()
    })

    it('separates retry events from terminal errors and counts billing exactly once', () => {
        const store = new TraceStore()
        store.record('orchestrator:execution:start', { sessionId: 'session-1', timestamp: 100 })
        store.record('llm:call:start', {
            sessionId: 'session-1', domain: 'mind', function: 'diagnose', timestamp: 110,
        })
        store.record('llm:call:error', {
            sessionId: 'session-1', error: '重试 1: upstream timeout', errorType: 'timeout', timestamp: 120,
        })
        store.record('agent:call:start', {
            sessionId: 'session-1', agentId: 'mind.diagnose', promptVersion: 'v2.0.0', timestamp: 130,
        })
        store.record('agent:call:success', {
            sessionId: 'session-1', agentId: 'mind.diagnose',
            usage: { promptTokens: 100, completionTokens: 50 }, timestamp: 150,
        })
        store.record('billing:record', {
            sessionId: 'session-1', promptTokens: 100, completionTokens: 50,
            cachedTokens: 10, costYuan: 0.02, timestamp: 151,
        })
        store.record('orchestrator:execution:success', { sessionId: 'session-1', timestamp: 170 })

        const trace = store.getTrace('session-1')
        expect(trace.summary).toMatchObject({
            status: 'success',
            llmCalls: 1,
            agentCalls: 1,
            retries: 1,
            errors: 0,
            totalTokens: 150,
            costYuan: 0.02,
            promptVersions: ['v2.0.0'],
        })
        expect(trace.events.find((event) => event.phase === 'retry')?.errorCategory).toBe('retryable')
    })

    it('caps query output while keeping full-summary counts', () => {
        const store = new TraceStore()
        for (let index = 0; index < 8; index += 1) {
            store.record('agent:call:start', {
                sessionId: 'session-limit', agentId: `agent-${index}`, timestamp: 100 + index,
            })
        }
        const trace = store.getTrace('session-limit', 3)
        expect(trace.events).toHaveLength(3)
        expect(trace.truncated).toBe(true)
        expect(trace.summary.eventCount).toBe(8)
        expect(trace.summary.agentCalls).toBe(8)
    })

    it('survives process-style store recreation without raw payload fields', () => {
        const first = new TraceStore({ durable: true, tableName: TEST_TABLE })
        first.record('agent:call:start', {
            sessionId: 'session-durable',
            agentId: 'brush.question',
            promptVersion: 'v3.1.0',
            timestamp: 1000,
            inputPreview: '绝不应落盘的题目内容',
        })

        const restarted = new TraceStore({ durable: true, tableName: TEST_TABLE })
        const trace = restarted.getTrace('session-durable')
        expect(trace.events).toHaveLength(1)
        expect(trace.events[0]).toMatchObject({
            agentId: 'brush.question',
            promptVersion: 'v3.1.0',
        })
        expect(JSON.stringify(trace)).not.toContain('绝不应落盘')
    })
})
