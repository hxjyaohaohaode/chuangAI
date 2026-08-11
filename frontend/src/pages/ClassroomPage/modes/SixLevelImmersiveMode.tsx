/**
 * 六阶沉浸课模式（SubTask 18.3 —— 单设备 + AI 流式点评）
 *
 * 设计背景：
 * - 六阶认知递进（布卢姆修正版）：记忆/理解/运用/分析/评价/创造
 * - 单设备场景下，教师代答输入 → AI 即时流式点评
 * - 每阶的作答正确率实时可视化
 *
 * 职责：
 * 1. 六阶认知雷达：当前阶高亮，进度条显示正确率
 * 2. 单设备代答输入（StudentInputPanel）
 * 3. AI 实时流式点评（SSE）：对学生作答给予 praise / guide / challenge / correct
 * 4. 智能赋分（0-100 + 分维度评分）
 * 5. 阶进度提示
 *
 * 设计要点：
 * - 当前阶使用 accent-primary 10% 背景
 * - 正确率 <60% 红色，60-80% 黄色，≥80% 绿色
 * - AI 点评流式输出光标 + 渐进式渲染
 */

import { memo, useCallback, useEffect, useMemo } from 'react'
import { Icon, Badge } from '@/components/ui'
import { useClassroomStore } from '@/stores/classroom'
import { BLOOM_ORDER, type BloomLevel, type StudentResponse, type ClassroomQuestion } from '@/lib/types'
import { StudentInputPanel } from '../shared/StudentInputPanel'

export interface SixLevelImmersiveModeProps {
    /** 当前题目（用于确定当前阶） */
    question: ClassroomQuestion | undefined
    /** 学生作答列表（累积） */
    responses: StudentResponse[]
    /** 每阶题目数量（可选，用于显示进度） */
    tierQuestionCounts?: Partial<Record<BloomLevel, number>>
}

/** 单阶统计 */
interface TierStat {
    level: BloomLevel
    correct: number
    total: number
    /** 正确率 0-100 */
    rate: number
}

/** 阶中文名 */
const BLOOM_LABELS: Record<BloomLevel, string> = {
    '记忆': '记忆',
    '理解': '理解',
    '应用': '运用',
    '分析': '分析',
    '评价': '评价',
    '创造': '创造',
}

/** 阶描述（用于教学提示） */
const BLOOM_DESCRIPTIONS: Record<BloomLevel, string> = {
    '记忆': '识别与回忆诗篇基本信息（作者、朝代、字句）',
    '理解': '解释诗意，把握意象与情感',
    '应用': '在新情境中运用诗句或意境',
    '分析': '分解诗篇结构，比较异同',
    '评价': '评价诗篇艺术价值与思想深度',
    '创造': '改写、续写、化用诗句创造新作品',
}

function computeTierStats(
    responses: StudentResponse[],
    currentLevel: BloomLevel | undefined,
): TierStat[] {
    const stats: TierStat[] = BLOOM_ORDER.map((level) => ({
        level,
        correct: 0,
        total: 0,
        rate: 0,
    }))

    if (currentLevel) {
        const idx = BLOOM_ORDER.indexOf(currentLevel)
        if (idx >= 0) {
            const stat = stats[idx]
            if (stat) {
                stat.total = responses.length
                stat.correct = responses.filter((r) => r.correct).length
                stat.rate = stat.total > 0 ? Math.round((stat.correct / stat.total) * 100) : 0
            }
        }
    }

    return stats
}

/** 根据正确率返回颜色变量名 */
function rateColor(rate: number): string {
    if (rate >= 80) return 'rgb(var(--c-accent-success))'
    if (rate >= 60) return 'rgb(var(--c-accent-warning))'
    if (rate > 0) return 'rgb(var(--c-accent-error))'
    return 'var(--surface-tertiary-alpha)'
}

export const SixLevelImmersiveMode = memo(function SixLevelImmersiveMode({
    question,
    responses,
    tierQuestionCounts,
}: SixLevelImmersiveModeProps) {
    const currentLevel = question?.bloomLevel
    const tierStats = useMemo(
        () => computeTierStats(responses, currentLevel),
        [responses, currentLevel],
    )

    const currentRate = currentLevel
        ? tierStats.find((t) => t.level === currentLevel)?.rate ?? 0
        : 0

    // store 状态与动作
    const streamComment = useClassroomStore((s) => s.streamComment)
    const abortComment = useClassroomStore((s) => s.abortComment)
    const commentText = useClassroomStore((s) => s.commentText)
    const commentStreaming = useClassroomStore((s) => s.commentStreaming)

    // 卸载时中断 AI 点评
    useEffect(() => {
        return () => {
            abortComment()
        }
    }, [abortComment])

    /** 学生作答后触发 AI 流式点评 —— 根据当前阶与得分选择点评策略 */
    const handleStudentSubmitted = useCallback(
        (_studentId: string, _studentName: string, answer: string, score: number | null) => {
            if (!question) return
            // 根据当前阶选择点评类型
            const commentType = (() => {
                if (score && score >= 90) return 'praise' as const
                if (score && score >= 60) return 'guide' as const
                if (currentLevel === '创造' || currentLevel === '评价') return 'challenge' as const
                return 'correct' as const
            })()
            streamComment({
                studentId: _studentId,
                answer,
                questionId: question.id,
                commentType,
            })
        },
        [streamComment, question, currentLevel],
    )

    /** 当前阶中文标签 */
    const currentLevelLabel = currentLevel ? BLOOM_LABELS[currentLevel] : '待开始'

    /** 当前阶描述 */
    const currentDescription = currentLevel ? BLOOM_DESCRIPTIONS[currentLevel] : '课堂尚未开始'

    /** 已完成阶数 */
    const completedTiers = tierStats.filter((t) => t.total > 0).length

    return (
        <div className="pr-six-level">
            <div className="pr-six-level-header">
                <Icon name="chart-bar" size={18} />
                <span className="pr-six-level-title">
                    六阶沉浸课 · 当前：{currentLevelLabel}
                </span>
                <Badge variant="info" style={{ marginLeft: 'var(--space-sm)' }}>
                    {completedTiers}/{BLOOM_ORDER.length} 阶
                </Badge>
                <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', opacity: 0.8 }}>
                    正确率 {currentRate}%
                </span>
            </div>

            {/* 当前阶描述 */}
            {currentLevel && (
                <div className="pr-six-level-current-desc">
                    <Icon name="info" size={12} />
                    <span>{currentDescription}</span>
                </div>
            )}

            {/* 六阶认知雷达 */}
            <div className="pr-six-level-tiers">
                {tierStats.map((stat) => {
                    const isCurrent = stat.level === currentLevel
                    const color = rateColor(stat.rate)
                    const label = BLOOM_LABELS[stat.level]
                    return (
                        <div
                            key={stat.level}
                            className={`pr-six-level-tier ${isCurrent ? 'pr-six-level-tier--current' : ''}`}
                        >
                            <span className="pr-six-level-tier-name">{label}</span>
                            <div className="pr-six-level-tier-bar">
                                <div
                                    className="pr-six-level-tier-fill"
                                    style={{
                                        transform: `scaleX(${stat.rate / 100})`,
                                        backgroundColor: color,
                                    }}
                                />
                            </div>
                            <span className="pr-six-level-tier-value">
                                {stat.total > 0 ? `${stat.rate}%` : '—'}
                            </span>
                        </div>
                    )
                })}
            </div>

            {/* 阶进度提示 */}
            {tierQuestionCounts && Object.keys(tierQuestionCounts).length > 0 && (
                <div className="pr-six-level-tier-counts">
                    {BLOOM_ORDER.map((level) => {
                        const count = tierQuestionCounts[level]
                        return count ? `${BLOOM_LABELS[level]} ${count}题 ` : ''
                    }).join('· ')}
                </div>
            )}

            {/* AI 流式点评展示区 */}
            {(commentStreaming || commentText) && (
                <div className="pr-six-level-comment">
                    <div className="pr-six-level-comment-header">
                        <Icon name="sparkles" size={14} />
                        <span className="pr-six-level-comment-title">AI 沉浸式点评</span>
                        {commentStreaming && (
                            <span className="pr-six-level-comment-streaming">
                                <span className="pr-six-level-comment-cursor" />
                                流式中
                            </span>
                        )}
                    </div>
                    <p className="pr-six-level-comment-text">{commentText}</p>
                    {commentStreaming && (
                        <button
                            type="button"
                            className="pr-six-level-comment-abort"
                            onClick={abortComment}
                        >
                            <Icon name="stop" size={10} />
                            中断点评
                        </button>
                    )}
                </div>
            )}

            {/* 单设备代答输入 */}
            <StudentInputPanel
                autoFocus
                placeholder="请输入学生姓名..."
                onSubmitted={handleStudentSubmitted}
            />
        </div>
    )
})
