/**
 * 朗读评测仓储
 */
import type Database from 'better-sqlite3'
import { BaseRepository, type RowMapper } from './base.repository.js'
import type { RecitationEntity, CreateRecitationInput } from '../types.js'
import { parseJson, stringifyJson } from '../utils/json.js'

export class RecitationRepository extends BaseRepository<RecitationEntity, CreateRecitationInput> {
    constructor(db: Database.Database) {
        super(db, 'recitations', 'id')
    }

    protected get mapper(): RowMapper<RecitationEntity, CreateRecitationInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                student_id: input.studentId,
                poem_id: input.poemId,
                audio_url: input.audioUrl ?? null,
                transcript: input.transcript ?? null,
                pronunciation_score: input.pronunciationScore ?? null,
                rhythm_score: input.rhythmScore ?? null,
                emotion_score: input.emotionScore ?? null,
                mistakes: stringifyJson(input.mistakes ?? null),
                suggestion: input.suggestion ?? null,
                audio_duration_sec: input.audioDurationSec ?? null,
                ai_generated: input.aiGenerated === false ? 0 : 1,
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.studentId !== undefined) row['student_id'] = patch.studentId
                if (patch.poemId !== undefined) row['poem_id'] = patch.poemId
                if (patch.audioUrl !== undefined) row['audio_url'] = patch.audioUrl
                if (patch.transcript !== undefined) row['transcript'] = patch.transcript
                if (patch.pronunciationScore !== undefined) row['pronunciation_score'] = patch.pronunciationScore
                if (patch.rhythmScore !== undefined) row['rhythm_score'] = patch.rhythmScore
                if (patch.emotionScore !== undefined) row['emotion_score'] = patch.emotionScore
                if (patch.mistakes !== undefined) row['mistakes'] = stringifyJson(patch.mistakes)
                if (patch.suggestion !== undefined) row['suggestion'] = patch.suggestion
                if (patch.audioDurationSec !== undefined) row['audio_duration_sec'] = patch.audioDurationSec
                if (patch.aiGenerated !== undefined) row['ai_generated'] = patch.aiGenerated ? 1 : 0
                return row
            },
            fromRow: (row) => ({
                id: row['id'] as string,
                studentId: row['student_id'] as string,
                poemId: row['poem_id'] as string,
                audioUrl: (row['audio_url'] as string | null) ?? null,
                transcript: (row['transcript'] as string | null) ?? null,
                pronunciationScore: (row['pronunciation_score'] as number | null) ?? null,
                rhythmScore: (row['rhythm_score'] as number | null) ?? null,
                emotionScore: (row['emotion_score'] as number | null) ?? null,
                mistakes: parseJson<unknown[]>(row['mistakes'] as string | null),
                suggestion: (row['suggestion'] as string | null) ?? null,
                audioDurationSec: (row['audio_duration_sec'] as number | null) ?? null,
                aiGenerated: (row['ai_generated'] as number) === 1,
                createdAt: row['created_at'] as number,
            }),
        }
    }

    /** 按学生查询 */
    findByStudentId(studentId: string): RecitationEntity[] {
        return this.findByWhere({ student_id: studentId }, 200, 0)
    }

    /** 按古诗查询 */
    findByPoemId(poemId: string): RecitationEntity[] {
        return this.findByWhere({ poem_id: poemId }, 200, 0)
    }
}
