/**
 * AI 虚拟对手面板（v5.0 Task 18-20）
 *
 * 设计背景：
 * - 单设备场景下学生无电子设备，无法形成真实的"学生 PK 学生"竞争
 * - 引入 AI 虚拟对手作为陪练，让课堂有"对手"，形成"学生 vs AI"的张力
 * - 难度可调：新秀 / 老练 / 诗仙（高难度、近乎无敌）
 *
 * 职责：
 * 1. 开关 AI 对手（启用/禁用陪练）
 * 2. 选择难度档位（easy/medium/hard）
 * 3. 显示 AI 累计统计：分数 / 正确率 / 平均响应时延
 * 4. 显示"思考中"动画（等待 API 响应）
 * 5. 显示最近一次作答内容与判定结果
 *
 * 设计要点（规范第 7 章）：
 * - 启用态使用 accent-primary 10% 背景暗示
 * - "思考中"使用脉动动画 + spring-bounce 缓动
 * - 难度切换 150ms transition
 */

import { memo, useMemo } from 'react'
import { Icon, Badge } from '@/components/ui'
import { useClassroomStore } from '@/stores/classroom'
import { AI_OPPONENT_LEVEL_LABELS } from '@/lib/types'
import type { AIOpponentLevel } from '@/lib/types'

export interface AIVirtualOpponentProps {
    /** 紧凑模式（横向排列，节省垂直空间） */
    compact?: boolean
    /** 显示"立即让 AI 作答"按钮（可选，由父组件控制） */
    showTriggerButton?: boolean
    /** 立即触发 AI 作答回调 */
    onTrigger?: () => void
}

/** 难度档位列表（用于按钮组） */
const LEVELS: AIOpponentLevel[] = ['easy', 'medium', 'hard']

/** 难度对应颜色变量名 */
const LEVEL_COLOR: Record<AIOpponentLevel, string> = {
    easy: 'accent-success',
    medium: 'accent-warning',
    hard: 'accent-error',
}

export const AIVirtualOpponent = memo(function AIVirtualOpponent({
    compact = false,
    showTriggerButton = false,
    onTrigger,
}: AIVirtualOpponentProps) {
    const aiOpponent = useClassroomStore((s) => s.aiOpponent)
    const thinking = useClassroomStore((s) => s.aiOpponentThinking)
    const setEnabled = useClassroomStore((s) => s.setAIOpponentEnabled)
    const setLevel = useClassroomStore((s) => s.setAIOpponentLevel)
    const reset = useClassroomStore((s) => s.resetAIOpponent)

    /** 正确率 */
    const accuracy = useMemo(() => {
        if (aiOpponent.totalCount === 0) return 0
        return Math.round((aiOpponent.correctCount / aiOpponent.totalCount) * 100)
    }, [aiOpponent.correctCount, aiOpponent.totalCount])

    /** 平均响应时间（秒） */
    const avgLatencySec = useMemo(() => {
        return Math.round(aiOpponent.avgLatencyMs / 100) / 10
    }, [aiOpponent.avgLatencyMs])

    const levelColor = LEVEL_COLOR[aiOpponent.level]

    return (
        <div
            className={`pr-ai-opponent ${aiOpponent.enabled ? 'is-enabled' : ''} ${compact ? 'is-compact' : ''}`}
            style={
                aiOpponent.enabled
                    ? { backgroundColor: `var(--${levelColor}-10)` }
                    : undefined
            }
        >
            <div className="pr-ai-opponent-header">
                <div className="pr-ai-opponent-avatar">
                    <Icon name="robot" size={compact ? 16 : 20} />
                </div>
                <div className="pr-ai-opponent-info">
                    <span className="pr-ai-opponent-name">
                        {aiOpponent.name}
                        {thinking && (
                            <span className="pr-ai-opponent-thinking-badge">
                                <span className="pr-ai-opponent-thinking-dot" />
                                思考中
                            </span>
                        )}
                    </span>
                    <span className="pr-ai-opponent-level">
                        {AI_OPPONENT_LEVEL_LABELS[aiOpponent.level]}
                    </span>
                </div>
                <button
                    type="button"
                    className={`pr-ai-opponent-toggle ${aiOpponent.enabled ? 'is-on' : 'is-off'}`}
                    onClick={() => setEnabled(!aiOpponent.enabled)}
                    aria-label={aiOpponent.enabled ? '关闭陪练' : '启用陪练'}
                >
                    <span className="pr-ai-opponent-toggle-knob" />
                </button>
            </div>

            {aiOpponent.enabled && (
                <>
                    {/* 难度档位 */}
                    <div className="pr-ai-opponent-levels">
                        {LEVELS.map((lv) => (
                            <button
                                key={lv}
                                type="button"
                                className={`pr-ai-opponent-level-btn ${aiOpponent.level === lv ? 'is-active' : ''}`}
                                onClick={() => setLevel(lv)}
                                data-level={lv}
                            >
                                {AI_OPPONENT_LEVEL_LABELS[lv]}
                            </button>
                        ))}
                    </div>

                    {/* 统计 */}
                    <div className="pr-ai-opponent-stats">
                        <div className="pr-ai-opponent-stat">
                            <span className="pr-ai-opponent-stat-label">累计分</span>
                            <span className="pr-ai-opponent-stat-value">{aiOpponent.score}</span>
                        </div>
                        <div className="pr-ai-opponent-stat">
                            <span className="pr-ai-opponent-stat-label">正确率</span>
                            <span className="pr-ai-opponent-stat-value">{accuracy}%</span>
                        </div>
                        <div className="pr-ai-opponent-stat">
                            <span className="pr-ai-opponent-stat-label">均耗时</span>
                            <span className="pr-ai-opponent-stat-value">{avgLatencySec}s</span>
                        </div>
                        <div className="pr-ai-opponent-stat">
                            <span className="pr-ai-opponent-stat-label">答题数</span>
                            <span className="pr-ai-opponent-stat-value">{aiOpponent.totalCount}</span>
                        </div>
                    </div>

                    {/* 触发按钮（可选） */}
                    {showTriggerButton && (
                        <button
                            type="button"
                            className="pr-ai-opponent-trigger"
                            onClick={onTrigger}
                            disabled={thinking}
                        >
                            <Icon name="bolt" size={14} />
                            {thinking ? 'AI 思考中...' : '让 AI 作答'}
                        </button>
                    )}

                    {/* 重置 */}
                    {!compact && aiOpponent.totalCount > 0 && (
                        <button
                            type="button"
                            className="pr-ai-opponent-reset"
                            onClick={reset}
                            aria-label="重置 AI 对手统计"
                        >
                            <Icon name="refresh" size={12} />
                            重置统计
                        </button>
                    )}
                </>
            )}

            {!aiOpponent.enabled && (
                <div className="pr-ai-opponent-disabled-hint">
                    <Icon name="info" size={12} />
                    <span>开启后 AI 将作为陪练与学生同台竞技</span>
                </div>
            )}

            {/* 装饰：Badge 标识 */}
            {aiOpponent.enabled && !compact && (
                <Badge variant="info" style={{ position: 'absolute', top: 8, right: 8 }}>
                    陪练
                </Badge>
            )}
        </div>
    )
})
