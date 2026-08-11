/**
 * 课后创造工坊 REST API 路由（Task 16）—— 真实多智能体协作共创
 *
 * 课后创造层（布鲁姆第六阶"创造"）：学生完成创造级任务（配画 / 改写 / 视频脚本 / 鉴赏文），
 * AI 协作共创，作品展示墙。教师可创建任务、参与迭代；学生可提交作品、点赞。
 *
 * 架构（Loop Engineering：生成→迭代→展示闭环）：
 *   教师创建创造级任务（指定诗 / 类型 / 要求）
 *     → 学生启动 AI 协作共创（brush.creative 生成初稿）
 *     → 教师/学生输入修改意见 → brush.creative 携带反馈再生成（多轮迭代）
 *     → 诗眼 Agent 视觉描述生成（brush.creative.illustration-description，供学生临摹参考）
 *     → 诗笔 Agent 改写辅助（brush.creative.rewrite-example，保留原意 + 创新表达）
 *     → 学生提交作品 → 作品墙展示（按点赞数排序，分页）
 *
 * 9 个端点：
 *   GET  /api/creation/tasks                获取创造级任务列表
 *   POST /api/creation/tasks/create         教师创建创造级任务
 *   POST /api/creation/collaborate/start    启动 AI 协作共创
 *   POST /api/creation/collaborate/iterate  AI 协作迭代
 *   POST /api/creation/vision-describe      生成配图描述（供学生临摹参考）
 *   POST /api/creation/rewrite              诗笔辅助改写
 *   GET  /api/creation/works                获取学生作品列表（支持筛选）
 *   POST /api/creation/works/submit         学生提交作品
 *   POST /api/creation/works/:id/like       点赞作品
 *   GET  /api/creation/works/wall           作品展示墙（按点赞数排序，分页）
 *
 * 设计说明：
 * - 任务、作品与协作状态由 SQLite 支撑的持久 Map 保存，重启后可恢复
 * - 所有 AI 生成内容标注 aiGenerated: true（《生成式人工智能服务管理暂行办法》合规）
 * - 学生姓名脱敏：返回 anonymousName，不暴露真实姓名
 * - brush.creative 子 Agent 提供 4 种素材类型，与创造工坊任务类型一一映射：
 *     illustration        → illustration-description（配图描述）
 *     rewrite             → rewrite-example（改写示例）
 *     video-script        → script（视频/表演脚本）
 *     appreciation        → cultural-story（文化故事/鉴赏文）
 * - 失败降级：AI 调用失败时返回明确错误，不阻塞列表/墙查询
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { repos } from '../db/index.js'
import { generateId } from '../db/utils/id.js'
import { agents } from '../agents/index.js'
import { handleRouteError } from './_helpers.js'
import type { AgentContext, PoemNode } from '../agents/base/types.js'
import type {
    CreativeInput,
    CreativeOutput,
    CreativeType,
    CreativeGradeLevel,
} from '../agents/brush-agent/creative.sub-agent.js'
import type { PoemEntity } from '../db/types.js'
// 持久化存储：原 3 个内存 Map → SQLite 表（重启不丢失）
//   taskStore     → creation_tasks 表
//   sessionStore  → creation_collaboration_sessions 表
//   workStore     → creation_works 表
import { SqliteMap } from '../db/runtime-store.js'
import { z } from 'zod'
import { isProtectedGeneratedImageUrl } from '../security/image-reference-policy.js'
import { validateBody, validateParams, validateQuery, schemas } from '../lib/validation.js'
// 闭环3补全：作品提交后推送 WS 事件 + 新增作品批改/再创作端点
import type { WSBroadcaster } from '../orchestrator/websocket/broadcaster.js'
import type { WSEvent } from '../orchestrator/types.js'
import { router } from '../llm/index.js'
import { safeJsonParse } from '../agents/base/prompts.js'
import { config } from '../config.js'
import { resolveCreationSubmissionBoundary } from '../services/creation/submission-boundary.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 创造工坊任务类型 —— 四类创造级任务 */
export type CreationTaskType = 'illustration' | 'rewrite' | 'video-script' | 'appreciation'

/** 任务类型 → brush.creative 类型映射 */
const TASK_TYPE_TO_CREATIVE: Record<CreationTaskType, CreativeType> = {
    illustration: 'illustration-description',
    rewrite: 'rewrite-example',
    'video-script': 'script',
    appreciation: 'cultural-story',
}

/** 任务类型中文标签 */
const TASK_TYPE_LABEL: Record<CreationTaskType, string> = {
    illustration: '配画',
    rewrite: '改写',
    'video-script': '视频脚本',
    appreciation: '鉴赏文',
}

/** 创造级任务实体 */
interface CreationTask {
    id: string
    /** 关联古诗 ID */
    poemId: string
    /** 关联古诗快照（避免反复查询） */
    poemTitle: string
    poet: string
    dynasty: string
    /** 任务类型 */
    type: CreationTaskType
    /** 任务类型中文标签 */
    typeLabel: string
    /** 教师设定的任务要求 */
    requirements: string
    /** 目标年级 */
    gradeLevel: CreativeGradeLevel
    /** 创建教师 ID */
    teacherId: string
    /** 关联班级 ID（可选） */
    classId: string | null
    /** 创建时间戳 */
    createdAt: number
    /** 截止时间（可选） */
    dueAt: number | null
    /** 任务状态 */
    status: 'open' | 'closed'
    /** 仅 DEMO_MODE 运行时样例，不写入数据库 */
    demoSample?: boolean
}

/** 协作对话条目 */
interface CollaborationTurn {
    /** 轮次序号（从 1 开始） */
    round: number
    /** 角色：ai / teacher / student */
    role: 'ai' | 'teacher' | 'student'
    /** 文本内容（Markdown） */
    content: string
    /** 文生图提示词（仅 ai 角色输出） */
    suggestedImagePrompt?: string
    /** 时间戳 */
    at: number
    /** AI 生成标记 */
    aiGenerated: boolean
}

/** 协作会话运行时 */
interface CollaborationSession {
    id: string
    taskId: string
    poemId: string
    /** 学生 ID（学生发起时） */
    studentId: string | null
    /** 教师 ID（教师发起时） */
    teacherId: string | null
    /** 任务类型 */
    type: CreationTaskType
    /** 对话历史 */
    history: CollaborationTurn[]
    /** 创建时间戳 */
    startedAt: number
    /** 最后更新时间 */
    updatedAt: number
}

/** 学生作品实体 */
interface CreationWork {
    id: string
    taskId: string
    poemId: string
    poemTitle: string
    poet: string
    /** 作品类型 */
    type: CreationTaskType
    typeLabel: string
    /** 学生 ID */
    studentId: string
    /** 脱敏姓名 */
    anonymousName: string
    /** 班级 ID */
    classId: string | null
    /** 作品名称 */
    title: string
    /** 作品正文（Markdown） */
    content: string
    /** 配图 URL（可选，配画类作品） */
    imageUrl: string | null
    /** 点赞数 */
    likeCount: number
    /** 是否有 AI 辅助 */
    aiAssisted: boolean
    /** 协作会话 ID（可选，追溯 AI 协作过程） */
    collaborationSessionId: string | null
    /** 提交时间戳 */
    submittedAt: number
    /** 仅 DEMO_MODE 运行时样例，不写入数据库 */
    demoSample?: boolean
}

// ─────────────────────────────────────────────────────────────
// 请求 / 响应类型
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 持久化存储（SQLite 替代内存 Map，重启后数据完整恢复）
// ─────────────────────────────────────────────────────────────

// 原 Map<string, CreationTask> → creation_tasks 表（teacher_id / class_id / poem_id 索引）
const taskStore = new SqliteMap<string, CreationTask>({
    table: 'creation_tasks',
    indexes: [
        { name: 'teacher_id', extract: (v) => v.teacherId },
        { name: 'class_id', extract: (v) => v.classId },
        { name: 'poem_id', extract: (v) => v.poemId },
    ],
})

// 原 Map<string, CollaborationSession> → creation_collaboration_sessions 表
const sessionStore = new SqliteMap<string, CollaborationSession>({
    table: 'creation_collaboration_sessions',
    indexes: [
        { name: 'task_id', extract: (v) => v.taskId },
        { name: 'student_id', extract: (v) => v.studentId },
        { name: 'teacher_id', extract: (v) => v.teacherId },
    ],
})

// 原 Map<string, CreationWork> → creation_works 表
const workStore = new SqliteMap<string, CreationWork>({
    table: 'creation_works',
    indexes: [
        { name: 'task_id', extract: (v) => v.taskId },
        { name: 'student_id', extract: (v) => v.studentId },
        { name: 'class_id', extract: (v) => v.classId },
        { name: 'poem_id', extract: (v) => v.poemId },
    ],
})

/**
 * 空数据库下的比赛演示样例。它们只在 DEMO_MODE 查询响应中合成，
 * 不写入 SQLite，不计入真实教学数据，也不会污染后续正式运行。
 */
const DEMO_CREATION_TASK: CreationTask = {
    id: 'demo-creation-task-jingyesi',
    poemId: 'tongbian-001',
    poemTitle: '静夜思',
    poet: '李白',
    dynasty: '唐',
    type: 'rewrite',
    typeLabel: '改写',
    requirements: '保留“由眼前景物引发思乡”的情感转折，换成现代校园场景。',
    gradeLevel: '5-6年级',
    teacherId: 'teacher-001',
    classId: 'class-001',
    createdAt: Date.UTC(2026, 6, 28, 8),
    dueAt: null,
    status: 'open',
    demoSample: true,
}

const DEMO_CREATION_WORKS: readonly CreationWork[] = [
    {
        id: 'demo-creation-work-01',
        taskId: DEMO_CREATION_TASK.id,
        poemId: DEMO_CREATION_TASK.poemId,
        poemTitle: DEMO_CREATION_TASK.poemTitle,
        poet: DEMO_CREATION_TASK.poet,
        type: DEMO_CREATION_TASK.type,
        typeLabel: DEMO_CREATION_TASK.typeLabel,
        studentId: 'demo-student-01',
        anonymousName: '清风同学',
        classId: DEMO_CREATION_TASK.classId,
        title: '晚自习的窗',
        content: '桌面一方冷白的灯，像月光落在未写完的练习册上。我抬头看见宿舍楼的窗，忽然想起家里那盏总为我留着的灯。',
        imageUrl: null,
        likeCount: 12,
        aiAssisted: false,
        collaborationSessionId: null,
        submittedAt: Date.UTC(2026, 6, 29, 10),
        demoSample: true,
    },
    {
        id: 'demo-creation-work-02',
        taskId: DEMO_CREATION_TASK.id,
        poemId: DEMO_CREATION_TASK.poemId,
        poemTitle: DEMO_CREATION_TASK.poemTitle,
        poet: DEMO_CREATION_TASK.poet,
        type: DEMO_CREATION_TASK.type,
        typeLabel: DEMO_CREATION_TASK.typeLabel,
        studentId: 'demo-student-02',
        anonymousName: '远山同学',
        classId: DEMO_CREATION_TASK.classId,
        title: '操场上的月光',
        content: '月光沿着跑道铺开，晚风翻动操场边的树叶。我在终点线前停下，才发现自己想念的不只是家，还有那些陪我出发的人。',
        imageUrl: null,
        likeCount: 8,
        aiAssisted: true,
        collaborationSessionId: 'demo-collaboration-02',
        submittedAt: Date.UTC(2026, 6, 29, 9),
        demoSample: true,
    },
]

function demoWorksWhenEmpty(list: CreationWork[]): CreationWork[] {
    return config.demoMode && list.length === 0 ? [...DEMO_CREATION_WORKS] : list
}

// ─────────────────────────────────────────────────────────────
// 插件选项
// ─────────────────────────────────────────────────────────────

export interface CreationRoutesOptions {
    /** 闭环3补全：广播作品提交/批改/再创作事件到前端 */
    broadcaster?: WSBroadcaster
}

// ─────────────────────────────────────────────────────────────
// Zod schemas（B6.3 输入校验）
// ─────────────────────────────────────────────────────────────

const creationTaskTypeSchema = z.enum(['illustration', 'rewrite', 'video-script', 'appreciation'])
const creativeGradeLevelSchema = z.enum(['1-2年级', '3-4年级', '5-6年级'])

/** GET /tasks 查询参数 */
const tasksQuerySchema = z.object({
    teacherId: schemas.optionalSanitizedString(128),
    classId: schemas.optionalSanitizedString(128),
    type: creationTaskTypeSchema.optional(),
})

/** POST /tasks/create 请求体 */
const createTaskSchema = z.object({
    poemId: schemas.poemId,
    type: creationTaskTypeSchema,
    requirements: schemas.sanitizedString(2000),
    gradeLevel: creativeGradeLevelSchema.optional(),
    teacherId: schemas.teacherId,
    classId: schemas.optionalSanitizedString(128),
    dueAt: z.number().int().min(0).optional(),
    poemTitle: schemas.optionalSanitizedString(200),
    poet: schemas.optionalSanitizedString(100),
    dynasty: schemas.optionalSanitizedString(50),
})

/** POST /collaborate/start 请求体 */
const collaborateStartSchema = z.object({
    taskId: schemas.taskId,
    studentId: schemas.optionalSanitizedString(128),
    teacherId: schemas.optionalSanitizedString(128),
    topic: schemas.optionalSanitizedString(1000),
    constraints: z.array(schemas.sanitizedString(500)).max(20).optional(),
})

/** POST /collaborate/iterate 请求体 */
const collaborateIterateSchema = z.object({
    sessionId: schemas.sessionId,
    feedback: schemas.sanitizedString(5000),
    role: z.enum(['teacher', 'student']).optional(),
})

/** POST /vision-describe 请求体 */
const visionDescribeSchema = z.object({
    poemId: schemas.poemId,
    gradeLevel: creativeGradeLevelSchema.optional(),
    topic: schemas.optionalSanitizedString(1000),
    constraints: z.array(schemas.sanitizedString(500)).max(20).optional(),
})

/** POST /rewrite 请求体 */
const rewriteSchema = z.object({
    poemId: schemas.poemId,
    direction: schemas.sanitizedString(200),
    gradeLevel: creativeGradeLevelSchema.optional(),
    constraints: z.array(schemas.sanitizedString(500)).max(20).optional(),
})

/** GET /works 查询参数 */
const worksQuerySchema = z.object({
    classId: schemas.optionalSanitizedString(128),
    poemId: schemas.optionalSanitizedString(128),
    type: creationTaskTypeSchema.optional(),
    studentId: schemas.optionalSanitizedString(128),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
})

/** POST /works/submit 请求体 */
const submitWorkSchema = z.object({
    taskId: schemas.taskId,
    studentId: schemas.studentId,
    title: schemas.sanitizedString(200),
    content: schemas.sanitizedString(50000),
    imageUrl: schemas.optionalSanitizedString(2000).refine(
        (value) => value === undefined || value.length === 0 || isProtectedGeneratedImageUrl(value),
        '配图只能引用系统已落盘的 /uploads/generated/.../*.webp',
    ),
    aiAssisted: z.boolean().optional(),
    collaborationSessionId: schemas.optionalSanitizedString(128),
})

/** POST /works/:id/like 路径参数 */
const workIdParamsSchema = z.object({ id: schemas.id })

/** GET /works/wall 查询参数 */
const wallQuerySchema = z.object({
    classId: schemas.optionalSanitizedString(128),
    poemId: schemas.optionalSanitizedString(128),
    type: creationTaskTypeSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(60).default(24),
})

/** 闭环3补全：POST /works/:id/grade 请求体 —— AI 批改学生创造作品 */
const gradeWorkSchema = z.object({
    /** 教师附加评语（可选，注入批改上下文） */
    teacherComment: schemas.optionalSanitizedString(2000),
    /** 评分维度侧重（可选） */
    focus: z.enum(['creativity', 'accuracy', 'expression', 'overall']).optional(),
})

/** 闭环3补全：POST /works/:id/recreate 请求体 —— 基于批改反馈再创作 */
const recreateWorkSchema = z.object({
    /** 批改反馈作为再创作指导 */
    feedback: schemas.sanitizedString(5000),
    /** 再创作方向（可选） */
    direction: schemas.optionalSanitizedString(500),
})

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

export const creationRoutes: FastifyPluginAsync<CreationRoutesOptions> = async (app, opts) => {
    const broadcaster = opts.broadcaster
    /**
     * GET /tasks
     *
     * 获取创造级任务列表。支持按 teacherId / classId / type 筛选。
     */
    app.get('/tasks', async (req: FastifyRequest, reply) => {
        const query = validateQuery(tasksQuerySchema, req, reply)
        if (!query) return
        const { teacherId, classId, type } = query
        let list = Array.from(taskStore.values())
        if (config.demoMode && list.length === 0) list = [DEMO_CREATION_TASK]
        if (teacherId) list = list.filter((t) => t.teacherId === teacherId)
        if (classId) list = list.filter((t) => t.classId === classId || t.classId === null)
        if (type) list = list.filter((t) => t.type === type)
        // 按创建时间倒序
        list.sort((a, b) => b.createdAt - a.createdAt)
        return reply.send({ status: 'ok', tasks: list })
    })

    /**
     * POST /tasks/create
     *
     * 教师创建创造级任务。若 poemId 在数据库中存在则使用真实诗信息，
     * 否则要求请求体携带 poemTitle/poet/dynasty 兜底。
     */
    app.post('/tasks/create', async (req: FastifyRequest, reply) => {
        const body = validateBody(createTaskSchema, req, reply)
        if (!body) return

        const { poemId, type, requirements, gradeLevel, teacherId, classId, dueAt, poemTitle, poet, dynasty } = body

        const poem = await loadPoemEntity(poemId)
        const task: CreationTask = {
            id: generateId(),
            poemId,
            poemTitle: poem?.title ?? poemTitle ?? '未知诗作',
            poet: poem?.poet ?? poet ?? '佚名',
            dynasty: poem?.dynasty ?? dynasty ?? '未知',
            type,
            typeLabel: TASK_TYPE_LABEL[type],
            requirements,
            gradeLevel: gradeLevel ?? '5-6年级',
            teacherId,
            classId: classId ?? null,
            createdAt: Date.now(),
            dueAt: dueAt ?? null,
            status: 'open',
        }
        taskStore.set(task.id, task)
        app.log.info({ taskId: task.id, type }, '[creation/tasks/create] 创造级任务已创建')
        return reply.send({ status: 'ok', task, aiGenerated: false })
    })

    /**
     * POST /collaborate/start
     *
     * 启动 AI 协作共创。根据任务类型调用 brush.creative 生成初稿，
     * 创建会话并返回首轮 AI 输出。
     */
    app.post('/collaborate/start', async (req: FastifyRequest, reply) => {
        const body = validateBody(collaborateStartSchema, req, reply)
        if (!body) return

        const { taskId, studentId, teacherId, topic, constraints } = body

        if (!studentId && !teacherId) {
            return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'studentId 或 teacherId 至少一个' })
        }

        const task = taskStore.get(taskId)
        if (!task) {
            return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: `任务 ${taskId} 不存在` })
        }

        const poemNode = await loadPoemNode(task.poemId, task)
        const ctx: AgentContext = {
            taskId: `creation-collab-${taskId}`,
            sessionId: '',
            knowledgeGraphNodes: poemNode ? [poemNode] : [],
            teacherIntent: topic ? JSON.stringify({ mode: 'collaborate-start', topic }) : undefined,
        }

        const input: CreativeInput = {
            type: TASK_TYPE_TO_CREATIVE[task.type],
            poemId: task.poemId,
            topic,
            gradeLevel: task.gradeLevel,
            constraints: constraints ?? [task.requirements],
        }

        try {
            const result = await agents.brush.creative.invoke(input, ctx)
            const output = result.output as CreativeOutput
            const session: CollaborationSession = {
                id: generateId(),
                taskId,
                poemId: task.poemId,
                studentId: studentId ?? null,
                teacherId: teacherId ?? null,
                type: task.type,
                history: [
                    {
                        round: 1,
                        role: 'ai',
                        content: output.content,
                        suggestedImagePrompt: output.suggestedImagePrompt,
                        at: Date.now(),
                        aiGenerated: true,
                    },
                ],
                startedAt: Date.now(),
                updatedAt: Date.now(),
            }
            sessionStore.set(session.id, session)
            app.log.info({ sessionId: session.id, taskId }, '[creation/collaborate/start] AI 协作共创已启动')
            return reply.send({
                status: 'ok',
                sessionId: session.id,
                history: session.history,
                aiGenerated: true,
            })
        } catch (err) {
            app.log.error({ err, taskId }, '[creation/collaborate/start] AI 协作启动失败')
            handleRouteError(err, req, reply, 'AI 协作启动失败')
            return
        }
    })

    /**
     * POST /collaborate/iterate
     *
     * AI 协作迭代：教师/学生输入修改意见 → brush.creative 携带反馈再生成。
     * 保留完整历史，新轮次追加到 history。
     */
    app.post('/collaborate/iterate', async (req: FastifyRequest, reply) => {
        const body = validateBody(collaborateIterateSchema, req, reply)
        if (!body) return

        const { sessionId, feedback, role = 'student' } = body

        const session = sessionStore.get(sessionId)
        if (!session) {
            return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: `协作会话 ${sessionId} 不存在` })
        }

        const task = taskStore.get(session.taskId)
        if (!task) {
            return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: `任务 ${session.taskId} 不存在` })
        }

        // 先记录用户输入
        const userTurn: CollaborationTurn = {
            round: session.history.length + 1,
            role,
            content: feedback,
            at: Date.now(),
            aiGenerated: false,
        }
        session.history.push(userTurn)
        // SqliteMap：mutation 后必须显式 set() 落盘，否则 AI 调用失败时用户反馈会丢失
        sessionStore.set(session.id, session)

        const poemNode = await loadPoemNode(session.poemId, task)
        const ctx: AgentContext = {
            taskId: `creation-collab-iter-${sessionId}`,
            sessionId,
            knowledgeGraphNodes: poemNode ? [poemNode] : [],
            teacherIntent: JSON.stringify({
                mode: 'collaborate-iterate',
                feedback,
                previousTurns: session.history.slice(-4).map((h) => ({ role: h.role, content: h.content })),
            }),
        }

        const input: CreativeInput = {
            type: TASK_TYPE_TO_CREATIVE[session.type],
            poemId: session.poemId,
            topic: feedback,
            gradeLevel: task.gradeLevel,
            constraints: [task.requirements, `上一轮反馈：${feedback}`],
        }

        try {
            const result = await agents.brush.creative.invoke(input, ctx)
            const output = result.output as CreativeOutput
            const aiTurn: CollaborationTurn = {
                round: session.history.length + 1,
                role: 'ai',
                content: output.content,
                suggestedImagePrompt: output.suggestedImagePrompt,
                at: Date.now(),
                aiGenerated: true,
            }
            session.history.push(aiTurn)
            session.updatedAt = Date.now()
            sessionStore.set(session.id, session)
            app.log.info({ sessionId, round: aiTurn.round }, '[creation/collaborate/iterate] AI 协作迭代完成')
            return reply.send({
                status: 'ok',
                sessionId: session.id,
                history: session.history,
                aiGenerated: true,
            })
        } catch (err) {
            app.log.error({ err, sessionId }, '[creation/collaborate/iterate] AI 协作迭代失败')
            handleRouteError(err, req, reply, 'AI 协作迭代失败')
            return
        }
    })

    /**
     * POST /vision-describe
     *
     * 生成配图描述（供学生临摹参考）。
     * 调用 brush.creative 的 illustration-description 类型生成画面感强的视觉描述，
     * 含场景构图、色彩基调、人物姿态、意象布局，可直接作为文生图提示词或临摹参考。
     */
    app.post('/vision-describe', async (req: FastifyRequest, reply) => {
        const body = validateBody(visionDescribeSchema, req, reply)
        if (!body) return

        const { poemId, gradeLevel, topic, constraints } = body

        const poemNode = await loadPoemNode(poemId)
        const ctx: AgentContext = {
            taskId: `creation-vision-${poemId}`,
            sessionId: '',
            knowledgeGraphNodes: poemNode ? [poemNode] : [],
            teacherIntent: topic ? JSON.stringify({ mode: 'vision-describe', topic }) : undefined,
        }

        const input: CreativeInput = {
            type: 'illustration-description',
            poemId,
            topic,
            gradeLevel: gradeLevel ?? '3-4年级',
            constraints,
        }

        try {
            const result = await agents.brush.creative.invoke(input, ctx)
            const output = result.output as CreativeOutput
            return reply.send({
                status: 'ok',
                description: output.content,
                suggestedImagePrompt: output.suggestedImagePrompt,
                poemId,
                aiGenerated: true,
            })
        } catch (err) {
            app.log.error({ err, poemId }, '[creation/vision-describe] 配图描述生成失败')
            handleRouteError(err, req, reply, '配图描述生成失败')
            return
        }
    })

    /**
     * POST /rewrite
     *
     * 诗笔辅助改写：保留原意 + 创新表达。
     * 调用 brush.creative 的 rewrite-example 类型生成改写示例，
     * 返回改写结果与原诗对比。
     */
    app.post('/rewrite', async (req: FastifyRequest, reply) => {
        const body = validateBody(rewriteSchema, req, reply)
        if (!body) return

        const { poemId, direction, gradeLevel, constraints } = body

        const poemNode = await loadPoemNode(poemId)
        const ctx: AgentContext = {
            taskId: `creation-rewrite-${poemId}`,
            sessionId: '',
            knowledgeGraphNodes: poemNode ? [poemNode] : [],
            teacherIntent: JSON.stringify({ mode: 'rewrite', direction }),
        }

        const input: CreativeInput = {
            type: 'rewrite-example',
            poemId,
            topic: direction,
            gradeLevel: gradeLevel ?? '5-6年级',
            constraints: constraints ?? [`改写方向：${direction}`],
        }

        try {
            const result = await agents.brush.creative.invoke(input, ctx)
            const output = result.output as CreativeOutput
            return reply.send({
                status: 'ok',
                original: poemNode?.content ?? '（原诗未提供）',
                rewrite: output.content,
                suggestedImagePrompt: output.suggestedImagePrompt,
                direction,
                poemId,
                aiGenerated: true,
            })
        } catch (err) {
            app.log.error({ err, poemId }, '[creation/rewrite] 改写生成失败')
            handleRouteError(err, req, reply, '改写生成失败')
            return
        }
    })

    /**
     * GET /works
     *
     * 获取学生作品列表。支持按班级 / 诗 / 类型 / 学生筛选。
     */
    app.get('/works', async (req: FastifyRequest, reply) => {
        const query = validateQuery(worksQuerySchema, req, reply)
        if (!query) return
        const { classId, poemId, type, studentId, limit = 100, offset = 0 } = query
        let list = demoWorksWhenEmpty(Array.from(workStore.values()))
        if (classId) list = list.filter((w) => w.classId === classId)
        if (poemId) list = list.filter((w) => w.poemId === poemId)
        if (type) list = list.filter((w) => w.type === type)
        if (studentId) list = list.filter((w) => w.studentId === studentId)
        list.sort((a, b) => b.submittedAt - a.submittedAt)
        const total = list.length
        const paged = list.slice(offset, offset + limit)
        return reply.send({ status: 'ok', works: paged, total })
    })

    /**
     * POST /works/submit
     *
     * 学生提交作品。学生姓名自动脱敏（使用 anonymousName）。
     */
    app.post('/works/submit', async (req: FastifyRequest, reply) => {
        const body = validateBody(submitWorkSchema, req, reply)
        if (!body) return

        const { taskId, studentId, title, content, imageUrl, aiAssisted, collaborationSessionId } = body

        const task = taskStore.get(taskId)
        if (!task) {
            return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: `任务 ${taskId} 不存在` })
        }

        const authenticatedTeacherId = req.auth?.id
        if (!authenticatedTeacherId) {
            return reply.status(401).send({
                status: 'error',
                error: 'AUTHENTICATION_REQUIRED',
                message: '登录会话不存在、已过期或无效',
            })
        }
        const student = repos.students.findById(studentId)
        const studentClass = student ? repos.classes.findById(student.classId) : null
        const collaboration = collaborationSessionId
          ? (sessionStore.get(collaborationSessionId) ?? null)
          : null
        const boundary = resolveCreationSubmissionBoundary({
            authenticatedTeacherId,
            taskId,
            studentId,
            task,
            student,
            studentClass,
            collaborationRequested: collaborationSessionId !== undefined,
            collaboration,
        })
        if (!boundary.accepted) {
            return reply.status(boundary.statusCode).send({
                status: 'error',
                error: boundary.error,
                message: boundary.message,
            })
        }
        const { anonymousName, classId } = boundary

        const work: CreationWork = {
            id: generateId(),
            taskId,
            poemId: task.poemId,
            poemTitle: task.poemTitle,
            poet: task.poet,
            type: task.type,
            typeLabel: task.typeLabel,
            studentId,
            anonymousName,
            classId,
            title,
            content,
            imageUrl: imageUrl ?? null,
            likeCount: 0,
            aiAssisted: aiAssisted ?? false,
            collaborationSessionId: collaborationSessionId ?? null,
            submittedAt: Date.now(),
        }
        workStore.set(work.id, work)
        app.log.info({ workId: work.id, taskId, studentId }, '[creation/works/submit] 学生作品已提交')

        // 闭环3补全：作品提交后推送 WS 事件，前端创作 store 据此刷新作品墙
        if (broadcaster) {
            try {
                const wsEvent: WSEvent = {
                    type: 'business:event',
                    timestamp: Date.now(),
                    sessionId: '',
                    payload: {
                        businessEventType: 'creation:submitted',
                        businessEventPayload: {
                            classId,
                            studentId,
                            poemId: task.poemId,
                            workId: work.id,
                            taskType: task.type,
                        },
                    },
                }
                broadcaster.broadcast(wsEvent)
            } catch {
                // WS 推送失败不影响提交主响应
            }
        }

        return reply.send({ status: 'ok', work, aiGenerated: false })
    })

    /**
     * POST /works/:id/like
     *
     * 点赞作品。同一作品可被多次点赞（教学场景简化，不做去重）。
     */
    app.post('/works/:id/like', async (req: FastifyRequest, reply) => {
        const params = validateParams(workIdParamsSchema, req, reply)
        if (!params) return
        const { id } = params
        const work = workStore.get(id)
            ?? (config.demoMode ? DEMO_CREATION_WORKS.find((item) => item.id === id) : undefined)
        if (!work) {
            return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: `作品 ${id} 不存在` })
        }
        if (work.demoSample) {
            return reply.send({
                status: 'ok',
                workId: id,
                likeCount: work.likeCount + 1,
                demoSample: true,
                persisted: false,
            })
        }
        work.likeCount += 1
        workStore.set(id, work)
        return reply.send({ status: 'ok', workId: id, likeCount: work.likeCount })
    })

    /**
     * GET /works/wall
     *
     * 作品展示墙数据。按点赞数倒序，分页返回。
     */
    app.get('/works/wall', async (req: FastifyRequest, reply) => {
        const query = validateQuery(wallQuerySchema, req, reply)
        if (!query) return
        const { classId, poemId, type, page = 1, pageSize = 24 } = query
        let list = demoWorksWhenEmpty(Array.from(workStore.values()))
        if (classId) list = list.filter((w) => w.classId === classId)
        if (poemId) list = list.filter((w) => w.poemId === poemId)
        if (type) list = list.filter((w) => w.type === type)
        // 按点赞数倒序，相同点赞按提交时间倒序
        list.sort((a, b) => b.likeCount - a.likeCount || b.submittedAt - a.submittedAt)
        const total = list.length
        const safePage = Math.max(1, page)
        const safeSize = Math.min(60, Math.max(1, pageSize))
        const start = (safePage - 1) * safeSize
        const paged = list.slice(start, start + safeSize)
        return reply.send({
            status: 'ok',
            works: paged,
            total,
            page: safePage,
            pageSize: safeSize,
            totalPages: Math.ceil(total / safeSize),
        })
    })

    /**
     * POST /works/:id/grade  —— 闭环3补全：AI 批改学生创造作品
     *
     * 对学生提交的配画/改写/视频脚本/鉴赏文进行 AI 多维度评价，
     * 返回结构化反馈（分数、亮点、改进建议、总评），供学生参考迭代。
     * 批改完成后推送 creation:graded WS 事件，触发前端再创作入口。
     */
    app.post('/works/:id/grade', async (req: FastifyRequest, reply) => {
        const params = validateParams(workIdParamsSchema, req, reply)
        if (!params) return
        const body = validateBody(gradeWorkSchema, req, reply)
        if (!body) return
        const { id } = params
        const { teacherComment, focus = 'overall' } = body

        const work = workStore.get(id)
            ?? (config.demoMode ? DEMO_CREATION_WORKS.find((item) => item.id === id) : undefined)
        if (!work) {
            return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: `作品 ${id} 不存在` })
        }

        if (work.demoSample) {
            return reply.send({
                status: 'ok',
                workId: id,
                grading: {
                    score: 88,
                    level: '优秀',
                    strengths: ['现代场景与原诗“见景生情”的结构呼应清晰', '细节具体，情感表达克制'],
                    improvements: ['可减少一处直接说明，让意象承担更多情感', '结尾可再回扣“灯”的意象'],
                    overallComment: '这是一条用于展示交互的规则化演示评语，不是真实 AI 评分或教学成效证据。',
                },
                aiGenerated: false,
                demoSample: true,
            })
        }

        const gradeSystemPrompt = `你是诗脉·启明的创造作品批改官。对学生提交的古诗创造作品（配画/改写/视频脚本/鉴赏文）进行多维度评价。

## 评价维度
1. 创意性（creativity）：构思是否新颖、是否有独特视角
2. 准确性（accuracy）：诗词理解是否正确、文化背景是否准确
3. 表达力（expression）：语言是否生动、结构是否清晰
4. 总体（overall）：综合评价

## 输出要求
输出严格 JSON：
{"score": 0-100整数, "level": "优秀|良好|合格|需改进", "strengths": ["亮点1", "亮点2"], "improvements": ["改进建议1", "改进建议2"], "overallComment": "总评文字"}
不输出任何解释文字或代码块包裹。`

        const userMessage = `作品类型：${work.typeLabel}
诗作：${work.poemTitle}（${work.poet}）
作品标题：${work.title}
作品正文：
${work.content}
${teacherComment ? `教师附加评语：${teacherComment}` : ''}
评分侧重：${focus}`

        try {
            const result = await router.execute('orchestrator', 'summarize', {
                messages: [
                    { role: 'system', content: gradeSystemPrompt },
                    { role: 'user', content: userMessage },
                ],
                jsonOutput: true,
                metadata: { agent: 'creation-grade', task: 'work-grading' },
            })

            const parsed = safeJsonParse(result.content) as {
                score?: number
                level?: string
                strengths?: string[]
                improvements?: string[]
                overallComment?: string
            }

            const grading = {
                score: typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : 0,
                level: parsed.level ?? '需改进',
                strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 5) : [],
                improvements: Array.isArray(parsed.improvements) ? parsed.improvements.slice(0, 5) : [],
                overallComment: parsed.overallComment ?? '（AI 批改未能生成总评）',
            }

            app.log.info({ workId: id, score: grading.score }, '[creation/works/grade] 作品批改完成')

            // 闭环3补全：批改完成后推送 WS 事件，前端据此展示反馈并开放再创作入口
            if (broadcaster) {
                try {
                    const wsEvent: WSEvent = {
                        type: 'business:event',
                        timestamp: Date.now(),
                        sessionId: '',
                        payload: {
                            businessEventType: 'creation:graded',
                            businessEventPayload: {
                                workId: id,
                                studentId: work.studentId,
                                poemId: work.poemId,
                                taskType: work.type,
                                score: grading.score,
                                level: grading.level,
                            },
                        },
                    }
                    broadcaster.broadcast(wsEvent)
                } catch {
                    // WS 推送失败不影响批改主响应
                }
            }

            return reply.send({ status: 'ok', workId: id, grading, aiGenerated: true })
        } catch (err) {
            app.log.error({ err, workId: id }, '[creation/works/grade] 作品批改失败')
            handleRouteError(err, req, reply, '作品批改失败')
            return
        }
    })

    /**
     * POST /works/:id/recreate  —— 闭环3补全：基于批改反馈再创作
     *
     * 学生收到批改反馈后，携带反馈调用 brush.creative 再生成一版作品，
     * 形成"创作→批改→反馈→再创作"的完整迭代闭环。
     * 再创作完成后推送 creation:feedback WS 事件。
     */
    app.post('/works/:id/recreate', async (req: FastifyRequest, reply) => {
        const params = validateParams(workIdParamsSchema, req, reply)
        if (!params) return
        const body = validateBody(recreateWorkSchema, req, reply)
        if (!body) return
        const { id } = params
        const { feedback, direction } = body

        const work = workStore.get(id)
            ?? (config.demoMode ? DEMO_CREATION_WORKS.find((item) => item.id === id) : undefined)
        if (!work) {
            return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: `作品 ${id} 不存在` })
        }

        const task = taskStore.get(work.taskId)
            ?? (work.demoSample ? DEMO_CREATION_TASK : undefined)
        if (!task) {
            return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: `任务 ${work.taskId} 不存在` })
        }


        if (work.demoSample) {
            return reply.send({
                status: 'ok',
                workId: id,
                recreatedContent: `${work.content}\n\n修订建议：将结尾改为对“灯”的再次凝视，用画面代替直接说明思念。`,
                suggestedImagePrompt: '暖色书桌灯与清冷月光在教室窗边交汇，不出现人脸',
                aiGenerated: false,
                demoSample: true,
            })
        }

        const poemNode = await loadPoemNode(work.poemId, task)
        const ctx: AgentContext = {
            taskId: `creation-recreate-${id}`,
            sessionId: '',
            knowledgeGraphNodes: poemNode ? [poemNode] : [],
            teacherIntent: JSON.stringify({
                mode: 'recreate',
                feedback,
                direction,
                originalWork: work.content.slice(0, 500),
            }),
        }

        const input: CreativeInput = {
            type: TASK_TYPE_TO_CREATIVE[work.type],
            poemId: work.poemId,
            topic: direction ?? feedback,
            gradeLevel: task.gradeLevel,
            constraints: [
                task.requirements,
                `上一版作品：${work.content.slice(0, 300)}`,
                `批改反馈：${feedback}`,
            ],
        }

        try {
            const result = await agents.brush.creative.invoke(input, ctx)
            const output = result.output as CreativeOutput

            app.log.info({ workId: id }, '[creation/works/recreate] 再创作完成')

            // 闭环3补全：再创作完成后推送 WS 事件
            if (broadcaster) {
                try {
                    const wsEvent: WSEvent = {
                        type: 'business:event',
                        timestamp: Date.now(),
                        sessionId: '',
                        payload: {
                            businessEventType: 'creation:feedback',
                            businessEventPayload: {
                                workId: id,
                                studentId: work.studentId,
                                poemId: work.poemId,
                                taskType: work.type,
                                feedbackApplied: feedback,
                            },
                        },
                    }
                    broadcaster.broadcast(wsEvent)
                } catch {
                    // WS 推送失败不影响再创作主响应
                }
            }

            return reply.send({
                status: 'ok',
                workId: id,
                recreatedContent: output.content,
                suggestedImagePrompt: output.suggestedImagePrompt,
                aiGenerated: true,
            })
        } catch (err) {
            app.log.error({ err, workId: id }, '[creation/works/recreate] 再创作失败')
            handleRouteError(err, req, reply, '再创作失败')
            return
        }
    })
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

/**
 * 从数据库加载古诗实体（用于补全任务的诗信息）
 */
async function loadPoemEntity(poemId: string): Promise<PoemEntity | null> {
    try {
        return repos.poems.findById(poemId) ?? null
    } catch {
        return null
    }
}

/**
 * 从数据库加载诗词并转换为 PoemNode（供 brush.creative 上下文使用）
 * 若数据库无此诗，使用 task 兜底信息构造。
 */
async function loadPoemNode(poemId: string, task?: CreationTask): Promise<PoemNode | null> {
    try {
        const poem = repos.poems.findById(poemId)
        if (poem) {
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
        }
    } catch {
        // 数据库查询失败，使用 task 兜底
    }
    if (task) {
        return {
            id: task.poemId,
            title: task.poemTitle,
            poet: task.poet,
            dynasty: task.dynasty,
            content: '（原文未提供，请基于诗词常识创作）',
            theme: [],
            images: [],
            gradeLevel: task.gradeLevel,
        }
    }
    return null
}
