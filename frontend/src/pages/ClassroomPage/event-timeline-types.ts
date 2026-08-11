/**
 * 课堂事件时间轴类型定义（课堂指挥深化 Task 4）
 *
 * 定义课堂全程关键事件的结构，供 EventTimeline 组件消费。
 * 事件来源：
 * - WS 事件 classroom:mode-changed / classroom:response / classroom:ai-suggested
 * - 教师操作（下一题 / 推送提示 / 推送讨论题 / 干预）
 * - 分数变化（PK 模式积分 / 飞花令接花成功）
 *
 * 设计要点：
 * - 5 类事件覆盖课堂全程关键节点
 * - 每类事件有独立图标 + 强调色，便于视觉区分
 * - summary 为简短摘要（≤30 字），适合时间轴展示
 */

/** 课堂事件类型 */
export type ClassroomEventType =
    | 'mode-changed'
    | 'student-answer'
    | 'ai-suggested'
    | 'teacher-intervention'
    | 'score-change'

/** 课堂事件条目 */
export interface ClassroomEventItem {
    /** 事件唯一 ID */
    id: string
    /** 事件类型 */
    type: ClassroomEventType
    /** 事件摘要（≤30 字，时间轴展示用） */
    summary: string
    /** 事件时间戳（ms） */
    timestamp: number
    /** 关联题目 ID（可选） */
    questionId?: string
    /** 关联学生 ID（可选） */
    studentId?: string
    /** 关联学生姓名（可选） */
    studentName?: string
    /** 附加详情（可选，点击事件时展示） */
    detail?: string
}

/** 事件类型中文标签 */
export const CLASSROOM_EVENT_LABELS: Record<ClassroomEventType, string> = {
    'mode-changed': '模式切换',
    'student-answer': '学生答题',
    'ai-suggested': 'AI 建议',
    'teacher-intervention': '教师干预',
    'score-change': '分数变化',
}
