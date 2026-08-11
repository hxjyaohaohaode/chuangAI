import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    useNotificationStore,
    useUnreadCount,
    type NotificationType,
    type AppNotification,
} from '@/stores/notifications'
import { Icon } from '@/components/ui'
import { cn } from '@/lib/cn'

/**
 * 通知中心（规范 8.4 状态保持 + 7.2 微交互 + 4.2 玻璃质感 + 6.2 Spring 动效）
 *
 * 深度升级要点：
 *  - Liquid Glass 面板：blur(24px) saturate(1.2) + 1px 内发光边缘 + 微噪点
 *  - Spring 物理动效：面板 spring-soft 入场，通知项 spring-snappy 交互
 *  - 渐进式入场：通知项按 --item-index 错峰 40ms staggered 展现
 *  - 时间分组：今天 / 昨天 / 更早，渐进式浏览信息分层
 *  - 类型语义色：info/success/warning/error 四色图标圆 + 左侧色条
 *  - 完整微交互链路：hover 浮起 / active 下沉 / focus-visible 焦点环
 *  - 情感化空状态：圆背景图标 + 标题 + 引导描述
 *  - 未读脉冲环：铃铛呼吸提示，吸引注意力
 *  - 跳转箭头：有 linkTo 的通知 hover 时显示方向指示
 *  - 可访问性：aria-live polite + 键盘上下箭头导航 + 完整 aria-label
 */

const TYPE_ICON: Record<NotificationType, Parameters<typeof Icon>[0]['name']> = {
    info: 'info',
    success: 'check-circle',
    warning: 'warning',
    error: 'x-circle',
}

const TYPE_COLOR: Record<NotificationType, string> = {
    info: 'var(--c-accent-info)',
    success: 'var(--c-accent-success)',
    warning: 'var(--c-accent-warning)',
    error: 'var(--c-accent-error)',
}

const TYPE_LABEL: Record<NotificationType, string> = {
    info: '信息',
    success: '成功',
    warning: '提醒',
    error: '错误',
}

function formatTime(ts: number): string {
    const diff = Date.now() - ts
    const min = Math.floor(diff / 60000)
    if (min < 1) return '刚刚'
    if (min < 60) return `${min} 分钟前`
    const hour = Math.floor(min / 60)
    if (hour < 24) return `${hour} 小时前`
    const day = Math.floor(hour / 24)
    if (day < 7) return `${day} 天前`
    return new Date(ts).toLocaleDateString('zh-CN')
}

/** 判断通知属于哪个时间分组 */
function getDateGroup(ts: number): 'today' | 'yesterday' | 'earlier' {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const yesterday = today - 24 * 60 * 60 * 1000
    if (ts >= today) return 'today'
    if (ts >= yesterday) return 'yesterday'
    return 'earlier'
}

const GROUP_LABELS: Record<string, string> = {
    today: '今天',
    yesterday: '昨天',
    earlier: '更早',
}

interface NotificationGroup {
    key: string
    label: string
    items: AppNotification[]
}

/**
 * 空通知面板没有可聚焦子元素，不能依赖 effect 已经挂载文档监听器才阻止
 * Tab 漏出。该函数同时由面板自身和文档级兜底调用，确保打开首帧也维持对话框
 * 的焦点边界。
 */
function trapPanelFocus(
    panel: HTMLDivElement | null,
    event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>,
) {
    if (event.key !== 'Tab' || !panel) return
    const focusables = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    if (focusables.length === 0) {
        event.preventDefault()
        panel.focus()
        return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (!first || !last) {
        event.preventDefault()
        panel.focus()
        return
    }
    const active = document.activeElement as HTMLElement | null
    if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
            event.preventDefault()
            last.focus()
        }
    } else if (active === last || !panel.contains(active)) {
        event.preventDefault()
        first.focus()
    }
}

/** 按时间分组通知（已按时间倒序，分组后保持倒序） */
function groupNotifications(notifications: AppNotification[]): NotificationGroup[] {
    const groups: Record<string, AppNotification[]> = {
        today: [],
        yesterday: [],
        earlier: [],
    }
    for (const n of notifications) {
        const group = groups[getDateGroup(n.createdAt)]
        if (group) group.push(n)
    }
    return (['today', 'yesterday', 'earlier'] as const)
        .filter((key) => (groups[key]?.length ?? 0) > 0)
        .map((key) => ({
            key,
            label: GROUP_LABELS[key] ?? key,
            items: groups[key] ?? [],
        }))
}

export function NotificationCenter() {
    const notifications = useNotificationStore((s) => s.notifications)
    const unreadCount = useUnreadCount()
    const markRead = useNotificationStore((s) => s.markRead)
    const markAllRead = useNotificationStore((s) => s.markAllRead)
    const clearAll = useNotificationStore((s) => s.clearAll)
    const clearRead = useNotificationStore((s) => s.clearRead)
    const navigate = useNavigate()

    const [open, setOpen] = useState(false)
    const panelRef = useRef<HTMLDivElement | null>(null)
    const buttonRef = useRef<HTMLButtonElement | null>(null)
    const listRef = useRef<HTMLDivElement | null>(null)
    const lastFocused = useRef<HTMLElement | null>(null)

    const grouped = useMemo(() => groupNotifications(notifications), [notifications])
    const hasReadItems = useMemo(() => notifications.some((n) => n.read), [notifications])

    // 点击外部关闭面板 + ESC 关闭 + 焦点陷阱（规范 14.4 / WCAG 2.4.3）
    useEffect(() => {
        if (!open) return
        const onClickOutside = (e: MouseEvent) => {
            const target = e.target as Node
            if (
                panelRef.current && !panelRef.current.contains(target) &&
                buttonRef.current && !buttonRef.current.contains(target)
            ) {
                setOpen(false)
            }
        }
        const onEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation()
                setOpen(false)
            }
        }
        // 文档级焦点陷阱：面板自身也绑定了同一处理器，以覆盖刚打开的首帧。
        const onTab = (e: KeyboardEvent) => {
            trapPanelFocus(panelRef.current, e)
        }
        document.addEventListener('mousedown', onClickOutside)
        document.addEventListener('keydown', onEsc)
        document.addEventListener('keydown', onTab)
        return () => {
            document.removeEventListener('mousedown', onClickOutside)
            document.removeEventListener('keydown', onEsc)
            document.removeEventListener('keydown', onTab)
        }
    }, [open])

    // 初始焦点：面板挂载后、浏览器绘制前记录触发元素并聚焦到面板内首个
    // 可交互元素（规范 14.4）。不能用零延迟定时器：空态没有内部按钮时，
    // 键盘用户可能在首帧仍停在背景触发器，随后 Tab 才被动回收。
    useLayoutEffect(() => {
        if (!open) return
        lastFocused.current = document.activeElement as HTMLElement | null
        const panel = panelRef.current
        if (!panel) return
        const focusable = panel.querySelector<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        ;(focusable ?? panel).focus({ preventScroll: true })
    }, [open])

    // 焦点恢复：关闭时还原到触发按钮（规范 14.4 / WCAG 2.4.3）。
    // `lastFocused` 在打开后的 effect 中记录；若用户在首帧内关闭或并发渲染
    // 使该元素已卸载，则退回到始终存在的铃铛按钮，避免把键盘焦点丢到 document。
    useEffect(() => {
        if (open) return
        const prev = lastFocused.current
        // 初始挂载不是一次“关闭”，不应劫持用户已在页面中的初始焦点。
        if (!prev) return
        lastFocused.current = null
        const target = prev?.isConnected && typeof prev.focus === 'function'
            ? prev
            : buttonRef.current
        if (!target) return
        const frame = window.requestAnimationFrame(() => {
            if (target.isConnected) target.focus({ preventScroll: true })
        })
        return () => window.cancelAnimationFrame(frame)
    }, [open])

    // 键盘上下箭头在通知项间导航
    const handleListKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        const items = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-notification-item]')
        if (!items || items.length === 0) return
        e.preventDefault()
        const currentIndex = Array.from(items).findIndex((item) => item === document.activeElement)
        if (e.key === 'ArrowDown') {
            const nextIndex = currentIndex < 0 || currentIndex === items.length - 1 ? 0 : currentIndex + 1
            items[nextIndex]?.focus()
        } else {
            const nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1
            items[nextIndex]?.focus()
        }
    }, [])

    const handlePanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') {
            e.stopPropagation()
            setOpen(false)
            return
        }
        // 使用 React 合成事件自身取消默认 Tab 行为，避免在刚挂载的面板上
        // 绕过 React 的事件边界而让浏览器先把焦点移到背景页面。
        trapPanelFocus(panelRef.current, e)
    }

    const handleNotificationClick = (id: string, linkTo?: string) => {
        markRead(id)
        if (linkTo) {
            navigate(linkTo)
            setOpen(false)
        }
    }

    const bellLabel = open
        ? '关闭通知面板'
        : `通知中心${unreadCount > 0 ? `，${unreadCount} 条未读` : ''}`

    return (
        <div className="pr-notification-center">
            <button
                ref={buttonRef}
                type="button"
                className={cn('pr-icon-button', open && 'is-active')}
                onClick={() => setOpen((v) => !v)}
                aria-label={bellLabel}
                aria-expanded={open}
                aria-haspopup="dialog"
            >
                <Icon name="bell" size={18} />
                {unreadCount > 0 && (
                    <span className="pr-notification-pulse" aria-hidden />
                )}
                {unreadCount > 0 && (
                    <span className="pr-notification-badge" aria-hidden>
                        {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                )}
            </button>

            {open && (
                <div
                    ref={panelRef}
                    className="pr-notification-panel"
                    role="dialog"
                    aria-modal="true"
                    aria-label="通知中心"
                    tabIndex={-1}
                    onKeyDown={handlePanelKeyDown}
                >
                    <div className="pr-notification-header">
                        <div className="pr-notification-header-info">
                            <span className="pr-notification-title">通知</span>
                            {unreadCount > 0 && (
                                <span className="pr-notification-count">
                                    {unreadCount} 条未读
                                </span>
                            )}
                        </div>
                        {unreadCount > 0 && (
                            <button
                                type="button"
                                className="pr-notification-action"
                                onClick={markAllRead}
                            >
                                <Icon name="check" size={12} />
                                <span>全部已读</span>
                            </button>
                        )}
                    </div>

                    <div
                        ref={listRef}
                        className="pr-notification-list"
                        role="log"
                        aria-live="polite"
                        aria-label="通知列表"
                        onKeyDown={handleListKeyDown}
                    >                        {notifications.length === 0 ? (
                        <div className="pr-notification-empty">
                            <span className="pr-notification-empty-icon">
                                <Icon name="bell-slash" size={28} weight="bold" />
                            </span>
                            <span className="pr-notification-empty-title">暂无通知</span>
                            <span className="pr-notification-empty-desc">
                                课堂结束、批改完成、报告生成等事件会在此处提醒
                            </span>
                        </div>
                    ) : (
                        grouped.map((group) => (
                            <div key={group.key} className="pr-notification-group">
                                <div className="pr-notification-group-label" aria-hidden>
                                    {group.label}
                                </div>
                                {group.items.map((n, idx) => (
                                    <button
                                        key={n.id}
                                        type="button"
                                        data-notification-item
                                        data-type={n.type}
                                        className={cn(
                                            'pr-notification-item',
                                            !n.read && 'is-unread',
                                        )}
                                        style={{
                                            '--item-index': Math.min(idx, 15),
                                            '--type-color': TYPE_COLOR[n.type],
                                        } as React.CSSProperties}
                                        onClick={() => handleNotificationClick(n.id, n.linkTo)}
                                        aria-label={`${TYPE_LABEL[n.type]}：${n.title}${n.description ? `，${n.description}` : ''}，${formatTime(n.createdAt)}${n.read ? '' : '，未读'}`}
                                    >
                                        <span className="pr-notification-item-icon">
                                            <Icon name={TYPE_ICON[n.type]} size={16} />
                                        </span>
                                        <span className="pr-notification-item-body">
                                            <span className="pr-notification-item-title">
                                                {n.title}
                                            </span>
                                            {n.description && (
                                                <span className="pr-notification-item-desc">
                                                    {n.description}
                                                </span>
                                            )}
                                            <span className="pr-notification-item-time">
                                                {formatTime(n.createdAt)}
                                            </span>
                                        </span>
                                        {n.linkTo && (
                                            <span
                                                className="pr-notification-item-arrow"
                                                aria-hidden
                                            >
                                                <Icon name="arrow-right" size={12} />
                                            </span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        ))
                    )}
                    </div>

                    {notifications.length > 0 && (
                        <div className="pr-notification-footer">
                            {hasReadItems && (
                                <button
                                    type="button"
                                    className="pr-notification-action"
                                    onClick={clearRead}
                                >
                                    <Icon name="check" size={12} />
                                    <span>清除已读</span>
                                </button>
                            )}
                            <button
                                type="button"
                                className="pr-notification-action pr-notification-action--danger"
                                onClick={clearAll}
                            >
                                <Icon name="trash" size={12} />
                                <span>清空全部</span>
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
