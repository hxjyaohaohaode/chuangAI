/**
 * WebSocket 路由处理器
 *
 * 在 /ws/orchestrator 路径上注册 WebSocket 端点，提供：
 * 1. 连接建立时推送 orch:session:start 事件
 * 2. 接收客户端 orch:subscribe 消息，动态调整订阅过滤器
 * 3. 接收客户端 orch:pause / orch:resume / orch:abort / orch:modify 控制消息
 * 4. 服务端持续推送事件（由 WSBroadcaster 广播）
 *
 * 客户端异常断开不会崩溃服务（broadcaster 已处理 error/close）。
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import type { WSBroadcaster } from './broadcaster.js'
import type { InterventionManager } from '../intervention.js'
import type { WSEvent, WSSubscriptionFilter } from '../types.js'
import { ORCH_EVENTS } from '../types.js'

// ─────────────────────────────────────────────────────────────
// 客户端控制消息类型
// ─────────────────────────────────────────────────────────────

interface ClientMessage {
    /** 消息类型 */
    type: 'orch:subscribe' | 'orch:pause' | 'orch:resume' | 'orch:abort' | 'orch:modify' | 'orch:feedback' | 'ping'
    /** 订阅过滤器（type=orch:subscribe 时使用） */
    filter?: WSSubscriptionFilter
    /** 会话 ID（控制消息必填） */
    sessionId?: string
    /** 任务 ID（控制消息必填） */
    taskId?: string
    /** 新输入（type=orch:modify 时使用） */
    newInput?: unknown
    /** 教师反馈（type=orch:feedback 时使用） */
    feedback?: {
        agentId: string
        feedbackType: 'good' | 'bad' | 'correction'
        content: string
    }
}

// ─────────────────────────────────────────────────────────────
// WebSocket 路由插件
// ─────────────────────────────────────────────────────────────

export interface OrchestratorWSPluginOptions {
    broadcaster: WSBroadcaster
    intervention: InterventionManager
}

/**
 * WebSocket 路由插件
 *
 * 注册 /ws/orchestrator 路径，处理客户端连接与控制消息。
 */
export const orchestratorWSPlugin: FastifyPluginAsync<OrchestratorWSPluginOptions> = async (
    app: FastifyInstance,
    opts: OrchestratorWSPluginOptions,
) => {
    const { broadcaster, intervention } = opts

    app.get('/orchestrator', { websocket: true }, (socket: WebSocket, _req) => {
        // 1. 注册连接（默认无过滤器，接收全部事件）
        broadcaster.registerConnection(socket, {})

        // 2. 发送 session:start 事件（客户端连接确认）
        const startEvent: WSEvent = {
            type: ORCH_EVENTS.SESSION_START,
            timestamp: Date.now(),
            sessionId: '',
            payload: {
                message: '已连接到诗脉·启明编排官观测台',
                serverTime: Date.now(),
            },
        }
        try {
            socket.send(JSON.stringify(startEvent))
        } catch {
            // 发送失败忽略，broadcaster 会清理
        }

        // 3. 监听客户端消息
        socket.on('message', (raw: Buffer | string) => {
            let msg: ClientMessage
            try {
                const text = typeof raw === 'string' ? raw : raw.toString('utf8')
                msg = JSON.parse(text) as ClientMessage
            } catch {
                sendError(socket, '消息格式错误，期望 JSON 字符串')
                return
            }

            handleClientMessage(socket, msg, broadcaster, intervention).catch((err) => {
                // 控制消息处理异常：发送错误反馈但不关闭连接
                const errMsg = err instanceof Error ? err.message : String(err)
                sendError(socket, `控制消息处理失败: ${errMsg}`)
            })
        })
    })
}

// ─────────────────────────────────────────────────────────────
// 客户端消息处理
// ─────────────────────────────────────────────────────────────

async function handleClientMessage(
    socket: WebSocket,
    msg: ClientMessage,
    broadcaster: WSBroadcaster,
    intervention: InterventionManager,
): Promise<void> {
    switch (msg.type) {
        case 'ping': {
            // 心跳响应
            sendEvent(socket, {
                type: 'pong',
                timestamp: Date.now(),
                sessionId: '',
                payload: { serverTime: Date.now() },
            })
            break
        }

        case 'orch:subscribe': {
            // 更新订阅过滤器
            broadcaster.updateFilter(socket, msg.filter ?? {})
            sendEvent(socket, {
                type: 'orch:subscribed',
                timestamp: Date.now(),
                sessionId: '',
                payload: { filter: msg.filter ?? {} },
            })
            break
        }

        case 'orch:pause': {
            if (!msg.sessionId || !msg.taskId) {
                sendError(socket, 'orch:pause 需要 sessionId 与 taskId')
                return
            }
            await intervention.pause(msg.sessionId, msg.taskId)
            break
        }

        case 'orch:resume': {
            if (!msg.sessionId || !msg.taskId) {
                sendError(socket, 'orch:resume 需要 sessionId 与 taskId')
                return
            }
            await intervention.resume(msg.sessionId, msg.taskId)
            break
        }

        case 'orch:abort': {
            if (!msg.sessionId) {
                sendError(socket, 'orch:abort 需要 sessionId')
                return
            }
            await intervention.abortSession(msg.sessionId)
            break
        }

        case 'orch:modify': {
            if (!msg.sessionId || !msg.taskId || msg.newInput === undefined) {
                sendError(socket, 'orch:modify 需要 sessionId、taskId 与 newInput')
                return
            }
            await intervention.modifyAndRerun(msg.sessionId, msg.taskId, msg.newInput)
            break
        }

        case 'orch:feedback': {
            if (!msg.sessionId || !msg.taskId || !msg.feedback) {
                sendError(socket, 'orch:feedback 需要 sessionId、taskId 与 feedback')
                return
            }
            intervention.recordFeedback({
                sessionId: msg.sessionId,
                taskId: msg.taskId,
                agentId: msg.feedback.agentId,
                feedbackType: msg.feedback.feedbackType,
                content: msg.feedback.content,
                timestamp: Date.now(),
            })
            break
        }

        default: {
            sendError(socket, `未知消息类型: ${(msg as { type?: string }).type ?? '(missing)'}`)
        }
    }
}

// ─────────────────────────────────────────────────────────────
// 辅助发送函数
// ─────────────────────────────────────────────────────────────

function sendEvent(socket: WebSocket, event: WSEvent): void {
    try {
        if (socket.readyState === 1 /* OPEN */) {
            socket.send(JSON.stringify(event))
        }
    } catch {
        // 忽略发送失败
    }
}

function sendError(socket: WebSocket, message: string): void {
    sendEvent(socket, {
        type: 'orch:error',
        timestamp: Date.now(),
        sessionId: '',
        payload: { error: message },
    })
}
