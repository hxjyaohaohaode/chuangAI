/**
 * 教师介入管理器
 *
 * 封装教师中途介入编排官执行的完整流程：
 * - pause(sessionId, taskId)         暂停某任务（运行中的 Agent 收到 AbortSignal）
 * - resume(sessionId, taskId)        恢复某任务（重新调度）
 * - abortSession(sessionId)          中止整个 session
 * - modifyAndRerun(sessionId, ...)   修正任务输入后重跑
 * - recordFeedback(feedback)         教师反馈写入（Task 22 自我进化引擎预留）
 *
 * 介入管理器是 REST/WS 控制消息与 Orchestrator 底层方法之间的中间层：
 * 1. 校验 sessionId 与 taskId 合法性（查询 SessionStore）
 * 2. 同步 SessionStore 中的任务状态
 * 3. 调用 Orchestrator 的底层 pause/resume/abort/modify
 * 4. 通过 broadcaster 推送介入事件
 *
 * 对 resume 与 modifyAndRerun，会触发后台重新执行（不阻塞 HTTP 请求）。
 */

import type { Orchestrator } from './Orchestrator.js'
import type { WSBroadcaster } from './websocket/broadcaster.js'
import type { SessionStore } from './session-store.js'
import type { TeacherFeedback, WSEvent } from './types.js'
import { ORCH_EVENTS } from './types.js'

// ─────────────────────────────────────────────────────────────
// InterventionManager
// ─────────────────────────────────────────────────────────────

export class InterventionManager {
    constructor(
        private readonly orchestrator: Orchestrator,
        private readonly sessionStore: SessionStore,
        private readonly broadcaster: WSBroadcaster,
    ) {}

    /**
     * 暂停某任务
     *
     * 1. 校验 session 与 task 存在
     * 2. 更新 SessionStore 任务状态为 paused
     * 3. 调用 orchestrator.pause 触发 AbortSignal
     * 4. 广播 orch:task:paused 事件
     */
    async pause(sessionId: string, taskId: string): Promise<void> {
        const session = this.sessionStore.getSession(sessionId)
        if (!session) {
            throw new Error(`会话不存在: ${sessionId}`)
        }
        const task = session.taskStates.get(taskId)
        if (!task) {
            throw new Error(`任务不存在: ${taskId}`)
        }
        if (task.status !== 'running') {
            throw new Error(`任务 ${taskId} 当前状态 ${task.status}，仅 running 可暂停`)
        }

        // 调用底层暂停
        this.orchestrator.pause(taskId)

        // 更新 SessionStore（executeNode 完成后会通过 onTaskUpdate 同步，
        // 但这里也主动更新以减少延迟）
        this.sessionStore.updateTaskState(sessionId, { ...task, status: 'paused' })

        this.broadcastIntervention(ORCH_EVENTS.TASK_PAUSED, sessionId, {
            taskId,
            agentId: task.agentId,
            reason: 'teacher-pause',
        })
    }

    /**
     * 恢复某任务
     *
     * 1. 校验 session 与 task 存在且为 paused
     * 2. 调用 orchestrator.resume 重置为 pending
     * 3. 广播 orch:task:resumed 事件
     * 4. 后台触发重新执行（不阻塞）
     */
    async resume(sessionId: string, taskId: string): Promise<void> {
        const session = this.sessionStore.getSession(sessionId)
        if (!session) {
            throw new Error(`会话不存在: ${sessionId}`)
        }
        const task = session.taskStates.get(taskId)
        if (!task) {
            throw new Error(`任务不存在: ${taskId}`)
        }
        if (task.status !== 'paused') {
            throw new Error(`任务 ${taskId} 当前状态 ${task.status}，仅 paused 可恢复`)
        }

        // 调用底层恢复
        this.orchestrator.resume(taskId)

        this.broadcastIntervention(ORCH_EVENTS.TASK_RESUMED, sessionId, {
            taskId,
            agentId: task.agentId,
        })

        // 后台触发重新执行（execute 会复用已有的调度器状态）
        if (session.currentPlan) {
            void this.orchestrator.execute(session.currentPlan, {
                sessionId,
                teacherId: session.teacherId,
                classId: session.classId,
            }).catch((err) => {
                // 后台执行错误仅记录，不抛出（已通过事件推送）
                this.broadcastIntervention(ORCH_EVENTS.TASK_FAILED, sessionId, {
                    taskId,
                    error: `恢复执行失败: ${err instanceof Error ? err.message : String(err)}`,
                })
            })
        }
    }

    /**
     * 中止整个 session
     *
     * 1. 调用 orchestrator.abortSession
     * 2. 更新 SessionStore 状态为 aborted
     * 3. 广播 orch:session:end 事件
     */
    async abortSession(sessionId: string): Promise<void> {
        const session = this.sessionStore.getSession(sessionId)
        if (!session) {
            throw new Error(`会话不存在: ${sessionId}`)
        }

        this.orchestrator.abortSession(sessionId)
        this.sessionStore.setStatus(sessionId, 'aborted')
        this.sessionStore.updateSession(sessionId, { endedAt: Date.now() })

        this.broadcaster.broadcast({
            type: ORCH_EVENTS.SESSION_END,
            timestamp: Date.now(),
            sessionId,
            payload: { reason: 'teacher-abort' },
        })
    }

    /**
     * 修正任务输入后重跑
     *
     * 1. 校验 session 与 task 存在
     * 2. 调用 orchestrator.modify（中止当前 + 修改输入 + 重置 pending）
     * 3. 广播 orch:task:resumed 事件
     * 4. 后台触发重新执行
     */
    async modifyAndRerun(sessionId: string, taskId: string, newInput: unknown): Promise<void> {
        const session = this.sessionStore.getSession(sessionId)
        if (!session) {
            throw new Error(`会话不存在: ${sessionId}`)
        }
        const task = session.taskStates.get(taskId)
        if (!task) {
            throw new Error(`任务不存在: ${taskId}`)
        }
        if (task.status === 'success') {
            throw new Error(`任务 ${taskId} 已成功完成，无需修改`)
        }

        // 调用底层修改（会中止当前运行 + 重置状态）
        this.orchestrator.modify(taskId, newInput)

        // 更新 SessionStore
        this.sessionStore.updateTaskState(sessionId, {
            ...task,
            input: newInput,
            status: 'pending',
            result: undefined,
            error: undefined,
            startedAt: undefined,
            endedAt: undefined,
        })

        this.broadcastIntervention(ORCH_EVENTS.TASK_RESUMED, sessionId, {
            taskId,
            agentId: task.agentId,
            reason: 'teacher-modify',
        })

        // 后台触发重新执行
        if (session.currentPlan) {
            void this.orchestrator.execute(session.currentPlan, {
                sessionId,
                teacherId: session.teacherId,
                classId: session.classId,
            }).catch((err) => {
                this.broadcastIntervention(ORCH_EVENTS.TASK_FAILED, sessionId, {
                    taskId,
                    error: `修改后重跑失败: ${err instanceof Error ? err.message : String(err)}`,
                })
            })
        }
    }

    /**
     * 教师反馈写入
     *
     * 当前仅广播 orch:teacher:feedback 事件，
     * Task 22 自我进化引擎实现后会接入 Prompt 版本更新流程。
     */
    recordFeedback(feedback: TeacherFeedback): void {
        const event: WSEvent = {
            type: ORCH_EVENTS.TEACHER_FEEDBACK,
            timestamp: Date.now(),
            sessionId: feedback.sessionId,
            payload: feedback,
        }
        this.broadcaster.broadcast(event)
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    private broadcastIntervention(
        type: string,
        sessionId: string,
        payload: Record<string, unknown>,
    ): void {
        this.broadcaster.broadcast({
            type,
            timestamp: Date.now(),
            sessionId,
            payload,
        })
    }
}
