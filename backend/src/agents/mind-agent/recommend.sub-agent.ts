/**
 * 学习路径推荐子 Agent — mind.recommend
 *
 * 职责：基于诊断结果，推荐个性化学习路径（按知识图谱节点）。
 * 模型：deepseek-v4-flash（recommend 路由），thinking: medium
 * 认知层级：应用（布鲁姆第三阶）
 *
 * 推荐策略：
 * - 从最薄弱的认知层切入，先补漏再提升
 * - 路径步骤按知识图谱依赖关系排序（prerequisites 优先）
 * - 每步包含具体活动描述与时间估算
 * - 设置里程碑检查点，确保路径可验收
 *
 * Context Engineering 策略：
 * - Retrieve：knowledgeGraph 注入完整知识图谱
 * - Offload：diagnosis 注入诊断结果（避免重新诊断）
 */

import { z } from 'zod'
import { BaseAgent } from '../base/Agent.js'
import type { AgentContext, AgentResult, BloomLevel, DiagnosisResult, PoemNode } from '../base/types.js'
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

export interface RecommendInput {
    studentId: string
    diagnosis: DiagnosisResult
    knowledgeGraph: PoemNode[]
}

export interface RecommendPathStep {
    step: number
    poemId: string
    bloomLevel: BloomLevel
    activity: string
    estimatedMinutes: number
    rationale: string
}

export interface RecommendOutput {
    studentId: string
    path: RecommendPathStep[]
    totalEstimatedMinutes: number
    milestones: Array<{ afterStep: number; checkPoint: string }>
    aiGenerated: true
}

// ─────────────────────────────────────────────────────────────
// zod 校验 schema
// ─────────────────────────────────────────────────────────────

const bloomLevelSchema = z.enum(['记忆', '理解', '应用', '分析', '评价', '创造'])

const pathStepSchema = z.object({
    step: z.number().int().min(1),
    poemId: z.string(),
    bloomLevel: bloomLevelSchema,
    activity: z.string(),
    estimatedMinutes: z.number().int().min(1),
    rationale: z.string(),
})

const recommendOutputSchema = z.object({
    studentId: z.string(),
    path: z.array(pathStepSchema).min(1),
    totalEstimatedMinutes: z.number().int().min(1),
    milestones: z.array(z.object({
        afterStep: z.number().int().min(1),
        checkPoint: z.string(),
    })),
    aiGenerated: z.literal(true),
})

// ─────────────────────────────────────────────────────────────
// RecommendSubAgent
// ─────────────────────────────────────────────────────────────

export class RecommendSubAgent extends BaseAgent {
    readonly id = 'mind.recommend'
    readonly name = '学习路径推荐子Agent'
    readonly domain = 'mind' as const
    readonly fn = 'recommend' as const
    readonly bloomLevel = '应用' as const
    readonly promptVersion = 'v2.0.0'

    async invoke(input: RecommendInput, ctx: AgentContext): Promise<AgentResult<RecommendOutput>> {
        return super.invoke(input, ctx) as Promise<AgentResult<RecommendOutput>>
    }

    protected buildSystemPrompt(ctx: AgentContext): string {
        const constraints = withConstraint([
            ...COMMON_OUTPUT_CONSTRAINTS,
            'path 步骤数 3-8 步，每步 estimatedMinutes 为 5-30 的整数',
            'step 编号从 1 开始连续递增',
            'totalEstimatedMinutes 等于所有步骤 estimatedMinutes 之和',
            'rationale 必须说明为何选择该诗词该认知层，关联诊断结果',
            'milestones 至少 1 个，afterStep 指向某一步之后进行验收',
            '路径设计遵循"先补漏后提升"原则，从最薄弱认知层切入',
        ])

        const teacherIntent = ctx.teacherIntent
            ? withXmlTags(ctx.teacherIntent, 'teacher_intent')
            : ''

        const fewShot = getFewShotBlock(this.id)

        return `你是诗心·学习路径推荐专家，精通知识图谱驱动的个性化学习路径规划。

## 你的职责
基于认知诊断结果与知识图谱，为学生推荐一条个性化学习路径。路径需：
1. 从最薄弱的认知层切入，先补漏再提升
2. 遵循知识图谱依赖关系（prerequisites 优先）
3. 每步包含具体可执行的学习活动
4. 设置里程碑检查点，确保路径可验收

## 路径设计原则
- 螺旋上升：同一首诗可在不同步骤覆盖不同认知层
- 难度递进：从低认知层（记忆/理解）逐步过渡到高认知层（分析/评价/创造）
- 时间可控：单次学习 15-25 分钟为宜，总时长 60-120 分钟
- 活动多样：背诵、翻译、赏析、仿写、对比、创作等多种形式

## 古诗词学习活动参考
- 记忆层：朗读背诵、填空默写、配对连线
- 理解层：翻译诗意、解释字词、概括主旨
- 应用层：迁移运用、仿写改写、情境应用
- 分析层：赏析手法、比较异同、梳理结构
- 评价层：评判优劣、表达偏好、赏析意境
- 创造层：原创创作、改编表演、跨媒介表达

## rationale 撰写要求
- 必须关联诊断结果中的 darkMatter 或 knowledgeGaps
- 必须说明为何选择该诗词（如"针对诊断出的修辞混淆，用同一首诗聚焦区分"）
- 不可为空话（如"为了提升能力"）

${constraints}

${fewShot}

${teacherIntent}`
    }

    protected buildUserPrompt(input: unknown, ctx: AgentContext): string {
        const typed = input as RecommendInput

        // 诊断结果摘要
        const diagnosisSummary = JSON.stringify({
            scope: typed.diagnosis.scope,
            darkMatter: typed.diagnosis.darkMatter.map((d) => ({
                poemId: d.poemId,
                bloomLevel: d.bloomLevel,
                severity: d.severity,
                pattern: d.pattern,
            })),
            knowledgeGaps: typed.diagnosis.knowledgeGaps,
            bloomImbalance: typed.diagnosis.bloomImbalance,
        }, null, 2)

        // 知识图谱
        const graphSummary = typed.knowledgeGraph.length > 0
            ? typed.knowledgeGraph.map((p) => {
                const parts = [`${p.id}: ${p.title}（${p.dynasty}·${p.poet}）`]
                if (p.difficulty !== undefined) parts.push(`难度${p.difficulty}`)
                if (p.prerequisites && p.prerequisites.length > 0) parts.push(`前置: ${p.prerequisites.join(',')}`)
                if (p.teachingPoints && p.teachingPoints.length > 0) parts.push(`要点: ${p.teachingPoints.join('/')}`)
                return parts.join(' | ')
            }).join('\n')
            : '（知识图谱为空）'

        // 学生画像（如有）
        const profile = ctx.studentProfile
            ? JSON.stringify({
                name: ctx.studentProfile.name,
                grade: ctx.studentProfile.grade,
                cognitiveStyle: ctx.studentProfile.cognitiveStyle,
                recommendedPace: ctx.studentProfile.recommendedPace,
            }, null, 2)
            : ''

        // 使用标准化上下文标签
        const contextBlock = buildContextBlock([
            standardEntry(STANDARD_CONTEXT_TAGS.STUDENT_PROFILE, typed.studentId),
            standardEntry(STANDARD_CONTEXT_TAGS.DIAGNOSIS_RESULT, diagnosisSummary),
            standardEntry(STANDARD_CONTEXT_TAGS.KNOWLEDGE_GRAPH, graphSummary),
            { tag: 'student_profile_detail', content: profile },
            standardEntry(STANDARD_CONTEXT_TAGS.TASK_INSTRUCTION, '推荐个性化学习路径'),
            standardEntry(STANDARD_CONTEXT_TAGS.OUTPUT_FORMAT, {
                fields: 'studentId, path, totalEstimatedMinutes, milestones, aiGenerated',
                note: 'path 3-8 步；step 从 1 连续；rationale 关联诊断',
            }),
        ])

        return `请基于以下诊断结果与知识图谱，推荐个性化学习路径。

${contextBlock}

请输出严格 JSON，包含字段：studentId, path, totalEstimatedMinutes, milestones, aiGenerated。`
    }

    protected validateOutput(raw: string): RecommendOutput {
        const parsed = safeJsonParse(raw)
        const result = recommendOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(`学习路径推荐输出校验失败: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        }
        return result.data
    }
}
