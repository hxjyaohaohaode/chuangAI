/**
 * 会话存储
 *
 * 会话状态管理。全局实例使用 SQLite 检查点，测试/独立实例默认使用内存 Map。
 * 实现 LRU 淘汰策略以保护内存：
 * - 最大会话数：1000（超出时淘汰最久未访问的会话）
 * - 单会话事件历史上限：10000（超出时丢弃最早事件）
 *
 * Map 在 JS 中保持插入顺序，配合 delete + set 即可实现 LRU：
 * 每次访问时 delete 后重新 set，使该 key 移动到末尾；
 * 淘汰时取第一个 key 删除即可。
 */

import { randomUUID } from 'node:crypto'
import { SqliteMap } from '../db/runtime-store.js'
import type {
    ParsedInstruction,
    Reflection,
    SessionState,
    SessionStatus,
    SubTask,
    WSEvent,
} from './types.js'

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 最大会话数（LRU 淘汰阈值） */
const MAX_SESSIONS = 1000

/** 单会话事件历史上限 */
const MAX_EVENTS_PER_SESSION = 10000

// ─────────────────────────────────────────────────────────────
// SessionStore
// ─────────────────────────────────────────────────────────────

export class SessionStore {
    /** LRU 存储：Map 保持插入顺序，访问时 delete + set 触发 LRU 更新 */
    private readonly sessions: Map<string, SessionState>

    constructor(options: {
        durable?: boolean
        tableName?: string
        storage?: Map<string, SessionState>
        recoverInterrupted?: boolean
    } = {}) {
        this.sessions = options.storage ?? (options.durable
            ? new SqliteMap<string, SessionState>({
                table: options.tableName ?? 'orchestrator_session_checkpoints',
                maxSize: MAX_SESSIONS,
                indexes: [
                    { name: 'teacher_id', extract: (session) => session.teacherId },
                    { name: 'session_status', extract: (session) => session.status },
                ],
                serialize: serializeSession,
                deserialize: deserializeSession,
            })
            : new Map<string, SessionState>())

        if (options.durable || options.recoverInterrupted) this.recoverInterruptedSessions()
    }

    /**
     * 创建新会话
     *
     * @returns 新建的 SessionState（status: 'idle'）
     */
    createSession(teacherId: string, classId?: string): SessionState {
        const session: SessionState = {
            id: randomUUID(),
            teacherId,
            classId,
            startedAt: Date.now(),
            status: 'idle',
            taskStates: new Map<string, SubTask>(),
            events: [],
        }

        this.sessions.set(session.id, session)
        this.evictIfNeeded()
        return session
    }

    /**
     * 获取会话（访问会触发 LRU 更新）
     */
    getSession(id: string): SessionState | undefined {
        const session = this.sessions.get(id)
        if (!session) return undefined

        // LRU 更新：delete + set 使其移到末尾
        this.sessions.delete(id)
        this.sessions.set(id, session)
        return session
    }

    /**
     * 更新会话状态
     *
     * 若提供 status 则更新；若提供 currentPlan 则更新；
     * 其他字段通过 update 部分合并。
     */
    updateSession(
        id: string,
        update: Partial<Pick<SessionState, 'status' | 'currentPlan' | 'endedAt' | 'executionResult' | 'reflections'>>,
    ): SessionState | undefined {
        const session = this.sessions.get(id)
        if (!session) return undefined

        if (update.status !== undefined) session.status = update.status
        if (update.currentPlan !== undefined) session.currentPlan = update.currentPlan
        if (update.endedAt !== undefined) session.endedAt = update.endedAt
        if (update.executionResult !== undefined) session.executionResult = update.executionResult
        if (update.reflections !== undefined) session.reflections = update.reflections

        // LRU 更新
        this.sessions.delete(id)
        this.sessions.set(id, session)
        return session
    }

    /**
     * 设置会话状态（便捷方法）
     */
    setStatus(id: string, status: SessionStatus): void {
        this.updateSession(id, { status })
    }

    /**
     * 更新会话中的任务状态
     */
    updateTaskState(sessionId: string, task: SubTask): void {
        const session = this.sessions.get(sessionId)
        if (!session) return
        session.taskStates.set(task.id, task)
        this.sessions.set(sessionId, session)
    }

    /**
     * 追加事件到会话历史
     *
     * 超过上限时丢弃最早事件（保持最近 10000 条）。
     */
    appendEvent(sessionId: string, event: WSEvent): void {
        const session = this.sessions.get(sessionId)
        if (!session) return
        session.events.push(event)
        if (session.events.length > MAX_EVENTS_PER_SESSION) {
            // 丢弃最早的事件（数组头部）
            session.events.splice(0, session.events.length - MAX_EVENTS_PER_SESSION)
        }
        this.sessions.set(sessionId, session)
    }

    /**
     * 追加反思到会话
     */
    appendReflection(sessionId: string, reflection: Reflection): void {
        const session = this.sessions.get(sessionId)
        if (!session) return
        if (!session.reflections) session.reflections = []
        session.reflections.push(reflection)
        this.sessions.set(sessionId, session)
    }

    /**
     * 设置当前计划
     */
    setPlan(sessionId: string, plan: ParsedInstruction): void {
        const session = this.sessions.get(sessionId)
        if (!session) return
        session.currentPlan = plan
        // 同步初始化任务状态
        session.taskStates.clear()
        for (const sub of plan.subTasks) {
            session.taskStates.set(sub.id, { ...sub })
        }
        this.sessions.set(sessionId, session)
    }

    /**
     * 列出会话（按 teacherId 过滤，按 startedAt 倒序）
     */
    listSessions(filter?: { teacherId?: string }): SessionState[] {
        const result: SessionState[] = []
        for (const session of this.sessions.values()) {
            if (filter?.teacherId !== undefined && session.teacherId !== filter.teacherId) continue
            result.push(session)
        }
        result.sort((a, b) => b.startedAt - a.startedAt)
        return result
    }

    /**
     * 删除会话
     */
    deleteSession(id: string): boolean {
        return this.sessions.delete(id)
    }

    /**
     * 当前会话总数
     */
    get size(): number {
        return this.sessions.size
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    /**
     * LRU 淘汰：若超过最大容量，删除最早（最久未访问）的会话
     */
    private evictIfNeeded(): void {
        while (this.sessions.size > MAX_SESSIONS) {
            const firstKey = this.sessions.keys().next().value
            if (firstKey === undefined) break
            this.sessions.delete(firstKey)
        }
    }

    /**
     * 进程退出时无法安全恢复正在执行的 Promise/AbortController。启动时把这类
     * 检查点标为 aborted，并保留计划与输入，等待教师显式确认重新执行。
     * 这比把旧状态冒充“仍在执行”或静默自动重放有副作用的任务更安全。
     */
    private recoverInterruptedSessions(): void {
        for (const [id, session] of this.sessions.entries()) {
            if (session.status !== 'executing' && session.status !== 'paused') continue
            session.status = 'aborted'
            session.endedAt = Date.now()
            for (const [taskId, task] of session.taskStates.entries()) {
                if (task.status !== 'running' && task.status !== 'paused') continue
                session.taskStates.set(taskId, {
                    ...task,
                    status: 'failed',
                    error: '服务进程曾中断；为避免重复副作用，需由教师确认后重新执行计划',
                    endedAt: Date.now(),
                })
            }
            this.sessions.set(id, session)
        }
    }
}

interface SerializedSessionState extends Omit<SessionState, 'taskStates' | 'executionResult'> {
    taskStates: Array<[string, SubTask]>
    executionResult?: Omit<NonNullable<SessionState['executionResult']>, 'results'> & {
        results: Array<[string, unknown]>
    }
}

function serializeSession(session: SessionState): string {
    const executionResult = session.executionResult
        ? { ...session.executionResult, results: Array.from(session.executionResult.results.entries()) }
        : undefined
    const payload: SerializedSessionState = {
        ...session,
        taskStates: Array.from(session.taskStates.entries()),
        executionResult,
    }
    // condition 是运行时函数，不可跨进程序列化；其描述性边仍保留在 DAG 中。
    return JSON.stringify(payload)
}

function deserializeSession(raw: string): SessionState {
    const parsed = JSON.parse(raw) as SerializedSessionState
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.teacherId !== 'string' ||
        !Array.isArray(parsed.taskStates) || !Array.isArray(parsed.events)) {
        throw new TypeError('Invalid orchestrator session checkpoint')
    }
    const executionResult = parsed.executionResult
        ? { ...parsed.executionResult, results: new Map(parsed.executionResult.results) }
        : undefined
    return {
        ...parsed,
        taskStates: new Map(parsed.taskStates),
        executionResult,
    }
}

/** 仅供检查点契约测试复核；业务代码应始终通过 SessionStore 读写。 */
export const sessionCheckpointCodec = {
    serialize: serializeSession,
    deserialize: deserializeSession,
} as const

// ─────────────────────────────────────────────────────────────
// 全局单例
// ─────────────────────────────────────────────────────────────

/**
 * 会话存储全局单例
 *
 * 供 REST 路由、WebSocket 处理器与编排官共享。
 * 通过 initOrchestrator() 注入到各组件。
 */
export const sessionStore = new SessionStore({ durable: process.env.NODE_ENV !== 'test' })
