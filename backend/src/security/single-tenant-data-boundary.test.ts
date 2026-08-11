import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { enforceSingleTenantDataBoundary } from './single-tenant-data-boundary.js'

const databases: Database.Database[] = []

afterEach(() => {
    for (const database of databases.splice(0)) database.close()
})

function createDatabase(): Database.Database {
    const database = new Database(':memory:')
    databases.push(database)
    database.exec(`
        CREATE TABLE classes (id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL);
        CREATE TABLE sessions (key TEXT PRIMARY KEY, owner_id TEXT);
        CREATE TABLE lesson_plans (key TEXT PRIMARY KEY, value TEXT NOT NULL, teacher_id TEXT);
        CREATE TABLE public_resources (id TEXT PRIMARY KEY, title TEXT);
    `)
    return database
}

describe('single-tenant data boundary', () => {
    it('接受空库与单一权威主体，并忽略无所有权列的公共资源', () => {
        const database = createDatabase()
        database.prepare('INSERT INTO classes VALUES (?, ?)').run('class-1', 'teacher-001')
        database.prepare('INSERT INTO public_resources VALUES (?, ?)').run('poem-1', '春晓')
        expect(enforceSingleTenantDataBoundary(database, 'teacher-001')).toEqual({
            migratedRows: 0,
            checkedOwnershipColumns: 3,
        })
    })

    it('只迁移两个明确的历史原型主体', () => {
        const database = createDatabase()
        database.prepare('INSERT INTO classes VALUES (?, ?)').run('class-1', 'teacher-demo-001')
        database.prepare('INSERT INTO sessions VALUES (?, ?)').run('session-1', 'teacher-default')
        const report = enforceSingleTenantDataBoundary(database, 'teacher-001')
        expect(report.migratedRows).toBe(2)
        expect(database.prepare('SELECT teacher_id FROM classes').pluck().get()).toBe('teacher-001')
        expect(database.prepare('SELECT owner_id FROM sessions').pluck().get()).toBe('teacher-001')
    })

    it('发现任何非历史的第二主体时失败关闭且不改写该主体', () => {
        const database = createDatabase()
        database.prepare('INSERT INTO classes VALUES (?, ?)').run('class-2', 'teacher-002')
        expect(() => enforceSingleTenantDataBoundary(database, 'teacher-001')).toThrow(/单教师.*其他主体/u)
        expect(database.prepare('SELECT teacher_id FROM classes').pluck().get()).toBe('teacher-002')
    })

    it('只按可证明的旧索引 bug 签名修复教案所有者', () => {
        const database = createDatabase()
        database.prepare('INSERT INTO lesson_plans VALUES (?, ?, ?)').run(
            'plan-1', JSON.stringify({ id: 'plan-1', title: '教案' }), 'plan-1',
        )
        const report = enforceSingleTenantDataBoundary(database, 'teacher-001')
        expect(report.migratedRows).toBe(1)
        const row = database.prepare('SELECT value, teacher_id FROM lesson_plans').get() as {
            value: string
            teacher_id: string
        }
        expect(row.teacher_id).toBe('teacher-001')
        expect(JSON.parse(row.value)).toMatchObject({ id: 'plan-1', teacherId: 'teacher-001' })
    })
})
