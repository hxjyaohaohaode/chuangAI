/**
 * 验收子 Agent — mind.verify
 *
 * 职责：独立审核其他 Agent 的产出（"自己不能判自己的卷子"）。
 * 模型：deepseek-v4-pro（verify 路由），thinking: high（深度审核）
 * 认知层级：评价（布鲁姆第五阶）
 *
 * Loop Engineering 核心组件：
 * Generator（生成 Agent）→ Verifier（本 Agent）→ Curator（编排官）
 * 每个生成 Agent 的产出必须经本 Agent 独立验收，verdict 为：
 * - pass：通过，直接使用
 * - revise：需修订，提供 revisedOutput 修正建议
 * - reject：拒绝，需重新生成
 *
 * 审核六维度：准确性 / 完整性 / 一致性 / 教育适宜性 / 文化敏感性 / AI 安全合规
 *
 * 本 Agent 可独立调用，审核任意其他 Agent 的产出，是系统质量护栏。
 */

import { z } from 'zod'
import { BaseAgent } from '../base/Agent.js'
import { agentEvents, AGENT_EVENTS } from '../base/events.js'
import type { AgentContext, AgentResult, VerifyIssue, VerifyVerdict } from '../base/types.js'
import { VERIFY_DIMENSIONS } from '../base/types.js'
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

export interface VerifyInput {
    targetAgentId: string
    targetOutput: unknown
    originalInput: unknown
    criteria: string[]
}

export interface VerifyOutput {
    targetAgentId: string
    verdict: VerifyVerdict
    score: number
    strengths: string[]
    issues: VerifyIssue[]
    revisedOutput?: unknown
    aiGenerated: true
    confidence: number
}

// ─────────────────────────────────────────────────────────────
// zod 校验 schema
// ─────────────────────────────────────────────────────────────

const issueSchema = z.object({
    severity: z.enum(['low', 'medium', 'high']),
    description: z.string(),
    suggestion: z.string(),
})

const verifyOutputSchema = z.object({
    targetAgentId: z.string(),
    verdict: z.enum(['pass', 'revise', 'reject']),
    score: z.number().min(0).max(100),
    strengths: z.array(z.string()),
    issues: z.array(issueSchema),
    revisedOutput: z.unknown().optional(),
    aiGenerated: z.literal(true),
    confidence: z.number().min(0).max(1),
})

// ─────────────────────────────────────────────────────────────
// VerifySubAgent
// ─────────────────────────────────────────────────────────────

export class VerifySubAgent extends BaseAgent {
    readonly id = 'mind.verify'
    readonly name = '验收子Agent'
    readonly domain = 'mind' as const
    readonly fn = 'verify' as const
    readonly bloomLevel = '评价' as const
    readonly promptVersion = 'v2.0.0'

    async invoke(input: VerifyInput, ctx: AgentContext): Promise<AgentResult<VerifyOutput>> {
        const result = (await super.invoke(input, ctx)) as AgentResult<VerifyOutput>

        // 发射验收事件，供编排官（Curator）订阅决策
        agentEvents.emit(AGENT_EVENTS.VERIFY, {
            targetAgentId: input.targetAgentId,
            taskId: ctx.taskId,
            sessionId: ctx.sessionId,
            verdict: result.output.verdict,
            score: result.output.score,
            timestamp: Date.now(),
        })

        return result
    }

    protected buildSystemPrompt(ctx: AgentContext): string {
        const dimensions = VERIFY_DIMENSIONS.join(' / ')
        const constraints = withConstraint([
            ...COMMON_OUTPUT_CONSTRAINTS,
            `审核六维度：${dimensions}`,
            'verdict 为 pass/revise/reject：pass=可直接使用，revise=需修订（提供 revisedOutput），reject=拒绝重新生成',
            'score 为 0-100 整数，>=80 可 pass，60-79 revise，<60 reject',
            'issues 每条含 severity（low/medium/high）、description、suggestion',
            '若 verdict 为 revise，必须提供 revisedOutput 修正建议',
            'confidence 为 0-1 的小数，审核依据不足时低于 0.6',
            '审核必须客观独立，不因 targetOutput 的表面质量而放松标准',
            'high severity 问题必须导致 verdict 不为 pass',
        ])

        const teacherIntent = ctx.teacherIntent
            ? withXmlTags(ctx.teacherIntent, 'teacher_intent')
            : ''

        const fewShot = getFewShotBlock(this.id)

        return `你是诗心·独立验收官，遵循"生成-验收分离"原则。你的唯一职责是审核其他 Agent 的产出，确保质量达标。

## 你的角色定位
你是质量护栏，不是生成者。你不替代生成 Agent 重新生成内容，而是：
- 客观评价产出的质量
- 指出具体问题与改进方向
- 必要时提供修正建议（revisedOutput）
- 给出明确的通过/修订/拒绝裁决

## 审核六维度
1. **准确性**：事实性内容（典故、字义、时代背景）是否正确无误
2. **完整性**：输出是否覆盖了输入要求的所有字段与内容
3. **一致性**：内部逻辑是否自洽，与输入数据是否矛盾
4. **教育适宜性**：内容是否适合目标学段，符合教学规律
5. **文化敏感性**：是否尊重传统文化，无文化偏见或不当表述
6. **AI 安全合规**：无有害内容，无幻觉，aiGenerated 标记正确

## 裁决标准
- pass（score>=80）：六维度均达标，可直接使用
- revise（score 60-79）：存在中低级问题，但核心内容可用，提供修正建议
- reject（score<60）：存在高级问题或事实错误，需重新生成

## 验收纪律
- 存在 high severity 问题时，verdict 不得为 pass（即使其他维度优秀）
- revisedOutput 必须是完整可用的修正后输出，不可仅是片段
- issues 的 description 必须具体（指出哪条数据/哪个字段有问题），不可泛泛
- issues 的 suggestion 必须可执行（给出具体修正动作）

${constraints}

${fewShot}

${teacherIntent}`
    }

    protected buildUserPrompt(input: unknown, _ctx: AgentContext): string {
        const typed = input as VerifyInput

        const targetOutputStr = typeof typed.targetOutput === 'string'
            ? typed.targetOutput
            : JSON.stringify(typed.targetOutput, null, 2)

        const originalInputStr = typeof typed.originalInput === 'string'
            ? typed.originalInput
            : JSON.stringify(typed.originalInput, null, 2)

        const criteriaStr = typed.criteria.length > 0
            ? typed.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
            : '（未指定额外审核标准，按六维度通用标准审核）'

        // 使用标准化上下文标签
        const contextBlock = buildContextBlock([
            { tag: 'target_agent', content: typed.targetAgentId },
            standardEntry(STANDARD_CONTEXT_TAGS.TASK_INSTRUCTION, '独立验收 Agent 产出'),
            { tag: 'original_input', content: originalInputStr },
            { tag: 'target_output', content: targetOutputStr },
            { tag: 'extra_criteria', content: criteriaStr },
            standardEntry(STANDARD_CONTEXT_TAGS.OUTPUT_FORMAT, {
                fields: 'targetAgentId, verdict, score, strengths, issues, revisedOutput(可选), aiGenerated, confidence',
                note: 'verdict pass/revise/reject；high severity 问题不可 pass',
            }),
        ])

        return `请审核以下 Agent 的产出。

${contextBlock}

请输出严格 JSON，包含字段：targetAgentId, verdict, score, strengths, issues, revisedOutput(可选), aiGenerated, confidence。`
    }

    protected validateOutput(raw: string): VerifyOutput {
        const parsed = safeJsonParse(raw)
        const result = verifyOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(`验收输出校验失败: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        }
        return result.data
    }
}
