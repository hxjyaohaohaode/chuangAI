/**
 * 六阶能力分布柱状图（Task 17）
 *
 * 基于 Canvas 2D API 绘制布鲁姆六阶认知能力分布柱状图：
 * 记忆 / 理解 / 应用 / 分析 / 评价 / 创造
 *
 * 每个柱子展示：
 * - 柱高 = 该阶层平均掌握度（0-100）
 * - 误差线 = ±标准差（反映班级离散程度）
 * - 顶部数字标签 = 均值
 * - 底部轴标签 = 阶层名称 + 学生数
 *
 * 颜色梯度（红→黄→绿）：
 * - avg < 60 → accent-error（赤陶）
 * - 60 ≤ avg < 80 → accent-warning（琥珀）
 * - avg ≥ 80 → accent-success（苔绿）
 *
 * 设计要点（规范第 6、10、15 章）：
 * - 高 DPI：devicePixelRatio 缩放
 * - 600ms 入场动画：柱子从底部生长（ease-out）
 * - hover tooltip：鼠标悬停显示详细信息
 * - ResizeObserver debounce 100ms
 * - 零硬编码色值：所有颜色从 CSS 变量读取
 * - 仅 transform/opacity 动画属性（柱子用 scale 模拟生长）
 */

import { useEffect, useRef, memo, useCallback } from 'react'
import { BLOOM_ORDER } from '@/lib/types'
import type { BloomDistributionLevel } from '@/lib/types'
import { escapeHtml } from '@/lib/html-escape'
import { readCSSColor, rgba, easeOut } from '@/lib/chartPalette'
import { observeElementResize } from '@/lib/resize-observer'
import { matchesMediaQuery } from '@/lib/media-query'

interface BloomDistributionChartProps {
    levels: BloomDistributionLevel[]
    loading?: boolean
    /** 错误信息（可选，父组件透传或子组件通过 useBloomDistributionQuery 获取） */
    error?: Error | null
    /** 重试回调（错误态下显示） */
    onRetry?: () => void
}

/** 动画时长（ms） */
const ANIMATION_MS = 600

/** 根据均值选择颜色 token 名 */
function colorVarForAvg(avg: number): string {
    if (avg < 60) return '--c-accent-error'
    if (avg < 80) return '--c-accent-warning'
    return '--c-accent-success'
}

interface HoverInfo {
    level: BloomDistributionLevel
    x: number
    y: number
}

export const BloomDistributionChart = memo(function BloomDistributionChart({
    levels,
    loading = false,
    error = null,
    onRetry,
}: BloomDistributionChartProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const containerRef = useRef<HTMLDivElement | null>(null)
    const animationRef = useRef<number | null>(null)
    const levelsRef = useRef<BloomDistributionLevel[]>(levels)
    const hoverRef = useRef<HoverInfo | null>(null)
    const tooltipRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        levelsRef.current = levels
        startAnimation()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [levels])

    const draw = useCallback((progress: number) => {
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

        // 读取颜色
        const cTextSecondary = readCSSColor('--c-text-secondary')
        const cTextPrimary = readCSSColor('--c-text-primary')
        const cTextTertiary = readCSSColor('--c-text-tertiary')

        // 几何参数
        const paddingTop = 40
        const paddingBottom = 56
        const paddingLeft = 48
        const paddingRight = 24
        const chartWidth = displayWidth - paddingLeft - paddingRight
        const chartHeight = displayHeight - paddingTop - paddingBottom
        const maxBars = BLOOM_ORDER.length
        const barGap = chartWidth / (maxBars * 4)
        const barWidth = (chartWidth - barGap * (maxBars - 1)) / maxBars

        // ── 1. 绘制 Y 轴网格线与刻度 ──
        ctx.lineWidth = 1
        ctx.font = `500 ${Math.max(10, displayWidth * 0.025)}px var(--font-sans, sans-serif)`
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        const yTicks = [0, 20, 40, 60, 80, 100]
        for (const tick of yTicks) {
            const y = paddingTop + chartHeight - (tick / 100) * chartHeight
            ctx.beginPath()
            ctx.moveTo(paddingLeft, y)
            ctx.lineTo(displayWidth - paddingRight, y)
            ctx.strokeStyle = rgba(cTextTertiary, 0.12)
            ctx.stroke()
            ctx.fillStyle = rgba(cTextSecondary, 0.8)
            ctx.fillText(String(tick), paddingLeft - 8, y)
        }

        // ── 2. 绘制柱子 ──
        const data = levelsRef.current
        const barPositions: Array<{ x: number; y: number; w: number; h: number; level: BloomDistributionLevel }> = []

        for (let i = 0; i < data.length; i++) {
            const item = data[i]!
            if (!item) continue
            const barX = paddingLeft + i * (barWidth + barGap)
            const fullHeight = (Math.min(100, Math.max(0, item.avg)) / 100) * chartHeight
            const animatedHeight = fullHeight * progress
            const barY = paddingTop + chartHeight - animatedHeight

            // 颜色根据均值选择
            const colorVar = colorVarForAvg(item.avg)
            const barColor = readCSSColor(colorVar)

            // 柱体填充（带圆角顶部）
            const radius = Math.min(6, barWidth / 4, animatedHeight / 2)
            ctx.beginPath()
            ctx.moveTo(barX, paddingTop + chartHeight)
            ctx.lineTo(barX, barY + radius)
            ctx.quadraticCurveTo(barX, barY, barX + radius, barY)
            ctx.lineTo(barX + barWidth - radius, barY)
            ctx.quadraticCurveTo(barX + barWidth, barY, barX + barWidth, barY + radius)
            ctx.lineTo(barX + barWidth, paddingTop + chartHeight)
            ctx.closePath()
            ctx.fillStyle = rgba(barColor, 0.85)
            ctx.fill()

            // 误差线（标准差）
            if (item.stdDev > 0 && progress >= 0.8) {
                const stdHeight = (Math.min(50, item.stdDev) / 100) * chartHeight
                const centerX = barX + barWidth / 2
                const topY = Math.max(paddingTop, barY - stdHeight)
                const bottomY = Math.min(paddingTop + chartHeight, barY + stdHeight)
                const capWidth = Math.min(barWidth / 3, 8)

                ctx.strokeStyle = rgba(barColor, 1)
                ctx.lineWidth = 1.5
                ctx.beginPath()
                ctx.moveTo(centerX, topY)
                ctx.lineTo(centerX, bottomY)
                // 顶部 cap
                ctx.moveTo(centerX - capWidth / 2, topY)
                ctx.lineTo(centerX + capWidth / 2, topY)
                // 底部 cap
                ctx.moveTo(centerX - capWidth / 2, bottomY)
                ctx.lineTo(centerX + capWidth / 2, bottomY)
                ctx.stroke()
            }

            barPositions.push({ x: barX, y: barY, w: barWidth, h: animatedHeight, level: item })

            // 数字标签（均值）
            if (progress >= 0.9) {
                ctx.font = `600 ${Math.max(11, displayWidth * 0.028)}px var(--font-sans, sans-serif)`
                ctx.fillStyle = rgba(cTextPrimary, 1)
                ctx.textAlign = 'center'
                ctx.textBaseline = 'bottom'
                ctx.fillText(Math.round(item.avg).toString(), barX + barWidth / 2, barY - 6)
            }

            // X 轴标签（阶层名称 + 学生数）
            ctx.font = `500 ${Math.max(10, displayWidth * 0.025)}px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.textAlign = 'center'
            ctx.textBaseline = 'top'
            ctx.fillText(item.level, barX + barWidth / 2, paddingTop + chartHeight + 8)

            ctx.font = `400 ${Math.max(9, displayWidth * 0.022)}px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextTertiary, 1)
            ctx.fillText(`${item.studentCount}人`, barX + barWidth / 2, paddingTop + chartHeight + 26)
        }

        // ── 3. 绘制 hover 高亮 ──
        const hover = hoverRef.current
        if (hover && progress >= 1) {
            const idx = data.findIndex((d) => d.level === hover.level.level)
            if (idx >= 0) {
                const pos = barPositions[idx]
                if (pos) {
                    ctx.strokeStyle = rgba(cTextPrimary, 0.4)
                    ctx.lineWidth = 2
                    ctx.strokeRect(pos.x - 2, paddingTop, pos.w + 4, chartHeight)
                }
            }
        }
    }, [])

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

    // 鼠标交互
    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        const container = containerRef.current
        const tooltip = tooltipRef.current
        if (!canvas || !container || !tooltip) return

        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top

        const displayWidth = rect.width
        const displayHeight = rect.height
        const paddingTop = 40
        const paddingBottom = 56
        const paddingLeft = 48
        const paddingRight = 24
        const chartWidth = displayWidth - paddingLeft - paddingRight
        const chartHeight = displayHeight - paddingTop - paddingBottom
        const maxBars = BLOOM_ORDER.length
        const barGap = chartWidth / (maxBars * 4)
        const barWidth = (chartWidth - barGap * (maxBars - 1)) / maxBars

        let found: HoverInfo | null = null
        const data = levelsRef.current
        for (let i = 0; i < data.length; i++) {
            const item = data[i]!
            if (!item) continue
            const barX = paddingLeft + i * (barWidth + barGap)
            if (x >= barX && x <= barX + barWidth && y >= paddingTop && y <= paddingTop + chartHeight) {
                found = { level: item, x: e.clientX - rect.left, y: e.clientY - rect.top }
                break
            }
        }

        hoverRef.current = found
        if (found) {
            tooltip.style.display = 'block'
            tooltip.style.left = `${found.x + 12}px`
            tooltip.style.top = `${found.y - 12}px`
            tooltip.innerHTML = `
                <div class="pr-diag-tooltip-title">${escapeHtml(found.level.level)}</div>
                <div class="pr-diag-tooltip-row"><span>均值</span><span>${Math.round(found.level.avg)}</span></div>
                <div class="pr-diag-tooltip-row"><span>标准差</span><span>${found.level.stdDev.toFixed(1)}</span></div>
                <div class="pr-diag-tooltip-row"><span>学生数</span><span>${found.level.studentCount}</span></div>
            `
            draw(1)
        } else {
            tooltip.style.display = 'none'
            draw(1)
        }
    }, [draw])

    const handleMouseLeave = useCallback(() => {
        hoverRef.current = null
        if (tooltipRef.current) {
            tooltipRef.current.style.display = 'none'
        }
        draw(1)
    }, [draw])

    // ResizeObserver
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
        <div className="pr-diag-chart-card">
            <div className="pr-diag-chart-header">
                <h3 className="pr-diag-chart-title">六阶能力分布</h3>
                <p className="pr-diag-chart-subtitle">布鲁姆认知分类 · 均值 ± 标准差</p>
            </div>

            <div className="pr-diag-canvas-wrapper" ref={containerRef}>
                {error ? (
                    <div className="pr-diag-chart-error" role="alert">
                        <div className="pr-diag-chart-error-icon" aria-hidden>
                            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10" />
                                <line x1="12" y1="8" x2="12" y2="12" />
                                <line x1="12" y1="16" x2="12.01" y2="16" />
                            </svg>
                        </div>
                        <p className="pr-diag-chart-error-title">六阶能力数据加载失败</p>
                        <p className="pr-diag-chart-error-msg">{error.message || '网络异常，请稍后重试'}</p>
                        {onRetry && (
                            <button
                                type="button"
                                className="pr-diag-chart-error-retry"
                                onClick={onRetry}
                            >
                                重试
                            </button>
                        )}
                    </div>
                ) : loading ? (
                    <div
                        className="pr-skeleton"
                        style={{ width: '100%', height: '100%', borderRadius: 'var(--radius-lg)' }}
                    />
                ) : levels.length === 0 ? (
                    <div className="pr-diag-empty">
                        <p className="pr-diag-empty-text">暂无六阶能力数据</p>
                        <p className="pr-diag-empty-hint">请先选择班级并确保已有学生作答记录</p>
                    </div>
                ) : (
                    <>
                        <canvas
                            ref={canvasRef}
                            className="pr-diag-canvas"
                            aria-label="六阶能力分布柱状图"
                            onMouseMove={handleMouseMove}
                            onMouseLeave={handleMouseLeave}
                        />
                        <div ref={tooltipRef} className="pr-diag-tooltip" style={{ display: 'none' }} />
                    </>
                )}
            </div>

            <div className="pr-diag-chart-legend">
                <span className="pr-diag-legend-item">
                    <span className="pr-diag-legend-swatch pr-diag-legend-swatch--error" />
                    低于60
                </span>
                <span className="pr-diag-legend-item">
                    <span className="pr-diag-legend-swatch pr-diag-legend-swatch--warning" />
                    60-80
                </span>
                <span className="pr-diag-legend-item">
                    <span className="pr-diag-legend-swatch pr-diag-legend-swatch--success" />
                    80以上
                </span>
            </div>
        </div>
    )
})
