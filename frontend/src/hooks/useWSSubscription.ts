/**
 * WS 订阅 Hook（v5.0 Task 3.4）
 *
 * 职责：
 * - 订阅全局 wsDispatcher 单例的 WSEvent / WSStatus 流
 * - 组件卸载时自动取消订阅，避免泄漏
 * - 不再建立独立 WebSocket 连接（连接生命周期由 App.tsx 统一管理）
 *
 * 与 useWebSocket 的区别：
 * - useWebSocket（旧）：每个组件创建独立 WS 连接，5 个页面 = 5 条连接，浪费资源
 * - useWSSubscription（新）：所有组件共享 1 条 wsDispatcher 连接，仅订阅事件流
 *
 * 用法：
 *   useWSSubscription({
 *       onEvent: handleWSEvent,
 *       onStatusChange: setWsStatus,
 *   })
 *
 * 性能（规范 15.2）：
 * - 订阅 / 取消订阅均为 O(1) Set 操作
 * - 不建立定时器、不持有 socket 引用
 * - 回调变化时仅做一次 unsub/sub，无网络抖动
 */

import { useEffect } from 'react'
import { wsDispatcher } from '@/lib/ws-dispatcher'
import type { WSEvent, WSStatus } from '@/lib/types'

/** Hook 配置 */
export interface UseWSSubscriptionOptions {
    /** 事件回调（每条 WS 消息调用） */
    onEvent?: (event: WSEvent) => void
    /** 状态变化回调（connecting / connected / disconnected / error） */
    onStatusChange?: (status: WSStatus) => void
    /** 是否启用订阅（false 时不订阅），默认 true */
    enabled?: boolean
}

/**
 * 订阅全局 WSDispatcher 的事件流
 *
 * - enabled = false 时不订阅（用于条件性订阅，如课堂"未开始"时不接收事件）
 * - 回调引用变化时自动重新订阅（依赖 React state/ref 的最新回调）
 */
export function useWSSubscription(opts: UseWSSubscriptionOptions = {}): void {
    const { onEvent, onStatusChange, enabled = true } = opts

    useEffect(() => {
        if (!enabled) return

        const unsubEvent = onEvent ? wsDispatcher.subscribe(onEvent) : () => {}
        const unsubStatus = onStatusChange ? wsDispatcher.subscribeStatus(onStatusChange) : () => {}

        return () => {
            unsubEvent()
            unsubStatus()
        }
    }, [onEvent, onStatusChange, enabled])
}
