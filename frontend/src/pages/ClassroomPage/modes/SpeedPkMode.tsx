/**
 * 速答 PK 模式（SubTask 18.4 —— 单设备 + AI 抢答 + 智能赋分）
 *
 * 设计背景：
 * - 单设备场景：教师大屏一台，学生无电子设备
 * - 抢答机制：学生举手 → 教师代答输入 → AI 智能赋分（含响应时延加分）
 * - AI 虚拟对手作为陪练：自动抢答，形成"学生 vs AI"竞争张力
 * - 实时积分榜：前 3 名金/银/铜徽章
 *
 * 职责：
 * 1. 抢答倒计时（10 秒，剩余 3 秒进入紧迫态）
 * 2. 单设备代答输入（StudentInputPanel，含时延记录）
 * 3. AI 虚拟对手抢答（自动触发，按难度档位有不同响应时延）
 * 4. 智能赋分：分数 = 基础分(60) + 时延加分(0-30) + 准确性加分(0-10)
 * 5. 实时积分榜（按分数降序，前 3 名特殊高亮）
 *
 * 设计要点：
 * - 抢答倒计时归零自动触发 AI 抢答
 * - 教师可"暂停抢答"，暂停时禁止输入
 * - AI 抢答的时延由难度档位决定（easy: 3.5-6s, medium: 2-4s, hard: 0.8-2s）
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, Button, Badge } from '@/components/ui'
import { useClassroomStore } from '@/stores/classroom'
import type { StudentResponse } from '@/lib/types'
import { StudentInputPanel } from '../shared/StudentInputPanel'
import { AIVirtualOpponent } from '../shared/AIVirtualOpponent'

export interface SpeedPkModeProps {
    /** 当前题目的学生作答列表 */
    responses: StudentResponse[]
    /** 总学生数 */
    totalStudents: number
}

/** 抢答倒计时秒数 */
const RACE_COUNTDOWN_SEC = 10

/** 紧迫态阈值 */
const URGENT_THRESHOLD_SEC = 3

/** 排名条目 */
interface RankEntry {
    studentId: string
    studentName: string
    score: number
    correctCount: number
    totalCount: number
    /** 是否 AI 对手 */
    isAI: boolean
}

export const SpeedPkMode = memo(function SpeedPkMode({
    responses,
    totalStudents,
}: SpeedPkModeProps) {
    // store 状态与动作
    const triggerAIOpponent = useClassroomStore((s) => s.triggerAIOpponent)
    const aiOpponent = useClassroomStore((s) => s.aiOpponent)
    const aiThinking = useClassroomStore((s) => s.aiOpponentThinking)
    const currentQuestion = useClassroomStore((s) => s.currentQuestion)
    const scoreAnswer = useClassroomStore((s) => s.scoreAnswer)

    /** 抢答倒计时 */
    const [raceCountdown, setRaceCountdown] = useState(RACE_COUNTDOWN_SEC)
    /** 是否暂停抢答 */
    const [paused, setPaused] = useState(false)
    /** AI 触发标记 */
    const aiTriggeredRef = useRef(false)
    /** 题目起始时间戳 */
    const questionStartRef = useRef<number>(Date.now())

    /** 聚合每个学生的得分（按 studentId 分组） */
    const leaderboard = useMemo<RankEntry[]>(() => {
        const map = new Map<string, RankEntry>()
        for (const r of responses) {
            const isAI = r.studentId === 'ai-opponent'
            const existing = map.get(r.studentId)
            const score = r.score ?? (r.correct ? 60 : 0)
            if (existing) {
                existing.score += score
                existing.totalCount += 1
                if (r.correct) existing.correctCount += 1
            } else {
                map.set(r.studentId, {
                    studentId: r.studentId,
                    studentName: r.studentName ?? (isAI ? 'AI 对手' : `学生${r.studentId.slice(-4)}`),
                    score,
                    correctCount: r.correct ? 1 : 0,
                    totalCount: 1,
                    isAI,
                })
            }
        }
        return Array.from(map.values()).sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score
            // 并列时正确率降序
            const aRate = a.totalCount > 0 ? a.correctCount / a.totalCount : 0
            const bRate = b.totalCount > 0 ? b.correctCount / b.totalCount : 0
            return bRate - aRate
        })
    }, [responses])

    const respondedCount = leaderboard.length

    /** 抢答倒计时 */
    useEffect(() => {
        if (paused) return
        if (raceCountdown <= 0) return
        const timer = window.setTimeout(() => {
            setRaceCountdown((prev) => Math.max(0, prev - 1))
        }, 1000)
        return () => window.clearTimeout(timer)
    }, [raceCountdown, paused])

    /** 倒计时归零时自动触发 AI 抢答 */
    useEffect(() => {
        if (raceCountdown === 0 && aiOpponent.enabled && !aiTriggeredRef.current && currentQuestion) {
            aiTriggeredRef.current = true
            void triggerAIOpponent({
                mode: 'speed-pk',
                level: aiOpponent.level,
                questionId: currentQuestion.id,
                questionStem: currentQuestion.stem,
                options: currentQuestion.options,
            })
        }
    }, [raceCountdown, aiOpponent.enabled, aiOpponent.level, currentQuestion, triggerAIOpponent])

    /** 题目变化时重置倒计时与触发标记 */
    useEffect(() => {
        setRaceCountdown(RACE_COUNTDOWN_SEC)
        aiTriggeredRef.current = false
        questionStartRef.current = Date.now()
        setPaused(false)
    }, [currentQuestion?.id])

    /** 教师代答提交后：智能赋分（含响应时延） */
    const handleStudentSubmitted = useCallback(
        async (studentId: string, _studentName: string, answer: string, _score: number | null) => {
            if (!currentQuestion) return
            // 计算响应时延
            const latencyMs = Date.now() - questionStartRef.current
            await scoreAnswer({
                studentId,
                answer,
                questionId: currentQuestion.id,
                referenceAnswer: currentQuestion.answer,
                questionType: currentQuestion.type,
                mode: 'speed-pk',
                latencyMs,
            })
        },
        [currentQuestion, scoreAnswer],
    )

    /** 手动触发 AI 抢答 */
    const handleTriggerAI = useCallback(() => {
        if (!currentQuestion) return
        void triggerAIOpponent({
            mode: 'speed-pk',
            level: aiOpponent.level,
            questionId: currentQuestion.id,
            questionStem: currentQuestion.stem,
            options: currentQuestion.options,
        })
    }, [triggerAIOpponent, aiOpponent.level, currentQuestion])

    /** 重新开始本轮抢答 */
    const handleRestart = useCallback(() => {
        setRaceCountdown(RACE_COUNTDOWN_SEC)
        aiTriggeredRef.current = false
        questionStartRef.current = Date.now()
        setPaused(false)
    }, [])

    const isUrgent = raceCountdown <= URGENT_THRESHOLD_SEC && raceCountdown > 0
    const showRaceBanner = raceCountdown > 0 || (raceCountdown === 0 && respondedCount === 0)

    return (
        <div className="pr-speed-pk">
            {/* 抢答倒计时大屏 */}
            {showRaceBanner && (
                <div className={`pr-speed-pk-race-banner ${isUrgent ? 'is-urgent' : ''} ${paused ? 'is-paused' : ''}`}>
                    <Icon name="bolt" size={20} />
                    <span className="pr-speed-pk-race-title">
                        {paused ? '抢答已暂停' : raceCountdown === 0 ? '抢答结束' : '抢答中'}
                    </span>
                    <span className="pr-speed-pk-race-countdown">
                        {String(raceCountdown).padStart(2, '0')}
                    </span>
                    <span style={{ fontSize: 'var(--text-xs)', opacity: 0.8 }}>
                        {respondedCount}/{totalStudents} 已抢答
                    </span>
                    <div className="pr-speed-pk-race-actions">
                        {raceCountdown > 0 && (
                            <button
                                type="button"
                                className="pr-speed-pk-race-pause"
                                onClick={() => setPaused(!paused)}
                            >
                                <Icon name={paused ? 'play' : 'pause'} size={12} />
                                {paused ? '继续' : '暂停'}
                            </button>
                        )}
                        {raceCountdown === 0 && (
                            <button
                                type="button"
                                className="pr-speed-pk-race-restart"
                                onClick={handleRestart}
                            >
                                <Icon name="refresh" size={12} />
                                重抢
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* AI 抢答中提示 */}
            {aiThinking && (
                <div className="pr-speed-pk-ai-thinking">
                    <span className="pr-speed-pk-ai-thinking-dot" />
                    AI 正在抢答...
                </div>
            )}

            {/* 单设备代答输入 + AI 对手 */}
            <div className="pr-speed-pk-input-row">
                <StudentInputPanel
                    autoFocus
                    enabled={!paused}
                    placeholder="请输入抢答学生姓名..."
                    onSubmitted={(sid, name, ans, score) => {
                        void handleStudentSubmitted(sid, name, ans, score)
                    }}
                />
                <AIVirtualOpponent
                    compact
                    showTriggerButton
                    onTrigger={handleTriggerAI}
                />
            </div>

            {/* 积分榜 */}
            {leaderboard.length === 0 ? (
                <div
                    style={{
                        padding: 'var(--space-md)',
                        textAlign: 'center',
                        color: 'rgb(var(--c-text-tertiary))',
                        fontSize: 'var(--text-sm)',
                    }}
                >
                    等待第一位抢答者...
                </div>
            ) : (
                <div className="pr-speed-pk-leaderboard">
                    <div className="pr-speed-pk-leader-header">
                        <Icon name="trophy" size={14} />
                        <span className="pr-speed-pk-leader-title">速答 PK 榜</span>
                        <Badge variant="default" style={{ marginLeft: 'auto' }}>
                            {leaderboard.length} 人
                        </Badge>
                    </div>
                    {leaderboard.slice(0, 10).map((entry, idx) => {
                        const rank = idx + 1
                        return (
                            <div
                                key={entry.studentId}
                                className={`pr-speed-pk-leaderboard-item ${entry.isAI ? 'is-ai' : ''}`}
                            >
                                <span className={`pr-speed-pk-rank pr-speed-pk-rank--${rank <= 3 ? rank : ''}`}>
                                    {rank}
                                </span>
                                <span className="pr-speed-pk-name">
                                    {entry.isAI && (
                                        <span style={{ marginRight: 4, display: 'inline-flex', alignItems: 'center' }}>
                                            <Icon name="robot" size={12} />
                                        </span>
                                    )}
                                    {entry.studentName}
                                    {entry.isAI && (
                                        <Badge variant="info" style={{ marginLeft: 'var(--space-xs)' }}>
                                            AI
                                        </Badge>
                                    )}
                                </span>
                                <span className="pr-speed-pk-correct">
                                    {entry.correctCount}/{entry.totalCount} 正确
                                </span>
                                <span className="pr-speed-pk-score">{entry.score}</span>
                            </div>
                        )
                    })}
                </div>
            )}

            {/* 教师控制按钮 */}
            <div className="pr-speed-pk-actions">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleRestart}
                    leftIcon={<Icon name="refresh" size={12} />}
                >
                    重新抢答
                </Button>
            </div>
        </div>
    )
})
