/**
 * 认知诊断中心 REST API 路由（Task 17）
 *
 * 8 个端点：
 * - GET /classes/:classId/bloom-distribution   班级六阶能力分布（均值+标准差+学生数）
 * - GET /classes/:classId/heatmap              班级学生×诗×六阶掌握度热力图
 * - GET /students/:studentId/profile           学生个体认知画像（六阶+漏洞+路径）
 * - GET /classes/:classId/dark-matter          班级认知暗物质列表
 * - GET /classes/:classId/dark-matter/report   暗物质汇总报告
 * - GET /students/:studentId/gaps              学生知识漏洞
 * - GET /students/:studentId/learning-path     推荐学习路径
 * - GET /classes/:classId/prescription/:patternId  靶向处方详情
 *
 * 设计要点：
 * - 直接调用 DarkMatterDetector / KnowledgeGraphService / MasteryService
 * - Neo4j 不可用时优雅降级返回空数组（不抛 500）
 * - 所有响应包含 aiGenerated: false（算法计算结果，非 AI 生成）
 * - 学生姓名脱敏（使用 students.anonymous_name 字段）
 * - 暗物质检测带超时降级，避免阻塞响应
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { db, repos, services } from '../db/index.js'
import { generateId } from '../db/utils/id.js'
import { DarkMatterDetector } from '../services/knowledge-graph/dark-matter-detector.js'
import { z } from 'zod'
import { validateParams, validateBody, schemas } from '../lib/validation.js'
import { KnowledgeGraphService } from '../services/knowledge-graph/knowledge-graph-service.js'
import { config } from '../config.js'
import type { BloomLevel } from '../agents/base/types.js'
import type {
    DarkMatter,
    StudentGap,
    DarkMatterReport,
} from '../services/knowledge-graph/dark-matter-detector.js'
import { generateStudentProfile3D } from '../services/profile/student-profile-3d.js'
// 批改诊断深化：学习路径生成 + 个性化处方服务
import { learningPathGenerator } from '../services/grading/learning-path-generator.js'
import { prescriptionGenerator } from '../services/grading/prescription-generator.js'
import type { LearningPathInput } from '../services/grading/learning-path-generator.js'
import type { PrescriptionInput } from '../services/grading/prescription-generator.js'
// 闭环：处方/路径生成完成后推送 WS 业务事件
import type { WSBroadcaster } from '../orchestrator/websocket/broadcaster.js'
import type { WSEvent } from '../orchestrator/types.js'
import { bindSseDisconnectAbort, createPublicSseError, writeSseFrame } from '../lib/sse.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 六阶分布单项 */
export interface BloomDistributionLevel {
    level: BloomLevel
    /** 该阶层平均掌握度 0-100 */
    avg: number
    /** 标准差（反映班级内部离散程度） */
    stdDev: number
    /** 该阶层有记录的学生数 */
    studentCount: number
}

export interface BloomDistributionResponse {
    classId: string
    levels: BloomDistributionLevel[]
    aiGenerated: false
}

/** 热力图学生行 */
export interface HeatmapStudent {
    id: string
    anonymousName: string
}

/** 热力图诗列 */
export interface HeatmapPoem {
    id: string
    title: string
    poet: string
}

/** 热力图单元格 */
export interface HeatmapCell {
    studentId: string
    poemId: string
    bloomLevel: BloomLevel
    score: number
}

export interface HeatmapResponse {
    classId: string
    students: HeatmapStudent[]
    poems: HeatmapPoem[]
    cells: HeatmapCell[]
    aiGenerated: false
}

/** 学生认知画像 */
export interface StudentProfileResponse {
    studentId: string
    anonymousName: string
    /** 六阶雷达（所有诗的六阶均值） */
    bloomRadar: Record<BloomLevel, number>
    /** 知识漏洞列表 */
    gaps: StudentGap[]
    /** 推荐学习路径节点 */
    learningPath: LearningPathNode[]
    aiGenerated: false
}

/** 学习路径节点 */
export interface LearningPathNode {
    poemId: string
    title: string
    poet: string
    dynasty: string
    difficulty: number
    /** 当前学生在该诗的综合掌握度（六阶均值），无记录为 0 */
    currentMastery: number
    /** 推荐理由 */
    reason: string
    /** 与薄弱诗的关联类型（如有） */
    relationType?: string
    /** 关联强度（如有） */
    strength?: number
}

export interface LearningPathResponse {
    studentId: string
    anonymousName: string
    path: LearningPathNode[]
    aiGenerated: false
}

export interface DarkMatterListResponse {
    classId: string
    darkMatter: DarkMatter[]
    aiGenerated: false
}

export interface DarkMatterReportResponse extends DarkMatterReport {
    aiGenerated: false
}

export interface StudentGapsResponse {
    studentId: string
    anonymousName: string
    gaps: StudentGap[]
    aiGenerated: false
}

export interface PrescriptionResponse {
    prescription: DarkMatter | null
    aiGenerated: false
}

// ─────────────────────────────────────────────────────────────
// 教学调整建议类型（Phase 4.2）
// ─────────────────────────────────────────────────────────────

export type TeachingSuggestionType =
    | 'weakness'      // 薄弱点强化
    | 'method'        // 教学方法调整
    | 'material'      // 教学素材补充
    | 'progress'      // 进度跟进
    | 'differentiate' // 分层教学

export type SuggestionPriority = 'high' | 'medium' | 'low'

export interface TeachingSuggestion {
    id: string
    type: TeachingSuggestionType
    title: string
    description: string
    priority: SuggestionPriority
    bloomLevel?: BloomLevel
    poemId?: string
    poemTitle?: string
    studentIds?: string[]
    affectedStudentCount?: number
    evidence: string
    suggestedAction: string
    generatedAt: number
    aiGenerated: boolean
}

export interface TeachingSuggestionResponse {
    classId: string
    suggestions: TeachingSuggestion[]
    generatedAt: number
    dataSummary: {
        classMasteryAvg: number
        darkMatterCount: number
        weakestBloomLevel: BloomLevel
        dueTodayCount: number
    }
    aiGenerated: boolean
}

// ─────────────────────────────────────────────────────────────
// SubTask 14.6：综合能力雷达类型
// ─────────────────────────────────────────────────────────────

/** 综合雷达维度键 */
export type RadarDimensionKey =
    | 'participation'  // 学习参与度
    | 'accuracy'        // 答题准确率
    | 'creation'        // 创作活跃度
    | 'breadth'         // 知识广度
    | 'bloomAvg'        // 六阶能力均值

/** 综合雷达维度 */
export interface RadarDimension {
    /** 维度名（中文显示） */
    name: string
    /** 维度键（前端映射用） */
    key: RadarDimensionKey
    /** 维度得分 0-100 */
    score: number
    /** 维度样本数（如总答题数、总创作数） */
    sampleSize: number
}

/** 学生综合能力雷达响应 */
export interface StudentRadarResponse {
    studentId: string
    anonymousName: string
    /** 六阶详细雷达（按 bloom level 分项） */
    bloomRadar: Record<BloomLevel, number>
    /** 综合维度雷达（5 维聚合） */
    dimensions: RadarDimension[]
    /** 综合能力评分 0-100（5 维加权平均） */
    overallScore: number
    /** 总样本数（参与计算的 mastery 记录数） */
    sampleSize: number
    /** 统计时间戳 */
    computedAt: number
    aiGenerated: false
}

/** 班级综合能力雷达响应 */
export interface ClassRadarResponse {
    classId: string
    className: string
    /** 六阶详细雷达（按 bloom level 分项） */
    bloomRadar: Record<BloomLevel, number>
    /** 综合维度雷达（5 维聚合） */
    dimensions: RadarDimension[]
    /** 综合能力评分 0-100 */
    overallScore: number
    /** 班级学生数 */
    studentCount: number
    /** 总样本数 */
    sampleSize: number
    /** 统计时间戳 */
    computedAt: number
    aiGenerated: false
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const BLOOM_LEVELS: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

/** 暗物质检测超时（ms）—— 避免长时间阻塞响应 */
const DARK_MATTER_TIMEOUT_MS = 3000

/** 学习路径推荐的最大节点数 */
const MAX_PATH_NODES = 8

/** 薄弱阈值（低于此值视为需要强化） */
const WEAK_THRESHOLD = 60

// ─────────────────────────────────────────────────────────────
// 模块级单例（避免每次请求重复创建 Neo4j driver）
// ─────────────────────────────────────────────────────────────

let kgServiceInstance: KnowledgeGraphService | null = null
let detectorInstance: DarkMatterDetector | null = null

async function closeKnowledgeGraphService(): Promise<void> {
    const service = kgServiceInstance
    kgServiceInstance = null
    detectorInstance = null
    if (service) await service.close()
}

/**
 * 获取 DarkMatterDetector 单例
 *
 * KnowledgeGraphService 构造函数仅创建 driver 对象，不立即连接。
 * Neo4j 不可用时所有图谱查询降级返回空数组，但暗物质检测的核心逻辑
 *（SQLite mastery 聚合 + 种子诗标签匹配）不依赖 Neo4j，仍可正常工作。
 */
function getDetector(): DarkMatterDetector {
    if (!detectorInstance) {
        kgServiceInstance = new KnowledgeGraphService(
            config.neo4j.uri,
            config.neo4j.user,
            config.neo4j.password,
        )
        detectorInstance = new DarkMatterDetector(kgServiceInstance)
    }
    return detectorInstance
}

/** 获取 KnowledgeGraphService 单例（用于学习路径推荐） */
function getKgService(): KnowledgeGraphService {
    if (!kgServiceInstance) {
        kgServiceInstance = new KnowledgeGraphService(
            config.neo4j.uri,
            config.neo4j.user,
            config.neo4j.password,
        )
        detectorInstance = new DarkMatterDetector(kgServiceInstance)
    }
    return kgServiceInstance
}

// ─────────────────────────────────────────────────────────────
// Zod schemas（B6.3 输入校验）
// ─────────────────────────────────────────────────────────────

/** GET /classes/:classId/* 路径参数 */
const classIdParamsSchema = z.object({ classId: schemas.classId })

/** GET /students/:studentId/* 路径参数 */
const studentIdParamsSchema = z.object({ studentId: schemas.studentId })

/** GET /classes/:classId/prescription/:patternId 路径参数 */
const prescriptionParamsSchema = z.object({
    classId: schemas.classId,
    patternId: schemas.id,
})

// ─────────────────────────────────────────────────────────────
// 批改诊断深化 Zod schemas（学习路径 + 个性化处方）
// ─────────────────────────────────────────────────────────────

/** POST /students/:studentId/learning-path 请求体 */
const generateLearningPathSchema = z.object({
    /** 是否流式输出（SSE） */
    stream: z.boolean().optional().default(false),
    /** 教师意图（可选） */
    teacherIntent: schemas.optionalSanitizedString(500),
    /** 错题归因摘要（可选，提升路径针对性） */
    errorAttributions: z.array(z.object({
        questionId: schemas.id,
        primaryErrorType: schemas.sanitizedString(50),
        rootCause: schemas.sanitizedString(500),
    })).max(20).optional(),
})

/** POST /students/:studentId/prescription 请求体 */
const generatePrescriptionSchema = z.object({
    /** 是否流式输出（SSE） */
    stream: z.boolean().optional().default(false),
    /** 教师意图（可选） */
    teacherIntent: schemas.optionalSanitizedString(500),
    /** 错题归因摘要（可选） */
    errorAttributions: z.array(z.object({
        questionId: schemas.id,
        primaryErrorType: schemas.sanitizedString(50),
        primaryErrorLabel: schemas.sanitizedString(50),
        severity: z.number().min(0).max(100),
        rootCause: schemas.sanitizedString(500),
    })).max(20).optional(),
    /** 学习路径节点（可选，来自 computeLearningPath 或 AI 路径生成器） */
    learningPath: z.array(z.object({
        poemId: schemas.id,
        title: schemas.sanitizedString(200),
        poet: schemas.sanitizedString(100),
        currentMastery: z.number().min(0).max(100),
        reason: schemas.sanitizedString(500),
    })).max(15).optional(),
})

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

/** 诊断路由选项（批改诊断深化：注入 broadcaster 推送处方/路径生成事件） */
export interface DiagnosisRoutesOptions {
    broadcaster?: WSBroadcaster
}

function sendDiagnosisNotFound(
    reply: FastifyReply,
    error: 'CLASS_NOT_FOUND' | 'STUDENT_NOT_FOUND',
) {
    return reply.status(404).send({
        status: 'error',
        error,
        message: error === 'CLASS_NOT_FOUND' ? '班级不存在' : '学生不存在',
    })
}

export const diagnosisRoutes: FastifyPluginAsync<DiagnosisRoutesOptions> = async (
    app: FastifyInstance,
    opts,
) => {
    const broadcaster = opts.broadcaster
    app.addHook('onClose', async () => {
        await closeKnowledgeGraphService()
    })
    // ── 1. GET /classes/:classId/bloom-distribution — 班级六阶能力分布 ──
    app.get(
        '/classes/:classId/bloom-distribution',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(classIdParamsSchema, req, reply)
            if (!params) return
            const { classId } = params

            try {
                if (!repos.classes.findById(classId)) {
                    return sendDiagnosisNotFound(reply, 'CLASS_NOT_FOUND')
                }
                const levels = computeBloomDistribution(classId)
                return reply.send({
                    classId,
                    levels,
                    aiGenerated: false as const,
                })
            } catch (err) {
                req.log.error({ err }, 'bloom-distribution 查询失败')
                return reply.send({
                    classId,
                    levels: BLOOM_LEVELS.map((level) => ({
                        level,
                        avg: 0,
                        stdDev: 0,
                        studentCount: 0,
                    })),
                    aiGenerated: false as const,
                })
            }
        },
    )

    // ── 2. GET /classes/:classId/heatmap — 班级热力图 ──
    app.get(
        '/classes/:classId/heatmap',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(classIdParamsSchema, req, reply)
            if (!params) return
            const { classId } = params

            try {
                if (!repos.classes.findById(classId)) {
                    return sendDiagnosisNotFound(reply, 'CLASS_NOT_FOUND')
                }
                const heatmap = computeHeatmap(classId)
                return reply.send({
                    classId,
                    students: heatmap.students,
                    poems: heatmap.poems,
                    cells: heatmap.cells,
                    aiGenerated: false as const,
                })
            } catch (err) {
                req.log.error({ err }, 'heatmap 查询失败')
                return reply.send({
                    classId,
                    students: [],
                    poems: [],
                    cells: [],
                    aiGenerated: false as const,
                })
            }
        },
    )

    // ── 3. GET /students/:studentId/profile — 学生认知画像 ──
    app.get(
        '/students/:studentId/profile',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(studentIdParamsSchema, req, reply)
            if (!params) return
            const { studentId } = params

            try {
                if (!repos.students.findById(studentId)) {
                    return sendDiagnosisNotFound(reply, 'STUDENT_NOT_FOUND')
                }
                const profile = await computeStudentProfile(studentId)
                return reply.send({
                    ...profile,
                    aiGenerated: false as const,
                })
            } catch (err) {
                req.log.error({ err }, 'student profile 查询失败')
                const emptyRadar = Object.fromEntries(
                    BLOOM_LEVELS.map((lv) => [lv, 0]),
                ) as Record<BloomLevel, number>
                return reply.send({
                    studentId,
                    anonymousName: '未知学生',
                    bloomRadar: emptyRadar,
                    gaps: [],
                    learningPath: [],
                    aiGenerated: false as const,
                })
            }
        },
    )

    // ── 4. GET /classes/:classId/dark-matter — 班级认知暗物质列表 ──
    app.get(
        '/classes/:classId/dark-matter',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(classIdParamsSchema, req, reply)
            if (!params) return
            const { classId } = params

            try {
                if (!repos.classes.findById(classId)) {
                    return sendDiagnosisNotFound(reply, 'CLASS_NOT_FOUND')
                }
                const detector = getDetector()
                const darkMatter = await withTimeout(
                    detector.detectClassDarkMatter(classId),
                    DARK_MATTER_TIMEOUT_MS,
                    [],
                )
                return reply.send({
                    classId,
                    darkMatter,
                    aiGenerated: false as const,
                })
            } catch (err) {
                req.log.error({ err }, 'dark-matter 检测失败')
                return reply.send({
                    classId,
                    darkMatter: [],
                    aiGenerated: false as const,
                })
            }
        },
    )

    // ── 5. GET /classes/:classId/dark-matter/report — 暗物质汇总报告 ──
    app.get(
        '/classes/:classId/dark-matter/report',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(classIdParamsSchema, req, reply)
            if (!params) return
            const { classId } = params

            try {
                if (!repos.classes.findById(classId)) {
                    return sendDiagnosisNotFound(reply, 'CLASS_NOT_FOUND')
                }
                const detector = getDetector()
                const report = await withTimeout(
                    detector.generateDarkMatterReport(classId),
                    DARK_MATTER_TIMEOUT_MS,
                    {
                        classId,
                        totalDarkMatter: 0,
                        byBloomLevel: {},
                        byTheme: {},
                        byImage: {},
                        topPatterns: [],
                    },
                )
                return reply.send({
                    ...report,
                    aiGenerated: false as const,
                })
            } catch (err) {
                req.log.error({ err }, 'dark-matter report 生成失败')
                return reply.send({
                    classId,
                    totalDarkMatter: 0,
                    byBloomLevel: {},
                    byTheme: {},
                    byImage: {},
                    topPatterns: [],
                    aiGenerated: false as const,
                })
            }
        },
    )

    // ── 6. GET /students/:studentId/gaps — 学生知识漏洞 ──
    app.get(
        '/students/:studentId/gaps',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(studentIdParamsSchema, req, reply)
            if (!params) return
            const { studentId } = params

            try {
                const student = repos.students.findById(studentId)
                if (!student) {
                    return sendDiagnosisNotFound(reply, 'STUDENT_NOT_FOUND')
                }
                const detector = getDetector()
                const gaps = await withTimeout(
                    detector.detectStudentGaps(studentId),
                    DARK_MATTER_TIMEOUT_MS,
                    [],
                )
                return reply.send({
                    studentId,
                    anonymousName: student.anonymousName,
                    gaps,
                    aiGenerated: false as const,
                })
            } catch (err) {
                req.log.error({ err }, 'student gaps 检测失败')
                return reply.send({
                    studentId,
                    anonymousName: '未知学生',
                    gaps: [],
                    aiGenerated: false as const,
                })
            }
        },
    )

    // ── 7. GET /students/:studentId/learning-path — 推荐学习路径 ──
    app.get(
        '/students/:studentId/learning-path',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(studentIdParamsSchema, req, reply)
            if (!params) return
            const { studentId } = params

            try {
                const student = repos.students.findById(studentId)
                if (!student) {
                    return sendDiagnosisNotFound(reply, 'STUDENT_NOT_FOUND')
                }
                const path = await computeLearningPath(studentId)
                return reply.send({
                    studentId,
                    anonymousName: student.anonymousName,
                    path,
                    aiGenerated: false as const,
                })
            } catch (err) {
                req.log.error({ err }, 'learning-path 推荐失败')
                return reply.send({
                    studentId,
                    anonymousName: '未知学生',
                    path: [],
                    aiGenerated: false as const,
                })
            }
        },
    )

    // ── 8. GET /classes/:classId/prescription/:patternId — 靶向处方详情 ──
    app.get(
        '/classes/:classId/prescription/:patternId',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(prescriptionParamsSchema, req, reply)
            if (!params) return
            const { classId, patternId } = params

            try {
                if (!repos.classes.findById(classId)) {
                    return sendDiagnosisNotFound(reply, 'CLASS_NOT_FOUND')
                }
                const detector = getDetector()
                const darkMatterList = await withTimeout(
                    detector.detectClassDarkMatter(classId),
                    DARK_MATTER_TIMEOUT_MS,
                    [],
                )
                const prescription = darkMatterList.find((dm) => dm.id === patternId) ?? null
                return reply.send({
                    prescription,
                    aiGenerated: false as const,
                })
            } catch (err) {
                req.log.error({ err }, 'prescription 查询失败')
                return reply.send({
                    prescription: null,
                    aiGenerated: false as const,
                })
            }
        },
    )

    // ── 9. GET /classes/:classId/suggestions — 教学调整建议 ──
    // 基于班级掌握度数据、暗物质检测、错题本待复习数，生成教学建议
    app.get(
        '/classes/:classId/suggestions',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(classIdParamsSchema, req, reply)
            if (!params) return
            const { classId } = params

            try {
                if (!repos.classes.findById(classId)) {
                    return sendDiagnosisNotFound(reply, 'CLASS_NOT_FOUND')
                }
                const result = await generateTeachingSuggestions(classId)
                return reply.send(result)
            } catch (err) {
                req.log.error({ err }, 'suggestions 生成失败')
                return reply.send({
                    classId,
                    suggestions: [],
                    generatedAt: Date.now(),
                    dataSummary: {
                        classMasteryAvg: 0,
                        darkMatterCount: 0,
                        weakestBloomLevel: '记忆',
                        dueTodayCount: 0,
                    },
                    aiGenerated: false,
                })
            }
        },
    )

    // ── 10. GET /students/:studentId/profile-3d — 学生立体画像（能力1） ──
    // 聚合 5 维度数据 + LLM 生成自然语言描述
    app.get(
        '/students/:studentId/profile-3d',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(studentIdParamsSchema, req, reply)
            if (!params) return
            const { studentId } = params

            try {
                // 校验学生存在
                const student = repos.students.findById(studentId)
                if (!student) {
                    return reply.status(404).send({
                        statusCode: 404,
                        error: 'Not Found',
                        message: `学生 ${studentId} 不存在`,
                    })
                }

                const response = await generateStudentProfile3D(studentId, false)
                return reply.send({
                    status: 'ok',
                    ...response,
                    aiGenerated: response.profile.aiGenerated,
                })
            } catch (err) {
                req.log.error({ err, studentId }, '学生立体画像生成失败')
                return reply.send({
                    status: 'degraded',
                    profile: null,
                    cached: false,
                    aiGenerated: false,
                })
            }
        },
    )

    // ── 11. POST /students/:studentId/profile-3d/refresh — 强制刷新立体画像（能力1） ──
    app.post(
        '/students/:studentId/profile-3d/refresh',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(studentIdParamsSchema, req, reply)
            if (!params) return
            const { studentId } = params

            try {
                const student = repos.students.findById(studentId)
                if (!student) {
                    return reply.status(404).send({
                        statusCode: 404,
                        error: 'Not Found',
                        message: `学生 ${studentId} 不存在`,
                    })
                }

                // forceRefresh = true 跳过缓存
                const response = await generateStudentProfile3D(studentId, true)
                return reply.send({
                    status: 'ok',
                    ...response,
                    aiGenerated: response.profile.aiGenerated,
                })
            } catch (err) {
                req.log.error({ err, studentId }, '学生立体画像刷新失败')
                return reply.status(500).send({
                    statusCode: 500,
                    error: 'Internal Server Error',
                    message: '立体画像刷新失败',
                })
            }
        },
    )

    // ─────────────────────────────────────────────────────────
    // 批改诊断深化端点（学习路径生成 + 个性化处方）
    // ─────────────────────────────────────────────────────────

    // ── 12. POST /students/:studentId/learning-path — AI 生成学习路径（支持 SSE） ──
    app.post(
        '/students/:studentId/learning-path',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(studentIdParamsSchema, req, reply)
            if (!params) return
            const body = validateBody(generateLearningPathSchema, req, reply)
            if (!body) return
            const { studentId } = params

            const student = repos.students.findById(studentId)
            if (!student) {
                return reply.status(404).send({
                    status: 'error',
                    message: `学生 ${studentId} 不存在`,
                })
            }

            // 构建 AI 学习路径输入
            const input = buildLearningPathInput(studentId, student.anonymousName, body)
            if (input.weakPoems.length === 0) {
                return reply.send({
                    status: 'ok',
                    output: null,
                    message: '该学生当前无薄弱诗篇，暂无需生成学习路径',
                })
            }

            // 非流式模式
            if (!body.stream) {
                try {
                    const output = await learningPathGenerator.generate(input)
                    broadcastDiagnosisEvent(broadcaster, 'diagnosis:learning-path-generated', {
                        studentId,
                        stepCount: output.path.length,
                        totalEstimatedMinutes: output.totalEstimatedMinutes,
                    })
                    return reply.send({ status: 'ok', output })
                } catch (err) {
                    req.log.error({ err, studentId }, 'AI 学习路径生成失败')
                    return reply.status(500).send({
                        status: 'error',
                        message: 'AI 学习路径生成失败，请稍后重试',
                    })
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
                for await (const chunk of learningPathGenerator.generateStream(input, abortController.signal)) {
                    if (abortController.signal.aborted) break
                    if (!await writeSSE({ delta: chunk })) {
                        abortController.abort()
                        break
                    }
                }
                const completedForClient = !abortController.signal.aborted && await writeSSE('[DONE]')
                if (completedForClient) {
                    broadcastDiagnosisEvent(broadcaster, 'diagnosis:learning-path-generated', {
                        studentId,
                        stream: true,
                    })
                    req.log.info({ path: req.url }, 'SSE 学习路径流式生成完成')
                } else if (!abortController.signal.aborted) {
                    abortController.abort()
                }
            } catch (err) {
                if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
                    req.log.debug({ path: req.url }, '学习路径生成流被客户端中止')
                } else {
                    req.log.error({ err, path: req.url }, 'SSE 学习路径流式生成失败')
                    await writeSSE(createPublicSseError('LEARNING_PATH_GENERATE_FAILED', err))
                }
            } finally {
                removeDisconnectHandlers()
                if (!raw.writableEnded) {
                    raw.end()
                }
            }
        },
    )

    // ── 13. GET /students/:studentId/prescription — 获取个性化处方（非流式） ──
    // 基于学生诊断全量数据生成个性化处方，非流式一次性返回
    app.get(
        '/students/:studentId/prescription',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(studentIdParamsSchema, req, reply)
            if (!params) return
            const { studentId } = params

            const student = repos.students.findById(studentId)
            if (!student) {
                return reply.status(404).send({
                    status: 'error',
                    message: `学生 ${studentId} 不存在`,
                })
            }

            try {
                const input = await buildPrescriptionInputAsync(studentId, student.anonymousName, student.grade)
                // GET 必须可作为页面首屏读取接口：仅基于真实诊断数据即时生成，
                // 不在页面加载时隐式触发耗时且高成本的 LLM。AI 深度生成由 POST 显式触发。
                const output = prescriptionGenerator.fallback(input)

                broadcastDiagnosisEvent(broadcaster, 'diagnosis:prescribed', {
                    studentId,
                    strengthsCount: output.strengths.length,
                    weaknessesCount: output.weaknesses.length,
                    smartGoalsCount: output.smartGoals.length,
                })

                return reply.send({ status: 'ok', output })
            } catch (err) {
                req.log.error({ err, studentId }, '个性化处方生成失败')
                // 降级：返回 fallback 处方
                try {
                    const input = await buildPrescriptionInputAsync(studentId, student.anonymousName, student.grade)
                    const fallbackOutput = prescriptionGenerator.fallback(input, err)
                    return reply.send({ status: 'degraded', output: fallbackOutput })
                } catch {
                    return reply.status(500).send({
                        status: 'error',
                        message: '个性化处方生成失败，请稍后重试',
                    })
                }
            }
        },
    )

    // ── 14. POST /students/:studentId/prescription — 生成个性化处方（支持 SSE） ──
    app.post(
        '/students/:studentId/prescription',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(studentIdParamsSchema, req, reply)
            if (!params) return
            const body = validateBody(generatePrescriptionSchema, req, reply)
            if (!body) return
            const { studentId } = params

            const student = repos.students.findById(studentId)
            if (!student) {
                return reply.status(404).send({
                    status: 'error',
                    message: `学生 ${studentId} 不存在`,
                })
            }

            const input = await buildPrescriptionInputAsync(
                studentId,
                student.anonymousName,
                student.grade,
                body,
            )

            // 非流式模式
            if (!body.stream) {
                try {
                    const output = await prescriptionGenerator.generate(input)
                    broadcastDiagnosisEvent(broadcaster, 'diagnosis:prescribed', {
                        studentId,
                        strengthsCount: output.strengths.length,
                        weaknessesCount: output.weaknesses.length,
                        smartGoalsCount: output.smartGoals.length,
                    })
                    return reply.send({ status: 'ok', output })
                } catch (err) {
                    req.log.error({ err, studentId }, '个性化处方生成失败')
                    const fallbackOutput = prescriptionGenerator.fallback(input, err)
                    return reply.send({ status: 'degraded', output: fallbackOutput })
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
                for await (const chunk of prescriptionGenerator.generateStream(input, abortController.signal)) {
                    if (abortController.signal.aborted) break
                    if (!await writeSSE({ delta: chunk })) {
                        abortController.abort()
                        break
                    }
                }
                const completedForClient = !abortController.signal.aborted && await writeSSE('[DONE]')
                if (completedForClient) {
                    broadcastDiagnosisEvent(broadcaster, 'diagnosis:prescribed', {
                        studentId,
                        stream: true,
                    })
                    req.log.info({ path: req.url }, 'SSE 处方流式生成完成')
                } else if (!abortController.signal.aborted) {
                    abortController.abort()
                }
            } catch (err) {
                if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
                    req.log.debug({ path: req.url }, '处方生成流被客户端中止')
                } else {
                    req.log.error({ err, path: req.url }, 'SSE 处方流式生成失败')
                    await writeSSE(createPublicSseError('PRESCRIPTION_GENERATE_FAILED', err))
                }
            } finally {
                removeDisconnectHandlers()
                if (!raw.writableEnded) {
                    raw.end()
                }
            }
        },
    )

    // ── SubTask 14.6: GET /students/:studentId/radar — 学生综合能力雷达 ──
    // 聚合六阶能力 + 参与度 + 准确率 + 创作活跃度 + 知识广度 → 5 维综合雷达
    app.get(
        '/students/:studentId/radar',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(studentIdParamsSchema, req, reply)
            if (!params) return
            const { studentId } = params

            try {
                const student = repos.students.findById(studentId)
                if (!student) {
                    return reply.status(404).send({
                        status: 'error',
                        message: `学生 ${studentId} 不存在`,
                    })
                }

                const radar = computeStudentRadar(studentId, student.anonymousName)
                return reply.send({ status: 'ok', ...radar })
            } catch (err) {
                req.log.error({ err, studentId }, '学生综合雷达计算失败')
                const emptyRadar = Object.fromEntries(
                    BLOOM_LEVELS.map((lv) => [lv, 0]),
                ) as Record<BloomLevel, number>
                return reply.send({
                    status: 'degraded',
                    studentId,
                    anonymousName: '未知学生',
                    bloomRadar: emptyRadar,
                    dimensions: [],
                    overallScore: 0,
                    sampleSize: 0,
                    computedAt: Date.now(),
                    aiGenerated: false as const,
                })
            }
        },
    )

    // ── SubTask 14.6: GET /classes/:classId/radar — 班级综合能力雷达 ──
    // 聚合班级六阶能力 + 班级参与度 + 准确率 + 创作活跃度 + 知识广度
    app.get(
        '/classes/:classId/radar',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(classIdParamsSchema, req, reply)
            if (!params) return
            const { classId } = params

            try {
                const classEntity = repos.classes.findById(classId)
                if (!classEntity) {
                    return reply.status(404).send({
                        status: 'error',
                        message: `班级 ${classId} 不存在`,
                    })
                }

                const radar = computeClassRadar(classId, classEntity.name)
                return reply.send({ status: 'ok', ...radar })
            } catch (err) {
                req.log.error({ err, classId }, '班级综合雷达计算失败')
                const emptyRadar = Object.fromEntries(
                    BLOOM_LEVELS.map((lv) => [lv, 0]),
                ) as Record<BloomLevel, number>
                return reply.send({
                    status: 'degraded',
                    classId,
                    className: '未知班级',
                    bloomRadar: emptyRadar,
                    dimensions: [],
                    overallScore: 0,
                    studentCount: 0,
                    sampleSize: 0,
                    computedAt: Date.now(),
                    aiGenerated: false as const,
                })
            }
        },
    )
}

// ─────────────────────────────────────────────────────────────
// 业务计算函数
// ─────────────────────────────────────────────────────────────

/**
 * 计算班级六阶能力分布（均值 + 标准差 + 学生数）
 *
 * SQL 聚合：AVG(score) + AVG(score^2) → JS 计算 stdDev = sqrt(E[X^2] - E[X]^2)
 */
function computeBloomDistribution(classId: string): BloomDistributionLevel[] {
    const result: BloomDistributionLevel[] = []
    try {
        const rows = db
            .prepare(
                `SELECT m.bloom_level AS bloom_level,
                        AVG(m.score) AS avg_score,
                        AVG(m.score * m.score) AS avg_square,
                        COUNT(DISTINCT m.student_id) AS student_count
                 FROM mastery m
                 JOIN students s ON m.student_id = s.id
                 WHERE s.class_id = ?
                 GROUP BY m.bloom_level`,
            )
            .all(classId) as Array<{
                bloom_level: string
                avg_score: number | null
                avg_square: number | null
                student_count: number
            }>

        const levelMap = new Map<string, { avg: number; stdDev: number; studentCount: number }>()
        for (const row of rows) {
            const avg = row.avg_score ?? 0
            const avgSquare = row.avg_square ?? 0
            const variance = Math.max(0, avgSquare - avg * avg)
            const stdDev = Math.sqrt(variance)
            levelMap.set(row.bloom_level, {
                avg: Math.round(avg * 100) / 100,
                stdDev: Math.round(stdDev * 100) / 100,
                studentCount: row.student_count,
            })
        }

        for (const level of BLOOM_LEVELS) {
            const data = levelMap.get(level)
            result.push({
                level,
                avg: data?.avg ?? 0,
                stdDev: data?.stdDev ?? 0,
                studentCount: data?.studentCount ?? 0,
            })
        }
    } catch (err) {
        // 静默降级（不打印 err.message 到 stdout）
        for (const level of BLOOM_LEVELS) {
            result.push({ level, avg: 0, stdDev: 0, studentCount: 0 })
        }
    }
    return result
}

/**
 * 计算班级热力图数据（学生 × 诗 × 六阶）
 *
 * 为控制数据量，仅返回有掌握度记录的诗与学生。
 */
function computeHeatmap(classId: string): {
    students: HeatmapStudent[]
    poems: HeatmapPoem[]
    cells: HeatmapCell[]
} {
    try {
        // 1. 查询班级学生（脱敏名）
        const students = repos.students
            .findByClassId(classId)
            .map((s) => ({ id: s.id, anonymousName: s.anonymousName }))

        if (students.length === 0) {
            return { students: [], poems: [], cells: [] }
        }

        const studentIds = students.map((s) => s.id)

        // 2. 查询这些学生的所有 mastery 记录（含诗信息）
        const placeholders = studentIds.map(() => '?').join(',')
        const rows = db
            .prepare(
                `SELECT m.student_id AS student_id,
                        m.poem_id AS poem_id,
                        m.bloom_level AS bloom_level,
                        m.score AS score,
                        p.title AS poem_title,
                        p.poet AS poet
                 FROM mastery m
                 JOIN poems p ON m.poem_id = p.id
                 WHERE m.student_id IN (${placeholders})
                 ORDER BY p.title, m.bloom_level`,
            )
            .all(...studentIds) as Array<{
                student_id: string
                poem_id: string
                bloom_level: string
                score: number
                poem_title: string
                poet: string
            }>

        if (rows.length === 0) {
            return { students, poems: [], cells: [] }
        }

        // 3. 提取去重的诗列表（保持顺序）
        const poemMap = new Map<string, HeatmapPoem>()
        for (const row of rows) {
            if (!poemMap.has(row.poem_id)) {
                poemMap.set(row.poem_id, {
                    id: row.poem_id,
                    title: row.poem_title,
                    poet: row.poet,
                })
            }
        }
        const poems = Array.from(poemMap.values())

        // 4. 构建单元格
        const cells: HeatmapCell[] = rows.map((row) => ({
            studentId: row.student_id,
            poemId: row.poem_id,
            bloomLevel: row.bloom_level as BloomLevel,
            score: Math.round(row.score * 100) / 100,
        }))

        return { students, poems, cells }
    } catch (err) {
        // 静默降级（不打印 err.message 到 stdout）
        return { students: [], poems: [], cells: [] }
    }
}

/**
 * 计算学生个体认知画像
 *
 * 组合：六阶雷达 + 知识漏洞 + 推荐学习路径
 */
async function computeStudentProfile(studentId: string): Promise<Omit<StudentProfileResponse, 'aiGenerated'>> {
    const student = repos.students.findById(studentId)
    const anonymousName = student?.anonymousName ?? '未知学生'

    // 六阶雷达
    const bloomRadar = services.mastery.getStudentBloomRadar(studentId)

    // 知识漏洞（调用 DarkMatterDetector）
    const detector = getDetector()
    let gaps: StudentGap[] = []
    try {
        gaps = await withTimeout(detector.detectStudentGaps(studentId), DARK_MATTER_TIMEOUT_MS, [])
    } catch {
        gaps = []
    }

    // 推荐学习路径
    const learningPath = await computeLearningPath(studentId)

    return {
        studentId,
        anonymousName,
        bloomRadar,
        gaps,
        learningPath,
    }
}

/**
 * 计算推荐学习路径
 *
 * 算法：
 * 1. 查询学生薄弱诗（score < 60）
 * 2. 对每个薄弱诗，调用 kgService.findRelatedPoems 获取关联诗
 * 3. 合并去重，按 difficulty 升序 + currentMastery 升序排序
 * 4. 取前 MAX_PATH_NODES 首
 */
async function computeLearningPath(studentId: string): Promise<LearningPathNode[]> {
    try {
        // 1. 查询学生薄弱诗
        const weakRows = db
            .prepare(
                `SELECT poem_id, bloom_level, score
                 FROM mastery
                 WHERE student_id = ? AND score < ?
                 ORDER BY score ASC`,
            )
            .all(studentId, WEAK_THRESHOLD) as Array<{
                poem_id: string
                bloom_level: string
                score: number
            }>

        if (weakRows.length === 0) {
            return []
        }

        // 2. 按诗分组薄弱阶层
        const weakPoemMap = new Map<string, Set<string>>()
        for (const row of weakRows) {
            const set = weakPoemMap.get(row.poem_id) ?? new Set<string>()
            set.add(row.bloom_level)
            weakPoemMap.set(row.poem_id, set)
        }

        // 3. 查询学生所有诗的掌握度（用于计算 currentMastery）
        const masteryRows = db
            .prepare(
                `SELECT poem_id, AVG(score) as avg_score
                 FROM mastery
                 WHERE student_id = ?
                 GROUP BY poem_id`,
            )
            .all(studentId) as Array<{ poem_id: string; avg_score: number }>
        const masteryMap = new Map<string, number>()
        for (const row of masteryRows) {
            masteryMap.set(row.poem_id, Math.round(row.avg_score * 100) / 100)
        }

        // 4. 对每个薄弱诗，查找关联诗
        const kgService = getKgService()
        const candidateMap = new Map<string, LearningPathNode>()

        for (const [weakPoemId, weakLevels] of weakPoemMap.entries()) {
            const weakPoem = repos.poems.findById(weakPoemId)
            if (!weakPoem) continue

            // 薄弱诗本身作为起点
            if (!candidateMap.has(weakPoemId)) {
                candidateMap.set(weakPoemId, {
                    poemId: weakPoemId,
                    title: weakPoem.title,
                    poet: weakPoem.poet,
                    dynasty: weakPoem.dynasty,
                    difficulty: weakPoem.difficulty,
                    currentMastery: masteryMap.get(weakPoemId) ?? 0,
                    reason: `薄弱阶层：${Array.from(weakLevels).join('、')}`,
                })
            }

            // 查找关联诗
            const relatedPoems = await withTimeout(
                kgService.findRelatedPoems(weakPoemId, 5),
                1500,
                [],
            )

            for (const related of relatedPoems) {
                const relatedId = related.poem.id
                if (candidateMap.has(relatedId)) continue
                const currentMastery = masteryMap.get(relatedId) ?? 0
                candidateMap.set(relatedId, {
                    poemId: relatedId,
                    title: related.poem.title,
                    poet: related.poem.poet,
                    dynasty: related.poem.dynasty,
                    difficulty: related.poem.difficulty ?? 3,
                    currentMastery,
                    reason: `与《${weakPoem.title}》${relationTypeLabel(related.relationType)}（强度 ${related.strength.toFixed(2)}）`,
                    relationType: related.relationType,
                    strength: related.strength,
                })
            }
        }

        // 5. 排序：优先推荐"关联薄弱诗 + 难度低 + 当前掌握度低"的诗
        const candidates = Array.from(candidateMap.values())
        candidates.sort((a, b) => {
            // 有 relationType 的优先（说明是针对性推荐）
            const aRel = a.relationType ? 0 : 1
            const bRel = b.relationType ? 0 : 1
            if (aRel !== bRel) return aRel - bRel
            // 难度低的优先
            const diffDiff = a.difficulty - b.difficulty
            if (Math.abs(diffDiff) > 0.1) return diffDiff
            // 当前掌握度低的优先
            return a.currentMastery - b.currentMastery
        })

        return candidates.slice(0, MAX_PATH_NODES)
    } catch (err) {
        // 静默降级（不打印 err.message 到 stdout）
        return []
    }
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

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

/** 关联类型中文标签 */
function relationTypeLabel(type: string): string {
    switch (type) {
        case 'SHARES_IMAGE':
            return '同意象'
        case 'SIMILAR_THEME':
            return '同主题'
        case 'BORROWS_RHETORIC':
            return '同修辞'
        default:
            return '关联'
    }
}

// ─────────────────────────────────────────────────────────────
// 教学调整建议生成（Phase 4.2）
// ─────────────────────────────────────────────────────────────

/**
 * 生成班级教学调整建议
 *
 * 数据源：
 * 1. computeBloomDistribution —— 班级六阶掌握度分布
 * 2. DarkMatterDetector —— 班级认知暗物质列表
 * 3. error_notebook_items 表 —— 错题本今日待复习数
 *
 * 建议生成规则（规则引擎，非 AI 生成）：
 * - weakest bloom avg < WEAK_THRESHOLD → weakness 建议（高优先级）
 * - classMasteryAvg < 50 → method 建议教学方法调整（高优先级）
 * - darkMatterCount > 3 → material 建议补充素材（中优先级）
 * - 存在掌握度极低学生（<30） → differentiate 分层教学（高优先级）
 * - 总是生成一条 progress 进度跟进建议（低优先级）
 */
async function generateTeachingSuggestions(classId: string): Promise<TeachingSuggestionResponse> {
    const now = Date.now()
    const suggestions: TeachingSuggestion[] = []

    // 1. 班级六阶分布
    const bloomDist = computeBloomDistribution(classId)
    const classMasteryAvg = bloomDist.length > 0
        ? Math.round(bloomDist.reduce((sum, l) => sum + l.avg, 0) / bloomDist.length * 100) / 100
        : 0

    // 找到最薄弱的 Bloom 层级
    let weakestLevel: BloomLevel = '记忆'
    let weakestAvg = 100
    for (const item of bloomDist) {
        if (item.avg < weakestAvg && item.studentCount > 0) {
            weakestAvg = item.avg
            weakestLevel = item.level
        }
    }
    if (bloomDist.length === 0 || bloomDist.every((l) => l.studentCount === 0)) {
        weakestAvg = 0
    }

    // 2. 暗物质检测（带超时降级）
    let darkMatterCount = 0
    try {
        const detector = getDetector()
        const darkMatterList = await withTimeout(
            detector.detectClassDarkMatter(classId),
            DARK_MATTER_TIMEOUT_MS,
            [],
        )
        darkMatterCount = darkMatterList.length
    } catch {
        darkMatterCount = 0
    }

    // 3. 错题本今日待复习数（SQL 查询 error_notebook_items 表）
    let dueTodayCount = 0
    try {
        const allItems = db
            .prepare('SELECT value FROM error_notebook_items')
            .all() as Array<{ value: string }>
        const nowMs = now
        dueTodayCount = allItems.filter((item) => {
            try {
                const parsed = JSON.parse(item.value) as { spacedRepetition?: { dueAt?: number; mastered?: boolean } }
                const sr = parsed.spacedRepetition
                return sr !== undefined && sr.dueAt !== undefined && sr.dueAt <= nowMs && sr.mastered !== true
            } catch {
                return false
            }
        }).length
    } catch {
        dueTodayCount = 0
    }

    // 4. 查询掌握度极低学生（< 30）
    let lowMasteryStudentIds: string[] = []
    try {
        const rows = db
            .prepare(
                `SELECT s.id AS student_id, AVG(m.score) AS avg_score
                 FROM students s
                 LEFT JOIN mastery m ON s.id = m.student_id
                 WHERE s.class_id = ?
                 GROUP BY s.id
                 HAVING avg_score < 30 OR avg_score IS NULL`,
            )
            .all(classId) as Array<{ student_id: string; avg_score: number | null }>
        lowMasteryStudentIds = rows.map((r) => r.student_id)
    } catch {
        lowMasteryStudentIds = []
    }

    // ── 生成建议 ──

    // 建议 1：薄弱点强化
    if (weakestAvg < WEAK_THRESHOLD && weakestAvg > 0) {
        suggestions.push({
            id: generateId(),
            type: 'weakness',
            title: `强化「${weakestLevel}」层能力`,
            description: `班级在「${weakestLevel}」认知层平均掌握度为 ${weakestAvg} 分，低于薄弱阈值 ${WEAK_THRESHOLD} 分，建议针对性强化训练。`,
            priority: 'high',
            bloomLevel: weakestLevel,
            evidence: `六阶分布数据：${weakestLevel} 平均 ${weakestAvg} 分（班级均值 ${classMasteryAvg}）`,
            suggestedAction: `设计 2-3 道针对「${weakestLevel}」层级的专项练习题，利用教案工坊生成针对性教学方案，课堂中增加该层级的提问频次。`,
            generatedAt: now,
            aiGenerated: false,
        })
    }

    // 建议 2：教学方法调整
    if (classMasteryAvg > 0 && classMasteryAvg < 50) {
        suggestions.push({
            id: generateId(),
            type: 'method',
            title: '调整课堂教学方法',
            description: `班级整体掌握度均值仅 ${classMasteryAvg} 分，学生认知负荷偏高。建议调整教学节奏，增加互动环节与可视化辅助。`,
            priority: 'high',
            evidence: `班级六阶平均掌握度 ${classMasteryAvg} 分，低于 50 分警戒线`,
            suggestedAction: '降低单节课信息密度，采用"讲-练-反馈"循环模式；引入课堂讲解工具逐句拆解；增加小组讨论与即时反馈环节。',
            generatedAt: now,
            aiGenerated: false,
        })
    }

    // 建议 3：教学素材补充
    if (darkMatterCount > 3) {
        suggestions.push({
            id: generateId(),
            type: 'material',
            title: '补充认知暗物质相关素材',
            description: `班级检测到 ${darkMatterCount} 个认知暗物质（学生普遍未掌握但未被检测到的知识盲区），建议补充相关教学素材。`,
            priority: 'medium',
            evidence: `暗物质检测：${darkMatterCount} 个认知盲区`,
            suggestedAction: '查看暗物质报告详情，针对每个盲区设计补充讲解材料；可调用文化背景工具生成意象解读与诗人故事素材。',
            generatedAt: now,
            aiGenerated: false,
        })
    }

    // 建议 4：分层教学
    if (lowMasteryStudentIds.length > 0) {
        suggestions.push({
            id: generateId(),
            type: 'differentiate',
            title: '实施分层教学策略',
            description: `班级中有 ${lowMasteryStudentIds.length} 名学生整体掌握度低于 30 分，需要个性化辅导与分层教学。`,
            priority: 'high',
            studentIds: lowMasteryStudentIds,
            affectedStudentCount: lowMasteryStudentIds.length,
            evidence: `掌握度低于 30 分的学生 ${lowMasteryStudentIds.length} 人`,
            suggestedAction: '为这些学生布置基础巩固练习（记忆+理解层），同时为掌握度高的学生设计高阶挑战题（分析+评价+创造层）；利用学习路径推荐功能生成个性化路径。',
            generatedAt: now,
            aiGenerated: false,
        })
    }

    // 建议 5：进度跟进（始终生成）
    const pendingReview = dueTodayCount
    suggestions.push({
        id: generateId(),
        type: 'progress',
        title: pendingReview > 0
            ? `跟进错题本复习（${pendingReview} 题待复习）`
            : '跟进本周学习进度',
        description: pendingReview > 0
            ? `班级错题本中有 ${pendingReview} 道题目今日待复习，建议安排课堂复习环节或布置课后复习任务。`
            : '建议本周完成当前诗篇的教学闭环，并安排阶段性测评以检验学习效果。',
        priority: 'low',
        evidence: pendingReview > 0
            ? `错题本今日待复习 ${pendingReview} 题`
            : '常规进度跟进',
        suggestedAction: pendingReview > 0
            ? '利用错题本的间隔重复功能，安排 10 分钟课堂复习；或布置课后 SM-2 复习任务。'
            : '安排一次阶段性测评，检验本周教学效果，并根据诊断结果调整下周教学计划。',
        generatedAt: now,
        aiGenerated: false,
    })

    return {
        classId,
        suggestions,
        generatedAt: now,
        dataSummary: {
            classMasteryAvg,
            darkMatterCount,
            weakestBloomLevel: weakestLevel,
            dueTodayCount,
        },
        aiGenerated: false,
    }
}

// ─────────────────────────────────────────────────────────────
// 批改诊断深化：辅助函数（学习路径输入构建 + 处方输入构建 + 事件广播）
// ─────────────────────────────────────────────────────────────

/**
 * 构建 AI 学习路径生成输入
 *
 * 数据源：
 * - services.mastery.getStudentBloomRadar —— 六阶掌握度雷达
 * - mastery 表 —— 薄弱诗篇（score < WEAK_THRESHOLD）
 * - poems 表 —— 诗的元数据（title/poet/dynasty/difficulty）
 * - 请求体 —— 错题归因摘要 + 教师意图
 *
 * @param studentId 学生 ID
 * @param anonymousName 学生脱敏名
 * @param body 请求体（含可选 errorAttributions / teacherIntent）
 * @returns LearningPathInput
 */
function buildLearningPathInput(
    studentId: string,
    anonymousName: string,
    body: { teacherIntent?: string; errorAttributions?: Array<{ questionId: string; primaryErrorType: string; rootCause: string }> },
): LearningPathInput {
    // 六阶雷达（BloomMastery → Record<string, number>，兼容 AI 服务输入类型）
    const bloomRadar = services.mastery.getStudentBloomRadar(studentId) as unknown as Record<string, number>

    // 薄弱诗篇：查询 score < WEAK_THRESHOLD 的记录，按诗分组
    const weakPoems: LearningPathInput['weakPoems'] = []
    try {
        const weakRows = db
            .prepare(
                `SELECT poem_id, bloom_level, score
                 FROM mastery
                 WHERE student_id = ? AND score < ?
                 ORDER BY score ASC`,
            )
            .all(studentId, WEAK_THRESHOLD) as Array<{
                poem_id: string
                bloom_level: string
                score: number
            }>

        // 按诗分组薄弱阶层
        const weakPoemMap = new Map<string, Set<string>>()
        for (const row of weakRows) {
            const set = weakPoemMap.get(row.poem_id) ?? new Set<string>()
            set.add(row.bloom_level)
            weakPoemMap.set(row.poem_id, set)
        }

        // 查询每首薄弱诗的元数据 + 当前掌握度（六阶均值）
        const masteryRows = db
            .prepare(
                `SELECT poem_id, AVG(score) as avg_score
                 FROM mastery
                 WHERE student_id = ?
                 GROUP BY poem_id`,
            )
            .all(studentId) as Array<{ poem_id: string; avg_score: number }>
        const masteryMap = new Map<string, number>()
        for (const row of masteryRows) {
            masteryMap.set(row.poem_id, Math.round(row.avg_score * 100) / 100)
        }

        for (const [poemId, weakLevels] of weakPoemMap.entries()) {
            const poem = repos.poems.findById(poemId)
            if (!poem) continue
            weakPoems.push({
                poemId,
                title: poem.title,
                poet: poem.poet,
                dynasty: poem.dynasty,
                difficulty: poem.difficulty,
                weakBloomLevels: Array.from(weakLevels),
                currentMastery: masteryMap.get(poemId) ?? 0,
            })
        }
    } catch {
        // 查询失败返回空薄弱诗列表
    }

    return {
        studentId,
        anonymousName,
        bloomRadar,
        weakPoems,
        errorAttributions: body.errorAttributions,
        teacherIntent: body.teacherIntent,
    }
}

/**
 * 构建个性化处方生成输入（异步，因需调用 detector.detectStudentGaps）
 *
 * 数据源：
 * - services.mastery.getStudentBloomRadar —— 六阶掌握度雷达
 * - DarkMatterDetector.detectStudentGaps —— 知识漏洞
 * - poems 表 —— 漏洞关联诗的元数据
 * - computeLearningPath —— 学习路径节点（可选）
 * - 请求体 —— 错题归因摘要 + 学习路径 + 教师意图
 *
 * @param studentId 学生 ID
 * @param anonymousName 学生脱敏名
 * @param grade 学生年级
 * @param body 请求体（可选，含 errorAttributions / learningPath / teacherIntent）
 * @returns PrescriptionInput
 */
async function buildPrescriptionInputAsync(
    studentId: string,
    anonymousName: string,
    grade: string,
    body?: {
        teacherIntent?: string
        errorAttributions?: Array<{
            questionId: string
            primaryErrorType: string
            primaryErrorLabel: string
            severity: number
            rootCause: string
        }>
        learningPath?: Array<{
            poemId: string
            title: string
            poet: string
            currentMastery: number
            reason: string
        }>
    },
): Promise<PrescriptionInput> {
    // 六阶雷达（BloomMastery 与 Record<string, number> 索引签名不兼容，通过双重断言转换）
    const bloomRadar = services.mastery.getStudentBloomRadar(studentId) as unknown as Record<string, number>

    // 知识漏洞（调用 DarkMatterDetector，带超时降级）
    const detector = getDetector()
    let rawGaps: StudentGap[] = []
    try {
        rawGaps = await withTimeout(detector.detectStudentGaps(studentId), DARK_MATTER_TIMEOUT_MS, [])
    } catch {
        rawGaps = []
    }

    // 映射 StudentGap → PrescriptionInput.gaps（补充 poemTitle / severity / description）
    const gaps: PrescriptionInput['gaps'] = []
    for (const gap of rawGaps) {
        const poem = repos.poems.findById(gap.poemId)
        // severity 基于该诗该阶层的掌握度缺口（若查不到则用默认值 60）
        let severity = 60
        try {
            const row = db
                .prepare('SELECT score FROM mastery WHERE student_id = ? AND poem_id = ? AND bloom_level = ?')
                .get(studentId, gap.poemId, gap.bloomLevel) as { score: number } | undefined
            if (row) {
                severity = Math.max(0, Math.min(100, Math.round(100 - row.score)))
            }
        } catch {
            // 查询失败用默认 severity
        }
        gaps.push({
            poemId: gap.poemId,
            poemTitle: poem?.title ?? '未知诗篇',
            bloomLevel: gap.bloomLevel,
            severity,
            description: gap.relatedWeaknesses.length > 0
                ? `关联薄弱点：${gap.relatedWeaknesses.join('、')}`
                : `${gap.bloomLevel}层掌握度不足`,
        })
    }

    // 学习路径：优先使用请求体提供的，否则调用 computeLearningPath
    let learningPath: PrescriptionInput['learningPath'] | undefined
    if (body?.learningPath && body.learningPath.length > 0) {
        learningPath = body.learningPath
    } else {
        try {
            const pathNodes = await computeLearningPath(studentId)
            if (pathNodes.length > 0) {
                learningPath = pathNodes.map((node) => ({
                    poemId: node.poemId,
                    title: node.title,
                    poet: node.poet,
                    currentMastery: node.currentMastery,
                    reason: node.reason,
                }))
            }
        } catch {
            // 学习路径查询失败不影响处方生成
        }
    }

    return {
        studentId,
        anonymousName,
        grade,
        bloomRadar,
        gaps,
        errorAttributions: body?.errorAttributions,
        learningPath,
        teacherIntent: body?.teacherIntent,
    }
}

/**
 * 推送诊断业务事件到 WebSocket 广播器
 *
 * 封装 WSEvent 构造与 broadcaster.broadcast 调用，
 * 供学习路径生成 / 个性化处方生成端点复用。
 *
 * 设计要点：
 * - broadcaster 为空时静默跳过（兼容未启用 WS 的部署）
 * - WS 推送失败不影响主响应（catch 吞错）
 * - sessionId 为空字符串（全局事件）
 *
 * @param broadcaster WS 广播器实例（可选）
 * @param eventType 业务事件类型，如 'diagnosis:prescribed' / 'diagnosis:learning-path-generated'
 * @param payload 业务事件载荷
 */
function broadcastDiagnosisEvent(
    broadcaster: WSBroadcaster | undefined,
    eventType: string,
    payload: Record<string, unknown>,
): void {
    if (!broadcaster) return
    try {
        const wsEvent: WSEvent = {
            type: 'business:event',
            timestamp: Date.now(),
            sessionId: '',
            payload: {
                businessEventType: eventType,
                businessEventPayload: payload,
            },
        }
        broadcaster.broadcast(wsEvent)
    } catch {
        // WS 推送失败不影响主响应
    }
}

// ─────────────────────────────────────────────────────────────
// SubTask 14.6：综合能力雷达计算
// ─────────────────────────────────────────────────────────────

/** 学生答题统计聚合（用于参与度与准确率维度） */
interface StudentAnswerStats {
    /** 总答题次数 */
    totalAnswers: number
    /** 正确答题次数（correct=1） */
    correctAnswers: number
    /** 涉及不同诗数（知识广度） */
    uniquePoems: number
}

/**
 * 查询学生答题统计（answers 表聚合）
 * - totalAnswers: COUNT(*) WHERE student_id = ?
 * - correctAnswers: SUM(CASE WHEN correct=1 THEN 1 ELSE 0 END)
 * - uniquePoems: COUNT(DISTINCT q.poem_id)
 */
function queryStudentAnswerStats(studentId: string): StudentAnswerStats {
    try {
        const row = db
            .prepare(`
                SELECT COUNT(*) AS total_answers,
                       SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) AS correct_answers,
                       COUNT(DISTINCT q.poem_id) AS unique_poems
                FROM answers a
                LEFT JOIN questions q ON a.question_id = q.id
                WHERE a.student_id = ?
            `)
            .get(studentId) as {
                total_answers: number | null
                correct_answers: number | null
                unique_poems: number | null
            } | undefined
        return {
            totalAnswers: row?.total_answers ?? 0,
            correctAnswers: row?.correct_answers ?? 0,
            uniquePoems: row?.unique_poems ?? 0,
        }
    } catch {
        return { totalAnswers: 0, correctAnswers: 0, uniquePoems: 0 }
    }
}

/** 学生创作统计（creation_works 表聚合） */
function queryStudentCreationCount(studentId: string): number {
    try {
        const row = db
            .prepare('SELECT COUNT(*) AS cnt FROM creation_works WHERE student_id = ?')
            .get(studentId) as { cnt: number } | undefined
        return row?.cnt ?? 0
    } catch {
        return 0
    }
}

/** 计算 mastery 记录数（样本数） */
function queryMasteryRecordCount(whereClause: string, params: unknown[]): number {
    try {
        const row = db
            .prepare(`SELECT COUNT(*) AS cnt FROM mastery ${whereClause}`)
            .get(...params) as { cnt: number } | undefined
        return row?.cnt ?? 0
    } catch {
        return 0
    }
}

/**
 * 计算参与度得分 0-100
 * - 0 次答题：0 分
 * - 1-10 次：线性 0-50 分
 * - 10-30 次：线性 50-80 分
 * - 30+ 次：80-100 分（饱和）
 */
function participationScore(totalAnswers: number): number {
    if (totalAnswers <= 0) return 0
    if (totalAnswers >= 30) return Math.min(100, 80 + (totalAnswers - 30) * 0.5)
    if (totalAnswers >= 10) return 50 + (totalAnswers - 10) * 1.5
    return (totalAnswers / 10) * 50
}

/**
 * 计算准确率得分 0-100（直接 = correct/total * 100）
 */
function accuracyScore(correct: number, total: number): number {
    if (total <= 0) return 0
    return Math.round((correct / total) * 10000) / 100
}

/**
 * 计算创作活跃度得分 0-100
 * - 0 件：0 分
 * - 1-3 件：30-60 分
 * - 4-10 件：60-85 分
 * - 10+ 件：85-100 分
 */
function creationScore(works: number): number {
    if (works <= 0) return 0
    if (works >= 10) return Math.min(100, 85 + (works - 10) * 1.5)
    if (works >= 4) return 60 + (works - 4) * (85 - 60) / 6
    return 30 + (works - 1) * (60 - 30) / 2
}

/**
 * 计算知识广度得分 0-100
 * 基于"已学诗数 / 诗总数"，但诗总数未知时采用经验阈值：
 * - 0 首：0 分
 * - 1-5 首：30-60 分
 * - 6-15 首：60-80 分
 * - 15+ 首：80-100 分
 */
function breadthScore(uniquePoems: number): number {
    if (uniquePoems <= 0) return 0
    if (uniquePoems >= 15) return Math.min(100, 80 + (uniquePoems - 15) * 1.5)
    if (uniquePoems >= 6) return 60 + (uniquePoems - 6) * (80 - 60) / 9
    return 30 + (uniquePoems - 1) * (60 - 30) / 4
}

/**
 * 计算六阶能力均值 0-100（直接来自 mastery 雷达）
 */
function bloomAvgScore(radar: Record<BloomLevel, number>): number {
    const values = BLOOM_LEVELS.map((lv) => radar[lv] ?? 0)
    const sum = values.reduce((a, b) => a + b, 0)
    return values.length > 0 ? Math.round((sum / values.length) * 100) / 100 : 0
}

/**
 * 综合能力评分 0-100（5 维加权）
 * - bloomAvg 权重 35%（核心能力）
 * - accuracy 权重 25%（学习效果）
 * - participation 权重 15%（学习投入）
 * - creation 权重 15%（创新输出）
 * - breadth 权重 10%（知识覆盖）
 */
function overallRadarScore(dims: RadarDimension[]): number {
    if (dims.length === 0) return 0
    const weights: Record<RadarDimensionKey, number> = {
        bloomAvg: 0.35,
        accuracy: 0.25,
        participation: 0.15,
        creation: 0.15,
        breadth: 0.10,
    }
    let sum = 0
    let totalWeight = 0
    for (const dim of dims) {
        const w = weights[dim.key] ?? 0
        sum += dim.score * w
        totalWeight += w
    }
    return totalWeight > 0 ? Math.round((sum / totalWeight) * 100) / 100 : 0
}

/**
 * 计算学生综合能力雷达（SubTask 14.6）
 *
 * 维度：
 * 1. bloomAvg —— 六阶能力均值（来自 services.mastery.getStudentBloomRadar）
 * 2. participation —— 学习参与度（来自 answers 表答题数）
 * 3. accuracy —— 答题准确率（来自 answers 表 correct/total）
 * 4. creation —— 创作活跃度（来自 creation_works 表）
 * 5. breadth —— 知识广度（来自 answers 表关联不同诗数）
 *
 * @param studentId 学生 ID
 * @param anonymousName 学生脱敏名
 */
function computeStudentRadar(
    studentId: string,
    anonymousName: string,
): Omit<StudentRadarResponse, 'aiGenerated'> {
    // 1. 六阶雷达
    const bloomRadar = services.mastery.getStudentBloomRadar(studentId)
    // 转为 Record<BloomLevel, number>（保持类型一致）
    const bloomRecord: Record<BloomLevel, number> = {
        记忆: bloomRadar['记忆'] ?? 0,
        理解: bloomRadar['理解'] ?? 0,
        应用: bloomRadar['应用'] ?? 0,
        分析: bloomRadar['分析'] ?? 0,
        评价: bloomRadar['评价'] ?? 0,
        创造: bloomRadar['创造'] ?? 0,
    }

    // 2. 答题统计
    const answerStats = queryStudentAnswerStats(studentId)

    // 3. 创作统计
    const creationWorks = queryStudentCreationCount(studentId)

    // 4. mastery 样本数
    const sampleSize = queryMasteryRecordCount('WHERE student_id = ?', [studentId])

    // 5. 构建 5 维雷达
    const dimensions: RadarDimension[] = [
        {
            name: '六阶能力',
            key: 'bloomAvg',
            score: bloomAvgScore(bloomRecord),
            sampleSize,
        },
        {
            name: '答题准确率',
            key: 'accuracy',
            score: accuracyScore(answerStats.correctAnswers, answerStats.totalAnswers),
            sampleSize: answerStats.totalAnswers,
        },
        {
            name: '学习参与度',
            key: 'participation',
            score: Math.round(participationScore(answerStats.totalAnswers) * 100) / 100,
            sampleSize: answerStats.totalAnswers,
        },
        {
            name: '创作活跃度',
            key: 'creation',
            score: Math.round(creationScore(creationWorks) * 100) / 100,
            sampleSize: creationWorks,
        },
        {
            name: '知识广度',
            key: 'breadth',
            score: Math.round(breadthScore(answerStats.uniquePoems) * 100) / 100,
            sampleSize: answerStats.uniquePoems,
        },
    ]

    return {
        studentId,
        anonymousName,
        bloomRadar: bloomRecord,
        dimensions,
        overallScore: overallRadarScore(dimensions),
        sampleSize,
        computedAt: Date.now(),
    }
}

/**
 * 计算班级综合能力雷达（SubTask 14.6）
 *
 * 维度同学生雷达，但聚合为班级整体：
 * - bloomAvg: 班级六阶均值（来自 services.mastery.getClassBloomRadar）
 * - accuracy: 班级整体准确率（聚合所有学生 answers）
 * - participation: 班级整体参与度（聚合所有学生 answers 总数 / 学生数）
 * - creation: 班级整体创作活跃度（聚合所有学生 creation_works）
 * - breadth: 班级整体知识广度（聚合所有学生涉及的 unique poems）
 *
 * @param classId 班级 ID
 * @param className 班级名称
 */
function computeClassRadar(
    classId: string,
    className: string,
): Omit<ClassRadarResponse, 'aiGenerated'> {
    // 1. 六阶雷达
    const bloomRadar = services.mastery.getClassBloomRadar(classId)
    const bloomRecord: Record<BloomLevel, number> = {
        记忆: bloomRadar['记忆'] ?? 0,
        理解: bloomRadar['理解'] ?? 0,
        应用: bloomRadar['应用'] ?? 0,
        分析: bloomRadar['分析'] ?? 0,
        评价: bloomRadar['评价'] ?? 0,
        创造: bloomRadar['创造'] ?? 0,
    }

    // 2. 班级学生数
    const students = repos.students.findByClassId(classId)
    const studentCount = students.length

    // 3. 班级整体答题统计
    let totalAnswers = 0
    let correctAnswers = 0
    let uniquePoemsSet = new Set<string>()
    try {
        const studentIds = students.map((s) => s.id)
        if (studentIds.length > 0) {
            const placeholders = studentIds.map(() => '?').join(',')
            const row = db
                .prepare(`
                    SELECT COUNT(*) AS total_answers,
                           SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) AS correct_answers
                    FROM answers a
                    WHERE a.student_id IN (${placeholders})
                `)
                .get(...studentIds) as {
                    total_answers: number | null
                    correct_answers: number | null
                } | undefined
            totalAnswers = row?.total_answers ?? 0
            correctAnswers = row?.correct_answers ?? 0

            // 查询涉及的不同诗数
            const poemRows = db
                .prepare(`
                    SELECT DISTINCT q.poem_id AS poem_id
                    FROM answers a
                    LEFT JOIN questions q ON a.question_id = q.id
                    WHERE a.student_id IN (${placeholders}) AND q.poem_id IS NOT NULL
                `)
                .all(...studentIds) as Array<{ poem_id: string }>
            uniquePoemsSet = new Set(poemRows.map((r) => r.poem_id))
        }
    } catch {
        // 查询失败保留 0
    }
    const uniquePoems = uniquePoemsSet.size

    // 4. 班级创作总数
    let totalCreations = 0
    try {
        const studentIds = students.map((s) => s.id)
        if (studentIds.length > 0) {
            const placeholders = studentIds.map(() => '?').join(',')
            const row = db
                .prepare(`SELECT COUNT(*) AS cnt FROM creation_works WHERE student_id IN (${placeholders})`)
                .get(...studentIds) as { cnt: number } | undefined
            totalCreations = row?.cnt ?? 0
        }
    } catch {
        // creation_works 表不存在
    }

    // 5. mastery 样本数（班级所有学生的 mastery 记录数）
    const sampleSize = queryMasteryRecordCount(
        'WHERE student_id IN (SELECT id FROM students WHERE class_id = ?)',
        [classId],
    )

    // 6. 班级人均参与度（按学生数平均）
    const avgParticipation = studentCount > 0 ? totalAnswers / studentCount : 0
    // 班级人均创作
    const avgCreation = studentCount > 0 ? totalCreations / studentCount : 0
    // 班级整体知识广度（不同诗数 - 已是去重后的班级聚合值，不需人均化）
    const classBreadth = uniquePoems

    // 7. 构建 5 维雷达
    const dimensions: RadarDimension[] = [
        {
            name: '六阶能力',
            key: 'bloomAvg',
            score: bloomAvgScore(bloomRecord),
            sampleSize,
        },
        {
            name: '答题准确率',
            key: 'accuracy',
            score: accuracyScore(correctAnswers, totalAnswers),
            sampleSize: totalAnswers,
        },
        {
            name: '学习参与度',
            key: 'participation',
            score: Math.round(participationScore(avgParticipation) * 100) / 100,
            sampleSize: totalAnswers,
        },
        {
            name: '创作活跃度',
            key: 'creation',
            score: Math.round(creationScore(avgCreation) * 100) / 100,
            sampleSize: totalCreations,
        },
        {
            name: '知识广度',
            key: 'breadth',
            score: Math.round(breadthScore(classBreadth) * 100) / 100,
            sampleSize: uniquePoems,
        },
    ]

    return {
        classId,
        className,
        bloomRadar: bloomRecord,
        dimensions,
        overallScore: overallRadarScore(dimensions),
        studentCount,
        sampleSize,
        computedAt: Date.now(),
    }
}
