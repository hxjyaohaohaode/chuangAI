/**
 * 学生仓储
 */
import type Database from 'better-sqlite3'
import { BaseRepository, type RowMapper } from './base.repository.js'
import type { StudentEntity, CreateStudentInput } from '../types.js'
import { parseJson, stringifyJson } from '../utils/json.js'

export class StudentRepository extends BaseRepository<StudentEntity, CreateStudentInput> {
    constructor(db: Database.Database) {
        super(db, 'students', 'id')
    }

    protected get mapper(): RowMapper<StudentEntity, CreateStudentInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                class_id: input.classId,
                name: input.name,
                anonymous_name: input.anonymousName,
                grade: input.grade,
                cognitive_style: input.cognitiveStyle ?? null,
                engagement_score: input.engagementScore ?? 0,
                metadata: stringifyJson(input.metadata ?? null),
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.classId !== undefined) row['class_id'] = patch.classId
                if (patch.name !== undefined) row['name'] = patch.name
                if (patch.anonymousName !== undefined) row['anonymous_name'] = patch.anonymousName
                if (patch.grade !== undefined) row['grade'] = patch.grade
                if (patch.cognitiveStyle !== undefined) row['cognitive_style'] = patch.cognitiveStyle
                if (patch.engagementScore !== undefined) row['engagement_score'] = patch.engagementScore
                if (patch.metadata !== undefined) row['metadata'] = stringifyJson(patch.metadata)
                return row
            },
            fromRow: (row) => ({
                id: row['id'] as string,
                classId: row['class_id'] as string,
                name: row['name'] as string,
                anonymousName: row['anonymous_name'] as string,
                grade: row['grade'] as string,
                cognitiveStyle: (row['cognitive_style'] as string | null) as StudentEntity['cognitiveStyle'],
                engagementScore: row['engagement_score'] as number,
                createdAt: row['created_at'] as number,
                updatedAt: row['updated_at'] as number,
                metadata: parseJson(row['metadata'] as string | null),
            }),
        }
    }

    /** 按班级查询学生 */
    findByClassId(classId: string): StudentEntity[] {
        return this.findByWhere({ class_id: classId }, 500, 0)
    }

    /** 按脱敏名查询（用于反查） */
    findByAnonymousName(anonymousName: string): StudentEntity | null {
        const list = this.findByWhere({ anonymous_name: anonymousName }, 1, 0)
        return list[0] ?? null
    }
}
