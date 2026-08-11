/**
 * 个性化处方卡片（v5.0 —— 学情诊断数据真实化）
 *
 * 重构说明：
 * - 旧版基于 DarkMatter（班级级暗物质模式），展示 pattern/rootCause/prescription
 * - 新版基于 PrescriptionOutput（学生级个性化处方），展示七大模块：
 *   portrait / strengths / weaknesses / suggestions / recommendations / activities / smartGoals
 * - 玻璃态设计：surface-elevated rgba(255,252,248,0.85) + backdrop-blur 20px（规范 14.3 / 2.3）
 *
 * 数据来源：GET /api/diagnosis/students/:id/prescription
 * 流式变体：streamingPrescriptionText（逐字累积，打字机效果）
 *
 * 设计要点（规范第 2、4、5、6、7、14 章）：
 * - 玻璃态材质：GlassCard blur="normal"（backdrop-blur 20px + 85% alpha）
 * - 无硬编码色值：全部使用 CSS 自定义属性
 * - 松紧得当：模块间稳带间距，模块内紧带
 * - 三态交互：hover 微升 + 微边框
 * - 流体尺寸：clamp() 响应视口
 * - 仅 transform/opacity 动画
 * - 严重度语义色：weakness severity >=60 error / >=30 warning / else info
 * - 优先级语义色：high error / medium warning / low info
 */

import { memo, useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { GlassCard, Icon, AIBadge, Button } from '@/components/ui'
import { toast } from '@/stores/toast'
import type {
    PrescriptionOutput,
    StrengthItem,
    WeaknessItem,
    SuggestionItem,
    RecommendationItem,
    ActivityItem,
    SmartGoal,
    StudentPortrait,
} from '@/lib/types'

interface PrescriptionCardProps {
    /** 学生级个性化处方数据（来自 GET /api/diagnosis/students/:id/prescription） */
    prescription: PrescriptionOutput | null
    /** 流式累积的处方文本（可选，逐字累积用于打字机效果） */
    streamingText?: string
    /** 加载态（首次拉取或流式生成中） */
    loading?: boolean
    /** 错误信息（拉取失败时显示） */
    error?: string | null
    /** 默认展开所有模块（默认折叠，仅显示画像摘要） */
    defaultExpanded?: boolean
    /** 派发回调（将处方下发到工坊/副驾） */
    onDispatch?: (prescription: PrescriptionOutput) => void
    /** 重试回调（拉取失败时点击重试） */
    onRetry?: () => void
    /** 显式启动 AI 深度生成；页面初始只读取快速数据处方 */
    onGenerate?: () => void
}

/* ──────────────────────────────────────────────────────────────
 * 辅助函数
 * ────────────────────────────────────────────────────────────── */

/** 推荐节奏中文标签 */
const PACE_LABELS: Record<StudentPortrait['recommendedPace'], string> = {
    slow: '慢速',
    medium: '常速',
    fast: '加速',
}

/** 建议类别中文标签 */
const CATEGORY_LABELS: Record<SuggestionItem['category'], string> = {
    reinforce: '巩固强化',
    extend: '拓展延伸',
    remediate: '补救教学',
    enrich: '丰富深化',
    pace: '节奏调整',
}

/** 建议类别图标 */
const CATEGORY_ICONS: Record<SuggestionItem['category'], string> = {
    reinforce: 'shield',
    extend: 'arrows-out-simple',
    remediate: 'first-aid-kit',
    enrich: 'sparkle',
    pace: 'timer',
}

/** 优先级中文标签 */
const PRIORITY_LABELS: Record<SuggestionItem['priority'], string> = {
    high: '高优先级',
    medium: '中优先级',
    low: '低优先级',
}

/** 资源类型中文标签 */
const RECO_TYPE_LABELS: Record<RecommendationItem['type'], string> = {
    poem: '诗篇',
    lesson: '课程',
    exercise: '练习',
    material: '素材',
    activity: '活动',
}


const ACTIVITY_TYPE_LABELS: Record<ActivityItem['type'], string> = {
    recite: '朗读',
    translate: '翻译',
    analyze: '分析',
    compare: '比较',
    create: '创作',
    discuss: '讨论',
    practice: '练习',
    game: '游戏',
}

/** 活动类型图标 */
const ACTIVITY_TYPE_ICONS: Record<ActivityItem['type'], string> = {
    recite: 'microphone',
    translate: 'translate',
    analyze: 'brain',
    compare: 'arrows-left-right',
    create: 'pencil',
    discuss: 'chat-circle',
    practice: 'pen',
    game: 'game-controller',
}

/** 严重度 → 语义 token */
function severityToken(severity: number): 'error' | 'warning' | 'info' {
    if (severity >= 60) return 'error'
    if (severity >= 30) return 'warning'
    return 'info'
}

/** 优先级 → 语义 token */
function priorityToken(priority: SuggestionItem['priority']): 'error' | 'warning' | 'info' {
    if (priority === 'high') return 'error'
    if (priority === 'medium') return 'warning'
    return 'info'
}

/* ──────────────────────────────────────────────────────────────
 * 子组件：模块标题
 * ────────────────────────────────────────────────────────────── */

const ModuleTitle = memo(function ModuleTitle({
    icon,
    title,
    count,
}: {
    icon: string
            title: string
    count?: number
}) {
    return (
                <div className="pr-rx-module-title">
            <Icon name={icon} size={14} />
            <span>{title}</span>
            {count !== undefined && count > 0 && (
                <span className="pr-rx-module-count">{count}</span>
            )}
        </div>
    )
})

/* ──────────────────────────────────────────────────────────────
 * 子组件：学生画像
 * ────────────────────────────────────────────────────────────── */

const PortraitSection = memo(function PortraitSection({ portrait }: { portrait: StudentPortrait }) {
    return (
        <div className="pr-rx-portrait">
            <div className="pr-rx-portrait-summary">{portrait.summary}</div>
            <div className="pr-rx-portrait-meta">
                <span className="pr-rx-portrait-tag">
                    <Icon name="brain" size={11} />
                    <span>{portrait.cognitiveStyle}</span>
                </span>
                <span className="pr-rx-portrait-tag">
                    <Icon name="timer" size={11} />
                    <span>推荐节奏：{PACE_LABELS[portrait.recommendedPace]}</span>
                </span>
                <span className="pr-rx-portrait-tag">
                    <Icon name="flag" size={11} />
                    <span>{portrait.currentStage}</span>
                </span>
            </div>
        </div>
    )
})

/* ──────────────────────────────

 * ────────────────────────────────────────────────────────────── */

const StrengthList = memo(function StrengthList({ items }: { items: StrengthItem[] }) {

    return (
        <ul className="pr-rx-strength-list">
            {items.map((item, idx) => (
                <li key={idx} className="pr-rx-strength-item">
                    <span className="pr-rx-strength-icon" aria-hidden>
                        <Icon name="check-circle" size={13} />
                    </span>
                    <div className="pr-rx-strength-body">
                        <p className="pr-rx-strength-desc">{item.description}</p>
                        {item.evidence && (
                            <p className="pr-rx-strength-evidence">{item.evidence}</p>
                        )}
                    </div>
                </li>
            ))}
        </ul>
    )
})

/* ──────────────

 * ────────────────────────────────────────────────────────────── */

const WeaknessList = memo(function WeaknessList({ items }: { items: WeaknessItem[] }) {
    if (items.length === 0) return null
    return (
        <ul className="pr-rx-weakness-list">
            {items.map((item, idx) => {
                const token = severityToken(item.severity)
                return (
                    <li key={idx} className="pr-rx-weakness-item" data-severity={token}>
                        <span className="pr-rx-weakness-bar" aria-hidden />
                        <div className="pr-rx-weakness-body">
                            <div className="pr-rx-weakness-header">
                                <p className="pr-rx-weakness-desc">{item.description}</p>
                                <span className={`pr-rx-severity-tag pr-rx-severity-tag--${token}`}>
                                    {Math.round(item.severity)}%
                                </span>
                            </div>
                            {item.rootCause && (
                                <p className="pr-rx-weakness-cause">
                                    <Icon name="lightbulb" size={11} />
                                    <span>{item.rootCause}</span>
                                </p>
                            )}
                        </div>
                    </li>
                )
            })}
        </ul>
    )
})

/* ──────────────────────────────────────────────────────────────
 * 子组件：教学建议列表
 * ────────────────────────────────────────────────────────────── */

const SuggestionList = memo(function SuggestionList({ items }: { items: SuggestionItem[] }) {
    if (items.length === 0) return null
    return (
        <div className="pr-rx-suggestion-list">
            {items.map((item, idx) => {
                const token = priorityToken(item.priority)
                const icon = CATEGORY_ICONS[item.category]
                return (
                    <article key={idx} className="pr-rx-suggestion-item" data-priority={token}>
                        <span className="pr-rx-suggestion-bar" aria-hidden />
                        <div className="pr-rx-suggestion-body">
                            <div className="pr-rx-suggestion-header">
                                <span className="pr-rx-suggestion-category">
                                    <Icon name={icon} size={12} />
                                    <span>{CATEGORY_LABELS[item.category]}</span>
                                </span>
                                <span className={`pr-rx-priority-tag pr-rx-priority-tag--${token}`}>
                                    {PRIORITY_LABELS[item.priority]}
                                </span>
                            </div>
                            <h5 className="pr-rx-suggestion-title">{item.title}</h5>
                            <p className="pr-rx-suggestion-desc">{item.description}</p>
                        </div>
                    </article>
                )
            })}
        </div>
    )
})

/* ──────────────────────────────────────────────────────────────
 * 子组件：资源推荐列表
 * ────────────────────────────────────────────────────────────── */

const RecommendationList = memo(function RecommendationList({ items }: { items: RecommendationItem[] }) {
    if (items.length === 0) return null
    return (
        <ul className="pr-rx-reco-list">
            {items.map((item, idx) => (
                <li key={idx} className="pr-rx-reco-item">
                    <span className="pr-rx-reco-type">{RECO_TYPE_LABELS[item.type]}</span>
                    <div className="pr-rx-reco-body">
                        <p className="pr-rx-reco-title">{item.title}</p>
                        <p className="pr-rx-reco-reason">{item.reason}</p>
                    </div>
                    <span className="pr-rx-reco-time">
                        <Icon name="timer" size={11} />
                        {item.estimatedMinutes} 分钟
                    </span>
                </li>
            ))}
        </ul>
    )
})

/* ──────────────────────────────────────────────────────────────
 * 子组件：学习活动列表
 * ────────────────────────────────────────────────────────────── */

const ActivityList = memo(function ActivityList({ items }: { items: ActivityItem[] }) {
    if (items.length === 0) return null
    return (
        <div className="pr-rx-activity-list">
            {items.map((item, idx) => {
                const icon = ACTIVITY_TYPE_ICONS[item.type]
                return (
                    <article key={idx} className="pr-rx-activity-item">
                        <div className="pr-rx-activity-header">
                            <span className="pr-rx-activity-type">
                                <Icon name={icon} size={12} />
                                <span>{ACTIVITY_TYPE_LABELS[item.type]}</span>
                            </span>
                            <span className="pr-rx-activity-time">
                                <Icon name="timer" size={11} />
                                {item.estimatedMinutes} 分钟
                            </span>
                        </div>
                        <h5 className="pr-rx-activity-title">{item.title}</h5>
                        <p className="pr-rx-activity-desc">{item.description}</p>
                        {item.steps.length > 0 && (
                            <ol className="pr-rx-activity-steps">
                                {item.steps.map((step, sIdx) => (
                                    <li key={sIdx} className="pr-rx-activity-step">
                                        <span className="pr-rx-activity-step-num">{sIdx + 1}</span>
                                        <span>{step}</span>
                                    </li>
                                ))}
                            </ol>
                        )}
                    </article>
                )
            })}
        </div>
    )
})

/* ──────────────────────────────────────────────────────────────
 * 子组件：SMART 目标列表
 * ────────────────────────────────────────────────────────────── */

const SmartGoalList = memo(function SmartGoalList({ items }: { items: SmartGoal[] }) {
    if (items.length === 0) return null
    return (
        <div className="pr-rx-goal-list">
            {items.map((item, idx) => (
                <article key={idx} className="pr-rx-goal-item">
                    <h5 className="pr-rx-goal-title">{item.title}</h5>
                    <dl className="pr-rx-goal-grid">
                        <div className="pr-rx-goal-cell">
                            <dt>S · 具体</dt>
                            <dd>{item.specific}</dd>
                        </div>
                        <div className="pr-rx-goal-cell">
                            <dt>M · 可测</dt>
                            <dd>{item.measurable}</dd>
                        </div>
                        <div className="pr-rx-goal-cell">
                            <dt>A · 可达</dt>
                            <dd>{item.achievable}</dd>
                        </div>
                        <div className="pr-rx-goal-cell">
                            <dt>R · 相关</dt>
                            <dd>{item.relevant}</dd>
                        </div>
                        <div className="pr-rx-goal-cell">
                            <dt>T · 时限</dt>
                            <dd>{item.timeBound}</dd>
                        </div>
                        <div className="pr-rx-goal-cell pr-rx-goal-cell--verify">
                            <dt>验证</dt>
                            <dd>{item.verification}</dd>
                        </div>
                    </dl>
                </article>
            ))}
        </div>
    )
})

/* ──────────────────────────────────────────────────────────────
 * 子组件：骨架屏
 * ────────────────────────────────────────────────────────────── */

function PrescriptionSkeleton() {
    return (
        <div className="pr-rx-skeleton">
            <div className="pr-rx-skeleton-line pr-rx-skeleton-line--lg" />
            <div className="pr-rx-skeleton-line pr-rx-skeleton-line--md" />
            <div className="pr-rx-skeleton-line pr-rx-skeleton-line--sm" />
            <div className="pr-rx-skeleton-modules">
                {[0, 1, 2, 3].map((i) => (
                    <div className="pr-rx-skeleton-module" key={i}>
                        <div className="pr-rx-skeleton-line pr-rx-skeleton-line--sm" />
                        <div className="pr-rx-skeleton-line pr-rx-skeleton-line--lg" />
                    </div>
                ))}
            </div>
        </div>
    )
}

/* ──────────────────────────────────────────────────────────────
 * 子组件：错误态
 * ────────────────────────────────────────────────────────────── */

function PrescriptionError({ message, onRetry }: { message: string; onRetry?: () => void }) {
    return (
        <div className="pr-rx-error">
            <Icon name="warning-circle" size={28} />
            <p className="pr-rx-error-title">个性化处方加载失败</p>
            <p className="pr-rx-error-msg">{message}</p>
            {onRetry && (
                <Button variant="secondary" size="sm" onClick={onRetry}>
                    <Icon name="arrows-clockwise" size={13} />
                    重试
                </Button>
            )}
        </div>
    )
}

/* ──────────────────────────────────────────────────────────────
 * 子组件：空状态
 * ────────────────────────────────────────────────────────────── */

function PrescriptionEmpty() {
    return (
        <div className="pr-rx-empty">
            <Icon name="clipboard-text" size={28} />
            <p className="pr-rx-empty-title">暂无个性化处方</p>
            <p className="pr-rx-empty-hint">
                请先选择学生，系统将基于学生画像与诊断数据生成个性化处方
            </p>
        </div>
    )
}

/* ──────────────────────────────────────────────────────────────
 * 主组件
 * ────────────────────────────────────────────────────────────── */

export const PrescriptionCard = memo(function PrescriptionCard({
    prescription,
    streamingText,
    loading,
    error,
    defaultExpanded = false,
    onDispatch,
    onRetry,
    onGenerate,
}: PrescriptionCardProps) {
    const [expanded, setExpanded] = useState(defaultExpanded)
    const [dispatching, setDispatching] = useState(false)
    const dispatchTimerRef = useRef<number | null>(null)

    useEffect(() => {
        return () => {
            if (dispatchTimerRef.current !== null) {
                window.clearTimeout(dispatchTimerRef.current)
            }
        }
    }, [])

    const handleToggle = useCallback(() => {
        setExpanded((v) => !v)
    }, [])

    const handleDispatch = useCallback(() => {
        if (dispatching || !prescription) return
        setDispatching(true)
        try {
            if (onDispatch) {
                onDispatch(prescription)
            } else {
                toast.success({
                    title: '处方已派发',
                    message: `已将「${prescription.anonymousName}」的处方推送至命题工坊`,
                })
            }
        } finally {
            dispatchTimerRef.current = window.setTimeout(() => setDispatching(false), 300)
        }
    }, [dispatching, prescription, onDispatch])

    /** 流式态：有 streamingText 且尚未生成结构化 prescription */
    const isStreaming = streamingText !== undefined && streamingText.length > 0 && !prescription

    /** 加载态：首次拉取（无 prescription 且 loading=true） */
    const isLoadingFirst = !!loading && !prescription && !isStreaming

    /** 错误态 */
    const hasError = !!error && !prescription

    /** 空状态 */
    const isEmpty = !prescription && !loading && !error && (!streamingText || streamingText.length === 0)

    /** 折叠态摘要：取 portrait.summary 前 60 字 */
    const summaryText = useMemo(() => {
        if (prescription?.portrait?.summary) {
            const s = prescription.portrait.summary
            return s.length > 60 ? `${s.slice(0, 60)}…` : s
        }
        return ''
    }, [prescription])

    return (
        <GlassCard
            interactive
            blur="normal"
            className="pr-rx-card"
            padding="lg"
        >
            {/* ── 头部：学生标识 + 置信度 + 展开按钮 ── */}
            <div className="pr-rx-header">
                <div className="pr-rx-header-left">
                    <div className="pr-rx-title-row">
                        <span className="pr-rx-icon-wrap" aria-hidden>
                            <Icon name="clipboard-text" size={16} />
                        </span>
                        <h3 className="pr-rx-title">个性化处方</h3>
                        {prescription?.aiGenerated ? (
                            <AIBadge size="xs" label="AI 深度生成" />
                        ) : (
                            <span className="pr-rx-data-badge">学情数据生成</span>
                        )}
                    </div>
                    {prescription && (
                        <div className="pr-rx-meta">
                            <span className="pr-rx-meta-item">
                                <Icon name="user" size={11} />
                                <span>{prescription.anonymousName}</span>
                            </span>
                            <span className="pr-rx-meta-item">
                                <Icon name="gauge" size={11} />
                                <span>置信度 {Math.round(prescription.confidence * 100)}%</span>
                            </span>
                            <span className="pr-rx-meta-item">
                                <Icon name="arrows-clockwise" size={11} />
                                <span>{new Date(prescription.generatedAt).toLocaleString('zh-CN')}</span>
                            </span>
                        </div>
                    )}
                </div>
                <div className="pr-rx-header-actions">
                    {onGenerate && (
                        <Button
                            variant="secondary"
                            size="sm"
                            loading={!!loading && !!prescription}
                            leftIcon={<Icon name="sparkle" size={13} />}
                            onClick={onGenerate}
                            disabled={!!loading}
                        >
                            AI 深度生成
                        </Button>
                    )}
                    {prescription && (
                        <button
                            type="button"
                            className="pr-rx-toggle"
                            onClick={handleToggle}
                            aria-expanded={expanded}
                            aria-label={expanded ? '收起详情' : '展开详情'}
                        >
                            <Icon name={expanded ? 'caret-up' : 'caret-down'} size={16} />
                        </button>
                    )}
                </div>
            </div>

            {/* ── 内容区 ── */}
            <div className="pr-rx-content">
                {isLoadingFirst && <PrescriptionSkeleton />}
                {hasError && (
                    <PrescriptionError message={error ?? '未知错误'} onRetry={onRetry} />
                )}
                {isEmpty && <PrescriptionEmpty />}

                {/* 流式态：显示打字机累积文本 */}
                {isStreaming && (
                    <div className="pr-rx-streaming">
                        <div className="pr-rx-streaming-cursor" aria-hidden>
                            <span className="pr-rx-streaming-dot" />
                        </div>
                        <pre className="pr-rx-streaming-text">{streamingText}</pre>
                    </div>
                )}

                {/* 完整处方数据态 */}
                {prescription && !isStreaming && (
                    <>
                        {/* 折叠态：仅显示画像摘要 */}
                        {!expanded && (
                            <div className="pr-rx-summary">
                                <Icon name="sparkle" size={13} />
                                <span>{summaryText}</span>
                            </div>
                        )}

                        {/* 展开态：七大模块完整展示 */}
                        {expanded && (
                            <div className="pr-rx-modules">
                                {/* 模块 1：学生画像 */}
                                <section className="pr-rx-module">
                                    <ModuleTitle icon="user-circle" title="学生画像" />
                                    <PortraitSection portrait={prescription.portrait} />
                                </section>

                                {/* 模块 2：优势分析 */}
                                {prescription.strengths.length > 0 && (
                                    <section className="pr-rx-module">
                                        <ModuleTitle
                                            icon="check-circle"
                                            title="优势分析"
                                            count={prescription.strengths.length}
                                        />
                                        <StrengthList items={prescription.strengths} />
                                    </section>
                                )}

                                {/* 模块 3：薄弱点诊断 */}
                                {prescription.weaknesses.length > 0 && (
                                    <section className="pr-rx-module">
                                        <ModuleTitle
                                            icon="warning-circle"
                                            title="薄弱点诊断"
                                            count={prescription.weaknesses.length}
                                        />
                                        <WeaknessList items={prescription.weaknesses} />
                                    </section>
                                )}

                                {/* 模块 4：教学策略建议 */}
                                {prescription.suggestions.length > 0 && (
                                    <section className="pr-rx-module">
                                        <ModuleTitle
                                            icon="lightbulb"
                                            title="教学策略建议"
                                            count={prescription.suggestions.length}
                                        />
                                        <SuggestionList items={prescription.suggestions} />
                                    </section>
                                )}

                                {/* 模块 5：资源推荐 */}
                                {prescription.recommendations.length > 0 && (
                                    <section className="pr-rx-module">
                                        <ModuleTitle
                                            icon="book-open"
                                            title="资源推荐"
                                            count={prescription.recommendations.length}
                                        />
                                        <RecommendationList items={prescription.recommendations} />
                                    </section>
                                )}

                                {/* 模块 6：学习活动 */}
                                {prescription.activities.length > 0 && (
                                    <section className="pr-rx-module">
                                        <ModuleTitle
                                            icon="target"
                                            title="学习活动"
                                            count={prescription.activities.length}
                                        />
                                        <ActivityList items={prescription.activities} />
                                    </section>
                                )}

                                {/* 模块 7：SMART 目标 */}
                                {prescription.smartGoals.length > 0 && (
                                    <section className="pr-rx-module">
                                        <ModuleTitle
                                            icon="flag"
                                            title="SMART 目标"
                                            count={prescription.smartGoals.length}
                                        />
                                        <SmartGoalList items={prescription.smartGoals} />
                                    </section>
                                )}

                                {/* 整体理据 */}
                                {prescription.overallRationale && (
                                    <section className="pr-rx-module pr-rx-module--rationale">
                                        <ModuleTitle icon="info" title="整体理据" />
                                        <p className="pr-rx-rationale">{prescription.overallRationale}</p>
                                    </section>
                                )}

                                {/* 派发按钮 */}
                                <div className="pr-rx-actions">
                                    <Button
                                        variant="primary"
                                        size="sm"
                                        onClick={handleDispatch}
                                        disabled={dispatching}
                                        aria-label="一键派发到处方工坊"
                                    >
                                        <Icon name="send" size={13} />
                                        {dispatching ? '派发中…' : '一键派发'}
                                    </Button>
                                    <span className="pr-rx-actions-hint">
                                        派发后将生成针对性练习
                                    </span>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </GlassCard>
    )
})
