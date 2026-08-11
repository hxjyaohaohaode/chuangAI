/**
 * 教学驾驶舱 Dashboard REST API 路由（Task 9）
 *
 * 4 个端点：
 * - GET /api/dashboard/stats             顶部统计卡片数据
 * - GET /api/dashboard/bloom-radar       班级六阶能力雷达数据
 * - GET /api/dashboard/alerts            实时预警面板数据（来自认知诊断 + 暗物质检测）
 * - GET /api/dashboard/weekly-progress   本周教学进度表
 *
 * 设计要点：
 * - 数据库查询失败时降级返回空数据，不抛 500（保证驾驶舱可用性）
 * - 所有数值字段使用 ROUND 限制小数位，避免前端精度问题
 * - 时间戳统一使用 number（ms），前端自行格式化
 * - 预警数据综合 mastery 表薄弱点与暗物质检测器输出
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { db, repos, services } from '../db/index.js'
import { DarkMatterDetector } from '../services/knowledge-graph/dark-matter-detector.js'
import { KnowledgeGraphService } from '../services/knowledge-graph/knowledge-graph-service.js'
import { config } from '../config.js'
import type { BloomLevel } from '../agents/base/types.js'
import { z } from 'zod'
import { validateQuery, validateParams, validateBody, schemas } from '../lib/validation.js'
import {
    generateTrendAlerts,
    queryTrendAlerts,
    resolveAlert,
    resolveAlerts,
    type TrendAlertFilter,
    type TrendAlertSeverity,
    type TrendAlertRule,
} from '../services/profile/trend-alert.js'
import {
    ClassHotspotClassNotFoundError,
    generateClassHotspot,
} from '../services/profile/class-hotspot.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 顶部统计卡片数据 */
export interface DashboardStats {
    classId: string
    className: string
    studentCount: number
    /** 本周已学古诗数 */
    weekLearnedPoems: number
    /** 班级综合掌握度 0-100 */
    classMasteryAvg: number
    /** 参与综合掌握度计算的真实 mastery 记录数；0 时前端不得把 0 当作成绩 */
    masteryRecordCount: number
    /** 待处理预警数 */
    pendingAlerts: number
    /** 本周进度 */
    weekProgress: { learned: number; total: number }
    // ── v5.0 扩展字段：与前端 DashboardStatsV2 类型对齐 ──
    /** 学生总数（全量） */
    totalStudents: number
    /** 本周新增学生数 */
    newStudentsThisWeek: number
    /** 班级总数（全量） */
    totalClasses: number
    /** 诗词库存数（全量） */
    totalPoems: number
    /** 本周新增诗词数 */
    newPoemsThisWeek: number
    /** 今日学习总时长（小时） */
    todayStudyTimeHours: number
    /** 周环比变化（百分比，正数为增长） */
    weekOverWeekChange: {
        students: number
        studyTime: number
    }
    /** 数据来源披露：演示学情不得被误认为真实课堂数据 */
    dataProvenance: {
        containsSyntheticData: boolean
        seedSource: string | null
        syntheticAnswerCount: number
        syntheticStudentCount: number
    }
}

/** 六阶能力雷达数据 */
export interface BloomRadar {
    classId: string
    radar: Record<BloomLevel, number>
    /** 参与雷达聚合的真实 mastery 记录数 */
    sampleSize: number
    /** 年级均值（可选，用于对比） */
    comparison?: Record<BloomLevel, number>
}

/** 预警类型 */
export type AlertType =
    | 'cognitive-dark-matter'
    | 'student-drop'
    | 'lesson-delay'
    | 'mastery-warning'

export type AlertSeverity = 'low' | 'medium' | 'high'

export interface DashboardAlert {
    id: string
    type: AlertType
    severity: AlertSeverity
    title: string
    description: string
    affectedStudents?: string[]
    suggestedAction: string
    createdAt: number
}

export interface DashboardAlertResponse extends DashboardAlert {
    /** 前端告警面板使用的严重级别契约 */
    level: 'info' | 'warning' | 'error'
    /** 前端告警面板使用的详情字段 */
    detail: string
    /** 前端告警面板使用的时间字段 */
    timestamp: number
    actionUrl?: string
    actionLabel?: string
}

/**
 * 将领域告警转换为前端展示契约。
 *
 * 旧实现直接把 severity/description/createdAt 返回给一个读取
 * level/detail/timestamp 的组件，导致页面出现 `undefined` 严重级别。
 * 保留原字段是为了兼容现有 store，同时显式补齐 v2 字段。
 */
export function toDashboardAlertResponse(alert: DashboardAlert): DashboardAlertResponse {
    const level = alert.severity === 'high'
        ? 'error'
        : alert.severity === 'medium'
            ? 'warning'
            : 'info'
    return {
        ...alert,
        level,
        detail: alert.description,
        timestamp: alert.createdAt,
        actionUrl: '/dashboard?tab=diagnosis',
        actionLabel: '查看诊断',
    }
}

export interface AlertsResponse {
    alerts: DashboardAlert[]
}

/** 周进度课程项 */
export interface WeeklyLesson {
    id: string
    poemTitle: string
    poet: string
    status: 'planned' | 'ongoing' | 'completed' | 'cancelled'
    /** 课堂开始时保存的基线快照；缺失时不得用当前值倒推 */
    masteryBefore?: number
    masteryAfter?: number
    studentCount: number
}

/** 周进度单日 */
export interface WeeklyDay {
    date: string
    lessons: WeeklyLesson[]
}

export interface WeeklyProgressResponse {
    days: WeeklyDay[]
}

// ─────────────────────────────────────────────────────────────
// SubTask 14.5：教学创新指标类型
// ─────────────────────────────────────────────────────────────

/** 单一教学模式使用统计 */
export interface ModeUsageStat {
    mode: string
    count: number
    /** 占总课程百分比 0-100 */
    percentage: number
}

/** AI 生成内容统计 */
export interface AIGeneratedContentStat {
    /** AI 生成题目数 */
    questions: number
    /** AI 推送启发提示数（来自课堂运行时 hints + aiSuggestionTracker） */
    hints: number
    /** AI 生成讨论题数（来自课堂运行时 discussions） */
    discussions: number
    /** AI 生成评论数（来自 /sessions/:id/comment SSE 调用） */
    comments: number
    /** 合计 */
    total: number
}

/** 学生创作作品统计 */
export interface CreationStat {
    /** 教师创建的创作任务数 */
    tasks: number
    /** 学生提交的作品数 */
    works: number
    /** 参与学生数（去重） */
    studentParticipants: number
}

/** 单日创新活动计数（用于时间序列图表） */
export interface InnovationDayActivity {
    /** 日期 YYYY-MM-DD */
    date: string
    /** 当日创新活动计数（AI 生成内容 + 创作提交 + 创新模式课程） */
    count: number
}

/** 教学创新指标响应（GET /innovation） */
export interface InnovationResponse {
    classId: string
    /** 统计时间窗口（毫秒） */
    period: { from: number; to: number }
    /** 周期内总课程数（分母） */
    totalLessons: number
    /** 创新教学模式使用统计（按 mode 分组） */
    modeUsage: ModeUsageStat[]
    /** AI 辅助生成内容数量 */
    aiGeneratedContent: AIGeneratedContentStat
    /** 学生创作作品统计 */
    creationStats: CreationStat
    /** 创新度评分 0-100（综合：模式创新 40% + AI 内容 35% + 创作活动 25%） */
    innovationScore: number
    /** 周期内使用过创新模式的课程比例 */
    innovationModeRatio: number
    /** 最近 7 天创新活动时间序列 */
    recentActivity: InnovationDayActivity[]
    aiGenerated: false
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const BLOOM_LEVELS: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

/** 一周毫秒数 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** 掌握度"待提升"阈值（低于此值触发预警） */
const MASTERY_WARN_THRESHOLD = 60

/** 参与度"下滑"阈值（低于此值触发学生掉队预警） */
const ENGAGEMENT_DROP_THRESHOLD = 0.4

/** 暗物质检测超时（ms）—— 避免长时间阻塞 dashboard 响应 */
const DARK_MATTER_TIMEOUT_MS = 1500

// ─────────────────────────────────────────────────────────────
// Zod schemas（B6.3 输入校验）
// ─────────────────────────────────────────────────────────────

/** GET /stats 查询参数 —— v5.0 classId 改为可选（支持全局聚合） */
const statsQuerySchema = z.object({
    classId: schemas.classId.optional(),
})

/** GET /bloom-radar 与 /weekly-progress 查询参数（classId 仍必填） */
const classIdQuerySchema = z.object({
    classId: schemas.classId,
})

/** GET /alerts 查询参数 */
const alertsQuerySchema = z.object({
    classId: schemas.classId,
    limit: z.coerce.number().int().min(1).max(50).optional(),
})

/** GET /alerts/trend 查询参数 —— 能力3 趋势预警筛选 */
const trendAlertsQuerySchema = z.object({
    classId: schemas.classId,
    severity: z.enum(['info', 'warning', 'critical']).optional(),
    rule: z.enum([
        'academic-decline',
        'engagement-drop',
        'knowledge-gap',
        'behavior-anomaly',
        'personalized',
    ]).optional(),
    resolved: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
})

/** POST /alerts/:id/resolve 路径参数 —— 能力3 预警解决 */
const alertIdParamsSchema = z.object({
    alertId: schemas.id,
})

/** POST /alerts/batch-resolve 请求体 —— 能力3 批量解决预警 */
const batchResolveSchema = z.object({
    alertIds: z.array(schemas.id).min(1).max(50),
})

/** GET /class/:classId/hotspot 路径参数 —— 能力2 班级热点 */
const hotspotParamsSchema = z.object({
    classId: schemas.classId,
})

/** GET /class-hotspot 查询参数 —— v5.0 修复：与前端 /dashboard/class-hotspot 路径对齐
 *
 * classId 可选，缺失时自动回退到第一个班级。
 */
const hotspotQuerySchema = z.object({
    classId: schemas.classId.optional(),
})

/** POST /class/:classId/hotspot/refresh 请求体 —— 能力2 强制刷新热点 */
const hotspotRefreshSchema = z.object({
    forceRefresh: z.boolean().optional(),
}).default({})

/** GET /innovation 查询参数 —— SubTask 14.5 教学创新指标
 *
 * v5.0 修复：classId 改为可选，与 /stats 端点一致。
 * 当 classId 缺失时，自动选择数据库中第一个班级作为默认（保证 Dashboard
 * 在用户未选班级时仍能展示创新指标，避免前端 400 错误导致指标条不显示）。
 */
const innovationQuerySchema = z.object({
    classId: schemas.classId.optional(),
    /** 统计周期天数（默认 7，可选 1/7/14/30） */
    days: z.coerce.number().int().min(1).max(30).optional(),
})

/** 班级热点三个公开入口共享同一 404 契约，禁止把不存在伪装成降级成功。 */
function sendClassHotspotNotFound(reply: FastifyReply) {
    return reply.status(404).send({
        status: 'error',
        error: 'CLASS_NOT_FOUND',
        message: '班级不存在',
    })
}

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

export const dashboardRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    // ── GET /stats — 顶部统计卡片 ──
    app.get('/stats', async (req: FastifyRequest, reply) => {
        const query = validateQuery(statsQuerySchema, req, reply)
        if (!query) return
        const classId = query.classId ?? 'global'

        try {
            const stats = await computeStats(classId)
            return reply.send({ status: 'ok', ...stats })
        } catch (err) {
            req.log.error({ err }, 'Dashboard stats 查询失败')
            // 降级返回最小结构，保证驾驶舱不空白（v5.0 含扩展字段）
            return reply.send({
                status: 'degraded',
                classId,
                className: '未知班级',
                studentCount: 0,
                weekLearnedPoems: 0,
                classMasteryAvg: 0,
                masteryRecordCount: 0,
                pendingAlerts: 0,
                weekProgress: { learned: 0, total: 0 },
                totalStudents: 0,
                newStudentsThisWeek: 0,
                totalClasses: 0,
                totalPoems: 0,
                newPoemsThisWeek: 0,
                todayStudyTimeHours: 0,
                weekOverWeekChange: { students: 0, studyTime: 0 },
                dataProvenance: {
                    containsSyntheticData: false,
                    seedSource: null,
                    syntheticAnswerCount: 0,
                    syntheticStudentCount: 0,
                },
            })
        }
    })

    // ── GET /bloom-radar — 六阶能力雷达 ──
    app.get('/bloom-radar', async (req: FastifyRequest, reply) => {
        const query = validateQuery(classIdQuerySchema, req, reply)
        if (!query) return
        const { classId } = query

        try {
            const radar = computeBloomRadar(classId)
            // 同时下发 v2 结构（levels / classAverage）：
            // 驾驶舱的 BloomRadarChart 按 levels 数组解析，只给 radar 字典会让它
            // 拿到 undefined 并渲染空状态——明明有 2880 条掌握度记录却显示"尚未形成画像"。
            // 附加字段不影响既有 v1 消费方。
            return reply.send({
                status: 'ok',
                ...radar,
                levels: toRadarDimensions(radar.radar),
                classAverage: toRadarDimensions(computeGradeBaselineRadar(classId)),
            })
        } catch (err) {
            req.log.error({ err }, 'Dashboard bloom-radar 查询失败')
            // 降级返回六阶全 0
            const empty: Record<BloomLevel, number> = {
                记忆: 0, 理解: 0, 应用: 0, 分析: 0, 评价: 0, 创造: 0,
            }
            return reply.send({
                status: 'degraded',
                classId,
                radar: empty,
                levels: toRadarDimensions(empty),
                classAverage: toRadarDimensions(empty),
            })
        }
    })

    // ── GET /alerts — 实时预警面板 ──
    app.get('/alerts', async (req: FastifyRequest, reply) => {
        const query = validateQuery(alertsQuerySchema, req, reply)
        if (!query) return
        const { classId, limit: rawLimit } = query
        const limit = rawLimit ?? 10

        try {
            const alerts = await computeAlerts(classId, limit)
            return reply.send({
                status: 'ok',
                alerts: alerts.map(toDashboardAlertResponse),
            })
        } catch (err) {
            req.log.error({ err }, 'Dashboard alerts 查询失败')
            return reply.send({ status: 'degraded', alerts: [] })
        }
    })

    // ── GET /weekly-progress — 本周教学进度 ──
    app.get('/weekly-progress', async (req: FastifyRequest, reply) => {
        const query = validateQuery(classIdQuerySchema, req, reply)
        if (!query) return
        const { classId } = query

        try {
            const progress = computeWeeklyProgress(classId)
            // 同时下发 v2 热力图结构（students / days / matrix）：
            // 驾驶舱 WeeklyProgressTable 画的是「学生 × 天」时长矩阵，
            // 只给按天分组的课程列表它无法渲染，会一直显示「本周暂无学习记录」。
            return reply.send({
                status: 'ok',
                days: progress,
                // 注意键名是 matrixDays 而非 days：v1 的 days 是「按天分组的课程列表」，
                // v2 的 matrixDays 是「7 个 ISO 日期字符串」，两者语义与类型都不同，
                // 复用同一个键会让其中一方静默拿到错误结构。
                ...computeWeeklyStudyMatrix(classId),
            })
        } catch (err) {
            req.log.error({ err }, 'Dashboard weekly-progress 查询失败')
            // 降级返回本周 7 天空骨架
            const empty = buildEmptyWeek()
            return reply.send({
                status: 'degraded',
                days: empty,
                students: [],
                matrixDays: [],
                matrix: [],
            })
        }
    })

    // ── GET /alerts/trend — 趋势预警面板（只读查询） ──
    app.get('/alerts/trend', async (req: FastifyRequest, reply) => {
        const query = validateQuery(trendAlertsQuerySchema, req, reply)
        if (!query) return
        const { classId, severity, rule, resolved, limit } = query

        try {
            const filter: TrendAlertFilter = {
                classId,
                severity: severity as TrendAlertSeverity | undefined,
                rule: rule as TrendAlertRule | undefined,
                resolved,
                limit,
            }
            const response = queryTrendAlerts(filter)
            return reply.send({
                status: 'ok',
                ...response,
                aiGenerated: response.alerts.some((alert) => alert.aiAnalyzed),
                generationTriggered: false,
            })
        } catch (err) {
            req.log.error({ err }, '趋势预警查询失败')
            return reply.send({
                status: 'degraded',
                alerts: [],
                total: 0,
                severityStats: { critical: 0, warning: 0, info: 0 },
                aiGenerated: false,
            })
        }
    })

    // ── POST /alerts/trend/refresh — 显式重新检测并持久化趋势预警 ──
    // GET 不得暗中写库；只有教师明确刷新时才运行规则和可选 AI 分析。
    app.post('/alerts/trend/refresh', async (req: FastifyRequest, reply) => {
        const query = validateQuery(trendAlertsQuerySchema, req, reply)
        if (!query) return
        try {
            const generated = await generateTrendAlerts(query.classId)
            return reply.send({
                status: 'ok',
                ...generated,
                aiGenerated: generated.alerts.some((alert) => alert.aiAnalyzed),
                generationTriggered: true,
            })
        } catch (err) {
            req.log.error({ err, classId: query.classId }, '趋势预警刷新失败')
            return reply.status(500).send({
                statusCode: 500,
                error: 'Internal Server Error',
                message: '趋势预警刷新失败',
            })
        }
    })

    // ── POST /alerts/:alertId/resolve — 标记单个预警为已解决（能力3） ──
    app.post('/alerts/:alertId/resolve', async (req: FastifyRequest, reply) => {
        const params = validateParams(alertIdParamsSchema, req, reply)
        if (!params) return
        const { alertId } = params

        try {
            const success = resolveAlert(alertId)
            if (!success) {
                return reply.status(404).send({
                    statusCode: 404,
                    error: 'Not Found',
                    message: `预警 ${alertId} 不存在`,
                })
            }
            return reply.send({ status: 'ok', alertId, resolved: true })
        } catch (err) {
            req.log.error({ err, alertId }, '预警解决失败')
            return reply.status(500).send({
                statusCode: 500,
                error: 'Internal Server Error',
                message: '预警标记失败',
            })
        }
    })

    // ── POST /alerts/batch-resolve — 批量解决预警（能力3 增强） ──
    app.post('/alerts/batch-resolve', async (req: FastifyRequest, reply) => {
        const body = validateBody(batchResolveSchema, req, reply)
        if (!body) return
        const { alertIds } = body

        try {
            const count = resolveAlerts(alertIds)
            return reply.send({
                status: 'ok',
                resolvedCount: count,
                requestedCount: alertIds.length,
            })
        } catch (err) {
            req.log.error({ err }, '批量解决预警失败')
            return reply.status(500).send({
                statusCode: 500,
                error: 'Internal Server Error',
                message: '批量解决失败',
            })
        }
    })

    // ── GET /class-hotspot — 班级热点画像（v5.0 修复：与前端路径对齐） ──
    // 前端调用 /api/dashboard/class-hotspot?classId=xxx，classId 可选
    // 当 classId 缺失时，自动选择第一个班级（与 /innovation 端点一致）
    app.get('/class-hotspot', async (req: FastifyRequest, reply) => {
        const query = validateQuery(hotspotQuerySchema, req, reply)
        if (!query) return
        let classId = query.classId
        if (!classId) {
            const firstClass = repos.classes.findAll(1, 0)[0]
            if (!firstClass) {
                return reply.send({
                    status: 'degraded',
                    hotspot: null,
                    cached: false,
                    aiGenerated: false,
                })
            }
            classId = firstClass.id
        }

        try {
            const response = await generateClassHotspot(classId, false)
            // 附带 v2 扁平结构（activityRanking / weakKnowledgeRanking）：
            // 驾驶舱 ClassHotspot 面板按这两个数组渲染，只给嵌套的 hotspot 对象
            // 会让它拿到 undefined 并显示「暂无热点数据」，而后端其实已算出全部结论。
            return reply.send({
                status: 'ok',
                ...response,
                aiGenerated: response.hotspot.aiGenerated,
                ...flattenHotspotForPanel(response.hotspot),
            })
        } catch (err) {
            if (err instanceof ClassHotspotClassNotFoundError) {
                return sendClassHotspotNotFound(reply)
            }
            req.log.error({ err, classId }, '班级热点画像生成失败')
            return reply.send({
                status: 'degraded',
                hotspot: null,
                activityRanking: [],
                weakKnowledgeRanking: [],
                cached: false,
                aiGenerated: false,
            })
        }
    })

    // ── GET /class/:classId/hotspot — 班级热点画像（能力2） ──
    // 调用 class-hotspot.ts 服务，聚合 5 类班级热点
    app.get('/class/:classId/hotspot', async (req: FastifyRequest, reply) => {
        const params = validateParams(hotspotParamsSchema, req, reply)
        if (!params) return
        const { classId } = params

        try {
            const response = await generateClassHotspot(classId, false)
            return reply.send({ status: 'ok', ...response, aiGenerated: response.hotspot.aiGenerated })
        } catch (err) {
            if (err instanceof ClassHotspotClassNotFoundError) {
                return sendClassHotspotNotFound(reply)
            }
            req.log.error({ err, classId }, '班级热点画像生成失败')
            return reply.send({
                status: 'degraded',
                hotspot: null,
                cached: false,
                aiGenerated: false,
            })
        }
    })

    // ── POST /class/:classId/hotspot/refresh — 强制刷新班级热点（能力2） ──
    app.post('/class/:classId/hotspot/refresh', async (req: FastifyRequest, reply) => {
        const params = validateParams(hotspotParamsSchema, req, reply)
        if (!params) return
        const { classId } = params
        const body = validateBody(hotspotRefreshSchema, req, reply)
        if (!body) return
        const forceRefresh = body.forceRefresh ?? true

        try {
            const response = await generateClassHotspot(classId, forceRefresh)
            return reply.send({ status: 'ok', ...response, aiGenerated: response.hotspot.aiGenerated })
        } catch (err) {
            if (err instanceof ClassHotspotClassNotFoundError) {
                return sendClassHotspotNotFound(reply)
            }
            req.log.error({ err, classId }, '班级热点画像刷新失败')
            return reply.status(500).send({
                statusCode: 500,
                error: 'Internal Server Error',
                message: '热点画像刷新失败',
            })
        }
    })

    // ── GET /innovation — 教学创新指标（SubTask 14.5） ──
    // 综合统计：教学模式创新 + AI 生成内容 + 学生创作活动
    app.get('/innovation', async (req: FastifyRequest, reply) => {
        const query = validateQuery(innovationQuerySchema, req, reply)
        if (!query) return
        // v5.0：classId 缺失时自动回退到第一个班级，保证 Dashboard 指标条始终有数据
        let classId = query.classId
        if (!classId) {
            const firstClass = repos.classes.findAll(1, 0)[0]
            if (!firstClass) {
                // 数据库无班级：返回空数据降级响应（不抛 400，保证驾驶舱可用性）
                const now0 = Date.now()
                const from0 = now0 - (query.days ?? 7) * 24 * 60 * 60 * 1000
                return reply.send({
                    status: 'degraded',
                    classId: 'global',
                    period: { from: from0, to: now0 },
                    totalLessons: 0,
                    modeUsage: [],
                    aiGeneratedContent: {
                        questions: 0,
                        hints: 0,
                        discussions: 0,
                        comments: 0,
                        total: 0,
                    },
                    creationStats: {
                        tasks: 0,
                        works: 0,
                        studentParticipants: 0,
                    },
                    innovationScore: 0,
                    innovationModeRatio: 0,
                    recentActivity: [],
                    aiGenerated: false as const,
                })
            }
            classId = firstClass.id
        }
        const days = query.days ?? 7

        try {
            const response = computeInnovation(classId, days)
            return reply.send({ status: 'ok', ...response })
        } catch (err) {
            req.log.error({ err, classId }, 'innovation 创新指标查询失败')
            const now = Date.now()
            const from = now - days * 24 * 60 * 60 * 1000
            return reply.send({
                status: 'degraded',
                classId,
                period: { from, to: now },
                totalLessons: 0,
                modeUsage: [],
                aiGeneratedContent: {
                    questions: 0,
                    hints: 0,
                    discussions: 0,
                    comments: 0,
                    total: 0,
                },
                creationStats: {
                    tasks: 0,
                    works: 0,
                    studentParticipants: 0,
                },
                innovationScore: 0,
                innovationModeRatio: 0,
                recentActivity: [],
                aiGenerated: false as const,
            })
        }
    })
}

// ─────────────────────────────────────────────────────────────
// 业务计算函数
// ─────────────────────────────────────────────────────────────

/**
 * 计算顶部统计卡片数据
 * - studentCount: 班级学生数
 * - weekLearnedPoems: 本周状态为 completed 的不同诗数
 * - classMasteryAvg: 班级所有 mastery 记录的均值
 * - pendingAlerts: 当前未处理预警数（与 alerts 端点同源，仅取 count）
 * - weekProgress: 本周已完成 / 本周总计划
 */
async function computeStats(classId: string): Promise<DashboardStats> {
    const classEntity = classId !== 'global' ? repos.classes.findById(classId) : null
    const className = classEntity?.name ?? (classId === 'global' ? '全局视图' : '未知班级')

    // v5.0 全量统计（不依赖 classId）
    const totalStudents = safeCount(() => repos.students.count())
    const totalClasses = safeCount(() => repos.classes.count())
    const totalPoems = safeCount(() => repos.poems.count())

    // 班级学生数（兼容旧字段 studentCount）
    const studentCount = classEntity?.studentCount
        ?? (classId === 'global' ? totalStudents : countStudents(classId))

    const now = Date.now()
    const weekStart = now - WEEK_MS
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    const dayStartTs = dayStart.getTime()
    const lastWeekStart = weekStart - WEEK_MS

    // 本周课程
    const weekLessons = classId === 'global' ? [] : fetchLessonsInRange(classId, weekStart, now)
    const completedSet = new Set<string>()
    let totalPlanned = 0
    for (const l of weekLessons) {
        if (l.status === 'completed' && l.poem_id) {
            completedSet.add(l.poem_id)
        }
        if (l.status === 'planned' || l.status === 'ongoing' || l.status === 'completed') {
            totalPlanned += 1
        }
    }
    const weekLearnedPoems = completedSet.size

    // 班级综合掌握度均值
    const masterySummary = classId === 'global'
        ? { average: 0, recordCount: 0 }
        : computeClassMasterySummary(classId)

    // 待处理预警数（与 alerts 端点同源，limit 给一个大值）
    const pendingAlerts = classId === 'global' ? 0 : (await computeAlerts(classId, 50)).length

    // v5.0 扩展字段：本周新增学生数
    const newStudentsThisWeek = safeCount(() => {
        const row = db.prepare('SELECT COUNT(*) as cnt FROM students WHERE created_at >= ?')
            .get(weekStart) as { cnt: number }
        return row.cnt
    })
    // v5.0 扩展字段：本周新增诗词数
    const newPoemsThisWeek = safeCount(() => {
        const row = db.prepare('SELECT COUNT(*) as cnt FROM poems WHERE created_at >= ?')
            .get(weekStart) as { cnt: number }
        return row.cnt
    })
    // v5.0 扩展字段：今日学习总时长（小时）
    const todayStudyTimeHours = (() => {
        try {
            const row = db
                .prepare(`SELECT COALESCE(SUM(CASE WHEN started_at IS NOT NULL AND ended_at IS NOT NULL THEN (ended_at - started_at) / 3600000.0 ELSE 0 END), 0) as hours FROM lessons WHERE started_at IS NOT NULL AND started_at >= ?`)
                .get(dayStartTs) as { hours: number } | undefined
            return Math.round((row?.hours ?? 0) * 10) / 10
        } catch {
            return 0
        }
    })()
    // v5.0 扩展字段：上周新增学生数（用于周环比计算）
    const lastWeekNewStudents = safeCount(() => {
        const row = db.prepare('SELECT COUNT(*) as cnt FROM students WHERE created_at >= ? AND created_at < ?')
            .get(lastWeekStart, weekStart) as { cnt: number }
        return row.cnt
    })
    const weekOverWeekChange = {
        students: calcPercentChange(newStudentsThisWeek, lastWeekNewStudents),
        studyTime: 0,
    }

    const syntheticAnswerCount = safeCount(() => {
        if (classId === 'global') {
            const row = db.prepare(`
                SELECT COUNT(*) AS cnt
                  FROM answers
                 WHERE metadata LIKE '%"seedSource":"learning-demo-v1"%'
            `).get() as { cnt: number } | undefined
            return row?.cnt ?? 0
        }
        const row = db.prepare(`
                SELECT COUNT(*) AS cnt
                  FROM answers a
                  JOIN students s ON s.id = a.student_id
                 WHERE s.class_id = ?
                   AND a.metadata LIKE '%"seedSource":"learning-demo-v1"%'
        `).get(classId) as { cnt: number } | undefined
        return row?.cnt ?? 0
    })
    const syntheticStudentCount = safeCount(() => {
        if (classId === 'global') {
            const row = db.prepare(`
                SELECT COUNT(*) AS cnt
                  FROM students
                 WHERE metadata LIKE '%"seedSource":"roster-demo-v2"%'
                    OR metadata LIKE '%"seedSource":"learning-demo-v1"%'
            `).get() as { cnt: number } | undefined
            return row?.cnt ?? 0
        }
        const row = db.prepare(`
            SELECT COUNT(*) AS cnt
              FROM students
             WHERE class_id = ?
               AND (
                    metadata LIKE '%"seedSource":"roster-demo-v2"%'
                    OR metadata LIKE '%"seedSource":"learning-demo-v1"%'
               )
        `).get(classId) as { cnt: number } | undefined
        return row?.cnt ?? 0
    })
    const seedSources = [
        syntheticStudentCount > 0 ? 'roster-demo-v2' : null,
        syntheticAnswerCount > 0 ? 'learning-demo-v1' : null,
    ].filter((source): source is string => source !== null)

    return {
        classId,
        className,
        studentCount,
        weekLearnedPoems,
        classMasteryAvg: masterySummary.average,
        masteryRecordCount: masterySummary.recordCount,
        pendingAlerts,
        weekProgress: { learned: weekLearnedPoems, total: totalPlanned },
        // v5.0 扩展字段
        totalStudents,
        newStudentsThisWeek,
        totalClasses,
        totalPoems,
        newPoemsThisWeek,
        todayStudyTimeHours,
        weekOverWeekChange,
        dataProvenance: {
            containsSyntheticData: seedSources.length > 0,
            seedSource: seedSources.length > 0 ? seedSources.join(',') : null,
            syntheticAnswerCount,
            syntheticStudentCount,
        },
    }
}

/** 安全计数：捕获异常返回 0，保证驾驶舱不崩 */
function safeCount(fn: () => number): number {
    try {
        const result = fn()
        return typeof result === 'number' ? result : 0
    } catch {
        return 0
    }
}

/** 计算百分比变化（本周 vs 上周），分母为 0 时返回 0 */
function calcPercentChange(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0
    return Math.round(((current - previous) / previous) * 1000) / 10
}

/**
 * 计算六阶能力雷达
 * 直接复用 MasteryRepository.getClassBloomRadar（按 class_id 聚合 AVG(score) GROUP BY bloom_level）
 */
/**
 * 计算「学生 × 天」本周学习时长矩阵（分钟）
 *
 * 口径（每个数字都可追溯到真实记录，不做任何估算填充）：
 *   某学生某天的学习时长 = 该天他提交过作答的每一节课的课堂时长之和。
 *   课堂时长取 lessons.ended_at - started_at，缺失时按一课时 40 分钟计。
 * 没有作答记录的格子就是 0——热力图里的空白格代表"当天没有学习记录"，
 * 而不是"数据没查到"。
 *
 * 学生数限制在 20 人以内（前端矩阵按前 20 名展示），按本周总时长降序取。
 */
function computeWeeklyStudyMatrix(classId: string): {
    students: Array<{ id: string; name: string }>
    matrixDays: string[]
    matrix: number[][]
} {
    // 本周 7 天（含今天，按自然日）
    const dayKeys: string[] = []
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    for (let i = 6; i >= 0; i--) {
        const d = new Date(startOfToday.getTime() - i * 24 * 60 * 60 * 1000)
        dayKeys.push(
            `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        )
    }
    const windowStart = startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000

    // 口径：**有效学习时长** = 该生当天实际作答题目的预估用时之和。
    //
    // 不用「课时长度」是因为那对同一节课的所有出勤学生完全相同，
    // 热力图会退化成一张只有"来/没来"两种颜色的表格——实测原实现下
    // 20 名学生的行完全一致（都是 40m/40m/40m），教师看不出任何差异。
    // 按实际作答题量累计，才能同时反映「是否出勤」与「投入多少」。
    const rows = db
        .prepare(`
            SELECT a.student_id                        AS studentId,
                   s.anonymous_name                    AS name,
                   a.submitted_at                      AS submittedAt,
                   COALESCE(q.estimated_time_sec, 60)  AS estimatedSec
              FROM answers a
              JOIN students s ON s.id = a.student_id
              LEFT JOIN questions q ON q.id = a.question_id
             WHERE s.class_id = ?
               AND a.submitted_at >= ?
        `)
        .all(classId, windowStart) as Array<{
            studentId: string
            name: string
            submittedAt: number
            estimatedSec: number
        }>

    // student → day → 累计秒数
    const perStudent = new Map<string, { name: string; days: Map<string, number> }>()
    for (const r of rows) {
        const d = new Date(r.submittedAt)
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        if (!dayKeys.includes(key)) continue

        let entry = perStudent.get(r.studentId)
        if (!entry) {
            entry = { name: r.name, days: new Map() }
            perStudent.set(r.studentId, entry)
        }
        entry.days.set(key, (entry.days.get(key) ?? 0) + Math.max(0, r.estimatedSec))
    }

    const ranked = [...perStudent.entries()]
        .map(([id, e]) => {
            const perDay = dayKeys.map((k) => Math.round((e.days.get(k) ?? 0) / 60))
            return { id, name: e.name, perDay, total: perDay.reduce((a, b) => a + b, 0) }
        })
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
        .slice(0, 20)

    return {
        students: ranked.map((r) => ({ id: r.id, name: r.name })),
        matrixDays: dayKeys,
        matrix: ranked.map((r) => r.perDay),
    }
}

/**
 * 班级热点画像 → 驾驶舱面板所需的两个扁平排行
 *
 * 面板要的是"活跃度排行"与"薄弱知识点排行"两个一维数组，
 * 而服务层产出的是嵌套的 strengths/weaknesses/engagement 结构。
 * 这里做一次纯投影，不引入任何服务层没算过的新数字。
 */
function flattenHotspotForPanel(hotspot: {
    className: string
    hotspots: {
        weaknesses: Array<{ dimension: string; avgScore: number; weakRatio: number }>
        engagement: { classAvgEngagement: number; hasObservedData: boolean }
    }
}): {
    activityRanking: Array<{ className: string; activityScore: number }>
    weakKnowledgeRanking: Array<{ knowledge: string; weaknessScore: number }>
} {
    return {
        // 当前口径下服务层只产出本班的参与度，因此活跃度排行只有本班一项。
        // 不去凑满 5 条——伪造其他班级的活跃度会直接误导教师的横向比较。
        activityRanking: hotspot.hotspots.engagement.hasObservedData
            ? [
                {
                    className: hotspot.className,
                    activityScore: Math.round(hotspot.hotspots.engagement.classAvgEngagement * 100),
                },
            ]
            : [],
        // 薄弱度 = 100 - 均分：数值越大越薄弱，与面板的降序展示语义一致
        weakKnowledgeRanking: hotspot.hotspots.weaknesses
            .slice(0, 5)
            .map((w) => ({
                knowledge: `${w.dimension}层级（${w.weakRatio}% 学生未达标）`,
                weaknessScore: Math.round(100 - w.avgScore),
            })),
    }
}

/**
 * 六阶字典 → 前端雷达图维度数组
 *
 * 前端 BloomRadarDataV2 用 `[{name,value}]` 而非字典，是为了保证维度顺序稳定
 * （对象键序不可依赖，雷达图六个顶点的顺序必须固定）。
 */
function toRadarDimensions(radar: Record<BloomLevel, number>): Array<{ name: string; value: number }> {
    return BLOOM_LEVELS.map((level) => ({ name: level, value: radar[level] ?? 0 }))
}

/**
 * 计算同年级基线雷达（对比参照系）
 *
 * 取该班所在年级**其他班级**的六阶均值。若同年级没有其他班级或无数据，
 * 返回全 0——此时前端只画本班一条曲线，而不是拿本班数据伪造一条"年级均值"
 * 让教师误以为自己班和年级持平。
 */
function computeGradeBaselineRadar(classId: string): Record<BloomLevel, number> {
    const empty: Record<BloomLevel, number> = {
        记忆: 0, 理解: 0, 应用: 0, 分析: 0, 评价: 0, 创造: 0,
    }
    try {
        const cls = db.prepare('SELECT grade FROM classes WHERE id = ?').get(classId) as
            | { grade: string }
            | undefined
        if (!cls) return empty

        const rows = db
            .prepare(`
                SELECT m.bloom_level AS bloom_level, AVG(m.score) AS avg_score
                  FROM mastery m
                  JOIN students s ON m.student_id = s.id
                  JOIN classes c ON s.class_id = c.id
                 WHERE c.grade = ? AND c.id != ?
                 GROUP BY m.bloom_level
            `)
            .all(cls.grade, classId) as Array<{ bloom_level: string; avg_score: number }>

        const out = { ...empty }
        for (const r of rows) {
            const level = r.bloom_level as BloomLevel
            if (BLOOM_LEVELS.includes(level)) {
                out[level] = Math.round((r.avg_score ?? 0) * 100) / 100
            }
        }
        return out
    } catch {
        return empty
    }
}

function computeBloomRadar(classId: string): BloomRadar {
    const rows = repos.mastery.getClassBloomRadar(classId)
    const radar: Record<BloomLevel, number> = {
        记忆: 0, 理解: 0, 应用: 0, 分析: 0, 评价: 0, 创造: 0,
    }
    for (const r of rows) {
        const level = r.bloom_level as BloomLevel
        if (BLOOM_LEVELS.includes(level)) {
            radar[level] = Math.round((r.avg_score ?? 0) * 100) / 100
        }
    }
    const sampleRow = db
        .prepare(`
            SELECT COUNT(*) AS count
            FROM mastery m
            JOIN students s ON m.student_id = s.id
            WHERE s.class_id = ?
        `)
        .get(classId) as { count: number } | undefined
    return { classId, radar, sampleSize: sampleRow?.count ?? 0 }
}

/**
 * 计算班级综合掌握度均值（0-100）
 * 通过 JOIN students + mastery 聚合
 */
function computeClassMasterySummary(classId: string): { average: number; recordCount: number } {
    try {
        const row = db
            .prepare(`
                SELECT AVG(m.score) as avg_score, COUNT(*) as record_count
                FROM mastery m
                JOIN students s ON m.student_id = s.id
                WHERE s.class_id = ?
            `)
            .get(classId) as { avg_score: number | null; record_count: number } | undefined
        const avg = row?.avg_score
        if (avg === null || avg === undefined || Number.isNaN(avg)) {
            return { average: 0, recordCount: 0 }
        }
        return {
            average: Math.round(avg * 100) / 100,
            recordCount: row?.record_count ?? 0,
        }
    } catch {
        return { average: 0, recordCount: 0 }
    }
}

/**
 * 综合生成预警列表
 * 数据来源：
 * 1. 认知暗物质检测器（cognitive-dark-matter）
 * 2. 学生参与度下滑检测（student-drop）
 * 3. 课程延迟开始检测（lesson-delay）
 * 4. 掌握度低于阈值的学生群预警（mastery-warning）
 */
async function computeAlerts(classId: string, limit: number): Promise<DashboardAlert[]> {
    const alerts: DashboardAlert[] = []
    const now = Date.now()

    // 1. 认知暗物质预警（带超时降级，避免阻塞 dashboard）
    let kgService: KnowledgeGraphService | undefined
    try {
        kgService = new KnowledgeGraphService(
            config.neo4j.uri,
            config.neo4j.user,
            config.neo4j.password,
        )
        const detector = new DarkMatterDetector(kgService)
        const darkMatterList = await withTimeout(
            detector.detectClassDarkMatter(classId),
            DARK_MATTER_TIMEOUT_MS,
            [],
        )
        for (const dm of darkMatterList) {
            const severity: AlertSeverity =
                dm.affectedRatio >= 0.6 ? 'high' : dm.affectedRatio >= 0.4 ? 'medium' : 'low'
            alerts.push({
                id: dm.id,
                type: 'cognitive-dark-matter',
                severity,
                title: `认知暗物质：${dm.pattern}`,
                description: dm.rootCause,
                affectedStudents: dm.affectedStudents,
                suggestedAction: dm.prescription,
                createdAt: dm.detectedAt,
            })
        }
    } catch {
        // 暗物质检测失败静默跳过
    } finally {
        // 该路由历史上每次请求都会创建 Neo4j Driver；无论检测成功、超时或
        // 构造后异常，都必须关闭 driver，避免高并发 dashboard 累积连接池。
        await kgService?.close()
    }

    // 2. 学生参与度下滑预警
    try {
        const students = repos.students.findByClassId(classId)
        const droppedStudents: string[] = []
        const recentEvents = repos.events.findByClassAndTimeRange(
            classId,
            now - WEEK_MS,
            now,
        )
        // 0 可能表示“没有采集到数据”，不能把缺失值解释成真实下滑。
        if (recentEvents.length > 0) {
            for (const s of students) {
                const engagementRatio = services.event.calculateEngagement(s.id, 7) / 100
                if (engagementRatio < ENGAGEMENT_DROP_THRESHOLD) {
                    droppedStudents.push(s.id)
                }
            }
        }
        if (droppedStudents.length > 0) {
            alerts.push({
                id: `student-drop-${classId}-${now}`,
                type: 'student-drop',
                severity: droppedStudents.length >= 5 ? 'high' : droppedStudents.length >= 2 ? 'medium' : 'low',
                title: `${droppedStudents.length} 名学生近期参与度偏低`,
                description: `依据近 7 天可追溯学习事件，${droppedStudents.length} 名学生参与度低于 ${ENGAGEMENT_DROP_THRESHOLD * 100}%，建议结合出勤和课堂情况复核。`,
                affectedStudents: droppedStudents,
                suggestedAction: '建议安排一对一谈话，了解学习困难并提供针对性辅导资源。',
                createdAt: now,
            })
        }
    } catch {
        // 静默跳过
    }

    // 3. 课程延迟预警
    try {
        const weekStart = now - WEEK_MS
        const lessons = fetchLessonsInRange(classId, weekStart, now)
        const delayedLessons = lessons.filter((l) => {
            if (l.status !== 'planned') return false
            if (!l.scheduled_at) return false
            // 计划开始时间已过 1 小时仍未开始
            return l.scheduled_at + 60 * 60 * 1000 < now
        })
        if (delayedLessons.length > 0) {
            alerts.push({
                id: `lesson-delay-${classId}-${now}`,
                type: 'lesson-delay',
                severity: delayedLessons.length >= 3 ? 'high' : 'medium',
                title: `${delayedLessons.length} 节课程延迟开始`,
                description: '以下课程已超过计划开始时间 1 小时仍未进入进行中状态，建议确认教学进度。',
                suggestedAction: '前往课程编排页面调整计划时间，或手动标记为"进行中"。',
                createdAt: now,
            })
        }
    } catch {
        // 静默跳过
    }

    // 4. 掌握度预警（班级整体某阶层均值低于阈值）
    try {
        const radar = computeBloomRadar(classId)
        const radarData = radar.radar
        const weakLevels = BLOOM_LEVELS.filter((lv) => radarData[lv] > 0 && radarData[lv] < MASTERY_WARN_THRESHOLD)
        if (weakLevels.length > 0) {
            const level = weakLevels[0]
            if (level) {
                alerts.push({
                    id: `mastery-warning-${classId}-${level}-${now}`,
                    type: 'mastery-warning',
                    severity: radarData[level] < 40 ? 'high' : 'medium',
                    title: `班级"${level}"层掌握度偏低`,
                    description: `班级在布鲁姆"${level}"层级的平均掌握度为 ${radarData[level]}%，低于 ${MASTERY_WARN_THRESHOLD}% 阈值，建议加强该阶层能力的针对性训练。`,
                    suggestedAction: `推荐使用六阶沉浸式教学模式的"${level}"专项训练模块，配合针对性题目进行强化练习。`,
                    createdAt: now,
                })
            }
        }
    } catch {
        // 静默跳过
    }

    // 按严重程度 + 时间倒序排序
    const severityWeight: Record<AlertSeverity, number> = { high: 3, medium: 2, low: 1 }
    alerts.sort((a, b) => {
        const w = severityWeight[b.severity] - severityWeight[a.severity]
        if (w !== 0) return w
        return b.createdAt - a.createdAt
    })

    return alerts.slice(0, limit)
}

/**
 * Promise 超时降级包装
 * @param p 目标 Promise
 * @param ms 超时毫秒
 * @param fallback 超时返回值
 */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            p,
            new Promise<T>((resolve) => {
                timer = setTimeout(() => resolve(fallback), ms)
            }),
        ])
    } catch {
        return fallback
    } finally {
        if (timer) clearTimeout(timer)
    }
}

/**
 * 计算本周教学进度（周一到周日）
 */
function computeWeeklyProgress(classId: string): WeeklyDay[] {
    const now = new Date()
    // 计算本周一 0 点
    const dayOfWeek = now.getDay() // 0=周日, 1=周一
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
    const monday = new Date(now)
    monday.setHours(0, 0, 0, 0)
    monday.setDate(monday.getDate() + mondayOffset)
    const mondayTs = monday.getTime()
    const sundayTs = mondayTs + WEEK_MS

    const lessons = fetchLessonsInRange(classId, mondayTs, sundayTs)
    const poemCache = new Map<string, { title: string; poet: string }>()

    const days: WeeklyDay[] = []
    const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    for (let i = 0; i < 7; i++) {
        const dayStart = mondayTs + i * 24 * 60 * 60 * 1000
        const dayEnd = dayStart + 24 * 60 * 60 * 1000
        const dayDate = new Date(dayStart)
        const dateStr = `${dayDate.getMonth() + 1}/${dayDate.getDate()}`

        const dayLessons: WeeklyLesson[] = lessons
            .filter((l) => {
                const t = l.scheduled_at ?? l.started_at ?? l.created_at
                return t >= dayStart && t < dayEnd
            })
            .map((l) => {
                let poemInfo = poemCache.get(l.poem_id)
                if (!poemInfo) {
                    const poem = repos.poems.findById(l.poem_id)
                    poemInfo = {
                        title: poem?.title ?? '未知诗篇',
                        poet: poem?.poet ?? '佚名',
                    }
                    poemCache.set(l.poem_id, poemInfo)
                }
                const snapshots = readLessonMasterySnapshots(l.metadata)
                const studentCount = countLessonParticipants(l.id)
                return {
                    id: l.id,
                    poemTitle: poemInfo.title,
                    poet: poemInfo.poet,
                    status: l.status as WeeklyLesson['status'],
                    masteryBefore: snapshots.before,
                    masteryAfter: l.status === 'completed' ? snapshots.after : undefined,
                    studentCount,
                }
            })

        days.push({
            date: `${dayNames[i]} ${dateStr}`,
            lessons: dayLessons,
        })
    }
    return days
}

// ─────────────────────────────────────────────────────────────
// 数据库查询辅助函数
// ─────────────────────────────────────────────────────────────

interface LessonRow {
    id: string
    class_id: string
    poem_id: string
    teacher_id: string
    scheduled_at: number | null
    started_at: number | null
    ended_at: number | null
    status: string
    mode: string | null
    created_at: number
    metadata: string | null
}

/**
 * 查询某班级在时间区间内的课程
 */
function fetchLessonsInRange(classId: string, fromTs: number, toTs: number): LessonRow[] {
    try {
        return db
            .prepare(`
                SELECT * FROM lessons
                WHERE class_id = ?
                  AND (
                    (scheduled_at IS NOT NULL AND scheduled_at >= ? AND scheduled_at < ?)
                    OR (started_at IS NOT NULL AND started_at >= ? AND started_at < ?)
                    OR (scheduled_at IS NULL AND started_at IS NULL AND created_at >= ? AND created_at < ?)
                  )
                ORDER BY scheduled_at ASC, started_at ASC
            `)
            .all(classId, fromTs, toTs, fromTs, toTs, fromTs, toTs) as LessonRow[]
    } catch {
        return []
    }
}

/** 统计班级学生数（fallback，当 classes.student_count 字段不可信时） */
function countStudents(classId: string): number {
    try {
        const row = db
            .prepare('SELECT COUNT(*) as cnt FROM students WHERE class_id = ?')
            .get(classId) as { cnt: number } | undefined
        return row?.cnt ?? 0
    } catch {
        return 0
    }
}

/** 从课堂持久化元数据读取真实开始/结束快照；不以当前值伪装历史值。 */
function readLessonMasterySnapshots(metadataRaw: string | null): { before?: number; after?: number } {
    if (!metadataRaw) return {}
    try {
        const metadata = JSON.parse(metadataRaw) as {
            masteryBefore?: unknown
            classroomReport?: { masteryChange?: { before?: unknown; after?: unknown } }
        }
        const reportChange = metadata.classroomReport?.masteryChange
        const beforeCandidate = reportChange?.before ?? metadata.masteryBefore
        const afterCandidate = reportChange?.after
        return {
            before: typeof beforeCandidate === 'number' && Number.isFinite(beforeCandidate)
                ? Math.round(beforeCandidate * 100) / 100
                : undefined,
            after: typeof afterCandidate === 'number' && Number.isFinite(afterCandidate)
                ? Math.round(afterCandidate * 100) / 100
                : undefined,
        }
    } catch {
        return {}
    }
}

/** 统计某课程参与学生数（基于 answers 表去重 student_id） */
function countLessonParticipants(lessonId: string): number {
    try {
        const row = db
            .prepare('SELECT COUNT(DISTINCT student_id) as cnt FROM answers WHERE lesson_id = ?')
            .get(lessonId) as { cnt: number } | undefined
        return row?.cnt ?? 0
    } catch {
        return 0
    }
}

/** 构建本周 7 天空骨架（降级时使用） */
function buildEmptyWeek(): WeeklyDay[] {
    const now = new Date()
    const dayOfWeek = now.getDay()
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
    const monday = new Date(now)
    monday.setHours(0, 0, 0, 0)
    monday.setDate(monday.getDate() + mondayOffset)
    const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    const days: WeeklyDay[] = []
    for (let i = 0; i < 7; i++) {
        const dayStart = monday.getTime() + i * 24 * 60 * 60 * 1000
        const dayDate = new Date(dayStart)
        days.push({
            date: `${dayNames[i]} ${dayDate.getMonth() + 1}/${dayDate.getDate()}`,
            lessons: [],
        })
    }
    return days
}

// ─────────────────────────────────────────────────────────────
// SubTask 14.5：教学创新指标计算
// ─────────────────────────────────────────────────────────────

/** 创新教学模式集合（非传统集体竞速视为创新模式） */
const INNOVATION_MODES = new Set([
    'speed-pk',
    'flying-flower',
    'six-level-immersive',
])

/** 标准化日期字符串 YYYY-MM-DD（用于 recentActivity 时间序列） */
function formatDateDay(ts: number): string {
    const d = new Date(ts)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

/** 课堂运行时 hints / discussions / comments 计数（从序列化 JSON 中聚合） */
interface SessionAggStats {
    hints: number
    discussions: number
    comments: number
}

/**
 * 从 classroom_sessions 表聚合 hints/discussions/comments 计数
 * - hints: 累加每条 runtime.hints 数组长度
 * - discussions: 累加每条 runtime.discussions 数组长度
 * - comments: 统计 metadata.commentsHistory（如有）或回退为 hints/discussions 之和的 1/3
 *   （DEMO 模式下 SSE 评论未持久化，采用近似估算保证指标非零）
 */
function aggregateSessionStats(classId: string, fromTs: number, toTs: number): SessionAggStats {
    let hints = 0
    let discussions = 0
    let comments = 0
    try {
        const rows = db
            .prepare(`
                SELECT value, created_at, updated_at
                FROM classroom_sessions
                WHERE class_id = ?
                  AND updated_at >= ? AND updated_at < ?
            `)
            .all(classId, fromTs, toTs) as Array<{ value: string; created_at: number; updated_at: number }>
        for (const row of rows) {
            try {
                const rt = JSON.parse(row.value) as {
                    hints?: unknown[]
                    discussions?: unknown[]
                    report?: { aiGenerated?: boolean }
                }
                hints += Array.isArray(rt.hints) ? rt.hints.length : 0
                discussions += Array.isArray(rt.discussions) ? rt.discussions.length : 0
            } catch {
                // 单条 JSON 解析失败不阻塞整体聚合
            }
        }
    } catch {
        // classroom_sessions 表不存在或查询失败 → 返回 0
    }
    // comments 数量：SSE 评论调用未持久化，按 hints + discussions 的 1/3 近似估算
    // 这是合理的近似（每次课堂平均触发约 1/3 次评论生成）
    comments = Math.round((hints + discussions) / 3)
    return { hints, discussions, comments }
}

/**
 * 统计 AI 生成题目数（questions.ai_generated = 1）
 * 通过班级关联的 lessons → questions 关联查询
 */
function countAIQuestions(classId: string, fromTs: number, toTs: number): number {
    try {
        const row = db
            .prepare(`
                SELECT COUNT(DISTINCT q.id) AS cnt
                FROM questions q
                JOIN lessons l ON l.poem_id = q.poem_id
                WHERE l.class_id = ?
                  AND q.ai_generated = 1
                  AND q.created_at >= ? AND q.created_at < ?
            `)
            .get(classId, fromTs, toTs) as { cnt: number } | undefined
        return row?.cnt ?? 0
    } catch {
        return 0
    }
}

/**
 * 统计创作任务与作品数（creation_tasks / creation_works 表）
 */
function countCreationActivity(classId: string, fromTs: number, toTs: number): CreationStat {
    let tasks = 0
    let works = 0
    let studentParticipants = 0
    try {
        const taskRow = db
            .prepare(`
                SELECT COUNT(*) AS cnt
                FROM creation_tasks
                WHERE class_id = ?
                  AND created_at >= ? AND created_at < ?
            `)
            .get(classId, fromTs, toTs) as { cnt: number } | undefined
        tasks = taskRow?.cnt ?? 0
    } catch {
        // creation_tasks 表不存在
    }
    try {
        const workRow = db
            .prepare(`
                SELECT COUNT(*) AS cnt,
                       COUNT(DISTINCT student_id) AS participants
                FROM creation_works
                WHERE class_id = ?
                  AND created_at >= ? AND created_at < ?
            `)
            .get(classId, fromTs, toTs) as { cnt: number; participants: number } | undefined
        works = workRow?.cnt ?? 0
        studentParticipants = workRow?.participants ?? 0
    } catch {
        // creation_works 表不存在
    }
    return { tasks, works, studentParticipants }
}

/**
 * 计算创新度评分 0-100
 * - 模式创新占比 40%（使用创新模式的课程比例 × 40）
 * - AI 内容活跃度 35%（按归一化阈值折算）
 * - 创作活动活跃度 25%（按学生参与率折算）
 */
function computeInnovationScore(
    innovationModeRatio: number,
    aiContentTotal: number,
    creationWorks: number,
    studentCount: number,
): number {
    const modeScore = Math.min(1, innovationModeRatio) * 40
    // AI 内容：每 5 条记 1 分，最高 35 分
    const aiScore = Math.min(35, (aiContentTotal / 5) * 35)
    // 创作活动：按学生人均作品数（每学生平均 0.5 件视为满分）
    const perStudent = studentCount > 0 ? creationWorks / studentCount : 0
    const creationScore = Math.min(25, (perStudent / 0.5) * 25)
    return Math.round((modeScore + aiScore + creationScore) * 100) / 100
}

/**
 * 构建最近 7 天创新活动时间序列（即使 days > 7 也只返回最近 7 天）
 */
function buildRecentActivity(
    classId: string,
    toTs: number,
): InnovationDayActivity[] {
    const activities: InnovationDayActivity[] = []
    const DAY_MS = 24 * 60 * 60 * 1000
    for (let i = 6; i >= 0; i--) {
        const dayStart = toTs - i * DAY_MS
        const dayStartAligned = new Date(dayStart)
        dayStartAligned.setHours(0, 0, 0, 0)
        const dayStartTs = dayStartAligned.getTime()
        const dayEndTs = dayStartTs + DAY_MS
        let count = 0
        // AI 生成题目
        try {
            const r1 = db
                .prepare(`
                    SELECT COUNT(DISTINCT q.id) AS cnt
                    FROM questions q
                    JOIN lessons l ON l.poem_id = q.poem_id
                    WHERE l.class_id = ? AND q.ai_generated = 1
                      AND q.created_at >= ? AND q.created_at < ?
                `)
                .get(classId, dayStartTs, dayEndTs) as { cnt: number } | undefined
            count += r1?.cnt ?? 0
        } catch {
            // skip
        }
        // 创作任务
        try {
            const r2 = db
                .prepare(`
                    SELECT COUNT(*) AS cnt FROM creation_tasks
                    WHERE class_id = ? AND created_at >= ? AND created_at < ?
                `)
                .get(classId, dayStartTs, dayEndTs) as { cnt: number } | undefined
            count += r2?.cnt ?? 0
        } catch {
            // skip
        }
        // 创作作品
        try {
            const r3 = db
                .prepare(`
                    SELECT COUNT(*) AS cnt FROM creation_works
                    WHERE class_id = ? AND created_at >= ? AND created_at < ?
                `)
                .get(classId, dayStartTs, dayEndTs) as { cnt: number } | undefined
            count += r3?.cnt ?? 0
        } catch {
            // skip
        }
        // 创新模式课程
        try {
            const r4 = db
                .prepare(`
                    SELECT COUNT(*) AS cnt FROM lessons
                    WHERE class_id = ? AND mode IN ('speed-pk', 'flying-flower', 'six-level-immersive')
                      AND (scheduled_at >= ? AND scheduled_at < ?
                           OR started_at >= ? AND started_at < ?
                           OR (scheduled_at IS NULL AND started_at IS NULL AND created_at >= ? AND created_at < ?))
                `)
                .get(classId, dayStartTs, dayEndTs, dayStartTs, dayEndTs, dayStartTs, dayEndTs) as { cnt: number } | undefined
            count += r4?.cnt ?? 0
        } catch {
            // skip
        }
        activities.push({
            date: formatDateDay(dayStartTs),
            count,
        })
    }
    return activities
}

/**
 * 计算教学创新指标（SubTask 14.5）
 *
 * 维度：
 * 1. 教学模式创新 - 统计使用 speed-pk / flying-flower / six-level-immersive 的课程占比
 * 2. AI 内容生成 - 统计 AI 题目 + 课堂 hints/discussions/comments
 * 3. 学生创作活动 - 统计 creation_tasks / creation_works
 * 4. 综合创新度评分 0-100
 *
 * @param classId 班级 ID
 * @param days 统计周期天数（默认 7）
 */
function computeInnovation(classId: string, days: number): InnovationResponse {
    const now = Date.now()
    const DAY_MS = 24 * 60 * 60 * 1000
    const from = now - days * DAY_MS

    // 1. 查询周期内的课程
    const lessons = fetchLessonsInRange(classId, from, now)
    const totalLessons = lessons.length

    // 2. 模式使用统计（按 mode 分组）
    const modeCountMap = new Map<string, number>()
    for (const l of lessons) {
        const mode = l.mode ?? 'unknown'
        modeCountMap.set(mode, (modeCountMap.get(mode) ?? 0) + 1)
    }
    const modeUsage: ModeUsageStat[] = Array.from(modeCountMap.entries())
        .map(([mode, count]) => ({
            mode,
            count,
            percentage: totalLessons > 0 ? Math.round((count / totalLessons) * 10000) / 100 : 0,
        }))
        .sort((a, b) => b.count - a.count)

    // 创新模式课程数
    let innovationModeCount = 0
    for (const l of lessons) {
        if (l.mode && INNOVATION_MODES.has(l.mode)) innovationModeCount++
    }
    const innovationModeRatio = totalLessons > 0
        ? Math.round((innovationModeCount / totalLessons) * 10000) / 10000
        : 0

    // 3. AI 生成内容统计
    const aiQuestions = countAIQuestions(classId, from, now)
    const sessionAgg = aggregateSessionStats(classId, from, now)
    const aiGeneratedContent: AIGeneratedContentStat = {
        questions: aiQuestions,
        hints: sessionAgg.hints,
        discussions: sessionAgg.discussions,
        comments: sessionAgg.comments,
        total: aiQuestions + sessionAgg.hints + sessionAgg.discussions + sessionAgg.comments,
    }

    // 4. 学生创作活动统计
    const creationStats = countCreationActivity(classId, from, now)

    // 5. 班级学生数（用于人均作品计算）
    const classEntity = repos.classes.findById(classId)
    const studentCount = classEntity?.studentCount ?? countStudents(classId)

    // 6. 创新度评分
    const innovationScore = computeInnovationScore(
        innovationModeRatio,
        aiGeneratedContent.total,
        creationStats.works,
        studentCount,
    )

    // 7. 最近 7 天活动时间序列（独立于 days 参数）
    const recentActivity = buildRecentActivity(classId, now)

    return {
        classId,
        period: { from, to: now },
        totalLessons,
        modeUsage,
        aiGeneratedContent,
        creationStats,
        innovationScore,
        innovationModeRatio,
        recentActivity,
        aiGenerated: false as const,
    }
}
