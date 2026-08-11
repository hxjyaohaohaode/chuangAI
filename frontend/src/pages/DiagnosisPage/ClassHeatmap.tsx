/**
 * 班级掌握度热力图（Task 17 / Task 3.3 重构）
 *
 * 基于 Canvas 2D API 绘制学生 × 诗 × 六阶掌握度矩阵热力图：
 * - 行 = 学生（脱敏名）
 * - 列 = 诗 × 六阶（每首诗 6 列，对应记忆/理解/应用/分析/评价/创造）
 * - 单元格颜色 = accent-primary 单色 Alpha 渐变（色盲安全，规范 10.2 chart-sequential）
 *
 * 配色（规范 10.2 / 10.6 —— 色盲安全）：
 * - 连续数值用单色 Alpha 渐变（15% → 100%），灰度模式下通过 alpha 差异自然区分
 * - 分数越高 → accent-primary alpha 越浓（0.15 → 1.0）
 * - 无数据 → surface-tertiary 极淡灰
 * - 弃用原离散三色（红/黄/绿），改为单色 sequential，符合规范 10.2 "连续数值用单色 Alpha 渐变"
 *
 * 交互（规范 10.3）：
 * - hover tooltip：玻璃态面板，显示学生/诗/阶层/分数
 * - 点击钻取：onCellClick 回调，传递学生+诗+阶层+分数，供父组件展开详情
 * - 鼠标 cursor: pointer 暗示可点击
 *
 * 设计要点（规范第 6、10、15 章）：
 * - 高 DPI：devicePixelRatio 缩放
 * - 600ms 入场动画：逐行淡入
 * - 水平滚动：列数多时支持滚动浏览
 * - ResizeObserver debounce 100ms
 * - 零硬编码色值：所有颜色从 chartPalette 派生
 * - Inter 字体 + Tabular Numbers（规范 10.6）
 */

import { useEffect, useRef, memo, useCallback } from 'react'
import { BLOOM_ORDER } from '@/lib/types'
import type { HeatmapResponse, BloomLevel } from '@/lib/types'
import { readCSSColor, rgba, easeOut, scoreToSequentialAlpha } from '@/lib/chartPalette'
import { escapeHtml } from '@/lib/html-escape'
import { observeElementResize } from '@/lib/resize-observer'
import { matchesMediaQuery } from '@/lib/media-query'

/** 单元格钻取事件载荷 */
export interface HeatmapCellClickInfo {
    studentId: string
    studentName: string
    poemId: string
    poemTitle: string
    bloomLevel: BloomLevel
    score: number | null
}

interface ClassHeatmapProps {
    data: HeatmapResponse
    loading?: boolean
    /** 错误态：传入则展示错误 UI 与重试按钮（规范第 6 章 · 错误态完整覆盖） */
    error?: Error | null
    /** 错误态重试回调 */
    onRetry?: () => void
    /** 点击单元格钻取回调（规范 10.3：点击钻取） */
    onCellClick?: (info: HeatmapCellClickInfo) => void
}

/** 动画时长（ms） */
const ANIMATION_MS = 600

/** 单元格尺寸常量 */
const CELL_SIZE = 28
const CELL_GAP = 2
const POEM_GAP = 8
const LEFT_COL_WIDTH = 96
const HEADER_HEIGHT = 52
const BLOOM_LABEL_HEIGHT = 16

interface HoverCell {
    studentId: string
    studentName: string
    poemId: string
    poemTitle: string
    bloomLevel: BloomLevel
    score: number | null
    x: number
    y: number
}

export const ClassHeatmap = memo(function ClassHeatmap({
    data,
    loading = false,
    error = null,
    onRetry,
    onCellClick,
}: ClassHeatmapProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const animationRef = useRef<number | null>(null)
    const dataRef = useRef<HeatmapResponse>(data)
    const hoverRef = useRef<HoverCell | null>(null)
    const tooltipRef = useRef<HTMLDivElement | null>(null)
    /** 缓存最新的 onCellClick，避免重建事件回调 */
    const onCellClickRef = useRef(onCellClick)
    onCellClickRef.current = onCellClick

    useEffect(() => {
        dataRef.current = data
        startAnimation()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data])

    /** 计算热力图总尺寸 */
    const getDimensions = useCallback(() => {
        const d = dataRef.current
        const poemCount = d.poems.length
        const studentCount = d.students.length
        // 每首诗：6 列 × (CELL_SIZE + CELL_GAP) - CELL_GAP + POEM_GAP
        const poemsWidth = poemCount * (BLOOM_ORDER.length * (CELL_SIZE + CELL_GAP) - CELL_GAP + POEM_GAP)
        const totalWidth = LEFT_COL_WIDTH + poemsWidth
        const totalHeight = HEADER_HEIGHT + BLOOM_LABEL_HEIGHT + studentCount * (CELL_SIZE + CELL_GAP)
        return { totalWidth, totalHeight, poemCount, studentCount }
    }, [])

    const draw = useCallback((progress: number) => {
        const canvas = canvasRef.current
        if (!canvas) return

        const d = dataRef.current
        const { totalWidth, totalHeight } = getDimensions()

        if (totalWidth === 0 || totalHeight === 0) return

        const dpr = window.devicePixelRatio || 1
        if (canvas.width !== Math.round(totalWidth * dpr) || canvas.height !== Math.round(totalHeight * dpr)) {
            canvas.width = Math.round(totalWidth * dpr)
            canvas.height = Math.round(totalHeight * dpr)
        }
        canvas.style.width = `${totalWidth}px`
        canvas.style.height = `${totalHeight}px`

        const ctx = canvas.getContext('2d')
        if (!ctx) return

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, totalWidth, totalHeight)

        // 读取颜色 —— 全部通过共享色板派生（规范 10.2 / 10.6）
        const cTextPrimary = readCSSColor('--c-text-primary')
        const cTextSecondary = readCSSColor('--c-text-secondary')
        const cTextTertiary = readCSSColor('--c-text-tertiary')
        const cSurfaceTertiary = readCSSColor('--c-surface-tertiary')
        const cAccent = readCSSColor('--c-accent-primary')

        // 构建 cells 索引：key = studentId||poemId||bloomLevel → score
        const cellMap = new Map<string, number>()
        for (const cell of d.cells) {
            cellMap.set(`${cell.studentId}||${cell.poemId}||${cell.bloomLevel}`, cell.score)
        }

        // ── 1. 绘制左侧学生名列 ──
        ctx.font = `500 12px var(--font-sans, sans-serif)`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        const startY = HEADER_HEIGHT + BLOOM_LABEL_HEIGHT
        for (let s = 0; s < d.students.length; s++) {
            const student = d.students[s]!
            if (!student) continue
            const y = startY + s * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2
            // 逐行淡入动画
            const rowProgress = Math.min(1, Math.max(0, (progress - s * 0.03) / 0.5))
            if (rowProgress <= 0) continue
            ctx.globalAlpha = rowProgress
            ctx.fillStyle = rgba(cTextSecondary, 1)
            ctx.fillText(student.anonymousName, 8, y)
            ctx.globalAlpha = 1
        }

        // ── 2. 绘制顶部诗标题 + 六阶标签 ──
        ctx.font = `600 12px var(--font-sans, sans-serif)`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        let poemX = LEFT_COL_WIDTH
        for (let p = 0; p < d.poems.length; p++) {
            const poem = d.poems[p]!
            if (!poem) continue
            const poemWidth = BLOOM_ORDER.length * (CELL_SIZE + CELL_GAP) - CELL_GAP
            const centerX = poemX + poemWidth / 2

            // 诗标题（截断显示）
            ctx.fillStyle = rgba(cTextPrimary, 1)
            const title = poem.title.length > 6 ? poem.title.slice(0, 5) + '…' : poem.title
            ctx.fillText(title, centerX, 8)

            // 诗人（小字）
            ctx.font = `400 10px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextTertiary, 1)
            const poet = poem.poet.length > 4 ? poem.poet.slice(0, 3) + '…' : poem.poet
            ctx.fillText(poet, centerX, 26)

            // 六阶标签
            ctx.font = `400 9px var(--font-sans, sans-serif)`
            ctx.fillStyle = rgba(cTextTertiary, 0.8)
            for (let b = 0; b < BLOOM_ORDER.length; b++) {
                const bloom = BLOOM_ORDER[b]!
                if (!bloom) continue
                const bx = poemX + b * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2
                ctx.fillText(bloom[0] ?? '', bx, HEADER_HEIGHT)
            }

            poemX += poemWidth + POEM_GAP
        }

        // ── 3. 绘制单元格 —— accent-primary 单色 Alpha 渐变（色盲安全）──
        poemX = LEFT_COL_WIDTH
        for (let p = 0; p < d.poems.length; p++) {
            const poem = d.poems[p]!
            if (!poem) continue
            const poemWidth = BLOOM_ORDER.length * (CELL_SIZE + CELL_GAP) - CELL_GAP

            for (let s = 0; s < d.students.length; s++) {
                const student = d.students[s]!
                if (!student) continue
                const rowProgress = Math.min(1, Math.max(0, (progress - s * 0.03) / 0.5))
                if (rowProgress <= 0) continue

                const cellY = startY + s * (CELL_SIZE + CELL_GAP)

                for (let b = 0; b < BLOOM_ORDER.length; b++) {
                    const bloom = BLOOM_ORDER[b]!
                    if (!bloom) continue
                    const cellX = poemX + b * (CELL_SIZE + CELL_GAP)
                    const key = `${student.id}||${poem.id}||${bloom}`
                    const score = cellMap.get(key)

                    ctx.globalAlpha = rowProgress

                    if (score === undefined) {
                        // 无数据：极淡灰
                        ctx.fillStyle = rgba(cSurfaceTertiary, 0.3)
                        ctx.beginPath()
                        ctx.roundRect(cellX, cellY, CELL_SIZE, CELL_SIZE, 4)
                        ctx.fill()
                    } else {
                        // 单色 sequential alpha 渐变：分数越高 alpha 越浓（15% → 100%）
                        // 灰度模式下通过 alpha 差异区分，色盲安全（规范 10.2）
                        const alpha = scoreToSequentialAlpha(score)
                        ctx.fillStyle = rgba(cAccent, alpha)
                        ctx.beginPath()
                        ctx.roundRect(cellX, cellY, CELL_SIZE, CELL_SIZE, 4)
                        ctx.fill()

                        // 分数文字 —— Tabular Numbers（规范 10.6）
                        // 低分（alpha 低）用深色文字，高分（alpha 高）用反色文字保证对比度
                        if (CELL_SIZE >= 24) {
                            ctx.font = `600 10px var(--font-sans, sans-serif)`
                            // alpha > 0.55 时背景较浓，用 inverse 色保证 WCAG AA 对比度
                            const isHighContrast = alpha > 0.55
                            const textColor = isHighContrast
                                ? readCSSColor('--c-text-inverse')
                                : cTextPrimary
                            ctx.fillStyle = rgba(textColor, 0.95)
                            ctx.textAlign = 'center'
                            ctx.textBaseline = 'middle'
                            ctx.fillText(Math.round(score).toString(), cellX + CELL_SIZE / 2, cellY + CELL_SIZE / 2)
                        }
                    }

                    ctx.globalAlpha = 1
                }
            }

            poemX += poemWidth + POEM_GAP
        }

        // ── 4. 绘制 hover 高亮 ──
        const hover = hoverRef.current
        if (hover && progress >= 1) {
            ctx.strokeStyle = rgba(cTextPrimary, 0.6)
            ctx.lineWidth = 2
            ctx.beginPath()
            ctx.roundRect(hover.x - 1, hover.y - 1, CELL_SIZE + 2, CELL_SIZE + 2, 5)
            ctx.stroke()
        }
    }, [getDimensions])

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

    /** 命中检测：返回单元格信息或 null */
    const hitTest = useCallback((x: number, y: number): HoverCell | null => {
        const d = dataRef.current
        const startY = HEADER_HEIGHT + BLOOM_LABEL_HEIGHT

        // 不在单元格区域
        if (x < LEFT_COL_WIDTH || y < startY) return null

        // 计算列索引（诗 + 阶层）
        let poemIndex = -1
        let bloomIndex = -1
        let poemX = LEFT_COL_WIDTH
        for (let p = 0; p < d.poems.length; p++) {
            const poemWidth = BLOOM_ORDER.length * (CELL_SIZE + CELL_GAP) - CELL_GAP
            if (x >= poemX && x < poemX + poemWidth) {
                poemIndex = p
                const relX = x - poemX
                bloomIndex = Math.floor(relX / (CELL_SIZE + CELL_GAP))
                if (bloomIndex >= BLOOM_ORDER.length) bloomIndex = -1
                break
            }
            poemX += poemWidth + POEM_GAP
        }

        // 计算行索引（学生）
        const relY = y - startY
        const studentIndex = Math.floor(relY / (CELL_SIZE + CELL_GAP))

        if (poemIndex < 0 || bloomIndex < 0 || studentIndex < 0 || studentIndex >= d.students.length) {
            return null
        }

        const student = d.students[studentIndex]
        const poem = d.poems[poemIndex]
        const bloom = BLOOM_ORDER[bloomIndex]
        if (!student || !poem || !bloom) return null

        const cellY = startY + studentIndex * (CELL_SIZE + CELL_GAP)
        // 重新计算 cellX（上面 break 时 poemX 已是当前诗的起始）
        let cx = LEFT_COL_WIDTH
        for (let p = 0; p < poemIndex; p++) {
            const pw = BLOOM_ORDER.length * (CELL_SIZE + CELL_GAP) - CELL_GAP
            cx += pw + POEM_GAP
        }
        cx += bloomIndex * (CELL_SIZE + CELL_GAP)

        const score = d.cells.find((c) => c.studentId === student.id && c.poemId === poem.id && c.bloomLevel === bloom)?.score

        return {
            studentId: student.id,
            studentName: student.anonymousName,
            poemId: poem.id,
            poemTitle: poem.title,
            bloomLevel: bloom,
            score: score !== undefined ? score : null,
            x: cx,
            y: cellY,
        }
    }, [])

    // 鼠标移动：hover tooltip + cursor 切换
    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        const tooltip = tooltipRef.current
        if (!canvas || !tooltip) return

        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top

        const hit = hitTest(x, y)

        if (hit) {
            hoverRef.current = hit
            // 可点击时显示 pointer cursor（规范 7.2：可交互暗示）
            canvas.style.cursor = onCellClickRef.current ? 'pointer' : 'default'

            tooltip.style.display = 'block'
            const scrollContainer = scrollRef.current
            const scrollLeft = scrollContainer?.scrollLeft ?? 0
            const scrollTop = scrollContainer?.scrollTop ?? 0
            tooltip.style.left = `${x - scrollLeft + 12}px`
            tooltip.style.top = `${y - scrollTop - 12}px`
            tooltip.innerHTML = `
                <div class="pr-diag-tooltip-title">${escapeHtml(hit.studentName)}</div>
                <div class="pr-diag-tooltip-row"><span>诗篇</span><span>${escapeHtml(hit.poemTitle)}</span></div>
                <div class="pr-diag-tooltip-row"><span>阶层</span><span>${escapeHtml(hit.bloomLevel)}</span></div>
                <div class="pr-diag-tooltip-row"><span>分数</span><span>${hit.score !== null ? Math.round(hit.score) : '未测'}</span></div>
                ${onCellClickRef.current ? '<div class="pr-diag-tooltip-hint">点击查看详情</div>' : ''}
            `
            draw(1)
        } else {
            hoverRef.current = null
            canvas.style.cursor = 'default'
            tooltip.style.display = 'none'
            draw(1)
        }
    }, [draw, hitTest])

    /** 点击钻取（规范 10.3：点击钻取） */
    const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const cb = onCellClickRef.current
        if (!cb) return
        const canvas = canvasRef.current
        if (!canvas) return

        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top

        const hit = hitTest(x, y)
        if (!hit) return

        cb({
            studentId: hit.studentId,
            studentName: hit.studentName,
            poemId: hit.poemId,
            poemTitle: hit.poemTitle,
            bloomLevel: hit.bloomLevel,
            score: hit.score,
        })
    }, [hitTest])

    const handleMouseLeave = useCallback(() => {
        hoverRef.current = null
        const canvas = canvasRef.current
        if (canvas) canvas.style.cursor = 'default'
        if (tooltipRef.current) {
            tooltipRef.current.style.display = 'none'
        }
        draw(1)
    }, [draw])

    // ResizeObserver（仅重绘，不改变尺寸）
    useEffect(() => {
        const scrollContainer = scrollRef.current
        if (!scrollContainer) return

        let resizeTimer: number | null = null
        const stopObserving = observeElementResize(scrollContainer, () => {
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

    const { totalWidth, totalHeight, poemCount, studentCount } = getDimensions()

    return (
        <div className="pr-diag-chart-card">
            <div className="pr-diag-chart-header">
                <h3 className="pr-diag-chart-title">班级掌握度热力图</h3>
                <p className="pr-diag-chart-subtitle">
                    {studentCount} 名学生 × {poemCount} 首诗 × 6 阶认知
                </p>
            </div>

            <div className="pr-diag-heatmap-scroll" ref={scrollRef}>
                {error ? (
                    <div className="pr-diag-chart-error" role="alert">
                        <div className="pr-diag-chart-error-icon" aria-hidden>
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                                <path
                                    d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
                                    stroke="currentColor"
                                    strokeWidth="1.6"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                            </svg>
                        </div>
                        <strong className="pr-diag-chart-error-title">热力图加载失败</strong>
                        <span className="pr-diag-chart-error-msg">
                            {error.message || '请稍后重试'}
                        </span>
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
                        style={{ width: '100%', height: '320px', borderRadius: 'var(--radius-lg)' }}
                    />
                ) : studentCount === 0 || poemCount === 0 ? (
                    <div className="pr-diag-empty">
                        <p className="pr-diag-empty-text">暂无掌握度数据</p>
                        <p className="pr-diag-empty-hint">请先选择班级并确保已有学生作答记录</p>
                    </div>
                ) : (
                    <div className="pr-diag-heatmap-inner" style={{ position: 'relative', width: totalWidth, height: totalHeight }}>
                        <canvas
                            ref={canvasRef}
                            className="pr-diag-canvas"
                            aria-label="班级掌握度热力图"
                            onMouseMove={handleMouseMove}
                            onMouseLeave={handleMouseLeave}
                            onClick={handleClick}
                        />
                        <div ref={tooltipRef} className="pr-diag-tooltip" style={{ display: 'none' }} />
                    </div>
                )}
            </div>

            {/* 图例：单色 Alpha 渐变梯度（色盲安全），替代原离散三色 */}
            <div className="pr-diag-chart-legend">
                <span className="pr-diag-legend-label">掌握度</span>
                <span className="pr-diag-legend-gradient" aria-hidden>
                    <span className="pr-diag-legend-gradient-label">低</span>
                    <span className="pr-diag-legend-gradient-bar" />
                    <span className="pr-diag-legend-gradient-label">高</span>
                </span>
                <span className="pr-diag-legend-item">
                    <span className="pr-diag-legend-swatch pr-diag-legend-swatch--empty" />
                    未测
                </span>
                {onCellClick && (
                    <span className="pr-diag-legend-hint">点击单元格查看详情</span>
                )}
            </div>
        </div>
    )
})
