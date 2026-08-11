/**
 * 共舞舞台共享类型（v5.0 创新点：AI 诗教共舞舞台）
 *
 * 与后端 dance-stage.ts 类型定义对齐，确保前后端契约一致。
 */

export type DanceActor = 'teacher' | 'ai' | 'student'

export type TeacherEventType = 'assign' | 'guide' | 'feedback'
export type AIEventType = 'suggest' | 'supplement' | 'question'
export type StudentEventType = 'answer' | 'ask' | 'react'

export type DanceEventSubType = TeacherEventType | AIEventType | StudentEventType

export interface DanceEventPayload {
    id: string
    name: string
    actor: DanceActor
    subType: DanceEventSubType
    actorId: string
    actorLabel: string
    content: string
    questionId?: string
    targetStudentId?: string
    aiGenerated: boolean
    timestamp: number
}

export interface DanceSession {
    lessonId: string
    classId: string
    poemId: string
    teacherLabel: string
    startedAt: number
    endedAt?: number
    timeline: DanceEventPayload[]
    students: Record<string, string>
    currentDirective?: string
    aiStreamingBuffer?: string
}
