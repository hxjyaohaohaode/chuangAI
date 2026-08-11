/**
 * LLM 抽象层共享类型定义
 *
 * 本文件定义了 DeepSeek / MiMo 两大模型族共用的消息、工具、结果等类型。
 * 所有类型均为严格 TypeScript，无 any，适配 noUncheckedIndexedAccess。
 */

// ─────────────────────────────────────────────────────────────
// 消息与内容
// ─────────────────────────────────────────────────────────────

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** 文本内容片段 */
export interface TextContentPart {
    type: 'text'
    text: string
}

/** 图片内容片段（多模态，mimo-v2.5 支持） */
export interface ImageContentPart {
    type: 'image_url'
    image_url: {
        url: string
        detail?: 'auto' | 'low' | 'high'
    }
}

export type ContentPart = TextContentPart | ImageContentPart

/**
 * 统一对话消息格式
 * content 既可为纯文本字符串，也可为多模态内容片段数组
 */
export interface ChatMessage {
    role: Role
    content: string | ContentPart[]
    /** tool 调用 ID（role=tool 时必填） */
    tool_call_id?: string
    /** 助手消息中的工具调用 */
    tool_calls?: ToolCall[]
    /** 参与者名称（可选） */
    name?: string
}

// ─────────────────────────────────────────────────────────────
// 工具调用
// ─────────────────────────────────────────────────────────────

/** 工具定义（Function Calling） */
export interface Tool {
    type: 'function'
    function: {
        name: string
        description?: string
        /** JSON Schema 参数定义 */
        parameters?: Record<string, unknown>
    }
}

/** 模型返回的工具调用 */
export interface ToolCall {
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string
    }
}

// ─────────────────────────────────────────────────────────────
// 思考模式
// ─────────────────────────────────────────────────────────────

/**
 * 思考深度模式
 * - low / medium / high: 所有支持思考的模型通用
 * - max: 仅 deepseek-v4-pro 支持
 */
export type ThinkingMode = 'low' | 'medium' | 'high' | 'max'

/** 文本模型支持的思考模式（不含 max） */
export type TextThinkingMode = 'low' | 'medium' | 'high'

// ─────────────────────────────────────────────────────────────
// 调用元数据
// ─────────────────────────────────────────────────────────────

/** 用于计费追踪与观测的元数据 */
export interface CallMetadata {
    agent: string
    task: string
    sessionId?: string
}

// ─────────────────────────────────────────────────────────────
// 流式分片
// ─────────────────────────────────────────────────────────────

/** 流式输出的单个分片 */
export interface ChatChunk {
    /** 正文本增量 */
    content?: string
    /** 思考过程增量（思考模式开启时） */
    reasoning?: string
    /** 工具调用增量 */
    toolCalls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
    }>
    /** 是否为最终分片 */
    done?: boolean
    /** 分片携带的 usage（仅最后一个分片，需 stream_options.include_usage） */
    usage?: {
        promptTokens: number
        completionTokens: number
        cachedTokens?: number
    }
}

// ─────────────────────────────────────────────────────────────
// 路由相关
// ─────────────────────────────────────────────────────────────

/** X-MAS 域（异构多智能体角色域） */
export type Domain = 'mind' | 'eye' | 'brush' | 'orchestrator' | 'verifier'

/** X-MAS 功能 */
export type Function =
    | 'diagnose'
    | 'profile'
    | 'recommend'
    | 'verify'
    | 'vision-annotate'
    | 'asr'
    | 'tts'
    | 'generate-question'
    | 'grade'
    | 'report'
    | 'creative'
    | 'route'
    | 'summarize'

/** 路由决策 */
export interface RouteDecision {
    provider: 'deepseek' | 'mimo'
    model: string
    thinking?: ThinkingMode
    reason: string
    /**
     * 该路由的输出 token 上限（来自路由矩阵）
     *
     * 调用方未显式指定 maxTokens 时生效。深度思考档位的结构化输出任务
     * 必须给足预算，否则推理链会把输出预算吃光、content 返回空串。
     */
    maxTokens?: number
}

// ─────────────────────────────────────────────────────────────
// 统一执行参数与结果
// ─────────────────────────────────────────────────────────────

/** 路由 execute 方法的统一参数（覆盖文本/TTS/ASR 三类调用） */
export interface ExecuteParams {
    /** 对话消息（文本模型） */
    messages?: ChatMessage[]
    /** 多模态图片（mimo-v2.5）；底层只接受魔数匹配的内联图片或 DashScope OSS 白名单地址。 */
    images?: Array<{ url: string; detail?: 'auto' | 'low' | 'high' }>
    /** TTS 待合成文本 */
    text?: string
    /** TTS 音色 ID */
    voice?: string
    /** TTS 语速 0.5-2.0 */
    speed?: number
    /** TTS 输出格式 */
    responseFormat?: 'mp3' | 'wav'
    /** ASR 音频（Buffer / base64 / URL） */
    audio?: Buffer | string
    /** ASR 语言 */
    language?: 'zh' | 'en'
    /** ASR 引导词 */
    prompt?: string
    /** 采样温度 0-2 */
    temperature?: number
    /** 最大输出 token */
    maxTokens?: number
    /** JSON 输出模式（DeepSeek） */
    jsonOutput?: boolean
    /** 工具定义 */
    tools?: Tool[]
    /** 调用元数据 */
    metadata?: CallMetadata
    /** 中断信号 */
    signal?: AbortSignal
}

/** 路由 execute 方法的统一返回结果 */
export interface LLMResult {
    /** 文本内容 / ASR 转写文本 */
    content: string
    /** 思考过程（思考模式开启时） */
    reasoning?: string
    /** 工具调用 */
    toolCalls?: ToolCall[]
    /** TTS 音频数据 */
    audio?: Buffer
    /** TTS 音频格式 */
    audioFormat?: string
    /** ASR 音频时长（秒，用于计费） */
    audioDurationSec?: number
    /** ASR 置信度 */
    confidence?: number
    /** token 用量 */
    usage: {
        promptTokens: number
        completionTokens: number
        cachedTokens?: number
    }
    /** 请求延迟（毫秒） */
    latencyMs: number
    /** 使用的模型名 */
    model: string
    /** 服务提供方 */
    provider: 'deepseek' | 'mimo'
    /** 是否为降级模式输出 */
    fallback?: boolean
}
