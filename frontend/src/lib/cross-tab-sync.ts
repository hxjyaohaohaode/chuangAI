/**
 * 跨 Tab 同步总线（规范第 12.2 节 —— 跨页面/Tab 同步 ≤ 200ms）
 *
 * 设计目的：
 * - 当用户在多个 Tab 打开本系统时，一个 Tab 的状态变更需在 ≤ 200ms 内同步到其他 Tab
 * - 弥补 businessEvents 仅能在单 Tab 内传播的局限
 * - 与 wsDispatcher 互补：
 *   - wsDispatcher：后端 → 前端（单 Tab）
 *   - businessEvents：前端 → 前端（单 Tab）
 *   - crossTabSync：Tab A → Tab B / Tab C ...（多 Tab）
 *
 * 同步场景：
 * 1. 通知中心：Tab A 收到通知 → 所有 Tab 通知中心同步显示
 * 2. 通知已读：Tab A 标记已读 → 所有 Tab 同步标记已读（避免重复提示）
 * 3. 通知清空：Tab A 清空 → 所有 Tab 同步清空
 * 4. 业务事件：Tab A 触发 grading:reviewed → Tab B 仪表盘同步刷新
 * 5. 鉴权状态：Tab A 登出 → 所有 Tab 同步登出
 *
 * 性能（规范 12.2）：
 * - BroadcastChannel 是浏览器原生 API，同源 Tab 间通信延迟 < 5ms
 * - 不经过网络，不占用 HTTP/WS 带宽
 * - 降级策略：不支持 BroadcastChannel 的环境（如旧版 Safari）使用 storage 事件
 *
 * 使用方式：
 * ```ts
 * import { crossTabSync } from '@/lib/cross-tab-sync'
 *
 * // 发射
 * crossTabSync.emit('notification:new', { id: 'xxx', title: '报告已生成' })
 *
 * // 订阅
 * crossTabSync.on('notification:new', (payload) => {
 *   useNotificationStore.getState().pushFromCrossTab(payload)
 * })
 * ```
 */

/** 跨 Tab 消息类型 */
export type CrossTabMessageType =
    | 'notification:new'
    | 'notification:read'
    | 'notification:read-all'
    | 'notification:clear'
    | 'notification:clear-read'
    | 'business:event'
    | 'auth:logout'
    | 'auth:login'

/** 跨 Tab 消息载荷映射 */
export interface CrossTabPayloadMap {
    'notification:new': {
        id: string
        type: 'info' | 'success' | 'warning' | 'error'
        title: string
        description?: string
        linkTo?: string
        createdAt: number
    }
    'notification:read': { id: string }
    'notification:read-all': Record<string, never>
    'notification:clear': Record<string, never>
    'notification:clear-read': Record<string, never>
    'business:event': {
        type: string
        payload: unknown
        timestamp: number
    }
    'auth:logout': { reason?: string }
    'auth:login': { userId: string; role: string }
}

/** 跨 Tab 消息信封 */
export interface CrossTabMessage<T extends CrossTabMessageType = CrossTabMessageType> {
    type: T
    payload: CrossTabPayloadMap[T]
    /** 消息来源 Tab ID（接收方忽略自己发出的消息） */
    originTabId: string
    /** 消息时间戳（用于乱序检测） */
    timestamp: number
}

/** 跨 Tab 消息订阅者 */
type CrossTabHandler<T extends CrossTabMessageType> = (
    payload: CrossTabPayloadMap[T],
    message: CrossTabMessage<T>,
) => void

/** 当前 Tab 唯一 ID（用于过滤自己发出的消息） */
const TAB_ID = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`

/** 降级用的 storage 事件 key 前缀 */
const STORAGE_FALLBACK_PREFIX = 'pr-crosstab-'

/**
 * 跨 Tab 同步总线
 *
 * 单例类，全应用唯一实例 crossTabSync
 * 优先使用 BroadcastChannel，不支持时降级为 storage 事件
 */
class CrossTabSyncBus {
    /** BroadcastChannel 实例（若可用） */
    private channel: BroadcastChannel | null = null
    /** 是否使用 storage 降级方案 */
    private useStorageFallback: boolean = false
    /** 按消息类型分组的订阅者 */
    private handlers: Map<CrossTabMessageType, Set<CrossTabHandler<CrossTabMessageType>>> = new Map()
    /** storage 事件监听是否已绑定 */
    private storageListenerBound = false
    /** 初始化状态 */
    private initialized = false

    /**
     * 初始化跨 Tab 同步
     * 在 AppRoot 顶层调用一次即可
     */
    init(): void {
        if (this.initialized) return
        this.initialized = true

        if (typeof BroadcastChannel !== 'undefined') {
            try {
                this.channel = new BroadcastChannel('poetic-realm-sync')
                this.channel.onmessage = (event: MessageEvent) => {
                    this.dispatch(event.data as CrossTabMessage)
                }
                this.channel.onmessageerror = () => {
                    // 消息格式错误：静默忽略
                }
            } catch {
                // 创建失败：降级到 storage
                this.useStorageFallback = true
                this.bindStorageListener()
            }
        } else {
            // 不支持 BroadcastChannel：降级到 storage
            this.useStorageFallback = true
            this.bindStorageListener()
        }
    }

    /**
     * 销毁跨 Tab 同步
     * 在 AppRoot 卸载时调用
     */
    destroy(): void {
        if (this.channel) {
            try {
                this.channel.onmessage = null
                this.channel.onmessageerror = null
                this.channel.close()
            } catch {
                // 忽略
            }
            this.channel = null
        }
        this.unbindStorageListener()
        this.handlers.clear()
        this.initialized = false
    }

    /**
     * 订阅指定类型的跨 Tab 消息
     * @param type 消息类型
     * @param handler 处理函数
     * @returns unsubscribe 函数
     */
    on<T extends CrossTabMessageType>(
        type: T,
        handler: CrossTabHandler<T>,
    ): () => void {
        const set = this.handlers.get(type) ?? new Set()
        set.add(handler as CrossTabHandler<CrossTabMessageType>)
        this.handlers.set(type, set)
        return () => {
            set.delete(handler as CrossTabHandler<CrossTabMessageType>)
            if (set.size === 0) {
                this.handlers.delete(type)
            }
        }
    }

    /**
     * 发射跨 Tab 消息
     * @param type 消息类型
     * @param payload 消息载荷
     */
    emit<T extends CrossTabMessageType>(
        type: T,
        payload: CrossTabPayloadMap[T],
    ): void {
        const message: CrossTabMessage<T> = {
            type,
            payload,
            originTabId: TAB_ID,
            timestamp: Date.now(),
        }

        if (this.channel) {
            try {
                this.channel.postMessage(message)
            } catch {
                // 发送失败：静默降级，本 Tab 仍正常工作
            }
        } else if (this.useStorageFallback) {
            // 降级方案：写入 localStorage 触发其他 Tab 的 storage 事件
            try {
                const key = `${STORAGE_FALLBACK_PREFIX}${type}`
                window.localStorage.setItem(key, JSON.stringify(message))
                // 立即清除（不持久化，仅用于触发事件）
                // 注意：不能立即清除，否则部分浏览器不会触发事件
                // 使用 setTimeout(0) 异步清除
                window.setTimeout(() => {
                    try {
                        window.localStorage.removeItem(key)
                    } catch {
                        // 忽略
                    }
                }, 0)
            } catch {
                // localStorage 不可用：静默降级
            }
        }
    }

    /**
     * 获取当前 Tab ID
     */
    get tabId(): string {
        return TAB_ID
    }

    /**
     * 是否使用降级方案
     */
    get isFallbackMode(): boolean {
        return this.useStorageFallback
    }

    // ── 内部方法 ──

    /**
     * 分发消息到订阅者
     * 忽略自己发出的消息（originTabId === TAB_ID）
     */
    private dispatch(message: CrossTabMessage): void {
        if (!message || message.originTabId === TAB_ID) return

        const set = this.handlers.get(message.type)
        if (!set || set.size === 0) return

        set.forEach((handler) => {
            try {
                handler(message.payload, message)
            } catch (err) {
                // 单个订阅者异常不影响其他订阅者
                console.error(`[crossTabSync] ${message.type} 订阅者异常:`, err)
            }
        })
    }

    /**
     * 绑定 storage 事件监听（降级方案）
     */
    private bindStorageListener(): void {
        if (this.storageListenerBound) return
        this.storageListenerBound = true
        window.addEventListener('storage', this.handleStorageEvent)
    }

    /**
     * 解绑 storage 事件监听
     */
    private unbindStorageListener(): void {
        if (!this.storageListenerBound) return
        this.storageListenerBound = false
        window.removeEventListener('storage', this.handleStorageEvent)
    }

    /**
     * storage 事件处理（降级方案）
     */
    private handleStorageEvent = (event: StorageEvent): void => {
        if (!event.key || !event.key.startsWith(STORAGE_FALLBACK_PREFIX)) return
        if (!event.newValue) return

        const type = event.key.slice(STORAGE_FALLBACK_PREFIX.length) as CrossTabMessageType
        let message: CrossTabMessage
        try {
            message = JSON.parse(event.newValue) as CrossTabMessage
        } catch {
            return
        }
        if (message.type !== type) return

        this.dispatch(message)
    }
}

/**
 * 全应用唯一的跨 Tab 同步总线实例
 */
export const crossTabSync = new CrossTabSyncBus()
