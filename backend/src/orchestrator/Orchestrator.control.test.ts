import { describe, expect, it, vi } from 'vitest'
import type { BaseAgent } from '../agents/base/Agent.js'
import type { AgentContext } from '../agents/base/types.js'
import type { LLMRouter } from '../llm/router.js'
import type { TokenBilling } from '../llm/billing.js'
import type { WSBroadcaster } from './websocket/broadcaster.js'
import { Orchestrator } from './Orchestrator.js'
import type { ParsedInstruction } from './types.js'

function plan(): ParsedInstruction {
    const task = { id: 'task-1', agentId: 'test.agent', input: { value: 1 }, dependencies: [], status: 'pending' as const }
    return {
        intent: 'composite',
        subTasks: [task],
        executionPlan: { nodes: [{ ...task }], edges: [] },
        estimatedAgents: ['test.agent'],
        estimatedDurationMs: 1000,
        confidence: 1,
    }
}

function setup() {
    const calls: Array<{ input: unknown; ctx: AgentContext; resolve: (value: unknown) => void }> = []
    const agent = {
        invoke: vi.fn((input: unknown, ctx: AgentContext) => new Promise((resolve) => {
            calls.push({ input, ctx, resolve })
        })),
    } as unknown as BaseAgent
    const orchestrator = new Orchestrator(
        {} as LLMRouter,
        { 'test.agent': agent },
        { broadcast: vi.fn() } as unknown as WSBroadcaster,
        { aggregateSession: () => ({ totalCostYuan: 0 }) } as unknown as TokenBilling,
    )
    const result = (value: unknown) => ({ output: value, usage: { promptTokens: 1, completionTokens: 1 } })
    return { orchestrator, calls, result }
}

describe('orchestrator session-scoped control', () => {
    it('isolates identical task ids across concurrent sessions and resumes only the selected session', async () => {
        const { orchestrator, calls, result } = setup()
        const first = orchestrator.execute(plan(), { sessionId: 's1', teacherId: 't1' })
        const second = orchestrator.execute(plan(), { sessionId: 's2', teacherId: 't2' })
        await vi.waitFor(() => expect(calls).toHaveLength(2))

        await orchestrator.pause('s1', 'task-1')
        expect(calls[0]?.ctx.signal?.aborted).toBe(true)
        expect(calls[1]?.ctx.signal?.aborted).toBe(false)
        expect(() => orchestrator.resume('s2', 'task-1')).toThrow('未暂停')
        orchestrator.resume('s1', 'task-1')
        await vi.waitFor(() => expect(calls).toHaveLength(3))

        calls[2]?.resolve(result('s1-done'))
        calls[1]?.resolve(result('s2-done'))
        calls[0]?.resolve(result('late-result-must-be-ignored'))
        expect((await first).results.get('task-1')).toBe('s1-done')
        expect((await second).results.get('task-1')).toBe('s2-done')
    })

    it('rejects a second scheduler for the same session and applies a running input change once', async () => {
        const { orchestrator, calls, result } = setup()
        const running = orchestrator.execute(plan(), { sessionId: 's1', teacherId: 't1' })
        await vi.waitFor(() => expect(calls).toHaveLength(1))
        await expect(orchestrator.execute(plan(), { sessionId: 's1', teacherId: 't1' })).rejects.toThrow('第二个调度循环')
        await orchestrator.modify('s1', 'task-1', { value: 2 })
        await vi.waitFor(() => expect(calls).toHaveLength(2))
        expect(calls[1]?.input).toEqual({ value: 2 })
        calls[1]?.resolve(result('new-result'))
        calls[0]?.resolve(result('old-result'))
        expect((await running).results.get('task-1')).toBe('new-result')
    })

    it('aborts a paused session and terminates its remaining nodes', async () => {
        const { orchestrator, calls, result } = setup()
        const running = orchestrator.execute(plan(), { sessionId: 's1', teacherId: 't1' })
        await vi.waitFor(() => expect(calls).toHaveLength(1))
        await orchestrator.pause('s1', 'task-1')
        orchestrator.abortSession('s1')
        calls[0]?.resolve(result('late-result'))
        const outcome = await running
        expect(outcome.success).toBe(false)
        expect(outcome.skippedTasks).toEqual(['task-1'])
        expect(orchestrator.activeExecutionCount).toBe(0)
    })
})
