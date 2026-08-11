/**
 * 题目仓储
 */
import type Database from 'better-sqlite3'
import { BaseRepository, type RowMapper } from './base.repository.js'
import type { QuestionEntity, CreateQuestionInput } from '../types.js'
import type { BloomLevel, QuestionType } from '../../agents/base/types.js'
import { parseJson, parseStringArray, stringifyJson } from '../utils/json.js'

export class QuestionRepository extends BaseRepository<QuestionEntity, CreateQuestionInput> {
    constructor(db: Database.Database) {
        super(db, 'questions', 'id')
    }

    protected get mapper(): RowMapper<QuestionEntity, CreateQuestionInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                poem_id: input.poemId,
                bloom_level: input.bloomLevel,
                type: input.type,
                stem: input.stem,
                options: stringifyJson(input.options ?? null),
                answer: input.answer,
                analysis: input.analysis ?? null,
                distractors_analysis: stringifyJson(input.distractorsAnalysis ?? null),
                difficulty: input.difficulty ?? 3,
                estimated_time_sec: input.estimatedTimeSec ?? 60,
                ai_generated: input.aiGenerated === false ? 0 : 1,
                prompt_version: input.promptVersion ?? null,
                created_by: input.createdBy ?? null,
                metadata: stringifyJson(input.metadata ?? null),
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.poemId !== undefined) row['poem_id'] = patch.poemId
                if (patch.bloomLevel !== undefined) row['bloom_level'] = patch.bloomLevel
                if (patch.type !== undefined) row['type'] = patch.type
                if (patch.stem !== undefined) row['stem'] = patch.stem
                if (patch.options !== undefined) row['options'] = stringifyJson(patch.options)
                if (patch.answer !== undefined) row['answer'] = patch.answer
                if (patch.analysis !== undefined) row['analysis'] = patch.analysis
                if (patch.distractorsAnalysis !== undefined) row['distractors_analysis'] = stringifyJson(patch.distractorsAnalysis)
                if (patch.difficulty !== undefined) row['difficulty'] = patch.difficulty
                if (patch.estimatedTimeSec !== undefined) row['estimated_time_sec'] = patch.estimatedTimeSec
                if (patch.aiGenerated !== undefined) row['ai_generated'] = patch.aiGenerated ? 1 : 0
                if (patch.promptVersion !== undefined) row['prompt_version'] = patch.promptVersion
                if (patch.createdBy !== undefined) row['created_by'] = patch.createdBy
                if (patch.metadata !== undefined) row['metadata'] = stringifyJson(patch.metadata)
                return row
            },
            fromRow: (row) => ({
                id: row['id'] as string,
                poemId: row['poem_id'] as string,
                bloomLevel: row['bloom_level'] as BloomLevel,
                type: row['type'] as QuestionType,
                stem: row['stem'] as string,
                options: row['options'] ? parseStringArray(row['options'] as string | null) : null,
                answer: row['answer'] as string,
                analysis: (row['analysis'] as string | null) ?? null,
                distractorsAnalysis: row['distractors_analysis']
                    ? parseStringArray(row['distractors_analysis'] as string | null)
                    : null,
                difficulty: row['difficulty'] as number,
                estimatedTimeSec: row['estimated_time_sec'] as number,
                aiGenerated: (row['ai_generated'] as number) === 1,
                promptVersion: (row['prompt_version'] as string | null) ?? null,
                createdAt: row['created_at'] as number,
                createdBy: (row['created_by'] as string | null) ?? null,
                metadata: parseJson(row['metadata'] as string | null),
            }),
        }
    }

    /** 按古诗查询题目 */
    findByPoemId(poemId: string): QuestionEntity[] {
        return this.findByWhere({ poem_id: poemId }, 500, 0)
    }

    /** 按古诗与布鲁姆阶层查询 */
    findByPoemAndBloom(poemId: string, bloomLevel: BloomLevel): QuestionEntity[] {
        return this.findByWhere({ poem_id: poemId, bloom_level: bloomLevel }, 100, 0)
    }
}
