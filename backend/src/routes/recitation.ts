/**
 * 诗音阁 REST API 路由（Task 19）
 *
 * 8 个端点：
 * - GET    /api/recitation/poems                 获取可朗读的诗列表
 * - POST   /api/recitation/tts/generate          生成标准范读（eye.tts，缓存）
 * - POST   /api/recitation/asr/transcribe        上传朗读音频并转写（eye.asr）
 * - POST   /api/recitation/evaluate              评估朗读三维得分（eye.asr 评估）
 * - GET    /api/recitation/history/:studentId    学生朗读历史
 * - GET    /api/recitation/leaderboard/:classId  班级朗读排行榜（脱敏）
 * - GET    /api/recitation/audio/:recitationId   获取指定朗读音频
 * - DELETE /api/recitation/:recitationId         删除朗读记录
 *
 * 设计要点：
 * - 音频文件存储到 APP_DATA_DIR/audio/（tts/ 与 recitations/ 子目录）
 * - 音频 URL 返回受会话保护的完整 API 路径 /api/recitation/audio/...
 * - TTS 结果缓存（同诗同 voice 不重复生成），SQLite 元数据 + 文件持久
 * - AI 成功时标记 aiGenerated: true；本地降级评分必须标记 false
 * - 评估调用 eyeAgent.asr（已内含 deepseek-v4-flash 评估发音/节奏/情感三维得分）
 *   注：mindAgent 无朗读评测专用子 Agent，eye.asr 的评估阶段使用同款
 *   deepseek-v4-flash 模型完成三维评分，与诗心 Agent 评估能力等价
 * - 排行榜学生姓名脱敏为"学生H01"格式
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { eyeAgent } from '../agents/index.js'
import type { AsrInput, AsrOutput, TtsInput } from '../agents/eye-agent/index.js'
import type { AgentContext } from '../agents/base/types.js'
import { repos, db } from '../db/index.js'
import { generateId } from '../db/utils/id.js'
import { inspectAudioUpload } from '../security/audio-upload-policy.js'
import { normalizeProtectedAudioUrl } from '../security/protected-audio-reference.js'
import type { RecitationEntity } from '../db/types.js'
import { z } from 'zod'
import { validateBody, validateParams, validateQuery, schemas } from '../lib/validation.js'
import { SqliteMap } from '../db/runtime-store.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 朗读诗选项（列表用） */
interface RecitationPoemOption {
    id: string
    title: string
    poet: string
    dynasty: string
    content: string
    /** 题材标签（教材人工校订，如 ["节庆","春节"]），前端据此着色与筛选 */
    theme?: string[]
    /** 修辞手法（教材人工校订，如 ["比喻","拟人"]） */
    rhetoric?: string[]
    /** 学段（如"三年级"） */
    gradeLevel?: string
    /** 当前学生是否已朗读过（前端展示徽章用） */
    recitedByStudent?: boolean
    /** 已缓存范读 URL（若有） */
    ttsAudioUrl?: string
}

// ─────────────────────────────────────────────────────────────
// Zod schemas（B6.3 输入校验）
// ─────────────────────────────────────────────────────────────

/** GET /poems 查询参数 */
const poemsQuerySchema = z.object({
    studentId: schemas.optionalSanitizedString(128),
})

/** POST /tts/generate 请求体 */
const ttsGenerateSchema = z.object({
    poemId: schemas.poemId,
    voice: z.string()
        .trim()
        .min(1, '音色不能为空')
        .max(64, '音色长度不能超过 64 字符')
        .regex(/^[A-Za-z0-9_-]+$/u, '音色仅允许字母、数字、下划线和连字符')
        .optional(),
    speed: z.number().min(0.5).max(2.0).optional(),
    format: z.enum(['mp3', 'wav', 'opus']).optional(),
})

/** POST /asr/transcribe 表单字段（multipart 解析后校验） */
const asrTranscribeFieldsSchema = z.object({
    poemId: schemas.poemId,
    studentId: schemas.studentId.optional(),
})

/** POST /evaluate 请求体 */
const evaluateSchema = z.object({
    studentId: schemas.studentId,
    poemId: schemas.poemId,
    audioUrl: schemas.sanitizedString(512),
    transcript: schemas.optionalSanitizedString(5000),
    audioDurationSec: z.number().min(0).max(3600).optional(),
})

/** GET /history/:studentId 路径参数 */
const studentIdParamsSchema = z.object({ studentId: schemas.studentId })

/** GET /leaderboard/:classId 路径参数 */
const leaderboardParamsSchema = z.object({ classId: schemas.classId })

/** GET /leaderboard/:classId 查询参数 */
const leaderboardQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
})

/** GET /audio/:recitationId 与 DELETE /:recitationId 路径参数 */
const recitationIdParamsSchema = z.object({ recitationId: schemas.id })

/** 排行榜条目 */
interface LeaderboardEntry {
    rank: number
    recitationId: string
    studentId: string
    /** 脱敏姓名，如"学生H01" */
    anonymousName: string
    poemId: string
    poemTitle: string
    poet: string
    /** 综合得分（三维加权） */
    overallScore: number
    pronunciationScore: number
    rhythmScore: number
    emotionScore: number
    createdAt: number
    aiGenerated: boolean
}

/** 朗读历史条目 */
interface HistoryEntry {
    id: string
    poemId: string
    poemTitle: string
    poet: string
    dynasty: string
    audioUrl: string | null
    transcript: string | null
    pronunciationScore: number | null
    rhythmScore: number | null
    emotionScore: number | null
    overallScore: number | null
    suggestion: string | null
    audioDurationSec: number | null
    createdAt: number
    aiGenerated: boolean
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 音频文件最大字节数（10MB） */
const MAX_AUDIO_SIZE = 10 * 1024 * 1024

/**
 * 朗读上传的路由级 multipart 边界。合法请求只有：
 * - 1 个名为 file 的文件；
 * - 1 个 poemId；
 * - 0 或 1 个 studentId。
 *
 * 不能只依赖 multipart 插件的全局 fileSize：默认 parts 上限为 1000，
 * 会让单次请求反复分配大量近 10MB Buffer。
 */
const ASR_MULTIPART_LIMITS = {
    files: 1,
    fields: 2,
    parts: 3,
    fileSize: MAX_AUDIO_SIZE,
    fieldNameSize: 32,
    fieldSize: 128,
    headerPairs: 32,
} as const

const MULTIPART_LIMIT_ERROR_CODES = new Set([
    'FST_PARTS_LIMIT',
    'FST_FILES_LIMIT',
    'FST_FIELDS_LIMIT',
    'FST_REQ_FILE_TOO_LARGE',
])

/** 允许的音频 MIME 类型 */
const ALLOWED_AUDIO_TYPES = new Set([
    'audio/webm', 'audio/wav', 'audio/mpeg', 'audio/mp3',
    'audio/ogg', 'audio/aac', 'audio/x-wav', 'audio/wave',
])

/** TTS 缓存上限（条目数），超出按 LRU 淘汰 */
const TTS_CACHE_MAX = 200

/** 综合得分权重（发音 0.4 / 节奏 0.3 / 情感 0.3） */
const SCORE_WEIGHTS = { pronunciation: 0.4, rhythm: 0.3, emotion: 0.3 }

// ─────────────────────────────────────────────────────────────
// 音频存储目录
// ─────────────────────────────────────────────────────────────

/** 音频存储根目录：APP_DATA_DIR/audio（本地默认 ./data/audio）。 */
const AUDIO_DIR = config.runtimePaths.audioDir
const TTS_DIR = config.runtimePaths.ttsAudioDir
const RECITATIONS_DIR = config.runtimePaths.recitationsAudioDir

/** 确保音频目录存在（幂等） */
async function ensureAudioDirs(): Promise<void> {
    if (!existsSync(TTS_DIR)) await mkdir(TTS_DIR, { recursive: true })
    if (!existsSync(RECITATIONS_DIR)) await mkdir(RECITATIONS_DIR, { recursive: true })
}

function isPathInside(directory: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(directory), path.resolve(candidate))
    return relative.length > 0
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative)
}

// ─────────────────────────────────────────────────────────────
// TTS 缓存（内存 + 文件持久）
// ─────────────────────────────────────────────────────────────

interface TTSCacheEntry {
    poemId: string
    voice: string
    audioUrl: string
    filePath: string
    durationMs: number
    createdAt: number
}

/** TTS 缓存：key = `${poemId}:${voice}` */
const ttsCache = new SqliteMap<string, TTSCacheEntry>({
    table: 'recitation_tts_cache',
    indexes: [{ name: 'poem_id', extract: (value) => value.poemId }],
})

/** TTS 缓存淘汰（FIFO，超限删最早） */
async function trimTTSCache(): Promise<string[]> {
    if (ttsCache.size <= TTS_CACHE_MAX) return []
    const sorted = Array.from(ttsCache.entries()).sort(
        (a, b) => a[1].createdAt - b[1].createdAt,
    )
    const toRemove = sorted.slice(0, ttsCache.size - TTS_CACHE_MAX)
    const failures: string[] = []
    for (const [key, entry] of toRemove) {
        try {
            if (!isPathInside(TTS_DIR, entry.filePath)) {
                failures.push(entry.filePath)
                continue
            }
            if (existsSync(entry.filePath)) await unlink(entry.filePath)
            ttsCache.delete(key)
        } catch {
            // 保留元数据，下一次生成时可重试清理，避免文件变成不可追踪的孤儿。
            failures.push(entry.filePath)
        }
    }
    return failures
}

// ─────────────────────────────────────────────────────────────
// 朗读评测中间结果缓存（transcribe → evaluate 流程衔接）
// ─────────────────────────────────────────────────────────────

interface AsrIntermediateResult {
    /** 上传时已认证的教师；不得由 multipart 或 evaluate 请求体提供。 */
    teacherId: string
    /** 上传时声明的学生，evaluate 必须逐字匹配。空串表示仅转写、不可评测。 */
    studentId: string
    /** 上传时声明的古诗，evaluate 必须逐字匹配。 */
    poemId: string
    transcript: string
    audioDurationSec: number
    /** 魔数校验通过后的规范 MIME，用于重启后再次校验磁盘内容。 */
    contentType: string
    /** 同进程内可选；持久化时不写入大 Buffer，重启后从 audioFilePath 恢复 */
    audioBuffer?: Buffer
    audioFilePath: string
    audioUrl: string
    createdAt: number
}

/** ASR 中间结果缓存：key = audioUrl */
const asrIntermediate = new SqliteMap<string, AsrIntermediateResult>({
    table: 'recitation_asr_intermediate',
    serialize: (value) => JSON.stringify({
        ...value,
        audioBuffer: undefined,
    }),
})

/** 中间结果保留 10 分钟 */
const ASR_INTERMEDIATE_TTL_MS = 10 * 60 * 1000
const ASR_INTERMEDIATE_MAX = 100

interface AsrCleanupLogger {
    warn: (bindings: Record<string, unknown>, message: string) => void
}

class AsrIntermediateAlreadyConsumedError extends Error {
    constructor() {
        super('ASR intermediate result was already consumed')
        this.name = 'AsrIntermediateAlreadyConsumedError'
    }
}

function isMultipartLimitError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) return false
    return MULTIPART_LIMIT_ERROR_CODES.has(String(error.code))
}

/**
 * 清理过期/超量的 ASR 中间结果。音频文件与 SQLite 元数据必须作为同一隐私单元：
 * 只有文件已不存在或成功删除后才能移除元数据；删除失败时保留记录供下次重试。
 */
async function pruneAsrIntermediate(log: AsrCleanupLogger): Promise<number> {
    const now = Date.now()
    let cleanupFailures = 0
    const removeEntry = async (key: string, val: AsrIntermediateResult): Promise<void> => {
        try {
            if (!isPathInside(RECITATIONS_DIR, val.audioFilePath)) {
                throw new Error('ASR 中间音频路径超出受控目录')
            }
            if (existsSync(val.audioFilePath)) await unlink(val.audioFilePath)
            asrIntermediate.delete(key)
        } catch (error) {
            cleanupFailures += 1
            log.warn(
                { err: error, audioUrl: val.audioUrl },
                '[recitation] ASR 中间音频清理失败，元数据已保留供后续重试',
            )
        }
    }

    const entries = Array.from(asrIntermediate.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt)
    for (const [key, val] of entries) {
        if (now - val.createdAt > ASR_INTERMEDIATE_TTL_MS) await removeEntry(key, val)
    }

    // 为当前即将写入的中间结果预留一个位置；不使用 SqliteMap 的内部自动淘汰，
    // 因为它只能删除元数据，无法同步清理磁盘音频。
    const remaining = Array.from(asrIntermediate.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt)
    const overflow = Math.max(0, remaining.length - (ASR_INTERMEDIATE_MAX - 1))
    for (const [key, val] of remaining.slice(0, overflow)) await removeEntry(key, val)
    return cleanupFailures
}

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

export const recitationRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    await ensureAudioDirs()

    // ── GET /poems — 获取可朗读的诗列表 ──
    app.get('/poems', async (req: FastifyRequest, reply) => {
        const query = validateQuery(poemsQuerySchema, req, reply)
        if (!query) return
        const studentId = query.studentId

        try {
            const poems = repos.poems.findAll(200, 0)

            // 若提供 studentId，标注已朗读状态
            let recitedPoemIds = new Set<string>()
            if (studentId) {
                try {
                    const records = repos.recitations.findByStudentId(studentId)
                    recitedPoemIds = new Set(records.map((r) => r.poemId))
                } catch {
                    // 查询失败不影响主流程
                }
            }

            const result: RecitationPoemOption[] = poems.map((p) => {
                const ttsKey = `${p.id}:alloy`
                const cached = ttsCache.get(ttsKey)
                return {
                    id: p.id,
                    title: p.title,
                    poet: p.poet,
                    dynasty: p.dynasty,
                    content: p.content,
                    // 题材与修辞是教材人工校订数据，随列表一并下发。
                    // 前端此前只能靠标题/正文的关键字子串去"猜"体裁，
                    // 猜出过《元日》→送别（因"春风送暖"）、《暮江吟》→边塞（因"月似弓"）
                    // 这类明显错误的标签。有权威字段就不该再猜。
                    theme: p.theme,
                    rhetoric: p.rhetoric,
                    gradeLevel: p.gradeLevel ?? undefined,
                    recitedByStudent: recitedPoemIds.has(p.id),
                    ttsAudioUrl: normalizeProtectedAudioUrl(cached?.audioUrl) ?? undefined,
                }
            })

            return reply.send({
                status: 'ok',
                poems: result,
            })
        } catch (err) {
            req.log.error({ err }, '[recitation] 获取诗列表失败')
            return reply.status(500).send({
                status: 'error',
                message: '获取诗列表失败',
            })
        }
    })

    // ── POST /tts/generate — 生成标准范读 ──
    app.post('/tts/generate', async (req: FastifyRequest, reply) => {
        const body = validateBody(ttsGenerateSchema, req, reply)
        if (!body) return
        const { poemId, voice = 'alloy', speed = 0.9, format = 'mp3' } = body

        const poem = repos.poems.findById(poemId)
        if (!poem) {
            return reply.status(404).send({ status: 'error', message: '古诗不存在' })
        }

        // 缓存命中检查
        const cacheKey = `${poemId}:${voice}`
        const cached = ttsCache.get(cacheKey)
        const cachedAudioUrl = normalizeProtectedAudioUrl(cached?.audioUrl)
        if (cached && cachedAudioUrl && existsSync(cached.filePath)) {
            if (cached.audioUrl !== cachedAudioUrl) {
                ttsCache.set(cacheKey, { ...cached, audioUrl: cachedAudioUrl })
            }
            return reply.send({
                status: 'ok',
                audioUrl: cachedAudioUrl,
                durationMs: cached.durationMs,
                cached: true,
                aiGenerated: true,
            })
        }

        // 调用 eye.tts 生成范读
        const ctx = buildAgentContext(`tts-${poemId}`)
        const ttsInput: TtsInput = {
            text: poem.content,
            voice,
            speed,
            format,
        }

        try {
            const result = await eyeAgent.tts.invoke(ttsInput, ctx)
            const audio = result.output.audio
            const ext = format === 'wav' ? 'wav' : format === 'opus' ? 'opus' : 'mp3'
            const fileName = `tts_${poemId}_${voice}.${ext}`
            const filePath = path.join(TTS_DIR, fileName)
            await writeFile(filePath, audio)

            const audioUrl = `/api/recitation/audio/tts/${fileName}`
            const entry: TTSCacheEntry = {
                poemId,
                voice,
                audioUrl,
                filePath,
                durationMs: result.output.durationMs,
                createdAt: Date.now(),
            }
            ttsCache.set(cacheKey, entry)
            const cleanupFailures = await trimTTSCache()
            if (cleanupFailures.length > 0) {
                req.log.warn({ failedCount: cleanupFailures.length }, '[recitation] TTS 缓存文件清理失败，已保留元数据供重试')
            }

            req.log.info({ poemId, voice, audioUrl }, '[recitation] TTS 范读已生成')

            return reply.send({
                status: 'ok',
                audioUrl,
                durationMs: result.output.durationMs,
                cached: false,
                aiGenerated: true,
            })
        } catch (err) {
            req.log.error({ err, poemId }, '[recitation] TTS 生成失败')
            return reply.status(502).send({
                status: 'error',
                message: '范读生成失败，请稍后重试',
                aiGenerated: true,
            })
        }
    })

    // ── POST /asr/transcribe — 上传朗读音频并转写 ──
    app.post('/asr/transcribe', async (req: FastifyRequest, reply) => {
        const teacherId = req.auth?.id
        if (!teacherId) {
            return reply.status(401).send({
                status: 'error',
                error: 'AUTHENTICATION_REQUIRED',
                message: '请先登录后再上传朗读音频',
            })
        }

        // 解析 multipart 表单：file + poemId + studentId?
        const parts = req.parts({ limits: ASR_MULTIPART_LIMITS })
        let audioBuffer: Buffer | null = null
        let mimetype = 'audio/webm'
        let poemId = ''
        let studentId = ''
        let fileCount = 0
        let formError: string | null = null
        let fieldLimitExceeded = false
        const seenFields = new Set<string>()

        try {
            for await (const part of parts) {
                if (part.type === 'file') {
                    fileCount += 1
                    if (part.fieldname !== 'file') {
                        part.file.resume()
                        formError ??= '音频文件字段必须命名为 file'
                        continue
                    }
                    if (!ALLOWED_AUDIO_TYPES.has(part.mimetype)) {
                        part.file.resume()
                        formError ??= `不支持的音频类型: ${part.mimetype}，允许: webm/wav/mp3/ogg/aac`
                        continue
                    }
                    audioBuffer = await part.toBuffer()
                    if (part.file.truncated) {
                        fieldLimitExceeded = true
                        continue
                    }
                    mimetype = part.mimetype
                } else if (part.type === 'field') {
                    if (part.fieldnameTruncated || part.valueTruncated) {
                        fieldLimitExceeded = true
                        continue
                    }
                    if (part.fieldname !== 'poemId' && part.fieldname !== 'studentId') {
                        formError ??= `不支持的表单字段: ${part.fieldname}`
                        continue
                    }
                    if (seenFields.has(part.fieldname)) {
                        formError ??= `表单字段重复: ${part.fieldname}`
                        continue
                    }
                    seenFields.add(part.fieldname)
                    const val = String(part.value)
                    if (part.fieldname === 'poemId') poemId = val
                    else if (part.fieldname === 'studentId') studentId = val
                }
            }
        } catch (err) {
            const limited = isMultipartLimitError(err)
            req.log.warn({ err, limited }, '[recitation] 解析 multipart 失败')
            if (limited) {
                return reply.status(413).send({
                    status: 'error',
                    error: 'UPLOAD_LIMIT_EXCEEDED',
                    message: `朗读上传超出限制（仅允许 1 个文件、2 个字段，文件最大 ${MAX_AUDIO_SIZE} 字节）`,
                })
            }
            return reply.status(400).send({ status: 'error', message: '音频上传解析失败' })
        }

        if (fieldLimitExceeded) {
            return reply.status(413).send({
                status: 'error',
                error: 'UPLOAD_LIMIT_EXCEEDED',
                message: `朗读上传字段或文件超过限制（文件最大 ${MAX_AUDIO_SIZE} 字节）`,
            })
        }
        if (formError) {
            return reply.status(400).send({
                status: 'error',
                error: 'INVALID_MULTIPART_FORM',
                message: formError,
            })
        }

        if (fileCount !== 1 || !audioBuffer) {
            return reply.status(400).send({ status: 'error', message: '未收到音频文件' })
        }
        if (audioBuffer.byteLength > MAX_AUDIO_SIZE) {
            return reply.status(413).send({
                status: 'error',
                message: `音频文件超过最大限制 ${MAX_AUDIO_SIZE} 字节`,
            })
        }
        let inspectedAudio: ReturnType<typeof inspectAudioUpload>
        try {
            inspectedAudio = inspectAudioUpload(audioBuffer, mimetype)
        } catch (error) {
            return reply.status(400).send({
                status: 'error',
                error: 'INVALID_AUDIO',
                message: error instanceof Error ? error.message : '音频格式校验失败',
            })
        }

        // 校验 multipart 表单字段（B6.3 输入校验）
        const fields = asrTranscribeFieldsSchema.safeParse({
            poemId,
            ...(studentId ? { studentId } : {}),
        })
        if (!fields.success) {
            return reply.status(400).send({
                status: 'error',
                error: 'VALIDATION_ERROR',
                message: '表单字段校验失败',
                details: fields.error.issues.map((issue) => ({
                    field: issue.path.join('.') || '(root)',
                    message: issue.message,
                })),
            })
        }
        poemId = fields.data.poemId
        studentId = fields.data.studentId ?? ''

        const poem = repos.poems.findById(poemId)
        if (!poem) {
            return reply.status(404).send({ status: 'error', message: '古诗不存在' })
        }
        if (studentId && !repos.students.findById(studentId)) {
            return reply.status(404).send({
                status: 'error',
                error: 'STUDENT_NOT_FOUND',
                message: '学生不存在',
            })
        }

        // 所有请求结构、魔数和实体引用均已通过后，才允许触碰缓存和磁盘。
        await pruneAsrIntermediate(req.log)

        // 保存音频文件到磁盘
        const fileId = generateId()
        const savedFilename = `rec_audio_${fileId}.${inspectedAudio.extension}`
        const filePath = path.join(RECITATIONS_DIR, savedFilename)
        try {
            await writeFile(filePath, audioBuffer)
        } catch (err) {
            req.log.error({ err, fileId }, '[recitation] 朗读音频写入失败')
            try {
                if (existsSync(filePath)) await unlink(filePath)
            } catch (cleanupError) {
                req.log.error({ err: cleanupError, fileId }, '[recitation] 写入失败后的音频清理失败')
            }
            return reply.status(503).send({
                status: 'error',
                error: 'AUDIO_STORAGE_UNAVAILABLE',
                message: '朗读音频暂时无法保存，请稍后重试',
                retryable: true,
            })
        }
        const audioUrl = `/api/recitation/audio/recitations/${savedFilename}`

        // 调用 eye.asr 转写（AsrSubAgent 同时完成评估，此处仅取 transcript）
        const ctx = buildAgentContext(`asr-${poemId}`)
        const asrInput: AsrInput = {
            audio: audioBuffer,
            poemId,
            expectedText: poem.content,
        }

        try {
            const result = await eyeAgent.asr.invoke(asrInput, ctx)
            const output: AsrOutput = result.output

            // 缓存中间结果，供 /evaluate 端点复用（避免二次 ASR）
            asrIntermediate.set(audioUrl, {
                teacherId,
                studentId,
                poemId,
                transcript: output.transcript,
                audioDurationSec: output.audioDurationSec,
                contentType: inspectedAudio.contentType,
                audioBuffer,
                audioFilePath: filePath,
                audioUrl,
                createdAt: Date.now(),
            })

            req.log.info(
                { poemId, studentId, audioUrl, duration: output.audioDurationSec },
                '[recitation] ASR 转写完成',
            )

            return reply.send({
                status: 'ok',
                audioUrl,
                transcript: output.transcript,
                audioDurationSec: output.audioDurationSec,
                aiGenerated: true,
            })
        } catch (err) {
            req.log.error({ err, poemId }, '[recitation] ASR 转写失败')
            // 转写失败时没有可继续衔接的中间记录，删除刚保存的音频，避免成为孤儿隐私文件。
            try {
                if (existsSync(filePath)) await unlink(filePath)
            } catch (cleanupError) {
                req.log.error({ err: cleanupError, fileId }, '[recitation] ASR 失败后的音频清理失败')
            }
            return reply.status(502).send({
                status: 'error',
                message: '语音识别失败，请稍后重试',
                retryable: true,
            })
        }
    })

    // ── POST /evaluate — 评估朗读三维得分 ──
    app.post('/evaluate', async (req: FastifyRequest, reply) => {
        const teacherId = req.auth?.id
        if (!teacherId) {
            return reply.status(401).send({
                status: 'error',
                error: 'AUTHENTICATION_REQUIRED',
                message: '请先登录后再评估朗读',
            })
        }
        const body = validateBody(evaluateSchema, req, reply)
        if (!body) return
        const { studentId, poemId, audioUrl } = body
        const normalizedAudioUrl = normalizeProtectedAudioUrl(audioUrl)
        if (!normalizedAudioUrl?.startsWith('/api/recitation/audio/recitations/')) {
            return reply.status(400).send({
                status: 'error',
                error: 'INVALID_AUDIO_REFERENCE',
                message: '朗读音频引用无效',
            })
        }

        const poem = repos.poems.findById(poemId)
        if (!poem) {
            return reply.status(404).send({ status: 'error', message: '古诗不存在' })
        }
        const student = repos.students.findById(studentId)
        if (!student) {
            return reply.status(404).send({
                status: 'error',
                error: 'STUDENT_NOT_FOUND',
                message: '学生不存在',
            })
        }

        const legacyAudioUrl = normalizedAudioUrl.replace('/api/recitation', '')
        const cachedKey = [audioUrl, normalizedAudioUrl, legacyAudioUrl]
            .find((key) => asrIntermediate.has(key))
        const cached = cachedKey ? asrIntermediate.get(cachedKey) : undefined
        if (!cachedKey || !cached) {
            return reply.status(410).send({
                status: 'error',
                error: 'ASR_INTERMEDIATE_UNAVAILABLE',
                message: '朗读转写结果已过期或已完成评估，请重新录制',
            })
        }
        if (typeof cached.createdAt !== 'number'
            || Date.now() - cached.createdAt > ASR_INTERMEDIATE_TTL_MS) {
            return reply.status(410).send({
                status: 'error',
                error: 'ASR_INTERMEDIATE_EXPIRED',
                message: '朗读转写结果已过期，请重新录制',
            })
        }
        if (cached.teacherId !== teacherId
            || cached.studentId !== studentId
            || cached.poemId !== poemId
            || normalizeProtectedAudioUrl(cached.audioUrl) !== normalizedAudioUrl) {
            return reply.status(403).send({
                status: 'error',
                error: 'ASR_BINDING_MISMATCH',
                message: '朗读音频与当前教师、学生或古诗不匹配',
            })
        }

        // 尝试复用 ASR 中间结果（避免重复调用）
        let pronunciation = 0
        let rhythm = 0
        let emotion = 0
        let finalTranscript = cached.transcript
        let durationSec = cached.audioDurationSec
        let mistakes: unknown[] = []
        let suggestion = ''
        let audioBuffer: Buffer | null = null
        let aiGenerated = true

        // 复用缓存的 ASR 结果，重新调用评估阶段。缓存既是绑定元数据，
        // 也是一次性能力令牌；不存在缓存时不得仅凭可猜测 URL 读取文件评测。
        if (cached.audioBuffer) {
            audioBuffer = cached.audioBuffer
        } else if (cached.audioFilePath
            && isPathInside(RECITATIONS_DIR, cached.audioFilePath)
            && existsSync(cached.audioFilePath)) {
            try {
                audioBuffer = await readFile(cached.audioFilePath)
            } catch {
                audioBuffer = null
            }
        }

        if (!audioBuffer) {
            return reply.status(410).send({
                status: 'error',
                error: 'AUDIO_FILE_UNAVAILABLE',
                message: '朗读音频已过期或不存在，请重新录制',
            })
        }
        try {
            inspectAudioUpload(audioBuffer, cached.contentType)
        } catch {
            return reply.status(410).send({
                status: 'error',
                error: 'AUDIO_FILE_INVALID',
                message: '朗读音频内容已损坏，请重新录制',
            })
        }

        // 调用 eye.asr 完整流程（含评估）—— 若有缓存则仍需评估
        // AsrSubAgent 内部使用 deepseek-v4-flash 完成三维评分
        const ctx = buildAgentContext(`eval-${poemId}`)
        const asrInput: AsrInput = {
            audio: audioBuffer,
            poemId,
            expectedText: poem.content,
        }

        try {
            const result = await eyeAgent.asr.invoke(asrInput, ctx)
            const output: AsrOutput = result.output
            pronunciation = output.pronunciation
            rhythm = output.rhythm
            emotion = output.emotion
            mistakes = output.mistakes
            suggestion = output.suggestion
            finalTranscript = finalTranscript || output.transcript
            durationSec = durationSec || output.audioDurationSec
        } catch (err) {
            req.log.error({ err, poemId }, '[recitation] 评估失败，降级为统计型评分')
            aiGenerated = false
            // 降级：基于文本相似度粗略评分
            const similarity = computeTextSimilarity(finalTranscript, poem.content)
            pronunciation = Math.round(similarity * 100)
            rhythm = Math.round(similarity * 80 + 20)
            emotion = Math.round(similarity * 60 + 30)
            mistakes = []
            suggestion = '语音评估服务暂不可用，已根据文本匹配给出参考分数，建议稍后重试。'
        }

        const overallScore = computeOverallScore(pronunciation, rhythm, emotion)

        // 持久化朗读记录到数据库
        let recitationId: string
        try {
            const persistAndConsume = db.transaction(() => {
                const created = repos.recitations.create({
                    studentId,
                    poemId,
                    audioUrl: normalizedAudioUrl,
                    transcript: finalTranscript,
                    pronunciationScore: pronunciation,
                    rhythmScore: rhythm,
                    emotionScore: emotion,
                    mistakes,
                    suggestion,
                    audioDurationSec: durationSec,
                    aiGenerated,
                })
                if (!asrIntermediate.delete(cachedKey)) {
                    throw new AsrIntermediateAlreadyConsumedError()
                }
                return created
            })
            const created = persistAndConsume()
            recitationId = created.id
        } catch (err) {
            if (err instanceof AsrIntermediateAlreadyConsumedError) {
                return reply.status(409).send({
                    status: 'error',
                    error: 'ASR_INTERMEDIATE_ALREADY_CONSUMED',
                    message: '该朗读已经完成评估，请勿重复提交',
                })
            }
            req.log.error({ err }, '[recitation] 朗读记录持久化失败，中间结果已保留')
            return reply.status(503).send({
                status: 'error',
                error: 'RECITATION_PERSISTENCE_FAILED',
                message: '朗读结果暂时无法保存，请稍后重试',
                retryable: true,
            })
        }

        req.log.info(
            { recitationId, studentId, poemId, overallScore },
            '[recitation] 朗读评估完成',
        )

        return reply.send({
            status: 'ok',
            recitationId,
            transcript: finalTranscript,
            pronunciation,
            rhythm,
            emotion,
            overallScore,
            mistakes,
            suggestion,
            audioDurationSec: durationSec,
            aiGenerated,
        })
    })

    // ── GET /history/:studentId — 学生朗读历史 ──
    app.get('/history/:studentId', async (req: FastifyRequest, reply) => {
        const params = validateParams(studentIdParamsSchema, req, reply)
        if (!params) return
        const { studentId } = params

        try {
            const records = repos.recitations.findByStudentId(studentId)
            const history: HistoryEntry[] = records.map((r) => enrichHistoryEntry(r))

            return reply.send({
                status: 'ok',
                history,
            })
        } catch (err) {
            req.log.error({ err, studentId }, '[recitation] 查询朗读历史失败')
            return reply.status(500).send({ status: 'error', message: '查询朗读历史失败' })
        }
    })

    // ── GET /leaderboard/:classId — 班级朗读排行榜 ──
    app.get('/leaderboard/:classId', async (req: FastifyRequest, reply) => {
        const params = validateParams(leaderboardParamsSchema, req, reply)
        if (!params) return
        const { classId } = params
        const query = validateQuery(leaderboardQuerySchema, req, reply)
        if (!query) return
        const limit = query.limit ?? 50

        try {
            // 联表查询：recitations + students + poems
            const rows = db
                .prepare(`
                    SELECT
                        r.id            AS recitation_id,
                        r.student_id    AS student_id,
                        s.anonymous_name AS anonymous_name,
                        r.poem_id       AS poem_id,
                        p.title         AS poem_title,
                        p.poet          AS poet,
                        r.pronunciation_score AS pronunciation_score,
                        r.rhythm_score       AS rhythm_score,
                        r.emotion_score      AS emotion_score,
                        r.ai_generated       AS ai_generated,
                        r.created_at    AS created_at
                    FROM recitations r
                    JOIN students s ON r.student_id = s.id
                    JOIN poems p ON r.poem_id = p.id
                    WHERE s.class_id = ?
                    ORDER BY (COALESCE(r.pronunciation_score,0)*0.4
                            + COALESCE(r.rhythm_score,0)*0.3
                            + COALESCE(r.emotion_score,0)*0.3) DESC
                    LIMIT ?
                `)
                .all(classId, limit) as Array<{
                    recitation_id: string
                    student_id: string
                    anonymous_name: string
                    poem_id: string
                    poem_title: string
                    poet: string
                    pronunciation_score: number | null
                    rhythm_score: number | null
                    emotion_score: number | null
                    ai_generated: number
                    created_at: number
                }>

            const leaderboard: LeaderboardEntry[] = rows.map((row, idx) => ({
                rank: idx + 1,
                recitationId: row.recitation_id,
                studentId: row.student_id,
                anonymousName: row.anonymous_name || anonymizeName(row.student_id),
                poemId: row.poem_id,
                poemTitle: row.poem_title,
                poet: row.poet,
                overallScore: computeOverallScore(
                    row.pronunciation_score ?? 0,
                    row.rhythm_score ?? 0,
                    row.emotion_score ?? 0,
                ),
                pronunciationScore: row.pronunciation_score ?? 0,
                rhythmScore: row.rhythm_score ?? 0,
                emotionScore: row.emotion_score ?? 0,
                createdAt: row.created_at,
                aiGenerated: row.ai_generated === 1,
            }))

            return reply.send({
                status: 'ok',
                leaderboard,
                aiGenerated: leaderboard.some((entry) => entry.aiGenerated),
            })
        } catch (err) {
            req.log.error({ err, classId }, '[recitation] 查询朗读排行榜失败')
            return reply.status(500).send({ status: 'error', message: '查询朗读排行榜失败' })
        }
    })

    // ── GET /audio/:recitationId — 获取指定朗读音频（学生原音 + 范读对比） ──
    app.get('/audio/:recitationId', async (req: FastifyRequest, reply) => {
        const params = validateParams(recitationIdParamsSchema, req, reply)
        if (!params) return
        const { recitationId } = params

        try {
            const record = repos.recitations.findById(recitationId)
            if (!record) {
                return reply.status(404).send({ status: 'error', message: '朗读记录不存在' })
            }

            // 获取对应的范读
            const ttsKey = `${record.poemId}:alloy`
            const cachedTts = ttsCache.get(ttsKey)

            return reply.send({
                status: 'ok',
                recitationId,
                studentAudioUrl: normalizeProtectedAudioUrl(record.audioUrl),
                ttsAudioUrl: normalizeProtectedAudioUrl(cachedTts?.audioUrl),
                transcript: record.transcript,
                poemId: record.poemId,
            })
        } catch (err) {
            req.log.error({ err, recitationId }, '[recitation] 查询朗读音频失败')
            return reply.status(500).send({ status: 'error', message: '查询朗读音频失败' })
        }
    })

    // ── DELETE /:recitationId — 删除朗读记录 ──
    app.delete('/:recitationId', async (req: FastifyRequest, reply) => {
        const params = validateParams(recitationIdParamsSchema, req, reply)
        if (!params) return
        const { recitationId } = params

        try {
            const record = repos.recitations.findById(recitationId)
            if (!record) {
                return reply.status(404).send({ status: 'error', message: '朗读记录不存在' })
            }

            // 文件删除失败时保留数据库记录，避免形成不可追踪的孤儿隐私文件。
            if (record.audioUrl) {
                const normalizedAudioUrl = normalizeProtectedAudioUrl(record.audioUrl)
                if (normalizedAudioUrl?.startsWith('/api/recitation/audio/recitations/')) {
                    const fileName = path.basename(normalizedAudioUrl)
                    const filePath = path.resolve(RECITATIONS_DIR, fileName)
                    if (isPathInside(RECITATIONS_DIR, filePath) && existsSync(filePath)) {
                        try {
                            await unlink(filePath)
                        } catch (cleanupError) {
                            req.log.error({ err: cleanupError, recitationId }, '[recitation] 朗读音频删除失败，已保留记录供重试')
                            return reply.status(500).send({
                                status: 'error',
                                error: 'AUDIO_FILE_CLEANUP_FAILED',
                                message: '音频文件暂时无法删除，记录已保留，请关闭占用程序后重试',
                            })
                        }
                    }
                } else {
                    req.log.warn({ recitationId }, '[recitation] 记录包含非受控音频引用，仅删除元数据')
                }
            }

            repos.recitations.delete(recitationId)
            req.log.info({ recitationId }, '[recitation] 朗读记录已删除')

            return reply.send({
                status: 'ok',
                recitationId,
                deleted: true,
            })
        } catch (err) {
            req.log.error({ err, recitationId }, '[recitation] 删除朗读记录失败')
            return reply.status(500).send({ status: 'error', message: '删除朗读记录失败' })
        }
    })

    // ── 受认证文件服务：/audio/* → APP_DATA_DIR/audio/ ──
    app.get('/audio/*', async (req: FastifyRequest<{ Params: { '*': string } }>, reply) => {
        const requestedPath = req.params['*']
        const normalizedAudioUrl = normalizeProtectedAudioUrl(`/audio/${requestedPath}`)
        if (!normalizedAudioUrl) {
            return reply.status(400).send({ status: 'error', message: '非法音频引用' })
        }
        const protectedRelativePath = normalizedAudioUrl.replace('/api/recitation/audio/', '')
        const filePath = path.resolve(AUDIO_DIR, protectedRelativePath)
        const relativePath = path.relative(AUDIO_DIR, filePath)
        if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
            return reply.status(400).send({ status: 'error', message: '非法路径' })
        }
        if (!existsSync(filePath)) {
            return reply.status(404).send({ status: 'error', message: '音频文件不存在' })
        }

        try {
            const buffer = await readFile(filePath)
            const ext = path.extname(filePath).toLowerCase()
            const mimeType = ext === '.mp3' ? 'audio/mpeg'
                : ext === '.wav' ? 'audio/wav'
                : ext === '.webm' ? 'audio/webm'
                : ext === '.opus' ? 'audio/ogg'
                : ext === '.aac' ? 'audio/aac'
                : 'application/octet-stream'

            reply.header('Content-Type', mimeType)
            reply.header(
                'Cache-Control',
                relativePath.startsWith(`recitations${path.sep}`)
                    ? 'private, no-store'
                    : 'public, max-age=86400',
            )
            return reply.send(buffer)
        } catch (err) {
            req.log.error({ err, filePath }, '[recitation] 读取音频文件失败')
            return reply.status(500).send({ status: 'error', message: '读取音频文件失败' })
        }
    })
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

/** 构建 AgentContext（最小集合） */
function buildAgentContext(taskId: string): AgentContext {
    return {
        taskId,
        sessionId: `recitation-${taskId}`,
    }
}

/** 计算综合得分（三维加权） */
function computeOverallScore(pronunciation: number, rhythm: number, emotion: number): number {
    return Math.round(
        pronunciation * SCORE_WEIGHTS.pronunciation
        + rhythm * SCORE_WEIGHTS.rhythm
        + emotion * SCORE_WEIGHTS.emotion,
    )
}

/**
 * 计算文本相似度（基于字符级 Jaccard 系数）
 * 用于 ASR 失败时的降级评分
 */
function computeTextSimilarity(a: string, b: string): number {
    if (!a || !b) return 0
    const setA = new Set(a.replace(/[\s\p{P}]/gu, '').split(''))
    const setB = new Set(b.replace(/[\s\p{P}]/gu, '').split(''))
    const intersection = new Set([...setA].filter((x) => setB.has(x)))
    const union = new Set([...setA, ...setB])
    return union.size === 0 ? 0 : intersection.size / union.size
}

/** 学生姓名脱敏（兜底：当 anonymous_name 缺失时） */
function anonymizeName(studentId: string): string {
    const hash = studentId.split('').reduce((acc, c) => {
        return ((acc << 5) - acc + c.charCodeAt(0)) | 0
    }, 0)
    const code = Math.abs(hash % 99) + 1
    const letter = String.fromCharCode(65 + (Math.abs(hash) % 26))
    return `学生${letter}${String(code).padStart(2, '0')}`
}

/** 朗读记录 → 历史条目（联表诗信息） */
function enrichHistoryEntry(record: RecitationEntity): HistoryEntry {
    let poemTitle = '未知诗名'
    let poet = '未知诗人'
    let dynasty = ''
    try {
        const poem = repos.poems.findById(record.poemId)
        if (poem) {
            poemTitle = poem.title
            poet = poem.poet
            dynasty = poem.dynasty
        }
    } catch {
        // 查询失败用默认值
    }

    const overall = record.pronunciationScore !== null
        && record.rhythmScore !== null
        && record.emotionScore !== null
        ? computeOverallScore(record.pronunciationScore, record.rhythmScore, record.emotionScore)
        : null

    return {
        id: record.id,
        poemId: record.poemId,
        poemTitle,
        poet,
        dynasty,
        audioUrl: normalizeProtectedAudioUrl(record.audioUrl),
        transcript: record.transcript,
        pronunciationScore: record.pronunciationScore,
        rhythmScore: record.rhythmScore,
        emotionScore: record.emotionScore,
        overallScore: overall,
        suggestion: record.suggestion,
        audioDurationSec: record.audioDurationSec,
        createdAt: record.createdAt,
        aiGenerated: record.aiGenerated,
    }
}
