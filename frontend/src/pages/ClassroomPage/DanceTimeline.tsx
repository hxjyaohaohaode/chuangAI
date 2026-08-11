/**
 * DanceTimeline —— 共舞时间轴（v5.0 创新点：AI 诗教共舞舞台）
 *
 * 三泳道 SVG 时间轴，将教师/AI/学生事件按时间序可视化。
 *
 * 设计规范合规：
 * - 无硬边框：泳道分隔使用透明度差异（规范 4.1）
 * - 透明度分层：泳道背景使用 surface-secondary alpha（规范 2.3）
 * - 入场动画：staggered 50ms × N（规范 6.3）
 * - transform/opacity 动画（规范 6.6）
 * - 流体高度 clamp()（规范 5.2）
 */

import { memo, useMemo, useRef, useEffect } from 'react'
import type { DanceActor, DanceEventPayload } from './dance-types'
import './DanceTimeline.css'

export interface DanceTimelineProps {
    events: DanceEventPayload[]
    /** 高亮事件 ID（最新） */
    latestEventId?: string
}

/** 泳道顺序 */
const LANE_ORDER: DanceActor[] = ['teacher', 'ai', 'student']

/** 长课保护：每条泳道只挂载最近节点，完整事件仍由上层状态/导出链保存。 */
const MAX_RENDERED_EVENTS_PER_LANE = 40
/** 排序工作集也必须有界，避免数小时课堂每次新事件都重排完整历史。 */
const MAX_SORT_CANDIDATES = MAX_RENDERED_EVENTS_PER_LANE * LANE_ORDER.length * 5

/** Actor 中文标签 */
const LANE_LABELS: Record<DanceActor, string> = {
    teacher: '教师',
    ai: 'AI',
    student: '学生',
}

/** Actor 强调色（与 DanceEventCard 对齐） */
const LANE_ACCENT: Record<DanceActor, string> = {
    teacher: 'var(--c-accent-primary)',
    ai: 'var(--c-accent-info)',
    student: 'var(--c-accent-success)',
}

function DanceTimelineImpl({ events, latestEventId }: DanceTimelineProps) {
    const scrollRef = useRef<HTMLDivElement>(null)

    // 新事件到达时自动滚动到底部（规范 6.5：平滑惯性滚动）
    useEffect(() => {
        if (scrollRef.current) {
            const reduceMotion = typeof window !== 'undefined'
                && typeof window.matchMedia === 'function'
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches
            scrollRef.current.scrollTo({
                top: scrollRef.current.scrollHeight,
                behavior: reduceMotion ? 'auto' : 'smooth',
            })
        }
    }, [events.length])

    const actorTotals = useMemo(() => {
        const totals: Record<DanceActor, number> = { teacher: 0, ai: 0, student: 0 }
        for (const event of events) totals[event.actor] += 1
        return totals
    }, [events])

    // 只对有界的最近工作集排序；各泳道再保留最后 N 条，DOM 上限固定为 120。
    const recentSortedEvents = useMemo(
        () => [...events.slice(-MAX_SORT_CANDIDATES)].sort((a, b) => a.timestamp - b.timestamp),
        [events],
    )
    const renderedByActor = useMemo(() => {
        const grouped: Record<DanceActor, DanceEventPayload[]> = {
            teacher: [],
            ai: [],
            student: [],
        }
        for (const event of recentSortedEvents) grouped[event.actor].push(event)
        for (const actor of LANE_ORDER) {
            grouped[actor] = grouped[actor].slice(-MAX_RENDERED_EVENTS_PER_LANE)
        }
        return grouped
    }, [recentSortedEvents])
    const renderedCount = LANE_ORDER.reduce((total, actor) => total + renderedByActor[actor].length, 0)
    const truncated = events.length > renderedCount

    return (
        <div
            className="pr-dance-timeline"
            role="region"
            aria-label="共舞时间轴"
            data-total-events={events.length}
            data-rendered-events={renderedCount}
        >
            {/* 泳道表头 */}
            <div className="pr-dance-timeline__lanes" aria-hidden="true">
                {LANE_ORDER.map((actor) => (
                    <div key={actor} className="pr-dance-timeline__lane-head">
                        <span
                            className="pr-dance-timeline__lane-dot"
                            style={{ backgroundColor: LANE_ACCENT[actor] }}
                        />
                        <span className="pr-dance-timeline__lane-name">{LANE_LABELS[actor]}</span>
                        <span className="pr-dance-timeline__lane-count">
                            {actorTotals[actor]}
                        </span>
                    </div>
                ))}
            </div>

            {truncated && (
                <p className="pr-dance-timeline__window-note" role="status">
                    为保障长课流畅，画面呈现各角色最近 {MAX_RENDERED_EVENTS_PER_LANE} 条；完整 {events.length} 条记录仍保留。
                </p>
            )}

            {/* 时间轴主体 —— 三泳道并列，事件按 actor 归入对应泳道 */}
            <div className="pr-dance-timeline__body" ref={scrollRef}>
                {events.length === 0 ? (
                    <div className="pr-dance-timeline__empty">
                        <span>等待共舞开始…教师布置任务后，AI 与学生将实时响应</span>
                    </div>
                ) : (
                    <div className="pr-dance-timeline__grid">
                        {LANE_ORDER.map((actor) => (
                            <div
                                key={actor}
                                className={`pr-dance-timeline__lane pr-dance-timeline__lane--${actor}`}
                            >
                                {renderedByActor[actor].map((event, idx) => (
                                        <div
                                            key={event.id}
                                            className={`pr-dance-timeline__node${
                                                event.id === latestEventId
                                                    ? ' pr-dance-timeline__node--latest'
                                                    : ''
                                            }`}
                                            style={{
                                                ['--node-accent' as string]: LANE_ACCENT[actor],
                                                animationDelay: `${Math.min(idx * 50, 600)}ms`,
                                            }}
                                            title={`${LANE_LABELS[actor]} · ${new Date(event.timestamp).toLocaleTimeString()}`}
                                        >
                                            <span className="pr-dance-timeline__node-dot" />
                                            <span className="pr-dance-timeline__node-text">
                                                {event.content.length > 40
                                                    ? `${event.content.slice(0, 40)}…`
                                                    : event.content}
                                            </span>
                                        </div>
                                    ))}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

export const DanceTimeline = memo(DanceTimelineImpl)
