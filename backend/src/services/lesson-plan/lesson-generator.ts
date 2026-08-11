/**
 * 教案 AI 生成与精修服务（智能备课 · 能力 4）
 *
 * 输入：诗歌 + 教学目标 + 分层设计 + 教师偏好
 * 输出：完整教案（教学环节/师生活动脚本/预设问题/AI协同点/时间分配/板书设计/分层作业）
 *
 * 两大能力：
 * 1. generateLesson —— deepseek-v4-pro max 思考模式，生成完整结构化教案
 * 2. refineLessonParagraph —— 选段精修，对教案中指定段落进行 AI 优化
 *
 * 流式输出：generateLesson 和 refineLessonParagraph 均支持 SSE 流式输出
 */

import { z } from 'zod'
import { managedLLM } from '../../llm/index.js'
import { repos } from '../../db/index.js'
import { computeGenre, computeSubject } from './poem-search.js'
import type { BloomLevel } from '../../agents/base/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

export type LessonGradeLevel = '1-2年级' | '3-4年级' | '5-6年级'

/** 教案生成请求 */
export interface LessonGenerateRequest {
    poemId: string
    gradeLevel: LessonGradeLevel
    lessonCount: 1 | 2 | 3
    /** 教学目标（来自 objective-generator） */
    objectives: Array<{
        bloomLevel: BloomLevel
        category: 'knowledge' | 'ability' | 'emotion'
        description: string
        assessment: string
    }>
    /** 分层设计摘要（来自 layered-design） */
    layeredDesignSummary?: {
        basicCount: number
        intermediateCount: number
        advancedCount: number
        focusAreas: string[]
    }
    /** 教师偏好 */
    teacherPreference?: {
        /** 教学风格（讲授式/探究式/合作式/翻转课堂） */
        teachingStyle?: string
        /** 时间分配偏好 */
        timeAllocation?: string
        /** 特殊要求 */
        specialRequirements?: string
    }
    /** 班级 ID（用于获取学情数据） */
    classId?: string
}

/** 教学环节类型 */
export type LessonPhaseType =
    | 'introduction'
    | 'literacy'
    | 'interpretation'
    | 'appreciation'
    | 'extension'
    | 'practice'
    | 'homework'

/** 教学环节 */
export interface LessonPhase {
    phase: LessonPhaseType
    title: string
    durationMin: number
    /** 教师活动脚本（含具体话术） */
    teacherScript: string
    /** 学生活动脚本（含具体操作） */
    studentScript: string
    /** 预设问题（含预设回答与追问） */
    presetQuestions: Array<{
        question: string
        expectedAnswer: string
        followUp?: string
        bloomLevel: BloomLevel
    }>
    /** AI 协同点（本环节中 AI 可以辅助的具体场景） */
    aiSynergyPoints: Array<{
        scenario: string
        aiAction: string
        benefit: string
    }>
    /** 设计意图 */
    designIntent: string
    /** 对应的教学目标索引 */
    goalIndices: number[]
    /** 分层提示（针对基础/提高/挑战层的差异化引导） */
    layerTips?: {
        basic?: string
        intermediate?: string
        advanced?: string
    }
}

/** 板书设计 */
export interface BoardDesign {
    title: string
    content: string
    /** 板书结构描述（用于前端可视化） */
    structure: 'linear' | 'radial' | 'tree' | 'matrix'
    intent: string
}

/** 完整教案 */
export interface GeneratedLesson {
    poemId: string
    poemTitle: string
    poet: string
    dynasty: string
    gradeLevel: LessonGradeLevel
    lessonCount: 1 | 2 | 3
    title: string
    /** 教学目标 */
    goals: LessonGenerateRequest['objectives']
    /** 教学重难点 */
    keyPoints: string[]
    difficultPoints: string[]
    /** 教学准备 */
    preparations: string[]
    /** 教学过程（核心） */
    teachingProcess: LessonPhase[]
    /** 板书设计 */
    boardDesign: BoardDesign
    /** 分层作业 */
    homework: Array<{
        tier: 'basic' | 'intermediate' | 'advanced' | 'common'
        type: 'dictation' | 'recitation' | 'creation' | 'investigation' | 'reading'
        description: string
        estimatedMin: number
        bloomLevel: BloomLevel
        optional: boolean
    }>
    /** 教学反思预设 */
    anticipatedReflections: Array<{
        scenario: string
        countermeasure: string
    }>
    /** 总时长 */
    totalDurationMin: number
    /** 设计说明 */
    designNotes: string
    aiGenerated: boolean
    generatedAt: number
}

/** 教案生成响应 */
export interface LessonGenerateResponse {
    lesson: GeneratedLesson
    aiGenerated: boolean
    generatedAt: number
}

/** 选段精修请求 */
export interface LessonRefineRequest {
    /** 教案 ID */
    lessonId: string
    /** 精修段落标识（phase 的索引或字段名） */
    targetSection: {
        /** 段落类型 */
        type: 'phase' | 'board' | 'homework' | 'goals' | 'keyPoints' | 'difficultPoints'
        /** phase 的索引（type=phase 时必填） */
        phaseIndex?: number
        /** phase 内的具体字段（type=phase 时，精修该字段的脚本） */
        field?: 'teacherScript' | 'studentScript' | 'presetQuestions' | 'aiSynergyPoints' | 'designIntent' | 'layerTips'
    }
    /** 原始内容 */
    originalContent: string
    /** 精修指令（教师自然语言要求） */
    refineInstruction: string
    /** 教学上下文（诗歌、年级等，用于约束精修方向） */
    context?: {
        poemTitle?: string
        gradeLevel?: LessonGradeLevel
    }
}

/** 选段精修响应 */
export interface LessonRefineResponse {
    refinedContent: string
    /** 修改摘要 */
    changeSummary: string
    aiGenerated: boolean
}

// ─────────────────────────────────────────────────────────────
// Zod 校验 Schema
// ─────────────────────────────────────────────────────────────

const bloomLevelSchema = z.enum(['记忆', '理解', '应用', '分析', '评价', '创造'])

const presetQuestionSchema = z.object({
    question: z.string().min(5).max(300),
    expectedAnswer: z.string().min(5).max(500),
    followUp: z.string().min(5).max(300).optional(),
    bloomLevel: bloomLevelSchema,
})

const aiSynergySchema = z.object({
    scenario: z.string().min(5).max(200),
    aiAction: z.string().min(5).max(300),
    benefit: z.string().min(5).max(200),
})

const phaseSchema = z.object({
    phase: z.enum(['introduction', 'literacy', 'interpretation', 'appreciation', 'extension', 'practice', 'homework']),
    title: z.string().min(2).max(100),
    durationMin: z.number().int().min(1).max(60),
    teacherScript: z.string().min(20).max(2000),
    studentScript: z.string().min(20).max(2000),
    presetQuestions: z.array(presetQuestionSchema).min(1).max(10),
    aiSynergyPoints: z.array(aiSynergySchema).max(5).default([]),
    designIntent: z.string().min(10).max(500),
    goalIndices: z.array(z.number().int().min(0)).default([]),
    layerTips: z.object({
        basic: z.string().max(500).optional(),
        intermediate: z.string().max(500).optional(),
        advanced: z.string().max(500).optional(),
    }).optional(),
})

const generatedLessonSchema = z.object({
    title: z.string().min(2).max(200),
    keyPoints: z.array(z.string().min(5).max(300)).min(1).max(10),
    difficultPoints: z.array(z.string().min(5).max(300)).min(1).max(10),
    preparations: z.array(z.string().min(5).max(200)).min(1).max(15),
    teachingProcess: z.array(phaseSchema).min(3).max(15),
    boardDesign: z.object({
        title: z.string().min(2).max(100),
        content: z.string().min(10).max(2000),
        structure: z.enum(['linear', 'radial', 'tree', 'matrix']),
        intent: z.string().min(5).max(500),
    }),
    homework: z.array(z.object({
        tier: z.enum(['basic', 'intermediate', 'advanced', 'common']),
        type: z.enum(['dictation', 'recitation', 'creation', 'investigation', 'reading']),
        description: z.string().min(5).max(300),
        estimatedMin: z.number().int().min(1).max(120),
        bloomLevel: bloomLevelSchema,
        optional: z.boolean(),
    })).min(1).max(15),
    anticipatedReflections: z.array(z.object({
        scenario: z.string().min(5).max(300),
        countermeasure: z.string().min(5).max(300),
    })).max(10).default([]),
    designNotes: z.string().min(10).max(1000),
})

// ─────────────────────────────────────────────────────────────
// 公共 API
// ─────────────────────────────────────────────────────────────

/**
 * 生成完整教案（deepseek-v4-pro max 思考模式）
 */
export async function generateLesson(
    req: LessonGenerateRequest,
): Promise<LessonGenerateResponse> {
    const poem = repos.poems.findById(req.poemId)
    if (!poem) {
        throw new Error(`诗歌不存在: ${req.poemId}`)
    }

    const genre = computeGenre(poem.content)
    const subject = computeSubject(poem.theme)[0] ?? '其他'

    const systemPrompt = buildSystemPrompt(req, genre, subject)
    const userPrompt = buildUserPrompt(poem, genre, subject, req)

    // 第一次尝试
    let parsed = await callLLM(systemPrompt, userPrompt)
    if (!parsed) {
        // 重试
        parsed = await callLLM(systemPrompt, userPrompt, 0.5)
    }

    if (parsed) {
        const lesson = assembleLesson(poem, req, parsed, true)
        return {
            lesson,
            aiGenerated: true,
            generatedAt: Date.now(),
        }
    }

    // 降级
    const lesson = generateFallbackLesson(poem, req, genre, subject)
    return {
        lesson,
        aiGenerated: false,
        generatedAt: Date.now(),
    }
}

/**
 * 流式生成教案（SSE）
 *
 * 逐 chunk 输出 LLM 流式响应，最后输出完整结构化教案 JSON。
 * 调用方应使用 SSE 帧格式：data: {chunk}\n\n，结束标记 data: [DONE]\n\n
 */
export async function* streamGenerateLesson(
    req: LessonGenerateRequest,
    signal?: AbortSignal,
): AsyncGenerator<LessonStreamChunk> {
    const poem = repos.poems.findById(req.poemId)
    if (!poem) {
        throw new Error(`诗歌不存在: ${req.poemId}`)
    }

    const genre = computeGenre(poem.content)
    const subject = computeSubject(poem.theme)[0] ?? '其他'

    const systemPrompt = buildSystemPrompt(req, genre, subject)
    const userPrompt = buildUserPrompt(poem, genre, subject, req)

    let fullContent = ''

    try {
        const stream = managedLLM.stream({
            model: 'deepseek-v4-pro',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            thinking: 'max',
            temperature: 0.7,
            maxTokens: 6000,
            jsonOutput: true,
            signal,
            metadata: {
                agent: 'lesson-generator',
                task: `generate-lesson-stream-${req.poemId}`,
            },
        })

        for await (const chunk of stream) {
            if (chunk.content) {
                fullContent += chunk.content
                yield { type: 'chunk', content: chunk.content }
            }
            // Provider chain-of-thought is intentionally not part of the public stream.
        }

        // 尝试解析完整内容
        const parsed = parseLessonContent(fullContent)
        if (parsed) {
            const lesson = assembleLesson(poem, req, parsed, true)
            yield { type: 'done', lesson }
        } else {
            // 解析失败，降级
            const lesson = generateFallbackLesson(poem, req, genre, subject)
            yield { type: 'done', lesson }
        }
    } catch (err) {
        if ((err as Error).name === 'AbortError') {
            yield { type: 'aborted' }
            return
        }
        // 其他错误，降级返回
        const lesson = generateFallbackLesson(poem, req, genre, subject)
        yield { type: 'done', lesson }
    }
}

/** 流式生成 chunk 类型 */
export type LessonStreamChunk =
    | { type: 'chunk'; content: string }
    | { type: 'reasoning'; content: string }
    | { type: 'done'; lesson: GeneratedLesson }
    | { type: 'aborted' }

/**
 * 选段精修
 */
export async function refineLessonParagraph(
    req: LessonRefineRequest,
): Promise<LessonRefineResponse> {
    const systemPrompt = `你是古诗词教学设计专家。请根据教师的精修指令，优化教案中的指定段落。

要求：
1. 保持原文核心内容不变，仅做优化
2. 严格遵循教师指令的方向
3. 输出精修后的完整段落内容（JSON 格式：{"refinedContent": "...", "changeSummary": "..."}）
4. changeSummary 简述主要修改点（50-200字）

精修方向可能包括：增加细节、简化语言、调整难度、补充提问、增加互动等。`

    const userPrompt = `精修目标：${req.targetSection.type}${req.targetSection.field ? ` / ${req.targetSection.field}` : ''}

原始内容：
${req.originalContent}

教师精修指令：
${req.refineInstruction}

${req.context ? `教学上下文：诗歌《${req.context.poemTitle ?? ''}》，${req.context.gradeLevel ?? ''}` : ''}

请输出精修后的内容。`

    try {
        const result = await managedLLM.chat({
            model: 'deepseek-v4-pro',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            thinking: 'high',
            temperature: 0.6,
            maxTokens: 2500,
            jsonOutput: true,
            metadata: {
                agent: 'lesson-generator',
                task: `refine-${req.targetSection.type}`,
            },
        })

        const parsed = JSON.parse(result.content) as { refinedContent: string; changeSummary: string }
        return {
            refinedContent: parsed.refinedContent || req.originalContent,
            changeSummary: parsed.changeSummary || 'AI 精修完成',
            aiGenerated: true,
        }
    } catch {
        return {
            refinedContent: req.originalContent,
            changeSummary: '精修失败，已保留原始内容',
            aiGenerated: false,
        }
    }
}

/**
 * 流式选段精修（SSE）
 */
export async function* streamRefineLessonParagraph(
    req: LessonRefineRequest,
    signal?: AbortSignal,
): AsyncGenerator<RefineStreamChunk> {
    const systemPrompt = `你是古诗词教学设计专家。请根据教师的精修指令，优化教案中的指定段落。

要求：
1. 保持原文核心内容不变，仅做优化
2. 严格遵循教师指令的方向
3. 直接输出精修后的完整段落内容（纯文本，非 JSON）`

    const userPrompt = `精修目标：${req.targetSection.type}${req.targetSection.field ? ` / ${req.targetSection.field}` : ''}

原始内容：
${req.originalContent}

教师精修指令：
${req.refineInstruction}

${req.context ? `教学上下文：诗歌《${req.context.poemTitle ?? ''}》，${req.context.gradeLevel ?? ''}` : ''}

请输出精修后的内容。`

    try {
        const stream = managedLLM.stream({
            model: 'deepseek-v4-pro',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            thinking: 'high',
            temperature: 0.6,
            maxTokens: 2500,
            signal,
            metadata: {
                agent: 'lesson-generator',
                task: `refine-stream-${req.targetSection.type}`,
            },
        })

        for await (const chunk of stream) {
            if (chunk.content) {
                yield { type: 'chunk', content: chunk.content }
            }
            // Provider chain-of-thought is intentionally not part of the public stream.
        }

        yield { type: 'done' }
    } catch (err) {
        if ((err as Error).name === 'AbortError') {
            yield { type: 'aborted' }
            return
        }
        yield { type: 'done' }
    }
}

export type RefineStreamChunk =
    | { type: 'chunk'; content: string }
    | { type: 'reasoning'; content: string }
    | { type: 'done' }
    | { type: 'aborted' }

// ─────────────────────────────────────────────────────────────
// 内部函数
// ─────────────────────────────────────────────────────────────

function buildSystemPrompt(req: LessonGenerateRequest, genre: string, subject: string): string {
    const totalDuration = req.lessonCount === 1 ? 40 : req.lessonCount === 2 ? 80 : 120
    return `你是小学语文古诗词教学设计专家，擅长设计精细化教案。

任务：为指定古诗生成完整教案，包含教学环节、师生活动脚本、预设问题、AI 协同点、时间分配、板书设计、分层作业。

输出要求：
1. 严格输出 JSON 格式，不要任何解释文字
2. 教学过程 ${req.lessonCount === 1 ? '5-7' : req.lessonCount === 2 ? '8-12' : '10-15'} 个环节
3. 总时长 ${totalDuration} 分钟（${req.lessonCount} 课时 × 40 分钟）
4. 每个环节包含：教师活动脚本（含具体话术）、学生活动脚本（含具体操作）、预设问题（含预设回答与追问）、AI 协同点
5. 适配 ${req.gradeLevel} 学生认知水平
6. 体裁：${genre}，题材：${subject}

JSON 结构：
{
    "title": "教案标题",
    "keyPoints": ["重点1", "重点2"],
    "difficultPoints": ["难点1", "难点2"],
    "preparations": ["准备1", "准备2"],
    "teachingProcess": [
        {
            "phase": "introduction|literacy|interpretation|appreciation|extension|practice|homework",
            "title": "环节标题",
            "durationMin": 5,
            "teacherScript": "教师活动脚本（含具体话术，20-2000字）",
            "studentScript": "学生活动脚本（含具体操作，20-2000字）",
            "presetQuestions": [
                {
                    "question": "预设问题",
                    "expectedAnswer": "预设回答",
                    "followUp": "追问提示（可选）",
                    "bloomLevel": "记忆|理解|应用|分析|评价|创造"
                }
            ],
            "aiSynergyPoints": [
                {
                    "scenario": "AI 协同场景",
                    "aiAction": "AI 具体动作",
                    "benefit": "带来的价值"
                }
            ],
            "designIntent": "设计意图（10-500字）",
            "goalIndices": [0],
            "layerTips": {
                "basic": "基础层提示（可选）",
                "intermediate": "提高层提示（可选）",
                "advanced": "挑战层提示（可选）"
            }
        }
    ],
    "boardDesign": {
        "title": "板书标题",
        "content": "板书内容（10-2000字）",
        "structure": "linear|radial|tree|matrix",
        "intent": "板书设计意图（5-500字）"
    },
    "homework": [
        {
            "tier": "basic|intermediate|advanced|common",
            "type": "dictation|recitation|creation|investigation|reading",
            "description": "作业描述",
            "estimatedMin": 15,
            "bloomLevel": "记忆|理解|应用|分析|评价|创造",
            "optional": false
        }
    ],
    "anticipatedReflections": [
        {
            "scenario": "预设场景",
            "countermeasure": "应对措施"
        }
    ],
    "designNotes": "设计说明（10-1000字）"
}

教学环节类型说明：
- introduction: 激趣导入
- literacy: 识字正音
- interpretation: 逐句释义
- appreciation: 整体感悟/品味意象
- extension: 拓展延伸
- practice: 课堂练习
- homework: 作业布置`
}

function buildUserPrompt(
    poem: { title: string; poet: string; dynasty: string; content: string; theme: string[]; images: string[]; rhetoric: string[]; annotation: Record<string, string> | null },
    genre: string,
    subject: string,
    req: LessonGenerateRequest,
): string {
    const objectivesText = req.objectives.map((o, i) =>
        `${i + 1}. [${o.bloomLevel}/${o.category}] ${o.description}（评估：${o.assessment}）`,
    ).join('\n')

    const layeredText = req.layeredDesignSummary
        ? `\n分层情况：基础层${req.layeredDesignSummary.basicCount}人 · 提高层${req.layeredDesignSummary.intermediateCount}人 · 挑战层${req.layeredDesignSummary.advancedCount}人\n重点领域：${req.layeredDesignSummary.focusAreas.join('、')}`
        : ''

    const prefText = req.teacherPreference
        ? `\n教师偏好：\n- 教学风格：${req.teacherPreference.teachingStyle ?? '未指定'}\n- 时间分配：${req.teacherPreference.timeAllocation ?? '默认'}\n- 特殊要求：${req.teacherPreference.specialRequirements ?? '无'}`
        : ''

    return `诗歌：《${poem.title}》
作者：${poem.dynasty}·${poem.poet}
体裁：${genre} · 题材：${subject}
正文：${poem.content}
${poem.annotation ? `注释：${JSON.stringify(poem.annotation)}` : ''}
${poem.theme.length > 0 ? `主题：${poem.theme.join('、')}` : ''}
${poem.images.length > 0 ? `意象：${poem.images.join('、')}` : ''}
${poem.rhetoric.length > 0 ? `修辞：${poem.rhetoric.join('、')}` : ''}

教学年级：${req.gradeLevel}
课时数：${req.lessonCount}

教学目标：
${objectivesText}
${layeredText}
${prefText}

请生成完整教案。`
}

async function callLLM(
    systemPrompt: string,
    userPrompt: string,
    temperature = 0.7,
): Promise<z.infer<typeof generatedLessonSchema> | null> {
    try {
        const result = await managedLLM.chat({
            model: 'deepseek-v4-pro',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            thinking: 'max',
            temperature,
            maxTokens: 6000,
            jsonOutput: true,
            metadata: { agent: 'lesson-generator', task: 'generate-lesson-structured' },
        })

        return parseLessonContent(result.content)
    } catch {
        return null
    }
}

function parseLessonContent(content: string): z.infer<typeof generatedLessonSchema> | null {
    try {
        const parsed = JSON.parse(content)
        const result = generatedLessonSchema.safeParse(parsed)
        if (!result.success) {
            return null
        }
        return result.data
    } catch {
        return null
    }
}

function assembleLesson(
    poem: { id: string; title: string; poet: string; dynasty: string; content: string; theme: string[]; images: string[]; rhetoric: string[] },
    req: LessonGenerateRequest,
    parsed: z.infer<typeof generatedLessonSchema>,
    aiGenerated: boolean,
): GeneratedLesson {
    const totalDurationMin = parsed.teachingProcess.reduce((sum, p) => sum + p.durationMin, 0)

    return {
        poemId: poem.id,
        poemTitle: poem.title,
        poet: poem.poet,
        dynasty: poem.dynasty,
        gradeLevel: req.gradeLevel,
        lessonCount: req.lessonCount,
        title: parsed.title,
        goals: req.objectives,
        keyPoints: parsed.keyPoints,
        difficultPoints: parsed.difficultPoints,
        preparations: parsed.preparations,
        teachingProcess: parsed.teachingProcess,
        boardDesign: parsed.boardDesign,
        homework: parsed.homework,
        anticipatedReflections: parsed.anticipatedReflections,
        totalDurationMin,
        designNotes: parsed.designNotes,
        aiGenerated,
        generatedAt: Date.now(),
    }
}

function generateFallbackLesson(
    poem: { id: string; title: string; poet: string; dynasty: string; content: string; theme: string[]; images: string[]; rhetoric: string[] },
    req: LessonGenerateRequest,
    _genre: string,
    _subject: string,
): GeneratedLesson {
    const title = poem.title
    const totalDurationMin = req.lessonCount * 40

    return {
        poemId: poem.id,
        poemTitle: poem.title,
        poet: poem.poet,
        dynasty: poem.dynasty,
        gradeLevel: req.gradeLevel,
        lessonCount: req.lessonCount,
        title: `${title}·${req.gradeLevel}·${req.lessonCount}课时教案`,
        goals: req.objectives,
        keyPoints: [
            `正确朗读背诵《${title}》`,
            `理解诗意，体会${poem.images.slice(0, 2).join('、') || '核心意象'}的含义`,
            `感受诗人情感与${poem.dynasty}时代风貌`,
        ],
        difficultPoints: [
            `理解${poem.rhetoric.slice(0, 2).join('、') || '修辞手法'}的表达效果`,
            '体会诗歌的深层意境',
        ],
        preparations: [
            '多媒体课件（含诗篇意境图）',
            '生字卡片',
            '朗读音频',
            '课堂练习单',
        ],
        teachingProcess: [
            {
                phase: 'introduction',
                title: `激趣导入：走进${poem.poet}的${poem.dynasty}世界`,
                durationMin: 5,
                teacherScript: `同学们，今天我们要学习一首${poem.dynasty}诗。先看这幅图，你想到什么？（出示意境图）对，就是《${title}》。让我们一起走进${poem.poet}的诗意世界。`,
                studentScript: '观察意境图，自由发言，进入学习情境',
                presetQuestions: [
                    {
                        question: '看到这幅图，你想到哪首诗？',
                        expectedAnswer: '想到《' + title + '》',
                        followUp: '你从哪里看出来的？',
                        bloomLevel: '记忆',
                    },
                ],
                aiSynergyPoints: [],
                designIntent: '激发兴趣，建立图文关联',
                goalIndices: [0],
            },
            {
                phase: 'literacy',
                title: '识字正音：通读全诗',
                durationMin: 8,
                teacherScript: `现在听老师范读《${title}》，注意字音和节奏。（范读）请同学们自由朗读，读准字音，读出节奏。`,
                studentScript: '听范读，自由朗读，指名读，互相纠正字音',
                presetQuestions: [
                    {
                        question: '这首诗中有哪些生字需要特别注意？',
                        expectedAnswer: '指出易错字',
                        followUp: '这些字怎么记？',
                        bloomLevel: '记忆',
                    },
                ],
                aiSynergyPoints: [
                    {
                        scenario: '学生朗读评测',
                        aiAction: 'AI 录音分析发音准确度',
                        benefit: '个性化纠音反馈',
                    },
                ],
                designIntent: '扫除阅读障碍，正确流利朗读',
                goalIndices: [0],
            },
            {
                phase: 'interpretation',
                title: '逐句释义：理解诗意',
                durationMin: 15,
                teacherScript: `请同学们借助注释自读自悟，理解每句诗的意思。小组合作，逐句翻译。（巡视指导）哪一组来分享你们的理解？`,
                studentScript: '借助注释自读，小组合作翻译，集体交流',
                presetQuestions: [
                    {
                        question: `"${poem.content.slice(0, 5)}"是什么意思？`,
                        expectedAnswer: '逐字解释句意',
                        followUp: '你从哪个词看出来的？',
                        bloomLevel: '理解',
                    },
                    {
                        question: '这首诗写了什么场景？',
                        expectedAnswer: '描述诗中画面',
                        followUp: '能在脑中想象这个画面吗？',
                        bloomLevel: '理解',
                    },
                ],
                aiSynergyPoints: [],
                designIntent: '理解诗歌内容，为鉴赏打基础',
                goalIndices: [1],
                layerTips: {
                    basic: '基础层：借助注释逐字翻译，教师重点辅导',
                    intermediate: '提高层：独立翻译后小组互查',
                    advanced: '挑战层：翻译后评价译文的优劣',
                },
            },
            {
                phase: 'appreciation',
                title: '整体感悟：品味意象',
                durationMin: 10,
                teacherScript: `诗中有哪些意象？${poem.images.length > 0 ? `如"${poem.images.slice(0, 3).join('、')}"` : ''}。这些意象传达了什么情感？小组讨论。`,
                studentScript: '圈画意象，小组讨论意象传达的情感',
                presetQuestions: [
                    {
                        question: `诗中"${poem.images[0] ?? '核心意象'}"传达了什么情感？`,
                        expectedAnswer: '分析意象的情感内涵',
                        followUp: '为什么用这个意象？',
                        bloomLevel: '分析',
                    },
                ],
                aiSynergyPoints: [
                    {
                        scenario: '意象可视化',
                        aiAction: 'AI 生成意象配图',
                        benefit: '帮助学生建立意象与情感的联结',
                    },
                ],
                designIntent: '从内容理解走向审美鉴赏',
                goalIndices: [2, 3],
            },
            {
                phase: 'practice',
                title: '课堂练习：巩固迁移',
                durationMin: 7,
                teacherScript: '出示练习题（填空/选择/简答），独立完成后集体订正。',
                studentScript: '独立完成练习，集体订正',
                presetQuestions: [],
                aiSynergyPoints: [
                    {
                        scenario: '即时评估',
                        aiAction: 'AI 自动批改练习',
                        benefit: '即时反馈，精准定位薄弱点',
                    },
                ],
                designIntent: '检测学习效果，强化薄弱环节',
                goalIndices: [0, 1],
            },
            {
                phase: 'homework',
                title: '作业布置：拓展延伸',
                durationMin: 5,
                teacherScript: '今天我们学习了《' + title + '》，请同学们完成分层作业。基础层完成背诵默写，提高层增加鉴赏题，挑战层尝试改写。',
                studentScript: '记录作业，课后完成',
                presetQuestions: [],
                aiSynergyPoints: [],
                designIntent: '巩固迁移，培养自主学习习惯',
                goalIndices: [3],
            },
        ],
        boardDesign: {
            title: poem.title,
            content: `${poem.title}\n${poem.poet}·${poem.dynasty}\n\n${poem.content}`,
            structure: 'linear',
            intent: '以诗篇原文为核心，辅以意象关键词，形成图文对照的视觉结构',
        },
        homework: [
            { tier: 'common', type: 'recitation', description: `背诵《${title}》`, estimatedMin: 15, bloomLevel: '记忆', optional: false },
            { tier: 'common', type: 'dictation', description: '默写重点诗句', estimatedMin: 10, bloomLevel: '记忆', optional: false },
            { tier: 'intermediate', type: 'creation', description: `分析《${title}》中意象的表达效果（100字）`, estimatedMin: 20, bloomLevel: '分析', optional: false },
            { tier: 'advanced', type: 'creation', description: `改写《${title}》为现代散文`, estimatedMin: 30, bloomLevel: '创造', optional: true },
        ],
        anticipatedReflections: [
            { scenario: '学生对意象理解困难', countermeasure: '借助 AI 意象配图辅助理解' },
            { scenario: '基础层学生背诵困难', countermeasure: '提供带拼音版本，分段背诵' },
        ],
        totalDurationMin,
        designNotes: `基于《${title}》文本特征与${req.gradeLevel}学情设计的${req.lessonCount}课时教案。`,
        aiGenerated: false,
        generatedAt: Date.now(),
    }
}
