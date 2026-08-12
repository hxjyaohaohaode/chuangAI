/**
 * 统一 AI 能力接口（SubTask 14.2）
 *
 * 4 个端点：
 * - POST /image-generate  文生图（Wan2.7-Image，复用 services/culture/wan-image.ts）
 * - POST /tts              语音合成（mimo-v2.5-tts，限时免费）
 * - POST /asr              语音识别（mimo-v2.5-asr，multipart 文件上传）
 * - POST /chat             文本对话（deepseek-v4-pro/flash 或 mimo-v2.5/pro，支持 SSE 流式）
 *
 * 严格遵循规则：
 * - 仅使用 deepseek 系列 + mimo 系列大模型，绝不引入其他 LLM
 * - 真实调用底层 SDK（wan-image / mimo / deepseek）
 * - DEMO_MODE=true 时返回模拟数据但保持结构一致
 * - SSE 流式响应使用 reply.hijack() + reply.raw
 * - TypeScript 严格模式无 any
 * - 明确区分 DEMO 占位与真实调用失败；真实调用失败返回 500，不伪装成功
 *
 * 模型选择规则：
 * - 文生图：固定 Wan2.7-Image（阿里云百炼，非 LLM）
 * - TTS：固定 mimo-v2.5-tts
 * - ASR：固定 mimo-v2.5-asr
 * - 文本对话：默认 deepseek-v4-flash，可选 deepseek-v4-pro / mimo-v2.5 / mimo-v2.5-pro
 */

import type {
    FastifyInstance,
    FastifyPluginAsync,
    FastifyRequest,
    FastifyReply,
} from 'fastify'
import { randomUUID } from 'node:crypto'
import { handleRouteError } from './_helpers.js'
import { validateBody } from '../lib/validation.js'
import { z } from 'zod'
import { config } from '../config.js'
import { getKey, getWanImageBaseUrl } from '../lib/credentials.js'
import { inspectAudioUpload } from '../security/audio-upload-policy.js'
import {
    isProtectedGeneratedImageUrl,
    isSupportedInlineImageDataUrl,
    MAX_MODEL_INLINE_IMAGE_URL_CHARS,
} from '../security/image-reference-policy.js'
import { isTrustedProviderEndpoint } from '../security/provider-endpoint-policy.js'
import { managedLLM } from '../llm/index.js'
import { getOrCreateImage } from '../services/culture/image-cache.js'
import type { ChatMessage, ThinkingMode, TextThinkingMode } from '../llm/types.js'
import type {
    MimoTextModel,
    MimoTtsModel,
    MimoAsrModel,
} from '../llm/mimo-client.js'
import type { DeepSeekModel } from '../llm/deepseek-client.js'
import { bindSseDisconnectAbort, createPublicSseError, writeSseFrame } from '../lib/sse.js'

// ─────────────────────────────────────────────────────────────
// 类型与常量
// ─────────────────────────────────────────────────────────────

/** 文本对话支持的模型（联合类型，跨 deepseek 与 mimo） */
type ChatModel = DeepSeekModel | MimoTextModel

/** 模型所属家族 */
type ModelFamily = 'deepseek' | 'mimo'

const DEEPSEEK_MODELS: ReadonlySet<string> = new Set(['deepseek-v4-pro', 'deepseek-v4-flash'])
const MIMO_TEXT_MODELS: ReadonlySet<string> = new Set(['mimo-v2.5', 'mimo-v2.5-pro'])
const WAN_IMAGE_MODEL = 'wan2.7-image' as const
const MIMO_ASR_MODEL = 'mimo-v2.5-asr' as const
const LOCAL_PLACEHOLDER_MODEL = 'local-placeholder' as const

const AI_ASR_MULTIPART_LIMITS = {
    files: 1,
    fields: 4,
    parts: 5,
    fileSize: 10 * 1024 * 1024,
    fieldSize: 8 * 1024,
    headerPairs: 64,
} as const

const MULTIPART_LIMIT_ERROR_CODES = new Set([
    'FST_FILES_LIMIT',
    'FST_FIELDS_LIMIT',
    'FST_PARTS_LIMIT',
    'FST_REQ_FILE_TOO_LARGE',
    'FST_PROTO_VIOLATION',
])

/** 默认对话模型 */
const DEFAULT_CHAT_MODEL: ChatModel = 'deepseek-v4-flash'

/**
 * 唯一的多模态（可读图）模型
 *
 * 出处：《大模型API文档.md》第 37–38 行——
 * 「mimo-v2.5模型为多模态模型」「deepseek-v4-flash、deepseek-v4-pro、
 * mimo-v2.5-pro模型均为纯文本模型」。
 * 带图请求只能落到它，这是能力事实，不是偏好。
 */
const VISION_MODEL: ChatModel = 'mimo-v2.5'

// ─────────────────────────────────────────────────────────────
// Zod schemas
// ─────────────────────────────────────────────────────────────

/** POST /image-generate 请求体 */
const imageGenerateBodySchema = z.object({
    prompt: z.string().trim().min(1, '提示词不能为空').max(5000, '提示词长度不能超过 5000'),
    orientation: z.enum(['landscape', 'portrait']).default('landscape'),
    // 当前底层缓存服务一次只生成一张；多图由前端按不同诗句并发调用，
    // 拒绝把 n>1 静默降成一张，避免“请求四张、返回一张”的契约谎言。
    n: z.literal(1).default(1),
    poemId: z.string().trim().min(1).max(200).optional(),
    verse: z.string().trim().min(1).max(1000).optional(),
}).strict()

/** POST /tts 请求体 */
const ttsBodySchema = z.object({
    text: z.string().trim().min(1, '合成文本不能为空').max(4000, '文本长度不能超过 4000'),
    voice: z.string().trim().max(50).optional(),
    speed: z.number().min(0.5).max(2.0).optional(),
    responseFormat: z.enum(['mp3', 'wav']).default('mp3'),
})

/** POST /chat 请求体 */
/**
 * 消息内容：纯文本，或「文本 + 图片」的多模态片段数组
 *
 * LLM 层（llm/types.ts 的 ContentPart）本来就支持图片片段，
 * 但此前这个 schema 把 content 锁死成 `z.string()`，多模态能力
 * 被卡在 API 边界上进不来——AI 副驾因此只能收纯文字。
 *
 * 图片一律以 data URL 传入而非外链：模型侧要能自己取到图，
 * 而本机的 http://localhost/... 对云端模型是不可达的；
 * data URL 则把字节直接随请求带走，无需任何公网托管。
 */
const contentPartSchema = z.union([
    z.object({
        type: z.literal('text'),
        text: z.string().max(32000),
    }),
    z.object({
        type: z.literal('image_url'),
        image_url: z.object({
            // 只接受声明格式与文件魔数一致的 data URL；不允许外链或伪图片。
            url: z.string()
                .max(MAX_MODEL_INLINE_IMAGE_URL_CHARS)
                .refine(
                    isSupportedInlineImageDataUrl,
                    '图片必须是魔数匹配的 data:image/jpeg|png|webp;base64 内联图片',
                ),
            detail: z.enum(['auto', 'low', 'high']).optional(),
        }),
    }),
])

const chatBodySchema = z.object({
    messages: z.array(
        z.object({
            role: z.enum(['system', 'user', 'assistant', 'tool']),
            content: z.union([
                z.string().min(1).max(32000),
                z.array(contentPartSchema).min(1).max(12),
            ]),
            name: z.string().trim().max(80).optional(),
            tool_call_id: z.string().trim().max(80).optional(),
        }),
    ).min(1, 'messages 不能为空').max(100, 'messages 数量不能超过 100'),
    model: z.string().trim().default(DEFAULT_CHAT_MODEL),
    thinking: z.enum(['low', 'medium', 'high', 'max']).default('medium'),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(64000).optional(),
    stream: z.boolean().default(false),
}).superRefine((body, ctx) => {
    let totalImageChars = 0
    body.messages.forEach((message, messageIndex) => {
        if (!Array.isArray(message.content)) return
        message.content.forEach((part, partIndex) => {
            if (part.type !== 'image_url') return
            totalImageChars += part.image_url.url.length
            if (message.role !== 'user') {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['messages', messageIndex, 'content', partIndex],
                    message: '图片片段只能出现在 user 消息中',
                })
            }
        })
    })
    if (totalImageChars > 6_000_000) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['messages'],
            message: '单次对话内联图片总量不能超过 6,000,000 字符',
        })
    }
})

// ─────────────────────────────────────────────────────────────
// 响应类型
// ─────────────────────────────────────────────────────────────

type AiDegradationReason =
    | 'demo-mode'
    | 'provider-unavailable'
    | 'provider-noncompliant'
    | 'provider-failed'

/** 单张文生图结果；来源标记复制到图片级，避免列表展平后丢失真相。 */
interface GeneratedImageResponse {
    id: string
    url: string
    prompt: string
    verse?: string
    orientation: 'landscape' | 'portrait'
    model: string
    requestedModel: typeof WAN_IMAGE_MODEL
    createdAt: number
    cached: boolean
    aiGenerated: true
    demo: false
    degraded: false
}

/** 文生图响应 */
interface ImageGenerateResponse {
    status: 'ok'
    images: GeneratedImageResponse[]
    model: string
    requestedModel: typeof WAN_IMAGE_MODEL
    requestId?: string
    aiGenerated: true
    demo: false
    degraded: false
}

/** ASR 响应 */
interface AsrResponse {
    status: 'ok' | 'degraded'
    transcript: string
    audioDurationSec: number
    confidence?: number
    similarityScore?: number
    model: string
    requestedModel: typeof MIMO_ASR_MODEL
    aiGenerated: boolean
    demo: boolean
    degraded: boolean
    degradationReason?: AiDegradationReason
}

/** 文本对话响应（非流式） */
interface ChatResponse {
    content: string
    model: string
    latencyMs: number
    usage: {
        promptTokens: number
        completionTokens: number
    }
    demo: boolean
    /**
     * 服务端按能力自动改选了模型时的说明（未改选时不出现）
     *
     * 必须回传给前端并如实展示：用户选了 A 却实际由 B 作答，
     * 而界面仍显示 A，是把「模型是谁」这件事说错了。
     */
    autoRouted?: { from: string; to: string; reason: string }
}

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

export const aiRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    // ── 1. POST /image-generate — 文生图（Wan2.7-Image） ──
    app.post('/image-generate', async (req: FastifyRequest, reply) => {
        const body = validateBody(imageGenerateBodySchema, req, reply)
        if (!body) return
        const { prompt, orientation = 'landscape', verse } = body

        // 生图没有“本地占位成功”这一状态：只有真实 Wan WebP 才能返回 200。
        // 演示账号仍可使用随包的同诗实图；动态生图不可用时必须明确失败，
        // 不能再把 SVG 伪装成一张“生成结果”。
        if (config.demoMode) {
            return sendImageGenerationUnavailable(reply, 'demo-mode', true, 503)
        }

        // 密钥可能在设置页热更新，不能依赖启动时的 config.wanImage.enabled 快照。
        // WorkspaceId 无法安全猜测；端点或密钥缺失时明确失败，禁止造占位图。
        const wanApiKey = getKey('dashscope')
        const wanBaseUrl = getWanImageBaseUrl()
        if (!wanBaseUrl || !wanApiKey) {
            return sendImageGenerationUnavailable(reply, 'provider-unavailable', false, 503)
        }

        // 项目官方文件规定 Wan2.7 必须走 Workspace MaaS 北京同步端点，且模型固定
        // wan2.7-image。当前环境若仍指向全球 DashScope 或 pro 变体，路由失败关闭，
        // 直接失败关闭，避免“能出图但违反参赛规则”的隐性事故。
        const complianceIssue = getWanConfigComplianceIssue(config.wanImage.model, wanBaseUrl)
        if (complianceIssue) {
            req.log.error({ complianceIssue }, 'Wan2.7 配置不符合项目官方模型规则，已拒绝外呼')
            return sendImageGenerationUnavailable(reply, 'provider-noncompliant', false, 503)
        }

        try {
            // 走落盘缓存而非直接返回 wan2.7 的原始地址：
            // 那是带 Expires 签名的 OSS 临时链接（官方仅保留 24 小时），
            // 前端一旦把它存进本地记录/收藏，隔天就是一片 403 破图。
            // 落盘后对外只给本地静态路径，长期有效且可离线演示。
            const result = await getOrCreateImage(prompt, orientation)
            if (!result) {
                return sendImageGenerationUnavailable(reply, 'provider-failed', false, 502)
            }
            if (result.model !== WAN_IMAGE_MODEL || !isProtectedGeneratedImageUrl(result.url)) {
                req.log.error(
                    {
                        actualModel: result.model,
                        expectedModel: WAN_IMAGE_MODEL,
                        protectedLocalUrl: isProtectedGeneratedImageUrl(result.url),
                    },
                    '生图服务返回了非官方模型或未校验地址，已拒绝冒充成功',
                )
                return sendImageGenerationUnavailable(reply, 'provider-noncompliant', false, 502)
            }

            const createdAt = Date.now()
            const response: ImageGenerateResponse = {
                status: 'ok',
                images: [{
                    id: result.requestId || `wan-${randomUUID()}`,
                    url: result.url,
                    prompt,
                    ...(verse ? { verse } : {}),
                    orientation,
                    model: WAN_IMAGE_MODEL,
                    requestedModel: WAN_IMAGE_MODEL,
                    createdAt,
                    cached: result.cached,
                    aiGenerated: true,
                    demo: false,
                    degraded: false,
                }],
                model: WAN_IMAGE_MODEL,
                requestedModel: WAN_IMAGE_MODEL,
                ...(result.requestId ? { requestId: result.requestId } : {}),
                aiGenerated: true,
                demo: false,
                degraded: false,
            }
            return reply.send(response)
        } catch (err) {
            req.log.error({ err }, '文生图调用异常，已失败关闭且未生成占位图')
            return sendImageGenerationUnavailable(reply, 'provider-failed', false, 502)
        }
    })

    // ── 2. POST /tts — 语音合成（mimo-v2.5-tts） ──
    app.post('/tts', async (req: FastifyRequest, reply) => {
        const body = validateBody(ttsBodySchema, req, reply)
        if (!body) return
        const { text, voice, speed, responseFormat = 'mp3' } = body

        const ttsModel: MimoTtsModel = 'mimo-v2.5-tts'

        // DEMO 模式：始终返回一个可播放、且明确标记为演示占位的 WAV。
        // 不能把空字节伪装成 MP3/Opus，否则浏览器会把 200 响应当作损坏媒体。
        if (config.demoMode) {
            const silentAudio = generateSilentWav(text.length)
            reply.header('Content-Type', 'audio/wav')
            reply.header('X-Demo-Mode', 'true')
            reply.header('X-Requested-Format', responseFormat)
            reply.header('X-Actual-Format', 'wav')
            reply.header('X-Model', ttsModel)
            reply.header('X-Duration-Ms', String(silentAudio.durationMs))
            return reply.send(silentAudio.buffer)
        }

        try {
            const result = await managedLLM.tts({
                model: ttsModel,
                text,
                voice,
                speed,
                responseFormat,
                metadata: { agent: 'ai-routes', task: 'tts' },
            })

            reply.header('Content-Type', `audio/${result.format}`)
            reply.header('X-Model', ttsModel)
            reply.header('X-Duration-Ms', String(result.durationMs))
            return reply.send(result.audio)
        } catch (err) {
            handleRouteError(err, req, reply, '语音合成失败')
            return
        }
    })

    // ── 3. POST /asr — 语音识别（mimo-v2.5-asr，multipart 文件上传） ──
    app.post('/asr', async (req: FastifyRequest, reply) => {
        const asrModel: MimoAsrModel = MIMO_ASR_MODEL
        const parts = req.parts({ limits: AI_ASR_MULTIPART_LIMITS })
        let audioBuffer: Buffer | null = null
        let audioMimeType = ''
        let audioFilename: string | undefined
        let referenceText: string | undefined
        let language: 'zh' | 'en' | undefined
        let promptParam: string | undefined
        let formError: string | null = null
        let limitExceeded = false
        const seenFields = new Set<string>()

        try {
            for await (const part of parts) {
                if (part.type === 'file') {
                    if (part.fieldname !== 'file') {
                        part.file.resume()
                        formError ??= '音频文件字段必须命名为 file'
                        continue
                    }
                    audioBuffer = await part.toBuffer()
                    if (part.file.truncated) limitExceeded = true
                    audioMimeType = part.mimetype
                    audioFilename = part.filename
                    continue
                }

                if (part.fieldnameTruncated || part.valueTruncated) {
                    limitExceeded = true
                    continue
                }
                if (!['poemId', 'referenceText', 'language', 'prompt'].includes(part.fieldname)) {
                    formError ??= `不支持的表单字段: ${part.fieldname}`
                    continue
                }
                if (seenFields.has(part.fieldname)) {
                    formError ??= `表单字段重复: ${part.fieldname}`
                    continue
                }
                seenFields.add(part.fieldname)
                const value = String(part.value).trim()

                if (part.fieldname === 'poemId') {
                    if (!value || value.length > 200) formError ??= 'poemId 长度必须为 1-200'
                } else if (part.fieldname === 'referenceText') {
                    if (!value || value.length > 4000 || normalizeComparisonText(value).length === 0) {
                        formError ??= 'referenceText 必须包含文字或数字且长度不超过 4000'
                    }
                    else referenceText = value
                } else if (part.fieldname === 'language') {
                    if (value !== 'zh' && value !== 'en') formError ??= 'language 仅支持 zh 或 en'
                    else language = value
                } else if (part.fieldname === 'prompt') {
                    if (!value || value.length > 500) formError ??= 'prompt 长度必须为 1-500'
                    else promptParam = value
                }
            }
        } catch (err) {
            if (isMultipartLimitError(err)) {
                return reply.code(413).send({
                    status: 'error',
                    error: 'UPLOAD_LIMIT_EXCEEDED',
                    message: 'ASR 上传超出限制（1 个文件、4 个字段、文件最大 10MB）',
                })
            }
            req.log.warn({ err }, 'ASR multipart 解析失败')
            return reply.code(400).send({
                status: 'error',
                error: 'INVALID_MULTIPART',
                message: '音频上传解析失败',
            })
        }

        if (limitExceeded) {
            return reply.code(413).send({
                status: 'error',
                error: 'UPLOAD_LIMIT_EXCEEDED',
                message: 'ASR 上传字段或文件超出限制（文件最大 10MB）',
            })
        }
        if (formError) {
            return reply.code(400).send({
                status: 'error',
                error: 'VALIDATION_ERROR',
                message: formError,
            })
        }
        if (!audioBuffer) {
            return reply.code(400).send({
                status: 'error',
                error: 'VALIDATION_ERROR',
                message: '未提供音频文件',
            })
        }
        if (audioBuffer.length === 0) {
            return reply.code(400).send({
                status: 'error',
                error: 'VALIDATION_ERROR',
                message: '音频文件为空',
            })
        }
        try {
            inspectAudioUpload(audioBuffer, audioMimeType)
        } catch (error) {
            return reply.code(400).send({
                status: 'error',
                error: 'INVALID_AUDIO',
                message: error instanceof Error ? error.message : '音频格式校验失败',
            })
        }

        // DEMO 模式不执行识别、不回填原文、不伪造评分。
        if (config.demoMode) {
            const response: AsrResponse = {
                status: 'degraded',
                transcript: '',
                audioDurationSec: 0,
                model: LOCAL_PLACEHOLDER_MODEL,
                requestedModel: MIMO_ASR_MODEL,
                aiGenerated: false,
                demo: true,
                degraded: true,
                degradationReason: 'demo-mode',
            }
            return reply.send(response)
        }

        try {
            const result = await managedLLM.asr({
                model: asrModel,
                audio: audioBuffer,
                audioFilename,
                audioMimeType,
                language,
                prompt: promptParam,
                metadata: { agent: 'ai-routes', task: 'asr' },
            })

            const similarityScore = referenceText
                ? calculateTextSimilarity(result.text, referenceText)
                : undefined
            const response: AsrResponse = {
                status: 'ok',
                transcript: result.text,
                audioDurationSec: result.durationSec,
                ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
                ...(similarityScore !== undefined ? { similarityScore } : {}),
                model: asrModel,
                requestedModel: MIMO_ASR_MODEL,
                aiGenerated: true,
                demo: false,
                degraded: false,
            }
            return reply.send(response)
        } catch (err) {
            req.log.error({ err }, 'MiMo ASR 调用失败')
            return reply.code(502).send({
                status: 'error',
                error: 'AI_PROVIDER_FAILED',
                message: '语音识别服务暂不可用，请稍后重试',
                requestedModel: MIMO_ASR_MODEL,
            })
        }
    })

    // ── 4. POST /chat — 文本对话（deepseek 或 mimo，支持 SSE 流式） ──
    app.post('/chat', { bodyLimit: 8_000_000 }, async (req: FastifyRequest, reply) => {
        const body = validateBody(chatBodySchema, req, reply)
        if (!body) return
        const { messages, thinking, temperature, maxTokens, stream } = body
        let model = body.model ?? DEFAULT_CHAT_MODEL

        // ── 按能力自动选模型（异构编排的第一层：确定性路由）──
        //
        // 依据《大模型API文档.md》：**mimo-v2.5 是唯一的多模态模型**，
        // deepseek-v4-pro / deepseek-v4-flash / mimo-v2.5-pro 均为纯文本模型。
        // 因此只要消息里带了图片，就必须切到 mimo-v2.5——否则请求会被
        // 纯文本模型拒绝或静默丢掉图片，用户看到的是"AI 没看懂我发的图"。
        //
        // 这一层刻意做成**确定性规则**而不是让模型猜：能力匹配是客观事实，
        // 用关键词或额外一次 LLM 调用去推断，只会引入不必要的误判和延迟。
        // 切换结果会随响应回传，前端要如实告诉用户"为什么换了模型"。
        const hasImage = messages.some(
            (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
        )
        let autoRouted: { from: string; to: string; reason: string } | null = null
        if (hasImage && model !== VISION_MODEL) {
            autoRouted = {
                from: model,
                to: VISION_MODEL,
                reason: `${model} 是纯文本模型，无法理解图片；已自动切换到多模态模型 ${VISION_MODEL}`,
            }
            model = VISION_MODEL
        }

        // 解析模型与家族
        const modelFamily = resolveModelFamily(model)
        if (!modelFamily) {
            return reply.code(400).send({
                status: 'error',
                error: 'VALIDATION_ERROR',
                message: `不支持的模型: ${model}。仅支持 deepseek-v4-pro/flash 或 mimo-v2.5/pro`,
            })
        }
        const chatModel = model as ChatModel

        // 校验 thinking 模式与供应商真实能力。
        const thinkingError = validateThinkingMode(chatModel, thinking as ThinkingMode)
        if (thinkingError) {
            return reply.code(400).send({
                status: 'error',
                error: 'VALIDATION_ERROR',
                message: thinkingError,
            })
        }

        const chatMessages: ChatMessage[] = messages.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.name ? { name: m.name } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        }))

        // DEMO 模式：返回模板化响应
        if (config.demoMode) {
            const lastMessage = chatMessages[chatMessages.length - 1]
            const demoContent = `【演示模式】收到您的请求：${typeof lastMessage?.content === 'string' ? lastMessage.content.slice(0, 100) : ''}。当前为演示模式，未实际调用大模型。请配置 API 密钥后重试。`
            if (stream) {
                return sendDemoSSE(req, reply, demoContent, chatModel)
            }
            const response: ChatResponse = {
                content: demoContent,
                model: chatModel,
                latencyMs: 10,
                usage: { promptTokens: 0, completionTokens: 0 },
                demo: true,
            }
            return reply.send(response)
        }

        // 流式模式：SSE
        if (stream) {
            return sendChatSSE(req, reply, {
                model: chatModel,
                family: modelFamily,
                messages: chatMessages,
                thinking: thinking as ThinkingMode,
                temperature,
                maxTokens,
                autoRouted,
            })
        }

        // 非流式模式
        try {
            const result = modelFamily === 'deepseek'
                ? await managedLLM.chat({
                    model: chatModel as DeepSeekModel,
                    messages: chatMessages,
                    thinking: thinking as ThinkingMode,
                    temperature,
                    maxTokens,
                    metadata: { agent: 'ai-routes', task: 'chat' },
                })
                : await managedLLM.chat({
                    model: chatModel as MimoTextModel,
                    messages: chatMessages,
                    thinking: thinking as TextThinkingMode,
                    temperature,
                    maxTokens,
                    metadata: { agent: 'ai-routes', task: 'chat' },
                })

            const response: ChatResponse = {
                content: result.content,
                model: chatModel,
                latencyMs: result.latencyMs,
                usage: {
                    promptTokens: result.usage.promptTokens,
                    completionTokens: result.usage.completionTokens,
                },
                demo: false,
                // 改选过模型就必须说出来：只回 model 而不回改选原因，
                // 前端无从判断"这是用户选的"还是"服务端换的"
                ...(autoRouted ? { autoRouted } : {}),
            }
            return reply.send(response)
        } catch (err) {
            handleRouteError(err, req, reply, '文本对话调用失败')
            return
        }
    })
}

// ─────────────────────────────────────────────────────────────
// 私有辅助函数
// ─────────────────────────────────────────────────────────────

/**
 * 校验项目官方文件规定的 Wan2.7 Workspace MaaS 端点。
 *
 * 端点必须精确匹配官方同步 API path，并禁止凭据、非默认端口、query/hash，
 * 避免密钥被发送到外域、Workspace 内其他服务或通过 URL 参数泄漏。
 */
export function getWanConfigComplianceIssue(model: string, baseUrl: string): string | null {
    if (model !== WAN_IMAGE_MODEL) {
        return `模型必须为 ${WAN_IMAGE_MODEL}，实际为 ${model}`
    }
    if (!baseUrl.trim()) return '未配置 Wan2.7 Workspace MaaS 端点'
    try {
        const url = new URL(baseUrl)
        const workspaceHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com$/i
        const officialPath = '/api/v1/services/aigc/multimodal-generation/generation'
        const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, '') : '/'
        if (url.protocol !== 'https:') return 'Wan2.7 端点必须使用 HTTPS'
        if (url.username || url.password) return 'Wan2.7 端点不得包含 URL 凭据'
        if (url.port && url.port !== '443') return 'Wan2.7 端点不得使用非默认端口'
        if (!workspaceHost.test(url.hostname)) {
            return 'Wan2.7 端点必须为 {WorkspaceId}.cn-beijing.maas.aliyuncs.com'
        }
        if (url.search || url.hash) return 'Wan2.7 端点不得包含 query 或 hash'
        if (path !== officialPath) return `Wan2.7 端点路径必须为 ${officialPath}`
        if (!isTrustedProviderEndpoint('wan-image', baseUrl)) return 'Wan2.7 端点未通过官方安全白名单'
        return null
    } catch {
        return 'Wan2.7 端点不是合法 URL'
    }
}

function sendImageGenerationUnavailable(
    reply: FastifyReply,
    degradationReason: AiDegradationReason,
    demo: boolean,
    statusCode: 502 | 503,
) {
    const message = degradationReason === 'demo-mode'
        ? '当前演示环境未启用动态生图，已保留诗库中的同诗实图'
        : degradationReason === 'provider-unavailable'
            ? '动态生图尚未配置，请在模型设置中配置 Wan2.7 后重试'
            : degradationReason === 'provider-noncompliant'
                ? 'Wan2.7 请求地址或模型配置不符合官方接口要求，已拒绝生成'
                : '动态生图暂时失败，已保留原有图片，请稍后重试'
    return reply.code(statusCode).send({
        status: 'error',
        error: 'IMAGE_GENERATION_UNAVAILABLE',
        message,
        requestedModel: WAN_IMAGE_MODEL,
        demo,
        degradationReason,
    })
}

function isMultipartLimitError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) return false
    return MULTIPART_LIMIT_ERROR_CODES.has(String(error.code))
}

function normalizeComparisonText(value: string): string {
    return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * 基于真实 ASR 转写结果计算确定性的文本编辑相似度。
 * 使用滚动数组将内存压到 O(min(m,n))；该分数不是模型自报置信度。
 */
export function calculateTextSimilarity(transcript: string, referenceText: string): number {
    const actual = Array.from(normalizeComparisonText(transcript))
    const expected = Array.from(normalizeComparisonText(referenceText))
    const maxLength = Math.max(actual.length, expected.length)
    if (maxLength === 0) return 0

    const rows = actual.length >= expected.length ? actual : expected
    const columns = actual.length >= expected.length ? expected : actual
    let previous = new Uint32Array(columns.length + 1)
    let current = new Uint32Array(columns.length + 1)
    for (let column = 0; column <= columns.length; column += 1) previous[column] = column

    for (let row = 1; row <= rows.length; row += 1) {
        current[0] = row
        for (let column = 1; column <= columns.length; column += 1) {
            const substitutionCost = rows[row - 1] === columns[column - 1] ? 0 : 1
            current[column] = Math.min(
                (previous[column] ?? 0) + 1,
                (current[column - 1] ?? 0) + 1,
                (previous[column - 1] ?? 0) + substitutionCost,
            )
        }
        const swap = previous
        previous = current
        current = swap
    }

    const distance = previous[columns.length] ?? maxLength
    const score = (1 - distance / maxLength) * 100
    return Math.round(Math.max(0, Math.min(100, score)) * 10) / 10
}

/** 解析模型所属家族 */
function resolveModelFamily(model: string): ModelFamily | null {
    if (DEEPSEEK_MODELS.has(model)) return 'deepseek'
    if (MIMO_TEXT_MODELS.has(model)) return 'mimo'
    return null
}

/** 校验 thinking 模式与模型兼容性。MiMo 仅支持开关，不支持 max 强度。 */
function validateThinkingMode(model: string, thinking: ThinkingMode): string | null {
    if (thinking === 'max' && model.startsWith('mimo-')) {
        return 'MiMo ChatCompletions 仅支持开启或关闭思考，不支持 max 强度；请选择标准深度'
    }
    return null
}

/** 发送流式 SSE 文本对话 */
async function sendChatSSE(
    req: FastifyRequest,
    reply: FastifyReply,
    params: {
        model: ChatModel
        family: ModelFamily
        messages: ChatMessage[]
        thinking: ThinkingMode
        temperature?: number
        maxTokens?: number
        /** 服务端按能力改选模型时的说明，作为流的第一帧发出 */
        autoRouted?: { from: string; to: string; reason: string } | null
    },
): Promise<void> {
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

    // 首帧告知前端「实际由谁作答」。必须排在正文之前发出，
    // 前端才来得及在第一个字冒出来之前把模型标签改对。
    if (params.autoRouted && !await writeSSE({ autoRouted: params.autoRouted, model: params.model })) {
        abortController.abort()
    }

    try {
        if (!abortController.signal.aborted) {
            const stream = params.family === 'deepseek'
                ? managedLLM.stream({
                model: params.model as DeepSeekModel,
                messages: params.messages,
                thinking: params.thinking,
                temperature: params.temperature,
                maxTokens: params.maxTokens,
                signal: abortController.signal,
                metadata: { agent: 'ai-routes', task: 'chat-stream' },
            })
                : managedLLM.stream({
                model: params.model as MimoTextModel,
                messages: params.messages,
                thinking: params.thinking as TextThinkingMode,
                temperature: params.temperature,
                maxTokens: params.maxTokens,
                signal: abortController.signal,
                metadata: { agent: 'ai-routes', task: 'chat-stream' },
            })

            for await (const chunk of stream) {
                if (abortController.signal.aborted) break
                const delta: { content?: string; done?: boolean; usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number } } = {}
                if (chunk.content) delta.content = chunk.content
                // Provider chain-of-thought is private model metadata, never client output.
                if (chunk.done) {
                    delta.done = true
                    if (chunk.usage) delta.usage = chunk.usage
                }
                if (!await writeSSE(delta)) {
                    abortController.abort()
                    break
                }
            }
        }

        const completedForClient = !abortController.signal.aborted && await writeSSE('[DONE]')
        if (completedForClient) {
            req.log.info({ path: req.url, model: params.model }, 'SSE 文本对话流式完成')
        } else if (!abortController.signal.aborted) {
            abortController.abort()
        }
    } catch (err) {
        if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
            req.log.debug({ path: req.url }, '文本对话流被客户端中止')
        } else {
            req.log.error({ err, path: req.url }, 'SSE 文本对话流式失败')
            await writeSSE(createPublicSseError('CHAT_STREAM_FAILED', err))
        }
    } finally {
        removeDisconnectHandlers()
        if (!raw.writableEnded) {
            raw.end()
        }
    }
}

/** DEMO 模式发送 SSE 文本（模拟流式输出） */
async function sendDemoSSE(
    req: FastifyRequest,
    reply: FastifyReply,
    content: string,
    model: string,
): Promise<void> {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, private, no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
        'X-Demo-Mode': 'true',
    })

    const abortController = new AbortController()
    const removeDisconnectHandlers = bindSseDisconnectAbort(req.raw, raw, abortController)
    const writeSSE = (payload: unknown) => writeSseFrame(raw, payload, abortController.signal)

    try {
        // 按字符流式输出（每 30ms 一个字符，模拟真实流式）
        for (const ch of content) {
            if (abortController.signal.aborted || !await writeSSE({ content: ch })) {
                abortController.abort()
                break
            }
            await new Promise((resolve) => setTimeout(resolve, 30))
        }
        const completedForClient = !abortController.signal.aborted
            && await writeSSE({ done: true, usage: { promptTokens: 0, completionTokens: content.length } })
            && await writeSSE('[DONE]')
        if (completedForClient) {
            req.log.info({ path: req.url, model }, 'DEMO SSE 文本对话流式完成')
        }
    } finally {
        removeDisconnectHandlers()
        if (!raw.writableEnded) {
            raw.end()
        }
    }
}

/** 生成合法的 PCM WAV 静音音频，仅供明确标注的 DEMO 模式占位。 */
export function generateSilentWav(textLength: number): { buffer: Buffer; durationMs: number } {
    // 估算时长：中文约 4 字/秒
    const boundedTextLength = Math.max(0, Math.min(Number.isFinite(textLength) ? textLength : 0, 5000))
    // 演示占位最长 30 秒，避免长文本导致不必要的大块内存分配。
    const estimatedDurationMs = Math.min(30_000, Math.max(1000, boundedTextLength * 250))
    const sampleRate = 16000
    const numSamples = Math.floor(estimatedDurationMs / 1000 * sampleRate)
    const dataSize = numSamples * 2 // 16-bit = 2 bytes
    const buffer = Buffer.alloc(44 + dataSize)
    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + dataSize, 4)
    buffer.write('WAVE', 8)
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20) // PCM
    buffer.writeUInt16LE(1, 22) // mono
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(sampleRate * 2, 28)
    buffer.writeUInt16LE(2, 32)
    buffer.writeUInt16LE(16, 34)
    buffer.write('data', 36)
    buffer.writeUInt32LE(dataSize, 40)
    // Buffer.alloc 已将数据区置 0（静音）
    return { buffer, durationMs: estimatedDurationMs }
}
