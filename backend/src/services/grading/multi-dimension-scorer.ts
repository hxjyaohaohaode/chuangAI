/**
 * 多维度评分服务（批改诊断深化能力 1/5）
 *
 * 职责：在传统"对/错/部分得分"批改基础上，从 6 个认知维度精细化评分，
 * 输出每个维度的分数、评语与改进建议，支持教师按维度加权合成总分。
 *
 * 模型：deepseek-v4-pro（thinking: high）+ JSON Output
 * 维度：准确性 / 完整性 / 理解力 / 表达力 / 创造性 / 文化敏感度
 *
 * 设计要点：
 * - 经显式模型托管网关调用，不经过选模 Router，精确保留模型与思考档
 * - JSON Output 确保结构化输出，Zod 校验保证类型完整
 * - 教师可调权重：默认等权 1/6，可自定义每个维度权重（0-1）
 * - 加权总分 = Σ(维度得分 × 维度权重) / Σ权重
 * - 维度评语面向学生（鼓励性），教学建议面向教师（诊断性）
 */

import { z } from 'zod'
import { managedLLM } from '../../llm/index.js'
import type { ChatMessage } from '../../llm/types.js'
import type { Question, StudentProfile } from '../../agents/base/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 评分维度标识 */
export type ScoreDimension =
    | 'accuracy'      // 准确性：字音字形、事实性内容的正确程度
    | 'completeness'  // 完整性：要点覆盖度，是否遗漏关键信息
    | 'comprehension' // 理解力：对诗意、意象、情感的理解深度
    | 'expression'    // 表达力：语言组织、连贯性、修辞运用
    | 'creativity'    // 创造性：原创性、想象力、独特视角
    | 'cultural'      // 文化敏感度：对文化内涵、历史背景的把握

/** 维度中文标签映射 */
export const DIMENSION_LABELS: Record<ScoreDimension, string> = {
    accuracy: '准确性',
    completeness: '完整性',
    comprehension: '理解力',
    expression: '表达力',
    creativity: '创造性',
    cultural: '文化敏感度',
}

/** 默认权重（等权） */
export const DEFAULT_WEIGHTS: Record<ScoreDimension, number> = {
    accuracy: 1,
    completeness: 1,
    comprehension: 1,
    expression: 1,
    creativity: 1,
    cultural: 1,
}

/** 单维度评分 */
export interface DimensionScore {
    /** 维度标识 */
    dimension: ScoreDimension
    /** 维度中文名 */
    label: string
    /** 该维度得分 0-100 */
    score: number
    /** 面向学生的维度评语（鼓励性，50-100 字） */
    comment: string
    /** 面向教师的教学建议（诊断性，30-80 字） */
    teachingHint: string
}

/** 多维度评分输入 */
export interface MultiDimScoreInput {
    /** 题目实体 */
    question: Question
    /** 学生答案文本 */
    studentAnswer: string
    /** 学生画像（可选，提升归因精度） */
    studentProfile?: StudentProfile
    /** 教师自定义权重（可选，缺省等权） */
    weights?: Partial<Record<ScoreDimension, number>>
}

/** 多维度评分输出 */
export interface MultiDimScoreOutput {
    /** 题目 ID */
    questionId: string
    /** 六维度评分明细 */
    dimensions: DimensionScore[]
    /** 加权总分 0-100 */
    weightedTotal: number
    /** 使用的权重（归一化后） */
    appliedWeights: Record<ScoreDimension, number>
    /** 综合评语（100-200 字，融合六维度） */
    overallComment: string
    /** 是否需要人工复核 */
    needsHumanReview: boolean
    /** AI 生成标记 */
    aiGenerated: true
    /** 评分置信度 0-1 */
    confidence: number
}

// ─────────────────────────────────────────────────────────────
// Zod 校验 schema
// ─────────────────────────────────────────────────────────────

const dimensionSchema = z.object({
    dimension: z.enum(['accuracy', 'completeness', 'comprehension', 'expression', 'creativity', 'cultural']),
    label: z.string(),
    score: z.number().min(0).max(100),
    comment: z.string().min(10).max(200),
    teachingHint: z.string().min(10).max(150),
})

const scoreOutputSchema = z.object({
    questionId: z.string(),
    dimensions: z.array(dimensionSchema).length(6),
    weightedTotal: z.number().min(0).max(100),
    appliedWeights: z.object({
        accuracy: z.number(),
        completeness: z.number(),
        comprehension: z.number(),
        expression: z.number(),
        creativity: z.number(),
        cultural: z.number(),
    }),
    overallComment: z.string().min(50).max(300),
    needsHumanReview: z.boolean(),
    aiGenerated: z.literal(true),
    confidence: z.number().min(0).max(1),
})

// ─────────────────────────────────────────────────────────────
// MultiDimensionScorer 服务
// ─────────────────────────────────────────────────────────────

/**
 * 多维度评分器
 *
 * 使用 deepseek-v4-pro + high 思考模式，对单条学生答案从 6 个维度评分。
 * 单例模式，全局共享。
 */
export class MultiDimensionScorer {
    private static instance: MultiDimensionScorer | null = null

    static getInstance(): MultiDimensionScorer {
        if (!MultiDimensionScorer.instance) {
            MultiDimensionScorer.instance = new MultiDimensionScorer()
        }
        return MultiDimensionScorer.instance
    }

    /**
     * 对单条答案进行多维度评分
     *
     * @param input 评分输入（题目 + 答案 + 可选画像与权重）
     * @returns 多维度评分结果
     */
    async score(input: MultiDimScoreInput): Promise<MultiDimScoreOutput> {
        const weights = { ...DEFAULT_WEIGHTS, ...input.weights }
        const normalizedWeights = this.normalizeWeights(weights)

        const messages = this.buildMessages(input, normalizedWeights)

        const result = await managedLLM.chat({
            model: 'deepseek-v4-pro',
            thinking: 'high',
            jsonOutput: true,
            temperature: 0.3,
            maxTokens: 4096,
            messages,
            metadata: {
                agent: 'multi-dim-scorer',
                task: 'score-multi-dim',
            },
        })

        return this.parseAndValidate(result.content, input.question.id, normalizedWeights)
    }

    /**
     * 批量评分：对多条答案并行评分（控制并发避免限流）
     *
     * @param inputs 多条评分输入
     * @param concurrency 并发数（默认 3）
     * @returns 多条评分结果
     */
    async batchScore(
        inputs: MultiDimScoreInput[],
        concurrency = 3,
    ): Promise<MultiDimScoreOutput[]> {
        const results: MultiDimScoreOutput[] = []
        for (let i = 0; i < inputs.length; i += concurrency) {
            const batch = inputs.slice(i, i + concurrency)
            const batchResults = await Promise.all(
                batch.map((input) => this.score(input).catch((err) => {
                    // 单条失败返回降级结果，不阻断批量
                    return this.fallback(input, err)
                })),
            )
            results.push(...batchResults)
        }
        return results
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    /** 权重归一化（使总和为 1） */
    private normalizeWeights(weights: Record<ScoreDimension, number>): Record<ScoreDimension, number> {
        const sum = Object.values(weights).reduce((a, b) => a + Math.max(0, b), 0)
        if (sum === 0) return { ...DEFAULT_WEIGHTS }
        const normalized = { ...DEFAULT_WEIGHTS }
        for (const key of Object.keys(normalized) as ScoreDimension[]) {
            normalized[key] = Math.max(0, weights[key] ?? 0) / sum
        }
        return normalized
    }

    /** 构建对话消息 */
    private buildMessages(
        input: MultiDimScoreInput,
        weights: Record<ScoreDimension, number>,
    ): ChatMessage[] {
        const systemPrompt = this.buildSystemPrompt()
        const userPrompt = this.buildUserPrompt(input, weights)
        return [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ]
    }

    /** 构建 system prompt */
    private buildSystemPrompt(): string {
        return `你是古诗词教学的多维度评分专家，精通布鲁姆认知层级理论与中华文化教育评价。

## 你的职责
对学生古诗词答题从 6 个维度进行精细化评分，每个维度输出：
1. 维度分数（0-100，整数）
2. 面向学生的维度评语（鼓励性，50-100 字，指出亮点与改进方向）
3. 面向教师的教学建议（诊断性，30-80 字，可执行的教学干预）

## 六个评分维度

| 维度 | 标识 | 评分要点 |
|------|------|----------|
| 准确性 | accuracy | 字音字形、作者朝代、事实性内容的正确程度 |
| 完整性 | completeness | 答题要点覆盖度，是否遗漏关键信息（如情感、手法、意象） |
| 理解力 | comprehension | 对诗意、意象象征、情感主旨的理解深度 |
| 表达力 | expression | 语言组织、逻辑连贯、修辞运用、文采 |
| 创造性 | creativity | 原创性、想象力、独特视角（主观题重点） |
| 文化敏感度 | cultural | 对文化内涵、历史背景、审美传统的把握 |

## 评分纪律
- 客观题（选择/填空/配对）：accuracy 与 completeness 为主要维度，其余维度适当降低权重
- 主观题（简答/赏析/创作）：六维度均评，creativity 与 expression 权重提升
- 评语必须具体到该维度的表现，不可泛泛说"较好"或"需加强"
- overallComment 须融合六维度亮点与改进点，100-200 字
- 答案完全空白或答非所问时，所有维度 score ≤ 20，needsHumanReview = true
- confidence < 0.7 时 needsHumanReview 必为 true

## 输出格式（严格 JSON）
{
  "questionId": "题目ID",
  "dimensions": [
    {"dimension": "accuracy", "label": "准确性", "score": 85, "comment": "...", "teachingHint": "..."},
    {"dimension": "completeness", "label": "完整性", "score": 80, "comment": "...", "teachingHint": "..."},
    {"dimension": "comprehension", "label": "理解力", "score": 78, "comment": "...", "teachingHint": "..."},
    {"dimension": "expression", "label": "表达力", "score": 82, "comment": "...", "teachingHint": "..."},
    {"dimension": "creativity", "label": "创造性", "score": 70, "comment": "...", "teachingHint": "..."},
    {"dimension": "cultural", "label": "文化敏感度", "score": 75, "comment": "...", "teachingHint": "..."}
  ],
  "weightedTotal": 78,
  "appliedWeights": {"accuracy": 0.2, "completeness": 0.2, "comprehension": 0.15, "expression": 0.15, "creativity": 0.15, "cultural": 0.15},
  "overallComment": "综合评语...",
  "needsHumanReview": false,
  "aiGenerated": true,
  "confidence": 0.85
}`
    }

    /** 构建 user prompt */
    private buildUserPrompt(
        input: MultiDimScoreInput,
        weights: Record<ScoreDimension, number>,
    ): string {
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

        const weightsStr = JSON.stringify(weights, null, 2)

        return `请对以下学生答题进行六维度评分。

<question>
${questionStr}
</question>

<student_answer>
${input.studentAnswer}
</student_answer>

<student_profile>
${profileStr}
</student_profile>

<applied_weights>
${weightsStr}
</applied_weights>

请输出严格 JSON，weightedTotal 须等于各维度 score × 权重的加权和（四舍五入至整数）。`
    }

    /** 解析与校验 LLM 输出 */
    private parseAndValidate(
        raw: string,
        questionId: string,
        normalizedWeights: Record<ScoreDimension, number>,
    ): MultiDimScoreOutput {
        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch {
            throw new Error(`多维度评分输出 JSON 解析失败: ${raw.slice(0, 200)}`)
        }

        const result = scoreOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(
                `多维度评分输出校验失败: ${result.error.issues
                    .map((i) => `${i.path.join('.')}: ${i.message}`)
                    .join('; ')}`,
            )
        }

        // 强制 questionId 与输入一致
        const output = result.data
        output.questionId = questionId
        output.appliedWeights = normalizedWeights

        // 重算加权总分（确保 LLM 输出与权重一致）
        let weightedSum = 0
        for (const dim of output.dimensions) {
            const w = normalizedWeights[dim.dimension] ?? 0
            weightedSum += dim.score * w
        }
        output.weightedTotal = Math.round(weightedSum)

        return output
    }

    /** 降级输出（LLM 失败时） */
    private fallback(input: MultiDimScoreInput, err: unknown): MultiDimScoreOutput {
        const errMsg = err instanceof Error ? err.message : String(err)
        const dimensions: DimensionScore[] = (
            Object.keys(DEFAULT_WEIGHTS) as ScoreDimension[]
        ).map((dim) => ({
            dimension: dim,
            label: DIMENSION_LABELS[dim],
            score: 0,
            comment: `评分服务暂时不可用，请人工评分。`,
            teachingHint: `AI 评分失败：${errMsg.slice(0, 50)}`,
        }))

        return {
            questionId: input.question.id,
            dimensions,
            weightedTotal: 0,
            appliedWeights: this.normalizeWeights({ ...DEFAULT_WEIGHTS, ...input.weights }),
            overallComment: 'AI 多维度评分服务暂时不可用，已标记需人工复核。请教师手动评分。',
            needsHumanReview: true,
            aiGenerated: true,
            confidence: 0,
        }
    }
}

/** 全局单例 */
export const multiDimensionScorer = MultiDimensionScorer.getInstance()
