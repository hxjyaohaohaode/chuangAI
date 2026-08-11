import { randomBytes, scryptSync } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
    AuthService,
    authRoutes,
    installAuthBoundary,
    type AuthServiceOptions,
} from './auth.js'

const apps: FastifyInstance[] = []
const DEMO_PHONE = '13177091153'
const DEMO_PASSWORD = 'Chy101713'

afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
})

function options(overrides: Partial<AuthServiceOptions> = {}): AuthServiceOptions {
    return {
        mode: 'demo',
        sessionSecret: 'test-session-secret-with-at-least-thirty-two-characters',
        sessionTtlSeconds: 480 * 60,
        cookieSecure: 'false',
        teacherId: 'teacher-001',
        teacherName: '王雅琴',
        teacherPhone: '13900000000',
        passwordScrypt: '',
        corsOrigins: ['http://localhost:5173'],
        ...overrides,
    }
}

async function build(service = new AuthService(options())) {
    const app = Fastify({ logger: false })
    apps.push(app)
    installAuthBoundary(app, service)
    await app.register(authRoutes, { prefix: '/api/auth', service })
    app.get('/api/health', async () => ({ status: 'ok' }))
    app.get('/api/health/db', async () => ({ schema: 'private' }))
    app.get('/api/protected', async (request) => ({ teacherId: request.auth?.id }))
    app.get('/api/report/shared/:token', async (request) => ({
        publicToken: (request.params as { token: string }).token,
    }))
    app.get('/api/report/shared', async () => ({ scope: 'private-list' }))
    app.post('/api/report/share', async () => ({ scope: 'private-create' }))
    app.delete('/api/report/shared/:token', async () => ({ scope: 'private-revoke' }))
    app.get('/ws/protected', async (request) => ({ teacherId: request.auth?.id }))
    app.get('/api/protected-stream-policy', async (_request, reply) => {
        reply.header('Cache-Control', 'no-cache, no-transform')
        return { status: 'ok' }
    })
    app.get('/uploads/generated/example.webp', async (_request, reply) => {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable')
        return reply.type('image/webp').send(Buffer.from('test-image'))
    })
    app.post('/api/protected', async (request) => ({ teacherId: request.auth?.id, body: request.body }))
    await app.ready()
    return app
}

function cookieHeader(response: { headers: Record<string, string | string[] | number | undefined> }): string {
    const value = response.headers['set-cookie']
    const cookies = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
    return cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ')
}

async function login(app: FastifyInstance, phone = DEMO_PHONE, extra: Record<string, unknown> = {}) {
    const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { phone, password: DEMO_PASSWORD, ...extra },
    })
    return {
        response,
        body: response.json() as { csrfToken?: string; user?: { id: string; name: string } },
        cookie: cookieHeader(response),
    }
}

describe('server authentication boundary', () => {
    it('拒绝弱显式会话密钥、越界 TTL 和缺失密码摘要', () => {
        expect(() => new AuthService(options({ sessionSecret: 'too-short' }))).toThrow(/32/)
        expect(() => new AuthService(options({ sessionTtlSeconds: 60 }))).toThrow(/5 分钟/)
        expect(() => new AuthService(options({ mode: 'password', passwordScrypt: '' }))).toThrow(/scrypt/)
    })

    it('只公开健康摘要与认证状态，业务和数据库健康细节默认返回 401', async () => {
        const app = await build()
        const health = await app.inject({ url: '/api/health' })
        expect(health.statusCode).toBe(200)
        expect(health.headers['cache-control']).toContain('no-store')
        expect(health.headers.pragma).toBe('no-cache')
        const status = await app.inject({ url: '/api/auth/status' })
        expect(status.json()).toMatchObject({
            authenticated: false,
            mode: 'demo',
        })
        expect(status.headers['cache-control']).toContain('no-store')
        const privateHealth = await app.inject({ url: '/api/health/db' })
        expect(privateHealth.statusCode).toBe(401)
        expect(privateHealth.headers['cache-control']).toContain('no-store')
        const protectedResponse = await app.inject({ url: '/api/protected' })
        expect(protectedResponse.statusCode).toBe(401)
        expect(protectedResponse.headers['cache-control']).toContain('no-store')
        const generatedMedia = await app.inject({ url: '/uploads/generated/example.webp' })
        expect(generatedMedia.statusCode).toBe(401)
        expect(generatedMedia.headers['cache-control']).toContain('private')
        expect(generatedMedia.headers['cache-control']).toContain('no-store')
    })

    it('只匿名放行报告分享的 GET 单 token 路径，管理面和相邻路径仍返回 401', async () => {
        const app = await build()
        const token = 'a'.repeat(43)

        const publicRead = await app.inject({
            method: 'GET',
            url: `/api/report/shared/${token}`,
        })
        expect(publicRead.statusCode).toBe(200)
        expect(publicRead.json()).toEqual({ publicToken: token })
        expect(publicRead.headers['cache-control']).toContain('no-store')

        for (const request of [
            { method: 'GET' as const, url: '/api/report/shared' },
            { method: 'GET' as const, url: `/api/report/shared/${token}/nested` },
            { method: 'HEAD' as const, url: `/api/report/shared/${token}` },
            { method: 'POST' as const, url: '/api/report/share', payload: {} },
            { method: 'DELETE' as const, url: `/api/report/shared/${token}` },
        ]) {
            const response = await app.inject(request)
            expect(response.statusCode, `${request.method} ${request.url}`).toBe(401)
            if (request.method === 'HEAD') {
                expect(response.body).toBe('')
            } else {
                expect(response.json()).toMatchObject({ error: 'AUTHENTICATION_REQUIRED' })
            }
        }
    })

    it('演示模式只接受服务器白名单档案并返回权威姓名', async () => {
        const app = await build()
        const rejected = await login(app, '13900000000')
        expect(rejected.response.statusCode).toBe(401)

        const accepted = await login(app)
        expect(accepted.response.statusCode).toBe(200)
        expect(accepted.body.user).toEqual({
            id: 'teacher-001', name: '演示教师', role: 'teacher', accountType: 'demo',
        })
        expect(accepted.cookie).toContain('pr_session=')
        expect(accepted.cookie).toContain('pr_csrf=')
        const setCookie = accepted.response.headers['set-cookie']
        expect(String(setCookie)).toContain('HttpOnly')
        expect(String(setCookie)).toContain('SameSite=Strict')
    })

    it('有效 HttpOnly 会话可访问业务接口，签名篡改会失败关闭', async () => {
        const app = await build()
        const authenticated = await login(app)
        expect((await app.inject({
            url: '/api/protected',
            headers: { cookie: authenticated.cookie },
        })).json()).toEqual({ teacherId: 'teacher-001' })

        const streamPolicy = await app.inject({
            url: '/api/protected-stream-policy',
            headers: { cookie: authenticated.cookie },
        })
        expect(streamPolicy.headers['cache-control']).toContain('no-cache')
        expect(streamPolicy.headers['cache-control']).toContain('no-transform')
        expect(streamPolicy.headers['cache-control']).toContain('private')
        expect(streamPolicy.headers['cache-control']).toContain('no-store')

        const generatedMedia = await app.inject({
            url: '/uploads/generated/example.webp',
            headers: { cookie: authenticated.cookie },
        })
        expect(generatedMedia.statusCode).toBe(200)
        expect(generatedMedia.headers['content-type']).toContain('image/webp')
        expect(generatedMedia.headers['cache-control']).toContain('private')
        expect(generatedMedia.headers['cache-control']).toContain('no-store')
        expect(generatedMedia.headers['cache-control']).not.toContain('public')
        expect(generatedMedia.headers['cache-control']).not.toContain('max-age')

        const forged = authenticated.cookie.replace(/pr_session=([^; ]+)/u, (_match, token: string) => (
            `pr_session=${token.slice(0, -1)}x`
        ))
        expect((await app.inject({
            url: '/api/protected',
            headers: { cookie: forged },
        })).statusCode).toBe(401)
    })

    it('写请求必须通过双提交 CSRF，且显式恶意 Origin 即使持有令牌也被拒绝', async () => {
        const app = await build()
        const authenticated = await login(app)
        const baseHeaders = { cookie: authenticated.cookie, 'content-type': 'application/json' }

        expect((await app.inject({
            method: 'POST', url: '/api/protected', headers: baseHeaders, payload: {},
        })).statusCode).toBe(403)
        expect((await app.inject({
            method: 'POST',
            url: '/api/protected',
            headers: { ...baseHeaders, 'x-csrf-token': 'wrong' },
            payload: {},
        })).statusCode).toBe(403)
        expect((await app.inject({
            method: 'POST',
            url: '/api/protected',
            headers: {
                ...baseHeaders,
                origin: 'https://attacker.example',
                'x-csrf-token': authenticated.body.csrfToken ?? '',
            },
            payload: {},
        })).statusCode).toBe(403)
        expect((await app.inject({
            method: 'POST',
            url: '/api/protected',
            headers: {
                ...baseHeaders,
                origin: 'http://localhost:5173',
                'x-csrf-token': authenticated.body.csrfToken ?? '',
            },
            payload: {},
        })).statusCode).toBe(200)
    })

    it('WebSocket GET 握手必须携带白名单 Origin，阻断同站不同源劫持', async () => {
        const app = await build()
        const authenticated = await login(app)

        const missingOrigin = await app.inject({
            url: '/ws/protected',
            headers: { cookie: authenticated.cookie },
        })
        expect(missingOrigin.statusCode).toBe(403)
        expect(missingOrigin.json()).toMatchObject({ error: 'ORIGIN_REJECTED' })

        const hostileOrigin = await app.inject({
            url: '/ws/protected',
            headers: { cookie: authenticated.cookie, origin: 'http://localhost:6666' },
        })
        expect(hostileOrigin.statusCode).toBe(403)
        expect(hostileOrigin.json()).toMatchObject({ error: 'ORIGIN_REJECTED' })

        const allowedOrigin = await app.inject({
            url: '/ws/protected',
            headers: { cookie: authenticated.cookie, origin: 'http://localhost:5173' },
        })
        expect(allowedOrigin.statusCode).toBe(200)
        expect(allowedOrigin.json()).toEqual({ teacherId: 'teacher-001' })
    })

    it('客户端 Host 或 X-Forwarded-Proto 不能扩大允许的 CSRF Origin 集合', async () => {
        const app = await build()
        const authenticated = await login(app)

        const response = await app.inject({
            method: 'POST',
            url: '/api/protected',
            headers: {
                cookie: authenticated.cookie,
                'content-type': 'application/json',
                host: 'attacker.example',
                'x-forwarded-proto': 'https',
                origin: 'https://attacker.example',
                'x-csrf-token': authenticated.body.csrfToken ?? '',
            },
            payload: {},
        })

        expect(response.statusCode).toBe(403)
        expect(response.json()).toMatchObject({ error: 'ORIGIN_REJECTED' })
    })

    it('查询或请求体中的 teacherId 不能越过会话主体', async () => {
        const app = await build()
        const authenticated = await login(app)
        expect((await app.inject({
            url: '/api/protected?teacherId=teacher-002',
            headers: { cookie: authenticated.cookie },
        })).statusCode).toBe(403)
        expect((await app.inject({
            method: 'POST',
            url: '/api/protected',
            headers: {
                cookie: authenticated.cookie,
                'x-csrf-token': authenticated.body.csrfToken ?? '',
            },
            payload: { teacherId: 'teacher-002' },
        })).statusCode).toBe(403)
        expect((await app.inject({
            method: 'POST',
            url: '/api/protected',
            headers: {
                cookie: authenticated.cookie,
                'x-csrf-token': authenticated.body.csrfToken ?? '',
            },
            payload: { params: { teacherId: 'teacher-002' } },
        })).statusCode).toBe(403)
    })

    it('注销撤销当前进程内会话并清除两枚 Cookie', async () => {
        const app = await build()
        const authenticated = await login(app)
        const logout = await app.inject({
            method: 'POST',
            url: '/api/auth/logout',
            headers: {
                cookie: authenticated.cookie,
                'x-csrf-token': authenticated.body.csrfToken ?? '',
            },
        })
        expect(logout.statusCode).toBe(200)
        expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0')
        expect((await app.inject({
            url: '/api/protected', headers: { cookie: authenticated.cookie },
        })).statusCode).toBe(401)
    })

    it('会话过期和使用新临时密钥的服务重启都使旧令牌失效', async () => {
        let now = Date.parse('2026-08-04T00:00:00Z')
        const expiringService = new AuthService(options({
            sessionTtlSeconds: 300,
            now: () => now,
        }))
        const app = await build(expiringService)
        const authenticated = await login(app)
        now += 301_000
        expect((await app.inject({
            url: '/api/protected', headers: { cookie: authenticated.cookie },
        })).statusCode).toBe(401)

        const first = new AuthService(options({ sessionSecret: '' }))
        const issued = first.issue({ id: 'teacher-001', name: '王雅琴', role: 'teacher' })
        const restarted = new AuthService(options({ sessionSecret: '' }))
        expect(restarted.verify(issued.token)).toBeNull()
    })

    it('密码模式校验 scrypt 摘要，并在连续失败后临时限速', async () => {
        const salt = randomBytes(16)
        const expected = scryptSync('correct horse battery staple', salt, 32, {
            N: 16_384, r: 8, p: 1, maxmem: 128 * 1024 * 1024,
        })
        const passwordScrypt = `scrypt$16384$8$1$${salt.toString('base64url')}$${expected.toString('base64url')}`
        const service = new AuthService(options({
            mode: 'password', passwordScrypt, teacherPhone: '13900000000',
        }))
        const app = await build(service)

        for (let attempt = 0; attempt < 5; attempt += 1) {
            const response = await login(app, '13900000000', { password: 'wrong' })
            expect(response.response.statusCode).toBe(401)
        }
        expect((await login(app, '13900000000', { password: 'correct horse battery staple' })).response.statusCode).toBe(429)
    })
})
