/**
 * LLM 路由层 — X-MAS 异构多智能体路由矩阵
 *
 * 按"域（Domain）× 功能（Function）"路由矩阵，将每个智能体任务
 * 分配到最优的模型+思考模式组合。路由决策依据三条原则：
 *
 * 1. X-MAS 异构优先：不同任务使用不同模型族，避免单点瓶颈
 * 2. 模型能力匹配：多模态任务用 mimo-v2.5，深度推理用 v4-pro(max)
 * 3. 价格最优：同类能力下优先选择更经济的模型
 *
 * execute() 方法串联 ErrorRecovery（L1-L5）、TokenBilling、EventEmitter，
 * 构成完整的调用编排链路。
 */

import { EventEmitter } from 'node:events'
import type { DeepSeekClient } from './deepseek-client.js'
import type { MiMoClient } from './mimo-client.js'
import { LLMError, type ErrorRecovery } from './error-recovery.js'
import type { TokenBilling } from './billing.js'
import { ProviderRateLimiter, toRateLimitProvider } from './rate-limiter.js'
import type {
    Domain,
    ExecuteParams,
    Function,
    LLMResult,
    RouteDecision,
    ThinkingMode,
    ChatChunk,
} from './types.js'

// ─────────────────────────────────────────────────────────────
// 路由矩阵定义
// ─────────────────────────────────────────────────────────────

/**
 * 路由矩阵条目
 */
interface RouteEntry {
    provider: 'deepseek' | 'mimo'
    model: string
    thinking?: ThinkingMode
    reason: string
    /**
     * 该路由的输出 token 上限
     *
     * 为什么需要按路由配置：深度思考模式下，推理链本身要吃掉相当一部分输出预算。
     * 客户端默认 4096 对 `thinking: 'max'` + 结构化 JSON 的组合明显不够——
     * 推理没写完就撞上上限，content 返回空串，下游 safeJsonParse 抛出
     * 「LLM 输出非合法 JSON」，看起来像模型幻觉，实际是被截断。
     * max_tokens 是上限而非计费量，调高不会增加正常调用的成本。
     */
    maxTokens?: number
}

/**
 * X-MAS 路由矩阵
 *
 * | Domain        | Function          | Model              | Thinking | Reason             |
 * |---------------|-------------------|--------------------|----------|--------------------|
 * | mind          | diagnose          | deepseek-v4-pro    | max      | 复杂认知诊断需深度推理 |
 * | mind          | profile           | mimo-v2.5-pro      | medium   | 多维画像，需 1M 上下文 |
 * | mind          | recommend         | deepseek-v4-flash  | medium   | 推荐路径规则化        |
 * | mind          | verify            | deepseek-v4-pro    | high     | 验收需独立深度审核    |
 * | eye           | vision-annotate   | mimo-v2.5          | high     | 必须多模态           |
 * | eye           | asr               | mimo-v2.5-asr      | —        | 语音识别专用         |
 * | eye           | tts               | mimo-v2.5-tts      | —        | 语音合成专用         |
 * | brush         | generate-question | deepseek-v4-pro    | max      | 命题需创造性深度思考   |
 * | brush         | grade             | deepseek-v4-flash  | low      | 批改追求速度         |
 * | brush         | report            | deepseek-v4-pro    | high     | 报告需综合分析       |
 * | brush         | creative          | deepseek-v4-flash  | medium   | 创意素材            |
 * | orchestrator  | route             | deepseek-v4-flash  | low      | 路由决策快          |
 * | orchestrator  | summarize         | deepseek-v4-flash  | low      | 摘要               |
 * | verifier      | verify            | deepseek-v4-pro    | high     | 独立验收            |
 */
const ROUTE_MATRIX: Record<string, RouteEntry> = {
    // mind 域（诗心 — 认知）
    'mind:diagnose': {
        provider: 'deepseek', model: 'deepseek-v4-pro', thinking: 'max',
        reason: '复杂认知诊断需深度推理，使用 v4-pro + max 思考模式',
        maxTokens: 16384,
    },
    'mind:profile': {
        provider: 'mimo', model: 'mimo-v2.5-pro', thinking: 'medium',
        reason: '多维学情画像需 1M 上下文，mimo-v2.5-pro 性价比最优',
    },
    'mind:recommend': {
        provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'medium',
        reason: '推荐路径规则化，flash 模型速度与成本均衡',
    },
    'mind:verify': {
        provider: 'deepseek', model: 'deepseek-v4-pro', thinking: 'high',
        reason: '验收需独立深度审核，v4-pro + high 确保严谨',
        maxTokens: 12288,
    },

    // eye 域（诗眼 — 多模态）
    'eye:vision-annotate': {
        provider: 'mimo', model: 'mimo-v2.5', thinking: 'high',
        reason: '视觉标注必须多模态，mimo-v2.5 是唯一支持图片输入的模型',
        maxTokens: 8192,
    },
    'eye:asr': {
        provider: 'mimo', model: 'mimo-v2.5-asr',
        reason: '语音识别专用模型，按时长计费 0.5 元/小时',
    },
    'eye:tts': {
        provider: 'mimo', model: 'mimo-v2.5-tts',
        reason: '语音合成专用模型，限时免费',
    },

    // brush 域（诗笔 — 生成）
    'brush:generate-question': {
        provider: 'deepseek', model: 'deepseek-v4-pro', thinking: 'max',
        reason: '命题需创造性深度思考，v4-pro + max 确保题目质量',
        // 一次最多出 20 道题，每题含题干/选项/答案/解析/干扰项分析，
        // 叠加 max 档推理链，4096 会被推理吃光导致 content 为空。
        maxTokens: 24576,
    },
    'brush:grade': {
        provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'low',
        reason: '批改追求速度，flash + low 思考模式响应最快',
    },
    'brush:report': {
        provider: 'deepseek', model: 'deepseek-v4-pro', thinking: 'high',
        reason: '报告需综合分析，v4-pro + high 确保深度',
        maxTokens: 24576,
    },
    'brush:creative': {
        provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'medium',
        reason: '创意素材生成，flash 模型性价比最优',
    },

    // orchestrator 域（编排）
    'orchestrator:route': {
        provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'low',
        reason: '路由决策需快速响应，flash + low 延迟最低',
    },
    'orchestrator:summarize': {
        provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'low',
        reason: '摘要任务规则化，flash + low 足够',
    },

    // verifier 域（验收）
    'verifier:verify': {
        provider: 'deepseek', model: 'deepseek-v4-pro', thinking: 'high',
        reason: '独立验收需深度审核，v4-pro + high 确保客观严谨',
        maxTokens: 12288,
    },
}

/** 功能类型分类 */
type FunctionCategory = 'text' | 'tts' | 'asr' | 'vision'

/**
 * 判断功能类别
 */
function categorizeFunction(fn: Function): FunctionCategory {
    if (fn === 'tts') return 'tts'
    if (fn === 'asr') return 'asr'
    if (fn === 'vision-annotate') return 'vision'
    return 'text'
}

// ─────────────────────────────────────────────────────────────
// 事件载荷类型
// ─────────────────────────────────────────────────────────────

interface CallStartPayload {
    domain: Domain
    function: Function
    provider: string
    model: string
    thinking?: ThinkingMode
    agent: string
    task: string
    /** P4：路由透明 —— 透传 sessionId 供前端按会话过滤 */
    sessionId?: string
    timestamp: number
}

interface CallSuccessPayload {
    domain: Domain
    function: Function
    provider: string
    model: string
    latencyMs: number
    costYuan: number
    fallback: boolean
    /** P4：路由透明 —— 透传 sessionId 供前端按会话过滤 */
    sessionId?: string
    timestamp: number
}

interface CallErrorPayload {
    domain: Domain
    function: Function
    provider: string
    model: string
    error: string
    errorType: string
    /** P4：路由透明 —— 透传 sessionId 供前端按会话过滤 */
    sessionId?: string
    timestamp: number
}

interface StreamDeltaPayload {
    domain: Domain
    function: Function
    chunk: unknown
    timestamp: number
}

// ─────────────────────────────────────────────────────────────
// LLMRouter
// ─────────────────────────────────────────────────────────────

/**
 * LLM 路由器
 *
 * 继承 EventEmitter，推送以下事件：
 * - llm:call:start    — 调用开始
 * - llm:call:success  — 调用成功
 * - llm:call:error    — 调用失败
 * - llm:stream:delta  — 流式分片
 */
export class LLMRouter extends EventEmitter {
    /** 主动限流闸门（按 provider 双限：令牌桶 RPM + 信号量并发） */
    private readonly rateLimiter: ProviderRateLimiter

    /**
     * 全局思考模式覆盖（v5.0 创新点：深度思考模式 UI 暴露）
     *
     * 由前端 ThinkingModeSwitcher 控制，通过 POST /api/copilot/thinking-mode 写入。
     * - undefined：使用路由矩阵中各任务预设的 thinking（默认行为）
     * - 'low' / 'medium' / 'high'：覆盖所有任务的 thinking，模型保持路由矩阵预设
     * - 'max'：文本任务强制使用 deepseek-v4-pro；视觉任务保持 mimo-v2.5，
     *   并使用它所支持的最高 high 档，避免把图片误送到纯文本模型
     *
     * 约束（大模型API文档.md）：
     * - max 模式仅 deepseek-v4-pro 支持，其他模型调用 max 会抛出校验错误
     * - low/medium/high 任意模型均支持
     * - mimo-v2.5-tts / mimo-v2.5-asr 不支持思考模式（专有模型），覆盖时不影响
     */
    private globalThinkingMode: ThinkingMode | undefined = undefined

    constructor(
        private deepseek: DeepSeekClient,
        private mimo: MiMoClient,
        private errorRecovery: ErrorRecovery,
        private billing: TokenBilling,
        rateLimiter: ProviderRateLimiter = new ProviderRateLimiter(),
    ) {
        super()
        this.rateLimiter = rateLimiter
    }

    /**
     * 设置全局思考模式覆盖
     *
     * @param mode 思考模式：'low' | 'medium' | 'high' | 'max'，传入 undefined 清除覆盖
     * @throws 当 mode='max' 但 deepseek 客户端不可用时抛出错误（理论上 deepseek 始终存在）
     */
    setThinkingMode(mode: ThinkingMode | undefined): void {
        if (mode === 'max') {
            // max 模式仅 deepseek-v4-pro 支持，此处仅做存在性校验
            // 实际模型校验由 deepseek-client.ts validateThinking() 在调用时执行
            if (!this.deepseek) {
                throw new Error('max 思考模式需要 deepseek 客户端支持，但当前未初始化')
            }
        }
        this.globalThinkingMode = mode
        // 发射事件供前端 WS 订阅（thinking-mode:changed）
        this.emit('thinking-mode:changed', { mode, timestamp: Date.now() })
    }

    /**
     * 获取当前全局思考模式覆盖
     * @returns 当前模式，undefined 表示未覆盖（使用路由矩阵预设）
     */
    getThinkingMode(): ThinkingMode | undefined {
        return this.globalThinkingMode
    }

    /**
     * 路由决策：根据 domain × function 解析最优模型
     *
     * 当 globalThinkingMode 被设置时，应用覆盖规则：
     * - 覆盖 thinking 为全局模式
     * - 若 mode='max'，纯文本任务强制 provider='deepseek' / model='deepseek-v4-pro'
     * - 视觉任务始终锁定 mimo-v2.5；请求 max 时降级为该模型最高支持的 high
     * - TTS/ASR 专有模型不受 thinking 覆盖影响（无 thinking 字段）
     */
    resolve(domain: Domain, fn: Function): RouteDecision {
        const key = `${domain}:${fn}`
        const entry = ROUTE_MATRIX[key]

        if (!entry) {
            throw new Error(`路由矩阵未覆盖: ${key}，请检查 domain/function 组合`)
        }

        // 未设置全局覆盖：使用路由矩阵预设
        if (this.globalThinkingMode === undefined) {
            return {
                provider: entry.provider,
                model: entry.model,
                thinking: entry.thinking,
                reason: entry.reason,
                maxTokens: entry.maxTokens,
            }
        }

        // TTS/ASR 专有模型不支持 thinking，直接返回原决策
        if (entry.thinking === undefined) {
            return {
                provider: entry.provider,
                model: entry.model,
                thinking: undefined,
                reason: `${entry.reason}（专有模型，不受全局思考模式覆盖）`,
                maxTokens: entry.maxTokens,
            }
        }

        // 全局覆盖 thinking
        const overrideMode = this.globalThinkingMode

        // mimo-v2.5 是唯一支持图片输入的模型；DeepSeek v4 全系列均为纯文本。
        // 因此全局 max 不能改写视觉任务的 provider/model，否则非流式路径会出现
        // “真实调用 MiMo，但事件/限流/计费/fallback 记录 DeepSeek”的分裂，流式路径
        // 更会直接把图片丢失后误送 DeepSeek。视觉请求按 MiMo 最高支持的 high 执行。
        if (overrideMode === 'max' && categorizeFunction(fn) === 'vision') {
            return {
                provider: entry.provider,
                model: entry.model,
                thinking: 'high',
                reason: `${entry.reason}｜全局请求 max；视觉能力锁定 mimo-v2.5，按其最高支持档位 high 执行`,
                maxTokens: entry.maxTokens,
            }
        }

        // 文本任务的 max 模式强制使用 deepseek-v4-pro（唯一支持 max 的模型）
        if (overrideMode === 'max') {
            return {
                provider: 'deepseek',
                model: 'deepseek-v4-pro',
                thinking: 'max',
                reason: `${entry.reason}｜全局覆盖：max 思考模式强制使用 deepseek-v4-pro`,
                // 全局切到 max 档时推理链更长，至少给 16K 输出预算，
                // 避免教师把思考模式调高反而让所有结构化输出全线失败。
                maxTokens: Math.max(entry.maxTokens ?? 0, 16384),
            }
        }

        // low/medium/high 覆盖 thinking，保持原模型
        return {
            provider: entry.provider,
            model: entry.model,
            thinking: overrideMode,
            reason: `${entry.reason}｜全局覆盖：${overrideMode} 思考模式`,
            maxTokens: entry.maxTokens,
        }
    }

    /**
     * 执行 LLM 调用
     *
     * 完整编排链路：
     * 1. resolve() 路由决策
     * 2. 发射 llm:call:start 事件
     * 3. errorRecovery.wrap() 包装调用（L1 重试 + L5 降级）
     * 4. 按 provider + category 调用对应 client
     * 5. L4 死循环检测
     * 6. billing.record() 计费
     * 7. 发射 llm:call:success / llm:call:error 事件
     */
    async execute(domain: Domain, fn: Function, params: ExecuteParams): Promise<LLMResult> {
        const decision = this.resolve(domain, fn)
        const category = categorizeFunction(fn)
        const meta = params.metadata ?? { agent: domain, task: fn }
        const startTime = Date.now()

        // 主动限流闸门：等待令牌桶+信号量（超时抛出 RateLimitTimeoutError）
        const release = await this.rateLimiter.acquire(toRateLimitProvider(decision), params.signal)

        // 发射调用开始事件
        this.emit('llm:call:start', {
            domain,
            function: fn,
            provider: decision.provider,
            model: decision.model,
            thinking: decision.thinking,
            agent: meta.agent,
            task: meta.task,
            sessionId: meta.sessionId,
            timestamp: startTime,
        } satisfies CallStartPayload)

        try {
            // 通过 ErrorRecovery 包装实际调用
            const result = await this.errorRecovery.wrap(
                async () => {
                    return this.invokeClient(decision, category, params)
                },
                {
                    agent: meta.agent,
                    task: meta.task,
                    maxRetries: 3,
                    onRetry: (err, attempt) => {
                        // 重试时也发射事件（可选，供观测）
                        this.emit('llm:call:error', {
                            domain,
                            function: fn,
                            provider: decision.provider,
                            model: decision.model,
                            error: `重试 ${attempt}: ${err.message}`,
                            errorType: err.type,
                            sessionId: meta.sessionId,
                            timestamp: Date.now(),
                        } satisfies CallErrorPayload)
                    },
                    // L5 降级：返回标注了"降级模式"的 fallback 内容
                    fallback: () => {
                        const fallbackContent = this.errorRecovery.getFallback(domain, fn)
                        const fallbackResult: LLMResult = {
                            content: fallbackContent,
                            usage: { promptTokens: 0, completionTokens: 0 },
                            latencyMs: Date.now() - startTime,
                            model: decision.model,
                            provider: decision.provider,
                            fallback: true,
                        }
                        return fallbackResult
                    },
                    signal: params.signal,
                },
            )

            // L4 死循环检测
            if (!result.fallback) {
                this.errorRecovery.trackOutput(
                    meta.agent,
                    meta.task,
                    result.content,
                    result.toolCalls?.map((tc) => tc.function.name).join(','),
                )
            }

            // 计费记录
            const billingRec = this.billing.record({
                agent: meta.agent,
                task: meta.task,
                sessionId: meta.sessionId,
                provider: decision.provider,
                model: decision.model,
                promptTokens: result.usage.promptTokens,
                completionTokens: result.usage.completionTokens,
                cachedTokens: result.usage.cachedTokens,
                audioDurationSec: result.audioDurationSec,
                latencyMs: result.latencyMs,
                success: true,
                fallback: result.fallback,
            })

            // 发射调用成功事件
            this.emit('llm:call:success', {
                domain,
                function: fn,
                provider: decision.provider,
                model: decision.model,
                latencyMs: result.latencyMs,
                costYuan: billingRec.costYuan,
                fallback: result.fallback ?? false,
                sessionId: meta.sessionId,
                timestamp: Date.now(),
            } satisfies CallSuccessPayload)

            return result
        } catch (err) {
            // 发射调用错误事件
            const errorMessage = err instanceof Error ? err.message : String(err)
            const errorType = 'unknown'
            this.emit('llm:call:error', {
                domain,
                function: fn,
                provider: decision.provider,
                model: decision.model,
                error: errorMessage,
                errorType,
                sessionId: meta.sessionId,
                timestamp: Date.now(),
            } satisfies CallErrorPayload)

            // 失败也记录计费（success: false）
            this.billing.record({
                agent: meta.agent,
                task: meta.task,
                sessionId: meta.sessionId,
                provider: decision.provider,
                model: decision.model,
                promptTokens: 0,
                completionTokens: 0,
                latencyMs: Date.now() - startTime,
                success: false,
            })

            throw err
        } finally {
            // 释放限流并发槽位（令牌桶令牌不返还）
            release()
        }
    }

    /**
     * 流式执行 LLM 调用
     *
     * 与 execute 类似，但返回 AsyncGenerator 逐分片产出
     * 每个分片同时通过 llm:stream:delta 事件推送
     */
    async *executeStream(domain: Domain, fn: Function, params: ExecuteParams): AsyncGenerator<ChatChunk> {
        const decision = this.resolve(domain, fn)
        const meta = params.metadata ?? { agent: domain, task: fn }
        const startTime = Date.now()
        const linked = linkAbortSignal(params.signal)
        let release: (() => void) | undefined
        let completed = false
        let terminalRecorded = false
        let usage: ChatChunk['usage'] = { promptTokens: 0, completionTokens: 0 }

        this.emit('llm:call:start', {
            domain,
            function: fn,
            provider: decision.provider,
            model: decision.model,
            thinking: decision.thinking,
            agent: meta.agent,
            task: meta.task,
            sessionId: meta.sessionId,
            timestamp: startTime,
        } satisfies CallStartPayload)

        try {
            // 先创建可由消费者 return() 主动中止的关联信号，再等待主动限流许可。
            // 流式调用不可透明重放：任一分片交付后重试都会造成重复正文。
            release = await this.rateLimiter.acquire(
                toRateLimitProvider(decision),
                linked.controller.signal,
            )
            const stream = decision.provider === 'deepseek'
                ? this.deepseek.stream({
                    model: decision.model as 'deepseek-v4-pro' | 'deepseek-v4-flash',
                    messages: params.messages ?? [],
                    thinking: decision.thinking,
                    temperature: params.temperature,
                    maxTokens: params.maxTokens ?? decision.maxTokens,
                    jsonOutput: params.jsonOutput,
                    tools: params.tools,
                    signal: linked.controller.signal,
                    metadata: meta,
                })
                : this.mimo.streamChat({
                    model: decision.model as 'mimo-v2.5' | 'mimo-v2.5-pro',
                    messages: params.messages ?? [],
                    images: params.images,
                    thinking: decision.thinking as 'low' | 'medium' | 'high' | undefined,
                    temperature: params.temperature,
                    maxTokens: params.maxTokens ?? decision.maxTokens,
                    tools: params.tools,
                    signal: linked.controller.signal,
                    metadata: meta,
                })

            for await (const chunk of stream) {
                if (chunk.usage) usage = { ...chunk.usage }
                // 事件桥会把该事件转发给 WebSocket；这里只能记录分片形态，
                // 不能复制正文、工具参数或供应商私有 reasoning。
                this.emit('llm:stream:delta', {
                    domain,
                    function: fn,
                    chunk: {
                        hasContent: Boolean(chunk.content),
                        hasReasoning: Boolean(chunk.reasoning),
                        toolCallCount: chunk.toolCalls?.length ?? 0,
                        done: chunk.done ?? false,
                        hasUsage: Boolean(chunk.usage),
                    },
                    timestamp: Date.now(),
                } satisfies StreamDeltaPayload)
                yield chunk
            }

            completed = true
            // 在任何可能抛错的计费/事件监听器之前锁定唯一终态，避免成功后又补记失败。
            terminalRecorded = true
            const latencyMs = Date.now() - startTime
            const billingRecord = this.billing.record({
                agent: meta.agent,
                task: meta.task,
                sessionId: meta.sessionId,
                provider: decision.provider,
                model: decision.model,
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                cachedTokens: usage.cachedTokens,
                latencyMs,
                success: true,
                fallback: false,
            })
            this.emit('llm:call:success', {
                domain,
                function: fn,
                provider: decision.provider,
                model: decision.model,
                latencyMs,
                costYuan: billingRecord.costYuan,
                fallback: false,
                sessionId: meta.sessionId,
                timestamp: Date.now(),
            } satisfies CallSuccessPayload)
        } catch (err) {
            if (!terminalRecorded) {
                terminalRecorded = true
                this.recordStreamFailure(domain, fn, decision, meta, startTime, err)
            }
            throw err
        } finally {
            // 释放限流并发槽位（令牌桶令牌不返还）
            release?.()
            if (!completed) linked.controller.abort('stream-consumer-closed')
            linked.cleanup()
            // 消费者 break/return 不经过 catch；必须形成失败账单和唯一错误终态。
            if (!completed && !terminalRecorded) {
                terminalRecorded = true
                this.recordStreamFailure(
                    domain,
                    fn,
                    decision,
                    meta,
                    startTime,
                    new LLMError('L1', 'network', '流式模型调用被提前终止', false),
                )
            }
        }
    }

    private recordStreamFailure(
        domain: Domain,
        fn: Function,
        decision: RouteDecision,
        meta: { agent: string; task: string; sessionId?: string },
        startTime: number,
        error: unknown,
    ): void {
        const classified = this.errorRecovery.classifyError(error)
        const publicMessage: Record<typeof classified.type, string> = {
            network: classified.retryable ? '模型流式网络异常' : '模型流式调用已中止',
            'rate-limit': '模型服务繁忙，请稍后重试',
            param: '模型流式调用参数不符合供应商约束',
            server: '模型流式服务暂时不可用，请稍后重试',
            tool: '模型流式工具调用失败',
            loop: '模型流式输出未收敛，调用已停止',
            unknown: '模型流式调用失败',
        }
        this.billing.record({
            agent: meta.agent,
            task: meta.task,
            sessionId: meta.sessionId,
            provider: decision.provider,
            model: decision.model,
            promptTokens: 0,
            completionTokens: 0,
            latencyMs: Date.now() - startTime,
            success: false,
        })
        this.emit('llm:call:error', {
            domain,
            function: fn,
            provider: decision.provider,
            model: decision.model,
            error: publicMessage[classified.type],
            errorType: classified.type,
            sessionId: meta.sessionId,
            timestamp: Date.now(),
        } satisfies CallErrorPayload)
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    /**
     * 按 provider + category 调用对应 client
     */
    private async invokeClient(
        decision: RouteDecision,
        category: FunctionCategory,
        params: ExecuteParams,
    ): Promise<LLMResult> {
        const startTime = Date.now()

        switch (category) {
            case 'tts':
                return this.invokeTts(decision, params, startTime)
            case 'asr':
                return this.invokeAsr(decision, params, startTime)
            case 'vision':
                return this.invokeVision(decision, params, startTime)
            case 'text':
            default:
                return this.invokeText(decision, params, startTime)
        }
    }

    /**
     * 调用文本模型（DeepSeek / MiMo 文本）
     */
    private async invokeText(
        decision: RouteDecision,
        params: ExecuteParams,
        _startTime: number,
    ): Promise<LLMResult> {
        if (decision.provider === 'deepseek') {
            const result = await this.deepseek.chat({
                model: decision.model as 'deepseek-v4-pro' | 'deepseek-v4-flash',
                messages: params.messages ?? [],
                thinking: decision.thinking,
                temperature: params.temperature,
                maxTokens: params.maxTokens ?? decision.maxTokens,
                jsonOutput: params.jsonOutput,
                tools: params.tools,
                signal: params.signal,
                metadata: params.metadata,
            })

            return {
                content: result.content,
                reasoning: result.reasoning,
                toolCalls: result.toolCalls,
                usage: result.usage,
                latencyMs: result.latencyMs,
                model: result.model,
                provider: 'deepseek',
            }
        }

        // MiMo 文本模型
        const result = await this.mimo.chat({
            model: decision.model as 'mimo-v2.5' | 'mimo-v2.5-pro',
            messages: params.messages ?? [],
            thinking: decision.thinking as 'low' | 'medium' | 'high' | undefined,
            temperature: params.temperature,
            maxTokens: params.maxTokens ?? decision.maxTokens,
            tools: params.tools,
            signal: params.signal,
            metadata: params.metadata,
        })

        return {
            content: result.content,
            reasoning: result.reasoning,
            toolCalls: result.toolCalls,
            usage: result.usage,
            latencyMs: result.latencyMs,
            model: result.model,
            provider: 'mimo',
        }
    }

    /**
     * 调用视觉标注（mimo-v2.5 多模态）
     */
    private async invokeVision(
        decision: RouteDecision,
        params: ExecuteParams,
        _startTime: number,
    ): Promise<LLMResult> {
        // 防御性能力断言：视觉请求只能由官方规则指定的多模态 mimo-v2.5 处理。
        // 一旦路由决策被未来改动破坏，应在供应商调用前明确失败，不能静默出现
        // “调用模型”和事件/计费模型不一致。
        if (decision.provider !== 'mimo' || decision.model !== 'mimo-v2.5') {
            throw new Error(
                `视觉路由能力约束被破坏：期望 mimo/mimo-v2.5，实际 ${decision.provider}/${decision.model}`,
            )
        }
        if (decision.thinking === 'max') {
            throw new Error('视觉路由能力约束被破坏：mimo-v2.5 不支持 max 思考模式')
        }

        const result = await this.mimo.chat({
            model: decision.model,
            messages: params.messages ?? [],
            images: params.images,
            thinking: decision.thinking,
            temperature: params.temperature,
            maxTokens: params.maxTokens ?? decision.maxTokens,
            signal: params.signal,
            metadata: params.metadata,
        })

        return {
            content: result.content,
            reasoning: result.reasoning,
            toolCalls: result.toolCalls,
            usage: result.usage,
            latencyMs: result.latencyMs,
            model: result.model,
            provider: 'mimo',
        }
    }

    /**
     * 调用 TTS（mimo-v2.5-tts）
     */
    private async invokeTts(
        _decision: RouteDecision,
        params: ExecuteParams,
        startTime: number,
    ): Promise<LLMResult> {
        if (!params.text) {
            throw new Error('TTS 调用需要 text 参数')
        }

        const result = await this.mimo.tts({
            model: 'mimo-v2.5-tts',
            text: params.text,
            voice: params.voice,
            speed: params.speed,
            responseFormat: params.responseFormat,
            signal: params.signal,
            metadata: params.metadata as { agent: string; task: string } | undefined,
        })

        return {
            content: '',
            audio: result.audio,
            audioFormat: result.format,
            usage: { promptTokens: 0, completionTokens: 0 },
            latencyMs: Date.now() - startTime,
            model: 'mimo-v2.5-tts',
            provider: 'mimo',
        }
    }

    /**
     * 调用 ASR（mimo-v2.5-asr）
     */
    private async invokeAsr(
        _decision: RouteDecision,
        params: ExecuteParams,
        startTime: number,
    ): Promise<LLMResult> {
        if (!params.audio) {
            throw new Error('ASR 调用需要 audio 参数')
        }

        const result = await this.mimo.asr({
            model: 'mimo-v2.5-asr',
            audio: params.audio,
            language: params.language,
            prompt: params.prompt,
            signal: params.signal,
            metadata: params.metadata as { agent: string; task: string } | undefined,
        })

        return {
            content: result.text,
            audioDurationSec: result.durationSec,
            confidence: result.confidence,
            usage: { promptTokens: 0, completionTokens: 0 },
            latencyMs: Date.now() - startTime,
            model: 'mimo-v2.5-asr',
            provider: 'mimo',
        }
    }
}

/** 把调用方信号链接到可由 Router 主动中止的内部控制器。 */
function linkAbortSignal(parent?: AbortSignal): {
    controller: AbortController
    cleanup: () => void
} {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(parent?.reason)
    if (parent?.aborted) onAbort()
    else parent?.addEventListener('abort', onAbort, { once: true })
    return {
        controller,
        cleanup: () => parent?.removeEventListener('abort', onAbort),
    }
}
