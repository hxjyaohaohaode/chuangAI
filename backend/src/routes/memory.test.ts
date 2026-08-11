import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { findByTeacherId, findStudentById } = vi.hoisted(() => ({
    findByTeacherId: vi.fn((teacherId: string) => teacherId === 'teacher-a' ? [{ id: 'class-a' }] : []),
    findStudentById: vi.fn((studentId: string) => studentId === 'student-a' ? { id: studentId, classId: 'class-a' } : null),
}))

vi.mock('../db/index.js', async () => {
    const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
    return {
        ...actual,
        repos: {
            ...actual.repos,
            classes: { ...actual.repos.classes, findByTeacherId },
            students: { ...actual.repos.students, findById: findStudentById },
        },
    }
})

import { memoryStore } from '../agents/base/long-term-memory.js'
import { memoryRoutes } from './memory.js'

describe('memory governance routes', () => {
    let app: Awaited<ReturnType<typeof Fastify>> | undefined

    afterEach(async () => {
        memoryStore.deleteAll({ ownerId: 'teacher-a' })
        if (app) await app.close()
        app = undefined
    })

    async function createApp() {
        app = Fastify({ logger: false })
        await app.register(memoryRoutes, { prefix: '/api/memory' })
        return app
    }

    it('supports explicit teacher create/list/update/delete with ownership checks', async () => {
        const server = await createApp()
        const created = await server.inject({
            method: 'POST',
            url: '/api/memory',
            payload: {
                teacherId: 'teacher-a',
                kind: 'student',
                studentId: 'student-a',
                classId: 'class-a',
                content: '诗意 理解',
            },
        })
        expect(created.statusCode).toBe(201)
        const id = (created.json() as { memory: { id: string } }).memory.id

        const listed = await server.inject({
            method: 'GET',
            url: '/api/memory?teacherId=teacher-a&kind=student&studentId=student-a&classId=class-a',
        })
        expect(listed.statusCode).toBe(200)
        expect(listed.json()).toMatchObject({ status: 'ok', total: 1, governance: { authenticated: false } })

        const classWideList = await server.inject({
            method: 'GET',
            url: '/api/memory?teacherId=teacher-a&kind=student&classId=class-a',
        })
        expect(classWideList.statusCode).toBe(200)
        expect(classWideList.json()).toMatchObject({ status: 'ok', total: 1 })

        const wrongOwner = await server.inject({
            method: 'PATCH',
            url: `/api/memory/${id}`,
            payload: { teacherId: 'teacher-b', content: '越权 修改' },
        })
        expect(wrongOwner.statusCode).toBe(404)

        const updated = await server.inject({
            method: 'PATCH',
            url: `/api/memory/${id}`,
            payload: { teacherId: 'teacher-a', content: '诗意 分析' },
        })
        expect(updated.statusCode).toBe(200)
        expect(updated.json()).toMatchObject({ memory: { content: '诗意 分析' } })

        const deleted = await server.inject({
            method: 'DELETE',
            url: `/api/memory/${id}?teacherId=teacher-a`,
        })
        expect(deleted.statusCode).toBe(200)
        expect((await server.inject({ method: 'GET', url: '/api/memory?teacherId=teacher-a' })).json()).toMatchObject({ total: 0 })
    })

    it('fails closed for foreign class, missing owner, agent kind, and direct identifiers', async () => {
        const server = await createApp()
        const foreignClass = await server.inject({
            method: 'POST',
            url: '/api/memory',
            payload: { teacherId: 'teacher-b', kind: 'student', studentId: 'student-a', classId: 'class-a', content: '诗意 理解' },
        })
        expect(foreignClass.statusCode).toBe(403)

        const agent = await server.inject({
            method: 'POST',
            url: '/api/memory',
            payload: { teacherId: 'teacher-a', kind: 'agent', content: '内部 策略' },
        })
        expect(agent.statusCode).toBe(400)

        const sensitive = await server.inject({
            method: 'POST',
            url: '/api/memory',
            payload: { teacherId: 'teacher-a', kind: 'teacher', content: '邮箱 test@example.com' },
        })
        expect(sensitive.statusCode).toBe(400)

        const missingOwner = await server.inject({ method: 'DELETE', url: '/api/memory' })
        expect(missingOwner.statusCode).toBe(400)

        const unscopedStudentDelete = await server.inject({
            method: 'DELETE',
            url: '/api/memory?teacherId=teacher-a&kind=student',
        })
        expect(unscopedStudentDelete.statusCode).toBe(400)

        const ambiguousStudentList = await server.inject({
            method: 'GET',
            url: '/api/memory?teacherId=teacher-a&studentId=student-a',
        })
        expect(ambiguousStudentList.statusCode).toBe(400)

        const ambiguousStudentDelete = await server.inject({
            method: 'DELETE',
            url: '/api/memory?teacherId=teacher-a&studentId=student-a',
        })
        expect(ambiguousStudentDelete.statusCode).toBe(400)
    })
})
