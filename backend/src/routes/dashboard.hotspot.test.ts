import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    findClassById: vi.fn(),
    findClasses: vi.fn(() => []),
    cacheGet: vi.fn(),
    cacheSet: vi.fn(),
    cacheDelete: vi.fn((_key: unknown) => true),
    deepseekChat: vi.fn(),
}))

vi.mock('../db/index.js', () => ({
    db: {
        exec: vi.fn(),
        prepare: vi.fn(),
        transaction: vi.fn((fn: () => unknown) => fn),
    },
    repos: {
        classes: {
            findById: mocks.findClassById,
            findAll: mocks.findClasses,
        },
        students: {},
        poems: {},
        lessons: {},
        questions: {},
        answers: {},
        mastery: {},
        events: {},
    },
    services: {
        event: { calculateEngagement: vi.fn(() => 0) },
    },
}))

vi.mock('../db/runtime-store.js', () => ({
    SqliteMap: class {
        get(key: unknown) {
            return mocks.cacheGet(key)
        }

        set(key: unknown, value: unknown) {
            mocks.cacheSet(key, value)
            return this
        }

        delete(key: unknown) {
            return mocks.cacheDelete(key)
        }
    },
}))

vi.mock('../llm/index.js', () => ({
    managedLLM: { chat: mocks.deepseekChat },
}))

// 本文件只验证热点路由；隔离趋势预警的持久化状态，避免无关单例参与测试。
vi.mock('../services/profile/trend-alert.js', () => ({
    generateTrendAlerts: vi.fn(() => []),
    queryTrendAlerts: vi.fn(() => []),
    resolveAlert: vi.fn(() => false),
    resolveAlerts: vi.fn(() => 0),
}))

import { dashboardRoutes } from './dashboard.js'

describe('dashboard class hotspot truth boundary', () => {
    let app: Awaited<ReturnType<typeof Fastify>> | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.findClassById.mockReturnValue(null)
        // 模拟升级前已经留下的“未知班级”毒化缓存；服务必须先查真相源，
        // 因而这个值绝不能被读取或返回。
        mocks.cacheGet.mockReturnValue({
            classId: 'missing-class',
            className: '未知班级',
            generatedAt: Date.now(),
        })
        mocks.cacheDelete.mockReturnValue(true)
    })

    afterEach(async () => {
        if (app) await app.close()
        app = undefined
    })

    async function createApp() {
        app = Fastify({ logger: false })
        await app.register(dashboardRoutes, { prefix: '/api/dashboard' })
        return app
    }

    it.each([
        ['GET query endpoint', 'GET', '/api/dashboard/class-hotspot?classId=missing-class'],
        ['GET resource endpoint', 'GET', '/api/dashboard/class/missing-class/hotspot'],
        ['POST refresh endpoint without an optional body', 'POST', '/api/dashboard/class/missing-class/hotspot/refresh'],
    ] as const)('%s returns an explicit 404 and purges stale cache', async (_label, method, url) => {
        const server = await createApp()
        const response = await server.inject({ method, url })

        expect(response.statusCode).toBe(404)
        expect(response.json()).toEqual({
            status: 'error',
            error: 'CLASS_NOT_FOUND',
            message: '班级不存在',
        })
        expect(mocks.findClassById).toHaveBeenCalledWith('missing-class')
        expect(mocks.cacheGet).not.toHaveBeenCalled()
        expect(mocks.cacheSet).not.toHaveBeenCalled()
        expect(mocks.cacheDelete).toHaveBeenCalledWith('v2:missing-class')
    })

    it('stops after an invalid refresh body instead of continuing after the 400 response', async () => {
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/dashboard/class/real-class/hotspot/refresh',
            payload: { forceRefresh: 'yes' },
        })

        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({ status: 'error', error: 'VALIDATION_ERROR' })
        expect(mocks.findClassById).not.toHaveBeenCalled()
        expect(mocks.cacheGet).not.toHaveBeenCalled()
        expect(mocks.cacheSet).not.toHaveBeenCalled()
    })
})
