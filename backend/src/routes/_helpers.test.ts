/**
 * routes/_helpers.ts 单元测试
 *
 * 覆盖：
 * - handleRouteError：日志记录、500 响应、message 文案、全环境敏感信息零出站
 * - 边界条件：fallbackMessage 不传、传空字符串、传自定义文案
 * - 错误类型：Error 实例、非 Error 值（字符串、对象、undefined）
 * - 环境变量：production / development / test / 未设置均无 detail
 *
 * 设计原则：
 * - mock FastifyRequest 与 FastifyReply，不依赖真实 Fastify 实例
 * - 通过 vi.stubEnv 控制 NODE_ENV
 * - 验证 req.log.error 与 reply.code/send 的调用参数
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify'
import { handleRouteError, normalizeHttpError } from './_helpers.js'

// ─────────────────────────────────────────────────────────────
// 辅助：构造 mock request / reply
// ─────────────────────────────────────────────────────────────

function createMockRequest(url = '/api/test'): {
    req: FastifyRequest
    logErrorSpy: ReturnType<typeof vi.fn>
} {
    const logErrorSpy = vi.fn()
    const req = {
        url,
        log: {
            error: logErrorSpy,
            warn: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        },
    } as unknown as FastifyRequest
    return { req, logErrorSpy }
}

function createMockReply(): {
    reply: FastifyReply
    codeSpy: ReturnType<typeof vi.fn>
    sendSpy: ReturnType<typeof vi.fn>
} {
    const codeSpy = vi.fn().mockReturnThis()
    const sendSpy = vi.fn().mockReturnThis()
    const reply = {
        code: codeSpy,
        send: sendSpy,
    } as unknown as FastifyReply
    return { reply, codeSpy, sendSpy }
}

describe('handleRouteError', () => {
    let originalNodeEnv: string | undefined

    beforeEach(() => {
        originalNodeEnv = process.env.NODE_ENV
    })

    afterEach(() => {
        if (originalNodeEnv === undefined) {
            delete process.env.NODE_ENV
        } else {
            process.env.NODE_ENV = originalNodeEnv
        }
        vi.unstubAllEnvs()
    })

    // ─────────────────────────────────────────────────────────
    // 基础行为
    // ─────────────────────────────────────────────────────────

    it('调用 req.log.error 记录完整错误对象', () => {
        const { req, logErrorSpy } = createMockRequest('/api/test')
        const { reply } = createMockReply()
        const err = new Error('测试错误')

        handleRouteError(err, req, reply)

        expect(logErrorSpy).toHaveBeenCalledTimes(1)
        const [payload, msg] = logErrorSpy.mock.calls[0]!
        expect(payload).toHaveProperty('err', err)
        expect(payload).toHaveProperty('path', '/api/test')
        expect(msg).toBe('Route error')
    })

    it('响应 500 状态码', () => {
        const { req } = createMockRequest()
        const { reply, codeSpy } = createMockReply()
        const err = new Error('测试错误')

        handleRouteError(err, req, reply)

        expect(codeSpy).toHaveBeenCalledWith(500)
    })

    it('响应体包含 status: error 与 error: INTERNAL_ERROR', () => {
        const { req } = createMockRequest()
        const { reply, sendSpy } = createMockReply()
        const err = new Error('测试错误')

        handleRouteError(err, req, reply)

        expect(sendSpy).toHaveBeenCalledTimes(1)
        const body = sendSpy.mock.calls[0]![0] as Record<string, unknown>
        expect(body.status).toBe('error')
        expect(body.error).toBe('INTERNAL_ERROR')
    })

    // ─────────────────────────────────────────────────────────
    // 文案处理
    // ─────────────────────────────────────────────────────────

    it('不传 fallbackMessage 时使用默认文案（生产环境）', () => {
        vi.stubEnv('NODE_ENV', 'production')
        const { req } = createMockRequest()
        const { reply, sendSpy } = createMockReply()
        const err = new Error('内部错误')

        handleRouteError(err, req, reply)

        const body = sendSpy.mock.calls[0]![0] as Record<string, unknown>
        expect(body.message).toBe('服务暂不可用，请稍后重试')
        // 生产环境不应包含 detail
        expect(body).not.toHaveProperty('detail')
    })

    it('传 fallbackMessage 时附加 "，请稍后重试" 后缀（生产环境）', () => {
        vi.stubEnv('NODE_ENV', 'production')
        const { req } = createMockRequest()
        const { reply, sendSpy } = createMockReply()
        const err = new Error('内部错误')

        handleRouteError(err, req, reply, 'AI 协作启动失败')

        const body = sendSpy.mock.calls[0]![0] as Record<string, unknown>
        expect(body.message).toBe('AI 协作启动失败，请稍后重试')
        expect(body).not.toHaveProperty('detail')
    })

    it('传空字符串 fallbackMessage 时仅返回 "，请稍后重试"（生产环境）', () => {
        vi.stubEnv('NODE_ENV', 'production')
        const { req } = createMockRequest()
        const { reply, sendSpy } = createMockReply()

        handleRouteError(new Error('x'), req, reply, '')

        const body = sendSpy.mock.calls[0]![0] as Record<string, unknown>
        // fallbackMessage 为空字符串时，三元运算符视为 falsy，使用 PROD_ERROR_MESSAGE
        expect(body.message).toBe('服务暂不可用，请稍后重试')
    })

    // ─────────────────────────────────────────────────────────
    // 环境边界：任意异常细节一律只进日志
    // ─────────────────────────────────────────────────────────

    const sensitiveErrorText = 'sk-live-SECRET provider_raw={"authorization":"Bearer hidden"} SQL=C:\\private\\users.db'

    it.each([
        { label: 'production', nodeEnv: 'production' },
        { label: 'development', nodeEnv: 'development' },
        { label: 'test', nodeEnv: 'test' },
        { label: 'unset', nodeEnv: undefined },
    ])('$label 环境的 helper 响应均不包含 detail 或底层异常文本', ({ nodeEnv }) => {
        vi.stubEnv('NODE_ENV', nodeEnv)
        const { req } = createMockRequest()
        const { reply, sendSpy } = createMockReply()
        const err = Object.assign(new Error(sensitiveErrorText), {
            providerDetail: 'upstream request id provider-secret-id',
        })

        handleRouteError(err, req, reply, '业务失败')

        const body = sendSpy.mock.calls[0]![0] as Record<string, unknown>
        expect(body).toEqual({
            status: 'error',
            error: 'INTERNAL_ERROR',
            message: '业务失败，请稍后重试',
        })
        const serialized = JSON.stringify(body)
        expect(serialized).not.toContain('sk-live-SECRET')
        expect(serialized).not.toContain('provider_raw')
        expect(serialized).not.toContain('provider-secret-id')
        expect(serialized).not.toContain('users.db')
        expect(serialized).not.toContain('stack')
    })

    it.each([
        ['字符串', sensitiveErrorText],
        ['对象', { code: 500, msg: sensitiveErrorText }],
        ['数字', 42],
        ['undefined', undefined],
        ['null', null],
    ])('非 Error 类型（%s）也不会被 String(err) 后写入响应', (_label, err) => {
        vi.stubEnv('NODE_ENV', 'development')
        const { req } = createMockRequest()
        const { reply, sendSpy } = createMockReply()

        handleRouteError(err, req, reply)

        expect(sendSpy.mock.calls[0]![0]).toEqual({
            status: 'error',
            error: 'INTERNAL_ERROR',
            message: '服务暂不可用，请稍后重试',
        })
    })

    it.each([
        { label: 'production', nodeEnv: 'production' },
        { label: 'development', nodeEnv: 'development' },
        { label: 'test', nodeEnv: 'test' },
        { label: 'unset', nodeEnv: undefined },
    ])('真实 Fastify 路由在 $label 环境中返回相同安全 envelope', async ({ nodeEnv }) => {
        vi.stubEnv('NODE_ENV', nodeEnv)
        const app = Fastify({ logger: false })
        const privateError = new Error(sensitiveErrorText)
        privateError.stack = `Error: ${sensitiveErrorText}\n    at C:\\private\\route.ts:10:2`

        app.get('/api/error-boundary', async (req, reply) => {
            try {
                throw privateError
            } catch (err) {
                handleRouteError(err, req, reply, '真实路由失败')
                return reply
            }
        })

        try {
            const response = await app.inject({ method: 'GET', url: '/api/error-boundary' })
            expect(response.statusCode).toBe(500)
            expect(response.json()).toEqual({
                status: 'error',
                error: 'INTERNAL_ERROR',
                message: '真实路由失败，请稍后重试',
            })
            expect(response.body).not.toContain('sk-live-SECRET')
            expect(response.body).not.toContain('provider_raw')
            expect(response.body).not.toContain('users.db')
            expect(response.body).not.toContain('route.ts')
        } finally {
            await app.close()
        }
    })

    // ─────────────────────────────────────────────────────────
    // 日志记录
    // ─────────────────────────────────────────────────────────

    it('日志包含 path 字段（取自 req.url）', () => {
        const { req, logErrorSpy } = createMockRequest('/api/custom-path')
        const { reply } = createMockReply()

        handleRouteError(new Error('x'), req, reply)

        const payload = logErrorSpy.mock.calls[0]![0] as Record<string, unknown>
        expect(payload.path).toBe('/api/custom-path')
    })

    it('日志包含 err 字段（保留原始错误对象，含 stack）', () => {
        const { req, logErrorSpy } = createMockRequest()
        const { reply } = createMockReply()
        const err = new Error('带 stack 的错误')

        handleRouteError(err, req, reply)

        const payload = logErrorSpy.mock.calls[0]![0] as Record<string, unknown>
        expect(payload.err).toBe(err)
        // 验证 err 对象的 stack 属性存在
        expect((payload.err as Error).stack).toBeDefined()
    })

    it('日志消息为 "Route error"', () => {
        const { req, logErrorSpy } = createMockRequest()
        const { reply } = createMockReply()

        handleRouteError(new Error('x'), req, reply)

        const msg = logErrorSpy.mock.calls[0]![1]
        expect(msg).toBe('Route error')
    })

    // ─────────────────────────────────────────────────────────
    // 返回值与调用顺序
    // ─────────────────────────────────────────────────────────

    it('返回 void（无返回值）', () => {
        const { req } = createMockRequest()
        const { reply } = createMockReply()

        const result = handleRouteError(new Error('x'), req, reply)
        expect(result).toBeUndefined()
    })

    it('先调用 reply.code，再调用 reply.send', () => {
        const { req } = createMockRequest()
        const { reply, codeSpy, sendSpy } = createMockReply()

        handleRouteError(new Error('x'), req, reply)

        expect(codeSpy).toHaveBeenCalledBefore(sendSpy)
    })
})

describe('normalizeHttpError', () => {
    it('生产环境隐藏 5xx 内部异常消息', () => {
        const result = normalizeHttpError(
            Object.assign(new Error('SQLITE_CONSTRAINT users.password_hash'), {
                statusCode: 500,
                code: 'SQLITE_CONSTRAINT',
            }),
            true,
        )

        expect(result).toEqual({
            statusCode: 500,
            errorCode: 'SQLITE_CONSTRAINT',
            message: '服务暂不可用，请稍后重试',
        })
    })

    it.each([false, true])('任何环境都隐藏 5xx 内部异常消息（isProduction=%s）', (isProduction) => {
        const result = normalizeHttpError(
            Object.assign(new Error('sk-secret provider_raw SQL=C:\\private\\global.db'), {
                statusCode: 503,
                code: 'UPSTREAM_UNAVAILABLE',
            }),
            isProduction,
        )

        expect(result).toEqual({
            statusCode: 503,
            errorCode: 'UPSTREAM_UNAVAILABLE',
            message: '服务暂不可用，请稍后重试',
        })
    })

    it('保留 4xx 的可操作提示和错误码', () => {
        const result = normalizeHttpError({
            statusCode: 422,
            code: 'FST_ERR_VALIDATION',
            message: 'body/poemId must be string',
        }, true)

        expect(result).toEqual({
            statusCode: 422,
            errorCode: 'FST_ERR_VALIDATION',
            message: 'body/poemId must be string',
        })
    })

    it('非 Error 值安全降级为 500', () => {
        expect(normalizeHttpError('boom', true)).toEqual({
            statusCode: 500,
            errorCode: 'INTERNAL_ERROR',
            message: '服务暂不可用，请稍后重试',
        })
    })
})
