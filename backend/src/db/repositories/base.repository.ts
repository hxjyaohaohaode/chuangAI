/**
 * BaseRepository 抽象基类
 *
 * 提供 CRUD 通用方法。子类通过实现 toEntity / fromEntity / columnMap
 * 完成 snake_case 列名与 camelCase 字段的双向映射。
 *
 * 设计要点：
 * - 所有用户输入通过 prepared statements 参数化查询（防 SQL 注入）
 * - 列名映射由子类提供，避免反射开销
 * - count 仅支持等值条件（复杂条件由子类自定义方法处理）
 * - 不在此层处理事务，事务由 service 层用 db.transaction 包裹
 */

import type Database from 'better-sqlite3'
import { generateId } from '../utils/id.js'

/**
 * 列映射定义
 * key = TS 字段名（camelCase），value = SQLite 列名（snake_case）
 */
export type ColumnMap = Record<string, string>

/**
 * 行转换器接口
 * - toRow：实体 → SQLite 列值字典（snake_case 键）
 * - fromRow：SQLite 列值字典 → 实体
 */
export interface RowMapper<TEntity, TCreateInput> {
    /** 创建输入 → SQLite 列值字典（含 id/createdAt/updatedAt 自动填充） */
    toRow(input: TCreateInput): Record<string, unknown>
    /** 更新补丁 → SQLite 列值字典（仅包含待更新字段） */
    toUpdateRow(patch: Partial<TEntity>): Record<string, unknown>
    /** SQLite 行 → 实体 */
    fromRow(row: Record<string, unknown>): TEntity
}

export abstract class BaseRepository<TEntity, TCreateInput, TPatch = Partial<TEntity>> {
    constructor(
        protected readonly db: Database.Database,
        protected readonly tableName: string,
        protected readonly idColumn: string = 'id',
    ) {}

    /**
     * 子类必须实现的行映射器
     */
    protected abstract get mapper(): RowMapper<TEntity, TCreateInput>

    /**
     * 按 ID 查询
     */
    findById(id: string): TEntity | null {
        const stmt = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE ${this.idColumn} = ?`)
        const row = stmt.get(id) as Record<string, unknown> | undefined
        return row ? this.mapper.fromRow(row) : null
    }

    /**
     * 查询全部（分页）
     */
    findAll(limit = 100, offset = 0): TEntity[] {
        const stmt = this.db.prepare(
            `SELECT * FROM ${this.tableName} ORDER BY ${this.idColumn} LIMIT ? OFFSET ?`,
        )
        const rows = stmt.all(limit, offset) as Array<Record<string, unknown>>
        return rows.map((row) => this.mapper.fromRow(row))
    }

    /**
     * 创建实体
     * 自动生成 ID（如未提供）、createdAt、updatedAt
     */
    create(input: TCreateInput): TEntity {
        const row = this.mapper.toRow(input)
        if (!row[this.idColumn]) {
            row[this.idColumn] = generateId()
        }
        const now = Date.now()
        if (!('created_at' in row)) row['created_at'] = now
        if (!('updated_at' in row)) row['updated_at'] = now

        const columns = Object.keys(row)
        const placeholders = columns.map(() => '?').join(', ')
        const sql = `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders})`
        this.db.prepare(sql).run(...columns.map((c) => row[c]))

        const id = row[this.idColumn] as string
        const created = this.findById(id)
        if (!created) {
            throw new Error(`[db] 创建后回查失败: ${this.tableName} id=${id}`)
        }
        return created
    }

    /**
     * 按部分字段更新
     */
    update(id: string, patch: TPatch): TEntity | null {
        const updateRow = this.mapper.toUpdateRow(patch as Partial<TEntity>)
        const keys = Object.keys(updateRow)
        if (keys.length === 0) return this.findById(id)

        // 自动更新 updatedAt
        if (!('updated_at' in updateRow)) updateRow['updated_at'] = Date.now()
        const setClause = Object.keys(updateRow)
            .map((k) => `${k} = ?`)
            .join(', ')
        const values = Object.keys(updateRow).map((k) => updateRow[k])
        const sql = `UPDATE ${this.tableName} SET ${setClause} WHERE ${this.idColumn} = ?`
        this.db.prepare(sql).run(...values, id)

        return this.findById(id)
    }

    /**
     * 按 ID 删除
     */
    delete(id: string): boolean {
        const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE ${this.idColumn} = ?`)
        const result = stmt.run(id)
        return result.changes > 0
    }

    /**
     * 计数（可选等值条件）
     * @param where 仅支持等值匹配
     */
    count(where?: Partial<Record<string, unknown>>): number {
        if (!where || Object.keys(where).length === 0) {
            const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM ${this.tableName}`).get() as { cnt: number }
            return row.cnt
        }
        const clause = Object.keys(where)
            .map((k) => `${k} = ?`)
            .join(' AND ')
        const values = Object.values(where)
        const row = this.db
            .prepare(`SELECT COUNT(*) as cnt FROM ${this.tableName} WHERE ${clause}`)
            .get(...values) as { cnt: number }
        return row.cnt
    }

    /**
     * 按等值条件查询（辅助方法，子类可用）
     */
    protected findByWhere(where: Record<string, unknown>, limit = 100, offset = 0): TEntity[] {
        const clause = Object.keys(where)
            .map((k) => `${k} = ?`)
            .join(' AND ')
        const values = Object.values(where)
        const sql = `SELECT * FROM ${this.tableName} WHERE ${clause} LIMIT ? OFFSET ?`
        const rows = this.db.prepare(sql).all(...values, limit, offset) as Array<Record<string, unknown>>
        return rows.map((row) => this.mapper.fromRow(row))
    }
}
