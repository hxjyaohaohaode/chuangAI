import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * 解析数据库路径并确保父目录存在。
 *
 * 显式 SQLITE_PATH 与默认路径必须遵循同一套冷启动规则；否则新部署环境
 * 只要父目录尚未创建，better-sqlite3 就会在服务监听前直接退出。
 */
export function prepareDatabasePath(
    configuredPath: string,
    projectRoot: string,
    defaultDatabaseFile: string = join(projectRoot, 'data', 'poetic-realm.db'),
): string {
    const trimmedPath = configuredPath.trim()
    if (trimmedPath === ':memory:') return trimmedPath

    const databasePath = trimmedPath
        ? resolve(trimmedPath)
        : resolve(defaultDatabaseFile)

    // 不吞掉权限或路径错误：启动时给出真实失败，比运行期静默丢数据更安全。
    mkdirSync(dirname(databasePath), { recursive: true })
    return databasePath
}
