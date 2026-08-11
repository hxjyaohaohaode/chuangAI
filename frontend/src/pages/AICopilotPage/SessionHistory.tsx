/**
 * 会话历史侧边栏 v6（Task 24.5 全面重做）
 *
 * 职责：
 * 1. 展示教师的历史会话列表（title + lastMessage + 相对时间）
 * 2. 支持按关键词模糊搜索
 * 3. 点击会话项加载完整消息流到聊天区
 * 4. 删除会话（带二次确认）
 * 5. "新建会话"按钮清空当前聊天区
 * 6. 可折叠：折叠后变为 48px 窄条，仅显示图标
 *
 * 设计要点（规范第 7、14 章）：
 * - 列表项 hover 时背景变为 surface-tertiary，选中态左侧 3px accent 竖线
 * - 搜索输入框无边框，focus 时 accent 光晕
 * - 空状态友好引导，加载态骨架占位
 * - 零 emoji，全部使用 Phosphor SVG 图标
 * - 相对时间友好显示（刚刚 / X 分钟前 / X 小时前 / X 天前）
 * - 折叠/展开 250ms spring-soft 动画
 * - content-visibility: auto 优化长列表渲染
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@/components/ui'
import { useCopilotStore } from '@/stores/copilot'
import { cn } from '@/lib/cn'
import type { CopilotSessionSummary } from '@/lib/types'

// ─────────────────────────────────────────────────────────────
// 相对时间格式化
// ─────────────────────────────────────────────────────────────

function formatRelativeTime(timestamp: number): string {
    const now = Date.now()
    const diff = now - timestamp
    const sec = Math.floor(diff / 1000)
    const min = Math.floor(sec / 60)
    const hour = Math.floor(min / 60)
    const day = Math.floor(hour / 24)

    if (sec < 60) return '刚刚'
    if (min < 60) return `${min} 分钟前`
    if (hour < 24) return `${hour} 小时前`
    if (day < 7) return `${day} 天前`
    // 超过 7 天显示日期
    const date = new Date(timestamp)
    const month = date.getMonth() + 1
    const dayOfMonth = date.getDate()
    return `${month}月${dayOfMonth}日`
}

// ─────────────────────────────────────────────────────────────
// 单条会话项
// ─────────────────────────────────────────────────────────────

interface SessionItemProps {
    session: CopilotSessionSummary
    isActive: boolean
    isLoading: boolean
    collapsed: boolean
    onSelect: () => void
    onDelete: () => void
}

const SessionItem = memo(function SessionItem({
    session,
    isActive,
    isLoading,
    collapsed,
    onSelect,
    onDelete,
}: SessionItemProps) {
    const [confirmingDelete, setConfirmingDelete] = useState(false)
    // 跟踪确认态定时器，卸载时清理避免内存泄漏
    const confirmTimerRef = useRef<number | null>(null)

    useEffect(() => {
        return () => {
            if (confirmTimerRef.current !== null) {
                window.clearTimeout(confirmTimerRef.current)
            }
        }
    }, [])

    const handleDeleteClick = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation()
            if (confirmingDelete) {
                onDelete()
            } else {
                setConfirmingDelete(true)
                // 3 秒后自动取消确认态；先清理旧定时器，避免叠加
                if (confirmTimerRef.current !== null) {
                    window.clearTimeout(confirmTimerRef.current)
                }
                confirmTimerRef.current = window.setTimeout(() => setConfirmingDelete(false), 3000)
            }
        },
        [confirmingDelete, onDelete],
    )

    const handleDeleteBlur = useCallback(() => {
        setConfirmingDelete(false)
    }, [])

    // 折叠态：仅显示一个圆点，hover 时展开 tooltip
    if (collapsed) {
        return (
            <li
                className={cn('pr-copilot-history-item', 'is-collapsed', {
                    'is-active': isActive,
                    'is-loading': isLoading,
                })}
            >
                <button
                    type="button"
                    className="pr-copilot-history-item-collapsed-btn"
                    onClick={onSelect}
                    disabled={isLoading}
                    aria-label={`加载会话 ${session.title}`}
                    aria-current={isActive ? 'true' : undefined}
                    title={session.title}
                >
                    <Icon name="chat-circle" size={14} />
                </button>
            </li>
        )
    }

    return (
        <li
            className={cn('pr-copilot-history-item', {
                'is-active': isActive,
                'is-loading': isLoading,
            })}
        >
            <button
                type="button"
                className="pr-copilot-history-item-main"
                onClick={onSelect}
                disabled={isLoading}
                aria-label={`加载会话 ${session.title}`}
                aria-current={isActive ? 'true' : undefined}
            >
                <span className="pr-copilot-history-item-title">{session.title}</span>
                <span className="pr-copilot-history-item-preview">
                    {session.lastMessage || '（暂无消息）'}
                </span>
                <span className="pr-copilot-history-item-time">
                    {formatRelativeTime(session.updatedAt)}
                </span>
            </button>
            <button
                type="button"
                className={cn('pr-copilot-history-item-delete', {
                    'is-confirming': confirmingDelete,
                })}
                onClick={handleDeleteClick}
                onBlur={handleDeleteBlur}
                disabled={isLoading}
                aria-label={confirmingDelete ? '再次点击以确认删除' : '删除会话'}
                title={confirmingDelete ? '再次点击确认删除' : '删除会话'}
            >
                <Icon name={confirmingDelete ? 'warning' : 'trash'} size={14} />
            </button>
        </li>
    )
})

// ─────────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────────

export const SessionHistory = memo(function SessionHistory() {
    const sessions = useCopilotStore((s) => s.sessions)
    const sessionsLoading = useCopilotStore((s) => s.sessionsLoading)
    const sessionId = useCopilotStore((s) => s.sessionId)
    const fetchSessions = useCopilotStore((s) => s.fetchSessions)
    const loadSession = useCopilotStore((s) => s.loadSession)
    const deleteSession = useCopilotStore((s) => s.deleteSession)
    const newSession = useCopilotStore((s) => s.newSession)

    const [query, setQuery] = useState('')
    /** 正在加载中的会话 id（点击后到加载完成期间） */
    const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null)
    /** 折叠态 —— 折叠后变为 48px 窄条 */
    const [collapsed, setCollapsed] = useState(false)

    // 首次挂载拉取会话列表
    useEffect(() => {
        void fetchSessions()
    }, [fetchSessions])

    // 当 sessionsLoading 由 true 转 false 时，清除 loadingSessionId
    useEffect(() => {
        if (!sessionsLoading && loadingSessionId) {
            setLoadingSessionId(null)
        }
    }, [sessionsLoading, loadingSessionId])

    const filteredSessions = useMemo(() => {
        const trimmed = query.trim().toLowerCase()
        if (!trimmed) return sessions
        return sessions.filter(
            (s) =>
                s.title.toLowerCase().includes(trimmed) ||
                s.lastMessage.toLowerCase().includes(trimmed),
        )
    }, [sessions, query])

    const handleSelect = useCallback(
        (id: string) => {
            if (id === sessionId) return
            setLoadingSessionId(id)
            void loadSession(id)
        },
        [loadSession, sessionId],
    )

    const handleDelete = useCallback(
        (id: string) => {
            void deleteSession(id)
        },
        [deleteSession],
    )

    const handleNewSession = useCallback(() => {
        newSession()
    }, [newSession])

    const handleToggleCollapse = useCallback(() => {
        setCollapsed((prev) => !prev)
    }, [])

    const hasSessions = sessions.length > 0
    const hasFiltered = filteredSessions.length > 0

    return (
        <section
            className={cn('pr-copilot-history', { 'is-collapsed': collapsed })}
            aria-label="会话历史"
        >
            <header className="pr-copilot-history-header">
                {!collapsed && (
                    <div className="pr-copilot-history-header-title">
                        <Icon name="clock" size={16} />
                        <h3>会话历史</h3>
                    </div>
                )}
                <div className="pr-copilot-history-header-actions">
                    <button
                        type="button"
                        className="pr-copilot-history-new-btn"
                        onClick={handleNewSession}
                        aria-label="新建会话"
                        title={collapsed ? '新建会话' : undefined}
                    >
                        <Icon name="plus" size={16} />
                        {!collapsed && <span>新建</span>}
                    </button>
                    <button
                        type="button"
                        className="pr-copilot-history-collapse-btn"
                        onClick={handleToggleCollapse}
                        aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'}
                        title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
                        aria-expanded={!collapsed}
                    >
                        <Icon name={collapsed ? 'caret-right' : 'caret-left'} size={14} />
                    </button>
                </div>
            </header>

            {!collapsed && hasSessions && (
                <div className="pr-copilot-history-search">
                    <Icon name="magnifying-glass" size={14} className="pr-copilot-history-search-icon" />
                    <input
                        type="search"
                        className="pr-copilot-history-search-input"
                        placeholder="搜索会话…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        aria-label="搜索会话"
                    />
                    {query && (
                        <button
                            type="button"
                            className="pr-copilot-history-search-clear"
                            onClick={() => setQuery('')}
                            aria-label="清除搜索"
                        >
                            <Icon name="x" size={12} />
                        </button>
                    )}
                </div>
            )}

            <div className="pr-copilot-history-list-wrapper">
                {sessionsLoading && !hasSessions && (
                    <ul className="pr-copilot-history-list" aria-busy="true">
                        {[0, 1, 2, 3].map((i) => (
                            <li key={i} className="pr-copilot-history-skeleton" aria-hidden="true">
                                <span className="pr-copilot-history-skeleton-title" />
                                <span className="pr-copilot-history-skeleton-preview" />
                                <span className="pr-copilot-history-skeleton-time" />
                            </li>
                        ))}
                    </ul>
                )}

                {!sessionsLoading && !hasSessions && !collapsed && (
                    <div className="pr-copilot-history-empty">
                        <Icon name="chat" size={32} className="pr-copilot-history-empty-icon" />
                        <p className="pr-copilot-history-empty-title">暂无历史会话</p>
                        <p className="pr-copilot-history-empty-desc">
                            发送第一条指令或点击快捷指令即可开始
                        </p>
                    </div>
                )}

                {!sessionsLoading && !hasSessions && collapsed && (
                    <div className="pr-copilot-history-empty pr-copilot-history-empty--collapsed">
                        <Icon name="chat-circle" size={20} className="pr-copilot-history-empty-icon" />
                    </div>
                )}

                {hasSessions && !hasFiltered && !collapsed && (
                    <div className="pr-copilot-history-empty">
                        <Icon name="magnifying-glass" size={28} className="pr-copilot-history-empty-icon" />
                        <p className="pr-copilot-history-empty-title">未匹配到会话</p>
                        <p className="pr-copilot-history-empty-desc">
                            尝试更换关键词或
                            <button
                                type="button"
                                className="pr-copilot-history-empty-reset"
                                onClick={() => setQuery('')}
                            >
                                清除搜索
                            </button>
                        </p>
                    </div>
                )}

                {hasFiltered && (
                    <ul className="pr-copilot-history-list">
                        {filteredSessions.map((session) => (
                            <SessionItem
                                key={session.id}
                                session={session}
                                isActive={session.id === sessionId}
                                isLoading={session.id === loadingSessionId}
                                collapsed={collapsed}
                                onSelect={() => handleSelect(session.id)}
                                onDelete={() => handleDelete(session.id)}
                            />
                        ))}
                    </ul>
                )}
            </div>
        </section>
    )
})
