import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WSBroadcaster } from '../orchestrator/websocket/broadcaster.js'

const mocks = vi.hoisted(() => ({
    stores: new Map<string, Map<string, unknown>>(),
    createLesson: vi.fn(),
    broadcast: vi.fn(),
}))

vi.mock('../db/runtime-store.js', () => ({
    SqliteMap: class InMemorySqliteMap {
        private readonly valuesByKey: Map<string, unknown>
        private readonly indexes: Array<{
            name: string
            extract: (value: unknown, key: string) => string | number | null
        }>

        constructor(options: {
            table: string
            indexes?: Array<{
                name: string
                extract: (value: unknown, key: string) => string | number | null
            }>
        }) {
            const existing = mocks.stores.get(options.table)
            this.valuesByKey = existing ?? new Map<string, unknown>()
            mocks.stores.set(options.table, this.valuesByKey)
            this.indexes = options.indexes ?? []
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

        delete(key: string): boolean {
            return this.valuesByKey.delete(String(key))
        }

        clear(): void {
            this.valuesByKey.clear()
        }

        entries(): IterableIterator<[string, unknown]> {
            return this.valuesByKey.entries()
        }

        values(): IterableIterator<unknown> {
            return this.valuesByKey.values()
        }

        [Symbol.iterator](): IterableIterator<[string, unknown]> {
            return this.entries()
        }

        findByIndex(indexName: string, indexValue: string | number): Array<{ key: string; value: unknown }> {
            const index = this.indexes.find((candidate) => candidate.name === indexName)
            if (!index) throw new Error(`Unknown test index: ${indexName}`)
            return [...this.valuesByKey.entries()]
                .filter(([key, value]) => index.extract(value, key) === indexValue)
                .map(([key, value]) => ({ key, value }))
        }
    },
}))

vi.mock('../db/index.js', () => ({
    db: {
        prepare: vi.fn(() => ({ get: vi.fn(() => ({ avg_score: null })) })),
    },
    repos: {
        classes: {
            findById: vi.fn((id: string) => id === 'class-safe-boundary'
                ? {
                    id,
                    name: '边界测试班',
                    grade: '三年级',
                    teacherId: 'teacher-safe-boundary',
                    studentCount: 0,
                    createdAt: 1,
                    updatedAt: 1,
                    metadata: null,
                }
                : null),
        },
        poems: {
            findById: vi.fn((id: string) => id === 'poem-safe-boundary'
                ? {
                    id,
                    title: '静夜思',
                    poet: '李白',
                    dynasty: '唐',
                    content: '床前明月光，疑是地上霜。',
                    annotation: null,
                    theme: ['思乡'],
                    images: ['明月'],
                    rhetoric: [],
                    gradeLevel: '3-4年级',
                    textbookEdition: '统编版',
                    difficulty: 2,
                    createdAt: 1,
                    metadata: null,
                }
                : null),
        },
        questions: {
            findById: vi.fn(),
            findByPoemId: vi.fn((poemId: string) => poemId === 'poem-safe-boundary'
                ? [{
                    id: 'question-safe-boundary',
                    poemId,
                    bloomLevel: '理解',
                    type: '简答',
                    stem: '诗句表达了什么情感？',
                    options: null,
                    answer: '思乡之情',
                    analysis: '由“思故乡”可知。',
                    distractorsAnalysis: null,
                    difficulty: 0.4,
                    estimatedTimeSec: 60,
                    aiGenerated: true,
                    promptVersion: 'test',
                    createdAt: 1,
                    createdBy: 'teacher-safe-boundary',
                    metadata: null,
                }]
                : []),
        },
        lessons: {
            create: mocks.createLesson,
        },
    },
    services: {
        event: { record: vi.fn() },
    },
}))

import { DanceStageError } from '../orchestrator/dance-stage.js'
import { classroomRoutes, type ClassroomRouteServices } from './classroom.js'

const PRIVATE_ERROR = 'sk-secret-CLASSROOM provider_raw={"token":"leak"} SQL=C:\\private\\tenant.db'

describe('classroom non-streaming HTTP error boundary', () => {
    let app: FastifyInstance | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        for (const store of mocks.stores.values()) store.clear()
        mocks.createLesson.mockImplementation((input: Record<string, unknown>) => input)
    })

    afterEach(async () => {
        if (app) await app.close()
        app = undefined
    })

    async function createStartedClassroom(services: ClassroomRouteServices): Promise<{
        server: FastifyInstance
        lessonId: string
    }> {
        app = Fastify({ logger: false })
        await app.register(classroomRoutes, {
            prefix: '/api/classroom',
            broadcaster: { broadcast: mocks.broadcast } as unknown as WSBroadcaster,
            services,
        })

        const started = await app.inject({
            method: 'POST',
            url: '/api/classroom/start',
            payload: {
                classId: 'class-safe-boundary',
                poemId: 'poem-safe-boundary',
                mode: 'collective-race',
            },
        })
        expect(started.statusCode).toBe(200)
        const lessonId = (started.json() as { lessonId: string }).lessonId
        return { server: app, lessonId }
    }

    it('干预异常仅返回稳定 code 与安全中文消息，不泄漏底层异常', async () => {
        const detectIntervention = vi.fn().mockRejectedValue(new Error(PRIVATE_ERROR))
        const { server, lessonId } = await createStartedClassroom({ detectIntervention })

        const response = await server.inject({
            method: 'POST',
            url: `/api/classroom/${lessonId}/ai/intervention`,
        })

        expect(response.statusCode).toBe(500)
        expect(response.json()).toEqual({
            status: 'error',
            error: 'CLASSROOM_INTERVENTION_FAILED',
            message: '干预建议生成失败，请稍后重试',
        })
        expect(response.body).not.toContain('sk-secret-CLASSROOM')
        expect(response.body).not.toContain('provider_raw')
        expect(response.body).not.toContain('tenant.db')
        expect(detectIntervention).toHaveBeenCalledTimes(1)
    })

    it.each([
        {
            stageError: new DanceStageError('STAGE_CLOSED', PRIVATE_ERROR),
            expectedCode: 'DANCE_STAGE_UNAVAILABLE',
            expectedMessage: '共舞服务暂不可用，请稍后重试',
        },
        {
            stageError: new DanceStageError('SESSION_LIMIT_REACHED', PRIVATE_ERROR),
            expectedCode: 'DANCE_STAGE_BUSY',
            expectedMessage: '共舞服务当前繁忙，请稍后重试',
        },
    ])('共舞已知业务态 $expectedCode 通过类型映射为安全 503', async ({
        stageError,
        expectedCode,
        expectedMessage,
    }) => {
        const startDanceSession = vi.fn(() => {
            throw stageError
        })
        const { server, lessonId } = await createStartedClassroom({ startDanceSession })

        const response = await server.inject({
            method: 'POST',
            url: `/api/classroom/${lessonId}/dance/start`,
        })

        expect(response.statusCode).toBe(503)
        expect(response.json()).toEqual({
            status: 'error',
            error: expectedCode,
            message: expectedMessage,
        })
        expect(response.body).not.toContain('sk-secret-CLASSROOM')
        expect(response.body).not.toContain('provider_raw')
        expect(response.body).not.toContain('tenant.db')
    })

    it('共舞未知异常以安全 500 收口，不用异常字符串猜业务状态', async () => {
        const startDanceSession = vi.fn(() => {
            throw new Error(PRIVATE_ERROR)
        })
        const { server, lessonId } = await createStartedClassroom({ startDanceSession })

        const response = await server.inject({
            method: 'POST',
            url: `/api/classroom/${lessonId}/dance/start`,
        })

        expect(response.statusCode).toBe(500)
        expect(response.json()).toEqual({
            status: 'error',
            error: 'DANCE_SESSION_START_FAILED',
            message: '共舞会话启动失败，请稍后重试',
        })
        expect(response.body).not.toContain('sk-secret-CLASSROOM')
        expect(response.body).not.toContain('provider_raw')
        expect(response.body).not.toContain('tenant.db')
    })

    it('干预成功路径保持原响应契约', async () => {
        const intervention = {
            strugglingStudents: [],
            classSuggestion: '全班整体表现良好。',
        }
        const { server, lessonId } = await createStartedClassroom({
            detectIntervention: vi.fn().mockResolvedValue(intervention),
        })

        const response = await server.inject({
            method: 'POST',
            url: `/api/classroom/${lessonId}/ai/intervention`,
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
            status: 'ok',
            lessonId,
            category: 'intervention',
            intervention,
        })
    })
})
