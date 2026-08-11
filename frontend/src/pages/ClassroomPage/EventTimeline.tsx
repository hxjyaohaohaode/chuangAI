/**
 * 课堂事件时间轴（课堂指挥深化 Task 4）
 *
 * 水平滚动时间轴，展示课堂全程关键事件：
 * - 模式切换（mode-changed）
 * - 学生答题（student-answer）
 * - AI 建议（ai-suggested）
 * - 教师干预（teacher-intervention）
 * - 分数变化（score-change）
 *
 * 每个事件包含：图标 + 摘要 + 时间戳
 * 当前位置指示器 + 点击跳转
 * 玻璃态覆盖层 + 可折叠
 *
 * 设计要点（规范第 6、7、14 章）：
 * - 玻璃态：surface-glass + backdrop-blur(12px)
 * - 微交互：hover 微升 + 透明微边框
 * - 入场动画：交错入场（staggered），每项 50ms 延迟
 * - 无边框：区域分隔使用透明度差异
 */

import { useMemo, useRef, useEffect, useState } from 'react'
import { Icon } from '@/components/ui'
import type { ClassroomEventItem } from './event-timeline-types'
import './EventTimeline.css'

export interface EventTimelineProps {
    /** 事件列表（按时间排序） */
    events: ClassroomEventItem[]
    /** 当前时间戳（用于位置指示器） */
    currentTime?: number
    /** 课堂开始时间 */
    startedAt: number
    /** 点击事件回调 */
    onEventClick?: (event: ClassroomEventItem) => void
}

/** 事件类型图标映射 */
const EVENT_ICONS: Record<ClassroomEventItem['type'], string> = {
    'mode-changed': 'switch',
    'student-answer': 'graduation',
    'ai-suggested': 'magic-wand',
    'teacher-intervention': 'lightbulb',
    'score-change': 'chart-line-up',
}

/** 事件类型颜色映射（使用设计规范的强调色） */
const EVENT_COLORS: Record<ClassroomEventItem['type'], string> = {
    'mode-changed': 'var(--c-accent-primary)',
    'student-answer': 'var(--c-accent-info)',
    'ai-suggested': 'var(--c-accent-success)',
    'teacher-intervention': 'var(--c-accent-warning)',
    'score-change': 'var(--c-accent-primary)',
}

/** 水平时间轴只挂载最近事件；完整历史仍保留在课堂状态与后端记录中。 */
const MAX_RENDERED_EVENTS = 120

/** 格式化时间戳为 MM:SS */
function formatTime(ts: number, startedAt: number): string {
    const elapsed = Math.max(0, Math.floor((ts - startedAt) / 1000))
    const min = Math.floor(elapsed / 60)
    const sec = elapsed % 60
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

export function EventTimeline({ events, currentTime, startedAt, onEventClick }: EventTimelineProps) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const [collapsed, setCollapsed] = useState(false)
    const [autoScroll, setAutoScroll] = useState(true)
    const visibleEvents = useMemo(() => events.slice(-MAX_RENDERED_EVENTS), [events])
    const truncated = events.length > visibleEvents.length

    // 自动滚动到最新事件
    useEffect(() => {
        if (!autoScroll || !scrollRef.current || collapsed) return
        const el = scrollRef.current
        const reduceMotion = typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        el.scrollTo({ left: el.scrollWidth, behavior: reduceMotion ? 'auto' : 'smooth' })
    }, [events.length, autoScroll, collapsed])

    // 当前时间位置百分比
    const currentPosition = useMemo(() => {
        if (!currentTime) return null
        const elapsed = currentTime - startedAt
        return Math.max(0, Math.min(100, (elapsed / (40 * 60 * 1000)) * 100))
    }, [currentTime, startedAt])

    if (collapsed) {
        return (
            <div className="pr-event-timeline pr-event-timeline--collapsed">
                <button
                    type="button"
                    className="pr-event-timeline-toggle"
                    onClick={() => setCollapsed(false)}
                    aria-label="展开时间轴"
                >
                    <Icon name="chart-line-up" size={16} />
                    <span>事件时间轴</span>
                    <span className="pr-event-timeline-count">{events.length}</span>
                    <Icon name="chevron-down" size={14} />
                </button>
            </div>
        )
    }

    return (
        <div
            className="pr-event-timeline"
            data-total-events={events.length}
            data-rendered-events={visibleEvents.length}
        >
            <div className="pr-event-timeline-header">
                <div className="pr-event-timeline-header-left">
                    <Icon name="chart-line-up" size={14} />
                    <span className="pr-event-timeline-title">事件时间轴</span>
                    <span className="pr-event-timeline-count">{events.length}</span>
                    {truncated && (
                        <span className="pr-event-timeline-window-note">
                            显示最近 {MAX_RENDERED_EVENTS} 条
                        </span>
                    )}
                </div>
                <div className="pr-event-timeline-header-right">
                    <button
                        type="button"
                        className="pr-event-timeline-auto-scroll"
                        aria-pressed={autoScroll}
                        onClick={() => setAutoScroll(!autoScroll)}
                    >
                        <Icon name={autoScroll ? 'pause' : 'play'} size={12} />
                        {autoScroll ? '自动滚动' : '手动'}
                    </button>
                    <button
                        type="button"
                        className="pr-event-timeline-toggle"
                        onClick={() => setCollapsed(true)}
                        aria-label="折叠时间轴"
                    >
                        <Icon name="chevron-up" size={14} />
                    </button>
                </div>
            </div>

            <div className="pr-event-timeline-track-wrapper">
                {/* 当前位置指示器 */}
                {currentPosition != null && (
                    <div
                        className="pr-event-timeline-cursor"
                        style={{ left: `${currentPosition}%` }}
                        aria-hidden="true"
                    />
                )}

                <div className="pr-event-timeline-track" ref={scrollRef}>
                    {/* 时间轴基线 */}
                    <div className="pr-event-timeline-baseline" aria-hidden="true" />

                    {events.length === 0 ? (
                        <div className="pr-event-timeline-empty">
                            <Icon name="clock" size={20} />
                            <span>暂无事件记录</span>
                        </div>
                    ) : (
                        visibleEvents.map((evt) => (
                            <button
                                key={evt.id}
                                type="button"
                                className="pr-event-timeline-item"
                                style={{
                                    ['--event-color' as string]: EVENT_COLORS[evt.type],
                                }}
                                onClick={() => onEventClick?.(evt)}
                                aria-label={`${evt.summary} - ${formatTime(evt.timestamp, startedAt)}`}
                            >
                                <div className="pr-event-timeline-item-dot">
                                    <Icon name={EVENT_ICONS[evt.type] as 'switch'} size={12} />
                                </div>
                                <div className="pr-event-timeline-item-content">
                                    <span className="pr-event-timeline-item-summary">
                                        {evt.summary}
                                    </span>
                                    <span className="pr-event-timeline-item-time">
                                        {formatTime(evt.timestamp, startedAt)}
                                    </span>
                                </div>
                            </button>
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}
