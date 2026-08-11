/**
 * 六阶命题工坊路由（Task 10）—— 真实多智能体版
 *
 * 教师最常用的功能：按布鲁姆六阶生成题目、验收、微调、导出、发布。
 *
 * 架构（Loop Engineering：生成→验收→修订闭环）：
 *   教师提交命题请求
 *     → brush.question 生成题目（deepseek-v4-pro max）
 *     → mind.verify 独立验收（deepseek-v4-pro high）
 *     → 若 reject 则携带验收反馈重新生成（最多 1 次重试）
 *     → WebSocket 实时推送进度
 *     → 结果落库 + 返回前端
 *
 * 设计说明：
 * - 编排官 Orchestrator.execute() 采用静态 DAG，节点 input 在计划阶段固定，
 *   无法支持"验收输入依赖生成输出"的动态构造。因此本路由直接调用子 Agent，
 *   但仍复用 sessionStore 管理会话状态、broadcaster 推送 WS 事件，
 *   保持全链路可观测性与编排官事件体系一致。
 * - /generate 为 fire-and-forget：立即返回 sessionId，结果通过 WebSocket 推送。
 * - /refine 为同步：直接返回微调后的题目（单题快速迭代）。
 *
 * 端点清单：
 *   POST /generate   生成题目（异步，返回 sessionId）
 *   POST /refine     微调单题（同步，返回精修后的题目）
 *   GET  /questions  按 sessionId 拉取生成结果
 *   POST /export     导出题目为 JSON / CSV
 *   POST /publish    发布为课堂闯关任务
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { Orchestrator } from '../orchestrator/Orchestrator.js'
import type { SessionStore } from '../orchestrator/session-store.js'
import type { WSBroadcaster } from '../orchestrator/websocket/broadcaster.js'
import { ORCH_EVENTS, type SubTask, type WSEvent } from '../orchestrator/types.js'
import type {
    AgentContext,
    BloomLevel,
    BloomMastery,
    BloomWeights,
    Question,
    PoemNode,
    VerifyIssue,
} from '../agents/base/types.js'
import type { QuestionInput, QuestionOutput } from '../agents/brush-agent/question.sub-agent.js'
import type { VerifyInput, VerifyOutput } from '../agents/mind-agent/verify.sub-agent.js'
import { agents } from '../agents/index.js'
import { repos } from '../db/index.js'
import { billing } from '../llm/index.js'
import { LESSON_MODES, type CreateQuestionInput, type CreateLessonInput, type QuestionEntity } from '../db/types.js'
import { handleRouteError } from './_helpers.js'
import { z } from 'zod'
import { validateBody, validateQuery, validateParams, schemas } from '../lib/validation.js'
import { bindSseDisconnectAbort, createPublicSseError, writeSseFrame } from '../lib/sse.js'
import {
    buildQuestionExport,
    questionsToCsv,
    type QuestionDocumentFormat,
} from '../services/workbench/question-exporter.js'

// ─────────────────────────────────────────────────────────────
// 请求 / 响应类型
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Zod schemas（B6.3 输入校验）
// ─────────────────────────────────────────────────────────────

const gradeLevelSchema = z.enum(['1-2年级', '3-4年级', '5-6年级'])

const questionTypeSchema = z.enum(['选择', '填空', '配对', '简答', '创作', '应用'])

const bloomLevelSchema = z.enum(['记忆', '理解', '应用', '分析', '评价', '创造'])

const percentageSchema = z.number().finite().min(0).max(100)
const PERCENTAGE_SUM_EPSILON = 1e-6

function requirePercentageSum(
    values: readonly number[],
    ctx: z.RefinementCtx,
    label: string,
): void {
    const sum = values.reduce((total, value) => total + value, 0)
    if (Math.abs(sum - 100) > PERCENTAGE_SUM_EPSILON) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label}总和必须为 100，当前为 ${sum}`,
        })
    }
}

const bloomWeightsSchema = z.object({
    记忆: percentageSchema,
    理解: percentageSchema,
    应用: percentageSchema,
    分析: percentageSchema,
    评价: percentageSchema,
    创造: percentageSchema,
}).strict().superRefine((weights, ctx) => requirePercentageSum([
    weights.记忆,
    weights.理解,
    weights.应用,
    weights.分析,
    weights.评价,
    weights.创造,
], ctx, 'Bloom 六阶权重'))

const difficultySchema = z.union([
    z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
])

/** Question 复合结构（用于 refine / publish 请求体） */
const questionSchema = z.object({
    id: schemas.id,
    poemId: schemas.poemId,
    bloomLevel: bloomLevelSchema,
    type: questionTypeSchema,
    stem: schemas.sanitizedString(5000),
    options: z.array(schemas.sanitizedString(1000)).min(1).max(8).optional(),
    answer: schemas.sanitizedString(5000),
    analysis: schemas.sanitizedString(10000),
    distractorsAnalysis: z.array(schemas.sanitizedString(5000)).min(1).max(8).optional(),
    difficulty: difficultySchema,
    estimatedTimeSec: z.number().finite().int().min(5).max(3600),
    aiGenerated: z.literal(true),
}).strict()

/** POST /generate 请求体 */
const generateSchema = z.object({
    poemId: schemas.poemId,
    gradeLevel: gradeLevelSchema,
    questionTypes: z.array(questionTypeSchema).min(1).max(6)
        .transform((values) => [...new Set(values)]),
    bloomWeights: bloomWeightsSchema,
    count: z.number().finite().int().min(1).max(20),
    teacherId: schemas.sanitizedString(128),
    classId: schemas.classId.optional(),
    excludeUsedQuestions: z.array(schemas.id).max(500)
        .transform((values) => [...new Set(values)])
        .optional(),
}).strict()

/** POST /refine 请求体 */
const refineSchema = z.object({
    question: questionSchema,
    instruction: schemas.sanitizedString(2000),
    poemId: schemas.poemId,
    gradeLevel: gradeLevelSchema,
    teacherId: schemas.sanitizedString(128),
})

/** GET /questions 查询参数（会话模式：拉取某次命题会话的生成结果） */
const questionsQuerySchema = z.object({
    sessionId: schemas.sessionId,
})

/**
 * GET /questions 查询参数（题库模式：分页浏览已落库题卡）
 *
 * 会话模式与题库模式共用同一路径，靠是否携带 page/pageSize 区分：
 * - 只带 sessionId              → 会话模式（返回该次生成的题目 + 验收结论）
 * - 带 page/pageSize            → 题库模式（分页 + 筛选 + 排序，sessionId 退化为筛选条件）
 * 这样既不破坏命题生成流程的既有契约，又能让「题目列表」面板真正读到题库。
 */
const questionBankQuerySchema = z.object({
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
    type: questionTypeSchema.optional(),
    difficulty: z.coerce.number().int().min(1).max(5).optional(),
    knowledgePoint: schemas.optionalSanitizedString(64),
    sortBy: z.enum(['difficulty', 'createdAt', 'score']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    sessionId: schemas.optionalSanitizedString(128),
    poemId: schemas.optionalSanitizedString(64),
    /** 仅看收藏 */
    favoritedOnly: z.coerce.boolean().optional(),
})

/** PATCH /questions/:id 请求体（题卡手动编辑，字段全部可选） */
const questionPatchSchema = z.object({
    stem: schemas.optionalSanitizedString(1000),
    answer: schemas.optionalSanitizedString(1000),
    analysis: schemas.optionalSanitizedString(2000),
    options: z.array(schemas.sanitizedString(300)).max(8).optional(),
    type: questionTypeSchema.optional(),
    bloomLevel: z.enum(['记忆', '理解', '应用', '分析', '评价', '创造']).optional(),
    difficulty: z.coerce.number().int().min(1).max(5).optional(),
    estimatedTimeSec: z.coerce.number().int().min(5).max(3600).optional(),
    knowledgePoints: z.array(schemas.sanitizedString(64)).max(20).optional(),
    score: z.coerce.number().min(0).max(100).optional(),
    favorited: z.boolean().optional(),
}).strict()

/** POST /questions/:id/favorite 请求体（显式目标态，允许安全重试） */
const favoriteTargetSchema = z.object({
    favorited: z.boolean(),
})

/** POST /smart-compose 请求体（AI 智能组卷） */
const smartComposeSchema = z.object({
    totalCount: z.number().finite().int().min(1).max(50),
    difficultyDistribution: z.object({
        easy: z.number().finite().min(0).max(100),
        medium: z.number().finite().min(0).max(100),
        hard: z.number().finite().min(0).max(100),
    }).strict().superRefine((distribution, ctx) => requirePercentageSum([
        distribution.easy,
        distribution.medium,
        distribution.hard,
    ], ctx, '难度分布')),
    knowledgePoints: z.array(schemas.sanitizedString(64)).max(30)
        .transform((values) => [...new Set(values)]),
    totalScore: z.number().finite().min(1).max(1000),
    poemId: schemas.optionalSanitizedString(64),
}).strict()

/** 题卡 ID 路径参数 */
const questionIdParamsSchema = z.object({ id: schemas.id })

/** POST /export 请求体 */
const exportSchema = z.object({
    questionIds: z.array(schemas.id).min(1).max(500)
        .transform((values) => [...new Set(values)]),
    format: z.enum(['word', 'excel', 'pdf', 'json', 'csv']),
    includeAnswer: z.boolean().default(true),
    includeAnalysis: z.boolean().default(true),
    layout: z.enum(['A4', 'B5']).default('A4'),
}).strict()

/** POST /publish 请求体 */
const publishSchema = z.object({
    classId: schemas.classId,
    poemId: schemas.poemId,
    teacherId: schemas.sanitizedString(128),
    questions: z.array(questionSchema).min(1).max(100),
    mode: z.enum(LESSON_MODES),
    scheduledAt: z.number().int().min(0).optional(),
}).strict()

interface WorkbenchResult {
    questions: Question[]
    verification: VerifyOutput
    coverage: BloomMastery
}

// ─────────────────────────────────────────────────────────────
// 插件选项
// ─────────────────────────────────────────────────────────────

export interface WorkbenchRoutesOptions {
    orchestrator: Orchestrator
    sessionStore: SessionStore
    broadcaster: WSBroadcaster
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 验收拒绝时的最大重试次数 */
const MAX_VERIFY_RETRIES = 1

// ─────────────────────────────────────────────────────────────
// 题库模式辅助（QuestionEntity ↔ WorkbenchQuestionMeta）
// ─────────────────────────────────────────────────────────────

/** 题卡在 questions.metadata 中承载的工坊扩展字段 */
interface QuestionBankMeta {
    favorited?: boolean
    score?: number
    knowledgePoints?: string[]
    sessionId?: string
}

/** 默认题卡分值（与前端 WorkbenchQuestionMeta.score 默认值一致） */
const DEFAULT_QUESTION_SCORE = 5

/**
 * 归一化难度到 1–5 整数
 *
 * questions.difficulty 列的 DDL 默认值是 0.5（历史上按 0–1 系数设计），
 * 而命题 Agent 写入的是 1–5 档位。这里统一收敛到 1–5，
 * 避免题库列表里出现 0.5 这种教师看不懂的难度值。
 */
function normalizeDifficulty(raw: number | null | undefined): 1 | 2 | 3 | 4 | 5 {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 3
    const scaled = raw <= 1 ? Math.round(raw * 5) : Math.round(raw)
    return Math.min(5, Math.max(1, scaled)) as 1 | 2 | 3 | 4 | 5
}

/**
 * 从题目实体推导知识点
 *
 * 优先取 metadata.knowledgePoints（命题/编辑时显式写入）；
 * 缺省时按「诗题 + 认知层级」派生一个稳定可解释的知识点，
 * 而不是留空——留空会让「按知识点筛选」永远筛不出东西。
 */
function deriveKnowledgePoints(entity: QuestionEntity, meta: QuestionBankMeta): string[] {
    if (Array.isArray(meta.knowledgePoints) && meta.knowledgePoints.length > 0) {
        return meta.knowledgePoints
    }
    const poem = repos.poems.findById(entity.poemId)
    const title = poem?.title ?? entity.poemId
    return [title, entity.bloomLevel]
}

/** QuestionEntity → 前端 WorkbenchQuestionMeta */
function toQuestionMeta(entity: QuestionEntity): Record<string, unknown> {
    const meta = (entity.metadata ?? {}) as QuestionBankMeta
    return {
        id: entity.id,
        poemId: entity.poemId,
        bloomLevel: entity.bloomLevel,
        type: entity.type,
        stem: entity.stem,
        options: entity.options ?? undefined,
        answer: entity.answer,
        analysis: entity.analysis ?? '',
        distractorsAnalysis: entity.distractorsAnalysis ?? undefined,
        difficulty: normalizeDifficulty(entity.difficulty),
        estimatedTimeSec: entity.estimatedTimeSec,
        aiGenerated: entity.aiGenerated,
        knowledgePoints: deriveKnowledgePoints(entity, meta),
        score: typeof meta.score === 'number' ? meta.score : DEFAULT_QUESTION_SCORE,
        favorited: meta.favorited === true,
        createdAt: entity.createdAt,
        updatedAt: (entity as unknown as { updatedAt?: number }).updatedAt ?? entity.createdAt,
    }
}

/** 验收六维度（与 mind.verify 子 Agent 系统提示一致） */
const VERIFY_CRITERIA = [
    '准确性：典故、字义、时代背景无误',
    '完整性：覆盖输入要求的所有字段',
    '一致性：内部逻辑自洽，与诗词原文不矛盾',
    '教育适宜性：符合指定年级认知水平',
    '文化敏感性：尊重传统文化，无不当表述',
    'AI 安全合规：无有害内容，无幻觉',
]

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

export const workbenchRoutes: FastifyPluginAsync<WorkbenchRoutesOptions> = async (app, opts) => {
    const { sessionStore, broadcaster } = opts

    /**
     * GET /poems
     *
     * 拉取古诗列表，供命题表单下拉选择。
     */
    app.get('/poems', async (_req, reply) => {
        try {
            const poems = repos.poems.findAll(200, 0)
            return reply.send({
                status: 'ok',
                poems: poems.map((p) => ({
                    id: p.id,
                    title: p.title,
                    poet: p.poet,
                    dynasty: p.dynasty,
                })),
            })
        } catch (err) {
            app.log.error({ err }, '[workbench/poems] 拉取古诗列表失败')
            return reply.send({ status: 'degraded', poems: [] })
        }
    })

    /**
     * POST /generate
     *
     * 触发六阶命题生成闭环（fire-and-forget）。
     * 立即返回 sessionId，前端通过 WebSocket 监听进度，
     * 生成完成后通过 GET /questions 拉取结果。
     */
    app.post(
        '/generate',
        async (req: FastifyRequest, reply) => {
            const body = validateBody(generateSchema, req, reply)
            if (!body) return
            const {
                poemId,
                count,
                teacherId,
                classId,
            } = body

            // 创建会话
            const session = sessionStore.createSession(teacherId, classId)
            sessionStore.setStatus(session.id, 'executing')

            // 广播会话开始
            broadcast(broadcaster, {
                type: ORCH_EVENTS.SESSION_START,
                timestamp: Date.now(),
                sessionId: session.id,
                payload: {
                    teacherId,
                    classId: classId ?? null,
                    intent: 'generate-questions',
                    poemId,
                    gradeLevel: body.gradeLevel,
                    count,
                },
            })

            // fire-and-forget：异步执行生成闭环
            void executeGenerationLoop(session.id, body, sessionStore, broadcaster, app.log)
                .catch((err) => {
                    app.log.error({ err, sessionId: session.id }, '[workbench] 生成闭环异常')
                    sessionStore.setStatus(session.id, 'aborted')
                    const abortBilling = billing.aggregateSession(session.id)
                    broadcast(broadcaster, {
                        type: ORCH_EVENTS.TASK_FAILED,
                        timestamp: Date.now(),
                        sessionId: session.id,
                        payload: {
                            taskId: 'workbench-generate',
                            error: '生成闭环异常',
                        },
                    })
                    broadcast(broadcaster, {
                        type: ORCH_EVENTS.SESSION_END,
                        timestamp: Date.now(),
                        sessionId: session.id,
                        payload: {
                            status: 'aborted',
                            totalCostYuan: abortBilling.totalCostYuan,
                            tokenUsage: abortBilling.tokenUsage,
                        },
                    })
                })

            return reply.send({ sessionId: session.id, aiGenerated: true })
        },
    )

    /**
     * POST /refine
     *
     * 微调单题：教师在命题工坊中对某道题提出自然语言修改意见，
     * 后端调用 brush.question 携带 teacherIntent 重新生成。
     * 同步返回精修后的题目（保留原题 id）。
     */
    app.post(
        '/refine',
        async (req: FastifyRequest, reply) => {
            const body = validateBody(refineSchema, req, reply)
            if (!body) return
            const { question, instruction, poemId, gradeLevel, teacherId } = body

            const session = sessionStore.createSession(teacherId)
            sessionStore.setStatus(session.id, 'executing')

            broadcast(broadcaster, {
                type: ORCH_EVENTS.SESSION_START,
                timestamp: Date.now(),
                sessionId: session.id,
                payload: {
                    teacherId,
                    intent: 'refine-question',
                    poemId,
                    questionId: question.id,
                },
            })

            const taskId = 'refine-brush-question'
            broadcastTaskStart(broadcaster, session.id, taskId, 'brush.question')

            try {
                const poemNode = await loadPoemNode(poemId)
                const teacherIntent = JSON.stringify({
                    mode: 'refine',
                    originalQuestion: question,
                    instruction,
                })

                const ctx: AgentContext = {
                    taskId,
                    sessionId: session.id,
                    knowledgeGraphNodes: poemNode ? [poemNode] : [],
                    teacherIntent,
                }

                // 以原题的 bloom 层级为重心构造权重
                const focusedWeights: BloomWeights = {
                    记忆: question.bloomLevel === '记忆' ? 100 : 0,
                    理解: question.bloomLevel === '理解' ? 100 : 0,
                    应用: question.bloomLevel === '应用' ? 100 : 0,
                    分析: question.bloomLevel === '分析' ? 100 : 0,
                    评价: question.bloomLevel === '评价' ? 100 : 0,
                    创造: question.bloomLevel === '创造' ? 100 : 0,
                }

                const input: QuestionInput = {
                    poemId,
                    gradeLevel,
                    questionTypes: [question.type],
                    bloomWeights: focusedWeights,
                    count: 1,
                }

                const result = await agents.brush.question.invoke(input, ctx)
                const output = result.output as QuestionOutput
                const refinedRaw = output.questions[0]
                if (!refinedRaw) {
                    throw new Error('微调未返回题目')
                }

                // 保留原题 id，确保前端可替换
                const refined: Question = { ...refinedRaw, id: question.id }

                const taskDone: SubTask = {
                    id: taskId,
                    agentId: 'brush.question',
                    input,
                    dependencies: [],
                    status: 'success',
                    result: { questions: [refined], coverage: output.coverage },
                    startedAt: Date.now(),
                    endedAt: Date.now(),
                }
                sessionStore.updateTaskState(session.id, taskDone)
                broadcastTaskDone(broadcaster, session.id, taskDone)

                sessionStore.setStatus(session.id, 'completed')
                const refineBilling = billing.aggregateSession(session.id)
                broadcast(broadcaster, {
                    type: ORCH_EVENTS.SESSION_END,
                    timestamp: Date.now(),
                    sessionId: session.id,
                    payload: {
                        status: 'completed',
                        totalCostYuan: refineBilling.totalCostYuan,
                        tokenUsage: refineBilling.tokenUsage,
                    },
                })

                return reply.send({ original: question, refined, aiGenerated: true })
            } catch (err) {
                const taskFailed: SubTask = {
                    id: taskId,
                    agentId: 'brush.question',
                    input: { poemId },
                    dependencies: [],
                    status: 'failed',
                    error: '微调失败',
                    startedAt: Date.now(),
                    endedAt: Date.now(),
                }
                sessionStore.updateTaskState(session.id, taskFailed)
                broadcastTaskFailed(broadcaster, session.id, taskFailed)
                sessionStore.setStatus(session.id, 'aborted')

                app.log.error({ err, sessionId: session.id }, '[workbench/refine] 微调失败')
                handleRouteError(err, req, reply, '微调失败')
                return
            }
        },
    )

    /**
     * GET /questions
     *
     * 双模式：
     *  A. 会话模式 `?sessionId=xxx`（无 page/pageSize）
     *     拉取指定命题会话的生成结果，从 sessionStore.taskStates 中提取
     *     最新一次 brush.question 与 mind.verify 结果。
     *  B. 题库模式 `?page=1&pageSize=20&...`
     *     分页浏览已落库题卡，支持题型/难度/知识点筛选与多字段排序。
     *     命题工坊「题目列表」面板走的是这条路径——此前该模式缺失，
     *     请求恒被会话模式的 sessionId 必填校验拦成 400，题库永远显示 0 题。
     */
    app.get(
        '/questions',
        async (req: FastifyRequest, reply) => {
            const rawQuery = (req.query ?? {}) as Record<string, unknown>
            const isBankMode = rawQuery['page'] !== undefined || rawQuery['pageSize'] !== undefined

            // ── A. 会话模式（保持既有契约不变） ──
            if (!isBankMode) {
                const query = validateQuery(questionsQuerySchema, req, reply)
                if (!query) return
                const { sessionId } = query

                const session = sessionStore.getSession(sessionId)
                if (!session) {
                    return reply.status(404).send({
                        statusCode: 404,
                        error: 'Not Found',
                        message: `会话 ${sessionId} 不存在或已过期`,
                    })
                }

                const result = extractWorkbenchResult(session.taskStates)
                return reply.send({
                    sessionId,
                    questions: result.questions,
                    verification: result.verification,
                    coverage: result.coverage,
                    aiGenerated: true,
                })
            }

            // ── B. 题库模式 ──
            const query = validateQuery(questionBankQuerySchema, req, reply)
            if (!query) return

            try {
                const page = query.page ?? 1
                const pageSize = query.pageSize ?? 20

                let entities = repos.questions.findAll(5000)

                if (query.poemId) entities = entities.filter((e) => e.poemId === query.poemId)
                if (query.type) entities = entities.filter((e) => e.type === query.type)
                if (query.difficulty !== undefined) {
                    entities = entities.filter((e) => normalizeDifficulty(e.difficulty) === query.difficulty)
                }
                if (query.sessionId) {
                    entities = entities.filter(
                        (e) => ((e.metadata ?? {}) as QuestionBankMeta).sessionId === query.sessionId,
                    )
                }
                if (query.favoritedOnly) {
                    entities = entities.filter((e) => ((e.metadata ?? {}) as QuestionBankMeta).favorited === true)
                }

                // 先转 meta 再按知识点筛选：知识点可能来自 metadata，也可能由诗题派生
                let metas = entities.map(toQuestionMeta)

                if (query.knowledgePoint) {
                    const kp = query.knowledgePoint.toLowerCase()
                    metas = metas.filter((m) =>
                        (m['knowledgePoints'] as string[]).some((k) => k.toLowerCase().includes(kp)),
                    )
                }

                const sortBy = query.sortBy ?? 'createdAt'
                const sortOrder = query.sortOrder ?? 'desc'
                const dir = sortOrder === 'asc' ? 1 : -1
                metas.sort((a, b) => {
                    const av = a[sortBy] as number
                    const bv = b[sortBy] as number
                    if (av === bv) {
                        // 同值时用 id 兜底，保证分页结果稳定不跳动
                        return String(a['id']).localeCompare(String(b['id'])) * dir
                    }
                    return (av - bv) * dir
                })

                const total = metas.length
                const start = (page - 1) * pageSize

                return reply.send({
                    status: 'ok',
                    questions: metas.slice(start, start + pageSize),
                    total,
                    page,
                    pageSize,
                })
            } catch (err) {
                handleRouteError(err, req, reply, '题库查询失败')
                return
            }
        },
    )

    /**
     * POST /questions/:id/favorite
     *
     * 将题卡收藏状态设置为显式目标值（幂等：同值重试不会再次翻转）。
     * 收藏标记写入 questions.metadata.favorited。
     */
    app.post('/questions/:id/favorite', async (req: FastifyRequest, reply) => {
        const params = validateParams(questionIdParamsSchema, req, reply)
        if (!params) return
        const target = validateBody(favoriteTargetSchema, req, reply)
        if (!target) return

        try {
            const entity = repos.questions.findById(params.id)
            if (!entity) {
                return reply.status(404).send({ status: 'error', error: 'NOT_FOUND', message: '题卡不存在' })
            }
            const meta = (entity.metadata ?? {}) as QuestionBankMeta
            const currentFavorited = meta.favorited === true

            // 显式目标态是重试安全的：请求响应丢失后，同一请求再次到达不会把状态翻回去；
            // 同值时不写库，避免无意义地刷新 updated_at 或覆盖并发写入的元数据。
            if (currentFavorited !== target.favorited) {
                repos.questions.update(params.id, {
                    metadata: { ...meta, favorited: target.favorited },
                })
            }

            return reply.send({ status: 'ok', questionId: params.id, favorited: target.favorited })
        } catch (err) {
            handleRouteError(err, req, reply, '收藏状态更新失败')
            return
        }
    })

    /**
     * POST /questions/:id/duplicate
     *
     * 复制题卡（新 ID，题干后缀「（副本）」以便教师在列表中区分）。
     * 副本不继承收藏状态——收藏是教师对具体那一张卡的标记。
     */
    app.post('/questions/:id/duplicate', async (req: FastifyRequest, reply) => {
        const params = validateParams(questionIdParamsSchema, req, reply)
        if (!params) return

        try {
            const src = repos.questions.findById(params.id)
            if (!src) {
                return reply.status(404).send({ status: 'error', error: 'NOT_FOUND', message: '题卡不存在' })
            }
            const srcMeta = (src.metadata ?? {}) as QuestionBankMeta
            const created = repos.questions.create({
                poemId: src.poemId,
                bloomLevel: src.bloomLevel,
                type: src.type,
                stem: `${src.stem}（副本）`,
                options: src.options,
                answer: src.answer,
                analysis: src.analysis,
                distractorsAnalysis: src.distractorsAnalysis,
                difficulty: src.difficulty,
                estimatedTimeSec: src.estimatedTimeSec,
                aiGenerated: src.aiGenerated,
                promptVersion: src.promptVersion,
                createdBy: src.createdBy,
                metadata: { ...srcMeta, favorited: false, duplicatedFrom: src.id },
            } as CreateQuestionInput)

            return reply.send({ status: 'ok', ...toQuestionMeta(created) })
        } catch (err) {
            handleRouteError(err, req, reply, '题卡复制失败')
            return
        }
    })

    /**
     * PATCH /questions/:id
     *
     * 手动编辑题卡。仅更新请求体中出现的字段，其余保持不变。
     */
    app.patch('/questions/:id', async (req: FastifyRequest, reply) => {
        const params = validateParams(questionIdParamsSchema, req, reply)
        if (!params) return
        const patch = validateBody(questionPatchSchema, req, reply)
        if (!patch) return

        try {
            const entity = repos.questions.findById(params.id)
            if (!entity) {
                return reply.status(404).send({ status: 'error', error: 'NOT_FOUND', message: '题卡不存在' })
            }

            const meta = (entity.metadata ?? {}) as QuestionBankMeta
            const nextMeta: QuestionBankMeta = { ...meta }
            if (patch.knowledgePoints !== undefined) nextMeta.knowledgePoints = patch.knowledgePoints
            if (patch.score !== undefined) nextMeta.score = patch.score
            if (patch.favorited !== undefined) nextMeta.favorited = patch.favorited

            repos.questions.update(params.id, {
                ...(patch.stem !== undefined ? { stem: patch.stem } : {}),
                ...(patch.answer !== undefined ? { answer: patch.answer } : {}),
                ...(patch.analysis !== undefined ? { analysis: patch.analysis } : {}),
                ...(patch.options !== undefined ? { options: patch.options } : {}),
                ...(patch.type !== undefined ? { type: patch.type } : {}),
                ...(patch.bloomLevel !== undefined ? { bloomLevel: patch.bloomLevel } : {}),
                ...(patch.difficulty !== undefined ? { difficulty: patch.difficulty } : {}),
                ...(patch.estimatedTimeSec !== undefined ? { estimatedTimeSec: patch.estimatedTimeSec } : {}),
                metadata: nextMeta as Record<string, unknown>,
            })

            const updated = repos.questions.findById(params.id)
            if (!updated) {
                return reply.status(404).send({ status: 'error', error: 'NOT_FOUND', message: '题卡不存在' })
            }
            return reply.send({ status: 'ok', ...toQuestionMeta(updated) })
        } catch (err) {
            handleRouteError(err, req, reply, '题卡更新失败')
            return
        }
    })

    /**
     * DELETE /questions/:id
     */
    app.delete('/questions/:id', async (req: FastifyRequest, reply) => {
        const params = validateParams(questionIdParamsSchema, req, reply)
        if (!params) return

        try {
            const entity = repos.questions.findById(params.id)
            if (!entity) {
                return reply.status(404).send({ status: 'error', error: 'NOT_FOUND', message: '题卡不存在' })
            }
            repos.questions.delete(params.id)
            return reply.send({ status: 'ok', questionId: params.id, deleted: true })
        } catch (err) {
            handleRouteError(err, req, reply, '题卡删除失败')
            return
        }
    })

    /**
     * GET /questions/:id/verification
     *
     * 题卡五维质量数据：难度 / 区分度 / 知识点覆盖率 / 答案正确性 / 表述清晰度。
     *
     * 口径说明（教师看到的每个数字都必须能解释来源）：
     * - difficulty：题卡难度档位归一化到 0–1
     * - discrimination：基于该题真实作答记录计算的高低分组通过率差；
     *   作答样本不足 6 条时不编造区分度，返回 0 并置 sampleSize=0，
     *   前端据此显示「样本不足」而非一个看似精确的假数字
     * - coverage：知识点数量相对目标值（3 个）的覆盖百分比
     * - correctness：答案字段非空且选择题答案落在选项集合内
     * - clarity：题干长度与结构的可读性启发式评分
     */
    app.get('/questions/:id/verification', async (req: FastifyRequest, reply) => {
        const params = validateParams(questionIdParamsSchema, req, reply)
        if (!params) return

        try {
            const entity = repos.questions.findById(params.id)
            if (!entity) {
                return reply.status(404).send({ status: 'error', error: 'NOT_FOUND', message: '题卡不存在' })
            }

            const meta = (entity.metadata ?? {}) as QuestionBankMeta
            const difficultyLevel = normalizeDifficulty(entity.difficulty)
            const difficulty = Number((difficultyLevel / 5).toFixed(2))

            // 真实作答样本（answers 表按 question_id 聚合）
            const rows = repos.answers.findByQuestionId(entity.id)
            const sampleSize = rows.length
            let discrimination = 0
            if (sampleSize >= 6) {
                // 高低分组按 partialScore 排序（无分值时用 correct 折算 1/0）
                const scoreOf = (r: (typeof rows)[number]): number =>
                    typeof r.partialScore === 'number' ? r.partialScore : r.correct ? 1 : 0
                const sorted = [...rows].sort((a, b) => scoreOf(b) - scoreOf(a))
                const groupSize = Math.max(1, Math.floor(sampleSize * 0.27))
                const high = sorted.slice(0, groupSize)
                const low = sorted.slice(-groupSize)
                const rate = (arr: typeof rows) =>
                    arr.filter((r) => r.correct === true).length / Math.max(1, arr.length)
                discrimination = Number(Math.max(0, Math.min(1, rate(high) - rate(low))).toFixed(2))
            }

            const knowledgePoints = deriveKnowledgePoints(entity, meta)
            const coverage = Math.min(100, Math.round((knowledgePoints.length / 3) * 100))

            const answerText = (entity.answer ?? '').trim()
            const correctness =
                answerText.length > 0 &&
                (entity.type !== '选择' ||
                    !entity.options ||
                    entity.options.length === 0 ||
                    entity.options.some((o) => o.trim() === answerText || answerText.includes(o.trim())))

            const stem = (entity.stem ?? '').trim()
            const lengthScore = stem.length >= 10 && stem.length <= 120 ? 100 : stem.length < 10 ? 45 : 70
            const hasPunctuation = /[，。？；：、]/.test(stem)
            const clarity = Math.min(100, Math.round(lengthScore * 0.8 + (hasPunctuation ? 20 : 0)))

            const overallScore = Math.round(
                coverage * 0.25 +
                clarity * 0.25 +
                (correctness ? 100 : 30) * 0.3 +
                (sampleSize >= 6 ? discrimination * 100 : 60) * 0.2,
            )

            return reply.send({
                status: 'ok',
                questionId: entity.id,
                difficulty,
                discrimination,
                coverage,
                correctness,
                clarity,
                overallScore,
                /** 区分度样本量：0 表示尚无足够作答记录，前端应显示「样本不足」 */
                sampleSize,
                verifiedAt: Date.now(),
            })
        } catch (err) {
            handleRouteError(err, req, reply, '题卡质量验证失败')
            return
        }
    })

    /**
     * POST /smart-compose
     *
     * 智能组卷：按难度分布 + 知识点覆盖 + 总分从题库中选题。
     *
     * 采用确定性的贪心选题而非 LLM 生成——组卷的本质是「从既有题库里挑」，
     * 让大模型凭空生成会产出题库里不存在的题卡 ID，教师后续无法编辑/发布。
     */
    app.post('/smart-compose', async (req: FastifyRequest, reply) => {
        const body = validateBody(smartComposeSchema, req, reply)
        if (!body) return

        try {
            let pool = repos.questions.findAll(5000)
            if (body.poemId) pool = pool.filter((e) => e.poemId === body.poemId)

            if (pool.length === 0) {
                return reply.status(404).send({
                    status: 'error',
                    error: 'EMPTY_QUESTION_BANK',
                    message: '题库为空，请先在命题工坊生成题目',
                })
            }

            const metas = pool.map(toQuestionMeta)

            // 难度分档：1-2 易 / 3 中 / 4-5 难
            const bucketOf = (d: number): 'easy' | 'medium' | 'hard' =>
                d <= 2 ? 'easy' : d === 3 ? 'medium' : 'hard'

            const dist = body.difficultyDistribution
            const quota = {
                easy: Math.round((dist.easy / 100) * body.totalCount),
                medium: Math.round((dist.medium / 100) * body.totalCount),
                hard: Math.round((dist.hard / 100) * body.totalCount),
            }
            // 四舍五入误差修正，保证总数严格等于 totalCount
            let drift = body.totalCount - (quota.easy + quota.medium + quota.hard)
            while (drift !== 0) {
                const key = drift > 0 ? 'medium' : quota.medium > 0 ? 'medium' : 'easy'
                quota[key] += drift > 0 ? 1 : -1
                drift += drift > 0 ? -1 : 1
            }

            // 命中目标知识点的题优先
            const wanted = body.knowledgePoints.map((k) => k.toLowerCase())
            const hitCount = (m: Record<string, unknown>): number =>
                wanted.length === 0
                    ? 0
                    : (m['knowledgePoints'] as string[]).filter((k) =>
                        wanted.some((w) => k.toLowerCase().includes(w) || w.includes(k.toLowerCase())),
                    ).length

            const paper: Array<Record<string, unknown>> = []
            for (const bucket of ['easy', 'medium', 'hard'] as const) {
                const candidates = metas
                    .filter((m) => bucketOf(m['difficulty'] as number) === bucket)
                    .sort((a, b) => hitCount(b) - hitCount(a) || (b['createdAt'] as number) - (a['createdAt'] as number))
                paper.push(...candidates.slice(0, quota[bucket]))
            }

            // 某档题量不足时，从其余题中补齐，保证交付的题量与教师要求一致
            if (paper.length < body.totalCount) {
                const picked = new Set(paper.map((m) => m['id'] as string))
                const filler = metas
                    .filter((m) => !picked.has(m['id'] as string))
                    .sort((a, b) => hitCount(b) - hitCount(a))
                paper.push(...filler.slice(0, body.totalCount - paper.length))
            }

            // 按总分等分摊到每道题（保留 1 位小数，末题吸收舍入误差）
            const perScore = paper.length > 0 ? body.totalScore / paper.length : 0
            const scored: Array<Record<string, unknown>> = paper.map((m, i) => ({
                ...m,
                score:
                    i === paper.length - 1
                        ? Number((body.totalScore - Number((perScore).toFixed(1)) * (paper.length - 1)).toFixed(1))
                        : Number(perScore.toFixed(1)),
            }))

            const coveredKp = new Set<string>()
            for (const m of scored) {
                for (const k of m['knowledgePoints'] as string[]) {
                    if (wanted.some((w) => k.toLowerCase().includes(w) || w.includes(k.toLowerCase()))) {
                        coveredKp.add(k.toLowerCase())
                    }
                }
            }
            const coverage = wanted.length === 0
                ? 100
                : Math.min(100, Math.round((coveredKp.size / wanted.length) * 100))

            const difficultyChart = { easy: 0, medium: 0, hard: 0 }
            for (const m of scored) difficultyChart[bucketOf(m['difficulty'] as number)] += 1

            return reply.send({
                status: 'ok',
                paper: scored,
                coverage,
                difficultyChart,
                totalScore: body.totalScore,
            })
        } catch (err) {
            handleRouteError(err, req, reply, '智能组卷失败')
            return
        }
    })

    /**
     * POST /export
     *
     * 导出题目。JSON/CSV 保持历史 JSON 响应；Word/Excel/PDF 工作流返回
     * 与真实 MIME/扩展名一致的文件流（.doc/.csv/打印版 .html）。
     */
    app.post(
        '/export',
        async (req: FastifyRequest, reply) => {
            const body = validateBody(exportSchema, req, reply)
            if (!body) return
            const { questionIds, format } = body

            const entities: QuestionEntity[] = []
            for (const id of questionIds) {
                const entity = repos.questions.findById(id)
                if (entity) entities.push(entity)
            }

            if (entities.length === 0) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: '未找到任何题目',
                })
            }

            if (format === 'word' || format === 'excel' || format === 'pdf') {
                const artifact = buildQuestionExport(entities, format as QuestionDocumentFormat, {
                    includeAnswer: body.includeAnswer ?? true,
                    includeAnalysis: body.includeAnalysis ?? true,
                    layout: body.layout ?? 'A4',
                })
                return reply
                    .type(artifact.mimeType)
                    .header(
                        'Content-Disposition',
                        `attachment; filename="question-export-${Date.now()}.${artifact.extension}"`,
                    )
                    .send(artifact.content)
            }

            const data = format === 'json'
                ? JSON.stringify(entities, null, 2)
                : questionsToCsv(entities)

            return reply.send({
                format,
                count: entities.length,
                data,
                aiGenerated: true,
            })
        },
    )

    /**
     * POST /publish
     *
     * 将题目发布为课堂闯关任务：题目落库（幂等）+ 创建课程。
     */
    app.post(
        '/publish',
        async (req: FastifyRequest, reply) => {
            const body = validateBody(publishSchema, req, reply)
            if (!body) return
            const { classId, poemId, teacherId, questions, mode, scheduledAt } = body

            // 题目落库（幂等：已存在则跳过）
            const savedIds: string[] = []
            for (const q of questions) {
                const existing = repos.questions.findById(q.id)
                if (existing) {
                    savedIds.push(existing.id)
                    continue
                }
                const createInput = questionToCreateInput(q, teacherId, poemId)
                const created = repos.questions.create(createInput)
                savedIds.push(created.id)
            }

            // 创建课程
            const lessonInput: CreateLessonInput = {
                classId,
                poemId,
                teacherId,
                mode,
                status: 'planned',
                scheduledAt: scheduledAt ?? null,
                metadata: { questionIds: savedIds, source: 'workbench' },
            }
            const lesson = repos.lessons.create(lessonInput)

            app.log.info(
                { lessonId: lesson.id, questionCount: savedIds.length, mode },
                '[workbench/publish] 已发布闯关任务',
            )

            return reply.send({
                lessonId: lesson.id,
                questionIds: savedIds,
                aiGenerated: true,
            })
        },
    )
}

// ─────────────────────────────────────────────────────────────
// 核心生成闭环
// ─────────────────────────────────────────────────────────────

/**
 * 执行"生成→验收→修订"闭环
 *
 * 流程：
 *   1. brush.question 生成题目（携带 teacherIntent 反馈，首轮为空）
 *   2. mind.verify 独立验收
 *   3. 若 verdict !== 'reject'，结束并落库
 *   4. 若 reject 且未超 MAX_VERIFY_RETRIES，携带验收反馈重新生成
 *
 * 全程通过 WebSocket 推送 task:start / task:done / task:failed 事件。
 */
async function executeGenerationLoop(
    sessionId: string,
    body: z.infer<typeof generateSchema>,
    sessionStore: SessionStore,
    broadcaster: WSBroadcaster,
    log: FastifyInstance['log'],
): Promise<WorkbenchResult> {
    const {
        poemId,
        gradeLevel,
        questionTypes,
        bloomWeights,
        count,
        teacherId,
        excludeUsedQuestions,
    } = body

    const poemNode = await loadPoemNode(poemId)

    let retryCount = 0
    let lastVerification: VerifyOutput | undefined
    let lastCoverage: BloomMastery | undefined
    let lastQuestions: Question[] = []

    while (retryCount <= MAX_VERIFY_RETRIES) {
        // ── 阶段 1：brush.question 生成 ──
        const questionTaskId = `gen-brush-question-${retryCount}`
        broadcastTaskStart(broadcaster, sessionId, questionTaskId, 'brush.question')

        const questionCtx: AgentContext = {
            taskId: questionTaskId,
            sessionId,
            knowledgeGraphNodes: poemNode ? [poemNode] : [],
            teacherIntent: retryCount > 0 && lastVerification
                ? JSON.stringify({
                    mode: 'regenerate',
                    reason: '上一轮验收未通过',
                    verdict: lastVerification.verdict,
                    score: lastVerification.score,
                    issues: lastVerification.issues,
                })
                : undefined,
        }

        const questionInput: QuestionInput = {
            poemId,
            gradeLevel,
            questionTypes,
            bloomWeights,
            count,
            excludeUsedQuestions,
        }

        let questionOutput: QuestionOutput
        try {
            const questionResult = await agents.brush.question.invoke(questionInput, questionCtx)
            questionOutput = questionResult.output as QuestionOutput
            lastQuestions = questionOutput.questions
            lastCoverage = questionOutput.coverage

            const questionTask: SubTask = {
                id: questionTaskId,
                agentId: 'brush.question',
                input: questionInput,
                dependencies: [],
                status: 'success',
                result: questionOutput,
                startedAt: Date.now(),
                endedAt: Date.now(),
            }
            sessionStore.updateTaskState(sessionId, questionTask)
            broadcastTaskDone(broadcaster, sessionId, questionTask)
        } catch (err) {
            const questionTask: SubTask = {
                id: questionTaskId,
                agentId: 'brush.question',
                input: questionInput,
                dependencies: [],
                status: 'failed',
                error: '题目生成失败',
                startedAt: Date.now(),
                endedAt: Date.now(),
            }
            sessionStore.updateTaskState(sessionId, questionTask)
            broadcastTaskFailed(broadcaster, sessionId, questionTask)
            throw err
        }

        // ── 阶段 2：mind.verify 验收 ──
        const verifyTaskId = `gen-mind-verify-${retryCount}`
        broadcastTaskStart(broadcaster, sessionId, verifyTaskId, 'mind.verify')

        const verifyInput: VerifyInput = {
            targetAgentId: 'brush.question',
            targetOutput: questionOutput,
            originalInput: {
                poemId,
                gradeLevel,
                questionTypes,
                bloomWeights,
                count,
            },
            criteria: VERIFY_CRITERIA,
        }

        const verifyCtx: AgentContext = {
            taskId: verifyTaskId,
            sessionId,
            knowledgeGraphNodes: poemNode ? [poemNode] : [],
        }

        try {
            const verifyResult = await agents.mind.verify.invoke(verifyInput, verifyCtx)
            lastVerification = verifyResult.output as VerifyOutput

            const verifyTask: SubTask = {
                id: verifyTaskId,
                agentId: 'mind.verify',
                input: verifyInput,
                dependencies: [questionTaskId],
                status: 'success',
                result: lastVerification,
                startedAt: Date.now(),
                endedAt: Date.now(),
            }
            sessionStore.updateTaskState(sessionId, verifyTask)
            broadcastTaskDone(broadcaster, sessionId, verifyTask)
        } catch (err) {
            const verifyTask: SubTask = {
                id: verifyTaskId,
                agentId: 'mind.verify',
                input: verifyInput,
                dependencies: [questionTaskId],
                status: 'failed',
                error: '验收失败',
                startedAt: Date.now(),
                endedAt: Date.now(),
            }
            sessionStore.updateTaskState(sessionId, verifyTask)
            broadcastTaskFailed(broadcaster, sessionId, verifyTask)
            log.warn({ err, sessionId }, '[workbench] 验收失败，采用未验收结果降级返回')
            // 验收失败不阻断，降级返回生成结果
            break
        }

        // ── 阶段 3：决策 ──
        if (lastVerification.verdict !== 'reject') {
            // pass 或 revise：结束
            break
        }

        retryCount += 1
        if (retryCount > MAX_VERIFY_RETRIES) {
            log.warn(
                { sessionId, verdict: lastVerification.verdict, score: lastVerification.score },
                '[workbench] 验收仍为 reject，已达最大重试次数，降级返回',
            )
            break
        }
    }

    // 落库（幂等）
    // 单题落库失败不能让整批已生成的题目一起丢失——记日志跳过该题，其余照常入库。
    const finalQuestions = lastQuestions
    for (const q of finalQuestions) {
        const existing = repos.questions.findById(q.id)
        if (!existing) {
            try {
                repos.questions.create(questionToCreateInput(q, teacherId, poemId))
            } catch (err) {
                log.warn({ err, sessionId, questionId: q.id }, '[workbench] 题目落库失败，已跳过该题')
            }
        }
    }

    sessionStore.setStatus(sessionId, 'completed')
    const genBilling = billing.aggregateSession(sessionId)
    broadcast(broadcaster, {
        type: ORCH_EVENTS.SESSION_END,
        timestamp: Date.now(),
        sessionId,
        payload: {
            status: 'completed',
            questionCount: finalQuestions.length,
            verdict: lastVerification?.verdict,
            score: lastVerification?.score,
            totalCostYuan: genBilling.totalCostYuan,
            tokenUsage: genBilling.tokenUsage,
        },
    })

    return {
        questions: finalQuestions,
        verification: lastVerification as VerifyOutput,
        coverage: lastCoverage as BloomMastery,
    }
}

// ─────────────────────────────────────────────────────────────
// Agent 编排 SSE（POST /api/agents/orchestrate）
// ─────────────────────────────────────────────────────────────

/** 命题工坊 UI 的 4 个 Agent 槽位标识（与前端 WorkbenchAgentKind 对齐） */
type AgentKind = 'question_generator' | 'verifier' | 'refiner' | 'accepter'

const AGENT_LABELS: Record<AgentKind, string> = {
    question_generator: '出题 Agent（brush.question）',
    verifier: '验证 Agent（mind.verify）',
    refiner: '精修 Agent（brush.question 复议轮）',
    accepter: '验收 Agent（终审落库）',
}

/** POST /agents/orchestrate 请求体 */
const orchestrateSchema = z.object({
    task: z.literal('question_generate'),
    params: generateSchema,
})

/**
 * Agent 编排路由（前缀 /api/agents）
 *
 * 与 `/api/workbench/generate` 的区别：
 * - `/generate` 是 fire-and-forget，进度走 WebSocket，适合多端同步观察
 * - 本端点是 SSE 单向流，进度直接回给发起命题的那个页面，
 *   命题工坊的「多智能体协作」面板依赖它逐帧渲染 4 个 Agent 的运行状态
 *
 * 四个槽位对应真实发生的工作，不做任何表演式的假进度：
 *   question_generator → brush.question 首轮生成
 *   verifier           → mind.verify 独立验收
 *   refiner            → 验收非 pass 时携带反馈的复议轮（pass 时明确标注「无需精修」）
 *   accepter           → 终审：题目落库 + 汇总验收结论
 */
export const agentOrchestrateRoutes: FastifyPluginAsync<WorkbenchRoutesOptions> = async (app, opts) => {
    const { sessionStore, broadcaster } = opts

    app.post('/orchestrate', async (req: FastifyRequest, reply) => {
        const body = validateBody(orchestrateSchema, req, reply)
        if (!body) return

        const params = body.params
        const authenticatedTeacherId = req.auth?.id
        if (!authenticatedTeacherId) {
            return reply.status(401).send({
                status: 'error',
                error: 'AUTHENTICATION_REQUIRED',
                message: '登录会话不存在、已过期或无效',
            })
        }
        if (params.teacherId !== authenticatedTeacherId) {
            return reply.status(403).send({
                status: 'error',
                error: 'TEACHER_SCOPE_MISMATCH',
                message: '请求教师范围与登录会话不一致',
            })
        }
        // 服务器会话是持久化主体的唯一真相源；后续落库不再信任客户端字段。
        const session = sessionStore.createSession(authenticatedTeacherId, params.classId)
        sessionStore.setStatus(session.id, 'executing')

        // 接管响应生命周期：必须在写 raw 之前调用，否则 Fastify 仍持有 reply，
        // onSend 钩子会与手写的 raw 响应相互干扰，客户端一个字节都收不到。
        reply.hijack()

        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, private, no-store, no-transform',
            Connection: 'keep-alive',
            // 关闭 Nginx 等反代的缓冲，否则 SSE 会被攒包后一次性下发，进度条会"卡住再瞬跳"
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        })

        const raw = reply.raw
        const abortController = new AbortController()
        const removeDisconnectHandlers = bindSseDisconnectAbort(req.raw, raw, abortController)
        const throwIfAborted = (): void => {
            if (!abortController.signal.aborted) return
            const error = new Error('多智能体编排已因客户端断开而取消')
            error.name = 'AbortError'
            throw error
        }
        const send = async (event: Record<string, unknown>): Promise<boolean> => {
            const delivered = await writeSseFrame(
                raw,
                { ...event, sessionId: session.id, timestamp: Date.now() },
                abortController.signal,
            )
            if (!delivered) abortController.abort()
            return delivered
        }

        const startAgent = async (agentId: AgentKind): Promise<number> => {
            throwIfAborted()
            const startedAt = Date.now()
            await send({ type: 'agent:start', agentId, agentLabel: AGENT_LABELS[agentId], status: 'running', progress: 0 })
            throwIfAborted()
            return startedAt
        }
        const progressAgent = async (agentId: AgentKind, progress: number, delta?: string): Promise<void> => {
            throwIfAborted()
            await send({ type: 'agent:progress', agentId, agentLabel: AGENT_LABELS[agentId], status: 'running', progress, ...(delta ? { delta } : {}) })
            throwIfAborted()
        }
        const doneAgent = async (agentId: AgentKind, startedAt: number, output?: string): Promise<void> => {
            throwIfAborted()
            await send({
                type: 'agent:done',
                agentId,
                agentLabel: AGENT_LABELS[agentId],
                status: 'success',
                progress: 100,
                elapsedMs: Date.now() - startedAt,
                ...(output ? { output } : {}),
            })
            throwIfAborted()
        }
        const failAgent = async (agentId: AgentKind, startedAt: number, error: string): Promise<void> => {
            throwIfAborted()
            await send({
                type: 'agent:failed',
                agentId,
                agentLabel: AGENT_LABELS[agentId],
                status: 'failed',
                error,
                elapsedMs: Date.now() - startedAt,
            })
            throwIfAborted()
        }

        try {
            const poemNode = await loadPoemNode(params.poemId)
            throwIfAborted()

            // ── 槽位 1：出题 ──
            const genStart = await startAgent('question_generator')
            await progressAgent('question_generator', 15, `正在为《${poemNode?.title ?? params.poemId}》按六阶权重生成 ${params.count} 道题…`)

            const questionInput: QuestionInput = {
                poemId: params.poemId,
                gradeLevel: params.gradeLevel,
                questionTypes: params.questionTypes,
                bloomWeights: params.bloomWeights,
                count: params.count,
                excludeUsedQuestions: params.excludeUsedQuestions,
            }
            let questionOutput: QuestionOutput
            try {
                const r = await agents.brush.question.invoke(questionInput, {
                    taskId: `orch-gen-${session.id}`,
                    sessionId: session.id,
                    knowledgeGraphNodes: poemNode ? [poemNode] : [],
                    signal: abortController.signal,
                })
                questionOutput = r.output as QuestionOutput
                await doneAgent('question_generator', genStart, `已生成 ${questionOutput.questions.length} 道题`)
            } catch (err) {
                await failAgent('question_generator', genStart, '题目生成失败')
                throw err
            }

            // ── 槽位 2：验收 ──
            const verStart = await startAgent('verifier')
            await progressAgent('verifier', 30, '诗心 Agent 正在按六维标准独立验收…')
            let verification: VerifyOutput | undefined
            try {
                const r = await agents.mind.verify.invoke(
                    {
                        targetAgentId: 'brush.question',
                        targetOutput: questionOutput,
                        originalInput: {
                            poemId: params.poemId,
                            gradeLevel: params.gradeLevel,
                            questionTypes: params.questionTypes,
                            bloomWeights: params.bloomWeights,
                            count: params.count,
                        },
                        criteria: VERIFY_CRITERIA,
                    } satisfies VerifyInput,
                    {
                        taskId: `orch-verify-${session.id}`,
                        sessionId: session.id,
                        knowledgeGraphNodes: poemNode ? [poemNode] : [],
                        signal: abortController.signal,
                    },
                )
                verification = r.output as VerifyOutput
                await doneAgent('verifier', verStart, `验收结论：${verification.verdict} · ${verification.score} 分`)
            } catch (err) {
                if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) throw err
                // 验收失败不阻断整体流程：降级为「未验收」并继续落库，与 /generate 的策略保持一致
                app.log.warn({ err, sessionId: session.id }, '[agents/orchestrate] 验收失败，降级继续')
                await failAgent('verifier', verStart, '验收失败，已降级为未验收结果')
            }

            // ── 槽位 3：精修（仅在验收非 pass 时真实执行） ──
            const refStart = await startAgent('refiner')
            let finalQuestions = questionOutput.questions
            if (verification && verification.verdict !== 'pass') {
                await progressAgent('refiner', 45, `验收判定「${verification.verdict}」，携带 ${verification.issues.length} 条问题反馈复议…`)
                try {
                    const r = await agents.brush.question.invoke(questionInput, {
                        taskId: `orch-refine-${session.id}`,
                        sessionId: session.id,
                        knowledgeGraphNodes: poemNode ? [poemNode] : [],
                        signal: abortController.signal,
                        teacherIntent: JSON.stringify({
                            mode: 'regenerate',
                            reason: '上一轮验收未通过',
                            verdict: verification.verdict,
                            score: verification.score,
                            issues: verification.issues,
                        }),
                    })
                    finalQuestions = (r.output as QuestionOutput).questions
                    await doneAgent('refiner', refStart, `已按验收意见重出 ${finalQuestions.length} 道题`)
                } catch (err) {
                    if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) throw err
                    app.log.warn({ err, sessionId: session.id }, '[agents/orchestrate] 精修轮失败，沿用首轮题目')
                    await failAgent('refiner', refStart, '精修失败，沿用首轮结果')
                }
            } else {
                // 不伪造一轮"精修"：验收通过时如实告知教师无需修订
                await doneAgent('refiner', refStart, '验收通过，本轮无需精修')
            }

            // ── 槽位 4：终审落库 ──
            const accStart = await startAgent('accepter')
            await progressAgent('accepter', 80, '题目落库并生成终审结论…')
            throwIfAborted()
            let persisted = 0
            for (const q of finalQuestions) {
                throwIfAborted()
                if (!repos.questions.findById(q.id)) {
                    try {
                        repos.questions.create(questionToCreateInput(q, authenticatedTeacherId, params.poemId))
                        persisted += 1
                    } catch (err) {
                        app.log.warn({ err, sessionId: session.id, questionId: q.id }, '[agents/orchestrate] 题目落库失败，已跳过该题')
                    }
                }
            }
            await doneAgent('accepter', accStart, `落库 ${persisted} 道（去重后），会话 ${session.id}`)

            const sessionBilling = billing.aggregateSession(session.id)
            const summaryDelivered = await send({
                type: 'session:end',
                status: 'success',
                progress: 100,
                output: JSON.stringify({
                    questionCount: finalQuestions.length,
                    persisted,
                    verdict: verification?.verdict ?? 'unverified',
                    score: verification?.score,
                    coverage: questionOutput.coverage,
                    totalCostYuan: sessionBilling.totalCostYuan,
                }),
            })
            const doneDelivered = summaryDelivered && await writeSseFrame(raw, '[DONE]', abortController.signal)
            if (!doneDelivered) {
                abortController.abort()
                throwIfAborted()
            }
            sessionStore.setStatus(session.id, 'completed')
            broadcast(broadcaster, {
                type: ORCH_EVENTS.SESSION_END,
                timestamp: Date.now(),
                sessionId: session.id,
                payload: {
                    status: 'completed',
                    questionCount: finalQuestions.length,
                    verdict: verification?.verdict,
                    score: verification?.score,
                    totalCostYuan: sessionBilling.totalCostYuan,
                    tokenUsage: sessionBilling.tokenUsage,
                },
            })
        } catch (err) {
            sessionStore.setStatus(session.id, 'aborted')
            if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
                app.log.info({ sessionId: session.id }, '[agents/orchestrate] 客户端断开，编排已取消')
            } else {
                app.log.error({ err, sessionId: session.id }, '[agents/orchestrate] 编排失败')
                const errorDelivered = await send({
                    type: 'session:error',
                    status: 'failed',
                    error: createPublicSseError('AGENT_ORCHESTRATION_FAILED', err).message,
                })
                if (errorDelivered) await writeSseFrame(raw, '[DONE]', abortController.signal)
            }
        } finally {
            removeDisconnectHandlers()
            if (!raw.writableEnded) raw.end()
        }
        return reply
    })
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

/** 广播事件 */
function broadcast(broadcaster: WSBroadcaster, event: WSEvent): void {
    broadcaster.broadcast(event)
}

/** 广播任务开始 */
function broadcastTaskStart(
    broadcaster: WSBroadcaster,
    sessionId: string,
    taskId: string,
    agentId: string,
): void {
    broadcast(broadcaster, {
        type: ORCH_EVENTS.TASK_START,
        timestamp: Date.now(),
        sessionId,
        payload: { taskId, agentId },
    })
}

/** 广播任务完成 */
function broadcastTaskDone(
    broadcaster: WSBroadcaster,
    sessionId: string,
    task: SubTask,
): void {
    broadcast(broadcaster, {
        type: ORCH_EVENTS.TASK_DONE,
        timestamp: Date.now(),
        sessionId,
        payload: {
            taskId: task.id,
            agentId: task.agentId,
            status: task.status,
            endedAt: task.endedAt,
        },
    })
}

/** 广播任务失败 */
function broadcastTaskFailed(
    broadcaster: WSBroadcaster,
    sessionId: string,
    task: SubTask,
): void {
    broadcast(broadcaster, {
        type: ORCH_EVENTS.TASK_FAILED,
        timestamp: Date.now(),
        sessionId,
        payload: {
            taskId: task.id,
            agentId: task.agentId,
            error: task.error,
            endedAt: task.endedAt,
        },
    })
}

/**
 * 从数据库加载诗词并转换为 PoemNode
 * 供 brush.question 的 knowledgeGraphNodes 上下文使用
 */
async function loadPoemNode(poemId: string): Promise<PoemNode | null> {
    try {
        const poem = repos.poems.findById(poemId)
        if (!poem) return null
        return {
            id: poem.id,
            title: poem.title,
            poet: poem.poet,
            dynasty: poem.dynasty,
            content: poem.content,
            theme: poem.theme,
            images: poem.images,
            gradeLevel: poem.gradeLevel ?? undefined,
            difficulty: poem.difficulty,
        }
    } catch {
        return null
    }
}

/**
 * 从 sessionStore.taskStates 提取最新的命题工坊结果
 * 取最后一次（retry 序号最大）的 brush.question 与 mind.verify 结果
 */
function extractWorkbenchResult(taskStates: Map<string, SubTask>): {
    questions: Question[]
    verification?: VerifyOutput
    coverage?: BloomMastery
} {
    let latestQuestionTask: SubTask | undefined
    let latestVerifyTask: SubTask | undefined

    for (const task of taskStates.values()) {
        if (task.agentId === 'brush.question' && task.status === 'success') {
            if (!latestQuestionTask || task.id > latestQuestionTask.id) {
                latestQuestionTask = task
            }
        }
        if (task.agentId === 'mind.verify' && task.status === 'success') {
            if (!latestVerifyTask || task.id > latestVerifyTask.id) {
                latestVerifyTask = task
            }
        }
    }

    const questionOutput = latestQuestionTask?.result as QuestionOutput | undefined
    const verification = latestVerifyTask?.result as VerifyOutput | undefined

    return {
        questions: questionOutput?.questions ?? [],
        verification,
        coverage: questionOutput?.coverage,
    }
}

/** Question 实体转 CreateQuestionInput */
/**
 * Question → 落库输入
 *
 * @param authoritativePoemId 教师在命题表单里选定的诗篇 ID
 *
 * 为什么不用 `q.poemId`：那是大模型回显的字段，实测会出现回写诗题
 * （如 "静夜思"）或自造 ID 的情况，直接落库会触发 questions.poem_id 的
 * 外键约束失败，让整批已生成好的题目全部丢失。教师选定的 poemId 才是权威值。
 */
function questionToCreateInput(q: Question, teacherId: string, authoritativePoemId: string): CreateQuestionInput {
    return {
        id: q.id,
        poemId: authoritativePoemId,
        bloomLevel: q.bloomLevel,
        type: q.type,
        stem: q.stem,
        options: q.options ?? null,
        answer: q.answer,
        analysis: q.analysis,
        distractorsAnalysis: q.distractorsAnalysis ?? null,
        difficulty: q.difficulty,
        estimatedTimeSec: q.estimatedTimeSec,
        aiGenerated: true,
        promptVersion: 'v1.0.0',
        createdBy: teacherId,
        metadata: null,
    }
}

// 显式标记未使用的导入（保持类型完整性，供未来扩展）
void (undefined as unknown as BloomLevel | VerifyIssue)
