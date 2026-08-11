/**
 * 教研报告子 Agent — brush.report
 *
 * 职责：汇总学情数据与诊断结论，生成结构化教研报告。
 * 模型：deepseek-v4-pro（report 路由），thinking: high（深度综合分析）
 * 认知层级：创造（布鲁姆第六阶）
 *
 * 报告四段式结构（强制）：
 *   1. 教学背景 — 班级学情概况与教学起点
 *   2. 干预策略 — 基于认知暗物质的靶向教学方案
 *   3. 数据实证 — 六阶掌握度变化与事件流佐证
 *   4. 反思展望 — 教学反思与下一阶段规划
 *
 * 合规要求：
 * - 数据自动脱敏：学生姓名替换为编号（S01、S02...）
 * - AI 生成水印：标题末尾附带「AI 生成」标记
 * - 事实严谨：所有数据结论必须可回溯至输入数据
 *
 * Context Engineering 策略：
 * - Offload：diagnosisResults / masteryData 注入外部诊断与画像
 * - Reduce：timeRange 裁剪事件流至报告区间
 */

import { z } from 'zod'
import { BaseAgent } from '../base/Agent.js'
import type {
    AgentContext,
    AgentResult,
    BloomMastery,
    ClassContext,
    DiagnosisResult,
    LearningEvent,
} from '../base/types.js'
import {
    buildContextBlock,
    COMMON_OUTPUT_CONSTRAINTS,
    STANDARD_CONTEXT_TAGS,
    getFewShotBlock,
    safeJsonParse,
    standardEntry,
    withAiGeneratedMark,
    withConstraint,
    withXmlTags,
} from '../base/prompts.js'

// ─────────────────────────────────────────────────────────────
// 输入 / 输出类型
// ─────────────────────────────────────────────────────────────

export interface ReportInput {
    /** 报告范围：班级或个体 */
    scope: 'class' | 'student'
    /** 目标 ID（班级 ID 或学生 ID） */
    targetId: string
    /** 报告时间区间（ms 时间戳） */
    timeRange: { start: number; end: number }
    /** 班级上下文 */
    classContext?: ClassContext
    /** 认知诊断结果（来自 mind.diagnose） */
    diagnosisResults?: DiagnosisResult[]
    /** 掌握度数据：均值与趋势 */
    masteryData?: {
        average: BloomMastery
        trend: Array<{ date: number; mastery: BloomMastery }>
    }
    /** 学习事件流（已按 timeRange 裁剪） */
    events?: LearningEvent[]
}

/** 报告章节 */
export interface ReportSection {
    /** 章节标题 */
    heading: string
    /** 章节正文（Markdown） */
    content: string
}

export interface ReportOutput {
    /** 报告标题（含「AI 生成」标记） */
    title: string
    /** 四段式章节（教学背景/干预策略/数据实证/反思展望） */
    sections: ReportSection[]
    /** 核心发现（3-5 条要点） */
    keyFindings: string[]
    /** 教学建议（可操作的行动项） */
    recommendations: string[]
    /** 数据已脱敏标记 */
    dataAnonymized: true
    /** AI 生成标记 */
    aiGenerated: true
}

// ─────────────────────────────────────────────────────────────
// zod 校验 schema
// ─────────────────────────────────────────────────────────────

const reportSectionSchema = z.object({
    heading: z.string(),
    content: z.string(),
})

const reportOutputSchema = z.object({
    title: z.string(),
    sections: z.array(reportSectionSchema),
    keyFindings: z.array(z.string()),
    recommendations: z.array(z.string()),
    dataAnonymized: z.literal(true),
    aiGenerated: z.literal(true),
})

// ─────────────────────────────────────────────────────────────
// ReportSubAgent
// ─────────────────────────────────────────────────────────────

export class ReportSubAgent extends BaseAgent {
    readonly id = 'brush.report'
    readonly name = '教研报告子Agent'
    readonly domain = 'brush' as const
    readonly fn = 'report' as const
    readonly bloomLevel = '创造' as const
    readonly promptVersion = 'v2.0.0'

    async invoke(input: ReportInput, ctx: AgentContext): Promise<AgentResult<ReportOutput>> {
        return super.invoke(input, ctx) as Promise<AgentResult<ReportOutput>>
    }

    protected buildSystemPrompt(ctx: AgentContext): string {
        const constraints = withConstraint([
            ...COMMON_OUTPUT_CONSTRAINTS,
            'sections 必须包含且仅包含 4 个章节，heading 依次为：教学背景、干预策略、数据实证、反思展望',
            '每个章节 content 为 Markdown 格式正文，300-600 字',
            'keyFindings 为 3-5 条核心发现，每条一句话，基于输入数据',
            'recommendations 为 3-5 条可操作教学建议，每条含具体行动步骤',
            'title 必须以「（AI 生成）」结尾',
            '所有学生姓名必须替换为编号（S01、S02...），dataAnonymized 必须为 true',
            '数据实证章节必须引用 masteryData 与 events 中的具体数值',
            '干预策略章节必须基于 diagnosisResults 中的认知暗物质条目',
            '不得编造未在输入中出现的数据',
        ])

        const teacherIntent = ctx.teacherIntent
            ? withXmlTags(ctx.teacherIntent, 'teacher_intent')
            : ''

        const fewShot = getFewShotBlock(this.id)

        return `你是诗笔·教研报告专家，精通古诗词教学研究与数据驱动的教学分析。

## 你的职责
基于学情数据与认知诊断结论，撰写专业教研报告。报告必须：
1. 数据驱动：所有结论可回溯至输入数据，不得编造
2. 结构严谨：四段式（教学背景/干预策略/数据实证/反思展望）
3. 面向实践：建议可操作，反思有深度
4. 合规脱敏：学生信息匿名化处理

## 报告四段式结构要求

### 一、教学背景
- 班级/学生学情概况
- 本阶段教学目标与内容
- 教学起点（六阶掌握度基线）

### 二、干预策略
- 基于「认知暗物质」的靶向教学方案
- 针对共性薄弱点的全班干预
- 针对个体差异的分层干预
- 具体教学活动设计建议

### 三、数据实证
- 六阶掌握度变化趋势（引用 masteryData.trend）
- 学习行为分析（引用 events 统计）
- 干预效果对比（前后数据）
- 典型案例（匿名化）

### 四、反思展望
- 教学策略有效性反思
- 待改进环节
- 下一阶段教学规划
- 风险预警与应对

## 数据脱敏规范
- 学生姓名 → S01、S02...（按出现顺序编号）
- 班级名称 → C1、C2...
- 保留诗词 ID、认知层级、掌握度数值等非个人化数据

## 报告质量纪律
- 数据实证章节须引用具体数值（如"理解层掌握度由 52 提升至 68（+16）"），不可仅定性描述
- 干预策略须与 diagnosisResults 中的 darkMatter 条目一一对应，不可空泛
- keyFindings 须基于数据实证章节的发现，不可凭空总结
- recommendations 须含可执行动作（如"设计'我为古诗配画'活动"），不可仅"加强教学"
- 反思展望须指出本轮干预的不足（如"创造层提升有限"），不可只报喜

${constraints}

${fewShot}

${teacherIntent}`
    }

    protected buildUserPrompt(input: unknown, ctx: AgentContext): string {
        const typed = input as ReportInput

        // 班级上下文
        const classCtxStr = typed.classContext ?? ctx.classContext
            ? JSON.stringify({
                id: (typed.classContext ?? ctx.classContext)?.id,
                name: (typed.classContext ?? ctx.classContext)?.name,
                grade: (typed.classContext ?? ctx.classContext)?.grade,
                studentCount: (typed.classContext ?? ctx.classContext)?.studentCount,
                averageMastery: (typed.classContext ?? ctx.classContext)?.averageMastery,
                engagementScore: (typed.classContext ?? ctx.classContext)?.engagementScore,
            }, null, 2)
            : '（班级上下文未提供）'

        // 诊断结果
        const diagnosisStr = typed.diagnosisResults && typed.diagnosisResults.length > 0
            ? JSON.stringify(typed.diagnosisResults.map((d) => ({
                scope: d.scope,
                targetId: d.targetId,
                darkMatter: d.darkMatter,
                knowledgeGaps: d.knowledgeGaps,
                bloomImbalance: d.bloomImbalance,
                confidence: d.confidence,
            })), null, 2)
            : '（诊断结果未提供）'

        // 掌握度数据
        const masteryStr = typed.masteryData
            ? JSON.stringify({
                average: typed.masteryData.average,
                trendPoints: typed.masteryData.trend.length,
                trendSample: typed.masteryData.trend.slice(-3),
            }, null, 2)
            : '（掌握度数据未提供）'

        // 事件流统计（避免注入过多原始数据）
        const eventsStr = typed.events && typed.events.length > 0
            ? JSON.stringify({
                totalEvents: typed.events.length,
                byType: this.countByType(typed.events),
                byBloom: this.countByBloom(typed.events),
                averageScore: this.calcAverageScore(typed.events),
                timeSpan: {
                    start: new Date(typed.timeRange.start).toISOString(),
                    end: new Date(typed.timeRange.end).toISOString(),
                },
            }, null, 2)
            : '（事件流未提供）'

        const contextBlock = buildContextBlock([
            standardEntry(STANDARD_CONTEXT_TAGS.TASK_INSTRUCTION, `${typed.scope === 'class' ? '班级' : '学生'}教研报告，目标 ${typed.targetId}`),
            { tag: 'report_scope', content: `${typed.scope}（目标 ID: ${typed.targetId}）` },
            { tag: 'time_range', content: `${new Date(typed.timeRange.start).toISOString()} 至 ${new Date(typed.timeRange.end).toISOString()}` },
            standardEntry(STANDARD_CONTEXT_TAGS.CLASS_CONTEXT, classCtxStr),
            standardEntry(STANDARD_CONTEXT_TAGS.DIAGNOSIS_RESULT, diagnosisStr),
            { tag: 'mastery_data', content: masteryStr },
            { tag: 'events_summary', content: eventsStr },
            standardEntry(STANDARD_CONTEXT_TAGS.OUTPUT_FORMAT, {
                fields: 'title（含"（AI 生成）"后缀）, sections[4: 教学背景/干预策略/数据实证/反思展望], keyFindings, recommendations, dataAnonymized: true, aiGenerated: true',
                note: 'sections 必须恰好 4 章；dataAnonymized 必为 true；aiGenerated 必为 true',
            }),
        ])

        return `请基于以下数据，生成一份教研报告。

${contextBlock}

请输出严格 JSON，包含字段：title（含「（AI 生成）」后缀）, sections（4 个章节）, keyFindings, recommendations, dataAnonymized: true, aiGenerated: true。${withAiGeneratedMark()}`
    }

    protected validateOutput(raw: string): ReportOutput {
        const parsed = safeJsonParse(raw)
        const result = reportOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(`教研报告输出校验失败: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        }

        // 业务规则校验：章节标题与数量
        if (result.data.sections.length !== 4) {
            throw new Error(`教研报告必须有且仅有 4 个章节，实际 ${result.data.sections.length} 个`)
        }
        const expectedHeadings = ['教学背景', '干预策略', '数据实证', '反思展望']
        for (let i = 0; i < 4; i++) {
            const actual = result.data.sections[i]?.heading ?? ''
            if (!actual.includes(expectedHeadings[i]!)) {
                throw new Error(`第 ${i + 1} 章节标题应为「${expectedHeadings[i]}」，实际为「${actual}」`)
            }
        }

        return result.data
    }

    // ── 私有辅助：事件流统计 ──

    private countByType(events: LearningEvent[]): Record<string, number> {
        const counts: Record<string, number> = {}
        for (const e of events) {
            counts[e.type] = (counts[e.type] ?? 0) + 1
        }
        return counts
    }

    private countByBloom(events: LearningEvent[]): Record<string, number> {
        const counts: Record<string, number> = {}
        for (const e of events) {
            if (e.bloomLevel) {
                counts[e.bloomLevel] = (counts[e.bloomLevel] ?? 0) + 1
            }
        }
        return counts
    }

    private calcAverageScore(events: LearningEvent[]): number {
        const scored = events.filter((e) => typeof e.score === 'number')
        if (scored.length === 0) return 0
        const sum = scored.reduce((acc, e) => acc + (e.score ?? 0), 0)
        return Math.round((sum / scored.length) * 1000) / 1000
    }
}
