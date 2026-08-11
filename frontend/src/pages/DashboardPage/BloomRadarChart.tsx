/**
 * 六阶能力雷达图（v5.0 Dashboard 数据真实化）
 *
 * 对接 GET /api/dashboard/bloom-radar，TanStack Query 直接消费：
 * - staleTime: 30s
 * - retry: 1
 * - 数据联动：classId 变化触发 refetch
 *
 * 数据形状：6 维度（记忆/理解/应用/分析/评价/创造）真实平均值 + 对比基线
 *
 * 设计要点（规范第 6、10、15 章）：
 * - 高 DPI：devicePixelRatio 缩放，Retina 屏清晰无模糊
 * - 60fps：requestAnimationFrame 驱动，仅 transform/opacity 动画属性
 * - 600ms 入场动画：数据多边形从中心展开（ease-out 缓动）+ 描边绘制
 * - 5 层网格：20% / 40% / 60% / 80% / 100% 同心六边形
 * - 班级数据：accent-primary 填充 20% + 描边 100%
 * - 对比数据：accent-info 虚线
 * - 零硬编码色值：所有颜色从 chartPalette 派生
 * - ResizeObserver：容器尺寸变化时 200ms 内重绘
 * - prefers-reduced-motion：降级为 0 时长
 * - 悬浮 tooltip：surface-elevated 玻璃态面板 + backdrop-blur 20px（规范 10.3 / 14.5）
 * - Tabular Numbers：数值标签等宽对齐（规范 10.6）
 *
 * 性能优化：
 * - 使用 ref 持有 canvas、animation frame、resize observer
 * - 数据变化时仅重启动画，不重建 observer
 * - 颜色解析缓存（仅在主题变化时重新读取）
 */

import { useEffect, useRef, memo, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Card, Icon, Button } from '@/components/ui'
import { api } from '@/lib/api'
import { readCSSColor, rgba, easeOut } from '@/lib/chartPalette'
import { observeElementResize } from '@/lib/resize-observer'
import { matchesMediaQuery } from '@/lib/media-query'
    import { toast } from '@/stores/toast'
import type { BloomRadarDataV2, BloomRadarDimension } from '@/lib/types'

interface BloomRadarChartProps {
    /** 班级 ID（可选，用于数据联动） */
    classId?: string
}

/** 动画时长（ms） */
const ANIMATION_MS = 600

/** 六维度的标准顺序（与后端 BLOOM_ORDER 对齐） */
const DEFAULT_DIMENSIONS = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

/** 查询 staleTime：30 秒 */
const RADAR_STALE_TIME = 30_000

/** tooltip 状态 */
interface RadarTooltip {
    visible: boolean
    x: number
    y: number
    level: string
    classValue: number
    comparisonValue?: number
}

export const BloomRadarChart = memo(function BloomRadarChart({
    classId,
}: BloomRadarChartProps) {
    const navigate = useNavigate()
    const query = useQuery<BloomRadarDataV2>({
        queryKey: ['dashboard-v2', 'bloom-radar', classId ?? 'global'],
        queryFn: () => api.dashboardV2.bloomRadar(classId),
        staleTime: RADAR_STALE_TIME,
        retry: 1,
        // classId 就绪前不发请求：
        // bloom-radar / alerts / weekly-progress 三个端点强制要求 classId，
        // 未就绪就发会先收 3 个 400，随后再用真实 classId 重发一轮，
        // 既产生无效错误噪音，也让面板内容闪烁一次。
        enabled: Boolean(classId),
    })

    /** "针对性命题"按钮：跳转到命题工坊，针对最薄弱层级 */
    const handleTargetedPractice = useCallback(() => {
        const data = query.data
        if (!data || !data.levels || data.levels.length === 0) {
            toast.info({ title: '数据加载中', message: '请等待雷达图加载完成后重试' })
            return
        }
        let weakest: BloomRadarDimension | null = null
        for (const d of data.levels) {
            if (!weakest || d.value < weakest.value) weakest = d
        }
        if (!weakest) {
            toast.info({ title: '暂无数据', message: '雷达图数据不完整，无法判断薄弱层级' })
            return
        }
        const params = new URLSearchParams()
        params.set('tier', weakest.name)
        if (classId) params.set('classId', classId)
        toast.info({
            title: '针对性命题',
            message: `将针对「${weakest.name}」层级（掌握度 ${Math.round(weakest.value)}%）自动调整命题权重`,
        })
        navigate(`/workbench?${params.toString()}`)
    }, [query.data, classId, navigate])

    // classId 未就绪时 useQuery 处于 disabled 状态（isLoading 为 false），
    // 用 isPending 统一覆盖「等待班级选定」与「正在请求」两种情况，
    // 使面板在这两种状态下都显示骨架屏，而不是错误地落到空状态分支。
    const loading = query.isPending
    const data = query.data
    const hasEvidence = Boolean(data && data.levels && data.levels.length > 0)

    return (
        <Card className="pr-radar-card">
            <div className="pr-radar-header">
                <div>
                    <h2 className="pr-radar-title">六阶能力雷达</h2>
                    <p className="pr-radar-subtitle">布鲁姆认知分类 · 班级均值</p>
                </div>
                {hasEvidence && (
                    <button
                        type="button"
                        className="pr-radar-targeted-btn"
                        onClick={handleTargetedPractice}
                        aria-label="针对薄弱层级去命题"
                        title="根据班级最薄弱的认知层级，跳转命题工坊自动调整权重"
                    >
                        针对性命题
                    </button>
                )}
            </div>

            <RadarCanvas
                data={data ?? null}
                loading={loading}
            />

            {/* 错误态 */}
            {query.isError && (
                <div className="pr-radar-empty pr-radar-empty--error" role="alert">
                    <Icon name="warning-circle" size={24} weight="bold" />
                    <strong>雷达图加载失败</strong>
                    <span>{query.error instanceof Error ? query.error.message : '请稍后重试'}</span>
                    <Button
                        variant="secondary"
                        size="sm"
                        leftIcon={<Icon name="arrows-clockwise" size={12} />}
                        onClick={() => void query.refetch()}
                    >
                        重试
                    </Button>
                </div>
            )}

            <RadarLegend data={data ?? null} />
        </Card>
    )
})

/** Canvas 雷达图主体 */
function RadarCanvas({
    data,
    loading,
}: {
    data: BloomRadarDataV2 | null
    loading: boolean
}) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const containerRef = useRef<HTMLDivElement | null>(null)
    const animationRef = useRef<number | null>(null)
    const dataRef = useRef<BloomRadarDataV2 | null>(data)
    /** 数据点屏幕坐标缓存（用于 tooltip 命中检测） */
    const pointsRef = useRef<Array<{ x: number; y: number; value: number; level: string; comparison?: number }>>([])

    const [tooltip, setTooltip] = useState<RadarTooltip>({ visible: false, x: 0, y: 0, level: '', classValue: 0 })

    /** 维度轴序（使用数据中的维度名，缺失时回退到 DEFAULT_DIMENSIONS） */
    const dimensions = (data?.levels?.map((d) => d.name) ?? Array.from(DEFAULT_DIMENSIONS)).slice(0, 6)

    /** 六阶轴角度（弧度），从正上方开始顺时针 */
    const axisAngles = dimensions.map((_, i) => -Math.PI / 2 + (i * Math.PI * 2) / dimensions.length)

    // 同步最新 data 到 ref（动画循环读取 ref，避免重启）
    useEffect(() => {
        dataRef.current = data
        startAnimation()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data])

    /** 启动入场动画 */
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

    /** 主绘制函数 */
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

        // 读取颜色 —— 全部通过共享色板派生（规范 10.2 / 10.6）
        const cBorderRow = readCSSColor('--c-text-tertiary')
        const cBorderPrimary = readCSSColor('--c-text-secondary')
        const cAccent = readCSSColor('--c-accent-primary')
        const cAccentInfo = readCSSColor('--c-accent-info')
        const cTextPrimary = readCSSColor('--c-text-primary')
        const cTextSecondary = readCSSColor('--c-text-secondary')
        const cTextInverse = readCSSColor('--c-text-inverse')

        // 几何参数
        const cx = displayWidth / 2
        const cy = displayHeight / 2
        const padding = Math.max(40, displayWidth * 0.18)
        const maxRadius = Math.max(10, Math.min(cx, cy) - padding)
        const gridLevels = [0.2, 0.4, 0.6, 0.8, 1.0]

        // ── 1. 绘制网格六边形（极淡 alpha，无 chartjunk）──
        ctx.lineWidth = 1
        for (const level of gridLevels) {
            const r = maxRadius * level
            ctx.beginPath()
            for (let i = 0; i < dimensions.length; i++) {
                const angle = axisAngles[i]
                if (typeof angle !== 'number') continue
                const x = cx + r * Math.cos(angle)
                const y = cy + r * Math.sin(angle)
                if (i === 0) ctx.moveTo(x, y)
                else ctx.lineTo(x, y)
            }
            ctx.closePath()
            ctx.strokeStyle = rgba(cBorderRow, 0.15)
            ctx.stroke()
        }

        // ── 2. 绘制轴线（极淡 alpha 替代实色 border）──
        ctx.lineWidth = 1
        ctx.strokeStyle = rgba(cBorderPrimary, 0.15)
        for (let i = 0; i < dimensions.length; i++) {
            const angle = axisAngles[i]
            if (typeof angle !== 'number') continue
            const x = cx + maxRadius * Math.cos(angle)
            const y = cy + maxRadius * Math.sin(angle)
            ctx.beginPath()
            ctx.moveTo(cx, cy)
            ctx.lineTo(x, y)
            ctx.stroke()
        }

        // ── 3. 绘制轴标签 ──
        ctx.font = `500 ${Math.max(11, displayWidth * 0.035)}px var(--font-sans, sans-serif)`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = rgba(cTextSecondary, 1)
        const labelOffset = maxRadius + 18
        for (let i = 0; i < dimensions.length; i++) {
            const angle = axisAngles[i]
            const level = dimensions[i]
            if (typeof angle !== 'number' || !level) continue
            const x = cx + labelOffset * Math.cos(angle)
            const y = cy + labelOffset * Math.sin(angle)
            ctx.fillText(level, x, y)
        }

        // ── 4. 绘制数据多边形 ──
        const current = dataRef.current
        pointsRef.current = []
        if (current && current.levels && current.levels.length > 0 && progress > 0) {
            // ── 4.1 班级均值多边形 ──
            const points: Array<{ x: number; y: number; value: number }> = []
            for (let i = 0; i < dimensions.length; i++) {
                const angle = axisAngles[i]
                if (typeof angle !== 'number') continue
                const dim = current.levels[i]
                const rawValue = dim ? dim.value : 0
                const normalized = Math.min(100, Math.max(0, rawValue)) / 100
                const r = maxRadius * normalized * progress
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
                ctx.fillStyle = rgba(cAccent, 0.2)
                ctx.fill()

                // 描边
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

                // 数值标签（仅动画完成后显示）—— Tabular Numbers（规范 10.6）
                if (progress >= 0.95) {
                    ctx.font = `600 ${Math.max(10, displayWidth * 0.028)}px var(--font-sans, sans-serif)`
                    ctx.fillStyle = rgba(cTextPrimary, 1)
                    for (let i = 0; i < points.length; i++) {
                        const p = points[i]
                        const angle = axisAngles[i]
                        if (!p || typeof angle !== 'number') continue
                        const offset = 14
                        const x = p.x + offset * Math.cos(angle)
                        const y = p.y + offset * Math.sin(angle)
                        ctx.fillText(Math.round(p.value).toString(), x, y)
                    }
                }

                // 缓存数据点用于 tooltip 命中检测
                if (progress >= 1) {
                    for (let i = 0; i < points.length; i++) {
                        const p = points[i]
                        const level = dimensions[i]
                        if (!p || !level) continue
                        const cmp = current.classAverage?.[i]?.value
                        pointsRef.current.push({
                            x: p.x,
                            y: p.y,
                            value: p.value,
                            level,
                            comparison: typeof cmp === 'number' ? cmp : undefined,
                        })
                    }
                }
            }

            // ── 4.2 对比数据（年级/全校均值，虚线）──
            if (current.classAverage && current.classAverage.length > 0 && progress >= 0.9) {
                ctx.setLineDash([4, 4])
                ctx.lineWidth = 1.5
                ctx.strokeStyle = rgba(cAccentInfo, 0.6)
                ctx.beginPath()
                for (let i = 0; i < dimensions.length; i++) {
                    const angle = axisAngles[i]
                    if (typeof angle !== 'number') continue
                    const dim = current.classAverage[i]
                    const rawValue = dim ? dim.value : 0
                    const normalized = Math.min(100, Math.max(0, rawValue)) / 100
                    const r = maxRadius * normalized
                    const x = cx + r * Math.cos(angle)
                    const y = cy + r * Math.sin(angle)
                    if (i === 0) ctx.moveTo(x, y)
                    else ctx.lineTo(x, y)
                }
                ctx.closePath()
                ctx.stroke()
                ctx.setLineDash([])
            }
        }
    }

    /** canvas 鼠标移动：命中数据点显示 tooltip */
    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const mx = e.clientX - rect.left
        const my = e.clientY - rect.top

        const HIT_RADIUS = 12
        let hit: { x: number; y: number; value: number; level: string; comparison?: number } | null = null
        for (const p of pointsRef.current) {
            const dx = p.x - mx
            const dy = p.y - my
            if (dx * dx + dy * dy <= HIT_RADIUS * HIT_RADIUS) {
                hit = p
                break
            }
        }

        if (hit) {
            setTooltip({
                visible: true,
                x: hit.x,
                y: hit.y,
                level: hit.level,
                classValue: hit.value,
                comparisonValue: hit.comparison,
            })
        } else if (tooltip.visible) {
            setTooltip((prev) => ({ ...prev, visible: false }))
        }
    }, [tooltip.visible])

    const handleMouseLeave = useCallback(() => {
        if (tooltip.visible) {
            setTooltip((prev) => ({ ...prev, visible: false }))
        }
    }, [tooltip.visible])

    // ResizeObserver：容器尺寸变化时重绘
    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        let resizeTimer: number | null = null
        const stopObserving = observeElementResize(container, () => {
            if (resizeTimer !== null) {
                window.clearTimeout(resizeTimer)
            }
            resizeTimer = window.setTimeout(() => {
                draw(1)
                resizeTimer = null
            }, 100)
        })
        return () => {
            stopObserving()
            if (resizeTimer !== null) {
                window.clearTimeout(resizeTimer)
            }
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

    return (
        <div className="pr-radar-canvas-wrapper" ref={containerRef}>
            {loading ? (
                <div
                    className="pr-skeleton"
                    style={{ width: '100%', height: '100%', borderRadius: 'var(--radius-lg)' }}
                />
            ) : (
                <>
                    <canvas
                        ref={canvasRef}
                        className="pr-radar-canvas"
                        aria-label="六阶能力雷达图"
                        onMouseMove={handleMouseMove}
                        onMouseLeave={handleMouseLeave}
                    />
                    {!data?.levels?.length && (
                        <div className="pr-radar-empty" role="status">
                            <strong>尚未形成六阶能力画像</strong>
                            <span>完成课堂作答或批改后，这里将按真实记录自动聚合。</span>
                        </div>
                    )}
                    {/* 悬浮 tooltip：surface-elevated 玻璃态面板 + backdrop-blur 20px */}
                    {tooltip.visible && (
                        <div
                            className="pr-radar-tooltip"
                            style={{
                                left: tooltip.x,
                                top: tooltip.y,
                                transform: 'translate(-50%, calc(-100% - 12px))',
                            }}
                            role="tooltip"
                        >
                            <div className="pr-radar-tooltip-level">{tooltip.level}</div>
                            <div className="pr-radar-tooltip-row">
                                <span className="pr-radar-tooltip-swatch pr-radar-tooltip-swatch--class" />
                                <span className="pr-radar-tooltip-label">本班</span>
                                <span className="pr-radar-tooltip-value">{Math.round(tooltip.classValue)}</span>
                            </div>
                            {tooltip.comparisonValue !== undefined && (
                                <div className="pr-radar-tooltip-row">
                                    <span className="pr-radar-tooltip-swatch pr-radar-tooltip-swatch--comparison" />
                                    <span className="pr-radar-tooltip-label">年级均值</span>
                                    <span className="pr-radar-tooltip-value">{Math.round(tooltip.comparisonValue)}</span>
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    )
}

/** 雷达图图例 */
function RadarLegend({ data }: { data: BloomRadarDataV2 | null }) {
    const hasLevels = Boolean(data?.levels?.length)
    const hasComparison = Boolean(data?.classAverage?.length)
    const sampleSize = data?.levels?.length ?? 0

    return (
        <div className="pr-radar-legend">
            <span className="pr-radar-legend-item">
                <span className="pr-radar-legend-swatch pr-radar-legend-swatch--class" />
                {hasLevels ? `本班均值 · ${sampleSize} 维度` : '等待有效作答'}
            </span>
            {hasComparison && (
                <span className="pr-radar-legend-item">
                    <span className="pr-radar-legend-swatch pr-radar-legend-swatch--comparison" />
                    年级均值
                </span>
            )}
        </div>
    )
}
