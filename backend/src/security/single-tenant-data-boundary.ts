import type Database from 'better-sqlite3'

const LEGACY_PROTOTYPE_OWNERS = ['teacher-demo-001', 'teacher-default'] as const
const OWNERSHIP_COLUMNS = ['teacher_id', 'owner_id'] as const

export interface SingleTenantBoundaryReport {
    migratedRows: number
    checkedOwnershipColumns: number
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`
}

function ownershipTargets(database: Database.Database): Array<{ table: string; column: string }> {
    const tables = database.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as Array<{ name: string }>

    const targets: Array<{ table: string; column: string }> = []
    for (const { name } of tables) {
        const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{ name: string }>
        const names = new Set(columns.map((column) => column.name))
        for (const ownershipColumn of OWNERSHIP_COLUMNS) {
            if (names.has(ownershipColumn)) targets.push({ table: name, column: ownershipColumn })
        }
    }
    return targets
}

/**
 * 当前产品是单教师、本地单租户安装，不是校园 SaaS。
 *
 * 启动时只迁移两个历史原型硬编码主体，然后扫描所有带 teacher_id/owner_id 的
 * 持久化表。发现任何其他主体就失败关闭，避免“列表未带筛选条件”演变为横向越权。
 * 要升级为多租户必须先为每个资源补齐 tenant_id、对象授权与迁移方案，不能放宽本门禁。
 */
export function enforceSingleTenantDataBoundary(
    database: Database.Database,
    authoritativeTeacherId: string,
): SingleTenantBoundaryReport {
    if (!authoritativeTeacherId.trim()) throw new Error('单租户数据边界需要非空教师主体')

    const targets = ownershipTargets(database)
    let migratedRows = 0
    database.transaction(() => {
        // v5.0 的 lesson_plans 索引误把 plan.id 写进 teacher_id，且 value 未保存
        // teacherId。仅在 teacher_id = key = value.id 的可证明 bug 签名下修复。
        if (targets.some(({ table, column }) => table === 'lesson_plans' && column === 'teacher_id')) {
            const result = database.prepare(`
                UPDATE lesson_plans
                   SET teacher_id = ?,
                       value = json_set(value, '$.teacherId', ?)
                 WHERE teacher_id = key
                   AND json_valid(value)
                   AND json_extract(value, '$.id') = key
            `).run(authoritativeTeacherId, authoritativeTeacherId)
            migratedRows += result.changes
        }
        for (const { table, column } of targets) {
            const result = database.prepare(
                `UPDATE ${quoteIdentifier(table)}
                    SET ${quoteIdentifier(column)} = ?
                  WHERE ${quoteIdentifier(column)} IN (?, ?)`,
            ).run(authoritativeTeacherId, ...LEGACY_PROTOTYPE_OWNERS)
            migratedRows += result.changes
        }
    })()

    const violations: string[] = []
    for (const { table, column } of targets) {
        const row = database.prepare(
            `SELECT COUNT(*) AS count
               FROM ${quoteIdentifier(table)}
              WHERE ${quoteIdentifier(column)} IS NOT NULL
                AND TRIM(CAST(${quoteIdentifier(column)} AS TEXT)) <> ''
                AND ${quoteIdentifier(column)} <> ?`,
        ).get(authoritativeTeacherId) as { count: number }
        if (row.count > 0) violations.push(`${table}.${column}:${row.count}`)
    }

    if (violations.length > 0) {
        throw new Error(
            '启动失败：当前构建仅支持单教师本地数据边界，但数据库含其他主体资源（'
            + violations.join(', ')
            + '）。请为该教师使用独立 SQLite 数据库；不得跳过此门禁。',
        )
    }

    return { migratedRows, checkedOwnershipColumns: targets.length }
}
