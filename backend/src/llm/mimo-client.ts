/**
 * MiMo 大模型客户端
 *
 * 覆盖 MiMo 系列四款模型，基于 OpenAI SDK（OpenAI 兼容 API）：
 * - mimo-v2.5:       多模态文本模型（支持图片输入），1M 上下文，128K 输出
 * - mimo-v2.5-pro:   纯文本模型，1M 上下文，128K 输出
 * - mimo-v2.5-tts:   语音合成模型，8K 上下文，8K 输出，限时免费
 * - mimo-v2.5-asr:   语音识别模型，8K 上下文，2K 输出，0.5 元/小时
 *
 * 文本模型支持开关思考模式；当前官方 ChatCompletions 不支持自定义思考强度，
 * 因此上层 low/medium/high 均按“启用思考”发送，不能伪装成供应商已执行分档。
 */

import OpenAI from 'openai'
import type {
    ChatCompletionCreateParamsNonStreaming,
    ChatCompletionCreateParamsStreaming,
    ChatCompletionMessageParam,
} from 'openai/resources/chat/completions.js'
import type { RequestOptions } from 'openai/core.js'
import type {
    ChatChunk,
    ChatMessage,
    CallMetadata,
    ContentPart,
    TextThinkingMode,
    Tool,
    ToolCall,
} from './types.js'
import { isSupportedModelImageReference } from '../security/image-reference-policy.js'
import { decodeBoundedTtsAudioData } from '../security/remote-audio-response.js'
import { inspectAudioBytes, type InspectedAudio } from '../security/audio-upload-policy.js'

// ─────────────────────────────────────────────────────────────
// MiMo 扩展类型
// ─────────────────────────────────────────────────────────────

/**
 * MiMo 扩展 ChatCompletion 请求参数。
 * 官方 ChatCompletions 使用 max_completion_tokens 与 thinking.type；
 * 不能复用 Responses API 的 reasoning.effort，也不能沿用旧 max_tokens 字段。
 */
type MimoCompletionParams = ChatCompletionCreateParamsNonStreaming & {
    max_completion_tokens?: number
    thinking?: { type: 'enabled' | 'disabled' }
}

type MimoStreamingParams = ChatCompletionCreateParamsStreaming & {
    max_completion_tokens?: number
    thinking?: { type: 'enabled' | 'disabled' }
}

/**
 * MiMo 扩展 Delta 类型（与 DeepSeek 一致，reasoning_content 为思考过程）
 */
interface MimoDelta {
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

export type MimoTextModel = 'mimo-v2.5' | 'mimo-v2.5-pro'
export type MimoTtsModel = 'mimo-v2.5-tts'
export type MimoAsrModel = 'mimo-v2.5-asr'

export interface MimoTextParams {
    model: MimoTextModel
    messages: ChatMessage[]
    /** 多模态图片输入（仅 mimo-v2.5 支持） */
    images?: Array<{ url: string; detail?: 'auto' | 'low' | 'high' }>
    /** 上层任务强度提示；MiMo 官方 ChatCompletions 当前统一映射为 enabled */
    thinking?: TextThinkingMode
    /** 采样温度 0-2 */
    temperature?: number
    /** 最大输出 token */
    maxTokens?: number
    /** 工具定义 */
    tools?: Tool[]
    /** 中断信号 */
    signal?: AbortSignal
    /** 调用元数据 */
    metadata?: CallMetadata
}

export interface MimoTextResult {
    content: string
    reasoning?: string
    toolCalls?: ToolCall[]
    usage: {
        promptTokens: number
        completionTokens: number
    }
    latencyMs: number
    model: MimoTextModel
}

export interface MimoTtsParams {
    model: MimoTtsModel
    /** 待合成文本 */
    text: string
    /** 音色 ID */
    voice?: string
    /** 语速 0.5-2.0 */
    speed?: number
    /** 输出格式 */
    responseFormat?: 'mp3' | 'wav'
    /** 中断信号 */
    signal?: AbortSignal
    /** 调用元数据 */
    metadata?: { agent: string; task: string }
}

export interface MimoAsrParams {
    model: MimoAsrModel
    /** 音频数据（受控 Buffer 或 base64；禁止客户端在 LLM 层代取 URL） */
    audio: Buffer | string
    /** 可选原始文件名；只校验扩展名与魔数一致，实际上传使用服务端生成的安全文件名。 */
    audioFilename?: string
    /** 可选声明 MIME；必须与魔数一致。data URI 自带 MIME 时也执行同一校验。 */
    audioMimeType?: string
    /** 语言 */
    language?: 'zh' | 'en'
    /** 引导词 */
    prompt?: string
    /** 中断信号 */
    signal?: AbortSignal
    /** 调用元数据 */
    metadata?: { agent: string; task: string }
}

// ─────────────────────────────────────────────────────────────
// MiMoClient
// ─────────────────────────────────────────────────────────────

/**
 * MiMo 大模型客户端
 *
 * 封装文本对话、语音合成（TTS）、语音识别（ASR）三种能力
 */
export class MiMoClient {
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
            timeout: MiMoClient.DEFAULT_TIMEOUT_MS,
        })
    }

    constructor(apiKey: string, baseUrl: string) {
        this.baseUrl = baseUrl
        this.apiKey = apiKey.trim()
        this.client = new OpenAI({
            apiKey: this.apiKey,
            baseURL: baseUrl,
            maxRetries: 0,
            timeout: MiMoClient.DEFAULT_TIMEOUT_MS,
        })
    }

    // ─────────────────────────────────────────────────────────
    // 文本对话
    // ─────────────────────────────────────────────────────────

    /**
     * 非流式文本对话
     */
    async chat(params: MimoTextParams): Promise<MimoTextResult> {
        this.assertConfigured()
        const startTime = Date.now()
        const thinking = params.thinking ?? 'medium'

        const requestParams = this.buildTextRequestParams(params, thinking, false)
        const requestOptions = this.buildRequestOptions(params.signal)

        const response = await this.client.chat.completions.create(
            requestParams as ChatCompletionCreateParamsNonStreaming,
            requestOptions,
        )

        const latencyMs = Date.now() - startTime

        const choice = response.choices[0]
        const message = choice?.message
        const content = message?.content ?? ''
        const reasoning = this.extractReasoning(message)
        const toolCalls = this.extractToolCalls(message)
        const usage = response.usage

        return {
            content,
            reasoning,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage: {
                promptTokens: usage?.prompt_tokens ?? 0,
                completionTokens: usage?.completion_tokens ?? 0,
            },
            latencyMs,
            model: params.model,
        }
    }

    /**
     * 流式文本对话
     */
    async *streamChat(params: MimoTextParams): AsyncGenerator<ChatChunk> {
        this.assertConfigured()
        const thinking = params.thinking ?? 'medium'

        const requestParams = this.buildTextRequestParams(params, thinking, true)
        const requestOptions = this.buildRequestOptions(params.signal)

        const stream = await this.client.chat.completions.create(
            requestParams as ChatCompletionCreateParamsStreaming,
            requestOptions,
        )

        for await (const chunk of stream) {
            const choice = chunk.choices[0]
            const delta = choice?.delta as MimoDelta | undefined

            // 最后一个分片携带 usage
            if (chunk.usage) {
                yield {
                    done: true,
                    usage: {
                        promptTokens: chunk.usage.prompt_tokens,
                        completionTokens: chunk.usage.completion_tokens,
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

            if (result.content || result.reasoning || result.toolCalls) {
                yield result
            }
        }
    }

    // ─────────────────────────────────────────────────────────
    // 语音合成（TTS）
    // ─────────────────────────────────────────────────────────

    /**
     * 语音合成
     *
     * 官方契约：POST /v1/chat/completions，目标文本必须放在 assistant 消息中，
     * 音频由 choices[0].message.audio.data 以 base64 返回。
     * mimo-v2.5-tts 限时免费
     */
    async tts(params: MimoTtsParams): Promise<{
        audio: Buffer
        format: string
        durationMs: number
    }> {
        this.assertConfigured()
        const startTime = Date.now()

        const format = params.responseFormat ?? 'mp3'
        const voice = normalizeMimoVoice(params.voice)
        const styleInstruction = buildMimoTtsStyleInstruction(params.speed)
        const ttsBody = {
            model: params.model,
            messages: [
                ...(styleInstruction
                    ? [{ role: 'user' as const, content: styleInstruction }]
                    : []),
                { role: 'assistant' as const, content: params.text },
            ],
            audio: { format, voice },
        }

        const requestOptions = this.buildRequestOptions(params.signal)

        const response = await this.client.chat.completions.create(
            ttsBody as unknown as ChatCompletionCreateParamsNonStreaming,
            requestOptions,
        )
        const audioData = (response.choices[0]?.message as unknown as {
            audio?: { data?: unknown } | null
        } | undefined)?.audio?.data
        if (typeof audioData !== 'string') {
            throw new Error('MiMo TTS 响应缺少 choices[0].message.audio.data')
        }
        const audio = decodeBoundedTtsAudioData(audioData, format)

        const latencyMs = Date.now() - startTime
        // TTS 限时免费，durationMs 仅用于观测（基于文本长度粗略估算）
        // 中文约 4 字/秒，英文约 2.5 词/秒，此处取混合估算
        const estimatedDurationMs = Math.max(latencyMs, params.text.length * 250)

        return {
            audio,
            format,
            durationMs: estimatedDurationMs,
        }
    }

    // ─────────────────────────────────────────────────────────
    // 语音识别（ASR）
    // ─────────────────────────────────────────────────────────

    /**
     * 语音识别
     *
     * 官方契约：POST /v1/chat/completions，音频以 data URI 放进
     * user.content[].input_audio.data，时长读取 usage.seconds。
     *
     * 计费：0.5 元/小时音频 = 0.5/3600 元/秒
     */
    async asr(params: MimoAsrParams): Promise<{
        text: string
        durationSec: number
        confidence?: number
    }> {
        this.assertConfigured()
        // 将输入音频统一转为 Buffer
        const resolvedAudio = await this.resolveAudioInput(
            params.audio,
            params.audioMimeType,
            params.audioFilename,
        )

        if (resolvedAudio.inspected.extension !== 'mp3' && resolvedAudio.inspected.extension !== 'wav') {
            throw new Error('MiMo ASR 官方接口仅接受 MP3 或 WAV 音频')
        }
        const encodedAudio = resolvedAudio.buffer.toString('base64')
        const maxEncodedAudioBytes = 10 * 1024 * 1024
        if (Buffer.byteLength(encodedAudio, 'ascii') > maxEncodedAudioBytes) {
            throw new Error(`MiMo ASR base64 音频不得超过 ${maxEncodedAudioBytes} 字节`)
        }
        const dataUri = `data:${resolvedAudio.inspected.contentType};base64,${encodedAudio}`
        const asrBody = {
            model: params.model,
            messages: [{
                role: 'user' as const,
                content: [{
                    type: 'input_audio',
                    input_audio: { data: dataUri },
                }],
            }],
            asr_options: { language: params.language ?? 'auto' },
        }

        const requestOptions = this.buildRequestOptions(params.signal)

        const completion = await this.client.chat.completions.create(
            asrBody as unknown as ChatCompletionCreateParamsNonStreaming,
            requestOptions,
        )
        const content = completion.choices[0]?.message.content
        const text = typeof content === 'string' ? content.trim() : ''
        if (!text) {
            throw new Error('MiMo ASR 响应缺少识别文本')
        }
        const seconds = (completion.usage as unknown as { seconds?: unknown } | undefined)?.seconds
        const durationSec = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
            ? seconds
            : 0

        return { text, durationSec }
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    /**
     * 构建文本对话请求参数
     */
    private buildTextRequestParams(
        params: MimoTextParams,
        thinking: TextThinkingMode,
        stream: boolean,
    ): MimoCompletionParams | MimoStreamingParams {
        // 边界必须在 SDK 调用前再校验一次：不信任路由或 Agent 已经做过检查。
        this.assertSupportedImageReferences(params.messages, params.images)

        // 将 images 注入到最后一条 user 消息的 content 中
        const messages = params.images && params.images.length > 0
            ? this.injectImages(params.messages, params.images)
            : params.messages.map((m) => this.mapMessage(m))

        const base: Record<string, unknown> = {
            model: params.model,
            messages,
            max_completion_tokens: params.maxTokens ?? 4096,
            thinking: { type: 'enabled' },
        }

        // 官方说明：思考开启时 temperature/top_p 会被强制覆盖为推荐值。
        // 不发送虚假的“可调采样参数”，避免界面设置与真实模型行为不一致。
        void params.temperature
        void thinking

        // 工具定义
        if (params.tools && params.tools.length > 0) {
            base.tools = params.tools.map((t) => ({
                type: 'function',
                function: {
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters,
                },
            }))
        }

        if (stream) {
            base.stream = true
            base.stream_options = { include_usage: true }
            return base as unknown as MimoStreamingParams
        }

        return base as unknown as MimoCompletionParams
    }

    /**
     * 将图片注入到最后一条 user 消息中（多模态）
     * mimo-v2.5 的 content 为 [{type:'text',text:...},{type:'image_url',image_url:{url:...}}] 数组
     */
    private injectImages(
        messages: ChatMessage[],
        images: Array<{ url: string; detail?: 'auto' | 'low' | 'high' }>,
    ): ChatCompletionMessageParam[] {
        const mapped = messages.map((m) => this.mapMessage(m))
        if (mapped.length === 0) return mapped

        // 找到最后一条 user 消息并注入图片
        const lastIndex = mapped.length - 1
        const lastMsg = mapped[lastIndex]
        if (!lastMsg) return mapped
        if (lastMsg.role === 'user') {
            // 将 content 转为多模态格式
            const textContent = typeof lastMsg.content === 'string'
                ? lastMsg.content
                : ''
            const contentParts: ContentPart[] = []
            if (textContent) {
                contentParts.push({ type: 'text', text: textContent })
            }
            for (const img of images) {
                contentParts.push({
                    type: 'image_url',
                    image_url: { url: img.url, detail: img.detail ?? 'auto' },
                })
            }
            // 覆盖最后一条消息的 content
            mapped[lastIndex] = {
                role: 'user',
                content: contentParts,
            } as ChatCompletionMessageParam
        }

        return mapped
    }

    /**
     * 构建请求选项
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
        if (msg.role === 'tool') {
            return {
                role: 'tool',
                tool_call_id: msg.tool_call_id ?? '',
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            }
        }

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

        return {
            role: msg.role,
            content: msg.content,
        } as ChatCompletionMessageParam
    }

    /**
     * 从响应消息中提取思考过程
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
            function: { name: tc.function.name, arguments: tc.function.arguments },
        }))
    }

    /**
     * 将音频输入统一转为 Buffer
     * 支持受控 Buffer / base64 字符串；URL 必须在业务边界下载并验证后转 Buffer。
     */
    private async resolveAudioInput(
        audio: Buffer | string,
        declaredMimeType?: string,
        declaredFilename?: string,
    ): Promise<{ buffer: Buffer; inspected: InspectedAudio }> {
        // 官方上限按 base64 编码后的数据计算，因此原始音频先限制在 7.5 MiB，
        // 并在构造 data URI 前再次核对实际编码长度。
        const MAX_AUDIO_BYTES = Math.floor((10 * 1024 * 1024) * 3 / 4)
        let resolved: Buffer
        let dataUriMimeType: string | undefined
        if (Buffer.isBuffer(audio)) {
            resolved = audio
        } else {
            if (/^https?:\/\//iu.test(audio)) {
                throw new Error('ASR 音频 URL 已禁用：请在受控业务边界验证后传入 Buffer')
            }
            const dataMatch = audio.match(/^data:(audio\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/u)
            dataUriMimeType = dataMatch?.[1]
            const base64Data = dataMatch?.[2] ?? audio
            if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(base64Data) || base64Data.length % 4 !== 0) {
                throw new Error('ASR 音频必须是有效的 base64 或 audio data URI')
            }
            resolved = Buffer.from(base64Data, 'base64')
        }
        if (resolved.length === 0 || resolved.length > MAX_AUDIO_BYTES) {
            throw new Error(`ASR 音频大小必须为 1-${MAX_AUDIO_BYTES} 字节`)
        }
        if (declaredMimeType && dataUriMimeType
            && normalizeMime(declaredMimeType) !== normalizeMime(dataUriMimeType)) {
            throw new Error('ASR 显式 MIME 与 data URI MIME 不一致')
        }
        const inspected = inspectAudioBytes(resolved, declaredMimeType ?? dataUriMimeType)
        if (declaredFilename) {
            assertFilenameMatchesAudio(declaredFilename, inspected.extension)
        }
        return { buffer: resolved, inspected }
    }

    /** 缺少密钥时必须在文件封装与 SDK/网络调用之前失败。 */
    private assertConfigured(): void {
        if (this.apiKey.length === 0) {
            throw new Error('MiMo API 密钥未配置')
        }
    }

    private assertSupportedImageReferences(
        messages: ChatMessage[],
        images?: Array<{ url: string; detail?: 'auto' | 'low' | 'high' }>,
    ): void {
        const references = [
            ...(images ?? []).map((image) => image.url),
            ...messages.flatMap((message) => Array.isArray(message.content)
                ? message.content
                    .filter((part) => part.type === 'image_url')
                    .map((part) => part.image_url.url)
                : []),
        ]
        if (references.some((reference) => !isSupportedModelImageReference(reference))) {
            throw new Error('拒绝非受控图片引用：MiMo 只接受魔数匹配的内联图片或 DashScope OSS 白名单地址')
        }
    }
}

function normalizeMimoVoice(value: string | undefined): string {
    const voice = value?.trim()
    if (!voice || voice === 'alloy' || voice === 'default') {
        return 'mimo_default'
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(voice)) {
        throw new Error('MiMo TTS 音色 ID 格式无效')
    }
    return voice
}

function buildMimoTtsStyleInstruction(speed: number | undefined): string | undefined {
    if (speed === undefined || speed === 1) return undefined
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
        throw new Error('MiMo TTS 语速必须为 0.5-2.0')
    }
    return `请以约 ${speed.toFixed(2)} 倍语速，清晰、自然地朗读下一条 assistant 消息。`
}

function normalizeMime(value: string): string {
    return value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function assertFilenameMatchesAudio(filename: string, expectedExtension: InspectedAudio['extension']): void {
    if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
        throw new Error('ASR 音频文件名不得包含路径或空字节')
    }
    const extension = filename.trim().toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1]
    if (!extension || extension !== expectedExtension) {
        throw new Error(`ASR 文件扩展名与真实音频格式不一致（扩展名 ${extension ?? '缺失'}，实际 ${expectedExtension}）`)
    }
}
