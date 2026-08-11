/**
 * 诗歌库智能检索服务（智能备课 · 能力 1）
 *
 * 三大检索能力：
 * 1. 多维检索 —— 按朝代/作者/体裁/题材/意象/年级/难度过滤
 * 2. 全文检索 —— 标题 + 正文 + 注释 LIKE 匹配
 * 3. 语义相似检索 —— deepseek-v4-flash 提取结构化语义特征（替代独立 embedding 接口），
 *    缓存到 SQLite poem_semantic_cache 表，使用加权 Jaccard 相似度排序
 *
 * 设计说明：
 * - DeepSeek API 未提供独立 embeddings 接口，本服务使用结构化语义特征 JSON 作为"语义 embedding"的替代实现
 * - 语义特征包含：主题/情感/意象/题材/体裁/基调/季节/时间，加权计算相似度
 * - 检索结果带 matchScore（0-1）匹配度评分
 * - 体裁从 content 字段按字数 + 句数推断（五言/七言/绝句/律诗/古体）
 *
 * 性能：
 * - 语义特征缓存到 SQLite，避免重复调用 LLM
 * - 多维过滤使用参数化 SQL，避免全表扫描
 */

import { db, repos } from '../../db/index.js'
import { SqliteMap } from '../../db/runtime-store.js'
import { managedLLM } from '../../llm/index.js'
import type { PoemEntity } from '../../db/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 多维检索查询参数 */
export interface PoemSearchQuery {
    /** 关键词（标题/正文/注释全文检索） */
    keyword?: string
    /** 朝代（如"唐"、"宋"） */
    dynasty?: string
    /** 作者 */
    poet?: string
    /** 体裁（五言绝句/七言绝句/五言律诗/七言律诗/古体等） */
    genre?: string
    /** 题材（思乡/山水/送别/田园/边塞/咏物/怀古） */
    subject?: string
    /** 意象（月/柳/雪/花/酒等） */
    imagery?: string
    /** 年级（1-2年级/3-4年级/5-6年级） */
    gradeLevel?: string
    /** 难度 1-5 */
    difficulty?: number
    /** 语义相似检索的自然语言查询（与 keyword 二选一或组合） */
    semanticQuery?: string
    /** 返回结果数量上限，默认 20 */
    limit?: number
    /** 偏移量，默认 0 */
    offset?: number
}

/** 检索结果项 */
export interface PoemSearchResult {
    poem: PoemEntity
    /** 匹配度评分 0-1（综合多维匹配 + 语义相似度） */
    matchScore: number
    /** 匹配维度（命中的维度列表，用于前端展示匹配理由） */
    matchedDimensions: string[]
    /** 推断出的体裁 */
    genre: string
    /** 推断出的题材 */
    subject: string
}

/** 诗歌详情（含 AI 生成的意象分析、典故、文化背景） */
export interface PoemDetail {
    poem: PoemEntity
    genre: string
    subject: string
    /** AI 生成的意象分析 */
    imageryAnalysis: Array<{
        name: string
        meaning: string
        culturalConnotation: string
    }>
    /** AI 生成的典故 */
    allusions: Array<{
        allusion: string
        explanation: string
        relatedText: string
    }>
    /** AI 生成的文化背景 */
    culturalBackground: {
        poetBackground: string
        eraBackground: string
        creationContext: string
    }
    aiGenerated: boolean
}

/** 诗歌语义特征（缓存到 SQLite） */
interface PoemSemanticFeatures {
    themes: string[]
    emotions: string[]
    imagery: string[]
    genre: string
    subject: string
    tone: string
    season?: string
    time?: string
    difficulty: number
    /** 特征生成时间戳 */
    generatedAt: number
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 体裁推断规则 */
const GENRE_PATTERNS: Array<{ pattern: RegExp; genre: string }> = [
    { pattern: /^.{5}[，。].{5}[，。]$/, genre: '五言绝句' },
    { pattern: /^.{5}[，。].{5}[，。].{5}[，。].{5}[，。]$/, genre: '五言律诗' },
    { pattern: /^.{7}[，。].{7}[，。]$/, genre: '七言绝句' },
    { pattern: /^.{7}[，。].{7}[，。].{7}[，。].{7}[，。]$/, genre: '七言律诗' },
]

/** 题材映射（从 theme 关键词推断） */
const SUBJECT_MAP: Array<{ keywords: string[]; subject: string }> = [
    { keywords: ['思乡', '故园', '归', '乡', '客'], subject: '思乡' },
    { keywords: ['山', '水', '江', '河', '湖', '海', '景'], subject: '山水' },
    { keywords: ['送', '别', '离', '赠'], subject: '送别' },
    { keywords: ['田', '农', '桑', '稼', '隐'], subject: '田园' },
    { keywords: ['边', '塞', '戍', '征', '战'], subject: '边塞' },
    { keywords: ['咏', '物', '赞', '颂'], subject: '咏物' },
    { keywords: ['怀', '古', '史', '兴亡'], subject: '怀古' },
    { keywords: ['春', '夏', '秋', '冬', '时'], subject: '时令' },
    { keywords: ['情', '相思', '闺', '怨'], subject: '爱情' },
]

/** 语义特征各维度权重（总和 1.0） */
const FEATURE_WEIGHTS = {
    themes: 0.20,
    emotions: 0.15,
    imagery: 0.25,
    genre: 0.10,
    subject: 0.15,
    tone: 0.10,
    season: 0.025,
    time: 0.025,
} as const

// ─────────────────────────────────────────────────────────────
// 语义特征缓存（SqliteMap 持久化）
// ─────────────────────────────────────────────────────────────

const semanticCache = new SqliteMap<string, PoemSemanticFeatures>({
    table: 'poem_semantic_cache',
    indexes: [{ name: 'poem_id', extract: (_v, k) => k }],
    maxSize: 1000,
})

/**
 * 幂等创建缓存表（SqliteMap 在首次 set 时会因表不存在而失败）
 */
function ensureCacheTable(): void {
    db.prepare(`
        CREATE TABLE IF NOT EXISTS poem_semantic_cache (
            key         TEXT PRIMARY KEY NOT NULL,
            value       TEXT NOT NULL,
            poem_id     TEXT,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        )
    `).run()
    db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_poem_semantic_cache_poem_id ON poem_semantic_cache(poem_id)`,
    ).run()
}

// 模块加载即建表
ensureCacheTable()

// ─────────────────────────────────────────────────────────────
// 公共 API
// ─────────────────────────────────────────────────────────────

/**
 * 多维检索诗歌
 *
 * 流程：
 * 1. 基础过滤（朝代/作者/年级/难度）—— 参数化 SQL WHERE
 * 2. 数组字段过滤（体裁/题材/意象）—— 内存过滤（SQLite JSON 字段不支持原生数组查询）
 * 3. 全文检索（keyword）—— LIKE 匹配标题 + 正文 + 注释
 * 4. 语义相似检索（semanticQuery）—— 加权 Jaccard 相似度
 * 5. 综合评分排序
 */
export async function searchPoems(query: PoemSearchQuery): Promise<PoemSearchResult[]> {
    const limit = Math.min(query.limit ?? 20, 100)
    const offset = Math.max(query.offset ?? 0, 0)

    // ── 第一步：基础 SQL 过滤（朝代/作者/年级/难度） ──
    const conditions: string[] = []
    const params: Array<string | number> = []

    if (query.dynasty) {
        conditions.push('dynasty = ?')
        params.push(query.dynasty)
    }
    if (query.poet) {
        conditions.push('poet LIKE ?')
        params.push(`%${query.poet}%`)
    }
    if (query.gradeLevel) {
        conditions.push('grade_level = ?')
        params.push(query.gradeLevel)
    }
    if (query.difficulty !== undefined) {
        conditions.push('difficulty = ?')
        params.push(query.difficulty)
    }

    // keyword 全文检索
    if (query.keyword) {
        conditions.push('(title LIKE ? OR content LIKE ? OR annotation LIKE ?)')
        const kw = `%${query.keyword}%`
        params.push(kw, kw, kw)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `SELECT * FROM poems ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    params.push(limit + 50, offset) // 多取 50 条用于内存二次过滤

    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    let poems = rows.map((row) => parsePoemRow(row))

    // ── 第二步：内存过滤（体裁/题材/意象） ──
    if (query.genre) {
        poems = poems.filter((p) => computeGenre(p.content) === query.genre)
    }
    if (query.subject) {
        const subject = query.subject
        poems = poems.filter((p) => computeSubject(p.theme).includes(subject))
    }
    if (query.imagery) {
        const imagery = query.imagery
        poems = poems.filter((p) =>
            p.images.some((img) => img.includes(imagery)) ||
            p.content.includes(imagery),
        )
    }

    // ── 第三步：语义相似检索（可选） ──
    let queryFeatures: PoemSemanticFeatures | null = null
    if (query.semanticQuery && query.semanticQuery.trim().length > 0) {
        queryFeatures = await generateSemanticFeatures({
            id: 'query',
            title: '',
            poet: '',
            dynasty: '',
            content: query.semanticQuery,
            annotation: null,
            theme: [],
            images: [],
            rhetoric: [],
            gradeLevel: null,
            textbookEdition: '统编版',
            difficulty: 3,
            createdAt: Date.now(),
            metadata: null,
        })
    }

    // ── 第四步：综合评分 ──
    const results: PoemSearchResult[] = poems.map((poem) => {
        const genre = computeGenre(poem.content)
        const subject = computeSubject(poem.theme)[0] ?? '其他'
        const matchedDimensions: string[] = []
        let matchScore = 0
        let dimensionCount = 0

        // 多维命中加分
        if (query.dynasty && poem.dynasty === query.dynasty) {
            matchedDimensions.push('朝代')
            matchScore += 0.15
            dimensionCount++
        }
        if (query.poet && poem.poet.includes(query.poet)) {
            matchedDimensions.push('作者')
            matchScore += 0.10
            dimensionCount++
        }
        if (query.genre && genre === query.genre) {
            matchedDimensions.push('体裁')
            matchScore += 0.10
            dimensionCount++
        }
        if (query.subject && computeSubject(poem.theme).includes(query.subject)) {
            matchedDimensions.push('题材')
            matchScore += 0.15
            dimensionCount++
        }
        const imagery = query.imagery
        if (imagery && (poem.images.some((i) => i.includes(imagery)) || poem.content.includes(imagery))) {
            matchedDimensions.push('意象')
            matchScore += 0.15
            dimensionCount++
        }
        if (query.gradeLevel && poem.gradeLevel === query.gradeLevel) {
            matchedDimensions.push('年级')
            matchScore += 0.05
            dimensionCount++
        }
        if (query.difficulty !== undefined && poem.difficulty === query.difficulty) {
            matchedDimensions.push('难度')
            matchScore += 0.05
            dimensionCount++
        }
        if (query.keyword && (
            poem.title.includes(query.keyword) ||
            poem.content.includes(query.keyword) ||
            (poem.annotation && JSON.stringify(poem.annotation).includes(query.keyword))
        )) {
            matchedDimensions.push('关键词')
            // 标题命中权重最高
            if (poem.title.includes(query.keyword)) matchScore += 0.20
            else matchScore += 0.10
            dimensionCount++
        }

        // 语义相似度
        if (queryFeatures) {
            const poemFeatures = getOrGenerateFeaturesSync(poem)
            if (poemFeatures) {
                const sim = computeSemanticSimilarity(queryFeatures, poemFeatures)
                if (sim > 0) {
                    matchedDimensions.push('语义相似')
                    matchScore += sim * 0.40
                    dimensionCount++
                }
            }
        }

        // 无任何维度命中时，给予基础分（仅当无过滤条件时）
        if (dimensionCount === 0 && !query.keyword && !query.semanticQuery) {
            matchScore = 0.5
        } else if (dimensionCount === 0) {
            matchScore = 0.1
        }

        matchScore = Math.min(matchScore, 1)

        return {
            poem,
            matchScore,
            matchedDimensions,
            genre,
            subject,
        }
    })

    // 按匹配度降序排序
    results.sort((a, b) => b.matchScore - a.matchScore)

    // 截断到 limit
    return results.slice(0, limit)
}

/**
 * 获取诗歌详情（含 AI 生成的意象分析、典故、文化背景）
 *
 * 优先从缓存读取，未命中则调用 deepseek-v4-flash 生成。
 */
export async function getPoemDetail(poemId: string): Promise<PoemDetail | null> {
    const poem = repos.poems.findById(poemId)
    if (!poem) return null

    const genre = computeGenre(poem.content)
    const subject = computeSubject(poem.theme)[0] ?? '其他'

    // 尝试从缓存读取详情
    const detailCache = new SqliteMap<string, Omit<PoemDetail, 'poem' | 'genre' | 'subject'>>({
        table: 'poem_detail_cache',
        maxSize: 500,
    })
    ensureDetailCacheTable()

    const cacheKey = poemId
    const cached = detailCache.get(cacheKey)

    if (cached) {
        return {
            poem,
            genre,
            subject,
            ...cached,
        }
    }

    // 调用 LLM 生成详情
    const detail = await generatePoemDetailWithLLM(poem)
    detailCache.set(cacheKey, {
        imageryAnalysis: detail.imageryAnalysis,
        allusions: detail.allusions,
        culturalBackground: detail.culturalBackground,
        aiGenerated: detail.aiGenerated,
    })

    return {
        poem,
        genre,
        subject,
        ...detail,
    }
}

/**
 * 推断体裁（五言/七言/绝句/律诗/古体）
 *
 * 规则：按句字数 + 句数推断
 */
export function computeGenre(content: string): string {
    // 移除标点、空白，按句分割
    const cleaned = content.replace(/[，。、！？；：\s\n]/g, ' ').trim()
    const sentences = cleaned.split(/\s+/).filter((s) => s.length > 0)

    if (sentences.length === 0) return '古体'

    const firstLen = sentences[0]?.length ?? 0

    // 匹配规则
    for (const rule of GENRE_PATTERNS) {
        if (rule.pattern.test(content.replace(/\s/g, ''))) {
            return rule.genre
        }
    }

    // 按字数 + 句数推断
    if (firstLen === 5) {
        if (sentences.length === 4) return '五言绝句'
        if (sentences.length === 8) return '五言律诗'
        return '五言古体'
    }
    if (firstLen === 7) {
        if (sentences.length === 4) return '七言绝句'
        if (sentences.length === 8) return '七言律诗'
        return '七言古体'
    }

    return '古体'
}

/**
 * 推断题材（思乡/山水/送别/田园/边塞/咏物/怀古）
 */
export function computeSubject(themes: string[]): string[] {
    const subjects = new Set<string>()
    const allText = themes.join('')

    for (const rule of SUBJECT_MAP) {
        if (rule.keywords.some((kw) => allText.includes(kw))) {
            subjects.add(rule.subject)
        }
    }

    if (subjects.size === 0) {
        subjects.add('其他')
    }

    return Array.from(subjects)
}

// ─────────────────────────────────────────────────────────────
// 内部函数：语义特征生成与相似度计算
// ─────────────────────────────────────────────────────────────

/**
 * 同步获取语义特征（从缓存），未命中时返回 null
 */
function getOrGenerateFeaturesSync(poem: PoemEntity): PoemSemanticFeatures | null {
    const cached = semanticCache.get(poem.id)
    if (cached) return cached
    // 异步生成由调用方触发，此处仅返回缓存
    return null
}

/**
 * 异步生成语义特征（调用 deepseek-v4-flash）
 *
 * 缓存命中时直接返回，未命中时调用 LLM 提取结构化语义特征。
 */
async function generateSemanticFeatures(poem: PoemEntity): Promise<PoemSemanticFeatures> {
    // 检查缓存
    const cached = semanticCache.get(poem.id)
    if (cached) return cached

    const systemPrompt = `你是古诗词语义分析专家。请从诗歌中提取结构化语义特征，用于语义相似检索。
严格输出 JSON 格式，不要添加任何解释文字。

JSON 结构：
{
    "themes": ["主题1", "主题2"],
    "emotions": ["情感1", "情感2"],
    "imagery": ["意象1", "意象2"],
    "genre": "体裁（如五言绝句/七言律诗）",
    "subject": "题材（思乡/山水/送别/田园/边塞/咏物/怀古/时令/爱情/其他）",
    "tone": "基调（如雄浑/婉约/清新/悲壮/豪放/淡泊）",
    "season": "季节（春/夏/秋/冬/无，若无明确季节填'无'）",
    "time": "时间（白天/夜晚/黄昏/清晨/无）",
    "difficulty": 3
}

要求：
- themes 和 emotions 各 2-5 个，简短（2-4字）
- imagery 提取诗中核心意象 2-5 个
- difficulty 1-5 整数（1 最易，5 最难）`

    const userPrompt = `诗歌：${poem.title}（${poem.dynasty}·${poem.poet}）
正文：${poem.content}
${poem.theme.length > 0 ? `已知主题：${poem.theme.join('、')}` : ''}
${poem.images.length > 0 ? `已知意象：${poem.images.join('、')}` : ''}`

    try {
        const result = await managedLLM.chat({
            model: 'deepseek-v4-flash',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            thinking: 'low',
            temperature: 0.3,
            maxTokens: 800,
            jsonOutput: true,
            metadata: { agent: 'poem-search', task: `semantic-${poem.id}` },
        })

        const features = parseSemanticFeatures(result.content, poem)
        semanticCache.set(poem.id, features)
        return features
    } catch {
        // LLM 调用失败时返回基础特征
        const fallback: PoemSemanticFeatures = {
            themes: poem.theme,
            emotions: [],
            imagery: poem.images,
            genre: computeGenre(poem.content),
            subject: computeSubject(poem.theme)[0] ?? '其他',
            tone: '淡泊',
            season: '无',
            time: '无',
            difficulty: poem.difficulty,
            generatedAt: Date.now(),
        }
        return fallback
    }
}

/**
 * 解析 LLM 返回的语义特征 JSON
 */
function parseSemanticFeatures(content: string, poem: PoemEntity): PoemSemanticFeatures {
    try {
        const parsed = JSON.parse(content) as Partial<PoemSemanticFeatures>
        return {
            themes: Array.isArray(parsed.themes) ? parsed.themes.slice(0, 5) : poem.theme,
            emotions: Array.isArray(parsed.emotions) ? parsed.emotions.slice(0, 5) : [],
            imagery: Array.isArray(parsed.imagery) ? parsed.imagery.slice(0, 5) : poem.images,
            genre: typeof parsed.genre === 'string' ? parsed.genre : computeGenre(poem.content),
            subject: typeof parsed.subject === 'string' ? parsed.subject : computeSubject(poem.theme)[0] ?? '其他',
            tone: typeof parsed.tone === 'string' ? parsed.tone : '淡泊',
            season: typeof parsed.season === 'string' ? parsed.season : '无',
            time: typeof parsed.time === 'string' ? parsed.time : '无',
            difficulty: typeof parsed.difficulty === 'number' ? Math.max(1, Math.min(5, parsed.difficulty)) : poem.difficulty,
            generatedAt: Date.now(),
        }
    } catch {
        return {
            themes: poem.theme,
            emotions: [],
            imagery: poem.images,
            genre: computeGenre(poem.content),
            subject: computeSubject(poem.theme)[0] ?? '其他',
            tone: '淡泊',
            season: '无',
            time: '无',
            difficulty: poem.difficulty,
            generatedAt: Date.now(),
        }
    }
}

/**
 * 计算两个语义特征的加权 Jaccard 相似度
 *
 * 各维度按 FEATURE_WEIGHTS 加权，总分 0-1
 */
function computeSemanticSimilarity(a: PoemSemanticFeatures, b: PoemSemanticFeatures): number {
    let totalScore = 0

    // themes（Jaccard）
    totalScore += FEATURE_WEIGHTS.themes * jaccardSimilarity(a.themes, b.themes)
    // emotions
    totalScore += FEATURE_WEIGHTS.emotions * jaccardSimilarity(a.emotions, b.emotions)
    // imagery
    totalScore += FEATURE_WEIGHTS.imagery * jaccardSimilarity(a.imagery, b.imagery)
    // genre（精确匹配）
    totalScore += FEATURE_WEIGHTS.genre * (a.genre === b.genre ? 1 : 0)
    // subject（精确匹配）
    totalScore += FEATURE_WEIGHTS.subject * (a.subject === b.subject ? 1 : 0)
    // tone（精确匹配）
    totalScore += FEATURE_WEIGHTS.tone * (a.tone === b.tone ? 1 : 0)
    // season
    totalScore += FEATURE_WEIGHTS.season * (a.season === b.season && a.season !== '无' ? 1 : 0)
    // time
    totalScore += FEATURE_WEIGHTS.time * (a.time === b.time && a.time !== '无' ? 1 : 0)

    return totalScore
}

/**
 * Jaccard 相似度（交集 / 并集）
 */
function jaccardSimilarity(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) return 0
    const setA = new Set(a)
    const setB = new Set(b)
    let intersection = 0
    for (const item of setA) {
        if (setB.has(item)) intersection++
    }
    const union = setA.size + setB.size - intersection
    return union === 0 ? 0 : intersection / union
}

// ─────────────────────────────────────────────────────────────
// 内部函数：诗歌详情生成
// ─────────────────────────────────────────────────────────────

/**
 * 幂等创建详情缓存表
 */
function ensureDetailCacheTable(): void {
    db.prepare(`
        CREATE TABLE IF NOT EXISTS poem_detail_cache (
            key         TEXT PRIMARY KEY NOT NULL,
            value       TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        )
    `).run()
}

/**
 * 调用 deepseek-v4-flash 生成诗歌详情
 */
async function generatePoemDetailWithLLM(
    poem: PoemEntity,
): Promise<Omit<PoemDetail, 'poem' | 'genre' | 'subject'>> {
    const systemPrompt = `你是古诗词教学专家。请为给定诗歌生成详细的教学资料，包括意象分析、典故、文化背景。
严格输出 JSON 格式，不要添加任何解释文字。

JSON 结构：
{
    "imageryAnalysis": [
        { "name": "意象名", "meaning": "含义阐释", "culturalConnotation": "文化内涵" }
    ],
    "allusions": [
        { "allusion": "典故名", "explanation": "典故解释", "relatedText": "相关诗句" }
    ],
    "culturalBackground": {
        "poetBackground": "诗人背景",
        "eraBackground": "时代背景",
        "creationContext": "创作语境"
    }
}

要求：
- 意象分析 2-5 条，每条含义 30-80 字，文化内涵 30-80 字
- 典故 0-3 条（无典故时返回空数组）
- 文化背景各字段 50-150 字
- 内容适合小学语文教师参考`

    const userPrompt = `诗歌：${poem.title}（${poem.dynasty}·${poem.poet}）
正文：${poem.content}
${poem.annotation ? `注释：${JSON.stringify(poem.annotation)}` : ''}
${poem.theme.length > 0 ? `主题：${poem.theme.join('、')}` : ''}
${poem.images.length > 0 ? `意象：${poem.images.join('、')}` : ''}
${poem.rhetoric.length > 0 ? `修辞：${poem.rhetoric.join('、')}` : ''}`

    try {
        const result = await managedLLM.chat({
            model: 'deepseek-v4-flash',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            thinking: 'medium',
            temperature: 0.4,
            maxTokens: 2500,
            jsonOutput: true,
            metadata: { agent: 'poem-search', task: `detail-${poem.id}` },
        })

        const parsed = parsePoemDetail(result.content)
        return { ...parsed, aiGenerated: true }
    } catch {
        // 降级：返回基础内容
        return {
            imageryAnalysis: poem.images.slice(0, 3).map((img) => ({
                name: img,
                meaning: `诗中"${img}"意象传达核心情感`,
                culturalConnotation: `${img}在古典诗词中常承载特定文化内涵`,
            })),
            allusions: [],
            culturalBackground: {
                poetBackground: `${poem.poet}（${poem.dynasty}）的代表作品之一`,
                eraBackground: `${poem.dynasty}时期的社会风貌与文学特征`,
                creationContext: `此诗为${poem.poet}抒发情思之作`,
            },
            aiGenerated: false,
        }
    }
}

/**
 * 解析 LLM 返回的诗歌详情 JSON
 */
function parsePoemDetail(
    content: string,
): Pick<PoemDetail, 'imageryAnalysis' | 'allusions' | 'culturalBackground'> {
    try {
        const parsed = JSON.parse(content) as Partial<PoemDetail>
        return {
            imageryAnalysis: Array.isArray(parsed.imageryAnalysis) ? parsed.imageryAnalysis : [],
            allusions: Array.isArray(parsed.allusions) ? parsed.allusions : [],
            culturalBackground: parsed.culturalBackground ?? {
                poetBackground: '',
                eraBackground: '',
                creationContext: '',
            },
        }
    } catch {
        return {
            imageryAnalysis: [],
            allusions: [],
            culturalBackground: {
                poetBackground: '',
                eraBackground: '',
                creationContext: '',
            },
        }
    }
}

// ─────────────────────────────────────────────────────────────
// 内部函数：行解析
// ─────────────────────────────────────────────────────────────

/**
 * 解析 SQLite 行为 PoemEntity（复用 PoemRepository.mapper.fromRow 逻辑）
 *
 * 此函数与 PoemRepository.mapper.fromRow 保持一致，
 * 因 mapper 为 protected 属性无法外部访问，故在此复制实现。
 */
function parsePoemRow(row: Record<string, unknown>): PoemEntity {
    const parseJson = <T>(s: string | null): T | null => {
        if (!s) return null
        try { return JSON.parse(s) as T } catch { return null }
    }
    const parseStringArray = (s: string | null): string[] => {
        if (!s) return []
        try {
            const arr = JSON.parse(s) as unknown
            return Array.isArray(arr) ? arr.map((x) => String(x)) : []
        } catch { return [] }
    }

    return {
        id: row['id'] as string,
        title: row['title'] as string,
        poet: row['poet'] as string,
        dynasty: row['dynasty'] as string,
        content: row['content'] as string,
        annotation: parseJson<Record<string, string>>(row['annotation'] as string | null),
        theme: parseStringArray(row['theme'] as string | null),
        images: parseStringArray(row['images'] as string | null),
        rhetoric: parseStringArray(row['rhetoric'] as string | null),
        gradeLevel: (row['grade_level'] as string | null) ?? null,
        textbookEdition: (row['textbook_edition'] as string) ?? '统编版',
        difficulty: row['difficulty'] as number,
        createdAt: row['created_at'] as number,
        metadata: parseJson(row['metadata'] as string | null),
    }
}
