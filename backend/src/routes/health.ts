import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { getDbStatus } from '../db/index.js'

/**
 * 健康检查路由
 * GET /api/health          -> { status: 'ok', timestamp, uptime }
 * GET /api/health/db       -> 数据库状态（连接、schema、表数量）
 */
export const healthRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/health', async () => {
        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            service: 'poetic-realm-v5-backend',
            version: '5.0.0',
        }
    })

    app.get('/health/db', async () => {
        const status = getDbStatus()
        return {
            status: status.connected && status.schemaInitialized ? 'ok' : 'degraded',
            ...status,
            timestamp: new Date().toISOString(),
        }
    })
}
