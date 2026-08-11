import { describe, expect, it } from 'vitest'
import {
    resolveOwnedGradingClass,
    validateGradingBatchItems,
    validateGradingUploadScope,
    type GradingBoundaryRepositories,
} from './batch-boundary.js'

function createRepositories(): GradingBoundaryRepositories {
    return {
        findClassById: (id) => id === 'class-a' ? { id, teacherId: 'teacher-a' } : null,
        findLessonById: (id) => id === 'lesson-a'
            ? { id, classId: 'class-a', teacherId: 'teacher-a' }
            : id === 'lesson-b'
                ? { id, classId: 'class-b', teacherId: 'teacher-b' }
                : null,
        findStudentById: (id) => id === 'student-a'
            ? { id, classId: 'class-a' }
            : id === 'student-b'
                ? { id, classId: 'class-b' }
                : null,
        findQuestionById: (id) => id === 'question-shared'
            ? { id, createdBy: null }
            : id === 'question-a'
                ? { id, createdBy: 'teacher-a' }
                : id === 'question-b'
                    ? { id, createdBy: 'teacher-b' }
                    : null,
    }
}

describe('grading aggregate boundary', () => {
    const repositories = createRepositories()

    it('requires an authenticated teacher and hides foreign classes', () => {
        expect(resolveOwnedGradingClass('class-a', undefined, repositories)).toMatchObject({
            ok: false,
            statusCode: 401,
            code: 'AUTH_REQUIRED',
        })
        expect(resolveOwnedGradingClass('class-a', 'teacher-b', repositories)).toMatchObject({
            ok: false,
            statusCode: 404,
            code: 'CLASS_NOT_FOUND',
        })
    })

    it('accepts a same-class lesson and shared or teacher-owned question', () => {
        expect(validateGradingUploadScope({
            classId: 'class-a',
            lessonId: 'lesson-a',
            questionId: 'question-shared',
            authenticatedTeacherId: 'teacher-a',
        }, repositories)).toEqual({
            ok: true,
            value: { classId: 'class-a', lessonId: 'lesson-a', questionId: 'question-shared' },
        })
        expect(validateGradingUploadScope({
            classId: 'class-a',
            questionId: 'question-a',
            authenticatedTeacherId: 'teacher-a',
        }, repositories).ok).toBe(true)
    })

    it('rejects a cross-class lesson and a foreign/private question before upload', () => {
        expect(validateGradingUploadScope({
            classId: 'class-a',
            lessonId: 'lesson-b',
            authenticatedTeacherId: 'teacher-a',
        }, repositories)).toMatchObject({ ok: false, code: 'LESSON_SCOPE_MISMATCH' })
        expect(validateGradingUploadScope({
            classId: 'class-a',
            questionId: 'question-b',
            authenticatedTeacherId: 'teacher-a',
        }, repositories)).toMatchObject({ ok: false, code: 'QUESTION_SCOPE_MISMATCH' })
    })

    const batch = { classId: 'class-a', files: [{ id: 'file-a' }, { id: 'file-b' }] }

    it('accepts a complete same-batch, same-class item set', () => {
        expect(validateGradingBatchItems({
            batch,
            authenticatedTeacherId: 'teacher-a',
            items: [
                { fileId: 'file-a', questionId: 'question-shared', studentId: 'student-a' },
                { fileId: 'file-b', questionId: 'question-a' },
            ],
        }, repositories)).toEqual({ ok: true, value: true })
    })

    it.each([
        [{ fileId: 'file-foreign', questionId: 'question-a' }, 'BATCH_FILE_MISMATCH'],
        [{ fileId: 'file-a', questionId: 'question-missing' }, 'QUESTION_NOT_FOUND'],
        [{ fileId: 'file-a', questionId: 'question-b' }, 'QUESTION_SCOPE_MISMATCH'],
        [{ fileId: 'file-a', questionId: 'question-a', studentId: 'student-missing' }, 'STUDENT_NOT_FOUND'],
        [{ fileId: 'file-a', questionId: 'question-a', studentId: 'student-b' }, 'STUDENT_CLASS_MISMATCH'],
    ] as const)('rejects invalid aggregate member %#', (item, code) => {
        expect(validateGradingBatchItems({
            batch,
            authenticatedTeacherId: 'teacher-a',
            items: [item],
        }, repositories)).toMatchObject({ ok: false, code })
    })

    it('rejects duplicate file grading atomically', () => {
        expect(validateGradingBatchItems({
            batch,
            authenticatedTeacherId: 'teacher-a',
            items: [
                { fileId: 'file-a', questionId: 'question-a' },
                { fileId: 'file-a', questionId: 'question-shared' },
            ],
        }, repositories)).toMatchObject({ ok: false, code: 'DUPLICATE_FILE' })
    })
})
