/**
 * Fastify 日志插件（任务 B6.5）
 *
 * 职责：
 * 1. 为每个请求生成唯一 requestId（贯穿整个请求链路）
 * 2. 注入请求级 child logger（自动携带 requestId 字段）
 * 3. 请求开始日志（含 method / url / requestId / remoteIp / userAgent）
 * 4. 响应完成日志（含 statusCode / latencyMs / responseSize）
 * 5. 错误日志（自动捕获未处理异常，含 stack / errorCode）
 *
 * 设计要点：
 * - 复用 Fastify 内置的 req.log（已是 Pino child logger），通过 onRequest 钩子
 *   重新 child 出携带 requestId 的子 logger
 * - 不使用 pino-http，避免与 Fastify 内置 logger 冲突
 * - requestId 同时写入响应头 X-Request-Id，便于客户端联调
 * - 健康检查路径（/api/health）默认不打请求开始日志，避免噪音
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { logRouteRequest, logError, type Logger } from './index.js'
import { redactBearerTokensFromUrl } from './sanitize.js'

// ─────────────────────────────────────────────────────────────
// 类型扩展
// ─────────────────────────────────────────────────────────────

/**
 * 扩展 FastifyRequest，增加 requestId 与开始时间字段
 * 通过 declaration merging 合并到 FastifyRequest 类型
 */
declare module 'fastify' {
    interface FastifyRequest {
        /** 请求唯一标识，贯穿整个请求链路的日志关联键 */
        requestId: string
        /** 请求开始时间戳（ms），用于计算 latency */
        _startedAt: number
    }
}

// ─────────────────────────────────────────────────────────────
// 插件选项
// ─────────────────────────────────────────────────────────────

export interface FastifyLoggerPluginOptions {
    /**
     * 哪些路径前缀不打"请求开始"日志（避免健康检查噪音）
     * 默认 ['/api/health', '/api/health/db']
     */
    silentStartPatterns?: readonly string[]

    /**
     * 自定义 requestId 生成器
     * 默认使用 `req_<timestamp base36>_<uuid前8位>`
     */
    genRequestId?: (req: FastifyRequest) => string

    /**
     * 是否将 requestId 写入响应头 X-Request-Id
     * 默认 true
     */
    writeResponseHeader?: boolean
}

// ─────────────────────────────────────────────────────────────
// 默认值
// ─────────────────────────────────────────────────────────────

const DEFAULT_SILENT_PATTERNS: readonly string[] = ['/api/health', '/api/health/db']

const DEFAULT_GEN_REQUEST_ID = (): string => {
    const ts = Date.now().toString(36)
    const rand = randomUUID().replace(/-/g, '').slice(0, 8)
    return `req_${ts}_${rand}`
}

// ─────────────────────────────────────────────────────────────
// Fastify 插件
// ─────────────────────────────────────────────────────────────

/**
 * Fastify 日志插件
 *
 * 注册顺序：必须在所有业务路由注册之前注册
 *
 * @example
 *   await app.register(fastifyLoggerPlugin, {
 *     silentStartPatterns: ['/api/health'],
 *   })
 */
export const fastifyLoggerPlugin: FastifyPluginAsync<FastifyLoggerPluginOptions> = async (
    app: FastifyInstance,
    opts: FastifyLoggerPluginOptions = {},
): Promise<void> => {
    const silentPatterns = opts.silentStartPatterns ?? DEFAULT_SILENT_PATTERNS
    const genRequestId = opts.genRequestId ?? DEFAULT_GEN_REQUEST_ID
    const writeHeader = opts.writeResponseHeader ?? true

    // ── 1. 生成 requestId 并注入到 req 对象 ──
    // 使用 onRequest 钩子在请求最早期生成 requestId，确保后续所有日志都能关联
    app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
        // 优先使用上游传入的 X-Request-Id（便于分布式追踪），否则生成新 ID
        const upstreamId = req.headers['x-request-id']
        const requestId =
            typeof upstreamId === 'string' && upstreamId.length > 0 && upstreamId.length <= 128
                ? upstreamId
                : genRequestId(req)

        req.requestId = requestId
        req._startedAt = Date.now()

        // 用 child logger 替换 req.log，使后续所有 req.log 自动携带 requestId
        // Fastify 的 req.log 是 Pino child logger，可继续 child
        req.log = (req.log as Logger).child({ requestId })

        // 写入响应头，便于客户端联调
        if (writeHeader) {
            reply.header('X-Request-Id', requestId)
        }

        // 请求开始日志（跳过健康检查等噪音路径）
        const shouldSkipStartLog = silentPatterns.some((p) => req.url.startsWith(p))
        if (!shouldSkipStartLog) {
            const safeUrl = redactBearerTokensFromUrl(req.url)
            req.log.info(
                {
                    method: req.method,
                    url: safeUrl,
                    remoteIp: extractRemoteIp(req),
                    userAgent: req.headers['user-agent'],
                },
                `收到请求 ${req.method} ${safeUrl}`,
            )
        }
    })

    // ── 2. 响应完成日志（含延迟与状态码） ──
    app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
        const latencyMs = Date.now() - req._startedAt
        const safeUrl = redactBearerTokensFromUrl(req.url)

        logRouteRequest(req.log as Logger, {
            method: req.method,
            url: safeUrl,
            statusCode: reply.statusCode,
            latencyMs,
            requestId: req.requestId,
            remoteIp: extractRemoteIp(req),
            userAgent: req.headers['user-agent'],
            responseSize: reply.getHeader('content-length')
                ? Number(reply.getHeader('content-length'))
                : undefined,
        })
    })

    // ── 3. 错误日志（已设置 setErrorHandler 的应用会被覆盖，需在此处兜底） ──
    // 注意：setErrorHandler 会覆盖 Fastify 默认错误处理，因此这里使用 onSend 钩子
    // 检测 5xx 响应并补记错误日志（仅当 reply 中存在错误对象时）
    app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
        if (reply.statusCode >= 500) {
            const latencyMs = Date.now() - req._startedAt
            const safeUrl = redactBearerTokensFromUrl(req.url)
            logError(req.log as Logger, {
                errorCode: 'INTERNAL_ERROR',
                message: `请求处理失败 ${req.method} ${safeUrl} ${reply.statusCode} ${latencyMs}ms`,
                context: {
                    method: req.method,
                    url: safeUrl,
                    statusCode: reply.statusCode,
                    latencyMs,
                },
                requestId: req.requestId,
            })
        }
        return payload
    })

    // ── 4. 未捕获异常兜底（onError 钩子，在错误处理流程中触发） ──
    app.addHook('onError', async (req: FastifyRequest, reply: FastifyReply, err: Error) => {
        const latencyMs = Date.now() - req._startedAt
        const safeUrl = redactBearerTokensFromUrl(req.url)
        logError(req.log as Logger, {
            errorCode: (err as { statusCode?: number }).statusCode?.toString() ?? 'INTERNAL_ERROR',
            stack: err.stack,
            errorName: err.name,
            message: err.message,
            context: {
                method: req.method,
                url: safeUrl,
                statusCode: reply.statusCode,
                latencyMs,
            },
            requestId: req.requestId,
        })
    })

    // ── 5. 未处理的 rejection / uncaughtException 兜底 ──
    // 这些是进程级事件，Fastify 钩子无法捕获，需在 app 实例外注册
    // 这里通过 app.ready 回调确保只注册一次（避免热重载时重复绑定）
    app.addHook('onReady', async () => {
        const log = app.log as Logger

        const rejectionHandler = (reason: unknown): void => {
            log.fatal(
                {
                    err: reason instanceof Error ? reason : new Error(String(reason)),
                    errorCode: 'UNHANDLED_REJECTION',
                },
                '未处理的 Promise rejection',
            )
        }
        const exceptionHandler = (err: Error): void => {
            log.fatal(
                {
                    err,
                    errorCode: 'UNCAUGHT_EXCEPTION',
                },
                '未捕获的异常',
            )
        }

        process.on('unhandledRejection', rejectionHandler)
        process.on('uncaughtException', exceptionHandler)
    })
}

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────

/**
 * 提取客户端真实 IP（穿透代理）
 * 优先级：X-Forwarded-For 第一段 > X-Real-IP > req.ip
 */
function extractRemoteIp(req: FastifyRequest): string | undefined {
    const xff = req.headers['x-forwarded-for']
    if (typeof xff === 'string') {
        const first = xff.split(',')[0]?.trim()
        if (first) return first
    }
    const xRealIp = req.headers['x-real-ip']
    if (typeof xRealIp === 'string' && xRealIp.length > 0) return xRealIp
    return req.ip
}
