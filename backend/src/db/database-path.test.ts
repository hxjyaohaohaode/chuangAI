import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareDatabasePath } from './database-path.js'

const temporaryRoots: string[] = []

function makeTemporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'poetic-realm-db-path-'))
    temporaryRoots.push(root)
    return root
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true })
    }
})

describe('prepareDatabasePath', () => {
    it('为空配置创建项目 data 目录并返回默认文件', () => {
        const projectRoot = makeTemporaryRoot()
        const result = prepareDatabasePath('', projectRoot)

        expect(result).toBe(join(projectRoot, 'data', 'poetic-realm.db'))
        expect(existsSync(join(projectRoot, 'data'))).toBe(true)
    })

    it('为显式嵌套路径递归创建父目录', () => {
        const root = makeTemporaryRoot()
        const configuredPath = join(root, 'fresh', 'nested', 'learning.db')
        const result = prepareDatabasePath(configuredPath, root)

        expect(result).toBe(resolve(configuredPath))
        expect(existsSync(join(root, 'fresh', 'nested'))).toBe(true)
    })

    it('空 SQLITE_PATH 使用 APP_DATA_DIR 下的确定性数据库文件', () => {
        const projectRoot = makeTemporaryRoot()
        const persistentRoot = join(projectRoot, 'render-disk')
        const databaseFile = join(persistentRoot, 'poetic-realm.db')
        const result = prepareDatabasePath('', projectRoot, databaseFile)

        expect(result).toBe(resolve(databaseFile))
        expect(existsSync(persistentRoot)).toBe(true)
    })

    it('保留 SQLite 内存数据库标识且不创建目录', () => {
        const projectRoot = makeTemporaryRoot()
        expect(prepareDatabasePath(':memory:', projectRoot)).toBe(':memory:')
        expect(existsSync(join(projectRoot, 'data'))).toBe(false)
    })
})
