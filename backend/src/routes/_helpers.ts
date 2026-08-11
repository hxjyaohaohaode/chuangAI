/**
 * 路由共用错误处理 Helper
 *
 * 设计目标：
 * - 不向后端响应体泄漏任何内部信息（SQL 错误、stack trace、Neo4j 错误、Agent 内部状态等）
 * - 完整 err 对象（含 stack）通过 Pino req.log.error 记录到服务端日志
 * - 响应体只含静态中文文案 + 通用 error code
 * - development / test / production 使用完全相同的安全响应，不提供 detail 调试旁路
 *
 * 使用方式（在路由 catch 块中）：
 * `	s
 * } catch (err) {
 *     handleRouteError(err, req, reply, 'AI 协作启动失败')
 *     return
 * }
 * `
 *
 * 注意：
 * - Zod 校验失败的 400 响应可保留字段细节（用户友好），不走本 helper
 * - Neo4j / LLM / Agent 降级路径已返回空数据时，也不走本 helper
 * - 仅当真要返回 500 时才使用本 helper
 */

import type { FastifyRequest, FastifyReply } from 'fastify'

/** 生产环境的用户友好文案（统一兜底） */
const PROD_ERROR_MESSAGE = '服务暂不可用，请稍后重试'

export interface NormalizedHttpError {
    statusCode: number
    errorCode: string
    message: string
}

/**
 * 将 Fastify 5 错误处理器收到的 unknown 安全收敛为公开响应字段。
 * 所有环境的 5xx 响应永不回传内部异常消息；4xx 仍保留可操作的校验提示。
 * `isProduction` 参数仅为兼容现有调用方保留，不再充当泄漏内部错误的调试开关。
 */
export function normalizeHttpError(
    err: unknown,
    _isProduction?: boolean,
): NormalizedHttpError {
    const candidate = typeof err === 'object' && err !== null
        ? err as { statusCode?: unknown; code?: unknown; message?: unknown }
        : {}
    const rawStatusCode = candidate.statusCode
    const statusCode = typeof rawStatusCode === 'number'
        && Number.isInteger(rawStatusCode)
        && rawStatusCode >= 400
        && rawStatusCode <= 599
        ? rawStatusCode
        : 500
    const errorCode = typeof candidate.code === 'string' && candidate.code.trim()
        ? candidate.code
        : statusCode >= 500
            ? 'INTERNAL_ERROR'
            : 'REQUEST_ERROR'
    const rawMessage = typeof candidate.message === 'string' && candidate.message.trim()
        ? candidate.message
        : statusCode >= 500
            ? PROD_ERROR_MESSAGE
            : '请求无效'

    return {
        statusCode,
        errorCode,
        message: statusCode >= 500 ? PROD_ERROR_MESSAGE : rawMessage,
    }
}

/**
 * 统一处理路由层 500 错误：日志记完整 err，响应体只暴露静态文案
 *
 * @param err catch 块捕获到的错误（unknown 类型）
 * @param req Fastify 请求对象（用于 req.log.error 与 url）
 * @param reply Fastify 响应对象
 * @param fallbackMessage 可选的公开业务文案（如 AI 协作启动失败），所有环境返回此文案 + 请稍后重试
 *                     若不传，统一返回 PROD_ERROR_MESSAGE
 */
export function handleRouteError(
    err: unknown,
    req: FastifyRequest,
    reply: FastifyReply,
    fallbackMessage?: string,
): void {
    // 服务端日志：完整 err 对象（含 stack、name、message、cause 等）
    req.log.error({ err, path: req.url }, 'Route error')

    const message = fallbackMessage
        ? fallbackMessage + '，请稍后重试'
        : PROD_ERROR_MESSAGE

    reply.code(500).send({
        status: 'error',
        error: 'INTERNAL_ERROR',
        message,
    })
}
