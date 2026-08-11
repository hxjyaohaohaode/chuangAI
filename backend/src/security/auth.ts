import {
    createHmac,
    randomBytes,
    timingSafeEqual,
} from 'node:crypto'
import type {
    FastifyInstance,
    FastifyPluginAsync,
    FastifyReply,
    FastifyRequest,
} from 'fastify'
import { z } from 'zod'
import { isSupportedScryptHash, verifyScryptPassword } from './scrypt-password.js'

export type AuthMode = 'demo' | 'password'
export type CookieSecurePolicy = 'auto' | 'true' | 'false'

export interface AuthUser {
    id: string
    name: string
    role: 'teacher'
}

export interface AuthenticatedSession extends AuthUser {
    issuedAt: number
    expiresAt: number
    csrfToken: string
    sessionId: string
}

declare module 'fastify' {
    interface FastifyRequest {
        /** 公开路由中为空；所有受保护 API/WS 在进入处理器前均已验证。 */
        auth?: AuthenticatedSession
    }
}

export interface AuthServiceOptions {
    mode: AuthMode
    sessionSecret: string
    sessionTtlSeconds: number
    cookieSecure: CookieSecurePolicy
    teacherId: string
    teacherName: string
    passwordScrypt: string
    corsOrigins: readonly string[]
    now?: () => number
}

export interface LoginInput {
    teacherId: string
    name?: string
    password?: string
}

interface SessionPayload {
    v: 1
    sub: string
    name: string
    role: 'teacher'
    iat: number
    exp: number
    csrf: string
    sid: string
}

interface LoginFailureState {
    failures: number
    windowStartedAt: number
    lockedUntil: number
}

const SESSION_COOKIE = 'pr_session'
const CSRF_COOKIE = 'pr_csrf'
const LOGIN_WINDOW_MS = 5 * 60_000
const LOGIN_LOCK_MS = 5 * 60_000
const LOGIN_MAX_FAILURES = 5
const MAX_COOKIE_HEADER_LENGTH = 8_192

/** 演示档案是产品公开数据，不是现实世界身份；单租户构建只允许一个固定主体。 */
export const DEMO_TEACHERS: readonly (AuthUser & { classLabel: string })[] = [
    { id: 'teacher-001', name: '王雅琴', role: 'teacher', classLabel: '三年二班' },
]

const loginBodySchema = z.object({
    teacherId: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(80).optional(),
    password: z.string().min(1).max(512).optional(),
}).strict()

function base64UrlJson(payload: SessionPayload): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, 'utf8')
    const rightBuffer = Buffer.from(right, 'utf8')
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function signPayload(encodedPayload: string, secret: string): string {
    return createHmac('sha256', secret).update(encodedPayload).digest('base64url')
}

function parseCookies(header: string | undefined): Record<string, string> {
    if (!header || header.length > MAX_COOKIE_HEADER_LENGTH) return {}
    const cookies: Record<string, string> = {}
    for (const part of header.split(';')) {
        const separator = part.indexOf('=')
        if (separator <= 0) continue
        const name = part.slice(0, separator).trim()
        const rawValue = part.slice(separator + 1).trim()
        if (!name || Object.hasOwn(cookies, name)) continue
        try {
            cookies[name] = decodeURIComponent(rawValue)
        } catch {
            // 非法百分号编码的 Cookie 不能进入认证路径。
        }
    }
    return cookies
}

function serializeCookie(
    name: string,
    value: string,
    options: { maxAge: number; httpOnly: boolean; secure: boolean },
): string {
    const attributes = [
        `${name}=${encodeURIComponent(value)}`,
        'Path=/',
        `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
        'SameSite=Strict',
    ]
    if (options.httpOnly) attributes.push('HttpOnly')
    if (options.secure) attributes.push('Secure')
    return attributes.join('; ')
}

function forwardedProtocol(request: FastifyRequest): string | undefined {
    const value = request.headers['x-forwarded-proto']
    const first = Array.isArray(value) ? value[0] : value?.split(',')[0]
    const normalized = first?.trim().toLowerCase()
    return normalized === 'https' || normalized === 'http' ? normalized : undefined
}

function isMutating(method: string): boolean {
    return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
}

function topLevelString(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const candidate = (value as Record<string, unknown>)[key]
    return typeof candidate === 'string' ? candidate.trim() : undefined
}

function nestedObjectString(value: unknown, parentKey: string, key: string): string | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const parent = (value as Record<string, unknown>)[parentKey]
    return topLevelString(parent, key)
}

export class LoginRejectedError extends Error {
    constructor(public readonly statusCode: 401 | 429, message: string) {
        super(message)
        this.name = 'LoginRejectedError'
    }
}

export class AuthService {
    readonly mode: AuthMode
    readonly ephemeralSecret: boolean
    readonly demoTeachers = DEMO_TEACHERS

    private readonly secret: string
    private readonly now: () => number
    private readonly failures = new Map<string, LoginFailureState>()
    private readonly revokedSessions = new Map<string, number>()

    constructor(private readonly options: AuthServiceOptions) {
        if (options.sessionSecret.length > 0 && Buffer.byteLength(options.sessionSecret, 'utf8') < 32) {
            throw new Error('显式会话密钥必须至少 32 字节')
        }
        if (!Number.isInteger(options.sessionTtlSeconds)
            || options.sessionTtlSeconds < 300
            || options.sessionTtlSeconds > 86_400) {
            throw new Error('会话有效期必须在 5 分钟到 24 小时之间')
        }
        if (options.mode === 'password'
            && !isSupportedScryptHash(options.passwordScrypt)) {
            throw new Error('密码认证需要受支持的 scrypt 摘要')
        }
        this.mode = options.mode
        this.ephemeralSecret = options.sessionSecret.length === 0
        this.secret = options.sessionSecret || randomBytes(48).toString('base64url')
        this.now = options.now ?? Date.now
    }

    async authenticate(input: LoginInput, source: string): Promise<AuthUser> {
        if (this.mode === 'demo') {
            const account = DEMO_TEACHERS.find((item) => item.id === input.teacherId)
            if (!account) throw new LoginRejectedError(401, '教师账号或凭据无效')
            return { id: account.id, name: account.name, role: 'teacher' }
        }

        this.assertNotLocked(source)
        const idMatches = safeEqual(input.teacherId, this.options.teacherId)
        const passwordMatches = typeof input.password === 'string'
            && await verifyScryptPassword(input.password, this.options.passwordScrypt)
        if (!idMatches || !passwordMatches) {
            this.recordFailure(source)
            throw new LoginRejectedError(401, '教师账号或凭据无效')
        }
        this.failures.delete(source)
        return { id: this.options.teacherId, name: this.options.teacherName, role: 'teacher' }
    }

    issue(user: AuthUser): { token: string; session: AuthenticatedSession } {
        const issuedAt = Math.floor(this.now() / 1_000)
        const payload: SessionPayload = {
            v: 1,
            sub: user.id,
            name: user.name,
            role: 'teacher',
            iat: issuedAt,
            exp: issuedAt + this.options.sessionTtlSeconds,
            csrf: randomBytes(32).toString('base64url'),
            sid: randomBytes(24).toString('base64url'),
        }
        const encoded = base64UrlJson(payload)
        return {
            token: `${encoded}.${signPayload(encoded, this.secret)}`,
            session: this.toSession(payload),
        }
    }

    verify(token: string | undefined): AuthenticatedSession | null {
        this.pruneRevocations()
        if (!token || token.length > 4_096) return null
        const separator = token.indexOf('.')
        if (separator <= 0 || separator !== token.lastIndexOf('.')) return null
        const encoded = token.slice(0, separator)
        const signature = token.slice(separator + 1)
        if (!safeEqual(signature, signPayload(encoded, this.secret))) return null

        let payload: SessionPayload
        try {
            payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload
        } catch {
            return null
        }
        const nowSeconds = Math.floor(this.now() / 1_000)
        if (payload.v !== 1 || payload.role !== 'teacher') return null
        if (!payload.sub || !payload.name || !payload.csrf || !payload.sid) return null
        if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null
        if (payload.iat > nowSeconds + 60 || payload.exp <= nowSeconds || payload.exp <= payload.iat) return null
        if (payload.exp - payload.iat > 86_400) return null
        if (this.revokedSessions.has(payload.sid)) return null
        return this.toSession(payload)
    }

    sessionFromRequest(request: FastifyRequest): AuthenticatedSession | null {
        const cookies = parseCookies(request.headers.cookie)
        return this.verify(cookies[SESSION_COOKIE])
    }

    csrfFromRequest(request: FastifyRequest): string | undefined {
        return parseCookies(request.headers.cookie)[CSRF_COOKIE]
    }

    revoke(session: AuthenticatedSession): void {
        this.revokedSessions.set(session.sessionId, session.expiresAt)
    }

    isAllowedOrigin(request: FastifyRequest): boolean {
        const origin = request.headers.origin
        if (typeof origin !== 'string' || origin.length > 512) return false
        // Origin 的可信性必须在启动时由配置确定。Host 和 X-Forwarded-Proto
        // 都来自当前请求；将它们拼成“同源”再加入白名单，会让持有合法 CSRF
        // token 的请求通过任意伪造 Host 扩大允许集合。前端开发端口和同源
        // 回环服务端口均在 config.corsOrigins 中显式列出。
        return this.options.corsOrigins.includes(origin)
    }

    cookiesForSession(request: FastifyRequest, token: string, session: AuthenticatedSession): string[] {
        const secure = this.shouldUseSecureCookie(request)
        return [
            serializeCookie(SESSION_COOKIE, token, {
                maxAge: session.expiresAt - Math.floor(this.now() / 1_000),
                httpOnly: true,
                secure,
            }),
            serializeCookie(CSRF_COOKIE, session.csrfToken, {
                maxAge: session.expiresAt - Math.floor(this.now() / 1_000),
                httpOnly: false,
                secure,
            }),
        ]
    }

    cookiesForLogout(request: FastifyRequest): string[] {
        const secure = this.shouldUseSecureCookie(request)
        return [
            serializeCookie(SESSION_COOKIE, '', { maxAge: 0, httpOnly: true, secure }),
            serializeCookie(CSRF_COOKIE, '', { maxAge: 0, httpOnly: false, secure }),
        ]
    }

    private toSession(payload: SessionPayload): AuthenticatedSession {
        return {
            id: payload.sub,
            name: payload.name,
            role: payload.role,
            issuedAt: payload.iat,
            expiresAt: payload.exp,
            csrfToken: payload.csrf,
            sessionId: payload.sid,
        }
    }

    private shouldUseSecureCookie(request: FastifyRequest): boolean {
        if (this.options.cookieSecure === 'true') return true
        if (this.options.cookieSecure === 'false') return false
        return (forwardedProtocol(request) ?? request.protocol) === 'https'
    }

    private assertNotLocked(source: string): void {
        const now = this.now()
        const state = this.failures.get(source)
        if (!state) return
        if (state.lockedUntil > now) throw new LoginRejectedError(429, '登录尝试过多，请稍后再试')
        if (now - state.windowStartedAt >= LOGIN_WINDOW_MS) this.failures.delete(source)
    }

    private recordFailure(source: string): void {
        const now = this.now()
        const current = this.failures.get(source)
        const state = !current || now - current.windowStartedAt >= LOGIN_WINDOW_MS
            ? { failures: 0, windowStartedAt: now, lockedUntil: 0 }
            : current
        state.failures += 1
        if (state.failures >= LOGIN_MAX_FAILURES) state.lockedUntil = now + LOGIN_LOCK_MS
        this.failures.set(source, state)
    }

    private pruneRevocations(): void {
        const nowSeconds = Math.floor(this.now() / 1_000)
        for (const [sessionId, expiresAt] of this.revokedSessions) {
            if (expiresAt <= nowSeconds) this.revokedSessions.delete(sessionId)
        }
    }
}

function pathOnly(request: FastifyRequest): string {
    return (request.raw.url ?? '').split('?', 1)[0] ?? ''
}

function isPublicRequest(request: FastifyRequest): boolean {
    if (request.method === 'OPTIONS') return true
    const pathname = pathOnly(request)
    return pathname === '/api/health'
        || pathname === '/api/auth/status'
        || pathname === '/api/auth/login'
        // 分享 token 是 bearer capability。只公开 GET + 单一非空路径段；列表、
        // 创建、撤销、尾随斜杠和嵌套路径仍然落入全局认证/CSRF 边界。
        || (request.method === 'GET' && /^\/api\/report\/shared\/[^/]+$/u.test(pathname))
}

function isProtectedTransport(request: FastifyRequest): boolean {
    const pathname = pathOnly(request)
    return pathname === '/api'
        || pathname.startsWith('/api/')
        || pathname.startsWith('/ws/')
        || pathname === '/uploads/generated'
        || pathname.startsWith('/uploads/generated/')
}

function authError(reply: FastifyReply, statusCode: 401 | 403, error: string, message: string) {
    return reply.code(statusCode).send({
        status: 'error',
        error,
        message,
        statusCode,
    })
}

/**
 * 根作用域认证钩子。必须在任何业务路由注册前调用，才能覆盖所有插件路由和 WS。
 */
export function installAuthBoundary(app: FastifyInstance, service: AuthService): void {
    app.addHook('onRequest', async (request, reply) => {
        if (!isProtectedTransport(request) || isPublicRequest(request)) return
        const session = service.sessionFromRequest(request)
        if (!session) {
            await authError(reply, 401, 'AUTHENTICATION_REQUIRED', '登录会话不存在、已过期或无效')
            return
        }
        request.auth = session

        // WebSocket 握手使用 GET，不能依赖 isMutating() 的 REST CSRF 分支。
        // 浏览器握手必带 Origin；要求它来自启动时白名单，可阻断同站不同源
        // （例如另一个 localhost 端口）携带 Strict Cookie 发起的 CSWSH。
        if (pathOnly(request).startsWith('/ws/') && !service.isAllowedOrigin(request)) {
            await authError(reply, 403, 'ORIGIN_REJECTED', 'WebSocket 请求来源不在允许范围内')
            return
        }

        if (isMutating(request.method)) {
            const origin = request.headers.origin
            if (origin !== undefined && !service.isAllowedOrigin(request)) {
                await authError(reply, 403, 'ORIGIN_REJECTED', '请求来源不在允许范围内')
                return
            }
            const headerToken = request.headers['x-csrf-token']
            const csrfHeader = Array.isArray(headerToken) ? headerToken[0] : headerToken
            const csrfCookie = service.csrfFromRequest(request)
            if (!csrfHeader || !csrfCookie
                || !safeEqual(csrfHeader, session.csrfToken)
                || !safeEqual(csrfCookie, session.csrfToken)) {
                await authError(reply, 403, 'CSRF_REJECTED', '请求完整性校验失败')
            }
        }
    })

    app.addHook('preValidation', async (request, reply) => {
        if (!request.auth) return
        const queryTeacher = topLevelString(request.query, 'teacherId')
        const bodyTeacher = topLevelString(request.body, 'teacherId')
        // /api/agents/orchestrate 的真实请求契约把 teacherId 放在 body.params；
        // 只看顶层会允许伪造主体写入持久化会话和 questions.createdBy。
        const bodyParamsTeacher = nestedObjectString(request.body, 'params', 'teacherId')
        const supplied = [queryTeacher, bodyTeacher, bodyParamsTeacher]
            .filter((value): value is string => Boolean(value))
        if (supplied.some((teacherId) => teacherId !== request.auth?.id)) {
            await authError(reply, 403, 'TEACHER_SCOPE_MISMATCH', '请求教师范围与登录会话不一致')
        }
    })

    // 教学 API 与生成媒体响应可能包含班级、学生、诊断、批改、会话或教师自定义
    // 生成内容。无论请求是否认证成功，都禁止浏览器和共享代理落盘缓存；流式路由
    // 已经声明的 no-transform 等指令必须保留，避免中间层改写事件流。
    app.addHook('onSend', async (request, reply, payload) => {
        const pathname = pathOnly(request)
        const sensitiveResponse = pathname === '/api'
            || pathname.startsWith('/api/')
            || pathname === '/uploads/generated'
            || pathname.startsWith('/uploads/generated/')
        if (!sensitiveResponse) return payload

        const existingHeader = reply.getHeader('Cache-Control')
        const existing = Array.isArray(existingHeader)
            ? existingHeader.join(',')
            : existingHeader === undefined
                ? ''
                : String(existingHeader)
        const directives = existing
            .split(',')
            .map((directive) => directive.trim().toLowerCase())
            .filter((directive) => directive
                && directive !== 'public'
                && directive !== 'immutable'
                && !directive.startsWith('max-age=')
                && !directive.startsWith('s-maxage='))
        const policy = [...new Set([...directives, 'private', 'no-store'])].join(', ')
        reply.header('Cache-Control', policy)
        reply.header('Pragma', 'no-cache')
        return payload
    })
}

export const authRoutes: FastifyPluginAsync<{ service: AuthService }> = async (app, options) => {
    const service = options.service

    app.get('/status', async (request, reply) => {
        reply.header('Cache-Control', 'no-store')
        const session = service.sessionFromRequest(request)
        return {
            status: 'ok',
            mode: service.mode,
            authenticated: session !== null,
            user: session ? { id: session.id, name: session.name, role: session.role } : null,
            expiresAt: session?.expiresAt ?? null,
            demoTeachers: service.mode === 'demo'
                ? service.demoTeachers.map(({ id, name, role, classLabel }) => ({ id, name, role, classLabel }))
                : [],
        }
    })

    app.post('/login', async (request, reply) => {
        reply.header('Cache-Control', 'no-store')
        const parsed = loginBodySchema.safeParse(request.body)
        if (!parsed.success) {
            return reply.code(400).send({
                status: 'error',
                error: 'INVALID_LOGIN_REQUEST',
                message: '教师账号或登录凭据格式无效',
                statusCode: 400,
            })
        }
        try {
            const user = await service.authenticate(parsed.data, request.ip)
            const issued = service.issue(user)
            reply.header('Set-Cookie', service.cookiesForSession(request, issued.token, issued.session))
            return {
                status: 'ok',
                authenticated: true,
                user,
                expiresAt: issued.session.expiresAt,
                csrfToken: issued.session.csrfToken,
            }
        } catch (error) {
            if (error instanceof LoginRejectedError) {
                return reply.code(error.statusCode).send({
                    status: 'error',
                    error: error.statusCode === 429 ? 'LOGIN_RATE_LIMITED' : 'INVALID_CREDENTIALS',
                    message: error.message,
                    statusCode: error.statusCode,
                })
            }
            throw error
        }
    })

    app.post('/logout', async (request, reply) => {
        reply.header('Cache-Control', 'no-store')
        if (request.auth) service.revoke(request.auth)
        reply.header('Set-Cookie', service.cookiesForLogout(request))
        return { status: 'ok', authenticated: false }
    })
}
