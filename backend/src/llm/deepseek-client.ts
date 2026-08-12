/**
 * DeepSeek 大模型客户端
 *
 * 基于 OpenAI SDK（DeepSeek 完全兼容 OpenAI API），实现：
 * - 文本对话（chat）与流式输出（stream）
 * - 思考模式控制（V4 Flash: low/high/max；V4 Pro: high/max）
 * - JSON Output / Tool Calling
 * - 缓存命中 token 读取（DeepSeek 扩展字段 prompt_cache_hit_tokens）
 * - 思考过程分离（reasoning_content）
 * - 错误分类与超时控制
 *
 * 模型规格：
 * - deepseek-v4-pro: 1M 上下文, 384K 输出, 500 并发, 支持 max 思考模式
 * - deepseek-v4-flash: 1M 上下文, 384K 输出, 2500 并发, 支持 low/high/max
 */

import OpenAI from 'openai'
import type {
    ChatCompletionCreateParamsNonStreaming,
    ChatCompletionCreateParamsStreaming,
    ChatCompletionMessageParam,
    ChatCompletionTool,
} from 'openai/resources/chat/completions.js'
import type { CompletionUsage } from 'openai/resources/completions.d.js'
import type { RequestOptions } from 'openai/core.js'
import type {
    ChatChunk,
    ChatMessage,
    CallMetadata,
    ThinkingMode,
    Tool,
    ToolCall,
} from './types.js'

// ─────────────────────────────────────────────────────────────
// DeepSeek 扩展类型
// ─────────────────────────────────────────────────────────────

/**
 * DeepSeek 扩展 ChatCompletion 请求参数
 * OpenAI SDK 4.67 不含 reasoning_effort 字段，需类型扩展
 */
type DeepSeekCompletionParams = ChatCompletionCreateParamsNonStreaming & {
    reasoning_effort?: 'low' | 'high' | 'max'
    thinking?: { type: 'enabled' | 'disabled' }
}

type DeepSeekStreamingParams = ChatCompletionCreateParamsStreaming & {
    reasoning_effort?: 'low' | 'high' | 'max'
    thinking?: { type: 'enabled' | 'disabled' }
}

/**
 * DeepSeek 扩展 Usage 类型
 * prompt_cache_hit_tokens 为 DeepSeek 特有的缓存命中字段
 */
interface DeepSeekUsage extends CompletionUsage {
    prompt_cache_hit_tokens?: number
}

/**
 * DeepSeek 扩展 Delta 类型
 * reasoning_content 为思考过程内容（思考模式开启时）
 */
interface DeepSeekDelta {
    content?: string | null
    reasoning_content?: string | null
    role?: 'system' | 'user' | 'assistant' | 'tool'
    tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
    }>
}

// ─────────────────────────────────────────────────────────────
// 公共类型
// ─────────────────────────────────────────────────────────────

export type DeepSeekModel = 'deepseek-v4-pro' | 'deepseek-v4-flash'

export interface DeepSeekCallParams {
    model: DeepSeekModel
    messages: ChatMessage[]
    /** 思考模式，默认 medium */
    thinking?: ThinkingMode
    /** 采样温度 0-2 */
    temperature?: number
    /** 最大输出 token，默认 4096 */
    maxTokens?: number
    /** 启用 JSON Output */
    jsonOutput?: boolean
    /** Tool Calling 定义 */
    tools?: Tool[]
    /** 是否流式输出（chat 方法忽略此字段，使用 stream 方法） */
    stream?: boolean
    /** 中断信号 */
    signal?: AbortSignal
    /** 调用元数据（用于计费追踪） */
    metadata?: CallMetadata
}

export interface DeepSeekResult {
    content: string
    /** 思考过程（思考模式开启时） */
    reasoning?: string
    toolCalls?: ToolCall[]
    usage: {
        promptTokens: number
        completionTokens: number
        cachedTokens?: number
    }
    latencyMs: number
    model: DeepSeekModel
}

// ─────────────────────────────────────────────────────────────
// DeepSeekClient
// ─────────────────────────────────────────────────────────────

/**
 * DeepSeek 大模型客户端
 *
 * 使用 OpenAI SDK 封装，支持 DeepSeek 特有的思考模式与缓存命中追踪
 */
export class DeepSeekClient {
    private client: OpenAI
    private apiKey: string
    /** 单次请求默认超时 60s */
    private static readonly DEFAULT_TIMEOUT_MS = 60_000

    /** 保留 baseUrl，供运行时换密钥时重建连接实例 */
    private baseUrl: string

    /**
     * 运行时更换 API 密钥
     *
     * OpenAI SDK 的 apiKey 在实例化时固化，无法就地修改，
     * 因此换密钥必须重建 client。教师在设置面板保存新密钥后，
     * credentials 模块会回调到这里，下一次调用即使用新密钥，无需重启服务。
     */
    setApiKey(apiKey: string): void {
        this.apiKey = apiKey.trim()
        this.client = new OpenAI({
            apiKey: this.apiKey,
            baseURL: this.baseUrl,
            maxRetries: 0,
            timeout: DeepSeekClient.DEFAULT_TIMEOUT_MS,
        })
    }

    constructor(apiKey: string, baseUrl: string) {
        this.baseUrl = baseUrl
        this.apiKey = apiKey.trim()
        this.client = new OpenAI({
            apiKey: this.apiKey,
            baseURL: baseUrl,
            // SDK 内置重试设为 0，由 ErrorRecovery 层统一处理重试
            maxRetries: 0,
            timeout: DeepSeekClient.DEFAULT_TIMEOUT_MS,
        })
    }

    /**
     * 非流式对话
     */
    async chat(params: DeepSeekCallParams): Promise<DeepSeekResult> {
        this.assertConfigured()
        const startTime = Date.now()
        const thinking = params.thinking ?? 'medium'

        // 在供应商边界校验并归一化官方有效档位。
        this.validateThinking(params.model, thinking)

        // 构建请求参数
        const requestParams = this.buildRequestParams(params, thinking, false)
        const requestOptions = this.buildRequestOptions(params.signal)

        const response = await this.client.chat.completions.create(
            requestParams as ChatCompletionCreateParamsNonStreaming,
            requestOptions,
        )

        const latencyMs = Date.now() - startTime

        // 解析响应
        const choice = response.choices[0]
        const message = choice?.message
        const content = message?.content ?? ''
        const reasoning = this.extractReasoning(message)
        const toolCalls = this.extractToolCalls(message)
        const usage = this.extractUsage(response.usage)

        // 输出预算耗尽检测
        //
        // 深度思考档位下，推理链会先消耗 max_tokens 预算；预算不够时正文 content
        // 会返回空串，而 finish_reason 为 'length'。若放任其向下传递，下游的
        // JSON 解析会抛出「LLM 输出非合法 JSON」，把一个配置问题伪装成模型幻觉，
        // 极难排查。这里在源头识别并给出可操作的错误信息。
        if (content.length === 0 && toolCalls.length === 0 && choice?.finish_reason === 'length') {
            throw new Error(
                `模型输出被 max_tokens 截断：思考模式 "${thinking}" 的推理链已耗尽 ` +
                `${params.maxTokens ?? 4096} token 输出预算，正文为空。` +
                `请调高该路由的 maxTokens（llm/router.ts 的 ROUTE_MATRIX）或降低思考档位。`,
            )
        }

        return {
            content,
            reasoning,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage,
            latencyMs,
            model: params.model,
        }
    }

    /**
     * 流式对话
     *
     * 逐分片 yield，分离 content 与 reasoning_content
     * 最后一个分片携带 usage（需 stream_options.include_usage）
     */
    async *stream(params: DeepSeekCallParams): AsyncGenerator<ChatChunk> {
        this.assertConfigured()
        const thinking = params.thinking ?? 'medium'

        // 在供应商边界校验并归一化官方有效档位。
        this.validateThinking(params.model, thinking)

        // 构建流式请求参数
        const requestParams = this.buildRequestParams(params, thinking, true)
        const requestOptions = this.buildRequestOptions(params.signal)

        const stream = await this.client.chat.completions.create(
            requestParams as ChatCompletionCreateParamsStreaming,
            requestOptions,
        )

        for await (const chunk of stream) {
            const choice = chunk.choices[0]
            const delta = choice?.delta as DeepSeekDelta | undefined

            // 使用 stream_options.include_usage 后，最后一个 chunk 携带 usage
            if (chunk.usage) {
                const deepseekUsage = chunk.usage as DeepSeekUsage
                yield {
                    done: true,
                    usage: {
                        promptTokens: deepseekUsage.prompt_tokens,
                        completionTokens: deepseekUsage.completion_tokens,
                        cachedTokens: deepseekUsage.prompt_cache_hit_tokens,
                    },
                }
                continue
            }

            if (!delta) continue

            const result: ChatChunk = {}

            if (delta.content) {
                result.content = delta.content
            }

            if (delta.reasoning_content) {
                result.reasoning = delta.reasoning_content
            }

            if (delta.tool_calls && delta.tool_calls.length > 0) {
                result.toolCalls = delta.tool_calls.map((tc) => ({
                    index: tc.index,
                    id: tc.id,
                    function: tc.function,
                }))
            }

            // 只在有内容时 yield
            if (result.content || result.reasoning || result.toolCalls) {
                yield result
            }
        }
    }

    /** 缺少密钥时必须在 SDK/网络边界之前失败，演示模式也不得发送空 Bearer 请求。 */
    private assertConfigured(): void {
        if (this.apiKey.length === 0) {
            throw new Error('DeepSeek API 密钥未配置')
        }
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    /**
     * 校验思考模式
     * 模型名由类型锁定；档位兼容映射在 buildRequestParams 中完成。
     */
    private validateThinking(model: DeepSeekModel, thinking: ThinkingMode): void {
        void model
        void thinking
    }

    /**
     * 构建请求参数
     */
    private buildRequestParams(
        params: DeepSeekCallParams,
        thinking: ThinkingMode,
        stream: boolean,
    ): DeepSeekCompletionParams | DeepSeekStreamingParams {
        const messages = params.messages.map((m) => this.mapMessage(m))

        const base: Record<string, unknown> = {
            model: params.model,
            messages,
            max_tokens: params.maxTokens ?? 4096,
            // DeepSeek 官方 OpenAI ChatCompletions 契约要求用 thinking 显式开关
            // 思考模式，再用 reasoning_effort 控制强度；只传后者会依赖供应商默认值。
            thinking: { type: 'enabled' },
        }

        if (params.temperature !== undefined) {
            base.temperature = params.temperature
        }

        // 官方当前：V4 Flash 支持 low/high/max；V4 Pro 暂只支持 high/max。
        // medium 是兼容值，会被供应商映射到 high。这里显式归一，确保观测与实际一致。
        base.reasoning_effort = thinking === 'max'
            ? 'max'
            : thinking === 'low' && params.model === 'deepseek-v4-flash'
                ? 'low'
                : 'high'

        // JSON Output
        if (params.jsonOutput) {
            base.response_format = { type: 'json_object' }
        }

        // Tool Calling
        if (params.tools && params.tools.length > 0) {
            base.tools = params.tools.map((t) => this.mapTool(t))
        }

        if (stream) {
            base.stream = true
            // 请求最后一个分片携带 usage
            base.stream_options = { include_usage: true }
            return base as unknown as DeepSeekStreamingParams
        }

        return base as unknown as DeepSeekCompletionParams
    }

    /**
     * 构建请求选项（超时 + 中断信号）
     */
    private buildRequestOptions(signal?: AbortSignal): RequestOptions {
        const opts: RequestOptions = {}
        if (signal) {
            opts.signal = signal
        }
        return opts
    }

    /**
     * 将统一 ChatMessage 映射为 OpenAI SDK 格式
     */
    private mapMessage(msg: ChatMessage): ChatCompletionMessageParam {
        // tool 角色消息
        if (msg.role === 'tool') {
            return {
                role: 'tool',
                tool_call_id: msg.tool_call_id ?? '',
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            }
        }

        // assistant 角色消息
        if (msg.role === 'assistant') {
            const assistantMsg: Record<string, unknown> = {
                role: 'assistant',
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            }
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                assistantMsg.tool_calls = msg.tool_calls.map((tc) => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: { name: tc.function.name, arguments: tc.function.arguments },
                }))
            }
            return assistantMsg as unknown as ChatCompletionMessageParam
        }

        // system / user 角色消息
        // content 可为字符串或多模态片段数组
        return {
            role: msg.role,
            content: msg.content,
        } as ChatCompletionMessageParam
    }

    /**
     * 将统一 Tool 定义映射为 OpenAI SDK 格式
     */
    private mapTool(tool: Tool): ChatCompletionTool {
        return {
            type: 'function',
            function: {
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters,
            },
        }
    }

    /**
     * 从响应消息中提取思考过程
     * DeepSeek 在 message 中返回 reasoning_content 字段
     */
    private extractReasoning(
        message: OpenAI.Chat.Completions.ChatCompletionMessage | undefined,
    ): string | undefined {
        if (!message) return undefined
        const extended = message as unknown as { reasoning_content?: string | null }
        return extended.reasoning_content ?? undefined
    }

    /**
     * 从响应消息中提取工具调用
     */
    private extractToolCalls(
        message: OpenAI.Chat.Completions.ChatCompletionMessage | undefined,
    ): ToolCall[] {
        if (!message?.tool_calls || message.tool_calls.length === 0) {
            return []
        }
        return message.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
            },
        }))
    }

    /**
     * 从响应 usage 中提取 token 用量
     * DeepSeek 扩展字段 prompt_cache_hit_tokens 表示缓存命中数
     */
    private extractUsage(usage: CompletionUsage | null | undefined): {
        promptTokens: number
        completionTokens: number
        cachedTokens?: number
    } {
        if (!usage) {
            return { promptTokens: 0, completionTokens: 0 }
        }
        const deepseekUsage = usage as DeepSeekUsage
        return {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            cachedTokens: deepseekUsage.prompt_cache_hit_tokens,
        }
    }
}
