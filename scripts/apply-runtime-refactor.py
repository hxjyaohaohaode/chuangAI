"""One-shot, anchor-checked source integration. Does not access credentials or the network."""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]
changes = {}
def replace(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Source anchor mismatch: ' + old[:100])
    return text.replace(old, new, 1)
def section(text, start, end, new):
    a = text.index(start)
    b = text.index(end, a)
    return text[:a] + new + '\n\n' + text[b:]

p = ROOT / 'backend/src/orchestrator/Orchestrator.ts'
s = p.read_text()
if '// RUNTIME_REFACTOR_V1' not in s:
    s = replace(s, "import { DAGScheduler } from './dag-scheduler.js'", "// RUNTIME_REFACTOR_V1\nimport { DAGScheduler } from './dag-scheduler.js'\nimport { ExecutionLimiter } from './execution-limiter.js'\nimport { resolveTaskInput } from './runtime-data.js'")
    s = replace(s, '    private readonly activeExecutions = new Map<string, ActiveExecution>()', '    private readonly activeExecutions = new Map<string, ActiveExecution>()\n    private readonly limiter = new ExecutionLimiter(8, 256)')
    s = replace(s, '        // 检查是否已有该 session 的执行（resume 场景）', "        ctx = { ...ctx }\n        if (this.activeExecutions.has(ctx.sessionId)) throw new Error('同一会话正在执行，拒绝重入或替换执行上下文')\n\n        // 检查是否已有该 session 的执行（resume 场景）")
    s = replace(s, '        // 若外部 abortSignal 触发，联动 sessionController', '        const onExternalAbort = () => sessionController.abort()\n        // 若外部 abortSignal 触发，联动 sessionController')
    s = replace(s, "ctx.abortSignal.addEventListener('abort', () => sessionController.abort(), { once: true })", "ctx.abortSignal.addEventListener('abort', onExternalAbort, { once: true })")
    s = replace(s, '            // 若 DAG 已完成，清理执行上下文', "            ctx.abortSignal?.removeEventListener('abort', onExternalAbort)\n            // 若 DAG 已完成，清理执行上下文")
    s = replace(s, '            if (scheduler.isComplete()) {', '            if (scheduler.isComplete() || sessionController.signal.aborted) {')
    s = section(s, '    private async runDAGLoop(', '    /**\n     * 执行单个节点', '''    private async runDAGLoop(execution: ActiveExecution): Promise<void> {
        const { scheduler, sessionController } = execution
        const inFlight = new Map<string, Promise<void>>()
        while (!scheduler.isComplete() || inFlight.size > 0) {
            if (sessionController.signal.aborted) {
                this.abortAllRunning(execution)
                await Promise.allSettled(inFlight.values())
                break
            }
            scheduler.evaluateConditions(scheduler.collectResults())
            if (!execution.ctx.pauseSignal?.aborted) {
                for (const node of scheduler.getReadyNodes()) {
                    if (inFlight.size >= 4) break
                    if (inFlight.has(node.id)) continue
                    const task = this.executeNode(node, execution).finally(() => { inFlight.delete(node.id) })
                    inFlight.set(node.id, task)
                }
            }
            if (inFlight.size) {
                await Promise.race(inFlight.values())
                continue
            }
            if (scheduler.isComplete()) break
            if (scheduler.snapshot().paused > 0 || execution.ctx.pauseSignal?.aborted) {
                await sleep(50)
                continue
            }
            throw new Error('执行图仍有未完成节点但不可调度，拒绝把阻塞状态报告为成功')
        }
    }''')
    s = replace(s, '        scheduler.markRunning(node.id)\n        this.emitTaskEvent', '        scheduler.markRunning(node.id)\n        const attemptRevision = scheduler.getRevision(node.id)\n        this.emitTaskEvent')
    s = replace(s, "            // 带超时调用\n            const result", "            const resolvedInput = resolveTaskInput(node.input, node.dependencies, scheduler.collectResults())\n            // 带超时调用\n            const result")
    s = replace(s, '                agent,\n                node.input,\n                agentCtx,', '                agent,\n                resolvedInput,\n                agentCtx,')
    s = replace(s, '            // 成功\n            scheduler.markDone(node.id, result.output)', "            if (!scheduler.isCurrent(node.id, attemptRevision)) return\n            if (taskController.signal.aborted) throw new DOMException('Aborted', 'AbortError')\n            // 成功\n            scheduler.markDone(node.id, result.output, attemptRevision)")
    s = replace(s, '        } catch (err) {\n            const isPaused = execution.pausedTasks.has(node.id)', '        } catch (err) {\n            if (!scheduler.isCurrent(node.id, attemptRevision)) return\n            const isPaused = execution.pausedTasks.has(node.id)')
    s = replace(s, '            execution.runningControllers.delete(node.id)', '            if (execution.runningControllers.get(node.id) === taskController) execution.runningControllers.delete(node.id)')
    s = section(s, '    private async invokeWithTimeout(', '    /**\n     * 等待所有运行中任务完成', '''    private async invokeWithTimeout(
        agent: BaseAgent, input: unknown, ctx: AgentContext,
        timeoutMs: number, controller: AbortController,
    ): Promise<ReturnType<BaseAgent['invoke']>> {
        const signal = controller.signal
        // Capacity remains leased until the underlying invocation actually settles,
        // even when an uncooperative provider ignores cancellation.
        return new Promise((resolve, reject) => {
            let timedOut = false
            const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
            const onAbort = () => { cleanup(); reject(timedOut ? new Error(`节点超时（${timeoutMs}ms）`) : new DOMException('Aborted', 'AbortError')) }
            const timer = setTimeout(() => { timedOut = true; controller.abort('node-timeout') }, timeoutMs)
            timer.unref?.()
            if (signal.aborted) { onAbort(); return }
            signal.addEventListener('abort', onAbort, { once: true })
            const key = [...this.agentRegistry].find(([, candidate]) => candidate === agent)?.[0] ?? 'unknown'
            void this.limiter.acquire(key, signal).then(release => {
                if (signal.aborted) { release(); return }
                void Promise.resolve().then(() => agent.invoke(input, ctx)).then(
                    result => { cleanup(); resolve(result) },
                    error => { cleanup(); reject(error) },
                ).finally(release)
            }, error => { cleanup(); reject(error) })
        })
    }''')
    s = section(s, '    private abortAllRunning(', '    // ─────────────────────────────────────────────────────────\n    // 内部：结果构建', '''    private abortAllRunning(execution: ActiveExecution): void {
        for (const controller of execution.runningControllers.values()) controller.abort('session-abort')
        execution.scheduler.cancel('会话已中止')
        for (const task of execution.scheduler.getAllNodes()) this.notifyTaskUpdate(execution.ctx, task)
    }

    private notifyTaskUpdate(ctx: OrchestratorContext, task: SubTask): void {
        try { ctx.onTaskUpdate?.(task) }
        catch { console.warn('[orchestrator] Task observer failed', ctx.sessionId, task.id) }
    }

    private executionForTask(taskId: string): ActiveExecution | undefined {
        const owners = [...this.activeExecutions.values()].filter(item => item.scheduler.getNode(taskId))
        if (owners.length > 1) throw new Error('任务标识在多个会话中重复，拒绝跨会话介入')
        return owners[0]
    }''')
    s = s.replace('ctx.onTaskUpdate?.(runningNode)', 'this.notifyTaskUpdate(ctx, runningNode)').replace('ctx.onTaskUpdate?.(completedNode)', 'this.notifyTaskUpdate(ctx, completedNode)').replace('ctx.onTaskUpdate?.(settledNode)', 'this.notifyTaskUpdate(ctx, settledNode)')
    s = replace(s, 'const success = failedTasks.length === 0 && scheduler.isComplete()', 'const success = !execution.sessionController.signal.aborted && failedTasks.length === 0 && scheduler.isComplete() && results.size > 0')
    s = section(s, '    pause(taskId: string): void {', '    /**\n     * 恢复某任务', '''    pause(taskId: string): void {
        const execution = this.executionForTask(taskId)
        const controller = execution?.runningControllers.get(taskId)
        if (!execution || !controller) return
        execution.pausedTasks.add(taskId)
        if (execution.scheduler.getNode(taskId)?.status === 'running') execution.scheduler.markPaused(taskId)
        controller.abort('pause')
        const node = execution.scheduler.getNode(taskId)
        if (node) this.notifyTaskUpdate(execution.ctx, node)
        this.emitTaskEvent(ORCH_EVENTS.TASK_PAUSED, execution.sessionId, taskId, { reason: 'pause' })
    }''')
    s = section(s, '    resume(taskId: string): void {', '    /**\n     * 中止单个任务', '''    resume(taskId: string): void {
        const execution = this.executionForTask(taskId)
        if (!execution?.pausedTasks.has(taskId)) return
        const node = execution.scheduler.getNode(taskId)
        if (node?.status === 'paused') execution.scheduler.modifyInput(taskId, node.input)
        execution.pausedTasks.delete(taskId)
    }''')
    s = section(s, '    abort(taskId: string): void {', '    /**\n     * 修正任务输入后重跑', '''    abort(taskId: string): void {
        const execution = this.executionForTask(taskId)
        if (!execution) return
        execution.pausedTasks.delete(taskId)
        const controller = execution.runningControllers.get(taskId)
        if (controller) controller.abort('abort')
        const node = execution.scheduler.getNode(taskId)
        if (node && (node.status === 'pending' || node.status === 'paused')) execution.scheduler.markSkipped(taskId, '教师中止任务')
    }''')
    s = section(s, '    modify(taskId: string, newInput: unknown): void {', '    /**\n     * 中止整个 session', '''    modify(taskId: string, newInput: unknown): void {
        const execution = this.executionForTask(taskId)
        if (!execution) return
        const node = execution.scheduler.getNode(taskId)!
        resolveTaskInput(newInput, node.dependencies)
        const affected = execution.scheduler.getAffectedTaskIds(taskId)
        if (affected.some(id => id !== taskId && execution.scheduler.getNode(id)?.status === 'running')) throw new Error('下游仍在运行，请先暂停下游再修改上游')
        if (node.status === 'running') execution.scheduler.markPaused(taskId)
        execution.runningControllers.get(taskId)?.abort('modify')
        execution.scheduler.modifyInput(taskId, newInput)
        execution.pausedTasks.delete(taskId)
        for (const id of affected) {
            const changed = execution.scheduler.getNode(id)
            if (changed) this.notifyTaskUpdate(execution.ctx, changed)
        }
    }''')
    s = replace(s, "            '有数据依赖的任务必须显式声明 dependencies',", "            '有数据依赖的任务必须显式声明 dependencies',\n            '引用上游真实产物必须写成 {\"$from\":{\"taskId\":\"上游ID\",\"path\":[\"字段\"]}}；上游ID必须在直接依赖中，禁止编造未执行任务的结果',")
    changes[p] = s

p = ROOT / 'backend/src/orchestrator/plan-validation.ts'
s = p.read_text()
if "import { resolveTaskInput }" not in s:
    s = "import { resolveTaskInput } from './runtime-data.js'\n" + s
    s = replace(s, '    assertAcyclic(parsed.data.subTasks)', '    for (const task of parsed.data.subTasks) resolveTaskInput(task.input, task.dependencies)\n    assertAcyclic(parsed.data.subTasks)')
    changes[p] = s

p = ROOT / 'backend/src/orchestrator/session-store.ts'
s = p.read_text()
if '// ATOMIC_SESSION_READ_V1' not in s:
    s = '// ATOMIC_SESSION_READ_V1\n' + s
    s = replace(s, '        // LRU 更新：delete + set 使其移到末尾\n        this.sessions.delete(id)\n        this.sessions.set(id, session)', '        // Durable reads must not DELETE a committed checkpoint or rewrite its payload.\n        if (!(this.sessions instanceof SqliteMap)) {\n            this.sessions.delete(id)\n            this.sessions.set(id, session)\n        }')
    s = replace(s, '        // LRU 更新\n        this.sessions.delete(id)\n        this.sessions.set(id, session)', '        // SqliteMap.set is transactional; never delete the durable row first.\n        if (!(this.sessions instanceof SqliteMap)) this.sessions.delete(id)\n        this.sessions.set(id, session)')
    changes[p] = s

for relative in ['backend/package.json', 'frontend/package.json']:
    p = ROOT / relative
    data = json.loads(p.read_text())
    data.setdefault('engines', {})['node'] = '>=24.0.0 <25'
    changes[p] = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
for relative in ['.node-version', '.nvmrc']:
    changes[ROOT / relative] = '24\n'

# Resolve all anchors before writing any file. Runtime migrations are not performed.
for p, content in changes.items():
    if p.read_text() != content:
        p.write_text(content)
        print('SOURCE_UPDATED ' + str(p.relative_to(ROOT)))
