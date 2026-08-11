/**
 * 班级仓储
 */
import type Database from 'better-sqlite3'
import { BaseRepository, type RowMapper } from './base.repository.js'
import type { ClassEntity, CreateClassInput } from '../types.js'
import { parseJson, stringifyJson } from '../utils/json.js'

export class ClassRepository extends BaseRepository<ClassEntity, CreateClassInput> {
    constructor(db: Database.Database) {
        super(db, 'classes', 'id')
    }

    protected get mapper(): RowMapper<ClassEntity, CreateClassInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                name: input.name,
                grade: input.grade,
                teacher_id: input.teacherId,
                student_count: input.studentCount ?? 0,
                metadata: stringifyJson(input.metadata ?? null),
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.name !== undefined) row['name'] = patch.name
                if (patch.grade !== undefined) row['grade'] = patch.grade
                if (patch.teacherId !== undefined) row['teacher_id'] = patch.teacherId
                if (patch.studentCount !== undefined) row['student_count'] = patch.studentCount
                if (patch.metadata !== undefined) row['metadata'] = stringifyJson(patch.metadata)
                return row
            },
            fromRow: (row) => ({
                id: row['id'] as string,
                name: row['name'] as string,
                grade: row['grade'] as string,
                teacherId: row['teacher_id'] as string,
                studentCount: row['student_count'] as number,
                createdAt: row['created_at'] as number,
                updatedAt: row['updated_at'] as number,
                metadata: parseJson(row['metadata'] as string | null),
            }),
        }
    }

    /** 按教师查询班级 */
    findByTeacherId(teacherId: string): ClassEntity[] {
        return this.findByWhere({ teacher_id: teacherId }, 200, 0)
    }
}
