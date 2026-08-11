/**
 * LLM 抽象层 barrel export
 *
 * 统一导出所有类型、客户端、路由器、计费与错误恢复组件。
 * 初始化全局单例，供应用其他模块直接引用。
 */

import { config } from '../config.js'
import { onCredentialChange } from '../lib/credentials.js'
import { DeepSeekClient } from './deepseek-client.js'
import { MiMoClient } from './mimo-client.js'
import { TokenBilling } from './billing.js'
import { ErrorRecovery } from './error-recovery.js'
import { LLMRouter } from './router.js'
import { ManagedLLMGateway } from './managed-gateway.js'
import { ProviderRateLimiter } from './rate-limiter.js'

// ─────────────────────────────────────────────────────────────
// 类型导出
// ─────────────────────────────────────────────────────────────

export type {
    Role,
    TextContentPart,
    ImageContentPart,
    ContentPart,
    ChatMessage,
    Tool,
    ToolCall,
    ThinkingMode,
    TextThinkingMode,
    CallMetadata,
    ChatChunk,
    Domain,
    Function,
    RouteDecision,
    ExecuteParams,
    LLMResult,
} from './types.js'

export type {
    DeepSeekModel,
    DeepSeekCallParams,
    DeepSeekResult,
} from './deepseek-client.js'

export type {
    MimoTextModel,
    MimoTtsModel,
    MimoAsrModel,
    MimoTextParams,
    MimoTextResult,
    MimoTtsParams,
    MimoAsrParams,
} from './mimo-client.js'

export type {
    BillingRecord,
    BillingSummary,
    SessionBillingAggregate,
} from './billing.js'

export type {
    LLMError,
    ErrorLayer,
    ErrorType,
    WrapOptions,
} from './error-recovery.js'

export type { RateLimitProvider } from './rate-limiter.js'
export { ProviderRateLimiter, RateLimitTimeoutError, toRateLimitProvider, TokenBucket, Semaphore } from './rate-limiter.js'
export type {
    ManagedGatewayOptions,
    ManagedTextParams,
    ManagedTextResult,
    ManagedDeepSeekModel,
    ManagedMimoTextModel,
} from './managed-gateway.js'

// ─────────────────────────────────────────────────────────────
// 类导出
// ─────────────────────────────────────────────────────────────

export { DeepSeekClient } from './deepseek-client.js'
export { MiMoClient } from './mimo-client.js'
export { TokenBilling } from './billing.js'
export { ErrorRecovery } from './error-recovery.js'
export { LLMRouter } from './router.js'
export { ManagedLLMGateway } from './managed-gateway.js'

// ─────────────────────────────────────────────────────────────
// 全局单例
// ─────────────────────────────────────────────────────────────

/**
 * DeepSeek 客户端单例
 * 使用 config.deepseek.apiKey 与 config.deepseek.baseUrl 初始化
 */
export const deepseek = new DeepSeekClient(config.deepseek.apiKey, config.deepseek.baseUrl)

/**
 * MiMo 客户端单例
 * 使用 config.mimo.apiKey 与 config.mimo.baseUrl 初始化
 */
export const mimo = new MiMoClient(config.mimo.apiKey, config.mimo.baseUrl)

/**
 * 订阅密钥变更：教师在设置面板保存新密钥后，立即重建对应客户端的连接实例。
 *
 * 放在此处而不是 credentials 模块内部，是为了避免 credentials → llm 的反向依赖：
 * credentials 只负责「存」与「广播」，具体怎么应用由各消费方自己决定。
 */
onCredentialChange((provider, key) => {
    if (provider === 'deepseek') deepseek.setApiKey(key)
    else if (provider === 'mimo') mimo.setApiKey(key)
    // dashscope 由 services/culture/wan-image.ts 在每次请求时现取，无需重建实例
})

/**
 * Token 计费引擎单例
 * 推送 billing:record 事件供 WebSocket 订阅
 */
// 生产/开发服务的全局计费账本必须落盘；TokenBilling 的独立测试实例仍默认内存隔离。
export const billing = new TokenBilling({ persistent: true })

/**
 * 错误恢复引擎单例
 * 推送 llm:fallback 事件
 */
export const errorRecovery = new ErrorRecovery()

/** Router 与显式模型网关共用同一 provider 级限流器，避免配额被分池超发。 */
export const rateLimiter = new ProviderRateLimiter()

/**
 * LLM 路由器单例
 * 推送 llm:call:start / llm:call:success / llm:call:error / llm:stream:delta 事件
 */
export const router = new LLMRouter(deepseek, mimo, errorRecovery, billing, rateLimiter)

/**
 * 服务层显式模型调用入口。模型与思考档不被重写，事件汇入 Router 现有总线。
 */
export const managedLLM = new ManagedLLMGateway(
    deepseek,
    mimo,
    errorRecovery,
    billing,
    rateLimiter,
    { eventSink: router },
)
