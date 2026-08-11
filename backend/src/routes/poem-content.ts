/**
 * 诗内容教学路由 —— GET /api/poem-content/:poemId
 *
 * 背景（v5.1 接口打通）：
 * 课堂导播台的「逐句讲解」面板（ExplainPanel）同时依赖两个端点：
 *   - GET /api/classroom/explain/:poemId  → 教学要点（已有）
 *   - GET /api/poem-content/:poemId       → 原文/拼音/译文/生字（此前缺失，整个面板报错空白）
 * 本模块补齐后一个。
 *
 * 数据分层（重要）：
 * 1) 结构与注释来自 poems 表的人工维护数据（content / annotation / theme / rhetoric）；
 *    是否完成双信源与语文教师逐首复核，必须以 sourceVerification 字段为准；
 * 2) 逐字拼音与现代汉语译文库中没有，需要 deepseek 生成，生成结果**持久化**到
 *    poems.metadata.teachingContent，同一首诗只付费一次，后续直接命中缓存；
 * 3) AI 不可用时不编造拼音和译文——返回空 pinyin 数组与空译文，并置 aiGenerated=false，
 *    让前端如实展示「译文待生成」，而不是拿错误的注音去教小学生。
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { repos } from '../db/index.js'
import { managedLLM } from '../llm/index.js'
import { validateParams } from '../lib/validation.js'
import { handleRouteError } from './_helpers.js'
import { splitPoemClauses, countHanChars } from '../lib/poem-lines.js'
import type { PoemEntity } from '../db/types.js'
import { getPoemVerification, type PoemSourceVerification } from '../services/content-verification/poem-provenance.js'
import {
    TEACHING_CONTENT_CACHE_VERSION,
    computeTeachingContentSourceFingerprint,
    isTeachingContentCacheCurrent,
} from '../services/content-verification/teaching-content-cache.js'
import { assertTeachingContentMatchesPoem } from '../services/content-verification/teaching-content-output.js'
import { config } from '../config.js'

// ─────────────────────────────────────────────────────────────
// 类型（与前端 lib/types.ts 的 PoemContent 严格对齐）
// ─────────────────────────────────────────────────────────────

type CharacterDifficulty = 'easy' | 'medium' | 'hard'

interface LineContent {
    lineIndex: number
    original: string
    pinyin: string[]
    translation: string
    annotations?: Array<{ word: string; explanation: string }>
}

interface CharacterInfo {
    char: string
    pinyin: string
    meaning: string
    partOfSpeech: string
    usage: string
    difficulty: CharacterDifficulty
    isPolyphone: boolean
    otherReadings?: string[]
    isNew: boolean
}

interface PoemContent {
    poemId: string
    poemTitle: string
    poet: string
    dynasty: string
    lines: LineContent[]
    characters: CharacterInfo[]
    overallTranslation: string
    theme: string
    rhetoricAnalysis?: Array<{ type: string; example: string; effect: string }>
    aiGenerated: boolean
    sourceVerification: PoemSourceVerification
    teachingContentReviewStatus: 'NOT_GENERATED' | 'AI_UNVERIFIED'
}

/** AI 生成结果在 poems.metadata 下的缓存键 */
const CACHE_KEY = 'teachingContent'

interface CachedTeachingContent {
    version: number
    /** 生成时实际送入模型的所有教学输入的 SHA-256；原文/注释等改动即失效。 */
    sourceFingerprint: string
    generatedAt: number
    lines: Array<{ lineIndex: number; pinyin: string[]; translation: string }>
    characters: CharacterInfo[]
    overallTranslation: string
    rhetoricAnalysis?: Array<{ type: string; example: string; effect: string }>
}

const poemIdParamsSchema = z.object({
    poemId: z.string().trim().min(1).max(80),
})

/** AI 输出结构校验（宁可整体降级，也不把半截结构塞给前端） */
const aiOutputSchema = z.object({
    lines: z.array(
        z.object({
            lineIndex: z.number().int().min(0),
            pinyin: z.array(z.string()),
            translation: z.string(),
        }),
    ),
    characters: z.array(
        z.object({
            char: z.string().min(1),
            pinyin: z.string(),
            meaning: z.string(),
            partOfSpeech: z.string(),
            usage: z.string(),
            difficulty: z.enum(['easy', 'medium', 'hard']),
            isPolyphone: z.boolean(),
            otherReadings: z.array(z.string()).optional(),
            isNew: z.boolean(),
        }),
    ),
    overallTranslation: z.string(),
    rhetoricAnalysis: z
        .array(z.object({ type: z.string(), example: z.string(), effect: z.string() }))
        .optional(),
})

/** 从人工注释中挑出落在该行的词条 */
function annotationsForLine(line: string, annotation: Record<string, string> | null): Array<{ word: string; explanation: string }> {
    if (!annotation) return []
    return Object.entries(annotation)
        .filter(([word]) => line.includes(word))
        .map(([word, explanation]) => ({ word, explanation }))
}

/**
 * 调用 deepseek 生成拼音 / 译文 / 生字表
 *
 * 使用 medium 思考档：这是一次结构化的语言学标注任务，
 * 不需要 max 档的深度推理，medium 已足够且更省成本与时延。
 */
async function generateTeachingContent(
    poem: PoemEntity,
    lines: string[],
    sourceFingerprint: string,
): Promise<CachedTeachingContent> {
    const annotationText = poem.annotation
        ? Object.entries(poem.annotation).map(([w, m]) => `${w}：${m}`).join('；')
        : '（无）'

    const result = await managedLLM.chat({
        model: 'deepseek-v4-pro',
        thinking: 'medium',
        jsonOutput: true,
        temperature: 0.2,
        maxTokens: 4096,
        messages: [
            {
                role: 'system',
                content:
                    '你是小学语文古诗教学的字词标注专家。请为给定古诗输出严格 JSON，' +
                    '用于小学课堂的识字与译文教学。注音必须准确（现代汉语普通话读音，带声调符号），' +
                    '译文必须是通顺的现代汉语，面向小学生，不使用文言。禁止编造原文中不存在的字词。',
            },
            {
                role: 'user',
                content:
                    `诗题：《${poem.title}》\n作者：${poem.dynasty} · ${poem.poet}\n` +
                    `学段：${poem.gradeLevel ?? '小学'}\n` +
                    `主题：${poem.theme.join('、') || '（无）'}\n` +
                    `修辞：${poem.rhetoric.join('、') || '（无）'}\n` +
                    `人工维护注释（仍须教师复核）：${annotationText}\n\n` +
                    `诗句（按行，lineIndex 从 0 开始）：\n` +
                    lines.map((l, i) => `${i}. ${l}`).join('\n') +
                    `\n\n请输出 JSON，字段如下：\n` +
                    `{\n` +
                    `  "lines": [{"lineIndex": 0, "pinyin": ["每个汉字一个拼音，数组长度必须等于该行汉字数"], "translation": "该句现代汉语译文"}],\n` +
                    `  "characters": [{"char":"单个汉字","pinyin":"带声调","meaning":"在本诗语境下的释义","partOfSpeech":"名/动/形/副/介/连/助/叹/数/量","usage":"本诗中的用法或例词","difficulty":"easy|medium|hard","isPolyphone":true/false,"otherReadings":["其他读音"],"isNew":true/false}],\n` +
                    `  "overallTranslation": "全诗大意，100-200 字",\n` +
                    `  "rhetoricAnalysis": [{"type":"修辞名","example":"原文例句","effect":"表达效果"}]\n` +
                    `}\n` +
                    `characters 只收录需要小学生重点识记的生字或难字（5-12 个），isNew 标记是否为本学段生字。`,
            },
        ],
        metadata: { agent: 'poem-content', task: `teaching-content-${poem.id}` },
    })

    const parsed = aiOutputSchema.parse(JSON.parse(result.content))
    assertTeachingContentMatchesPoem(parsed, lines)
    return {
        version: TEACHING_CONTENT_CACHE_VERSION,
        sourceFingerprint,
        generatedAt: Date.now(),
        lines: parsed.lines,
        characters: parsed.characters,
        overallTranslation: parsed.overallTranslation,
        rhetoricAnalysis: parsed.rhetoricAnalysis,
    }
}

export const poemContentRoutes: FastifyPluginAsync = async (app) => {
    /**
     * GET /:poemId —— 诗的完整教学内容
     *
     * 命中缓存直接返回；未命中则调用 deepseek 生成并写回 poems.metadata。
     */
    app.get('/:poemId', async (req: FastifyRequest, reply) => {
        const params = validateParams(poemIdParamsSchema, req, reply)
        if (!params) return

        try {
            const poem = repos.poems.findById(params.poemId)
            if (!poem) {
                return reply.code(404).send({
                    status: 'error',
                    error: 'NOT_FOUND',
                    message: '古诗不存在',
                })
            }

            const rawLines = splitPoemClauses(poem.content)

            // ── 读缓存 ──
            const meta = (poem.metadata ?? {}) as Record<string, unknown>
            const cached = meta[CACHE_KEY] as CachedTeachingContent | undefined
            const sourceFingerprint = computeTeachingContentSourceFingerprint({
                id: poem.id,
                title: poem.title,
                poet: poem.poet,
                dynasty: poem.dynasty,
                content: poem.content,
                gradeLevel: poem.gradeLevel,
                theme: poem.theme,
                rhetoric: poem.rhetoric,
                annotation: poem.annotation,
            })
            let generated: CachedTeachingContent | null =
                isTeachingContentCacheCurrent(cached, sourceFingerprint) ? cached : null

            // ── 未命中则生成 ──
            // DEMO_MODE 的启动契约明确表示外部 AI 不可用；必须立即返回原文/人工注释，
            // 不能在离线演示里等待一个注定失败的网络请求。
            if (!generated && !config.demoMode) {
                try {
                    generated = await generateTeachingContent(poem, rawLines, sourceFingerprint)
                    repos.poems.update(poem.id, {
                        metadata: { ...meta, [CACHE_KEY]: generated },
                    })
                } catch (err) {
                    // 生成失败不阻断：退回到「只有人工维护结构与注释」的降级形态
                    req.log.warn({ err, poemId: poem.id }, '[poem-content] AI 生成降级，仅返回教材结构与注释')
                    generated = null
                }
            }

            const byIndex = new Map(
                (generated?.lines ?? []).map((l) => [l.lineIndex, l] as const),
            )

            const lines: LineContent[] = rawLines.map((original, lineIndex) => {
                const ai = byIndex.get(lineIndex)
                const annotations = annotationsForLine(original, poem.annotation)
                return {
                    lineIndex,
                    original,
                    // 拼音数组长度必须与汉字数一致，否则前端逐字对齐会错位；
                    // 长度对不上时宁可丢弃这一行的注音，也不做截断/补空的猜测。
                    pinyin:
                        ai && ai.pinyin.length === countHanChars(original)
                            ? ai.pinyin
                            : [],
                    translation: ai?.translation ?? '',
                    ...(annotations.length > 0 ? { annotations } : {}),
                }
            })

            const body: PoemContent = {
                poemId: poem.id,
                poemTitle: poem.title,
                poet: poem.poet,
                dynasty: poem.dynasty,
                lines,
                characters: generated?.characters ?? [],
                overallTranslation: generated?.overallTranslation ?? '',
                theme: poem.theme.join('、'),
                ...(generated?.rhetoricAnalysis
                    ? { rhetoricAnalysis: generated.rhetoricAnalysis }
                    : poem.rhetoric.length > 0
                        ? {
                            // 无 AI 分析时，只列出人工维护的修辞标签（effect 留空，不冒充教师结论）
                            rhetoricAnalysis: poem.rhetoric.map((type) => ({
                                type,
                                example: '',
                                effect: '',
                            })),
                        }
                        : {}),
                aiGenerated: generated !== null,
                sourceVerification: getPoemVerification({
                    id: poem.id,
                    title: poem.title,
                    poet: poem.poet,
                    dynasty: poem.dynasty,
                    content: poem.content,
                }),
                teachingContentReviewStatus: generated ? 'AI_UNVERIFIED' : 'NOT_GENERATED',
            }

            return reply.send({ status: 'ok', ...body })
        } catch (err) {
            handleRouteError(err, req, reply, '诗内容加载失败')
            return
        }
    })
}

export default poemContentRoutes
