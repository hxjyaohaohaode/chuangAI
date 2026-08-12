/**
 * 智能批改台 REST API 路由（Task 12）
 *
 * 5 个端点：
 * - POST /api/grading/upload          上传答题图片（multipart）
 * - POST /api/grading/recognize       调用诗眼 Agent 识别手写内容
 * - POST /api/grading/grade           调用诗笔 Agent 批改 + 诗心 Agent 认知归因（可选）
 * - POST /api/grading/review          教师审核（确认/修正 AI 批改结果）
 * - GET  /api/grading/batch/:batchId  查询批次状态
 * - GET  /api/grading/files/:fileId   读取已上传的图片文件（前端预览用）
 *
 * 批改流程：
 * 1. 教师上传图片 → /upload（保存到 data/uploads/）
 * 2. 诗眼 Agent（mimo-v2.5）识别手写内容 → /recognize
 *    - 调用 eyeAgent.visionAnnotate 多视角描述
 *    - 提取文本内容（finalAnnotation）
 *    - 自动匹配题目（若上传时提供了 questionId 则直接使用）
 * 3. 诗笔 Agent 批改 → /grade
 *    - 调用 brushAgent.grade 批改（已包含 cognitiveAttribution）
 *    - mindAgent.diagnose 为可选增强，本实现暂不调用（需 masteryData）
 * 4. 教师审核 → /review
 *    - 低置信度（<0.8）标记需人工审核
 *    - 教师修正触发自我进化引擎事件（Task 22 用，通过 agentEvents emit）
 *
 * 设计要点：
 * - 批次状态持久化到 SQLite，重启后可继续查询与审核
 * - 文件以 base64 data URL 形式传给多模态 Agent（mimo-v2.5 支持 data URL）
 * - 前端通过 /files/:fileId 获取图片预览（HTTP 静态读取）
 * - 数据库查询失败时降级返回空数据，不抛 500
 * - 教师审核修正后 emit `grading:review` 事件，供自我进化引擎订阅
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { mkdir, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { eyeAgent, brushAgent } from '../agents/index.js'
import { agentEvents } from '../agents/base/events.js'
import { proactiveIntelligence } from '../agents/base/proactive-intelligence.js'
import { db, repos } from '../db/index.js'
import { generateId } from '../db/utils/id.js'
import { inspectImageUpload, sanitizeUploadFilename } from '../security/image-upload-policy.js'
import { resolveProtectedUploadReference } from '../security/protected-upload-reference.js'
import { isSupportedInlineImageDataUrl } from '../security/image-reference-policy.js'
import type { AgentContext, BloomMastery, Question, StudentProfile } from '../agents/base/types.js'
// 持久化存储：原 Map<string, GradingBatch> → SQLite grading_batches 表
import { SqliteMap } from '../db/runtime-store.js'
import { z } from 'zod'
import { validateBody, validateParams, validateQuery, schemas } from '../lib/validation.js'
// 闭环2补全：批改完成后主动同步错题本 + 推送 WS 事件
import { syncErrorsFromAnswers } from './error-notebook.js'
import type { WSBroadcaster } from '../orchestrator/websocket/broadcaster.js'
import type { WSEvent } from '../orchestrator/types.js'
// 批改诊断深化：5 大能力服务（多维度评分 / 手写识别 / 错题归因）
import { multiDimensionScorer } from '../services/grading/multi-dimension-scorer.js'
import { handwritingOcr } from '../services/grading/handwriting-ocr.js'
import { errorAttribution } from '../services/grading/error-attribution.js'
import type { ScoreDimension } from '../services/grading/multi-dimension-scorer.js'
import {
    resolveOwnedGradingClass,
    validateGradingBatchItems,
    validateGradingUploadScope,
    type GradingBoundaryFailure,
} from '../services/grading/batch-boundary.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 已上传文件元数据 */
interface UploadedFile {
    id: string
    /** 前端可访问的相对 URL */
    url: string
    /** 磁盘绝对路径 */
    filePath: string
    fileName: string
    contentType: string
    size: number
}

/** 单条识别结果 */
interface RecognizedItem {
    fileId: string
    studentId?: string
    /** 自动匹配的题目 ID（未匹配则为 undefined） */
    questionId?: string
    /** 识别出的学生答案文本 */
    studentAnswer: string
    confidence: number
    /** 如未匹配到题目则为 true */
    needsManualMatch: boolean
}

/** 单条批改结果 */
interface GradingResult {
    fileId: string
    studentId?: string
    questionId: string
    correct: boolean
    partialScore?: number
    cognitiveAttribution: string
    feedback: string
    teacherHint: string
    confidence: number
    needsHumanReview: boolean
    aiGenerated: true
    /** 教师审核状态 */
    reviewed?: boolean
    /** 审核动作 */
    reviewAction?: 'confirm' | 'modify' | 'reference'
    /** 教师修正的反馈 */
    teacherFeedback?: string
    /** 教师修正的认知归因 */
    teacherAttribution?: string
}

/** 批次状态 */
type BatchStatus = 'uploading' | 'recognizing' | 'grading' | 'reviewing' | 'completed'

/** 批次 */
interface GradingBatch {
    batchId: string
    classId: string
    lessonId?: string
    questionId?: string
    status: BatchStatus
    files: UploadedFile[]
    recognized: RecognizedItem[]
    results: GradingResult[]
    createdAt: number
    updatedAt: number
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 需人工审核的置信度阈值 */
const REVIEW_CONFIDENCE_THRESHOLD = 0.8

/** 单批次最大文件数 */
const MAX_FILES_PER_BATCH = 30

/** 单文件最大字节数（10MB） */
const MAX_FILE_SIZE = 10 * 1024 * 1024

/** 防止 30×10MB 同时驻留内存造成进程压力；正常答题照片远低于此值。 */
const MAX_TOTAL_UPLOAD_SIZE = 80 * 1024 * 1024

/**
 * 批改上传的路由级 multipart 上限。
 *
 * 合法最大形态为 30 个 `files` 文件 + classId/lessonId/questionId 各一次，
 * 因此 parts 必须精确封顶 33，不能继续依赖插件默认的 1000 parts。
 */
const GRADING_MULTIPART_LIMITS = {
    files: MAX_FILES_PER_BATCH,
    fields: 3,
    parts: MAX_FILES_PER_BATCH + 3,
    fileSize: MAX_FILE_SIZE,
    fieldNameSize: 32,
    fieldSize: 256,
    headerPairs: 64,
} as const

const GRADING_UPLOAD_FIELD_NAMES = new Set(['classId', 'lessonId', 'questionId'])

const MULTIPART_LIMIT_ERROR_CODES = new Set([
    'FST_FILES_LIMIT',
    'FST_FIELDS_LIMIT',
    'FST_PARTS_LIMIT',
    'FST_REQ_FILE_TOO_LARGE',
])

/** 允许的图片 MIME 类型 */
const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** 自我进化引擎事件名（Task 22 用） */
const GRADING_REVIEW_EVENT = 'grading:review'

// ─────────────────────────────────────────────────────────────
// 上传目录解析
// ─────────────────────────────────────────────────────────────

/** 上传文件存储根目录：APP_DATA_DIR/uploads（本地默认 ./data/uploads）。 */
const UPLOAD_DIR = config.runtimePaths.uploadsDir

/** 确保上传目录存在（幂等） */
async function ensureUploadDir(): Promise<void> {
    if (!existsSync(UPLOAD_DIR)) {
        await mkdir(UPLOAD_DIR, { recursive: true })
    }
}

// ─────────────────────────────────────────────────────────────
// 持久化批次存储（SQLite 替代内存 Map，重启后批改进度完整恢复）
// ─────────────────────────────────────────────────────────────

/** 全局批次存储：原 Map<string, GradingBatch> → SqliteMap（grading_batches 表）
 *  LRU 上限 200 批次（原 trimBatches FIFO 行为由 SqliteMap.evictIfNeeded 接管） */
const MAX_BATCHES = 200
const batchStore = new SqliteMap<string, GradingBatch>({
    table: 'grading_batches',
    indexes: [
        { name: 'class_id', extract: (v) => v.classId },
        { name: 'lesson_id', extract: (v) => v.lessonId ?? null },
    ],
})

const gradingBoundaryRepositories = {
    findClassById: (id: string) => repos.classes.findById(id) ?? null,
    findLessonById: (id: string) => repos.lessons.findById(id) ?? null,
    findStudentById: (id: string) => repos.students.findById(id) ?? null,
    findQuestionById: (id: string) => repos.questions.findById(id) ?? null,
}

function sendGradingBoundaryFailure(reply: FastifyReply, failure: GradingBoundaryFailure) {
    return reply.status(failure.statusCode).send({
        status: 'error',
        error: failure.code,
        message: failure.message,
    })
}

function isMultipartLimitError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) return false
    return MULTIPART_LIMIT_ERROR_CODES.has(String(error.code))
}

function sendGradingUploadLimit(reply: FastifyReply) {
    return reply.status(413).send({
        status: 'error',
        error: 'UPLOAD_LIMIT_EXCEEDED',
        message: `批改上传超出限制（最多 ${MAX_FILES_PER_BATCH} 个文件、3 个字段；单文件 10MiB、总计 80MiB）`,
    })
}

function sendInvalidGradingMultipart(reply: FastifyReply, message = '批改上传表单格式无效') {
    return reply.status(400).send({
        status: 'error',
        error: 'INVALID_MULTIPART_FORM',
        message,
    })
}

function requireOwnedGradingBatch(
    batch: GradingBatch,
    req: FastifyRequest,
    reply: FastifyReply,
): boolean {
    const result = resolveOwnedGradingClass(batch.classId, req.auth?.id, gradingBoundaryRepositories)
    if (result.ok) return true
    sendGradingBoundaryFailure(reply, result)
    return false
}

function isPathInsideUploadDirectory(candidate: string): boolean {
    const relative = path.relative(UPLOAD_DIR, path.resolve(candidate))
    return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function resolveExistingPathInsideUploadDirectory(candidate: string): Promise<string | null> {
    try {
        const [realRoot, realCandidate] = await Promise.all([
            realpath(UPLOAD_DIR),
            realpath(candidate),
        ])
        const relative = path.relative(realRoot, realCandidate)
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            return null
        }
        return realCandidate
    } catch {
        return null
    }
}

async function resolveExistingProtectedUploadFile(filePath: string, contentType: string): Promise<string | null> {
    const lexicalPath = resolveProtectedUploadReference(UPLOAD_DIR, filePath, contentType)
    if (!lexicalPath) return null
    return resolveExistingPathInsideUploadDirectory(lexicalPath)
}

/**
 * 删除一批图片。任何失败都会保留批次元数据，便于再次清理，而不是制造无法追踪的孤儿文件。
 */
async function removeBatchFiles(batch: GradingBatch): Promise<string[]> {
    const failures: string[] = []
    for (const file of batch.files) {
        if (!isPathInsideUploadDirectory(file.filePath)) {
            failures.push(file.id)
            continue
        }
        try {
            if (existsSync(file.filePath)) {
                const protectedFilePath = await resolveExistingProtectedUploadFile(file.filePath, file.contentType)
                if (!protectedFilePath) {
                    failures.push(file.id)
                    continue
                }
                await unlink(protectedFilePath)
            }
        } catch {
            failures.push(file.id)
        }
    }

    const batchDirectory = path.join(UPLOAD_DIR, batch.batchId)
    if (failures.length === 0 && isPathInsideUploadDirectory(batchDirectory) && existsSync(batchDirectory)) {
        try {
            const protectedBatchDirectory = await resolveExistingPathInsideUploadDirectory(batchDirectory)
            if (!protectedBatchDirectory) throw new Error('批次目录超出受控上传根目录')
            await rmdir(protectedBatchDirectory)
        } catch {
            failures.push(batch.batchId)
        }
    }
    return failures
}

/** 手动淘汰使“磁盘文件 + SQLite 元数据”作为一个可恢复单元共同治理。 */
async function trimGradingBatches(): Promise<number> {
    if (batchStore.size <= MAX_BATCHES) return 0
    const candidates = Array.from(batchStore.values())
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, batchStore.size - MAX_BATCHES)
    let failedCount = 0
    for (const batch of candidates) {
        const failures = await removeBatchFiles(batch)
        if (failures.length === 0) batchStore.delete(batch.batchId)
        else failedCount += 1
    }
    return failedCount
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

/**
 * 将文件转为 base64 data URL，供多模态 Agent 调用
 */
async function fileToDataUrl(filePath: string, contentType: string): Promise<string> {
    const protectedFilePath = await resolveExistingProtectedUploadFile(filePath, contentType)
    if (!protectedFilePath) throw new Error('批改图片引用无效或已逃出受控目录')
    const buffer = await readFile(protectedFilePath)
    const base64 = buffer.toString('base64')
    return `data:${contentType};base64,${base64}`
}

/**
 * 构建 AgentContext（最小集合）
 */
function buildAgentContext(taskId: string, classId?: string): AgentContext {
    return {
        taskId,
        sessionId: `grading-${taskId}`,
        classContext: classId
            ? {
                id: classId,
                name: '',
                grade: '',
                studentCount: 0,
            }
            : undefined,
    }
}

/**
 * 从 questions 表查询题目实体并转为 Agent 层 Question 类型
 * 查询失败时返回 null
 */
function lookupQuestion(questionId: string): Question | null {
    try {
        const entity = repos.questions.findById(questionId)
        if (!entity) return null
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
            difficulty: Math.max(1, Math.min(5, Math.round(entity.difficulty))) as 1 | 2 | 3 | 4 | 5,
            estimatedTimeSec: entity.estimatedTimeSec,
            // 评审批改题目均来自 AI 出题流程，统一标记 aiGenerated: true
            aiGenerated: true as const,
        }
    } catch {
        return null
    }
}

/**
 * 查询班级所有题目候选（用于自动匹配）
 * 返回最多 100 条题目摘要
 */
interface QuestionCandidate {
    id: string
    stem: string
    poemId: string
    bloomLevel: string
}
function listQuestionCandidates(classId: string): QuestionCandidate[] {
    try {
        // 通过班级 → 课程 → 题目 链路查询；失败则降级返回空
        const rows = db
            .prepare(`
                SELECT q.id, q.stem, q.poem_id, q.bloom_level
                FROM questions q
                JOIN lessons l ON q.poem_id = l.poem_id
                WHERE l.class_id = ?
                GROUP BY q.id
                LIMIT 100
            `)
            .all(classId) as QuestionCandidate[]
        return rows
    } catch {
        return []
    }
}

/**
 * 启发式匹配题目：基于识别文本与题目 stem 的关键词重叠
 * 简化实现：若识别文本包含 stem 中的关键名词，则视为匹配
 */
function matchQuestion(recognizedText: string, candidates: QuestionCandidate[]): string | undefined {
    if (candidates.length === 0) return undefined
    const text = recognizedText.toLowerCase()
    let bestId: string | undefined
    let bestScore = 0
    for (const c of candidates) {
        const stem = c.stem.toLowerCase()
        // 提取 stem 中长度 >= 2 的中文/字母词片段
        const tokens = stem.match(/[\u4e00-\u9fa5]{2,}|[a-z]{3,}/g) ?? []
        if (tokens.length === 0) continue
        let hits = 0
        for (const t of tokens) {
            if (text.includes(t)) hits++
        }
        const score = hits / tokens.length
        if (score > bestScore && score >= 0.3) {
            bestScore = score
            bestId = c.id
        }
    }
    return bestId
}

/**
 * 计算批次统计摘要
 */
function computeSummary(results: GradingItemResult[]): {
    total: number
    correct: number
    partial: number
    wrong: number
    needsReview: number
    avgConfidence: number
} {
    let correct = 0
    let partial = 0
    let wrong = 0
    let needsReview = 0
    let confSum = 0
    for (const r of results) {
        if (r.needsHumanReview) needsReview++
        if (r.correct) {
            correct++
        } else if (r.partialScore !== undefined && r.partialScore > 0) {
            partial++
        } else {
            wrong++
        }
        confSum += r.confidence
    }
    return {
        total: results.length,
        correct,
        partial,
        wrong,
        needsReview,
        avgConfidence: results.length > 0 ? Math.round((confSum / results.length) * 1000) / 1000 : 0,
    }
}

/** /grade 端点单条结果（与响应契约对齐） */
type GradingItemResult = {
    fileId: string
    studentId?: string
    questionId: string
    correct: boolean
    partialScore?: number
    cognitiveAttribution: string
    feedback: string
    teacherHint: string
    confidence: number
    needsHumanReview: boolean
    aiGenerated: true
}

// ─────────────────────────────────────────────────────────────
// Zod schemas（B6.3 输入校验）
// ─────────────────────────────────────────────────────────────

/** POST /upload form fields（multipart 表单字段） */
const uploadFormSchema = z.object({
    classId: schemas.classId,
    lessonId: schemas.optionalSanitizedString(128),
    questionId: schemas.optionalSanitizedString(128),
}).strict()

const gradingStudentsQuerySchema = z.object({ classId: schemas.classId })
const gradingQuestionsQuerySchema = z.object({ poemId: schemas.poemId })

/** POST /recognize 请求体 */
const recognizeSchema = z.object({
    batchId: schemas.id,
})

/** POST /grade 单条 item */
const gradeItemSchema = z.object({
    fileId: schemas.id,
    questionId: schemas.id,
    studentId: schemas.optionalSanitizedString(128),
    studentAnswer: schemas.sanitizedString(5000),
})

/** POST /grade 请求体 */
const gradeSchema = z.object({
    batchId: schemas.id,
    items: z.array(gradeItemSchema).min(1, 'items 至少一条').max(100, 'items 不能超过 100 条'),
})

/** POST /review 请求体 */
const reviewSchema = z.object({
    fileId: schemas.id,
    batchId: schemas.optionalSanitizedString(128),
    correct: z.boolean().optional(),
    feedback: schemas.optionalSanitizedString(5000),
    cognitiveAttribution: schemas.optionalSanitizedString(2000),
    action: z.enum(['confirm', 'modify', 'reference']).optional(),
})

/** GET /batch/:batchId 与 DELETE /batch/:batchId 路径参数 */
const batchIdParamsSchema = z.object({ batchId: schemas.id })

/** GET /files/:fileId 路径参数 */
const fileIdParamsSchema = z.object({ fileId: schemas.id })

// ─────────────────────────────────────────────────────────────
// 批改诊断深化 Zod schemas
// ─────────────────────────────────────────────────────────────

/** POST /:id/score-multi-dim 路径参数（:id 为 questionId） */
const questionIdParamsSchema = z.object({ id: schemas.id })

/** POST /:id/score-multi-dim 请求体 */
const scoreMultiDimSchema = z.object({
    studentAnswer: schemas.sanitizedString(5000),
    studentId: schemas.optionalSanitizedString(128),
    weights: z.object({
        accuracy: z.number().min(0).max(10).optional(),
        completeness: z.number().min(0).max(10).optional(),
        comprehension: z.number().min(0).max(10).optional(),
        expression: z.number().min(0).max(10).optional(),
        creativity: z.number().min(0).max(10).optional(),
        cultural: z.number().min(0).max(10).optional(),
    }).optional(),
})

/** POST /batch-score 请求体 */
const batchScoreItemSchema = z.object({
    questionId: schemas.id,
    studentAnswer: schemas.sanitizedString(5000),
    studentId: schemas.optionalSanitizedString(128),
    weights: z.object({
        accuracy: z.number().min(0).max(10).optional(),
        completeness: z.number().min(0).max(10).optional(),
        comprehension: z.number().min(0).max(10).optional(),
        expression: z.number().min(0).max(10).optional(),
        creativity: z.number().min(0).max(10).optional(),
        cultural: z.number().min(0).max(10).optional(),
    }).optional(),
})

const batchScoreSchema = z.object({
    items: z.array(batchScoreItemSchema).min(1, 'items 至少一条').max(50, 'items 不能超过 50 条'),
    concurrency: z.number().int().min(1).max(5).optional(),
})

/** POST /ocr 请求体 */
const inlineOcrImageSchema = z.string()
    .trim()
    .min(1, 'imageUrl 不能为空')
    .max(1_000_000, 'imageUrl 过长')
    .refine(isSupportedInlineImageDataUrl, 'imageUrl 仅允许格式与魔数一致的内联 jpg/png/webp 图片')

const ocrSchema = z.object({
    imageUrl: inlineOcrImageSchema,
    detail: z.enum(['auto', 'low', 'high']).optional(),
    context: schemas.optionalSanitizedString(500),
    expectedRange: schemas.optionalSanitizedString(200),
})

/** POST /ocr-batch 请求体 */
const ocrBatchItemSchema = z.object({
    imageUrl: inlineOcrImageSchema,
    detail: z.enum(['auto', 'low', 'high']).optional(),
    context: schemas.optionalSanitizedString(500),
    expectedRange: schemas.optionalSanitizedString(200),
})

const ocrBatchSchema = z.object({
    items: z.array(ocrBatchItemSchema).min(1, 'items 至少一条').max(20, 'items 不能超过 20 张'),
    concurrency: z.number().int().min(1).max(5).optional(),
})

/** POST /:id/attribute 请求体 */
const attributeSchema = z.object({
    studentAnswer: schemas.sanitizedString(5000),
    studentId: schemas.optionalSanitizedString(128),
    gradingResult: z.object({
        correct: z.boolean(),
        partialScore: z.number().min(0).max(1).optional(),
        cognitiveAttribution: schemas.optionalSanitizedString(2000),
        feedback: schemas.optionalSanitizedString(5000),
    }).optional(),
})

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

/** 批改路由选项（闭环2补全：broadcaster 用于推送批改完成事件） */
export interface GradingRoutesOptions {
    broadcaster?: WSBroadcaster
}

export const gradingRoutes: FastifyPluginAsync<GradingRoutesOptions> = async (
    app: FastifyInstance,
    opts,
) => {
    const broadcaster = opts.broadcaster
    await ensureUploadDir()

    // ── GET /students — 批改归档所需的真实班级学生 ──
    app.get('/students', async (req: FastifyRequest, reply) => {
        const query = validateQuery(gradingStudentsQuerySchema, req, reply)
        if (!query) return
        const classScope = resolveOwnedGradingClass(query.classId, req.auth?.id, gradingBoundaryRepositories)
        if (!classScope.ok) return sendGradingBoundaryFailure(reply, classScope)
        return reply.send({
            status: 'ok',
            students: repos.students.findByClassId(query.classId).map((student) => ({
                id: student.id,
                name: student.name,
            })),
        })
    })

    // ── GET /questions — 按诗篇返回真实题库，供教师显式确认批改对象 ──
    app.get('/questions', async (req: FastifyRequest, reply) => {
        const query = validateQuery(gradingQuestionsQuerySchema, req, reply)
        if (!query) return
        const authenticatedTeacherId = req.auth?.id
        if (!authenticatedTeacherId) {
            return reply.status(401).send({ status: 'error', error: 'AUTH_REQUIRED', message: '需要教师身份后才能访问题库' })
        }
        return reply.send({
            status: 'ok',
            questions: repos.questions.findByPoemId(query.poemId)
                .filter((question) => !question.createdBy || question.createdBy === authenticatedTeacherId)
                .map((question) => ({
                    id: question.id,
                    stem: question.stem,
                    bloomLevel: question.bloomLevel,
                    type: question.type,
                })),
        })
    })

    // ── GET /history — 班级批改批次历史 ──
    app.get('/history', async (req: FastifyRequest, reply) => {
        const query = validateQuery(gradingStudentsQuerySchema, req, reply)
        if (!query) return
        const classScope = resolveOwnedGradingClass(query.classId, req.auth?.id, gradingBoundaryRepositories)
        if (!classScope.ok) return sendGradingBoundaryFailure(reply, classScope)
        const batches = Array.from(batchStore.values())
            .filter((batch) => batch.classId === query.classId)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 30)
            .map((batch) => {
                const question = batch.questionId ? lookupQuestion(batch.questionId) : null
                return {
                    batchId: batch.batchId,
                    classId: batch.classId,
                    lessonId: batch.lessonId,
                    questionId: batch.questionId,
                    poemId: question?.poemId,
                    questionStem: question?.stem,
                    status: batch.status,
                    fileCount: batch.files.length,
                    recognizedCount: batch.recognized.length,
                    resultCount: batch.results.length,
                    reviewedCount: batch.results.filter((result) => result.reviewed).length,
                    needsReview: batch.results.filter((result) => result.needsHumanReview).length,
                    createdAt: batch.createdAt,
                    updatedAt: batch.updatedAt,
                }
            })
        return reply.send({ status: 'ok', batches })
    })

    // ── POST /upload — 上传答题图片 ──
    app.post('/upload', async (req: FastifyRequest, reply) => {
        // multipart 数据流只能消费一次；统一使用 parts() 同时读取文件与字段。
        const parts = req.parts({ limits: GRADING_MULTIPART_LIMITS })
        const files: Array<{
            buffer: Buffer
            filename: string
            mimetype: string
            extension: 'jpg' | 'png' | 'webp'
        }> = []
        const formFields: Record<string, string> = {}
        const seenFields = new Set<string>()
        let totalUploadBytes = 0

        try {
            for await (const part of parts) {
                if (part.type === 'file') {
                    if (part.fieldname !== 'files') {
                        part.file.resume()
                        return sendInvalidGradingMultipart(reply, '图片文件字段必须命名为 files')
                    }
                    if (files.length >= MAX_FILES_PER_BATCH) {
                        part.file.resume()
                        return sendGradingUploadLimit(reply)
                    }
                    const safeFilename = sanitizeUploadFilename(part.filename)
                    if (!ALLOWED_CONTENT_TYPES.has(part.mimetype)) {
                        part.file.resume()
                        return reply.status(400).send({
                            status: 'error',
                            error: 'INVALID_IMAGE',
                            message: '图片声明类型不受支持，仅允许 jpg/png/webp',
                        })
                    }
                    const buffer = await part.toBuffer()
                    if (part.file.truncated || buffer.byteLength > MAX_FILE_SIZE) {
                        return sendGradingUploadLimit(reply)
                    }
                    totalUploadBytes += buffer.byteLength
                    if (totalUploadBytes > MAX_TOTAL_UPLOAD_SIZE) {
                        return sendGradingUploadLimit(reply)
                    }
                    let inspected: Awaited<ReturnType<typeof inspectImageUpload>>
                    try {
                        inspected = await inspectImageUpload(buffer, part.mimetype)
                    } catch (error) {
                        return reply.status(400).send({
                            status: 'error',
                            error: 'INVALID_IMAGE',
                            message: `${safeFilename}：${error instanceof Error ? error.message : '图片校验失败'}`,
                        })
                    }
                    files.push({
                        buffer,
                        filename: safeFilename,
                        mimetype: inspected.contentType,
                        extension: inspected.extension,
                    })
                } else if (part.type === 'field') {
                    if (part.fieldnameTruncated || part.valueTruncated) {
                        return sendGradingUploadLimit(reply)
                    }
                    if (!GRADING_UPLOAD_FIELD_NAMES.has(part.fieldname)) {
                        return sendInvalidGradingMultipart(reply, `不支持的表单字段: ${part.fieldname}`)
                    }
                    if (seenFields.has(part.fieldname)) {
                        return sendInvalidGradingMultipart(reply, `表单字段重复: ${part.fieldname}`)
                    }
                    seenFields.add(part.fieldname)
                    formFields[part.fieldname] = String(part.value)
                }
            }
        } catch (err) {
            const limited = isMultipartLimitError(err)
            req.log.warn({ err, limited }, 'grading upload multipart 解析失败')
            if (limited) return sendGradingUploadLimit(reply)
            return sendInvalidGradingMultipart(reply)
        }

        // 校验 form fields（B6.3）
        const formResult = uploadFormSchema.safeParse({
            classId: formFields['classId'],
            lessonId: formFields['lessonId'] || undefined,
            questionId: formFields['questionId'] || undefined,
        })
        if (!formResult.success) {
            return reply.status(400).send({
                status: 'error',
                error: 'VALIDATION_ERROR',
                message: '表单字段校验失败',
                details: formResult.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message })),
            })
        }
        const { classId, lessonId, questionId } = formResult.data

        const uploadScope = validateGradingUploadScope({
            classId,
            lessonId,
            questionId,
            authenticatedTeacherId: req.auth?.id,
        }, gradingBoundaryRepositories)
        if (!uploadScope.ok) return sendGradingBoundaryFailure(reply, uploadScope)

        if (files.length === 0) {
            return sendInvalidGradingMultipart(reply, '未上传任何文件')
        }
        const batchId = generateId()
        const batchDir = path.join(UPLOAD_DIR, batchId)
        await mkdir(batchDir, { recursive: true })

        const uploadedFiles: UploadedFile[] = []
        for (const f of files) {
            const fileId = generateId()
            const savedName = `${fileId}.${f.extension}`
            const filePath = path.join(batchDir, savedName)
            await writeFile(filePath, f.buffer)
            uploadedFiles.push({
                id: fileId,
                url: `/api/grading/files/${fileId}`,
                filePath,
                fileName: f.filename,
                contentType: f.mimetype,
                size: f.buffer.byteLength,
            })
        }

        const batch: GradingBatch = {
            batchId,
            classId,
            lessonId,
            questionId,
            status: 'uploading',
            files: uploadedFiles,
            recognized: [],
            results: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }
        batchStore.set(batchId, batch)
        const cleanupFailureCount = await trimGradingBatches()
        if (cleanupFailureCount > 0) {
            req.log.warn(
                { failedBatchCount: cleanupFailureCount },
                '旧批改批次文件清理失败，已保留元数据供后续重试',
            )
        }

        return reply.send({
            status: 'ok',
            batchId,
            uploadedFiles: uploadedFiles.map((f) => ({ id: f.id, url: f.url })),
            pendingRecognition: uploadedFiles.length,
        })
    })

    // ── POST /recognize — 调用诗眼 Agent 识别手写内容 ──
    app.post('/recognize', async (req: FastifyRequest, reply) => {
        const body = validateBody(recognizeSchema, req, reply)
        if (!body) return
        const { batchId } = body

        const batch = batchStore.get(batchId)
        if (!batch) {
            return reply.status(404).send({
                status: 'error',
                message: `批次不存在: ${batchId}`,
            })
        }
        if (!requireOwnedGradingBatch(batch, req, reply)) return

        if (batch.status === 'recognizing') {
            return reply.status(409).send({
                status: 'error',
                error: 'BATCH_RECOGNITION_IN_PROGRESS',
                message: '该批次正在识别，请勿重复提交',
            })
        }
        if (batch.recognized.length > 0) {
            return reply.send({
                status: 'ok',
                recognized: batch.recognized,
                aiGenerated: true,
                replayed: true,
            })
        }

        batch.status = 'recognizing'
        batch.updatedAt = Date.now()
        // SqliteMap：mutation 后必须显式 set() 落盘
        batchStore.set(batchId, batch)

        // 题目候选列表（用于自动匹配）
        const candidates = batch.questionId
            ? []
            : listQuestionCandidates(batch.classId)

        const recognized: RecognizedItem[] = []

        for (const file of batch.files) {
            try {
                // 将文件转为 data URL 供多模态 Agent 调用
                const dataUrl = await fileToDataUrl(file.filePath, file.contentType)

                // 调用诗眼 Agent 视觉标注子 Agent（Tri-MARF 三阶段流程）
                const ctx = buildAgentContext(`recognize-${file.id}`, batch.classId)
                const result = await eyeAgent.visionAnnotate.invoke(
                    {
                        imageUrl: dataUrl,
                        purpose: 'handwriting-recognition',
                    },
                    ctx,
                )

                const annotation = result.output.finalAnnotation || result.output.aggregated || ''
                const confidence = result.output.confidence ?? 0.6

                // 题目匹配：上传时指定 questionId 优先，否则启发式匹配
                let matchedQuestionId: string | undefined
                let needsManualMatch = false
                if (batch.questionId) {
                    matchedQuestionId = batch.questionId
                } else {
                    matchedQuestionId = matchQuestion(annotation, candidates)
                    needsManualMatch = matchedQuestionId === undefined
                }

                recognized.push({
                    fileId: file.id,
                    questionId: matchedQuestionId,
                    studentAnswer: annotation,
                    confidence,
                    needsManualMatch,
                })
            } catch (err) {
                req.log.error({ err, fileId: file.id }, '诗眼 Agent 识别失败')
                // 降级：返回空文本 + 低置信度 + 需人工匹配
                recognized.push({
                    fileId: file.id,
                    studentAnswer: '',
                    confidence: 0,
                    needsManualMatch: true,
                })
            }
        }

        batch.recognized = recognized
        batch.status = 'reviewing'
        batch.updatedAt = Date.now()
        // SqliteMap：mutation 后必须显式 set() 落盘
        batchStore.set(batchId, batch)

        return reply.send({
            status: 'ok',
            recognized,
            aiGenerated: true,
        })
    })

    // ── POST /grade — 调用诗笔 Agent 批改 ──
    app.post('/grade', async (req: FastifyRequest, reply) => {
        const body = validateBody(gradeSchema, req, reply)
        if (!body) return
        const { batchId, items } = body

        const batch = batchStore.get(batchId)
        if (!batch) {
            return reply.status(404).send({
                status: 'error',
                message: `批次不存在: ${batchId}`,
            })
        }

        const batchItemsScope = validateGradingBatchItems({
            batch,
            items,
            authenticatedTeacherId: req.auth?.id,
        }, gradingBoundaryRepositories)
        if (!batchItemsScope.ok) return sendGradingBoundaryFailure(reply, batchItemsScope)

        if (batch.status === 'grading') {
            return reply.status(409).send({
                status: 'error',
                error: 'BATCH_GRADING_IN_PROGRESS',
                message: '该批次正在批改，请勿重复提交',
            })
        }
        if (batch.results.length > 0 || batch.status === 'completed') {
            return reply.status(409).send({
                status: 'error',
                error: 'BATCH_ALREADY_GRADED',
                message: '该批次已有批改结果，请先读取现有结果，避免重复写入学情数据',
            })
        }

        batch.status = 'grading'
        batch.updatedAt = Date.now()
        // SqliteMap：mutation 后必须显式 set() 落盘
        batchStore.set(batchId, batch)

        const results: GradingItemResult[] = []

        for (const item of items) {
            try {
                const question = lookupQuestion(item.questionId)
                if (!question) {
                    req.log.error({ questionId: item.questionId }, '题目不存在')
                    results.push({
                        fileId: item.fileId,
                        studentId: item.studentId,
                        questionId: item.questionId,
                        correct: false,
                        cognitiveAttribution: '题目查询失败，无法批改',
                        feedback: '题目查询失败，请检查题目 ID',
                        teacherHint: '题目不存在于数据库',
                        confidence: 0,
                        needsHumanReview: true,
                        aiGenerated: true,
                    })
                    continue
                }

                // 调用诗笔 Agent 智能批改子 Agent
                const ctx = buildAgentContext(`grade-${item.fileId}`, batch.classId)
                const gradeResult = await brushAgent.grade.invoke(
                    {
                        question,
                        studentAnswer: item.studentAnswer,
                    },
                    ctx,
                )

                const out = gradeResult.output
                const needsReview = out.needsHumanReview || out.confidence < REVIEW_CONFIDENCE_THRESHOLD

                const result: GradingItemResult = {
                    fileId: item.fileId,
                    studentId: item.studentId,
                    questionId: item.questionId,
                    correct: out.correct,
                    ...(out.partialScore !== undefined ? { partialScore: out.partialScore } : {}),
                    cognitiveAttribution: out.cognitiveAttribution,
                    feedback: out.feedback,
                    teacherHint: out.teacherHint ?? '',
                    confidence: out.confidence,
                    needsHumanReview: needsReview,
                    aiGenerated: true,
                }
                results.push(result)

                // 若提供 studentId，则将作答记录写入 answers 表（持久化）
                if (item.studentId) {
                    try {
                        repos.answers.create({
                            studentId: item.studentId,
                            questionId: item.questionId,
                            lessonId: batch.lessonId ?? null,
                            answerText: item.studentAnswer,
                            correct: out.correct,
                            partialScore: out.partialScore ?? null,
                            cognitiveAttribution: out.cognitiveAttribution,
                            feedback: out.feedback,
                            teacherHint: out.teacherHint ?? null,
                            aiConfidence: out.confidence,
                            needsHumanReview: needsReview,
                            gradedBy: 'ai',
                            gradedAt: Date.now(),
                            submittedAt: Date.now(),
                        })

                        // P0-1: 批改完成后同步写入 mastery 表
                        // 驾驶舱雷达图、学情诊断、暗物质检测、推荐引擎均依赖此数据
                        const masteryScore = out.correct
                            ? 100
                            : (out.partialScore !== undefined ? Math.round(out.partialScore * 100) : 0)
                        repos.mastery.upsertScore(
                            item.studentId,
                            question.poemId,
                            question.bloomLevel,
                            masteryScore,
                            out.correct,
                        )
                    } catch (err) {
                        req.log.error({ err }, 'answers 表写入失败，忽略')
                    }
                }
            } catch (err) {
                req.log.error({ err, fileId: item.fileId }, '诗笔 Agent 批改失败')
                results.push({
                    fileId: item.fileId,
                    studentId: item.studentId,
                    questionId: item.questionId,
                    correct: false,
                    cognitiveAttribution: '批改失败，需人工审核',
                    feedback: 'AI 批改失败，请人工审核',
                    teacherHint: '批改过程异常',
                    confidence: 0,
                    needsHumanReview: true,
                    aiGenerated: true,
                })
            }
        }

        // 更新批次结果
        batch.results = results.map((r) => ({ ...r }))
        batch.status = 'reviewing'
        batch.updatedAt = Date.now()
        // SqliteMap：mutation 后必须显式 set() 落盘
        batchStore.set(batchId, batch)

        const summary = computeSummary(results)

        // P0-3: 批改完成后触发学情暗物质检测（容错：失败不影响主响应）
        triggerMasteryDarkMatterCheck(results)

        // 闭环2补全：批改完成后主动同步错题本（避免惰性同步的数据延迟）
        // 此前错题本仅在 /error-notebook/list 首次访问时同步，导致刚批改出的错题
        // 无法立即出现在错题本中。此处主动调用同步函数，确保数据闭环实时性。
        try {
            syncErrorsFromAnswers()
        } catch {
            // 同步失败不影响批改主响应
        }

        // 闭环2补全：批改完成后推送 WS 事件，通知前端刷新错题本/诊断/仪表盘
        if (broadcaster) {
            try {
                const wrongCount = results.filter((r) => r.correct === false).length
                const wsEvent: WSEvent = {
                    type: 'business:event',
                    timestamp: Date.now(),
                    sessionId: batchId,
                    payload: {
                        businessEventType: 'grading:reviewed',
                        businessEventPayload: {
                            classId: batch.classId || undefined,
                            reviewCount: results.length,
                            wrongCount,
                        },
                    },
                }
                broadcaster.broadcast(wsEvent)
            } catch {
                // WS 推送失败不影响主响应
            }
        }

        return reply.send({
            status: 'ok',
            results,
            summary,
        })
    })

    // ── POST /review — 教师审核 ──
    app.post('/review', async (req: FastifyRequest, reply) => {
        const body = validateBody(reviewSchema, req, reply)
        if (!body) return
        const { fileId, batchId, correct, feedback, cognitiveAttribution, action = 'confirm' } = body

        // 查找包含该 fileId 的批次
        let batch: GradingBatch | undefined
        if (batchId) {
            batch = batchStore.get(batchId)
        } else {
            for (const b of batchStore.values()) {
                if (b.results.some((r) => r.fileId === fileId)) {
                    batch = b
                    break
                }
            }
        }

        if (!batch) {
            return reply.status(404).send({
                status: 'error',
                message: `未找到 fileId=${fileId} 对应的批次`,
            })
        }
        if (!requireOwnedGradingBatch(batch, req, reply)) return

        const resultIdx = batch.results.findIndex((r) => r.fileId === fileId)
        if (resultIdx === -1) {
            return reply.status(404).send({
                status: 'error',
                message: `批次中未找到 fileId=${fileId} 的批改结果`,
            })
        }

        const result = batch.results[resultIdx]
        if (!result) {
            return reply.status(409).send({ status: 'error', message: '批改结果状态已变化，请刷新后重试' })
        }
        const wasModified = action === 'modify'
        const originalCorrect = result.correct

        // 应用教师修正
        if (wasModified) {
            if (correct !== undefined) result.correct = correct
            if (feedback !== undefined) {
                result.teacherFeedback = feedback
                result.feedback = feedback
            }
            if (cognitiveAttribution !== undefined) {
                result.teacherAttribution = cognitiveAttribution
                result.cognitiveAttribution = cognitiveAttribution
            }
            // 教师修正后置信度提升至 1.0，取消人工审核标记
            result.confidence = 1.0
            result.needsHumanReview = false
        } else if (action === 'confirm') {
            result.needsHumanReview = false
            result.confidence = Math.max(result.confidence, 0.95)
        } else if (action === 'reference') {
            // 标记为参考，不批改
            result.needsHumanReview = false
        }

        result.reviewed = true
        result.reviewAction = action
        batch.results[resultIdx] = result
        batch.updatedAt = Date.now()
        // SqliteMap：mutation 后必须显式 set() 落盘（results / status 变更）
        batchStore.set(batch.batchId, batch)

        // 检查批次是否全部审核完成
        const allReviewed = batch.results.every((r) => r.reviewed || !r.needsHumanReview)
        if (allReviewed) {
            batch.status = 'completed'
        }
        batchStore.set(batch.batchId, batch)

        // 教师审核是最终事实源：同步修正 answers 与 mastery，避免界面改了而学情仍保留 AI 旧结论。
        if (result.studentId && action !== 'reference') {
            try {
                const answerRow = db.prepare(`
                    SELECT id FROM answers
                    WHERE student_id = ? AND question_id = ?
                    ORDER BY submitted_at DESC
                    LIMIT 1
                `).get(result.studentId, result.questionId) as { id: string } | undefined
                if (answerRow) {
                    repos.answers.update(answerRow.id, {
                        correct: result.correct,
                        feedback: result.feedback,
                        cognitiveAttribution: result.cognitiveAttribution,
                        aiConfidence: 1,
                        needsHumanReview: false,
                        gradedBy: 'both',
                        gradedAt: Date.now(),
                    })
                }
                if (wasModified && originalCorrect !== result.correct) {
                    const question = repos.questions.findById(result.questionId)
                    if (question) {
                        const mastery = repos.mastery.findByStudentPoemBloom(
                            result.studentId,
                            question.poemId,
                            question.bloomLevel,
                        )
                        if (mastery) {
                            repos.mastery.update(mastery.id, {
                                score: result.correct ? 100 : 0,
                                correctCount: Math.max(
                                    0,
                                    mastery.correctCount + (result.correct ? 1 : -1),
                                ),
                                lastAttemptAt: Date.now(),
                            })
                        }
                    }
                }
            } catch (err) {
                req.log.error({ err, fileId }, '教师审核结果回写学情失败')
            }
        }

        // 教师修正触发自我进化引擎事件（Task 22 用）
        if (wasModified) {
            agentEvents.emit(GRADING_REVIEW_EVENT, {
                fileId,
                batchId: batch.batchId,
                questionId: result.questionId,
                action,
                originalAttribution: result.cognitiveAttribution,
                teacherAttribution: cognitiveAttribution,
                teacherFeedback: feedback,
                timestamp: Date.now(),
            })
        }

        return reply.send({
            status: 'ok',
            success: true,
            batchStatus: batch.status,
            // 审核结果是服务端权威事实；前端必须用它校准乐观更新，不能只收到布尔成功后
            // 长期保留旧置信度、旧需审标记或旧汇总。
            result: { ...result },
            summary: computeSummary(batch.results),
        })
    })

    // ── GET /batch/:batchId — 查询批次状态 ──
    app.get('/batch/:batchId', async (req: FastifyRequest, reply) => {
        const params = validateParams(batchIdParamsSchema, req, reply)
        if (!params) return
        const { batchId } = params
        const batch = batchStore.get(batchId)
        if (!batch) {
            return reply.status(404).send({
                status: 'error',
                message: `批次不存在: ${batchId}`,
            })
        }
        if (!requireOwnedGradingBatch(batch, req, reply)) return

        const total = batch.files.length
        const done = batch.results.length
        const batchQuestion = batch.questionId ? lookupQuestion(batch.questionId) : null

        return reply.send({
            status: 'ok',
            batchId: batch.batchId,
            classId: batch.classId,
            lessonId: batch.lessonId,
            questionId: batch.questionId,
            poemId: batchQuestion?.poemId,
            questionStem: batchQuestion?.stem,
            batchStatus: batch.status,
            progress: { total, done },
            files: batch.files.map((f) => ({ id: f.id, url: f.url, fileName: f.fileName })),
            recognized: batch.recognized,
            results: batch.results,
            summary: computeSummary(batch.results),
        })
    })

    // ── GET /files/:fileId — 读取已上传的图片文件（前端预览用） ──
    app.get('/files/:fileId', async (req: FastifyRequest, reply) => {
        const params = validateParams(fileIdParamsSchema, req, reply)
        if (!params) return
        const { fileId } = params
        // 在所有批次中查找该 fileId
        let target: { filePath: string; contentType: string; batch: GradingBatch } | null = null
        for (const batch of batchStore.values()) {
            const f = batch.files.find((x) => x.id === fileId)
            if (f) {
                target = { filePath: f.filePath, contentType: f.contentType, batch }
                break
            }
        }

        if (!target) {
            return reply.status(404).send({
                status: 'error',
                message: `文件不存在: ${fileId}`,
            })
        }
        if (!requireOwnedGradingBatch(target.batch, req, reply)) return

        try {
            const protectedFilePath = await resolveExistingProtectedUploadFile(target.filePath, target.contentType)
            if (!protectedFilePath) {
                return reply.status(410).send({
                    status: 'error',
                    error: 'UPLOAD_FILE_UNAVAILABLE',
                    message: '图片引用无效、已过期或不再位于受控目录',
                })
            }
            const buffer = await readFile(protectedFilePath)
            reply.type(target.contentType)
            return reply.send(buffer)
        } catch (err) {
            req.log.error({ err, fileId }, '读取上传文件失败')
            return reply.status(404).send({
                status: 'error',
                message: '文件读取失败',
            })
        }
    })

    // ── DELETE /batch/:batchId — 清理批次（可选，用于资源回收） ──
    app.delete('/batch/:batchId', async (req: FastifyRequest, reply) => {
        const params = validateParams(batchIdParamsSchema, req, reply)
        if (!params) return
        const { batchId } = params
        const batch = batchStore.get(batchId)
        if (!batch) {
            return reply.status(404).send({
                status: 'error',
                message: `批次不存在: ${batchId}`,
            })
        }
        if (!requireOwnedGradingBatch(batch, req, reply)) return

        const cleanupFailures = await removeBatchFiles(batch)
        if (cleanupFailures.length > 0) {
            req.log.error(
                { batchId, failedCount: cleanupFailures.length },
                '批改批次文件清理失败，元数据已保留供重试',
            )
            return reply.status(500).send({
                status: 'error',
                error: 'BATCH_FILE_CLEANUP_FAILED',
                message: '部分文件暂时无法删除，批次记录已保留，请关闭占用文件的程序后重试',
            })
        }

        batchStore.delete(batchId)
        return reply.send({ status: 'ok', success: true })
    })

    // ─────────────────────────────────────────────────────────
    // 批改诊断深化端点（5 大能力）
    // ─────────────────────────────────────────────────────────

    // ── POST /:id/score-multi-dim — 多维度评分（单条） ──
    app.post('/:id/score-multi-dim', async (req: FastifyRequest, reply) => {
        const params = validateParams(questionIdParamsSchema, req, reply)
        if (!params) return
        const body = validateBody(scoreMultiDimSchema, req, reply)
        if (!body) return
        const questionId = params.id

        const question = lookupQuestion(questionId)
        if (!question) {
            return reply.status(404).send({
                status: 'error',
                message: `题目不存在: ${questionId}`,
            })
        }

        // 可选：查询学生画像
        let profile: StudentProfile | undefined
        if (body.studentId) {
            profile = buildStudentProfileForProactive(body.studentId) ?? undefined
        }

        try {
            const output = await multiDimensionScorer.score({
                question,
                studentAnswer: body.studentAnswer,
                studentProfile: profile,
                weights: body.weights as Partial<Record<ScoreDimension, number>> | undefined,
            })

            // 推送业务事件 grading:scored
            broadcastBusinessEvent(broadcaster, 'grading:scored', {
                questionId,
                studentId: body.studentId,
                weightedTotal: output.weightedTotal,
                needsHumanReview: output.needsHumanReview,
            })

            return reply.send({ status: 'ok', ...output })
        } catch (err) {
            req.log.error({ err, questionId }, '多维度评分失败')
            return reply.status(500).send({
                status: 'error',
                message: '多维度评分失败，请稍后重试',
            })
        }
    })

    // ── POST /batch-score — 批量多维度评分 ──
    app.post('/batch-score', async (req: FastifyRequest, reply) => {
        const body = validateBody(batchScoreSchema, req, reply)
        if (!body) return

        try {
            const inputs = body.items.map((item) => {
                const question = lookupQuestion(item.questionId)
                if (!question) {
                    throw new Error(`题目不存在: ${item.questionId}`)
                }
                const profile = item.studentId
                    ? buildStudentProfileForProactive(item.studentId) ?? undefined
                    : undefined
                return {
                    question,
                    studentAnswer: item.studentAnswer,
                    studentProfile: profile,
                    weights: item.weights as Partial<Record<ScoreDimension, number>> | undefined,
                }
            })

            const results = await multiDimensionScorer.batchScore(inputs, body.concurrency ?? 3)

            // 推送业务事件 grading:scored（批量）
            broadcastBusinessEvent(broadcaster, 'grading:scored', {
                batchCount: results.length,
                avgScore: results.length > 0
                    ? Math.round(results.reduce((s, r) => s + r.weightedTotal, 0) / results.length)
                    : 0,
            })

            return reply.send({
                status: 'ok',
                results,
                totalCount: results.length,
                avgScore: results.length > 0
                    ? Math.round(results.reduce((s, r) => s + r.weightedTotal, 0) / results.length)
                    : 0,
            })
        } catch (err) {
            req.log.error({ err }, '批量多维度评分失败')
            return reply.status(500).send({
                status: 'error',
                error: 'BATCH_SCORING_FAILED',
                message: '批量评分失败，请稍后重试',
            })
        }
    })

    // ── POST /ocr — 单张手写识别 ──
    app.post('/ocr', async (req: FastifyRequest, reply) => {
        const body = validateBody(ocrSchema, req, reply)
        if (!body) return

        try {
            const output = await handwritingOcr.recognize({
                imageUrl: body.imageUrl,
                detail: body.detail,
                context: body.context,
                expectedRange: body.expectedRange,
            })

            // 推送业务事件 grading:ocr-completed
            broadcastBusinessEvent(broadcaster, 'grading:ocr-completed', {
                confidence: output.confidence,
                suspiciousCount: output.suspiciousCount,
                needsManualCheck: output.needsManualCheck,
            })

            return reply.send({ status: 'ok', ...output })
        } catch (err) {
            req.log.error({ err }, '手写识别失败')
            return reply.status(500).send({
                status: 'error',
                message: '手写识别失败，请稍后重试',
            })
        }
    })

    // ── POST /ocr-batch — 批量手写识别 ──
    app.post('/ocr-batch', async (req: FastifyRequest, reply) => {
        const body = validateBody(ocrBatchSchema, req, reply)
        if (!body) return

        try {
            const output = await handwritingOcr.batchRecognize({
                items: body.items,
                concurrency: body.concurrency,
            })

            // 推送业务事件 grading:ocr-completed（批量）
            broadcastBusinessEvent(broadcaster, 'grading:ocr-completed', {
                totalCount: output.totalCount,
                successCount: output.successCount,
                failedCount: output.failedCount,
            })

            return reply.send({ status: 'ok', ...output })
        } catch (err) {
            req.log.error({ err }, '批量手写识别失败')
            return reply.status(500).send({
                status: 'error',
                message: '批量手写识别失败，请稍后重试',
            })
        }
    })

    // ── POST /:id/attribute — 错题归因分析 ──
    app.post('/:id/attribute', async (req: FastifyRequest, reply) => {
        const params = validateParams(questionIdParamsSchema, req, reply)
        if (!params) return
        const body = validateBody(attributeSchema, req, reply)
        if (!body) return
        const questionId = params.id

        const question = lookupQuestion(questionId)
        if (!question) {
            return reply.status(404).send({
                status: 'error',
                message: `题目不存在: ${questionId}`,
            })
        }

        let profile: StudentProfile | undefined
        if (body.studentId) {
            profile = buildStudentProfileForProactive(body.studentId) ?? undefined
        }

        try {
            const output = await errorAttribution.attribute({
                question,
                studentAnswer: body.studentAnswer,
                studentProfile: profile,
                gradingResult: body.gradingResult,
            })

            return reply.send({ status: 'ok', ...output })
        } catch (err) {
            req.log.error({ err, questionId }, '错题归因失败')
            return reply.status(500).send({
                status: 'error',
                message: '错题归因失败，请稍后重试',
            })
        }
    })
}

// ─────────────────────────────────────────────────────────────
// P0-3 主动智能：学情暗物质检测
// ─────────────────────────────────────────────────────────────

/**
 * 批改完成后对涉及的学生触发学情暗物质检测
 *
 * 对每个被批改的学生构建 StudentProfile，调用 proactiveIntelligence.checkMasteryDarkMatter
 * 主动推送预警。容错：单学生失败不影响其他学生，整体失败不影响主响应。
 */
function triggerMasteryDarkMatterCheck(results: GradingItemResult[]): void {
    const uniqueStudentIds = new Set<string>()
    for (const r of results) {
        if (r.studentId) uniqueStudentIds.add(r.studentId)
    }
    for (const studentId of uniqueStudentIds) {
        try {
            const profile = buildStudentProfileForProactive(studentId)
            if (profile) {
                proactiveIntelligence.checkMasteryDarkMatter(profile)
            }
        } catch {
            // 容错：单学生失败不影响其他学生
        }
    }
}

/**
 * 基于 students + mastery 表构建 StudentProfile（供 checkMasteryDarkMatter 使用）
 * 失败时返回 null，不影响主流程
 */
function buildStudentProfileForProactive(studentId: string): StudentProfile | null {
    try {
        const student = repos.students.findById(studentId)
        if (!student) return null
        const masteryList = repos.mastery.findByStudentId(studentId)
        const masteryByPoem: Record<string, BloomMastery> = {}
        for (const m of masteryList) {
            let entry = masteryByPoem[m.poemId]
            if (!entry) {
                entry = { 记忆: 0, 理解: 0, 应用: 0, 分析: 0, 评价: 0, 创造: 0 }
                masteryByPoem[m.poemId] = entry
            }
            entry[m.bloomLevel] = m.score
        }
        return {
            id: student.id,
            name: student.name,
            grade: student.grade,
            mastery: masteryByPoem,
        }
    } catch {
        return null
    }
}

// ─────────────────────────────────────────────────────────────
// 批改诊断深化：业务事件广播辅助函数
// ─────────────────────────────────────────────────────────────

/**
 * 推送业务事件到 WebSocket 广播器
 *
 * 封装 WSEvent 构造与 broadcaster.broadcast 调用，
 * 供批改诊断深化端点（score-multi-dim / batch-score / ocr / ocr-batch）复用。
 *
 * 设计要点：
 * - broadcaster 为空时静默跳过（兼容未启用 WS 的部署）
 * - WS 推送失败不影响主响应（catch 吞错）
 * - sessionId 为空字符串（全局事件，与现有 grading:reviewed 模式一致）
 *
 * @param broadcaster WS 广播器实例（可选）
 * @param eventType 业务事件类型，如 'grading:scored' / 'grading:ocr-completed'
 * @param payload 业务事件载荷
 */
function broadcastBusinessEvent(
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
