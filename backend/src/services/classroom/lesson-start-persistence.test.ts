import { describe, expect, it, vi } from 'vitest'
import type { CreateLessonInput } from '../../db/types.js'
import { persistLessonStartOrRollback } from './lesson-start-persistence.js'

const lesson: CreateLessonInput = {
    id: 'lesson-persistence-test',
    classId: 'class-test',
    poemId: 'poem-test',
    teacherId: 'teacher-test',
    startedAt: 1_700_000_000_000,
    status: 'ongoing',
    mode: 'collective-race',
    metadata: { joinCode: 'AB12CD' },
}

describe('persistLessonStartOrRollback', () => {
    it('creates runtime before the long-term archive and preserves both when persistence succeeds', () => {
        const createRuntime = vi.fn()
        const createLesson = vi.fn()
        const rollbackRuntime = vi.fn()
        const error = vi.fn()

        expect(persistLessonStartOrRollback(lesson, {
            createRuntime,
            createLesson,
            rollbackRuntime,
            log: { error },
        })).toEqual({ ok: true })

        expect(createRuntime).toHaveBeenCalledOnce()
        expect(createLesson).toHaveBeenCalledOnce()
        expect(createLesson).toHaveBeenCalledWith(lesson)
        expect(createRuntime.mock.invocationCallOrder[0]).toBeLessThan(createLesson.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY)
        expect(rollbackRuntime).not.toHaveBeenCalled()
        expect(error).not.toHaveBeenCalled()
    })

    it('fails closed before archive creation when runtime persistence fails', () => {
        const createRuntime = vi.fn(() => { throw new Error('SQLite classroom_sessions insert failed') })
        const createLesson = vi.fn()
        const rollbackRuntime = vi.fn()
        const error = vi.fn()

        expect(persistLessonStartOrRollback(lesson, {
            createRuntime,
            createLesson,
            rollbackRuntime,
            log: { error },
        })).toEqual({ ok: false, failure: 'runtime' })

        expect(createRuntime).toHaveBeenCalledOnce()
        expect(createLesson).not.toHaveBeenCalled()
        expect(rollbackRuntime).not.toHaveBeenCalled()
        expect(error).toHaveBeenCalledOnce()
        expect(error.mock.calls[0]?.[0]).toMatchObject({
            lessonId: 'lesson-persistence-test',
            classId: 'class-test',
            poemId: 'poem-test',
        })
    })

    it('fails closed and removes the runtime when the long-term archive cannot be created', () => {
        const createRuntime = vi.fn()
        const createLesson = vi.fn(() => { throw new Error('SQLite lesson insert failed') })
        const rollbackRuntime = vi.fn()
        const error = vi.fn()

        expect(persistLessonStartOrRollback(lesson, {
            createRuntime,
            createLesson,
            rollbackRuntime,
            log: { error },
        })).toEqual({ ok: false, failure: 'archive' })

        expect(createRuntime).toHaveBeenCalledOnce()
        expect(rollbackRuntime).toHaveBeenCalledExactlyOnceWith('lesson-persistence-test')
        expect(error).toHaveBeenCalledOnce()
        expect(error.mock.calls[0]?.[0]).toMatchObject({
            lessonId: 'lesson-persistence-test',
            classId: 'class-test',
            poemId: 'poem-test',
        })
    })

    it('still fails closed and records both errors when runtime rollback also fails', () => {
        const createRuntime = vi.fn()
        const createLesson = vi.fn(() => { throw new Error('archive unavailable') })
        const rollbackRuntime = vi.fn(() => { throw new Error('runtime rollback unavailable') })
        const error = vi.fn()

        expect(persistLessonStartOrRollback(lesson, {
            createRuntime,
            createLesson,
            rollbackRuntime,
            log: { error },
        })).toEqual({ ok: false, failure: 'archive' })

        expect(error).toHaveBeenCalledOnce()
        expect(error.mock.calls[0]?.[0]).toMatchObject({
            lessonId: 'lesson-persistence-test',
            rollbackErr: expect.any(Error),
        })
    })
})
