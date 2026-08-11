/**
 * 视觉→文本标注子 Agent — eye.vision-annotate（Tri-MARF 范式）
 *
 * 按 Tri-MARF（Tri-perspective Multi-modal Annotation Refinement Framework）范式实现：
 *
 * 阶段 1 — 多视角描述：调用 mimo-v2.5（多模态）三次，分别从
 *   "色彩与构图 / 情感与氛围 / 文化符号"三个视角描述图片
 *
 * 阶段 2 — 聚合选优：用 deepseek-v4-flash 聚合三个描述，
 *   去除冗余与冲突，形成统一标注
 *
 * 阶段 3 — 门控降噪：用 deepseek-v4-flash 对聚合结果做事实核查，
 *   不通过则重新调用阶段 1（带反馈），最多重试 1 次
 *
 * 模型：mimo-v2.5（vision-annotate 路由）+ deepseek-v4-flash（orchestrator 路由）
 * 认知层级：分析
 *
 * 本 Agent override invoke，实现三阶段流程，复用基类的 emitStart/emitSuccess/emitError。
 */

import { z } from 'zod'
import { router } from '../../llm/index.js'
import type { ChatMessage } from '../../llm/types.js'
import { BaseAgent } from '../base/Agent.js'
import type { AgentContext, AgentResult, PoemNode } from '../base/types.js'
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

export type VisionPurpose = 'illustration' | 'handwriting-recognition' | 'cultural-artifact'

export interface VisionAnnotateInput {
    imageUrl: string
    poemContext?: PoemNode
    purpose: VisionPurpose
}

type PerspectiveKey = 'color_composition' | 'emotion_atmosphere' | 'cultural_symbols'

interface Perspectives {
    color_composition: string
    emotion_atmosphere: string
    cultural_symbols: string
}

export interface FactEntry {
    claim: string
    verified: boolean
}

export interface VisionAnnotateOutput {
    imageUrl: string
    purpose: string
    perspectives: Perspectives
    aggregated: string
    facts: FactEntry[]
    finalAnnotation: string
    aiGenerated: true
    confidence: number
}

// ─────────────────────────────────────────────────────────────
// 三视角定义
// ─────────────────────────────────────────────────────────────

interface PerspectiveSpec {
    key: PerspectiveKey
    label: string
    instruction: string
}

const PERSPECTIVES: readonly PerspectiveSpec[] = [
    {
        key: 'color_composition',
        label: '色彩与构图',
        instruction: '从色彩搭配、构图布局、视觉重心、空间层次等角度描述图片。注意色调（暖/冷/中性）与画面元素的排列方式。',
    },
    {
        key: 'emotion_atmosphere',
        label: '情感与氛围',
        instruction: '从画面传达的情感、氛围、意境等角度描述。注意画面的情绪基调（欢快/忧伤/宁静/激昂）与营造手法。',
    },
    {
        key: 'cultural_symbols',
        label: '文化符号',
        instruction: '从文化符号、历史背景、文学关联等角度描述。识别图中的传统文化元素（如柳枝=送别、明月=思乡）及其象征意义。',
    },
] as const

// ─────────────────────────────────────────────────────────────
// zod 校验 schema（用于 validateOutput）
// ─────────────────────────────────────────────────────────────

const visionOutputSchema = z.object({
    imageUrl: z.string(),
    purpose: z.string(),
    perspectives: z.object({
        color_composition: z.string(),
        emotion_atmosphere: z.string(),
        cultural_symbols: z.string(),
    }),
    aggregated: z.string(),
    facts: z.array(z.object({
        claim: z.string(),
        verified: z.boolean(),
    })),
    finalAnnotation: z.string(),
    aiGenerated: z.literal(true),
    confidence: z.number().min(0).max(1),
})

// 聚合阶段输出 schema
const aggregateSchema = z.object({
    aggregated: z.string(),
})

// 门控阶段输出 schema
const gateSchema = z.object({
    facts: z.array(z.object({
        claim: z.string(),
        verified: z.boolean(),
        reason: z.string(),
    })),
    allPassed: z.boolean(),
    feedback: z.string().optional(),
})

// ─────────────────────────────────────────────────────────────
// VisionAnnotateSubAgent — Tri-MARF 实现
// ─────────────────────────────────────────────────────────────

export class VisionAnnotateSubAgent extends BaseAgent {
    readonly id = 'eye.vision-annotate'
    readonly name = '视觉→文本标注子Agent'
    readonly domain = 'eye' as const
    readonly fn = 'vision-annotate' as const
    readonly bloomLevel = '分析' as const
    readonly promptVersion = 'v2.0.0'

    /** 最大门控重试次数 */
    private static readonly MAX_GATE_RETRIES = 1

    protected useJsonOutput(): boolean {
        return false
    }

    /**
     * override invoke — 实现 Tri-MARF 三阶段流程
     */
    async invoke(input: VisionAnnotateInput, ctx: AgentContext): Promise<AgentResult<VisionAnnotateOutput>> {
        const startedAt = Date.now()
        const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }
        this.emitStart(this.previewInput(input), ctx)

        try {
            const systemPrompt = ctx.promptOverride?.systemPrompt ?? this.buildSystemPrompt(ctx)
            const images = [{ url: input.imageUrl, detail: 'high' as const }]

            // ── 阶段 1：多视角描述 ──
            let perspectives = await this.describeAllPerspectives(input, systemPrompt, images, ctx, usage, undefined)

            // ── 阶段 2：聚合选优 ──
            let aggregated = await this.aggregate(perspectives, input, ctx, usage)

            // ── 阶段 3：门控降噪（含重试） ──
            let gateResult = await this.gate(aggregated, input, ctx, usage)
            let retries = 0

            while (!gateResult.allPassed && retries < VisionAnnotateSubAgent.MAX_GATE_RETRIES) {
                retries++
                // 重新描述（带门控反馈）
                perspectives = await this.describeAllPerspectives(input, systemPrompt, images, ctx, usage, gateResult.feedback)
                aggregated = await this.aggregate(perspectives, input, ctx, usage)
                gateResult = await this.gate(aggregated, input, ctx, usage)
            }

            const output: VisionAnnotateOutput = {
                imageUrl: input.imageUrl,
                purpose: input.purpose,
                perspectives,
                aggregated,
                facts: gateResult.facts.map((f) => ({ claim: f.claim, verified: f.verified })),
                finalAnnotation: aggregated,
                aiGenerated: true,
                confidence: gateResult.allPassed ? 0.9 : 0.6,
            }

            const result = this.buildResult(output, usage, startedAt, ctx,
                gateResult.allPassed ? undefined : ['门控未完全通过，标注质量可能受限'])

            this.emitSuccess(result, ctx)
            return result
        } catch (err) {
            this.emitError(err, ctx)
            throw err
        }
    }

    // ── 阶段 1：多视角描述 ──

    /**
     * 并行调用 mimo-v2.5 三次，分别从三个视角描述图片
     */
    private async describeAllPerspectives(
        input: VisionAnnotateInput,
        systemPrompt: string,
        images: Array<{ url: string; detail: 'auto' | 'low' | 'high' }>,
        ctx: AgentContext,
        usage: { promptTokens: number; completionTokens: number; cachedTokens: number },
        feedback?: string,
    ): Promise<Perspectives> {
        const [color, emotion, cultural] = await Promise.all(
            PERSPECTIVES.map((spec) =>
                this.describePerspective(input, spec, systemPrompt, images, ctx, usage, feedback),
            ),
        )

        return {
            color_composition: color ?? '',
            emotion_atmosphere: emotion ?? '',
            cultural_symbols: cultural ?? '',
        }
    }

    /**
     * 从单一视角描述图片
     */
    private async describePerspective(
        input: VisionAnnotateInput,
        spec: PerspectiveSpec,
        systemPrompt: string,
        images: Array<{ url: string; detail: 'auto' | 'low' | 'high' }>,
        ctx: AgentContext,
        usage: { promptTokens: number; completionTokens: number; cachedTokens: number },
        feedback?: string,
    ): Promise<string> {
        const userPrompt = this.buildPerspectiveUserPrompt(input, spec, ctx, feedback)
        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ]

        const result = await router.execute(this.domain, this.fn, {
            messages,
            images,
            metadata: { agent: `${this.id}:${spec.key}`, task: ctx.taskId, sessionId: ctx.sessionId },
            signal: ctx.signal,
        })

        usage.promptTokens += result.usage.promptTokens
        usage.completionTokens += result.usage.completionTokens
        if (result.usage.cachedTokens) usage.cachedTokens += result.usage.cachedTokens

        return result.content
    }

    // ── 阶段 2：聚合选优 ──

    /**
     * 用 deepseek-v4-flash（orchestrator:summarize 路由）聚合三视角描述
     */
    private async aggregate(
        perspectives: Perspectives,
        input: VisionAnnotateInput,
        ctx: AgentContext,
        usage: { promptTokens: number; completionTokens: number; cachedTokens: number },
    ): Promise<string> {
        const systemPrompt = `你是诗眼·视觉标注聚合器。你的职责是将三个视角的图片描述聚合为一段统一、连贯、无冗余的标注文本。

${withConstraint([
            '聚合时去除三个视角间的重复信息',
            '冲突信息以"文化符号"视角为准（文化准确性优先）',
            '输出严格 JSON，格式为 {"aggregated": "统一标注文本"}',
            '标注文本 100-300 字，自然连贯',
        ])}`

        const perspectivesBlock = buildContextBlock([
            { tag: 'color_composition', content: perspectives.color_composition },
            { tag: 'emotion_atmosphere', content: perspectives.emotion_atmosphere },
            { tag: 'cultural_symbols', content: perspectives.cultural_symbols },
        ])

        const poemContext = input.poemContext
            ? withXmlTags(`${input.poemContext.title}（${input.poemContext.dynasty}·${input.poemContext.poet}）`, 'poem_context')
            : ''

        const userPrompt = `请聚合以下三视角描述为统一标注。

${perspectivesBlock}

${poemContext}`

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ]

        const result = await router.execute('orchestrator', 'summarize', {
            messages,
            jsonOutput: true,
            metadata: { agent: `${this.id}:aggregate`, task: ctx.taskId, sessionId: ctx.sessionId },
            signal: ctx.signal,
        })

        usage.promptTokens += result.usage.promptTokens
        usage.completionTokens += result.usage.completionTokens
        if (result.usage.cachedTokens) usage.cachedTokens += result.usage.cachedTokens

        const parsed = safeJsonParse(result.content)
        const validated = aggregateSchema.safeParse(parsed)
        if (!validated.success) {
            throw new Error(`视觉标注聚合输出校验失败: ${validated.error.issues.map((i) => i.message).join('; ')}`)
        }
        return validated.data.aggregated
    }

    // ── 阶段 3：门控降噪 ──

    /**
     * 用 deepseek-v4-flash（orchestrator:route 路由）做事实核查
     */
    private async gate(
        aggregated: string,
        input: VisionAnnotateInput,
        ctx: AgentContext,
        usage: { promptTokens: number; completionTokens: number; cachedTokens: number },
    ): Promise<{ facts: Array<{ claim: string; verified: boolean; reason: string }>; allPassed: boolean; feedback?: string }> {
        const systemPrompt = `你是诗眼·视觉标注门控官。你的职责是对聚合标注中的事实性声明逐条核查，判断其是否合理。

${withConstraint([
            '提取标注中的事实性声明（如"图中有柳树""色调偏暖"等）',
            '基于诗词上下文与常识判断每条声明是否合理',
            '若声明与诗词内容矛盾或缺乏依据，标记 verified: false',
            '输出严格 JSON：{"facts": [{"claim":"...","verified":true/false,"reason":"..."}], "allPassed": bool, "feedback": "改进建议(可选)"}',
        ])}`

        const poemContext = input.poemContext
            ? withXmlTags(
                `${input.poemContext.title}（${input.poemContext.dynasty}·${input.poemContext.poet}）\n主题: ${input.poemContext.theme.join('/')}\n意象: ${input.poemContext.images.join('/')}`,
                'poem_context',
            )
            : ''

        const userPrompt = `请核查以下聚合标注中的事实性声明。

${withXmlTags(aggregated, 'aggregated_annotation')}

${poemContext}`

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ]

        const result = await router.execute('orchestrator', 'route', {
            messages,
            jsonOutput: true,
            metadata: { agent: `${this.id}:gate`, task: ctx.taskId, sessionId: ctx.sessionId },
            signal: ctx.signal,
        })

        usage.promptTokens += result.usage.promptTokens
        usage.completionTokens += result.usage.completionTokens
        if (result.usage.cachedTokens) usage.cachedTokens += result.usage.cachedTokens

        const parsed = safeJsonParse(result.content)
        const validated = gateSchema.safeParse(parsed)
        if (!validated.success) {
            throw new Error(`视觉标注门控输出校验失败: ${validated.error.issues.map((i) => i.message).join('; ')}`)
        }
        return validated.data
    }

    // ── 基类抽象方法实现 ──

    protected buildSystemPrompt(ctx: AgentContext): string {
        const constraints = withConstraint([
            ...COMMON_OUTPUT_CONSTRAINTS.filter((c) => c !== '输出对象必须包含 "aiGenerated": true 字段'),
            '输出为自然语言描述，不输出 JSON',
            '描述需具体、客观，基于图片可见内容',
            '文化符号解读需关联诗词上下文，不可臆测',
        ])

        const teacherIntent = ctx.teacherIntent
            ? withXmlTags(ctx.teacherIntent, 'teacher_intent')
            : ''

        const fewShot = getFewShotBlock(this.id)

        return `你是诗眼·视觉标注专家，精通中国古典诗词意象与文化符号识别。

## 你的职责
从指定视角观察图片，输出详实的自然语言描述。你的描述将作为纯文本 Agent 的"眼睛"，供下游认知诊断与命题使用。

## 三视角框架
- 色彩与构图：色调、画面布局、视觉重心、空间层次
- 情感与氛围：情绪基调、意境营造、氛围渲染
- 文化符号：传统文化元素识别、象征意义解读、文学关联

## 古诗词常见意象对照（知识库）
- 柳枝 → 送别、留恋
- 明月 → 思乡、团圆
- 落花 → 伤春、凋零
- 孤帆 → 离别、远行
- 青山 → 永恒、隐逸
- 流水 → 时光流逝、愁绪

## 视觉标注质量纪律
- 描述须含具体视觉元素（如"明月位于画面右上方""地面有银白色光晕"），不可仅"画面很美"
- 文化符号解读须关联诗词上下文（如"明月呼应《静夜思》思乡主题"），不可孤立描述
- 色彩与构图须客观陈述（如"冷蓝色调为主"），不可主观臆断
- 情感与氛围须基于画面元素推断（如"仰头姿态营造孤寂感"），不可凭空想象
- 若图片与诗词内容不符，须如实指出（如"图中无明月，与诗意不符"）

${constraints}

${fewShot}

${teacherIntent}`
    }

    protected buildUserPrompt(input: unknown, ctx: AgentContext): string {
        const typed = input as VisionAnnotateInput
        // 默认使用第一个视角构建通用 prompt（基类 invoke 使用，本 Agent 实际使用 buildPerspectiveUserPrompt）
        return this.buildPerspectiveUserPrompt(typed, PERSPECTIVES[0]!, ctx, undefined)
    }

    /**
     * 构建特定视角的 user prompt
     */
    private buildPerspectiveUserPrompt(
        input: VisionAnnotateInput,
        spec: PerspectiveSpec,
        _ctx: AgentContext,
        feedback?: string,
    ): string {
        const poemContextStr = input.poemContext
            ? `${input.poemContext.title}（${input.poemContext.dynasty}·${input.poemContext.poet}）\n主题: ${input.poemContext.theme.join('/')}\n意象: ${input.poemContext.images.join('/')}`
            : ''

        const feedbackBlock = feedback
            ? withXmlTags(feedback, 'gate_feedback')
            : ''

        const contextBlock = buildContextBlock([
            standardEntry(STANDARD_CONTEXT_TAGS.TASK_INSTRUCTION, `从「${spec.label}」视角描述图片，输出自然语言 100-200 字`),
            standardEntry(STANDARD_CONTEXT_TAGS.POEM_CONTENT, poemContextStr),
            standardEntry(STANDARD_CONTEXT_TAGS.OUTPUT_FORMAT, '自然语言描述，100-200 字，不输出 JSON'),
            { tag: 'perspective_instruction', content: spec.instruction },
            { tag: 'annotation_purpose', content: input.purpose },
        ])

        return `请从「${spec.label}」视角描述这张图片。

${contextBlock}

${feedbackBlock}

请输出自然语言描述，100-200 字。`
    }

    protected validateOutput(raw: string): VisionAnnotateOutput {
        const parsed = safeJsonParse(raw)
        const result = visionOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(`视觉标注输出校验失败: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        }
        return result.data
    }
}
