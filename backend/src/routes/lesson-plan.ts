/**
 * 教案工坊路由（Phase 3）—— 数据驱动备课
 *
 * 4 个端点：
 * - GET  /list           教案列表
 * - GET  /:id            教案详情
 * - POST /generate       AI 生成教案（基于班级诊断数据）
 * - POST /save           保存教案
 *
 * 设计要点：
 * - 教案生成调用 brush.creative Agent（deepseek-v4-flash medium 思考）
 * - 生成依据（basis）从 mastery 表聚合班级诊断数据
 * - 教案持久化到 SQLite lesson_plans 表（SqliteMap）
 * - 所有 AI 生成内容标注 aiGenerated: true
 * - 生成失败时降级返回基于诗篇数据的模板教案，不阻塞教学流程
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { Orchestrator } from '../orchestrator/Orchestrator.js'
import type { SessionStore } from '../orchestrator/session-store.js'
import type { WSBroadcaster } from '../orchestrator/websocket/broadcaster.js'
import { ORCH_EVENTS, type WSEvent } from '../orchestrator/types.js'
import { agents } from '../agents/index.js'
import type { AgentContext, BloomLevel } from '../agents/base/types.js'
import type { CreativeInput, CreativeOutput } from '../agents/brush-agent/creative.sub-agent.js'
import { repos, db } from '../db/index.js'
import { generateId } from '../db/utils/id.js'
import { SqliteMap } from '../db/runtime-store.js'
import { handleRouteError } from './_helpers.js'
import { z } from 'zod'
import { validateBody, validateParams, validateQuery, schemas } from '../lib/validation.js'
// 闭环1补全：引入暗物质检测器，让教案依据包含认知盲区数据
import { DarkMatterDetector } from '../services/knowledge-graph/dark-matter-detector.js'
import { KnowledgeGraphService } from '../services/knowledge-graph/knowledge-graph-service.js'
import { config } from '../config.js'
// 智能备课 5 大能力服务
import { searchPoems, getPoemDetail } from '../services/lesson-plan/poem-search.js'
import { generateObjectives } from '../services/lesson-plan/objective-generator.js'
import { generateLayeredDesign } from '../services/lesson-plan/layered-design.js'
import {
    generateLesson,
    streamGenerateLesson,
    refineLessonParagraph,
    streamRefineLessonParagraph,
} from '../services/lesson-plan/lesson-generator.js'
import { getLessonResources } from '../services/lesson-plan/resource-scheduler.js'
import { bindSseDisconnectAbort, createPublicSseError, writeSseFrame } from '../lib/sse.js'

// ─────────────────────────────────────────────────────────────
// 类型定义（与前端 types.ts 对齐）
// ─────────────────────────────────────────────────────────────

export type CreationGradeLevel = '1-2年级' | '3-4年级' | '5-6年级'

export type LessonPlanStatus = 'draft' | 'published' | 'archived'

export type TeachingGoalCategory = 'knowledge' | 'ability' | 'emotion'

export interface TeachingGoal {
    category: TeachingGoalCategory
    bloomLevel: BloomLevel
    description: string
    assessment: string
}

export type TeachingPhaseType =
    | 'introduction'
    | 'literacy'
    | 'interpretation'
    | 'appreciation'
    | 'extension'
    | 'practice'
    | 'homework'

export interface TeachingProcessStep {
    phase: TeachingPhaseType
    title: string
    durationMin: number
    teacherActivity: string
    studentActivity: string
    designIntent: string
    bloomLevels: BloomLevel[]
    goalIndices: number[]
}

export interface BoardDesign {
    title: string
    content: string
    diagramUrl?: string
    intent: string
}

export type HomeworkType = 'dictation' | 'recitation' | 'creation' | 'investigation' | 'reading'

export interface HomeworkItem {
    type: HomeworkType
    description: string
    estimatedMin: number
    bloomLevel: BloomLevel
    optional: boolean
}

export interface TeachingReflection {
    classOverview: string
    highlights: string[]
    improvements: string[]
    adjustments: string[]
    commonMistakes: string[]
    aiGenerated: boolean
    generatedAt: number
}

export interface LessonPlan {
    id: string
    teacherId: string
    poemId: string
    poemTitle: string
    poet: string
    dynasty: string
    gradeLevel: CreationGradeLevel
    classId: string | null
    className?: string
    teacherName: string
    title: string
    lessonCount: 1 | 2 | 3
    goals: TeachingGoal[]
    keyPoints: string[]
    difficultPoints: string[]
    preparations: string[]
    teachingProcess: TeachingProcessStep[]
    boardDesign: BoardDesign
    homework: HomeworkItem[]
    reflection?: TeachingReflection
    status: LessonPlanStatus
    createdAt: number
    updatedAt: number
    aiGenerated: boolean
}

export interface LessonPlanListItem {
    id: string
    poemId: string
    poemTitle: string
    poet: string
    dynasty: string
    gradeLevel: CreationGradeLevel
    title: string
    lessonCount: 1 | 2 | 3
    status: LessonPlanStatus
    classId: string | null
    className?: string
    updatedAt: number
    aiGenerated: boolean
}

export interface LessonPlanGenerateRequest {
    poemId: string
    gradeLevel: CreationGradeLevel
    classId?: string
    includeReflection?: boolean
    lessonCount?: 1 | 2 | 3
}

export interface LessonPlanGenerateResponse {
    lessonPlan: LessonPlan
    basis: {
        weakBloomLevels: BloomLevel[]
        classAvgMastery: number
        studentCount: number
        dataSource: string
        /** 闭环1补全：暗物质数量（认知盲区），用于教案针对性调整 */
        darkMatterCount?: number
        /** 闭环1补全：班级今日错题待复习数，用于教案复习环节设计 */
        dueTodayErrorCount?: number
    }
    aiGenerated: true
}

export interface LessonPlanSaveResponse {
    lessonPlan: LessonPlan
    saved: boolean
    aiGenerated: false
}

export interface LessonPlanListResponse {
    lessonPlans: LessonPlanListItem[]
    total: number
}

export type LessonPlanExportFormat = 'markdown' | 'html' | 'word' | 'csv'

export interface LessonPlanExportOptions {
    includeReflection: boolean
    includeBoard: boolean
    includeHomework: boolean
}

export interface LessonPlanExportArtifact {
    content: string
    mimeType: string
}

export type LessonPlanExportRenderer = (
    plan: LessonPlan,
    format: LessonPlanExportFormat,
    options: LessonPlanExportOptions,
) => LessonPlanExportArtifact

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const BLOOM_LEVELS: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

/** 六阶薄弱阈值（低于此值视为薄弱） */
const WEAK_THRESHOLD = 60

// ─────────────────────────────────────────────────────────────
// 持久化存储
// ─────────────────────────────────────────────────────────────

/** 教案持久化存储 —— SQLite lesson_plans 表 */
const lessonPlanStore = new SqliteMap<string, LessonPlan>({
    table: 'lesson_plans',
    indexes: [
        { name: 'teacher_id', extract: (v) => v.teacherId },
        { name: 'class_id', extract: (v) => v.classId },
        { name: 'poem_id', extract: (v) => v.poemId },
    ],
})

// ─────────────────────────────────────────────────────────────
// Zod schemas（输入校验）
// ─────────────────────────────────────────────────────────────

const gradeLevelSchema = z.enum(['1-2年级', '3-4年级', '5-6年级'])

const lessonCountSchema = z.union([z.literal(1), z.literal(2), z.literal(3)])

/** POST /generate 请求体 */
const generateSchema = z.object({
    poemId: schemas.poemId,
    gradeLevel: gradeLevelSchema,
    classId: schemas.classId.optional(),
    includeReflection: z.boolean().optional(),
    lessonCount: lessonCountSchema.optional(),
})

/** POST /save 请求体（完整 LessonPlan） */
const saveSchema = z.object({
    id: schemas.id,
    poemId: schemas.poemId,
    poemTitle: schemas.sanitizedString(200),
    poet: schemas.sanitizedString(100),
    dynasty: schemas.sanitizedString(50),
    gradeLevel: gradeLevelSchema,
    classId: schemas.classId.optional(),
    className: schemas.optionalSanitizedString(100),
    teacherName: schemas.sanitizedString(100),
    title: schemas.sanitizedString(200),
    lessonCount: lessonCountSchema,
    goals: z.array(z.object({
        category: z.enum(['knowledge', 'ability', 'emotion']),
        bloomLevel: z.enum(['记忆', '理解', '应用', '分析', '评价', '创造']),
        description: schemas.sanitizedString(500),
        assessment: schemas.sanitizedString(500),
    })).min(1).max(20),
    keyPoints: z.array(schemas.sanitizedString(500)).max(20),
    difficultPoints: z.array(schemas.sanitizedString(500)).max(20),
    preparations: z.array(schemas.sanitizedString(500)).max(20),
    teachingProcess: z.array(z.object({
        phase: z.enum(['introduction', 'literacy', 'interpretation', 'appreciation', 'extension', 'practice', 'homework']),
        title: schemas.sanitizedString(200),
        durationMin: z.number().int().min(1).max(120),
        teacherActivity: schemas.sanitizedString(5000),
        studentActivity: schemas.sanitizedString(5000),
        designIntent: schemas.sanitizedString(2000),
        bloomLevels: z.array(z.enum(['记忆', '理解', '应用', '分析', '评价', '创造'])),
        goalIndices: z.array(z.number().int().min(0)),
    })).min(1).max(20),
    boardDesign: z.object({
        title: schemas.sanitizedString(200),
        content: schemas.sanitizedString(5000),
        diagramUrl: schemas.optionalSanitizedString(500),
        intent: schemas.sanitizedString(1000),
    }),
    homework: z.array(z.object({
        type: z.enum(['dictation', 'recitation', 'creation', 'investigation', 'reading']),
        description: schemas.sanitizedString(500),
        estimatedMin: z.number().int().min(1).max(180),
        bloomLevel: z.enum(['记忆', '理解', '应用', '分析', '评价', '创造']),
        optional: z.boolean(),
    })).max(20),
    status: z.enum(['draft', 'published', 'archived']),
    createdAt: z.number(),
    updatedAt: z.number(),
    aiGenerated: z.boolean(),
})

/** GET /:id 路径参数 */
const planIdParamsSchema = z.object({ id: schemas.id })

/** GET /templates 查询参数（可选按年级/课时过滤） */
const templatesQuerySchema = z.object({
    gradeLevel: z.enum(['1-2年级', '3-4年级', '5-6年级']).optional(),
    lessonCount: z.coerce.number().int().min(1).max(3).optional(),
})

/** POST /:id/export 请求体 */
const exportBodySchema = z.object({
    format: z.enum(['markdown', 'html', 'word', 'csv']),
    /** 是否包含教学反思 */
    includeReflection: z.boolean().default(true),
    /** 是否包含板书设计 */
    includeBoard: z.boolean().default(true),
    /** 是否包含作业 */
    includeHomework: z.boolean().default(true),
})

// ─────────────────────────────────────────────────────────────
// 智能备课 5 大能力 —— Zod schemas
// ─────────────────────────────────────────────────────────────

/** GET /poems/search 查询参数 */
const poemSearchQuerySchema = z.object({
    keyword: schemas.optionalSanitizedString(200),
    dynasty: schemas.optionalSanitizedString(50),
    poet: schemas.optionalSanitizedString(100),
    genre: schemas.optionalSanitizedString(50),
    subject: schemas.optionalSanitizedString(50),
    imagery: schemas.optionalSanitizedString(50),
    gradeLevel: z.enum(['1-2年级', '3-4年级', '5-6年级']).optional(),
    difficulty: z.coerce.number().int().min(1).max(5).optional(),
    semanticQuery: schemas.optionalSanitizedString(500),
    limit: z.coerce.number().int().positive().max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
})

/** GET /poems/:id/detail 路径参数 */
const poemDetailParamsSchema = z.object({ id: schemas.poemId })

/** POST /objectives/generate 请求体 */
const objectiveGenerateSchema = z.object({
    poemId: schemas.poemId,
    gradeLevel: gradeLevelSchema,
    lessonCount: lessonCountSchema,
    weakBloomLevels: z.array(z.enum(['记忆', '理解', '应用', '分析', '评价', '创造'])).max(6).optional(),
    teacherPreference: schemas.optionalSanitizedString(500),
})

/** POST /layered-design/generate 请求体 */
const layeredDesignSchema = z.object({
    poemId: schemas.poemId,
    classId: schemas.classId.optional(),
    objectiveIds: z.array(schemas.id).max(30).optional(),
    layerRatio: z.object({
        basic: z.number().min(0).max(1),
        intermediate: z.number().min(0).max(1),
        advanced: z.number().min(0).max(1),
    }).optional(),
})

/** POST /lessons/generate 请求体 */
const lessonGenerateSchema = z.object({
    poemId: schemas.poemId,
    gradeLevel: gradeLevelSchema,
    lessonCount: lessonCountSchema,
    objectives: z.array(z.object({
        bloomLevel: z.enum(['记忆', '理解', '应用', '分析', '评价', '创造']),
        category: z.enum(['knowledge', 'ability', 'emotion']),
        description: schemas.sanitizedString(300),
        assessment: schemas.sanitizedString(300),
    })).min(1).max(20),
    layeredDesignSummary: z.object({
        basicCount: z.number().int().min(0),
        intermediateCount: z.number().int().min(0),
        advancedCount: z.number().int().min(0),
        focusAreas: z.array(schemas.sanitizedString(200)).max(10),
    }).optional(),
    teacherPreference: z.object({
        teachingStyle: schemas.optionalSanitizedString(100),
        timeAllocation: schemas.optionalSanitizedString(200),
        specialRequirements: schemas.optionalSanitizedString(500),
    }).optional(),
    classId: schemas.classId.optional(),
    /** 是否流式输出（true=SSE，false=JSON），默认 false */
    stream: z.boolean().optional(),
})

/** POST /lessons/:id/refine 请求体 */
const lessonRefineSchema = z.object({
    lessonId: schemas.id,
    targetSection: z.object({
        type: z.enum(['phase', 'board', 'homework', 'goals', 'keyPoints', 'difficultPoints']),
        phaseIndex: z.number().int().min(0).max(20).optional(),
        field: z.enum(['teacherScript', 'studentScript', 'presetQuestions', 'aiSynergyPoints', 'designIntent', 'layerTips']).optional(),
    }),
    originalContent: schemas.sanitizedString(5000),
    refineInstruction: schemas.sanitizedString(1000),
    context: z.object({
        poemTitle: schemas.optionalSanitizedString(200),
        gradeLevel: gradeLevelSchema.optional(),
    }).optional(),
    /** 是否流式输出（true=SSE，false=JSON），默认 false */
    stream: z.boolean().optional(),
})

/** GET /lessons/:id/resources 路径参数 + 查询参数 */
const lessonResourcesParamsSchema = z.object({ id: schemas.id })
const lessonResourcesQuerySchema = z.object({
    poemId: schemas.poemId,
})

// ─────────────────────────────────────────────────────────────
// 路由插件选项
// ─────────────────────────────────────────────────────────────

export interface LessonPlanRoutesOptions {
    orchestrator: Orchestrator
    sessionStore: SessionStore
    broadcaster: WSBroadcaster
    /** 默认走受控内置渲染器；显式注入点用于隔离验证导出错误边界。 */
    renderExport?: LessonPlanExportRenderer
}

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

export const lessonPlanRoutes: FastifyPluginAsync<LessonPlanRoutesOptions> = async (
    app: FastifyInstance,
    opts,
) => {
    const { broadcaster } = opts
    const renderExport = opts.renderExport ?? renderLessonPlanExport

    /** 广播教案事件 */
    function broadcast(type: string, payload: Record<string, unknown>): void {
        const event: WSEvent = {
            type,
            timestamp: Date.now(),
            sessionId: 'lesson-plan',
            payload,
        }
        broadcaster.broadcast(event)
    }

    // ── GET /templates — 教案模板列表（SubTask 14.3） ──
    // 静态路径在动态路径 /:id 之前声明，避免被 /:id 匹配
    app.get('/templates', async (req: FastifyRequest, reply) => {
        const query = validateQuery(templatesQuerySchema, req, reply)
        if (!query) return
        const { gradeLevel, lessonCount } = query

        try {
            let templates = LESSON_PLAN_TEMPLATES
            if (gradeLevel) {
                templates = templates.filter((t) => t.gradeLevel === gradeLevel)
            }
            if (lessonCount) {
                templates = templates.filter((t) => t.lessonCount === lessonCount)
            }
            return reply.send({
                templates,
                total: templates.length,
                aiGenerated: false as const,
            })
        } catch (err) {
            req.log.error({ err, path: req.url }, '教案模板列表查询失败，返回显式空态')
            return reply.send({
                templates: [],
                total: 0,
                aiGenerated: false as const,
            })
        }
    })

    // ── GET /list — 教案列表 ──
    app.get('/list', async (req: FastifyRequest, reply) => {
        try {
            const plans: LessonPlan[] = []
            for (const [, plan] of lessonPlanStore) {
                if (plan.teacherId === req.auth!.id) plans.push(plan)
            }
            // 按更新时间降序
            plans.sort((a, b) => b.updatedAt - a.updatedAt)

            const items: LessonPlanListItem[] = plans.map((p) => ({
                id: p.id,
                poemId: p.poemId,
                poemTitle: p.poemTitle,
                poet: p.poet,
                dynasty: p.dynasty,
                gradeLevel: p.gradeLevel,
                title: p.title,
                lessonCount: p.lessonCount,
                status: p.status,
                classId: p.classId,
                className: p.className,
                updatedAt: p.updatedAt,
                aiGenerated: p.aiGenerated,
            }))

            return reply.send({
                lessonPlans: items,
                total: items.length,
            })
        } catch (err) {
            handleRouteError(err, req, reply, '教案列表查询失败')
            return
        }
    })

    // ── GET /:id — 教案详情 ──
    app.get('/:id', async (req: FastifyRequest, reply) => {
        const params = validateParams(planIdParamsSchema, req, reply)
        if (!params) return
        const { id } = params

        try {
            const plan = lessonPlanStore.get(id)
            if (!plan) {
                return reply.status(404).send({ status: 'error', message: '教案不存在' })
            }
            if (plan.teacherId !== req.auth!.id) {
                return reply.status(403).send({ status: 'error', message: '教案不属于当前教师' })
            }
            return reply.send(plan)
        } catch (err) {
            handleRouteError(err, req, reply, '教案详情查询失败')
            return
        }
    })

    // ── POST /generate — AI 生成教案 ──
    app.post('/generate', async (req: FastifyRequest, reply) => {
        const body = validateBody(generateSchema, req, reply)
        if (!body) return

        const { poemId, gradeLevel, classId, includeReflection, lessonCount } = body

        // 校验古诗存在
        const poem = repos.poems.findById(poemId)
        if (!poem) {
            return reply.status(404).send({ status: 'error', message: '古诗不存在' })
        }

        // 聚合班级诊断数据（basis）
        const basis = await computeBasis(classId, poemId)

        // 调用 brush.creative 生成教学素材
        const ctx: AgentContext = {
            taskId: `lesson-plan-${generateId()}`,
            sessionId: 'lesson-plan',
        }

        const creativeInput: CreativeInput = {
            type: 'cultural-story',
            poemId,
            topic: `为古诗「${poem.title}」(${poem.poet})生成${gradeLevel}教案所需的教学素材：创作背景、文化内涵、意象分析、教学重点提示`,
            gradeLevel: gradeLevel as CreativeInput['gradeLevel'],
            constraints: [
                '内容需涵盖诗人创作背景与时代风貌',
                '分析核心意象及其文化内涵',
                '提供适合小学课堂的教学切入点',
                `语言风格适配${gradeLevel}学生`,
                ...(basis.weakBloomLevels.length > 0
                    ? [`针对班级薄弱层级${basis.weakBloomLevels.join('、')}强化教学设计`]
                    : []),
            ],
        }

        let aiContent = ''
        let aiGenerated = false
        try {
            const result = await agents.brush.creative.invoke(creativeInput, ctx)
            const output = result.output as CreativeOutput
            aiContent = output.content
            aiGenerated = true
        } catch (err) {
            req.log.warn({ err }, '教案 AI 生成降级：使用模板内容')
            aiContent = `${poem.poet}的《${poem.title}》创作于${poem.dynasty}时期，表达了诗人深厚的情感与独特的审美追求。`
        }

        // 构建结构化教案
        const plan = buildLessonPlan(
            poem,
            gradeLevel,
            classId,
            aiContent,
            aiGenerated,
            lessonCount ?? 1,
            includeReflection ?? false,
            basis,
            req.auth!.id,
        )

        // 持久化
        lessonPlanStore.set(plan.id, plan)

        // 广播生成完成事件
        broadcast(ORCH_EVENTS.TASK_DONE, {
            taskId: ctx.taskId,
            type: 'lesson-plan:generated',
            planId: plan.id,
            poemId: plan.poemId,
        })

        return reply.send({
            lessonPlan: plan,
            basis: {
                weakBloomLevels: basis.weakBloomLevels,
                classAvgMastery: basis.classAvgMastery,
                studentCount: basis.studentCount,
                dataSource: basis.dataSource,
                // 闭环1补全：返回暗物质和错题复习数据
                darkMatterCount: basis.darkMatterCount,
                dueTodayErrorCount: basis.dueTodayErrorCount,
            },
            aiGenerated: true as const,
        })
    })

    // ── POST /save — 保存教案 ──
    app.post('/save', async (req: FastifyRequest, reply) => {
        const body = validateBody(saveSchema, req, reply)
        if (!body) return

        try {
            const now = Date.now()
            const plan: LessonPlan = {
                ...body,
                teacherId: req.auth!.id,
                classId: body.classId ?? null,
                updatedAt: now,
            }
            // 保留原 createdAt（若已存在）
            const existing = lessonPlanStore.get(plan.id)
            if (existing) {
                if (existing.teacherId !== req.auth!.id) {
                    return reply.status(403).send({ status: 'error', message: '教案不属于当前教师' })
                }
                plan.createdAt = existing.createdAt
            }

            lessonPlanStore.set(plan.id, plan)

            return reply.send({
                lessonPlan: plan,
                saved: true,
                aiGenerated: false as const,
            })
        } catch (err) {
            handleRouteError(err, req, reply, '教案保存失败')
            return
        }
    })

    // ═══════════════════════════════════════════════════════════
    // 智能备课 5 大能力端点
    // ═══════════════════════════════════════════════════════════

    // ── GET /poems/search — 诗歌库智能检索（能力1） ──
    app.get('/poems/search', async (req: FastifyRequest, reply) => {
        const query = validateQuery(poemSearchQuerySchema, req, reply)
        if (!query) return

        try {
            const results = await searchPoems({
                keyword: query.keyword,
                dynasty: query.dynasty,
                poet: query.poet,
                genre: query.genre,
                subject: query.subject,
                imagery: query.imagery,
                gradeLevel: query.gradeLevel,
                difficulty: query.difficulty,
                semanticQuery: query.semanticQuery,
                limit: query.limit,
                offset: query.offset,
            })

            return reply.send({
                results,
                total: results.length,
            })
        } catch (err) {
            handleRouteError(err, req, reply, '诗歌检索失败')
            return
        }
    })

    // ── GET /poems/:id/detail — 诗歌详情（能力1） ──
    app.get('/poems/:id/detail', async (req: FastifyRequest, reply) => {
        const params = validateParams(poemDetailParamsSchema, req, reply)
        if (!params) return
        const { id } = params

        try {
            const detail = await getPoemDetail(id)
            if (!detail) {
                return reply.status(404).send({ status: 'error', message: '诗歌不存在' })
            }
            return reply.send(detail)
        } catch (err) {
            handleRouteError(err, req, reply, '诗歌详情查询失败')
            return
        }
    })

    // ── POST /objectives/generate — 教学目标智能生成（能力2） ──
    app.post('/objectives/generate', async (req: FastifyRequest, reply) => {
        const body = validateBody(objectiveGenerateSchema, req, reply)
        if (!body) return

        try {
            const response = await generateObjectives({
                poemId: body.poemId,
                gradeLevel: body.gradeLevel,
                lessonCount: body.lessonCount,
                weakBloomLevels: body.weakBloomLevels,
                teacherPreference: body.teacherPreference,
            })

            broadcast('lesson-plan:objectives-generated', {
                poemId: body.poemId,
                gradeLevel: body.gradeLevel,
                objectiveCount: response.objectives.length,
                aiGenerated: response.aiGenerated,
            })

            return reply.send(response)
        } catch (err) {
            handleRouteError(err, req, reply, '教学目标生成失败')
            return
        }
    })

    // ── POST /layered-design/generate — 分层教学设计（能力3） ──
    app.post('/layered-design/generate', async (req: FastifyRequest, reply) => {
        const body = validateBody(layeredDesignSchema, req, reply)
        if (!body) return

        try {
            const response = await generateLayeredDesign({
                poemId: body.poemId,
                classId: body.classId,
                objectiveIds: body.objectiveIds,
                layerRatio: body.layerRatio,
            })

            broadcast('lesson-plan:layered-design-generated', {
                poemId: body.poemId,
                classId: body.classId,
                layerCount: response.layers.length,
                aiGenerated: response.aiGenerated,
            })

            return reply.send(response)
        } catch (err) {
            handleRouteError(err, req, reply, '分层教学设计生成失败')
            return
        }
    })

    // ── POST /lessons/generate — 教案AI生成（能力4，支持SSE流式） ──
    app.post('/lessons/generate', async (req: FastifyRequest, reply) => {
        const body = validateBody(lessonGenerateSchema, req, reply)
        if (!body) return

        const { stream: useStream, ...generateReq } = body

        // 非流式模式：直接返回 JSON
        if (!useStream) {
            try {
                const response = await generateLesson(generateReq)

                broadcast(ORCH_EVENTS.TASK_DONE, {
                    taskId: `lesson-gen-${generateId()}`,
                    type: 'lesson:generated',
                    poemId: generateReq.poemId,
                    aiGenerated: response.aiGenerated,
                })

                return reply.send(response)
            } catch (err) {
                handleRouteError(err, req, reply, '教案生成失败')
                return
            }
        }

        // 流式模式：SSE
        reply.hijack()
        const raw = reply.raw
        raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, private, no-store, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        })

        const abortController = new AbortController()
        const removeDisconnectHandlers = bindSseDisconnectAbort(req.raw, raw, abortController)
        const writeSSE = (payload: unknown) => writeSseFrame(raw, payload, abortController.signal)

        try {
            for await (const chunk of streamGenerateLesson(generateReq, abortController.signal)) {
                if (abortController.signal.aborted || !await writeSSE(chunk)) {
                    abortController.abort()
                    break
                }
            }
            const completedForClient = !abortController.signal.aborted && await writeSSE('[DONE]')
            if (completedForClient) {
                broadcast(ORCH_EVENTS.TASK_DONE, {
                    taskId: `lesson-gen-${generateId()}`,
                    type: 'lesson:generated',
                    poemId: generateReq.poemId,
                    stream: true,
                })
                req.log.info({ path: req.url }, 'SSE 教案流式生成完成')
            } else if (!abortController.signal.aborted) {
                abortController.abort()
            }
        } catch (err) {
            if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
                req.log.debug({ path: req.url }, '教案生成流被客户端中止')
            } else {
                req.log.error({ err, path: req.url }, 'SSE 教案流式生成失败')
                await writeSSE(createPublicSseError('LESSON_GENERATE_FAILED', err))
            }
        } finally {
            removeDisconnectHandlers()
            if (!raw.writableEnded) {
                raw.end()
            }
        }
    })

    // ── POST /lessons/:id/refine — 选段精修（能力4，支持SSE流式） ──
    app.post('/lessons/:id/refine', async (req: FastifyRequest, reply) => {
        const body = validateBody(lessonRefineSchema, req, reply)
        if (!body) return

        const { stream: useStream, ...refineReq } = body

        // 非流式模式
        if (!useStream) {
            try {
                const response = await refineLessonParagraph(refineReq)
                return reply.send(response)
            } catch (err) {
                handleRouteError(err, req, reply, '教案精修失败')
                return
            }
        }

        // 流式模式：SSE
        reply.hijack()
        const raw = reply.raw
        raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, private, no-store, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        })

        const abortController = new AbortController()
        const removeDisconnectHandlers = bindSseDisconnectAbort(req.raw, raw, abortController)
        const writeSSE = (payload: unknown) => writeSseFrame(raw, payload, abortController.signal)

        try {
            for await (const chunk of streamRefineLessonParagraph(refineReq, abortController.signal)) {
                if (abortController.signal.aborted || !await writeSSE(chunk)) {
                    abortController.abort()
                    break
                }
            }
            const completedForClient = !abortController.signal.aborted && await writeSSE('[DONE]')
            if (completedForClient) {
                req.log.info({ path: req.url, lessonId: refineReq.lessonId }, 'SSE 教案精修流式完成')
            } else if (!abortController.signal.aborted) {
                abortController.abort()
            }
        } catch (err) {
            if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
                req.log.debug({ path: req.url }, '教案精修流被客户端中止')
            } else {
                req.log.error({ err, path: req.url }, 'SSE 教案精修流式失败')
                await writeSSE(createPublicSseError('LESSON_REFINE_FAILED', err))
            }
        } finally {
            removeDisconnectHandlers()
            if (!raw.writableEnded) {
                raw.end()
            }
        }
    })

    // ── GET /lessons/:id/resources — 资源调度（能力5） ──
    app.get('/lessons/:id/resources', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonResourcesParamsSchema, req, reply)
        if (!params) return
        const query = validateQuery(lessonResourcesQuerySchema, req, reply)
        if (!query) return

        const { id: lessonId } = params
        const { poemId } = query

        try {
            const response = await getLessonResources(lessonId, poemId)
            return reply.send(response)
        } catch (err) {
            handleRouteError(err, req, reply, '资源调度失败')
            return
        }
    })

    // ── POST /:id/export — 导出教案（SubTask 14.3） ──
    app.post('/:id/export', async (req: FastifyRequest, reply) => {
        const params = validateParams(planIdParamsSchema, req, reply)
        if (!params) return
        const body = validateBody(exportBodySchema, req, reply)
        if (!body) return
        const { id } = params
        const { format, includeReflection = true, includeBoard = true, includeHomework = true } = body

        try {
            const plan = lessonPlanStore.get(id)
            if (!plan) {
                return reply.status(404).send({ status: 'error', message: '教案不存在' })
            }
            if (plan.teacherId !== req.auth!.id) {
                return reply.status(403).send({ status: 'error', message: '教案不属于当前教师' })
            }

            const exportId = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            const fileName = `${plan.title}-${plan.gradeLevel}`
            const now = Date.now()

            const { content, mimeType } = renderExport(plan, format, {
                includeReflection,
                includeBoard,
                includeHomework,
            })

            return reply.send({
                exportId,
                reportId: id,
                format,
                fileName,
                mimeType,
                content,
                generatedAt: now,
                success: true,
                aiGenerated: false as const,
            })
        } catch (err) {
            req.log.error({ err, path: req.url }, '教案导出失败')
            return reply.code(500).send({
                exportId: `exp-${Date.now()}-err`,
                reportId: id,
                format,
                fileName: '',
                mimeType: 'text/plain',
                content: '',
                generatedAt: Date.now(),
                success: false,
                error: '教案导出失败，请稍后重试',
                aiGenerated: false as const,
            })
        }
    })
}

// ─────────────────────────────────────────────────────────────
// 业务计算函数
// ─────────────────────────────────────────────────────────────

/**
 * 聚合班级诊断数据 —— 作为教案生成的依据
 *
 * 闭环1补全：除了 mastery 表数据外，还聚合：
 * 1. 认知暗物质数量（DarkMatterDetector 检测的盲区）
 * 2. 错题本今日待复习数（SM-2 算法到期错题）
 * 让教案生成依据从"仅掌握度"扩展为"掌握度+盲区+复习负担"三维数据。
 */
async function computeBasis(
    classId: string | undefined,
    _poemId: string,
): Promise<{
    weakBloomLevels: BloomLevel[]
    classAvgMastery: number
    studentCount: number
    dataSource: string
    darkMatterCount: number
    dueTodayErrorCount: number
}> {
    if (!classId) {
        return {
            weakBloomLevels: [],
            classAvgMastery: 0,
            studentCount: 0,
            dataSource: '未指定班级，使用通用教学数据',
            darkMatterCount: 0,
            dueTodayErrorCount: 0,
        }
    }

    try {
        const rows = db
            .prepare(
                `SELECT m.bloom_level AS bloom_level,
                        AVG(m.score) AS avg_score,
                        COUNT(DISTINCT m.student_id) AS student_count
                 FROM mastery m
                 JOIN students s ON m.student_id = s.id
                 WHERE s.class_id = ?
                 GROUP BY m.bloom_level`,
            )
            .all(classId) as Array<{
                bloom_level: string
                avg_score: number | null
                student_count: number
            }>

        if (rows.length === 0) {
            return {
                weakBloomLevels: [],
                classAvgMastery: 0,
                studentCount: 0,
                dataSource: '班级暂无诊断数据，使用通用教学数据',
                darkMatterCount: 0,
                dueTodayErrorCount: 0,
            }
        }

        const studentCount = rows[0]?.student_count ?? 0
        let totalAvg = 0
        const weakBloomLevels: BloomLevel[] = []

        for (const row of rows) {
            const avg = row.avg_score ?? 0
            totalAvg += avg
            if (avg < WEAK_THRESHOLD) {
                const level = BLOOM_LEVELS.find((l) => l === row.bloom_level)
                if (level) weakBloomLevels.push(level)
            }
        }

        const classAvgMastery = Math.round(totalAvg / rows.length)

        // 闭环1补全：聚合暗物质数量（容错降级，不阻塞教案生成）
        let darkMatterCount = 0
        try {
            const kgService = new KnowledgeGraphService(
                config.neo4j.uri,
                config.neo4j.user,
                config.neo4j.password,
            )
            const detector = new DarkMatterDetector(kgService)
            // 超时 1500ms 降级（不阻塞教案生成主流程）
            let timeoutTimer: NodeJS.Timeout | undefined
            try {
                const timeoutPromise = new Promise<never>((_, reject) => {
                    timeoutTimer = setTimeout(() => reject(new Error('dark-matter-timeout')), 1500)
                })
                const darkMatterList = await Promise.race([
                    detector.detectClassDarkMatter(classId),
                    timeoutPromise,
                ])
                darkMatterCount = darkMatterList.length
            } finally {
                if (timeoutTimer) clearTimeout(timeoutTimer)
                await kgService.close()
            }
        } catch {
            darkMatterCount = 0
        }

        // 闭环1补全：聚合错题本今日待复习数（容错降级）
        let dueTodayErrorCount = 0
        try {
            const nowMs = Date.now()
            const todayEnd = new Date()
            todayEnd.setHours(23, 59, 59, 999)
            const todayEndMs = todayEnd.getTime()
            const allItems = db
                .prepare('SELECT value FROM error_notebook_items')
                .all() as Array<{ value: string }>
            dueTodayErrorCount = allItems.filter((item) => {
                try {
                    const parsed = JSON.parse(item.value) as {
                        repetition?: { nextReviewDate?: number; mastered?: boolean }
                        studentId?: string
                    }
                    const sr = parsed.repetition
                    if (!sr || sr.mastered === true) return false
                    return sr.nextReviewDate !== undefined
                        && sr.nextReviewDate <= todayEndMs
                        && sr.nextReviewDate >= nowMs - 7 * 24 * 60 * 60 * 1000
                } catch {
                    return false
                }
            }).length
        } catch {
            dueTodayErrorCount = 0
        }

        return {
            weakBloomLevels,
            classAvgMastery,
            studentCount,
            dataSource: `基于班级${studentCount}名学生的 mastery 诊断数据 + 暗物质${darkMatterCount}项 + 错题待复习${dueTodayErrorCount}题`,
            darkMatterCount,
            dueTodayErrorCount,
        }
    } catch {
        return {
            weakBloomLevels: [],
            classAvgMastery: 0,
            studentCount: 0,
            dataSource: '诊断数据查询失败，使用通用教学数据',
            darkMatterCount: 0,
            dueTodayErrorCount: 0,
        }
    }
}

/**
 * 构建结构化教案
 */
function buildLessonPlan(
    poem: { id: string; title: string; poet: string; dynasty: string; content: string; theme: string[]; images: string[]; rhetoric: string[]; gradeLevel: string | null },
    gradeLevel: CreationGradeLevel,
    classId: string | undefined,
    aiContent: string,
    aiGenerated: boolean,
    lessonCount: 1 | 2 | 3,
    includeReflection: boolean,
    basis: { weakBloomLevels: BloomLevel[]; classAvgMastery: number; studentCount: number },
    teacherId: string,
): LessonPlan {
    const now = Date.now()
    const planId = `plan-${generateId()}`

    // 查询班级名称
    let className: string | undefined
    if (classId) {
        const classEntity = repos.classes.findById(classId)
        className = classEntity?.name
    }

    // 根据薄弱层级调整教学目标
    const goals: TeachingGoal[] = [
        {
            category: 'knowledge',
            bloomLevel: '记忆',
            description: `正确朗读并背诵《${poem.title}》，掌握生字新词`,
            assessment: '课堂朗读 + 默写检测',
        },
        {
            category: 'knowledge',
            bloomLevel: '理解',
            description: `理解诗意，能用自己的话翻译《${poem.title}》`,
            assessment: '口头翻译 + 选择题',
        },
        {
            category: 'ability',
            bloomLevel: '分析',
            description: `分析意象与修辞手法（${poem.rhetoric.slice(0, 3).join('、') || '比喻'}）`,
            assessment: '小组讨论 + 简答题',
        },
        {
            category: 'emotion',
            bloomLevel: '评价',
            description: '体会诗人情感，感受古诗的意境美',
            assessment: '鉴赏写作 + 课堂分享',
        },
    ]

    // 教学过程
    const teachingProcess: TeachingProcessStep[] = [
        {
            phase: 'introduction',
            title: `激趣导入：走进${poem.poet}的${poem.dynasty}世界`,
            durationMin: 5,
            teacherActivity: `播放意境图片，提问"看到这幅画你想到哪首诗？"引出《${poem.title}》`,
            studentActivity: '观察图片，自由发言，进入学习情境',
            designIntent: '激发兴趣，建立图文关联',
            bloomLevels: ['记忆', '理解'],
            goalIndices: [0],
        },
        {
            phase: 'literacy',
            title: '识字正音：通读全诗',
            durationMin: 8,
            teacherActivity: `范读《${poem.title}》，标注生字拼音，讲解易错字`,
            studentActivity: '跟读、自由读、指名读，互相纠正字音',
            designIntent: '扫除阅读障碍，正确流利朗读',
            bloomLevels: ['记忆'],
            goalIndices: [0],
        },
        {
            phase: 'interpretation',
            title: '逐句释义：理解诗意',
            durationMin: 15,
            teacherActivity: aiContent.slice(0, 500) || '逐句讲解诗意，结合注释引导学生理解',
            studentActivity: '借助注释自读自悟，小组合作翻译',
            designIntent: '理解诗歌内容，为鉴赏打基础',
            bloomLevels: ['理解', '分析'],
            goalIndices: [1, 2],
        },
        {
            phase: 'appreciation',
            title: '整体感悟：品味意象',
            durationMin: 10,
            teacherActivity: `引导学生找出诗中意象（${poem.images.slice(0, 3).join('、') || '月、山、水'}），讨论其文化内涵`,
            studentActivity: '圈画意象，小组讨论意象传达的情感',
            designIntent: '从内容理解走向审美鉴赏',
            bloomLevels: ['分析', '评价'],
            goalIndices: [2, 3],
        },
        {
            phase: 'practice',
            title: '课堂练习：巩固迁移',
            durationMin: 7,
            teacherActivity: '出示练习题（填空/选择/简答），巡视指导',
            studentActivity: '独立完成练习，集体订正',
            designIntent: '检测学习效果，强化薄弱环节',
            bloomLevels: basis.weakBloomLevels.length > 0 ? basis.weakBloomLevels : ['应用'],
            goalIndices: [0, 1],
        },
        {
            phase: 'homework',
            title: '作业布置：拓展延伸',
            durationMin: 5,
            teacherActivity: '布置分层作业，提出背诵要求',
            studentActivity: '记录作业，课后完成',
            designIntent: '巩固迁移，培养自主学习习惯',
            bloomLevels: ['创造'],
            goalIndices: [3],
        },
    ]

    // 反思建议（基于诊断数据）
    const reflection: TeachingReflection | undefined = includeReflection
        ? {
            classOverview: `班级${basis.studentCount}名学生，平均掌握度${basis.classAvgMastery}分${basis.weakBloomLevels.length > 0
                ? `，${basis.weakBloomLevels.join('、')}层级为薄弱环节`
                : '，各层级掌握均衡'
                }`,
            highlights: ['课堂参与度高', '朗读积极性强'],
            improvements:
                basis.weakBloomLevels.length > 0
                    ? basis.weakBloomLevels.map((l) => `加强${l}层级训练`)
                    : ['继续保持良好的学习状态'],
            adjustments: basis.weakBloomLevels.length > 0
                ? [`针对${basis.weakBloomLevels.join('、')}薄弱点增加专项练习`]
                : ['可适当增加拓展深度'],
            commonMistakes: ['生字书写错误', '意象理解偏差'],
            aiGenerated: aiGenerated,
            generatedAt: now,
        }
        : undefined

    return {
        id: planId,
        teacherId,
        poemId: poem.id,
        poemTitle: poem.title,
        poet: poem.poet,
        dynasty: poem.dynasty,
        gradeLevel,
        classId: classId ?? null,
        className,
        teacherName: '系统生成',
        title: `${poem.title}·${gradeLevel}·第1课时`,
        lessonCount,
        goals,
        keyPoints: [
            '正确朗读背诵全诗',
            `理解诗意，体会${poem.images.slice(0, 2).join('、') || '核心意象'}的含义`,
            `感受诗人情感与${poem.dynasty}时代风貌`,
        ],
        difficultPoints: [
            `理解${poem.rhetoric.slice(0, 2).join('、') || '修辞手法'}的表达效果`,
            '体会诗歌的深层意境',
        ],
        preparations: [
            '多媒体课件（含诗篇意境图）',
            '生字卡片',
            '朗读音频',
            '课堂练习单',
        ],
        teachingProcess,
        boardDesign: {
            title: poem.title,
            content: `${poem.title}\n${poem.poet}·${poem.dynasty}\n\n${poem.content.slice(0, 100)}`,
            intent: '以诗篇原文为核心，辅以意象关键词，形成图文对照的视觉结构',
        },
        homework: [
            {
                type: 'recitation',
                description: `背诵《${poem.title}》`,
                estimatedMin: 15,
                bloomLevel: '记忆',
                optional: false,
            },
            {
                type: 'dictation',
                description: `默写重点诗句`,
                estimatedMin: 10,
                bloomLevel: '记忆',
                optional: false,
            },
            {
                type: 'creation',
                description: `用一段话描写你想象中的诗中画面`,
                estimatedMin: 20,
                bloomLevel: '创造',
                optional: true,
            },
        ],
        reflection,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        aiGenerated,
    }
}

// ─────────────────────────────────────────────────────────────
// 教案模板（SubTask 14.3：GET /templates 数据源）
// ─────────────────────────────────────────────────────────────

/** 教案模板（精简版，不含完整教学过程） */
export interface LessonPlanTemplate {
    id: string
    name: string
    description: string
    gradeLevel: CreationGradeLevel
    lessonCount: 1 | 2 | 3
    /** 教学阶段要点 */
    keyPhases: Array<{
        phase: TeachingPhaseType
        title: string
        durationMin: number
        focus: string
    }>
    /** 推荐教学目标分布 */
    recommendedGoals: Array<{
        category: TeachingGoalCategory
        bloomLevel: BloomLevel
        description: string
    }>
    /** 适用场景 */
    suitableFor: string[]
    /** 是否适合首次教学 */
    forBeginner: boolean
}

/** 内置教案模板（5 套，覆盖 1-3 课时与各年级段） */
const LESSON_PLAN_TEMPLATES: readonly LessonPlanTemplate[] = [
    {
        id: 'tpl-classic-1',
        name: '经典诵读型（1课时）',
        description: '适用于 1-2 年级古诗初学，以诵读感悟为主，节奏轻快',
        gradeLevel: '1-2年级',
        lessonCount: 1,
        keyPhases: [
            { phase: 'introduction', title: '激趣导入', durationMin: 5, focus: '图片/音乐导入，建立情境' },
            { phase: 'literacy', title: '识字正音', durationMin: 10, focus: '范读、跟读、纠音' },
            { phase: 'interpretation', title: '逐句释义', durationMin: 15, focus: '借助注释理解诗意' },
            { phase: 'appreciation', title: '意境品鉴', durationMin: 8, focus: '想象画面，感受意境' },
            { phase: 'homework', title: '巩固作业', durationMin: 2, focus: '背诵+默写关键词' },
        ],
        recommendedGoals: [
            { category: 'knowledge', bloomLevel: '记忆', description: '能正确朗读并背诵全诗' },
            { category: 'ability', bloomLevel: '理解', description: '能借助注释说出诗句大意' },
            { category: 'emotion', bloomLevel: '理解', description: '感受诗歌的音韵美与画面美' },
        ],
        suitableFor: ['低年级', '古诗初学', '五言绝句', '七言绝句'],
        forBeginner: true,
    },
    {
        id: 'tpl-deep-appreciation-2',
        name: '深度鉴赏型（2课时）',
        description: '适用于 3-4 年级，第一课时侧重字词理解，第二课时侧重意境与文化背景',
        gradeLevel: '3-4年级',
        lessonCount: 2,
        keyPhases: [
            { phase: 'introduction', title: '知人论世', durationMin: 8, focus: '介绍诗人与创作背景' },
            { phase: 'literacy', title: '通读正音', durationMin: 7, focus: '朗读训练，扫除字词障碍' },
            { phase: 'interpretation', title: '炼字品词', durationMin: 15, focus: '聚焦关键字词的妙用' },
            { phase: 'appreciation', title: '意境重构', durationMin: 10, focus: '想象并描述诗中画面' },
            { phase: 'extension', title: '文化延伸', durationMin: 10, focus: '关联同类题材古诗' },
            { phase: 'practice', title: '迁移运用', durationMin: 5, focus: '仿写或改写片段' },
        ],
        recommendedGoals: [
            { category: 'knowledge', bloomLevel: '理解', description: '理解关键词语的含义与妙用' },
            { category: 'ability', bloomLevel: '分析', description: '能分析意象与情感的关系' },
            { category: 'ability', bloomLevel: '评价', description: '能评价诗人的艺术手法' },
            { category: 'emotion', bloomLevel: '评价', description: '体会诗人的情感与人生态度' },
        ],
        suitableFor: ['中年级', '律诗', '词', '意象丰富'],
        forBeginner: false,
    },
    {
        id: 'tpl-inquiry-creation-3',
        name: '探究创作型（3课时）',
        description: '适用于 5-6 年级，强调分析评价与创造，融合跨学科探究',
        gradeLevel: '5-6年级',
        lessonCount: 3,
        keyPhases: [
            { phase: 'introduction', title: '问题驱动', durationMin: 10, focus: '提出核心探究问题' },
            { phase: 'literacy', title: '深度研读', durationMin: 15, focus: '多版本对比阅读' },
            { phase: 'interpretation', title: '主题辨析', durationMin: 15, focus: '小组辨论诗中主题' },
            { phase: 'appreciation', title: '美学评价', durationMin: 12, focus: '从美学角度评价诗歌' },
            { phase: 'extension', title: '文化比较', durationMin: 13, focus: '与同类诗作横向比较' },
            { phase: 'practice', title: '改写创作', durationMin: 15, focus: '改写为现代文/诗/剧本' },
            { phase: 'homework', title: '项目作业', durationMin: 5, focus: '完成"我为诗人代言"小项目' },
        ],
        recommendedGoals: [
            { category: 'knowledge', bloomLevel: '分析', description: '能分析诗歌的结构与艺术手法' },
            { category: 'ability', bloomLevel: '评价', description: '能从多角度评价诗歌的文学价值' },
            { category: 'ability', bloomLevel: '创造', description: '能改写或创作仿古诗作品' },
            { category: 'emotion', bloomLevel: '创造', description: '能表达对诗人的独特理解与共鸣' },
        ],
        suitableFor: ['高年级', '律诗', '长诗', '主题探究', '跨学科'],
        forBeginner: false,
    },
    {
        id: 'tpl-game-1',
        name: '游戏化教学型（1课时）',
        description: '通过闯关游戏串联教学环节，适合低中年级古诗复习课',
        gradeLevel: '1-2年级',
        lessonCount: 1,
        keyPhases: [
            { phase: 'introduction', title: '情境导入', durationMin: 3, focus: '创设"诗词闯关"游戏情境' },
            { phase: 'literacy', title: '第一关：字音挑战', durationMin: 8, focus: '朗读闯关，纠正字音' },
            { phase: 'interpretation', title: '第二关：诗意接龙', durationMin: 12, focus: '逐句释义接龙' },
            { phase: 'appreciation', title: '第三关：画面定格', durationMin: 10, focus: '画出诗中画面' },
            { phase: 'homework', title: '终极挑战', durationMin: 7, focus: '背诵挑战赛' },
        ],
        recommendedGoals: [
            { category: 'knowledge', bloomLevel: '记忆', description: '熟练背诵全诗' },
            { category: 'ability', bloomLevel: '理解', description: '能用自己的话复述诗意' },
            { category: 'emotion', bloomLevel: '应用', description: '在游戏中体验学习古诗的乐趣' },
        ],
        suitableFor: ['低年级', '复习课', '游戏化', '古诗兴趣培养'],
        forBeginner: true,
    },
    {
        id: 'tpl-cross-cultural-2',
        name: '跨文化对比型（2课时）',
        description: '通过中外诗歌对比，拓展文化视野，适合高年级深度学习',
        gradeLevel: '5-6年级',
        lessonCount: 2,
        keyPhases: [
            { phase: 'introduction', title: '同类诗歌呈现', durationMin: 8, focus: '呈现中外同类题材诗歌' },
            { phase: 'literacy', title: '初读感知', durationMin: 7, focus: '通读中外两首诗' },
            { phase: 'interpretation', title: '意象对比', durationMin: 15, focus: '对比意象异同' },
            { phase: 'appreciation', title: '情感共鸣', durationMin: 10, focus: '体会不同文化下的情感表达' },
            { phase: 'extension', title: '文化溯源', durationMin: 10, focus: '探究文化差异根源' },
        ],
        recommendedGoals: [
            { category: 'knowledge', bloomLevel: '分析', description: '能分析中外诗歌的意象差异' },
            { category: 'ability', bloomLevel: '评价', description: '能评价不同文化背景下的诗歌特色' },
            { category: 'emotion', bloomLevel: '评价', description: '形成跨文化理解的开放态度' },
        ],
        suitableFor: ['高年级', '跨文化', '主题学习', '深度阅读'],
        forBeginner: false,
    },
]

// ─────────────────────────────────────────────────────────────
// 教案导出渲染函数（SubTask 14.3：POST /:id/export）
// ─────────────────────────────────────────────────────────────

/** 单一导出分派入口，保证生产路径与边界测试使用完全相同的格式契约。 */
export function renderLessonPlanExport(
    plan: LessonPlan,
    format: LessonPlanExportFormat,
    options: LessonPlanExportOptions,
): LessonPlanExportArtifact {
    switch (format) {
        case 'markdown':
            return { content: renderPlanMarkdown(plan, options), mimeType: 'text/markdown' }
        case 'html':
            return { content: renderPlanHtml(plan, options), mimeType: 'text/html' }
        case 'word':
            return { content: renderPlanWordHtml(plan, options), mimeType: 'application/msword' }
        case 'csv':
            return { content: renderPlanCsv(plan, options), mimeType: 'text/csv' }
    }
}

/** 渲染为 Markdown 格式 */
function renderPlanMarkdown(plan: LessonPlan, opts: LessonPlanExportOptions): string {
    const lines: string[] = []
    lines.push(`# ${plan.title}`)
    lines.push('')
    lines.push(`> ${plan.poemTitle} · ${plan.poet}（${plan.dynasty}）`)
    lines.push('')
    lines.push(`**年级**：${plan.gradeLevel}  ｜  **课时**：${plan.lessonCount}  ｜  **教师**：${plan.teacherName}`)
    if (plan.className) {
        lines.push(`  ｜  **班级**：${plan.className}`)
    }
    lines.push('')
    lines.push(`**生成时间**：${new Date(plan.createdAt).toLocaleString('zh-CN')}`)
    lines.push('')

    // 教学目标
    lines.push('## 教学目标')
    lines.push('')
    plan.goals.forEach((g, i) => {
        const categoryLabel = g.category === 'knowledge' ? '知识与技能' : g.category === 'ability' ? '过程与方法' : '情感态度价值观'
        lines.push(`${i + 1}. **[${categoryLabel}｜${g.bloomLevel}]** ${g.description}`)
        lines.push(`   - 评价方式：${g.assessment}`)
    })
    lines.push('')

    // 重点难点
    if (plan.keyPoints.length > 0) {
        lines.push('## 教学重点')
        plan.keyPoints.forEach((p) => lines.push(`- ${p}`))
        lines.push('')
    }
    if (plan.difficultPoints.length > 0) {
        lines.push('## 教学难点')
        plan.difficultPoints.forEach((p) => lines.push(`- ${p}`))
        lines.push('')
    }

    // 教学准备
    if (plan.preparations.length > 0) {
        lines.push('## 教学准备')
        plan.preparations.forEach((p) => lines.push(`- ${p}`))
        lines.push('')
    }

    // 教学过程
    lines.push('## 教学过程')
    lines.push('')
    plan.teachingProcess.forEach((step, i) => {
        lines.push(`### 环节${i + 1}：${step.title}（${step.durationMin}分钟）`)
        lines.push(`> 阶段：${step.phase}  ｜  Bloom 层级：${step.bloomLevels.join('、')}`)
        lines.push('')
        lines.push(`**教师活动**：${step.teacherActivity}`)
        lines.push('')
        lines.push(`**学生活动**：${step.studentActivity}`)
        lines.push('')
        lines.push(`**设计意图**：${step.designIntent}`)
        lines.push('')
    })

    // 板书设计
    if (opts.includeBoard && plan.boardDesign) {
        lines.push('## 板书设计')
        lines.push('')
        lines.push(`**${plan.boardDesign.title}**`)
        lines.push('')
        lines.push('```')
        lines.push(plan.boardDesign.content)
        lines.push('```')
        lines.push('')
        if (plan.boardDesign.intent) {
            lines.push(`设计意图：${plan.boardDesign.intent}`)
            lines.push('')
        }
    }

    // 作业
    if (opts.includeHomework && plan.homework.length > 0) {
        lines.push('## 作业设计')
        lines.push('')
        const typeLabel: Record<HomeworkType, string> = {
            dictation: '默写',
            recitation: '背诵',
            creation: '创作',
            investigation: '调查',
            reading: '阅读',
        }
        plan.homework.forEach((h, i) => {
            lines.push(`${i + 1}. **[${typeLabel[h.type]}｜${h.bloomLevel}]** ${h.description}`)
            lines.push(`   - 预计时长：${h.estimatedMin} 分钟${h.optional ? '（选做）' : '（必做）'}`)
        })
        lines.push('')
    }

    // 教学反思
    if (opts.includeReflection && plan.reflection) {
        lines.push('## 教学反思')
        lines.push('')
        lines.push(`**班级概况**：${plan.reflection.classOverview}`)
        lines.push('')
        if (plan.reflection.highlights.length > 0) {
            lines.push('### 亮点')
            plan.reflection.highlights.forEach((h) => lines.push(`- ${h}`))
            lines.push('')
        }
        if (plan.reflection.improvements.length > 0) {
            lines.push('### 待改进')
            plan.reflection.improvements.forEach((h) => lines.push(`- ${h}`))
            lines.push('')
        }
        if (plan.reflection.adjustments.length > 0) {
            lines.push('### 后续调整')
            plan.reflection.adjustments.forEach((h) => lines.push(`- ${h}`))
            lines.push('')
        }
        if (plan.reflection.commonMistakes.length > 0) {
            lines.push('### 常见错误')
            plan.reflection.commonMistakes.forEach((h) => lines.push(`- ${h}`))
            lines.push('')
        }
        lines.push(`> 反思生成方式：${plan.reflection.aiGenerated ? 'AI 生成' : '教师手写'}  ｜  ${new Date(plan.reflection.generatedAt).toLocaleString('zh-CN')}`)
    }

    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push(`*本教案由 PoeticRealm AI 教案工坊生成${plan.aiGenerated ? '（AI 辅助）' : ''} · ${new Date().toLocaleString('zh-CN')}*`)

    return lines.join('\n')
}

/** 渲染为 HTML 格式（用于浏览器打印 / 在线预览） */
function renderPlanHtml(plan: LessonPlan, opts: LessonPlanExportOptions): string {
    const sections: string[] = []

    sections.push(`<header class="plan-header">
<h1>${escapeHtml(plan.title)}</h1>
<div class="meta">${escapeHtml(plan.poemTitle)} · ${escapeHtml(plan.poet)}（${escapeHtml(plan.dynasty)}）</div>
<div class="info">年级：${escapeHtml(plan.gradeLevel)} ｜ 课时：${plan.lessonCount} ｜ 教师：${escapeHtml(plan.teacherName)}${plan.className ? ` ｜ 班级：${escapeHtml(plan.className)}` : ''}</div>
<div class="badge">${plan.aiGenerated ? 'AI 辅助生成' : '教师手工'}</div>
</header>`)

    // 教学目标
    const goalsHtml = plan.goals.map((g) => {
        const label = g.category === 'knowledge' ? '知识与技能' : g.category === 'ability' ? '过程与方法' : '情感态度价值观'
        return `<li><strong>[${escapeHtml(label)}｜${escapeHtml(g.bloomLevel)}]</strong> ${escapeHtml(g.description)}<div class="assess">评价：${escapeHtml(g.assessment)}</div></li>`
    }).join('')
    sections.push(`<section><h2>教学目标</h2><ol>${goalsHtml}</ol></section>`)

    // 教学过程
    const processHtml = plan.teachingProcess.map((step, i) => `
<div class="phase">
<h3>环节${i + 1}：${escapeHtml(step.title)} <span class="duration">（${step.durationMin}分钟）</span></h3>
<div class="phase-meta">阶段：${escapeHtml(step.phase)} ｜ Bloom：${escapeHtml(step.bloomLevels.join('、'))}</div>
<div class="activity"><strong>教师活动：</strong>${escapeHtml(step.teacherActivity)}</div>
<div class="activity"><strong>学生活动：</strong>${escapeHtml(step.studentActivity)}</div>
<div class="intent"><strong>设计意图：</strong>${escapeHtml(step.designIntent)}</div>
</div>`).join('')
    sections.push(`<section><h2>教学过程</h2>${processHtml}</section>`)

    // 板书设计
    if (opts.includeBoard && plan.boardDesign) {
        sections.push(`<section><h2>板书设计</h2><h3>${escapeHtml(plan.boardDesign.title)}</h3><pre>${escapeHtml(plan.boardDesign.content)}</pre><p class="intent">${escapeHtml(plan.boardDesign.intent)}</p></section>`)
    }

    // 作业
    if (opts.includeHomework && plan.homework.length > 0) {
        const typeLabel: Record<HomeworkType, string> = { dictation: '默写', recitation: '背诵', creation: '创作', investigation: '调查', reading: '阅读' }
        const homeworkHtml = plan.homework.map((h) => `<li><strong>[${escapeHtml(typeLabel[h.type])}｜${escapeHtml(h.bloomLevel)}]</strong> ${escapeHtml(h.description)} <span class="duration">${h.estimatedMin}分钟${h.optional ? '（选做）' : '（必做）'}</span></li>`).join('')
        sections.push(`<section><h2>作业设计</h2><ol>${homeworkHtml}</ol></section>`)
    }

    // 教学反思
    if (opts.includeReflection && plan.reflection) {
        const reflectionHtml = `
<div class="reflection">
<p><strong>班级概况：</strong>${escapeHtml(plan.reflection.classOverview)}</p>
${plan.reflection.highlights.length > 0 ? `<div><h4>亮点</h4><ul>${plan.reflection.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul></div>` : ''}
${plan.reflection.improvements.length > 0 ? `<div><h4>待改进</h4><ul>${plan.reflection.improvements.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul></div>` : ''}
</div>`
        sections.push(`<section><h2>教学反思</h2>${reflectionHtml}</section>`)
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(plan.title)}</title>
<style>
body { font-family: 'Noto Sans SC', -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 32px; color: #2C241A; background: #FAF8F5; }
.plan-header { text-align: center; padding: 24px 0; border-bottom: 2px solid rgba(197,133,59,0.2); margin-bottom: 32px; }
.plan-header h1 { font-size: 32px; color: #2C241A; margin: 0 0 8px 0; }
.meta { color: #6B6258; font-size: 16px; }
.info { color: #9E968C; font-size: 14px; margin-top: 8px; }
.badge { display: inline-block; margin-top: 12px; padding: 4px 12px; background: rgba(197,133,59,0.1); color: #C5853B; border-radius: 4px; font-size: 12px; }
section { margin-bottom: 32px; }
h2 { color: #C5853B; border-bottom: 1px solid rgba(197,133,59,0.15); padding-bottom: 8px; font-size: 22px; }
h3 { color: #2C241A; font-size: 18px; margin: 16px 0 8px 0; }
.duration { color: #9E968C; font-weight: normal; font-size: 14px; }
.phase { padding: 16px; background: rgba(245,241,236,0.6); border-radius: 8px; margin-bottom: 16px; }
.phase-meta { color: #9E968C; font-size: 13px; margin-bottom: 8px; }
.activity { margin: 8px 0; }
.intent { color: #6B6258; font-style: italic; margin-top: 8px; }
.assess { color: #6B6258; font-size: 13px; margin-left: 24px; }
pre { background: rgba(237,232,226,0.6); padding: 16px; border-radius: 8px; white-space: pre-wrap; }
ol, ul { padding-left: 24px; }
li { margin: 8px 0; }
</style>
</head>
<body>
${sections.join('\n')}
<footer style="margin-top: 48px; padding-top: 16px; border-top: 1px solid rgba(44,36,26,0.08); color: #9E968C; font-size: 12px; text-align: center;">
本教案由 PoeticRealm AI 教案工坊生成 · ${new Date().toLocaleString('zh-CN')}
</footer>
</body>
</html>`
}

/** 渲染为 Word 兼容 HTML（带 Word XML 命名空间） */
function renderPlanWordHtml(plan: LessonPlan, opts: LessonPlanExportOptions): string {
    const html = renderPlanHtml(plan, opts)
    // 包装为 Word 兼容的 HTML（含 xmlns:o = "urn:schemas-microsoft-com:office:office"）
    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8">
<meta name="ProgId" content="Word.Document">
<meta name="Generator" content="PoeticRealm AI">
<meta name="Originator" content="Microsoft Word 365">
</head>
<body>
${html}
</body>
</html>`
}

/** 渲染为 CSV 格式（含 BOM，Excel 可直接打开） */
function renderPlanCsv(plan: LessonPlan, opts: LessonPlanExportOptions): string {
    const rows: string[][] = []
    rows.push(['教案导出'])
    rows.push(['标题', plan.title])
    rows.push(['古诗', plan.poemTitle])
    rows.push(['诗人', plan.poet])
    rows.push(['朝代', plan.dynasty])
    rows.push(['年级', plan.gradeLevel])
    rows.push(['课时', String(plan.lessonCount)])
    rows.push(['教师', plan.teacherName])
    rows.push(['班级', plan.className ?? ''])
    rows.push(['创建时间', new Date(plan.createdAt).toLocaleString('zh-CN')])
    rows.push([])

    // 教学目标
    rows.push(['教学目标'])
    rows.push(['序号', '类别', 'Bloom层级', '描述', '评价方式'])
    plan.goals.forEach((g, i) => {
        const label = g.category === 'knowledge' ? '知识与技能' : g.category === 'ability' ? '过程与方法' : '情感态度价值观'
        rows.push([String(i + 1), label, g.bloomLevel, g.description, g.assessment])
    })
    rows.push([])

    // 教学过程
    rows.push(['教学过程'])
    rows.push(['环节', '阶段', '标题', '时长(分)', '教师活动', '学生活动', '设计意图', 'Bloom层级'])
    plan.teachingProcess.forEach((step, i) => {
        rows.push([
            String(i + 1),
            step.phase,
            step.title,
            String(step.durationMin),
            step.teacherActivity,
            step.studentActivity,
            step.designIntent,
            step.bloomLevels.join('/'),
        ])
    })
    rows.push([])

    // 板书设计
    if (opts.includeBoard && plan.boardDesign) {
        rows.push(['板书设计'])
        rows.push(['标题', plan.boardDesign.title])
        rows.push(['内容', plan.boardDesign.content])
        rows.push(['意图', plan.boardDesign.intent])
        rows.push([])
    }

    // 作业
    if (opts.includeHomework && plan.homework.length > 0) {
        rows.push(['作业设计'])
        rows.push(['序号', '类型', 'Bloom层级', '描述', '时长(分)', '必/选做'])
        plan.homework.forEach((h, i) => {
            rows.push([
                String(i + 1),
                h.type,
                h.bloomLevel,
                h.description,
                String(h.estimatedMin),
                h.optional ? '选做' : '必做',
            ])
        })
        rows.push([])
    }

    // 教学反思
    if (opts.includeReflection && plan.reflection) {
        rows.push(['教学反思'])
        rows.push(['班级概况', plan.reflection.classOverview])
        rows.push(['亮点', plan.reflection.highlights.join('；')])
        rows.push(['待改进', plan.reflection.improvements.join('；')])
        rows.push(['后续调整', plan.reflection.adjustments.join('；')])
        rows.push(['常见错误', plan.reflection.commonMistakes.join('；')])
        rows.push(['AI生成', plan.reflection.aiGenerated ? '是' : '否'])
    }

    // 转 CSV（含 BOM）
    const csvContent = rows
        .map((row) => row.map((cell) => {
            const escaped = String(cell ?? '').replace(/"/g, '""')
            return `"${escaped}"`
        }).join(','))
        .join('\n')
    return '\ufeff' + csvContent
}

/** HTML 转义 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

