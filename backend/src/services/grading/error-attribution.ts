/**
 * 错题归因服务（批改诊断深化能力 3/5）
 *
 * 职责：对学生错误答题进行深度归因分析，识别 5 类错误根源，
 * 关联知识图谱节点，输出可执行的教学干预建议。
 *
 * 模型：deepseek-v4-pro（thinking: high）+ JSON Output
 * 错误类型：知识型 / 理解型 / 表达型 / 粗心型 / 文化型
 *
 * 设计要点：
 * - 经显式模型托管网关调用，保留 v4-pro/high 并统一限流、计费与观测
 * - 5 类错误类型覆盖小学生古诗词学习的主要失误模式
 * - 每类错误关联布鲁姆认知层级，便于与诊断中心数据打通
 * - 输出可执行的教学干预建议（具体到活动、素材、时长）
 * - 支持批量归因（同一学生多题或同一题多学生）
 */

import { z } from 'zod'
import { managedLLM } from '../../llm/index.js'
import type { ChatMessage } from '../../llm/types.js'
import type { Question, StudentProfile } from '../../agents/base/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 错误类型标识 */
export type ErrorType =
    | 'knowledge'    // 知识型：字音字形、作者朝代等事实性知识缺失
    | 'comprehension' // 理解型：对诗意、意象、情感的理解偏差
    | 'expression'   // 表达型：语言组织、逻辑连贯、修辞运用不足
    | 'careless'     // 粗心型：笔误、看错题、漏字等非认知因素
    | 'cultural'     // 文化型：对文化内涵、历史背景、审美传统的不熟悉

/** 错误类型中文标签 */
export const ERROR_TYPE_LABELS: Record<ErrorType, string> = {
    knowledge: '知识型错误',
    comprehension: '理解型错误',
    expression: '表达型错误',
    careless: '粗心型错误',
    cultural: '文化型错误',
}

/** 错误类型对应的布鲁姆认知层级 */
export const ERROR_TYPE_BLOOM: Record<ErrorType, string> = {
    knowledge: '记忆',
    comprehension: '理解',
    expression: '应用',
    careless: '记忆',
    cultural: '评价',
}

/** 错题归因输入 */
export interface ErrorAttributionInput {
    /** 题目实体 */
    question: Question
    /** 学生答案文本 */
    studentAnswer: string
    /** 学生画像（可选） */
    studentProfile?: StudentProfile
    /** 批改结果（可选，提供时归因更精准） */
    gradingResult?: {
        correct: boolean
        partialScore?: number
        cognitiveAttribution?: string
        feedback?: string
    }
}

/** 错题归因输出 */
export interface ErrorAttributionOutput {
    /** 题目 ID */
    questionId: string
    /** 主导错误类型 */
    primaryErrorType: ErrorType
    /** 主导错误类型中文标签 */
    primaryErrorLabel: string
    /** 关联的布鲁姆认知层级 */
    bloomLevel: string
    /** 错误严重度 0-100（越高越严重） */
    severity: number
    /** 错误根因分析（100-200 字，指出具体失误点） */
    rootCause: string
    /** 次要错误类型（可选，一道题可能同时存在多种错误） */
    secondaryErrorTypes: Array<{
        type: ErrorType
        label: string
        contribution: number // 贡献度 0-1
    }>
    /** 关联知识图谱节点（诗 ID / 意象 / 主题等） */
    relatedNodes: Array<{
        type: 'poem' | 'image' | 'theme' | 'rhetoric' | 'era'
        id: string
        label: string
        relation: string
    }>
    /** 教学干预建议（具体可执行） */
    interventions: Array<{
        type: 'review' | 'practice' | 'compare' | 'create' | 'discuss'
        label: string
        description: string
        estimatedMinutes: number
    }>
    /** 是否为反复错误（同一知识点多次出错，可选） */
    isRecurring?: boolean
    /** AI 生成标记 */
    aiGenerated: true
    /** 归因置信度 0-1 */
    confidence: number
}

// ─────────────────────────────────────────────────────────────
// Zod 校验 schema
// ─────────────────────────────────────────────────────────────

const secondaryErrorSchema = z.object({
    type: z.enum(['knowledge', 'comprehension', 'expression', 'careless', 'cultural']),
    label: z.string(),
    contribution: z.number().min(0).max(1),
})

const relatedNodeSchema = z.object({
    type: z.enum(['poem', 'image', 'theme', 'rhetoric', 'era']),
    id: z.string(),
    label: z.string(),
    relation: z.string(),
})

const interventionSchema = z.object({
    type: z.enum(['review', 'practice', 'compare', 'create', 'discuss']),
    label: z.string(),
    description: z.string(),
    estimatedMinutes: z.number().int().min(5).max(60),
})

const attributionOutputSchema = z.object({
    questionId: z.string(),
    primaryErrorType: z.enum(['knowledge', 'comprehension', 'expression', 'careless', 'cultural']),
    primaryErrorLabel: z.string(),
    bloomLevel: z.string(),
    severity: z.number().min(0).max(100),
    rootCause: z.string().min(50).max(300),
    secondaryErrorTypes: z.array(secondaryErrorSchema),
    relatedNodes: z.array(relatedNodeSchema),
    interventions: z.array(interventionSchema).min(1).max(5),
    isRecurring: z.boolean().optional(),
    aiGenerated: z.literal(true),
    confidence: z.number().min(0).max(1),
})

// ─────────────────────────────────────────────────────────────
// ErrorAttributionService 服务
// ─────────────────────────────────────────────────────────────

/**
 * 错题归因服务
 *
 * 使用 deepseek-v4-pro + high 思考模式，对错题进行深度归因。
 * 单例模式，全局共享。
 */
export class ErrorAttributionService {
    private static instance: ErrorAttributionService | null = null

    static getInstance(): ErrorAttributionService {
        if (!ErrorAttributionService.instance) {
            ErrorAttributionService.instance = new ErrorAttributionService()
        }
        return ErrorAttributionService.instance
    }

    /**
     * 对单条错题进行归因分析
     *
     * @param input 归因输入
     * @returns 归因结果
     */
    async attribute(input: ErrorAttributionInput): Promise<ErrorAttributionOutput> {
        const messages = this.buildMessages(input)

        const result = await managedLLM.chat({
            model: 'deepseek-v4-pro',
            thinking: 'high',
            jsonOutput: true,
            temperature: 0.3,
            maxTokens: 4096,
            messages,
            metadata: {
                agent: 'error-attribution',
                task: 'attribute',
            },
        })

        return this.parseAndValidate(result.content, input.question.id)
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    /** 构建对话消息 */
    private buildMessages(input: ErrorAttributionInput): ChatMessage[] {
        const systemPrompt = this.buildSystemPrompt()
        const userPrompt = this.buildUserPrompt(input)
        return [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ]
    }

    /** 构建 system prompt */
    private buildSystemPrompt(): string {
        return `你是古诗词教学的错题归因专家，精通认知诊断与教学干预设计。

## 你的职责
对学生错题进行深度归因分析，识别错误根源，关联知识图谱，输出可执行的教学干预建议。

## 五类错误类型

| 类型 | 标识 | 布鲁姆层级 | 典型表现 |
|------|------|------------|----------|
| 知识型 | knowledge | 记忆 | 字音字形错误、作者朝代混淆、诗句默写错误 |
| 理解型 | comprehension | 理解 | 诗意翻译偏差、意象象征误读、情感主旨把握不准 |
| 表达型 | expression | 应用 | 语言组织混乱、逻辑不连贯、修辞运用不当 |
| 粗心型 | careless | 记忆 | 笔误、看错题、漏字、答非所问（非认知缺陷） |
| 文化型 | cultural | 评价 | 对文化内涵、历史背景、审美传统不熟悉 |

## 归因纪律
- primaryErrorType 必须是主导错误（贡献度 > 50%）
- secondaryErrorTypes 为次要错误，contribution 之和 ≤ 50%
- rootCause 须具体到失误点（如"将'疑是地上霜'的'霜'误写为'双'"），不可泛泛说"理解不到位"
- relatedNodes 关联知识图谱节点，至少 1 个（如诗本身、意象、主题、修辞、朝代）
- interventions 须具体可执行（如"用《静夜思》与《月夜》对比'月'意象的不同"），不可仅"多练习"
- severity: 知识型/理解型 ≥ 60，粗心型 ≤ 40，文化型 40-70
- isRecurring: 若学生画像 weaknesses 中包含相关知识点，标记为 true

## 输出格式（严格 JSON）
{
  "questionId": "题目ID",
  "primaryErrorType": "comprehension",
  "primaryErrorLabel": "理解型错误",
  "bloomLevel": "理解",
  "severity": 65,
  "rootCause": "学生将'举头望明月'中的'望'理解为'看'，忽略了'望'在此处含'凝视、思念'的双重含义，导致情感把握偏差...",
  "secondaryErrorTypes": [
    {"type": "cultural", "label": "文化型错误", "contribution": 0.2}
  ],
  "relatedNodes": [
    {"type": "poem", "id": "poem-001", "label": "静夜思", "relation": "本题所属诗篇"},
    {"type": "image", "id": "img-moon", "label": "月亮意象", "relation": "思乡象征"}
  ],
  "interventions": [
    {"type": "compare", "label": "对比赏析", "description": "对比《静夜思》与《望月怀远》中'望月'的情感异同", "estimatedMinutes": 15}
  ],
  "isRecurring": false,
  "aiGenerated": true,
  "confidence": 0.85
}`
    }

    /** 构建 user prompt */
    private buildUserPrompt(input: ErrorAttributionInput): string {
        const questionStr = JSON.stringify({
            id: input.question.id,
            poemId: input.question.poemId,
            bloomLevel: input.question.bloomLevel,
            type: input.question.type,
            stem: input.question.stem,
            options: input.question.options ?? [],
            answer: input.question.answer,
            analysis: input.question.analysis,
            difficulty: input.question.difficulty,
        }, null, 2)

        const profileStr = input.studentProfile
            ? JSON.stringify({
                name: input.studentProfile.name,
                grade: input.studentProfile.grade,
                cognitiveStyle: input.studentProfile.cognitiveStyle,
                strengths: input.studentProfile.strengths ?? [],
                weaknesses: input.studentProfile.weaknesses ?? [],
            }, null, 2)
            : '（学情画像未提供）'

        const gradingStr = input.gradingResult
            ? JSON.stringify(input.gradingResult, null, 2)
            : '（批改结果未提供）'

        return `请对以下错题进行归因分析。

<question>
${questionStr}
</question>

<student_answer>
${input.studentAnswer}
</student_answer>

<student_profile>
${profileStr}
</student_profile>

<grading_result>
${gradingStr}
</grading_result>

请输出严格 JSON，primaryErrorType 须为主导错误类型，rootCause 须具体到失误点。`
    }

    /** 解析与校验 LLM 输出 */
    private parseAndValidate(raw: string, questionId: string): ErrorAttributionOutput {
        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch {
            throw new Error(`错题归因输出 JSON 解析失败: ${raw.slice(0, 200)}`)
        }

        const result = attributionOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(
                `错题归因输出校验失败: ${result.error.issues
                    .map((i) => `${i.path.join('.')}: ${i.message}`)
                    .join('; ')}`,
            )
        }

        // 强制 questionId 与输入一致
        result.data.questionId = questionId

        // 确保 primaryErrorLabel 与 ERROR_TYPE_LABELS 一致
        result.data.primaryErrorLabel = ERROR_TYPE_LABELS[result.data.primaryErrorType]
        for (const sec of result.data.secondaryErrorTypes) {
            sec.label = ERROR_TYPE_LABELS[sec.type]
        }

        // 确保 bloomLevel 与错误类型一致
        result.data.bloomLevel = ERROR_TYPE_BLOOM[result.data.primaryErrorType]

        return result.data
    }
}

/** 全局单例 */
export const errorAttribution = ErrorAttributionService.getInstance()
