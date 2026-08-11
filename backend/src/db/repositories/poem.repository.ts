/**
 * 古诗仓储
 */
import type Database from 'better-sqlite3'
import { BaseRepository, type RowMapper } from './base.repository.js'
import type { PoemEntity, CreatePoemInput } from '../types.js'
import { parseJson, parseStringArray, stringifyJson } from '../utils/json.js'

export class PoemRepository extends BaseRepository<PoemEntity, CreatePoemInput> {
    constructor(db: Database.Database) {
        super(db, 'poems', 'id')
    }

    protected get mapper(): RowMapper<PoemEntity, CreatePoemInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                title: input.title,
                poet: input.poet,
                dynasty: input.dynasty,
                content: input.content,
                annotation: stringifyJson(input.annotation ?? null),
                theme: stringifyJson(input.theme ?? []),
                images: stringifyJson(input.images ?? []),
                rhetoric: stringifyJson(input.rhetoric ?? []),
                grade_level: input.gradeLevel ?? null,
                textbook_edition: input.textbookEdition ?? '统编版',
                difficulty: input.difficulty ?? 3,
                metadata: stringifyJson(input.metadata ?? null),
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.title !== undefined) row['title'] = patch.title
                if (patch.poet !== undefined) row['poet'] = patch.poet
                if (patch.dynasty !== undefined) row['dynasty'] = patch.dynasty
                if (patch.content !== undefined) row['content'] = patch.content
                if (patch.annotation !== undefined) row['annotation'] = stringifyJson(patch.annotation)
                if (patch.theme !== undefined) row['theme'] = stringifyJson(patch.theme)
                if (patch.images !== undefined) row['images'] = stringifyJson(patch.images)
                if (patch.rhetoric !== undefined) row['rhetoric'] = stringifyJson(patch.rhetoric)
                if (patch.gradeLevel !== undefined) row['grade_level'] = patch.gradeLevel
                if (patch.textbookEdition !== undefined) row['textbook_edition'] = patch.textbookEdition
                if (patch.difficulty !== undefined) row['difficulty'] = patch.difficulty
                if (patch.metadata !== undefined) row['metadata'] = stringifyJson(patch.metadata)
                return row
            },
            fromRow: (row) => ({
                id: row['id'] as string,
                title: row['title'] as string,
                poet: row['poet'] as string,
                dynasty: row['dynasty'] as string,
                content: row['content'] as string,
                annotation: parseJson<Record<string, string>>(row['annotation'] as string | null),
                theme: parseStringArray(row['theme'] as string | null),
                images: parseStringArray(row['images'] as string | null),
                rhetoric: parseStringArray(row['rhetoric'] as string | null),
                gradeLevel: (row['grade_level'] as string | null) ?? null,
                textbookEdition: (row['textbook_edition'] as string) ?? '统编版',
                difficulty: row['difficulty'] as number,
                createdAt: row['created_at'] as number,
                metadata: parseJson(row['metadata'] as string | null),
            }),
        }
    }

    /** 按诗人查询 */
    findByPoet(poet: string): PoemEntity[] {
        return this.findByWhere({ poet }, 200, 0)
    }

    /** 按标题模糊查询 */
    searchByTitle(keyword: string): PoemEntity[] {
        const stmt = this.db.prepare(`SELECT * FROM poems WHERE title LIKE ? LIMIT 100`)
        const rows = stmt.all(`%${keyword}%`) as Array<Record<string, unknown>>
        return rows.map((row) => this.mapper.fromRow(row))
    }
}
