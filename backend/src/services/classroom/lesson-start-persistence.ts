/**
 * 课堂启动的归档记录门禁。
 *
 * `classroom_sessions` 负责短期实时状态，`lessons` 负责结束后的报告、历史查询与
 * 可审计课堂证据。两者不能只成功其一后仍把课堂报告为“已开始”：运行时快照清理后，
 * 缺少 lessons 记录会导致历史报告不可恢复。
 */
import type { CreateLessonInput } from '../../db/types.js'

export interface LessonStartPersistenceLogger {
    error: (payload: Record<string, unknown>, message: string) => unknown
}

export type LessonStartPersistenceFailure = 'runtime' | 'archive'

export type LessonStartPersistenceResult =
    | { ok: true }
    | { ok: false, failure: LessonStartPersistenceFailure }

export interface LessonStartPersistenceDependencies {
    /** 写入短期课堂运行时；失败时尚未允许任何对外“开课成功”状态。 */
    createRuntime: () => unknown
    createLesson: (lesson: CreateLessonInput) => unknown
    rollbackRuntime: (lessonId: string) => unknown
    log: LessonStartPersistenceLogger
}

/**
 * 以可补偿顺序创建短期运行时和长期 lessons 归档。
 *
 * - runtime 写入失败：不尝试归档、不启动监测、不广播加入码；调用方可向 UI 返回
 *   `CLASSROOM_RUNTIME_UNAVAILABLE`，而不是泛化 500。
 * - lessons 归档失败：撤销已写入的 runtime；调用方可向 UI 返回
 *   `LESSON_ARCHIVE_UNAVAILABLE`。
 *
 * 返回失败时调用方不得启动监测定时器、广播加入码或向教师返回成功。即便运行时回滚
 * 本身失败，也仍然失败关闭，并把两个错误都留在仅服务端可见的结构化日志中。
 */
export function persistLessonStartOrRollback(
    lesson: CreateLessonInput,
    dependencies: LessonStartPersistenceDependencies,
): LessonStartPersistenceResult {
    const lessonId = lesson.id
    if (!lessonId) {
        throw new Error('课堂归档门禁要求调用方提供 lesson.id')
    }

    try {
        dependencies.createRuntime()
    } catch (err) {
        dependencies.log.error(
            {
                err,
                lessonId,
                classId: lesson.classId,
                poemId: lesson.poemId,
            },
            '课堂运行时创建失败；已拒绝启动课堂',
        )
        return { ok: false, failure: 'runtime' }
    }

    try {
        dependencies.createLesson(lesson)
        return { ok: true }
    } catch (err) {
        let rollbackErr: unknown
        try {
            dependencies.rollbackRuntime(lessonId)
        } catch (cleanupErr) {
            rollbackErr = cleanupErr
        }
        dependencies.log.error(
            {
                err,
                rollbackErr,
                lessonId,
                classId: lesson.classId,
                poemId: lesson.poemId,
            },
            '课堂归档创建失败；已拒绝启动课堂并尝试回滚运行时',
        )
        return { ok: false, failure: 'archive' }
    }
}
