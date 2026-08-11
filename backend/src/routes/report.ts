/**
 * 教研报告自动生成路由（Task 14）—— 真实多智能体协作版
 *
 * 教师总结教学成果、参与教研活动的关键功能。
 *
 * 架构（Loop Engineering：导出→诊断→生成→验收 闭环）：
 *   教师提交报告生成请求
 *     → SubTask 1: db.utils.exporter.exportClassReportData 获取脱敏数据
 *     → SubTask 2: DarkMatterDetector.generateDarkMatterReport 获取暗物质分析
 *     → SubTask 3: brush.report 生成报告（依赖 1+2，携带脱敏数据与诊断）
 *     → SubTask 4: mind.verify 独立验收报告
 *     → WebSocket 实时推送进度
 *     → 结果存入内存报告库 + 返回前端
 *
 * 设计说明：
 * - 与 workbench.ts 一致，本路由直接调用子 Agent，但复用 sessionStore
 *   管理会话状态、broadcaster 推送 WS 事件，保持全链路可观测性。
 * - /generate 为 fire-and-forget：立即返回 reportId + sessionId，结果通过
 *   WebSocket 推送，前端可通过 GET /:reportId 拉取最终结果。
 * - 报告持久化使用模块级 Map（避免修改 db schema），进程重启后历史报告
 *   丢失（教研场景可接受，教师每次生成新报告）。
 *
 * 端点清单：
 *   POST   /generate             生成教研报告（异步，返回 reportId + sessionId）
 *   GET    /:reportId            查询报告内容
 *   GET    /:reportId/export     导出报告为 Word / PDF / Markdown
 *   GET    /                     查询历史报告列表（分页 + 搜索）
 *   DELETE /:reportId            删除报告
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Orchestrator } from '../orchestrator/Orchestrator.js'
import type { SessionStore } from '../orchestrator/session-store.js'
import type { WSBroadcaster } from '../orchestrator/websocket/broadcaster.js'
import { ORCH_EVENTS, type ExecutionResult, type SubTask, type WSEvent } from '../orchestrator/types.js'
import { validateBody, validateParams, validateQuery, schemas } from '../lib/validation.js'
import type { AgentContext, BloomLevel, BloomMastery, ClassContext, DiagnosisResult, LearningEvent } from '../agents/base/types.js'
import type { ReportInput, ReportOutput, ReportSection } from '../agents/brush-agent/report.sub-agent.js'
import type { VerifyInput, VerifyOutput } from '../agents/mind-agent/verify.sub-agent.js'
import type { ClassReportData } from '../db/utils/export.js'
import type { DarkMatterReport } from '../services/knowledge-graph/dark-matter-detector.js'
import { agents } from '../agents/index.js'
import { proactiveIntelligence } from '../agents/base/proactive-intelligence.js'
import { utils, repos } from '../db/index.js'
import { billing } from '../llm/index.js'
import { DarkMatterDetector } from '../services/knowledge-graph/dark-matter-detector.js'
import { KnowledgeGraphService } from '../services/knowledge-graph/knowledge-graph-service.js'
import { config } from '../config.js'
// 持久化存储：原 Map<string, ReportRecord> → SQLite reports 表
import { SqliteMap } from '../db/runtime-store.js'
// 能力 4：多格式导出 + 分享链接
import {
    exportReport,
    type ExportFormat,
    type ExportRequest,
} from '../services/profile/report-exporter.js'
import { registerReportSharingRoutes } from './report-sharing.js'
// 能力 5：家校沟通活页
import {
    generateWeeklyReport,
    HomeSchoolStudentClassMismatchError,
    getLatestWeekly,
    addTeacherNote,
    submitParentFeedback,
    listClassRoster,
    publishWeeklyReport,
    markFeedbackRead,
    completeActivity,
    type CreateWeeklyRequest,
    type SubmitFeedbackRequest,
} from '../services/profile/home-school-book.js'

// ─────────────────────────────────────────────────────────────
// 请求 / 响应类型
// ─────────────────────────────────────────────────────────────

/** 报告模板类型 */
export type ReportTemplate = 'standard' | 'data-driven' | 'narrative' | 'executive'

/** 可包含的章节（多选） */
export type ReportSectionKey =
    | 'background'
    | 'intervention'
    | 'evidence'
    | 'reflection'

// ─────────────────────────────────────────────────────────────
// Zod schemas（B6.3 输入校验）
// ─────────────────────────────────────────────────────────────

/** POST /generate 请求体 */
const generateSchema = z.object({
    classId: schemas.classId,
    teacherId: schemas.teacherId,
    period: z.object({
        from: schemas.sanitizedString(64),
        to: schemas.sanitizedString(64),
    }),
    template: z.enum(['standard', 'data-driven', 'narrative', 'executive']).optional(),
    includeSections: z
        .array(z.enum(['background', 'intervention', 'evidence', 'reflection']))
        .min(1, 'includeSections 不能为空')
        .max(4, 'includeSections 不能超过 4 项')
        .optional(),
})

/** GET/DELETE /:reportId 路径参数 */
const reportIdParamsSchema = z.object({ reportId: schemas.id })

/** GET /:reportId/export 查询参数 */
const exportQuerySchema = z.object({
    format: z.enum(['word', 'pdf', 'markdown']).optional(),
})

/** GET / 查询参数 */
const listQuerySchema = z.object({
    teacherId: schemas.optionalSanitizedString(128),
    classId: schemas.optionalSanitizedString(128),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    keyword: schemas.optionalSanitizedString(200),
})

/**
 * GET /history 查询参数
 *
 * 历史报告是 GET / 列表的超集：额外支持时间范围（from/to）、模板、状态筛选。
 * 前端 `api.report.history()` 契约见 lib/types.ts 的 ReportHistoryQuery。
 * from/to 接受 ISO 日期串（如 2026-07-01）或毫秒时间戳字符串。
 */
const historyQuerySchema = z.object({
    teacherId: schemas.optionalSanitizedString(128),
    classId: schemas.optionalSanitizedString(128),
    from: schemas.optionalSanitizedString(40),
    to: schemas.optionalSanitizedString(40),
    template: z.enum(['standard', 'data-driven', 'narrative', 'executive']).optional(),
    status: z.enum(['generating', 'completed', 'failed']).optional(),
    keyword: schemas.optionalSanitizedString(200),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    offset: z.coerce.number().int().min(0).optional(),
})

/**
 * 解析时间边界参数
 *
 * @param raw ISO 日期串 / 毫秒时间戳字符串
 * @param boundary 'start' 时把纯日期解析为当日 00:00:00，'end' 时解析为当日 23:59:59.999
 * @returns 毫秒时间戳；无法解析时返回 null（视为不过滤，而非过滤掉全部）
 */
function parseTimeBoundary(raw: string | undefined, boundary: 'start' | 'end'): number | null {
    if (!raw) return null
    const trimmed = raw.trim()
    if (!trimmed) return null

    // 纯数字视为毫秒时间戳
    if (/^\d{10,}$/.test(trimmed)) {
        const n = Number(trimmed)
        return Number.isFinite(n) ? n : null
    }

    // 纯日期（YYYY-MM-DD）需补齐边界时刻，否则 to=2026-07-25 会把当天生成的报告全部漏掉
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    const iso = dateOnly
        ? boundary === 'start'
            ? `${trimmed}T00:00:00.000`
            : `${trimmed}T23:59:59.999`
        : trimmed

    const ts = new Date(iso).getTime()
    return Number.isFinite(ts) ? ts : null
}

/** DELETE /:reportId 查询参数 */
const deleteQuerySchema = z.object({
    teacherId: schemas.optionalSanitizedString(128),
})

// ─────────────────────────────────────────────────────────────
// 能力 4 + 5：新增 Zod schemas
// ─────────────────────────────────────────────────────────────

/** POST /export/:reportId 请求体（能力 4） */
const exportBodySchema = z.object({
    format: z.enum(['pdf', 'image', 'excel', 'markdown', 'word']),
    includeSections: z.array(z.enum(['background', 'intervention', 'evidence', 'reflection']))
        .min(1)
        .max(4)
        .optional(),
    includeCharts: z.boolean().optional(),
    includeVerification: z.boolean().optional(),
})

/** POST /home-school/weekly 请求体（能力 5） */
const createWeeklySchema = z.object({
    studentId: schemas.id,
    classId: schemas.classId,
    weekKey: schemas.optionalSanitizedString(20),
})

/** GET /home-school/:studentId/latest 路径参数 */
const weeklyStudentParamsSchema = z.object({
    studentId: schemas.id,
})

/** POST /home-school/:reportId/feedback 请求体（能力 5） */
const feedbackBodySchema = z.object({
    feedbackType: z.enum(['praise', 'concern', 'question', 'suggestion']),
    content: schemas.sanitizedString(2000),
})

/** POST /home-school/:reportId/note 请求体（能力 5：教师批注） */
const teacherNoteSchema = z.object({
    content: schemas.sanitizedString(2000),
    teacherName: schemas.sanitizedString(64),
})

/** GET /home-school/class/:classId 路径参数 */
const classRosterParamsSchema = z.object({
    classId: schemas.classId,
})

/** POST /home-school/:reportId/activity/:activityId/complete 路径参数 */
const activityParamsSchema = z.object({
    reportId: schemas.sanitizedString(120),
    activityId: schemas.sanitizedString(120),
})

// ─────────────────────────────────────────────────────────────
// 报告记录（内存持久化）
// ─────────────────────────────────────────────────────────────

export type ReportStatus = 'generating' | 'completed' | 'failed'

export interface ReportRecord {
    id: string
    teacherId: string
    classId: string
    className: string
    period: { from: number; to: number }
    template: ReportTemplate
    includeSections: ReportSectionKey[]
    status: ReportStatus
    /** brush.report 输出（生成完成后填充） */
    output?: ReportOutput
    /** mind.verify 验收结果（生成完成后填充） */
    verification?: VerifyOutput
    /** 暗物质诊断报告（阶段 2 产出） */
    darkMatterReport?: DarkMatterReport
    /** 脱敏导出数据（阶段 1 产出，供前端图表渲染） */
    exportedData?: ClassReportData
    /** 错误信息（失败时填充） */
    error?: string
    /** 生成进度（0-100） */
    progress: number
    createdAt: number
    updatedAt: number
}

// ─────────────────────────────────────────────────────────────
// SubTask 14.7：报告图表 / 预览类型
// ─────────────────────────────────────────────────────────────

/** 图表类型 */
export type ReportChartType =
    | 'radar'        // 雷达图
    | 'bar'           // 柱状图
    | 'line'          // 折线图
    | 'pie'           // 饼图
    | 'scatter'       // 散点图
    | 'heatmap'       // 热力图

/** 图表数据（结构因 type 而异，前端按 type 解析） */
export interface ReportChartData {
    /** 图表 ID（前端用于锚点定位） */
    chartId: string
    /** 图表类型 */
    type: ReportChartType
    /** 图表标题 */
    title: string
    /** 图表描述（可选） */
    description?: string
    /** 数据来源标识（exportedData / darkMatterReport / output） */
    source: 'classBloomRadar' | 'studentRadars' | 'events' | 'darkMatter' | 'sections' | 'verification'
    /** 图表数据（结构因 type 而异，前端按 type 字段解析） */
    data: unknown
    /** 是否 AI 生成（exportedData 标记为 true） */
    aiGenerated: boolean
}

export interface ReportChartsResponse {
    reportId: string
    /** 报告状态（generating/completed/failed） */
    reportStatus: ReportStatus
    className: string
    period: { from: number; to: number }
    charts: ReportChartData[]
    /** 总图表数 */
    total: number
    /** 报告是否存在 output */
    hasOutput: boolean
    /** 是否含脱敏数据 */
    hasExportedData: boolean
    aiGenerated: boolean
}

/** 报告预览章节 */
export interface ReportPreviewSection {
    /** 章节序号（0-based） */
    index: number
    /** 章节标题 */
    heading: string
    /** 章节预览（前 200 字，超出省略号） */
    preview: string
    /** 完整章节字数 */
    fullLength: number
}

export interface ReportPreviewResponse {
    reportId: string
    /** 报告状态（generating/completed/failed） */
    reportStatus: ReportStatus
    className: string
    period: { from: number; to: number }
    /** 报告标题 */
    title?: string
    /** 关键发现（前 5 条） */
    keyFindings?: string[]
    /** 教学建议（前 5 条） */
    recommendations?: string[]
    /** 章节预览列表 */
    sections: ReportPreviewSection[]
    /** 关键指标 */
    metrics: {
        /** 总字数 */
        wordCount: number
        /** 章节数 */
        sectionCount: number
        /** 图表数（来自 charts） */
        chartCount: number
        /** 核心发现数 */
        keyFindingsCount: number
        /** 教学建议数 */
        recommendationsCount: number
    }
    /** 渲染 HTML（紧凑预览版，用于嵌入式展示） */
    html?: string
    /** 渲染 Markdown */
    markdown?: string
    /** 生成时间戳（output.aiGenerated 标记） */
    generatedAt?: number
    /** 报告生成进度（仅在 status=generating 时有意义） */
    progress?: number
    /** 失败错误信息（仅在 status=failed 时有意义） */
    error?: string
    aiGenerated: boolean
}

/**
 * 模块级报告存储（SQLite 持久化，重启后历史报告完整恢复）
 *
 * 原 Map<string, ReportRecord> → reports 表（teacher_id / class_id / status 索引）
 * ReportRecord 仅含 JSON 可序列化字段，无需 serialize/deserialize 钩子。
 */
const reportStore = new SqliteMap<string, ReportRecord>({
    table: 'reports',
    indexes: [
        { name: 'teacher_id', extract: (v) => v.teacherId },
        { name: 'class_id', extract: (v) => v.classId },
        { name: 'status', extract: (v) => v.status },
    ],
})

// ─────────────────────────────────────────────────────────────
// 插件选项
// ─────────────────────────────────────────────────────────────

export interface ReportRoutesOptions {
    orchestrator: Orchestrator
    sessionStore: SessionStore
    broadcaster: WSBroadcaster
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 验收拒绝时的最大重试次数（与 workbench 一致） */
const MAX_VERIFY_RETRIES = 1

/** 暗物质检测超时（ms）—— 避免长时间阻塞报告生成 */
const DARK_MATTER_TIMEOUT_MS = 3000

/** 验收六维度（与 mind.verify 子 Agent 系统提示一致） */
const VERIFY_CRITERIA = [
    '准确性：所有数据结论可回溯至输入数据，无编造',
    '完整性：四段式章节齐全（教学背景/干预策略/数据实证/反思展望）',
    '一致性：章节间逻辑自洽，数据引用与 masteryData/events 一致',
    '脱敏合规：所有学生姓名已替换为编号（S01、S02...）',
    '教育适宜性：建议可操作，符合小学古诗词教学场景',
    'AI 安全合规：无有害内容，无幻觉，标题含「（AI 生成）」标记',
]

/** 章节中文标题映射 */
const SECTION_TITLES: Record<ReportSectionKey, string> = {
    background: '教学背景',
    intervention: '干预策略',
    evidence: '数据实证',
    reflection: '反思展望',
}

/** 模板描述映射 */
const TEMPLATE_LABELS: Record<ReportTemplate, string> = {
    standard: '标准教研报告',
    'data-driven': '数据驱动型报告',
    narrative: '叙事型报告',
    executive: '摘要型报告',
}

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

export const reportRoutes: FastifyPluginAsync<ReportRoutesOptions> = async (app, opts) => {
    const { sessionStore, broadcaster } = opts

    /**
     * GET /templates
     *
     * 拉取可用的报告模板与章节配置，供前端生成表单下拉选择。
     */
    app.get('/templates', async (_req, reply) => {
        const templates = Object.entries(TEMPLATE_LABELS).map(([key, label]) => ({
            key: key as ReportTemplate,
            label,
        }))
        const sections = Object.entries(SECTION_TITLES).map(([key, label]) => ({
            key: key as ReportSectionKey,
            label,
        }))
        return reply.send({ status: 'ok', templates, sections })
    })

    /**
     * POST /generate
     *
     * 触发教研报告生成闭环（fire-and-forget）。
     * 立即返回 reportId + sessionId，前端通过 WebSocket 监听进度，
     * 生成完成后通过 GET /:reportId 拉取结果。
     */
    app.post(
        '/generate',
        async (req: FastifyRequest, reply) => {
            const body = validateBody(generateSchema, req, reply)
            if (!body) return

            const { classId, period, teacherId } = body
            const template = body.template ?? 'standard'
            const includeSections = body.includeSections ?? ['background', 'intervention', 'evidence', 'reflection']

            // 解析时间范围（schema 仅校验字符串格式，from < to 的语义约束在此校验）
            const fromMs = Date.parse(period.from)
            const toMs = Date.parse(period.to)
            if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
                return reply.status(400).send({
                    statusCode: 400,
                    error: 'Bad Request',
                    message: 'period.from 与 period.to 必须为有效 ISO 字符串，且 from < to',
                })
            }

            // 校验班级存在
            const classEntity = repos.classes.findById(classId)
            if (!classEntity) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `班级 ${classId} 不存在`,
                })
            }

            // 创建报告记录
            const reportId = `rpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            const now = Date.now()
            const record: ReportRecord = {
                id: reportId,
                teacherId,
                classId,
                className: classEntity.name,
                period: { from: fromMs, to: toMs },
                template,
                includeSections,
                status: 'generating',
                progress: 0,
                createdAt: now,
                updatedAt: now,
            }
            reportStore.set(reportId, record)

            // 创建会话
            const session = sessionStore.createSession(teacherId, classId)
            sessionStore.setStatus(session.id, 'executing')

            // 广播会话开始
            broadcast(broadcaster, {
                type: ORCH_EVENTS.SESSION_START,
                timestamp: now,
                sessionId: session.id,
                payload: {
                    teacherId,
                    classId,
                    intent: 'generate-report',
                    reportId,
                    template,
                    className: classEntity.name,
                },
            })

            // fire-and-forget：异步执行生成闭环
            void executeReportGenerationLoop(
                reportId,
                session.id,
                {
                    classId,
                    teacherId,
                    className: classEntity.name,
                    from: fromMs,
                    to: toMs,
                    template,
                    includeSections,
                    classEntity,
                },
                sessionStore,
                broadcaster,
                app.log,
            )
                .then(async () => {
                    // P0-2: 报告生成完成后触发教学反思与建议推送（不阻塞主流程）
                    try {
                        const executionResult: ExecutionResult = {
                            sessionId: session.id,
                            success: true,
                            results: new Map<string, unknown>(),
                            failedTasks: [],
                            skippedTasks: [],
                            totalLatencyMs: Date.now() - now,
                            totalCostYuan: 0,
                            agentInvocations: [],
                        }
                        const reflection = await opts.orchestrator.reflect(executionResult)
                        proactiveIntelligence.checkReflectionSuggestions(reflection)
                    } catch (err) {
                        app.log.warn(
                            { err, reportId, sessionId: session.id },
                            '[report] 反思与建议推送失败（不阻塞）',
                        )
                    }
                })
                .catch((err) => {
                    app.log.error({ err, reportId, sessionId: session.id }, '[report] 生成闭环异常')
                    const rec = reportStore.get(reportId)
                    if (rec) {
                        rec.status = 'failed'
                        rec.error = '报告生成失败'
                        rec.updatedAt = Date.now()
                        // SqliteMap：mutation 后必须显式 set() 落盘
                        reportStore.set(reportId, rec)
                    }
                    sessionStore.setStatus(session.id, 'aborted')
                    const abortBilling = billing.aggregateSession(session.id)
                    broadcast(broadcaster, {
                        type: ORCH_EVENTS.TASK_FAILED,
                        timestamp: Date.now(),
                        sessionId: session.id,
                        payload: {
                            taskId: 'report-generate',
                            reportId,
                            error: '报告生成失败',
                        },
                    })
                    broadcast(broadcaster, {
                        type: ORCH_EVENTS.SESSION_END,
                        timestamp: Date.now(),
                        sessionId: session.id,
                        payload: {
                            status: 'aborted',
                            reportId,
                            totalCostYuan: abortBilling.totalCostYuan,
                            tokenUsage: abortBilling.tokenUsage,
                        },
                    })
                })

            return reply.send({
                reportId,
                sessionId: session.id,
                status: 'generating' as ReportStatus,
                aiGenerated: true,
            })
        },
    )

    /**
     * GET /history
     *
     * 历史报告列表（GET / 的超集：额外支持时间范围 / 模板 / 状态筛选，并回显筛选条件）。
     *
     * 必须声明在 `/:reportId` 之前阅读——虽然 Fastify 的 find-my-way 路由树会让
     * 静态段优先于参数段匹配，但此前该路由压根不存在，`/api/report/history`
     * 会落到 `/:reportId` 上并返回「报告 history 不存在」，导致教研报告页
     * 「历史报告」面板恒为空。
     */
    app.get(
        '/history',
        async (req: FastifyRequest, reply) => {
            const query = validateQuery(historyQuerySchema, req, reply)
            if (!query) return

            const limit = query.limit ?? 20
            const offset = query.offset ?? 0
            const keyword = query.keyword?.trim().toLowerCase()
            const fromTs = parseTimeBoundary(query.from, 'start')
            const toTs = parseTimeBoundary(query.to, 'end')

            let items = Array.from(reportStore.values())

            if (query.teacherId) items = items.filter((r) => r.teacherId === query.teacherId)
            if (query.classId) items = items.filter((r) => r.classId === query.classId)
            if (query.template) items = items.filter((r) => r.template === query.template)
            if (query.status) items = items.filter((r) => r.status === query.status)
            if (fromTs !== null) items = items.filter((r) => r.createdAt >= fromTs)
            if (toTs !== null) items = items.filter((r) => r.createdAt <= toTs)
            if (keyword) {
                items = items.filter((r) => {
                    const title = r.output?.title ?? ''
                    return (
                        title.toLowerCase().includes(keyword) ||
                        r.className.toLowerCase().includes(keyword)
                    )
                })
            }

            items.sort((a, b) => b.createdAt - a.createdAt)

            const total = items.length
            const paged = items.slice(offset, offset + limit)

            return reply.send({
                status: 'ok',
                total,
                limit,
                offset,
                items: paged.map((r) => ({
                    id: r.id,
                    teacherId: r.teacherId,
                    classId: r.classId,
                    className: r.className,
                    template: r.template,
                    status: r.status,
                    progress: r.progress,
                    title: r.output?.title,
                    period: r.period,
                    createdAt: r.createdAt,
                    updatedAt: r.updatedAt,
                    error: r.error,
                })),
                // 筛选条件回显：前端 ReportHistory 面板据此渲染「当前筛选」标签组
                filters: {
                    ...(query.classId ? { classId: query.classId } : {}),
                    ...(query.template ? { template: query.template } : {}),
                    ...(query.status ? { status: query.status } : {}),
                    ...(query.from ? { from: query.from } : {}),
                    ...(query.to ? { to: query.to } : {}),
                },
            })
        },
    )

    /**
     * GET /:reportId
     *
     * 查询报告内容。生成中返回进度，完成返回完整报告。
     */
    app.get(
        '/:reportId',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(reportIdParamsSchema, req, reply)
            if (!params) return
            const { reportId } = params
            const record = reportStore.get(reportId)
            if (!record) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `报告 ${reportId} 不存在`,
                })
            }
            return reply.send({
                status: 'ok',
                report: record,
                aiGenerated: true,
            })
        },
    )

    /**
     * GET /:reportId/export?format=word|pdf|markdown
     *
     * 导出报告为指定格式。
     * - markdown：返回纯 Markdown 文本
     * - word：返回带 Word 兼容头的 HTML（前端用 Blob + application/msword 下载）
     * - pdf：返回打印友好的 HTML，用户通过浏览器“打印 / 另存为 PDF”生成真实 PDF
     */
    app.get(
        '/:reportId/export',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(reportIdParamsSchema, req, reply)
            if (!params) return
            const { reportId } = params
            const query = validateQuery(exportQuerySchema, req, reply)
            if (!query) return
            const format = query.format ?? 'markdown'
            const record = reportStore.get(reportId)
            if (!record) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `报告 ${reportId} 不存在`,
                })
            }
            if (record.status !== 'completed' || !record.output) {
                return reply.status(409).send({
                    statusCode: 409,
                    error: 'Conflict',
                    message: `报告尚未生成完成（当前状态: ${record.status}）`,
                })
            }

            const markdown = renderReportMarkdown(record)
            const className = record.className

            if (format === 'markdown') {
                return reply.type('text/markdown; charset=utf-8').send(markdown)
            }

            if (format === 'word') {
                const html = renderReportHtml(record, markdown)
                return reply
                    .type('application/msword; charset=utf-8')
                    .header(
                        'Content-Disposition',
                        `attachment; filename="${encodeURIComponent(className)}-教研报告.doc"`,
                    )
                    .send(html)
            }

            if (format === 'pdf') {
                const html = renderReportHtml(record, markdown, true)
                return reply
                    .type('text/html; charset=utf-8')
                    .header(
                        'Content-Disposition',
                        `inline; filename*=UTF-8''${encodeURIComponent(className)}-%E6%95%99%E7%A0%94%E6%8A%A5%E5%91%8A.html`,
                    )
                    .send(html)
            }

            return reply.status(400).send({
                statusCode: 400,
                error: 'Bad Request',
                message: 'format 仅支持 word / pdf / markdown',
            })
        },
    )

    // ── SubTask 14.7: GET /:reportId/charts — 报告图表数据 ──
    // 从 ReportRecord.exportedData / darkMatterReport / output 提取图表数据
    app.get(
        '/:reportId/charts',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(reportIdParamsSchema, req, reply)
            if (!params) return
            const { reportId } = params
            const record = reportStore.get(reportId)
            if (!record) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `报告 ${reportId} 不存在`,
                })
            }

            try {
                const charts = extractReportCharts(record)
                return reply.send({
                    status: 'ok',
                    reportId,
                    reportStatus: record.status,
                    className: record.className,
                    period: record.period,
                    charts,
                    total: charts.length,
                    hasOutput: !!record.output,
                    hasExportedData: !!record.exportedData,
                    aiGenerated: !!record.output?.aiGenerated || !!record.exportedData?.aiGenerated,
                })
            } catch (err) {
                req.log.error({ err, reportId }, '报告图表数据提取失败')
                return reply.send({
                    status: 'degraded',
                    reportId,
                    reportStatus: record.status,
                    className: record.className,
                    period: record.period,
                    charts: [],
                    total: 0,
                    hasOutput: !!record.output,
                    hasExportedData: !!record.exportedData,
                    aiGenerated: false,
                })
            }
        },
    )

    // ── SubTask 14.7: GET /:reportId/preview — 报告预览（紧凑摘要） ──
    // 返回报告摘要 + 章节预览（每章节前 200 字）+ 关键指标 + HTML/Markdown 渲染
    app.get(
        '/:reportId/preview',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(reportIdParamsSchema, req, reply)
            if (!params) return
            const { reportId } = params
            const record = reportStore.get(reportId)
            if (!record) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `报告 ${reportId} 不存在`,
                })
            }

            // 报告生成中：返回进度
            if (record.status === 'generating') {
                return reply.send({
                    status: 'ok',
                    reportId,
                    reportStatus: record.status,
                    className: record.className,
                    period: record.period,
                    progress: record.progress,
                    sections: [],
                    metrics: {
                        wordCount: 0,
                        sectionCount: 0,
                        chartCount: 0,
                        keyFindingsCount: 0,
                        recommendationsCount: 0,
                    },
                    aiGenerated: false,
                })
            }

            // 报告失败：返回错误信息
            if (record.status === 'failed') {
                return reply.send({
                    status: 'ok',
                    reportId,
                    reportStatus: record.status,
                    className: record.className,
                    period: record.period,
                    error: record.error,
                    sections: [],
                    metrics: {
                        wordCount: 0,
                        sectionCount: 0,
                        chartCount: 0,
                        keyFindingsCount: 0,
                        recommendationsCount: 0,
                    },
                    aiGenerated: false,
                })
            }

            // 报告完成：返回完整预览
            try {
                const output = record.output
                const sections: ReportPreviewSection[] = (output?.sections ?? []).map((sec, i) => {
                    const content = sec.content ?? ''
                    const fullLength = content.length
                    const preview = content.length > 200
                        ? content.slice(0, 200) + '...'
                        : content
                    return {
                        index: i,
                        heading: sec.heading,
                        preview,
                        fullLength,
                    }
                })

                const wordCount = sections.reduce((sum, s) => sum + s.fullLength, 0)
                const charts = extractReportCharts(record)
                const markdown = output ? renderReportMarkdown(record) : undefined
                const html = output ? renderReportHtml(record, markdown ?? '', true) : undefined

                return reply.send({
                    status: 'ok',
                    reportId,
                    reportStatus: record.status,
                    className: record.className,
                    period: record.period,
                    title: output?.title,
                    keyFindings: output?.keyFindings?.slice(0, 5),
                    recommendations: output?.recommendations?.slice(0, 5),
                    sections,
                    metrics: {
                        wordCount,
                        sectionCount: sections.length,
                        chartCount: charts.length,
                        keyFindingsCount: output?.keyFindings?.length ?? 0,
                        recommendationsCount: output?.recommendations?.length ?? 0,
                    },
                    html,
                    markdown,
                    generatedAt: record.updatedAt,
                    aiGenerated: !!output?.aiGenerated,
                })
            } catch (err) {
                req.log.error({ err, reportId }, '报告预览生成失败')
                return reply.send({
                    status: 'degraded',
                    reportId,
                    reportStatus: record.status,
                    className: record.className,
                    period: record.period,
                    sections: [],
                    metrics: {
                        wordCount: 0,
                        sectionCount: 0,
                        chartCount: 0,
                        keyFindingsCount: 0,
                        recommendationsCount: 0,
                    },
                    aiGenerated: false,
                })
            }
        },
    )

    /**
     * GET /
     *
     * 查询历史报告列表（分页 + 搜索）。
     */
    app.get(
        '/',
        async (req: FastifyRequest, reply) => {
            const query = validateQuery(listQuerySchema, req, reply)
            if (!query) return
            const teacherId = query.teacherId
            const classId = query.classId
            const limit = query.limit ?? 10
            const offset = query.offset ?? 0
            const keyword = query.keyword?.trim().toLowerCase()

            let items = Array.from(reportStore.values())

            // 按教师过滤
            if (teacherId) {
                items = items.filter((r) => r.teacherId === teacherId)
            }
            // 按班级过滤
            if (classId) {
                items = items.filter((r) => r.classId === classId)
            }
            // 关键词搜索（标题/班级名/错误信息）
            if (keyword) {
                items = items.filter((r) => {
                    const title = r.output?.title ?? ''
                    return (
                        title.toLowerCase().includes(keyword) ||
                        r.className.toLowerCase().includes(keyword) ||
                        (r.error ?? '').toLowerCase().includes(keyword)
                    )
                })
            }

            // 按创建时间倒序
            items.sort((a, b) => b.createdAt - a.createdAt)

            const total = items.length
            const paged = items.slice(offset, offset + limit)

            // 返回摘要（不包含完整 output，避免响应过大）
            const summaries = paged.map((r) => ({
                id: r.id,
                teacherId: r.teacherId,
                classId: r.classId,
                className: r.className,
                template: r.template,
                status: r.status,
                progress: r.progress,
                title: r.output?.title,
                period: r.period,
                createdAt: r.createdAt,
                updatedAt: r.updatedAt,
                error: r.error,
            }))

            return reply.send({
                status: 'ok',
                total,
                limit,
                offset,
                items: summaries,
                aiGenerated: true,
            })
        },
    )

    /**
     * DELETE /:reportId
     *
     * 删除报告。
     */
    app.delete(
        '/:reportId',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(reportIdParamsSchema, req, reply)
            if (!params) return
            const { reportId } = params
            const query = validateQuery(deleteQuerySchema, req, reply)
            if (!query) return
            const teacherId = query.teacherId
            const record = reportStore.get(reportId)
            if (!record) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `报告 ${reportId} 不存在`,
                })
            }
            if (teacherId && record.teacherId !== teacherId) {
                return reply.status(403).send({
                    statusCode: 403,
                    error: 'Forbidden',
                    message: '仅报告所有者可删除',
                })
            }

            reportStore.delete(reportId)
            app.log.info({ reportId }, '[report/delete] 报告已删除')

            return reply.send({ status: 'ok', reportId, deleted: true })
        },
    )

    // ═══════════════════════════════════════════════════════════
    // 能力 4：多格式导出端点
    // ═══════════════════════════════════════════════════════════

    /**
     * POST /export/:reportId
     *
     * 导出报告为指定格式（pdf / image / excel / markdown / word）。
     * 返回内容字符串，前端通过 Blob 下载。
     */
    app.post(
        '/export/:reportId',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(reportIdParamsSchema, req, reply)
            if (!params) return
            const { reportId } = params
            const body = validateBody(exportBodySchema, req, reply)
            if (!body) return

            const record = reportStore.get(reportId)
            if (!record) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `报告 ${reportId} 不存在`,
                })
            }
            if (record.status !== 'completed' || !record.output) {
                return reply.status(409).send({
                    statusCode: 409,
                    error: 'Conflict',
                    message: `报告尚未生成完成（当前状态: ${record.status}）`,
                })
            }

            const exportReq: ExportRequest = {
                reportId,
                format: body.format as ExportFormat,
                includeSections: body.includeSections,
                includeCharts: body.includeCharts,
                includeVerification: body.includeVerification,
            }

            const result = await exportReport(exportReq, {
                reportId,
                className: record.className,
                period: record.period,
                output: {
                    title: record.output.title,
                    sections: record.output.sections,
                    keyFindings: record.output.keyFindings,
                    recommendations: record.output.recommendations,
                },
                verification: record.verification,
                exportedData: record.exportedData
                    ? {
                        anonymizedStudents: record.exportedData.anonymizedStudents.map((s) => ({
                            id: s.id,
                            name: s.anonymousName,
                        })),
                        classBloomRadar: record.exportedData.classBloomRadar as unknown as Record<string, number>,
                        events: record.exportedData.events
                            .filter((e) => e.studentId !== null)
                            .map((e) => ({
                                studentId: e.studentId as string,
                                type: e.type,
                                occurredAt: e.occurredAt,
                                action: e.action,
                            })),
                    }
                    : undefined,
            })

            return reply.send({ status: 'ok', result, aiGenerated: true })
        },
    )

    registerReportSharingRoutes(app, {
        getReport: (reportId) => reportStore.get(reportId),
        renderMarkdown: renderReportMarkdown,
        getSensitiveTerms: getReportShareSensitiveTerms,
    })

    // ═══════════════════════════════════════════════════════════
    // 能力 5：家校沟通活页端点
    // ═══════════════════════════════════════════════════════════

    /**
     * GET /home-school/class/:classId
     *
     * 家校联系本左栏花名册：一次拿到全班学生 + 各自最新周报状态。
     *
     * 必须注册在 `/home-school/:studentId/latest` 之前——两者都是三段路径，
     * 靠 `class` 这个静态段区分。Fastify 的 radix 路由静态段优先于参数段，
     * 顺序其实不敏感；这里前置只是让"静态在前"这条约定在源码里也成立。
     */
    app.get(
        '/home-school/class/:classId',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(classRosterParamsSchema, req, reply)
            if (!params) return

            const cls = repos.classes.findById(params.classId)
            if (!cls) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `班级 ${params.classId} 不存在`,
                })
            }

            return reply.send({
                status: 'ok',
                classId: params.classId,
                className: cls.name,
                roster: listClassRoster(params.classId),
            })
        },
    )

    /**
     * POST /home-school/weekly
     *
     * 生成（或获取缓存的）家校周报。
     */
    app.post(
        '/home-school/weekly',
        async (req: FastifyRequest, reply) => {
            const body = validateBody(createWeeklySchema, req, reply)
            if (!body) return

            const student = repos.students.findById(body.studentId)
            if (!student) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `学生 ${body.studentId} 不存在`,
                })
            }

            if (body.classId !== student.classId) {
                return reply.status(409).send({
                    status: 'error',
                    error: 'STUDENT_CLASS_MISMATCH',
                    message: '学生不属于指定班级',
                })
            }

            const weeklyReq: CreateWeeklyRequest = {
                studentId: body.studentId,
                // 服务端学生实体是班级归属唯一真相源，客户端字段仅用于冲突检测。
                classId: student.classId,
                weekKey: body.weekKey,
            }

            try {
                const result = await generateWeeklyReport(weeklyReq)
                return reply.send({ status: 'ok', report: result.report, cached: result.cached, aiGenerated: true })
            } catch (err) {
                // 防御学生在路由校验与服务读取之间被迁班的竞态。
                if (err instanceof HomeSchoolStudentClassMismatchError) {
                    return reply.status(409).send({
                        status: 'error',
                        error: err.code,
                        message: err.message,
                    })
                }
                throw err
            }
        },
    )

    /**
     * GET /home-school/:studentId/latest
     *
     * 获取学生最新家校周报。
     */
    app.get(
        '/home-school/:studentId/latest',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(weeklyStudentParamsSchema, req, reply)
            if (!params) return

            const report = getLatestWeekly(params.studentId)
            if (!report) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: '暂无家校周报',
                })
            }

            return reply.send({ status: 'ok', report, aiGenerated: true })
        },
    )

    /**
     * POST /home-school/:reportId/feedback
     *
     * 提交家长反馈。
     */
    app.post(
        '/home-school/:reportId/feedback',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(reportIdParamsSchema, req, reply)
            if (!params) return
            const body = validateBody(feedbackBodySchema, req, reply)
            if (!body) return

            const feedbackReq: SubmitFeedbackRequest = {
                feedbackType: body.feedbackType,
                content: body.content,
            }

            const report = submitParentFeedback(params.reportId, feedbackReq)
            if (!report) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `周报 ${params.reportId} 不存在`,
                })
            }

            return reply.send({ status: 'ok', report, aiGenerated: true })
        },
    )

    /**
     * POST /home-school/:reportId/note
     *
     * 教师添加批注。
     */
    app.post(
        '/home-school/:reportId/note',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(reportIdParamsSchema, req, reply)
            if (!params) return
            const body = validateBody(teacherNoteSchema, req, reply)
            if (!body) return

            const report = addTeacherNote(params.reportId, body.content, body.teacherName)
            if (!report) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `周报 ${params.reportId} 不存在`,
                })
            }

            return reply.send({ status: 'ok', report, aiGenerated: true })
        },
    )

    // ── 以下三条补齐了 service 里早已实现、却一直没有路由出口的能力 ──
    // publishWeeklyReport / markFeedbackRead / completeActivity 此前是死代码：
    // 逻辑写好了，前端却无从调用，周报永远停在 draft、反馈永远未读、
    // 亲子活动永远勾不上。家校联系本因此只能"看"不能"用"。

    /**
     * POST /home-school/:reportId/publish
     *
     * 发布周报（draft → published）。发布后家长侧才可见，
     * 也是教师"这一周我确认过了"的留痕。
     */
    app.post(
        '/home-school/:reportId/publish',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(reportIdParamsSchema, req, reply)
            if (!params) return

            const report = publishWeeklyReport(params.reportId)
            if (!report) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `周报 ${params.reportId} 不存在`,
                })
            }
            return reply.send({ status: 'ok', report })
        },
    )

    /**
     * POST /home-school/:reportId/feedback/read
     *
     * 教师把该周报下的家长反馈全部标记为已读。
     */
    app.post(
        '/home-school/:reportId/feedback/read',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(reportIdParamsSchema, req, reply)
            if (!params) return

            const report = markFeedbackRead(params.reportId)
            if (!report) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `周报 ${params.reportId} 不存在`,
                })
            }
            return reply.send({ status: 'ok', report })
        },
    )

    /**
     * POST /home-school/:reportId/activity/:activityId/complete
     *
     * 勾选一项亲子活动为已完成。
     */
    app.post(
        '/home-school/:reportId/activity/:activityId/complete',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(activityParamsSchema, req, reply)
            if (!params) return

            const report = completeActivity(params.reportId, params.activityId)
            if (!report) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `周报或活动不存在：${params.reportId} / ${params.activityId}`,
                })
            }
            return reply.send({ status: 'ok', report })
        },
    )
}

// ─────────────────────────────────────────────────────────────
// 核心生成闭环
// ─────────────────────────────────────────────────────────────

interface GenerationContext {
    classId: string
    teacherId: string
    className: string
    from: number
    to: number
    template: ReportTemplate
    includeSections: ReportSectionKey[]
    classEntity: { id: string; name: string; grade: string; studentCount: number }
}

/**
 * 执行"导出→诊断→生成→验收"四阶段闭环
 *
 * 流程：
 *   1. db.utils.exporter.exportClassReportData 获取脱敏数据
 *   2. DarkMatterDetector.generateDarkMatterReport 获取暗物质分析
 *   3. brush.report 生成报告（依赖 1+2）
 *   4. mind.verify 独立验收
 *
 * 全程通过 WebSocket 推送 task:start / task:done / task:failed 事件，
 * 并更新 reportStore 中报告记录的 progress 字段。
 */
async function executeReportGenerationLoop(
    reportId: string,
    sessionId: string,
    ctx: GenerationContext,
    sessionStore: SessionStore,
    broadcaster: WSBroadcaster,
    log: FastifyInstance['log'],
): Promise<void> {
    const { classId, className, from, to, template, includeSections, classEntity } = ctx

    // ── 阶段 1：脱敏数据导出 ──
    const exportTaskId = `rpt-export-${reportId}`
    broadcastTaskStart(broadcaster, sessionId, exportTaskId, 'db.exporter', reportId, 10)
    const exportStartedAt = Date.now()

    let exportedData: ClassReportData
    try {
        exportedData = utils.exporter.exportClassReportData(classId, { from, to })
        const exportTask: SubTask = {
            id: exportTaskId,
            agentId: 'db.exporter',
            input: { classId, from, to },
            dependencies: [],
            status: 'success',
            result: { studentCount: exportedData.anonymizedStudents.length, eventCount: exportedData.events.length },
            startedAt: exportStartedAt,
            endedAt: Date.now(),
        }
        sessionStore.updateTaskState(sessionId, exportTask)
        broadcastTaskDone(broadcaster, sessionId, exportTask, reportId, 25)
        updateReportProgress(reportId, 25, { exportedData })
    } catch (err) {
        const exportTask: SubTask = {
            id: exportTaskId,
            agentId: 'db.exporter',
            input: { classId, from, to },
            dependencies: [],
            status: 'failed',
            error: '数据导出失败',
            startedAt: exportStartedAt,
            endedAt: Date.now(),
        }
        sessionStore.updateTaskState(sessionId, exportTask)
        broadcastTaskFailed(broadcaster, sessionId, exportTask, reportId)
        throw err
    }

    // ── 阶段 2：暗物质检测（带超时降级） ──
    const dmTaskId = `rpt-darkmatter-${reportId}`
    broadcastTaskStart(broadcaster, sessionId, dmTaskId, 'dark-matter-detector', reportId, 30)
    const dmStartedAt = Date.now()

    let darkMatterReport: DarkMatterReport | undefined
    try {
        darkMatterReport = await withTimeout(
            detectDarkMatter(classId),
            DARK_MATTER_TIMEOUT_MS,
            undefined,
        )
        const dmTask: SubTask = {
            id: dmTaskId,
            agentId: 'dark-matter-detector',
            input: { classId },
            dependencies: [exportTaskId],
            status: 'success',
            result: darkMatterReport ?? { totalDarkMatter: 0 },
            startedAt: dmStartedAt,
            endedAt: Date.now(),
        }
        sessionStore.updateTaskState(sessionId, dmTask)
        broadcastTaskDone(broadcaster, sessionId, dmTask, reportId, 45)
        updateReportProgress(reportId, 45, { darkMatterReport })
    } catch (err) {
        // 暗物质检测失败不阻断，降级为无诊断
        log.warn({ err, reportId }, '[report] 暗物质检测失败，降级为无诊断')
        const dmTask: SubTask = {
            id: dmTaskId,
            agentId: 'dark-matter-detector',
            input: { classId },
            dependencies: [exportTaskId],
            status: 'failed',
            error: '暗物质检测失败',
            startedAt: dmStartedAt,
            endedAt: Date.now(),
        }
        sessionStore.updateTaskState(sessionId, dmTask)
        broadcastTaskFailed(broadcaster, sessionId, dmTask, reportId)
    }

    // ── 阶段 3：brush.report 生成报告 ──
    let retryCount = 0
    let lastVerification: VerifyOutput | undefined
    let lastOutput: ReportOutput | undefined

    while (retryCount <= MAX_VERIFY_RETRIES) {
        const reportTaskId = `rpt-brush-report-${retryCount}-${reportId}`
        broadcastTaskStart(broadcaster, sessionId, reportTaskId, 'brush.report', reportId, 50 + retryCount * 15)
        const reportStartedAt = Date.now()

        // 构造 brush.report 输入
        const classContext: ClassContext = {
            id: classEntity.id,
            name: classEntity.name,
            grade: classEntity.grade,
            studentCount: classEntity.studentCount,
            averageMastery: exportedData.classBloomRadar,
            engagementScore: computeAverageEngagement(exportedData.events),
        }

        // 构造诊断结果（基于暗物质报告）
        const diagnosisResults: DiagnosisResult[] = darkMatterReport && darkMatterReport.topPatterns.length > 0
            ? [{
                scope: 'class' as const,
                targetId: classId,
                darkMatter: darkMatterReport.topPatterns.map((p) => ({
                    poemId: p.affectedPoems[0] ?? '',
                    bloomLevel: (extractBloomLevelFromPattern(p.pattern) ?? '分析') as BloomLevel,
                    pattern: p.pattern,
                    severity: p.affectedStudents >= 5 ? 'high' : p.affectedStudents >= 2 ? 'medium' : 'low',
                    rootCause: p.prescription,
                    prescription: p.prescription,
                })),
                knowledgeGaps: [],
                bloomImbalance: detectBloomImbalance(exportedData.classBloomRadar),
                aiGenerated: true,
                confidence: 0.85,
            }]
            : []

        // 构造掌握度数据
        const masteryData = {
            average: exportedData.classBloomRadar,
            trend: computeMasteryTrend(exportedData.events, from, to),
        }

        // 构造事件流（裁剪为 LearningEvent[]）
        const events: LearningEvent[] = exportedData.events.map((e) => ({
            type: normalizeEventType(e.type),
            timestamp: e.occurredAt,
            poemId: e.poemId ?? undefined,
            detail: e.action,
        }))

        const reportInput: ReportInput = {
            scope: 'class',
            targetId: classId,
            timeRange: { start: from, end: to },
            classContext,
            diagnosisResults,
            masteryData,
            events,
        }

        const reportCtx: AgentContext = {
            taskId: reportTaskId,
            sessionId,
            classContext,
            teacherIntent: retryCount > 0 && lastVerification
                ? JSON.stringify({
                    mode: 'regenerate',
                    reason: '上一轮验收未通过',
                    verdict: lastVerification.verdict,
                    score: lastVerification.score,
                    issues: lastVerification.issues,
                })
                : JSON.stringify({
                    mode: 'generate',
                    template,
                    includeSections,
                    className,
                }),
        }

        try {
            const result = await agents.brush.report.invoke(reportInput, reportCtx)
            lastOutput = result.output as ReportOutput

            const reportTask: SubTask = {
                id: reportTaskId,
                agentId: 'brush.report',
                input: { classId, template, includeSections },
                dependencies: [exportTaskId, dmTaskId],
                status: 'success',
                result: lastOutput,
                startedAt: reportStartedAt,
                endedAt: Date.now(),
            }
            sessionStore.updateTaskState(sessionId, reportTask)
            broadcastTaskDone(broadcaster, sessionId, reportTask, reportId, 70 + retryCount * 10)
            updateReportProgress(reportId, 70 + retryCount * 10, { output: lastOutput })
        } catch (err) {
            const reportTask: SubTask = {
                id: reportTaskId,
                agentId: 'brush.report',
                input: { classId, template },
                dependencies: [exportTaskId, dmTaskId],
                status: 'failed',
                error: '报告生成失败',
                startedAt: reportStartedAt,
                endedAt: Date.now(),
            }
            sessionStore.updateTaskState(sessionId, reportTask)
            broadcastTaskFailed(broadcaster, sessionId, reportTask, reportId)
            throw err
        }

        // ── 阶段 4：mind.verify 验收 ──
        const verifyTaskId = `rpt-mind-verify-${retryCount}-${reportId}`
        broadcastTaskStart(broadcaster, sessionId, verifyTaskId, 'mind.verify', reportId, 80 + retryCount * 5)
        const verifyStartedAt = Date.now()

        const verifyInput: VerifyInput = {
            targetAgentId: 'brush.report',
            targetOutput: lastOutput,
            originalInput: {
                classId,
                className,
                template,
                includeSections,
                timeRange: { from, to },
            },
            criteria: VERIFY_CRITERIA,
        }

        const verifyCtx: AgentContext = {
            taskId: verifyTaskId,
            sessionId,
            classContext,
        }

        try {
            const verifyResult = await agents.mind.verify.invoke(verifyInput, verifyCtx)
            lastVerification = verifyResult.output as VerifyOutput

            const verifyTask: SubTask = {
                id: verifyTaskId,
                agentId: 'mind.verify',
                input: verifyInput,
                dependencies: [reportTaskId],
                status: 'success',
                result: lastVerification,
                startedAt: verifyStartedAt,
                endedAt: Date.now(),
            }
            sessionStore.updateTaskState(sessionId, verifyTask)
            broadcastTaskDone(broadcaster, sessionId, verifyTask, reportId, 95)
            updateReportProgress(reportId, 95, { verification: lastVerification })
        } catch (err) {
            const verifyTask: SubTask = {
                id: verifyTaskId,
                agentId: 'mind.verify',
                input: verifyInput,
                dependencies: [reportTaskId],
                status: 'failed',
                error: '验收失败',
                startedAt: verifyStartedAt,
                endedAt: Date.now(),
            }
            sessionStore.updateTaskState(sessionId, verifyTask)
            broadcastTaskFailed(broadcaster, sessionId, verifyTask, reportId)
            log.warn({ err, reportId }, '[report] 验收失败，采用未验收结果降级返回')
            // 验收失败不阻断，降级返回生成结果
            break
        }

        // ── 决策 ──
        if (lastVerification.verdict !== 'reject') {
            // pass 或 revise：结束
            // 若 revise 且有 revisedOutput，采用修订版本
            if (lastVerification.verdict === 'revise' && lastVerification.revisedOutput) {
                const revised = lastVerification.revisedOutput as ReportOutput
                if (revised?.title && revised?.sections) {
                    lastOutput = revised
                }
            }
            break
        }

        retryCount += 1
        if (retryCount > MAX_VERIFY_RETRIES) {
            log.warn(
                { reportId, verdict: lastVerification.verdict, score: lastVerification.score },
                '[report] 验收仍为 reject，已达最大重试次数，降级返回',
            )
            break
        }
    }

    // ── 完成 ──
    updateReportProgress(reportId, 100, {
        output: lastOutput,
        verification: lastVerification,
        status: 'completed',
    })

    sessionStore.setStatus(sessionId, 'completed')
    const reportBilling = billing.aggregateSession(sessionId)
    broadcast(broadcaster, {
        type: ORCH_EVENTS.SESSION_END,
        timestamp: Date.now(),
        sessionId,
        payload: {
            status: 'completed',
            reportId,
            verdict: lastVerification?.verdict,
            score: lastVerification?.score,
            totalCostYuan: reportBilling.totalCostYuan,
            tokenUsage: reportBilling.tokenUsage,
        },
    })
}

// ─────────────────────────────────────────────────────────────
// 辅助函数：广播
// ─────────────────────────────────────────────────────────────

/** 广播事件 */
function broadcast(broadcaster: WSBroadcaster, event: WSEvent): void {
    broadcaster.broadcast(event)
}

/** 广播任务开始（携带 reportId 与 progress） */
function broadcastTaskStart(
    broadcaster: WSBroadcaster,
    sessionId: string,
    taskId: string,
    agentId: string,
    reportId?: string,
    progress?: number,
): void {
    broadcast(broadcaster, {
        type: ORCH_EVENTS.TASK_START,
        timestamp: Date.now(),
        sessionId,
        payload: { taskId, agentId, reportId, progress },
    })
}

/** 广播任务完成 */
function broadcastTaskDone(
    broadcaster: WSBroadcaster,
    sessionId: string,
    task: SubTask,
    reportId?: string,
    progress?: number,
): void {
    broadcast(broadcaster, {
        type: ORCH_EVENTS.TASK_DONE,
        timestamp: Date.now(),
        sessionId,
        payload: {
            taskId: task.id,
            agentId: task.agentId,
            status: task.status,
            reportId,
            progress,
            endedAt: task.endedAt,
        },
    })
}

/** 广播任务失败 */
function broadcastTaskFailed(
    broadcaster: WSBroadcaster,
    sessionId: string,
    task: SubTask,
    reportId?: string,
): void {
    broadcast(broadcaster, {
        type: ORCH_EVENTS.TASK_FAILED,
        timestamp: Date.now(),
        sessionId,
        payload: {
            taskId: task.id,
            agentId: task.agentId,
            reportId,
            error: task.error,
            endedAt: task.endedAt,
        },
    })
}

// ─────────────────────────────────────────────────────────────
// 辅助函数：报告记录更新
// ─────────────────────────────────────────────────────────────

/** 更新报告进度与字段 */
function updateReportProgress(
    reportId: string,
    progress: number,
    patch: Partial<ReportRecord>,
): void {
    const record = reportStore.get(reportId)
    if (!record) return
    record.progress = progress
    record.updatedAt = Date.now()
    Object.assign(record, patch)
    // SqliteMap：mutation 后必须显式 set() 落盘
    reportStore.set(reportId, record)
}

// ─────────────────────────────────────────────────────────────
// 辅助函数：数据计算
// ─────────────────────────────────────────────────────────────

/**
 * 暗物质检测（带降级）
 *
 * 复用 dashboard.ts 的实例化模式：每次新建 KnowledgeGraphService +
 * DarkMatterDetector。Neo4j 不可用时 detectClassDarkMatter 返回空数组，
 * generateDarkMatterReport 返回零值报告。
 */
async function detectDarkMatter(classId: string): Promise<DarkMatterReport> {
    const kgService = new KnowledgeGraphService(
        config.neo4j.uri,
        config.neo4j.user,
        config.neo4j.password,
    )
    const detector = new DarkMatterDetector(kgService)
    try {
        return await detector.generateDarkMatterReport(classId)
    } finally {
        // 报告生成是按请求临时创建 Driver 的兼容路径；关闭必须覆盖成功、
        // Neo4j 降级与异常，避免后台批量生成耗尽连接资源。
        await kgService.close()
    }
}

/**
 * 带超时的 Promise 包装
 */
async function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    fallback: T,
): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`操作超时（${ms}ms）`)), ms)
            }),
        ])
    } catch {
        return fallback
    } finally {
        if (timer) clearTimeout(timer)
    }
}

/**
 * 计算平均参与度（基于事件流）
 */
function computeAverageEngagement(events: ClassReportData['events']): number {
    if (events.length === 0) return 0
    const uniqueStudents = new Set(events.map((e) => e.studentId).filter(Boolean))
    if (uniqueStudents.size === 0) return 0
    // 简化：人均事件数 / 10，上限 1.0
    const avg = events.length / uniqueStudents.size / 10
    return Math.min(Math.round(avg * 100) / 100, 1)
}

/**
 * 检测六阶失衡（找出最强与最弱阶层）
 *
 * 返回 DiagnosisResult.bloomImbalance 所需格式：
 * { dominant, weakest, suggestion }
 */
function detectBloomImbalance(radar: BloomMastery): { dominant: string; weakest: string; suggestion: string } {
    const entries = Object.entries(radar) as Array<[string, number]>
    if (entries.length === 0) {
        return { dominant: '记忆', weakest: '创造', suggestion: '建议加强高阶层能力训练' }
    }
    const firstEntry = entries[0]
    if (!firstEntry) {
        return { dominant: '记忆', weakest: '创造', suggestion: '建议加强高阶层能力训练' }
    }
    let max = firstEntry
    let min = firstEntry
    for (const e of entries) {
        if (e[1] > max[1]) max = e
        if (e[1] < min[1]) min = e
    }
    const suggestion = min[1] < 60
        ? `建议针对"${min[0]}"层开展专项训练，当前均值 ${min[1]} 低于 60 分阈值`
        : `各阶层发展较为均衡，可适当强化"${min[0]}"层能力`
    return {
        dominant: max[0],
        weakest: min[0],
        suggestion,
    }
}

/**
 * 从暗物质 pattern 字符串中解析布鲁姆阶层
 *
 * pattern 格式示例：
 * - "含'月'意象的诗在'分析'层卡顿"
 * - "表达'思乡'主题的诗在'评价'层卡顿"
 */
function extractBloomLevelFromPattern(pattern: string): BloomLevel | null {
    const match = pattern.match(/在'([^']+)'层卡顿/)
    if (!match) return null
    const level = match[1] as BloomLevel
    const validLevels: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const
    if (validLevels.includes(level)) return level
    return null
}

/**
 * 将数据库事件类型归一化为 LearningEvent.type
 *
 * db events 表的 type 字段为自由文本（如 'answer'、'recite'、'browse'、
 * 'practice'、'review' 等），需映射到 LearningEvent 的 5 种受控类型。
 */
function normalizeEventType(raw: string): LearningEvent['type'] {
    const t = raw.toLowerCase().trim()
    if (t === 'answer' || t === '答题' || t === '作答') return 'answer'
    if (t === 'recite' || t === '朗读' || t === '背诵') return 'recite'
    if (t === 'browse' || t === '浏览' || t === '查看') return 'browse'
    if (t === 'practice' || t === '练习' || t === '训练') return 'practice'
    if (t === 'review' || t === '复习' || t === '回顾') return 'review'
    // 默认归为练习
    return 'practice'
}

/**
 * 计算掌握度趋势（按周聚合）
 */
function computeMasteryTrend(
    events: ClassReportData['events'],
    from: number,
    to: number,
): Array<{ date: number; mastery: BloomMastery }> {
    const trend: Array<{ date: number; mastery: BloomMastery }> = []
    const span = to - from
    const buckets = Math.min(4, Math.max(1, Math.floor(span / (7 * 24 * 60 * 60 * 1000))))
    const bucketSize = span / buckets

    for (let i = 0; i < buckets; i++) {
        const bucketStart = from + i * bucketSize
        const bucketEnd = bucketStart + bucketSize
        const bucketEvents = events.filter((e) => e.occurredAt >= bucketStart && e.occurredAt < bucketEnd)
        // 简化：基于事件数估算掌握度（实际应从 mastery 表查询）
        const mastery: BloomMastery = {
            记忆: Math.min(100, 40 + bucketEvents.length * 2),
            理解: Math.min(100, 35 + bucketEvents.length * 2),
            应用: Math.min(100, 30 + bucketEvents.length * 2),
            分析: Math.min(100, 25 + bucketEvents.length * 2),
            评价: Math.min(100, 20 + bucketEvents.length * 2),
            创造: Math.min(100, 15 + bucketEvents.length * 2),
        }
        trend.push({ date: bucketStart, mastery })
    }
    return trend
}

// ─────────────────────────────────────────────────────────────
// SubTask 14.7 辅助函数：报告图表数据提取
// ─────────────────────────────────────────────────────────────

/**
 * 从 ReportRecord 提取前端可渲染的图表数据
 *
 * 图表来源映射：
 *   1. exportedData.classBloomRadar  → radar  班级六阶雷达
 *   2. exportedData.studentRadars    → scatter 学生六阶分布
 *   3. exportedData.events           → line    教学事件时间序列（按日聚合）
 *   4. darkMatterReport.byBloomLevel → pie     暗物质按阶层分布
 *   5. darkMatterReport.byTheme      → pie     暗物质按主题分布
 *   6. output.sections               → bar     章节字数分布
 *   7. verification                   → bar     验收评分（含 score + confidence）
 *
 * 所有数据源均为 optional，缺失时跳过对应图表。
 * 返回的图表数组顺序稳定，便于前端锚点定位。
 */
function extractReportCharts(record: ReportRecord): ReportChartData[] {
    const charts: ReportChartData[] = []
    const { exportedData, darkMatterReport, output, verification, period } = record

    // 1. 班级六阶雷达（必含）
    if (exportedData?.classBloomRadar) {
        charts.push({
            chartId: 'class-bloom-radar',
            type: 'radar',
            title: '班级六阶能力雷达',
            description: '全班布鲁姆六阶掌握度均值（0-100）',
            source: 'classBloomRadar',
            data: {
                axes: BLOOM_AXES,
                values: radarToValues(exportedData.classBloomRadar),
                sampleSize: exportedData.studentRadars?.length ?? 0,
            },
            aiGenerated: true,
        })
    }

    // 2. 学生六阶分布散点图
    if (exportedData?.studentRadars && exportedData.studentRadars.length > 0) {
        charts.push({
            chartId: 'student-bloom-scatter',
            type: 'scatter',
            title: '学生六阶能力分布',
            description: '每位学生在六阶能力上的散点分布（已脱敏）',
            source: 'studentRadars',
            data: {
                axes: BLOOM_AXES,
                points: exportedData.studentRadars.map((r) => ({
                    studentId: r.studentId,
                    anonymousName: r.anonymousName,
                    values: radarToValues(r.radar),
                })),
                sampleSize: exportedData.studentRadars.length,
            },
            aiGenerated: true,
        })
    }

    // 3. 教学事件时间序列（按日聚合）
    if (exportedData?.events && exportedData.events.length > 0) {
        const dayBuckets = aggregateEventsByDay(exportedData.events, period.from, period.to)
        if (dayBuckets.length > 0) {
            charts.push({
                chartId: 'events-timeline',
                type: 'line',
                title: '教学事件时间序列',
                description: '按日聚合的学习事件数量（含答题/朗读/练习等）',
                source: 'events',
                data: {
                    series: [
                        {
                            name: '事件数',
                            points: dayBuckets.map((b) => ({ x: b.date, y: b.count })),
                        },
                    ],
                    totalEvents: exportedData.events.length,
                    sampleSize: exportedData.events.length,
                },
                aiGenerated: true,
            })
        }
    }

    // 4. 暗物质按阶层分布
    if (darkMatterReport && Object.keys(darkMatterReport.byBloomLevel).length > 0) {
        charts.push({
            chartId: 'dark-matter-by-bloom',
            type: 'pie',
            title: '认知暗物质 · 布鲁姆阶层分布',
            description: '共性薄弱点在各布鲁姆阶层的数量分布',
            source: 'darkMatter',
            data: {
                segments: Object.entries(darkMatterReport.byBloomLevel).map(([level, count]) => ({
                    label: level,
                    value: count,
                })),
                total: darkMatterReport.totalDarkMatter,
            },
            aiGenerated: true,
        })
    }

    // 5. 暗物质按主题分布
    if (darkMatterReport && Object.keys(darkMatterReport.byTheme).length > 0) {
        charts.push({
            chartId: 'dark-matter-by-theme',
            type: 'pie',
            title: '认知暗物质 · 主题分布',
            description: '共性薄弱点在各主题维度的数量分布',
            source: 'darkMatter',
            data: {
                segments: Object.entries(darkMatterReport.byTheme).map(([theme, count]) => ({
                    label: theme,
                    value: count,
                })),
                total: darkMatterReport.totalDarkMatter,
            },
            aiGenerated: true,
        })
    }

    // 6. 章节字数分布
    if (output?.sections && output.sections.length > 0) {
        charts.push({
            chartId: 'section-word-count',
            type: 'bar',
            title: '报告章节字数分布',
            description: '四段式章节的字数分布（教学背景/干预策略/数据实证/反思展望）',
            source: 'sections',
            data: {
                bars: output.sections.map((s, i) => ({
                    label: s.heading,
                    index: i,
                    wordCount: s.content?.length ?? 0,
                })),
                sectionCount: output.sections.length,
            },
            aiGenerated: !!output.aiGenerated,
        })
    }

    // 7. 验收评分（可选）
    if (verification) {
        charts.push({
            chartId: 'verification-score',
            type: 'bar',
            title: 'AI 验收评分',
            description: 'mind.verify 子 Agent 对报告的六维度独立验收',
            source: 'verification',
            data: {
                bars: [
                    { label: '综合评分', value: verification.score, max: 100 },
                    { label: '置信度', value: Math.round(verification.confidence * 100), max: 100 },
                ],
                verdict: verification.verdict,
                strengthsCount: verification.strengths.length,
                issuesCount: verification.issues.length,
            },
            aiGenerated: true,
        })
    }

    return charts
}

/** 布鲁姆六阶轴标签（顺序固定，与雷达渲染顺序一致） */
const BLOOM_AXES: readonly string[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

/**
 * 将 BloomMastery 对象转换为与 BLOOM_AXES 对齐的数值数组
 */
function radarToValues(radar: BloomMastery): number[] {
    return BLOOM_AXES.map((axis) => radar[axis as keyof BloomMastery] ?? 0)
}

/**
 * 按日聚合事件流，返回时间序列数据点
 *
 * 用于折线图：x = 日期时间戳，y = 当日事件数
 */
function aggregateEventsByDay(
    events: ClassReportData['events'],
    from: number,
    to: number,
): Array<{ date: number; count: number }> {
    const DAY_MS = 24 * 60 * 60 * 1000
    const buckets = new Map<number, number>()
    const startDay = Math.floor(from / DAY_MS) * DAY_MS
    const endDay = Math.ceil(to / DAY_MS) * DAY_MS

    // 初始化所有日期桶（避免缺失日期跳过）
    for (let t = startDay; t <= endDay; t += DAY_MS) {
        buckets.set(t, 0)
    }

    // 聚合事件
    for (const e of events) {
        const day = Math.floor(e.occurredAt / DAY_MS) * DAY_MS
        const cur = buckets.get(day) ?? 0
        buckets.set(day, cur + 1)
    }

    return Array.from(buckets.entries())
        .sort(([a], [b]) => a - b)
        .map(([date, count]) => ({ date, count }))
}

// ─────────────────────────────────────────────────────────────
// 辅助函数：报告渲染
// ─────────────────────────────────────────────────────────────

const REPORT_SHARE_PII_METADATA_KEY = /(?:name|phone|mobile|email|parent|guardian|contact|id.?card|wechat|address|姓名|电话|手机|邮箱|家长|监护人|联系人|身份证|微信|住址)/iu

/**
 * 公开分享前从权威班级花名册构建内容级隐私词表。
 *
 * 报告 Agent 虽声明 dataAnonymized=true，但该字段是模型输出契约而不是 DLP 证明；
 * 因此仍以数据库中的真实姓名/ID/匿名编号做确定性二次脱敏。花名册查询抛错时
 * 上层分享路由返回 503，绝不在缺失词表时降级发布。
 */
function getReportShareSensitiveTerms(record: ReportRecord): readonly string[] {
    const terms = [record.id, record.teacherId, record.classId]
    const students = repos.students.findByClassId(record.classId)
    for (const student of students) {
        terms.push(student.id, student.name, student.anonymousName)
        terms.push(...collectReportShareMetadataPii(student.metadata))
    }
    return terms
}

function collectReportShareMetadataPii(
    value: unknown,
    inheritedSensitive = false,
    depth = 0,
): string[] {
    if (depth > 6 || value === null || value === undefined) return []
    if (typeof value === 'string' || typeof value === 'number') {
        return inheritedSensitive ? [String(value)] : []
    }
    if (Array.isArray(value)) {
        return value.flatMap((item) => collectReportShareMetadataPii(
            item,
            inheritedSensitive,
            depth + 1,
        ))
    }
    if (typeof value !== 'object') return []

    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => (
        collectReportShareMetadataPii(
            child,
            inheritedSensitive || REPORT_SHARE_PII_METADATA_KEY.test(key),
            depth + 1,
        )
    ))
}

/**
 * 渲染报告为 Markdown 文本
 */
function renderReportMarkdown(record: ReportRecord): string {
    const { output, className, period, template, verification } = record
    if (!output) return ''

    const lines: string[] = []
    lines.push(`# ${output.title}`)
    lines.push('')
    lines.push(`> **班级**：${className}  |  **时间范围**：${formatDate(period.from)} 至 ${formatDate(period.to)}  |  **模板**：${TEMPLATE_LABELS[template]}`)
    lines.push('')
    lines.push('> 本报告由诗脉·启明 PoeticRealm AI v5.0 多智能体系统自动生成，数据已脱敏，仅供教研使用。')
    lines.push('')

    // 章节
    for (const section of output.sections) {
        lines.push(`## ${section.heading}`)
        lines.push('')
        lines.push(section.content)
        lines.push('')
    }

    // 关键发现
    if (output.keyFindings.length > 0) {
        lines.push('## 关键发现')
        lines.push('')
        for (const f of output.keyFindings) {
            lines.push(`- ${f}`)
        }
        lines.push('')
    }

    // 教学建议
    if (output.recommendations.length > 0) {
        lines.push('## 教学建议')
        lines.push('')
        for (const r of output.recommendations) {
            lines.push(`- ${r}`)
        }
        lines.push('')
    }

    // 验收信息
    if (verification) {
        lines.push('---')
        lines.push('')
        lines.push('## AI 验收报告')
        lines.push('')
        lines.push(`- **验收结论**：${verification.verdict}`)
        lines.push(`- **综合评分**：${verification.score} / 100`)
        lines.push(`- **置信度**：${Math.round(verification.confidence * 100)}%`)
        if (verification.strengths.length > 0) {
            lines.push('- **亮点**：')
            for (const s of verification.strengths) {
                lines.push(`  - ${s}`)
            }
        }
        if (verification.issues.length > 0) {
            lines.push('- **待改进**：')
            for (const i of verification.issues) {
                lines.push(`  - [${i.severity}] ${i.description}（建议：${i.suggestion}）`)
            }
        }
        lines.push('')
    }

    // 水印
    lines.push('---')
    lines.push('')
    lines.push('*本报告由 AI 生成，数据已脱敏，最终解释权归教师所有。*')

    return lines.join('\n')
}

/**
 * 渲染报告为 HTML（Word / PDF 兼容）
 */
function renderReportHtml(record: ReportRecord, markdown: string, forPdf = false): string {
    const { output, className, period, verification } = record
    if (!output) return ''

    const bodyHtml = markdownToHtml(markdown)
    const watermark = forPdf
        ? '<div class="watermark">AI 生成 · 已脱敏</div>'
        : '<div class="watermark">AI 生成 · 已脱敏</div>'

    const titleSuffix = verification ? `（验收评分：${verification.score}/100）` : ''

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(output.title)}</title>
<style>
${getReportCss(forPdf)}
</style>
</head>
<body>
<div class="report-container">
<div class="report-header">
<h1>${escapeHtml(output.title)}</h1>
<div class="meta">班级：${escapeHtml(className)} ｜ 时间：${formatDate(period.from)} 至 ${formatDate(period.to)}${titleSuffix}</div>
<div class="badge">AI 生成 · 数据已脱敏</div>
</div>
${bodyHtml}
${watermark}
</div>
</body>
</html>`
}

/**
 * 报告 CSS 样式（Word / PDF 兼容）
 */
function getReportCss(forPdf: boolean): string {
    const baseFont = forPdf ? '"Noto Sans SC", "Microsoft YaHei", sans-serif' : '"Noto Sans SC", "Microsoft YaHei", sans-serif'
    return `
body {
    font-family: ${baseFont};
    font-size: 14px;
    line-height: 1.8;
    color: #2C241A;
    background: #FAF8F5;
    margin: 0;
    padding: 40px;
}
.report-container {
    max-width: 800px;
    margin: 0 auto;
    background: #FFFCF8;
    padding: 48px;
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(44, 36, 26, 0.08);
    position: relative;
}
.report-header {
    border-bottom: 2px solid #C5853B;
    padding-bottom: 24px;
    margin-bottom: 32px;
}
.report-header h1 {
    font-size: 28px;
    color: #2C241A;
    margin: 0 0 12px 0;
    font-weight: 700;
}
.meta {
    color: #6B6258;
    font-size: 13px;
}
.badge {
    display: inline-block;
    margin-top: 12px;
    padding: 4px 12px;
    background: rgba(197, 133, 59, 0.12);
    color: #C5853B;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
}
h2 {
    color: #2C241A;
    font-size: 20px;
    margin: 32px 0 16px 0;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(44, 36, 26, 0.08);
}
h3 {
    color: #2C241A;
    font-size: 16px;
    margin: 24px 0 12px 0;
}
p {
    margin: 12px 0;
}
ul, ol {
    margin: 12px 0;
    padding-left: 24px;
}
li {
    margin: 6px 0;
}
blockquote {
    border-left: 3px solid #C5853B;
    background: rgba(197, 133, 59, 0.04);
    padding: 12px 16px;
    margin: 16px 0;
    color: #6B6258;
    font-style: italic;
}
code {
    font-family: "JetBrains Mono", "Consolas", monospace;
    background: rgba(44, 36, 26, 0.06);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 0.9em;
}
pre {
    background: #EDE8E2;
    padding: 16px;
    border-radius: 8px;
    overflow-x: auto;
}
pre code {
    background: transparent;
    padding: 0;
}
table {
    width: 100%;
    border-collapse: collapse;
    margin: 16px 0;
}
th, td {
    padding: 10px 16px;
    text-align: left;
    border-bottom: 1px solid rgba(44, 36, 26, 0.08);
}
th {
    font-weight: 600;
    color: #6B6258;
    background: rgba(240, 235, 225, 0.5);
}
.watermark {
    position: fixed;
    bottom: 20px;
    right: 20px;
    color: rgba(197, 133, 59, 0.3);
    font-size: 11px;
    pointer-events: none;
    z-index: 999;
}
`
}

/**
 * 简易 Markdown → HTML 转换
 *
 * 仅支持报告所需的基础语法：标题、段落、列表、引用、代码、分割线。
 * 不依赖外部库，保证后端零依赖。
 */
function markdownToHtml(md: string): string {
    const lines = md.split('\n')
    const html: string[] = []
    let inList = false
    let listType: 'ul' | 'ol' = 'ul'
    let inCodeBlock = false
    let codeLines: string[] = []

    for (const line of lines) {
        // 代码块
        if (line.startsWith('```')) {
            if (inCodeBlock) {
                html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
                codeLines = []
                inCodeBlock = false
            } else {
                inCodeBlock = true
            }
            continue
        }
        if (inCodeBlock) {
            codeLines.push(line)
            continue
        }

        // 关闭列表
        if (inList && !line.match(/^\s*[-*]\s/) && !line.match(/^\s*\d+\.\s/)) {
            html.push(`</${listType}>`)
            inList = false
        }

        // 标题
        const h1 = line.match(/^# (.+)$/)
        if (h1) {
            html.push(`<h1>${escapeHtml(h1[1]!)}</h1>`)
            continue
        }
        const h2 = line.match(/^## (.+)$/)
        if (h2) {
            html.push(`<h2>${escapeHtml(h2[1]!)}</h2>`)
            continue
        }
        const h3 = line.match(/^### (.+)$/)
        if (h3) {
            html.push(`<h3>${escapeHtml(h3[1]!)}</h3>`)
            continue
        }

        // 引用
        const bq = line.match(/^> (.+)$/)
        if (bq) {
            html.push(`<blockquote>${escapeHtml(bq[1]!)}</blockquote>`)
            continue
        }

        // 分割线
        if (line.match(/^---+$/)) {
            html.push('<hr/>')
            continue
        }

        // 无序列表
        const ul = line.match(/^\s*[-*]\s(.+)$/)
        if (ul) {
            if (!inList || listType !== 'ul') {
                if (inList) html.push(`</${listType}>`)
                html.push('<ul>')
                inList = true
                listType = 'ul'
            }
            html.push(`<li>${inlineFormat(ul[1]!)}</li>`)
            continue
        }

        // 有序列表
        const ol = line.match(/^\s*\d+\.\s(.+)$/)
        if (ol) {
            if (!inList || listType !== 'ol') {
                if (inList) html.push(`</${listType}>`)
                html.push('<ol>')
                inList = true
                listType = 'ol'
            }
            html.push(`<li>${inlineFormat(ol[1]!)}</li>`)
            continue
        }

        // 空行
        if (line.trim() === '') {
            continue
        }

        // 普通段落
        html.push(`<p>${inlineFormat(line)}</p>`)
    }

    // 关闭未闭合的列表/代码块
    if (inList) html.push(`</${listType}>`)
    if (inCodeBlock && codeLines.length > 0) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
    }

    return html.join('\n')
}

/** 行内格式化（粗体、斜体、行内代码） */
function inlineFormat(text: string): string {
    let result = escapeHtml(text)
    // 粗体
    result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // 斜体
    result = result.replace(/\*(.+?)\*/g, '<em>$1</em>')
    // 行内代码
    result = result.replace(/`(.+?)`/g, '<code>$1</code>')
    return result
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

/** 格式化日期 */
function formatDate(ms: number): string {
    const d = new Date(ms)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

// 显式标记未使用的导入（保持类型完整性）
void (undefined as unknown as ReportSection)
