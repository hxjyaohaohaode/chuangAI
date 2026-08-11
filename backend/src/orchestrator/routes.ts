/**
 * 编排官 REST API 路由
 *
 * 6 个端点：
 * - POST /api/orchestrator/parse         解析教师指令（不执行）
 * - POST /api/orchestrator/execute       执行已解析的 plan
 * - POST /api/orchestrator/pause         暂停任务
 * - POST /api/orchestrator/resume        恢复任务
 * - POST /api/orchestrator/abort         中止任务
 * - POST /api/orchestrator/modify        修正任务输入
 * - GET  /api/orchestrator/sessions/:id  查询 session 状态
 *
 * 路由设计原则：
 * - 解析与执行分离（教师可审查 plan 后再执行）
 * - 介入接口同步返回确认，实际效果通过 WebSocket 推送
 * - execute 异步执行，立即返回 sessionId，结果通过 WS 推送
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Orchestrator } from './Orchestrator.js'
import type { InterventionManager } from './intervention.js'
import type { SessionStore } from './session-store.js'
import type { TraceStore } from '../observability/trace-store.js'
import type { OrchestratorContext, ParsedInstruction, SubTask } from './types.js'
import { z } from 'zod'
import { schemas, validateBody } from '../lib/validation.js'
import {
    boundedAgentInputSchema,
    OrchestratorPlanValidationError,
} from './plan-validation.js'

// ─────────────────────────────────────────────────────────────
// 请求体类型
// ─────────────────────────────────────────────────────────────

interface ParseBody {
    instruction: string
    teacherId: string
    classId?: string
    /** 是否立即创建 session（默认 true） */
    createSession?: boolean
}

interface ExecuteBody {
    sessionId: string
    plan: ParsedInstruction
    teacherId: string
    classId?: string
}

interface TaskControlBody {
    sessionId: string
    taskId: string
}

interface ModifyBody extends TaskControlBody {
    newInput: unknown
}

interface TraceRequest {
    Params: { id: string }
    Querystring: { teacherId?: string; limit?: string }
}

const parseBodySchema = z.object({
    instruction: z.string().trim().min(1, 'instruction 不能为空').max(10_000, 'instruction 不能超过 10000 个字符'),
    teacherId: schemas.teacherId.optional(),
    classId: schemas.classId.optional(),
    createSession: z.boolean().optional(),
}).strict()

const executeBodySchema = z.object({
    sessionId: schemas.sessionId,
    plan: z.unknown(),
    teacherId: schemas.teacherId.optional(),
    classId: schemas.classId.optional(),
}).strict()

const taskControlBodySchema = z.object({
    sessionId: schemas.sessionId,
    taskId: schemas.id,
}).strict()

const abortBodySchema = z.object({
    sessionId: schemas.sessionId,
    taskId: schemas.id.optional(),
}).strict()

const modifyBodySchema = z.object({
    sessionId: schemas.sessionId,
    taskId: schemas.id,
    newInput: boundedAgentInputSchema,
}).strict()

/** 每次批准/重试都从干净状态启动；客户端提交的旧结果与错误绝不能被当成新执行事实。 */
function resetPlanForExecution(plan: ParsedInstruction): ParsedInstruction {
    const resetTask = (task: SubTask): SubTask => ({
        id: task.id,
        agentId: task.agentId,
        input: task.input,
        dependencies: [...task.dependencies],
        condition: task.condition,
        status: 'pending',
    })
    return {
        ...plan,
        subTasks: plan.subTasks.map(resetTask),
        executionPlan: {
            ...plan.executionPlan,
            nodes: plan.executionPlan.nodes.map(resetTask),
            edges: plan.executionPlan.edges.map((edge) => ({ ...edge })),
        },
    }
}

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

export interface OrchestratorRoutesOptions {
    orchestrator: Orchestrator
    intervention: InterventionManager
    sessionStore: SessionStore
    traceStore: TraceStore
}

export const orchestratorRoutes: FastifyPluginAsync<OrchestratorRoutesOptions> = async (
    app: FastifyInstance,
    opts: OrchestratorRoutesOptions,
) => {
    const { orchestrator, intervention, sessionStore, traceStore } = opts

    const requireOwnedSession = (id: string, teacherId: string, reply: FastifyReply) => {
        const session = sessionStore.getSession(id)
        if (!session) {
            void reply.status(404).send({ status: 'error', message: `会话不存在: ${id}` })
            return null
        }
        if (session.teacherId !== teacherId) {
            void reply.status(403).send({ status: 'error', message: '会话不属于当前教师' })
            return null
        }
        return session
    }

    // ── POST /parse — 解析教师指令 ──
    app.post('/parse', async (req: FastifyRequest<{ Body: ParseBody }>, reply) => {
        const body = validateBody(parseBodySchema, req, reply)
        if (!body) return
        const { instruction, classId, createSession = true } = body
        const teacherId = req.auth!.id

        try {
            const plan = await orchestrator.parseInstruction(instruction, { teacherId, classId })

            // 创建 session 并保存 plan
            let sessionId: string | undefined
            if (createSession) {
                const session = sessionStore.createSession(teacherId, classId)
                sessionStore.setPlan(session.id, plan)
                sessionStore.setStatus(session.id, 'planning')
                sessionId = session.id
                traceStore.record('orchestrator:plan:created', {
                    sessionId,
                    timestamp: Date.now(),
                })
            }

            return reply.send({
                status: 'ok',
                sessionId,
                plan,
            })
        } catch (err) {
            req.log.error({ err }, '编排官解析失败')
            return reply.status(500).send({
                status: 'error',
                error: 'ORCHESTRATOR_PARSE_FAILED',
                message: '编排计划解析失败，请稍后重试',
            })
        }
    })

    // ── POST /execute — 执行 plan ──
    app.post('/execute', async (req: FastifyRequest<{ Body: ExecuteBody }>, reply) => {
        const body = validateBody(executeBodySchema, req, reply)
        if (!body) return
        const { sessionId, plan, classId } = body
        const teacherId = req.auth!.id

        const session = requireOwnedSession(sessionId, teacherId, reply)
        if (!session) return
        if (session.status === 'executing' || session.status === 'completed') {
            return reply.status(409).send({
                status: 'error',
                message: `会话当前状态 ${session.status}，不可重复执行`,
            })
        }
        if (classId && session.classId && classId !== session.classId) {
            return reply.status(409).send({
                status: 'error',
                error: 'SESSION_CLASS_MISMATCH',
                message: '执行班级与规划会话不一致',
            })
        }

        // 教师可以在计划预览阶段修改任务输入；批准时以本次提交的 plan 作为
        // 唯一执行真相源，避免 SessionStore 仍保留 AI 最初草案。
        let executablePlan: ParsedInstruction
        try {
            executablePlan = resetPlanForExecution(orchestrator.validatePlanForExecution(plan))
        } catch (error) {
            if (error instanceof OrchestratorPlanValidationError) {
                return reply.status(400).send({
                    status: 'error',
                    error: error.code,
                    message: error.message,
                })
            }
            throw error
        }
        sessionStore.setPlan(sessionId, executablePlan)
        sessionStore.setStatus(sessionId, 'executing')
        traceStore.record('orchestrator:plan:approved', {
            sessionId,
            timestamp: Date.now(),
        })
        traceStore.record('orchestrator:execution:start', {
            sessionId,
            timestamp: Date.now(),
        })

        // 构建执行上下文
        const ctx: OrchestratorContext = {
            sessionId,
            teacherId,
            classId: session.classId ?? classId,
            onTaskUpdate: (task: SubTask) => {
                sessionStore.updateTaskState(sessionId, task)
            },
        }

        // 后台异步执行，立即返回
        void orchestrator
            .execute(executablePlan, ctx)
            .then((result) => {
                sessionStore.updateSession(sessionId, {
                    status: result.success ? 'completed' : 'aborted',
                    executionResult: result,
                    endedAt: Date.now(),
                })
                traceStore.record(
                    result.success ? 'orchestrator:execution:success' : 'orchestrator:execution:error',
                    { sessionId, timestamp: Date.now(), errorType: result.success ? undefined : 'task_failure' },
                )

                // 触发反思（非阻塞）
                void orchestrator.reflect(result).then((reflection) => {
                    sessionStore.appendReflection(sessionId, reflection)
                }).catch((err) => {
                    req.log.warn({ err }, '反思生成失败')
                })
            })
            .catch((err) => {
                req.log.error({ err }, '编排官执行失败')
                sessionStore.updateSession(sessionId, {
                    status: 'aborted',
                    endedAt: Date.now(),
                })
                traceStore.record('orchestrator:execution:error', {
                    sessionId,
                    timestamp: Date.now(),
                    errorType: err instanceof Error ? err.name : 'unknown',
                })
            })

        return reply.send({
            status: 'ok',
            message: '执行已启动，请通过 WebSocket 订阅实时进度',
            sessionId,
        })
    })

    // ── POST /pause — 暂停任务 ──
    app.post('/pause', async (req: FastifyRequest<{ Body: TaskControlBody }>, reply) => {
        const body = validateBody(taskControlBodySchema, req, reply)
        if (!body) return
        const { sessionId, taskId } = body
        if (!requireOwnedSession(sessionId, req.auth!.id, reply)) return

        try {
            await intervention.pause(sessionId, taskId)
            traceStore.record('orchestrator:execution:paused', {
                sessionId, taskId, timestamp: Date.now(),
            })
            return reply.send({ status: 'ok', message: '任务已暂停', sessionId, taskId })
        } catch (err) {
            return reply.status(400).send({
                status: 'error',
                message: err instanceof Error ? err.message : '暂停失败',
            })
        }
    })

    // ── POST /resume — 恢复任务 ──
    app.post('/resume', async (req: FastifyRequest<{ Body: TaskControlBody }>, reply) => {
        const body = validateBody(taskControlBodySchema, req, reply)
        if (!body) return
        const { sessionId, taskId } = body
        if (!requireOwnedSession(sessionId, req.auth!.id, reply)) return

        try {
            await intervention.resume(sessionId, taskId)
            traceStore.record('orchestrator:execution:resumed', {
                sessionId, taskId, timestamp: Date.now(),
            })
            return reply.send({ status: 'ok', message: '任务已恢复', sessionId, taskId })
        } catch (err) {
            return reply.status(400).send({
                status: 'error',
                message: err instanceof Error ? err.message : '恢复失败',
            })
        }
    })

    // ── POST /abort — 中止 session ──
    app.post('/abort', async (req: FastifyRequest<{ Body: TaskControlBody }>, reply) => {
        const body = validateBody(abortBodySchema, req, reply)
        if (!body) return
        const { sessionId } = body
        if (!requireOwnedSession(sessionId, req.auth!.id, reply)) return

        try {
            await intervention.abortSession(sessionId)
            traceStore.record('orchestrator:execution:aborted', {
                sessionId, timestamp: Date.now(),
            })
            return reply.send({ status: 'ok', message: '会话已中止', sessionId })
        } catch (err) {
            return reply.status(400).send({
                status: 'error',
                message: err instanceof Error ? err.message : '中止失败',
            })
        }
    })

    // ── POST /modify — 修正任务输入 ──
    app.post('/modify', async (req: FastifyRequest<{ Body: ModifyBody }>, reply) => {
        const body = validateBody(modifyBodySchema, req, reply)
        if (!body) return
        const { sessionId, taskId, newInput } = body
        if (!requireOwnedSession(sessionId, req.auth!.id, reply)) return

        try {
            await intervention.modifyAndRerun(sessionId, taskId, newInput)
            traceStore.record('orchestrator:execution:modified', {
                sessionId, taskId, timestamp: Date.now(),
            })
            return reply.send({
                status: 'ok',
                message: '任务输入已修正，重新执行中',
                sessionId,
                taskId,
            })
        } catch (err) {
            return reply.status(400).send({
                status: 'error',
                message: err instanceof Error ? err.message : '修改失败',
            })
        }
    })

    // ── GET /sessions/:id — 查询 session 状态 ──
    app.get('/sessions/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const { id } = req.params
        const session = requireOwnedSession(id, req.auth!.id, reply)
        if (!session) return

        // 序列化（Map 与函数无法直接 JSON.stringify）
        const taskStates = Array.from(session.taskStates.values()).map((t) => ({
            ...t,
            // condition 函数不可序列化，仅保留是否存在标志
            hasCondition: typeof t.condition === 'function',
            condition: undefined,
        }))

        return reply.send({
            status: 'ok',
            session: {
                id: session.id,
                teacherId: session.teacherId,
                classId: session.classId,
                startedAt: session.startedAt,
                endedAt: session.endedAt,
                status: session.status,
                currentPlan: session.currentPlan,
                taskStates,
                eventsCount: session.events.length,
                reflections: session.reflections ?? [],
                executionResult: session.executionResult
                    ? {
                        ...session.executionResult,
                        results: Array.from(session.executionResult.results.entries()),
                    }
                    : undefined,
            },
        })
    })

    // ── GET /sessions/:id/trace — 查询脱敏运行证据 ──
    app.get('/sessions/:id/trace', async (req: FastifyRequest<TraceRequest>, reply) => {
        const { id } = req.params
        const { limit } = req.query
        const session = requireOwnedSession(id, req.auth!.id, reply)
        if (!session) return

        const parsedLimit = limit === undefined ? undefined : Number(limit)
        if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
            return reply.status(400).send({
                status: 'error',
                message: 'limit 必须为正整数',
            })
        }

        return reply.send({
            status: 'ok',
            trace: traceStore.getTrace(id, parsedLimit),
        })
    })

    // ── GET /sessions — 列出会话 ──
    app.get('/sessions', async (req: FastifyRequest<{ Querystring: { teacherId?: string } }>, reply) => {
        const sessions = sessionStore.listSessions({ teacherId: req.auth!.id })

        return reply.send({
            status: 'ok',
            sessions: sessions.map((s) => ({
                id: s.id,
                teacherId: s.teacherId,
                classId: s.classId,
                startedAt: s.startedAt,
                endedAt: s.endedAt,
                status: s.status,
                taskCount: s.taskStates.size,
            })),
        })
    })
}
