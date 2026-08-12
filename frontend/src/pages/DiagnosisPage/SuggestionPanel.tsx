/**
 * 教学调整建议面板（Phase 4.2 —— 教师教学流程闭环 + v5.0 AI 真实流式对话）
 *
 * 双模式架构：
 * - 模式 A（向后兼容 DashboardPage）：传入 `response` prop → 列表视图
 *   基于 TeachingSuggestionResponse 展示数据摘要 + 筛选 + 建议卡片列表
 * - 模式 B（v5.0 新增 DiagnosisPage）：传入 `studentId` + `studentData` → AI 聊天视图
 *   调用 POST /api/ai/chat SSE 流式输出，使用 deepseek-v4-pro + thinking_mode: medium
 *   支持至少 3 轮上下文记忆、中断/继续按钮、光标脉动、错误重试
 *
 * 模式判定规则：
 * - props.studentId 存在 → 进入 AI 聊天模式
 * - props.response 存在且无 studentId → 进入列表模式（DashboardPage 兼容）
 *
 * AI 调用流程（模式 B）：
 *   1. 教师输入问题 → 调用 store.streamSuggestion({ studentId, userMessage })
 *   2. store 内部构造 messages（system + 最近 3 轮历史 + user）→ POST /api/ai/chat
 *   3. SSE 帧逐字推送 → store.streamingSuggestionText 累积 → 组件渲染打字机效果
 *   4. 用户可点击"中断"调用 store.abortSuggestionStream()
 *   5. 流式完成后 assistant 消息追加到 store.suggestionMessages（多轮上下文记忆）
 *
 * 设计要点（规范第 1、4、5、6、7、11 章）：
 * - 内容即设计：每条建议的证据链→建议行动构成完整因果叙事
 * - 无边框设计：透明度差异 + 负空间分隔，无 1px 实色边框
 * - 松紧得当：摘要卡片稳带间距，建议列表项内紧外稳
 * - 即时反馈：筛选切换 150ms 过渡，卡片 hover 微升
 * - 流式输出：光标脉动 1s 周期，逐字渲染 60-80 字符/秒
 * - 优先级语义色：high=error / medium=warning / low=info（均使用 alpha 背景）
 * - 零硬编码色值：全部使用 CSS 自定义属性
 * - 仅 transform/opacity 动画
 */

import { memo, useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { Card, Icon, Button, AIBadge, Combobox } from '@/components/ui'
import { QuickVoiceAssist } from '@/components/ui/QuickVoiceAssist'
import { useDiagnosisStore } from '@/stores/diagnosis'
import { toast } from '@/stores/toast'
import { aiMessageText } from '@/lib/types'
import type {
    TeachingSuggestion,
    TeachingSuggestionResponse,
    TeachingSuggestionType,
    SuggestionPriority,
    StudentProfileResponse,
    StudentGap,
    PrescriptionOutput,
    AiChatMessage,
    AiThinkingMode,
} from '@/lib/types'
import './SuggestionPanel.css'

/** 建议类型标签映射 */
const TYPE_LABELS: Record<TeachingSuggestionType, string> = {
    weakness: '薄弱点',
    method: '教法调整',
    material: '素材补充',
    progress: '进度提醒',
    differentiate: '分层教学',
}

/** 建议类型图标映射 */
const TYPE_ICONS: Record<TeachingSuggestionType, string> = {
    weakness: 'warning-circle',
    method: 'gear',
    material: 'book-open',
    progress: 'chart-bar',
    differentiate: 'student',
}

/** 优先级标签映射 */
const PRIORITY_LABELS: Record<SuggestionPriority, string> = {
    high: '高优先级',
    medium: '中优先级',
    low: '低优先级',
}

/** 优先级排序权重（数字越小越靠前） */
const PRIORITY_WEIGHT: Record<SuggestionPriority, number> = {
    high: 0,
    medium: 1,
    low: 2,
}

/** 筛选选项类型 */
type FilterType = 'all' | TeachingSuggestionType
type FilterPriority = 'all' | SuggestionPriority

/** SuggestionPanel Props —— 双模式 */
interface SuggestionPanelProps {
    /**
     * 模式 A：教学建议响应（含建议列表 + 数据摘要） —— DashboardPage 兼容
     * 当 studentId 未提供时使用此模式
     */
    response?: TeachingSuggestionResponse
    /** 模式 A 加载态 */
    loading?: boolean

    /**
     * 模式 B：学生 ID —— DiagnosisPage AI 聊天模式
     * 提供此参数后进入 AI 流式对话模式
     */
    studentId?: string
    /** 模式 B：学生姓名（用于显示） */
    studentName?: string
    /** 模式 B：学生画像数据（注入 AI 上下文） */
    studentProfile?: StudentProfileResponse | null
    /** 模式 B：学生知识漏洞（注入 AI 上下文） */
    studentGaps?: StudentGap[]
    /** 模式 B：个性化处方（注入 AI 上下文） */
    prescription?: PrescriptionOutput | null
}

/* ──────────────────────────────────────────────────────────────
 * 模式 A：列表模式子组件（DashboardPage 兼容）
 * ────────────────────────────────────────────────────────────── */

/** 单条建议卡片 —— memo 包装，避免列表中其他项变化时重渲染 */
const SuggestionCard = memo(function SuggestionCard({ suggestion, index }: { suggestion: TeachingSuggestion; index: number }) {
    const typeIcon = TYPE_ICONS[suggestion.type]
    const typeLabel = TYPE_LABELS[suggestion.type]
    const priorityLabel = PRIORITY_LABELS[suggestion.priority]

    return (
        <article
            className={`pr-suggestion-card pr-suggestion-card--${suggestion.priority}`}
            style={{ ['--suggestion-index' as string]: `${index}` }}
        >
            {/* 左侧优先级指示条（3px，无 hard border，使用 alpha 色） */}
            <span
                className="pr-suggestion-priority-bar"
                aria-hidden="true"
                data-priority={suggestion.priority}
            />

            <div className="pr-suggestion-card-body">
                {/* 头部：类型标签 + 优先级 + AI 标记 */}
                <div className="pr-suggestion-header">
                    <div className="pr-suggestion-header-left">
                        <span className={`pr-suggestion-type-tag pr-suggestion-type-tag--${suggestion.type}`}>
                            <Icon name={typeIcon} size={12} />
                            <span>{typeLabel}</span>
                        </span>
                        {suggestion.bloomLevel && (
                            <span className="pr-suggestion-bloom-tag">
                                {suggestion.bloomLevel}
                            </span>
                        )}
                        {suggestion.poemTitle && (
                            <span className="pr-suggestion-poem-tag">
                                <Icon name="feather" size={10} />
                                <span>{suggestion.poemTitle}</span>
                            </span>
                        )}
                    </div>
                    <div className="pr-suggestion-header-right">
                        {suggestion.aiGenerated && (
                            <span className="pr-suggestion-ai-badge">
                                <Icon name="magic-wand" size={10} />
                                <span>AI 生成</span>
                            </span>
                        )}
                        <span
                            className={`pr-suggestion-priority-tag pr-suggestion-priority-tag--${suggestion.priority}`}
                        >
                            {priorityLabel}
                        </span>
                    </div>
                </div>

                {/* 标题 */}
                <h4 className="pr-suggestion-title">{suggestion.title}</h4>

                {/* 描述 */}
                <p className="pr-suggestion-description">{suggestion.description}</p>

                {/* 数据证据链 */}
                <div className="pr-suggestion-evidence">
                    <div className="pr-suggestion-evidence-label">
                        <Icon name="database" size={11} />
                        <span>数据证据</span>
                    </div>
                    <p className="pr-suggestion-evidence-text">{suggestion.evidence}</p>
                </div>

                {/* 建议行动 */}
                <div className="pr-suggestion-action">
                    <div className="pr-suggestion-action-label">
                        <Icon name="magic-wand" size={11} />
                        <span>建议行动</span>
                    </div>
                    <p className="pr-suggestion-action-text">{suggestion.suggestedAction}</p>
                </div>

                {/* 底部元信息 */}
                <div className="pr-suggestion-footer">
                    {suggestion.affectedStudentCount !== undefined && (
                        <span className="pr-suggestion-meta-item">
                            <Icon name="user" size={11} />
                            <span>影响 {suggestion.affectedStudentCount} 名学生</span>
                        </span>
                    )}
                    <span className="pr-suggestion-meta-item">
                        <Icon name="arrows-clockwise" size={11} />
                        <span>{formatRelativeTime(suggestion.generatedAt)}</span>
                    </span>
                </div>
            </div>
        </article>
    )
})

/** 格式化相对时间 */
function formatRelativeTime(timestamp: number): string {
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / (1000 * 60))
    if (minutes < 1) return '刚刚生成'
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} 小时前`
    const days = Math.floor(hours / 24)
    return `${days} 天前`
}

/** 骨架屏 */
function SuggestionSkeleton() {
    return (
        <div className="pr-suggestion-skeleton-list">
            {[0, 1, 2].map((i) => (
                <div className="pr-suggestion-skeleton-card" key={i}>
                    <div className="pr-suggestion-skeleton-line pr-suggestion-skeleton-line--short" />
                    <div className="pr-suggestion-skeleton-line pr-suggestion-skeleton-line--long" />
                    <div className="pr-suggestion-skeleton-line pr-suggestion-skeleton-line--medium" />
                    <div className="pr-suggestion-skeleton-line pr-suggestion-skeleton-line--long" />
                </div>
            ))}
        </div>
    )
}

/** 空状态 */
function SuggestionEmpty({ hasFilter, onReset }: { hasFilter: boolean; onReset: () => void }) {
    return (
        <div className="pr-suggestion-empty">
            <Icon name="lightbulb" size={32} />
            <p className="pr-suggestion-empty-title">
                {hasFilter ? '当前筛选下暂无建议' : '暂无教学建议'}
            </p>
            <p className="pr-suggestion-empty-hint">
                {hasFilter
                    ? '当前类型或优先级筛选下没有匹配的教学建议，可重置筛选查看全部建议。'
                    : '请确保已选择班级，且班级已有诊断数据与错题记录，AI 将据此生成针对性教学建议。'}
            </p>
            {hasFilter && (
                <button type="button" className="pr-suggestion-empty-cta" onClick={onReset}>
                    重置筛选
                </button>
            )}
        </div>
    )
}

/* ──────────────────────────────────────────────────────────────
 * 模式 A：列表视图组件
 * ────────────────────────────────────────────────────────────── */

function SuggestionListView({ response, loading }: { response: TeachingSuggestionResponse; loading?: boolean }) {
    const [filterType, setFilterType] = useState<FilterType>('all')
    const [filterPriority, setFilterPriority] = useState<FilterPriority>('all')

    /** 筛选 + 排序后的建议列表 */
    const filteredSuggestions = useMemo(() => {
        let list = [...response.suggestions]
        if (filterType !== 'all') {
            list = list.filter((s) => s.type === filterType)
        }
        if (filterPriority !== 'all') {
            list = list.filter((s) => s.priority === filterPriority)
        }
        // 按优先级排序（high → medium → low），同优先级按生成时间降序
        list.sort((a, b) => {
            const pw = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]
            if (pw !== 0) return pw
            return b.generatedAt - a.generatedAt
        })
        return list
    }, [response.suggestions, filterType, filterPriority])

    /** 数据摘要 */
    const summary = response.dataSummary

    /** 类型筛选选项（仅显示有数据的类型） */
    const typeOptions: Array<{ value: FilterType; label: string; count: number }> = useMemo(() => {
        const types = ['all', 'weakness', 'method', 'material', 'progress', 'differentiate'] as const
        return types.map((t) => ({
            value: t,
            label: t === 'all' ? '全部类型' : TYPE_LABELS[t],
            count: t === 'all'
                ? response.suggestions.length
                : response.suggestions.filter((s) => s.type === t).length,
        })).filter((o) => o.count > 0)
    }, [response.suggestions])

    /** 优先级筛选选项 */
    const priorityOptions: Array<{ value: FilterPriority; label: string; count: number }> = useMemo(() => {
        const priorities = ['all', 'high', 'medium', 'low'] as const
        return priorities.map((p) => ({
            value: p,
            label: p === 'all' ? '全部优先级' : PRIORITY_LABELS[p],
            count: p === 'all'
                ? response.suggestions.length
                : response.suggestions.filter((s) => s.priority === p).length,
        })).filter((o) => o.count > 0)
    }, [response.suggestions])

    return (
        <div className="pr-suggestion-panel pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '0ms' }}>
            {/* ── 区域 1：数据摘要卡片 ── */}
            <section className="pr-suggestion-summary-grid" aria-label="班级诊断数据摘要">
                <Card className="pr-suggestion-summary-card pr-suggestion-summary-card--mastery" padding="md">
                    <div className="pr-suggestion-summary-icon-wrap" data-tone="primary">
                        <Icon name="graph" size={18} />
                    </div>
                    <div className="pr-suggestion-summary-content">
                        <span className="pr-suggestion-summary-label">班级综合掌握度</span>
                        <span className="pr-suggestion-summary-value">
                            {Math.round(summary.classMasteryAvg)}
                            <span className="pr-suggestion-summary-unit">分</span>
                        </span>
                        <div className="pr-suggestion-summary-bar" aria-hidden="true">
                            <span
                                className="pr-suggestion-summary-bar-fill"
                                style={{ transform: `scaleX(${Math.min(1, summary.classMasteryAvg / 100)})` }}
                            />
                        </div>
                    </div>
                </Card>

                <Card className="pr-suggestion-summary-card pr-suggestion-summary-card--dark" padding="md">
                    <div className="pr-suggestion-summary-icon-wrap" data-tone="error">
                        <Icon name="brain" size={18} />
                    </div>
                    <div className="pr-suggestion-summary-content">
                        <span className="pr-suggestion-summary-label">共性薄弱点总数</span>
                        <span className="pr-suggestion-summary-value">
                            {summary.darkMatterCount}
                            <span className="pr-suggestion-summary-unit">个</span>
                        </span>
                        <span className="pr-suggestion-summary-hint">共性薄弱点</span>
                    </div>
                </Card>

                <Card className="pr-suggestion-summary-card pr-suggestion-summary-card--weak" padding="md">
                    <div className="pr-suggestion-summary-icon-wrap" data-tone="warning">
                        <Icon name="check-circle" size={18} />
                    </div>
                    <div className="pr-suggestion-summary-content">
                        <span className="pr-suggestion-summary-label">最薄弱认知层级</span>
                        <span className="pr-suggestion-summary-value pr-suggestion-summary-value--text">
                            {summary.weakestBloomLevel}
                        </span>
                        <span className="pr-suggestion-summary-hint">需重点突破</span>
                    </div>
                </Card>

                <Card className="pr-suggestion-summary-card pr-suggestion-summary-card--due" padding="md">
                    <div className="pr-suggestion-summary-icon-wrap" data-tone="info">
                        <Icon name="calendar" size={18} />
                    </div>
                    <div className="pr-suggestion-summary-content">
                        <span className="pr-suggestion-summary-label">今日待复习错题</span>
                        <span className="pr-suggestion-summary-value">
                            {summary.dueTodayCount}
                            <span className="pr-suggestion-summary-unit">道</span>
                        </span>
                        <span className="pr-suggestion-summary-hint">SM-2 算法到期</span>
                    </div>
                </Card>
            </section>

            {/* ── 区域 2：筛选工具栏 ── */}
            <section className="pr-suggestion-toolbar" aria-label="建议筛选">
                <div className="pr-suggestion-toolbar-group">
                    <span className="pr-suggestion-toolbar-label">
                        <Icon name="faders-horizontal" size={12} />
                        <span>类型</span>
                    </span>
                    <div className="pr-suggestion-filter-chips" role="group" aria-label="按类型筛选">
                        {typeOptions.map((opt) => (
                            <button
                                key={opt.value}
                                type="button"
                                className={`pr-suggestion-chip ${filterType === opt.value ? 'is-active' : ''}`}
                                onClick={() => setFilterType(opt.value)}
                                aria-pressed={filterType === opt.value}
                            >
                                <span>{opt.label}</span>
                                <span className="pr-suggestion-chip-count">{opt.count}</span>
                            </button>
                        ))}
                    </div>
                </div>

                <div className="pr-suggestion-toolbar-divider" aria-hidden="true" />

                <div className="pr-suggestion-toolbar-group">
                    <span className="pr-suggestion-toolbar-label">
                        <Icon name="bell" size={12} />
                        <span>优先级</span>
                    </span>
                    <div className="pr-suggestion-filter-chips" role="group" aria-label="按优先级筛选">
                        {priorityOptions.map((opt) => (
                            <button
                                key={opt.value}
                                type="button"
                                className={`pr-suggestion-chip pr-suggestion-chip--${opt.value} ${filterPriority === opt.value ? 'is-active' : ''}`}
                                onClick={() => setFilterPriority(opt.value)}
                                aria-pressed={filterPriority === opt.value}
                            >
                                <span>{opt.label}</span>
                                <span className="pr-suggestion-chip-count">{opt.count}</span>
                            </button>
                        ))}
                    </div>
                </div>

                <div className="pr-suggestion-toolbar-count">
                    <Icon name="lightbulb" size={12} />
                    <span>共 {filteredSuggestions.length} 条建议</span>
                </div>
            </section>

            {/* ── 区域 3：建议列表 ── */}
            <section className="pr-suggestion-list" aria-label="教学建议列表">
                {loading ? (
                    <SuggestionSkeleton />
                ) : filteredSuggestions.length === 0 ? (
                    <SuggestionEmpty
                        hasFilter={filterType !== 'all' || filterPriority !== 'all'}
                        onReset={() => {
                            setFilterType('all')
                            setFilterPriority('all')
                        }}
                    />
                ) : (
                    filteredSuggestions.map((suggestion, index) => (
                        <SuggestionCard
                            key={suggestion.id}
                            suggestion={suggestion}
                            index={index}
                        />
                    ))
                )}
            </section>

            {/* ── 区域 4：AI 生成声明 ── */}
            {response.aiGenerated && !loading && filteredSuggestions.length > 0 && (
                <footer className="pr-suggestion-ai-footer">
                    <Icon name="info" size={11} />
                    <span>
                        以上建议由 AI 基于班级诊断数据与错题本数据综合生成，仅供教学参考。
                        生成时间：{new Date(response.generatedAt).toLocaleString('zh-CN')}
                    </span>
                </footer>
            )}
        </div>
    )
}

/* ──────────────────────────────────────────────────────────────
 * 模式 B：AI 流式对话视图
 * ────────────────────────────────────────────────────────────── */

/** 快速提问建议（教师可一键发送） */
const QUICK_PROMPTS: Array<{ key: string; label: string; icon: string; prompt: string }> = [
    {
        key: 'diagnose',
        label: '诊断现状',
        icon: 'brain',
        prompt: '请基于该学生的六阶能力雷达与知识漏洞，诊断当前认知现状，指出最关键的 2-3 个薄弱点。',
    },
    {
        key: 'strategy',
        label: '教学策略',
        icon: 'lightbulb',
        prompt: '针对该学生的薄弱点，给出 3 条具体可执行的教学策略，每条策略需说明预期效果。',
    },
    {
        key: 'activity',
        label: '学习活动',
        icon: 'target',
        prompt: '为该学生设计一个 15 分钟的针对性学习活动，包含步骤与检查节点。',
    },
    {
        key: 'goal',
        label: 'SMART 目标',
        icon: 'flag',
        prompt: '为该学生制定本周的 SMART 目标，覆盖具体、可测、可达、相关、时限、验证六个维度。',
    },
]

const DIAGNOSIS_FOLLOW_UPS = [
    '先给我最优先的一步',
    '改成适合家长理解的说法',
    '生成一周练习安排',
    '给出可观察的检查标准',
] as const

/** 思考模式选择 */
const THINKING_MODES: Array<{ value: AiThinkingMode; label: string }> = [
    { value: 'high', label: '标准深度（DeepSeek high）' },
    { value: 'max', label: '最大深度（仅 V4 Pro）' },
]

/** 单条对话消息渲染 */
const ChatMessage = memo(function ChatMessage({ message }: { message: AiChatMessage }) {
    const isUser = message.role === 'user'
    const isAssistant = message.role === 'assistant'
    return (
        <article className={`pr-suggestion-chat-msg ${isUser ? 'is-user' : 'is-assistant'}`}>
            <div className="pr-suggestion-chat-avatar" aria-hidden>
                <Icon name={isUser ? 'user' : 'sparkle'} size={14} />
            </div>
            <div className="pr-suggestion-chat-bubble">
                <div className="pr-suggestion-chat-role">
                    {isUser ? '教师' : 'AI 助教'}
                    {isAssistant && <AIBadge size="xs" label="deepseek-v4-pro" />}
                </div>
                <div className="pr-suggestion-chat-content">{aiMessageText(message.content)}</div>
            </div>
        </article>
    )
})

/** 流式输出区域 —— 打字机效果 + 脉动光标 */
function StreamingOutput({ text, reasoning }: { text: string; reasoning?: string }) {
    const scrollRef = useRef<HTMLDivElement>(null)

    /** 流式输出时自动滚动到底部 */
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
    }, [text, reasoning])

    if (!text && !reasoning) return null
    return (
        <article className="pr-suggestion-chat-msg is-assistant is-streaming">
            <div className="pr-suggestion-chat-avatar" aria-hidden>
                <Icon name="sparkle" size={14} />
            </div>
            <div className="pr-suggestion-chat-bubble">
                <div className="pr-suggestion-chat-role">
                    AI 助教
                    <AIBadge size="xs" label="生成中" />
                </div>
                {reasoning && (
                    <details className="pr-suggestion-chat-reasoning">
                        <summary>
                            <Icon name="brain" size={11} />
                            <span>思考过程</span>
                        </summary>
                        <div className="pr-suggestion-chat-reasoning-body">{reasoning}</div>
                    </details>
                )}
                <div
                    ref={scrollRef}
                    className="pr-suggestion-chat-content pr-suggestion-chat-content--streaming"
                >
                    {text}
                    <span className="pr-suggestion-chat-cursor" aria-hidden>
                        <span className="pr-suggestion-chat-cursor-dot" />
                    </span>
                </div>
            </div>
        </article>
    )
}

/** AI 聊天视图主组件 */
function SuggestionChatView({
    studentId,
    studentName,
    studentProfile,
    studentGaps,
    prescription,
}: {
    studentId: string
    studentName?: string
    studentProfile?: StudentProfileResponse | null
    studentGaps?: StudentGap[]
    prescription?: PrescriptionOutput | null
}) {
    const [input, setInput] = useState('')
    const [thinkingMode, setThinkingMode] = useState<AiThinkingMode>('high')

    // 订阅 store 中的 AI 建议流式状态
    const messages = useDiagnosisStore((s) => s.suggestionMessages)
    const streamingText = useDiagnosisStore((s) => s.streamingSuggestionText)
    const streamingReasoning = useDiagnosisStore((s) => s.streamingSuggestionReasoning)
    const isStreaming = useDiagnosisStore((s) => s.loading.aiSuggestion)
    const suggestionError = useDiagnosisStore((s) => s.suggestionError)
    const streamSuggestion = useDiagnosisStore((s) => s.streamSuggestion)
    const abortSuggestionStream = useDiagnosisStore((s) => s.abortSuggestionStream)
    const clearSuggestion = useDiagnosisStore((s) => s.clearSuggestion)

    const messagesEndRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)

    /** 自动滚动到最新消息 */
    useEffect(() => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
        }
    }, [messages, streamingText])

    /** 构造上下文摘要（注入 system prompt） */
    const contextSummary = useMemo(() => {
        const parts: string[] = []
        if (studentName) parts.push(`学生姓名：${studentName}`)
        if (studentProfile) {
            const radar = studentProfile.bloomRadar
            const radarStr = Object.entries(radar)
                .map(([k, v]) => `${k}:${Math.round(v)}`)
                .join(' / ')
            parts.push(`六阶能力雷达：${radarStr}`)
        }
        if (studentGaps && studentGaps.length > 0) {
            const gapsStr = studentGaps
                .slice(0, 5)
                .map((g) => `${g.poemId}·${g.bloomLevel}`)
                .join('、')
            parts.push(`知识漏洞（前 5）：${gapsStr}`)
        }
        if (prescription) {
            const weaknesses = prescription.weaknesses
                .slice(0, 3)
                .map((w) => w.description)
                .join('、')
            parts.push(`处方薄弱点：${weaknesses}`)
        }
        return parts.join('；')
    }, [studentName, studentProfile, studentGaps, prescription])

    /** 发送消息 */
    const handleSend = useCallback(() => {
        const trimmed = input.trim()
        if (!trimmed || isStreaming) return

        const systemPrompt = `你是诗脉·启明系统的教学诊断助手，专注于为教师提供针对单个学生的个性化教学建议。

【当前学生上下文】
${contextSummary}

请基于上述学情数据，给出具体、可执行的教学策略。建议应包含：
1. 学生现状诊断（基于六阶认知模型）
2. 薄弱环节分析与归因
3. 针对性教学策略（含具体方法与资源）
4. 预期效果与检查节点

请使用清晰的 Markdown 格式输出，避免空洞的套话。`

        streamSuggestion({
            studentId,
            userMessage: trimmed,
            systemPrompt,
            thinkingMode,
        })
        setInput('')
        // 重新聚焦输入框
        requestAnimationFrame(() => inputRef.current?.focus())
    }, [input, isStreaming, contextSummary, studentId, thinkingMode, streamSuggestion])

    /** 快速提问 */
    const handleQuickPrompt = useCallback((prompt: string) => {
        if (isStreaming) return
        const systemPrompt = `你是诗脉·启明系统的教学诊断助手，专注于为教师提供针对单个学生的个性化教学建议。

【当前学生上下文】
${contextSummary}

请基于上述学情数据，给出具体、可执行的教学策略。请使用清晰的 Markdown 格式输出。`

        streamSuggestion({
            studentId,
            userMessage: prompt,
            systemPrompt,
            thinkingMode,
        })
    }, [isStreaming, contextSummary, studentId, thinkingMode, streamSuggestion])

    /** 键盘快捷键：Cmd/Ctrl+Enter 发送 */
    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            handleSend()
        }
    }, [handleSend])

    /** 中断流式 */
    const handleAbort = useCallback(() => {
        abortSuggestionStream()
        toast.info({ title: '已中断生成', message: '可继续追问或重新生成' })
    }, [abortSuggestionStream])

    /** 清空对话 */
    const handleClear = useCallback(() => {
        clearSuggestion()
        toast.info({ title: '对话已清空', message: '上下文记忆已重置' })
    }, [clearSuggestion])

    /** 错误重试 */
    const handleRetry = useCallback(() => {
        if (messages.length === 0) return
        const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
        if (!lastUserMsg) return
        clearSuggestion()
        // 重新发送上一条用户消息
        const systemPrompt = `你是诗脉·启明系统的教学诊断助手，专注于为教师提供针对单个学生的个性化教学建议。

【当前学生上下文】
${contextSummary}

请基于上述学情数据，给出具体、可执行的教学策略。请使用清晰的 Markdown 格式输出。`
        streamSuggestion({
            studentId,
            userMessage: aiMessageText(lastUserMsg.content),
            systemPrompt,
            thinkingMode,
        })
    }, [messages, clearSuggestion, contextSummary, studentId, thinkingMode, streamSuggestion])

    return (
        <div className="pr-suggestion-chat pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '0ms' }}>
            {/* ── 顶部：学生上下文摘要 + 操作工具栏 ── */}
            <header className="pr-suggestion-chat-header">
                <div className="pr-suggestion-chat-context">
                    <Icon name="user-circle" size={14} />
                    <span className="pr-suggestion-chat-context-name">
                        {studentName ?? '未命名学生'}
                    </span>
                    <span className="pr-suggestion-chat-context-divider" aria-hidden />
                    <span className="pr-suggestion-chat-context-summary">
                        {contextSummary || '暂无学情数据'}
                    </span>
                </div>
                <div className="pr-suggestion-chat-tools">
                    {/* 思考模式选择 —— Combobox 替代原生 select（规范 14.5） */}
                    <div className="pr-suggestion-chat-thinking">
                        <Icon name="brain" size={12} />
                        <Combobox
                            mode="single"
                            options={THINKING_MODES.map((m) => ({ value: m.value as string, label: m.label }))}
                            value={thinkingMode ?? ''}
                            onChange={(val) => {
                                const v = typeof val === 'string' ? val : ''
                                setThinkingMode((v || null) as AiThinkingMode)
                            }}
                            disabled={isStreaming}
                            ariaLabel="选择思考模式"
                            searchable={false}
                            className="pr-suggestion-chat-thinking-combobox"
                        />
                    </div>
                    {/* 清空对话 */}
                    <button
                        type="button"
                        className="pr-suggestion-chat-tool-btn"
                        onClick={handleClear}
                        disabled={isStreaming || messages.length === 0}
                        aria-label="清空对话"
                    >
                        <Icon name="trash" size={13} />
                        <span>清空</span>
                    </button>
                </div>
            </header>

            {/* ── 中部：消息列表 + 流式输出 ── */}
            <main className="pr-suggestion-chat-main">
                {messages.length === 0 && !isStreaming && !streamingText && !suggestionError && (
                    <div className="pr-suggestion-chat-welcome">
                        <Icon name="sparkle" size={32} />
                        <h3 className="pr-suggestion-chat-welcome-title">
                            AI 教学诊断助手
                        </h3>
                        <p className="pr-suggestion-chat-welcome-hint">
                            基于 deepseek-v4-pro 模型 + 学生学情数据，为教师提供个性化教学建议。
                            支持多轮对话，可随时中断与追问。
                        </p>
                        <div className="pr-suggestion-chat-quick-prompts">
                            {QUICK_PROMPTS.map((p) => (
                                <button
                                    key={p.key}
                                    type="button"
                                    className="pr-suggestion-chat-quick-prompt"
                                    onClick={() => handleQuickPrompt(p.prompt)}
                                    disabled={isStreaming}
                                >
                                    <Icon name={p.icon} size={13} />
                                    <span>{p.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* 历史消息 */}
                {messages.map((msg, idx) => (
                    <ChatMessage key={idx} message={msg} />
                ))}

                {/* 流式输出 */}
                {isStreaming && streamingText && (
                    <StreamingOutput text={streamingText} reasoning={streamingReasoning} />
                )}

                {/* 流式加载态（已发送但尚未收到首个 chunk） */}
                {isStreaming && !streamingText && (
                    <div className="pr-suggestion-chat-loading">
                        <span className="pr-suggestion-chat-loading-dot" />
                        <span className="pr-suggestion-chat-loading-dot" />
                        <span className="pr-suggestion-chat-loading-dot" />
                        <span className="pr-suggestion-chat-loading-text">AI 正在思考…</span>
                    </div>
                )}

                {/* 错误态 */}
                {suggestionError && !isStreaming && (
                    <div className="pr-suggestion-chat-error">
                        <Icon name="warning-circle" size={20} />
                        <p className="pr-suggestion-chat-error-title">AI 生成失败</p>
                        <p className="pr-suggestion-chat-error-msg">{suggestionError}</p>
                        <Button variant="secondary" size="sm" onClick={handleRetry}>
                            <Icon name="arrows-clockwise" size={13} />
                            重试
                        </Button>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </main>

            {/* ── 底部：输入区 + 中断/发送按钮 ── */}
            <footer className="pr-suggestion-chat-input-area">
                <QuickVoiceAssist
                    suggestions={DIAGNOSIS_FOLLOW_UPS}
                    onPick={setInput}
                    onTranscript={setInput}
                    label="点选追问，或直接说给 AI"
                    voiceLabel="语音追问"
                    disabled={isStreaming}
                    compact
                />
                <div className="pr-suggestion-chat-input-row">
                    <textarea
                        ref={inputRef}
                        className="pr-suggestion-chat-input"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={isStreaming ? 'AI 正在生成中，可点击中断按钮停止…' : '点选或说完后，可在这里补充'}
                        disabled={isStreaming}
                        rows={2}
                        aria-label="教学问题输入框"
                    />
                    <div className="pr-suggestion-chat-input-actions">
                        {isStreaming ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={handleAbort}
                                aria-label="中断 AI 生成"
                            >
                                <Icon name="stop" size={13} />
                                <span>中断</span>
                            </Button>
                        ) : (
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={handleSend}
                                disabled={!input.trim()}
                                aria-label="发送问题"
                            >
                                <Icon name="paper-plane" size={13} />
                                <span>发送</span>
                            </Button>
                        )}
                    </div>
                </div>
            </footer>

            {/* ── 多轮记忆指示器 ── */}
            {messages.length > 0 && (
                <div className="pr-suggestion-chat-memory">
                    <Icon name="stack" size={11} />
                    <span>
                        已记录 {Math.floor(messages.filter((m) => m.role === 'user').length)} 轮对话上下文
                        · 最近 3 轮将作为下次请求的上下文
                    </span>
                </div>
            )}
        </div>
    )
}

/* ──────────────────────────────────────────────────────────────
 * 主组件：双模式分发
 * ────────────────────────────────────────────────────────────── */

export function SuggestionPanel(props: SuggestionPanelProps) {
    // 模式 B：studentId 存在 → AI 聊天模式
    if (props.studentId) {
        return (
            <SuggestionChatView
                studentId={props.studentId}
                studentName={props.studentName}
                studentProfile={props.studentProfile}
                studentGaps={props.studentGaps}
                prescription={props.prescription}
            />
        )
    }

    // 模式 A：默认列表模式（DashboardPage 兼容）
    const response = props.response ?? {
        classId: '',
        suggestions: [],
        generatedAt: 0,
        dataSummary: {
            classMasteryAvg: 0,
            darkMatterCount: 0,
            weakestBloomLevel: '记忆',
            dueTodayCount: 0,
        },
        aiGenerated: false,
    }
    return <SuggestionListView response={response} loading={props.loading} />
}
