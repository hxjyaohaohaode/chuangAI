export interface GradingClassScope {
    id: string
    teacherId: string
}

export interface GradingLessonScope {
    id: string
    classId: string
    teacherId: string
}

export interface GradingStudentScope {
    id: string
    classId: string
}

export interface GradingQuestionScope {
    id: string
    createdBy: string | null
}

export interface GradingBoundaryRepositories {
    findClassById(id: string): GradingClassScope | null
    findLessonById(id: string): GradingLessonScope | null
    findStudentById(id: string): GradingStudentScope | null
    findQuestionById(id: string): GradingQuestionScope | null
}

export interface GradingBoundaryFailure {
    ok: false
    statusCode: 401 | 404 | 409
    code:
        | 'AUTH_REQUIRED'
        | 'CLASS_NOT_FOUND'
        | 'LESSON_SCOPE_MISMATCH'
        | 'QUESTION_NOT_FOUND'
        | 'QUESTION_SCOPE_MISMATCH'
        | 'BATCH_FILE_MISMATCH'
        | 'DUPLICATE_FILE'
        | 'STUDENT_NOT_FOUND'
        | 'STUDENT_CLASS_MISMATCH'
    message: string
}

export interface GradingBoundarySuccess<T> {
    ok: true
    value: T
}

export type GradingBoundaryResult<T> = GradingBoundarySuccess<T> | GradingBoundaryFailure

export interface GradingBatchScope {
    classId: string
    files: ReadonlyArray<{ id: string }>
}

export interface GradingBatchItemScope {
    fileId: string
    questionId: string
    studentId?: string
}

function success<T>(value: T): GradingBoundarySuccess<T> {
    return { ok: true, value }
}

function failure(
    statusCode: GradingBoundaryFailure['statusCode'],
    code: GradingBoundaryFailure['code'],
    message: string,
): GradingBoundaryFailure {
    return { ok: false, statusCode, code, message }
}

/**
 * 班级是批改数据的租户边界。未登录与越权班级必须在读取批次、学生或文件前拒绝，
 * 避免仅依赖客户端传来的 classId 造成跨班级读取或写入。
 */
export function resolveOwnedGradingClass(
    classId: string,
    authenticatedTeacherId: string | undefined,
    repositories: Pick<GradingBoundaryRepositories, 'findClassById'>,
): GradingBoundaryResult<GradingClassScope> {
    if (!authenticatedTeacherId) {
        return failure(401, 'AUTH_REQUIRED', '需要教师身份后才能访问批改数据')
    }

    const classEntity = repositories.findClassById(classId)
    // 对不存在与不属于当前教师统一返回 404，避免通过状态差异枚举其他教师的班级。
    if (!classEntity || classEntity.teacherId !== authenticatedTeacherId) {
        return failure(404, 'CLASS_NOT_FOUND', `班级不存在: ${classId}`)
    }
    return success(classEntity)
}

/** 上传批次前一次性核对班级、课程与显式题目的真实归属。 */
export function validateGradingUploadScope(
    input: {
        classId: string
        lessonId?: string
        questionId?: string
        authenticatedTeacherId?: string
    },
    repositories: Pick<GradingBoundaryRepositories, 'findClassById' | 'findLessonById' | 'findQuestionById'>,
): GradingBoundaryResult<{ classId: string; lessonId?: string; questionId?: string }> {
    const ownedClass = resolveOwnedGradingClass(
        input.classId,
        input.authenticatedTeacherId,
        repositories,
    )
    if (!ownedClass.ok) return ownedClass

    if (input.lessonId) {
        const lesson = repositories.findLessonById(input.lessonId)
        if (
            !lesson
            || lesson.classId !== input.classId
            || lesson.teacherId !== input.authenticatedTeacherId
        ) {
            return failure(409, 'LESSON_SCOPE_MISMATCH', '课程与当前批改班级不一致')
        }
    }

    if (input.questionId) {
        const question = repositories.findQuestionById(input.questionId)
        if (!question) {
            return failure(404, 'QUESTION_NOT_FOUND', `题目不存在: ${input.questionId}`)
        }
        if (question.createdBy && question.createdBy !== input.authenticatedTeacherId) {
            return failure(404, 'QUESTION_SCOPE_MISMATCH', `题目不存在: ${input.questionId}`)
        }
    }

    return success({
        classId: input.classId,
        ...(input.lessonId ? { lessonId: input.lessonId } : {}),
        ...(input.questionId ? { questionId: input.questionId } : {}),
    })
}

/**
 * 批改前核对整个 items 集合。任何一项不一致都在 Agent 调用、批次状态变更与数据库写入前
 * 原子拒绝，避免“部分成功 + 部分跨班污染”的不可恢复状态。
 */
export function validateGradingBatchItems(
    input: {
        batch: GradingBatchScope
        items: ReadonlyArray<GradingBatchItemScope>
        authenticatedTeacherId?: string
    },
    repositories: Pick<GradingBoundaryRepositories, 'findClassById' | 'findStudentById' | 'findQuestionById'>,
): GradingBoundaryResult<true> {
    const ownedClass = resolveOwnedGradingClass(
        input.batch.classId,
        input.authenticatedTeacherId,
        repositories,
    )
    if (!ownedClass.ok) return ownedClass

    const batchFileIds = new Set(input.batch.files.map((file) => file.id))
    const requestedFileIds = new Set<string>()

    for (const item of input.items) {
        if (!batchFileIds.has(item.fileId)) {
            return failure(409, 'BATCH_FILE_MISMATCH', `文件不属于当前批次: ${item.fileId}`)
        }
        if (requestedFileIds.has(item.fileId)) {
            return failure(409, 'DUPLICATE_FILE', `同一文件不能在一个批改请求中重复提交: ${item.fileId}`)
        }
        requestedFileIds.add(item.fileId)

        const question = repositories.findQuestionById(item.questionId)
        if (!question) {
            return failure(404, 'QUESTION_NOT_FOUND', `题目不存在: ${item.questionId}`)
        }
        if (question.createdBy && question.createdBy !== input.authenticatedTeacherId) {
            return failure(404, 'QUESTION_SCOPE_MISMATCH', `题目不存在: ${item.questionId}`)
        }

        if (item.studentId) {
            const student = repositories.findStudentById(item.studentId)
            if (!student) {
                return failure(404, 'STUDENT_NOT_FOUND', `学生不存在: ${item.studentId}`)
            }
            if (student.classId !== input.batch.classId) {
                return failure(409, 'STUDENT_CLASS_MISMATCH', '学生与当前批改班级不一致')
            }
        }
    }

    return success(true)
}
