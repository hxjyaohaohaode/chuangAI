/**
 * 诗眼 Agent — 多模态感知专家（主 Agent）
 *
 * 协调 3 个子 Agent，覆盖视觉与语音双通道感知：
 * - vision-annotate：Tri-MARF 视觉→文本标注（分析层）
 * - asr             ：语音识别 + 朗读评估（分析层）
 * - tts             ：标准范读合成（应用层）
 *
 * 主模型：mimo-v2.5（多模态），子 Agent 按路由矩阵各自选择最优模型。
 *
 * 本主 Agent 为协调者，不直接调用 LLM，而是组合调用子 Agent。
 */

import { VisionAnnotateSubAgent } from './vision-annotate.sub-agent.js'
import { AsrSubAgent } from './asr.sub-agent.js'
import { TtsSubAgent } from './tts.sub-agent.js'

export class EyeAgent {
    readonly id = 'eye'
    readonly name = '诗眼Agent'
    readonly description = '多模态感知专家 — 视觉标注(Tri-MARF)、语音识别与朗读评估、范读合成'

    /** 视觉→文本标注子 Agent — eye.vision-annotate（Tri-MARF） */
    readonly visionAnnotate = new VisionAnnotateSubAgent()

    /** 语音识别与朗读评估子 Agent — eye.asr */
    readonly asr = new AsrSubAgent()

    /** 语音合成子 Agent — eye.tts */
    readonly tts = new TtsSubAgent()
}

export { VisionAnnotateSubAgent } from './vision-annotate.sub-agent.js'
export { AsrSubAgent } from './asr.sub-agent.js'
export { TtsSubAgent } from './tts.sub-agent.js'
export type { VisionAnnotateInput, VisionAnnotateOutput, FactEntry, VisionPurpose } from './vision-annotate.sub-agent.js'
export type { AsrInput, AsrOutput, AsrMistake, MistakeType } from './asr.sub-agent.js'
export type { TtsInput, TtsOutput } from './tts.sub-agent.js'
