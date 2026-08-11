/**
 * 六阶掌握度仓储
 *
 * 核心表：每学生每诗每阶一行。UPSERT 操作基于 UNIQUE(student_id, poem_id, bloom_level)。
 */
import type Database from 'better-sqlite3'
import { BaseRepository, type RowMapper } from './base.repository.js'
import type { MasteryEntity, CreateMasteryInput } from '../types.js'
import type { BloomLevel } from '../../agents/base/types.js'

export class MasteryRepository extends BaseRepository<MasteryEntity, CreateMasteryInput> {
    constructor(db: Database.Database) {
        super(db, 'mastery', 'id')
    }

    protected get mapper(): RowMapper<MasteryEntity, CreateMasteryInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                student_id: input.studentId,
                poem_id: input.poemId,
                bloom_level: input.bloomLevel,
                score: input.score ?? 0,
                attempts: input.attempts ?? 0,
                correct_count: input.correctCount ?? 0,
                last_attempt_at: input.lastAttemptAt ?? null,
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.studentId !== undefined) row['student_id'] = patch.studentId
                if (patch.poemId !== undefined) row['poem_id'] = patch.poemId
                if (patch.bloomLevel !== undefined) row['bloom_level'] = patch.bloomLevel
                if (patch.score !== undefined) row['score'] = patch.score
                if (patch.attempts !== undefined) row['attempts'] = patch.attempts
                if (patch.correctCount !== undefined) row['correct_count'] = patch.correctCount
                if (patch.lastAttemptAt !== undefined) row['last_attempt_at'] = patch.lastAttemptAt
                return row
            },
            fromRow: (row) => ({
                id: row['id'] as string,
                studentId: row['student_id'] as string,
                poemId: row['poem_id'] as string,
                bloomLevel: row['bloom_level'] as BloomLevel,
                score: row['score'] as number,
                attempts: row['attempts'] as number,
                correctCount: row['correct_count'] as number,
                lastAttemptAt: (row['last_attempt_at'] as number | null) ?? null,
                updatedAt: row['updated_at'] as number,
            }),
        }
    }

    /**
     * UPSERT：基于 UNIQUE(student_id, poem_id, bloom_level) 冲突时更新
     * 由 MasteryService 调用，事务包裹中。
     *
     * @returns 更新后的实体
     */
    upsertScore(
        studentId: string,
        poemId: string,
        bloomLevel: BloomLevel,
        newScore: number,
        isCorrect: boolean,
    ): MasteryEntity {
        const now = Date.now()
        // 先查现有
        const existing = this.findByStudentPoemBloom(studentId, poemId, bloomLevel)
        if (existing) {
            const updatedAttempts = existing.attempts + 1
            const updatedCorrect = existing.correctCount + (isCorrect ? 1 : 0)
            const updated = this.update(existing.id, {
                score: newScore,
                attempts: updatedAttempts,
                correctCount: updatedCorrect,
                lastAttemptAt: now,
            })
            if (!updated) {
                throw new Error(`[db/mastery] UPSERT 更新失败: ${studentId}/${poemId}/${bloomLevel}`)
            }
            return updated
        }
        // 不存在则插入
        return this.create({
            studentId,
            poemId,
            bloomLevel,
            score: newScore,
            attempts: 1,
            correctCount: isCorrect ? 1 : 0,
            lastAttemptAt: now,
        } as CreateMasteryInput)
    }

    /** 按学生+古诗+阶层精确查询 */
    findByStudentPoemBloom(
        studentId: string,
        poemId: string,
        bloomLevel: BloomLevel,
    ): MasteryEntity | null {
        const list = this.findByWhere(
            { student_id: studentId, poem_id: poemId, bloom_level: bloomLevel },
            1,
            0,
        )
        return list[0] ?? null
    }

    /** 按学生+古诗查询六阶 */
    findByStudentPoem(studentId: string, poemId: string): MasteryEntity[] {
        return this.findByWhere({ student_id: studentId, poem_id: poemId }, 10, 0)
    }

    /** 按学生查询所有掌握度 */
    findByStudentId(studentId: string): MasteryEntity[] {
        return this.findByWhere({ student_id: studentId }, 1000, 0)
    }

    /**
     * 通过视图查询学生六阶能力雷达
     */
    getStudentBloomRadarViaView(
        studentId: string,
    ): Array<{ bloom_level: string; avg_score: number; last_updated: number }> {
        const stmt = this.db.prepare(
            `SELECT bloom_level, avg_score, last_updated FROM v_student_bloom_radar WHERE student_id = ?`,
        )
        return stmt.all(studentId) as Array<{ bloom_level: string; avg_score: number; last_updated: number }>
    }

    /**
     * 通过视图查询班级某诗六阶均值
     */
    getClassPoemMasteryViaView(
        classId: string,
        poemId: string,
    ): Array<{ bloom_level: string; avg_score: number; student_count: number; mastered_count: number }> {
        const stmt = this.db.prepare(
            `SELECT bloom_level, avg_score, student_count, mastered_count FROM v_class_poem_mastery WHERE class_id = ? AND poem_id = ?`,
        )
        return stmt.all(classId, poemId) as Array<{
            bloom_level: string
            avg_score: number
            student_count: number
            mastered_count: number
        }>
    }

    /**
     * 查询班级所有学生的六阶均值（用于班级雷达）
     */
    getClassBloomRadar(classId: string): Array<{ bloom_level: string; avg_score: number }> {
        const stmt = this.db.prepare(`
            SELECT m.bloom_level, AVG(m.score) as avg_score
            FROM mastery m
            JOIN students s ON m.student_id = s.id
            WHERE s.class_id = ?
            GROUP BY m.bloom_level
        `)
        return stmt.all(classId) as Array<{ bloom_level: string; avg_score: number }>
    }
}
