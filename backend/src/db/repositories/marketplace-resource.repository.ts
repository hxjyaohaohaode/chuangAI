/**
 * 开源集市资源仓储（Task 21）
 *
 * 职责：
 * 1. 资源 CRUD（基于 marketplace_resources 表）
 * 2. 多维筛选查询（类型 / 年级 / 标签 / 模型）
 * 3. 复刻记录与反馈记录的写入与查询
 * 4. 反馈聚合统计（平均分 / 反馈数）的原子更新
 *
 * 设计要点：
 * - JSON 字段（tags / bloom_weights / models_used / adaptation_meta）通过
 *   utils/json 的 stringifyJson / parseJson 在仓储层完成序列化
 * - 反馈写入时通过事务一并更新 resources 表的 feedback_score / feedback_count
 * - 复刻写入时通过事务一并更新 resources 表的 fork_count
 * - 不在此层处理外部服务调用（如班级 mastery 适配预览由路由层调用 MasteryRepo 完成）
 */
import type Database from 'better-sqlite3'
import { BaseRepository, type RowMapper } from './base.repository.js'
import type {
    MarketplaceResourceEntity,
    MarketplaceResourceType,
    CreateMarketplaceResourceInput,
    MarketplaceForkRecordEntity,
    CreateMarketplaceForkRecordInput,
    MarketplaceFeedbackEntity,
    CreateMarketplaceFeedbackInput,
} from '../types.js'
import type { BloomWeights } from '../../agents/base/types.js'
import { parseJson, stringifyJson } from '../utils/json.js'

// ─────────────────────────────────────────────────────────────
// 资源仓储
// ─────────────────────────────────────────────────────────────

export class MarketplaceResourceRepository extends BaseRepository<
    MarketplaceResourceEntity,
    CreateMarketplaceResourceInput
> {
    constructor(db: Database.Database) {
        super(db, 'marketplace_resources', 'id')
    }

    protected get mapper(): RowMapper<MarketplaceResourceEntity, CreateMarketplaceResourceInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                title: input.title,
                description: input.description ?? null,
                type: input.type,
                content: input.content,
                tags: stringifyJson(input.tags ?? []) ?? '[]',
                grade_level: input.gradeLevel ?? null,
                bloom_weights: stringifyJson(input.bloomWeights ?? null),
                models_used: stringifyJson(input.modelsUsed ?? []) ?? '[]',
                author_id: input.authorId ?? null,
                author_name: input.authorName ?? null,
                fork_count: input.forkCount ?? 0,
                feedback_score: input.feedbackScore ?? 0,
                feedback_count: input.feedbackCount ?? 0,
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.title !== undefined) row['title'] = patch.title
                if (patch.description !== undefined) row['description'] = patch.description
                if (patch.type !== undefined) row['type'] = patch.type
                if (patch.content !== undefined) row['content'] = patch.content
                if (patch.tags !== undefined) row['tags'] = stringifyJson(patch.tags) ?? '[]'
                if (patch.gradeLevel !== undefined) row['grade_level'] = patch.gradeLevel
                if (patch.bloomWeights !== undefined) row['bloom_weights'] = stringifyJson(patch.bloomWeights)
                if (patch.modelsUsed !== undefined) row['models_used'] = stringifyJson(patch.modelsUsed) ?? '[]'
                if (patch.authorId !== undefined) row['author_id'] = patch.authorId
                if (patch.authorName !== undefined) row['author_name'] = patch.authorName
                if (patch.forkCount !== undefined) row['fork_count'] = patch.forkCount
                if (patch.feedbackScore !== undefined) row['feedback_score'] = patch.feedbackScore
                if (patch.feedbackCount !== undefined) row['feedback_count'] = patch.feedbackCount
                return row
            },
            fromRow: (row) => ({
                id: row['id'] as string,
                title: row['title'] as string,
                description: (row['description'] as string | null) ?? null,
                type: row['type'] as MarketplaceResourceType,
                content: row['content'] as string,
                tags: parseStringArraySafe(row['tags'] as string | null),
                gradeLevel: (row['grade_level'] as string | null) ?? null,
                bloomWeights: parseJson<BloomWeights>(row['bloom_weights'] as string | null),
                modelsUsed: parseStringArraySafe(row['models_used'] as string | null),
                authorId: (row['author_id'] as string | null) ?? null,
                authorName: (row['author_name'] as string | null) ?? null,
                forkCount: row['fork_count'] as number,
                feedbackScore: row['feedback_score'] as number,
                feedbackCount: row['feedback_count'] as number,
                createdAt: row['created_at'] as number,
                updatedAt: row['updated_at'] as number,
            }),
        }
    }

    /**
     * 多维筛选查询
     *
     * @param filter 类型 / 年级 / 标签 / 模型 / 关键词
     * @returns 资源数组（按 created_at 倒序）
     */
    search(filter: MarketplaceSearchFilter): MarketplaceResourceEntity[] {
        const clauses: string[] = []
        const params: unknown[] = []

        if (filter.type) {
            clauses.push('type = ?')
            params.push(filter.type)
        }
        if (filter.gradeLevel) {
            clauses.push('grade_level = ?')
            params.push(filter.gradeLevel)
        }
        if (filter.tag) {
            // JSON 数组中包含某标签 —— 使用 LIKE 兜底匹配（SQLite 无原生 JSON_CONTAINS）
            clauses.push("tags LIKE ?")
            params.push(`%"${filter.tag.replace(/["%_]/g, '')}"%`)
        }
        if (filter.model) {
            clauses.push("models_used LIKE ?")
            params.push(`%"${filter.model.replace(/["%_]/g, '')}"%`)
        }
        if (filter.keyword) {
            clauses.push('(title LIKE ? OR description LIKE ?)')
            const kw = `%${filter.keyword.replace(/[%_]/g, '')}%`
            params.push(kw, kw)
        }

        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
        const limit = filter.limit ?? 50
        const offset = filter.offset ?? 0
        const sql = `SELECT * FROM marketplace_resources ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
        const rows = this.db.prepare(sql).all(...params, limit, offset) as Array<Record<string, unknown>>
        return rows.map((row) => this.mapper.fromRow(row))
    }

    /**
     * 原子自增 fork_count
     */
    incrementForkCount(resourceId: string): void {
        this.db
            .prepare(`UPDATE marketplace_resources SET fork_count = fork_count + 1, updated_at = ? WHERE id = ?`)
            .run(Date.now(), resourceId)
    }

    /**
     * 重新计算反馈平均分与条数（在写入新反馈后调用）
     */
    recomputeFeedbackStats(resourceId: string): void {
        const row = this.db
            .prepare(
                `SELECT COUNT(*) AS cnt, COALESCE(AVG(score), 0) AS avg_score
                 FROM marketplace_feedback WHERE resource_id = ?`,
            )
            .get(resourceId) as { cnt: number; avg_score: number } | undefined
        const count = row?.cnt ?? 0
        const avg = row?.avg_score ?? 0
        this.db
            .prepare(
                `UPDATE marketplace_resources
                 SET feedback_count = ?, feedback_score = ?, updated_at = ?
                 WHERE id = ?`,
            )
            .run(count, avg, Date.now(), resourceId)
    }
}

// ─────────────────────────────────────────────────────────────
// 复刻记录仓储
// ─────────────────────────────────────────────────────────────

export class MarketplaceForkRecordRepository extends BaseRepository<
    MarketplaceForkRecordEntity,
    CreateMarketplaceForkRecordInput
> {
    constructor(db: Database.Database) {
        super(db, 'marketplace_fork_records', 'id')
    }

    protected get mapper(): RowMapper<MarketplaceForkRecordEntity, CreateMarketplaceForkRecordInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                resource_id: input.resourceId,
                source_author: input.sourceAuthor ?? null,
                target_class_id: input.targetClassId ?? null,
                target_teacher: input.targetTeacher ?? null,
                adaptation_meta: stringifyJson(input.adaptationMeta ?? null),
                forked_at: input.forkedAt,
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.resourceId !== undefined) row['resource_id'] = patch.resourceId
                if (patch.sourceAuthor !== undefined) row['source_author'] = patch.sourceAuthor
                if (patch.targetClassId !== undefined) row['target_class_id'] = patch.targetClassId
                if (patch.targetTeacher !== undefined) row['target_teacher'] = patch.targetTeacher
                if (patch.adaptationMeta !== undefined) row['adaptation_meta'] = stringifyJson(patch.adaptationMeta)
                if (patch.forkedAt !== undefined) row['forked_at'] = patch.forkedAt
                return row
            },
            fromRow: (row) => ({
                id: row['id'] as string,
                resourceId: row['resource_id'] as string,
                sourceAuthor: (row['source_author'] as string | null) ?? null,
                targetClassId: (row['target_class_id'] as string | null) ?? null,
                targetTeacher: (row['target_teacher'] as string | null) ?? null,
                adaptationMeta: parseJson<Record<string, unknown>>(row['adaptation_meta'] as string | null),
                forkedAt: row['forked_at'] as number,
                createdAt: row['created_at'] as number,
                updatedAt: row['updated_at'] as number,
            }),
        }
    }

    /** 按资源 ID 查询所有复刻记录 */
    findByResource(resourceId: string): MarketplaceForkRecordEntity[] {
        return this.findByWhere({ resource_id: resourceId }, 500, 0)
    }

    /** 按目标班级查询复刻历史 */
    findByClass(classId: string): MarketplaceForkRecordEntity[] {
        return this.findByWhere({ target_class_id: classId }, 200, 0)
    }

    /** 按资源 + 时间窗口聚合（用于趋势图） */
    aggregateByDay(resourceId: string, sinceMs: number): Array<{ day: string; count: number }> {
        const rows = this.db
            .prepare(
                `SELECT strftime('%Y-%m-%d', datetime(forked_at / 1000, 'unixepoch', 'localtime')) AS day,
                        COUNT(*) AS count
                 FROM marketplace_fork_records
                 WHERE resource_id = ? AND forked_at >= ?
                 GROUP BY day
                 ORDER BY day ASC`,
            )
            .all(resourceId, sinceMs) as Array<{ day: string; count: number }>
        return rows
    }
}

// ─────────────────────────────────────────────────────────────
// 反馈仓储
// ─────────────────────────────────────────────────────────────

export class MarketplaceFeedbackRepository extends BaseRepository<
    MarketplaceFeedbackEntity,
    CreateMarketplaceFeedbackInput
> {
    constructor(db: Database.Database) {
        super(db, 'marketplace_feedback', 'id')
    }

    protected get mapper(): RowMapper<MarketplaceFeedbackEntity, CreateMarketplaceFeedbackInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                resource_id: input.resourceId,
                rater_id: input.raterId ?? null,
                rater_name: input.raterName ?? null,
                score: input.score,
                comment: input.comment ?? null,
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.resourceId !== undefined) row['resource_id'] = patch.resourceId
                if (patch.raterId !== undefined) row['rater_id'] = patch.raterId
                if (patch.raterName !== undefined) row['rater_name'] = patch.raterName
                if (patch.score !== undefined) row['score'] = patch.score
                if (patch.comment !== undefined) row['comment'] = patch.comment
                return row
            },
            fromRow: (row) => ({
                id: row['id'] as string,
                resourceId: row['resource_id'] as string,
                raterId: (row['rater_id'] as string | null) ?? null,
                raterName: (row['rater_name'] as string | null) ?? null,
                score: row['score'] as number,
                comment: (row['comment'] as string | null) ?? null,
                createdAt: row['created_at'] as number,
                updatedAt: row['updated_at'] as number,
            }),
        }
    }

    /** 按资源查询所有反馈 */
    findByResource(resourceId: string): MarketplaceFeedbackEntity[] {
        return this.findByWhere({ resource_id: resourceId }, 200, 0)
    }

    /** 评分分布 —— 各分数段（0-1 / 1-2 / 2-3 / 3-4 / 4-5）条数 */
    distribution(resourceId: string): Array<{ bucket: string; count: number }> {
        const rows = this.db
            .prepare(
                `SELECT
                    CASE
                        WHEN score < 1 THEN '0-1'
                        WHEN score < 2 THEN '1-2'
                        WHEN score < 3 THEN '2-3'
                        WHEN score < 4 THEN '3-4'
                        ELSE '4-5'
                    END AS bucket,
                    COUNT(*) AS count
                 FROM marketplace_feedback
                 WHERE resource_id = ?
                 GROUP BY bucket
                 ORDER BY bucket ASC`,
            )
            .all(resourceId) as Array<{ bucket: string; count: number }>
        return rows
    }
}

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

function parseStringArraySafe(raw: string | null): string[] {
    const parsed = parseJson<unknown[]>(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
}

// ─────────────────────────────────────────────────────────────
// 筛选类型
// ─────────────────────────────────────────────────────────────

export interface MarketplaceSearchFilter {
    type?: MarketplaceResourceType
    gradeLevel?: string
    tag?: string
    model?: string
    keyword?: string
    limit?: number
    offset?: number
}
