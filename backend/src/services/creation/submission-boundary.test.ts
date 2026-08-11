import { describe, expect, it } from 'vitest'
import { resolveCreationSubmissionBoundary } from './submission-boundary.js'

const base = {
    authenticatedTeacherId: 'teacher-a',
    taskId: 'task-a',
    studentId: 'student-a',
    task: { teacherId: 'teacher-a', classId: 'class-a', status: 'open' as const },
    student: { id: 'student-a', classId: 'class-a', anonymousName: 'A01' },
    studentClass: { id: 'class-a', teacherId: 'teacher-a' },
    collaborationRequested: false,
    collaboration: null,
}

describe('creation submission aggregate boundary', () => {
    it('accepts an open same-teacher same-class task', () => {
        expect(resolveCreationSubmissionBoundary(base)).toEqual({
            accepted: true,
            classId: 'class-a',
            anonymousName: 'A01',
        })
    })

    it.each([
        [{ task: { ...base.task, teacherId: 'teacher-b' } }, 'TASK_SCOPE_MISMATCH', 403],
        [{ task: { ...base.task, status: 'closed' as const } }, 'TASK_CLOSED', 409],
        [{ student: null }, 'STUDENT_NOT_FOUND', 404],
        [{ studentClass: { id: 'class-a', teacherId: 'teacher-b' } }, 'STUDENT_SCOPE_MISMATCH', 403],
        [{ student: { ...base.student, classId: 'class-b' } }, 'STUDENT_CLASS_MISMATCH', 409],
        [{ collaborationRequested: true }, 'COLLABORATION_NOT_FOUND', 404],
        [{
            collaborationRequested: true,
            collaboration: { taskId: 'task-b', studentId: 'student-a', teacherId: 'teacher-a' },
        }, 'COLLABORATION_SCOPE_MISMATCH', 409],
        [{
            collaborationRequested: true,
            collaboration: { taskId: 'task-a', studentId: 'student-b', teacherId: 'teacher-a' },
        }, 'COLLABORATION_SCOPE_MISMATCH', 409],
    ] as const)('rejects invalid aggregate relation %s', (override, error, statusCode) => {
        expect(resolveCreationSubmissionBoundary({ ...base, ...override })).toMatchObject({
            accepted: false,
            error,
            statusCode,
        })
    })

    it('allows a teacher-owned global task only for a student in that teacher scope', () => {
        expect(resolveCreationSubmissionBoundary({
            ...base,
            task: { ...base.task, classId: null },
        })).toMatchObject({ accepted: true, classId: 'class-a' })
    })
})
