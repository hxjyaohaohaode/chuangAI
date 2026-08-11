/**
 * TTS 子 Agent — eye.tts
 *
 * 职责：调用 mimo-v2.5-tts 生成标准范读音频。
 * 模型：mimo-v2.5-tts（eye:tts 路由），限时免费
 * 认知层级：应用
 *
 * TTS 不走 LLM 对话流程，直接调用语音合成 API。
 * override invoke，基类的 buildSystemPrompt/buildUserPrompt/validateOutput
 * 不适用于本 Agent（标记为不可调用）。
 *
 * 输出音频 Buffer 由上层路由决定是直接返回客户端还是存文件。
 */

import { router } from '../../llm/index.js'
import { BaseAgent } from '../base/Agent.js'
import type { AgentContext, AgentResult } from '../base/types.js'

// ─────────────────────────────────────────────────────────────
// 输入 / 输出类型
// ─────────────────────────────────────────────────────────────

export interface TtsInput {
    /** 待合成文本 */
    text: string
    /** 音色 ID（可选，使用 TTS 服务默认音色） */
    voice?: string
    /** 语速 0.5-2.0（可选，默认 1.0） */
    speed?: number
    /** 输出格式（可选，默认 mp3） */
    format?: 'mp3' | 'wav'
}

export interface TtsOutput {
    audio: Buffer
    format: string
    durationMs: number
    aiGenerated: true
}

// ─────────────────────────────────────────────────────────────
// TtsSubAgent
// ─────────────────────────────────────────────────────────────

export class TtsSubAgent extends BaseAgent {
    readonly id = 'eye.tts'
    readonly name = '语音合成子Agent'
    readonly domain = 'eye' as const
    readonly fn = 'tts' as const
    readonly bloomLevel = '应用' as const
    readonly promptVersion = 'v1.0.0'

    protected useJsonOutput(): boolean {
        return false
    }

    /**
     * override invoke — 直接调用 TTS API
     */
    async invoke(input: TtsInput, ctx: AgentContext): Promise<AgentResult<TtsOutput>> {
        const startedAt = Date.now()
        this.emitStart(this.previewInput({ textLength: input.text.length, voice: input.voice }), ctx)

        try {
            const result = await router.execute(this.domain, this.fn, {
                text: input.text,
                voice: input.voice,
                speed: input.speed,
                responseFormat: input.format,
                metadata: { agent: this.id, task: ctx.taskId, sessionId: ctx.sessionId },
                signal: ctx.signal,
            })

            if (!result.audio) {
                throw new Error('TTS 调用未返回音频数据')
            }

            // 音频时长估算：中文约 4 字/秒，取估算值与请求延迟的较大值
            const estimatedDurationMs = Math.max(
                result.latencyMs,
                input.text.length * 250,
            )

            const output: TtsOutput = {
                audio: result.audio,
                format: result.audioFormat ?? input.format ?? 'mp3',
                durationMs: estimatedDurationMs,
                aiGenerated: true,
            }

            const agentResult = this.buildResult(
                output,
                { promptTokens: 0, completionTokens: 0 },
                startedAt,
                ctx,
            )
            this.emitSuccess(agentResult, ctx)
            return agentResult
        } catch (err) {
            this.emitError(err, ctx)
            throw err
        }
    }

    // ── 基类抽象方法（TTS 不走 LLM 对话流程，标记不可调用） ──

    protected buildSystemPrompt(_ctx: AgentContext): string {
        throw new Error('TTS 子 Agent 不使用 System Prompt（直接调用语音合成 API）')
    }

    protected buildUserPrompt(_input: unknown, _ctx: AgentContext): string {
        throw new Error('TTS 子 Agent 不使用 User Prompt（直接调用语音合成 API）')
    }

    protected validateOutput(_raw: string): TtsOutput {
        throw new Error('TTS 子 Agent 不需要 validateOutput（输出为音频 Buffer，非文本 JSON）')
    }
}
