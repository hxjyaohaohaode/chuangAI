/**
 * DanceEventCard —— 共舞事件卡片（v5.0 创新点：AI 诗教共舞舞台）
 *
 * 单条共舞事件的玻璃态卡片，按 actor（teacher/ai/student）区分色相与图标。
 *
 * 设计规范合规：
 * - 玻璃态背景：surface-elevated + backdrop-blur（规范 2.3 第 3 层）
 * - 无硬边框：仅 hover 时出现 alpha 8% 微边框（规范 4.3）
 * - 透明度分层：actor 色带使用 20% alpha 背景（规范 2.4）
 * - 入场动画：spring-soft，translateY + opacity（规范 6.3）
 * - transform/opacity 动画，不触发 Layout（规范 6.6）
 */

import { memo } from 'react'
import { Icon } from '@/components/ui'
import type { DanceActor, DanceEventPayload } from './dance-types'
import './DanceEventCard.css'

/** Actor 视觉配置 */
const ACTOR_CONFIG: Record<DanceActor, {
    icon: 'brain' | 'sparkle' | 'student'
    label: string
    /** 强调色 token 名（rgb var） */
    accent: '--c-accent-primary' | '--c-accent-info' | '--c-accent-success'
}> = {
    teacher: { icon: 'brain', label: '教师', accent: '--c-accent-primary' },
    ai: { icon: 'sparkle', label: 'AI', accent: '--c-accent-info' },
    student: { icon: 'student', label: '学生', accent: '--c-accent-success' },
}

/** 子类型中文标签 */
const SUB_TYPE_LABELS: Record<string, string> = {
    assign: '布置任务', guide: '引导启发', feedback: '反馈点评',
    suggest: '建议补充', supplement: '内容拓展', question: '追问深化',
    answer: '回答', ask: '提问', react: '反应',
}

export interface DanceEventCardProps {
    event: DanceEventPayload
    /** 是否高亮（最新事件） */
    isLatest?: boolean
}

/** 格式化时间戳为 HH:MM:SS */
function formatTime(ts: number): string {
    const d = new Date(ts)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function DanceEventCardImpl({ event, isLatest }: DanceEventCardProps) {
    const config = ACTOR_CONFIG[event.actor]
    const subTypeLabel = SUB_TYPE_LABELS[event.subType] ?? event.subType
    const accentVar = `var(${config.accent})`

    return (
        <article
            className={`pr-dance-card pr-dance-card--${event.actor}${isLatest ? ' pr-dance-card--latest' : ''}`}
            style={{
                // actor 色带：左侧 3px 竖条，使用 actor 强调色（规范 9.2 引用块指示条同源）
                ['--dance-accent' as string]: accentVar,
            }}
            aria-label={`${config.label}${subTypeLabel}事件`}
        >
            {/* 左侧色带 —— 透明度暗示 actor 归属，非硬边框 */}
            <span className="pr-dance-card__band" aria-hidden="true" />

            <div className="pr-dance-card__head">
                <span className="pr-dance-card__actor">
                    <Icon name={config.icon} size={14} />
                    <span className="pr-dance-card__actor-label">{config.label}</span>
                </span>
                <span className="pr-dance-card__subtype">{subTypeLabel}</span>
                <time className="pr-dance-card__time" dateTime={new Date(event.timestamp).toISOString()}>
                    {formatTime(event.timestamp)}
                </time>
            </div>

            <p className="pr-dance-card__content">
                {event.content}
            </p>

            {event.actorLabel && event.actor !== 'teacher' && (
                <footer className="pr-dance-card__foot">
                    <span className="pr-dance-card__who">{event.actorLabel}</span>
                    {event.aiGenerated && (
                        <span className="pr-dance-card__ai-tag" title="AI 生成">AI</span>
                    )}
                </footer>
            )}
        </article>
    )
}

export const DanceEventCard = memo(DanceEventCardImpl)
