/**
 * 教学目标智能生成服务（智能备课 · 能力 2）
 *
 * 输入：诗歌 + 年级 + 课时数
 * 输出：按 Bloom 认知六阶（记忆/理解/应用/分析/评价/创造）分类的教学目标，
 *       每级 2-3 条，可编辑，JSON + Zod 校验
 *
 * LLM：deepseek-v4-pro，high 思考模式
 *
 * 设计要点：
 * - Bloom 六阶完整覆盖，每级 2-3 条目标，避免遗漏高阶思维培养
 * - 目标可测量：每条目标附评估方式（如何检测达成）
 * - 适配年级：1-2年级重记忆理解，3-4年级重应用分析，5-6年级重评价创造
 * - 课时分配：1课时聚焦核心目标，2-3课时覆盖完整六阶
 * - Zod 校验：严格校验 LLM 输出结构，失败重试一次
 */

import { z } from 'zod'
import { managedLLM } from '../../llm/index.js'
import { repos } from '../../db/index.js'
import { computeGenre, computeSubject } from './poem-search.js'
import type { BloomLevel } from '../../agents/base/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

export type ObjectiveGradeLevel = '1-2年级' | '3-4年级' | '5-6年级'

/** 教学目标生成请求 */
export interface ObjectiveGenerateRequest {
    poemId: string
    gradeLevel: ObjectiveGradeLevel
    lessonCount: 1 | 2 | 3
    /** 班级薄弱 Bloom 层级（可选，用于针对性强化） */
    weakBloomLevels?: BloomLevel[]
    /** 教师偏好（可选，影响目标风格） */
    teacherPreference?: string
}

/** 单条教学目标 */
export interface TeachingObjective {
    /** Bloom 层级 */
    bloomLevel: BloomLevel
    /** 目标分类（knowledge 知识 / ability 能力 / emotion 情感） */
    category: 'knowledge' | 'ability' | 'emotion'
    /** 目标描述 */
    description: string
    /** 评估方式 */
    assessment: string
    /** 该目标在第几课时达成 */
    lessonIndex: number
}

/** 教学目标生成响应 */
export interface ObjectiveGenerateResponse {
    objectives: TeachingObjective[]
    /** 设计说明 */
    designNotes: string
    /** Bloom 六阶覆盖情况 */
    bloomCoverage: Record<BloomLevel, number>
    aiGenerated: boolean
    generatedAt: number
}

// ─────────────────────────────────────────────────────────────
// Zod 校验 Schema
// ─────────────────────────────────────────────────────────────

const bloomLevelSchema = z.enum(['记忆', '理解', '应用', '分析', '评价', '创造'])

const objectiveSchema = z.object({
    bloomLevel: bloomLevelSchema,
    category: z.enum(['knowledge', 'ability', 'emotion']),
    description: z.string().min(5, '目标描述至少 5 字').max(200, '目标描述不超过 200 字'),
    assessment: z.string().min(5, '评估方式至少 5 字').max(200, '评估方式不超过 200 字'),
    lessonIndex: z.number().int().min(1).max(3),
})

const objectiveGenerateResponseSchema = z.object({
    objectives: z.array(objectiveSchema).min(6, '至少 6 条目标').max(20, '最多 20 条目标'),
    designNotes: z.string().min(10).max(1000),
    bloomCoverage: z.record(bloomLevelSchema, z.number().min(0).max(1)),
})

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 各年级 Bloom 侧重权重（影响目标数量分配） */
const GRADE_BLOOM_WEIGHTS: Record<ObjectiveGradeLevel, Record<BloomLevel, number>> = {
    '1-2年级': {
        记忆: 0.30, 理解: 0.25, 应用: 0.20, 分析: 0.15, 评价: 0.05, 创造: 0.05,
    },
    '3-4年级': {
        记忆: 0.20, 理解: 0.20, 应用: 0.20, 分析: 0.20, 评价: 0.10, 创造: 0.10,
    },
    '5-6年级': {
        记忆: 0.15, 理解: 0.15, 应用: 0.20, 分析: 0.20, 评价: 0.15, 创造: 0.15,
    },
}

/** 1 课时目标数量 / 2-3 课时目标数量 */
const OBJECTIVE_COUNT_BY_LESSON: Record<number, { min: number; max: number }> = {
    1: { min: 6, max: 9 },
    2: { min: 10, max: 15 },
    3: { min: 14, max: 18 },
}

// ─────────────────────────────────────────────────────────────
// 公共 API
// ─────────────────────────────────────────────────────────────

/**
 * 生成 Bloom 六阶教学目标
 *
 * 使用 deepseek-v4-pro high 思考模式，严格输出 JSON 结构。
 * 失败时重试一次；重试仍失败则降级返回模板目标。
 */
export async function generateObjectives(
    req: ObjectiveGenerateRequest,
): Promise<ObjectiveGenerateResponse> {
    const poem = repos.poems.findById(req.poemId)
    if (!poem) {
        throw new Error(`诗歌不存在: ${req.poemId}`)
    }

    const genre = computeGenre(poem.content)
    const subject = computeSubject(poem.theme)[0] ?? '其他'
    const countRange = OBJECTIVE_COUNT_BY_LESSON[req.lessonCount] ?? OBJECTIVE_COUNT_BY_LESSON[1]!

    const systemPrompt = buildSystemPrompt(req.gradeLevel, req.lessonCount, countRange, req.weakBloomLevels)
    const userPrompt = buildUserPrompt(poem, genre, subject, req.gradeLevel, req.lessonCount, req.weakBloomLevels, req.teacherPreference)

    // 第一次尝试
    let response = await callLLM(systemPrompt, userPrompt)
    if (response) {
        return finalizeResponse(response, true)
    }

    // 重试一次（降低温度）
    response = await callLLM(systemPrompt, userPrompt, 0.5)
    if (response) {
        return finalizeResponse(response, true)
    }

    // 降级：生成模板目标
    return generateFallbackObjectives(poem, genre, subject, req.gradeLevel, req.lessonCount, req.weakBloomLevels)
}

// ─────────────────────────────────────────────────────────────
// 内部函数：LLM 调用与解析
// ─────────────────────────────────────────────────────────────

/**
 * 构建 system prompt
 */
function buildSystemPrompt(
    gradeLevel: ObjectiveGradeLevel,
    lessonCount: number,
    countRange: { min: number; max: number },
    weakBloomLevels?: BloomLevel[],
): string {
    const weights = GRADE_BLOOM_WEIGHTS[gradeLevel]
    const emphasisText = weakBloomLevels && weakBloomLevels.length > 0
        ? `\n班级薄弱 Bloom 层级：${weakBloomLevels.join('、')}。请针对这些层级加强目标设计，每级至少 3 条。`
        : ''

    return `你是小学语文古诗教学设计专家，擅长按 Bloom 认知分类法设计教学目标。

任务：为指定古诗生成 Bloom 六阶教学目标。

输出要求：
1. 严格输出 JSON 格式，不要任何解释文字
2. 目标数量：${countRange.min}-${countRange.max} 条
3. Bloom 六阶完整覆盖：记忆、理解、应用、分析、评价、创造
4. 每阶 ${lessonCount === 1 ? '1-2' : '2-3'} 条目标
5. ${gradeLevel}年级 Bloom 权重参考：${JSON.stringify(weights)}${emphasisText}

JSON 结构：
{
    "objectives": [
        {
            "bloomLevel": "记忆|理解|应用|分析|评价|创造",
            "category": "knowledge|ability|emotion",
            "description": "目标描述（5-200字，行为动词开头）",
            "assessment": "评估方式（5-200字，具体可测量）",
            "lessonIndex": 1
        }
    ],
    "designNotes": "设计说明（10-1000字，阐述目标设计思路）",
    "bloomCoverage": {
        "记忆": 0.2, "理解": 0.2, "应用": 0.15, "分析": 0.15, "评价": 0.15, "创造": 0.15
    }
}

目标设计原则：
- 记忆：正确朗读、背诵、默写生字
- 理解：解释诗意、翻译诗句
- 应用：运用修辞手法、模仿造句
- 分析：分析意象、修辞效果、结构
- 评价：鉴赏评价、比较异同、表达感受
- 创造：改写创作、配画配乐、拓展延伸
- 每条目标必须可测量：明确"如何检测达成"
- lessonIndex 表示该目标在第几课时达成（1-${lessonCount}）`
}

/**
 * 构建 user prompt
 */
function buildUserPrompt(
    poem: { title: string; poet: string; dynasty: string; content: string; theme: string[]; images: string[]; rhetoric: string[] },
    genre: string,
    subject: string,
    gradeLevel: ObjectiveGradeLevel,
    lessonCount: number,
    weakBloomLevels?: BloomLevel[],
    teacherPreference?: string,
): string {
    return `诗歌：《${poem.title}》
作者：${poem.dynasty}·${poem.poet}
体裁：${genre}
题材：${subject}
正文：${poem.content}
${poem.theme.length > 0 ? `主题：${poem.theme.join('、')}` : ''}
${poem.images.length > 0 ? `意象：${poem.images.join('、')}` : ''}
${poem.rhetoric.length > 0 ? `修辞：${poem.rhetoric.join('、')}` : ''}

教学年级：${gradeLevel}
课时数：${lessonCount}
${weakBloomLevels && weakBloomLevels.length > 0 ? `班级薄弱层级：${weakBloomLevels.join('、')}` : ''}
${teacherPreference ? `教师偏好：${teacherPreference}` : ''}

请生成 Bloom 六阶教学目标。`
}

/**
 * 调用 deepseek-v4-pro 生成教学目标
 *
 * @returns 解析后的响应，失败返回 null
 */
async function callLLM(
    systemPrompt: string,
    userPrompt: string,
    temperature = 0.7,
): Promise<ObjectiveGenerateResponse | null> {
    try {
        const result = await managedLLM.chat({
            model: 'deepseek-v4-pro',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            thinking: 'high',
            temperature,
            maxTokens: 3000,
            jsonOutput: true,
            metadata: { agent: 'objective-generator', task: 'generate-objectives' },
        })

        return parseResponse(result.content)
    } catch {
        return null
    }
}

/**
 * 解析并校验 LLM 响应
 */
function parseResponse(content: string): ObjectiveGenerateResponse | null {
    try {
        const parsed = JSON.parse(content)
        const result = objectiveGenerateResponseSchema.safeParse(parsed)
        if (!result.success) {
            return null
        }

        return finalizeResponse(result.data, true)
    } catch {
        return null
    }
}

/**
 * 完善响应（补充生成时间戳和 Bloom 覆盖率校验）
 *
 * 注意：Zod 的 z.record 产出 Partial<Record<BloomLevel, number>>，
 * 因此入参的 bloomCoverage 允许部分缺失，由 computeBloomCoverage 补全。
 */
type FinalizeInput = Omit<ObjectiveGenerateResponse, 'generatedAt' | 'aiGenerated' | 'bloomCoverage'> & {
    bloomCoverage?: Partial<Record<BloomLevel, number>>
}

function finalizeResponse(
    data: FinalizeInput,
    aiGenerated: boolean,
): ObjectiveGenerateResponse {
    // 补充 bloomCoverage（若缺失或不完整则由 objectives 重新计算）
    const bloomCoverage: Record<BloomLevel, number> = {
        记忆: 0, 理解: 0, 应用: 0, 分析: 0, 评价: 0, 创造: 0,
        ...(data.bloomCoverage ?? {}),
    }
    // 若全为零（即未提供），则根据 objectives 计算
    const sum = Object.values(bloomCoverage).reduce((a, b) => a + b, 0)
    const finalCoverage = sum > 0 ? bloomCoverage : computeBloomCoverage(data.objectives)

    return {
        objectives: data.objectives,
        designNotes: data.designNotes,
        bloomCoverage: finalCoverage,
        aiGenerated,
        generatedAt: Date.now(),
    }
}

/**
 * 计算 Bloom 六阶覆盖率
 */
function computeBloomCoverage(objectives: TeachingObjective[]): Record<BloomLevel, number> {
    const counts: Record<BloomLevel, number> = {
        记忆: 0, 理解: 0, 应用: 0, 分析: 0, 评价: 0, 创造: 0,
    }
    for (const obj of objectives) {
        counts[obj.bloomLevel] = (counts[obj.bloomLevel] ?? 0) + 1
    }
    const total = objectives.length || 1
    return {
        记忆: counts.记忆 / total,
        理解: counts.理解 / total,
        应用: counts.应用 / total,
        分析: counts.分析 / total,
        评价: counts.评价 / total,
        创造: counts.创造 / total,
    }
}

/**
 * 降级：生成模板教学目标
 *
 * LLM 调用失败时使用，确保教学流程不中断
 */
function generateFallbackObjectives(
    poem: { title: string; poet: string; dynasty: string; content: string; theme: string[]; images: string[]; rhetoric: string[] },
    _genre: string,
    _subject: string,
    gradeLevel: ObjectiveGradeLevel,
    lessonCount: 1 | 2 | 3,
    weakBloomLevels?: BloomLevel[],
): ObjectiveGenerateResponse {
    const title = poem.title
    const objectives: TeachingObjective[] = [
        {
            bloomLevel: '记忆',
            category: 'knowledge',
            description: `正确朗读并背诵《${title}》，掌握诗中生字新词的读音与书写`,
            assessment: '课堂朗读展示 + 默写检测',
            lessonIndex: 1,
        },
        {
            bloomLevel: '理解',
            category: 'knowledge',
            description: `借助注释理解《${title}》诗意，能用自己的话翻译全诗`,
            assessment: '口头翻译 + 同桌互评',
            lessonIndex: 1,
        },
        {
            bloomLevel: '应用',
            category: 'ability',
            description: `运用诗中的${poem.rhetoric.slice(0, 2).join('、') || '修辞手法'}仿写句子`,
            assessment: '仿写练习 + 作品展示',
            lessonIndex: Math.min(2, lessonCount),
        },
        {
            bloomLevel: '分析',
            category: 'ability',
            description: `分析《${title}》中${poem.images.slice(0, 2).join('、') || '核心意象'}的含义与作用`,
            assessment: '小组讨论 + 简答题',
            lessonIndex: Math.min(2, lessonCount),
        },
        {
            bloomLevel: '评价',
            category: 'emotion',
            description: `评价诗人情感表达的效果，表达自己对《${title}》的感受`,
            assessment: '鉴赏短文 + 课堂分享',
            lessonIndex: lessonCount,
        },
        {
            bloomLevel: '创造',
            category: 'emotion',
            description: `改写《${title}》为白话散文或配画创作，表达个性化的诗意理解`,
            assessment: '创作作品 + 作品墙展示',
            lessonIndex: lessonCount,
        },
    ]

    // 针对薄弱层级补充
    if (weakBloomLevels) {
        for (const level of weakBloomLevels) {
            objectives.push({
                bloomLevel: level,
                category: 'ability',
                description: `针对${level}层级的强化训练：${getBloomEnhancement(level, title)}`,
                assessment: `专项练习 + 即时反馈`,
                lessonIndex: Math.min(2, lessonCount),
            })
        }
    }

    return {
        objectives,
        designNotes: `基于《${title}》文本特征与${gradeLevel}学情，按 Bloom 六阶设计教学目标。${weakBloomLevels && weakBloomLevels.length > 0
            ? `针对班级薄弱层级${weakBloomLevels.join('、')}增加强化目标。`
            : ''
            }`,
        bloomCoverage: computeBloomCoverage(objectives),
        aiGenerated: false,
        generatedAt: Date.now(),
    }
}

/**
 * 获取各 Bloom 层级强化训练描述
 */
function getBloomEnhancement(level: BloomLevel, title: string): string {
    const enhancements: Record<BloomLevel, string> = {
        记忆: `反复诵读《${title}》，通过多感官记忆法巩固背诵`,
        理解: `借助思维导图梳理《${title}》诗句层次与逻辑`,
        应用: `将《${title}》中的修辞手法迁移到自己的写作中`,
        分析: `对比《${title}》与同类诗作的意象运用差异`,
        评价: `从多角度评价《${title}》的艺术成就`,
        创造: `基于《${title}》意境创作现代版改编作品`,
    }
    return enhancements[level] ?? `强化${level}层级能力`
}
