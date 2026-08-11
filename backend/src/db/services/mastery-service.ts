/**
 * 六阶掌握度服务
 *
 * 基于 EMA（指数移动平均）算法跟踪学生布鲁姆六阶掌握度。
 * 每次 recordAnswer 操作通过事务包裹 mastery UPSERT + events 写入，
 * 保证数据一致性（"数据即同步"原则）。
 *
 * EMA 公式：score = α * newScore + (1-α) * prevScore
 * α=0.3：新观测权重 30%，历史权重 70%，避免单次成绩剧烈抖动。
 */

import type Database from 'better-sqlite3'
import type { BloomMastery, BloomLevel } from '../../agents/base/types.js'
import type { MasteryRepository } from '../repositories/mastery.repository.js'
import type { EventRepository } from '../repositories/event.repository.js'
import type { QuestionRepository } from '../repositories/question.repository.js'
import type { StudentRepository } from '../repositories/student.repository.js'

/** 六阶顺序（由低到高） */
const BLOOM_ORDER: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

/** 空 BloomMastery（未有任何答题记录时） */
const EMPTY_MASTERY: BloomMastery = {
    记忆: 0,
    理解: 0,
    应用: 0,
    分析: 0,
    评价: 0,
    创造: 0,
}

/**
 * 班级某诗掌握度（含学生数量）
 */
export interface ClassPoemMastery extends BloomMastery {
    studentCount: number
}

/**
 * 构造函数依赖注入参数
 */
export interface MasteryServiceDeps {
    db: Database.Database
    masteryRepo: MasteryRepository
    eventRepo: EventRepository
    questionRepo: QuestionRepository
    studentRepo: StudentRepository
}

export class MasteryService {
    /** EMA 平滑系数：α 越大越敏感于新数据 */
    private static readonly EMA_ALPHA = 0.3

    constructor(private readonly deps: MasteryServiceDeps) {}

    /**
     * 记录一次答题，更新掌握度
     *
     * 流程（事务包裹）：
     * 1. 查询 question 的 poem_id + bloom_level
     * 2. 计算本次分数：correct=100 / wrong=0 / partial=partialScore*100
     * 3. UPSERT mastery（attempts++、correctCount 按需++、score 按 EMA 更新）
     * 4. 写入 events 表
     *
     * @param studentId 学生 ID
     * @param questionId 题目 ID
     * @param correct 是否正确（partialScore 优先）
     * @param partialScore 部分得分（0-1），优先于 correct
     */
    recordAnswer(
        studentId: string,
        questionId: string,
        correct: boolean,
        partialScore?: number,
    ): void {
        const { db, masteryRepo, eventRepo, questionRepo, studentRepo } = this.deps

        const tx = db.transaction(() => {
            // 1. 查询题目
            const question = questionRepo.findById(questionId)
            if (!question) {
                throw new Error(`[mastery] 题目不存在: ${questionId}`)
            }
            const poemId = question.poemId
            const bloomLevel = question.bloomLevel

            // 2. 查询学生所属班级（用于事件流的 classId 关联）
            const student = studentRepo.findById(studentId)
            const classId = student?.classId ?? null

            // 3. 计算本次得分
            const newScore = this.computeObservationScore(correct, partialScore)

            // 4. 查询现有掌握度，计算 EMA
            const existing = masteryRepo.findByStudentPoemBloom(studentId, poemId, bloomLevel)
            const prevScore = existing?.score ?? 0
            const updatedScore = this.calculateEMA(prevScore, newScore)

            // 5. UPSERT
            masteryRepo.upsertScore(studentId, poemId, bloomLevel, updatedScore, correct)

            // 6. 写入事件流（含 classId，便于班级级查询与导出）
            eventRepo.create({
                studentId,
                classId,
                type: 'answer',
                action: 'submit-answer',
                payload: {
                    questionId,
                    poemId,
                    bloomLevel,
                    correct,
                    partialScore: partialScore ?? null,
                    observationScore: newScore,
                    prevMasteryScore: prevScore,
                    updatedMasteryScore: updatedScore,
                },
                poemId,
            })
        })

        tx()
    }

    /**
     * 获取学生某诗六阶掌握度
     */
    getStudentPoemMastery(studentId: string, poemId: string): BloomMastery {
        const records = this.deps.masteryRepo.findByStudentPoem(studentId, poemId)
        const result: BloomMastery = { ...EMPTY_MASTERY }
        for (const r of records) {
            const key = r.bloomLevel
            if (key in result) {
                result[key] = Math.round(r.score * 10) / 10
            }
        }
        return result
    }

    /**
     * 获取学生整体六阶雷达（所有诗的六阶均值）
     */
    getStudentBloomRadar(studentId: string): BloomMastery {
        const rows = this.deps.masteryRepo.getStudentBloomRadarViaView(studentId)
        const result: BloomMastery = { ...EMPTY_MASTERY }
        for (const row of rows) {
            const level = row.bloom_level as BloomLevel
            if (level in result) {
                result[level] = Math.round((row.avg_score ?? 0) * 10) / 10
            }
        }
        return result
    }

    /**
     * 获取班级某诗六阶均值
     */
    getClassPoemMastery(classId: string, poemId: string): ClassPoemMastery {
        const rows = this.deps.masteryRepo.getClassPoemMasteryViaView(classId, poemId)
        const result: ClassPoemMastery = {
            ...EMPTY_MASTERY,
            studentCount: 0,
        }
        // 取最大学生数（不同阶层的学生数可能不同）
        let maxCount = 0
        for (const row of rows) {
            const level = row.bloom_level as BloomLevel
            if (level in result) {
                result[level] = Math.round((row.avg_score ?? 0) * 10) / 10
            }
            if (row.student_count > maxCount) maxCount = row.student_count
        }
        result.studentCount = maxCount
        return result
    }

    /**
     * 获取班级六阶雷达（所有学生所有诗的六阶均值）
     */
    getClassBloomRadar(classId: string): BloomMastery {
        const rows = this.deps.masteryRepo.getClassBloomRadar(classId)
        const result: BloomMastery = { ...EMPTY_MASTERY }
        for (const row of rows) {
            const level = row.bloom_level as BloomLevel
            if (level in result) {
                result[level] = Math.round((row.avg_score ?? 0) * 10) / 10
            }
        }
        return result
    }

    /**
     * EMA 算法
     *
     * @param prevScore 历史得分（0-100）
     * @param newScore 本次观测得分（0-100）
     * @param alpha 平滑系数，默认 0.3
     * @returns 更新后的得分（0-100）
     */
    private calculateEMA(prevScore: number, newScore: number, alpha: number = MasteryService.EMA_ALPHA): number {
        const score = alpha * newScore + (1 - alpha) * prevScore
        // 钳制到 [0, 100]
        return Math.max(0, Math.min(100, score))
    }

    /**
     * 计算本次观测得分（0-100）
     * - 优先使用 partialScore（部分得分）
     * - 否则 correct → 100, wrong → 0
     */
    private computeObservationScore(correct: boolean, partialScore?: number): number {
        if (typeof partialScore === 'number' && partialScore >= 0 && partialScore <= 1) {
            return partialScore * 100
        }
        return correct ? 100 : 0
    }
}

/**
 * 导出六阶顺序常量（其他模块可复用）
 */
export { BLOOM_ORDER }
