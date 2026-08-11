/**
 * 学情事件仓储
 *
 * 事件溯源核心表，记录所有学情相关事件（自学/答题/课堂互动/朗读等）。
 */
import type Database from 'better-sqlite3'
import { BaseRepository, type RowMapper } from './base.repository.js'
import type { EventEntity, CreateEventInput, EventType } from '../types.js'
import { parseJson, stringifyJson } from '../utils/json.js'

export class EventRepository extends BaseRepository<EventEntity, CreateEventInput> {
    constructor(db: Database.Database) {
        super(db, 'events', 'id')
    }

    protected get mapper(): RowMapper<EventEntity, CreateEventInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                student_id: input.studentId ?? null,
                class_id: input.classId ?? null,
                lesson_id: input.lessonId ?? null,
                type: input.type,
                action: input.action,
                payload: stringifyJson(input.payload ?? null),
                poem_id: input.poemId ?? null,
                occurred_at: input.occurredAt ?? Date.now(),
                recorded_at: input.recordedAt ?? Date.now(),
                metadata: stringifyJson(input.metadata ?? null),
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.studentId !== undefined) row['student_id'] = patch.studentId
                if (patch.classId !== undefined) row['class_id'] = patch.classId
                if (patch.lessonId !== undefined) row['lesson_id'] = patch.lessonId
                if (patch.type !== undefined) row['type'] = patch.type
                if (patch.action !== undefined) row['action'] = patch.action
                if (patch.payload !== undefined) row['payload'] = stringifyJson(patch.payload)
                if (patch.poemId !== undefined) row['poem_id'] = patch.poemId
                if (patch.occurredAt !== undefined) row['occurred_at'] = patch.occurredAt
                if (patch.metadata !== undefined) row['metadata'] = stringifyJson(patch.metadata)
                return row
            },
            fromRow: (row) => ({
                id: row['id'] as string,
                studentId: (row['student_id'] as string | null) ?? null,
                classId: (row['class_id'] as string | null) ?? null,
                lessonId: (row['lesson_id'] as string | null) ?? null,
                type: row['type'] as EventType,
                action: row['action'] as string,
                payload: parseJson(row['payload'] as string | null),
                poemId: (row['poem_id'] as string | null) ?? null,
                occurredAt: row['occurred_at'] as number,
                recordedAt: row['recorded_at'] as number,
                metadata: parseJson(row['metadata'] as string | null),
            }),
        }
    }

    /** 学生近期事件（按 occurred_at DESC） */
    findRecentByStudentId(studentId: string, limit = 50): EventEntity[] {
        const stmt = this.db.prepare(
            `SELECT * FROM events WHERE student_id = ? ORDER BY occurred_at DESC LIMIT ?`,
        )
        const rows = stmt.all(studentId, limit) as Array<Record<string, unknown>>
        return rows.map((row) => this.mapper.fromRow(row))
    }

    /** 班级某时段事件 */
    findByClassAndTimeRange(
        classId: string,
        from: number,
        to: number,
        type?: EventType,
    ): EventEntity[] {
        if (type) {
            const stmt = this.db.prepare(
                `SELECT * FROM events WHERE class_id = ? AND occurred_at >= ? AND occurred_at <= ? AND type = ? ORDER BY occurred_at DESC LIMIT 500`,
            )
            const rows = stmt.all(classId, from, to, type) as Array<Record<string, unknown>>
            return rows.map((row) => this.mapper.fromRow(row))
        }
        const stmt = this.db.prepare(
            `SELECT * FROM events WHERE class_id = ? AND occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at DESC LIMIT 500`,
        )
        const rows = stmt.all(classId, from, to) as Array<Record<string, unknown>>
        return rows.map((row) => this.mapper.fromRow(row))
    }

    /** 学生某时段事件计数（用于参与度统计） */
    countByStudentSince(studentId: string, sinceTs: number): Array<{ type: string; cnt: number }> {
        const stmt = this.db.prepare(
            `SELECT type, COUNT(*) as cnt FROM events WHERE student_id = ? AND occurred_at >= ? GROUP BY type`,
        )
        return stmt.all(studentId, sinceTs) as Array<{ type: string; cnt: number }>
    }
}
