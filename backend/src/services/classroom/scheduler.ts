/**
 * 课堂实时调度引擎（课堂指挥深化 Task 2）
 *
 * 4 种调度策略：
 * - round-robin 轮询：按调用次数均衡，优先调用次数最少的学生
 * - random-draw 抽签：加权随机，权重与（1 - callCount/maxCall）成正比
 * - pk 对战：选择正确率相近的两名学生进行对战
 * - tiered 分层：困难学生优先（正确率 <0.4），其次活跃学生，最后空闲学生
 *
 * 自适应难度：
 * - 全班正确率 >0.8 时，自动提升难度（优先调用正确率高的学生）
 * - 全班正确率 <0.4 时，自动降低难度（优先调用正确率低的学生给予机会）
 *
 * 教师手动覆盖：
 * - 教师可指定学生，调度器记录覆盖状态，下一次 next() 时清除
 *
 * 时间提醒：
 * - 时间进度 >0.8 时，调度策略自动切换为 round-robin 保证公平
 *
 * 设计要点（规范第 12 章 —— 实时数据同步）：
 * - 调度状态在内存 Map 中维护，随课堂 runtime 生命周期存亡
 * - 无副作用：纯函数式计算，不修改 runtime（由路由层负责持久化）
 */

import type { ClassroomRuntime, StudentResponse } from '../../routes/classroom.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 调度策略 */
export type ScheduleStrategy = 'round-robin' | 'random-draw' | 'pk' | 'tiered'

/** 学生候选项 */
export interface ScheduleCandidate {
    studentId: string
    studentName: string
    /** 学生状态：active 活跃 / idle 空闲 / struggling 困难 */
    status: 'active' | 'idle' | 'struggling'
    /** 近期正确率 0-1 */
    accuracy: number
    /** 累计被调度次数 */
    callCount: number
    /** 上次被调度时间戳 */
    lastCalledAt?: number
}

/** 调度结果 */
export interface ScheduleResult {
    /** 被选中学生 ID */
    studentId: string
    /** 被选中学生姓名 */
    studentName: string
    /** 选择理由 */
    reason: string
    /** 实际使用的策略 */
    strategy: ScheduleStrategy
    /** 候选学生列表 */
    candidates: ScheduleCandidate[]
    /** 是否为教师覆盖 */
    isOverride: boolean
}

/** 调度状态 */
export interface ScheduleStatus {
    /** 当前调度策略 */
    currentStrategy: ScheduleStrategy
    /** 时间进度 0-1 */
    timeProgress: number
    /** 已调度次数 */
    totalCalls: number
    /** 候选学生列表 */
    candidates: ScheduleCandidate[]
    /** 当前被调度学生（若有） */
    currentStudent?: {
        studentId: string
        studentName: string
        calledAt: number
    }
    /** 是否被教师手动覆盖 */
    isOverridden: boolean
}

// ─────────────────────────────────────────────────────────────
// 调度器实现
// ─────────────────────────────────────────────────────────────

/**
 * 课堂调度引擎
 *
 * 每个课堂（lessonId）维护独立的调度状态：
 * - callCounts：学生 -> 被调用次数
 * - lastCalledAt：学生 -> 上次被调用时间戳
 * - currentStrategy：当前策略
 * - overriddenStudent：教师覆盖的学生 ID（null 表示无覆盖）
 * - currentStudent：当前被调度的学生
 * - totalCalls：累计调度次数
 */
export class ClassroomScheduler {
    /** lessonId -> (studentId -> callCount) */
    private callCounts = new Map<string, Map<string, number>>()
    /** lessonId -> (studentId -> lastCalledAt) */
    private lastCalledAt = new Map<string, Map<string, number>>()
    /** lessonId -> currentStrategy */
    private strategies = new Map<string, ScheduleStrategy>()
    /** lessonId -> overridden studentId (null = no override) */
    private overridden = new Map<string, string | null>()
    /** lessonId -> current scheduled student */
    private currentStudents = new Map<string, { studentId: string; studentName: string; calledAt: number }>()
    /** lessonId -> total calls */
    private totalCalls = new Map<string, number>()

    /** 默认策略 */
    private static readonly DEFAULT_STRATEGY: ScheduleStrategy = 'round-robin'

    /**
     * 构建候选学生列表
     * 从 runtime.students 与 responses 中提取每个学生的状态与正确率
     */
    buildCandidates(runtime: ClassroomRuntime): ScheduleCandidate[] {
        const candidates: ScheduleCandidate[] = []
        const lessonCallCounts = this.callCounts.get(runtime.lessonId) ?? new Map<string, number>()
        const lessonLastCalled = this.lastCalledAt.get(runtime.lessonId) ?? new Map<string, number>()

        for (const [studentId, studentName] of runtime.students) {
            // 统计该学生在所有题目中的作答
            const studentResponses: StudentResponse[] = []
            for (const rs of runtime.responses.values()) {
                for (const r of rs) {
                    if (r.studentId === studentId) {
                        studentResponses.push(r)
                    }
                }
            }

            // 计算正确率
            const correctCount = studentResponses.filter((r) => r.correct).length
            const accuracy = studentResponses.length > 0 ? correctCount / studentResponses.length : 0.5

            // 判断状态
            let status: ScheduleCandidate['status']
            if (studentResponses.length === 0) {
                status = 'idle'
            } else if (accuracy < 0.4) {
                status = 'struggling'
            } else {
                status = 'active'
            }

            candidates.push({
                studentId,
                studentName,
                status,
                accuracy,
                callCount: lessonCallCounts.get(studentId) ?? 0,
                lastCalledAt: lessonLastCalled.get(studentId),
            })
        }

        return candidates
    }

    /**
     * 选择下一个学生
     *
     * @param runtime 课堂运行时
     * @param preferredStrategy 教师首选策略（可选，默认使用当前策略）
     * @param timeProgress 时间进度 0-1（>0.8 时强制 round-robin）
     */
    selectNext(
        runtime: ClassroomRuntime,
        preferredStrategy?: ScheduleStrategy,
        timeProgress = 0,
    ): ScheduleResult {
        const lessonId = runtime.lessonId
        const candidates = this.buildCandidates(runtime)

        // 无学生时返回空结果
        if (candidates.length === 0) {
            return {
                studentId: '',
                studentName: '',
                reason: '当前无学生在线',
                strategy: 'round-robin',
                candidates: [],
                isOverride: false,
            }
        }

        // 教师覆盖优先
        const overrideId = this.overridden.get(lessonId)
        if (overrideId) {
            const candidate = candidates.find((c) => c.studentId === overrideId)
            if (candidate) {
                this.recordCall(lessonId, candidate.studentId, candidate.studentName)
                this.overridden.set(lessonId, null) // 消费一次覆盖
                return {
                    studentId: candidate.studentId,
                    studentName: candidate.studentName,
                    reason: `教师手动指定 ${candidate.studentName} 回答`,
                    strategy: preferredStrategy ?? this.getStrategy(lessonId),
                    candidates,
                    isOverride: true,
                }
            }
        }

        // 确定实际策略
        let strategy = preferredStrategy ?? this.getStrategy(lessonId)
        // 时间进度 >0.8 时强制公平轮询
        if (timeProgress > 0.8) {
            strategy = 'round-robin'
        }
        // 自适应难度：全班正确率 >0.8 提升难度，<0.4 降低难度
        const classAccuracy = this.computeClassAccuracy(candidates)
        if (classAccuracy > 0.8 && strategy === 'tiered') {
            strategy = 'pk' // 高正确率切换为对战
        } else if (classAccuracy < 0.4 && strategy === 'pk') {
            strategy = 'tiered' // 低正确率切换为分层（给困难学生机会）
        }

        this.setStrategy(lessonId, strategy)

        // 按策略选择
        const selected = this.selectByStrategy(candidates, strategy)

        if (!selected) {
            // 兜底：选第一个
            const fallback = candidates[0]!
            this.recordCall(lessonId, fallback.studentId, fallback.studentName)
            return {
                studentId: fallback.studentId,
                studentName: fallback.studentName,
                reason: '默认调度（无匹配候选）',
                strategy,
                candidates,
                isOverride: false,
            }
        }

        this.recordCall(lessonId, selected.studentId, selected.studentName)

        return {
            studentId: selected.studentId,
            studentName: selected.studentName,
            reason: selected.reason,
            strategy,
            candidates,
            isOverride: false,
        }
    }

    /**
     * 教师手动覆盖：指定学生回答
     */
    override(lessonId: string, studentId: string, studentName: string): void {
        this.overridden.set(lessonId, studentId)
        this.currentStudents.set(lessonId, { studentId, studentName, calledAt: Date.now() })
    }

    /**
     * 获取调度状态
     */
    getStatus(lessonId: string, runtime: ClassroomRuntime, timeProgress = 0): ScheduleStatus {
        const candidates = this.buildCandidates(runtime)
        const currentStudent = this.currentStudents.get(lessonId)
        const overriddenId = this.overridden.get(lessonId)

        return {
            currentStrategy: this.getStrategy(lessonId),
            timeProgress,
            totalCalls: this.totalCalls.get(lessonId) ?? 0,
            candidates,
            currentStudent,
            isOverridden: overriddenId != null && overriddenId !== '',
        }
    }

    /**
     * 清理课堂调度状态（课堂结束时调用）
     */
    cleanup(lessonId: string): void {
        this.callCounts.delete(lessonId)
        this.lastCalledAt.delete(lessonId)
        this.strategies.delete(lessonId)
        this.overridden.delete(lessonId)
        this.currentStudents.delete(lessonId)
        this.totalCalls.delete(lessonId)
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    /** 获取当前策略 */
    private getStrategy(lessonId: string): ScheduleStrategy {
        return this.strategies.get(lessonId) ?? ClassroomScheduler.DEFAULT_STRATEGY
    }

    /** 设置当前策略 */
    private setStrategy(lessonId: string, strategy: ScheduleStrategy): void {
        this.strategies.set(lessonId, strategy)
    }

    /** 记录一次调用 */
    private recordCall(lessonId: string, studentId: string, studentName: string): void {
        const counts = this.callCounts.get(lessonId) ?? new Map<string, number>()
        counts.set(studentId, (counts.get(studentId) ?? 0) + 1)
        this.callCounts.set(lessonId, counts)

        const lastCalled = this.lastCalledAt.get(lessonId) ?? new Map<string, number>()
        lastCalled.set(studentId, Date.now())
        this.lastCalledAt.set(lessonId, lastCalled)

        this.currentStudents.set(lessonId, { studentId, studentName, calledAt: Date.now() })
        this.totalCalls.set(lessonId, (this.totalCalls.get(lessonId) ?? 0) + 1)
    }

    /** 计算全班正确率 */
    private computeClassAccuracy(candidates: ScheduleCandidate[]): number {
        const withResponses = candidates.filter((c) => c.callCount > 0 || c.accuracy !== 0.5)
        if (withResponses.length === 0) return 0.5
        const sum = withResponses.reduce((acc, c) => acc + c.accuracy, 0)
        return sum / withResponses.length
    }

    /**
     * 按策略选择学生
     * 返回 { studentId, studentName, reason }
     */
    private selectByStrategy(
        candidates: ScheduleCandidate[],
        strategy: ScheduleStrategy,
    ): { studentId: string; studentName: string; reason: string } | null {
        if (candidates.length === 0) return null

        switch (strategy) {
            case 'round-robin':
                return this.selectRoundRobin(candidates)
            case 'random-draw':
                return this.selectRandomDraw(candidates)
            case 'pk':
                return this.selectPk(candidates)
            case 'tiered':
                return this.selectTiered(candidates)
            default:
                return this.selectRoundRobin(candidates)
        }
    }

    /**
     * 轮询：选择调用次数最少的学生
     * 平局时选择上次调用时间最早的
     */
    private selectRoundRobin(candidates: ScheduleCandidate[]): { studentId: string; studentName: string; reason: string } {
        const sorted = [...candidates].sort((a, b) => {
            // 调用次数升序
            if (a.callCount !== b.callCount) return a.callCount - b.callCount
            // 上次调用时间升序（更早的优先）
            const aTime = a.lastCalledAt ?? 0
            const bTime = b.lastCalledAt ?? 0
            return aTime - bTime
        })
        const selected = sorted[0]!
        return {
            studentId: selected.studentId,
            studentName: selected.studentName,
            reason: `轮询调度：${selected.studentName} 被调用次数最少（${selected.callCount} 次），保证公平参与`,
        }
    }

    /**
     * 抽签：加权随机
     * 权重 = (1 - callCount / (maxCall + 1))，调用越少权重越高
     */
    private selectRandomDraw(candidates: ScheduleCandidate[]): { studentId: string; studentName: string; reason: string } {
        const maxCall = Math.max(...candidates.map((c) => c.callCount), 1)
        const weights = candidates.map((c) => 1 - c.callCount / (maxCall + 1))
        const totalWeight = weights.reduce((sum, w) => sum + w, 0)

        // 加权随机
        let rand = Math.random() * totalWeight
        let selectedIdx = 0
        for (let i = 0; i < weights.length; i++) {
            rand -= weights[i]!
            if (rand <= 0) {
                selectedIdx = i
                break
            }
        }
        const selected = candidates[selectedIdx]!
        return {
            studentId: selected.studentId,
            studentName: selected.studentName,
            reason: `抽签调度：随机选中 ${selected.studentName}（权重 ${weights[selectedIdx]!.toFixed(2)}），增加课堂悬念`,
        }
    }

    /**
     * 对战：选择正确率相近的两名学生中的胜者候选
     * 实际返回正确率中位的学生，便于教师组织 PK
     */
    private selectPk(candidates: ScheduleCandidate[]): { studentId: string; studentName: string; reason: string } {
        // 过滤有作答记录的学生
        const withAccuracy = candidates.filter((c) => c.callCount > 0 || c.accuracy !== 0.5)
        const pool = withAccuracy.length >= 2 ? withAccuracy : candidates

        // 按正确率排序，选择中位数附近的学生
        const sorted = [...pool].sort((a, b) => a.accuracy - b.accuracy)
        const midIdx = Math.floor(sorted.length / 2)
        const selected = sorted[midIdx]!
        return {
            studentId: selected.studentId,
            studentName: selected.studentName,
            reason: `对战调度：${selected.studentName} 正确率 ${(selected.accuracy * 100).toFixed(0)}%，适合作为 PK 基准选手`,
        }
    }

    /**
     * 分层：困难学生优先（正确率 <0.4），其次活跃学生，最后空闲学生
     * 同层内按调用次数升序
     */
    private selectTiered(candidates: ScheduleCandidate[]): { studentId: string; studentName: string; reason: string } {
        const struggling = candidates.filter((c) => c.status === 'struggling')
        const active = candidates.filter((c) => c.status === 'active')
        const idle = candidates.filter((c) => c.status === 'idle')

        let pool: ScheduleCandidate[]
        let layer: string
        if (struggling.length > 0) {
            pool = struggling
            layer = '困难层'
        } else if (idle.length > 0) {
            pool = idle
            layer = '空闲层'
        } else {
            pool = active
            layer = '活跃层'
        }

        // 同层内调用次数最少优先
        const sorted = [...pool].sort((a, b) => a.callCount - b.callCount)
        const selected = sorted[0]!
        return {
            studentId: selected.studentId,
            studentName: selected.studentName,
            reason: `分层调度：${selected.studentName} 属于${layer}，正确率 ${(selected.accuracy * 100).toFixed(0)}%，优先给予回答机会`,
        }
    }
}

/** 全局单例 */
export const classroomScheduler = new ClassroomScheduler()
