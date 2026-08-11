import { create } from 'zustand'
import { crossTabSync } from '@/lib/cross-tab-sync'

/**
 * 通知中心 Store（规范 8.4 状态保持策略 + 规范 12.2 跨 Tab 同步）
 *
 * 设计要点：
 *  - 通知来源：系统内部事件（课堂开始/结束、报告生成完成、批改完成等）
 *  - 持久化至 localStorage，刷新后保留未读通知
 *  - 上限 50 条，超出自动淘汰最早的（FIFO）
 *  - 未读数 badge 由 hasUnread 派生
 *  - 跨 Tab 同步：一个 Tab 收到通知/标记已读/清空，所有 Tab 同步（≤ 200ms）
 *
 * 用法：
 *   import { useNotificationStore } from '@/stores/notifications'
 *   useNotificationStore.getState().push({ type: 'success', title: '报告已生成' })
 */

export type NotificationType = 'info' | 'success' | 'warning' | 'error'

export interface AppNotification {
    id: string
    type: NotificationType
    title: string
    description?: string
    /** 关联路由，点击通知可跳转 */
    linkTo?: string
    createdAt: number
    read: boolean
}

interface NotificationState {
    notifications: AppNotification[]
    /** 推入一条通知（自动生成 id + createdAt + read=false），并跨 Tab 同步 */
    push: (n: Omit<AppNotification, 'id' | 'createdAt' | 'read'>) => void
    /** 跨 Tab 接收通知（不再次发射，避免循环） */
    pushFromCrossTab: (n: AppNotification) => void
    /** 标记单条已读，并跨 Tab 同步 */
    markRead: (id: string) => void
    /** 全部标记已读，并跨 Tab 同步 */
    markAllRead: () => void
    /** 清空所有通知，并跨 Tab 同步 */
    clearAll: () => void
    /** 清除已读通知，并跨 Tab 同步 */
    clearRead: () => void
}

const STORAGE_KEY = 'pr-notifications'
const MAX_NOTIFICATIONS = 50

function readInitial(): AppNotification[] {
    if (typeof window === 'undefined') return []
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw) as AppNotification[]
        if (!Array.isArray(parsed)) return []
        // 兼容旧数据：确保每条都有 read 字段
        return parsed.slice(0, MAX_NOTIFICATIONS).map((n) => ({
            ...n,
            read: n.read ?? false,
        }))
    } catch {
        return []
    }
}

function persist(notifications: AppNotification[]): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications))
    } catch {
        /* localStorage 不可用时静默降级 */
    }
}

function genId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID()
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
    notifications: readInitial(),

    push: (n) => {
        const notification: AppNotification = {
            ...n,
            id: genId(),
            createdAt: Date.now(),
            read: false,
        }
        const next = [notification, ...get().notifications].slice(0, MAX_NOTIFICATIONS)
        persist(next)
        set({ notifications: next })
        // 跨 Tab 同步
        crossTabSync.emit('notification:new', notification)
    },

    pushFromCrossTab: (n) => {
        // 跨 Tab 接收：避免重复，按 id 去重
        const exists = get().notifications.some((item) => item.id === n.id)
        if (exists) return
        const next = [n, ...get().notifications].slice(0, MAX_NOTIFICATIONS)
        persist(next)
        set({ notifications: next })
    },

    markRead: (id) => {
        const next = get().notifications.map((n) => (n.id === id ? { ...n, read: true } : n))
        persist(next)
        set({ notifications: next })
        // 跨 Tab 同步
        crossTabSync.emit('notification:read', { id })
    },

    markAllRead: () => {
        const next = get().notifications.map((n) => ({ ...n, read: true }))
        persist(next)
        set({ notifications: next })
        // 跨 Tab 同步
        crossTabSync.emit('notification:read-all', {})
    },

    clearAll: () => {
        persist([])
        set({ notifications: [] })
        // 跨 Tab 同步
        crossTabSync.emit('notification:clear', {})
    },

    clearRead: () => {
        const next = get().notifications.filter((n) => !n.read)
        persist(next)
        set({ notifications: next })
        // 跨 Tab 同步
        crossTabSync.emit('notification:clear-read', {})
    },
}))

// ─────────────────────────────────────────────────────────────
// 跨 Tab 同步订阅：在模块加载时绑定，接收其他 Tab 的通知变更
// ─────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
    // 通知新增
    crossTabSync.on('notification:new', (payload) => {
        useNotificationStore.getState().pushFromCrossTab({ ...payload, read: false })
    })

    // 通知标记已读
    crossTabSync.on('notification:read', (payload) => {
        const store = useNotificationStore.getState()
        const next = store.notifications.map((n) =>
            n.id === payload.id ? { ...n, read: true } : n,
        )
        persist(next)
        useNotificationStore.setState({ notifications: next })
    })

    // 全部标记已读
    crossTabSync.on('notification:read-all', () => {
        const store = useNotificationStore.getState()
        const next = store.notifications.map((n) => ({ ...n, read: true }))
        persist(next)
        useNotificationStore.setState({ notifications: next })
    })

    // 清空所有
    crossTabSync.on('notification:clear', () => {
        persist([])
        useNotificationStore.setState({ notifications: [] })
    })

    // 清除已读
    crossTabSync.on('notification:clear-read', () => {
        const store = useNotificationStore.getState()
        const next = store.notifications.filter((n) => !n.read)
        persist(next)
        useNotificationStore.setState({ notifications: next })
    })
}

/** 派生选择器：未读数量 */
export function useUnreadCount(): number {
    return useNotificationStore((s) => s.notifications.filter((n) => !n.read).length)
}
