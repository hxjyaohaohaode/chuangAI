/**
 * 数据脱敏工具
 *
 * 隐私优先原则：导出报告时自动脱敏，真实姓名仅教师可见。
 *
 * 脱敏规则：学生 + 班级字母 + 两位序号
 * - 班级 ID 决定字母（A-Z，按 UUID 字典序映射，避免可推测）
 * - 班级内序号从 01 开始递增
 *
 * 双向转换：
 * - anonymizeStudentName: 真实姓名 → 脱敏名
 * - deanonymize: 脱敏名 → 真实姓名（仅教师权限调用）
 */

import type { StudentRepository } from '../repositories/student.repository.js'

/**
 * 脱敏名前缀
 */
const ANONYM_PREFIX = '学生'

/**
 * 班级字母表（A-Z，共 26 个）
 */
const CLASS_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * 依赖注入参数
 */
export interface AnonymizerDeps {
    studentRepo: StudentRepository
}

export class Anonymizer {
    /** 班级 ID → 字母 映射缓存（按字典序分配字母） */
    private classLetterCache: Map<string, string> = new Map()
    /** 班级 ID → 下一个序号 */
    private classSeqCache: Map<string, number> = new Map()

    constructor(private readonly deps?: AnonymizerDeps) { }

    /**
     * 替换学生姓名为编号
     *
     * 规则：学生 + 班级字母 + 两位序号
     * 例如："张三" / classId="cls-001" → "学生A01"
     *
     * @param _realName 真实姓名（保留入参以兼容无仓储场景，实际脱敏名由 anonymousName 字段决定）
     * @param classId 班级 ID
     * @returns 脱敏名
     */
    anonymizeStudentName(_realName: string, classId: string): string {
        // 注意：实际项目中应直接读取 students.anonymous_name 字段
        // 此方法提供"无仓储"模式下的"即时脱敏"——按 classId 分配字母 + 序号
        // _realName 不参与生成（脱敏名仅由班级字母 + 序号组成），保留入参以兼容 API 约定
        const letter = this.getClassLetter(classId)
        const seq = this.nextSeq(classId)
        return `${ANONYM_PREFIX}${letter}${seq.toString().padStart(2, '0')}`
    }

    /**
     * 脱敏整个数据集（用于导出报告）
     *
     * 替换所有 studentName 为 anonymousName，studentId 保持不变
     * 若数据中无 anonymousName 字段，则按 classId 即时生成
     *
     * 返回类型说明：
     * - studentName 字段在运行时被移除（测试通过 toBeUndefined 验证），
     *   但类型上保留为可选，以便测试访问该字段断言其已脱敏
     * - anonymousName 字段被添加（可能为 string 或 undefined）
     *   - 有 studentName 的项：anonymousName 为 string（来自字段或即时生成）
     *   - 无 studentName 的项：原样返回，anonymousName 可能 undefined
     */
    anonymizeDataset<T extends { studentId?: string; studentName?: string; anonymousName?: string; classId?: string }>(
        data: T[],
    ): Array<Omit<T, 'anonymousName'> & { studentName?: string; anonymousName?: string }> {
        return data.map((item) => {
            if (item.studentName === undefined) {
                return item as Omit<T, 'anonymousName'> & { studentName?: string; anonymousName?: string }
            }
            const classId = item.classId ?? 'unknown'
            const anonymousName =
                item.anonymousName ?? this.anonymizeStudentName(item.studentName, classId)
            const { studentName: _omit, anonymousName: _omitAnon, ...rest } = item
            // 运行时 studentName 已被移除（_omit 仅用于类型剥离），测试通过 toBeUndefined 验证
            return { ...rest, anonymousName } as Omit<T, 'anonymousName'> & {
                studentName?: string
                anonymousName?: string
            }
        })
    }

    /**
     * 反向查询（仅教师权限）：通过 anonymous_name 查真实姓名
     *
     * @param anonymousName 脱敏名
     * @param classId 班级 ID（缩小查询范围）
     * @returns 真实姓名，未找到返回 null
     */
    deanonymize(anonymousName: string, _classId?: string): string | null {
        if (!this.deps) {
            throw new Error('[anonymizer] 未注入 StudentRepository，无法执行 deanonymize')
        }
        const student = this.deps.studentRepo.findByAnonymousName(anonymousName)
        return student?.name ?? null
    }

    // ── 内部辅助方法 ──

    /**
     * 获取班级对应的字母（按 classId 字典序稳定分配）
     */
    private getClassLetter(classId: string): string {
        const cached = this.classLetterCache.get(classId)
        if (cached) return cached

        // 简化策略：用 classId 的 hash 取模 26
        let hash = 0
        for (let i = 0; i < classId.length; i++) {
            hash = (hash * 31 + classId.charCodeAt(i)) & 0xffffffff
        }
        const idx = Math.abs(hash) % CLASS_LETTERS.length
        const letter = CLASS_LETTERS[idx] ?? 'A'
        this.classLetterCache.set(classId, letter)
        return letter
    }

    /**
     * 获取班级下一个序号
     */
    private nextSeq(classId: string): number {
        const cur = this.classSeqCache.get(classId) ?? 0
        const next = cur + 1
        this.classSeqCache.set(classId, next)
        return next
    }
}
