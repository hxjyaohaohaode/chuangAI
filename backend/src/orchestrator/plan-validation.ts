import { z } from 'zod'
import { resolveTaskInput } from './runtime-data.js'
import type { Intent, ParsedInstruction, SubTask } from './types.js'

const MAX_TASKS = 32
const MAX_DEPENDENCIES_PER_TASK = 31
const MAX_EDGES = 128
const MAX_AGENT_INPUT_CHARS = 20_000
const MAX_AGENT_INPUT_DEPTH = 12

const INTENTS = [
    'generate-questions',
    'grade-answers',
    'diagnose-class',
    'diagnose-student',
    'generate-report',
    'recommend-path',
    'vision-annotate',
    'evaluate-recitation',
    'generate-tts',
    'generate-creative',
    'composite',
    'unknown',
] as const satisfies readonly Intent[]

const boundedIdentifierSchema = z.string().trim().min(1).max(128)

function inspectJsonValue(value: unknown, depth = 0): string | null {
    if (depth > MAX_AGENT_INPUT_DEPTH) return `输入嵌套不能超过 ${MAX_AGENT_INPUT_DEPTH} 层`
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
        if (typeof value === 'number' && !Number.isFinite(value)) return '输入数字必须为有限值'
        return null
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const issue = inspectJsonValue(item, depth + 1)
            if (issue) return issue
        }
        return null
    }
    if (typeof value === 'object') {
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) return '输入必须是普通 JSON 对象'
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (key.length > 128) return '输入字段名不能超过 128 个字符'
            if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
                return `输入包含禁止字段: ${key}`
            }
            const issue = inspectJsonValue(item, depth + 1)
            if (issue) return issue
        }
        return null
    }
    return '输入只能包含可序列化的 JSON 值'
}

export const boundedAgentInputSchema = z.unknown().superRefine((value, ctx) => {
    const structuralIssue = inspectJsonValue(value)
    if (structuralIssue) {
        ctx.addIssue({ code: 'custom', message: structuralIssue })
        return
    }
    let serialized: string | undefined
    try {
        serialized = JSON.stringify(value)
    } catch {
        ctx.addIssue({ code: 'custom', message: '输入必须可以序列化为 JSON' })
        return
    }
    if (serialized === undefined) {
        ctx.addIssue({ code: 'custom', message: '输入必须是有效 JSON 值' })
    } else if (serialized.length > MAX_AGENT_INPUT_CHARS) {
        ctx.addIssue({
            code: 'custom',
            message: `单个任务输入不能超过 ${MAX_AGENT_INPUT_CHARS} 个字符`,
        })
    }
})

const taskSchema = z.object({
    id: boundedIdentifierSchema,
    agentId: boundedIdentifierSchema,
    input: boundedAgentInputSchema,
    dependencies: z.array(boundedIdentifierSchema).max(MAX_DEPENDENCIES_PER_TASK).default([]),
    // 接收预览态中的状态以保持前端兼容，但执行前始终重置为 pending。
    status: z.enum(['pending', 'running', 'paused', 'success', 'failed', 'skipped']).optional(),
}).strip()

const edgeSchema = z.object({
    from: boundedIdentifierSchema,
    to: boundedIdentifierSchema,
    condition: z.string().trim().min(1).max(256).optional(),
}).strip()

const executablePlanSchema = z.object({
    intent: z.enum(INTENTS),
    subTasks: z.array(taskSchema).min(1).max(MAX_TASKS),
    executionPlan: z.object({
        nodes: z.array(taskSchema).min(1).max(MAX_TASKS),
        edges: z.array(edgeSchema).max(MAX_EDGES),
    }).strip(),
    estimatedAgents: z.array(boundedIdentifierSchema).max(MAX_TASKS),
    estimatedDurationMs: z.number().int().min(1).max(30 * 60 * 1000),
    confidence: z.number().finite().min(0).max(1),
}).strip()

export class OrchestratorPlanValidationError extends Error {
    readonly code = 'INVALID_EXECUTION_PLAN'

    constructor(message: string) {
        super(message)
        this.name = 'OrchestratorPlanValidationError'
    }
}

function reject(message: string): never {
    throw new OrchestratorPlanValidationError(message)
}

function assertAcyclic(tasks: ReadonlyArray<{ id: string; dependencies: readonly string[] }>): void {
    const successors = new Map<string, string[]>()
    const indegree = new Map<string, number>(tasks.map((task) => [task.id, task.dependencies.length]))
    for (const task of tasks) {
        for (const dependency of task.dependencies) {
            const list = successors.get(dependency) ?? []
            list.push(task.id)
            successors.set(dependency, list)
        }
    }

    const queue = tasks.filter((task) => task.dependencies.length === 0).map((task) => task.id)
    let visited = 0
    while (queue.length > 0) {
        const current = queue.shift()
        if (!current) break
        visited += 1
        for (const successor of successors.get(current) ?? []) {
            const next = (indegree.get(successor) ?? 0) - 1
            indegree.set(successor, next)
            if (next === 0) queue.push(successor)
        }
    }
    if (visited !== tasks.length) reject('执行计划存在循环依赖')
}

/**
 * 对客户端回传的计划做完整运行时校验并重建唯一执行真相源。
 * executionPlan.nodes/edges 仅作为预览冗余输入接受；真正执行图始终由受检 subTasks 重建。
 */
export function validateExecutablePlan(
    value: unknown,
    allowedAgentIds: Iterable<string>,
): ParsedInstruction {
    const parsed = executablePlanSchema.safeParse(value)
    if (!parsed.success) {
        const firstIssue = parsed.error.issues[0]
        const field = firstIssue?.path.join('.') || 'plan'
        reject(`${field}: ${firstIssue?.message ?? '执行计划格式无效'}`)
    }

    const allowedAgents = new Set(allowedAgentIds)
    const taskIds = new Set<string>()
    for (const task of parsed.data.subTasks) {
        if (taskIds.has(task.id)) reject(`子任务 ID 重复: ${task.id}`)
        taskIds.add(task.id)
        if (!allowedAgents.has(task.agentId)) reject(`未注册的 Agent: ${task.agentId}`)
    }

    const previewNodeIds = new Set<string>()
    for (const node of parsed.data.executionPlan.nodes) {
        if (previewNodeIds.has(node.id)) reject(`executionPlan 节点 ID 重复: ${node.id}`)
        previewNodeIds.add(node.id)
    }
    if (previewNodeIds.size !== taskIds.size || [...taskIds].some((id) => !previewNodeIds.has(id))) {
        reject('executionPlan.nodes 与 subTasks 的节点集合不一致')
    }

    for (const task of parsed.data.subTasks) {
        const dependencies = new Set<string>()
        for (const dependency of task.dependencies) {
            if (dependency === task.id) reject(`子任务 ${task.id} 不能依赖自身`)
            if (!taskIds.has(dependency)) reject(`子任务 ${task.id} 依赖不存在的任务: ${dependency}`)
            if (dependencies.has(dependency)) reject(`子任务 ${task.id} 包含重复依赖: ${dependency}`)
            dependencies.add(dependency)
        }
    }

    for (const edge of parsed.data.executionPlan.edges) {
        if (!taskIds.has(edge.from) || !taskIds.has(edge.to)) {
            reject(`执行边引用不存在的节点: ${edge.from} -> ${edge.to}`)
        }
        if (edge.from === edge.to) reject(`执行边不能自环: ${edge.from}`)
    }

    for (const task of parsed.data.subTasks) resolveTaskInput(task.input, task.dependencies)
    assertAcyclic(parsed.data.subTasks)

    const conditions = new Map<string, string>()
    for (const edge of parsed.data.executionPlan.edges) {
        if (edge.condition) conditions.set(`${edge.from}\u0000${edge.to}`, edge.condition)
    }
    const subTasks: SubTask[] = parsed.data.subTasks.map((task) => ({
        id: task.id,
        agentId: task.agentId,
        input: task.input,
        dependencies: [...task.dependencies],
        status: 'pending',
    }))
    const edges = subTasks.flatMap((task) => task.dependencies.map((dependency) => ({
        from: dependency,
        to: task.id,
        ...(conditions.get(`${dependency}\u0000${task.id}`)
            ? { condition: conditions.get(`${dependency}\u0000${task.id}`) }
            : {}),
    })))

    return {
        intent: parsed.data.intent,
        subTasks,
        executionPlan: { nodes: subTasks.map((task) => ({ ...task, dependencies: [...task.dependencies] })), edges },
        estimatedAgents: [...new Set(subTasks.map((task) => task.agentId))],
        estimatedDurationMs: parsed.data.estimatedDurationMs,
        confidence: parsed.data.confidence,
    }
}
