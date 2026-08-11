/**
 * 分层教学设计服务（智能备课 · 能力 3）
 *
 * 根据班级学生画像（mastery + profile）自动分层：
 * - 基础层：记忆/理解为主，强化基础
 * - 提高层：应用/分析为主，深化理解
 * - 挑战层：评价/创造为主，拓展创新
 *
 * 每层提供：
 * - 差异化问题串（教师引导问题序列）
 * - 活动设计（学生参与方式）
 * - 作业建议（分层作业）
 *
 * LLM：deepseek-v4-pro，high 思考模式
 */

import { z } from 'zod'
import { managedLLM } from '../../llm/index.js'
import { db, repos } from '../../db/index.js'
import { computeGenre, computeSubject } from './poem-search.js'
import type { BloomLevel } from '../../agents/base/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

export type LayerTier = 'basic' | 'intermediate' | 'advanced'

/** 分层教学设计请求 */
export interface LayeredDesignRequest {
    poemId: string
    classId?: string
    /** 教学目标 ID 列表（来自 objective-generator 的输出） */
    objectiveIds?: string[]
    /** 自定义分层比例（可选，默认 4:4:2） */
    layerRatio?: {
        basic: number
        intermediate: number
        advanced: number
    }
}

/** 单层教学设计 */
export interface LayerDesign {
    /** 层级 */
    tier: LayerTier
    /** 层级名称 */
    tierName: string
    /** 学生比例（0-1） */
    studentRatio: number
    /** 目标学生画像描述 */
    targetStudents: string
    /** 主攻 Bloom 层级 */
    focusBloomLevels: BloomLevel[]
    /** 差异化问题串（教师引导问题序列） */
    questionChain: Array<{
        /** 问题序号 */
        order: number
        /** Bloom 层级 */
        bloomLevel: BloomLevel
        /** 问题内容 */
        question: string
        /** 预设学生回答 */
        expectedAnswer: string
        /** 追问提示（若学生答错） */
        scaffold: string
    }>
    /** 活动设计 */
    activities: Array<{
        /** 活动名称 */
        name: string
        /** 活动类型（个体/同桌/小组/全班） */
        type: 'individual' | 'pair' | 'group' | 'whole-class'
        /** 时长（分钟） */
        durationMin: number
        /** 活动描述 */
        description: string
        /** 教师角色 */
        teacherRole: string
        /** AI 协同点 */
        aiSynergy?: string
    }>
    /** 分层作业建议 */
    homework: Array<{
        /** 作业类型 */
        type: 'dictation' | 'recitation' | 'creation' | 'investigation' | 'reading'
        /** 作业描述 */
        description: string
        /** 预计时长（分钟） */
        estimatedMin: number
        /** Bloom 层级 */
        bloomLevel: BloomLevel
        /** 是否选做 */
        optional: boolean
    }>
    /** 学习支架（针对该层学生的特殊支持） */
    scaffolds: string[]
}

/** 分层教学设计响应 */
export interface LayeredDesignResponse {
    layers: LayerDesign[]
    /** 分层依据（学情数据摘要） */
    basis: {
        /** 班级总人数 */
        studentCount: number
        /** 班级平均掌握度 */
        classAvgMastery: number
        /** 各层学生数 */
        layerDistribution: Record<LayerTier, number>
        /** 数据来源 */
        dataSource: string
    }
    /** 分层设计说明 */
    designNotes: string
    aiGenerated: boolean
    generatedAt: number
}

// ─────────────────────────────────────────────────────────────
// Zod 校验 Schema
// ─────────────────────────────────────────────────────────────

const bloomLevelSchema = z.enum(['记忆', '理解', '应用', '分析', '评价', '创造'])

const questionSchema = z.object({
    order: z.number().int().min(1),
    bloomLevel: bloomLevelSchema,
    question: z.string().min(5).max(300),
    expectedAnswer: z.string().min(5).max(500),
    scaffold: z.string().min(5).max(300),
})

const activitySchema = z.object({
    name: z.string().min(2).max(100),
    type: z.enum(['individual', 'pair', 'group', 'whole-class']),
    durationMin: z.number().int().min(1).max(60),
    description: z.string().min(10).max(500),
    teacherRole: z.string().min(5).max(300),
    aiSynergy: z.string().min(5).max(300).optional(),
})

const homeworkSchema = z.object({
    type: z.enum(['dictation', 'recitation', 'creation', 'investigation', 'reading']),
    description: z.string().min(5).max(300),
    estimatedMin: z.number().int().min(1).max(120),
    bloomLevel: bloomLevelSchema,
    optional: z.boolean(),
})

const layerSchema = z.object({
    tier: z.enum(['basic', 'intermediate', 'advanced']),
    tierName: z.string().min(2).max(20),
    studentRatio: z.number().min(0).max(1),
    targetStudents: z.string().min(10).max(300),
    focusBloomLevels: z.array(bloomLevelSchema).min(1).max(3),
    questionChain: z.array(questionSchema).min(3).max(8),
    activities: z.array(activitySchema).min(1).max(5),
    homework: z.array(homeworkSchema).min(1).max(5),
    scaffolds: z.array(z.string().min(5).max(200)).min(1).max(5),
})

const layeredDesignResponseSchema = z.object({
    layers: z.array(layerSchema).length(3, '必须包含 3 个层级'),
    designNotes: z.string().min(10).max(1000),
})

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const LAYER_CONFIG: Record<LayerTier, {
    name: string
    bloomFocus: BloomLevel[]
    description: string
}> = {
    basic: {
        name: '基础层',
        bloomFocus: ['记忆', '理解'],
        description: '掌握度较低、需要夯实基础的学生',
    },
    intermediate: {
        name: '提高层',
        bloomFocus: ['应用', '分析'],
        description: '掌握度中等、具备基本能力可进一步深化的学生',
    },
    advanced: {
        name: '挑战层',
        bloomFocus: ['评价', '创造'],
        description: '掌握度较高、可挑战高阶思维的学生',
    },
}

/** 默认分层比例 4:4:2 */
const DEFAULT_LAYER_RATIO = { basic: 0.4, intermediate: 0.4, advanced: 0.2 }

// ─────────────────────────────────────────────────────────────
// 公共 API
// ─────────────────────────────────────────────────────────────

/**
 * 生成分层教学设计
 */
export async function generateLayeredDesign(
    req: LayeredDesignRequest,
): Promise<LayeredDesignResponse> {
    const poem = repos.poems.findById(req.poemId)
    if (!poem) {
        throw new Error(`诗歌不存在: ${req.poemId}`)
    }

    const genre = computeGenre(poem.content)
    const subject = computeSubject(poem.theme)[0] ?? '其他'
    const basis = computeBasis(req.classId, req.poemId)
    const ratio = req.layerRatio ?? DEFAULT_LAYER_RATIO

    const systemPrompt = buildSystemPrompt(ratio, basis)
    const userPrompt = buildUserPrompt(poem, genre, subject, basis)

    let response = await callLLM(systemPrompt, userPrompt)
    if (response) {
        return finalizeResponse(response, basis, ratio)
    }

    // 重试
    response = await callLLM(systemPrompt, userPrompt, 0.5)
    if (response) {
        return finalizeResponse(response, basis, ratio)
    }

    // 降级
    return generateFallbackLayeredDesign(poem, genre, subject, basis, ratio)
}

// ─────────────────────────────────────────────────────────────
// 内部函数
// ─────────────────────────────────────────────────────────────

/**
 * 构建分层学情基础数据
 */
function computeBasis(
    classId: string | undefined,
    poemId: string,
): LayeredDesignResponse['basis'] {
    if (!classId) {
        return {
            studentCount: 0,
            classAvgMastery: 0,
            layerDistribution: { basic: 0, intermediate: 0, advanced: 0 },
            dataSource: '未指定班级，使用通用分层策略',
        }
    }

    try {
        // 查询班级学生对该诗的掌握度
        const rows = db.prepare(`
            SELECT s.id AS student_id,
                   AVG(m.score) AS avg_score
            FROM students s
            LEFT JOIN mastery m ON s.id = m.student_id AND m.poem_id = ?
            WHERE s.class_id = ?
            GROUP BY s.id
        `).all(poemId, classId) as Array<{ student_id: string; avg_score: number | null }>

        if (rows.length === 0) {
            return {
                studentCount: 0,
                classAvgMastery: 0,
                layerDistribution: { basic: 0, intermediate: 0, advanced: 0 },
                dataSource: '班级暂无学情数据，使用通用分层策略',
            }
        }

        const studentCount = rows.length
        let basicCount = 0
        let intermediateCount = 0
        let advancedCount = 0
        let totalScore = 0
        let scoredCount = 0

        for (const row of rows) {
            const score = row.avg_score ?? 0
            if (score === 0) {
                // 无数据的学生归入基础层
                basicCount++
            } else if (score < 60) {
                basicCount++
                totalScore += score
                scoredCount++
            } else if (score < 80) {
                intermediateCount++
                totalScore += score
                scoredCount++
            } else {
                advancedCount++
                totalScore += score
                scoredCount++
            }
        }

        const classAvgMastery = scoredCount > 0 ? Math.round(totalScore / scoredCount) : 0

        return {
            studentCount,
            classAvgMastery,
            layerDistribution: {
                basic: basicCount,
                intermediate: intermediateCount,
                advanced: advancedCount,
            },
            dataSource: `基于班级${studentCount}名学生对本诗的掌握度数据分层`,
        }
    } catch {
        return {
            studentCount: 0,
            classAvgMastery: 0,
            layerDistribution: { basic: 0, intermediate: 0, advanced: 0 },
            dataSource: '学情数据查询失败，使用通用分层策略',
        }
    }
}

function buildSystemPrompt(
    ratio: { basic: number; intermediate: number; advanced: number },
    basis: LayeredDesignResponse['basis'],
): string {
    return `你是小学语文分层教学设计专家。请为指定古诗生成三层（基础层/提高层/挑战层）差异化教学设计。

分层比例：基础层 ${Math.round(ratio.basic * 100)}% · 提高层 ${Math.round(ratio.intermediate * 100)}% · 挑战层 ${Math.round(ratio.advanced * 100)}%
学情数据：${basis.dataSource}
班级人数：${basis.studentCount}人，平均掌握度：${basis.classAvgMastery}分
各层学生数：基础层${basis.layerDistribution.basic}人 · 提高层${basis.layerDistribution.intermediate}人 · 挑战层${basis.layerDistribution.advanced}人

严格输出 JSON，不要解释文字。

JSON 结构：
{
    "layers": [
        {
            "tier": "basic",
            "tierName": "基础层",
            "studentRatio": 0.4,
            "targetStudents": "学生画像描述",
            "focusBloomLevels": ["记忆", "理解"],
            "questionChain": [
                {
                    "order": 1,
                    "bloomLevel": "记忆",
                    "question": "问题内容",
                    "expectedAnswer": "预设回答",
                    "scaffold": "支架提示"
                }
            ],
            "activities": [
                {
                    "name": "活动名",
                    "type": "individual|pair|group|whole-class",
                    "durationMin": 10,
                    "description": "活动描述",
                    "teacherRole": "教师角色",
                    "aiSynergy": "AI 协同点（可选）"
                }
            ],
            "homework": [
                {
                    "type": "dictation|recitation|creation|investigation|reading",
                    "description": "作业描述",
                    "estimatedMin": 15,
                    "bloomLevel": "记忆",
                    "optional": false
                }
            ],
            "scaffolds": ["支架1", "支架2"]
        },
        {
            "tier": "intermediate",
            ...
        },
        {
            "tier": "advanced",
            ...
        }
    ],
    "designNotes": "分层设计说明"
}

设计原则：
- 基础层：3-5 个问题串，问题从记忆→理解渐进，强化基础；活动以教师引导为主；作业重默写朗读
- 提高层：4-6 个问题串，问题从应用→分析深化，引导迁移；活动以小组合作为主；作业增加分析题
- 挑战层：5-7 个问题串，问题从评价→创造突破，鼓励创新；活动以自主探究为主；作业含创作改写
- 每个问题串必须包含 scaffold（支架提示，用于学生答错时引导）
- AI 协同点：标注哪些环节适合 AI 辅助（如个性化反馈、即时评估等）`
}

function buildUserPrompt(
    poem: { title: string; poet: string; dynasty: string; content: string; theme: string[]; images: string[]; rhetoric: string[] },
    genre: string,
    subject: string,
    basis: LayeredDesignResponse['basis'],
): string {
    return `诗歌：《${poem.title}》
作者：${poem.dynasty}·${poem.poet}
体裁：${genre} · 题材：${subject}
正文：${poem.content}
${poem.theme.length > 0 ? `主题：${poem.theme.join('、')}` : ''}
${poem.images.length > 0 ? `意象：${poem.images.join('、')}` : ''}
${poem.rhetoric.length > 0 ? `修辞：${poem.rhetoric.join('、')}` : ''}

班级学情：${basis.studentCount}人，平均掌握度${basis.classAvgMastery}分
分层分布：基础层${basis.layerDistribution.basic}人 / 提高层${basis.layerDistribution.intermediate}人 / 挑战层${basis.layerDistribution.advanced}人

请生成三层差异化教学设计。`
}

async function callLLM(
    systemPrompt: string,
    userPrompt: string,
    temperature = 0.7,
): Promise<z.infer<typeof layeredDesignResponseSchema> | null> {
    try {
        const result = await managedLLM.chat({
            model: 'deepseek-v4-pro',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            thinking: 'high',
            temperature,
            maxTokens: 4500,
            jsonOutput: true,
            metadata: { agent: 'layered-design', task: 'generate-layered-design' },
        })

        const parsed = JSON.parse(result.content)
        const validationResult = layeredDesignResponseSchema.safeParse(parsed)
        if (!validationResult.success) {
            return null
        }
        return validationResult.data
    } catch {
        return null
    }
}

function finalizeResponse(
    data: z.infer<typeof layeredDesignResponseSchema>,
    basis: LayeredDesignResponse['basis'],
    ratio: { basic: number; intermediate: number; advanced: number },
): LayeredDesignResponse {
    // 补充 studentRatio
    const layers = data.layers.map((layer) => {
        const ratioValue = layer.tier === 'basic' ? ratio.basic
            : layer.tier === 'intermediate' ? ratio.intermediate
            : ratio.advanced
        return { ...layer, studentRatio: ratioValue }
    })

    return {
        layers,
        basis,
        designNotes: data.designNotes,
        aiGenerated: true,
        generatedAt: Date.now(),
    }
}

function generateFallbackLayeredDesign(
    poem: { title: string; poet: string; dynasty: string; content: string; theme: string[]; images: string[]; rhetoric: string[] },
    _genre: string,
    _subject: string,
    basis: LayeredDesignResponse['basis'],
    ratio: { basic: number; intermediate: number; advanced: number },
): LayeredDesignResponse {
    const title = poem.title

    const layers: LayerDesign[] = [
        {
            tier: 'basic',
            tierName: '基础层',
            studentRatio: ratio.basic,
            targetStudents: '掌握度较低的学生，需夯实字词与朗读基础，逐步理解诗意',
            focusBloomLevels: LAYER_CONFIG.basic.bloomFocus,
            questionChain: [
                {
                    order: 1,
                    bloomLevel: '记忆',
                    question: `《${title}》的作者是谁？是哪个朝代的？`,
                    expectedAnswer: `作者是${poem.poet}，${poem.dynasty}代人`,
                    scaffold: '回顾课前提到的作者信息',
                },
                {
                    order: 2,
                    bloomLevel: '记忆',
                    question: `请朗读《${title}》，注意字音和节奏`,
                    expectedAnswer: '正确朗读全诗，停顿恰当',
                    scaffold: '教师范读后跟读',
                },
                {
                    order: 3,
                    bloomLevel: '理解',
                    question: `诗中"${poem.images[0] ?? '月'}"是什么意思？`,
                    expectedAnswer: '解释意象的字面含义',
                    scaffold: '借助注释理解',
                },
            ],
            activities: [
                {
                    name: '范读跟读',
                    type: 'whole-class',
                    durationMin: 8,
                    description: '教师范读，学生跟读，纠正字音节奏',
                    teacherRole: '示范朗读，及时纠错',
                    aiSynergy: 'AI 朗读评测：学生录音后 AI 评估发音准确度',
                },
                {
                    name: '字词卡片',
                    type: 'pair',
                    durationMin: 10,
                    description: '同桌互考生字词，配图记忆',
                    teacherRole: '巡视指导，重点辅导困难学生',
                },
            ],
            homework: [
                {
                    type: 'recitation',
                    description: `熟练朗读《${title}》3 遍，尝试背诵`,
                    estimatedMin: 15,
                    bloomLevel: '记忆',
                    optional: false,
                },
                {
                    type: 'dictation',
                    description: '抄写生字词各 5 遍',
                    estimatedMin: 10,
                    bloomLevel: '记忆',
                    optional: false,
                },
            ],
            scaffolds: [
                '提供带拼音的诗文版本',
                '生字词卡片配图辅助记忆',
                '朗读节奏标注辅助',
            ],
        },
        {
            tier: 'intermediate',
            tierName: '提高层',
            studentRatio: ratio.intermediate,
            targetStudents: '掌握度中等的学生，已能朗读理解，需深化分析与迁移应用',
            focusBloomLevels: LAYER_CONFIG.intermediate.bloomFocus,
            questionChain: [
                {
                    order: 1,
                    bloomLevel: '应用',
                    question: `诗中用了${poem.rhetoric[0] ?? '比喻'}的手法，请找出并说明其作用`,
                    expectedAnswer: '识别修辞手法并分析表达效果',
                    scaffold: '回顾修辞手法的判定标准',
                },
                {
                    order: 2,
                    bloomLevel: '分析',
                    question: `诗人为什么选择"${poem.images[0] ?? '月'}"作为意象？有何深意？`,
                    expectedAnswer: '分析意象的选择动机与文化内涵',
                    scaffold: '联系诗人创作背景思考',
                },
                {
                    order: 3,
                    bloomLevel: '分析',
                    question: `《${title}》的结构是怎样的？层次如何划分？`,
                    expectedAnswer: '分析诗歌结构层次',
                    scaffold: '按起承转合分析',
                },
                {
                    order: 4,
                    bloomLevel: '应用',
                    question: '模仿诗中的写法，用自己的话描述一个相似的场景',
                    expectedAnswer: '仿写迁移',
                    scaffold: '先分析原诗写法特点',
                },
            ],
            activities: [
                {
                    name: '小组讨论',
                    type: 'group',
                    durationMin: 12,
                    description: '4 人小组讨论意象与修辞的作用',
                    teacherRole: '引导讨论方向，追问深化',
                    aiSynergy: 'AI 实时分析小组讨论质量，提供追问建议',
                },
                {
                    name: '仿写练习',
                    type: 'individual',
                    durationMin: 10,
                    description: '模仿诗中修辞手法仿写句子',
                    teacherRole: '点评作品，引导互评',
                },
            ],
            homework: [
                {
                    type: 'creation',
                    description: `用一段话分析《${title}》中意象的表达效果`,
                    estimatedMin: 20,
                    bloomLevel: '分析',
                    optional: false,
                },
                {
                    type: 'reading',
                    description: '阅读同主题的其他诗作，对比异同',
                    estimatedMin: 15,
                    bloomLevel: '应用',
                    optional: true,
                },
            ],
            scaffolds: [
                '提供意象分析思维导图模板',
                '修辞手法判定流程图',
                '仿写范例参考',
            ],
        },
        {
            tier: 'advanced',
            tierName: '挑战层',
            studentRatio: ratio.advanced,
            targetStudents: '掌握度较高的学生，已能分析鉴赏，可挑战评价与创造',
            focusBloomLevels: LAYER_CONFIG.advanced.bloomFocus,
            questionChain: [
                {
                    order: 1,
                    bloomLevel: '评价',
                    question: `你认为《${title}》最精彩的一句是哪句？为什么？`,
                    expectedAnswer: '个性化评价，有理有据',
                    scaffold: '从意象、修辞、情感多角度评价',
                },
                {
                    order: 2,
                    bloomLevel: '评价',
                    question: `将《${title}》与同题材的其他诗作对比，你更喜欢哪首？说明理由`,
                    expectedAnswer: '对比评价，有比较维度',
                    scaffold: '建立比较维度（情感/手法/意境）',
                },
                {
                    order: 3,
                    bloomLevel: '创造',
                    question: '请将这首诗改写为现代散文或现代诗',
                    expectedAnswer: '创造性改写，保留原意有新意',
                    scaffold: '先把握原诗核心意境',
                },
                {
                    order: 4,
                    bloomLevel: '创造',
                    question: '如果为这首诗配一幅画，你会画什么？描述画面构图',
                    expectedAnswer: '画面构思描述',
                    scaffold: '从诗中意象提取视觉元素',
                },
                {
                    order: 5,
                    bloomLevel: '创造',
                    question: '基于本诗意境，创作一首同主题的小诗',
                    expectedAnswer: '原创小诗',
                    scaffold: '借鉴原诗的意象与结构',
                },
            ],
            activities: [
                {
                    name: '鉴赏辩论',
                    type: 'whole-class',
                    durationMin: 15,
                    description: '就"最精彩的一句"展开辩论，各抒己见',
                    teacherRole: '主持辩论，引导深度思考',
                    aiSynergy: 'AI 多维度评价学生发言质量',
                },
                {
                    name: '创作工坊',
                    type: 'individual',
                    durationMin: 20,
                    description: '改写或创作作品，作品墙展示',
                    teacherRole: '提供创作支架，点评作品',
                    aiSynergy: 'AI 协作共创，提供创作建议',
                },
            ],
            homework: [
                {
                    type: 'creation',
                    description: '将《' + title + '》改写为现代散文（200字以上）',
                    estimatedMin: 30,
                    bloomLevel: '创造',
                    optional: false,
                },
                {
                    type: 'investigation',
                    description: '查阅诗人其他作品，整理创作风格特点',
                    estimatedMin: 25,
                    bloomLevel: '评价',
                    optional: true,
                },
            ],
            scaffolds: [
                '提供诗歌鉴赏评价量表',
                '创作思维导图模板',
                '对比阅读材料包',
            ],
        },
    ]

    return {
        layers,
        basis,
        designNotes: `基于班级学情（${basis.studentCount}人，平均掌握度${basis.classAvgMastery}分）按 4:4:2 比例分层。基础层夯实字词朗读，提高层深化分析迁移，挑战层突破评价创造。`,
        aiGenerated: false,
        generatedAt: Date.now(),
    }
}
