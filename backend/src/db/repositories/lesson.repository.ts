/**
 * 课程仓储
 */
import type Database from 'better-sqlite3'
import { BaseRepository, type RowMapper } from './base.repository.js'
import type { LessonEntity, CreateLessonInput, LessonStatus } from '../types.js'
import { parseJson, stringifyJson } from '../utils/json.js'

export class LessonRepository extends BaseRepository<LessonEntity, CreateLessonInput> {
    constructor(db: Database.Database) {
        super(db, 'lessons', 'id')
    }

    protected get mapper(): RowMapper<LessonEntity, CreateLessonInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                class_id: input.classId,
                poem_id: input.poemId,
                teacher_id: input.teacherId,
                scheduled_at: input.scheduledAt ?? null,
                started_at: input.startedAt ?? null,
                ended_at: input.endedAt ?? null,
                status: input.status ?? 'planned',
                mode: input.mode ?? null,
                metadata: stringifyJson(input.metadata ?? null),
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.classId !== undefined) row['class_id'] = patch.classId
                if (patch.poemId !== undefined) row['poem_id'] = patch.poemId
                if (patch.teacherId !== undefined) row['teacher_id'] = patch.teacherId
                if (patch.scheduledAt !== undefined) row['scheduled_at'] = patch.scheduledAt
                if (patch.startedAt !== undefined) row['started_at'] = patch.startedAt
                if (patch.endedAt !== undefined) row['ended_at'] = patch.endedAt
                if (patch.status !== undefined) row['status'] = patch.status
                if (patch.mode !== undefined) row['mode'] = patch.mode
                if (patch.metadata !== undefined) row['metadata'] = stringifyJson(patch.metadata)
                return row
            },
            fromRow: (row) => ({
                id: row['id'] as string,
                classId: row['class_id'] as string,
                poemId: row['poem_id'] as string,
                teacherId: row['teacher_id'] as string,
                scheduledAt: (row['scheduled_at'] as number | null) ?? null,
                startedAt: (row['started_at'] as number | null) ?? null,
                endedAt: (row['ended_at'] as number | null) ?? null,
                status: (row['status'] as LessonStatus) ?? 'planned',
                mode: (row['mode'] as LessonEntity['mode']) ?? null,
                metadata: parseJson(row['metadata'] as string | null),
            }),
        }
    }

    /** 按班级查询 */
    findByClassId(classId: string): LessonEntity[] {
        return this.findByWhere({ class_id: classId }, 200, 0)
    }

    /** 按古诗查询 */
    findByPoemId(poemId: string): LessonEntity[] {
        return this.findByWhere({ poem_id: poemId }, 200, 0)
    }
}
