/**
 * 业务事件总线（v5.0 Task 4.4 —— 规范第 12 章实时数据同步）
 *
 * 设计目的：
 * - 打通 8 个 store 之间的跨域通信，弥补 WebSocket 仅能处理后端推送事件的局限
 * - 纯前端事件总线，不依赖网络，触发即同步（≤ 1ms）
 * - 与 wsDispatcher 互补：
 *   - wsDispatcher：后端 → 前端的事件分发（orch:* / agent:* 等）
 *   - businessEvents：前端 → 前端的跨 store 通信（业务状态变更）
 *
 * 7 类业务事件（v5.0 计划）：
 * 1. diagnosis:updated      —— 诊断数据更新（学生完成诊断 / 教师批改完成）
 * 2. recitation:completed   —— 朗读完成（学生提交朗读评估）
 * 3. self-study:progress    —— 自学进度更新（学生完成闯关 / 朗读 / 诊断）
 * 4. workbench:question-ready —— 题目就绪（教师在工坊生成题目）
 * 5. grading:reviewed       —— 批改完成（教师完成主观题批改）
 * 6. report:generated       —— 报告生成（课堂报告 / 学生画像报告生成）
 * 7. classroom:ended        —— 课堂结束（教师结束课堂，触发报告生成）
 *
 * 使用方式：
 * - 发射：`businessEvents.emit('self-study:progress', { classId, studentId, poemId, stage: 'quest' })`
 * - 订阅：`businessEvents.on('self-study:progress', (event) => { ... })`
 *
 * 性能：
 * - 订阅者使用 Set 持有，fan-out 时间复杂度 O(n)
 * - 单订阅者异常不影响其他订阅者（try/catch 隔离）
 * - 无防抖/节流，调用方需自行控制发射频率
 */

/** 业务事件类型 */
export type BusinessEventType =
    | 'diagnosis:updated'
    | 'recitation:completed'
    | 'self-study:progress'
    | 'workbench:question-ready'
    | 'grading:reviewed'
    | 'report:generated'
    | 'classroom:ended'
    | 'creation:submitted'
    | 'creation:graded'
    | 'creation:feedback'
    | 'prompt:evolved'
    | 'ab-test:won'
    | 'lesson-plan:generated'
    | 'lesson-plan:saved'
    | 'error-notebook:review-completed'
    // 智能备课 5 大能力事件（深化版教案生成/精修）
    | 'lesson:generated'
    | 'lesson:refined'
    // 课堂指挥深化：模式切换 / AI 协同建议 / 复盘报告
    | 'classroom:mode-changed'
    | 'classroom:ai-suggested'
    | 'classroom:report-generated'
    // 画像报告模块 5 大能力事件
    | 'profile:refreshed'
    | 'hotspot:detected'
    | 'alert:triggered'
    | 'report:exported'
    | 'home-school:weekly-generated'
    // 批改诊断深化能力事件（多维度评分 / 手写识别 / 处方 / 学习路径生成）
    | 'grading:scored'
    | 'grading:ocr-completed'
    | 'diagnosis:prescribed'
    | 'diagnosis:learning-path-generated'

/** 业务事件载荷（按事件类型分发） */
export interface BusinessEventPayloadMap {
    'diagnosis:updated': {
        classId?: string
        studentId?: string
        scope: 'class' | 'student'
    }
    'recitation:completed': {
        classId: string
        studentId: string
        poemId: string
        overallScore: number
    }
    'self-study:progress': {
        classId: string
        studentId: string
        poemId: string
        /** 当前完成的阶段：diagnose / quest / recite / completed */
        stage: 'diagnose' | 'quest' | 'recite' | 'completed'
        /** 闯关正确数（仅 stage=quest 时有效） */
        correctCount?: number
        /** 闯关总数（仅 stage=quest 时有效） */
        totalCount?: number
        /** 朗读综合得分（仅 stage=completed 时有效） */
        overallScore?: number
    }
    'workbench:question-ready': {
        poemId: string
        /** 生成的题目 ID 列表 */
        questionIds: string[]
        /** 题目总数 */
        count: number
    }
    'grading:reviewed': {
        classId?: string
        studentId?: string
        poemId?: string
        /** 批改的题目数 */
        reviewCount: number
    }
    'report:generated': {
        lessonId?: string
        classId?: string
        /** 学生 ID（仅 reportType=student-profile 时必填，用于定向刷新该学生画像） */
        studentId?: string
        /** 报告类型 */
        reportType: 'classroom' | 'student-profile' | 'class-diagnosis'
    }
    'classroom:ended': {
        lessonId: string
        classId?: string
        /** 课堂时长（秒） */
        durationSec?: number
    }
    'creation:submitted': {
        classId?: string
        studentId: string
        poemId?: string
        /** 作品 ID */
        workId: string
        /** 创作任务类型 */
        taskType?: 'illustration' | 'rewrite' | 'video-script' | 'appreciation'
    }
    'creation:graded': {
        /** 作品 ID */
        workId: string
        studentId: string
        poemId?: string
        taskType?: 'illustration' | 'rewrite' | 'video-script' | 'appreciation'
        /** 批改分数 0-100 */
        score: number
        /** 评级 */
        level: string
    }
    'creation:feedback': {
        /** 作品 ID */
        workId: string
        studentId: string
        poemId?: string
        taskType?: 'illustration' | 'rewrite' | 'video-script' | 'appreciation'
        /** 应用的反馈文本 */
        feedbackApplied: string
    }
    'prompt:evolved': {
        /** Agent ID */
        agentId: string
        /** 新版本号 */
        version: string
        /** 触发模式摘要 */
        triggerPattern: string
        /** 进化时间戳 */
        evolvedAt: number
    }
    'ab-test:won': {
        /** Agent ID */
        agentId: string
        /** 胜出版本号 */
        winningVersion: string
        /** 候选版本成功率 */
        candidateSuccessRate: number
        /** 活跃版本成功率 */
        activeSuccessRate: number
        /** 自动激活时间戳 */
        activatedAt: number
    }
    'lesson-plan:generated': {
        /** 教案 ID */
        lessonPlanId: string
        /** 关联诗篇 ID */
        poemId: string
        /** 关联班级 ID（可选） */
        classId?: string
        /** 教师姓名 */
        teacherName?: string
        /** 生成依据：班级共性薄弱 Bloom 层级 */
        weakBloomLevels?: string[]
        /** 数据驱动标记：是否基于班级诊断数据生成 */
        dataDriven: boolean
    }
    'lesson-plan:saved': {
        /** 教案 ID */
        lessonPlanId: string
        /** 关联诗篇 ID */
        poemId: string
        /** 教案状态 */
        status: 'draft' | 'published' | 'archived'
        /** 保存时间戳 */
        savedAt: number
    }
    'error-notebook:review-completed': {
        /** 学生 ID */
        studentId: string
        /** 错题条目 ID */
        itemId: string
        /** 关联诗篇 ID */
        poemId: string
        /** Bloom 认知层级 */
        bloomLevel: string
        /** 复习质量评分（0-5） */
        quality: number
        /** 复习后是否新掌握 */
        newlyMastered: boolean
        /** 复习时间戳 */
        reviewedAt: number
    }
    /** 智能备课深化版教案生成完成（区别于 lesson-plan:generated，适用于未保存的 AI 生成教案） */
    'lesson:generated': {
        /** 关联诗篇 ID */
        poemId: string
        /** 诗篇标题 */
        poemTitle: string
        /** 课时数 */
        lessonCount: 1 | 2 | 3
        /** 总时长（分钟） */
        totalDurationMin: number
        /** 是否 AI 生成 */
        aiGenerated: boolean
        /** 生成时间戳 */
        generatedAt: number
    }
    /** 智能备课深化版教案选段精修完成 */
    'lesson:refined': {
        /** 教案 ID */
        lessonId: string
        /** 精修目标段落 */
        targetSection: {
            type: 'phase' | 'board' | 'homework' | 'goals' | 'keyPoints' | 'difficultPoints'
            phaseIndex?: number
            field?: 'teacherScript' | 'studentScript' | 'presetQuestions' | 'aiSynergyPoints' | 'designIntent' | 'layerTips'
        }
        /** 变更摘要 */
        changeSummary: string
    }
    /** 课堂模式切换（多模式无缝切换） */
    'classroom:mode-changed': {
        /** 课堂 ID */
        lessonId: string
        /** 切换前模式 */
        fromMode: string
        /** 切换后模式 */
        toMode: string
        /** 切换时间戳 */
        changedAt: number
    }
    /** AI 协同教学建议生成（反馈/补充/追问/干预） */
    'classroom:ai-suggested': {
        /** 课堂 ID */
        lessonId: string
        /** 建议类别：feedback 反馈 / supplement 补充 / followup 追问 / intervention 干预 */
        category: 'feedback' | 'supplement' | 'followup' | 'intervention'
        /** 建议摘要（前 80 字） */
        summary: string
        /** 关联题目 ID（可选） */
        questionId?: string
        /** 关联学生 ID（可选） */
        studentId?: string
        /** 生成时间戳 */
        suggestedAt: number
    }
    /** 课堂复盘报告生成 */
    'classroom:report-generated': {
        /** 课堂 ID */
        lessonId: string
        /** 班级 ID */
        classId?: string
        /** 参与人数 */
        participation: number
        /** 报告生成时间戳 */
        generatedAt: number
    }
    /** 学生立体画像刷新 */
    'profile:refreshed': {
        /** 学生 ID */
        studentId: string
        /** 班级 ID */
        classId: string
        /** 是否 AI 生成 */
        aiGenerated: boolean
        /** 刷新时间戳 */
        refreshedAt: number
    }
    /** 班级热点检测完成 */
    'hotspot:detected': {
        /** 班级 ID */
        classId: string
        /** 检测到的热点数 */
        hotspotCount: number
        /** 是否 AI 生成 */
        aiGenerated: boolean
        /** 检测时间戳 */
        detectedAt: number
    }
    /** 趋势预警触发 */
    'alert:triggered': {
        /** 预警 ID */
        alertId: string
        /** 班级 ID */
        classId: string
        /** 学生 ID（可选） */
        studentId?: string
        /** 预警严重程度 */
        severity: 'info' | 'warning' | 'critical'
        /** 触发时间戳 */
        triggeredAt: number
    }
    /** 报告导出完成 */
    'report:exported': {
        /** 报告 ID */
        reportId: string
        /** 导出格式 */
        format: 'pdf' | 'image' | 'excel' | 'markdown' | 'word'
        /** 是否成功 */
        success: boolean
        /** 导出时间戳 */
        exportedAt: number
    }
    /** 家校周报生成 */
    'home-school:weekly-generated': {
        /** 周报 ID */
        reportId: string
        /** 学生 ID */
        studentId: string
        /** 周键（如 "2026-W28"） */
        weekKey: string
        /** 是否 AI 生成 */
        aiGenerated: boolean
        /** 生成时间戳 */
        generatedAt: number
    }
    /** 多维度评分完成（批改诊断深化能力 1/5） */
    'grading:scored': {
        /** 文件 ID */
        fileId: string
        /** 题目 ID */
        questionId: string
        /** 加权总分 */
        weightedTotal: number
    }
    /** 手写识别完成（批改诊断深化能力 2/5） */
    'grading:ocr-completed': {
        /** 文件 ID */
        fileId: string
        /** 整体置信度（0-1） */
        confidence: number
        /** 可疑字数量 */
        suspiciousCount: number
    }
    /** 个性化处方生成完成（批改诊断深化能力 5/5） */
    'diagnosis:prescribed': {
        /** 学生 ID */
        studentId: string
        /** 生成时间戳 */
        generatedAt: number
    }
    /** AI 学习路径生成完成（批改诊断深化能力 4/5） */
    'diagnosis:learning-path-generated': {
        /** 学生 ID */
        studentId: string
        /** 生成时间戳 */
        generatedAt: number
    }
}

/** 通用业务事件结构 */
export interface BusinessEvent<T extends BusinessEventType = BusinessEventType> {
    type: T
    payload: BusinessEventPayloadMap[T]
    timestamp: number
}

/** 业务事件订阅者 */
type BusinessEventHandler<T extends BusinessEventType = BusinessEventType> = (
    event: BusinessEvent<T>,
) => void

/**
 * 业务事件总线
 *
 * 单例类，全应用唯一实例 businessEvents
 * 各 store 在模块加载时订阅，在关键业务节点发射事件
 */
class BusinessEventBus {
    /** 按事件类型分组的订阅者集合 */
    private handlers: Map<BusinessEventType, Set<BusinessEventHandler>> = new Map()

    /**
     * 订阅指定类型的业务事件
     * @param type 事件类型
     * @param handler 处理函数
     * @returns unsubscribe 函数，调用后不再收到事件
     */
    on<T extends BusinessEventType>(
        type: T,
        handler: BusinessEventHandler<T>,
    ): () => void {
        if (!this.handlers.has(type)) {
            this.handlers.set(type, new Set())
        }
        const set = this.handlers.get(type)!
        // 类型擦除：Set<BusinessEventHandler> 与 Set<BusinessEventHandler<T>> 互转
        set.add(handler as BusinessEventHandler)
        return () => {
            set.delete(handler as BusinessEventHandler)
        }
    }

    /**
     * 发射业务事件
     * @param type 事件类型
     * @param payload 事件载荷
     */
    emit<T extends BusinessEventType>(
        type: T,
        payload: BusinessEventPayloadMap[T],
    ): void {
        const event: BusinessEvent<T> = {
            type,
            payload,
            timestamp: Date.now(),
        }
        const set = this.handlers.get(type)
        if (!set || set.size === 0) return
        set.forEach((handler) => {
            try {
                (handler as BusinessEventHandler<T>)(event)
            } catch (err) {
                // 单个订阅者异常不影响其他订阅者
                console.error(`[businessEvents] ${type} 订阅者异常:`, err)
            }
        })
    }

    /**
     * 清除指定类型的所有订阅者（仅用于测试）
     */
    clear(type?: BusinessEventType): void {
        if (type) {
            this.handlers.delete(type)
        } else {
            this.handlers.clear()
        }
    }
}

/**
 * 全应用唯一的业务事件总线实例
 *
 * 使用方式：
 * ```ts
 * import { businessEvents } from '@/lib/business-events'
 *
 * // 发射
 * businessEvents.emit('self-study:progress', { classId, studentId, poemId, stage: 'quest' })
 *
 * // 订阅（在 store 模块加载时）
 * businessEvents.on('self-study:progress', (event) => {
 *   void useDashboardStore.getState().refreshAlerts()
 * })
 * ```
 */
export const businessEvents = new BusinessEventBus()
