import { describe, it, expect, vi } from 'vitest'
import { DAGScheduler } from './dag-scheduler.js'
import { ExecutionLimiter } from './execution-limiter.js'
import { cloneRuntimeData, resolveTaskInput } from './runtime-data.js'
import { Orchestrator } from './Orchestrator.js'
import type { DAG, SubTask, ParsedInstruction } from './types.js'
import type { BaseAgent } from '../agents/base/Agent.js'
import type { LLMRouter } from '../llm/router.js'
import type { TokenBilling } from '../llm/billing.js'
import type { WSBroadcaster } from './websocket/broadcaster.js'
vi.mock('../agents/base/evolution-engine.js', () => ({ evolutionEngine: { injectPromptOverride: (ctx: unknown) => ctx } }))
const task = (id: string, dependencies: string[] = [], input: unknown = {}): SubTask => ({ id, agentId: id, dependencies, input, status: 'pending' })
const graph = (...nodes: SubTask[]): DAG => ({ nodes, edges: nodes.flatMap(node => node.dependencies.map(from => ({ from, to: node.id }))) })
const done = (s: DAGScheduler, id: string, result: unknown = {}) => { s.markRunning(id); s.markDone(id, result) }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const output = (value: unknown = {}) => ({ output: value, usage: { promptTokens: 1, completionTokens: 1 } })
function harness(agents: Record<string, { invoke: (...args: any[]) => Promise<unknown> }>) {
    const broadcaster = { broadcast: vi.fn() }
    return { broadcaster, engine: new Orchestrator({} as LLMRouter, agents as unknown as Record<string, BaseAgent>, broadcaster as unknown as WSBroadcaster, { aggregateSession: () => ({ totalCostYuan: 0, tokenUsage: {} }) } as unknown as TokenBilling) }
}
const plan = (...nodes: SubTask[]): ParsedInstruction => ({ intent: 'composite', subTasks: nodes, executionPlan: graph(...nodes), estimatedAgents: nodes.map(node => node.agentId), estimatedDurationMs: 1000, confidence: 1 })

describe('runtime payload and explicit handoff boundary', () => {
    it('copies nested objects and binary data without aliasing', () => {
        const value = { nested: { a: 1 }, audio: Buffer.from('abc') }
        const cloned = cloneRuntimeData(value)
        cloned.nested.a = 9; cloned.audio[0] = 0
        expect(value.nested.a).toBe(1); expect(value.audio.toString()).toBe('abc')
        expect(Buffer.isBuffer(cloned.audio)).toBe(true)
    })
    it.each([NaN, Infinity, -Infinity, () => 1, Symbol('x'), new Date()])('rejects non-data value %s', value => { expect(() => cloneRuntimeData(value)).toThrow() })
    it('rejects cycles without stack overflow', () => { const x: Record<string, unknown> = {}; x.x = x; expect(() => cloneRuntimeData(x)).toThrow('循环') })
    it('does not invoke getters', () => { const getter = vi.fn(() => 'secret'); const x = Object.defineProperty({}, 'x', { get: getter, enumerable: true }); expect(() => cloneRuntimeData(x)).toThrow('访问器'); expect(getter).not.toHaveBeenCalled() })
    it.each(['__proto__', 'constructor', 'prototype'])('rejects dangerous own property %s', key => { const x = JSON.parse(`{"${key}":{}}`); expect(() => cloneRuntimeData(x)).toThrow() })
    it('enforces depth and byte limits including UTF-8', () => {
        let x: unknown = 1; for (let i = 0; i < 26; i++) x = { x }
        expect(() => cloneRuntimeData(x)).toThrow('结构')
        expect(() => cloneRuntimeData('诗'.repeat(10), 20)).toThrow('字节')
    })
    it('resolves only declared predecessor fields and copies the selected result', () => {
        const value = { items: [{ score: 7 }] }; const results = new Map([['a', value]])
        const input = { selected: { $from: { taskId: 'a', path: ['items', '0'] } } }
        const resolved = resolveTaskInput(input, ['a'], results) as { selected: { score: number } }
        expect(resolved.selected.score).toBe(7); resolved.selected.score = 0; expect(value.items[0]?.score).toBe(7)
    })
    it('rejects undeclared references before execution', () => { expect(() => resolveTaskInput({ $from: { taskId: 'secret' } }, ['a'])).toThrow('直接依赖') })
    it('rejects unavailable output rather than substituting a fabricated empty object', () => { expect(() => resolveTaskInput({ $from: { taskId: 'a' } }, ['a'], new Map())).toThrow('没有成功产物') })
    it('rejects nonexistent paths and mixed reference objects', () => {
        expect(() => resolveTaskInput({ $from: { taskId: 'a', path: ['missing'] } }, ['a'], new Map([['a', {}]]))).toThrow('缺少')
        expect(() => resolveTaskInput({ $from: { taskId: 'a' }, extra: true }, ['a'])).toThrow('混用')
    })
})

describe('deterministic DAG kernel', () => {
    it('does not permit public snapshots or caller inputs to mutate scheduling state', () => {
        const a = task('a', [], { nested: { score: 1 } }); const s = new DAGScheduler(graph(a))
        ;(a.input as { nested: { score: number } }).nested.score = 2
        ;(s.getReadyNodes()[0]!.input as { nested: { score: number } }).nested.score = 3
        expect(s.getNode('a')!.input).toEqual({ nested: { score: 1 } })
        done(s, 'a', { list: [1] }); (s.collectResults().get('a') as { list: number[] }).list.push(2)
        expect(s.getNode('a')!.result).toEqual({ list: [1] })
    })
    it('rejects completion before admission and terminal resurrection', () => {
        const s = new DAGScheduler(graph(task('a')))
        expect(() => s.markDone('a', {})).toThrow(); done(s, 'a')
        expect(() => s.markRunning('a')).toThrow(); expect(() => s.markFailed('a', 'late')).toThrow()
    })
    it('invalidates every transitive descendant but preserves unrelated results', () => {
        const s = new DAGScheduler(graph(task('a'), task('b', ['a']), task('c', ['b']), task('other')))
        for (const id of ['a', 'b', 'c', 'other']) done(s, id, { stale: true })
        s.modifyInput('a', { version: 2 })
        expect(['a', 'b', 'c'].map(id => s.getNode(id)?.status)).toEqual(['pending', 'pending', 'pending'])
        expect(s.getNode('c')?.result).toBeUndefined(); expect(s.getNode('other')?.status).toBe('success')
    })
    it('rejects edits atomically while a descendant is running', () => {
        const s = new DAGScheduler(graph(task('a'), task('b', ['a']))); done(s, 'a', { old: true }); s.markRunning('b')
        expect(() => s.modifyInput('a', { changed: true })).toThrow()
        expect(s.getNode('a')?.result).toEqual({ old: true }); expect(s.getNode('b')?.status).toBe('running')
    })
    it('fences completion from an earlier attempt after pause modify restart', () => {
        const s = new DAGScheduler(graph(task('a'))); s.markRunning('a'); const old = s.getRevision('a')
        s.markPaused('a'); s.modifyInput('a', { newer: true }); s.markRunning('a')
        s.markDone('a', { stale: true }, old); expect(s.getNode('a')?.status).toBe('running')
        s.markDone('a', { fresh: true }, s.getRevision('a')); expect(s.getNode('a')?.result).toEqual({ fresh: true })
    })
    it('terminates queued paused and active tasks on cancellation', () => {
        const s = new DAGScheduler(graph(task('active'), task('paused'), task('queued')))
        s.markRunning('active'); const old = s.getRevision('active'); s.markRunning('paused'); s.markPaused('paused'); s.cancel()
        expect(s.isComplete()).toBe(true); s.markDone('active', { late: true }, old); expect(s.collectResults().size).toBe(0)
    })
    it('propagates failed dependencies through conditioned nodes instead of leaving a deadlock', () => {
        const conditioned = { ...task('b', ['a']), condition: () => true }
        const s = new DAGScheduler(graph(task('a'), conditioned, task('c', ['b'])))
        s.markRunning('a'); s.markFailed('a', 'provider unavailable'); expect(s.isComplete()).toBe(true)
        expect(s.collectSkipped()).toEqual(['b', 'c'])
    })
    it('isolates condition callbacks from stored results', () => {
        const condition = (results: Map<string, unknown>) => { (results.get('a') as { x: number }).x = 2; return false }
        const s = new DAGScheduler(graph(task('a'), { ...task('b', ['a']), condition })); done(s, 'a', { x: 1 })
        s.evaluateConditions(s.collectResults()); expect(s.collectResults().get('a')).toEqual({ x: 1 }); expect(s.getNode('b')?.status).toBe('skipped')
    })
    it('rejects cycles missing nodes and duplicate dependencies', () => {
        expect(() => new DAGScheduler(graph(task('a', ['b']), task('b', ['a'])))).toThrow()
        expect(() => new DAGScheduler(graph(task('a', ['missing'])))).toThrow()
        expect(() => new DAGScheduler(graph(task('a'), task('b', ['a', 'a'])))).toThrow()
    })
    it('maintains topological ordering over deterministic generated DAGs', () => {
        for (let n = 1; n <= 40; n++) {
            const nodes = Array.from({ length: n }, (_, i) => task(String(i), Array.from({ length: i }, (_, j) => j).filter(j => (j + i) % 3 === 0).map(String)))
            const s = new DAGScheduler(graph(...nodes.reverse()))
            let completed = 0
            while (!s.isComplete()) {
                const ready = s.getReadyNodes(); expect(ready.length).toBeGreaterThan(0)
                for (const node of ready) { for (const dep of node.dependencies) expect(s.getNode(dep)?.status).toBe('success'); done(s, node.id); completed++ }
            }
            expect(completed).toBe(n)
        }
    })
})

describe('shared agent admission', () => {
    it('serializes one agent while allowing a different agent to use spare capacity', async () => {
        const limiter = new ExecutionLimiter(2); const signal = new AbortController().signal
        const a = await limiter.acquire('a', signal); let gotSecondA = false
        const waiting = limiter.acquire('a', signal).then(release => { gotSecondA = true; return release })
        const b = await limiter.acquire('b', signal); expect(gotSecondA).toBe(false); expect(limiter.snapshot()).toEqual({ active: 2, queued: 1 })
        a(); const release = await waiting; b(); release(); release(); expect(limiter.snapshot()).toEqual({ active: 0, queued: 0 })
    })
    it('removes cancelled queued requests without leaking admission slots', async () => {
        const limiter = new ExecutionLimiter(1); const release = await limiter.acquire('a', new AbortController().signal)
        const controller = new AbortController(); const waiting = limiter.acquire('b', controller.signal)
        const assertion = expect(waiting).rejects.toThrow('Aborted'); controller.abort(); await assertion; release()
        expect(limiter.snapshot()).toEqual({ active: 0, queued: 0 })
    })
    it('rejects pre-aborted and capacity-exceeded requests', async () => {
        const limiter = new ExecutionLimiter(1, 1); const signal = new AbortController().signal
        const release = await limiter.acquire('a', signal); const waiting = limiter.acquire('b', signal)
        await expect(limiter.acquire('c', signal)).rejects.toThrow('队列已满'); release(); (await waiting)()
        const controller = new AbortController(); controller.abort(); await expect(limiter.acquire('a', controller.signal)).rejects.toThrow('Aborted')
    })
})

describe('integrated orchestrator execution', () => {
    it('launches successors without waiting for an unrelated slow branch', async () => {
        let finish!: (value: unknown) => void
        const a = { invoke: vi.fn(() => new Promise(resolve => { finish = resolve })) }
        const b = { invoke: vi.fn(async () => output({ x: 7 })) }
        const c = { invoke: vi.fn(async (input: unknown) => output(input)) }
        const { engine } = harness({ a, b, c })
        const running = engine.execute(plan(task('a'), task('b'), task('c', ['b'], { $from: { taskId: 'b', path: ['x'] } })), { sessionId: 'work-conserving', teacherId: 't' })
        try { await vi.waitFor(() => expect(c.invoke).toHaveBeenCalled()); expect(c.invoke.mock.calls[0]?.[0]).toBe(7) }
        finally { finish(output()); await running }
    })
    it('rejects duplicate active session execution instead of replacing its context', async () => {
        let finish!: (value: unknown) => void
        const { engine } = harness({ a: { invoke: () => new Promise(resolve => { finish = resolve }) } })
        const p = plan(task('a')); const ctx = { sessionId: 'single-owner', teacherId: 't' }
        const running = engine.execute(p, ctx); await tick()
        await expect(engine.execute(p, { ...ctx, teacherId: 'different' })).rejects.toThrow('拒绝重入')
        finish(output()); expect((await running).success).toBe(true)
    })
    it('keeps observer failures separate from agent result status', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { engine } = harness({ a: { invoke: async () => output({ valid: true }) } })
        try { const result = await engine.execute(plan(task('a')), { sessionId: 'observer', teacherId: 't', onTaskUpdate: () => { throw new Error('UI disconnected') } }); expect(result.success).toBe(true) }
        finally { warn.mockRestore() }
    })
    it('rejects malformed Agent usage before committing a successful task', async () => {
        const { engine } = harness({ a: { invoke: async () => ({ output: { answer: 1 }, usage: { promptTokens: NaN, completionTokens: 1 } }) } })
        const result = await engine.execute(plan(task('a')), { sessionId: 'invalid-usage', teacherId: 't' })
        expect(result.success).toBe(false)
        expect(result.failedTasks).toEqual(['a'])
        expect(result.results.size).toBe(0)
    })
    it('times out admission behind an Agent that ignores cancellation', async () => {
        vi.useFakeTimers()
        let settleUnderlying!: (value: unknown) => void
        const agent = { invoke: vi.fn(() => new Promise(resolve => { settleUnderlying = resolve })) }
        const { engine } = harness({ a: agent })
        try {
            const first = engine.execute(plan(task('a')), { sessionId: 'hung-first', teacherId: 't' })
            await vi.advanceTimersByTimeAsync(0)
            expect(agent.invoke).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(60_001)
            expect((await first).failedTasks).toEqual(['a'])

            const second = engine.execute(plan(task('a')), { sessionId: 'queued-second', teacherId: 't' })
            await vi.advanceTimersByTimeAsync(0)
            expect(agent.invoke).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(60_001)
            expect((await second).failedTasks).toEqual(['a'])
            expect(agent.invoke).toHaveBeenCalledTimes(1)
        } finally {
            settleUnderlying?.(output())
            await vi.advanceTimersByTimeAsync(0)
            vi.useRealTimers()
        }
    })
    it('cancels a paused session to terminal failure rather than hanging or reporting success', async () => {
        const a = { invoke: vi.fn((_input: unknown, ctx: { signal: AbortSignal }) => new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))) }
        const { engine } = harness({ a })
        const running = engine.execute(plan(task('a')), { sessionId: 'paused-abort', teacherId: 't' })
        await vi.waitFor(() => expect(a.invoke).toHaveBeenCalled()); await engine.pause('paused-abort', 'a'); await tick(); engine.abortSession('paused-abort')
        const result = await running; expect(result.success).toBe(false); expect(result.results.size).toBe(0)
    })
})
