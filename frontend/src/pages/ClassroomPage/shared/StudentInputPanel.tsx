/**
 * 单设备学生代答输入面板（v5.0 Task 18-20）
 *
 * 设计背景：
 * - 课堂场景：仅教师大屏一台电子设备，学生无任何电子设备
 * - 教师代为输入学生姓名 / 选择学生 + 输入学生作答
 * - 提交后自动触发 AI 智能赋分（0-100）+ SSE 流式点评
 *
 * 职责：
 * 1. 学生姓名快速输入（含历史记忆）
 * 2. 学生作答文本框（多行）
 * 3. 提交按钮：调用 store.submit + store.scoreAnswer
 * 4. 显示赋分结果与 AI 反馈
 * 5. 支持键盘快捷提交（Ctrl + Enter）
 *
 * 数据来源：
 * - store.lessonId / currentQuestion
 * - store.scoreAnswer / submit
 * - store.scoreEntries（最近一条记录）
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Icon, Badge } from '@/components/ui'
import { QuickVoiceAssist } from '@/components/ui/QuickVoiceAssist'
import { useClassroomStore } from '@/stores/classroom'
import { api } from '@/lib/api'
import type { StudentOption } from '@/lib/types'

export interface StudentInputPanelProps {
    /** 自动聚焦（首次进入模式时） */
    autoFocus?: boolean
    /** 提交后清空文本（默认 true） */
    clearAfterSubmit?: boolean
    /** 隐藏 AI 赋分结果区（用于无赋分模式如 poem-relay） */
    hideScoreResult?: boolean
    /** 自定义占位符 */
    placeholder?: string
    /** 是否允许提交（外部控制，默认 true） */
    enabled?: boolean
    /** 提交后回调（用于触发 AI 对手等联动） */
    onSubmitted?: (studentId: string, studentName: string, answer: string, score: number | null) => void
}

/** 历史学生姓名只用于排序真实班级名单，不会生成临时学生。 */
const HISTORY_KEY = 'classroom.student-history'
const MAX_HISTORY = 20

function loadHistory(): string[] {
    try {
        const raw = localStorage.getItem(HISTORY_KEY)
        if (!raw) return []
        const arr = JSON.parse(raw) as unknown
        if (!Array.isArray(arr)) return []
        return arr.filter((n): n is string => typeof n === 'string').slice(0, MAX_HISTORY)
    } catch {
        return []
    }
}

function saveHistory(name: string): void {
    try {
        const list = loadHistory()
        const filtered = list.filter((n) => n !== name)
        filtered.unshift(name)
        localStorage.setItem(HISTORY_KEY, JSON.stringify(filtered.slice(0, MAX_HISTORY)))
    } catch {
        // 忽略
    }
}

export const StudentInputPanel = memo(function StudentInputPanel({
    autoFocus = true,
    clearAfterSubmit = true,
    hideScoreResult = false,
    placeholder = '请输入学生姓名（如：王小明）',
    enabled = true,
    onSubmitted,
}: StudentInputPanelProps) {
    // store 状态
    const lessonId = useClassroomStore((s) => s.lessonId)
    const classId = useClassroomStore((s) => s.status.classId)
    const currentQuestion = useClassroomStore((s) => s.currentQuestion)
    const scoring = useClassroomStore((s) => s.scoring)
    const scoreEntries = useClassroomStore((s) => s.scoreEntries)
    const scoreAnswer = useClassroomStore((s) => s.scoreAnswer)
    const submit = useClassroomStore((s) => s.submit)

    // 本地状态
    const [studentName, setStudentName] = useState('')
    const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null)
    const [answer, setAnswer] = useState('')
    const [history, setHistory] = useState<string[]>([])
    const [roster, setRoster] = useState<StudentOption[]>([])
    const [rosterLoading, setRosterLoading] = useState(false)
    const [rosterError, setRosterError] = useState<string | null>(null)
    const [lastSubmittedName, setLastSubmittedName] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const nameInputRef = useRef<HTMLInputElement>(null)
    const answerTextareaRef = useRef<HTMLTextAreaElement>(null)

    // 初次加载历史
    useEffect(() => {
        setHistory(loadHistory())
    }, [])

    // 真实班级名单：课堂 status 带回 classId，再按班级查询学生资源。
    // 接口只返回业务允许展示的匿名名，不把学生真实姓名扩散到课堂大屏。
    useEffect(() => {
        let cancelled = false
        if (!classId) {
            setRoster([])
            setRosterLoading(false)
            setRosterError(null)
            return
        }
        setRosterLoading(true)
        setRosterError(null)
        api.students.list(classId)
            .then((result) => {
                if (!cancelled) {
                    setRoster(result.students)
                    setRosterLoading(false)
                    if (result.students.length === 0) setRosterError('当前班级没有可选学生')
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setRoster([])
                    setRosterLoading(false)
                    setRosterError('班级名单加载失败，请刷新后重试')
                }
            })
        return () => { cancelled = true }
    }, [classId])

    // autoFocus
    useEffect(() => {
        if (autoFocus && nameInputRef.current) {
            // 保留键盘即输能力，但不把整页自动滚到中段。
            nameInputRef.current.focus({ preventScroll: true })
        }
    }, [autoFocus])

    // 最近一次赋分结果
    const lastScore = useMemo(() => {
        return scoreEntries[scoreEntries.length - 1] ?? null
    }, [scoreEntries])

    /** 提交学生作答并触发智能赋分 */
    const handleSubmit = useCallback(async () => {
        if (!enabled || submitting) return
        if (!studentName.trim() || !answer.trim()) return
        if (!lessonId || !currentQuestion || !selectedStudentId) return

        setSubmitting(true)
        const name = studentName.trim()
        const studentId = selectedStudentId
        const ans = answer.trim()

        try {
            // 1. 先以真实班级学生 ID 记录作答。失败时不继续做第二次智能赋分，
            // 避免界面显示分数但课堂事实表中根本没有这次作答。
            const submitted = await submit(studentId, ans, name)
            if (submitted === null) return
            // 2. 调用智能赋分
            const result = await scoreAnswer({
                studentId,
                studentName: name,
                questionId: currentQuestion.id,
                answer: ans,
                referenceAnswer: currentQuestion.answer,
                questionType: currentQuestion.type,
                mode: useClassroomStore.getState().mode,
            })
            // 3. 记录历史
            saveHistory(name)
            setHistory(loadHistory())
            setLastSubmittedName(name)
            // 4. 通知父组件
            onSubmitted?.(studentId, name, ans, result?.score ?? null)
            // 5. 清空作答框
            if (clearAfterSubmit) {
                setAnswer('')
            }
        } finally {
            setSubmitting(false)
        }
    }, [enabled, submitting, studentName, selectedStudentId, answer, lessonId, currentQuestion, submit, scoreAnswer, clearAfterSubmit, onSubmitted])

    /** 键盘快捷键：Ctrl/Cmd + Enter 提交 */
    const handleKeyDown = useCallback(
        (e: KeyboardEvent<HTMLTextAreaElement>) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                void handleSubmit()
            }
        },
        [handleSubmit],
    )

    /** 选择历史学生 */
    const pickStudent = (name: string, studentId?: string) => {
        setStudentName(name)
        setSelectedStudentId(studentId ?? roster.find((student) => student.name === name)?.id ?? null)
        answerTextareaRef.current?.focus()
    }

    const studentChoices = useMemo(() => {
        const recentOrder = new Map(history.map((name, index) => [name, index]))
        const keyword = studentName.trim().toLocaleLowerCase('zh-CN')
        return [...roster]
            .filter((student) => !keyword || student.name.toLocaleLowerCase('zh-CN').includes(keyword))
            .sort((a, b) => {
                const aRecent = recentOrder.get(a.name) ?? Number.MAX_SAFE_INTEGER
                const bRecent = recentOrder.get(b.name) ?? Number.MAX_SAFE_INTEGER
                return aRecent - bRecent || a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
            })
            .slice(0, 8)
    }, [history, roster, studentName])

    /**
     * 题目选项可直接点选；主观题只给表达支架，不泄露参考答案。
     * 这些句式帮助低龄学生开口，但最终内容仍由学生补全。
     */
    const answerSuggestions = useMemo(() => {
        if (currentQuestion?.options?.length) return currentQuestion.options.slice(0, 6)
        switch (currentQuestion?.bloomLevel) {
            case '记忆':
                return ['我记得是……', '这句诗是……', '诗人写的是……']
            case '理解':
                return ['我觉得这句写了……', '从这句话可以看出……', '因为……所以……']
            case '应用':
                return ['我会用这句诗形容……', '生活中我想到……', '如果换个场景……']
            case '分析':
                return ['这里用了……的写法', '前后两句形成了……', '这个字写出了……']
            case '评价':
                return ['我赞同，因为……', '我有不同想法，因为……', '我最喜欢……因为……']
            case '创造':
                return ['如果我是诗人，我会……', '我想把这一句改成……', '我想到的画面是……']
            default:
                return ['我觉得……', '我发现……', '因为……所以……']
        }
    }, [currentQuestion])

    const handleQuickAnswer = useCallback((value: string) => {
        const isChoice = Boolean(currentQuestion?.options?.includes(value))
        setAnswer((previous) => {
            if (isChoice || !previous.trim()) return value
            return `${previous.trim()} ${value}`
        })
        answerTextareaRef.current?.focus()
    }, [currentQuestion])

    const handleVoiceAnswer = useCallback((transcript: string) => {
        setAnswer((previous) => previous.trim()
            ? `${previous.trim()}\n${transcript}`
            : transcript)
        answerTextareaRef.current?.focus()
    }, [])

    const isDisabled = !enabled || !lessonId || !currentQuestion
    const isLoading = submitting || scoring

    return (
        <div className="pr-student-input-panel">
            <div className="pr-student-input-header">
                <Icon name="user" size={14} />
                <span className="pr-student-input-title">学生作答代录</span>
                <Badge variant="default" style={{ marginLeft: 'auto' }}>
                    点选 / 语音
                </Badge>
            </div>

            {/* 只允许选择真实班级名册。输入框是搜索，不再创建后端不存在的临时学生。 */}
            <div className="pr-student-input-student">
                <span className="pr-student-input-section-label">1. 搜索并选择班级学生</span>
                <div className="pr-student-input-name-row">
                    <input
                        ref={nameInputRef}
                        type="search"
                        value={studentName}
                        onChange={(e) => {
                            const value = e.target.value
                            setStudentName(value)
                            const exact = roster.find((student) => student.name === value)
                            setSelectedStudentId(exact?.id ?? null)
                        }}
                        placeholder={rosterLoading ? '正在加载班级名单…' : placeholder}
                        className="pr-student-input-name"
                        disabled={isDisabled || rosterLoading}
                        autoComplete="off"
                        aria-describedby="pr-student-roster-status"
                    />
                </div>
                <span id="pr-student-roster-status" className={rosterError ? 'pr-student-input-roster-status is-error' : 'pr-student-input-roster-status'}>
                    {rosterError ?? (selectedStudentId ? `已选择 ${studentName}` : `共 ${roster.length} 名，输入姓名可筛选`)}
                </span>
                {studentChoices.length > 0 && (
                    <div className="pr-student-input-history-quick" aria-label="匹配的班级学生">
                        {studentChoices.map((student) => (
                            <button
                                key={student.id}
                                type="button"
                                className={studentName === student.name
                                    ? 'pr-student-input-history-item is-selected'
                                    : 'pr-student-input-history-item'}
                                onClick={() => pickStudent(student.name, student.id)}
                                disabled={isDisabled}
                                aria-pressed={studentName === student.name}
                            >
                                <Icon name="user-check" size={13} />
                                {student.name}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div className="pr-student-input-answer-zone">
                <span className="pr-student-input-section-label">2. 点选句式，或直接说答案</span>
                <QuickVoiceAssist
                    suggestions={answerSuggestions}
                    onPick={handleQuickAnswer}
                    onTranscript={handleVoiceAnswer}
                    label={currentQuestion?.options?.length ? '直接点选答案' : '选一句开头，再把话说完整'}
                    voiceLabel="说出答案"
                    disabled={isDisabled || isLoading}
                    compact
                />
                <textarea
                    ref={answerTextareaRef}
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="点选或说完后，答案会出现在这里；检查一下再提交"
                    className="pr-student-input-answer"
                    rows={4}
                    disabled={isDisabled}
                />

                <div className="pr-student-input-actions">
                    <span className="pr-student-input-hint">
                        {isLoading ? 'AI 正在智能赋分…' : '语音只转成文字，不会自动提交'}
                    </span>
                    <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={isDisabled || isLoading || !selectedStudentId || !answer.trim()}
                        className="pr-student-input-submit"
                    >
                        <Icon name="sparkles" size={14} />
                        {isLoading ? '提交中' : '检查好了，提交'}
                    </button>
                </div>
            </div>

            {/* AI 赋分结果 */}
            {!hideScoreResult && lastScore && (
                <div className="pr-student-input-score">
                    <div className="pr-student-input-score-header">
                        <span className="pr-student-input-score-name">
                            {lastScore.studentId.startsWith('ai-opponent')
                                ? 'AI 对手'
                                : lastSubmittedName || roster.find((student) => student.id === lastScore.studentId)?.name || '班级学生'}
                        </span>
                        <span className={`pr-student-input-score-value ${lastScore.correct ? 'is-correct' : 'is-wrong'}`}>
                            {lastScore.score} / 100
                        </span>
                    </div>
                    <p className="pr-student-input-score-feedback">{lastScore.feedback}</p>
                    {lastScore.dimensions && lastScore.dimensions.length > 0 && (
                        <div className="pr-student-input-score-dims">
                            {lastScore.dimensions.map((d) => (
                                <div key={d.name} className="pr-student-input-score-dim">
                                    <span className="pr-student-input-score-dim-name">{d.name}</span>
                                    <div className="pr-student-input-score-dim-bar">
                                        <div
                                            className="pr-student-input-score-dim-fill"
                                            style={{ transform: `scaleX(${d.score / d.maxScore})` }}
                                        />
                                    </div>
                                    <span className="pr-student-input-score-dim-value">{d.score}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
})
