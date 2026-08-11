/**
 * 教研报告图表组件（SubTask 14.3 + v5.0 数据真实化）
 *
 * 纯 Canvas 实现 8 种图表，零图表库依赖：
 *
 * v5.0 新增（对接 GET /api/report/:id/charts，TanStack Query 数据驱动）：
 * 5. ScoreDistributionChart   —— 班级整体成绩分布柱状图
 * 6. KnowledgeMasteryChart    —— 知识点掌握度折线图
 * 7. BloomDistributionChart   —— Bloom 分类分布饼图
 * 8. WeeklyComparisonChart    —— 周次对比多系列折线图
 *
 * 保留原有（基于 ReportRecord.exportedData）：
 * 1. BloomRadarChartReport —— 六阶能力雷达图
 * 2. WeeklyActivityChart  —— 周度学习活跃度折线图
 * 3. DarkMatterChart      —— 认知暗物质柱状图
 * 4. EngagementChart      —— 参与度面积图
 *
 * 设计要点（规范第 6、10、15 章）：
 * - 高 DPI：devicePixelRatio 缩放，Retina 屏清晰
 * - 600ms 入场动画：ease-out 缓动，数据从基线展开
 * - hover 数值：鼠标悬停最近数据点显示 tooltip
 * - 零硬编码色值：所有颜色从 CSS 变量读取
 * - ResizeObserver：容器尺寸变化时 100ms debounce 后重绘
 * - prefers-reduced-motion：降级为 0 时长
 * - 仅 transform/opacity 动画属性，保证 60fps
 * - 加载/错误/空数据态完整覆盖（v5.0）
 */

import { useEffect, useRef, memo, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, Icon, Skeleton } from '@/components/ui'
import { api } from '@/lib/api'
import { BLOOM_ORDER } from '@/lib/types'
import type {
    ReportBloomMastery,
    DarkMatterReport,
    AnonymizedEvent,
    ScoreDistributionBin,
    KnowledgeMasteryPoint,
    BloomDistributionSlice,
    WeeklyComparisonSeries,
} from '@/lib/types'
import { getDisplayError } from '@/lib/errors'
import { readCSSColor, rgba, easeOut } from '@/lib/chartPalette'
import { observeElementResize } from '@/lib/resize-observer'
import { matchesMediaQuery } from '@/lib/media-query'

// ─────────────────────────────────────────────────────────────
// 共享工具
// ─────────────────────────────────────────────────────────────

const ANIMATION_MS = 600

/** 检测 prefers-reduced-motion */
function prefersReducedMotion(): boolean {
    return matchesMediaQuery('(prefers-reduced-motion: reduce)')
}

/** 六阶轴角度（弧度），从正上方开始顺时针 */
const BLOOM_AXES: number[] = BLOOM_ORDER.map((_, i) => {
    return -Math.PI / 2 + (i * Math.PI * 2) / BLOOM_ORDER.length
})

/**
 * Canvas 绘图 Hook —— 封装高 DPI、动画、ResizeObserver、hover
 *
 * @param draw 绘制函数，接收 (ctx, width, height, progress, hoverIndex)
 * @returns canvasRef, containerRef, setHoverIndex
 */
function useChartCanvas(
    draw: (
        ctx: CanvasRenderingContext2D,
        width: number,
        height: number,
        progress: number,
        hoverIndex: number,
    ) => void,
    deps: ReadonlyArray<unknown>,
) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const containerRef = useRef<HTMLDivElement | null>(null)
    const animationRef = useRef<number | null>(null)
    const hoverRef = useRef<number>(-1)
    const drawRef = useRef(draw)

    // 同步最新 draw 函数
    useEffect(() => {
        drawRef.current = draw
    })

    /** 执行绘制 */
    const render = useCallback((progress: number) => {
        const canvas = canvasRef.current
        const container = containerRef.current
        if (!canvas || !container) return

        const dpr = window.devicePixelRatio || 1
        const rect = container.getBoundingClientRect()
        const w = rect.width
        const h = rect.height
        if (w === 0 || h === 0) return

        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr)
            canvas.height = Math.round(h * dpr)
        }
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`

        const ctx = canvas.getContext('2d')
        if (!ctx) return

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, w, h)
        drawRef.current(ctx, w, h, progress, hoverRef.current)
    }, [])

    /** 启动入场动画 */
    const startAnimation = useCallback(() => {
        if (animationRef.current !== null) {
            cancelAnimationFrame(animationRef.current)
        }
        if (prefersReducedMotion()) {
            render(1)
            return
        }
        const start = performance.now()
        const tick = (now: number) => {
            const elapsed = now - start
            const p = Math.min(1, elapsed / ANIMATION_MS)
            render(easeOut(p))
            if (p < 1) {
                animationRef.current = requestAnimationFrame(tick)
            } else {
                animationRef.current = null
            }
        }
        animationRef.current = requestAnimationFrame(tick)
    }, [render])

    // 数据变化时重启动画
    useEffect(() => {
        startAnimation()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)

    // ResizeObserver：容器尺寸变化时 100ms debounce 后重绘
    useEffect(() => {
        const container = containerRef.current
        if (!container) return
        let timer: number | null = null
        const stopObserving = observeElementResize(container, () => {
            if (timer !== null) window.clearTimeout(timer)
            timer = window.setTimeout(() => {
                render(1)
                timer = null
            }, 100)
        })
        return () => {
            stopObserving()
            if (timer !== null) window.clearTimeout(timer)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // 清理动画帧
    useEffect(() => {
        return () => {
            if (animationRef.current !== null) {
                cancelAnimationFrame(animationRef.current)
                animationRef.current = null
            }
        }
    }, [])

    /** 设置 hover 索引并重绘 */
    const setHoverIndex = useCallback((idx: number) => {
        hoverRef.current = idx
        render(1)
    }, [render])

    return { canvasRef, containerRef, setHoverIndex }
}

// ─────────────────────────────────────────────────────────────
// 1. 六阶能力雷达图
// ─────────────────────────────────────────────────────────────

interface BloomRadarProps {
    radar: ReportBloomMastery | null
}

export const BloomRadarChartReport = memo(function BloomRadarChartReport({ radar }: BloomRadarProps) {
    const radarRef = useRef<ReportBloomMastery | null>(radar)
    useEffect(() => { radarRef.current = radar }, [radar])

    const draw = useCallback((
        ctx: CanvasRenderingContext2D,
        w: number,
        h: number,
        progress: number,
        _hover: number,
    ) => {
        const cBorder = readCSSColor('--c-text-tertiary')
        const cAccent = readCSSColor('--c-accent-primary')
        const cTextPrimary = readCSSColor('--c-text-primary')
        const cTextSecondary = readCSSColor('--c-text-secondary')
        const cTextInverse = readCSSColor('--c-text-inverse')

        const cx = w / 2
        const cy = h / 2
        const padding = Math.max(36, w * 0.16)
        const maxR = Math.max(10, Math.min(cx, cy) - padding)
        const gridLevels = [0.2, 0.4, 0.6, 0.8, 1.0]

        // 网格六边形
        ctx.lineWidth = 1
        for (const level of gridLevels) {
            const r = maxR * level
            ctx.beginPath()
            for (let i = 0; i < BLOOM_ORDER.length; i++) {
                const a = BLOOM_AXES[i]
                if (typeof a !== 'number') continue
                const x = cx + r * Math.cos(a)
                const y = cy + r * Math.sin(a)
                if (i === 0) ctx.moveTo(x, y)
                else ctx.lineTo(x, y)
            }
            ctx.closePath()
            ctx.strokeStyle = rgba(cBorder, 0.15)
            ctx.stroke()
        }

        // 轴线
        ctx.strokeStyle = rgba(cBorder, 0.15)
        for (let i = 0; i < BLOOM_ORDER.length; i++) {
            const a = BLOOM_AXES[i]
            if (typeof a !== 'number') continue
            ctx.beginPath()
            ctx.moveTo(cx, cy)
            ctx.lineTo(cx + maxR * Math.cos(a), cy + maxR * Math.sin(a))
            ctx.stroke()
        }

        // 轴标签
        ctx.font = `500 ${Math.max(11, w * 0.032)}px var(--font-sans, sans-serif)`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = rgba(cTextSecondary, 1)
        const labelOffset = maxR + 18
        for (let i = 0; i < BLOOM_ORDER.length; i++) {
            const a = BLOOM_AXES[i]
            const level = BLOOM_ORDER[i]
            if (typeof a !== 'number' || !level) continue
            ctx.fillText(level, cx + labelOffset * Math.cos(a), cy + labelOffset * Math.sin(a))
        }

        // 数据多边形
        const data = radarRef.current
        if (data && progress > 0) {
            const points: Array<{ x: number; y: number; v: number }> = []
            for (let i = 0; i < BLOOM_ORDER.length; i++) {
                const level = BLOOM_ORDER[i]
                const a = BLOOM_AXES[i]
                if (!level || typeof a !== 'number') continue
                const raw = data[level] ?? 0
                const norm = Math.min(100, Math.max(0, raw)) / 100
                const r = maxR * norm * progress
                points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), v: raw })
            }

            // 填充
            ctx.beginPath()
            points.forEach((p, i) => {
                if (i === 0) ctx.moveTo(p.x, p.y)
                else ctx.lineTo(p.x, p.y)
            })
            ctx.closePath()
            ctx.fillStyle = rgba(cAccent, 0.2)
            ctx.fill()
            ctx.lineWidth = 2
            ctx.strokeStyle = rgba(cAccent, 1)
            ctx.stroke()

            // 数据点
            for (const p of points) {
                ctx.beginPath()
                ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
                ctx.fillStyle = rgba(cAccent, 1)
                ctx.fill()
                ctx.strokeStyle = rgba(cTextInverse, 1)
                ctx.lineWidth = 1.5
                ctx.stroke()
            }

            // 数值标签
            if (progress >= 0.95) {
                ctx.font = `600 ${Math.max(10, w * 0.026)}px var(--font-sans, sans-serif)`
                ctx.fillStyle = rgba(cTextPrimary, 1)
                for (let i = 0; i < points.length; i++) {
                    const p = points[i]
                    const a = BLOOM_AXES[i]
                    if (!p || typeof a !== 'number') continue
                    ctx.fillText(Math.round(p.v).toString(), p.x + 14 * Math.cos(a), p.y + 14 * Math.sin(a))
                }
            }
        }
    }, [])

    const { canvasRef, containerRef } = useChartCanvas(draw, [radar])

    return (
        <Card className="pr-rpt-chart-card" padding="md">
            <div className="pr-rpt-chart-head">
                <h3 className="pr-rpt-chart-title">六阶能力雷达</h3>
                <p className="pr-rpt-chart-subtitle">布鲁姆认知分类 · 班级均值</p>
            </div>
            <div className="pr-rpt-chart-canvas-wrapper" ref={containerRef}>
                <canvas ref={canvasRef} className="pr-rpt-chart-canvas" aria-label="六阶能力雷达图" />
            </div>
        </Card>
    )
})

// ─────────────────────────────────────────────────────────────
// 2. 周度学习活跃度折线图
// ─────────────────────────────────────────────────────────────

interface WeeklyActivityProps {
    events: AnonymizedEvent[]
    period: { from: number; to: number }
}

/** 按周聚合事件数量 */
function aggregateWeekly(events: AnonymizedEvent[], from: number, to: number): Array<{ week: string; count: number }> {
    if (events.length === 0 || to <= from) return []
    const weekMs = 7 * 24 * 60 * 60 * 1000
    const totalWeeks = Math.max(1, Math.ceil((to - from) / weekMs))
    const buckets = new Array(totalWeeks).fill(0)
    for (const e of events) {
        const idx = Math.floor((e.occurredAt - from) / weekMs)
        if (idx >= 0 && idx < totalWeeks) buckets[idx] = (buckets[idx] ?? 0) + 1
    }
    return buckets.map((count, i) => {
        const weekStart = from + i * weekMs
        const d = new Date(weekStart)
        return { week: `${d.getMonth() + 1}/${d.getDate()}`, count }
    })
}

export const WeeklyActivityChart = memo(function WeeklyActivityChart({ events, period }: WeeklyActivityProps) {
    const dataRef = useRef<Array<{ week: string; count: number }>>([])
    const weekly = aggregateWeekly(events, period.from, period.to)
    dataRef.current = weekly

    const draw = useCallback((
        ctx: CanvasRenderingContext2D,
        w: number,
        h: number,
        progress: number,
        hover: number,
    ) => {
        const cBorder = readCSSColor('--c-text-tertiary')
        const cAccent = readCSSColor('--c-accent-primary')
        const cTextPrimary = readCSSColor('--c-text-primary')
        const cTextSecondary = readCSSColor('--c-text-secondary')
        const cTextInverse = readCSSColor('--c-text-inverse')

        const padding = { top: 20, right: 16, bottom: 32, left: 40 }
        const chartW = Math.max(10, w - padding.left - padding.right)
        const chartH = Math.max(10, h - padding.top - padding.bottom)

        const data = dataRef.current
        if (data.length === 0) {
            ctx.font = `400 13px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText('暂无学习活动数据', w / 2, h / 2)
            return
        }

        const maxCount = Math.max(...data.map((d) => d.count), 1)
        const stepX = chartW / Math.max(1, data.length - 1)

        // Y 轴网格 + 标签
        ctx.font = `500 11px var(--font-sans, sans-serif)`
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        ctx.strokeStyle = rgba(cBorder, 0.12)
        ctx.lineWidth = 1
        const ySteps = 4
        for (let i = 0; i <= ySteps; i++) {
            const y = padding.top + chartH - (chartH * i) / ySteps
            const val = Math.round((maxCount * i) / ySteps)
            ctx.beginPath()
            ctx.moveTo(padding.left, y)
            ctx.lineTo(padding.left + chartW, y)
            ctx.stroke()
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.fillText(String(val), padding.left - 8, y)
        }

        // X 轴标签
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const labelStep = Math.ceil(data.length / 6)
        for (let i = 0; i < data.length; i += labelStep) {
            const d = data[i]
            if (!d) continue
            const x = padding.left + i * stepX
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.fillText(d.week, x, padding.top + chartH + 8)
        }

        // 折线 + 面积
        const points = data.map((d, i) => ({
            x: padding.left + i * stepX,
            y: padding.top + chartH - (chartH * d.count) / maxCount * progress,
            count: d.count,
            week: d.week,
        }))

        // 面积填充
        if (points.length === 0) return
        const firstPt = points[0]
        const lastPt = points[points.length - 1]
        if (!firstPt || !lastPt) return
        ctx.beginPath()
        ctx.moveTo(firstPt.x, padding.top + chartH)
        points.forEach((p) => ctx.lineTo(p.x, p.y))
        ctx.lineTo(lastPt.x, padding.top + chartH)
        ctx.closePath()
        const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH)
        grad.addColorStop(0, rgba(cAccent, 0.25))
        grad.addColorStop(1, rgba(cAccent, 0.02))
        ctx.fillStyle = grad
        ctx.fill()

        // 折线
        ctx.beginPath()
        points.forEach((p, i) => {
            if (i === 0) ctx.moveTo(p.x, p.y)
            else ctx.lineTo(p.x, p.y)
        })
        ctx.strokeStyle = rgba(cAccent, 1)
        ctx.lineWidth = 2
        ctx.stroke()

        // 数据点
        for (let i = 0; i < points.length; i++) {
            const p = points[i]
            if (!p) continue
            const isHover = i === hover
            ctx.beginPath()
            ctx.arc(p.x, p.y, isHover ? 5 : 3, 0, Math.PI * 2)
            ctx.fillStyle = rgba(cAccent, 1)
            ctx.fill()
            ctx.strokeStyle = rgba(cTextInverse, 1)
            ctx.lineWidth = 1.5
            ctx.stroke()
        }

        // hover tooltip
        if (hover >= 0 && hover < points.length && progress >= 0.95) {
            const p = points[hover]
            if (!p) return
            const text = `${p.week} · ${p.count} 次`
            ctx.font = `600 12px var(--font-sans, sans-serif)`
            const tw = ctx.measureText(text).width + 16
            const th = 24
            const tx = Math.min(w - tw - 4, Math.max(4, p.x - tw / 2))
            const ty = Math.max(4, p.y - th - 8)
            ctx.fillStyle = rgba(readCSSColor('--c-surface-elevated'), 0.92)
            ctx.beginPath()
            ctx.roundRect(tx, ty, tw, th, 6)
            ctx.fill()
            ctx.strokeStyle = rgba(cBorder, 0.2)
            ctx.stroke()
            ctx.fillStyle = rgba(cTextPrimary, 1)
            ctx.textAlign = 'left'
            ctx.textBaseline = 'middle'
            ctx.fillText(text, tx + 8, ty + th / 2)
        }
    }, [])

    const { canvasRef, containerRef, setHoverIndex } = useChartCanvas(draw, [events, period])

    const handleMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        const container = containerRef.current
        if (!canvas || !container) return
        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const padding = { left: 40, right: 16 }
        const chartW = rect.width - padding.left - padding.right
        const data = dataRef.current
        if (data.length === 0) return
        const stepX = chartW / Math.max(1, data.length - 1)
        const idx = Math.round((x - padding.left) / stepX)
        setHoverIndex(Math.max(0, Math.min(data.length - 1, idx)))
    }, [canvasRef, containerRef, setHoverIndex])

    const handleLeave = useCallback(() => {
        setHoverIndex(-1)
    }, [setHoverIndex])

    return (
        <Card className="pr-rpt-chart-card" padding="md">
            <div className="pr-rpt-chart-head">
                <h3 className="pr-rpt-chart-title">周度学习活跃度</h3>
                <p className="pr-rpt-chart-subtitle">每周学习事件数量趋势</p>
            </div>
            <div className="pr-rpt-chart-canvas-wrapper" ref={containerRef}>
                <canvas
                    ref={canvasRef}
                    className="pr-rpt-chart-canvas"
                    aria-label="周度学习活跃度折线图"
                    onMouseMove={handleMove}
                    onMouseLeave={handleLeave}
                />
            </div>
        </Card>
    )
})

// ─────────────────────────────────────────────────────────────
// 3. 认知暗物质柱状图
// ─────────────────────────────────────────────────────────────

interface DarkMatterChartProps {
    report: DarkMatterReport | null
}

export const DarkMatterChart = memo(function DarkMatterChart({ report }: DarkMatterChartProps) {
    const dataRef = useRef<Array<{ label: string; count: number }>>([])
    const byBloom = report?.byBloomLevel ?? {}
    const entries = Object.entries(byBloom).map(([label, count]) => ({ label, count }))
    dataRef.current = entries

    const draw = useCallback((
        ctx: CanvasRenderingContext2D,
        w: number,
        h: number,
        progress: number,
        hover: number,
    ) => {
        const cBorder = readCSSColor('--c-text-tertiary')
        const cAccent = readCSSColor('--c-accent-warning')
        const cTextPrimary = readCSSColor('--c-text-primary')
        const cTextSecondary = readCSSColor('--c-text-secondary')

        const padding = { top: 20, right: 16, bottom: 40, left: 40 }
        const chartW = Math.max(10, w - padding.left - padding.right)
        const chartH = Math.max(10, h - padding.top - padding.bottom)

        const data = dataRef.current
        if (data.length === 0) {
            ctx.font = `400 13px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText('暂无暗物质数据', w / 2, h / 2)
            return
        }

        const maxCount = Math.max(...data.map((d) => d.count), 1)
        const barW = chartW / data.length * 0.6
        const barGap = chartW / data.length * 0.4

        // Y 轴网格
        ctx.font = `500 11px var(--font-sans, sans-serif)`
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        ctx.strokeStyle = rgba(cBorder, 0.12)
        ctx.lineWidth = 1
        const ySteps = 4
        for (let i = 0; i <= ySteps; i++) {
            const y = padding.top + chartH - (chartH * i) / ySteps
            const val = Math.round((maxCount * i) / ySteps)
            ctx.beginPath()
            ctx.moveTo(padding.left, y)
            ctx.lineTo(padding.left + chartW, y)
            ctx.stroke()
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.fillText(String(val), padding.left - 8, y)
        }

        // 柱子
        for (let i = 0; i < data.length; i++) {
            const d = data[i]
            if (!d) continue
            const barH = (chartH * d.count) / maxCount * progress
            const x = padding.left + i * (barW + barGap) + barGap / 2
            const y = padding.top + chartH - barH
            const isHover = i === hover

            // 渐变填充
            const grad = ctx.createLinearGradient(0, y, 0, padding.top + chartH)
            grad.addColorStop(0, rgba(cAccent, isHover ? 1 : 0.85))
            grad.addColorStop(1, rgba(cAccent, isHover ? 0.6 : 0.4))
            ctx.fillStyle = grad
            ctx.beginPath()
            ctx.roundRect(x, y, barW, barH, [4, 4, 0, 0])
            ctx.fill()

            // X 轴标签
            ctx.font = `500 11px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.textAlign = 'center'
            ctx.textBaseline = 'top'
            ctx.fillText(d.label, x + barW / 2, padding.top + chartH + 8)

            // 数值（hover 或动画完成时显示）
            if ((isHover || progress >= 0.95) && barH > 0) {
                ctx.font = `600 11px var(--font-sans, sans-serif)`
                ctx.fillStyle = rgba(cTextPrimary, isHover ? 1 : 0.7)
                ctx.textBaseline = 'bottom'
                ctx.fillText(String(d.count), x + barW / 2, y - 4)
            }
        }
    }, [])

    const { canvasRef, containerRef, setHoverIndex } = useChartCanvas(draw, [report])

    const handleMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const padding = { left: 40, right: 16 }
        const chartW = rect.width - padding.left - padding.right
        const data = dataRef.current
        if (data.length === 0) return
        const slotW = chartW / data.length
        const idx = Math.floor((x - padding.left) / slotW)
        setHoverIndex(Math.max(0, Math.min(data.length - 1, idx)))
    }, [canvasRef, setHoverIndex])

    const handleLeave = useCallback(() => {
        setHoverIndex(-1)
    }, [setHoverIndex])

    return (
        <Card className="pr-rpt-chart-card" padding="md">
            <div className="pr-rpt-chart-head">
                <h3 className="pr-rpt-chart-title">认知暗物质分布</h3>
                <p className="pr-rpt-chart-subtitle">按布鲁姆层级统计卡顿点数量</p>
            </div>
            <div className="pr-rpt-chart-canvas-wrapper" ref={containerRef}>
                <canvas
                    ref={canvasRef}
                    className="pr-rpt-chart-canvas"
                    aria-label="认知薄弱柱状图"
                    onMouseMove={handleMove}
                    onMouseLeave={handleLeave}
                />
            </div>
        </Card>
    )
})

// ─────────────────────────────────────────────────────────────
// 4. 参与度面积图
// ─────────────────────────────────────────────────────────────

interface EngagementChartProps {
    events: AnonymizedEvent[]
    period: { from: number; to: number }
}

/** 按天聚合参与学生数 */
function aggregateDaily(events: AnonymizedEvent[], from: number, to: number): Array<{ day: string; students: number; count: number }> {
    if (events.length === 0 || to <= from) return []
    const dayMs = 24 * 60 * 60 * 1000
    const totalDays = Math.max(1, Math.ceil((to - from) / dayMs))
    const buckets: Array<Set<string>> = new Array(totalDays).fill(null).map(() => new Set<string>())
    const counts = new Array(totalDays).fill(0)

    for (const e of events) {
        const idx = Math.floor((e.occurredAt - from) / dayMs)
        if (idx >= 0 && idx < totalDays) {
            const bucket = buckets[idx]
            if (bucket) bucket.add(e.studentId)
            counts[idx] = (counts[idx] ?? 0) + 1
        }
    }

    return buckets.map((set, i) => {
        const d = new Date(from + i * dayMs)
        return {
            day: `${d.getMonth() + 1}/${d.getDate()}`,
            students: set.size,
            count: counts[i] ?? 0,
        }
    })
}

export const EngagementChart = memo(function EngagementChart({ events, period }: EngagementChartProps) {
    const dataRef = useRef<Array<{ day: string; students: number; count: number }>>([])
    const daily = aggregateDaily(events, period.from, period.to)
    dataRef.current = daily

    const draw = useCallback((
        ctx: CanvasRenderingContext2D,
        w: number,
        h: number,
        progress: number,
        hover: number,
    ) => {
        const cBorder = readCSSColor('--c-text-tertiary')
        const cInfo = readCSSColor('--c-accent-info')
        const cTextPrimary = readCSSColor('--c-text-primary')
        const cTextSecondary = readCSSColor('--c-text-secondary')
        const cTextInverse = readCSSColor('--c-text-inverse')

        const padding = { top: 20, right: 16, bottom: 32, left: 40 }
        const chartW = Math.max(10, w - padding.left - padding.right)
        const chartH = Math.max(10, h - padding.top - padding.bottom)

        const data = dataRef.current
        if (data.length === 0) {
            ctx.font = `400 13px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText('暂无参与度数据', w / 2, h / 2)
            return
        }

        const maxStudents = Math.max(...data.map((d) => d.students), 1)
        const stepX = chartW / Math.max(1, data.length - 1)

        // Y 轴网格
        ctx.font = `500 11px var(--font-sans, sans-serif)`
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        ctx.strokeStyle = rgba(cBorder, 0.12)
        ctx.lineWidth = 1
        const ySteps = 4
        for (let i = 0; i <= ySteps; i++) {
            const y = padding.top + chartH - (chartH * i) / ySteps
            const val = Math.round((maxStudents * i) / ySteps)
            ctx.beginPath()
            ctx.moveTo(padding.left, y)
            ctx.lineTo(padding.left + chartW, y)
            ctx.stroke()
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.fillText(String(val), padding.left - 8, y)
        }

        // X 轴标签
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const labelStep = Math.ceil(data.length / 6)
        for (let i = 0; i < data.length; i += labelStep) {
            const d = data[i]
            if (!d) continue
            const x = padding.left + i * stepX
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.fillText(d.day, x, padding.top + chartH + 8)
        }

        // 面积
        const points = data.map((d, i) => ({
            x: padding.left + i * stepX,
            y: padding.top + chartH - (chartH * d.students) / maxStudents * progress,
            students: d.students,
            day: d.day,
        }))

        if (points.length === 0) return
        const firstPt = points[0]
        const lastPt = points[points.length - 1]
        if (!firstPt || !lastPt) return
        ctx.beginPath()
        ctx.moveTo(firstPt.x, padding.top + chartH)
        points.forEach((p) => ctx.lineTo(p.x, p.y))
        ctx.lineTo(lastPt.x, padding.top + chartH)
        ctx.closePath()
        const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH)
        grad.addColorStop(0, rgba(cInfo, 0.3))
        grad.addColorStop(1, rgba(cInfo, 0.02))
        ctx.fillStyle = grad
        ctx.fill()

        // 描边
        ctx.beginPath()
        points.forEach((p, i) => {
            if (i === 0) ctx.moveTo(p.x, p.y)
            else ctx.lineTo(p.x, p.y)
        })
        ctx.strokeStyle = rgba(cInfo, 1)
        ctx.lineWidth = 2
        ctx.stroke()

        // 数据点
        for (let i = 0; i < points.length; i++) {
            const p = points[i]
            if (!p) continue
            const isHover = i === hover
            ctx.beginPath()
            ctx.arc(p.x, p.y, isHover ? 5 : 3, 0, Math.PI * 2)
            ctx.fillStyle = rgba(cInfo, 1)
            ctx.fill()
            ctx.strokeStyle = rgba(cTextInverse, 1)
            ctx.lineWidth = 1.5
            ctx.stroke()
        }

        // hover tooltip
        if (hover >= 0 && hover < points.length && progress >= 0.95) {
            const p = points[hover]
            if (!p) return
            const text = `${p.day} · ${p.students} 人参与`
            ctx.font = `600 12px var(--font-sans, sans-serif)`
            const tw = ctx.measureText(text).width + 16
            const th = 24
            const tx = Math.min(w - tw - 4, Math.max(4, p.x - tw / 2))
            const ty = Math.max(4, p.y - th - 8)
            ctx.fillStyle = rgba(readCSSColor('--c-surface-elevated'), 0.92)
            ctx.beginPath()
            ctx.roundRect(tx, ty, tw, th, 6)
            ctx.fill()
            ctx.strokeStyle = rgba(cBorder, 0.2)
            ctx.stroke()
            ctx.fillStyle = rgba(cTextPrimary, 1)
            ctx.textAlign = 'left'
            ctx.textBaseline = 'middle'
            ctx.fillText(text, tx + 8, ty + th / 2)
        }
    }, [])

    const { canvasRef, containerRef, setHoverIndex } = useChartCanvas(draw, [events, period])

    const handleMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const padding = { left: 40, right: 16 }
        const chartW = rect.width - padding.left - padding.right
        const data = dataRef.current
        if (data.length === 0) return
        const stepX = chartW / Math.max(1, data.length - 1)
        const idx = Math.round((x - padding.left) / stepX)
        setHoverIndex(Math.max(0, Math.min(data.length - 1, idx)))
    }, [canvasRef, setHoverIndex])

    const handleLeave = useCallback(() => {
        setHoverIndex(-1)
    }, [setHoverIndex])

    return (
        <Card className="pr-rpt-chart-card" padding="md">
            <div className="pr-rpt-chart-head">
                <h3 className="pr-rpt-chart-title">参与度趋势</h3>
                <p className="pr-rpt-chart-subtitle">每日参与学习的学生人数</p>
            </div>
            <div className="pr-rpt-chart-canvas-wrapper" ref={containerRef}>
                <canvas
                    ref={canvasRef}
                    className="pr-rpt-chart-canvas"
                    aria-label="参与度面积图"
                    onMouseMove={handleMove}
                    onMouseLeave={handleLeave}
                />
            </div>
        </Card>
    )
})

// ─────────────────────────────────────────────────────────────
// v5.0 新增图表 5：班级整体成绩分布柱状图
// 对接 GET /api/report/:id/charts.scoreDistribution
// ─────────────────────────────────────────────────────────────

interface ScoreDistributionChartProps {
    data: ScoreDistributionBin[]
}

export const ScoreDistributionChart = memo(function ScoreDistributionChart({ data }: ScoreDistributionChartProps) {
    const dataRef = useRef<ScoreDistributionBin[]>(data)
    useEffect(() => { dataRef.current = data }, [data])

    const draw = useCallback((
        ctx: CanvasRenderingContext2D,
        w: number,
        h: number,
        progress: number,
        hover: number,
    ) => {
        const cBorder = readCSSColor('--c-text-tertiary')
        const cAccent = readCSSColor('--c-accent-primary')
        const cTextPrimary = readCSSColor('--c-text-primary')
        const cTextSecondary = readCSSColor('--c-text-secondary')

        const padding = { top: 24, right: 16, bottom: 40, left: 44 }
        const chartW = Math.max(10, w - padding.left - padding.right)
        const chartH = Math.max(10, h - padding.top - padding.bottom)

        const bins = dataRef.current
        if (bins.length === 0) {
            ctx.font = `400 13px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText('暂无成绩分布数据', w / 2, h / 2)
            return
        }

        const maxCount = Math.max(...bins.map((b) => b.count), 1)
        const slotW = chartW / bins.length
        const barW = slotW * 0.6

        // Y 轴网格 + 标签
        ctx.font = `500 11px var(--font-sans, sans-serif)`
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        ctx.strokeStyle = rgba(cBorder, 0.12)
        ctx.lineWidth = 1
        const ySteps = 4
        for (let i = 0; i <= ySteps; i++) {
            const y = padding.top + chartH - (chartH * i) / ySteps
            const val = Math.round((maxCount * i) / ySteps)
            ctx.beginPath()
            ctx.moveTo(padding.left, y)
            ctx.lineTo(padding.left + chartW, y)
            ctx.stroke()
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.fillText(`${val}人`, padding.left - 8, y)
        }

        // 柱子
        for (let i = 0; i < bins.length; i++) {
            const bin = bins[i]
            if (!bin) continue
            const barH = (chartH * bin.count) / maxCount * progress
            const x = padding.left + i * slotW + (slotW - barW) / 2
            const y = padding.top + chartH - barH
            const isHover = i === hover

            // 渐变填充：使用 accent-primary alpha 渐变
            const grad = ctx.createLinearGradient(0, y, 0, padding.top + chartH)
            grad.addColorStop(0, rgba(cAccent, isHover ? 1 : 0.85))
            grad.addColorStop(1, rgba(cAccent, isHover ? 0.55 : 0.35))
            ctx.fillStyle = grad
            ctx.beginPath()
            ctx.roundRect(x, y, barW, barH, [6, 6, 0, 0])
            ctx.fill()

            // X 轴标签（区间）
            ctx.font = `500 11px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.textAlign = 'center'
            ctx.textBaseline = 'top'
            ctx.fillText(bin.label, x + barW / 2, padding.top + chartH + 8)

            // 数值标签（hover 或动画完成时）
            if ((isHover || progress >= 0.95) && bin.count > 0) {
                ctx.font = `600 11px var(--font-sans, sans-serif)`
                ctx.fillStyle = rgba(cTextPrimary, isHover ? 1 : 0.75)
                ctx.textBaseline = 'bottom'
                ctx.fillText(`${bin.count}`, x + barW / 2, y - 4)
            }
        }
    }, [])

    const { canvasRef, containerRef, setHoverIndex } = useChartCanvas(draw, [data])

    const handleMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const padding = { left: 44, right: 16 }
        const chartW = rect.width - padding.left - padding.right
        const bins = dataRef.current
        if (bins.length === 0) return
        const slotW = chartW / bins.length
        const idx = Math.floor((x - padding.left) / slotW)
        setHoverIndex(Math.max(0, Math.min(bins.length - 1, idx)))
    }, [canvasRef, setHoverIndex])

    const handleLeave = useCallback(() => setHoverIndex(-1), [setHoverIndex])

    return (
        <Card className="pr-rpt-chart-card" padding="md">
            <div className="pr-rpt-chart-head">
                <h3 className="pr-rpt-chart-title">班级整体成绩分布</h3>
                <p className="pr-rpt-chart-subtitle">按分数区间统计学生人数</p>
            </div>
            <div className="pr-rpt-chart-canvas-wrapper" ref={containerRef}>
                <canvas
                    ref={canvasRef}
                    className="pr-rpt-chart-canvas"
                    aria-label="班级整体成绩分布柱状图"
                    onMouseMove={handleMove}
                    onMouseLeave={handleLeave}
                />
            </div>
        </Card>
    )
})

// ─────────────────────────────────────────────────────────────
// v5.0 新增图表 6：知识点掌握度折线图
// 对接 GET /api/report/:id/charts.knowledgeMastery
// ─────────────────────────────────────────────────────────────

interface KnowledgeMasteryChartProps {
    data: KnowledgeMasteryPoint[]
}

export const KnowledgeMasteryChart = memo(function KnowledgeMasteryChart({ data }: KnowledgeMasteryChartProps) {
    const dataRef = useRef<KnowledgeMasteryPoint[]>(data)
    useEffect(() => { dataRef.current = data }, [data])

    const draw = useCallback((
        ctx: CanvasRenderingContext2D,
        w: number,
        h: number,
        progress: number,
        hover: number,
    ) => {
        const cBorder = readCSSColor('--c-text-tertiary')
        const cAccent = readCSSColor('--c-accent-primary')
        const cMuted = readCSSColor('--c-text-secondary')
        const cTextPrimary = readCSSColor('--c-text-primary')
        const cTextSecondary = readCSSColor('--c-text-secondary')
        const cTextInverse = readCSSColor('--c-text-inverse')

        const padding = { top: 24, right: 24, bottom: 56, left: 44 }
        const chartW = Math.max(10, w - padding.left - padding.right)
        const chartH = Math.max(10, h - padding.top - padding.bottom)

        const points = dataRef.current
        if (points.length === 0) {
            ctx.font = `400 13px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText('暂无知识点掌握度数据', w / 2, h / 2)
            return
        }

        const stepX = chartW / Math.max(1, points.length - 1)

        // Y 轴网格 + 标签（0-100 掌握度）
        ctx.font = `500 11px var(--font-sans, sans-serif)`
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        ctx.strokeStyle = rgba(cBorder, 0.12)
        ctx.lineWidth = 1
        const ySteps = 5
        for (let i = 0; i <= ySteps; i++) {
            const y = padding.top + chartH - (chartH * i) / ySteps
            const val = Math.round((100 * i) / ySteps)
            ctx.beginPath()
            ctx.moveTo(padding.left, y)
            ctx.lineTo(padding.left + chartW, y)
            ctx.stroke()
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.fillText(`${val}`, padding.left - 8, y)
        }

        // 上期对比线（虚线）
        const hasPrev = points.some((p) => p.previousMastery !== undefined)
        if (hasPrev) {
            ctx.setLineDash([4, 4])
            ctx.strokeStyle = rgba(cMuted, 0.5)
            ctx.lineWidth = 1.5
            ctx.beginPath()
            points.forEach((p, i) => {
                const x = padding.left + i * stepX
                const prev = p.previousMastery ?? 0
                const y = padding.top + chartH - (chartH * prev) / 100 * progress
                if (i === 0) ctx.moveTo(x, y)
                else ctx.lineTo(x, y)
            })
            ctx.stroke()
            ctx.setLineDash([])
        }

        // 当期折线
        const linePoints = points.map((p, i) => ({
            x: padding.left + i * stepX,
            y: padding.top + chartH - (chartH * Math.min(100, Math.max(0, p.mastery))) / 100 * progress,
            mastery: p.mastery,
            knowledge: p.knowledge,
            prev: p.previousMastery,
        }))

        // 面积填充
        if (linePoints.length > 0) {
            const first = linePoints[0]
            const last = linePoints[linePoints.length - 1]
            if (first && last) {
                ctx.beginPath()
                ctx.moveTo(first.x, padding.top + chartH)
                linePoints.forEach((p) => ctx.lineTo(p.x, p.y))
                ctx.lineTo(last.x, padding.top + chartH)
                ctx.closePath()
                const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH)
                grad.addColorStop(0, rgba(cAccent, 0.25))
                grad.addColorStop(1, rgba(cAccent, 0.02))
                ctx.fillStyle = grad
                ctx.fill()
            }
        }

        // 折线
        ctx.beginPath()
        linePoints.forEach((p, i) => {
            if (i === 0) ctx.moveTo(p.x, p.y)
            else ctx.lineTo(p.x, p.y)
        })
        ctx.strokeStyle = rgba(cAccent, 1)
        ctx.lineWidth = 2
        ctx.stroke()

        // 数据点 + X 轴标签
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        for (let i = 0; i < linePoints.length; i++) {
            const p = linePoints[i]
            if (!p) continue
            const isHover = i === hover
            ctx.beginPath()
            ctx.arc(p.x, p.y, isHover ? 5 : 3, 0, Math.PI * 2)
            ctx.fillStyle = rgba(cAccent, 1)
            ctx.fill()
            ctx.strokeStyle = rgba(cTextInverse, 1)
            ctx.lineWidth = 1.5
            ctx.stroke()

            // X 轴标签（旋转 -30° 防重叠）
            ctx.save()
            ctx.translate(p.x, padding.top + chartH + 10)
            ctx.rotate(-Math.PI / 6)
            ctx.font = `500 11px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.textAlign = 'right'
            ctx.fillText(p.knowledge, 0, 0)
            ctx.restore()
        }

        // hover tooltip
        if (hover >= 0 && hover < linePoints.length && progress >= 0.95) {
            const p = linePoints[hover]
            if (!p) return
            const text = `${p.knowledge} · ${p.mastery.toFixed(1)}%`
            ctx.font = `600 12px var(--font-sans, sans-serif)`
            const tw = ctx.measureText(text).width + 16
            const th = 24
            const tx = Math.min(w - tw - 4, Math.max(4, p.x - tw / 2))
            const ty = Math.max(4, p.y - th - 8)
            ctx.fillStyle = rgba(readCSSColor('--c-surface-elevated'), 0.92)
            ctx.beginPath()
            ctx.roundRect(tx, ty, tw, th, 6)
            ctx.fill()
            ctx.strokeStyle = rgba(cBorder, 0.2)
            ctx.stroke()
            ctx.fillStyle = rgba(cTextPrimary, 1)
            ctx.textAlign = 'left'
            ctx.textBaseline = 'middle'
            ctx.fillText(text, tx + 8, ty + th / 2)
        }
    }, [])

    const { canvasRef, containerRef, setHoverIndex } = useChartCanvas(draw, [data])

    const handleMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const padding = { left: 44, right: 24 }
        const chartW = rect.width - padding.left - padding.right
        const pts = dataRef.current
        if (pts.length === 0) return
        const stepX = chartW / Math.max(1, pts.length - 1)
        const idx = Math.round((x - padding.left) / stepX)
        setHoverIndex(Math.max(0, Math.min(pts.length - 1, idx)))
    }, [canvasRef, setHoverIndex])

    const handleLeave = useCallback(() => setHoverIndex(-1), [setHoverIndex])

    return (
        <Card className="pr-rpt-chart-card" padding="md">
            <div className="pr-rpt-chart-head">
                <h3 className="pr-rpt-chart-title">知识点掌握度</h3>
                <p className="pr-rpt-chart-subtitle">班级各知识点平均掌握度（实线本期 / 虚线上期）</p>
            </div>
            <div className="pr-rpt-chart-canvas-wrapper" ref={containerRef}>
                <canvas
                    ref={canvasRef}
                    className="pr-rpt-chart-canvas"
                    aria-label="知识点掌握度折线图"
                    onMouseMove={handleMove}
                    onMouseLeave={handleLeave}
                />
            </div>
        </Card>
    )
})

// ─────────────────────────────────────────────────────────────
// v5.0 新增图表 7：Bloom 分类分布饼图
// 对接 GET /api/report/:id/charts.bloomDistribution
// ─────────────────────────────────────────────────────────────

interface BloomDistributionChartProps {
    data: BloomDistributionSlice[]
}

/** 暖调色板：6 阶 Bloom 层级各一色（按规范 chart-qualitative 配色） */
const BLOOM_COLORS = [
    { varName: '--c-accent-primary', alpha: 1.0 },     // 记忆
    { varName: '--c-accent-warning', alpha: 0.85 },    // 理解
    { varName: '--c-accent-success', alpha: 0.85 },    // 应用
    { varName: '--c-accent-info', alpha: 0.85 },       // 分析
    { varName: '--c-accent-primary', alpha: 0.6 },     // 评价
    { varName: '--c-accent-error', alpha: 0.75 },      // 创造
]

export const BloomDistributionChart = memo(function BloomDistributionChart({ data }: BloomDistributionChartProps) {
    const dataRef = useRef<BloomDistributionSlice[]>(data)
    useEffect(() => { dataRef.current = data }, [data])

    const draw = useCallback((
        ctx: CanvasRenderingContext2D,
        w: number,
        h: number,
        progress: number,
        hover: number,
    ) => {
        const cTextPrimary = readCSSColor('--c-text-primary')
        const cTextSecondary = readCSSColor('--c-text-secondary')
        const cTextInverse = readCSSColor('--c-text-inverse')

        const slices = dataRef.current
        if (slices.length === 0) {
            ctx.font = `400 13px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText('暂无 Bloom 分类数据', w / 2, h / 2)
            return
        }

        const cx = w * 0.38
        const cy = h / 2
        const maxR = Math.max(20, Math.min(cx, cy) - 16)
        const innerR = maxR * 0.55 // 环形

        const total = slices.reduce((sum, s) => sum + s.count, 0)
        if (total === 0) return

        // 绘制扇区
        let startAngle = -Math.PI / 2 // 从正上方开始
        const slicePaths: Array<{ x: number; y: number; mid: number; slice: BloomDistributionSlice }> = []
        for (let i = 0; i < slices.length; i++) {
            const slice = slices[i]
            if (!slice) continue
            const angle = (slice.count / total) * Math.PI * 2 * progress
            const endAngle = startAngle + angle
            const midAngle = startAngle + angle / 2
            const isHover = i === hover
            const r = isHover ? maxR + 6 : maxR

            const colorCfg = BLOOM_COLORS[i % BLOOM_COLORS.length]
            if (!colorCfg) continue
            const colorStr = readCSSColor(colorCfg.varName)

            ctx.beginPath()
            ctx.moveTo(cx, cy)
            ctx.arc(cx, cy, r, startAngle, endAngle)
            ctx.closePath()
            ctx.fillStyle = rgba(colorStr, colorCfg.alpha)
            ctx.fill()
            ctx.strokeStyle = rgba(cTextInverse, 0.8)
            ctx.lineWidth = 2
            ctx.stroke()

            // 中心镂空（环形效果）
            slicePaths.push({
                x: cx,
                y: cy,
                mid: midAngle,
                slice,
            })

            startAngle = endAngle
        }

        // 中心镂空（绘制背景色圆，与所在容器背景一致）
        ctx.beginPath()
        ctx.arc(cx, cy, innerR, 0, Math.PI * 2)
        ctx.fillStyle = rgba(readCSSColor('--c-surface-elevated'), 1)
        ctx.fill()

        // 中心总数
        ctx.font = `600 16px var(--font-sans, sans-serif)`
        ctx.fillStyle = rgba(cTextPrimary, 1)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(`${total}`, cx, cy - 6)
        ctx.font = `500 11px var(--font-sans, sans-serif)`
        ctx.fillStyle = rgba(cTextSecondary, 1)
        ctx.fillText('总数', cx, cy + 12)

        // 图例（右侧）
        const legendX = w * 0.7
        const legendStartY = cy - (slices.length * 22) / 2
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        for (let i = 0; i < slices.length; i++) {
            const slice = slices[i]
            if (!slice) continue
            const y = legendStartY + i * 22
            const colorCfg = BLOOM_COLORS[i % BLOOM_COLORS.length]
            if (!colorCfg) continue
            const colorStr = readCSSColor(colorCfg.varName)

            // 色块
            ctx.beginPath()
            ctx.roundRect(legendX, y - 6, 12, 12, 3)
            ctx.fillStyle = rgba(colorStr, colorCfg.alpha)
            ctx.fill()

            // 文字
            ctx.font = `500 12px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextPrimary, 1)
            ctx.fillText(slice.level, legendX + 18, y)
            ctx.font = `500 11px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.fillText(`${slice.percentage.toFixed(1)}% (${slice.count})`, legendX + 18, y + 12)
        }
    }, [])

    const { canvasRef, containerRef, setHoverIndex } = useChartCanvas(draw, [data])

    const handleMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top
        const w = rect.width
        const h = rect.height
        const cx = w * 0.38
        const cy = h / 2
        const dx = x - cx
        const dy = y - cy
        const dist = Math.sqrt(dx * dx + dy * dy)
        const maxR = Math.max(20, Math.min(cx, cy) - 16)
        const innerR = maxR * 0.55
        if (dist < innerR || dist > maxR + 8) {
            setHoverIndex(-1)
            return
        }
        // 计算角度（从正上方顺时针）
        let angle = Math.atan2(dy, dx) + Math.PI / 2
        if (angle < 0) angle += Math.PI * 2
        const slices = dataRef.current
        const total = slices.reduce((sum, s) => sum + s.count, 0)
        if (total === 0) return
        let acc = 0
        for (let i = 0; i < slices.length; i++) {
            const slice = slices[i]
            if (!slice) continue
            const sliceAngle = (slice.count / total) * Math.PI * 2
            if (angle >= acc && angle < acc + sliceAngle) {
                setHoverIndex(i)
                return
            }
            acc += sliceAngle
        }
        setHoverIndex(-1)
    }, [canvasRef, setHoverIndex])

    const handleLeave = useCallback(() => setHoverIndex(-1), [setHoverIndex])

    return (
        <Card className="pr-rpt-chart-card" padding="md">
            <div className="pr-rpt-chart-head">
                <h3 className="pr-rpt-chart-title">Bloom 分类分布</h3>
                <p className="pr-rpt-chart-subtitle">六阶认知层级题目/活动占比</p>
            </div>
            <div className="pr-rpt-chart-canvas-wrapper" ref={containerRef}>
                <canvas
                    ref={canvasRef}
                    className="pr-rpt-chart-canvas"
                    aria-label="Bloom 分类分布饼图"
                    onMouseMove={handleMove}
                    onMouseLeave={handleLeave}
                />
            </div>
        </Card>
    )
})

// ─────────────────────────────────────────────────────────────
// v5.0 新增图表 8：周次对比多系列折线图
// 对接 GET /api/report/:id/charts.weeklyComparison
// ─────────────────────────────────────────────────────────────

interface WeeklyComparisonChartProps {
    data: WeeklyComparisonSeries[]
}

/** 多系列配色（暖调 qualitative 色板） */
const SERIES_COLORS = ['--c-accent-primary', '--c-accent-info', '--c-accent-success', '--c-accent-warning']

export const WeeklyComparisonChart = memo(function WeeklyComparisonChart({ data }: WeeklyComparisonChartProps) {
    const dataRef = useRef<WeeklyComparisonSeries[]>(data)
    useEffect(() => { dataRef.current = data }, [data])

    const draw = useCallback((
        ctx: CanvasRenderingContext2D,
        w: number,
        h: number,
        progress: number,
        hover: number,
    ) => {
        const cBorder = readCSSColor('--c-text-tertiary')
        const cTextPrimary = readCSSColor('--c-text-primary')
        const cTextSecondary = readCSSColor('--c-text-secondary')
        const cTextInverse = readCSSColor('--c-text-inverse')

        const padding = { top: 24, right: 24, bottom: 40, left: 44 }
        const chartW = Math.max(10, w - padding.left - padding.right)
        const chartH = Math.max(10, h - padding.top - padding.bottom)

        const series = dataRef.current
        if (series.length === 0) {
            ctx.font = `400 13px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText('暂无周次对比数据', w / 2, h / 2)
            return
        }

        // 计算所有点的最大值和周次数
        const allValues: number[] = []
        let maxWeeks = 0
        for (const s of series) {
            maxWeeks = Math.max(maxWeeks, s.points.length)
            for (const p of s.points) allValues.push(p.value)
        }
        const maxValue = Math.max(...allValues, 1)
        const stepX = chartW / Math.max(1, maxWeeks - 1)

        // Y 轴网格 + 标签
        ctx.font = `500 11px var(--font-sans, sans-serif)`
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        ctx.strokeStyle = rgba(cBorder, 0.12)
        ctx.lineWidth = 1
        const ySteps = 4
        for (let i = 0; i <= ySteps; i++) {
            const y = padding.top + chartH - (chartH * i) / ySteps
            const val = Math.round((maxValue * i) / ySteps)
            ctx.beginPath()
            ctx.moveTo(padding.left, y)
            ctx.lineTo(padding.left + chartW, y)
            ctx.stroke()
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.fillText(`${val}`, padding.left - 8, y)
        }

        // X 轴标签（取第一个系列的 week 标签）
        const firstSeries = series[0]
        if (firstSeries) {
            ctx.textAlign = 'center'
            ctx.textBaseline = 'top'
            const labelStep = Math.ceil(firstSeries.points.length / 8)
            for (let i = 0; i < firstSeries.points.length; i += labelStep) {
                const pt = firstSeries.points[i]
                if (!pt) continue
                const x = padding.left + i * stepX
                ctx.fillStyle = rgba(cTextSecondary, 1)
                ctx.fillText(pt.week, x, padding.top + chartH + 8)
            }
        }

        // 绘制每个系列
        for (let sIdx = 0; sIdx < series.length; sIdx++) {
            const s = series[sIdx]
            if (!s) continue
            const colorVar = SERIES_COLORS[sIdx % SERIES_COLORS.length] ?? '--c-accent-primary'
            const colorStr = readCSSColor(colorVar)

            const linePoints = s.points.map((p, i) => ({
                x: padding.left + i * stepX,
                y: padding.top + chartH - (chartH * p.value) / maxValue * progress,
                value: p.value,
                week: p.week,
            }))

            // 折线
            ctx.beginPath()
            linePoints.forEach((p, i) => {
                if (i === 0) ctx.moveTo(p.x, p.y)
                else ctx.lineTo(p.x, p.y)
            })
            ctx.strokeStyle = rgba(colorStr, 1)
            ctx.lineWidth = 2
            ctx.stroke()

            // 数据点
            for (let i = 0; i < linePoints.length; i++) {
                const p = linePoints[i]
                if (!p) continue
                const isHover = i === hover
                ctx.beginPath()
                ctx.arc(p.x, p.y, isHover ? 5 : 3, 0, Math.PI * 2)
                ctx.fillStyle = rgba(colorStr, 1)
                ctx.fill()
                ctx.strokeStyle = rgba(cTextInverse, 1)
                ctx.lineWidth = 1.5
                ctx.stroke()
            }
        }

        // 图例（顶部右侧）
        const legendY = padding.top - 12
        let legendX = w - padding.right
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        for (let i = series.length - 1; i >= 0; i--) {
            const s = series[i]
            if (!s) continue
            const colorVar = SERIES_COLORS[i % SERIES_COLORS.length] ?? '--c-accent-primary'
            const colorStr = readCSSColor(colorVar)
            const text = s.name
            ctx.font = `500 11px var(--font-sans, sans-serif)`
            const tw = ctx.measureText(text).width + 24
            // 色块
            ctx.beginPath()
            ctx.roundRect(legendX - tw, legendY - 5, 12, 10, 2)
            ctx.fillStyle = rgba(colorStr, 1)
            ctx.fill()
            // 文字
            ctx.fillStyle = rgba(cTextPrimary, 1)
            ctx.fillText(text, legendX - 12, legendY)
            legendX -= tw + 8
        }

        // hover tooltip（显示所有系列在该周的值）
        if (hover >= 0 && progress >= 0.95) {
            const firstS = series[0]
            if (firstS && hover < firstS.points.length) {
                const weekLabel = firstS.points[hover]?.week ?? ''
                const lines: Array<{ name: string; value: number; color: string }> = []
                for (let i = 0; i < series.length; i++) {
                    const s = series[i]
                    if (!s) continue
                    const pt = s.points[hover]
                    if (!pt) continue
                    const colorVar = SERIES_COLORS[i % SERIES_COLORS.length] ?? '--c-accent-primary'
                    lines.push({ name: s.name, value: pt.value, color: readCSSColor(colorVar) })
                }
                ctx.font = `600 12px var(--font-sans, sans-serif)`
                const maxLineWidth = Math.max(
                    ctx.measureText(weekLabel).width,
                    ...lines.map((l) => ctx.measureText(`${l.name}: ${l.value}`).width),
                )
                const tw = maxLineWidth + 24
                const th = 20 + lines.length * 18
                const tx = Math.min(w - tw - 4, Math.max(4, padding.left + hover * stepX - tw / 2))
                const ty = Math.max(4, padding.top - th - 4)
                ctx.fillStyle = rgba(readCSSColor('--c-surface-elevated'), 0.92)
                ctx.beginPath()
                ctx.roundRect(tx, ty, tw, th, 6)
                ctx.fill()
                ctx.strokeStyle = rgba(cBorder, 0.2)
                ctx.stroke()
                ctx.fillStyle = rgba(cTextPrimary, 1)
                ctx.textAlign = 'left'
                ctx.textBaseline = 'middle'
                ctx.fillText(weekLabel, tx + 12, ty + 12)
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i]
                    if (!line) continue
                    const ly = ty + 28 + i * 18
                    ctx.beginPath()
                    ctx.roundRect(tx + 12, ly - 4, 8, 8, 2)
                    ctx.fillStyle = rgba(line.color, 1)
                    ctx.fill()
                    ctx.fillStyle = rgba(cTextPrimary, 1)
                    ctx.fillText(`${line.name}: ${line.value}`, tx + 26, ly)
                }
            }
        }
    }, [])

    const { canvasRef, containerRef, setHoverIndex } = useChartCanvas(draw, [data])

    const handleMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const padding = { left: 44, right: 24 }
        const chartW = rect.width - padding.left - padding.right
        const series = dataRef.current
        if (series.length === 0) return
        const firstS = series[0]
        if (!firstS || firstS.points.length === 0) return
        const stepX = chartW / Math.max(1, firstS.points.length - 1)
        const idx = Math.round((x - padding.left) / stepX)
        setHoverIndex(Math.max(0, Math.min(firstS.points.length - 1, idx)))
    }, [canvasRef, setHoverIndex])

    const handleLeave = useCallback(() => setHoverIndex(-1), [setHoverIndex])

    return (
        <Card className="pr-rpt-chart-card" padding="md">
            <div className="pr-rpt-chart-head">
                <h3 className="pr-rpt-chart-title">周次对比</h3>
                <p className="pr-rpt-chart-subtitle">多系列周度数据对比趋势</p>
            </div>
            <div className="pr-rpt-chart-canvas-wrapper" ref={containerRef}>
                <canvas
                    ref={canvasRef}
                    className="pr-rpt-chart-canvas"
                    aria-label="周次对比多系列折线图"
                    onMouseMove={handleMove}
                    onMouseLeave={handleLeave}
                />
            </div>
        </Card>
    )
})

// ─────────────────────────────────────────────────────────────
// v5.0 数据驱动容器：ReportChartsContainer
// 通过 reportId 拉取 /api/report/:id/charts，渲染 4 张新图表
// 加载/错误/空数据态完整覆盖
// ─────────────────────────────────────────────────────────────

interface ReportChartsContainerProps {
    /** 报告 ID（必填，未提供时不发请求） */
    reportId: string | null
}

/**
 * 报告图表容器（v5.0）
 *
 * 通过 TanStack Query 拉取 GET /api/report/:id/charts，
 * 渲染 4 张新图表（成绩分布/知识点掌握度/Bloom 分布/周次对比）。
 *
 * 加载态：骨架屏（4 张卡片占位）
 * 错误态：错误提示 + 重试按钮
 * 空数据态：暂无数据提示
 */
export const ReportChartsContainer = memo(function ReportChartsContainer({ reportId }: ReportChartsContainerProps) {
    const { data, isLoading, isError, error, refetch } = useQuery({
        queryKey: ['report', 'charts', reportId],
        queryFn: () => api.report.charts(reportId as string),
        enabled: !!reportId,
        staleTime: 5 * 60 * 1000,
    })

    if (!reportId) {
        return null
    }

    if (isLoading) {
        return (
            <div className="pr-rpt-preview-charts">
                {[0, 1, 2, 3].map((i) => (
                    <Card key={i} className="pr-rpt-chart-card" padding="md">
                        <div className="pr-rpt-chart-head">
                            <Skeleton width="40%" height={16} />
                            <Skeleton width="60%" height={11} />
                        </div>
                        <div className="pr-rpt-chart-skeleton-canvas">
                            <Skeleton width="80%" height={180} radius={8} />
                        </div>
                    </Card>
                ))}
            </div>
        )
    }

    if (isError) {
        return (
            <Card className="pr-rpt-chart-card pr-rpt-chart-card--error" padding="md">
                <div className="pr-rpt-chart-error">
                    <Icon name="x-circle" size={24} />
                    <p className="pr-rpt-chart-error-title">
                        图表数据加载失败
                    </p>
                    <p className="pr-rpt-chart-error-detail">
                        {getDisplayError(error, '未知错误')}
                    </p>
                    <button
                        type="button"
                        className="pr-rpt-chart-retry"
                        onClick={() => void refetch()}
                    >
                        重试
                    </button>
                </div>
            </Card>
        )
    }

    if (!data) return null

    const hasAnyData =
        data.scoreDistribution.length > 0 ||
        data.knowledgeMastery.length > 0 ||
        data.bloomDistribution.length > 0 ||
        data.weeklyComparison.length > 0

    if (!hasAnyData) {
        return (
            <Card className="pr-rpt-chart-card pr-rpt-chart-card--empty" padding="md">
                <div className="pr-rpt-chart-empty">
                    <Icon name="chart-bar" size={28} />
                    <p className="pr-rpt-chart-empty-title">
                        暂无图表数据
                    </p>
                    <p className="pr-rpt-chart-empty-desc">
                        该报告尚未生成图表数据
                    </p>
                </div>
            </Card>
        )
    }

    return (
        <div className="pr-rpt-preview-charts">
            {data.scoreDistribution.length > 0 && (
                <ScoreDistributionChart data={data.scoreDistribution} />
            )}
            {data.knowledgeMastery.length > 0 && (
                <KnowledgeMasteryChart data={data.knowledgeMastery} />
            )}
            {data.bloomDistribution.length > 0 && (
                <BloomDistributionChart data={data.bloomDistribution} />
            )}
            {data.weeklyComparison.length > 0 && (
                <WeeklyComparisonChart data={data.weeklyComparison} />
            )}
        </div>
    )
})
