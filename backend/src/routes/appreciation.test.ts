import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { appreciationRoutes } from './appreciation.js'

describe('appreciation resource truth contract', () => {
    let app: Awaited<ReturnType<typeof Fastify>> | undefined

    afterEach(async () => {
        if (app) await app.close()
        app = undefined
    })

    async function createApp() {
        app = Fastify({ logger: false })
        await app.register(appreciationRoutes, { prefix: '/api/appreciation' })
        return app
    }

    it.each([
        ['jingyesi', '静夜思', '李白'],
        ['poem-jingyesi', '静夜思', '李白'],
        ['tongbian-003', '静夜思', '李白'],
        ['chunxiao', '春晓', '孟浩然'],
        ['poem-chunxiao', '春晓', '孟浩然'],
        ['tongbian-002', '春晓', '孟浩然'],
    ] as const)('returns only the exact reviewed guide for %s', async (poemId, title, poet) => {
        const server = await createApp()
        const response = await server.inject({
            method: 'GET',
            url: `/api/appreciation/${poemId}`,
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({
            status: 'ok',
            poemId,
            poemTitle: title,
            poet,
            aiGenerated: true,
        })
    })

    it('returns 404 instead of substituting 静夜思 for an unknown poem', async () => {
        const server = await createApp()
        const response = await server.inject({
            method: 'GET',
            url: '/api/appreciation/audit-invalid-poemId',
        })

        expect(response.statusCode).toBe(404)
        expect(response.json()).toEqual({
            status: 'error',
            error: 'NOT_FOUND',
            message: '暂无该诗篇鉴赏指导',
        })
        expect(response.body).not.toContain('静夜思')
    })

    it('rejects a malformed poem id before route logic', async () => {
        const server = await createApp()
        const response = await server.inject({
            method: 'GET',
            url: '/api/appreciation/invalid.poem',
        })

        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({ status: 'error', error: 'VALIDATION_ERROR' })
    })
})
