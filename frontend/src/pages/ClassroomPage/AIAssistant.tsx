/**
 * AI 实时辅助副驾（SubTask 11.4 + 课堂指挥深化 Task 3）
 *
 * 职责：
 * 1. 展示诗笔/诗心 Agent 的实时输出（批改反馈 / 启发提示 / 讨论题 / 报告片段）
 * 2. WebSocket 事件自动追加消息，无需手动刷新
 * 3. 课堂指挥深化：4 类 AI 协同建议（反馈/补充/追问/干预）+ SSE 流式输出
 * 4. 一键采纳建议，标记为已采纳
 * 5. 消息按 kind 着色（feedback=info, hint=warning, discussion=primary, report=success）
 *
 * 数据来源：
 * - aiMessages：从 useClassroomStore 获取，按时间顺序累积
 * - WS 事件 classroom:response / classroom:hint / classroom:discuss 自动追加
 * - SSE 流式：api.classroom.aiSuggest / aiSupplement / aiFollowup
 *
 * 设计要点（规范第 11、12 章）：
 * - 流式输出使用 StreamText 组件，逐字符涌现
 * - 消息入场动画 200ms 淡入 + 上移 4px（pr-ai-msg-in）
 * - 左侧 2px 色条区分消息类型，不使用边框
 * - 消息列表 max-height 280px，超出滚动
 * - 角色标签使用 mono 字体 + accent 10% 背景
 */

import { memo, useEffect, useRef, useState, useCallback } from 'react'
import { Icon, AIBadge } from '@/components/ui'
import { StreamText } from '@/components/ui/StreamText'
import { api } from '@/lib/api'
import {
    beginAsyncGeneration,
    invalidateAsyncGeneration,
    isAsyncGenerationCurrent,
    type AsyncGenerationToken,
} from '@/lib/async-generation'
import { businessEvents } from '@/lib/business-events'
import { toast } from '@/stores/toast'
import type { AIAssistantMessage } from '@/stores/classroom'
import type { AIInterventionResponse, StudentResponse, AISuggestionCategory } from '@/lib/types'
import { AI_SUGGESTION_CATEGORY_LABELS } from '@/lib/types'

export interface AIAssistantProps {
    /** AI 副驾消息列表 */
    messages: AIAssistantMessage[]
    /** WS 连接状态 */
    wsConnected: boolean
    /** 课堂 ID（用于 AI 协同建议） */
    lessonId?: string
    /** 当前题目 ID（用于 AI 协同建议） */
    currentQuestionId?: string
    /** 学生作答列表（用于提取最近答题学生 + 正确率） */
    responses?: StudentResponse[]
}

/** 角色中文标签 */
const ROLE_LABELS: Record<string, string> = {
    'brush.grade': '诗笔·批改',
    'brush.creative': '诗笔·创想',
    'mind.diagnose': '诗心·诊断',
    'brush.report': '诗笔·报告',
}

/** 消息类型图标 */
const KIND_ICONS: Record<string, 'check-circle' | 'lightbulb' | 'quotes' | 'chart-bar'> = {
    feedback: 'check-circle',
    hint: 'lightbulb',
    discussion: 'quotes',
    report: 'chart-bar',
}

/** AI 建议类别按钮配置 */
const SUGGESTION_ACTIONS: Array<{
    category: AISuggestionCategory
    icon: 'check-circle' | 'book-open' | 'quotes' | 'lightbulb'
    label: string
}> = [
    { category: 'feedback', icon: 'check-circle', label: '实时反馈' },
    { category: 'supplement', icon: 'book-open', label: '背景补充' },
    { category: 'followup', icon: 'quotes', label: '追问生成' },
    { category: 'intervention', icon: 'lightbulb', label: '干预建议' },
]

/** 格式化时间 */
function formatTime(at: number): string {
    const d = new Date(at)
    const h = d.getHours().toString().padStart(2, '0')
    const m = d.getMinutes().toString().padStart(2, '0')
    const s = d.getSeconds().toString().padStart(2, '0')
    return `${h}:${m}:${s}`
}

/** 将后端聚合出的干预分析转换为教师可直接阅读的、带来源边界的课堂建议。 */
function formatIntervention(result: AIInterventionResponse): string {
    const { strugglingStudents, classSuggestion } = result.intervention
    const lines = ['基于本节课已提交作答的规则化分析（不等同于长期学情结论）：', classSuggestion]
    if (strugglingStudents.length > 0) {
        lines.push('', '需重点支持：')
        for (const student of strugglingStudents) {
            lines.push(`- ${student.studentName}：当前正确率 ${(student.accuracy * 100).toFixed(0)}%；${student.suggestion}`)
        }
    } else {
        lines.push('', '当前没有已提交作答且正确率低于 40% 的学生。请结合课堂观察决定是否调整教学。')
    }
    return lines.join('\n')
}

export const AIAssistant = memo(function AIAssistant({
    messages,
    wsConnected,
    lessonId,
    currentQuestionId,
    responses = [],
}: AIAssistantProps) {
    const scrollRef = useRef<HTMLDivElement | null>(null)
    /** 流式输出内容 */
    const [streamingContent, setStreamingContent] = useState('')
    /** SSE 回调读取 ref，避免 onDone 因闭包拿到启动时的空文本。 */
    const streamingContentRef = useRef('')
    /** 当前流式类别 */
    const [streamingCategory, setStreamingCategory] = useState<AISuggestionCategory | null>(null)
    /** 是否正在流式输出 */
    const [isStreaming, setIsStreaming] = useState(false)
    /** 已采纳的建议类别集合 */
    const [adoptedSet, setAdoptedSet] = useState<Set<AISuggestionCategory>>(new Set())
    /** 采纳落库尚未完成时，不提前把 UI 标记为成功。 */
    const [adoptingSuggestion, setAdoptingSuggestion] = useState(false)
    /** 流式控制器（用于中断） */
    const streamControllerRef = useRef<{ abort: () => void; streaming: boolean } | null>(null)
    /** 建议与采纳分别使用单调代际，避免旧 Promise/流回写新课堂上下文。 */
    const suggestionGenerationRef = useRef(0)
    const adoptionGenerationRef = useRef(0)
    const mountedRef = useRef(false)
    const suggestionContextKey = JSON.stringify({
        lessonId: lessonId ?? null,
        questionId: currentQuestionId ?? null,
        responses: responses.map((response) => [
            response.studentId,
            response.studentName ?? null,
            response.answer,
            response.correct ?? null,
            response.score ?? null,
            response.at,
        ]),
    })
    const lessonQuestionKey = JSON.stringify([lessonId ?? null, currentQuestionId ?? null])
    const latestSuggestionContextKeyRef = useRef(suggestionContextKey)
    // 回调可能在被动 effect 执行前完成；渲染期同步 latest ref 可关闭这段竞态窗口。
    latestSuggestionContextKeyRef.current = suggestionContextKey

    // 新消息到达时自动滚动到底部
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
    }, [messages])

    // 组件卸载时中断可取消的 SSE；不可取消 Promise 由 mounted + generation 双门禁隔离。
    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            invalidateAsyncGeneration(suggestionGenerationRef)
            invalidateAsyncGeneration(adoptionGenerationRef)
            streamControllerRef.current?.abort()
            streamControllerRef.current = null
        }
    }, [])

    // 换课、切题或学生作答上下文变化时，旧建议不再属于当前视图。
    useEffect(() => {
        invalidateAsyncGeneration(suggestionGenerationRef)
        invalidateAsyncGeneration(adoptionGenerationRef)
        streamControllerRef.current?.abort()
        streamControllerRef.current = null
        streamingContentRef.current = ''
        setStreamingContent('')
        setStreamingCategory(null)
        setIsStreaming(false)
        setAdoptingSuggestion(false)
    }, [suggestionContextKey])

    // “已采纳”是题目上下文状态；学生新作答不应抹掉同一道题的展示标记。
    useEffect(() => {
        setAdoptedSet(new Set())
    }, [lessonQuestionKey])

    const isCurrentSuggestion = useCallback((token: AsyncGenerationToken) => (
        isAsyncGenerationCurrent(
            token,
            suggestionGenerationRef.current,
            latestSuggestionContextKeyRef.current,
            mountedRef.current,
        )
    ), [])

    const isCurrentAdoption = useCallback((token: AsyncGenerationToken) => (
        isAsyncGenerationCurrent(
            token,
            adoptionGenerationRef.current,
            latestSuggestionContextKeyRef.current,
            mountedRef.current,
        )
    ), [])

    /** 计算全班正确率 */
    const classAccuracy = useCallback(() => {
        if (responses.length === 0) return undefined
        const correct = responses.filter((r) => r.correct === true).length
        return correct / responses.length
    }, [responses])

    /** 获取最近答题学生 ID */
    const lastStudentId = useCallback(() => {
        if (responses.length === 0) return undefined
        const sorted = [...responses].sort((a, b) => b.at - a.at)
        return sorted[0]?.studentId
    }, [responses])

    /** 触发 AI 协同建议（SSE 流式） */
    const handleSuggestion = useCallback((category: AISuggestionCategory) => {
        if (!lessonId || !currentQuestionId) {
            toast.warning({ title: '无法生成建议', message: '课堂未开始或无当前题目' })
            return
        }
        streamControllerRef.current?.abort()
        streamControllerRef.current = null
        invalidateAsyncGeneration(adoptionGenerationRef)
        setAdoptingSuggestion(false)

        const token = beginAsyncGeneration(suggestionGenerationRef, suggestionContextKey)
        const requestLessonId = lessonId
        const requestQuestionId = currentQuestionId

        streamingContentRef.current = ''
        setStreamingContent('')
        setStreamingCategory(category)
        setIsStreaming(true)

        const studentId = lastStudentId()
        const accuracy = classAccuracy()
        const callbacks = {
            onChunk: (chunk: { delta?: string; done?: boolean; category: AISuggestionCategory }) => {
                if (!isCurrentSuggestion(token)) return
                if (chunk.delta) {
                    streamingContentRef.current += chunk.delta
                    setStreamingContent(streamingContentRef.current)
                }
            },
            onDone: () => {
                if (!isCurrentSuggestion(token)) return
                streamControllerRef.current = null
                setIsStreaming(false)
                // 发射业务事件
                businessEvents.emit('classroom:ai-suggested', {
                    lessonId: requestLessonId,
                    category,
                    summary: streamingContentRef.current.slice(0, 80) || AI_SUGGESTION_CATEGORY_LABELS[category],
                    questionId: requestQuestionId,
                    studentId,
                    suggestedAt: Date.now(),
                })
            },
            onError: (err: Error) => {
                if (!isCurrentSuggestion(token)) return
                streamControllerRef.current = null
                setIsStreaming(false)
                if (import.meta.env.DEV) console.error('[ai-assistant] SSE error:', err)
                toast.error({ title: 'AI 建议生成失败', message: err.message.slice(0, 60) })
            },
        }

        if (category === 'intervention') {
            streamControllerRef.current = null
            void api.classroom.aiIntervention(requestLessonId)
                .then((result) => {
                    if (!isCurrentSuggestion(token)) return
                    const content = formatIntervention(result)
                    streamingContentRef.current = content
                    setStreamingContent(content)
                    setIsStreaming(false)
                    businessEvents.emit('classroom:ai-suggested', {
                        lessonId: requestLessonId,
                        category,
                        summary: content.slice(0, 80),
                        questionId: requestQuestionId,
                        studentId,
                        suggestedAt: Date.now(),
                    })
                })
                .catch((err) => {
                    if (!isCurrentSuggestion(token)) return
                    setIsStreaming(false)
                    const message = err instanceof Error ? err.message : '请稍后重试'
                    toast.error({ title: '干预分析生成失败', message: message.slice(0, 60) })
                })
            return
        }

        let controller: { abort: () => void; streaming: boolean }
        if (category === 'feedback') {
            controller = api.classroom.aiSuggest(requestLessonId, requestQuestionId, studentId ?? '', callbacks, accuracy)
        } else if (category === 'supplement') {
            controller = api.classroom.aiSupplement(requestLessonId, requestQuestionId, callbacks)
        } else if (category === 'followup') {
            controller = api.classroom.aiFollowup(requestLessonId, requestQuestionId, callbacks, studentId)
        } else return
        streamControllerRef.current = controller
    }, [
        lessonId,
        currentQuestionId,
        suggestionContextKey,
        lastStudentId,
        classAccuracy,
        isCurrentSuggestion,
    ])

    /** 中断流式输出 */
    const handleAbort = useCallback(() => {
        invalidateAsyncGeneration(suggestionGenerationRef)
        streamControllerRef.current?.abort()
        streamControllerRef.current = null
        setIsStreaming(false)
    }, [])

    /** 一键采纳当前建议 */
    const handleAdopt = useCallback(async () => {
        if (!streamingCategory || !lessonId) return
        const category = streamingCategory
        const requestLessonId = lessonId
        const token = beginAsyncGeneration(adoptionGenerationRef, suggestionContextKey)
        setAdoptingSuggestion(true)
        try {
            await api.classroom.markAISuggestionAdopted(requestLessonId, category)
            if (!isCurrentAdoption(token)) return
            setAdoptedSet((prev) => new Set(prev).add(category))
            toast.success({ title: '已采纳', message: AI_SUGGESTION_CATEGORY_LABELS[category] })
        } catch (err) {
            if (!isCurrentAdoption(token)) return
            const message = err instanceof Error ? err.message : '请稍后重试'
            toast.error({ title: '采纳状态未保存', message: message.slice(0, 60) })
        } finally {
            if (isCurrentAdoption(token)) setAdoptingSuggestion(false)
        }
    }, [streamingCategory, lessonId, suggestionContextKey, isCurrentAdoption])

    const canSuggest = Boolean(lessonId && currentQuestionId)

    return (
        <div className="pr-ai-assistant">
            <div className="pr-ai-assistant-header">
                <span className="pr-ai-assistant-title">
                    <span className="pr-ai-assistant-title-icon">
                        <Icon name="sparkle" size={14} />
                    </span>
                    AI 副驾
                    {wsConnected && (
                        <span
                            style={{
                                fontSize: 'var(--text-2xs)',
                                color: 'rgb(var(--c-accent-success))',
                                marginLeft: 'var(--space-xs)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '2px',
                            }}
                        >
                            <span
                                style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: 'var(--radius-full)',
                                    backgroundColor: 'rgb(var(--c-accent-success))',
                                    display: 'inline-block',
                                }}
                            />
                            实时
                        </span>
                    )}
                </span>
                <span
                    style={{
                        fontSize: 'var(--text-2xs)',
                        color: 'rgb(var(--c-text-tertiary))',
                    }}
                >
                    {messages.length} 条消息
                </span>
            </div>

            {/* AI 协同建议按钮组（课堂指挥深化 Task 3） */}
            {canSuggest && (
                <div className="pr-ai-assistant-suggestions">
                    {SUGGESTION_ACTIONS.map((action) => (
                        <button
                            key={action.category}
                            type="button"
                            className={`pr-ai-suggestion-btn ${streamingCategory === action.category && isStreaming ? 'pr-ai-suggestion-btn--active' : ''} ${adoptedSet.has(action.category) ? 'pr-ai-suggestion-btn--adopted' : ''}`}
                            disabled={isStreaming && streamingCategory !== action.category}
                            onClick={() => handleSuggestion(action.category)}
                            aria-label={action.label}
                        >
                            <Icon name={action.icon} size={12} />
                            <span>{action.label}</span>
                            {adoptedSet.has(action.category) && (
                                <Icon name="check" size={10} />
                            )}
                        </button>
                    ))}
                </div>
            )}

            {/* 流式输出区域 */}
            {streamingCategory && (isStreaming || streamingContent) && (
                <div className={`pr-ai-assistant-streaming pr-ai-assistant-streaming--${streamingCategory}`}>
                    <div className="pr-ai-assistant-streaming-header">
                        <span className="pr-ai-assistant-streaming-label">
                            <Icon name="sparkle" size={10} />
                            {AI_SUGGESTION_CATEGORY_LABELS[streamingCategory]}
                        </span>
                        {isStreaming ? (
                            <button
                                type="button"
                                className="pr-ai-assistant-streaming-abort"
                                onClick={handleAbort}
                            >
                                <Icon name="x" size={10} />
                                中断
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="pr-ai-assistant-streaming-adopt"
                                onClick={() => void handleAdopt()}
                                disabled={adoptingSuggestion}
                                aria-busy={adoptingSuggestion}
                            >
                                <Icon name="check" size={10} />
                                {adoptingSuggestion ? '保存采纳中…' : '采纳'}
                            </button>
                        )}
                    </div>
                    <div className="pr-ai-assistant-streaming-content">
                        {streamingContent ? (
                            <StreamText
                                content={streamingContent}
                                charStagger={8}
                                charDuration={150}
                                showCursor={isStreaming}
                                structured
                            />
                        ) : (
                            <span className="pr-ai-assistant-streaming-waiting">
                                AI 思考中…
                            </span>
                        )}
                    </div>
                </div>
            )}

            <div className="pr-ai-assistant-messages" ref={scrollRef}>
                {messages.length === 0 && !streamingContent ? (
                    <div className="pr-ai-assistant-empty">
                        <Icon name="feather" size={20} />
                        <span>AI 副驾待命中，作答后将自动生成反馈</span>
                    </div>
                ) : (
                    messages.map((msg) => (
                        <div
                            key={msg.id}
                            className={`pr-ai-message pr-ai-message--${msg.kind}`}
                        >
                            <div className="pr-ai-message-header">
                                <span className="pr-ai-message-role">
                                    {ROLE_LABELS[msg.role] ?? msg.role}
                                </span>
                                <AIBadge size="xs" />
                                <Icon name={KIND_ICONS[msg.kind] ?? 'info'} size={10} />
                                <span>{formatTime(msg.at)}</span>
                            </div>
                            <div className="pr-ai-message-content">{msg.content}</div>
                        </div>
                    ))
                )}
            </div>
        </div>
    )
})
