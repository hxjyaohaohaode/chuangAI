export interface CreationSubmissionTaskScope {
    teacherId: string
    classId: string | null
    status: 'open' | 'closed'
}

export interface CreationSubmissionStudentScope {
    id: string
    classId: string
    anonymousName: string
}

export interface CreationSubmissionClassScope {
    id: string
    teacherId: string
}

export interface CreationSubmissionCollaborationScope {
    taskId: string
    studentId: string | null
    teacherId: string | null
}

export type CreationSubmissionBoundary =
    | { accepted: true; classId: string; anonymousName: string }
    | {
        accepted: false
        statusCode: 403 | 404 | 409
        error:
            | 'TASK_SCOPE_MISMATCH'
            | 'TASK_CLOSED'
            | 'STUDENT_NOT_FOUND'
            | 'STUDENT_SCOPE_MISMATCH'
            | 'STUDENT_CLASS_MISMATCH'
            | 'COLLABORATION_NOT_FOUND'
            | 'COLLABORATION_SCOPE_MISMATCH'
        message: string
    }

/** 提交作品前一次性验证任务、学生、班级、协作会话属于同一业务聚合。 */
export function resolveCreationSubmissionBoundary(input: {
    authenticatedTeacherId: string
    taskId: string
    studentId: string
    task: CreationSubmissionTaskScope
    student: CreationSubmissionStudentScope | null
    studentClass: CreationSubmissionClassScope | null
    collaborationRequested: boolean
    collaboration: CreationSubmissionCollaborationScope | null
}): CreationSubmissionBoundary {
    const {
        authenticatedTeacherId,
        taskId,
        studentId,
        task,
        student,
        studentClass,
        collaborationRequested,
        collaboration,
    } = input

    if (task.teacherId !== authenticatedTeacherId) {
        return { accepted: false, statusCode: 403, error: 'TASK_SCOPE_MISMATCH', message: '任务不属于当前教师' }
    }
    if (task.status !== 'open') {
        return { accepted: false, statusCode: 409, error: 'TASK_CLOSED', message: '任务已关闭，不能继续提交作品' }
    }
    if (!student) {
        return { accepted: false, statusCode: 404, error: 'STUDENT_NOT_FOUND', message: '学生不存在' }
    }
    if (!studentClass || studentClass.teacherId !== authenticatedTeacherId) {
        return { accepted: false, statusCode: 403, error: 'STUDENT_SCOPE_MISMATCH', message: '学生不属于当前教师的班级' }
    }
    if (task.classId !== null && task.classId !== student.classId) {
        return { accepted: false, statusCode: 409, error: 'STUDENT_CLASS_MISMATCH', message: '学生不属于任务指定班级' }
    }
    if (collaborationRequested && !collaboration) {
        return { accepted: false, statusCode: 404, error: 'COLLABORATION_NOT_FOUND', message: '协作会话不存在' }
    }
    if (collaboration && (
        collaboration.taskId !== taskId
        || (collaboration.studentId !== null && collaboration.studentId !== studentId)
        || (collaboration.teacherId !== null && collaboration.teacherId !== authenticatedTeacherId)
    )) {
        return {
            accepted: false,
            statusCode: 409,
            error: 'COLLABORATION_SCOPE_MISMATCH',
            message: '协作会话与任务、学生或教师不匹配',
        }
    }

    return {
        accepted: true,
        classId: student.classId,
        anonymousName: student.anonymousName,
    }
}
