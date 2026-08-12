/**
 * 学生认知画像面板（Task 17 + 画像报告能力 1 深化）
 *
 * 左右双栏布局：
 * - 左栏：学生列表（脱敏名，可搜索筛选，选中高亮）
 * - 右栏：选中学生的认知画像
 *   1. 五维度立体画像（能力 1 深化：知识/能力/行为/兴趣/成长 + AI 描述 + 标签云 + 成长曲线）
 *   2. 六阶能力雷达图（Canvas 2D，复用 BloomRadarChart 绘制逻辑）
 *   3. 知识漏洞列表（漏洞诗 + 阶层 + 关联弱点 + 建议路径）
 *   4. 推荐学习路径节点（诗 + 朝代 + 难度 + 掌握度 + 推荐理由）
 *
 * 设计要点（规范第 2、4、5、6、7、8、14 章）：
 * - 零硬编码色值：所有颜色从 CSS 变量读取
 * - 无边框优先：左右栏用透明度差异分隔
 * - Canvas 高 DPI：devicePixelRatio 缩放
 * - 600ms 入场动画：雷达图从中心展开
 * - ResizeObserver debounce 100ms
 * - 学生列表支持单一 roving 焦点下的方向键 / Home / End 选择
 * - 仅 transform/opacity 动画
 * - 能力 1：立体画像通过 api.profile3d 异步加载，支持强制刷新
 */

import { useEffect, useRef, memo, useState, useMemo, useCallback } from 'react'
import { Card, Icon, Button } from '@/components/ui'
import { api } from '@/lib/api'
import { businessEvents } from '@/lib/business-events'
import { BLOOM_ORDER } from '@/lib/types'
import type {
    HeatmapStudent,
    StudentProfileResponse,
    StudentGap,
    BloomLevel,
    StudentProfile3D,
} from '@/lib/types'
import { readCSSColor, rgba, easeOut } from '@/lib/chartPalette'
import { observeElementResize } from '@/lib/resize-observer'
import { matchesMediaQuery } from '@/lib/media-query'

interface StudentProfilePanelProps {
    /** 学生列表（来自热力图数据） */
    students: HeatmapStudent[]
    /** 选中学生的认知画像 */
    profile: StudentProfileResponse
    /** 选中学生 ID */
    selectedStudentId: string | null
    /** 知识漏洞列表 */
    gaps: StudentGap[]
    /** 是否加载中 */
    loading?: boolean
    /** 选择学生回调 */
    onSelectStudent: (studentId: string) => void
}

/** 动画时长（ms） */
const ANIMATION_MS = 600

/** 六阶轴角度（弧度），从正上方开始顺时针 */
const AXIS_ANGLES: number[] = BLOOM_ORDER.map((_, i) => {
    return -Math.PI / 2 + (i * Math.PI * 2) / BLOOM_ORDER.length
})

/** 根据分数选择颜色 token */
function colorVarForScore(score: number): string {
    if (score < 60) return '--c-accent-error'
    if (score < 80) return '--c-accent-warning'
    return '--c-accent-success'
}

// ─────────────────────────────────────────────────────────────
// 学生六阶雷达图（Canvas）
// ─────────────────────────────────────────────────────────────

interface StudentRadarProps {
    radar: Record<BloomLevel, number>
    anonymousName: string
}

const StudentRadar = memo(function StudentRadar({ radar, anonymousName }: StudentRadarProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const containerRef = useRef<HTMLDivElement | null>(null)
    const animationRef = useRef<number | null>(null)
    const radarRef = useRef<Record<BloomLevel, number>>(radar)

    useEffect(() => {
        radarRef.current = radar
        startAnimation()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [radar])

    function startAnimation() {
        if (animationRef.current !== null) {
            cancelAnimationFrame(animationRef.current)
        }
        const start = performance.now()
        const prefersReducedMotion = matchesMediaQuery('(prefers-reduced-motion: reduce)')

        if (prefersReducedMotion) {
            draw(1)
            return
        }

        const tick = (now: number) => {
            const elapsed = now - start
            const progress = Math.min(1, elapsed / ANIMATION_MS)
            const eased = easeOut(progress)
            draw(eased)
            if (progress < 1) {
                animationRef.current = requestAnimationFrame(tick)
            } else {
                animationRef.current = null
            }
        }
        animationRef.current = requestAnimationFrame(tick)
    }

    function draw(progress: number) {
        const canvas = canvasRef.current
        const container = containerRef.current
        if (!canvas || !container) return

        const dpr = window.devicePixelRatio || 1
        const rect = container.getBoundingClientRect()
        const displayWidth = rect.width
        const displayHeight = rect.height
        if (displayWidth === 0 || displayHeight === 0) return

        if (canvas.width !== Math.round(displayWidth * dpr) || canvas.height !== Math.round(displayHeight * dpr)) {
            canvas.width = Math.round(displayWidth * dpr)
            canvas.height = Math.round(displayHeight * dpr)
        }
        canvas.style.width = `${displayWidth}px`
        canvas.style.height = `${displayHeight}px`

        const ctx = canvas.getContext('2d')
        if (!ctx) return

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, displayWidth, displayHeight)

        const cx = displayWidth / 2
        const cy = displayHeight / 2
        const padding = Math.max(36, displayWidth * 0.16)
        const maxRadius = Math.max(10, Math.min(cx, cy) - padding)
        const gridLevels = [0.2, 0.4, 0.6, 0.8, 1.0]

        const cBorder = readCSSColor('--c-text-tertiary')
        const cTextSecondary = readCSSColor('--c-text-secondary')
        const cTextPrimary = readCSSColor('--c-text-primary')

        // 1. 网格六边形
        ctx.lineWidth = 1
        for (const level of gridLevels) {
            const r = maxRadius * level
            ctx.beginPath()
            for (let i = 0; i < BLOOM_ORDER.length; i++) {
                const angle = AXIS_ANGLES[i]!
                const x = cx + r * Math.cos(angle)
                const y = cy + r * Math.sin(angle)
                if (i === 0) ctx.moveTo(x, y)
                else ctx.lineTo(x, y)
            }
            ctx.closePath()
            ctx.strokeStyle = rgba(cBorder, 0.15)
            ctx.stroke()
        }

        // 2. 轴线
        ctx.strokeStyle = rgba(cBorder, 0.15)
        for (let i = 0; i < BLOOM_ORDER.length; i++) {
            const angle = AXIS_ANGLES[i]!
            ctx.beginPath()
            ctx.moveTo(cx, cy)
            ctx.lineTo(cx + maxRadius * Math.cos(angle), cy + maxRadius * Math.sin(angle))
            ctx.stroke()
        }

        // 3. 轴标签
        ctx.font = `500 ${Math.max(11, displayWidth * 0.032)}px var(--font-sans, sans-serif)`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = rgba(cTextSecondary, 1)
        const labelOffset = maxRadius + 16
        for (let i = 0; i < BLOOM_ORDER.length; i++) {
            const angle = AXIS_ANGLES[i]
            const level = BLOOM_ORDER[i]
            if (typeof angle !== 'number' || !level) continue
            const x = cx + labelOffset * Math.cos(angle)
            const y = cy + labelOffset * Math.sin(angle)
            ctx.fillText(level, x, y)
        }

        // 4. 数据多边形
        const data = radarRef.current
        const points: Array<{ x: number; y: number; value: number }> = []
        for (let i = 0; i < BLOOM_ORDER.length; i++) {
            const level = BLOOM_ORDER[i] as BloomLevel
            const rawValue = data[level] ?? 0
            const normalized = Math.min(100, Math.max(0, rawValue)) / 100
            const r = maxRadius * normalized * progress
            const angle = AXIS_ANGLES[i]!
            points.push({
                x: cx + r * Math.cos(angle),
                y: cy + r * Math.sin(angle),
                value: rawValue,
            })
        }

        if (points.length > 0) {
            // 填充
            ctx.beginPath()
            points.forEach((p, i) => {
                if (i === 0) ctx.moveTo(p.x, p.y)
                else ctx.lineTo(p.x, p.y)
            })
            ctx.closePath()
            ctx.fillStyle = rgba(readCSSColor('--c-accent-primary'), 0.2)
            ctx.fill()

            // 描边
            ctx.lineWidth = 2
            ctx.strokeStyle = rgba(readCSSColor('--c-accent-primary'), 1)
            ctx.stroke()

            // 数据点 + 数值标签
            for (let i = 0; i < points.length; i++) {
                const p = points[i]!
                ctx.beginPath()
                ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
                ctx.fillStyle = rgba(readCSSColor('--c-accent-primary'), 1)
                ctx.fill()

                if (progress >= 0.9) {
                    ctx.font = `600 ${Math.max(10, displayWidth * 0.026)}px var(--font-sans, sans-serif)`
                    ctx.fillStyle = rgba(cTextPrimary, 1)
                    const angle = AXIS_ANGLES[i]!
                    const offset = 12
                    ctx.fillText(Math.round(p.value).toString(), p.x + offset * Math.cos(angle), p.y + offset * Math.sin(angle))
                }
            }
        }
    }

    useEffect(() => {
        const container = containerRef.current
        if (!container) return
        let resizeTimer: number | null = null
        const stopObserving = observeElementResize(container, () => {
            if (resizeTimer !== null) window.clearTimeout(resizeTimer)
            resizeTimer = window.setTimeout(() => {
                draw(1)
                resizeTimer = null
            }, 100)
        })
        return () => {
            stopObserving()
            if (resizeTimer !== null) window.clearTimeout(resizeTimer)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        return () => {
            if (animationRef.current !== null) {
                cancelAnimationFrame(animationRef.current)
                animationRef.current = null
            }
        }
    }, [])

    return (
        <div className="pr-student-radar">
            <div className="pr-student-radar-title">
                <Icon name="chart-bar" size={14} />
                六阶能力雷达 · {anonymousName}
            </div>
            <div className="pr-student-radar-canvas-wrapper" ref={containerRef}>
                <canvas ref={canvasRef} aria-label={`${anonymousName}六阶能力雷达图`} />
            </div>
        </div>
    )
})

// ─────────────────────────────────────────────────────────────
// 五维度立体画像 Section（能力 1 深化）
// ─────────────────────────────────────────────────────────────

interface Profile3DSectionProps {
    studentId: string
    classId?: string
    anonymousName: string
}

/** 成长等级标签映射 */
const GROWTH_LEVEL_LABELS: Record<string, string> = {
    rising: '上升中',
    stable: '稳定',
    declining: '下降',
}

/** 活跃等级标签映射 */
const ACTIVITY_LEVEL_LABELS: Record<string, string> = {
    active: '活跃',
    normal: '正常',
    quiet: '沉默',
}

/** 成长趋势迷你折线图（Canvas 2D） */
const GrowthTrendMini = memo(function GrowthTrendMini({ data }: { data: Array<{ date: number; mastery: number }> }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const containerRef = useRef<HTMLDivElement | null>(null)
    const [resizeTick, setResizeTick] = useState(0)

    useEffect(() => {
        const canvas = canvasRef.current
        const container = containerRef.current
        if (!canvas || !container || data.length < 2) return

        const dpr = window.devicePixelRatio || 1
        const rect = container.getBoundingClientRect()
        const w = rect.width
        const h = rect.height
        if (w === 0 || h === 0) return

        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`

        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, w, h)

        const values = data.map((d) => d.mastery)
        const minV = Math.min(...values, 0)
        const maxV = Math.max(...values, 100)
        const range = Math.max(1, maxV - minV)
        const padding = 6
        const drawW = w - padding * 2
        const drawH = h - padding * 2

        // 背景渐变填充
        const cAccent = readCSSColor('--c-accent-primary')
        ctx.beginPath()
        data.forEach((d, i) => {
            const x = padding + (i / (data.length - 1)) * drawW
            const y = padding + drawH - ((d.mastery - minV) / range) * drawH
            if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
        })
        ctx.lineTo(padding + drawW, padding + drawH)
        ctx.lineTo(padding, padding + drawH)
        ctx.closePath()
        ctx.fillStyle = rgba(cAccent, 0.1)
        ctx.fill()

        // 折线
        ctx.beginPath()
        data.forEach((d, i) => {
            const x = padding + (i / (data.length - 1)) * drawW
            const y = padding + drawH - ((d.mastery - minV) / range) * drawH
            if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
        })
        ctx.strokeStyle = rgba(cAccent, 0.8)
        ctx.lineWidth = 1.5
        ctx.stroke()

        // 末端点
        const lastD = data.at(-1)
        if (!lastD) return
        const lx = padding + drawW
        const ly = padding + drawH - ((lastD.mastery - minV) / range) * drawH
        ctx.beginPath()
        ctx.arc(lx, ly, 3, 0, Math.PI * 2)
        ctx.fillStyle = rgba(cAccent, 1)
        ctx.fill()
    }, [data, resizeTick])

    useEffect(() => {
        const container = containerRef.current
        if (!container) return
        let timer: number | null = null
        const stopObserving = observeElementResize(container, () => {
            if (timer !== null) window.clearTimeout(timer)
            timer = window.setTimeout(() => setResizeTick((tick) => tick + 1), 100)
        })
        return () => {
            stopObserving()
            if (timer !== null) window.clearTimeout(timer)
        }
    }, [data])

    if (data.length < 2) return null

    return (
        <div className="pr-profile-3d-growth-chart" ref={containerRef}>
            <canvas ref={canvasRef} aria-label="成长趋势图" />
        </div>
    )
})

/** 五维度立体画像 Section */
const Profile3DSection = memo(function Profile3DSection({
    studentId,
    classId,
}: Profile3DSectionProps) {
    const [profile3d, setProfile3d] = useState<StudentProfile3D | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [refreshing, setRefreshing] = useState(false)

    const fetchProfile = useCallback(async (forceRefresh = false) => {
        try {
            if (forceRefresh) {
                setRefreshing(true)
            } else {
                setLoading(true)
            }
            setError(null)
            const method = forceRefresh ? api.profile3d.refresh : api.profile3d.get
            const res = await method(studentId)
            setProfile3d(res.profile)
            if (forceRefresh && classId) {
                businessEvents.emit('profile:refreshed', {
                    studentId,
                    classId,
                    aiGenerated: res.profile.aiGenerated,
                    refreshedAt: Date.now(),
                })
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : '加载立体画像失败')
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }, [studentId, classId])

    useEffect(() => {
        void fetchProfile()
    }, [fetchProfile])

    const handleRefresh = useCallback(() => {
        void fetchProfile(true)
    }, [fetchProfile])

    if (loading) {
        return (
            <Card className="pr-profile-3d-section pr-profile-3d-section--loading" padding="md">
                <div className="pr-profile-3d-header">
                    <Icon name="brain" size={16} />
                    <h4 className="pr-profile-3d-title">五维度立体画像</h4>
                </div>
                <div className="pr-profile-3d-skeleton">
                    {[0, 1, 2].map((i) => (
                        <div key={i} className="pr-skeleton" style={{ height: 64, borderRadius: 8 }} />
                    ))}
                </div>
            </Card>
        )
    }

    if (error || !profile3d) {
        return (
            <Card className="pr-profile-3d-section pr-profile-3d-section--error" padding="md">
                <div className="pr-profile-3d-header">
                    <Icon name="brain" size={16} />
                    <h4 className="pr-profile-3d-title">五维度立体画像</h4>
                </div>
                <div className="pr-profile-3d-empty">
                    <Icon name="warning-circle" size={20} />
                    <p className="pr-profile-3d-empty-text">{error ?? '暂无立体画像数据'}</p>
                    <Button variant="ghost" size="sm" onClick={() => void fetchProfile()}>
                        重试
                    </Button>
                </div>
            </Card>
        )
    }

    const { dimensions, description, aiGenerated } = profile3d
    const tags = Array.isArray(profile3d.tags) ? profile3d.tags : []
    const masteryTrend = Array.isArray(dimensions.growth.masteryTrend)
        ? dimensions.growth.masteryTrend
        : []
    const growthTrend = dimensions.growth.trend ?? 'stable'
    const growthDelta = Number.isFinite(dimensions.growth.delta) ? dimensions.growth.delta : 0
    const growthMomentum = Number.isFinite(dimensions.growth.momentum) ? dimensions.growth.momentum : 0
    const classPercentile = Number.isFinite(dimensions.growth.classPercentile)
        ? dimensions.growth.classPercentile
        : 50
    const textSecondary = readCSSColor('--c-text-secondary')
    const textTertiary = readCSSColor('--c-text-tertiary')
    const accentVar = readCSSColor('--c-accent-primary')

    return (
        <Card className="pr-profile-3d-section" padding="md">
            <div className="pr-profile-3d-header">
                <div className="pr-profile-3d-title-row">
                    <Icon name="brain" size={16} />
                    <h4 className="pr-profile-3d-title">五维度立体画像</h4>
                    {aiGenerated && (
                        <span className="pr-profile-3d-ai-badge">AI 生成</span>
                    )}
                </div>
                <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={<Icon name="arrows-clockwise" size={12} />}
                    loading={refreshing}
                    onClick={handleRefresh}
                >
                    刷新
                </Button>
            </div>

            {/* AI 描述 */}
            {description && (
                <div className="pr-profile-3d-description">
                    <Icon name="quotes" size={12} />
                    <p>{description}</p>
                </div>
            )}

            {/* 标签云 */}
            {tags.length > 0 && (
                <div className="pr-profile-3d-tags">
                    {tags.map((tag, i) => (
                        <span
                            key={i}
                            className="pr-profile-3d-tag"
                            style={{
                                color: rgba(accentVar, 1),
                                backgroundColor: rgba(accentVar, 0.08),
                            }}
                        >
                            {tag}
                        </span>
                    ))}
                </div>
            )}

            {/* 5 维度卡片网格 */}
            <div className="pr-profile-3d-dimensions">
                {/* 知识维度 */}
                <div className="pr-profile-3d-dim-card">
                    <div className="pr-profile-3d-dim-header">
                        <Icon name="book-open" size={12} />
                        <span className="pr-profile-3d-dim-title">知识</span>
                    </div>
                    <div className="pr-profile-3d-dim-stats">
                        <div className="pr-profile-3d-dim-stat">
                            <span className="pr-profile-3d-dim-value">{dimensions.knowledge.learnedPoemCount}</span>
                            <span className="pr-profile-3d-dim-label" style={{ color: rgba(textTertiary, 1) }}>已学</span>
                        </div>
                        <div className="pr-profile-3d-dim-stat">
                            <span className="pr-profile-3d-dim-value">{Math.round(dimensions.knowledge.avgMastery)}</span>
                            <span className="pr-profile-3d-dim-label" style={{ color: rgba(textTertiary, 1) }}>均值</span>
                        </div>
                        <div className="pr-profile-3d-dim-stat">
                            <span className="pr-profile-3d-dim-value">{dimensions.knowledge.masteredCount}</span>
                            <span className="pr-profile-3d-dim-label" style={{ color: rgba(textTertiary, 1) }}>已掌握</span>
                        </div>
                        <div className="pr-profile-3d-dim-stat">
                            <span className="pr-profile-3d-dim-value">{dimensions.knowledge.weakCount}</span>
                            <span className="pr-profile-3d-dim-label" style={{ color: rgba(textTertiary, 1) }}>薄弱</span>
                        </div>
                    </div>
                    {/* 覆盖率进度条 */}
                    <div className="pr-profile-3d-coverage-bar">
                        <div
                            className="pr-profile-3d-coverage-fill"
                            style={{ width: `${Math.min(100, dimensions.knowledge.coverage)}%` }}
                        />
                        <span className="pr-profile-3d-coverage-label" style={{ color: rgba(textSecondary, 1) }}>
                            覆盖率 {Math.round(dimensions.knowledge.coverage)}%
                        </span>
                    </div>
                </div>

                {/* 能力维度 */}
                <div className="pr-profile-3d-dim-card">
                    <div className="pr-profile-3d-dim-header">
                        <Icon name="chart-bar" size={12} />
                        <span className="pr-profile-3d-dim-title">能力</span>
                    </div>
                    <div className="pr-profile-3d-dim-ability">
                        <div className="pr-profile-3d-ability-row">
                            <span className="pr-profile-3d-ability-label" style={{ color: rgba(textSecondary, 1) }}>最强</span>
                            <span
                                className="pr-profile-3d-ability-value pr-profile-3d-ability-value--strong"
                                style={{
                                    color: rgba(readCSSColor('--c-accent-success'), 1),
                                    backgroundColor: rgba(readCSSColor('--c-accent-success'), 0.1),
                                }}
                            >
                                {dimensions.ability.strongest}
                            </span>
                        </div>
                        <div className="pr-profile-3d-ability-row">
                            <span className="pr-profile-3d-ability-label" style={{ color: rgba(textSecondary, 1) }}>薄弱</span>
                            <span
                                className="pr-profile-3d-ability-value pr-profile-3d-ability-value--weak"
                                style={{
                                    color: rgba(readCSSColor('--c-accent-error'), 1),
                                    backgroundColor: rgba(readCSSColor('--c-accent-error'), 0.1),
                                }}
                            >
                                {dimensions.ability.weakest}
                            </span>
                        </div>
                        <div className="pr-profile-3d-ability-balance">
                            <span style={{ color: rgba(textTertiary, 1) }}>均衡度</span>
                            <div className="pr-profile-3d-balance-track">
                                <div
                                    className="pr-profile-3d-balance-fill"
                                    style={{ width: `${dimensions.ability.balance}%` }}
                                />
                            </div>
                            <span style={{ color: rgba(textSecondary, 1) }}>{Math.round(dimensions.ability.balance)}%</span>
                        </div>
                    </div>
                </div>

                {/* 行为维度 */}
                <div className="pr-profile-3d-dim-card">
                    <div className="pr-profile-3d-dim-header">
                        <Icon name="gauge" size={12} />
                        <span className="pr-profile-3d-dim-title">行为</span>
                        <span
                            className={`pr-profile-3d-activity-badge pr-profile-3d-activity-badge--${dimensions.behavior.activityLevel}`}
                        >
                            {ACTIVITY_LEVEL_LABELS[dimensions.behavior.activityLevel] ?? dimensions.behavior.activityLevel}
                        </span>
                    </div>
                    <div className="pr-profile-3d-dim-stats">
                        <div className="pr-profile-3d-dim-stat">
                            <span className="pr-profile-3d-dim-value">{Math.round(dimensions.behavior.engagement)}</span>
                            <span className="pr-profile-3d-dim-label" style={{ color: rgba(textTertiary, 1) }}>参与度</span>
                        </div>
                        <div className="pr-profile-3d-dim-stat">
                            <span className="pr-profile-3d-dim-value">{dimensions.behavior.totalAttempts}</span>
                            <span className="pr-profile-3d-dim-label" style={{ color: rgba(textTertiary, 1) }}>答题数</span>
                        </div>
                        <div className="pr-profile-3d-dim-stat">
                            <span className="pr-profile-3d-dim-value">{Math.round(dimensions.behavior.correctRate)}%</span>
                            <span className="pr-profile-3d-dim-label" style={{ color: rgba(textTertiary, 1) }}>正确率</span>
                        </div>
                        <div className="pr-profile-3d-dim-stat">
                            <span className="pr-profile-3d-dim-value">{dimensions.behavior.recitationCount}</span>
                            <span className="pr-profile-3d-dim-label" style={{ color: rgba(textTertiary, 1) }}>朗读</span>
                        </div>
                    </div>
                </div>

                {/* 兴趣维度 */}
                <div className="pr-profile-3d-dim-card">
                    <div className="pr-profile-3d-dim-header">
                        <Icon name="heart" size={12} />
                        <span className="pr-profile-3d-dim-title">兴趣</span>
                    </div>
                    <div className="pr-profile-3d-interest-content">
                        {dimensions.interest.topDynasties.length > 0 && (
                            <div className="pr-profile-3d-interest-group">
                                <span className="pr-profile-3d-interest-label" style={{ color: rgba(textTertiary, 1) }}>偏好朝代</span>
                                <div className="pr-profile-3d-interest-tags">
                                    {dimensions.interest.topDynasties.slice(0, 3).map((d, i) => (
                                        <span key={i} className="pr-profile-3d-interest-tag">
                                            {d.dynasty} · {d.count}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                        {dimensions.interest.topThemes.length > 0 && (
                            <div className="pr-profile-3d-interest-group">
                                <span className="pr-profile-3d-interest-label" style={{ color: rgba(textTertiary, 1) }}>偏好主题</span>
                                <div className="pr-profile-3d-interest-tags">
                                    {dimensions.interest.topThemes.slice(0, 3).map((t, i) => (
                                        <span key={i} className="pr-profile-3d-interest-tag">
                                            {t.theme} · {t.count}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                        {dimensions.interest.topRhetoric.length > 0 && (
                            <div className="pr-profile-3d-interest-group">
                                <span className="pr-profile-3d-interest-label" style={{ color: rgba(textTertiary, 1) }}>偏好修辞</span>
                                <div className="pr-profile-3d-interest-tags">
                                    {dimensions.interest.topRhetoric.slice(0, 3).map((r, i) => (
                                        <span key={i} className="pr-profile-3d-interest-tag">
                                            {r.rhetoric} · {r.count}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* 成长维度 */}
                <div className="pr-profile-3d-dim-card pr-profile-3d-dim-card--growth">
                    <div className="pr-profile-3d-dim-header">
                        <Icon name="chart-line-up" size={12} />
                        <span className="pr-profile-3d-dim-title">成长</span>
                        <span
                            className={`pr-profile-3d-growth-badge pr-profile-3d-growth-badge--${growthTrend}`}
                        >
                            {GROWTH_LEVEL_LABELS[growthTrend] ?? growthTrend}
                        </span>
                    </div>
                    {masteryTrend.length >= 2 && (
                        <GrowthTrendMini data={masteryTrend} />
                    )}
                    <div className="pr-profile-3d-growth-stats">
                        <div className="pr-profile-3d-dim-stat">
                            <span className="pr-profile-3d-dim-value">
                                {growthDelta >= 0 ? '+' : ''}{growthDelta.toFixed(1)}
                            </span>
                            <span className="pr-profile-3d-dim-label" style={{ color: rgba(textTertiary, 1) }}>30 天变化</span>
                        </div>
                        <div className="pr-profile-3d-dim-stat">
                            <span className="pr-profile-3d-dim-value">{growthMomentum.toFixed(1)}</span>
                            <span className="pr-profile-3d-dim-label" style={{ color: rgba(textTertiary, 1) }}>短期动量</span>
                        </div>
                        <div className="pr-profile-3d-dim-stat">
                            <span className="pr-profile-3d-dim-value">{Math.round(classPercentile)}%</span>
                            <span className="pr-profile-3d-dim-label" style={{ color: rgba(textTertiary, 1) }}>班级百分位</span>
                        </div>
                    </div>
                </div>
            </div>
        </Card>
    )
})

// ─────────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────────

export const StudentProfilePanel = memo(function StudentProfilePanel({
    students,
    profile,
    selectedStudentId,
    gaps,
    loading = false,
    onSelectStudent,
}: StudentProfilePanelProps) {
    const [searchQuery, setSearchQuery] = useState('')
    const listRef = useRef<HTMLDivElement | null>(null)
    // 仅键盘导航才申请回收焦点。鼠标点击和页面首次自动选中不应抢走教师当前焦点。
    const pendingKeyboardFocusIdRef = useRef<string | null>(null)

    // 搜索筛选
    const filteredStudents = useMemo(() => {
        if (!searchQuery.trim()) return students
        const q = searchQuery.toLowerCase().trim()
        return students.filter(
            (s) => (s.displayName ?? s.anonymousName).toLowerCase().includes(q)
                || s.anonymousName.toLowerCase().includes(q)
                || s.id.toLowerCase().includes(q),
        )
    }, [students, searchQuery])

    /**
     * Zustand 更新可以在当前按键事件内触发，而 React 按钮的 aria-pressed / tabIndex
     * 要到提交渲染后才一致。把“需要聚焦谁”与实际 focus 分开，避免 rAF 在旧 DOM
     * 上运行后被重渲染覆盖，造成“已选中但焦点留在旧项”的键盘断裂。
     */
    const requestKeyboardFocus = useCallback((studentId: string) => {
        pendingKeyboardFocusIdRef.current = studentId
    }, [])

    useEffect(() => {
        const targetStudentId = pendingKeyboardFocusIdRef.current
        if (!targetStudentId) return
        // 若键盘操作后又发生鼠标/外部选择，不再把焦点夺回到过期目标。
        if (targetStudentId !== selectedStudentId) {
            pendingKeyboardFocusIdRef.current = null
            return
        }
        const next = Array.from(
            listRef.current?.querySelectorAll<HTMLButtonElement>('[data-student-list-item]') ?? [],
        ).find((element) => element.dataset.studentListItem === targetStudentId)
        if (!next) {
            // 搜索条件变更导致目标不可见时清除请求，避免它在未来意外接管焦点。
            pendingKeyboardFocusIdRef.current = null
            return
        }
        pendingKeyboardFocusIdRef.current = null
        requestAnimationFrame(() => next.focus())
    }, [selectedStudentId, filteredStudents])

    // 键盘导航：↑↓/Home/End 选择学生，并让选中状态与真实 DOM 焦点同步。
    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (filteredStudents.length === 0) return
            const currentIdx = filteredStudents.findIndex((s) => s.id === selectedStudentId)
            let nextIdx: number
            switch (e.key) {
                case 'ArrowDown':
                    nextIdx = Math.min(filteredStudents.length - 1, currentIdx + 1)
                    break
                case 'ArrowUp':
                    nextIdx = Math.max(0, currentIdx === -1 ? 0 : currentIdx - 1)
                    break
                case 'Home':
                    nextIdx = 0
                    break
                case 'End':
                    nextIdx = filteredStudents.length - 1
                    break
                default:
                    return
            }
            e.preventDefault()
            const next = filteredStudents[nextIdx]
            if (!next) return
            requestKeyboardFocus(next.id)
            onSelectStudent(next.id)
        },
        [filteredStudents, selectedStudentId, onSelectStudent, requestKeyboardFocus],
    )

    const textSecondary = readCSSColor('--c-text-secondary')
    const textTertiary = readCSSColor('--c-text-tertiary')
    const accentVar = readCSSColor('--c-accent-primary')

    const hasProfile = profile.studentId !== '' && selectedStudentId !== null
    const selectedStudentVisible = filteredStudents.some((student) => student.id === selectedStudentId)

    return (
        <div className="pr-student-profile-panel">
            {/* ── 左栏：学生列表 ── */}
            <Card className="pr-student-list-card" padding="none">
                <div className="pr-student-list-header">
                    <div className="pr-student-list-search">
                        <Icon name="magnifying-glass" size={14} />
                        <input
                            type="text"
                            className="pr-student-list-search-input"
                            placeholder="搜索学生…"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            aria-label="搜索学生"
                        />
                    </div>
                    <div
                        className="pr-student-list-count"
                        style={{ color: rgba(textTertiary, 1) }}
                    >
                        {filteredStudents.length} 人
                    </div>
                </div>
                <div
                    className="pr-student-list"
                    ref={listRef}
                    role="group"
                    aria-label="学生列表"
                    onKeyDown={handleKeyDown}
                >
                    {loading && students.length === 0 ? (
                        [0, 1, 2, 3].map((i) => (
                            <div
                                key={i}
                                className="pr-skeleton pr-student-list-skeleton"
                                style={{ height: 40 }}
                            />
                        ))
                    ) : filteredStudents.length === 0 ? (
                        <div className="pr-student-list-empty">
                            <Icon name="student" size={24} />
                            <p className="pr-student-list-empty-title">未找到匹配学生</p>
                            <p className="pr-student-list-empty-desc">
                                {searchQuery.trim()
                                    ? `没有姓名包含「${searchQuery.trim()}」的学生，可清空搜索查看全部学生。`
                                    : '当前班级暂无学生数据，请确认班级已导入学生名单。'}
                            </p>
                            {searchQuery.trim() && (
                                <button
                                    type="button"
                                    className="pr-student-list-empty-cta"
                                    onClick={() => setSearchQuery('')}
                                >
                                    清空搜索
                                </button>
                            )}
                        </div>
                    ) : (
                        filteredStudents.map((student, index) => {
                            const isSelected = student.id === selectedStudentId
                            const studentDisplayName = student.displayName ?? student.anonymousName
                            // 只有当前选择项可由 Tab 进入；搜索过滤掉当前项时，第一个结果接管入口。
                            const isRovingTabStop = isSelected || (!selectedStudentVisible && index === 0)
                            return (
                                <div key={student.id} role="presentation">
                                    <button
                                        type="button"
                                        data-student-list-item={student.id}
                                        aria-pressed={isSelected}
                                        aria-label={`选择学生：${studentDisplayName}`}
                                        tabIndex={isRovingTabStop ? 0 : -1}
                                        className={`pr-student-list-item ${isSelected ? 'is-selected' : ''}`}
                                        onClick={() => {
                                            pendingKeyboardFocusIdRef.current = null
                                            onSelectStudent(student.id)
                                        }}
                                    >
                                        <Icon name="user" size={14} />
                                        <span className="pr-student-list-name">
                                            {studentDisplayName}
                                        </span>
                                        {isSelected && <Icon name="check" size={12} active />}
                                    </button>
                                </div>
                            )
                        })
                    )}
                </div>
            </Card>

            {/* ── 右栏：学生画像 ── */}
            <div className="pr-student-profile-main">
                {!hasProfile ? (
                    <Card className="pr-student-profile-empty" padding="lg">
                        <Icon name="user" size={32} />
                        <p className="pr-student-profile-empty-title">
                            选择左侧学生查看认知画像
                        </p>
                        <p
                            className="pr-student-profile-empty-hint"
                            style={{ color: rgba(textTertiary, 1) }}
                        >
                            画像包含六阶能力雷达、知识漏洞与推荐学习路径
                        </p>
                    </Card>
                ) : (
                    <>
                        {/* 学生头部 */}
                        <Card className="pr-student-profile-header" padding="md">
                            <div className="pr-student-profile-name-row">
                                <Icon name="graduation" size={20} />
                                <h3 className="pr-student-profile-name">
                                    {profile.displayName ?? profile.anonymousName}
                                </h3>
                            </div>
                        </Card>

                        {/* 五维度立体画像（能力 1 深化） */}
                        <Profile3DSection
                            studentId={profile.studentId}
                            anonymousName={profile.displayName ?? profile.anonymousName}
                        />

                        {/* 六阶雷达 */}
                        <Card className="pr-student-profile-radar-card" padding="md">
                            <StudentRadar
                                radar={profile.bloomRadar}
                                anonymousName={profile.displayName ?? profile.anonymousName}
                            />
                        </Card>

                        {/* 知识漏洞列表 */}
                        <Card className="pr-student-profile-gaps" padding="md">
                            <div className="pr-student-profile-section-title">
                                <Icon name="warning-circle" size={14} />
                                知识漏洞
                                <span
                                    className="pr-student-profile-section-count"
                                    style={{ color: rgba(textTertiary, 1) }}
                                >
                                    {gaps.length} 项
                                </span>
                            </div>
                            {gaps.length === 0 ? (
                                <div className="pr-student-profile-gaps-empty">
                                    <Icon name="check-circle" size={20} />
                                    <p className="pr-student-profile-gaps-empty-title">该生暂无显著知识漏洞</p>
                                    <p className="pr-student-profile-gaps-empty-desc">
                                        学生在六阶认知层级上表现稳定，可关注进阶"创造"级任务以持续挑战。
                                    </p>
                                </div>
                            ) : (
                                <ul className="pr-student-profile-gaps-list">
                                    {gaps.map((gap, idx) => (
                                        <li
                                            key={`${gap.poemId}-${gap.bloomLevel}-${idx}`}
                                            className="pr-student-profile-gap-item"
                                        >
                                            <div className="pr-student-profile-gap-header">
                                                <span
                                                    className="pr-student-profile-gap-bloom"
                                                    style={{
                                                        color: rgba(accentVar, 1),
                                                        backgroundColor: rgba(accentVar, 0.1),
                                                    }}
                                                >
                                                    {gap.bloomLevel}
                                                </span>
                                                <span
                                                    className="pr-student-profile-gap-poem"
                                                    style={{ color: rgba(textSecondary, 1) }}
                                                >
                                                    {gap.poemId}
                                                </span>
                                            </div>
                                            {gap.relatedWeaknesses.length > 0 && (
                                                <div className="pr-student-profile-gap-related">
                                                    <Icon name="share" size={12} />
                                                    <span>{gap.relatedWeaknesses.join('；')}</span>
                                                </div>
                                            )}
                                            {gap.suggestedPath.length > 0 && (
                                                <div className="pr-student-profile-gap-path">
                                                    <Icon name="arrow-right" size={12} />
                                                    <span>
                                                        建议路径：{gap.suggestedPath.join(' → ')}
                                                    </span>
                                                </div>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Card>

                        {/* 推荐学习路径 */}
                        <Card className="pr-student-profile-path" padding="md">
                            <div className="pr-student-profile-section-title">
                                <Icon name="lightbulb" size={14} />
                                推荐学习路径
                                <span
                                    className="pr-student-profile-section-count"
                                    style={{ color: rgba(textTertiary, 1) }}
                                >
                                    {profile.learningPath.length} 首
                                </span>
                            </div>
                            {profile.learningPath.length === 0 ? (
                                <div className="pr-student-profile-path-empty">
                                    <Icon name="graph" size={20} />
                                    <p className="pr-student-profile-path-empty-title">个性化学习路径待生成</p>
                                    <p className="pr-student-profile-path-empty-desc">
                                        系统暂未为该学生生成个性化学习路径，可确认其诊断数据已完整采集。
                                    </p>
                                </div>
                            ) : (
                                <ol className="pr-student-profile-path-list">
                                    {profile.learningPath.map((node, idx) => {
                                        const masteryColor = readCSSColor(colorVarForScore(node.currentMastery))
                                        return (
                                            <li
                                                key={`${node.poemId}-${idx}`}
                                                className="pr-student-profile-path-item"
                                            >
                                                <div className="pr-student-profile-path-rank">
                                                    {idx + 1}
                                                </div>
                                                <div className="pr-student-profile-path-content">
                                                    <div className="pr-student-profile-path-title-row">
                                                        <span className="pr-student-profile-path-title">
                                                            {node.title}
                                                        </span>
                                                        <span
                                                            className="pr-student-profile-path-meta"
                                                            style={{ color: rgba(textTertiary, 1) }}
                                                        >
                                                            {node.poet} · {node.dynasty}
                                                        </span>
                                                    </div>
                                                    <div className="pr-student-profile-path-info">
                                                        <span
                                                            className="pr-student-profile-path-mastery"
                                                            style={{
                                                                color: rgba(masteryColor, 1),
                                                                backgroundColor: rgba(masteryColor, 0.1),
                                                            }}
                                                        >
                                                            掌握 {Math.round(node.currentMastery)}
                                                        </span>
                                                        <span
                                                            className="pr-student-profile-path-difficulty"
                                                            style={{ color: rgba(textTertiary, 1) }}
                                                        >
                                                            难度 {node.difficulty}
                                                        </span>
                                                        {node.relationType && (
                                                            <span
                                                                className="pr-student-profile-path-relation"
                                                                style={{ color: rgba(textSecondary, 1) }}
                                                            >
                                                                <Icon name="share" size={11} />
                                                                {node.relationType}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p
                                                        className="pr-student-profile-path-reason"
                                                        style={{ color: rgba(textSecondary, 1) }}
                                                    >
                                                        {node.reason}
                                                    </p>
                                                </div>
                                            </li>
                                        )
                                    })}
                                </ol>
                            )}
                        </Card>
                    </>
                )}
            </div>
        </div>
    )
})
