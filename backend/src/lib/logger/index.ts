/**
 * 统一结构化日志体系 —— 核心工厂（任务 B6.5）
 *
 * 设计目标：
 * 1. 统一 logger 工厂，dev 模式 pretty print，prod 模式 JSON
 * 2. 全局单例 `logger`，供非请求上下文（DB / LLM / 服务层）复用
 * 3. 组件级 child logger（`createComponentLogger('db')` 等）
 * 4. 敏感信息脱敏（基于 Pino redact + 运行时 sanitize）
 * 5. 异步写入（Pino transport 使用 worker thread，不阻塞事件循环）
 * 6. TypeScript 严格模式无错误
 *
 * 日志级别规范（自上而下递减）：
 * - fatal: 服务不可恢复的灾难性错误，需立即人工介入
 *           例：数据库连接丢失、端口被占用导致启动失败
 * - error: 业务流程失败但服务可继续运行
 *           例：LLM 调用最终失败、单条请求 500、Neo4j 关闭异常
 * - warn: 异常但可降级处理的情况
 *           例：Neo4j 不可用降级运行、重试触发、降级模式输出
 * - info: 关键业务事件，生产环境默认输出
 *           例：服务启动、种子数据写入、Agent 调用成功
 * - debug: 详细的内部状态信息，仅开发环境输出
 *           例：SQL 执行细节、路由决策、prompt 构建
 * - trace: 极细粒度的调用链路追踪
 *           例：流式分片内容、HTTP 请求/响应全量
 *
 * 使用方式：
 *   import { logger, createComponentLogger } from '../lib/logger/index.js'
 *   const log = createComponentLogger('db')
 *   log.info({ table: 'students', rowsAffected: 1 }, '学生记录已创建')
 */

import pino, { type Logger, type LoggerOptions } from 'pino'
import { config } from '../../config.js'
import {
    REDACT_PATHS,
    REDACT_CENSOR,
    redactBearerTokensFromUrl,
    sanitize,
} from './sanitize.js'

// ─────────────────────────────────────────────────────────────
// Logger 工厂
// ─────────────────────────────────────────────────────────────

/**
 * 创建 Pino Logger 实例
 *
 * 行为差异：
 * - development / test：pino-pretty 美化输出（彩色 + 时间戳），level=debug
 * - production：JSON 行格式输出到 stdout，level=info，启用 redact
 *
 * 不论何种模式，均启用：
 * - redact（敏感字段打码）
 * - timestamp（ISO 8601 毫秒精度）
 * - 自定义级别标签（level 字段输出字符串而非数字）
 *
 * 注意：development 模式使用 pino-pretty transport（worker thread），
 * 日志写入异步进行，不阻塞事件循环。
 *
 * @param component 组件名，作为 child logger 的固定字段
 */
export function createLogger(component?: string): Logger {
    const isProd = config.nodeEnv === 'production'

    const baseOptions: LoggerOptions = {
        // 开发模式 level=debug，生产模式 level=info
        level: config.isDev ? 'debug' : 'info',
        // 使用 ISO 时间戳（毫秒精度）
        timestamp: pino.stdTimeFunctions.isoTime,
        // redact 配置：自动打码敏感字段
        redact: {
            paths: [...REDACT_PATHS],
            censor: REDACT_CENSOR,
            // 同时移除嵌套路径中的敏感字段
            remove: false,
        },
        // 自定义级别标签：输出 'info' 而非 30
        formatters: {
            level(label: string): Record<string, unknown> {
                return { level: label }
            },
        },
    }

    let options: LoggerOptions

    if (isProd) {
        // 生产模式：纯 JSON 输出到 stdout
        options = baseOptions
    } else {
        // 开发模式：pino-pretty 美化输出（worker thread 异步写入）
        options = {
            ...baseOptions,
            transport: {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'SYS:HH:MM:ss.l',
                    ignore: 'pid,hostname,service,version,env',
                    singleLine: false,
                    messageFormat: '{msg}',
                    // 自定义级别颜色
                    customColors: 'fatal:bgRed,error:red,warn:yellow,info:green,debug:blue,trace:gray',
                    // 异步刷新，避免开发期日志延迟
                    sync: false,
                },
            },
        }
    }

    // 使用 child logger 注入服务级字段，保留 pino 默认的 pid/hostname
    // 这样后续 createComponentLogger('db') 创建的孙 logger 能继承所有绑定
    const root = pino(options)
    const bindings: Record<string, unknown> = {
        service: 'poetic-realm-v3-backend',
        version: '5.0.0',
        env: config.nodeEnv,
    }
    if (component) bindings.component = component
    return root.child(bindings)
}

// ─────────────────────────────────────────────────────────────
// 全局单例
// ─────────────────────────────────────────────────────────────

/**
 * 根 Logger 单例
 *
 * 全应用唯一的日志出口。Fastify 实例应直接复用此 logger
 * （通过 `Fastify({ logger })` 注入），使 req.log / app.log 与
 * 非请求代码共享同一日志管线、同一 redact 配置、同一 transport。
 *
 * 启动顺序约束：
 * - config.ts 必须先于本模块加载（本模块 import config）
 * - server.ts 必须在 initDatabase / initOrchestrator 之前 import 本模块
 */
export const logger: Logger = createLogger()

/**
 * 创建组件级 child logger
 *
 * 组件 logger 自动携带 `component` 字段，便于日志检索过滤。
 * 例：createComponentLogger('db') 输出每行均含 component:"db"
 *
 * @param component 组件名（db / llm / orchestrator / kg / dark-matter / agent / route / config）
 */
export function createComponentLogger(component: string): Logger {
    return logger.child({ component })
}

// ─────────────────────────────────────────────────────────────
// 预定义组件 logger（懒加载，避免模块加载顺序问题）
// ─────────────────────────────────────────────────────────────

let _dbLogger: Logger | undefined
let _llmLogger: Logger | undefined
let _agentLogger: Logger | undefined
let _orchestratorLogger: Logger | undefined
let _kgLogger: Logger | undefined
let _routeLogger: Logger | undefined
let _serverLogger: Logger | undefined

/** DB 层 logger */
export function dbLogger(): Logger {
    return (_dbLogger ??= createComponentLogger('db'))
}

/** LLM 层 logger */
export function llmLogger(): Logger {
    return (_llmLogger ??= createComponentLogger('llm'))
}

/** Agent 层 logger */
export function agentLogger(): Logger {
    return (_agentLogger ??= createComponentLogger('agent'))
}

/** 编排官 logger */
export function orchestratorLogger(): Logger {
    return (_orchestratorLogger ??= createComponentLogger('orchestrator'))
}

/** 知识图谱 logger */
export function kgLogger(): Logger {
    return (_kgLogger ??= createComponentLogger('kg'))
}

/** 路由层 logger（用于非 req.log 场景，如启动期路由注册） */
export function routeLogger(): Logger {
    return (_routeLogger ??= createComponentLogger('route'))
}

/** 服务器生命周期 logger */
export function serverLogger(): Logger {
    return (_serverLogger ??= createComponentLogger('server'))
}

// ─────────────────────────────────────────────────────────────
// 结构化日志辅助方法
// ─────────────────────────────────────────────────────────────

/**
 * LLM 调用结构化日志字段
 */
export interface LlmCallLogFields {
    provider: string
    model: string
    /** 思考模式 */
    thinking?: string
    /** 域 */
    domain: string
    /** 功能 */
    function: string
    /** 输入 token 数 */
    promptTokens: number
    /** 输出 token 数 */
    completionTokens: number
    /** 缓存命中 token 数 */
    cachedTokens?: number
    /** 调用延迟（毫秒） */
    latencyMs: number
    /** 费用（元） */
    costYuan: number
    /** 调用状态：success / fallback / error */
    status: 'success' | 'fallback' | 'error'
    /** Agent 标识 */
    agent?: string
    /** 任务标识 */
    task?: string
    /** 会话标识 */
    sessionId?: string
    /** 关联请求 ID */
    requestId?: string
    /** 错误信息（仅 status=error 时） */
    error?: string
    /** 错误类型（仅 status=error 时） */
    errorType?: string
}

/**
 * Agent 编排结构化日志字段
 */
export interface AgentCallLogFields {
    agentId: string
    /** Agent 类型（domain） */
    agentType: string
    /** 动作（function） */
    action: string
    /** 调用耗时（毫秒） */
    durationMs: number
    /** 结果状态：success / fallback / error */
    result: 'success' | 'fallback' | 'error'
    /** Bloom 层级 */
    bloomLevel?: string
    /** Prompt 版本 */
    promptVersion?: string
    /** 任务标识 */
    taskId?: string
    /** 会话标识 */
    sessionId?: string
    /** 关联请求 ID */
    requestId?: string
    /** token 用量 */
    promptTokens?: number
    completionTokens?: number
    /** 错误信息（仅 result=error） */
    error?: string
    /** 降级原因（仅 result=fallback） */
    fallbackReason?: string
}

/**
 * 数据库操作结构化日志字段
 */
export interface DbOperationLogFields {
    table: string
    /** 操作类型：select / insert / update / delete / exec */
    operation: 'select' | 'insert' | 'update' | 'delete' | 'exec'
    /** 耗时（毫秒） */
    durationMs: number
    /** 影响行数（insert/update/delete 适用） */
    rowsAffected?: number
    /** 返回行数（select 适用） */
    rowsReturned?: number
    /** 关联请求 ID */
    requestId?: string
    /** 错误信息（操作失败时） */
    error?: string
}

/**
 * 路由请求结构化日志字段
 */
export interface RouteRequestLogFields {
    method: string
    url: string
    statusCode: number
    latencyMs: number
    requestId: string
    /** 用户标识（如已认证） */
    userId?: string
    /** 客户端 IP */
    remoteIp?: string
    /** User-Agent */
    userAgent?: string
    /** 响应大小（字节） */
    responseSize?: number
}

/**
 * 错误结构化日志字段
 */
export interface ErrorLogFields {
    errorCode: string
    /** 错误堆栈 */
    stack?: string
    /** 错误上下文（任意结构化数据） */
    context?: Record<string, unknown>
    /** 关联请求 ID */
    requestId?: string
    /** 错误名称 */
    errorName?: string
    /** 错误消息 */
    message: string
}

// ─────────────────────────────────────────────────────────────
// 结构化日志输出函数
// ─────────────────────────────────────────────────────────────

/**
 * 记录一次 LLM 调用（成功/失败/降级）
 *
 * 自动按 status 选择日志级别：
 * - success → debug（量大，仅开发期记录）
 * - fallback → warn
 * - error → error
 */
export function logLlmCall(log: Logger, fields: LlmCallLogFields): void {
    const payload = sanitize({
        provider: fields.provider,
        model: fields.model,
        thinking: fields.thinking,
        domain: fields.domain,
        function: fields.function,
        promptTokens: fields.promptTokens,
        completionTokens: fields.completionTokens,
        cachedTokens: fields.cachedTokens,
        latencyMs: fields.latencyMs,
        costYuan: fields.costYuan,
        status: fields.status,
        agent: fields.agent,
        task: fields.task,
        sessionId: fields.sessionId,
        requestId: fields.requestId,
        error: fields.error,
        errorType: fields.errorType,
    })

    const msg = `LLM 调用 ${fields.provider}/${fields.model} ${fields.function} [${fields.status}] ${fields.latencyMs}ms`

    switch (fields.status) {
        case 'success':
            log.debug(payload, msg)
            break
        case 'fallback':
            log.warn(payload, msg)
            break
        case 'error':
            log.error(payload, msg)
            break
    }
}

/**
 * 记录一次 Agent 编排调用
 *
 * 自动按 result 选择日志级别：
 * - success → info（Agent 调用是关键业务事件）
 * - fallback → warn
 * - error → error
 */
export function logAgentCall(log: Logger, fields: AgentCallLogFields): void {
    const payload = sanitize({
        agentId: fields.agentId,
        agentType: fields.agentType,
        action: fields.action,
        durationMs: fields.durationMs,
        result: fields.result,
        bloomLevel: fields.bloomLevel,
        promptVersion: fields.promptVersion,
        taskId: fields.taskId,
        sessionId: fields.sessionId,
        requestId: fields.requestId,
        promptTokens: fields.promptTokens,
        completionTokens: fields.completionTokens,
        error: fields.error,
        fallbackReason: fields.fallbackReason,
    })

    const msg = `Agent ${fields.agentId} ${fields.action} [${fields.result}] ${fields.durationMs}ms`

    switch (fields.result) {
        case 'success':
            log.info(payload, msg)
            break
        case 'fallback':
            log.warn(payload, msg)
            break
        case 'error':
            log.error(payload, msg)
            break
    }
}

/**
 * 记录一次数据库操作
 *
 * 默认 debug 级别（量大），失败时升级为 error。
 */
export function logDbOperation(log: Logger, fields: DbOperationLogFields): void {
    const payload = sanitize({
        table: fields.table,
        operation: fields.operation,
        durationMs: fields.durationMs,
        rowsAffected: fields.rowsAffected,
        rowsReturned: fields.rowsReturned,
        requestId: fields.requestId,
        error: fields.error,
    })

    const msg = `DB ${fields.operation} ${fields.table} ${fields.durationMs}ms${
        fields.error ? ' ERROR' : ''
    }`

    if (fields.error) {
        log.error(payload, msg)
    } else {
        log.debug(payload, msg)
    }
}

/**
 * 记录一次路由请求完成
 *
 * 自动按状态码选择日志级别：
 * - < 400 → info
 * - 400-499 → warn
 * - >= 500 → error
 */
export function logRouteRequest(log: Logger, fields: RouteRequestLogFields): void {
    const safeUrl = redactBearerTokensFromUrl(fields.url)
    const payload = sanitize({
        method: fields.method,
        url: safeUrl,
        statusCode: fields.statusCode,
        latencyMs: fields.latencyMs,
        requestId: fields.requestId,
        userId: fields.userId,
        remoteIp: fields.remoteIp,
        userAgent: fields.userAgent,
        responseSize: fields.responseSize,
    })

    const msg = `${fields.method} ${safeUrl} ${fields.statusCode} ${fields.latencyMs}ms`

    if (fields.statusCode >= 500) {
        log.error(payload, msg)
    } else if (fields.statusCode >= 400) {
        log.warn(payload, msg)
    } else {
        log.info(payload, msg)
    }
}

/**
 * 记录一个错误（含结构化上下文）
 *
 * 自动脱敏 context 中的 PII。
 */
export function logError(log: Logger, fields: ErrorLogFields): void {
    const payload = sanitize({
        errorCode: fields.errorCode,
        stack: fields.stack,
        context: fields.context,
        requestId: fields.requestId,
        errorName: fields.errorName,
    })

    log.error(payload, fields.message)
}

// ─────────────────────────────────────────────────────────────
// 导出
// ─────────────────────────────────────────────────────────────

export type {
    Logger,
    LoggerOptions,
} from 'pino'

export {
    sanitize,
    isSensitiveKey,
    maskString,
    redactBearerTokensFromUrl,
    REDACT_PATHS,
    REDACT_CENSOR,
} from './sanitize.js'

export {
    attachLlmEventLoggers,
    attachAgentEventLoggers,
} from './events.js'

export {
    fastifyLoggerPlugin,
    type FastifyLoggerPluginOptions,
} from './fastify-plugin.js'
