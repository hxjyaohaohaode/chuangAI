/**
 * db/utils/anonymize.ts 单元测试
 *
 * 覆盖：
 * - anonymizeStudentName：脱敏名格式、班级字母稳定、序号递增
 * - anonymizeDataset：替换 studentName、保留 anonymousName、保留无 studentName 项
 * - deanonymize：依赖注入校验、查到/未查到、classId 可选
 * - getClassLetter / nextSeq（通过 anonymizeStudentName 间接验证）
 *
 * 设计原则：
 * - StudentRepository 使用 vi.fn() mock，不依赖真实数据库
 * - 班级字母稳定性通过多次调用同 classId 验证
 * - 不同 classId 字母可能相同（hash 取模），仅验证稳定性而非唯一性
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Anonymizer, type AnonymizerDeps } from './anonymize.js'
import type { StudentRepository } from '../repositories/student.repository.js'
import type { StudentEntity } from '../types.js'

// ─────────────────────────────────────────────────────────────
// 辅助：构造 mock StudentRepository
// ─────────────────────────────────────────────────────────────

function createStudentRepoMock() {
    return {
        findByAnonymousName: vi.fn(),
        findByClassId: vi.fn(),
    }
}

function makeStudent(overrides: Partial<StudentEntity> = {}): StudentEntity {
    return {
        id: 'stu-001',
        classId: 'cls-001',
        name: '张三',
        anonymousName: '学生A01',
        grade: '三年级',
        cognitiveStyle: null,
        engagementScore: 0.5,
        createdAt: 0,
        updatedAt: 0,
        metadata: null,
        ...overrides,
    }
}

// ─────────────────────────────────────────────────────────────
// anonymizeStudentName
// ─────────────────────────────────────────────────────────────

describe('Anonymizer — anonymizeStudentName', () => {
    let anonymizer: Anonymizer

    beforeEach(() => {
        anonymizer = new Anonymizer()
    })

    it('格式：学生 + 字母 + 两位序号', () => {
        const name = anonymizer.anonymizeStudentName('张三', 'cls-001')
        // 形如 "学生A01" / "学生B02" 等
        expect(name).toMatch(/^学生[A-Z]\d{2}$/)
    })

    it('序号从 01 开始递增', () => {
        const n1 = anonymizer.anonymizeStudentName('张三', 'cls-001')
        const n2 = anonymizer.anonymizeStudentName('李四', 'cls-001')
        const n3 = anonymizer.anonymizeStudentName('王五', 'cls-001')
        // 提取序号部分
        const seq1 = parseInt(n1.slice(-2), 10)
        const seq2 = parseInt(n2.slice(-2), 10)
        const seq3 = parseInt(n3.slice(-2), 10)
        expect(seq1).toBe(1)
        expect(seq2).toBe(2)
        expect(seq3).toBe(3)
    })

    it('不同 classId 各自独立计数', () => {
        const a1 = anonymizer.anonymizeStudentName('张三', 'cls-A')
        const b1 = anonymizer.anonymizeStudentName('李四', 'cls-B')
        const a2 = anonymizer.anonymizeStudentName('王五', 'cls-A')
        const b2 = anonymizer.anonymizeStudentName('赵六', 'cls-B')

        // 两个 classId 各自从 01 开始
        expect(a1.endsWith('01')).toBe(true)
        expect(b1.endsWith('01')).toBe(true)
        expect(a2.endsWith('02')).toBe(true)
        expect(b2.endsWith('02')).toBe(true)
    })

    it('同一 classId 多次调用字母保持稳定', () => {
        const n1 = anonymizer.anonymizeStudentName('张三', 'cls-001')
        const n2 = anonymizer.anonymizeStudentName('李四', 'cls-001')
        const n3 = anonymizer.anonymizeStudentName('王五', 'cls-001')
        // 字母部分应相同
        const letter1 = n1.charAt(2)
        const letter2 = n2.charAt(2)
        const letter3 = n3.charAt(2)
        expect(letter1).toBe(letter2)
        expect(letter2).toBe(letter3)
    })

    it('realName 参数不参与脱敏名生成（仅 classId 决定）', () => {
        // 同一 classId，不同 realName，应得到连续序号
        const n1 = anonymizer.anonymizeStudentName('张三', 'cls-X')
        const n2 = anonymizer.anonymizeStudentName('完全不同的名字', 'cls-X')
        // n1=01, n2=02，字母部分相同
        expect(n1.endsWith('01')).toBe(true)
        expect(n2.endsWith('02')).toBe(true)
        expect(n1.charAt(2)).toBe(n2.charAt(2))
    })

    it('序号超过 99 时不再补零（自动扩展位数）', () => {
        // 调用 100 次，第 100 次序号为 100
        for (let i = 0; i < 99; i++) {
            anonymizer.anonymizeStudentName(`name-${i}`, 'cls-100')
        }
        const n100 = anonymizer.anonymizeStudentName('name-99', 'cls-100')
        // padStart(2, '0') 对 100 不补零
        expect(n100.endsWith('100')).toBe(true)
    })

    it('字母在 A-Z 范围内', () => {
        // 测试多个 classId，字母都应在 A-Z
        for (let i = 0; i < 50; i++) {
            const name = anonymizer.anonymizeStudentName('x', `cls-${i}`)
            const letter = name.charAt(2)
            expect(letter).toMatch(/[A-Z]/)
        }
    })
})

// ─────────────────────────────────────────────────────────────
// anonymizeDataset
// ─────────────────────────────────────────────────────────────

describe('Anonymizer — anonymizeDataset', () => {
    let anonymizer: Anonymizer

    beforeEach(() => {
        anonymizer = new Anonymizer()
    })

    it('替换 studentName 为 anonymousName（已有 anonymousName 字段）', () => {
        const data = [
            { studentId: 's1', studentName: '张三', anonymousName: '学生A01', classId: 'cls-001' },
            { studentId: 's2', studentName: '李四', anonymousName: '学生A02', classId: 'cls-001' },
        ]
        const result = anonymizer.anonymizeDataset(data)
        expect(result[0]!.studentName).toBeUndefined()
        expect(result[0]!.anonymousName).toBe('学生A01')
        expect(result[1]!.studentName).toBeUndefined()
        expect(result[1]!.anonymousName).toBe('学生A02')
        // studentId 保留
        expect(result[0]!.studentId).toBe('s1')
    })

    it('无 anonymousName 字段时按 classId 即时生成', () => {
        const data = [
            { studentId: 's1', studentName: '张三', classId: 'cls-001' },
            { studentId: 's2', studentName: '李四', classId: 'cls-001' },
        ]
        const result = anonymizer.anonymizeDataset(data)
        expect(result[0]!.studentName).toBeUndefined()
        expect(result[0]!.anonymousName).toMatch(/^学生[A-Z]\d{2}$/)
        expect(result[1]!.anonymousName).toMatch(/^学生[A-Z]\d{2}$/)
        // 两次生成的序号应不同
        expect(result[0]!.anonymousName).not.toBe(result[1]!.anonymousName)
    })

    it('无 studentName 的项原样返回', () => {
        const data = [
            { studentId: 's1', classId: 'cls-001' }, // 无 studentName
        ]
        const result = anonymizer.anonymizeDataset(data)
        expect(result[0]).toEqual(data[0])
        expect(result[0]!.anonymousName).toBeUndefined()
    })

    it('无 classId 时使用 "unknown" 作为默认', () => {
        const data = [
            { studentId: 's1', studentName: '张三' }, // 无 classId
        ]
        const result = anonymizer.anonymizeDataset(data)
        expect(result[0]!.anonymousName).toMatch(/^学生[A-Z]\d{2}$/)
    })

    it('不修改原数组', () => {
        const data = [
            { studentId: 's1', studentName: '张三', anonymousName: '学生A01', classId: 'cls-001' },
        ]
        const original = JSON.parse(JSON.stringify(data))
        anonymizer.anonymizeDataset(data)
        expect(data).toEqual(original)
    })

    it('空数组返回空数组', () => {
        const result = anonymizer.anonymizeDataset([])
        expect(result).toEqual([])
    })

    it('保留其他字段（如 score、grade 等）', () => {
        const data = [
            {
                studentId: 's1',
                studentName: '张三',
                anonymousName: '学生A01',
                classId: 'cls-001',
                score: 95,
                grade: '三年级',
                cognitiveStyle: 'visual',
            },
        ]
        const result = anonymizer.anonymizeDataset(data)
        expect(result[0]!.score).toBe(95)
        expect(result[0]!.grade).toBe('三年级')
        expect(result[0]!.cognitiveStyle).toBe('visual')
    })

    it('连续多项同一 classId，即时生成的序号递增', () => {
        const data = [
            { studentId: 's1', studentName: '张三', classId: 'cls-X' },
            { studentId: 's2', studentName: '李四', classId: 'cls-X' },
            { studentId: 's3', studentName: '王五', classId: 'cls-X' },
        ]
        const result = anonymizer.anonymizeDataset(data)
        const seq1 = parseInt(result[0]!.anonymousName!.slice(-2), 10)
        const seq2 = parseInt(result[1]!.anonymousName!.slice(-2), 10)
        const seq3 = parseInt(result[2]!.anonymousName!.slice(-2), 10)
        expect(seq2).toBe(seq1 + 1)
        expect(seq3).toBe(seq2 + 1)
    })
})

// ─────────────────────────────────────────────────────────────
// deanonymize
// ─────────────────────────────────────────────────────────────

describe('Anonymizer — deanonymize', () => {
    let repo: ReturnType<typeof createStudentRepoMock>
    let anonymizer: Anonymizer

    beforeEach(() => {
        repo = createStudentRepoMock()
        const deps: AnonymizerDeps = {
            studentRepo: repo as unknown as StudentRepository,
        }
        anonymizer = new Anonymizer(deps)
    })

    it('查到学生 → 返回真实姓名', () => {
        repo.findByAnonymousName.mockReturnValue(makeStudent({ name: '张三' }))
        const result = anonymizer.deanonymize('学生A01', 'cls-001')
        expect(result).toBe('张三')
        expect(repo.findByAnonymousName).toHaveBeenCalledWith('学生A01')
    })

    it('未查到学生 → 返回 null', () => {
        repo.findByAnonymousName.mockReturnValue(null)
        const result = anonymizer.deanonymize('学生Z99', 'cls-001')
        expect(result).toBeNull()
    })

    it('classId 参数可选', () => {
        repo.findByAnonymousName.mockReturnValue(makeStudent({ name: '李四' }))
        const result = anonymizer.deanonymize('学生A01')
        expect(result).toBe('李四')
    })

    it('未注入 StudentRepository → 抛错', () => {
        const noDepsAnonymizer = new Anonymizer()
        expect(() => noDepsAnonymizer.deanonymize('学生A01'))
            .toThrow(/未注入 StudentRepository/)
    })

    it('学生无 name 字段时返回 null', () => {
        // 边界：repo 返回的对象 name 为 undefined
        const studentPartial = { ...makeStudent(), name: undefined } as unknown as StudentEntity
        repo.findByAnonymousName.mockReturnValue(studentPartial)
        const result = anonymizer.deanonymize('学生A01')
        expect(result).toBeNull()
    })
})
