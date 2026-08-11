/**
 * DanceStage —— AI 诗教共舞舞台（v5.0 创新点）
 *
 * 教师/AI/学生三方实时协作舞台，将传统"教师讲→学生听"的单向教学
 * 升级为"教师指挥→AI 补位→学生回应"的三方共舞。
 *
 * 架构：
 * - WebSocket 订阅 dance:* 事件流（dance:session:start / dance:event / dance:ai:stream-delta / dance:ai:stream-done）
 * - 本地 state 维护 timeline，WS 事件增量追加
 * - 教师指挥台：assign 布置 / guide 引导 / feedback 反馈 三类指令
 * - AI 流式输出区：StreamText 驱动逐字呈现
 * - 三泳道时间轴 + 事件卡片列表双视图
 *
 * 数据流（规范第 12 章实时数据同步）：
 * - WS 事件到达 → ≤50ms 内更新 state（Zustand 同步更新）
 * - 教师提交事件 → 乐观追加 timeline + POST /dance/event
 * - AI 流式分片 → 实时拼接 buffer + StreamText 渲染
 *
 * 设计规范合规：
 * - 玻璃态面板（规范 2.3 第 4 层 surface-glass-heavy）
 * - 无硬边框（规范 4.1）
 * - StreamText 流式输出（规范 11）
 * - transform/opacity 动画（规范 6.6）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button, Icon } from '@/components/ui'
import { StreamText } from '@/components/ui/StreamText'
import { api } from '@/lib/api'
import { toast } from '@/stores/toast'
import { businessEvents } from '@/lib/business-events'
import type { WSEvent } from '@/lib/types'
import { DanceTimeline } from './DanceTimeline'
import { DanceEventCard } from './DanceEventCard'
import { QuickVoiceAssist } from '@/components/ui/QuickVoiceAssist'
import type { DanceEventPayload, DanceEventSubType } from './dance-types'
import './DanceStage.css'

/** 教师指令类型 */
type TeacherDirective = 'assign' | 'guide' | 'feedback'

const TEACHER_DIRECTIVES: readonly TeacherDirective[] = ['assign', 'guide', 'feedback']

/** 指令配置 */
const DIRECTIVE_CONFIG: Record<TeacherDirective, {
    label: string
    icon: 'magic-wand' | 'lightbulb' | 'check-circle'
    placeholder: string
    subType: DanceEventSubType
    suggestions: readonly string[]
}> = {
    assign: {
        label: '布置任务',
        icon: 'magic-wand',
        placeholder: '请输入要布置的学习任务，如"赏析《静夜思》中"床前明月光"的意境"…',
        subType: 'assign',
        suggestions: ['朗读这首诗', '找出诗中的意象', '说说你看到的画面', '小组合作完成赏析'],
    },
    guide: {
        label: '引导启发',
        icon: 'lightbulb',
        placeholder: '请输入启发引导语，如"同学们想想，诗人为何用"疑"字？"…',
        subType: 'guide',
        suggestions: ['再读一遍，注意这个字', '你从哪里看出来的？', '还有不同的想法吗？', '联系生活想一想'],
    },
    feedback: {
        label: '反馈点评',
        icon: 'check-circle',
        placeholder: '请输入对学生的反馈点评…',
        subType: 'feedback',
        suggestions: ['表达很清楚', '发现得很细致', '请把理由说完整', '再读一遍会更有感情'],
    },
}

export interface DanceStageProps {
    /** 课堂 ID */
    lessonId: string
    /** 诗篇 ID */
    poemId: string
    /** WS 事件订阅（由 ClassroomPage 通过 useWSSubscription 注入） */
    onSubscribeDanceEvents?: (handler: (event: WSEvent) => void) => () => void
}

export function DanceStage({ lessonId, onSubscribeDanceEvents }: DanceStageProps) {
    // ── 本地状态 ──
    const [timeline, setTimeline] = useState<DanceEventPayload[]>([])
    const [sessionActive, setSessionActive] = useState(false)
    const [aiStreamingContent, setAiStreamingContent] = useState('')
    const [aiStreaming, setAiStreaming] = useState(false)
    const [currentDirective, setCurrentDirective] = useState<TeacherDirective>('assign')
    const [inputValue, setInputValue] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [loadingTimeline, setLoadingTimeline] = useState(false)
    const [timelineError, setTimelineError] = useState<string | null>(null)
    const [timelineRequest, setTimelineRequest] = useState(0)

    // ── 引用 ──
    const timelineEndRef = useRef<HTMLDivElement>(null)

    // ── 拉取历史时间线（首次挂载或 lessonId 变化） ──
    useEffect(() => {
        let cancelled = false
        setTimeline([])
        setSessionActive(false)
        setAiStreaming(false)
        setAiStreamingContent('')
        setInputValue('')
        setTimelineError(null)

        if (!lessonId) {
            setLoadingTimeline(false)
            setTimelineError('未找到课堂标识，暂时无法加载共舞事件。')
            return () => { cancelled = true }
        }

        setLoadingTimeline(true)
        api.classroom.danceTimeline(lessonId, 0, 500)
            .then((res) => {
                if (cancelled) return
                const events = (res.timeline ?? []) as DanceEventPayload[]
                setTimeline(events)
            })
            .catch(() => {
                if (!cancelled) {
                    setTimeline([])
                    setTimelineError('共舞事件流暂时不可用。可重试加载；不影响教师重新启动会话。')
                }
            })
            .finally(() => {
                if (!cancelled) setLoadingTimeline(false)
            })
        return () => { cancelled = true }
    }, [lessonId, timelineRequest])

    const retryTimeline = useCallback(() => {
        setTimelineRequest((previous) => previous + 1)
    }, [])

    // ── 自动滚动到底部（新事件到达） ──
    useEffect(() => {
        timelineEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }, [timeline.length])

    // ── WS 事件处理：dance:* 系列 ──
    // 通过全局 wsDispatcher 订阅（ClassroomPage 已统一管理连接）
    const handleDanceEvent = useCallback((event: WSEvent) => {
        if (event.sessionId !== lessonId || !event.type.startsWith('dance:')) return

        switch (event.type) {
            case 'dance:session:start': {
                setSessionActive(true)
                break
            }
            case 'dance:session:end': {
                setSessionActive(false)
                setAiStreaming(false)
                setAiStreamingContent('')
                break
            }
            case 'dance:event': {
                const payload = event.payload as DanceEventPayload
                if (!payload?.id) return
                setTimeline((prev) => {
                    // 幂等：避免重复追加（WS 重连可能重放）
                    if (prev.some((item) => item.id === payload.id)) return prev
                    return [...prev, payload]
                })
                businessEvents.emit('classroom:ai-suggested', {
                    lessonId,
                    category: payload.actor === 'ai' ? 'supplement' : 'feedback',
                    summary: payload.content.slice(0, 80),
                    questionId: payload.questionId,
                    studentId: payload.targetStudentId,
                    suggestedAt: payload.timestamp,
                })
                break
            }
            case 'dance:ai:stream-delta': {
                const delta = (event.payload as { chunk?: string })?.chunk ?? ''
                setAiStreaming(true)
                setAiStreamingContent((prev) => prev + delta)
                break
            }
            case 'dance:ai:stream-done': {
                setAiStreaming(false)
                break
            }
            default:
                break
        }
    }, [lessonId])

    useEffect(() => {
        if (onSubscribeDanceEvents) return onSubscribeDanceEvents(handleDanceEvent)

        // 动态导入避免循环依赖；取消挂载后忽略迟到的导入结果。
        let disposed = false
        let unsub: (() => void) | null = null
        void import('@/lib/ws-dispatcher').then(({ wsDispatcher }) => {
            if (!disposed) unsub = wsDispatcher.subscribe(handleDanceEvent)
        })
        return () => {
            disposed = true
            unsub?.()
        }
    }, [handleDanceEvent, onSubscribeDanceEvents])

    // ── 启动共舞会话 ──
    const handleStartSession = useCallback(async () => {
        if (!lessonId) return
        setSubmitting(true)
        try {
            await api.classroom.danceStart(lessonId)
            setSessionActive(true)
            toast.success({ title: '共舞舞台已开启', message: '教师/AI/学生三方协作通道已建立' })
        } catch (err) {
            toast.error({ title: '启动失败', message: err instanceof Error ? err.message : '请稍后重试' })
        } finally {
            setSubmitting(false)
        }
    }, [lessonId])

    // ── 教师提交指令 ──
    const handleSubmitDirective = useCallback(async () => {
        const content = inputValue.trim()
        if (!content || !lessonId) return

        const directive = DIRECTIVE_CONFIG[currentDirective]
        const tempId = `temp-${Date.now()}`

        // 乐观追加（规范 12.3：≤50ms 内反映预期结果）
        const optimisticEvent: DanceEventPayload = {
            id: tempId,
            name: `teacher:${directive.subType}`,
            actor: 'teacher',
            subType: directive.subType,
            actorId: 'teacher',
            actorLabel: '教师',
            content,
            aiGenerated: false,
            timestamp: Date.now(),
        }
        setTimeline((prev) => [...prev, optimisticEvent])
        setInputValue('')
        setSubmitting(true)

        try {
            await api.classroom.danceSubmitEvent(lessonId, {
                actor: 'teacher',
                subType: directive.subType,
                content,
                actorId: 'teacher',
                actorLabel: '教师',
                aiGenerated: false,
            })
            // 服务端确认后，tempId 会被 WS 推送的真实事件替换（幂等去重）
        } catch (err) {
            // 回滚乐观更新（规范 12.3：失败回滚 + toast）
            setTimeline((prev) => prev.filter((e) => e.id !== tempId))
            toast.error({
                title: '提交失败',
                message: err instanceof Error ? err.message : '请稍后重试',
            })
        } finally {
            setSubmitting(false)
        }
    }, [inputValue, lessonId, currentDirective])

    // ── 最新事件 ID（用于高亮） ──
    const latestEventId = useMemo(() => {
        if (timeline.length === 0) return undefined
        const last = timeline[timeline.length - 1]
        return last?.id
    }, [timeline])

    const directiveConfig = DIRECTIVE_CONFIG[currentDirective]
    const insertDirective = useCallback((content: string) => {
        setInputValue((previous) => previous.trim()
            ? `${previous.trim()} ${content}`
            : content)
    }, [])

    const handleDirectiveTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
        const currentIndex = TEACHER_DIRECTIVES.indexOf(currentDirective)
        let nextIndex: number
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                nextIndex = (currentIndex + 1) % TEACHER_DIRECTIVES.length
                break
            case 'ArrowLeft':
            case 'ArrowUp':
                nextIndex = (currentIndex - 1 + TEACHER_DIRECTIVES.length) % TEACHER_DIRECTIVES.length
                break
            case 'Home':
                nextIndex = 0
                break
            case 'End':
                nextIndex = TEACHER_DIRECTIVES.length - 1
                break
            default:
                return
        }
        event.preventDefault()
        const nextDirective = TEACHER_DIRECTIVES[nextIndex]
        if (!nextDirective) return
        setCurrentDirective(nextDirective)
        event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-dance-directive-tab="${nextDirective}"]`)
            ?.focus()
    }, [currentDirective])

    return (
        <div className="pr-dance-stage" role="region" aria-label="AI 诗教共舞舞台">
            {/* ── 头部：标题 + 会话状态 + 启动按钮 ── */}
            <header className="pr-dance-stage__head">
                <div className="pr-dance-stage__title-group">
                    <Icon name="magic-wand" size={18} />
                    <h3 className="pr-dance-stage__title">AI 诗教共舞舞台</h3>
                    <span
                        className={`pr-dance-stage__status${sessionActive ? ' pr-dance-stage__status--active' : ''
                            }`}
                        role="status"
                        aria-live="polite"
                        aria-label={sessionActive ? '共舞进行中' : '共舞未开始'}
                    >
                        <span className="pr-dance-stage__status-dot" />
                        {sessionActive ? '进行中' : '待启动'}
                    </span>
                </div>
                {!sessionActive && (
                    <Button
                        size="sm"
                        onClick={handleStartSession}
                        disabled={submitting || !lessonId}
                        aria-label="启动共舞会话"
                    >
                        <Icon name="magic-wand" size={14} />
                        启动共舞
                    </Button>
                )}
            </header>

            {/* ── 时间轴视图（三泳道） ── */}
            <DanceTimeline events={timeline} latestEventId={latestEventId} />

            {/* ── AI 流式输出区 ── */}
            {aiStreamingContent && (
                <div className="pr-dance-stage__ai-stream" aria-live="polite">
                    <div className="pr-dance-stage__ai-stream-head">
                        <Icon name="sparkle" size={14} />
                        <span className="pr-dance-stage__ai-stream-label">AI 实时响应</span>
                        {aiStreaming && (
                            <span className="pr-dance-stage__ai-stream-indicator">
                                <Icon name="circle-notch" size={12} className="pr-app-spin" />
                                生成中
                            </span>
                        )}
                    </div>
                    <StreamText
                        content={aiStreamingContent}
                        charStagger={12}
                        charDuration={250}
                        showCursor={aiStreaming}
                        structured
                    />
                </div>
            )}

            {/* ── 事件卡片列表（最近 20 条） ── */}
            <div className="pr-dance-stage__events">
                <div className="pr-dance-stage__events-head">
                    <span className="pr-dance-stage__events-title">事件流</span>
                    <span className="pr-dance-stage__events-count">
                        {timeline.length} 条
                    </span>
                </div>
                <div className="pr-dance-stage__events-list" aria-label="共舞事件流" aria-busy={loadingTimeline}>
                    {loadingTimeline && timeline.length === 0 ? (
                        <div className="pr-dance-stage__events-loading">
                            <Icon name="circle-notch" size={20} className="pr-app-spin" />
                            <span>加载时间线…</span>
                        </div>
                    ) : timeline.length === 0 ? (
                        <div className="pr-dance-stage__events-empty">
                            <Icon name="sparkle" size={24} />
                            <span>共舞尚未开始</span>
                            <span className="pr-dance-stage__events-empty-hint">
                                教师布置任务后，AI 将自动补充教学内容，学生实时回应
                            </span>
                        </div>
                    ) : (
                        timeline.slice(-20).map((event, idx, arr) => (
                            <DanceEventCard
                                key={event.id}
                                event={event}
                                isLatest={idx === arr.length - 1}
                            />
                        ))
                    )}
                    {timelineError && (
                        <div className="pr-dance-stage__events-error" role="alert">
                            <span>{timelineError}</span>
                            <button type="button" onClick={retryTimeline} disabled={loadingTimeline}>
                                {loadingTimeline ? '重新加载中…' : '重试加载'}
                            </button>
                        </div>
                    )}
                    <div ref={timelineEndRef} />
                </div>
            </div>

            {/* ── 教师指挥台 ── */}
            <footer className="pr-dance-stage__console">
                <div
                    className="pr-dance-stage__console-tabs"
                    role="tablist"
                    aria-label="教师指令类型"
                    onKeyDown={handleDirectiveTabKeyDown}
                >
                    {TEACHER_DIRECTIVES.map((key) => {
                        const cfg = DIRECTIVE_CONFIG[key]
                        const active = currentDirective === key
                        return (
                            <button
                                key={key}
                                type="button"
                                role="tab"
                                id={`pr-dance-directive-tab-${key}`}
                                data-dance-directive-tab={key}
                                aria-selected={active}
                                aria-controls="pr-dance-directive-panel"
                                tabIndex={active ? 0 : -1}
                                className={`pr-dance-stage__console-tab${active ? ' pr-dance-stage__console-tab--active' : ''
                                    }`}
                                onClick={() => setCurrentDirective(key)}
                            >
                                <Icon name={cfg.icon} size={13} active={active} />
                                {cfg.label}
                            </button>
                        )
                    })}
                </div>
                <div
                    id="pr-dance-directive-panel"
                    className="pr-dance-stage__directive-panel"
                    role="tabpanel"
                    aria-labelledby={`pr-dance-directive-tab-${currentDirective}`}
                    aria-busy={submitting}
                >
                    <QuickVoiceAssist
                        suggestions={directiveConfig.suggestions}
                        onPick={insertDirective}
                        onTranscript={insertDirective}
                        label={`快速${directiveConfig.label}，也可以直接说`}
                        voiceLabel="语音指令"
                        disabled={submitting || !sessionActive}
                        compact
                    />
                    <div className="pr-dance-stage__console-input">
                        <textarea
                            className="pr-dance-stage__textarea"
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            placeholder="从上方点选后可直接发送，也可以在这里补充"
                            rows={2}
                            disabled={submitting || !sessionActive}
                            onKeyDown={(e) => {
                                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                    e.preventDefault()
                                    void handleSubmitDirective()
                                }
                            }}
                            aria-label={`教师${directiveConfig.label}输入`}
                        />
                        <Button
                            size="sm"
                            onClick={handleSubmitDirective}
                            disabled={!inputValue.trim() || submitting || !sessionActive}
                            aria-label={`提交${directiveConfig.label}`}
                        >
                            <Icon name="magic-wand" size={14} />
                            {submitting ? '提交中' : '发送'}
                        </Button>
                    </div>
                    <p className="pr-dance-stage__console-hint">
                        按 Ctrl/⌘ + Enter 快速发送 · AI 将根据指令自动补充教学内容
                    </p>
                </div>
            </footer>
        </div>
    )
}
