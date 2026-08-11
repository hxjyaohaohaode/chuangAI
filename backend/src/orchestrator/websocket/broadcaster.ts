/**
 * WebSocket 事件广播器
 *
 * 管理前端观测台的 WebSocket 连接，按订阅过滤器分发事件。
 *
 * 设计要点：
 * 1. 每个连接携带 WSSubscriptionFilter（sessionId / agentIds / eventTypes）
 * 2. broadcast 时按过滤器决定是否推送，避免无关事件淹没客户端
 * 3. 客户端异常断开自动清理，不影响其他连接
 * 4. 连接关闭后从内部集合移除，防止内存泄漏
 * 5. 发送失败不抛出，仅记录日志（避免一个客户端拖垮全局）
 * 6. B6.2 增强：最大连接数限制 + 空闲连接超时清理 + 连接唯一 ID
 */

import type { FastifyInstance } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import type { WSEvent, WSSubscriptionFilter } from '../types.js'

// ─────────────────────────────────────────────────────────────
// 连接条目
// ─────────────────────────────────────────────────────────────

interface ConnectionEntry {
    socket: WebSocket
    filter: WSSubscriptionFilter
    /** 注册时间戳，用于诊断 */
    registeredAt: number
    /** 最后活动时间戳（B6.2：用于空闲检测） */
    lastActivityAt: number
    /** 连接唯一 ID（B6.2：用于日志追踪） */
    connectionId: string
}

// ─────────────────────────────────────────────────────────────
// WSBroadcaster
// ─────────────────────────────────────────────────────────────

/** 最大连接数（B6.2：防止连接耗尽） */
const MAX_CONNECTIONS = 200

/** 空闲连接超时（ms）：超过此时间无任何消息收发的连接将被清理（B6.2） */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟

/** 空闲检测扫描间隔（ms）（B6.2） */
const IDLE_SCAN_INTERVAL_MS = 60 * 1000 // 1 分钟

/** 连接 ID 自增计数器（B6.2） */
let connectionIdCounter = 0

export class WSBroadcaster {
    /** 活跃连接集合（socket -> entry） */
    private readonly connections = new Set<ConnectionEntry>()
    /** 当前 fastify 实例（用于日志） */
    private readonly fastify: FastifyInstance
    /** 空闲连接扫描定时器（B6.2） */
    private idleScanTimer: NodeJS.Timeout | null = null

    constructor(fastify: FastifyInstance) {
        this.fastify = fastify
        // B6.2: 启动空闲连接定期扫描
        this.idleScanTimer = setInterval(() => this.cleanupIdleConnections(), IDLE_SCAN_INTERVAL_MS)
        // unref：不阻止进程退出
        if (this.idleScanTimer && typeof this.idleScanTimer.unref === 'function') {
            this.idleScanTimer.unref()
        }
    }

    /**
     * 注册一个 WebSocket 连接
     *
     * @param socket 客户端 socket
     * @param filter 订阅过滤器（可选）
     */
    registerConnection(socket: WebSocket, filter: WSSubscriptionFilter = {}): void {
        // B6.2: 最大连接数限制
        if (this.connections.size >= MAX_CONNECTIONS) {
            this.fastify.log.warn(
                { total: this.connections.size, max: MAX_CONNECTIONS },
                '[WSBroadcaster] 连接数已达上限，拒绝新连接',
            )
            try {
                socket.close(1013, 'Maximum connections reached')
            } catch {
                // 忽略
            }
            return
        }

        const now = Date.now()
        connectionIdCounter += 1
        const entry: ConnectionEntry = {
            socket,
            filter,
            registeredAt: now,
            lastActivityAt: now,
            connectionId: `ws_${connectionIdCounter}`,
        }
        this.connections.add(entry)

        // 监听关闭事件，自动清理
        socket.on('close', () => {
            this.connections.delete(entry)
        })

        // 监听错误事件，避免未处理异常
        socket.on('error', (err: Error) => {
            this.fastify.log.debug(
                { err, connectionId: entry.connectionId },
                '[WSBroadcaster] 客户端 socket 异常',
            )
            this.connections.delete(entry)
            try {
                socket.close()
            } catch {
                // 忽略关闭时的二次异常
            }
        })

        // B6.2: 监听消息事件，更新最后活动时间
        socket.on('message', () => {
            entry.lastActivityAt = Date.now()
        })

        this.fastify.log.debug(
            { filter, total: this.connections.size, connectionId: entry.connectionId },
            '[WSBroadcaster] 新连接注册',
        )
    }

    /**
     * 更新连接的订阅过滤器
     *
     * 客户端可通过 orch:subscribe 消息动态调整订阅。
     */
    updateFilter(socket: WebSocket, filter: WSSubscriptionFilter): void {
        for (const entry of this.connections) {
            if (entry.socket === socket) {
                entry.filter = filter
                entry.lastActivityAt = Date.now()
                return
            }
        }
    }

    /**
     * 广播事件给所有匹配的订阅者
     *
     * 匹配规则：
     * - sessionId: 事件 sessionId 为空（全局事件）则匹配；否则要求过滤器为空或相等
     * - agentIds:  事件 payload.agentId 存在时，要求过滤器为空或包含该 agentId
     * - eventTypes: 事件 type 必须在过滤器列表中（过滤器为空则全部通过）
     *
     * 发送失败的连接会被清理。
     */
    broadcast(event: WSEvent): void {
        for (const entry of this.connections) {
            if (!this.matchFilter(event, entry.filter)) continue

            try {
                // socket.readyState 1 = OPEN
                if (entry.socket.readyState !== 1 /* OPEN */) {
                    this.connections.delete(entry)
                    continue
                }
                entry.socket.send(JSON.stringify(event))
                entry.lastActivityAt = Date.now()
            } catch (err) {
                this.fastify.log.debug(
                    { err, eventType: event.type, connectionId: entry.connectionId },
                    '[WSBroadcaster] 发送失败，清理连接',
                )
                this.connections.delete(entry)
                try {
                    entry.socket.close()
                } catch {
                    // 忽略
                }
            }
        }
    }

    /**
     * 广播共舞事件（便捷方法）
     *
     * 为 DanceStage 提供类型安全的广播入口，将 DanceEventPayload 封装为
     * 统一的 WSEvent（type 为 'dance:event'，sessionId 为 lessonId）后广播。
     *
     * 与 broadcast() 的区别：自动构造事件信封，调用方无需手写 WSEvent 结构。
     *
     * @param lessonId 课堂 ID（作为 sessionId）
     * @param type 事件类型（如 'dance:event' / 'dance:session:start'）
     * @param payload 事件载荷
     */
    broadcastDanceEvent(lessonId: string, type: string, payload: unknown): void {
        const event: WSEvent = {
            type,
            timestamp: Date.now(),
            sessionId: lessonId,
            payload,
        }
        this.broadcast(event)
    }

    /**
     * 当前活跃连接数
     */
    get connectionCount(): number {
        return this.connections.size
    }

    /**
     * 关闭所有连接（用于服务关闭）
     */
    closeAll(): void {
        // B6.2: 停止空闲扫描定时器
        if (this.idleScanTimer) {
            clearInterval(this.idleScanTimer)
            this.idleScanTimer = null
        }
        for (const entry of this.connections) {
            try {
                entry.socket.close()
            } catch {
                // 忽略
            }
        }
        this.connections.clear()
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    /**
     * 清理空闲连接（B6.2）
     *
     * 超过 IDLE_TIMEOUT_MS 无任何消息收发的连接将被主动关闭。
     * 防止僵尸连接长期占用资源。
     */
    private cleanupIdleConnections(): void {
        const now = Date.now()
        const toRemove: ConnectionEntry[] = []

        for (const entry of this.connections) {
            const idleMs = now - entry.lastActivityAt
            if (idleMs > IDLE_TIMEOUT_MS) {
                toRemove.push(entry)
            }
        }

        if (toRemove.length === 0) return

        for (const entry of toRemove) {
            this.fastify.log.info(
                {
                    connectionId: entry.connectionId,
                    idleMs: now - entry.lastActivityAt,
                    registeredAt: entry.registeredAt,
                },
                '[WSBroadcaster] 清理空闲连接',
            )
            this.connections.delete(entry)
            try {
                entry.socket.close(1000, 'Idle timeout')
            } catch {
                // 忽略
            }
        }
    }

    /**
     * 判断事件是否匹配订阅过滤器
     */
    private matchFilter(event: WSEvent, filter: WSSubscriptionFilter): boolean {
        // eventTypes 过滤
        if (filter.eventTypes !== undefined && filter.eventTypes.length > 0) {
            if (!filter.eventTypes.includes(event.type)) return false
        }

        // sessionId 过滤：全局事件（sessionId 为空）总是通过
        if (filter.sessionId !== undefined && event.sessionId !== '') {
            if (event.sessionId !== filter.sessionId) return false
        }

        // agentIds 过滤：检查 payload.agentId
        if (filter.agentIds !== undefined && filter.agentIds.length > 0) {
            const payload = event.payload as { agentId?: unknown } | null
            if (
                payload !== null &&
                typeof payload === 'object' &&
                'agentId' in payload &&
                typeof payload.agentId === 'string'
            ) {
                if (!filter.agentIds.includes(payload.agentId)) return false
            }
        }

        return true
    }
}
