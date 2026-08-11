/**
 * 集体闯关模式（SubTask 18.1 —— 单设备 + AI 对手 + 智能赋分）
 *
 * 设计背景：
 * - 课堂只有教师大屏一台电子设备，学生无任何电子设备
 * - 教师代为输入学生作答 → AI 智能赋分（0-100）→ 实时积分榜
 * - AI 虚拟对手作为陪练，让学生有"竞争对象"的张力
 *
 * 职责：
 * 1. 60 秒倒计时（基于当前题目 estimatedTimeSec），剩余 10 秒进入紧迫态
 * 2. 单设备代答输入（StudentInputPanel）
 * 3. AI 虚拟对手陪练（AIVirtualOpponent，倒计时归零自动作答）
 * 4. 实时积分榜（RealtimeLeaderboard，混合学生与 AI 对手）
 * 5. AI 流式点评（学生作答后触发，SSE 增量输出）
 *
 * 设计要点（规范第 5、6、12 章）：
 * - 倒计时使用 transform/opacity 动画，GPU 友好
 * - 紧迫态颜色由 accent-primary 切换至 accent-error
 * - 数据同步：store.responses 变化 → 积分榜即时更新（≤50ms）
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Icon, Button } from '@/components/ui'
import { useClassroomStore } from '@/stores/classroom'
import { getRemainingCountdownSeconds, normalizeCountdownSeconds } from '@/lib/countdown'
import type { ClassroomQuestion } from '@/lib/types'
import { StudentInputPanel } from '../shared/StudentInputPanel'
import { AIVirtualOpponent } from '../shared/AIVirtualOpponent'
import { RealtimeLeaderboard } from '../shared/RealtimeLeaderboard'

export interface CollectiveRaceModeProps {
    /** 当前题目 */
    question: ClassroomQuestion | undefined
    /** 当前题目序号（0-based） */
    questionIndex: number
    /** 已答题学生数 */
    responseCount: number
    /** 总学生数 */
    totalStudents: number
    /** 题目切换时重置倒计时 */
    onTimeout?: () => void
}

/** 默认倒计时秒数（题目无 estimatedTimeSec 时使用） */
const DEFAULT_TIMEOUT_SEC = 60

/** 紧迫态阈值（剩余秒数） */
const URGENT_THRESHOLD_SEC = 10

export const CollectiveRaceMode = memo(function CollectiveRaceMode({
    question,
    questionIndex,
    responseCount,
    totalStudents,
    onTimeout,
}: CollectiveRaceModeProps) {
    const totalSec = normalizeCountdownSeconds(question?.estimatedTimeSec, DEFAULT_TIMEOUT_SEC)
    const [remaining, setRemaining] = useState(totalSec)
    const timerRef = useRef<number | null>(null)
    const deadlineRef = useRef(0)
    const onTimeoutRef = useRef(onTimeout)
    const timeoutNotifiedRef = useRef(false)
    const aiTriggeredRef = useRef(false)

    // store 状态与动作
    const streamComment = useClassroomStore((s) => s.streamComment)
    const abortComment = useClassroomStore((s) => s.abortComment)
    const commentText = useClassroomStore((s) => s.commentText)
    const commentStreaming = useClassroomStore((s) => s.commentStreaming)
    const triggerAIOpponent = useClassroomStore((s) => s.triggerAIOpponent)
    const currentQuestion = useClassroomStore((s) => s.currentQuestion)
    const aiOpponent = useClassroomStore((s) => s.aiOpponent)

    useEffect(() => {
        onTimeoutRef.current = onTimeout
    }, [onTimeout])

    const clearCountdownTimer = useCallback(() => {
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current)
            timerRef.current = null
        }
    }, [])

    // 题目切换时重置倒计时与 AI 触发标记。剩余时间来自绝对截止时间，
    // 因此后台标签页即使被浏览器节流，也不会把 60 秒错误延长为数分钟。
    useEffect(() => {
        setRemaining(totalSec)
        timeoutNotifiedRef.current = false
        aiTriggeredRef.current = false
        clearCountdownTimer()
        deadlineRef.current = Date.now() + totalSec * 1000
        let disposed = false

        const schedule = () => {
            if (disposed) return
            clearCountdownTimer()
            const next = getRemainingCountdownSeconds(deadlineRef.current, Date.now())
            setRemaining(next)
            if (next <= 0 || document.visibilityState === 'hidden') return
            timerRef.current = window.setTimeout(schedule, 1000)
        }

        const handleVisibilityChange = () => {
            clearCountdownTimer()
            if (document.visibilityState !== 'hidden') schedule()
        }

        document.addEventListener('visibilitychange', handleVisibilityChange)
        timerRef.current = window.setTimeout(schedule, 1000)

        return () => {
            disposed = true
            document.removeEventListener('visibilitychange', handleVisibilityChange)
            clearCountdownTimer()
        }
    }, [clearCountdownTimer, totalSec, question?.id, questionIndex])

    // 副作用不能在 setState 的函数式更新器中触发，否则会在子组件渲染期间
    // 更新父级课堂状态并产生 React 跨组件更新告警。
    useEffect(() => {
        if (remaining !== 0 || timeoutNotifiedRef.current) return
        timeoutNotifiedRef.current = true
        onTimeoutRef.current?.()
    }, [remaining])

    // 卸载时中断 AI 点评
    useEffect(() => {
        return () => {
            abortComment()
        }
    }, [abortComment])

    /** 学生作答后触发 AI 流式点评 */
    const handleStudentSubmitted = useCallback(
        (_studentId: string, _studentName: string, answer: string, _score: number | null) => {
            if (!currentQuestion) return
            streamComment(
                {
                    studentId: _studentId,
                    answer,
                    questionId: currentQuestion.id,
                    commentType: _score && _score >= 80 ? 'praise' : _score && _score >= 60 ? 'guide' : 'correct',
                },
            )
        },
        [streamComment, currentQuestion],
    )

    /** 倒计时归零时自动触发 AI 对手作答（仅启用陪练且未触发过时） */
    useEffect(() => {
        if (remaining === 0 && aiOpponent.enabled && !aiTriggeredRef.current && currentQuestion) {
            aiTriggeredRef.current = true
            void triggerAIOpponent({
                mode: 'collective-race',
                level: aiOpponent.level,
                questionId: currentQuestion.id,
                questionStem: currentQuestion.stem,
                options: currentQuestion.options,
            })
        }
    }, [remaining, aiOpponent.enabled, aiOpponent.level, currentQuestion, triggerAIOpponent])

    /** 手动触发 AI 作答 */
    const handleTriggerAI = useCallback(() => {
        if (!currentQuestion) return
        void triggerAIOpponent({
            mode: 'collective-race',
            level: aiOpponent.level,
            questionId: currentQuestion.id,
            questionStem: currentQuestion.stem,
            options: currentQuestion.options,
        })
    }, [triggerAIOpponent, aiOpponent.level, currentQuestion])

    const isUrgent = remaining <= URGENT_THRESHOLD_SEC && remaining > 0
    const minutes = Math.floor(remaining / 60)
    const seconds = remaining % 60
    const timeStr = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`

    const progressPercent = totalSec > 0 ? ((totalSec - remaining) / totalSec) * 100 : 0

    return (
        <div className="pr-collective-race">
            <div className={`pr-collective-race-timer ${isUrgent ? 'pr-collective-race-timer--urgent' : ''}`}>
                <Icon name="clock" size={18} />
                <span className="pr-collective-race-timer-value">{timeStr}</span>
                <span style={{ fontSize: 'var(--text-xs)', opacity: 0.8 }}>
                    {responseCount}/{totalStudents} 已作答
                </span>
            </div>
            <div className="pr-stage-progress-bar" style={{ width: '100%' }}>
                <div
                    className="pr-stage-progress-fill"
                    style={{
                        transform: `scaleX(${progressPercent / 100})`,
                        backgroundColor: isUrgent ? 'rgb(var(--c-accent-error))' : undefined,
                    }}
                />
            </div>

            {/* AI 流式点评展示区 */}
            {(commentStreaming || commentText) && (
                <div className="pr-collective-race-comment">
                    <div className="pr-collective-race-comment-header">
                        <Icon name="sparkles" size={14} />
                        <span className="pr-collective-race-comment-title">AI 实时点评</span>
                        {commentStreaming && (
                            <span className="pr-collective-race-comment-streaming">
                                <span className="pr-collective-race-comment-cursor" />
                                流式中
                            </span>
                        )}
                    </div>
                    <p className="pr-collective-race-comment-text">{commentText}</p>
                </div>
            )}

            {/* 单设备代答输入 + AI 对手 */}
            <div className="pr-collective-race-input-row">
                <StudentInputPanel
                    autoFocus
                    placeholder="请输入学生姓名..."
                    onSubmitted={handleStudentSubmitted}
                />
                <AIVirtualOpponent
                    compact
                    showTriggerButton
                    onTrigger={handleTriggerAI}
                />
            </div>

            {/* 实时积分榜 */}
            <RealtimeLeaderboard
                title="群赛积分榜"
                maxItems={8}
                compact={false}
            />

            {/* 结束倒计时按钮 */}
            {remaining > 0 && (
                <div className="pr-collective-race-actions">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            deadlineRef.current = Date.now()
                            setRemaining(0)
                            clearCountdownTimer()
                        }}
                        leftIcon={<Icon name="stop" size={12} />}
                    >
                        结束本题
                    </Button>
                </div>
            )}
        </div>
    )
})
