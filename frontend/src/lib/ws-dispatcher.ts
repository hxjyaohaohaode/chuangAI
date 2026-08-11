/**
 * 中央 WebSocket 调度器（v5.0 Task 3.1 —— 规范第 12 章实时数据同步）
 *
 * 设计目的：
 * - 替代 5 个页面各自调用 useWebSocket 创建独立连接的分散架构
 * - 收敛为单一 WebSocket 连接，多订阅者 fan-out 分发
 * - 与 business-events.ts 配合，打通 8 个 store 跨域通信
 *
 * 职责（复用 useWebSocket.ts 已验证逻辑）：
 * 1. 自动连接 /ws/orchestrator
 * 2. 心跳：每 30s 发送 ping，保持连接活跃
 * 3. 心跳超时检测：ping 发送后 10s 未收到 pong，主动断连重连
 * 4. 断线重连：指数退避（1s → 2s → 4s → ... → max 30s）
 * 5. 连接超时：连接建立超过 8s 未 open，超时重试
 * 6. 最大重连次数限制：10 次
 * 7. 页面可见性感知：隐藏时暂停心跳，可见时恢复
 * 8. 网络状态感知：监听 online/offline 事件
 * 9. 事件分发：每条消息 fan-out 至所有订阅者
 * 10. 状态分发：连接状态变化 fan-out 至所有状态订阅者
 *
 * 单例模式：
 * - `export const wsDispatcher = new WSDispatcher()` 全应用唯一实例
 * - AppRoot 顶层调用 connect()，卸载时 disconnect()
 * - 各页面/Store 通过 subscribe() 订阅事件，无需管理连接生命周期
 *
 * 性能（规范 15.2）：
 * - 整个应用仅 1 个 WebSocket 连接（替代原 5 个独立连接）
 * - 心跳定时器仅在 connected 状态运行
 * - 重连定时器在 disconnected/error 状态运行
 * - 页面隐藏时暂停心跳，节省资源
 * - 订阅者使用 Set 持有，fan-out 时间复杂度 O(n)
 */

import type { WSEvent, WSStatus } from '@/lib/types'
import { isDemoMode } from '@/lib/demo-mode'

/** WebSocket 事件订阅者 */
type WSEventHandler = (event: WSEvent) => void
/** WebSocket 状态订阅者 */
type WSStatusHandler = (status: WSStatus) => void

/**
 * 构建 WebSocket URL
 * 自动根据当前页面协议选择 ws/wss，并拼接 path
 */
function buildWSUrl(path: string): string {
    if (typeof window === 'undefined') return ''
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}${path}`
}

/**
 * 中央 WebSocket 调度器
 *
 * 单例类，全应用唯一实例 wsDispatcher
 */
class WSDispatcher {
    /** WebSocket 路径（与后端 /ws/orchestrator 对齐） */
    private readonly path: string = '/ws/orchestrator'
    /** 心跳间隔（ms） */
    private readonly heartbeatMs: number = 30000
    /** 重连最大间隔（ms） */
    private readonly maxReconnectMs: number = 30000
    /** 初始重连延迟（ms） */
    private readonly initialReconnectMs: number = 1000
    /** 心跳超时（ms）：ping 发送后未收到 pong 的超时 */
    private readonly heartbeatTimeoutMs: number = 10000
    /** 连接超时（ms）：连接建立未 open 的超时 */
    private readonly connectTimeoutMs: number = 8000
    /** 最大重连次数 */
    private readonly maxReconnectAttempts: number = 10

    /** 事件订阅者集合（fan-out 分发） */
    private eventHandlers: Set<WSEventHandler> = new Set()
    /** 状态订阅者集合（fan-out 分发） */
    private statusHandlers: Set<WSStatusHandler> = new Set()

    /** 连接生命周期引用 */
    private socket: WebSocket | null = null
    private heartbeatTimer: number | null = null
    private heartbeatTimeoutTimer: number | null = null
    private connectTimeoutTimer: number | null = null
    private reconnectTimer: number | null = null
    private reconnectAttempt: number = 0
    private manualClose: boolean = false
    /** 当前连接状态 */
    private currentStatus: WSStatus = 'idle'
    /** 是否已初始化（避免重复 connect） */
    private initialized: boolean = false
    /** 可见性与网络事件监听是否已绑定 */
    private listenersBound: boolean = false

    /**
     * 初始化连接（幂等，多次调用安全）
     *
     * 由 AppRoot 顶层调用，应用生命周期内仅建立一次连接
     */
    connect(): void {
        if (this.initialized) return
        this.initialized = true
        this.manualClose = false
        this.bindGlobalListeners()
        this.doConnect()
    }

    /**
     * 断开连接（应用卸载时调用）
     *
     * 清理所有定时器和事件监听，关闭连接
     */
    disconnect(): void {
        this.manualClose = true
        this.initialized = false
        this.clearAllTimers()
        this.unbindGlobalListeners()
        if (this.socket) {
            try {
                this.socket.onclose = null
                this.socket.onerror = null
                this.socket.onmessage = null
                this.socket.onopen = null
                this.socket.close()
            } catch {
                // 忽略
            }
            this.socket = null
        }
        this.notifyStatus('disconnected')
    }

    /**
     * 订阅 WebSocket 事件
     * @returns unsubscribe 函数，调用后不再收到事件
     */
    subscribe(handler: WSEventHandler): () => void {
        this.eventHandlers.add(handler)
        return () => {
            this.eventHandlers.delete(handler)
        }
    }

    /**
     * 订阅 WebSocket 状态变化
     * @returns unsubscribe 函数，调用后不再收到状态
     */
    subscribeStatus(handler: WSStatusHandler): () => void {
        this.statusHandlers.add(handler)
        // 立即通知当前状态（让新订阅者立即知道当前连接状态）
        handler(this.currentStatus)
        return () => {
            this.statusHandlers.delete(handler)
        }
    }

    /**
     * 获取当前连接状态
     */
    getStatus(): WSStatus {
        return this.currentStatus
    }

    /**
     * 发送消息（仅 connected 状态有效）
     * @returns 是否发送成功
     */
    send(data: unknown): boolean {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
        try {
            this.socket.send(typeof data === 'string' ? data : JSON.stringify(data))
            return true
        } catch {
            return false
        }
    }

    // ── 内部方法 ──

    /** 建立连接 */
    private doConnect(): void {
        if (this.manualClose || !this.initialized) return

        // 清理旧连接
        if (this.socket) {
            try {
                this.socket.onclose = null
                this.socket.onerror = null
                this.socket.onmessage = null
                this.socket.onopen = null
                this.socket.close()
            } catch {
                // 忽略
            }
            this.socket = null
        }

        const url = buildWSUrl(this.path)
        if (!url) return

        this.notifyStatus('connecting')

        let socket: WebSocket
        try {
            socket = new WebSocket(url)
        } catch {
            this.notifyStatus('error')
            this.scheduleReconnect()
            return
        }
        this.socket = socket

        // 连接超时检测
        this.clearConnectTimeout()
        this.connectTimeoutTimer = window.setTimeout(() => {
            if (this.socket && this.socket.readyState !== WebSocket.OPEN) {
                try {
                    this.socket.onclose = null
                    this.socket.onerror = null
                    this.socket.onmessage = null
                    this.socket.onopen = null
                    this.socket.close()
                } catch {
                    // 忽略
                }
                this.socket = null
                this.notifyStatus('error')
                this.scheduleReconnect()
            }
        }, this.connectTimeoutMs)

        socket.onopen = () => {
            this.clearConnectTimeout()
            this.reconnectAttempt = 0
            this.manualClose = false
            this.notifyStatus('connected')
            this.startHeartbeat()
        }

        socket.onmessage = (event: MessageEvent) => {
            let data: WSEvent
            try {
                data = JSON.parse(event.data as string) as WSEvent
            } catch {
                return
            }
            // pong 响应不外传，仅清除心跳超时定时器
            if (data.type === 'pong') {
                this.clearHeartbeatTimeout()
                return
            }
            // fan-out 至所有订阅者
            this.eventHandlers.forEach((handler) => {
                try {
                    handler(data)
                } catch (err) {
                    // 单个订阅者异常不影响其他订阅者
                    console.error('[wsDispatcher] 事件订阅者异常:', err)
                }
            })
        }

        socket.onerror = () => {
            this.notifyStatus('error')
            // 不立即重连，等 onclose 触发后由其调度
        }

        socket.onclose = () => {
            this.clearHeartbeat()
            this.clearHeartbeatTimeout()
            this.clearConnectTimeout()
            if (this.manualClose || !this.initialized) {
                this.notifyStatus('disconnected')
                return
            }
            this.notifyStatus('disconnected')
            this.scheduleReconnect()
        }
    }

    /** 启动心跳（ping + 超时检测） */
    private startHeartbeat(): void {
        this.clearHeartbeat()
        this.clearHeartbeatTimeout()
        this.heartbeatTimer = window.setInterval(() => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                try {
                    this.socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }))
                    // 启动心跳超时检测
                    this.clearHeartbeatTimeout()
                    this.heartbeatTimeoutTimer = window.setTimeout(() => {
                        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                            try {
                                this.socket.close()
                            } catch {
                                // 忽略
                            }
                        }
                    }, this.heartbeatTimeoutMs)
                } catch {
                    // 发送失败忽略，下次心跳会重试
                }
            }
        }, this.heartbeatMs)
    }

    /** 计算下一次重连延迟（指数退避） */
    private nextReconnectDelay(): number {
        const attempt = this.reconnectAttempt
        return Math.min(this.initialReconnectMs * Math.pow(2, attempt), this.maxReconnectMs)
    }

    /** 触发重连 */
    private scheduleReconnect(): void {
        if (this.manualClose || !this.initialized) return
        // v5.0 Task 5.8：DEMO 模式下停止重连，避免 270+ 个 500 错误雪崩
        // 后端不可达时，WS 重连只会徒增网络噪音；DEMO 模式退出后由 connect() 重新启动
        if (isDemoMode()) {
            this.notifyStatus('error')
            return
        }
        if (this.reconnectAttempt >= this.maxReconnectAttempts) {
            this.notifyStatus('error')
            return
        }
        this.clearReconnect()
        const delay = this.nextReconnectDelay()
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectAttempt += 1
            this.doConnect()
        }, delay)
    }

    /** 通知状态变化（fan-out 至所有状态订阅者） */
    private notifyStatus(status: WSStatus): void {
        this.currentStatus = status
        this.statusHandlers.forEach((handler) => {
            try {
                handler(status)
            } catch (err) {
                console.error('[wsDispatcher] 状态订阅者异常:', err)
            }
        })
    }

    /** 绑定全局事件监听（可见性 + 网络状态） */
    private bindGlobalListeners(): void {
        if (this.listenersBound) return
        this.listenersBound = true
        document.addEventListener('visibilitychange', this.handleVisibilityChange)
        window.addEventListener('online', this.handleOnline)
        window.addEventListener('offline', this.handleOffline)
    }

    /** 解绑全局事件监听 */
    private unbindGlobalListeners(): void {
        if (!this.listenersBound) return
        this.listenersBound = false
        document.removeEventListener('visibilitychange', this.handleVisibilityChange)
        window.removeEventListener('online', this.handleOnline)
        window.removeEventListener('offline', this.handleOffline)
    }

    /** 页面可见性变化处理 */
    private handleVisibilityChange = (): void => {
        if (document.hidden) {
            // 页面隐藏：暂停心跳，节省资源
            this.clearHeartbeat()
            this.clearHeartbeatTimeout()
        } else {
            // 页面可见：恢复心跳
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.startHeartbeat()
            }
        }
    }

    /** 网络恢复处理 */
    private handleOnline = (): void => {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            this.manualClose = false
            this.reconnectAttempt = 0
            this.clearReconnect()
            this.doConnect()
        }
    }

    /** 网络断开处理 */
    private handleOffline = (): void => {
        this.clearHeartbeat()
        this.clearHeartbeatTimeout()
        this.notifyStatus('error')
    }

    /** 清除心跳定时器 */
    private clearHeartbeat(): void {
        if (this.heartbeatTimer !== null) {
            window.clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = null
        }
    }

    /** 清除心跳超时定时器 */
    private clearHeartbeatTimeout(): void {
        if (this.heartbeatTimeoutTimer !== null) {
            window.clearTimeout(this.heartbeatTimeoutTimer)
            this.heartbeatTimeoutTimer = null
        }
    }

    /** 清除连接超时定时器 */
    private clearConnectTimeout(): void {
        if (this.connectTimeoutTimer !== null) {
            window.clearTimeout(this.connectTimeoutTimer)
            this.connectTimeoutTimer = null
        }
    }

    /** 清除重连定时器 */
    private clearReconnect(): void {
        if (this.reconnectTimer !== null) {
            window.clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
    }

    /** 清除所有定时器 */
    private clearAllTimers(): void {
        this.clearHeartbeat()
        this.clearHeartbeatTimeout()
        this.clearConnectTimeout()
        this.clearReconnect()
    }
}

/**
 * 全应用唯一的 WebSocket 调度器实例
 *
 * 使用方式：
 * - AppRoot 顶层：`useEffect(() => { wsDispatcher.connect(); return () => wsDispatcher.disconnect() }, [])`
 * - 页面/Store 订阅：
 *   ```ts
 *   useEffect(() => {
 *       const unsub = wsDispatcher.subscribe((event) => store.handleWSEvent(event))
 *       const unsubStatus = wsDispatcher.subscribeStatus((s) => store.setWsStatus(s))
 *       return () => { unsub(); unsubStatus() }
 *   }, [])
 *   ```
 */
export const wsDispatcher = new WSDispatcher()
