import { describe, expect, it } from 'vitest'
import { boundedAgentInputSchema, validateExecutablePlan } from './plan-validation.js'

const allowedAgents = ['brush.question', 'mind.diagnose']

function validPlan() {
    return {
        intent: 'composite',
        subTasks: [
            {
                id: 'task-1',
                agentId: 'brush.question',
                input: { poemId: 'poem-1' },
                dependencies: [],
                status: 'success',
                result: { must: 'be stripped' },
            },
            {
                id: 'task-2',
                agentId: 'mind.diagnose',
                input: { classId: 'class-1' },
                dependencies: ['task-1'],
                status: 'failed',
                error: 'must be stripped',
            },
        ],
        executionPlan: {
            nodes: [
                { id: 'task-1', agentId: 'brush.question', input: {}, dependencies: [], status: 'success' },
                { id: 'task-2', agentId: 'mind.diagnose', input: {}, dependencies: ['task-1'] },
            ],
            edges: [{ from: 'task-1', to: 'task-2', condition: 'approved' }],
        },
        estimatedAgents: ['forged-agent'],
        estimatedDurationMs: 30_000,
        confidence: 0.9,
    }
}

describe('orchestrator execution plan validation', () => {
    it('rebuilds runtime state, edges and estimated agents from validated subtasks', () => {
        const plan = validateExecutablePlan(validPlan(), allowedAgents)
        expect(plan.subTasks.map((task) => task.status)).toEqual(['pending', 'pending'])
        expect(plan.subTasks[0]).not.toHaveProperty('result')
        expect(plan.subTasks[1]).not.toHaveProperty('error')
        expect(plan.estimatedAgents).toEqual(['brush.question', 'mind.diagnose'])
        expect(plan.executionPlan.edges).toEqual([
            { from: 'task-1', to: 'task-2', condition: 'approved' },
        ])
        expect(plan.executionPlan.nodes).not.toBe(plan.subTasks)
    })

    it.each([
        ['duplicate task id', (plan: ReturnType<typeof validPlan>) => { plan.subTasks[1]!.id = 'task-1' }, /ID 重复/u],
        ['unknown agent', (plan: ReturnType<typeof validPlan>) => { plan.subTasks[0]!.agentId = 'evil.agent' }, /未注册的 Agent/u],
        ['missing dependency', (plan: ReturnType<typeof validPlan>) => { plan.subTasks[1]!.dependencies = ['missing'] }, /依赖不存在/u],
        ['self dependency', (plan: ReturnType<typeof validPlan>) => { plan.subTasks[0]!.dependencies = ['task-1'] }, /依赖自身/u],
        ['cycle', (plan: ReturnType<typeof validPlan>) => { plan.subTasks[0]!.dependencies = ['task-2'] }, /循环依赖/u],
        ['preview mismatch', (plan: ReturnType<typeof validPlan>) => { plan.executionPlan.nodes.pop() }, /节点集合不一致/u],
        ['unknown edge node', (plan: ReturnType<typeof validPlan>) => { plan.executionPlan.edges[0]!.from = 'missing' }, /执行边引用不存在/u],
    ])('rejects %s', (_label, mutate, expected) => {
        const plan = validPlan()
        mutate(plan)
        expect(() => validateExecutablePlan(plan, allowedAgents)).toThrow(expected)
    })

    it('rejects oversized, deeply nested and non-finite Agent input', () => {
        expect(boundedAgentInputSchema.safeParse('x'.repeat(20_001)).success).toBe(false)
        let deeplyNested: unknown = 'leaf'
        for (let index = 0; index < 14; index += 1) deeplyNested = { nested: deeplyNested }
        expect(boundedAgentInputSchema.safeParse(deeplyNested).success).toBe(false)
        expect(boundedAgentInputSchema.safeParse({ score: Number.POSITIVE_INFINITY }).success).toBe(false)
        expect(boundedAgentInputSchema.safeParse(JSON.parse('{"__proto__":{"polluted":true}}')).success).toBe(false)
    })
})
