/**
 * ASR 子 Agent — eye.asr
 *
 * 职责：调用 mimo-v2.5-asr 识别学生朗读音频，并评估发音/节奏/情感。
 *
 * 两阶段流程：
 * 1. ASR 转写：调用 mimo-v2.5-asr（eye:asr 路由），将音频转为文本
 * 2. 朗读评估：调用 deepseek-v4-flash（orchestrator:summarize 路由），
 *    对比原文与转写，输出发音/节奏/情感三维评分 + 错误标注
 *
 * 模型：mimo-v2.5-asr + deepseek-v4-flash
 * 认知层级：分析
 *
 * override invoke 实现两阶段流程。
 */

import { z } from 'zod'
import { router } from '../../llm/index.js'
import type { ChatMessage } from '../../llm/types.js'
import { BaseAgent } from '../base/Agent.js'
import type { AgentContext, AgentResult } from '../base/types.js'
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

export interface AsrInput {
    /** 音频数据（受控 Buffer / base64；URL 不得进入 LLM 客户端） */
    audio: Buffer | string
    poemId: string
    /** 诗词原文（用于对比评估） */
    expectedText: string
}

export type MistakeType = '错字' | '漏字' | '多字' | '停顿'

export interface AsrMistake {
    type: MistakeType
    position: number
    detail: string
}

export interface AsrOutput {
    transcript: string
    pronunciation: number
    rhythm: number
    emotion: number
    mistakes: AsrMistake[]
    suggestion: string
    audioDurationSec: number
    aiGenerated: true
}

// ─────────────────────────────────────────────────────────────
// zod 校验 schema
// ─────────────────────────────────────────────────────────────

const mistakeSchema = z.object({
    type: z.enum(['错字', '漏字', '多字', '停顿']),
    position: z.number().int().min(0),
    detail: z.string(),
})

const asrOutputSchema = z.object({
    transcript: z.string(),
    pronunciation: z.number().min(0).max(100),
    rhythm: z.number().min(0).max(100),
    emotion: z.number().min(0).max(100),
    mistakes: z.array(mistakeSchema),
    suggestion: z.string(),
    audioDurationSec: z.number().min(0),
    aiGenerated: z.literal(true),
})

// ─────────────────────────────────────────────────────────────
// AsrSubAgent
// ─────────────────────────────────────────────────────────────

export class AsrSubAgent extends BaseAgent {
    readonly id = 'eye.asr'
    readonly name = '语音识别与朗读评估子Agent'
    readonly domain = 'eye' as const
    readonly fn = 'asr' as const
    readonly bloomLevel = '分析' as const
    readonly promptVersion = 'v2.0.0'

    protected useJsonOutput(): boolean {
        return false
    }

    /**
     * override invoke — 两阶段流程：ASR 转写 + 朗读评估
     */
    async invoke(input: AsrInput, ctx: AgentContext): Promise<AgentResult<AsrOutput>> {
        const startedAt = Date.now()
        const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }
        this.emitStart(this.previewInput({ poemId: input.poemId, expectedText: input.expectedText }), ctx)

        try {
            // ── 阶段 1：ASR 转写 ──
            const asrResult = await router.execute(this.domain, this.fn, {
                audio: input.audio,
                language: 'zh',
                prompt: input.expectedText,
                metadata: { agent: `${this.id}:transcribe`, task: ctx.taskId, sessionId: ctx.sessionId },
                signal: ctx.signal,
            })

            const transcript = asrResult.content
            const audioDurationSec = asrResult.audioDurationSec ?? 0

            usage.promptTokens += asrResult.usage.promptTokens
            usage.completionTokens += asrResult.usage.completionTokens
            if (asrResult.usage.cachedTokens) usage.cachedTokens += asrResult.usage.cachedTokens

            // ── 阶段 2：朗读评估 ──
            const systemPrompt = this.buildSystemPrompt(ctx)
            const userPrompt = this.buildEvaluationUserPrompt(transcript, input, ctx)
            const messages: ChatMessage[] = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ]

            const evalResult = await router.execute('orchestrator', 'summarize', {
                messages,
                jsonOutput: true,
                metadata: { agent: `${this.id}:evaluate`, task: ctx.taskId, sessionId: ctx.sessionId },
                signal: ctx.signal,
            })

            usage.promptTokens += evalResult.usage.promptTokens
            usage.completionTokens += evalResult.usage.completionTokens
            if (evalResult.usage.cachedTokens) usage.cachedTokens += evalResult.usage.cachedTokens

            // 解析评估结果
            const parsed = safeJsonParse(evalResult.content)
            const evalData = z.object({
                pronunciation: z.number().min(0).max(100),
                rhythm: z.number().min(0).max(100),
                emotion: z.number().min(0).max(100),
                mistakes: z.array(mistakeSchema),
                suggestion: z.string(),
            }).safeParse(parsed)

            if (!evalData.success) {
                throw new Error(`朗读评估输出校验失败: ${evalData.error.issues.map((i) => i.message).join('; ')}`)
            }

            const output: AsrOutput = {
                transcript,
                pronunciation: evalData.data.pronunciation,
                rhythm: evalData.data.rhythm,
                emotion: evalData.data.emotion,
                mistakes: evalData.data.mistakes,
                suggestion: evalData.data.suggestion,
                audioDurationSec,
                aiGenerated: true,
            }

            const result = this.buildResult(output, usage, startedAt, ctx)
            this.emitSuccess(result, ctx)
            return result
        } catch (err) {
            this.emitError(err, ctx)
            throw err
        }
    }

    protected buildSystemPrompt(ctx: AgentContext): string {
        const constraints = withConstraint([
            ...COMMON_OUTPUT_CONSTRAINTS,
            'pronunciation/rhythm/emotion 均为 0-100 整数',
            'mistakes 每条含 type（错字/漏字/多字/停顿）、position（字位置从0开始）、detail（具体说明）',
            'suggestion 为给学生的朗读改进建议，50-100 字',
            '评估需公平客观，转写与原文完全一致时各项评分应较高',
        ])

        const teacherIntent = ctx.teacherIntent
            ? withXmlTags(ctx.teacherIntent, 'teacher_intent')
            : ''

        const fewShot = getFewShotBlock(this.id)

        return `你是诗眼·朗读评估专家，精通古诗词朗读教学与语音评估。

## 你的职责
对比学生朗读的 ASR 转写文本与诗词原文，评估朗读质量，输出三维评分与错误标注。

## 评估维度
1. **发音（pronunciation）**：字音准确度，包括多音字、生僻字、通假字读音
2. **节奏（rhythm）**：韵律节奏感，包括平仄、停顿、轻重缓急
3. **情感（emotion）**：情感表达度，包括语气、语调、意境传达

## 古诗词朗读评分要点
- 发音：多音字（如"朝"cháo/zhāo）、生僻字（如"潋滟"liàn yàn）、入声字
- 节奏：五言诗"二三"节奏（如"床前/明月光"），七言诗"二二三"节奏（如"月落/乌啼/霜满天"）
- 情感：思乡诗宜低沉、边塞诗宜豪放、田园诗宜恬淡

## 错误类型定义
- 错字：读音对应的字与原文不符
- 漏字：转写中缺少原文的字
- 多字：转写中多出原文没有的字
- 停顿：节奏断句不当（通过转写文本的断点推断）

## 朗读评估质量纪律
- mistakes 的 position 须为字位置索引（从 0 开始），不可仅说"中间"
- mistakes 的 detail 须含错读音与正音对比（如""霜"误读为"双"，shuāng→shuāng"），不可仅"读错了"
- suggestion 须含具体练习动作（如"对比'霜'与'双'的声调差异"），不可仅"多练习"
- 转写与原文完全一致时，pronunciation 应≥90，mistakes 为空数组
- 节奏评分须基于诗词格律（五言二三、七言二二三），不可凭感觉

${constraints}

${fewShot}

${teacherIntent}`
    }

    /**
     * 构建评估阶段的 user prompt
     */
    private buildEvaluationUserPrompt(transcript: string, input: AsrInput, _ctx: AgentContext): string {
        const contextBlock = buildContextBlock([
            standardEntry(STANDARD_CONTEXT_TAGS.TASK_INSTRUCTION, '对比原文与 ASR 转写，评估朗读质量'),
            standardEntry(STANDARD_CONTEXT_TAGS.POEM_CONTENT, `诗词 ID: ${input.poemId}\n原文: ${input.expectedText}`),
            { tag: 'student_transcript', content: transcript },
            standardEntry(STANDARD_CONTEXT_TAGS.OUTPUT_FORMAT, {
                fields: 'pronunciation(0-100), rhythm(0-100), emotion(0-100), mistakes[{type,position,detail}], suggestion',
                note: 'mistakes.type 为 错字/漏字/多字/停顿；position 从 0 开始',
            }),
        ])

        return `请对比原文与学生朗读转写，评估朗读质量。

${contextBlock}

请输出严格 JSON，包含字段：pronunciation, rhythm, emotion, mistakes, suggestion。`
    }

    protected buildUserPrompt(input: unknown, ctx: AgentContext): string {
        const typed = input as AsrInput
        return this.buildEvaluationUserPrompt('', typed, ctx)
    }

    protected validateOutput(raw: string): AsrOutput {
        const parsed = safeJsonParse(raw)
        const result = asrOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(`ASR 输出校验失败: ${result.error.issues.map((i) => i.message).join('; ')}`)
        }
        return result.data
    }
}
