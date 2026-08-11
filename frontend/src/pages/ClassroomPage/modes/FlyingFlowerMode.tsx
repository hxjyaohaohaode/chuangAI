/**
 * 飞花令擂台模式（SubTask 18.2 —— 单设备 + AI 对手接花 + AI 判断）
 *
 * 设计背景：
 * - 单设备场景：教师大屏一台，学生无电子设备
 * - 教师代为输入学生接的诗句 → AI 判断是否符合"关键字接花"规则
 * - AI 虚拟对手作为陪练，能立即"接花"形成对擂张力
 * - 擂主榜混合学生与 AI 对手，streak 越长越显眼
 *
 * 职责：
 * 1. 关键字大屏突出（accent-primary + display 字体大字号）
 * 2. 单设备代答输入（StudentInputPanel）
 * 3. AI 虚拟对手接花（触发 triggerAIOpponent，传入 flyingFlowerKeyword）
 * 4. AI 判断：调用智能赋分判断是否含关键字、是否符合格律（scoreAnswer）
 * 5. 实时积分榜（按 streak 排序）
 *
 * 设计要点：
 * - streak 计算：连续正确累加，错误清零
 * - 关键字区域使用渐变背景 + 大字号
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Icon, Button, Badge } from '@/components/ui'
import { useClassroomStore } from '@/stores/classroom'
import type { StudentResponse } from '@/lib/types'
import { StudentInputPanel } from '../shared/StudentInputPanel'
import { AIVirtualOpponent } from '../shared/AIVirtualOpponent'

export interface FlyingFlowerModeProps {
    /** 飞花令关键字 */
    keyword: string | undefined
    /** 学生作答列表 */
    responses: StudentResponse[]
    /** 总学生数 */
    totalStudents: number
}

/** 擂主榜条目 */
interface LeaderEntry {
    studentId: string
    studentName: string
    /** 连续答对数（streak） */
    streak: number
    /** 答对总数 */
    correctCount: number
    /** 是否 AI 对手 */
    isAI: boolean
}

/**
 * 计算每个学生的 streak（连续答对数）
 *
 * 算法：按 studentId 分组 + at 升序，correct=true 时 streak++，correct=false 时 streak=0
 */
function computeStreaks(responses: StudentResponse[]): LeaderEntry[] {
    const map = new Map<string, LeaderEntry>()
    const grouped = new Map<string, StudentResponse[]>()

    for (const r of responses) {
        const arr = grouped.get(r.studentId)
        if (arr) {
            arr.push(r)
        } else {
            grouped.set(r.studentId, [r])
        }
    }

    for (const [studentId, arr] of grouped) {
        arr.sort((a, b) => a.at - b.at)
        let maxStreak = 0
        let currentStreak = 0
        let correctCount = 0
        for (const r of arr) {
            if (r.correct) {
                currentStreak += 1
                correctCount += 1
                if (currentStreak > maxStreak) maxStreak = currentStreak
            } else {
                currentStreak = 0
            }
        }
        const lastName = arr[arr.length - 1]?.studentName
        const isAI = studentId === 'ai-opponent'
        map.set(studentId, {
            studentId,
            studentName: lastName ?? (isAI ? 'AI 对手' : `学生${studentId.slice(-4)}`),
            streak: maxStreak,
            correctCount,
            isAI,
        })
    }

    return Array.from(map.values()).sort((a, b) => {
        if (b.streak !== a.streak) return b.streak - a.streak
        return b.correctCount - a.correctCount
    })
}

/** AI 判断关键字命中（本地快速校验，作为赋分补充） */
function checkKeywordHit(answer: string, keyword: string | undefined): boolean {
    if (!keyword) return false
    return answer.includes(keyword)
}

export const FlyingFlowerMode = memo(function FlyingFlowerMode({
    keyword,
    responses,
    totalStudents,
}: FlyingFlowerModeProps) {
    const leaderboard = useMemo(() => computeStreaks(responses), [responses])
    const respondedCount = leaderboard.length

    // store 状态与动作
    const triggerAIOpponent = useClassroomStore((s) => s.triggerAIOpponent)
    const aiOpponent = useClassroomStore((s) => s.aiOpponent)
    const aiThinking = useClassroomStore((s) => s.aiOpponentThinking)
    const scoreAnswer = useClassroomStore((s) => s.scoreAnswer)
    const currentQuestion = useClassroomStore((s) => s.currentQuestion)
    const lessonId = useClassroomStore((s) => s.lessonId)

    /** AI 自动接花标记（避免重复触发） */
    const [aiAutoTriggered, setAIAutoTriggered] = useState<Set<string>>(new Set())

    /** 教师代答提交后：AI 判断 + 自动触发 AI 接花 */
    const handleStudentSubmitted = useCallback(
        async (studentId: string, _studentName: string, answer: string, _score: number | null) => {
            // 1. AI 判断是否含关键字（本地快速校验）
            const hit = checkKeywordHit(answer, keyword)
            if (currentQuestion) {
                await scoreAnswer({
                    studentId,
                    answer,
                    questionId: currentQuestion.id,
                    referenceAnswer: keyword ? `含「${keyword}」字的诗句` : undefined,
                    mode: 'flying-flower',
                })
            }
            // 2. 若未含关键字，提示教师
            if (!hit && keyword) {
                // 由赋分结果反馈，不弹 toast 避免刷屏
            }
            // 3. 学生答完后，自动触发 AI 接花（作为陪练张力）
            if (aiOpponent.enabled && !aiAutoTriggered.has(studentId)) {
                setAIAutoTriggered((prev) => new Set(prev).add(studentId))
                void triggerAIOpponent({
                    mode: 'flying-flower',
                    level: aiOpponent.level,
                    flyingFlowerKeyword: keyword,
                })
            }
        },
        [keyword, currentQuestion, aiOpponent.enabled, aiOpponent.level, aiAutoTriggered, triggerAIOpponent, scoreAnswer],
    )

    /** 手动触发 AI 接花 */
    const handleTriggerAI = useCallback(() => {
        if (!keyword) return
        void triggerAIOpponent({
            mode: 'flying-flower',
            level: aiOpponent.level,
            flyingFlowerKeyword: keyword,
        })
    }, [triggerAIOpponent, aiOpponent.level, keyword])

    // 关键字变化时重置 AI 触发标记
    useEffect(() => {
        setAIAutoTriggered(new Set())
    }, [keyword])

    // 自动抽取新关键字按钮（教师手动抽取）
    const handleRandomKeyword = useCallback(() => {
        // 此处由后端在 switchMode 时生成关键字；这里仅提示
        // 若教师希望切换关键字，可通过 switchMode(flying-flower) 触发
    }, [])

    return (
        <div className="pr-flying-flower">
            <div className="pr-flying-flower-keyword">
                <Icon name="feather" size={20} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3xs, 2px)' }}>
                    <span className="pr-flying-flower-keyword-label">飞花令关键字</span>
                    <span className="pr-flying-flower-keyword-value">
                        {keyword ?? '待抽取'}
                    </span>
                </div>
                <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'rgb(var(--c-text-secondary))' }}>
                    {respondedCount}/{totalStudents} 已接花
                </span>
                {aiOpponent.enabled && (
                    <Badge variant="info" style={{ marginLeft: 'var(--space-sm)' }}>
                        <Icon name="robot" size={10} />
                        AI 接花中
                    </Badge>
                )}
            </div>

            {/* 关键字提示语 */}
            <div className="pr-flying-flower-hint">
                <Icon name="info" size={12} />
                <span>规则：诗句中必须包含「{keyword ?? '?'}」字，含此字即接花成功，streak 累加。</span>
            </div>

            {/* 单设备代答输入 */}
            <StudentInputPanel
                autoFocus
                placeholder="请输入学生姓名..."
                onSubmitted={(sid, name, ans, score) => {
                    void handleStudentSubmitted(sid, name, ans, score)
                }}
            />

            {/* AI 虚拟对手 */}
            <AIVirtualOpponent
                compact={false}
                showTriggerButton
                onTrigger={handleTriggerAI}
            />

            {/* 擂主榜 */}
            {leaderboard.length === 0 ? (
                <div
                    style={{
                        padding: 'var(--space-md)',
                        textAlign: 'center',
                        color: 'rgb(var(--c-text-tertiary))',
                        fontSize: 'var(--text-sm)',
                    }}
                >
                    等待第一位接花者...
                </div>
            ) : (
                <div className="pr-flying-flower-leaderboard">
                    <div className="pr-flying-flower-leader-header">
                        <Icon name="trophy" size={14} />
                        <span className="pr-flying-flower-leader-title">飞花擂主榜</span>
                    </div>
                    {leaderboard.slice(0, 10).map((entry, idx) => (
                        <div
                            key={entry.studentId}
                            className={`pr-flying-flower-leader-item ${entry.isAI ? 'is-ai' : ''}`}
                            style={
                                idx === 0
                                    ? { backgroundColor: 'var(--accent-primary-10)' }
                                    : entry.isAI
                                        ? { backgroundColor: 'var(--accent-info-10)' }
                                        : undefined
                            }
                        >
                            <span className={`pr-flying-flower-leader-rank pr-flying-flower-leader-rank--${idx + 1 <= 3 ? idx + 1 : ''}`}>
                                {idx + 1}
                            </span>
                            <span className="pr-flying-flower-leader-name">
                                {entry.isAI && (
                                    <span style={{ marginRight: 'var(--space-xs, 4px)', display: 'inline-flex', alignItems: 'center' }}>
                                        <Icon name="robot" size={12} />
                                    </span>
                                )}
                                {entry.studentName}
                            </span>
                            <span className="pr-flying-flower-leader-streak">
                                <Icon name="lightbulb" size={12} />
                                {entry.streak} 连
                            </span>
                            <span className="pr-flying-flower-leader-correct">
                                正确 {entry.correctCount}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {/* 教师操作按钮 */}
            {lessonId && (
                <div className="pr-flying-flower-actions">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleRandomKeyword}
                        leftIcon={<Icon name="refresh" size={12} />}
                        disabled
                    >
                        切换关键字（由后端调度）
                    </Button>
                </div>
            )}

            {/* AI 思考中提示 */}
            {aiThinking && (
                <div className="pr-flying-flower-ai-thinking">
                    <span className="pr-flying-flower-ai-thinking-dot" />
                    AI 正在搜索含「{keyword ?? '?'}」字的诗句...
                </div>
            )}
        </div>
    )
})
