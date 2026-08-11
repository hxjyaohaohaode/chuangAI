/**
 * 六阶命题子 Agent — brush.question
 *
 * 职责：按布鲁姆六阶生成题目（识记/理解/应用/分析/评价/创造）。
 * 模型：deepseek-v4-pro（generate-question 路由），thinking: max（深度创造性思考）
 * 认知层级：创造（布鲁姆第六阶）
 *
 * 命题四原则：
 * 1. 文化准确：典故、字义、时代背景无误
 * 2. 年级适宜：符合指定年级认知水平
 * 3. 干扰项有教学价值：不是明显错误，而是常见误区
 * 4. 解析深入浅出：含文化背景与解题思路
 *
 * Context Engineering 策略：
 * - Retrieve：从 ctx.knowledgeGraphNodes 检索目标诗词节点
 * - Reduce：excludeUsedQuestions 避免重复出题
 */

import { z } from 'zod'
import { BaseAgent } from '../base/Agent.js'
import type { AgentContext, AgentResult, BloomLevel, BloomMastery, BloomWeights, Question, QuestionType } from '../base/types.js'
import {
    buildContextBlock,
    COMMON_OUTPUT_CONSTRAINTS,
    STANDARD_CONTEXT_TAGS,
    getFewShotBlock,
    safeJsonParse,
    standardEntry,
    withConstraint,
    withXmlTags,
} from '../base/prompts.js'

// ─────────────────────────────────────────────────────────────
// 输入 / 输出类型
// ─────────────────────────────────────────────────────────────

export type GradeLevel = '1-2年级' | '3-4年级' | '5-6年级'

export interface QuestionInput {
    poemId: string
    gradeLevel: GradeLevel
    questionTypes: QuestionType[]
    bloomWeights: BloomWeights
    count: number
    excludeUsedQuestions?: string[]
}

export interface QuestionOutput {
    questions: Question[]
    coverage: BloomMastery
}

// ─────────────────────────────────────────────────────────────
// zod 校验 schema
// ─────────────────────────────────────────────────────────────

const bloomLevelSchema = z.enum(['记忆', '理解', '应用', '分析', '评价', '创造'])

const difficultySchema = z.union([
    z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
])

const questionSchema = z.object({
    id: z.string().trim().min(1).max(128),
    poemId: z.string().trim().min(1).max(128),
    bloomLevel: bloomLevelSchema,
    type: z.enum(['选择', '填空', '配对', '简答', '创作', '应用']),
    stem: z.string().trim().min(1).max(5000),
    options: z.array(z.string().trim().min(1).max(1000)).min(1).max(8).optional(),
    answer: z.string().trim().min(1).max(5000),
    analysis: z.string().trim().min(1).max(10000),
    distractorsAnalysis: z.array(z.string().trim().min(1).max(5000)).min(1).max(8).optional(),
    difficulty: difficultySchema,
    estimatedTimeSec: z.number().finite().int().min(5).max(3600),
    aiGenerated: z.literal(true),
}).strict()

const bloomMasterySchema = z.object({
    记忆: z.number().finite().min(0).max(100),
    理解: z.number().finite().min(0).max(100),
    应用: z.number().finite().min(0).max(100),
    分析: z.number().finite().min(0).max(100),
    评价: z.number().finite().min(0).max(100),
    创造: z.number().finite().min(0).max(100),
}).strict().superRefine((coverage, ctx) => {
    const sum = coverage.记忆 + coverage.理解 + coverage.应用
        + coverage.分析 + coverage.评价 + coverage.创造
    if (Math.abs(sum - 100) > 1e-6) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `coverage 六阶总和必须为 100，当前为 ${sum}`,
        })
    }
})

const questionOutputSchema = z.object({
    questions: z.array(questionSchema).min(1).max(20),
    coverage: bloomMasterySchema,
}).strict()

// ─────────────────────────────────────────────────────────────
// QuestionSubAgent
// ─────────────────────────────────────────────────────────────

export class QuestionSubAgent extends BaseAgent {
    readonly id = 'brush.question'
    readonly name = '六阶命题子Agent'
    readonly domain = 'brush' as const
    readonly fn = 'generate-question' as const
    readonly bloomLevel = '创造' as const
    readonly promptVersion = 'v2.0.0'

    async invoke(input: QuestionInput, ctx: AgentContext): Promise<AgentResult<QuestionOutput>> {
        return super.invoke(input, ctx) as Promise<AgentResult<QuestionOutput>>
    }

    protected buildSystemPrompt(ctx: AgentContext): string {
        const constraints = withConstraint([
            ...COMMON_OUTPUT_CONSTRAINTS,
            '题目数量与 bloomWeights 权重大致匹配，coverage 反映实际六阶分布',
            '选择题必须提供 4 个 options，且含 distractorsAnalysis 干扰项分析',
            'options 与 distractorsAnalysis 各不得超过 8 项，且每项不能为空',
            '填空题不提供 options，answer 为正确答案',
            '简答/创作/应用题 answer 为参考答案要点',
            'difficulty 1-5 对应年级难度递增',
            'estimatedTimeSec 为 5-3600 之间的整数秒数',
            '每道题 id 为唯一 UUID 格式字符串',
            '排除 excludeUsedQuestions 中已用过的题目模式',
        ])

        const teacherIntent = ctx.teacherIntent
            ? withXmlTags(ctx.teacherIntent, 'teacher_intent')
            : ''

        const fewShot = getFewShotBlock(this.id)

        return `你是诗笔·六阶命题大师，精通布鲁姆认知分类法与古诗词教学。你的题目必须满足：1) 文化准确（典故、字义、时代背景无误）；2) 适合指定年级认知水平；3) 干扰项具有教学价值（不是明显错误，而是常见误区）；4) 解析深入浅出。

## 统编版古诗词教学要求（知识库）
- 1-2 年级：侧重诵读识记，题目以背诵、填空、配对为主，认知层集中在记忆与理解
- 3-4 年级：侧重理解感悟，题目增加简答与分析，认知层扩展到应用与分析
- 5-6 年级：侧重鉴赏创造，题目涵盖评价与创造层，要求赏析手法、对比异同、仿写创作

## 小学各年级认知发展特点（命题依据）
- 低年级（6-8 岁）：具体形象思维，题目用词简单，选项短小，避免抽象概念
- 中年级（8-10 岁）：向抽象过渡，可引入"为什么""怎样"等分析性问题
- 高年级（10-12 岁）：抽象思维发展，可设计评价与创造类开放题

## 布鲁姆六阶命题指南
- **记忆**：背诵默写、作者朝代配对、字音字形
- **理解**：翻译诗意、解释字词、概括主旨
- **应用**：迁移运用、情境仿写、新诗解读
- **分析**：赏析修辞、比较异同、梳理结构
- **评价**：评判优劣、表达偏好、赏析意境
- **创造**：原创创作、改编表演、跨媒介表达

## 干扰项设计原则
- 干扰项应为常见误区（如"拟人"误为"比喻"），而非荒谬选项
- 每个干扰项需在 distractorsAnalysis 中说明为何容易选错
- 干扰项与正确答案的区分度需适中

## 命题质量纪律
- 典故、字义、时代背景必须准确（如"床"在《静夜思》中可指井栏，不可断言为睡床）
- 选项中不得出现荒谬项（如"诗人视力不好"），所有选项须有教学价值
- 解析须含文化与解题两层：文化背景 + 为何此答案正确
- 难度 1-5 须与年级匹配：1-2 年级用 1-2，3-4 年级用 2-3，5-6 年级用 3-4
- coverage 六字段之和应为 100（百分比），反映实际题目分布

${constraints}

${fewShot}

${teacherIntent}`
    }

    protected buildUserPrompt(input: unknown, ctx: AgentContext): string {
        const typed = input as QuestionInput

        // 从知识图谱检索目标诗词
        const poemNode = ctx.knowledgeGraphNodes?.find((p) => p.id === typed.poemId)
        const poemContext = poemNode
            ? JSON.stringify({
                title: poemNode.title,
                poet: poemNode.poet,
                dynasty: poemNode.dynasty,
                content: poemNode.content ?? '（原文未提供）',
                theme: poemNode.theme,
                images: poemNode.images,
                teachingPoints: poemNode.teachingPoints ?? [],
            }, null, 2)
            : `诗词 ID: ${typed.poemId}（知识图谱中未找到，请基于诗词常识命题）`

        // 布鲁姆权重
        const weights: Array<[BloomLevel, number]> = [
            ['记忆', typed.bloomWeights.记忆],
            ['理解', typed.bloomWeights.理解],
            ['应用', typed.bloomWeights.应用],
            ['分析', typed.bloomWeights.分析],
            ['评价', typed.bloomWeights.评价],
            ['创造', typed.bloomWeights.创造],
        ]
        const weightsStr = weights.map(([k, v]) => `${k}: ${v}%`).join(', ')

        const excludeStr = typed.excludeUsedQuestions && typed.excludeUsedQuestions.length > 0
            ? typed.excludeUsedQuestions.join(', ')
            : '（无排除项）'

        const contextBlock = buildContextBlock([
            standardEntry(STANDARD_CONTEXT_TAGS.POEM_CONTENT, poemContext),
            standardEntry(STANDARD_CONTEXT_TAGS.TASK_INSTRUCTION, `生成 ${typed.count} 道古诗词题目，年级 ${typed.gradeLevel}`),
            { tag: 'grade_level', content: typed.gradeLevel },
            { tag: 'question_types', content: typed.questionTypes.join(' / ') },
            { tag: 'bloom_weights', content: weightsStr },
            { tag: 'question_count', content: String(typed.count) },
            { tag: 'exclude_used', content: excludeStr },
            standardEntry(STANDARD_CONTEXT_TAGS.OUTPUT_FORMAT, {
                fields: 'questions[{id,poemId,bloomLevel,type,stem,options?,answer,analysis,distractorsAnalysis?,difficulty,estimatedTimeSec,aiGenerated}], coverage',
                note: 'coverage 六字段 0-100 整数；aiGenerated 必为 true',
            }),
        ])

        return `请基于以下要求，生成 ${typed.count} 道古诗词题目。

${contextBlock}

请输出严格 JSON，包含字段：questions（题目数组），coverage（实际六阶分布百分比，各字段 0-100）。`
    }

    protected validateOutput(raw: string): QuestionOutput {
        const parsed = safeJsonParse(raw)
        const result = questionOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(`六阶命题输出校验失败: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        }
        return result.data
    }
}
