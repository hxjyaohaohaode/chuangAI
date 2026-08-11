/**
 * 验收结果面板（SubTask 21.3 —— 5 维度雷达图增强版）
 *
 * 在原有会话级验收（verdict/score/strengths/issues）基础上，新增：
 * 1. 单题质量验收（GET /api/workbench/questions/:id/verification）
 * 2. 5 维度雷达图（Canvas 绘制）：难度/区分度/覆盖率/答案正确性/清晰度
 * 3. 5 维度进度条 + 总评分
 * 4. 题卡选择器（Combobox）
 *
 * 数据流：
 * - 会话级验收：store.verification（旧流程，保留兼容）
 * - 单题级验收：TanStack Query 拉取 /api/workbench/questions/:id/verification
 * - 题卡列表：store.questions 或 QuestionCardList 当前显示的题卡
 *
 * 设计要点（规范第 10、14 章）：
 * - 雷达图：surface-tertiary 背景 + accent-primary 填充（10% alpha）+ accent-primary 描边
 * - 进度条：accent 色系，按维度语义着色（success/warning/error）
 * - 评分用 Tabular Numbers 等宽对齐
 * - 加载态：骨架屏；错误态：重试；空态：引导
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge, Button, Combobox, Icon, AIBadge, type ComboboxOption } from '@/components/ui'
import { useWorkbenchStore } from '@/stores/workbench'
import { toast } from '@/stores/toast'
import { api } from '@/lib/api'
import { getDisplayError } from '@/lib/errors'
import { WORKBENCH_BLOOM_COLORS } from '@/lib/types'
import type {
    BloomLevel,
    WorkbenchVerification,
    WorkbenchVerifyIssue,
    WorkbenchQuestionVerification,
} from '@/lib/types'

/** verdict 评级配置 */
const VERDICT_CONFIG: Record<WorkbenchVerification['verdict'], {
    label: string
    badge: 'success' | 'warning' | 'error'
    color: string
    desc: string
}> = {
    pass: {
        label: '通过',
        badge: 'success',
        color: 'rgb(var(--c-accent-success))',
        desc: '题目质量达标，可发布使用',
    },
    revise: {
        label: '需修订',
        badge: 'warning',
        color: 'rgb(var(--c-accent-warning))',
        desc: '存在可改进项，建议应用修订建议',
    },
    reject: {
        label: '不通过',
        badge: 'error',
        color: 'rgb(var(--c-accent-error))',
        desc: '题目存在严重问题，需重新生成',
    },
}

/** 问题严重程度配置 */
const SEVERITY_CONFIG: Record<WorkbenchVerifyIssue['severity'], { label: string; color: string }> = {
    low: { label: '轻微', color: 'rgb(var(--c-accent-info))' },
    medium: { label: '中等', color: 'rgb(var(--c-accent-warning))' },
    high: { label: '严重', color: 'rgb(var(--c-accent-error))' },
}

/** 5 维度配置（雷达图 + 进度条共用） */
interface DimensionConfig {
    key: keyof Pick<WorkbenchQuestionVerification, 'difficulty' | 'discrimination' | 'coverage' | 'correctness' | 'clarity'>
    label: string
    /** 将原始值归一化到 0-100 */
    normalize: (v: WorkbenchQuestionVerification) => number
    /** 进度条颜色（按评分阈值） */
    color: (score: number) => string
    /** 格式化显示文本 */
    format: (v: WorkbenchQuestionVerification) => string
}

const DIMENSIONS: DimensionConfig[] = [
    {
        key: 'difficulty',
        label: '难度',
        normalize: (v) => Math.round(v.difficulty * 100),
        color: (s) => s >= 70 ? 'rgb(var(--c-accent-warning))' : s >= 40 ? 'rgb(var(--c-accent-info))' : 'rgb(var(--c-accent-success))',
        format: (v) => v.difficulty.toFixed(2),
    },
    {
        key: 'discrimination',
        label: '区分度',
        normalize: (v) => Math.round(v.discrimination * 100),
        color: (s) => s >= 60 ? 'rgb(var(--c-accent-success))' : s >= 30 ? 'rgb(var(--c-accent-warning))' : 'rgb(var(--c-accent-error))',
        format: (v) => v.discrimination.toFixed(2),
    },
    {
        key: 'coverage',
        label: '覆盖率',
        normalize: (v) => Math.round(v.coverage),
        color: (s) => s >= 80 ? 'rgb(var(--c-accent-success))' : s >= 60 ? 'rgb(var(--c-accent-warning))' : 'rgb(var(--c-accent-error))',
        format: (v) => `${v.coverage.toFixed(0)}%`,
    },
    {
        key: 'correctness',
        label: '答案正确性',
        normalize: (v) => v.correctness ? 100 : 0,
        color: (s) => s >= 100 ? 'rgb(var(--c-accent-success))' : 'rgb(var(--c-accent-error))',
        format: (v) => v.correctness ? '正确' : '错误',
    },
    {
        key: 'clarity',
        label: '清晰度',
        normalize: (v) => Math.round(v.clarity),
        color: (s) => s >= 80 ? 'rgb(var(--c-accent-success))' : s >= 60 ? 'rgb(var(--c-accent-warning))' : 'rgb(var(--c-accent-error))',
        format: (v) => `${v.clarity.toFixed(0)}%`,
    },
]

export const VerificationPanel = memo(function VerificationPanel() {
    const verification = useWorkbenchStore((s) => s.verification)
    const questions = useWorkbenchStore((s) => s.questions)
    const generating = useWorkbenchStore((s) => s.generating)

    // 单题质量验收：当前选中的题卡 ID
    const [selectedQuestionId, setSelectedQuestionId] = useState<string>('')

    // 自动选中第一道题卡
    useEffect(() => {
        if (!selectedQuestionId && questions.length > 0 && questions[0]) {
            setSelectedQuestionId(questions[0].id)
        }
        // 若选中题卡已被移除，回退到第一道
        if (selectedQuestionId && questions.length > 0 && !questions.some((q) => q.id === selectedQuestionId) && questions[0]) {
            setSelectedQuestionId(questions[0].id)
        }
    }, [questions, selectedQuestionId])

    // 单题质量验收查询
    const { data: questionVerification, isLoading: qvLoading, isError: qvError, error: qvErr, refetch: qvRefetch } = useQuery({
        queryKey: ['workbench', 'question-verification', selectedQuestionId],
        queryFn: () => api.workbench.fetchVerification(selectedQuestionId),
        enabled: !!selectedQuestionId,
        staleTime: 60_000,
    })

    const onApplySuggestions = useCallback(() => {
        toast.info({
            title: '应用修订建议',
            message: '请在题目卡片中点击"微调"逐题应用验收建议',
        })
    }, [])

    // 题卡选项（Combobox）
    const questionOptions: ComboboxOption[] = useMemo(() => {
        return questions.map((q, i) => ({
            value: q.id,
            label: `第 ${i + 1} 题 · ${q.bloomLevel} · ${q.type}`,
        }))
    }, [questions])

    const handleQuestionChange = useCallback((v: string | string[]) => {
        if (typeof v === 'string') setSelectedQuestionId(v)
    }, [])

    // 加载态
    if (generating && !verification && questions.length === 0) {
        return (
            <div className="pr-wb-verify pr-wb-verify--loading" aria-busy="true">
                <div className="pr-wb-verify-header">
                    <div className="pr-skeleton" style={{ width: 120, height: 16 }} />
                </div>
                <div className="pr-skeleton" style={{ width: '100%', height: 64, marginTop: 12 }} />
                <div className="pr-skeleton" style={{ width: '80%', height: 12, marginTop: 16 }} />
                <div className="pr-skeleton" style={{ width: '60%', height: 12, marginTop: 8 }} />
            </div>
        )
    }

    // 空态
    if (!verification && questions.length === 0) {
        return (
            <div className="pr-wb-verify pr-wb-verify--empty">
                <div className="pr-wb-verify-empty-icon">
                    <Icon name="check-circle" size={28} weight="bold" />
                </div>
                <div className="pr-wb-verify-empty-title">尚未验收</div>
                <div className="pr-wb-verify-empty-desc">
                    题目生成完成后，诗心 Agent 将自动进行六维验收
                </div>
            </div>
        )
    }

    const config = verification ? VERDICT_CONFIG[verification.verdict] : null
    const scoreColor = verification
        ? verification.score >= 80
            ? 'rgb(var(--c-accent-success))'
            : verification.score >= 60
                ? 'rgb(var(--c-accent-warning))'
                : 'rgb(var(--c-accent-error))'
        : 'rgb(var(--c-text-tertiary))'

    return (
        <div className="pr-wb-verify">
            <header className="pr-wb-verify-header">
                <div className="pr-wb-verify-title-row">
                    <Icon name="check-circle" size={18} />
                    <h3 className="pr-wb-verify-title">诗心·验收报告</h3>
                    {config && <Badge variant={config.badge}>{config.label}</Badge>}
                    <AIBadge size="xs" />
                </div>
                {verification && (
                    <span className="pr-wb-verify-confidence">
                        置信度 {(verification.confidence * 100).toFixed(0)}%
                    </span>
                )}
            </header>

            {/* 会话级总分 */}
            {verification && config && (
                <div className="pr-wb-verify-score-block">
                    <div className="pr-wb-verify-score">
                        <span className="pr-wb-verify-score-value" style={{ color: scoreColor }}>
                            {verification.score.toFixed(1)}
                        </span>
                        <span className="pr-wb-verify-score-unit">/ 100</span>
                    </div>
                    <div className="pr-wb-verify-score-bar">
                        <div
                            className="pr-wb-verify-score-fill"
                            style={{ width: `${verification.score}%`, backgroundColor: scoreColor }}
                        />
                    </div>
                    <p className="pr-wb-verify-score-desc">{config.desc}</p>
                </div>
            )}

            {/* 单题质量验收（5 维度） */}
            {questions.length > 0 && (
                <div className="pr-wb-verify-dimensions">
                    <div className="pr-wb-verify-section-label">
                        <Icon name="chart-bar" size={14} />
                        <span>单题质量验收</span>
                    </div>
                    <Combobox
                        className="pr-wb-verify-q-select"
                        value={selectedQuestionId}
                        onChange={handleQuestionChange}
                        ariaLabel="选择题卡查看质量验收"
                        placeholder="选择题卡"
                        options={questionOptions}
                    />
                    {selectedQuestionId && (
                        <QuestionVerificationView
                            verification={questionVerification}
                            loading={qvLoading}
                            error={qvError ? getDisplayError(qvErr, '质量验收加载失败') : null}
                            onRetry={() => void qvRefetch()}
                        />
                    )}
                </div>
            )}

            {/* 每题得分条（按题目的 bloomLevel 着色） */}
            {verification && questions.length > 0 && (
                <div className="pr-wb-verify-per-question">
                    <div className="pr-wb-verify-section-label">
                        <Icon name="list" size={14} />
                        <span>逐题覆盖</span>
                    </div>
                    <div className="pr-wb-verify-bars">
                        {questions.map((q, i) => {
                            const color = WORKBENCH_BLOOM_COLORS[q.bloomLevel as BloomLevel]
                            const perScore = Math.max(40, 100 - (q.difficulty - 1) * 12)
                            return (
                                <div key={q.id} className="pr-wb-verify-bar-item" title={`第 ${i + 1} 题 · ${q.bloomLevel}`}>
                                    <span className="pr-wb-verify-bar-label">Q{i + 1}</span>
                                    <div className="pr-wb-verify-bar-track">
                                        <div
                                            className="pr-wb-verify-bar-fill"
                                            style={{ transform: `scaleX(${perScore / 100})`, backgroundColor: color }}
                                        />
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </div>
            )}

            {/* 优点 */}
            {verification && verification.strengths.length > 0 && (
                <div className="pr-wb-verify-section">
                    <div className="pr-wb-verify-section-label pr-wb-verify-section-label--success">
                        <Icon name="check" size={14} weight="bold" />
                        <span>题目亮点（{verification.strengths.length}）</span>
                    </div>
                    <ul className="pr-wb-verify-strengths">
                        {verification.strengths.map((s, i) => (
                            <li key={i} className="pr-wb-verify-strength">
                                <Icon name="check" size={12} />
                                <span>{s}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* 问题 */}
            {verification && verification.issues.length > 0 && (
                <div className="pr-wb-verify-section">
                    <div className="pr-wb-verify-section-label pr-wb-verify-section-label--warning">
                        <Icon name="warning" size={14} weight="bold" />
                        <span>改进建议（{verification.issues.length}）</span>
                    </div>
                    <ul className="pr-wb-verify-issues">
                        {verification.issues.map((issue, i) => {
                            const sev = SEVERITY_CONFIG[issue.severity]
                            return (
                                <li
                                    key={i}
                                    className={`pr-wb-verify-issue pr-wb-verify-issue--${issue.severity}`}
                                    style={{ '--pr-issue-color': sev.color } as React.CSSProperties}
                                >
                                    <div className="pr-wb-verify-issue-head">
                                        <Badge variant={issue.severity === 'high' ? 'error' : issue.severity === 'medium' ? 'warning' : 'info'}>
                                            {sev.label}
                                        </Badge>
                                        <span className="pr-wb-verify-issue-desc">{issue.description}</span>
                                    </div>
                                    <div className="pr-wb-verify-issue-suggestion">
                                        <Icon name="lightbulb" size={12} />
                                        <span>{issue.suggestion}</span>
                                    </div>
                                </li>
                            )
                        })}
                    </ul>
                </div>
            )}

            {/* 一键应用建议 */}
            {verification && verification.verdict === 'revise' && (
                <div className="pr-wb-verify-actions">
                    <Button
                        variant="secondary"
                        size="sm"
                        leftIcon={<Icon name="arrows-clockwise" size={14} />}
                        onClick={onApplySuggestions}
                    >
                        一键应用所有建议
                    </Button>
                </div>
            )}
        </div>
    )
})

/* ============================================================
 * 子组件：单题质量验收视图（雷达图 + 进度条 + 总评分）
 * ============================================================ */

interface QuestionVerificationViewProps {
    verification: WorkbenchQuestionVerification | undefined
    loading: boolean
    error: string | null
    onRetry: () => void
}

function QuestionVerificationView({ verification, loading, error, onRetry }: QuestionVerificationViewProps) {
    // 加载态
    if (loading && !verification) {
        return (
            <div className="pr-wb-verify-qv pr-wb-verify-qv--loading" aria-busy="true">
                <div className="pr-skeleton pr-wb-verify-qv-radar-skeleton" />
                <div className="pr-wb-verify-qv-bars-skeleton">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className="pr-skeleton pr-wb-verify-qv-bar-skeleton" />
                    ))}
                </div>
            </div>
        )
    }

    // 错误态
    if (error && !verification) {
        return (
            <div className="pr-wb-verify-qv pr-wb-verify-qv--error" role="alert">
                <Icon name="warning-circle" size={20} weight="bold" />
                <span>{error}</span>
                <Button variant="ghost" size="sm" leftIcon={<Icon name="arrows-clockwise" size={12} />} onClick={onRetry}>
                    重试
                </Button>
            </div>
        )
    }

    if (!verification) return null

    const overallColor = verification.overallScore >= 80
        ? 'rgb(var(--c-accent-success))'
        : verification.overallScore >= 60
            ? 'rgb(var(--c-accent-warning))'
            : 'rgb(var(--c-accent-error))'

    return (
        <div className="pr-wb-verify-qv">
            {/* 雷达图 + 总评分 */}
            <div className="pr-wb-verify-qv-radar-wrap">
                <RadarChart verification={verification} size={200} />
                <div className="pr-wb-verify-qv-overall">
                    <span className="pr-wb-verify-qv-overall-value" style={{ color: overallColor }}>
                        {verification.overallScore.toFixed(0)}
                    </span>
                    <span className="pr-wb-verify-qv-overall-unit">/ 100</span>
                    <span className="pr-wb-verify-qv-overall-label">总评分</span>
                </div>
            </div>

            {/* 5 维度进度条 */}
            <ul className="pr-wb-verify-qv-bars">
                {DIMENSIONS.map((dim) => {
                    const score = dim.normalize(verification)
                    const color = dim.color(score)
                    return (
                        <li key={dim.key} className="pr-wb-verify-qv-bar">
                            <div className="pr-wb-verify-qv-bar-head">
                                <span className="pr-wb-verify-qv-bar-label">{dim.label}</span>
                                <span className="pr-wb-verify-qv-bar-value" style={{ color }}>
                                    {dim.format(verification)}
                                </span>
                            </div>
                            <div className="pr-wb-verify-qv-bar-track">
                                <div
                                    className="pr-wb-verify-qv-bar-fill"
                                    style={{ transform: `scaleX(${score / 100})`, backgroundColor: color }}
                                />
                            </div>
                        </li>
                    )
                })}
            </ul>
        </div>
    )
}

/* ============================================================
 * 子组件：5 维度雷达图（Canvas 绘制）
 * ============================================================ */

interface RadarChartProps {
    verification: WorkbenchQuestionVerification
    size?: number
}

function RadarChart({ verification, size = 200 }: RadarChartProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null)

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        // 高分屏适配
        const dpr = window.devicePixelRatio || 1
        canvas.width = size * dpr
        canvas.height = size * dpr
        canvas.style.width = `${size}px`
        canvas.style.height = `${size}px`
        ctx.scale(dpr, dpr)

        // 清空
        ctx.clearRect(0, 0, size, size)

        const cx = size / 2
        const cy = size / 2
        const maxRadius = size * 0.38
        const dimensions = DIMENSIONS
        const n = dimensions.length

        // 读取 CSS 变量（规范：零硬编码，色值来自 tokens）
        // 回退值与 tokens.css 中实际 token 值严格对齐（逗号分隔以兼容下方 rgba() 模板）
        // 同时将 space-separated 的 token 值规范化为逗号分隔，确保 rgba() 拼接合法
        const styles = getComputedStyle(document.documentElement)
        const normalizeRgb = (v: string, fallback: string): string => {
            const trimmed = v.trim()
            if (!trimmed) return fallback
            // tokens.css 中 token 形如 "152 98 39"，统一替换为 "152, 98, 39"
            return trimmed.replace(/\s+/g, ', ')
        }
        const accentPrimary = normalizeRgb(styles.getPropertyValue('--c-accent-primary'), '152, 98, 39')
        const surfaceTertiary = normalizeRgb(styles.getPropertyValue('--c-surface-tertiary'), '237, 232, 226')
        const textSecondary = normalizeRgb(styles.getPropertyValue('--c-text-secondary'), '107, 98, 88')
        const textTertiary = normalizeRgb(styles.getPropertyValue('--c-text-tertiary'), '110, 102, 92')

        // 1. 绘制同心圆参考线（25/50/75/100）
        ctx.strokeStyle = `rgba(${surfaceTertiary}, 0.6)`
        ctx.lineWidth = 1
        for (let level = 1; level <= 4; level++) {
            const r = (maxRadius * level) / 4
            ctx.beginPath()
            for (let i = 0; i < n; i++) {
                const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
                const x = cx + r * Math.cos(angle)
                const y = cy + r * Math.sin(angle)
                if (i === 0) ctx.moveTo(x, y)
                else ctx.lineTo(x, y)
            }
            ctx.closePath()
            ctx.stroke()
        }

        // 2. 绘制轴线
        ctx.strokeStyle = `rgba(${surfaceTertiary}, 0.5)`
        ctx.lineWidth = 1
        for (let i = 0; i < n; i++) {
            const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
            const x = cx + maxRadius * Math.cos(angle)
            const y = cy + maxRadius * Math.sin(angle)
            ctx.beginPath()
            ctx.moveTo(cx, cy)
            ctx.lineTo(x, y)
            ctx.stroke()
        }

        // 3. 绘制数据多边形（填充 + 描边）
        const points: Array<{ x: number; y: number }> = []
        for (let i = 0; i < n; i++) {
            const dim = dimensions[i]
            if (!dim) continue
            const score = dim.normalize(verification)
            const r = (maxRadius * Math.max(0, Math.min(100, score))) / 100
            const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
            points.push({
                x: cx + r * Math.cos(angle),
                y: cy + r * Math.sin(angle),
            })
        }

        // 填充（10% alpha）
        ctx.fillStyle = `rgba(${accentPrimary}, 0.15)`
        ctx.beginPath()
        points.forEach((p, i) => {
            if (i === 0) ctx.moveTo(p.x, p.y)
            else ctx.lineTo(p.x, p.y)
        })
        ctx.closePath()
        ctx.fill()

        // 描边（100% alpha）
        ctx.strokeStyle = `rgba(${accentPrimary}, 1)`
        ctx.lineWidth = 2
        ctx.beginPath()
        points.forEach((p, i) => {
            if (i === 0) ctx.moveTo(p.x, p.y)
            else ctx.lineTo(p.x, p.y)
        })
        ctx.closePath()
        ctx.stroke()

        // 4. 绘制顶点圆点
        ctx.fillStyle = `rgba(${accentPrimary}, 1)`
        points.forEach((p) => {
            ctx.beginPath()
            ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI)
            ctx.fill()
        })

        // 5. 绘制维度标签
        // 规范 14.2：字体引用 --font-sans token（v5.0 暖调衬线 + Inter Variable）
        const fontSans = styles.getPropertyValue('--font-sans').trim() || 'Inter, -apple-system, system-ui, sans-serif'
        ctx.font = `500 11px ${fontSans}`
        ctx.fillStyle = `rgba(${textSecondary}, 1)`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        for (let i = 0; i < n; i++) {
            const dim = dimensions[i]
            if (!dim) continue
            const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
            const labelR = maxRadius + 16
            const x = cx + labelR * Math.cos(angle)
            const y = cy + labelR * Math.sin(angle)
            ctx.fillText(dim.label, x, y)
        }

        // 6. 中心点
        ctx.fillStyle = `rgba(${textTertiary}, 0.6)`
        ctx.beginPath()
        ctx.arc(cx, cy, 2, 0, 2 * Math.PI)
        ctx.fill()
    }, [verification, size])

    return (
        <canvas
            ref={canvasRef}
            className="pr-wb-verify-radar"
            role="img"
            aria-label={`5 维度质量雷达图：总评分 ${verification.overallScore.toFixed(0)} 分`}
        />
    )
}
