/**
 * 智能体层 barrel export
 *
 * 统一导出三大主 Agent 及其子 Agent、共享基类与类型。
 * 提供 mindAgent / eyeAgent / brushAgent 三个单例，
 * 供编排官（orchestrator）与路由层全局复用。
 *
 * 架构总览：
 *   ┌─────────────────────────────────────────────────┐
 *   │  MindAgent（诗心）— 认知诊断专家                │
 *   │  ├─ profile    学情画像（mimo-v2.5-pro）        │
 *   │  ├─ diagnose   认知诊断（v4-pro max）           │
 *   │  ├─ recommend  路径推荐（v4-flash）             │
 *   │  └─ verify     独立验收（v4-pro 评价层）        │
 *   ├─────────────────────────────────────────────────┤
 *   │  EyeAgent（诗眼）— 多模态感知专家              │
 *   │  ├─ vision-annotate  Tri-MARF 视觉标注（v2.5）  │
 *   │  ├─ asr              语音识别（v2.5-asr）       │
 *   │  └─ tts              范读合成（v2.5-tts）       │
 *   ├─────────────────────────────────────────────────┤
 *   │  BrushAgent（诗笔）— 内容生成专家              │
 *   │  ├─ question   六阶命题（v4-pro max）           │
 *   │  ├─ grade      智能批改（v4-flash low）         │
 *   │  ├─ report     教研报告（v4-pro high）          │
 *   │  └─ creative   创意素材（v4-flash medium）      │
 *   └─────────────────────────────────────────────────┘
 *
 * 异构路由矩阵（X-MAS 范式）：
 *   共 14 个 Agent（3 主 + 11 子），按 domain × function 路由至
 *   deepseek-v4-pro / v4-flash / mimo-v2.5 / v2.5-pro / v2.5-tts / v2.5-asr
 *   六款模型，搭配 low/medium/high/max 四档思考模式。
 */

// ── 主 Agent ──
export { MindAgent } from './mind-agent/index.js'
export { EyeAgent } from './eye-agent/index.js'
export { BrushAgent } from './brush-agent/index.js'

// ── 诗心子 Agent ──
export {
    ProfileSubAgent,
    DiagnoseSubAgent,
    RecommendSubAgent,
    VerifySubAgent,
} from './mind-agent/index.js'
export type {
    ProfileInput,
    ProfileOutput,
    DiagnoseInput,
    RecommendInput,
    RecommendOutput,
    RecommendPathStep,
    VerifyInput,
    VerifyOutput,
} from './mind-agent/index.js'

// ── 诗眼子 Agent ──
export {
    VisionAnnotateSubAgent,
    AsrSubAgent,
    TtsSubAgent,
} from './eye-agent/index.js'
export type {
    VisionAnnotateInput,
    VisionAnnotateOutput,
    FactEntry,
    VisionPurpose,
    AsrInput,
    AsrOutput,
    AsrMistake,
    MistakeType,
    TtsInput,
    TtsOutput,
} from './eye-agent/index.js'

// ── 诗笔子 Agent ──
export {
    QuestionSubAgent,
    GradeSubAgent,
    ReportSubAgent,
    CreativeSubAgent,
    gradeOutputSchema,
} from './brush-agent/index.js'
export type {
    QuestionInput,
    QuestionOutput,
    GradeLevel,
    GradeInput,
    GradeOutput,
    ReportInput,
    ReportOutput,
    ReportSection,
    CreativeInput,
    CreativeOutput,
    CreativeType,
    CreativeGradeLevel,
} from './brush-agent/index.js'

// ── 基类与共享类型 ──
export { BaseAgent } from './base/Agent.js'
export { agentEvents, AGENT_EVENTS } from './base/events.js'
export type {
    AgentEventName,
    AgentCallStartPayload,
    AgentCallSuccessPayload,
    AgentCallErrorPayload,
    AgentFallbackPayload,
    AgentVerifyPayload,
} from './base/events.js'
export {
    withXmlTags,
    withExamples,
    withConstraint,
    withAiGeneratedMark,
    buildContextBlock,
    safeJsonParse,
    COMMON_OUTPUT_CONSTRAINTS,
    STANDARD_CONTEXT_TAGS,
    standardEntry,
    FEWSHOT_EXAMPLES,
    getFewShotBlock,
    withRegenerationFeedback,
    withHistorySummary,
} from './base/prompts.js'
export type { StandardContextTag } from './base/prompts.js'
export {
    RAGRetriever,
    LongConversationSummarizer,
    buildIsolatedContext,
    trimHistoryWithSummary,
} from './base/context.js'
export type { RAGResult, SummarizedHistory } from './base/context.js'
export {
    GeneratorVerifierCurator,
    runGvcLoop,
    buildCuratorFeedback,
    classifyErrorLayer,
} from './base/loop.js'
export type { GvcResult, GvcOptions, ErrorLayer as LoopErrorLayer } from './base/loop.js'

// ── P7：自我进化引擎 + 主动智能 ──
export { EvolutionEngine, evolutionEngine } from './base/evolution-engine.js'
export type { EvolutionSource, EvolutionStats } from './base/evolution-engine.js'
export {
    ProactiveIntelligence,
    proactiveIntelligence,
    PROACTIVE_EVENTS,
} from './base/proactive-intelligence.js'
export type { ProactiveAlert } from './base/proactive-intelligence.js'
export type {
    BloomLevel,
    BloomMastery,
    BloomWeights,
    CognitiveStyle,
    LearningPace,
    StudentProfile,
    PoemNode,
    ClassContext,
    LearningEvent,
    DiagnosisResult,
    DarkMatterEntry,
    QuestionType,
    Question,
    AgentContext,
    AgentResult,
    VerifyVerdict,
    VerifyIssue,
    VerifyDimension,
    StructuredOutputSchema,
    ToolInvocation,
} from './base/types.js'
export { VERIFY_DIMENSIONS } from './base/types.js'

// ─────────────────────────────────────────────────────────────
// 全局单例（供 orchestrator 与路由层复用）
// ─────────────────────────────────────────────────────────────

import { MindAgent } from './mind-agent/index.js'
import { EyeAgent } from './eye-agent/index.js'
import { BrushAgent } from './brush-agent/index.js'

/** 诗心 Agent 单例 — 认知诊断专家 */
export const mindAgent = new MindAgent()

/** 诗眼 Agent 单例 — 多模态感知专家 */
export const eyeAgent = new EyeAgent()

/** 诗笔 Agent 单例 — 内容生成专家 */
export const brushAgent = new BrushAgent()

/**
 * 三大主 Agent 单例集合
 * 供编排官一次性获取所有 Agent 引用
 */
export const agents = {
    mind: mindAgent,
    eye: eyeAgent,
    brush: brushAgent,
} as const
