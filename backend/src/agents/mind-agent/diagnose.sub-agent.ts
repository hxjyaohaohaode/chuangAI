/**
 * 认知诊断子 Agent — mind.diagnose
 *
 * 职责：识别班级/学生认知暗物质（共性薄弱点）+ 个体知识漏洞。
 * 模型：deepseek-v4-pro（diagnose 路由），thinking: max（深度推理）
 * 认知层级：评价（布鲁姆第五阶）
 *
 * "认知暗物质"概念：那些藏在错题背后、学生共性卡顿的隐性知识漏洞。
 * 本 Agent 不止于"做错了什么"，更深入分析"为什么做错"（根因）和
 * "怎么补救"（靶向处方）。
 *
 * Context Engineering 策略：
 * - Retrieve：通过 poemNodes 注入相关诗词知识图谱节点
 * - Reduce：masteryData 聚合为矩阵，避免逐条事件注入
 */

import { z } from 'zod'
import { BaseAgent } from '../base/Agent.js'
import type { AgentContext, AgentResult, BloomLevel, BloomMastery, DiagnosisResult, PoemNode } from '../base/types.js'
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

export interface DiagnoseInput {
    scope: 'class' | 'student'
    targetId: string
    masteryData: BloomMastery[]
    poemNodes?: PoemNode[]
}

// ─────────────────────────────────────────────────────────────
// zod 校验 schema
// ─────────────────────────────────────────────────────────────

const bloomLevelSchema = z.enum(['记忆', '理解', '应用', '分析', '评价', '创造'])

const darkMatterSchema = z.object({
    poemId: z.string(),
    bloomLevel: bloomLevelSchema,
    pattern: z.string(),
    severity: z.enum(['low', 'medium', 'high']),
    rootCause: z.string(),
    prescription: z.string(),
})

const diagnosisOutputSchema = z.object({
    scope: z.enum(['class', 'student']),
    targetId: z.string(),
    darkMatter: z.array(darkMatterSchema),
    knowledgeGaps: z.array(z.object({
        poemId: z.string(),
        gap: z.string(),
        priority: z.number(),
    })),
    bloomImbalance: z.object({
        dominant: z.string(),
        weakest: z.string(),
        suggestion: z.string(),
    }),
    aiGenerated: z.literal(true),
    confidence: z.number().min(0).max(1),
})

// ─────────────────────────────────────────────────────────────
// DiagnoseSubAgent
// ─────────────────────────────────────────────────────────────

export class DiagnoseSubAgent extends BaseAgent {
    readonly id = 'mind.diagnose'
    readonly name = '认知诊断子Agent'
    readonly domain = 'mind' as const
    readonly fn = 'diagnose' as const
    readonly bloomLevel = '评价' as const
    readonly promptVersion = 'v2.0.0'

    async invoke(input: DiagnoseInput, ctx: AgentContext): Promise<AgentResult<DiagnosisResult>> {
        return super.invoke(input, ctx) as Promise<AgentResult<DiagnosisResult>>
    }

    protected buildSystemPrompt(ctx: AgentContext): string {
        const constraints = withConstraint([
            ...COMMON_OUTPUT_CONSTRAINTS,
            'darkMatter 数组每条必须包含 pattern（错误模式）、rootCause（根因）、prescription（处方）三要素',
            'severity 分为 low/medium/high，high 表示影响后续学习的核心漏洞',
            'knowledgeGaps 的 priority 为 1-5，5 为最紧急',
            'bloomImbalance.dominant 和 weakest 为布鲁姆六阶之一',
            'confidence 为 0-1 的小数，数据不足时低于 0.5',
        ])

        const teacherIntent = ctx.teacherIntent
            ? withXmlTags(ctx.teacherIntent, 'teacher_intent')
            : ''

        const fewShot = getFewShotBlock(this.id)

        return `你是诗心·认知诊断专家，擅长识别"认知暗物质"——那些藏在错题背后、学生共性卡顿的隐性知识漏洞。

## 你的职责
基于六阶掌握度矩阵与知识图谱，诊断出：
1. 认知暗物质（darkMatter）：反复出现的错误模式 + 根因分析 + 靶向处方
2. 知识漏洞（knowledgeGaps）：具体诗词的具体知识点缺失
3. 布鲁姆失衡（bloomImbalance）：六阶掌握度的结构性倾斜

## 古诗词教学常见认知误区（知识库）
- 修辞手法混淆：拟人↔比喻、夸张↔想象、借代↔象征
- 意象理解偏差：将"明月"仅理解为自然景物，忽略思乡寓意
- 情感把握错位：将"豪放"误读为"狂妄"，将"婉约"误读为"软弱"
- 结构分析碎片化：能赏析名句但无法把握全诗脉络
- 创造性缺失：背诵熟练但无法仿写或改写

## 诊断方法论
- 先识别 pattern（表层错误模式）
- 再挖掘 rootCause（深层认知缺陷）
- 最后开 prescription（靶向教学干预）
- 处方必须可执行，如"用对比法区分拟人与比喻，结合《咏柳》和《春晓》实例"

## 诊断深度要求
- pattern 必须具体（如"反复将"床"误解为睡床"），不可泛泛而谈
- rootCause 必须触及认知层（如"字义古今演变认知缺失"），不可止于表象
- prescription 必须可执行（含具体教学动作 + 载体诗词），不可为空话

${constraints}

${fewShot}

${teacherIntent}`
    }

    protected buildUserPrompt(input: unknown, _ctx: AgentContext): string {
        const typed = input as DiagnoseInput

        // 掌握度矩阵
        const masteryMatrix = typed.masteryData.length > 0
            ? typed.masteryData.map((m, i) => {
                const vals: Array<[BloomLevel, number]> = [
                    ['记忆', m.记忆], ['理解', m.理解], ['应用', m.应用],
                    ['分析', m.分析], ['评价', m.评价], ['创造', m.创造],
                ]
                return `样本${i + 1}: ${vals.map(([k, v]) => `${k}=${v}`).join(', ')}`
            }).join('\n')
            : '（暂无掌握度数据）'

        // 知识图谱节点
        const poemNodes = typed.poemNodes && typed.poemNodes.length > 0
            ? typed.poemNodes.map((p) => {
                const parts = [`${p.title}（${p.dynasty}·${p.poet}）`]
                if (p.theme.length > 0) parts.push(`主题: ${p.theme.join('/')}`)
                if (p.images.length > 0) parts.push(`意象: ${p.images.join('/')}`)
                if (p.teachingPoints && p.teachingPoints.length > 0) parts.push(`教学要点: ${p.teachingPoints.join('/')}`)
                return parts.join(' | ')
            }).join('\n')
            : ''

        // 使用标准化上下文标签
        const contextBlock = buildContextBlock([
            standardEntry(STANDARD_CONTEXT_TAGS.CLASS_CONTEXT, {
                scope: typed.scope,
                targetId: typed.targetId,
            }),
            standardEntry(STANDARD_CONTEXT_TAGS.TASK_INSTRUCTION, '执行认知诊断，识别认知暗物质'),
            { tag: 'mastery_matrix', content: masteryMatrix },
            standardEntry(STANDARD_CONTEXT_TAGS.KNOWLEDGE_GRAPH, poemNodes),
            standardEntry(STANDARD_CONTEXT_TAGS.OUTPUT_FORMAT, {
                fields: 'scope, targetId, darkMatter, knowledgeGaps, bloomImbalance, aiGenerated, confidence',
                note: 'darkMatter 每条含 pattern/rootCause/prescription；severity low/medium/high',
            }),
        ])

        return `请基于以下数据，执行认知诊断。

${contextBlock}

请输出严格 JSON，包含字段：scope, targetId, darkMatter, knowledgeGaps, bloomImbalance, aiGenerated, confidence。`
    }

    protected validateOutput(raw: string): DiagnosisResult {
        const parsed = safeJsonParse(raw)
        const result = diagnosisOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(`认知诊断输出校验失败: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        }
        return result.data
    }
}
