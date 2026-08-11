/**
 * 文化语境还原 REST API 路由（Task 20）
 *
 * 7 个端点：
 * - GET  /api/culture/poems/:poemId/background   获取诗的文化背景包（brush.creative 生成，缓存）
 * - GET  /api/culture/poems/:poemId/images       获取文化文物图片库（eye.vision-annotate + 文生图 API）
 * - GET  /api/culture/images/:imageId            获取单张图片详情
 * - GET  /api/culture/imagery/:imageName         获取意象文化内涵解读（seed-data 聚合 + brush.creative 解读）
 * - POST /api/culture/immersive/start            启动沉浸式投屏
 * - GET  /api/culture/immersive/:poemId/status   获取投屏状态
 * - POST /api/culture/immersive/stop             停止投屏
 *
 * 设计要点：
 * - 文化背景包分四区：历史背景 / 诗人境遇 / 创作情境 / 文化常识，由 brush.creative 生成
 * - 图片库调用 eye.vision-annotate 生成视觉描述 + 调用文生图 API 生成实际图片
 * - 意象解读从 seed-data 的 IMAGE_CULTURAL_MEANINGS 聚合 + brush.creative 深度解读
 * - 所有 AI 生成内容携带 aiGenerated: true
 * - 内存缓存（Map）避免重复生成，降低 LLM 调用成本
 * - 投屏状态为内存态（单机部署足够，分布式需换 Redis）
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { brushAgent, eyeAgent } from '../agents/index.js'
import type { CreativeInput, CreativeOutput, CreativeGradeLevel } from '../agents/brush-agent/index.js'
import type { VisionAnnotateInput, VisionAnnotateOutput, VisionPurpose } from '../agents/eye-agent/index.js'
import type { AgentContext, PoemNode } from '../agents/base/types.js'
import { repos } from '../db/index.js'
import { SEED_POEMS, IMAGE_CULTURAL_MEANINGS } from '../services/knowledge-graph/seed-data.js'
import { generateId } from '../db/utils/id.js'

import { generateLocalScenes } from '../services/culture/local-scene-generator.js'
import { getOrCreateImage, type CachedImage } from '../services/culture/image-cache.js'
import { z } from 'zod'
import { validateBody, validateParams, schemas } from '../lib/validation.js'
import { SqliteMap } from '../db/runtime-store.js'
import { config } from '../config.js'
import { isKnownImagery } from '../services/culture/imagery-policy.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 文化背景包分区键 */
export type BackgroundSectionKey = 'historical' | 'poet' | 'creation' | 'cultural'

/** 文化背景包 */
export interface CultureBackground {
    poemId: string
    /** 历史背景 */
    historical: string
    /** 诗人境遇 */
    poet: string
    /** 创作情境 */
    creation: string
    /** 文化常识 */
    cultural: string
    /** 文生图提示词（综合四区意境） */
    suggestedImagePrompt: string
    aiGenerated: boolean
    /** 生成时间戳 */
    generatedAt: number
}

/** 文化文物图片条目 */
export interface CultureImage {
    id: string
    poemId: string
    /** 图片标题（如"唐代长安城元宵夜"） */
    title: string
    /** 图片 URL（来自文生图 API） */
    imageUrl: string
    /** 视觉描述（eye.vision-annotate 生成） */
    description: string
    /** 文化内涵解读 */
    culturalMeaning: string
    /** 三视角标注 */
    perspectives?: {
        color_composition: string
        emotion_atmosphere: string
        cultural_symbols: string
    }
    /** 关联诗句 */
    relatedVerse?: string
    /** 图片方向 */
    orientation: 'landscape' | 'portrait'
    aiGenerated: boolean
    /** 图片真实来源，供前端水印与答辩证据追溯 */
    source: 'wan2.7' | 'local-illustration'
    /** 生成模型；本地插画无此字段 */
    model?: string
    /** 云端请求 ID，仅用于问题追踪，不含凭据 */
    generationRequestId?: string
    createdAt: number
}

/** 图片库响应 */
export interface ImageGalleryResponse {
    poemId: string
    images: CultureImage[]
    aiGenerated: boolean
}

/** 意象文化内涵解读 */
export interface ImageryInterpretation {
    imageName: string
    /** 来自 seed-data 的基础含义 */
    baseMeaning: string
    /** AI 深度解读（Markdown） */
    deepInterpretation: string
    /** 文化符号维度（如"思乡""团圆""高洁"） */
    culturalDimensions: string[]
    /** 关联诗列表 */
    relatedPoems: Array<{ poemId: string; title: string; poet: string; dynasty: string }>
    aiGenerated: boolean
    generatedAt: number
}

/** 投屏状态 */
export type ImmersiveStatus = 'idle' | 'running' | 'paused' | 'stopped'

/** 投屏会话状态 */
export interface ImmersiveState {
    poemId: string
    status: ImmersiveStatus
    /** 当前展示的图片索引 */
    currentImageIndex: number
    /** 图片切换间隔（ms） */
    slideIntervalMs: number
    /** 是否播放朗读音频 */
    narrationEnabled: boolean
    /** 是否播放背景音 */
    bgmEnabled: boolean
    /** 投屏开始时间 */
    startedAt: number
    /** 最后更新时间 */
    updatedAt: number
}

/** 启动投屏请求 */
export interface StartImmersiveBody {
    poemId: string
    /** 图片切换间隔（秒，默认 8） */
    slideIntervalSec?: number
    /** 是否播放朗读 */
    narrationEnabled?: boolean
    /** 是否播放背景音 */
    bgmEnabled?: boolean
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 背景包四区主题映射 */
const BACKGROUND_TOPICS: Record<BackgroundSectionKey, string> = {
    historical: '本诗创作时代的政治、社会、文化背景',
    poet: '诗人当时的生平境遇、仕途、心境',
    creation: '诗人创作本诗的具体情境与触发事件',
    cultural: '与本诗相关的传统文化常识、礼俗、典故',
}

/** 背景包四区中文名 */
const BACKGROUND_SECTION_LABELS: Record<BackgroundSectionKey, string> = {
    historical: '历史背景',
    poet: '诗人境遇',
    creation: '创作情境',
    cultural: '文化常识',
}

/** 每首诗生成的图片数量 */
const IMAGES_PER_POEM = 4

/** 投屏默认切换间隔（ms） */
const DEFAULT_SLIDE_INTERVAL_MS = 8000

/** 缓存上限 */
const CACHE_MAX = 100

// ─────────────────────────────────────────────────────────────
// 内存缓存
// ─────────────────────────────────────────────────────────────

/** 背景包缓存：key = poemId（进程重启后仍保留，避免重复调用 AI） */
const backgroundCache = new SqliteMap<string, CultureBackground>({
    table: 'culture_backgrounds',
    maxSize: CACHE_MAX,
})

/** 图片库缓存：key = poemId */
const imageGalleryCache = new SqliteMap<string, CultureImage[]>({
    table: 'culture_image_galleries',
    maxSize: CACHE_MAX,
})

/** 单图缓存：key = imageId */
const imageCache = new SqliteMap<string, CultureImage>({
    table: 'culture_images',
    indexes: [{ name: 'poem_id', extract: (value) => value.poemId }],
    maxSize: CACHE_MAX,
})

/** 意象解读缓存：key = imageName */
const imageryCache = new SqliteMap<string, ImageryInterpretation>({
    table: 'culture_imagery',
    maxSize: CACHE_MAX,
})

/** 投屏状态缓存：key = poemId */
const immersiveStates = new SqliteMap<string, ImmersiveState>({
    table: 'culture_immersive_states',
    indexes: [{ name: 'poem_id', extract: (value) => value.poemId }],
    maxSize: CACHE_MAX,
})

/** 缓存淘汰（FIFO） */
function trimCache<K, V>(cache: Map<K, V>): void {
    if (cache.size <= CACHE_MAX) return
    const firstKey = cache.keys().next().value
    if (firstKey !== undefined) cache.delete(firstKey)
}

// ─────────────────────────────────────────────────────────────
// Zod schemas（B6.3 输入校验）
// ─────────────────────────────────────────────────────────────

/** GET /poems/:poemId/background 与 /poems/:poemId/images 与 /immersive/:poemId/status 路径参数 */
const poemIdParamsSchema = z.object({ poemId: schemas.poemId })

/** GET /images/:imageId 路径参数 */
const imageIdParamsSchema = z.object({ imageId: schemas.id })

/** GET /imagery/:imageName 路径参数（URL 编码的意象名，允许中文字符） */
const imageNameParamsSchema = z.object({
    imageName: z.string().trim().min(1, '意象名不能为空').max(128, '意象名长度不能超过 128 字符'),
})

/** POST /immersive/start 请求体 */
const immersiveStartSchema = z.object({
    poemId: schemas.poemId,
    slideIntervalSec: z.number().int().min(1).max(120).optional(),
    narrationEnabled: z.boolean().optional(),
    bgmEnabled: z.boolean().optional(),
})

/** POST /immersive/stop 请求体 */
const immersiveStopSchema = z.object({
    poemId: schemas.optionalSanitizedString(128),
})

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

export const cultureRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    // ── GET /poems/:poemId/background — 获取文化背景包 ──
    app.get('/poems/:poemId/background', async (req: FastifyRequest, reply) => {
        const params = validateParams(poemIdParamsSchema, req, reply)
        if (!params) return
        const { poemId } = params
        const poem = fetchPoem(poemId)
        if (!poem) {
            return reply.status(404).send({ status: 'error', message: '古诗不存在' })
        }

        // 缓存命中
        const cached = backgroundCache.get(poemId)
        if (cached) {
            return reply.send({ status: 'ok', background: cached, cached: true })
        }

        // 调用 brush.creative 生成四区内容
        try {
            const sections = await generateBackgroundSections(poem)
            const background: CultureBackground = {
                poemId,
                ...sections,
                generatedAt: Date.now(),
            }
            backgroundCache.set(poemId, background)
            trimCache(backgroundCache)

            req.log.info({ poemId }, '[culture] 文化背景包已生成')
            return reply.send({ status: 'ok', background, cached: false })
        } catch (err) {
            req.log.error({ err, poemId }, '[culture] 文化背景包生成失败')
            return reply.status(502).send({
                status: 'error',
                message: '文化背景包生成失败，请稍后重试',
                aiGenerated: true,
            })
        }
    })

    // ── GET /poems/:poemId/images — 获取文化文物图片库 ──
    app.get('/poems/:poemId/images', async (req: FastifyRequest, reply) => {
        const params = validateParams(poemIdParamsSchema, req, reply)
        if (!params) return
        const { poemId } = params
        const poem = fetchPoem(poemId)
        if (!poem) {
            return reply.status(404).send({ status: 'error', message: '古诗不存在' })
        }

        // 缓存命中
        const cached = imageGalleryCache.get(poemId)
        if (cached && cached.length > 0) {
            const resp: ImageGalleryResponse = { poemId, images: cached, aiGenerated: cached.some((image) => image.aiGenerated) }
            return reply.send({ status: 'ok', ...resp, cached: true })
        }

        // DEMO 是可离线复现的演示档，不应在页面首次渲染时发起会随供应商、
        // 网络或配额波动的创意/生图调用。返回与当前诗篇一一对应的本地 SVG，
        // 并通过每张图片的 source/aiGenerated 如实标记其不是 AI 生成内容。
        if (config.demoMode) {
            const images = generateLocalImageGallery(poem)
            cacheImageGallery(poemId, images)
            const resp: ImageGalleryResponse = { poemId, images, aiGenerated: false }
            return reply.send({ status: 'ok', ...resp, cached: false, source: 'local-demo' })
        }

        try {
            const images = await generateImageGallery(poem, req)
            cacheImageGallery(poemId, images)

            const resp: ImageGalleryResponse = { poemId, images, aiGenerated: images.some((image) => image.aiGenerated) }
            req.log.info({ poemId, count: images.length }, '[culture] 图片库已生成')
            return reply.send({ status: 'ok', ...resp, cached: false })
        } catch (err) {
            // LIVE 模式保留 AI 增强，但其所有前置描述任务均失败时仍须交付
            // 同诗篇、可追溯、明确标记的本地场景；不能把外部服务抖动放大为
            // 页面级 502，也不能借用其他诗篇或把本地结果冒充成 AI 图。
            const images = generateLocalImageGallery(poem)
            cacheImageGallery(poemId, images)
            req.log.warn({ err, poemId, count: images.length }, '[culture] AI 图片库生成失败，已降级为本地教学插画')
            const resp: ImageGalleryResponse = { poemId, images, aiGenerated: false }
            return reply.send({ status: 'ok', ...resp, cached: false, source: 'local-fallback' })
        }
    })

    // ── GET /images/:imageId — 获取单张图片详情 ──
    app.get('/images/:imageId', async (req: FastifyRequest, reply) => {
        const params = validateParams(imageIdParamsSchema, req, reply)
        if (!params) return
        const { imageId } = params
        const cached = imageCache.get(imageId)
        if (cached) {
            return reply.send({ status: 'ok', image: cached, cached: true })
        }

        // 兜底：在所有图片库缓存中查找
        for (const images of imageGalleryCache.values()) {
            const found = images.find((i) => i.id === imageId)
            if (found) {
                imageCache.set(imageId, found)
                return reply.send({ status: 'ok', image: found, cached: true })
            }
        }

        return reply.status(404).send({ status: 'error', message: '图片不存在或已失效' })
    })

    // ── GET /imagery/:imageName — 获取意象文化内涵解读 ──
    app.get('/imagery/:imageName', async (req: FastifyRequest, reply) => {
        const params = validateParams(imageNameParamsSchema, req, reply)
        if (!params) return
        const imageName = decodeURIComponent(params.imageName)

        // 缓存命中
        const cached = imageryCache.get(imageName)
        if (cached) {
            return reply.send({ status: 'ok', interpretation: cached, cached: true })
        }

        // 从 seed-data 聚合基础含义 + 关联诗
        const baseMeaning = lookupImageMeaning(imageName)
        const relatedPoems = findPoemsByImage(imageName)

        // 普通读取必须在前端 15 秒超时内稳定返回。目录基础义与关联诗均为
        // 可追溯本地数据；AI 深度扩写改由显式 refresh 触发。
        const interpretation = buildLocalImageryInterpretation(imageName, baseMeaning, relatedPoems)
        imageryCache.set(imageName, interpretation)
        return reply.send({
            status: 'ok',
            interpretation,
            cached: false,
            source: 'local-catalog',
        })
    })

    // ── POST /imagery/:imageName/refresh — 显式请求 AI 深度解读 ──
    app.post('/imagery/:imageName/refresh', async (req: FastifyRequest, reply) => {
        const params = validateParams(imageNameParamsSchema, req, reply)
        if (!params) return
        const imageName = decodeURIComponent(params.imageName)

        // 刷新属于高成本 AI 写操作，只允许本地目录中可追溯的意象。
        // 未知值若继续下传，会把任意路径参数送入模型并在无密钥时挂起至 SDK 超时。
        if (!isKnownImagery(imageName)) {
            return reply.status(404).send({
                status: 'error',
                error: 'IMAGERY_NOT_FOUND',
                message: '意象未收录，无法生成可追溯的 AI 深度解读',
            })
        }

        // DEMO_MODE 的启动契约明确表示 AI 调用不可用。这里必须快速、诚实失败，
        // 不能等待 60 秒模型超时，也不能把本地文本伪装成一次成功的 AI 刷新。
        if (config.demoMode) {
            return reply.status(409).send({
                status: 'error',
                error: 'AI_REFRESH_UNAVAILABLE_IN_DEMO_MODE',
                message: '演示模式未启用 AI 刷新，请继续使用本地目录解读',
                fallbackPath: `/api/culture/imagery/${encodeURIComponent(imageName)}`,
            })
        }

        const baseMeaning = lookupImageMeaning(imageName)
        const relatedPoems = findPoemsByImage(imageName)
        try {
            const deepInterpretation = await generateImageryDeepInterpretation(
                imageName,
                baseMeaning,
                relatedPoems,
            )
            const interpretation: ImageryInterpretation = {
                ...buildLocalImageryInterpretation(imageName, baseMeaning, relatedPoems),
                deepInterpretation,
                culturalDimensions: extractDimensions(baseMeaning, deepInterpretation),
                aiGenerated: true,
                generatedAt: Date.now(),
            }
            imageryCache.set(imageName, interpretation)
            req.log.info({ imageName }, '[culture] AI 意象解读已刷新')
            return reply.send({ status: 'ok', interpretation, cached: false, source: 'ai' })
        } catch (err) {
            req.log.error({ err, imageName }, '[culture] AI 意象解读刷新失败')
            return reply.status(502).send({
                status: 'error',
                message: 'AI 意象解读刷新失败，本地目录解读仍可使用',
            })
        }
    })

    // ── POST /immersive/start — 启动沉浸式投屏 ──
    app.post('/immersive/start', async (req: FastifyRequest, reply) => {
        const body = validateBody(immersiveStartSchema, req, reply)
        if (!body) return
        const { poemId } = body

        const poem = fetchPoem(poemId)
        if (!poem) {
            return reply.status(404).send({ status: 'error', message: '古诗不存在' })
        }

        const slideIntervalMs = (body.slideIntervalSec ?? 8) * 1000
        const state: ImmersiveState = {
            poemId,
            status: 'running',
            currentImageIndex: 0,
            slideIntervalMs,
            narrationEnabled: body.narrationEnabled ?? true,
            bgmEnabled: body.bgmEnabled ?? true,
            startedAt: Date.now(),
            updatedAt: Date.now(),
        }
        immersiveStates.set(poemId, state)

        req.log.info({ poemId, slideIntervalMs }, '[culture] 沉浸式投屏已启动')
        return reply.send({ status: 'ok', state, aiGenerated: true })
    })

    // ── GET /immersive/:poemId/status — 获取投屏状态 ──
    app.get('/immersive/:poemId/status', async (req: FastifyRequest, reply) => {
        const params = validateParams(poemIdParamsSchema, req, reply)
        if (!params) return
        const { poemId } = params
        const state = immersiveStates.get(poemId)
        if (!state) {
            return reply.send({
                status: 'ok',
                state: {
                    poemId,
                    status: 'idle' as ImmersiveStatus,
                    currentImageIndex: 0,
                    slideIntervalMs: DEFAULT_SLIDE_INTERVAL_MS,
                    narrationEnabled: true,
                    bgmEnabled: true,
                    startedAt: 0,
                    updatedAt: 0,
                } satisfies ImmersiveState,
            })
        }
        return reply.send({ status: 'ok', state })
    })

    // ── POST /immersive/stop — 停止投屏 ──
    app.post('/immersive/stop', async (req: FastifyRequest, reply) => {
        const body = validateBody(immersiveStopSchema, req, reply)
        if (!body) return
        const { poemId } = body
        if (!poemId) {
            // 停止所有投屏
            let count = 0
            for (const [key, state] of immersiveStates.entries()) {
                if (state.status === 'running' || state.status === 'paused') {
                    state.status = 'stopped'
                    state.updatedAt = Date.now()
                    immersiveStates.set(key, state)
                    count++
                }
            }
            return reply.send({ status: 'ok', stoppedCount: count, aiGenerated: true })
        }

        const state = immersiveStates.get(poemId)
        if (!state) {
            return reply.status(404).send({ status: 'error', message: '投屏会话不存在' })
        }
        state.status = 'stopped'
        state.updatedAt = Date.now()
        immersiveStates.set(poemId, state)

        req.log.info({ poemId }, '[culture] 沉浸式投屏已停止')
        return reply.send({ status: 'ok', state, aiGenerated: true })
    })
}

// ─────────────────────────────────────────────────────────────
// 业务函数
// ─────────────────────────────────────────────────────────────

/** 查询古诗（DB 优先，回退到 seed-data） */
function fetchPoem(poemId: string): { id: string; title: string; poet: string; dynasty: string; content: string; theme: string[]; images: string[]; rhetoric: string[]; gradeLevel?: string; difficulty?: number } | null {
    try {
        const dbPoem = repos.poems.findById(poemId)
        if (dbPoem) {
            return {
                id: dbPoem.id,
                title: dbPoem.title,
                poet: dbPoem.poet,
                dynasty: dbPoem.dynasty,
                content: dbPoem.content,
                theme: dbPoem.theme ?? [],
                images: dbPoem.images ?? [],
                rhetoric: dbPoem.rhetoric ?? [],
                gradeLevel: dbPoem.gradeLevel ?? undefined,
                difficulty: dbPoem.difficulty,
            }
        }
    } catch {
        // DB 查询失败，回退 seed-data
    }

    const seed = SEED_POEMS.find((p) => p.id === poemId)
    if (seed) {
        return {
            id: seed.id,
            title: seed.title,
            poet: seed.poet,
            dynasty: seed.dynasty,
            content: seed.content,
            theme: [...seed.themes],
            images: [...seed.images],
            rhetoric: [...seed.rhetoric],
            gradeLevel: seed.gradeLevel,
            difficulty: seed.difficulty,
        }
    }
    return null
}

/** 构建 PoemNode 上下文 */
function buildPoemNode(poem: NonNullable<ReturnType<typeof fetchPoem>>): PoemNode {
    return {
        id: poem.id,
        title: poem.title,
        poet: poem.poet,
        dynasty: poem.dynasty,
        theme: poem.theme,
        images: poem.images,
        content: poem.content,
        gradeLevel: poem.gradeLevel,
        difficulty: poem.difficulty,
        teachingPoints: poem.rhetoric,
    }
}

/** 构建 AgentContext */
function buildAgentContext(taskId: string): AgentContext {
    return {
        taskId,
        sessionId: `culture-${taskId}`,
    }
}

/** 推断年级分段 */
function inferGradeLevel(poem: NonNullable<ReturnType<typeof fetchPoem>>): CreativeGradeLevel {
    const g = poem.gradeLevel ?? ''
    if (g.includes('一') || g.includes('二')) return '1-2年级'
    if (g.includes('三') || g.includes('四')) return '3-4年级'
    return '5-6年级'
}

/**
 * 调用 brush.creative 生成四区内容
 * 并行 4 次调用，每次主题不同
 */
async function generateBackgroundSections(
    poem: NonNullable<ReturnType<typeof fetchPoem>>,
): Promise<Omit<CultureBackground, 'poemId' | 'generatedAt'>> {
    const poemNode = buildPoemNode(poem)
    const gradeLevel = inferGradeLevel(poem)
    const ctx = buildAgentContext(`bg-${poem.id}`)

    const sectionKeys: BackgroundSectionKey[] = ['historical', 'poet', 'creation', 'cultural']

    const results = await Promise.allSettled(
        sectionKeys.map((key) => {
            const input: CreativeInput = {
                type: 'cultural-story',
                poemId: poem.id,
                topic: BACKGROUND_TOPICS[key],
                gradeLevel,
                constraints: [
                    `聚焦"${BACKGROUND_SECTION_LABELS[key]}"维度，不与其他维度重叠`,
                    '叙事生动、史实准确、避免戏说',
                    '只能把输入中明确给出的诗题、作者、朝代、诗文、教材字段当作确定事实',
                    '凡输入中未提供的创作年份、具体事件、人物经历与传说，必须明确写“相传”或“有待史料核验”，不得以确定口吻补写',
                    '不要使用 Markdown 标题符号或代码块，直接输出可阅读的中文正文',
                    '篇幅 300-500 字，适合小学教师备课参考',
                ],
            }
            const localCtx: AgentContext = {
                ...ctx,
                knowledgeGraphNodes: [poemNode],
                teacherIntent: `为小学${gradeLevel}教师备课生成${BACKGROUND_SECTION_LABELS[key]}说明`,
            }
            return brushAgent.creative.invoke(input, localCtx)
        }),
    )

    const sections: Record<BackgroundSectionKey, string> = {
        historical: '',
        poet: '',
        creation: '',
        cultural: '',
    }
    let suggestedImagePrompt = ''
    let generatedSectionCount = 0
    const safeFallbacks: Record<BackgroundSectionKey, string> = {
        historical: `《${poem.title}》创作于${poem.dynasty}代。教学时可先引导学生从诗中的景物、人物与生活器物入手，再结合教材注释核对时代环境，避免把后世习俗直接套入诗歌语境。`,
        poet: `作者${poem.poet}的经历与表达方式，是理解《${poem.title}》的重要线索。建议结合教材中的作者简介，关注诗中可直接观察到的情感变化，不把未经史料证实的传说当作事实。`,
        creation: `可从“诗人看见了什么、听见了什么、想到了什么”三个问题还原创作情境。诗句“${poem.content.split('\n')[0] ?? poem.content}”适合作为课堂观察入口，引导学生先据文本想象，再查证背景。`,
        cultural: `本诗涉及的意象包括${poem.images.length > 0 ? poem.images.join('、') : '自然景物与古代生活场景'}。课堂讲解应区分“诗句原意、传统文化寓意、学生个人联想”三个层次，并以教材与可靠文献为依据。`,
    }

    results.forEach((r, idx) => {
        const key = sectionKeys[idx]
        if (!key) return
        if (r.status === 'fulfilled') {
            generatedSectionCount += 1
            const out: CreativeOutput = r.value.output
            sections[key] = out.content
            // 收集最后一个非空的 suggestedImagePrompt
            if (out.suggestedImagePrompt && out.suggestedImagePrompt.length > 20) {
                suggestedImagePrompt = out.suggestedImagePrompt
            }
        } else {
            // 降级内容不暴露供应商、鉴权或内部错误，课堂仍可直接使用。
            sections[key] = safeFallbacks[key]
        }
    })

    // 兜底 suggestedImagePrompt
    if (!suggestedImagePrompt) {
        suggestedImagePrompt = `Chinese ink painting, ${poem.dynasty} dynasty scene, ${poem.title} by ${poem.poet}, traditional landscape, serene atmosphere, soft brush strokes, muted warm tones`
    }

    return {
        historical: sections.historical,
        poet: sections.poet,
        creation: sections.creation,
        cultural: sections.cultural,
        suggestedImagePrompt,
        aiGenerated: generatedSectionCount > 0,
    }
}

/**
 * 生成图片库
 * 流程：1) brush.creative 生成 N 个配图描述 + 文生图 prompt
 *      2) 调用文生图 API 生成实际图片
 *      3) 调用 eye.vision-annotate 生成视觉描述（用文生图 URL 作为输入）
 */
async function generateImageGallery(
    poem: NonNullable<ReturnType<typeof fetchPoem>>,
    req: FastifyRequest,
): Promise<CultureImage[]> {
    void req // 参数保留以维持调用方签名兼容
    const poemNode = buildPoemNode(poem)
    // 一次性生成 4 张本地 SVG 场景图（替代外部文生图 API）
    const localScenes = generateLocalScenes(poem.id, poemNode)
    const gradeLevel = inferGradeLevel(poem)
    const ctx = buildAgentContext(`img-${poem.id}`)

    // 第 1 步：调用 brush.creative 生成多个配图描述
    const illustrationInputs: CreativeInput[] = []
    const angles = [
        `本诗整体意境的画面化呈现`,
        `诗中核心意象"${poem.images[0] ?? '主旨'}"的特写画面`,
        `诗人${poem.poet}创作此诗时的生活场景`,
        `${poem.dynasty}代与本诗相关的文化风貌`,
    ]
    for (let i = 0; i < IMAGES_PER_POEM; i++) {
        illustrationInputs.push({
            type: 'illustration-description',
            poemId: poem.id,
            topic: angles[i] ?? `与本诗相关的画面变体 ${i + 1}`,
            gradeLevel,
            constraints: [
                '画面需符合古诗意境，避免现代化元素',
                `图片方向：${i % 2 === 0 ? '横向 16:9' : '纵向 4:3'}`,
                '适合小学课堂投屏展示',
            ],
        })
    }

    const creativeResults = await Promise.allSettled(
        illustrationInputs.map((input) => {
            const localCtx: AgentContext = {
                ...ctx,
                knowledgeGraphNodes: [poemNode],
                teacherIntent: `为小学${gradeLevel}课堂投屏生成文化文物配图`,
            }
            return brushAgent.creative.invoke(input, localCtx)
        }),
    )

    // 第 2 步：调用文生图 API 生成实际图片
    const imageEntries: Array<{
        title: string
        description: string
        prompt: string
        orientation: 'landscape' | 'portrait'
        relatedVerse?: string
    }> = []

    creativeResults.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
            const out: CreativeOutput = r.value.output
            imageEntries.push({
                title: `${poem.title}·画面${idx + 1}`,
                description: out.content,
                prompt: out.suggestedImagePrompt,
                orientation: idx % 2 === 0 ? 'landscape' : 'portrait',
                relatedVerse: poem.content.split('\n')[idx % poem.content.split('\n').length],
            })
        }
    })

    if (imageEntries.length === 0) {
        throw new Error('所有配图描述生成失败')
    }

    // 第 3 步：并行调用文生图 API + eye.vision-annotate
    const images: CultureImage[] = []
    const ctxVA = buildAgentContext(`va-${poem.id}`)

    const imageResults = await Promise.allSettled(
        imageEntries.map(async (entry, idx) => {
            // 优先调用 Wan2.7；未配置或生成失败时，明确降级为本地教学插画。
            const scene = localScenes[idx % localScenes.length] ?? localScenes[0]

            // ── 生成 + 立即落盘 ──
            //
            // 这里过去直接用 generateWanImage 拿到的 `imageUrl` 存库。
            // 那是阿里云 OSS 的**限时签名地址**：实测 `Expires` 只有约 16 小时，
            // 过期后全部 403。而本路由的缓存一旦写入就永远命中，
            // 于是第二天起文化图库与思考宫殿配图会**整片破图且永不自愈**。
            // 改走 getOrCreateImage：生成后立刻把字节下载、压缩、落盘，
            // 对外只给本地静态路径。
            let wanResult: CachedImage | null = null
            try {
                wanResult = await getOrCreateImage(
                    [
                        entry.prompt,
                        `中国小学古诗词课堂教学插画，《${poem.title}》，${poem.dynasty}代，`,
                        '史实准确，儿童友好，无现代物件，无文字，无人脸特写，暖调中国画审美。',
                    ].join(''),
                    entry.orientation,
                )
            } catch (error) {
                req.log.warn(
                    { err: error, poemId: poem.id, imageIndex: idx },
                    '[culture] Wan2.7 生成失败，已降级为本地教学插画',
                )
            }
            const imageUrl = wanResult?.url ?? scene?.imageUrl ?? ''
            if (!imageUrl) {
                throw new Error('Wan2.7 与本地教学插画均不可用')
            }

            // 调用 eye.vision-annotate 生成视觉描述
            let perspectives: VisionAnnotateOutput | null = null
            try {
                // 视觉标注要交给云端多模态模型去"看"，模型必须能自行抓取该地址，
                // 本地 /uploads 路径它够不着——所以这里用本次生成的远程原图地址。
                // 命中磁盘缓存时没有远程地址，但那种情况下路由早已返回缓存结果，
                // 根本不会走到这里。
                const annotateUrl = wanResult?.remoteUrl ?? imageUrl
                const vaInput: VisionAnnotateInput = {
                    imageUrl: annotateUrl,
                    poemContext: poemNode,
                    purpose: 'cultural-artifact' as VisionPurpose,
                }
                const vaResult = await eyeAgent.visionAnnotate.invoke(vaInput, ctxVA)
                perspectives = vaResult.output
            } catch {
                // 视觉标注失败不阻塞主流程
            }

            const image: CultureImage = {
                id: `img-${poem.id}-${generateId()}`,
                poemId: poem.id,
                title: entry.title,
                imageUrl,
                description: perspectives?.finalAnnotation ?? entry.description,
                culturalMeaning: perspectives?.perspectives.cultural_symbols ?? extractCulturalMeaning(poem, entry.description),
                perspectives: perspectives
                    ? {
                          color_composition: perspectives.perspectives.color_composition,
                          emotion_atmosphere: perspectives.perspectives.emotion_atmosphere,
                          cultural_symbols: perspectives.perspectives.cultural_symbols,
                      }
                    : undefined,
                relatedVerse: entry.relatedVerse,
                orientation: entry.orientation,
                aiGenerated: wanResult !== null,
                source: wanResult ? 'wan2.7' : 'local-illustration',
                model: wanResult?.model,
                generationRequestId: wanResult?.requestId,
                createdAt: Date.now(),
            }
            return image
        }),
    )

    imageResults.forEach((r) => {
        if (r.status === 'fulfilled') {
            images.push(r.value)
        }
    })

    if (images.length === 0) {
        throw new Error('所有图片生成失败')
    }

    return images
}

/**
 * 本地图库是“读取可用性”兜底，不是 AI 结果。它仅使用当前诗篇的题名、作者、
 * 朝代、意象和诗句生成 SVG，因此无网络、无供应商、无跨诗借图依赖。
 */
function generateLocalImageGallery(
    poem: NonNullable<ReturnType<typeof fetchPoem>>,
): CultureImage[] {
    const poemNode = buildPoemNode(poem)
    return generateLocalScenes(poem.id, poemNode).map((scene) => ({
        id: `local-${poem.id}-${scene.sceneType}`,
        poemId: poem.id,
        title: scene.title,
        imageUrl: scene.imageUrl,
        description: scene.description,
        culturalMeaning: scene.culturalMeaning,
        relatedVerse: scene.relatedVerse,
        orientation: scene.orientation,
        aiGenerated: false,
        source: 'local-illustration' as const,
        createdAt: scene.createdAt,
    }))
}

/** 把单诗图库与详情索引一起写入同一运行时缓存，避免详情页找不到刚展示的本地场景。 */
function cacheImageGallery(poemId: string, images: CultureImage[]): void {
    imageGalleryCache.set(poemId, images)
    trimCache(imageGalleryCache)
    for (const image of images) {
        imageCache.set(image.id, image)
        trimCache(imageCache)
    }
}

/** 从诗的意象中提取文化含义（降级用） */
function extractCulturalMeaning(
    poem: NonNullable<ReturnType<typeof fetchPoem>>,
    description: string,
): string {
    const meanings: string[] = []
    for (const img of poem.images) {
        const m = IMAGE_CULTURAL_MEANINGS[img]
        if (m) meanings.push(`${img}：${m}`)
    }
    if (meanings.length === 0) {
        return `本画面呈现《${poem.title}》的意境，描绘${poem.dynasty}代生活场景。${description.slice(0, 80)}`
    }
    return meanings.join('；')
}

/** 查询意象的基础含义（支持别名匹配） */
function lookupImageMeaning(imageName: string): string {
    // 精确匹配
    const direct = IMAGE_CULTURAL_MEANINGS[imageName]
    if (direct) return direct

    // 模糊匹配（包含关系）
    for (const [key, val] of Object.entries(IMAGE_CULTURAL_MEANINGS)) {
        if (key.includes(imageName) || imageName.includes(key)) {
            return val
        }
    }

    return '尚未收录此意象的文化含义，建议结合具体诗篇分析'
}

/** 查找包含某意象的所有诗 */
function findPoemsByImage(imageName: string): Array<{ id: string; title: string; poet: string; dynasty: string; content: string; images: readonly string[] }> {
    const results: Array<{ id: string; title: string; poet: string; dynasty: string; content: string; images: readonly string[] }> = []

    // 从 seed-data 查找
    for (const p of SEED_POEMS) {
        if (p.images.some((img) => img === imageName || img.includes(imageName) || imageName.includes(img))) {
            results.push({
                id: p.id,
                title: p.title,
                poet: p.poet,
                dynasty: p.dynasty,
                content: p.content,
                images: p.images,
            })
        }
    }

    // 从 DB 查找（去重）
    try {
        const dbPoems = repos.poems.findAll(200, 0)
        for (const p of dbPoems) {
            if (results.some((r) => r.id === p.id)) continue
            const imgs = p.images ?? []
            if (imgs.some((img) => img === imageName || img.includes(imageName) || imageName.includes(img))) {
                results.push({
                    id: p.id,
                    title: p.title,
                    poet: p.poet,
                    dynasty: p.dynasty,
                    content: p.content,
                    images: imgs,
                })
            }
        }
    } catch {
        // DB 查询失败，仅返回 seed-data
    }

    return results
}

/**
 * 调用 brush.creative 生成意象深度解读
 */
function buildLocalImageryInterpretation(
    imageName: string,
    baseMeaning: string,
    relatedPoems: Array<{ id: string; title: string; poet: string; dynasty: string }>,
): ImageryInterpretation {
    return {
        imageName,
        baseMeaning,
        deepInterpretation: baseMeaning,
        culturalDimensions: baseMeaning
            .split(/[,，、]/)
            .map((part) => part.trim())
            .filter(Boolean),
        relatedPoems: relatedPoems.map((poem) => ({
            poemId: poem.id,
            title: poem.title,
            poet: poem.poet,
            dynasty: poem.dynasty,
        })),
        aiGenerated: false,
        generatedAt: Date.now(),
    }
}

async function generateImageryDeepInterpretation(
    imageName: string,
    baseMeaning: string,
    relatedPoems: Array<{ id: string; title: string; poet: string; dynasty: string; content: string }>,
): Promise<string> {
    const ctx = buildAgentContext(`img-interp-${imageName}`)

    // 借用 brush.creative（cultural-story 类型），但 poemId 用首篇关联诗
    const primaryPoem = relatedPoems[0]
    const input: CreativeInput = {
        type: 'cultural-story',
        poemId: primaryPoem?.id ?? 'tongbian-003',
        topic: `意象"${imageName}"的文化内涵解读：${baseMeaning}`,
        gradeLevel: '5-6年级',
        constraints: [
            `聚焦意象"${imageName}"的多重文化含义`,
            '从历史演变、文学传统、典型用例三个维度展开',
            `引用至少 2 首包含此意象的古诗${primaryPoem ? `（如《${primaryPoem.title}》${relatedPoems[1] ? `《${relatedPoems[1].title}》` : ''}）` : ''}`,
            '篇幅 400-600 字，Markdown 格式',
        ],
    }

    const localCtx: AgentContext = {
        ...ctx,
        teacherIntent: `为小学高年级教师生成意象"${imageName}"的文化内涵深度解读`,
    }

    const result = await brushAgent.creative.invoke(input, localCtx)
    return result.output.content
}

/** 从基础含义与深度解读中提取文化维度 */
function extractDimensions(baseMeaning: string, deepInterpretation: string): string[] {
    const dims = new Set<string>()
    // 从 baseMeaning 拆分（顿号/逗号分隔）
    for (const part of baseMeaning.split(/[,，、]/)) {
        const t = part.trim()
        if (t && t.length >= 2 && t.length <= 8) dims.add(t)
    }
    // 从 deepInterpretation 中提取加粗或关键词
    const boldMatches = deepInterpretation.match(/\*\*(.+?)\*\*/g)
    if (boldMatches) {
        for (const m of boldMatches) {
            const t = m.replace(/\*\*/g, '').trim()
            if (t && t.length >= 2 && t.length <= 8) dims.add(t)
        }
    }
    return Array.from(dims).slice(0, 8)
}
