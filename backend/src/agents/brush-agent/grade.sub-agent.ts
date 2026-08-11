/**
 * 智能批改子 Agent — brush.grade
 *
 * 职责：快速批改学生答题，输出认知归因与反馈。
 * 模型：deepseek-v4-flash（grade 路由），thinking: low（追求速度）
 * 认知层级：评价（布鲁姆第五阶）
 *
 * 批改策略：
 * - 客观题（选择/填空/配对）：判定对错，给出认知归因
 * - 主观题（简答/创作/应用）：部分得分制（partialScore 0-1）
 * - 低置信度（confidence < 0.8）标记 needsHumanReview
 * - 反馈面向学生（鼓励性），teacherHint 面向教师（诊断性）
 *
 * Context Engineering 策略：
 * - Offload：studentProfile 注入学情画像，辅助认知归因
 */

import { z } from 'zod'
import { BaseAgent } from '../base/Agent.js'
import type { AgentContext, AgentResult, Question, StudentProfile } from '../base/types.js'
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

export interface GradeInput {
    question: Question
    studentAnswer: string
    studentProfile?: StudentProfile
}

export interface GradeOutput {
    questionId: string
    correct: boolean
    partialScore?: number
    cognitiveAttribution: string
    feedback: string
    teacherHint?: string
    confidence: number
    needsHumanReview: boolean
    aiGenerated: true
}

// ─────────────────────────────────────────────────────────────
// zod 校验 schema
// ─────────────────────────────────────────────────────────────

export const gradeOutputSchema = z.object({
    questionId: z.string(),
    correct: z.boolean(),
    partialScore: z.number().min(0).max(1).optional(),
    cognitiveAttribution: z.string(),
    feedback: z.string(),
    teacherHint: z.string().optional(),
    confidence: z.number().min(0).max(1),
    needsHumanReview: z.boolean(),
    aiGenerated: z.literal(true),
})

// ─────────────────────────────────────────────────────────────
// GradeSubAgent
// ─────────────────────────────────────────────────────────────

export class GradeSubAgent extends BaseAgent {
    readonly id = 'brush.grade'
    readonly name = '智能批改子Agent'
    readonly domain = 'brush' as const
    readonly fn = 'grade' as const
    readonly bloomLevel = '评价' as const
    readonly promptVersion = 'v2.0.0'

    async invoke(input: GradeInput, ctx: AgentContext): Promise<AgentResult<GradeOutput>> {
        return super.invoke(input, ctx) as Promise<AgentResult<GradeOutput>>
    }

    protected buildSystemPrompt(ctx: AgentContext): string {
        const constraints = withConstraint([
            ...COMMON_OUTPUT_CONSTRAINTS,
            '客观题（选择/填空/配对）correct 为 true/false，不输出 partialScore',
            '主观题（简答/创作/应用）输出 partialScore（0-1），correct 为 partialScore>=0.8',
            'cognitiveAttribution 为认知归因，指出学生的认知层缺陷（如"将拟人误判为比喻"）',
            'feedback 面向学生，鼓励性语言，50-100 字',
            'teacherHint 面向教师，诊断性建议，30-80 字',
            'confidence < 0.8 时 needsHumanReview 必须为 true',
            '主观题或答案模糊时 confidence 应适当降低',
        ])

        const teacherIntent = ctx.teacherIntent
            ? withXmlTags(ctx.teacherIntent, 'teacher_intent')
            : ''

        const fewShot = getFewShotBlock(this.id)

        return `你是诗笔·智能批改专家，精通古诗词教学评价与认知归因分析。

## 你的职责
批改学生答题，不仅判定对错，更要：
1. 归因到具体认知层缺陷（记忆/理解/应用/分析/评价/创造哪一层出了问题）
2. 给学生鼓励性反馈（指出进步方向，而非简单批评）
3. 给教师诊断性提示（辅助教师针对性教学）

## 批改原则
- **客观题**：严格判定，对就是对，错就是错
- **主观题**：部分得分制，关注核心要点是否答出
- **认知归因**：不止于"答错了"，要指出"为什么答错"（如"混淆了修辞手法""未理解意象象征义"）
- **反馈语言**：面向小学生，用词温暖、具体、可操作

## 古诗词常见错误归因表
- 字音字形错误 → 记忆层缺陷
- 翻译偏差 → 理解层缺陷
- 不会迁移 → 应用层缺陷
- 手法混淆 → 分析层缺陷
- 无法评判 → 评价层缺陷
- 不会仿写 → 创造层缺陷

## 批改质量纪律
- cognitiveAttribution 必须具体到认知层与缺陷点，不可泛泛说"理解不到位"
- feedback 须含具体改进动作（如"我们再对比'拟人'与'比喻'的差别"），不可仅"加油"
- teacherHint 须给出可执行的教学建议（如"建议用《咏柳》《春晓》对比练习"），不可仅"需加强"
- 主观题 partialScore 须基于要点覆盖度，不可凭感觉打分
- 答案模糊或答非所问时 confidence 须低于 0.7 并标记 needsHumanReview: true

${constraints}

${fewShot}

${teacherIntent}`
    }

    protected buildUserPrompt(input: unknown, ctx: AgentContext): string {
        const typed = input as GradeInput

        const questionStr = JSON.stringify({
            id: typed.question.id,
            poemId: typed.question.poemId,
            bloomLevel: typed.question.bloomLevel,
            type: typed.question.type,
            stem: typed.question.stem,
            options: typed.question.options ?? [],
            answer: typed.question.answer,
            analysis: typed.question.analysis,
            difficulty: typed.question.difficulty,
        }, null, 2)

        const profileStr = typed.studentProfile ?? ctx.studentProfile
            ? JSON.stringify({
                name: (typed.studentProfile ?? ctx.studentProfile)?.name,
                grade: (typed.studentProfile ?? ctx.studentProfile)?.grade,
                cognitiveStyle: (typed.studentProfile ?? ctx.studentProfile)?.cognitiveStyle,
                strengths: (typed.studentProfile ?? ctx.studentProfile)?.strengths ?? [],
                weaknesses: (typed.studentProfile ?? ctx.studentProfile)?.weaknesses ?? [],
            }, null, 2)
            : '（学情画像未提供）'

        const contextBlock = buildContextBlock([
            standardEntry(STANDARD_CONTEXT_TAGS.TASK_INSTRUCTION, '批改学生答题并给出认知归因与反馈'),
            { tag: 'question', content: questionStr },
            { tag: 'student_answer', content: typed.studentAnswer },
            standardEntry(STANDARD_CONTEXT_TAGS.STUDENT_PROFILE, profileStr),
            standardEntry(STANDARD_CONTEXT_TAGS.OUTPUT_FORMAT, {
                fields: 'questionId, correct, partialScore?(主观题), cognitiveAttribution, feedback, teacherHint?, confidence, needsHumanReview, aiGenerated',
                note: 'confidence<0.8 时 needsHumanReview 必为 true；aiGenerated 必为 true',
            }),
        ])

        return `请批改以下学生答题。

${contextBlock}

请输出严格 JSON，包含字段：questionId, correct, partialScore(主观题), cognitiveAttribution, feedback, teacherHint, confidence, needsHumanReview, aiGenerated。`
    }

    protected validateOutput(raw: string): GradeOutput {
        const parsed = safeJsonParse(raw)
        const result = gradeOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(`智能批改输出校验失败: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        }
        return result.data
    }
}
