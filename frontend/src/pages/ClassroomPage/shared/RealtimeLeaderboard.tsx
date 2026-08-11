/**
 * 实时积分榜组件（v5.0 Task 18-20）
 *
 * 设计背景：
 * - 单设备场景下需要把学生与 AI 对手混合在同一榜单展示
 * - 用于群赛 / 速PK / 飞花令 / 接龙 / 大转盘等多模式
 *
 * 职责：
 * 1. 聚合 responses + AI 对手得分 → 统一榜单
 * 2. 排序：按分数降序（并列时按响应时延升序）
 * 3. Top 3 特殊高亮（金/银/铜）
 * 4. AI 对手特殊标识（机器人图标 + accent-info 背景）
 * 5. 响应式：宽度自适应，支持紧凑模式
 *
 * 数据来源：
 * - responses: useClassroomStore.responses（包含 AI 对手的作答，studentId='ai-opponent'）
 * - aiOpponent: useClassroomStore.aiOpponent（用作 accent-info 高亮）
 * - scoreEntries: useClassroomStore.scoreEntries（智能赋分记录，用于替代 responses 中的 score）
 */

import { memo, useMemo } from 'react'
import { Icon, Badge } from '@/components/ui'
import { useClassroomStore } from '@/stores/classroom'
import type { StudentResponse } from '@/lib/types'

export interface RealtimeLeaderboardProps {
    /** 显示条目上限（默认 10） */
    maxItems?: number
    /** 紧凑模式（隐藏图标，单行高度） */
    compact?: boolean
    /** 显示分数条 */
    showBar?: boolean
    /** 自定义标题 */
    title?: string
    /** 自定义分数计算：传入则覆盖默认（用于特殊模式） */
    computeScore?: (responses: StudentResponse[]) => LeaderEntry[]
}

/** 排行榜条目 */
export interface LeaderEntry {
    studentId: string
    studentName: string
    score: number
    correctCount: number
    totalCount: number
    /** 平均响应时延 ms（用于排序） */
    avgLatencyMs?: number
    /** 是否为 AI 对手 */
    isAI: boolean
    /** 最近一次作答时间戳 */
    lastAt?: number
}

/** 默认分数聚合 */
function defaultCompute(responses: StudentResponse[]): LeaderEntry[] {
    const map = new Map<string, LeaderEntry>()

    for (const r of responses) {
        const isAI = r.studentId === 'ai-opponent'
        const existing = map.get(r.studentId)
        const score = r.score ?? (r.correct ? 60 : 0)
        if (existing) {
            existing.score += score
            existing.totalCount += 1
            if (r.correct) existing.correctCount += 1
            if (r.at > (existing.lastAt ?? 0)) existing.lastAt = r.at
        } else {
            map.set(r.studentId, {
                studentId: r.studentId,
                studentName: r.studentName ?? (isAI ? 'AI 对手' : `学生${r.studentId.slice(-4)}`),
                score,
                correctCount: r.correct ? 1 : 0,
                totalCount: 1,
                isAI,
                lastAt: r.at,
            })
        }
    }

    return Array.from(map.values()).sort((a, b) => {
        // 分数降序
        if (b.score !== a.score) return b.score - a.score
        // 并列时正确率降序
        const aRate = a.totalCount > 0 ? a.correctCount / a.totalCount : 0
        const bRate = b.totalCount > 0 ? b.correctCount / b.totalCount : 0
        if (bRate !== aRate) return bRate - aRate
        // 最后按时间升序（先答完的排前）
        return (a.lastAt ?? 0) - (b.lastAt ?? 0)
    })
}

export const RealtimeLeaderboard = memo(function RealtimeLeaderboard({
    maxItems = 10,
    compact = false,
    showBar = true,
    title = '实时积分榜',
    computeScore,
}: RealtimeLeaderboardProps) {
    const responses = useClassroomStore((s) => s.responses)
    const aiOpponent = useClassroomStore((s) => s.aiOpponent)

    const leaderboard = useMemo(() => {
        const compute = computeScore ?? defaultCompute
        return compute(responses)
    }, [responses, computeScore])

    const visible = leaderboard.slice(0, maxItems)
    const maxScore = Math.max(1, ...visible.map((e) => e.score))

    return (
        <div className={`pr-leaderboard ${compact ? 'is-compact' : ''}`}>
            <div className="pr-leaderboard-header">
                <Icon name="trophy" size={14} />
                <span className="pr-leaderboard-title">{title}</span>
                <Badge variant="default" style={{ marginLeft: 'auto' }}>
                    {leaderboard.length} 人
                </Badge>
            </div>

            {visible.length === 0 ? (
                <div className="pr-leaderboard-empty">
                    <Icon name="clock" size={20} />
                    <span>等待第一位作答...</span>
                </div>
            ) : (
                <ol className="pr-leaderboard-list">
                    {visible.map((entry, idx) => {
                        const rank = idx + 1
                        const isTop3 = rank <= 3
                        const isAI = entry.isAI || entry.studentId === 'ai-opponent'
                        const barWidth = (entry.score / maxScore) * 100

                        return (
                            <li
                                key={entry.studentId}
                                className={`pr-leaderboard-item ${isTop3 ? `is-rank-${rank}` : ''} ${isAI ? 'is-ai' : ''}`}
                            >
                                <span className={`pr-leaderboard-rank ${isTop3 ? `pr-leaderboard-rank--${rank}` : ''}`}>
                                    {rank}
                                </span>
                                <div className="pr-leaderboard-info">
                                    <span className="pr-leaderboard-name">
                                        {isAI && (
                                            <span style={{ marginRight: 'var(--space-xs, 4px)', display: 'inline-flex', alignItems: 'center' }}>
                                                <Icon name="robot" size={12} />
                                            </span>
                                        )}
                                        {entry.studentName}
                                        {isAI && aiOpponent.enabled && (
                                            <span className="pr-leaderboard-ai-tag">AI</span>
                                        )}
                                    </span>
                                    {showBar && !compact && (
                                        <div className="pr-leaderboard-bar">
                                            <div
                                                className="pr-leaderboard-bar-fill"
                                                style={{
                                                    transform: `scaleX(${barWidth / 100})`,
                                                    backgroundColor: isAI
                                                        ? 'rgb(var(--c-accent-info))'
                                                        : rank === 1
                                                            ? 'rgb(var(--c-accent-primary))'
                                                            : rank === 2
                                                                ? 'rgb(var(--c-text-secondary))'
                                                                : rank === 3
                                                                    ? 'rgb(var(--c-accent-warning))'
                                                                    : 'rgb(var(--c-text-tertiary))',
                                                }}
                                            />
                                        </div>
                                    )}
                                </div>
                                <span className="pr-leaderboard-score">{entry.score}</span>
                                {!compact && entry.totalCount > 0 && (
                                    <span className="pr-leaderboard-correct">
                                        {entry.correctCount}/{entry.totalCount}
                                    </span>
                                )}
                            </li>
                        )
                    })}
                </ol>
            )}
        </div>
    )
})
