/**
 * 学情画像子 Agent — mind.profile
 *
 * 职责：根据学生历史答题、自学行为、朗读数据，生成六维学情画像。
 * 模型：mimo-v2.5-pro（profile 路由），thinking: medium
 * 认知层级：分析（布鲁姆第四阶）
 *
 * Context Engineering 策略：
 * - Offload：已有学情画像通过 ctx.studentProfile 注入（增量更新）
 * - Reduce：仅注入最近 N 条学习事件，避免上下文膨胀
 *
 * 输出经 zod 严格校验，确保六阶掌握度、认知风格等字段完整。
 */

import { z } from 'zod'
import { BaseAgent } from '../base/Agent.js'
import type { AgentContext, AgentResult, BloomMastery, CognitiveStyle, LearningEvent, LearningPace } from '../base/types.js'
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

export interface ProfileInput {
    studentId: string
    recentEvents: LearningEvent[]
    classRank?: number
}

export interface ProfileOutput {
    studentId: string
    strengths: string[]
    weaknesses: string[]
    bloomMastery: BloomMastery
    cognitiveStyle: CognitiveStyle
    engagementScore: number
    recommendedPace: LearningPace
    aiGenerated: true
    confidence: number
}

// ─────────────────────────────────────────────────────────────
// zod 校验 schema
// ─────────────────────────────────────────────────────────────

const bloomMasterySchema = z.object({
    记忆: z.number().min(0).max(100),
    理解: z.number().min(0).max(100),
    应用: z.number().min(0).max(100),
    分析: z.number().min(0).max(100),
    评价: z.number().min(0).max(100),
    创造: z.number().min(0).max(100),
})

const profileOutputSchema = z.object({
    studentId: z.string(),
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
    bloomMastery: bloomMasterySchema,
    cognitiveStyle: z.enum(['visual', 'auditory', 'kinesthetic', 'mixed']),
    engagementScore: z.number().min(0).max(100),
    recommendedPace: z.enum(['slow', 'medium', 'fast']),
    aiGenerated: z.literal(true),
    confidence: z.number().min(0).max(1),
})

// ─────────────────────────────────────────────────────────────
// ProfileSubAgent
// ─────────────────────────────────────────────────────────────

export class ProfileSubAgent extends BaseAgent {
    readonly id = 'mind.profile'
    readonly name = '学情画像子Agent'
    readonly domain = 'mind' as const
    readonly fn = 'profile' as const
    readonly bloomLevel = '分析' as const
    readonly promptVersion = 'v2.0.0'

    async invoke(input: ProfileInput, ctx: AgentContext): Promise<AgentResult<ProfileOutput>> {
        return super.invoke(input, ctx) as Promise<AgentResult<ProfileOutput>>
    }

    protected buildSystemPrompt(ctx: AgentContext): string {
        const constraints = withConstraint([
            ...COMMON_OUTPUT_CONSTRAINTS,
            'bloomMastery 六个字段值均为 0-100 的整数',
            'confidence 为 0-1 的小数，表示画像可信度',
            'strengths 和 weaknesses 各 2-4 条，每条不超过 20 字',
            '若学习事件不足 5 条，confidence 应低于 0.6',
        ])

        const teacherIntent = ctx.teacherIntent
            ? withXmlTags(ctx.teacherIntent, 'teacher_intent')
            : ''

        const fewShot = getFewShotBlock(this.id)

        return `你是诗心·学情画像分析师，专精布鲁姆认知分类法与中国小学语文古诗词教学。

## 你的职责
基于学生历史学习事件（答题、朗读、自学行为），生成结构化学情画像。画像需覆盖布鲁姆认知六阶，并给出认知风格、参与度与学习节奏建议。

## 中国小学生认知发展规律（知识库）
- 1-2 年级（6-8 岁）：以具体形象思维为主，记忆层最强，理解层逐步发展，古诗词学习侧重背诵识记
- 3-4 年级（8-10 岁）：向抽象思维过渡，应用与分析层开始活跃，古诗词学习侧重理解感悟
- 5-6 年级（10-12 岁）：抽象思维显著发展，评价与创造层逐步显现，古诗词学习侧重鉴赏创造
- 认知风格判断依据：答题偏好（图文题 vs 纯文字题）、朗读表现（节奏感 vs 情感表达）、学习时长分布

## 古诗词教学常见认知误区（用于识别 weaknesses）
- 将"拟人"误判为"比喻"（修辞手法混淆）
- 背诵流利但无法解释诗意（记忆与理解脱节）
- 能翻译字面义但无法体会意境（理解到分析断层）
- 能分析手法但无法迁移到新诗（分析到应用断裂）

## 六阶掌握度评估基准
- 90-100：精通，可指导他人
- 75-89：熟练，可独立完成
- 60-74：基本掌握，需少量提示
- 40-59：薄弱，需针对性辅导
- 0-39：未掌握，需系统补课

${constraints}

${fewShot}

${teacherIntent}`
    }

    protected buildUserPrompt(input: unknown, ctx: AgentContext): string {
        const typed = input as ProfileInput

        // 学习事件摘要
        const eventsSummary = typed.recentEvents.length > 0
            ? typed.recentEvents.map((e, i) => {
                const parts = [`事件${i + 1}: ${e.type}`]
                if (e.poemId) parts.push(`诗词: ${e.poemId}`)
                if (e.bloomLevel) parts.push(`认知层: ${e.bloomLevel}`)
                if (e.correct !== undefined) parts.push(`正确: ${e.correct ? '是' : '否'}`)
                if (e.score !== undefined) parts.push(`得分: ${e.score}`)
                if (e.durationSec !== undefined) parts.push(`时长: ${e.durationSec}秒`)
                if (e.detail) parts.push(`详情: ${e.detail}`)
                return parts.join(' | ')
            }).join('\n')
            : '（暂无学习事件记录）'

        // 已有画像（增量更新场景）
        const existingProfile = ctx.studentProfile
            ? JSON.stringify({
                name: ctx.studentProfile.name,
                grade: ctx.studentProfile.grade,
                previousStrengths: ctx.studentProfile.strengths ?? [],
                previousWeaknesses: ctx.studentProfile.weaknesses ?? [],
                classRank: ctx.studentProfile.classRank,
            }, null, 2)
            : ''

        // 使用标准化上下文标签
        const contextBlock = buildContextBlock([
            standardEntry(STANDARD_CONTEXT_TAGS.STUDENT_PROFILE, {
                studentId: typed.studentId,
                classRank: typed.classRank,
            }),
            standardEntry(STANDARD_CONTEXT_TAGS.TASK_INSTRUCTION, '生成结构化学情画像'),
            { tag: 'student_history', content: eventsSummary },
            { tag: 'existing_profile', content: existingProfile },
            standardEntry(STANDARD_CONTEXT_TAGS.OUTPUT_FORMAT, {
                fields: 'studentId, strengths, weaknesses, bloomMastery, cognitiveStyle, engagementScore, recommendedPace, aiGenerated, confidence',
                note: 'bloomMastery 六字段 0-100 整数；confidence 0-1 小数',
            }),
        ])

        return `请基于以下学生数据，生成结构化学情画像。

${contextBlock}

请输出严格 JSON，包含字段：studentId, strengths, weaknesses, bloomMastery, cognitiveStyle, engagementScore, recommendedPace, aiGenerated, confidence。`
    }

    protected validateOutput(raw: string): ProfileOutput {
        const parsed = safeJsonParse(raw)
        const result = profileOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(`学情画像输出校验失败: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        }
        return result.data
    }
}
