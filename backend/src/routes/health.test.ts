/**
 * routes/health.ts 单元测试
 *
 * 覆盖：
 * - GET /health：返回 ok 状态、timestamp、uptime、service、version
 * - GET /health/db：数据库连接正常 + schema 已初始化 → status: ok
 * - GET /health/db：数据库连接正常 + schema 未初始化 → status: degraded
 * - GET /health/db：数据库连接失败 → status: degraded
 * - GET /health/db：响应包含所有 getDbStatus 返回的字段 + timestamp
 *
 * 设计原则：
 * - 使用 vi.mock 隔离 '../db/index.js'，避免初始化真实数据库连接
 * - 使用 Fastify inject 测试模式，不启动真实 HTTP 服务
 * - 每个测试创建独立的 Fastify 实例，避免状态污染
 * - 验证响应状态码、Content-Type、响应体字段
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// ─────────────────────────────────────────────────────────────
// Mock getDbStatus，避免触发真实数据库初始化
// 使用 vi.hoisted 确保 mock 引用在 vi.mock 工厂中可用
// ─────────────────────────────────────────────────────────────

const { mockGetDbStatus } = vi.hoisted(() => ({
    mockGetDbStatus: vi.fn(),
}))

vi.mock('../db/index.js', () => ({
    getDbStatus: mockGetDbStatus,
}))

// 在 mock 之后导入被测模块
import { healthRoutes } from './health.js'

// ─────────────────────────────────────────────────────────────
// 辅助：创建 Fastify 实例并注册 healthRoutes
// ─────────────────────────────────────────────────────────────

async function createApp(): Promise<FastifyInstance> {
    const app = Fastify({
        logger: false,
    })
    await app.register(healthRoutes, { prefix: '/api' })
    return app
}

describe('healthRoutes', () => {
    let app: FastifyInstance

    beforeEach(() => {
        mockGetDbStatus.mockReset()
    })

    afterEach(async () => {
        if (app) {
            await app.close()
        }
    })

    // ─────────────────────────────────────────────────────────
    // GET /api/health
    // ─────────────────────────────────────────────────────────

    describe('GET /api/health', () => {
        it('返回 200 状态码', async () => {
            app = await createApp()
            const response = await app.inject({
                method: 'GET',
                url: '/api/health',
            })
            expect(response.statusCode).toBe(200)
        })

        it('返回 status: ok', async () => {
            app = await createApp()
            const response = await app.inject({
                method: 'GET',
                url: '/api/health',
            })
            const body = response.json() as { status: string }
            expect(body.status).toBe('ok')
        })

        it('返回 ISO 格式 timestamp', async () => {
            app = await createApp()
            const before = new Date()
            const response = await app.inject({
                method: 'GET',
                url: '/api/health',
            })
            const after = new Date()
            const body = response.json() as { timestamp: string }
            const ts = new Date(body.timestamp)
            expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime())
            expect(ts.getTime()).toBeLessThanOrEqual(after.getTime())
        })

        it('返回 uptime（数字，大于 0）', async () => {
            app = await createApp()
            const response = await app.inject({
                method: 'GET',
                url: '/api/health',
            })
            const body = response.json() as { uptime: number }
            expect(typeof body.uptime).toBe('number')
            expect(body.uptime).toBeGreaterThan(0)
        })

        it('返回 service 字段为 poetic-realm-v5-backend', async () => {
            app = await createApp()
            const response = await app.inject({
                method: 'GET',
                url: '/api/health',
            })
            const body = response.json() as { service: string }
            expect(body.service).toBe('poetic-realm-v5-backend')
        })

        it('返回 version 字段为 5.0.0', async () => {
            app = await createApp()
            const response = await app.inject({
                method: 'GET',
                url: '/api/health',
            })
            const body = response.json() as { version: string }
            expect(body.version).toBe('5.0.0')
        })

        it('Content-Type 为 application/json', async () => {
            app = await createApp()
            const response = await app.inject({
                method: 'GET',
                url: '/api/health',
            })
            expect(response.headers['content-type']).toContain('application/json')
        })

        it('不调用 getDbStatus（基础健康检查不查数据库）', async () => {
            app = await createApp()
            await app.inject({
                method: 'GET',
                url: '/api/health',
            })
            expect(mockGetDbStatus).not.toHaveBeenCalled()
        })
    })

    // ─────────────────────────────────────────────────────────
    // GET /api/health/db
    // ─────────────────────────────────────────────────────────

    describe('GET /api/health/db', () => {
        it('数据库正常时返回 status: ok', async () => {
            mockGetDbStatus.mockReturnValue({
                connected: true,
                path: '/tmp/test.db',
                schemaInitialized: true,
                tableCount: 11,
            })
            app = await createApp()

            const response = await app.inject({
                method: 'GET',
                url: '/api/health/db',
            })

            expect(response.statusCode).toBe(200)
            const body = response.json() as { status: string }
            expect(body.status).toBe('ok')
        })

        it('数据库连接正常但 schema 未初始化时返回 status: degraded', async () => {
            mockGetDbStatus.mockReturnValue({
                connected: true,
                path: '/tmp/test.db',
                schemaInitialized: false,
                tableCount: 0,
            })
            app = await createApp()

            const response = await app.inject({
                method: 'GET',
                url: '/api/health/db',
            })

            const body = response.json() as { status: string }
            expect(body.status).toBe('degraded')
        })

        it('数据库连接失败时返回 status: degraded', async () => {
            mockGetDbStatus.mockReturnValue({
                connected: false,
                path: '/tmp/test.db',
                schemaInitialized: false,
                tableCount: 0,
            })
            app = await createApp()

            const response = await app.inject({
                method: 'GET',
                url: '/api/health/db',
            })

            const body = response.json() as { status: string }
            expect(body.status).toBe('degraded')
        })

        it('调用 getDbStatus 一次', async () => {
            mockGetDbStatus.mockReturnValue({
                connected: true,
                path: '/tmp/test.db',
                schemaInitialized: true,
                tableCount: 11,
            })
            app = await createApp()

            await app.inject({
                method: 'GET',
                url: '/api/health/db',
            })

            expect(mockGetDbStatus).toHaveBeenCalledTimes(1)
        })

        it('响应包含 getDbStatus 返回的所有字段', async () => {
            const dbStatus = {
                connected: true,
                path: '/custom/path.db',
                schemaInitialized: true,
                tableCount: 42,
            }
            mockGetDbStatus.mockReturnValue(dbStatus)
            app = await createApp()

            const response = await app.inject({
                method: 'GET',
                url: '/api/health/db',
            })

            const body = response.json() as Record<string, unknown>
            expect(body.connected).toBe(true)
            expect(body.path).toBe('/custom/path.db')
            expect(body.schemaInitialized).toBe(true)
            expect(body.tableCount).toBe(42)
        })

        it('响应包含 ISO 格式 timestamp', async () => {
            mockGetDbStatus.mockReturnValue({
                connected: true,
                path: '/tmp/test.db',
                schemaInitialized: true,
                tableCount: 11,
            })
            app = await createApp()
            const before = new Date()

            const response = await app.inject({
                method: 'GET',
                url: '/api/health/db',
            })
            const after = new Date()

            const body = response.json() as { timestamp: string }
            const ts = new Date(body.timestamp)
            expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime())
            expect(ts.getTime()).toBeLessThanOrEqual(after.getTime())
        })

        it('Content-Type 为 application/json', async () => {
            mockGetDbStatus.mockReturnValue({
                connected: true,
                path: '/tmp/test.db',
                schemaInitialized: true,
                tableCount: 11,
            })
            app = await createApp()

            const response = await app.inject({
                method: 'GET',
                url: '/api/health/db',
            })

            expect(response.headers['content-type']).toContain('application/json')
        })

        it('schema 未初始化但 connected 为 true 时仍返回 degraded', async () => {
            // 验证 status 公式：connected && schemaInitialized ? 'ok' : 'degraded'
            mockGetDbStatus.mockReturnValue({
                connected: true,
                path: '/tmp/test.db',
                schemaInitialized: false,
                tableCount: 5, // 部分表
            })
            app = await createApp()

            const response = await app.inject({
                method: 'GET',
                url: '/api/health/db',
            })

            const body = response.json() as { status: string }
            expect(body.status).toBe('degraded')
        })

        it('schema 已初始化但 connected 为 false 时返回 degraded', async () => {
            // 验证 status 公式的短路逻辑：connected 必须为 true
            mockGetDbStatus.mockReturnValue({
                connected: false,
                path: '/tmp/test.db',
                schemaInitialized: true,
                tableCount: 11,
            })
            app = await createApp()

            const response = await app.inject({
                method: 'GET',
                url: '/api/health/db',
            })

            const body = response.json() as { status: string }
            expect(body.status).toBe('degraded')
        })

        it('tableCount 为 0 时（连接正常但无表）返回 degraded', async () => {
            mockGetDbStatus.mockReturnValue({
                connected: true,
                path: '/tmp/test.db',
                schemaInitialized: false,
                tableCount: 0,
            })
            app = await createApp()

            const response = await app.inject({
                method: 'GET',
                url: '/api/health/db',
            })

            const body = response.json() as { status: string }
            expect(body.status).toBe('degraded')
        })
    })

    // ─────────────────────────────────────────────────────────
    // 404 路由
    // ─────────────────────────────────────────────────────────

    describe('未注册的路由', () => {
        it('未注册路径返回 404', async () => {
            app = await createApp()
            const response = await app.inject({
                method: 'GET',
                url: '/api/unknown',
            })
            expect(response.statusCode).toBe(404)
        })

        it('未注册 /api/health/unknown 子路径返回 404', async () => {
            app = await createApp()
            const response = await app.inject({
                method: 'GET',
                url: '/api/health/unknown',
            })
            expect(response.statusCode).toBe(404)
        })
    })
})
