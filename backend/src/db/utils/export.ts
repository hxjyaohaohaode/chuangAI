/**
 * 数据导出工具
 *
 * 隐私优先：导出班级报告时自动脱敏（姓名→编号）。
 * 所有导出数据携带 aiGenerated: true 元数据，标识为系统生成。
 */

import type { ClassRepository } from '../repositories/class.repository.js'
import type { StudentRepository } from '../repositories/student.repository.js'
import type { EventRepository } from '../repositories/event.repository.js'
import type { MasteryRepository } from '../repositories/mastery.repository.js'
import type { BloomMastery } from '../../agents/base/types.js'

/**
 * 班级报告数据
 */
export interface ClassReportData {
    className: string
    classId: string
    period: { from: number; to: number }
    anonymizedStudents: Array<{ id: string; anonymousName: string }>
    /** 班级六阶均值雷达 */
    classBloomRadar: BloomMastery
    /** 每学生六阶雷达 */
    studentRadars: Array<{ studentId: string; anonymousName: string; radar: BloomMastery }>
    /** 脱敏后的事件流 */
    events: Array<{
        id: string
        studentId: string | null
        anonymousName: string | null
        type: string
        action: string
        occurredAt: number
        poemId: string | null
    }>
    aiGenerated: true
}

/**
 * 依赖注入参数
 */
export interface DataExporterDeps {
    classRepo: ClassRepository
    studentRepo: StudentRepository
    eventRepo: EventRepository
    masteryRepo: MasteryRepository
}

export class DataExporter {
    constructor(private readonly deps: DataExporterDeps) {}

    /**
     * 导出班级报告数据（自动脱敏）
     *
     * @param classId 班级 ID
     * @param period 时间范围 { from, to }（Unix timestamp ms）
     */
    exportClassReportData(
        classId: string,
        period: { from: number; to: number },
    ): ClassReportData {
        // 1. 查询班级
        const cls = this.deps.classRepo.findById(classId)
        if (!cls) {
            throw new Error(`[exporter] 班级不存在: ${classId}`)
        }

        // 2. 查询学生（取脱敏名）
        const students = this.deps.studentRepo.findByClassId(classId)
        const anonymizedStudents = students.map((s) => ({
            id: s.id,
            anonymousName: s.anonymousName,
        }))

        // 3. 班级六阶雷达
        const radarRows = this.deps.masteryRepo.getClassBloomRadar(classId)
        const classBloomRadar: BloomMastery = {
            记忆: 0, 理解: 0, 应用: 0, 分析: 0, 评价: 0, 创造: 0,
        }
        for (const row of radarRows) {
            const level = row.bloom_level as keyof BloomMastery
            if (level in classBloomRadar) {
                classBloomRadar[level] = Math.round((row.avg_score ?? 0) * 10) / 10
            }
        }

        // 4. 每学生六阶雷达
        const studentRadars: ClassReportData['studentRadars'] = students.map((s) => {
            const rows = this.deps.masteryRepo.getStudentBloomRadarViaView(s.id)
            const radar: BloomMastery = {
                记忆: 0, 理解: 0, 应用: 0, 分析: 0, 评价: 0, 创造: 0,
            }
            for (const row of rows) {
                const level = row.bloom_level as keyof BloomMastery
                if (level in radar) {
                    radar[level] = Math.round((row.avg_score ?? 0) * 10) / 10
                }
            }
            return {
                studentId: s.id,
                anonymousName: s.anonymousName,
                radar,
            }
        })

        // 5. 事件流（脱敏）
        const events = this.deps.eventRepo.findByClassAndTimeRange(classId, period.from, period.to)
        // 构建 studentId → anonymousName 映射
        const idToAnon = new Map<string, string>()
        for (const s of students) idToAnon.set(s.id, s.anonymousName)

        const anonymizedEvents = events.map((e) => ({
            id: e.id,
            studentId: e.studentId,
            anonymousName: e.studentId ? (idToAnon.get(e.studentId) ?? null) : null,
            type: e.type,
            action: e.action,
            occurredAt: e.occurredAt,
            poemId: e.poemId,
        }))

        return {
            className: cls.name,
            classId,
            period,
            anonymizedStudents,
            classBloomRadar,
            studentRadars,
            events: anonymizedEvents,
            aiGenerated: true,
        }
    }
}
