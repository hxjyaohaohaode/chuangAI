import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Orchestrator } from '../orchestrator/Orchestrator.js'
import type { SessionStore } from '../orchestrator/session-store.js'
import type { WSBroadcaster } from '../orchestrator/websocket/broadcaster.js'

const mocks = vi.hoisted(() => ({
    stores: new Map<string, Map<string, unknown>>(),
    broadcast: vi.fn(),
}))

vi.mock('../db/runtime-store.js', () => ({
    SqliteMap: class InMemorySqliteMap {
        private readonly valuesByKey: Map<string, unknown>

        constructor(options: { table: string }) {
            const existing = mocks.stores.get(options.table)
            this.valuesByKey = existing ?? new Map<string, unknown>()
            mocks.stores.set(options.table, this.valuesByKey)
        }

        get size(): number {
            return this.valuesByKey.size
        }

        get(key: string): unknown {
            return this.valuesByKey.get(String(key))
        }

        set(key: string, value: unknown): this {
            this.valuesByKey.set(String(key), value)
            return this
        }

        entries(): IterableIterator<[string, unknown]> {
            return this.valuesByKey.entries()
        }

        [Symbol.iterator](): IterableIterator<[string, unknown]> {
            return this.entries()
        }
    },
}))

vi.mock('../db/index.js', () => ({
    db: {
        prepare: vi.fn(() => ({
            run: vi.fn(),
            get: vi.fn(),
            all: vi.fn(() => []),
        })),
    },
    repos: {
        poems: { findById: vi.fn() },
        classes: { findById: vi.fn() },
        students: { findByClassId: vi.fn(() => []) },
        mastery: { findByStudentAndPoem: vi.fn(() => []) },
        errorNotebook: { findDueForReview: vi.fn(() => []) },
    },
}))

vi.mock('../agents/index.js', () => ({
    agents: { brush: { creative: { invoke: vi.fn() } } },
}))

import {
    lessonPlanRoutes,
    type LessonPlanExportRenderer,
} from './lesson-plan.js'

const PRIVATE_ERROR = 'sk-secret-EXPORT provider_raw={"request_id":"raw-id"} SQL=C:\\private\\lesson.db'

function validPlan(id: string, title = '《静夜思》教学设计'): Record<string, unknown> {
    const now = Date.now()
    return {
        id,
        poemId: 'poem-jingyesi',
        poemTitle: '静夜思',
        poet: '李白',
        dynasty: '唐',
        gradeLevel: '3-4年级',
        classId: 'class-001',
        className: '三（2）班',
        teacherName: '测试教师',
        title,
        lessonCount: 1,
        goals: [{
            category: 'knowledge',
            bloomLevel: '理解',
            description: '理解诗歌中的思乡之情',
            assessment: '能够结合诗句说明',
        }],
        keyPoints: ['理解核心意象'],
        difficultPoints: ['体会情感'],
        preparations: ['课件'],
        teachingProcess: [{
            phase: 'interpretation',
            title: '品读诗句',
            durationMin: 15,
            teacherActivity: '引导学生圈画关键词',
            studentActivity: '朗读并交流',
            designIntent: '从语言进入情感',
            bloomLevels: ['理解'],
            goalIndices: [0],
        }],
        boardDesign: {
            title: '板书',
            content: '明月 → 故乡',
            intent: '呈现意象与情感联系',
        },
        homework: [{
            type: 'recitation',
            description: '背诵全诗',
            estimatedMin: 10,
            bloomLevel: '记忆',
            optional: false,
        }],
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        aiGenerated: false,
    }
}

describe('lesson-plan export HTTP error boundary', () => {
    let app: FastifyInstance | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        for (const store of mocks.stores.values()) store.clear()
    })

    afterEach(async () => {
        if (app) await app.close()
        app = undefined
    })

    async function createApp(renderExport?: LessonPlanExportRenderer): Promise<FastifyInstance> {
        app = Fastify({ logger: false })
        app.addHook('onRequest', async (request) => {
            request.auth = {
                id: 'teacher-export-boundary',
                name: '测试教师',
                role: 'teacher',
                issuedAt: 1,
                expiresAt: Number.MAX_SAFE_INTEGER,
                csrfToken: 'csrf-export-boundary',
                sessionId: 'session-export-boundary',
            }
        })
        await app.register(lessonPlanRoutes, {
            prefix: '/api/lesson-plans',
            orchestrator: {} as Orchestrator,
            sessionStore: {} as SessionStore,
            broadcaster: { broadcast: mocks.broadcast } as unknown as WSBroadcaster,
            renderExport,
        })
        return app
    }

    async function savePlan(server: FastifyInstance, plan: Record<string, unknown>): Promise<void> {
        const response = await server.inject({
            method: 'POST',
            url: '/api/lesson-plans/save',
            payload: plan,
        })
        expect(response.statusCode).toBe(200)
    }

    it('渲染器异常保留原失败响应形状，但 error 永远是通用安全文案', async () => {
        const renderExport = vi.fn(() => {
            throw new Error(PRIVATE_ERROR)
        })
        const server = await createApp(renderExport)
        await savePlan(server, validPlan('plan-export-error'))

        const response = await server.inject({
            method: 'POST',
            url: '/api/lesson-plans/plan-export-error/export',
            payload: { format: 'html' },
        })

        expect(response.statusCode).toBe(500)
        const body = response.json() as Record<string, unknown>
        expect(Object.keys(body).sort()).toEqual([
            'aiGenerated',
            'content',
            'error',
            'exportId',
            'fileName',
            'format',
            'generatedAt',
            'mimeType',
            'reportId',
            'success',
        ])
        expect(body).toMatchObject({
            reportId: 'plan-export-error',
            format: 'html',
            fileName: '',
            mimeType: 'text/plain',
            content: '',
            success: false,
            error: '教案导出失败，请稍后重试',
            aiGenerated: false,
        })
        expect(response.body).not.toContain('sk-secret-EXPORT')
        expect(response.body).not.toContain('provider_raw')
        expect(response.body).not.toContain('lesson.db')
        expect(renderExport).toHaveBeenCalledTimes(1)
    })

    it('默认 HTML 导出继续逐字段转义，不因错误边界改造而回退', async () => {
        const unsafeTitle = '教案 <img src=x> & "引号"'
        const server = await createApp()
        await savePlan(server, validPlan('plan-export-html', unsafeTitle))

        const response = await server.inject({
            method: 'POST',
            url: '/api/lesson-plans/plan-export-html/export',
            payload: { format: 'html' },
        })

        expect(response.statusCode).toBe(200)
        const body = response.json() as { success: boolean; content: string }
        expect(body.success).toBe(true)
        expect(body.content).toContain('教案 &lt;img src=x&gt; &amp; &quot;引号&quot;')
        expect(body.content).not.toContain(unsafeTitle)
    })
})
