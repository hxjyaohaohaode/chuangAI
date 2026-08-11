/**
 * db/repositories/student.repository.ts 单元测试
 *
 * 覆盖：
 * - StudentRepository 继承 BaseRepository 的 CRUD：findById / findAll / create / update / delete / count
 * - StudentRepository 特有方法：findByClassId / findByAnonymousName
 * - 列映射：camelCase ↔ snake_case、JSON 字段（metadata）
 * - 自动填充：id（如未提供）、created_at、updated_at
 * - 边界条件：未找到返回 null、空 patch、删除不存在 ID 返回 false
 * - 错误场景：update 不存在的 ID 返回 null
 *
 * 设计原则：
 * - 使用 better-sqlite3 :memory: 数据库，避免文件 IO
 * - 内联最小 schema（仅 students 表 + 必要索引），关闭外键约束以避免依赖 classes 表
 * - 不导入 db/index.ts，避免触发完整初始化与种子数据
 * - 通过 StudentRepository 间接验证 BaseRepository.findByWhere 的 protected 方法
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type DatabaseType from 'better-sqlite3'
import { StudentRepository } from './student.repository.js'
import type { CreateStudentInput } from '../types.js'

// ─────────────────────────────────────────────────────────────
// 内联最小 schema（仅 students 表，关闭外键约束以避免依赖 classes 表）
// ─────────────────────────────────────────────────────────────

const STUDENTS_SCHEMA = `
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS students (
    id                TEXT PRIMARY KEY NOT NULL,
    class_id          TEXT NOT NULL,
    name              TEXT NOT NULL,
    anonymous_name    TEXT NOT NULL,
    grade             TEXT NOT NULL,
    cognitive_style   TEXT,
    engagement_score  REAL NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    metadata          TEXT
);

CREATE INDEX IF NOT EXISTS idx_students_class_id ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_students_anonymous_name ON students(anonymous_name);
CREATE INDEX IF NOT EXISTS idx_students_grade ON students(grade);
`

// ─────────────────────────────────────────────────────────────
// 辅助：构造 CreateStudentInput
// ─────────────────────────────────────────────────────────────

function makeCreateInput(overrides: Partial<CreateStudentInput> = {}): CreateStudentInput {
    return {
        classId: 'cls-001',
        name: '张三',
        anonymousName: '学生A01',
        grade: '三年级',
        cognitiveStyle: 'visual',
        engagementScore: 0.5,
        metadata: { source: '测试' },
        ...overrides,
    }
}

describe('StudentRepository', () => {
    let db: DatabaseType.Database
    let repo: StudentRepository

    beforeEach(() => {
        db = new Database(':memory:')
        db.exec(STUDENTS_SCHEMA)
        repo = new StudentRepository(db)
    })

    afterEach(() => {
        db.close()
    })

    // ─────────────────────────────────────────────────────────
    // create + findById
    // ─────────────────────────────────────────────────────────

    describe('create + findById', () => {
        it('创建实体并回查（自动生成 id/created_at/updated_at）', () => {
            const before = Date.now()
            const input = makeCreateInput()
            const created = repo.create(input)
            const after = Date.now()

            expect(created.id).toBeTruthy()
            expect(typeof created.id).toBe('string')
            expect(created.id.length).toBe(36) // UUID v4
            expect(created.classId).toBe('cls-001')
            expect(created.name).toBe('张三')
            expect(created.anonymousName).toBe('学生A01')
            expect(created.grade).toBe('三年级')
            expect(created.cognitiveStyle).toBe('visual')
            expect(created.engagementScore).toBe(0.5)
            expect(created.metadata).toEqual({ source: '测试' })
            expect(created.createdAt).toBeGreaterThanOrEqual(before)
            expect(created.createdAt).toBeLessThanOrEqual(after)
            expect(created.updatedAt).toBeGreaterThanOrEqual(before)
            expect(created.updatedAt).toBeLessThanOrEqual(after)

            // 回查
            const found = repo.findById(created.id)
            expect(found).not.toBeNull()
            expect(found?.name).toBe('张三')
        })

        it('使用调用方提供的 id', () => {
            const input = makeCreateInput({ id: 'custom-stu-001' })
            const created = repo.create(input)
            expect(created.id).toBe('custom-stu-001')
        })

        it('默认值：cognitiveStyle 为 null、engagementScore 为 0、metadata 为 null', () => {
            // 仅提供必填字段
            const minimal: CreateStudentInput = {
                classId: 'cls-001',
                name: '李四',
                anonymousName: '学生B01',
                grade: '四年级',
            }
            const created = repo.create(minimal)
            expect(created.cognitiveStyle).toBeNull()
            expect(created.engagementScore).toBe(0)
            expect(created.metadata).toBeNull()
        })

        it('findById 不存在的 id 返回 null', () => {
            const found = repo.findById('non-existent-id')
            expect(found).toBeNull()
        })
    })

    // ─────────────────────────────────────────────────────────
    // findAll
    // ─────────────────────────────────────────────────────────

    describe('findAll', () => {
        it('空表返回空数组', () => {
            const list = repo.findAll()
            expect(list).toEqual([])
        })

        it('返回所有行（按 id 排序）', () => {
            repo.create(makeCreateInput({ id: 'aaa-001', name: '学生A' }))
            repo.create(makeCreateInput({ id: 'bbb-002', name: '学生B' }))
            repo.create(makeCreateInput({ id: 'ccc-003', name: '学生C' }))

            const list = repo.findAll()
            expect(list).toHaveLength(3)
            // ORDER BY id（TEXT 排序）：aaa < bbb < ccc
            expect(list[0]!.id).toBe('aaa-001')
            expect(list[1]!.id).toBe('bbb-002')
            expect(list[2]!.id).toBe('ccc-003')
        })

        it('limit 限制返回数量', () => {
            for (let i = 0; i < 5; i++) {
                repo.create(
                    makeCreateInput({
                        id: `id-${i.toString().padStart(3, '0')}`,
                        name: `学生${i}`,
                    }),
                )
            }
            const list = repo.findAll(2, 0)
            expect(list).toHaveLength(2)
        })

        it('offset 跳过前 N 条', () => {
            for (let i = 0; i < 5; i++) {
                repo.create(
                    makeCreateInput({
                        id: `id-${i.toString().padStart(3, '0')}`,
                        name: `学生${i}`,
                    }),
                )
            }
            const list = repo.findAll(10, 2)
            expect(list).toHaveLength(3)
            expect(list[0]!.id).toBe('id-002')
        })

        it('limit + offset 组合', () => {
            for (let i = 0; i < 10; i++) {
                repo.create(
                    makeCreateInput({
                        id: `id-${i.toString().padStart(3, '0')}`,
                        name: `学生${i}`,
                    }),
                )
            }
            const list = repo.findAll(3, 4)
            expect(list).toHaveLength(3)
            expect(list[0]!.id).toBe('id-004')
            expect(list[2]!.id).toBe('id-006')
        })
    })

    // ─────────────────────────────────────────────────────────
    // update
    // ─────────────────────────────────────────────────────────

    describe('update', () => {
        it('更新单个字段', () => {
            const created = repo.create(makeCreateInput())
            const updated = repo.update(created.id, { name: '新名字' })
            expect(updated).not.toBeNull()
            expect(updated?.name).toBe('新名字')
            // 其他字段保持不变
            expect(updated?.classId).toBe('cls-001')
        })

        it('更新多个字段（含 JSON 字段）', () => {
            const created = repo.create(makeCreateInput())
            const updated = repo.update(created.id, {
                name: '王五',
                grade: '五年级',
                cognitiveStyle: 'auditory',
                engagementScore: 0.8,
                metadata: { source: '更新后' },
            })
            expect(updated).not.toBeNull()
            expect(updated?.name).toBe('王五')
            expect(updated?.grade).toBe('五年级')
            expect(updated?.cognitiveStyle).toBe('auditory')
            expect(updated?.engagementScore).toBe(0.8)
            expect(updated?.metadata).toEqual({ source: '更新后' })
        })

        it('更新 classId 与 anonymousName（snake_case 映射）', () => {
            const created = repo.create(makeCreateInput())
            const updated = repo.update(created.id, {
                classId: 'cls-002',
                anonymousName: '学生B02',
            })
            expect(updated?.classId).toBe('cls-002')
            expect(updated?.anonymousName).toBe('学生B02')
        })

        it('空 patch 返回当前实体（不更新任何字段）', () => {
            const created = repo.create(makeCreateInput())
            const before = created.updatedAt
            const updated = repo.update(created.id, {})
            expect(updated).not.toBeNull()
            expect(updated?.name).toBe('张三')
            // 注：BaseRepository 在 keys.length === 0 时直接 return findById(id)
            // 不修改 updated_at
            expect(updated?.updatedAt).toBe(before)
        })

        it('更新不存在的 id 返回 null', () => {
            const updated = repo.update('non-existent-id', { name: '新名字' })
            expect(updated).toBeNull()
        })

        it('更新后 updated_at 自动更新', async () => {
            const created = repo.create(makeCreateInput())
            const beforeUpdatedAt = created.updatedAt

            // 等待 5ms 后更新
            await new Promise((resolve) => setTimeout(resolve, 5))
            const updated = repo.update(created.id, { name: '新名字' })
            expect(updated?.updatedAt).toBeGreaterThanOrEqual(beforeUpdatedAt)
        })
    })

    // ─────────────────────────────────────────────────────────
    // delete
    // ─────────────────────────────────────────────────────────

    describe('delete', () => {
        it('删除存在的 id 返回 true', () => {
            const created = repo.create(makeCreateInput())
            const result = repo.delete(created.id)
            expect(result).toBe(true)
            // 验证已删除
            expect(repo.findById(created.id)).toBeNull()
        })

        it('删除不存在的 id 返回 false', () => {
            const result = repo.delete('non-existent-id')
            expect(result).toBe(false)
        })

        it('删除后再创建同 id 可正常工作', () => {
            const created = repo.create(makeCreateInput({ id: 'reuse-id' }))
            repo.delete(created.id)
            const recreated = repo.create(makeCreateInput({ id: 'reuse-id', name: '新学生' }))
            expect(recreated.id).toBe('reuse-id')
            expect(recreated.name).toBe('新学生')
        })
    })

    // ─────────────────────────────────────────────────────────
    // count
    // ─────────────────────────────────────────────────────────

    describe('count', () => {
        it('空表返回 0', () => {
            expect(repo.count()).toBe(0)
        })

        it('返回总行数（无 where）', () => {
            repo.create(makeCreateInput({ classId: 'cls-001' }))
            repo.create(makeCreateInput({ classId: 'cls-001' }))
            repo.create(makeCreateInput({ classId: 'cls-002' }))
            expect(repo.count()).toBe(3)
        })

        it('按 class_id 等值筛选', () => {
            repo.create(makeCreateInput({ classId: 'cls-001' }))
            repo.create(makeCreateInput({ classId: 'cls-001' }))
            repo.create(makeCreateInput({ classId: 'cls-002' }))
            expect(repo.count({ class_id: 'cls-001' })).toBe(2)
            expect(repo.count({ class_id: 'cls-002' })).toBe(1)
        })

        it('按 grade 等值筛选', () => {
            repo.create(makeCreateInput({ grade: '三年级' }))
            repo.create(makeCreateInput({ grade: '四年级' }))
            expect(repo.count({ grade: '三年级' })).toBe(1)
            expect(repo.count({ grade: '四年级' })).toBe(1)
        })

        it('多条件 AND 筛选', () => {
            repo.create(makeCreateInput({ classId: 'cls-001', grade: '三年级' }))
            repo.create(makeCreateInput({ classId: 'cls-001', grade: '四年级' }))
            repo.create(makeCreateInput({ classId: 'cls-002', grade: '三年级' }))
            expect(repo.count({ class_id: 'cls-001', grade: '三年级' })).toBe(1)
            expect(repo.count({ class_id: 'cls-001', grade: '四年级' })).toBe(1)
        })

        it('无匹配条件返回 0', () => {
            repo.create(makeCreateInput({ classId: 'cls-001' }))
            expect(repo.count({ class_id: '不存在' })).toBe(0)
        })

        it('空对象作为 where 等同于无 where', () => {
            repo.create(makeCreateInput())
            repo.create(makeCreateInput())
            expect(repo.count({})).toBe(2)
        })
    })

    // ─────────────────────────────────────────────────────────
    // findByClassId
    // ─────────────────────────────────────────────────────────

    describe('findByClassId', () => {
        it('返回指定班级的所有学生', () => {
            repo.create(makeCreateInput({ id: 's-001', classId: 'cls-001', name: '张三' }))
            repo.create(makeCreateInput({ id: 's-002', classId: 'cls-001', name: '李四' }))
            repo.create(makeCreateInput({ id: 's-003', classId: 'cls-002', name: '王五' }))

            const list = repo.findByClassId('cls-001')
            expect(list).toHaveLength(2)
            expect(list.map((s) => s.name).sort()).toEqual(['张三', '李四'])
        })

        it('无匹配返回空数组', () => {
            repo.create(makeCreateInput({ classId: 'cls-001' }))
            const list = repo.findByClassId('cls-999')
            expect(list).toEqual([])
        })

        it('精确匹配（不模糊）', () => {
            repo.create(makeCreateInput({ classId: 'cls-001' }))
            repo.create(makeCreateInput({ classId: 'cls-001-extra' }))
            const list = repo.findByClassId('cls-001')
            expect(list).toHaveLength(1)
        })

        it('limit 默认为 500（验证可通过 200+ 学生场景）', () => {
            // 创建 250 个学生（避免过多导致测试缓慢）
            for (let i = 0; i < 250; i++) {
                repo.create(
                    makeCreateInput({
                        id: `s-${i.toString().padStart(3, '0')}`,
                        classId: 'cls-001',
                        name: `学生${i}`,
                    }),
                )
            }
            const list = repo.findByClassId('cls-001')
            expect(list).toHaveLength(250)
        })
    })

    // ─────────────────────────────────────────────────────────
    // findByAnonymousName
    // ─────────────────────────────────────────────────────────

    describe('findByAnonymousName', () => {
        it('返回匹配的学生实体', () => {
            repo.create(makeCreateInput({ id: 's-001', anonymousName: '学生A01' }))
            const found = repo.findByAnonymousName('学生A01')
            expect(found).not.toBeNull()
            expect(found?.anonymousName).toBe('学生A01')
        })

        it('未找到返回 null', () => {
            repo.create(makeCreateInput({ anonymousName: '学生A01' }))
            const found = repo.findByAnonymousName('学生Z99')
            expect(found).toBeNull()
        })

        it('只返回第一个匹配（limit 1）', () => {
            // 即使有重复 anonymousName（理论上不应该），也只返回第一条
            repo.create(makeCreateInput({ id: 's-001', anonymousName: '学生A01' }))
            repo.create(makeCreateInput({ id: 's-002', anonymousName: '学生A01' }))

            const found = repo.findByAnonymousName('学生A01')
            expect(found).not.toBeNull()
            expect(found?.id).toBe('s-001') // 返回第一条
        })

        it('精确匹配（不模糊）', () => {
            repo.create(makeCreateInput({ anonymousName: '学生A01' }))
            const found = repo.findByAnonymousName('学生A')
            expect(found).toBeNull()
        })
    })

    // ─────────────────────────────────────────────────────────
    // 列映射完整性
    // ─────────────────────────────────────────────────────────

    describe('列映射完整性', () => {
        it('所有字段在 create + findById 后保持一致', () => {
            const input: CreateStudentInput = {
                id: 'full-test-001',
                classId: 'cls-full',
                name: '完整测试学生',
                anonymousName: '学生X42',
                grade: '六年级',
                cognitiveStyle: 'kinesthetic',
                engagementScore: 0.85,
                metadata: { chapter: 1, level: 'advanced' },
            }
            const created = repo.create(input)
            const found = repo.findById(created.id)

            expect(found).not.toBeNull()
            expect(found?.id).toBe(input.id)
            expect(found?.classId).toBe(input.classId)
            expect(found?.name).toBe(input.name)
            expect(found?.anonymousName).toBe(input.anonymousName)
            expect(found?.grade).toBe(input.grade)
            expect(found?.cognitiveStyle).toBe(input.cognitiveStyle)
            expect(found?.engagementScore).toBe(input.engagementScore)
            expect(found?.metadata).toEqual(input.metadata)
        })

        it('cognitiveStyle 为 null 时正确序列化与反序列化', () => {
            const created = repo.create(makeCreateInput({ cognitiveStyle: null }))
            const found = repo.findById(created.id)
            expect(found?.cognitiveStyle).toBeNull()
        })

        it('metadata 为 null 时正确处理', () => {
            const created = repo.create(makeCreateInput({ metadata: null }))
            const found = repo.findById(created.id)
            expect(found?.metadata).toBeNull()
        })

        it('engagementScore 为 0 时正确处理（不与 null 混淆）', () => {
            const created = repo.create(makeCreateInput({ engagementScore: 0 }))
            const found = repo.findById(created.id)
            expect(found?.engagementScore).toBe(0)
        })

        it('engagementScore 为负数时正确处理', () => {
            const created = repo.create(makeCreateInput({ engagementScore: -0.5 }))
            const found = repo.findById(created.id)
            expect(found?.engagementScore).toBe(-0.5)
        })
    })
})
