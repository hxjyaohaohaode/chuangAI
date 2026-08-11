/**
 * 诗词大转盘模式（SubTask 19.1 —— 创新 1：诗词大转盘 3D rotate）
 *
 * 设计背景：
 * - "寓教于乐"理念：借鉴幸运转盘玩法，将"随机抽题"包装成"大转盘抽奖"游戏
 * - 单设备场景：教师点击转盘 → 大屏旋转 2 秒 → 命中题目 → 学生作答
 * - 命中后显示题目 → 学生作答 → AI 智能赋分 + 流式点评
 *
 * 创新点：
 * 1. 用 CSS 3D transform: rotateY 制造立体转盘效果（8 等分扇形）
 * 2. 旋转动画使用 cubic-bezier 缓动曲线，营造"减速停止"的物理感
 * 3. 命中扇形高亮 + spring-bounce 弹跳动画
 * 4. "今日幸运题"概念：把随机抽题游戏化，让学生充满期待感
 *
 * 职责：
 * 1. 8 个题目扇形（每个扇形 45°）
 * 2. 点击中心按钮旋转，2 秒后停止
 * 3. 命中题目后显示题干 + 选项
 * 4. 单设备代答输入 + AI 智能赋分
 * 5. AI 流式点评
 *
 * 数据来源：
 * - useClassroomStore.poemId / currentQuestion
 * - useClassroomStore.wheelAngle / wheelSpinning / wheelSelectedIndex
 * - useClassroomStore.spinWheel / scoreAnswer / streamComment
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Icon, Button, Badge } from '@/components/ui'
import { useClassroomStore } from '@/stores/classroom'
import type { ClassroomQuestion } from '@/lib/types'
import { StudentInputPanel } from '../shared/StudentInputPanel'

export interface PoemWheelModeProps {
    /** 当前题目（命中后展示） */
    question: ClassroomQuestion | undefined
}

/** 转盘扇形数量 */
const WHEEL_SECTIONS = 8

/** 扇形颜色（按位置循环） */
const SECTION_COLORS = [
    'var(--accent-primary)',
    'var(--accent-success)',
    'var(--accent-warning)',
    'var(--accent-info)',
    'var(--accent-primary)',
    'var(--accent-success)',
    'var(--accent-warning)',
    'var(--accent-info)',
]

/** 扇形中文字标签（若未拉取到题目列表，用占位） */
const SECTION_PLACEHOLDER_LABELS = [
    '春',
    '夏',
    '秋',
    '冬',
    '风',
    '花',
    '雪',
    '月',
]

/** 简单题目池（本地预填，用于转盘展示；实际命中后由 currentQuestion 决定） */
interface WheelItem {
    /** 显示标签 */
    label: string
    /** 题目 ID（命中后用于跳转） */
    questionId?: string
    /** 颜色 */
    color: string
}

export const PoemWheelMode = memo(function PoemWheelMode({
    question: _question,
}: PoemWheelModeProps) {
    // store 状态与动作
    const wheelAngle = useClassroomStore((s) => s.wheelAngle)
    const wheelSpinning = useClassroomStore((s) => s.wheelSpinning)
    const wheelSelectedIndex = useClassroomStore((s) => s.wheelSelectedIndex)
    const spinWheel = useClassroomStore((s) => s.spinWheel)
    const resetWheel = useClassroomStore((s) => s.resetWheel)
    const streamComment = useClassroomStore((s) => s.streamComment)
    const abortComment = useClassroomStore((s) => s.abortComment)
    const commentText = useClassroomStore((s) => s.commentText)
    const commentStreaming = useClassroomStore((s) => s.commentStreaming)
    const currentQuestion = useClassroomStore((s) => s.currentQuestion)
    const lessonId = useClassroomStore((s) => s.lessonId)

    /** 转盘扇形条目（本地状态，可由后端拉取题目列表填充） */
    const [wheelItems] = useState<WheelItem[]>(() => {
        return Array.from({ length: WHEEL_SECTIONS }, (_, i) => ({
            label: SECTION_PLACEHOLDER_LABELS[i] ?? `题${i + 1}`,
            color: SECTION_COLORS[i] ?? 'var(--accent-primary)',
        }))
    })

    /** 是否已命中并显示题目 */
    const [revealed, setRevealed] = useState(false)

    /** 监听 wheelSelectedIndex 变化，命中后显示题目 */
    useEffect(() => {
        if (wheelSelectedIndex !== null && !wheelSpinning) {
            setRevealed(true)
        }
    }, [wheelSelectedIndex, wheelSpinning])

    /** 卸载时中断 AI 点评 + 重置转盘 */
    useEffect(() => {
        return () => {
            abortComment()
            resetWheel()
        }
    }, [abortComment, resetWheel])

    /** 学生作答后触发 AI 流式点评 */
    const handleStudentSubmitted = useCallback(
        (_studentId: string, _studentName: string, answer: string, score: number | null) => {
            if (!currentQuestion) return
            streamComment({
                studentId: _studentId,
                answer,
                questionId: currentQuestion.id,
                commentType: score && score >= 80 ? 'praise' : score && score >= 60 ? 'guide' : 'challenge',
            })
        },
        [streamComment, currentQuestion],
    )

    /** 重新旋转 */
    const handleRespin = useCallback(() => {
        setRevealed(false)
        resetWheel()
    }, [resetWheel])

    /** 当前命中扇形 */
    const selected = useMemo(() => {
        if (wheelSelectedIndex === null) return null
        return wheelItems[wheelSelectedIndex] ?? null
    }, [wheelSelectedIndex, wheelItems])

    return (
        <div className="pr-poem-wheel">
            <div className="pr-poem-wheel-header">
                <Icon name="sparkles" size={18} />
                <span className="pr-poem-wheel-title">诗词大转盘</span>
                <Badge variant="primary" style={{ marginLeft: 'var(--space-sm)' }}>
                    寓教于乐
                </Badge>
                <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'rgb(var(--c-text-secondary))' }}>
                    点击中心按钮旋转
                </span>
            </div>

            {/* 大转盘 3D 容器 */}
            <div className="pr-poem-wheel-stage">
                {/* 转盘指针 */}
                <div className="pr-poem-wheel-pointer" aria-hidden="true">
                    <Icon name="caret-down" size={24} />
                </div>

                {/* 转盘主体 */}
                <div
                    className={`pr-poem-wheel-rotor ${wheelSpinning ? 'is-spinning' : ''} ${wheelSelectedIndex !== null ? 'is-selected' : ''}`}
                    style={{
                        transform: `rotate(${wheelAngle}deg)`,
                        transition: wheelSpinning
                            ? 'transform 2s cubic-bezier(0.16, 1, 0.3, 1)'
                            : 'none',
                    }}
                >
                    {wheelItems.map((item, idx) => {
                        const isSelected = wheelSelectedIndex === idx
                        const sectionAngle = (360 / WHEEL_SECTIONS) * idx
                        return (
                            <div
                                key={idx}
                                className={`pr-poem-wheel-section ${isSelected ? 'is-selected' : ''}`}
                                style={{
                                    transform: `rotate(${sectionAngle}deg)`,
                                    background: `conic-gradient(from 0deg, ${item.color} 0deg, ${item.color} 45deg, transparent 45deg)`,
                                }}
                            >
                                <span
                                    className="pr-poem-wheel-section-label"
                                    style={{ transform: `rotate(${sectionAngle + 22.5}deg)` }}
                                >
                                    {item.label}
                                </span>
                            </div>
                        )
                    })}
                    {/* 中心圆 */}
                    <button
                        type="button"
                        className="pr-poem-wheel-center"
                        onClick={spinWheel}
                        disabled={wheelSpinning}
                        aria-label="旋转大转盘"
                    >
                        <span className="pr-poem-wheel-center-inner">
                            {wheelSpinning ? (
                                <Icon name="clock" size={20} />
                            ) : (
                                <Icon name="bolt" size={20} />
                            )}
                        </span>
                        <span className="pr-poem-wheel-center-text">
                            {wheelSpinning ? '旋转中' : 'GO'}
                        </span>
                    </button>
                </div>
            </div>

            {/* 命中提示 */}
            {selected && !wheelSpinning && (
                <div className="pr-poem-wheel-result">
                    <Icon name="star" size={14} />
                    <span>本轮幸运字：</span>
                    <span className="pr-poem-wheel-result-label">{selected.label}</span>
                </div>
            )}

            {/* 命中题目展示 + 单设备代答 */}
            {revealed && currentQuestion && (
                <div className="pr-poem-wheel-question">
                    <div className="pr-poem-wheel-question-header">
                        <Icon name="book-open" size={14} />
                        <span className="pr-poem-wheel-question-title">命中题目</span>
                        <Badge variant="info" style={{ marginLeft: 'var(--space-sm)' }}>
                            {currentQuestion.bloomLevel}
                        </Badge>
                        <Button
                            variant="ghost"
                            size="sm"
                            style={{ marginLeft: 'auto' }}
                            onClick={handleRespin}
                            leftIcon={<Icon name="refresh" size={12} />}
                        >
                            再转一次
                        </Button>
                    </div>
                    <div className="pr-poem-wheel-question-stem">{currentQuestion.stem}</div>
                    {currentQuestion.options && currentQuestion.options.length > 0 && (
                        <div className="pr-poem-wheel-question-options">
                            {currentQuestion.options.map((opt, idx) => (
                                <div key={idx} className="pr-poem-wheel-question-option">
                                    <span className="pr-poem-wheel-question-option-key">
                                        {String.fromCharCode(65 + idx)}
                                    </span>
                                    <span>{opt}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* AI 流式点评 */}
                    {(commentStreaming || commentText) && (
                        <div className="pr-poem-wheel-comment">
                            <div className="pr-poem-wheel-comment-header">
                                <Icon name="sparkles" size={14} />
                                <span className="pr-poem-wheel-comment-title">AI 点评</span>
                                {commentStreaming && (
                                    <span className="pr-poem-wheel-comment-streaming">
                                        <span className="pr-poem-wheel-comment-cursor" />
                                        流式中
                                    </span>
                                )}
                            </div>
                            <p className="pr-poem-wheel-comment-text">{commentText}</p>
                        </div>
                    )}

                    {/* 单设备代答输入 */}
                    <StudentInputPanel
                        autoFocus
                        placeholder="请输入学生姓名..."
                        onSubmitted={handleStudentSubmitted}
                    />
                </div>
            )}

            {/* 教师控制按钮 */}
            {lessonId && !revealed && (
                <div className="pr-poem-wheel-actions">
                    <Button
                        variant="primary"
                        onClick={spinWheel}
                        loading={wheelSpinning}
                        leftIcon={<Icon name="bolt" size={14} />}
                    >
                        {wheelSpinning ? '旋转中...' : '旋转大转盘'}
                    </Button>
                </div>
            )}
        </div>
    )
})
