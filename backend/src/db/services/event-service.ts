/**
 * 学情事件流服务
 *
 * 提供事件记录、查询与参与度统计能力。
 * 参与度算法：基于近 N 天事件数量 + 类型权重加权计算。
 */

import type { EventRepository } from '../repositories/event.repository.js'
import type { EventEntity, EventType, CreateEventInput } from '../types.js'

/**
 * 事件记录入参
 */
export interface RecordEventInput {
    studentId?: string | null
    classId?: string | null
    lessonId?: string | null
    type: EventType
    action: string
    payload?: unknown | null
    poemId?: string | null
    /** 发生时间，默认 now */
    occurredAt?: number
    metadata?: Record<string, unknown> | null
}

/**
 * 事件类型权重（用于参与度计算）
 * 高质量学习行为权重高，被动行为权重低
 */
const EVENT_TYPE_WEIGHTS: Record<EventType, number> = {
    'answer': 3,        // 答题（核心学习行为）
    'creative': 3,      // 创作类（高阶认知）
    'recitation': 2,    // 朗读（多模态学习）
    'self-study': 2,    // 自学
    'classroom': 1.5,   // 课堂互动
    'login': 0.5,       // 登录（基础活跃度）
    'other': 0.5,       // 其他
}

/**
 * 参与度计算参考：理想学生 7 天内的事件加权总分
 * 达到此值即视为 100 分
 */
const ENGAGEMENT_FULL_SCORE_REFERENCE = 100

/**
 * 依赖注入参数
 */
export interface EventServiceDeps {
    eventRepo: EventRepository
}

export class EventService {
    constructor(private readonly deps: EventServiceDeps) {}

    /**
     * 记录学情事件
     */
    record(event: RecordEventInput): EventEntity {
        const input: CreateEventInput = {
            type: event.type,
            action: event.action,
            studentId: event.studentId ?? null,
            classId: event.classId ?? null,
            lessonId: event.lessonId ?? null,
            payload: event.payload ?? null,
            poemId: event.poemId ?? null,
            occurredAt: event.occurredAt ?? Date.now(),
            metadata: event.metadata ?? null,
        }
        return this.deps.eventRepo.create(input)
    }

    /**
     * 查询学生近期事件（用于学情画像 Agent）
     */
    getStudentRecentEvents(studentId: string, limit = 50): EventEntity[] {
        return this.deps.eventRepo.findRecentByStudentId(studentId, limit)
    }

    /**
     * 查询班级某时段事件
     */
    getClassEvents(
        classId: string,
        from: number,
        to: number,
        type?: EventType,
    ): EventEntity[] {
        return this.deps.eventRepo.findByClassAndTimeRange(classId, from, to, type)
    }

    /**
     * 统计学生参与度（用于 engagementScore）
     *
     * 算法：
     * 1. 取近 N 天事件按类型计数
     * 2. 加权求和（answer=3, creative=3, recitation=2, ...）
     * 3. 归一化到 0-100（参考值 100）
     *
     * @param studentId 学生 ID
     * @param sinceDays 统计窗口（天），默认 7
     * @returns 0-100
     */
    calculateEngagement(studentId: string, sinceDays: number = 7): number {
        const now = Date.now()
        const sinceTs = now - sinceDays * 24 * 60 * 60 * 1000
        const counts = this.deps.eventRepo.countByStudentSince(studentId, sinceTs)

        let weightedSum = 0
        for (const { type, cnt } of counts) {
            const weight = EVENT_TYPE_WEIGHTS[type as EventType] ?? 0.5
            weightedSum += weight * cnt
        }

        // 归一化：参考值为满分，超出按 100 截断
        const raw = (weightedSum / ENGAGEMENT_FULL_SCORE_REFERENCE) * 100
        return Math.max(0, Math.min(100, Math.round(raw)))
    }
}

/**
 * 导出事件类型权重常量（其他模块可复用）
 */
export { EVENT_TYPE_WEIGHTS, ENGAGEMENT_FULL_SCORE_REFERENCE }
