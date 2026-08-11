/**
 * AI 诗教共舞舞台 —— 三方实时协作事件总线
 *
 * 课堂中教师 / AI / 学生三方实时协作的"共舞舞台"：
 * - 教师事件：teacher:assign / teacher:guide / teacher:feedback
 * - AI 事件：ai:suggest / ai:supplement / ai:question
 * - 学生事件：student:answer / student:ask / student:react
 *
 * 设计要点：
 * 1. 每个共舞会话（DanceSession）绑定一个 lessonId，独立维护时间轴
 * 2. 事件流以有序数组持久化，供回放与时间轴可视化
 * 3. 通过 WSBroadcaster 实时广播，前端订阅 dance:* 事件类型
 * 4. 内存存储 + LRU 上限，会话结束后保留 30 分钟供回看
 * 5. 严格 TypeScript，零 any，适配 noUncheckedIndexedAccess
 */

import type { WSBroadcaster } from './websocket/broadcaster.js'
import type { WSEvent } from './types.js'

// ─────────────────────────────────────────────────────────────
// 事件类型定义
// ─────────────────────────────────────────────────────────────

/** 事件发起方（三方共舞的三条泳道） */
export type DanceActor = 'teacher' | 'ai' | 'student'

/** 教师事件子类型 */
export type TeacherEventType = 'assign' | 'guide' | 'feedback'

/** AI 事件子类型 */
export type AIEventType = 'suggest' | 'supplement' | 'question'

/** 学生事件子类型 */
export type StudentEventType = 'answer' | 'ask' | 'react'

/** 全部事件子类型 */
export type DanceEventSubType = TeacherEventType | AIEventType | StudentEventType

/** 事件类型全名（actor:subType） */
export type DanceEventName =
    | `teacher:${TeacherEventType}`
    | `ai:${AIEventType}`
    | `student:${StudentEventType}`

/** 共舞事件载荷 */
export interface DanceEventPayload {
    /** 事件唯一 ID */
    id: string
    /** 事件全名（如 teacher:assign） */
    name: DanceEventName
    /** 发起方 */
    actor: DanceActor
    /** 子类型 */
    subType: DanceEventSubType
    /** 发起者标识（教师 ID / 'ai' / 学生 ID） */
    actorId: string
    /** 发起者显示名 */
    actorLabel: string
    /** 事件文本内容（指令 / 建议 / 回答 / 反应） */
    content: string
    /** 关联题目 ID（可选） */
    questionId?: string
    /** 关联学生 ID（可选，如教师反馈指向某学生） */
    targetStudentId?: string
    /** 是否 AI 生成内容 */
    aiGenerated: boolean
    /** 事件时间戳（ms） */
    timestamp: number
}

/** 共舞会话状态 */
export interface DanceSession {
    /** 会话 ID（与 lessonId 一致） */
    lessonId: string
    /** 关联班级 ID */
    classId: string
    /** 关联诗篇 ID */
    poemId: string
    /** 教师显示名 */
    teacherLabel: string
    /** 会话开始时间戳 */
    startedAt: number
    /** 会话结束时间戳 */
    endedAt?: number
    /** 事件时间轴（按时间顺序追加） */
    timeline: DanceEventPayload[]
    /** 当前活跃学生（studentId -> 显示名） */
    students: Map<string, string>
    /** 当前教师指令（最近的 teacher:assign 内容） */
    currentDirective?: string
    /** 当前 AI 流式输出累积（用于前端光标跟随） */
    aiStreamingBuffer?: string
}

// ─────────────────────────────────────────────────────────────
// WebSocket 事件常量
// ─────────────────────────────────────────────────────────────

/** 共舞事件 WebSocket 广播类型前缀 */
export const DANCE_EVENTS = {
    /** 会话启动 */
    SESSION_START: 'dance:session:start',
    /** 会话结束 */
    SESSION_END: 'dance:session:end',
    /** 事件流入（教师/AI/学生事件统一信封） */
    EVENT: 'dance:event',
    /** AI 流式分片 */
    AI_STREAM_DELTA: 'dance:ai:stream-delta',
    /** AI 流式完成 */
    AI_STREAM_DONE: 'dance:ai:stream-done',
} as const

export type DanceWSEventName = (typeof DANCE_EVENTS)[keyof typeof DANCE_EVENTS]

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 会话保留时长（ms），结束后 30 分钟清理 */
const SESSION_RETENTION_MS = 30 * 60 * 1000

/** 单会话事件上限（超出 LRU 淘汰最早事件） */
const MAX_EVENTS_PER_SESSION = 2000

/** 并发会话上限 */
const MAX_CONCURRENT_SESSIONS = 50

/** 事件 ID 自增计数器 */
let eventIdCounter = 0

/** 生成事件唯一 ID */
function nextEventId(): string {
    eventIdCounter += 1
    return `dance-evt-${Date.now()}-${eventIdCounter}`
}

// ─────────────────────────────────────────────────────────────
// DanceStage 核心类
// ─────────────────────────────────────────────────────────────

/** 可供传输层稳定分类的共舞舞台业务错误；HTTP 层不得依赖 message 文本判断。 */
export type DanceStageErrorCode = 'STAGE_CLOSED' | 'SESSION_LIMIT_REACHED'

export class DanceStageError extends Error {
    readonly name = 'DanceStageError'

    constructor(
        readonly code: DanceStageErrorCode,
        message: string,
    ) {
        super(message)
    }
}

/**
 * 共舞舞台事件总线
 *
 * 管理课堂共舞会话的全生命周期与事件流，通过 WSBroadcaster 实时广播。
 * 单例模式，由 server.ts 注入到 classroom 路由。
 */
export class DanceStage {
    /** 活跃会话集合：lessonId -> DanceSession */
    private readonly sessions = new Map<string, DanceSession>()
    /** 清理定时器集合：lessonId -> timer */
    private readonly cleanupTimers = new Map<string, NodeJS.Timeout>()
    /** WebSocket 广播器 */
    private readonly broadcaster: WSBroadcaster
    /** 日志器（容错，可能为 null） */
    private readonly log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void } | null
    /** 服务关闭后禁止旧路由引用继续写入，并允许单例在热重载时重建。 */
    private closed = false

    constructor(
        broadcaster: WSBroadcaster,
        log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void } | null,
    ) {
        this.broadcaster = broadcaster
        this.log = log ?? null
    }

    /**
     * 启动共舞会话
     *
     * @returns 新建的 DanceSession
     * @throws 并发会话超限时抛出错误
     */
    startSession(params: {
        lessonId: string
        classId: string
        poemId: string
        teacherLabel: string
    }): DanceSession {
        if (this.closed) {
            throw new DanceStageError('STAGE_CLOSED', 'DanceStage 已关闭，请重新初始化后再创建课堂')
        }
        const { lessonId, classId, poemId, teacherLabel } = params

        // 已存在则直接返回（幂等）
        const existing = this.sessions.get(lessonId)
        if (existing && !existing.endedAt) {
            return existing
        }

        // 并发会话上限保护
        if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
            this.log?.warn(
                { total: this.sessions.size, max: MAX_CONCURRENT_SESSIONS },
                '[DanceStage] 并发会话数超限，拒绝新建',
            )
            throw new DanceStageError(
                'SESSION_LIMIT_REACHED',
                `并发共舞会话已达上限 (${MAX_CONCURRENT_SESSIONS})`,
            )
        }

        const now = Date.now()
        const session: DanceSession = {
            lessonId,
            classId,
            poemId,
            teacherLabel,
            startedAt: now,
            timeline: [],
            students: new Map(),
        }

        this.sessions.set(lessonId, session)

        // 广播会话启动事件
        this.broadcast(lessonId, DANCE_EVENTS.SESSION_START, {
            lessonId,
            classId,
            poemId,
            teacherLabel,
            startedAt: now,
        })

        this.log?.info({ lessonId }, '[DanceStage] 共舞会话已启动')
        return session
    }

    /**
     * 结束共舞会话
     */
    endSession(lessonId: string): DanceSession | undefined {
        const session = this.sessions.get(lessonId)
        if (!session) return undefined

        if (session.endedAt) {
            // 已结束，幂等返回
            return session
        }

        session.endedAt = Date.now()

        // 广播会话结束事件
        this.broadcast(lessonId, DANCE_EVENTS.SESSION_END, {
            lessonId,
            endedAt: session.endedAt,
            eventCount: session.timeline.length,
        })

        this.log?.info({ lessonId, eventCount: session.timeline.length }, '[DanceStage] 共舞会话已结束')

        // 延迟清理（保留 30 分钟供回看）
        const timer = setTimeout(() => {
            this.sessions.delete(lessonId)
            this.cleanupTimers.delete(lessonId)
        }, SESSION_RETENTION_MS)
        // unref：不阻止进程退出
        if (typeof timer.unref === 'function') timer.unref()
        this.cleanupTimers.set(lessonId, timer)

        return session
    }

    /**
     * 获取会话
     */
    getSession(lessonId: string): DanceSession | undefined {
        if (this.closed) return undefined
        return this.sessions.get(lessonId)
    }

    /**
     * 获取会话时间轴（回放用）
     *
     * @param fromIdx 起始索引（含），默认 0
     * @param limit 返回上限，默认全部
     */
    getTimeline(lessonId: string, fromIdx = 0, limit?: number): DanceEventPayload[] {
        if (this.closed) return []
        const session = this.sessions.get(lessonId)
        if (!session) return []
        const slice = session.timeline.slice(fromIdx, limit !== undefined ? fromIdx + limit : undefined)
        return slice
    }

    /**
     * 提交一个共舞事件
     *
     * 写入时间轴并实时广播 dance:event。
     * 教师事件触发 currentDirective 更新；学生事件触发 students 注册。
     *
     * @returns 写入的事件载荷（含生成的 id 与 timestamp）
     */
    submitEvent(lessonId: string, input: Omit<DanceEventPayload, 'id' | 'timestamp'>): DanceEventPayload | undefined {
        if (this.closed) return undefined
        const session = this.sessions.get(lessonId)
        if (!session) return undefined
        if (session.endedAt) return undefined

        const event: DanceEventPayload = {
            ...input,
            id: nextEventId(),
            timestamp: Date.now(),
        }

        // LRU 上限保护
        if (session.timeline.length >= MAX_EVENTS_PER_SESSION) {
            session.timeline.splice(0, session.timeline.length - MAX_EVENTS_PER_SESSION + 1)
        }

        session.timeline.push(event)

        // 教师分配任务 → 更新当前指令
        if (event.name === 'teacher:assign') {
            session.currentDirective = event.content
        }

        // 学生事件 → 注册学生
        if (event.actor === 'student' && !session.students.has(event.actorId)) {
            session.students.set(event.actorId, event.actorLabel)
        }

        // 广播事件
        this.broadcast(lessonId, DANCE_EVENTS.EVENT, event)

        return event
    }

    /**
     * 推送 AI 流式分片（供前端光标跟随）
     *
     * 不写入时间轴（时间轴只保留最终完整事件），仅广播增量。
     */
    pushAIStreamDelta(lessonId: string, delta: string): void {
        if (this.closed) return
        const session = this.sessions.get(lessonId)
        if (!session || session.endedAt) return

        session.aiStreamingBuffer = (session.aiStreamingBuffer ?? '') + delta
        this.broadcast(lessonId, DANCE_EVENTS.AI_STREAM_DELTA, {
            lessonId,
            delta,
            bufferLength: session.aiStreamingBuffer.length,
        })
    }

    /**
     * AI 流式完成
     *
     * 清空流式缓冲，时间轴写入完整 ai:* 事件。
     */
    pushAIStreamDone(lessonId: string, finalContent: string, subType: AIEventType, actorLabel = 'AI 共舞者'): void {
        if (this.closed) return
        const session = this.sessions.get(lessonId)
        if (!session || session.endedAt) return

        session.aiStreamingBuffer = undefined

        // 写入完整 AI 事件到时间轴
        this.submitEvent(lessonId, {
            name: `ai:${subType}` as DanceEventName,
            actor: 'ai',
            subType,
            actorId: 'ai',
            actorLabel,
            content: finalContent,
            aiGenerated: true,
        })

        this.broadcast(lessonId, DANCE_EVENTS.AI_STREAM_DONE, {
            lessonId,
            contentLength: finalContent.length,
        })
    }

    /**
     * 关闭所有会话（服务关闭时调用）
     */
    closeAll(): void {
        if (this.closed) return
        this.closed = true
        for (const timer of this.cleanupTimers.values()) {
            clearTimeout(timer)
        }
        this.cleanupTimers.clear()
        this.sessions.clear()
    }

    /** 供单例初始化判断旧实例是否已绑定到已关闭的 Fastify/WS 生命周期。 */
    get isClosed(): boolean {
        return this.closed
    }

    /**
     * 当前活跃会话数
     */
    get sessionCount(): number {
        return this.sessions.size
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    /**
     * 广播共舞事件
     *
     * 复用 WSBroadcaster，事件 sessionId 设为 lessonId，
     * 前端可通过订阅 dance:* 事件类型过滤。
     */
    private broadcast(lessonId: string, type: string, payload: unknown): void {
        const event: WSEvent = {
            type,
            timestamp: Date.now(),
            sessionId: lessonId,
            payload,
        }
        this.broadcaster.broadcast(event)
    }
}

// ─────────────────────────────────────────────────────────────
// 单例（由 server.ts 注入 broadcaster 后导出）
// ─────────────────────────────────────────────────────────────

let danceStageInstance: DanceStage | null = null

/**
 * 初始化全局 DanceStage 单例
 *
 * 幂等：若已初始化则直接返回已有实例（避免路由插件重复注册时创建多实例）。
 * 由 server.ts 或路由插件在启动时调用，注入 WSBroadcaster。
 */
export function initDanceStage(broadcaster: WSBroadcaster, log?: unknown): DanceStage {
    if (danceStageInstance && !danceStageInstance.isClosed) {
        return danceStageInstance
    }
    danceStageInstance = new DanceStage(
        broadcaster,
        log as { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void } | null | undefined,
    )
    return danceStageInstance
}

/**
 * 获取全局 DanceStage 单例
 *
 * 未初始化时抛出明确错误（fail-fast），避免静默空指针。
 */
export function getDanceStage(): DanceStage {
    if (!danceStageInstance) {
        throw new Error('DanceStage 未初始化，请先调用 initDanceStage(broadcaster)')
    }
    return danceStageInstance
}
