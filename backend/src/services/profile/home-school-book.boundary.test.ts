import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    findStudentById: vi.fn(),
    cacheGet: vi.fn(),
    cacheSet: vi.fn(),
    cacheDelete: vi.fn((_key: unknown) => true),
    deepseekChat: vi.fn(),
}))

vi.mock('../../db/index.js', () => ({
    db: { prepare: vi.fn(() => { throw new Error('no aggregate rows in boundary test') }) },
    repos: {
        students: {
            findById: mocks.findStudentById,
            findByClassId: vi.fn(() => []),
        },
        events: {},
        mastery: {},
        poems: {},
        recitations: {},
    },
}))

vi.mock('../../db/runtime-store.js', () => ({
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

        *[Symbol.iterator]() {
            // 其余服务函数的 Map 契约；本组测试不需要已有条目。
        }
    },
}))

vi.mock('../../llm/index.js', () => ({
    managedLLM: { chat: mocks.deepseekChat },
}))

import {
    generateWeeklyReport,
    HomeSchoolStudentClassMismatchError,
} from './home-school-book.js'

describe('home-school weekly student/class boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.findStudentById.mockReturnValue({
            id: 'student-b',
            classId: 'class-b',
            anonymousName: 'B01',
        })
        mocks.deepseekChat.mockRejectedValue(new Error('offline'))
    })

    it('rejects a cross-class request before reading or writing cache', async () => {
        await expect(generateWeeklyReport({
            studentId: 'student-b',
            classId: 'class-a',
            weekKey: '2026-W32',
        })).rejects.toMatchObject({
            name: 'HomeSchoolStudentClassMismatchError',
            code: 'STUDENT_CLASS_MISMATCH',
            statusCode: 409,
            studentId: 'student-b',
            requestedClassId: 'class-a',
            authoritativeClassId: 'class-b',
        } satisfies Partial<HomeSchoolStudentClassMismatchError>)

        expect(mocks.cacheGet).not.toHaveBeenCalled()
        expect(mocks.cacheSet).not.toHaveBeenCalled()
        expect(mocks.cacheDelete).not.toHaveBeenCalled()
        expect(mocks.deepseekChat).not.toHaveBeenCalled()
    })

    it('returns a published cache only when its class matches the student truth source', async () => {
        const cached = {
            id: 'student-b-2026-W32',
            studentId: 'student-b',
            classId: 'class-b',
            weekKey: '2026-W32',
            status: 'published',
        }
        mocks.cacheGet.mockReturnValue(cached)

        const result = await generateWeeklyReport({
            studentId: 'student-b',
            classId: 'class-b',
            weekKey: '2026-W32',
        })

        expect(result).toEqual({ report: cached, cached: true })
        expect(mocks.cacheSet).not.toHaveBeenCalled()
        expect(mocks.cacheDelete).not.toHaveBeenCalled()
    })

    it('purges a legacy wrong-class cache instead of returning it', async () => {
        mocks.cacheGet.mockReturnValue({
            id: 'student-b-2026-W32',
            studentId: 'student-b',
            classId: 'class-a',
            weekKey: '2026-W32',
            status: 'published',
        })

        const result = await generateWeeklyReport({
            studentId: 'student-b',
            classId: 'class-b',
            weekKey: '2026-W32',
        })

        expect(mocks.cacheDelete).toHaveBeenCalledWith('student-b-2026-W32')
        expect(result.report).toMatchObject({
            studentId: 'student-b',
            classId: 'class-b',
            aiGenerated: false,
        })
        expect(mocks.cacheSet).toHaveBeenCalledWith(
            'student-b-2026-W32',
            expect.objectContaining({ classId: 'class-b' }),
        )
    })
})
