/**
 * 运行时持久化存储 —— SQLite 替代内存 Map
 *
 * 背景：
 *   8 个路由模块原本使用 `new Map<K, V>()` 在进程内存中存储会话状态、
 *   批次状态、报告记录等。进程重启后数据丢失，导致"功能看似没打通"。
 *   本模块提供 SqliteMap —— 一个 Map 兼容的 SQLite 后端实现，
 *   写入即落盘，重启后数据完整恢复。
 *
 * 设计：
 *   - 每张表对应一个原内存 Map（key TEXT + value TEXT(JSON) + 时间戳）
 *   - 复杂对象通过 JSON.stringify 序列化为 TEXT 字段
 *   - 常用查询字段（teacherId / studentId / classId）抽取为独立列并建索引
 *   - 全部使用 `?` 参数化占位符，杜绝 SQL 注入
 *   - WAL 模式下无需显式关闭连接，进程退出自动 flush
 *
 * 用法：
 *   const store = new SqliteMap<string, MyState>({
 *       table: 'my_table',
 *       indexes: [{ name: 'owner_id', extract: (v) => v.ownerId }],
 *       maxSize: 500,  // 可选 LRU 上限
 *   })
 *   store.set(key, value)   // INSERT OR REPLACE
 *   store.get(key)          // SELECT ... WHERE key = ?
 *   store.delete(key)      // DELETE ... WHERE key = ?
 *   for (const [k, v] of store) { ... }  // 全表扫描
 *
 * 注意：
 *   get() 返回的是 JSON.parse 后的新对象，对它的修改不会自动落盘。
 *   修改后必须显式调用 set() 才能持久化。这与原生 Map 行为不同，
 *   但符合"显式优于隐式"的原则，避免遗漏写入导致数据不一致。
 */

import { db } from './index.js'

// ─────────────────────────────────────────────────────────────
// SqliteMap —— Map 兼容的 SQLite 后端
// ─────────────────────────────────────────────────────────────

/** 索引字段提取器配置 */
export interface SqliteMapIndex<K, V> {
    /** 索引列名（必须与 schema 中的列名一致） */
    name: string
    /** 从 value 中提取该列的值（返回 null 表示空） */
    extract: (value: V, key: K) => string | number | null
}

export interface SqliteMapOptions<K, V> {
    /** 表名 */
    table: string
    /** 索引字段配置（可选，用于加速按字段查询） */
    indexes?: SqliteMapIndex<K, V>[]
    /** 可选 LRU 上限：超过时按 updated_at 升序淘汰最旧记录 */
    maxSize?: number
    /**
     * 可选序列化钩子：默认 JSON.stringify。
     * 用于处理含 Map / Set / Date / Buffer 等原生 JSON 不支持的字段。
     * 调用方应在 serialize 内把 Map 转 [entries] 数组、Buffer 转 base64 等。
     */
    serialize?: (value: V) => string
    /**
     * 可选反序列化钩子：默认 JSON.parse。
     * 与 serialize 配对，用于把 [entries] 数组还原为 Map、base64 还原为 Buffer 等。
     */
    deserialize?: (raw: string) => V
}

const SQLITE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SQLITE_MAP_RESERVED_COLUMNS = new Set(['key', 'value', 'created_at', 'updated_at'])

/**
 * 校验动态拼接进 DDL 的内部标识符。
 *
 * SqliteMap 的表名和列名来自代码配置而非 HTTP 输入，但它们仍会进入 SQL
 * 标识符位置，无法使用参数占位符。启动期主动失败比运行到某次写入才暴露
 * SQL 语法错误更安全，也能阻止保留列被重复声明。
 */
function assertSqlIdentifier(identifier: string, kind: 'table' | 'index column'): void {
    if (!SQLITE_IDENTIFIER_PATTERN.test(identifier)) {
        throw new Error(`Invalid SqliteMap ${kind} identifier: ${identifier}`)
    }
}

/**
 * Map 兼容的 SQLite 持久化实现
 *
 * - 写入立即落盘（better-sqlite3 同步事务）
 * - 重启后数据完整恢复
 * - get() 返回 deserialize 后的新对象，修改后需显式 set() 才能持久化
 * - 全部参数化查询，无 SQL 注入风险
 * - 可通过 serialize/deserialize 钩子处理嵌套 Map / Set / Buffer 等特殊类型
 */
export class SqliteMap<K, V> implements Map<K, V> {
    private readonly table: string
    private readonly indexes: SqliteMapIndex<K, V>[]
    private readonly indexNames: ReadonlySet<string>
    private readonly maxSize?: number
    private readonly serialize: (value: V) => string
    private readonly deserialize: (raw: string) => V

    constructor(opts: SqliteMapOptions<K, V>) {
        assertSqlIdentifier(opts.table, 'table')
        const configuredIndexes = opts.indexes ?? []
        const seenIndexes = new Set<string>()
        for (const index of configuredIndexes) {
            assertSqlIdentifier(index.name, 'index column')
            if (SQLITE_MAP_RESERVED_COLUMNS.has(index.name)) {
                throw new Error(
                    `SqliteMap index column "${index.name}" is reserved by the base schema`,
                )
            }
            if (seenIndexes.has(index.name)) {
                throw new Error(`Duplicate SqliteMap index column: ${index.name}`)
            }
            seenIndexes.add(index.name)
        }
        if (
            opts.maxSize !== undefined &&
            (!Number.isSafeInteger(opts.maxSize) || opts.maxSize < 1)
        ) {
            throw new Error(
                `SqliteMap maxSize must be a positive safe integer: ${String(opts.maxSize)}`,
            )
        }
        this.table = opts.table
        this.indexes = configuredIndexes
        this.indexNames = seenIndexes
        this.maxSize = opts.maxSize
        this.serialize = opts.serialize ?? ((v) => JSON.stringify(v))
        this.deserialize = opts.deserialize ?? ((raw) => JSON.parse(raw) as V)
        this.ensureTable()
    }

    /**
     * 自建表结构
     *
     * ── 为什么需要这一步 ──
     * 原本每个 SqliteMap 的建表语句都手写在本文件顶部的 DDL 常量里。
     * 那是一份**必须与所有调用点手工保持同步**的清单——只要有人新建一个
     * SqliteMap 而忘了补 DDL，这个 store 的行为就会分裂：
     * `set()` 也会失败，但更隐蔽的是 `get()/entries()/size` 会直接抛
     * `SQLITE_ERROR: no such table`，把一个"还没有数据"的正常状态
     * 变成 500。实际就发生过：`home_school_weekly` 漏写 DDL，
     * 家校联系本的花名册接口必然 500。
     *
     * SqliteMap 自己就持有表名与索引声明，信息本来就是齐的，
     * 因此让它在构造时自行建表，从根上消除"忘了补 DDL"这一类故障。
     * 顶部 DDL 仍然保留：它对已有表是幂等的 `IF NOT EXISTS`，
     * 且承担了一次性建好全部表、便于备份检视的作用。
     */
    private ensureTable(): void {
        // 索引列刻意**不声明类型**：SQLite 中无类型列取 BLOB 亲和性，
        // 绑定什么就存什么、不做隐式转换。若声明成 TEXT，数值型 extract
        // 会被转成字符串，之后 `WHERE col = 123` 就再也匹配不上 '123'。
        // 索引声明的取值类型是 `string | number | null`，必须两者都成立。
        const idxColumns = this.indexes.map((i) => `, "${i.name}"`).join('')
        db.exec(
            `CREATE TABLE IF NOT EXISTS "${this.table}" (
                key         TEXT PRIMARY KEY NOT NULL,
                value       TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL${idxColumns}
            );`,
        )
        // 表可能是顶部 DDL 或旧版本数据库预先创建的遗留表。CREATE TABLE IF
        // NOT EXISTS 不会补列；若这里只跳过索引，set() 仍会在首次写入时因缺列
        // 崩溃。因此逐列做幂等迁移，确保读、写两条路径都成立。
        const readColumns = (): Set<string> => new Set(
            (db.prepare(`PRAGMA table_info("${this.table}")`).all() as Array<{ name: string }>)
                .map((c) => c.name),
        )
        let existingColumns = readColumns()

        if (!existingColumns.has('created_at')) {
            db.exec(
                `ALTER TABLE "${this.table}" ` +
                `ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;`,
            )
        }
        if (!existingColumns.has('updated_at')) {
            db.exec(
                `ALTER TABLE "${this.table}" ` +
                `ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;`,
            )
        }
        existingColumns = readColumns()
        for (const index of this.indexes) {
            if (existingColumns.has(index.name)) continue
            db.exec(`ALTER TABLE "${this.table}" ADD COLUMN "${index.name}";`)
        }
        existingColumns = readColumns()

        const indexTargets = [...this.indexes.map((i) => i.name), 'updated_at']
        for (const column of indexTargets) {
            if (!existingColumns.has(column)) continue
            db.exec(
                `CREATE INDEX IF NOT EXISTS "idx_${this.table}_${column}" ` +
                `ON "${this.table}"("${column}");`,
            )
        }
    }

    /** 读取值（反序列化）。返回新对象，修改后需显式 set() 持久化 */
    get(key: K): V | undefined {
        const k = String(key)
        const row = db
            .prepare(`SELECT value FROM "${this.table}" WHERE key = ?`)
            .get(k) as { value: string } | undefined
        if (!row || !row.value) return undefined
        try {
            return this.deserialize(row.value)
        } catch {
            return undefined
        }
    }

    /** 写入值（INSERT OR REPLACE，保留 created_at） */
    set(key: K, value: V): this {
        const k = String(key)
        const v = this.serialize(value)
        const now = Date.now()

        // 提取索引字段
        const idxValues: Array<{ name: string; val: string | number | null }> = this.indexes.map((idx) => ({
            name: idx.name,
            val: idx.extract(value, key),
        }))

        const columns = ['key', 'value', 'created_at', 'updated_at', ...idxValues.map((i) => `"${i.name}"`)]
        const placeholders = columns.map(() => '?').join(', ')
        const sql = `INSERT OR REPLACE INTO "${this.table}" (${columns.join(', ')}) VALUES (${placeholders})`

        // Existing-row lookup, upsert and LRU eviction are one logical write.
        // Keeping them in the same SQLite transaction prevents a crash between
        // the upsert and eviction from leaving the store permanently over its
        // declared capacity.
        //
        // 这里必须使用 BEGIN IMMEDIATE，而不是 better-sqlite3 默认的 DEFERRED：
        // 默认事务会先 SELECT 旧 created_at、随后把读事务升级为写事务；两个并发
        // 写者若都完成了 SELECT，后发者会得到 SQLITE_BUSY(_SNAPSHOT)，busy_timeout
        // 也不能把已失效的读快照升级为可写。IMMEDIATE 先取得（或在 busy_timeout 内
        // 等待）保留写锁，再读取和写入，避免课堂/编排检查点在并发恢复时随机失败。
        const write = db.transaction(() => {
            // 保留 created_at（若已存在）
            const existing = db
                .prepare(`SELECT created_at FROM "${this.table}" WHERE key = ?`)
                .get(k) as { created_at: number } | undefined
            const createdAt = existing?.created_at ?? now
            const values: Array<string | number | null> = [k, v, createdAt, now, ...idxValues.map((i) => i.val)]
            db.prepare(sql).run(...values)

            if (this.maxSize !== undefined) {
                this.evictIfNeeded()
            }
        }).immediate
        write()
        return this
    }

    /** 删除值，返回是否删除成功 */
    delete(key: K): boolean {
        const k = String(key)
        const result = db.prepare(`DELETE FROM "${this.table}" WHERE key = ?`).run(k)
        return result.changes > 0
    }

    /** 判断是否存在 */
    has(key: K): boolean {
        const k = String(key)
        const row = db.prepare(`SELECT 1 FROM "${this.table}" WHERE key = ? LIMIT 1`).get(k)
        return row !== undefined
    }

    /** 条目总数 */
    get size(): number {
        const row = db.prepare(`SELECT COUNT(*) AS cnt FROM "${this.table}"`).get() as { cnt: number }
        return row.cnt
    }

    /** 清空表 */
    clear(): void {
        db.prepare(`DELETE FROM "${this.table}"`).run()
    }

    /** 遍历所有 [key, value] 对 */
    *entries(): IterableIterator<[K, V]> {
        const rows = db.prepare(`SELECT key, value FROM "${this.table}"`).all() as Array<{
            key: string
            value: string
        }>
        for (const row of rows) {
            try {
                yield [row.key as K, this.deserialize(row.value)]
            } catch {
                // 跳过损坏的 JSON
            }
        }
    }

    /** 遍历所有 key */
    *keys(): IterableIterator<K> {
        const rows = db.prepare(`SELECT key FROM "${this.table}"`).all() as Array<{ key: string }>
        for (const row of rows) {
            yield row.key as K
        }
    }

    /** 遍历所有 value */
    *values(): IterableIterator<V> {
        const rows = db.prepare(`SELECT value FROM "${this.table}"`).all() as Array<{ value: string }>
        for (const row of rows) {
            try {
                yield this.deserialize(row.value)
            } catch {
                // 跳过损坏的 JSON
            }
        }
    }

    /** 回调遍历 */
    forEach(callback: (value: V, key: K, map: this) => void): void {
        for (const [k, v] of this.entries()) {
            callback(v, k, this)
        }
    }

    [Symbol.iterator](): IterableIterator<[K, V]> {
        return this.entries()
    }

    get [Symbol.toStringTag](): string {
        return 'SqliteMap'
    }

    /** 按索引字段查询（辅助方法，非 Map 标准 API） */
    findByIndex(indexName: string, indexValue: string | number): Array<{ key: K; value: V }> {
        // The column name cannot be bound with a `?` placeholder. Only allow
        // columns explicitly declared by this store; accepting an arbitrary
        // identifier here would turn an internal helper into an SQL-injection
        // surface if a future caller forwards request input.
        if (!this.indexNames.has(indexName)) {
            throw new Error(`Unknown SqliteMap index column: ${indexName}`)
        }
        const rows = db
            .prepare(`SELECT key, value FROM "${this.table}" WHERE "${indexName}" = ? ORDER BY updated_at DESC`)
            .all(indexValue) as Array<{ key: string; value: string }>
        const result: Array<{ key: K; value: V }> = []
        for (const row of rows) {
            try {
                result.push({ key: row.key as K, value: this.deserialize(row.value) })
            } catch {
                // 跳过损坏的 JSON
            }
        }
        return result
    }

    /** LRU 淘汰：按 updated_at 升序删除最旧记录 */
    private evictIfNeeded(): void {
        if (this.maxSize === undefined) return
        const count = this.size
        if (count <= this.maxSize) return
        const toEvict = count - this.maxSize
        db.prepare(
            `DELETE FROM "${this.table}" WHERE key IN (
                SELECT key FROM "${this.table}" ORDER BY updated_at ASC LIMIT ?
            )`,
        ).run(toEvict)
    }
}

// ─────────────────────────────────────────────────────────────
// JSON 序列化辅助：处理嵌套 Map / Set / Date
// ─────────────────────────────────────────────────────────────

/**
 * 将 Map 序列化为 JSON 友好的 [entries] 数组
 * 用于嵌套在对象内的 Map 字段持久化
 */
export function mapToJsonEntries<K, V>(m: Map<K, V>): Array<[K, V]> {
    return Array.from(m.entries())
}

/**
 * 从 [entries] 数组还原 Map
 */
export function jsonEntriesToMap<K, V>(entries: Array<[K, V]> | undefined): Map<K, V> {
    const m = new Map<K, V>()
    if (Array.isArray(entries)) {
        for (const [k, v] of entries) {
            m.set(k, v)
        }
    }
    return m
}
