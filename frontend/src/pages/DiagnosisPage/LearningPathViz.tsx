/**
 * 学习路径力导向图（Task 17 / Task 3.4 FLIP 动画重构 / Task 6.3.2 scipilot 规范优化）
 *
 * 基于 D3.js forceSimulation 渲染学生推荐学习路径的力导向图：
 * - 节点 = 诗（圆形，按掌握度着色：单色 sequential alpha 渐变 + 冗余编码）
 * - 边 = 诗与诗的关联（实线 = 图谱关联，虚线箭头 = 推荐学习路径）
 * - 当前学生位置高亮（已学习的诗带光环）
 * - 节点大小 = 难度（难度越高节点越大）
 * - 拖拽/缩放/平移交互
 *
 * scipilot 规范优化（Task 6.3.2）：
 * - 掌握度着色从离散三色（红/黄/绿）改为单色 sequential alpha 渐变（色盲安全）
 * - 冗余编码：节点边框样式（点线=未学/虚线=低掌握/实线=中高掌握）补充颜色编码
 * - 复用 chartPalette 共享色板函数（readCSSColor/rgba/scoreToSequentialAlpha），消除本地重复
 *
 * 架构（D3 + React 混合模式，参考 AgentTopology）：
 * - React 提供 SVG 容器与控件
 * - D3 管理 simulation 与 DOM 绘制
 * - 通过 ref 持有 simulation，避免重渲染
 *
 * FLIP 动画过渡（Task 3.4，规范 6.4 / 7.1.2）：
 * - First：切换学生时，记录上一轮 simulation 收敛后的节点位置（按 poemId 索引）
 * - Last：新路径数据驱动 simulation 收敛到新位置
 * - Invert：新节点初始化 d.x/d.y 为上一轮位置（非中心），制造"原地起势"
 * - Play：simulation 以 alpha=1 重启，节点从旧位置弹性过渡到新位置
 * - 新增节点（旧路径不存在）：从画布中心淡入（opacity 0→1，600ms ease-out）
 * - 既有节点：保持 opacity=1，仅位置过渡（避免闪烁）
 *
 * 设计要点（规范第 6、10、13 章）：
 * - 零硬编码色值：所有颜色从 CSS 变量读取
 * - 零 emoji：所有图形语义由 SVG 承载
 * - 入场动画：节点淡入 + 缩放（600ms ease-out）
 * - GPU 友好：仅 transform/opacity 动画
 * - 高 DPI：SVG 矢量天然清晰
 */

import { useEffect, useRef, useState, useCallback, memo } from 'react'
import * as d3 from 'd3'
import type { SimulationNodeDatum, SimulationLinkDatum, Simulation, ZoomBehavior } from 'd3'
import { Icon } from '@/components/ui'
import type { LearningPathNode } from '@/lib/types'
import { readCSSColor, rgba, scoreToSequentialAlpha } from '@/lib/chartPalette'
import { escapeHtml } from '@/lib/html-escape'

interface LearningPathVizProps {
    /** 推荐学习路径节点 */
    path: LearningPathNode[]
    /** 学生脱敏名 */
    anonymousName?: string
    /** 是否加载中 */
    loading?: boolean
    /** 空状态 CTA：切换到学生列表选择学生（由父组件传入 tab 切换回调） */
    onSwitchToStudent?: () => void
}

/**
 * 检测 prefers-reduced-motion（规范 7.11 / 14.3）
 * 启用时：D3 transition duration 设为 0，禁用所有非必要动画
 */
function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 根据掌握度返回节点配色参数（scipilot 规范：单色 sequential + 冗余编码）
 *
 * 替代原离散三色（error/warning/success），改为：
 * - 颜色：统一使用 accent-primary（已学习）或 text-tertiary（未学习）
 * - Alpha：由 scoreToSequentialAlpha 派生，掌握度越高 alpha 越浓（色盲安全）
 * - 边框样式（冗余编码）：未学=点线 / 低掌握=虚线 / 中高掌握=实线
 *
 * @returns { colorVar, alpha, strokeDash, strokeWidth } 节点着色与边框参数
 */
function masteryStyle(score: number): {
    colorVar: string
    alpha: number
    strokeDash: string
    strokeWidth: number
} {
    if (score === 0) {
        // 未学习：灰色点线边框
        return { colorVar: '--c-text-tertiary', alpha: 0.2, strokeDash: '2 3', strokeWidth: 1.5 }
    }
    // 已学习：accent-primary 单色 sequential alpha 渐变
    const alpha = scoreToSequentialAlpha(score)
    // 冗余编码：低掌握(<60)=虚线 / 中高掌握(>=60)=实线
    if (score < 60) {
        return { colorVar: '--c-accent-primary', alpha, strokeDash: '5 3', strokeWidth: 2 }
    }
    return { colorVar: '--c-accent-primary', alpha, strokeDash: 'none', strokeWidth: 2.5 }
}

// ─────────────────────────────────────────────────────────────
// D3 仿真数据类型
// ─────────────────────────────────────────────────────────────

interface SimNode extends SimulationNodeDatum {
    poemId: string
    title: string
    poet: string
    dynasty: string
    difficulty: number
    currentMastery: number
    reason: string
    relationType?: string
    strength?: number
    /** 是否为推荐路径中的节点 */
    inPath: boolean
    /** 在推荐路径中的序号（-1 表示非路径节点） */
    pathOrder: number
}

interface SimLink extends SimulationLinkDatum<SimNode> {
    /** 边类型：related（图谱关联）或 path（推荐路径） */
    kind: 'related' | 'path'
    /** 关联类型（仅 related 边有） */
    relationType?: string
    /** 关联强度（仅 related 边有） */
    strength?: number
}

/** 节点半径 —— 基于难度（难度 1-5 映射到 12-22px） */
function nodeRadius(difficulty: number): number {
    return 12 + Math.max(1, Math.min(5, difficulty)) * 2
}

/** 构建节点 class */
function nodeClass(node: SimNode, totalInPath: number): string {
    const classes = ['pr-lpv-node']
    if (node.inPath) classes.push('pr-lpv-node--path')
    if (node.currentMastery > 0) classes.push('pr-lpv-node--learned')
    if (node.pathOrder === 0) classes.push('pr-lpv-node--start')
    if (node.pathOrder === totalInPath - 1 && totalInPath > 1) classes.push('pr-lpv-node--end')
    return classes.join(' ')
}

/** 构建边 class */
function edgeClass(link: SimLink): string {
    const classes = ['pr-lpv-edge', `pr-lpv-edge--${link.kind}`]
    return classes.join(' ')
}

export const LearningPathViz = memo(function LearningPathViz({
    path,
    anonymousName = '',
    loading = false,
    onSwitchToStudent,
}: LearningPathVizProps) {
    const svgRef = useRef<SVGSVGElement | null>(null)
    const containerRef = useRef<HTMLDivElement | null>(null)
    const simRef = useRef<Simulation<SimNode, SimLink> | null>(null)
    const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null)
    const tooltipRef = useRef<HTMLDivElement | null>(null)
    /**
     * FLIP 动画位置缓存（Task 3.4）
     * 键：poemId；值：上一轮 simulation 收敛后的 {x, y}
     * 切换学生时，新路径中存在的节点从旧位置"起势"过渡到新位置
     */
    const prevPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())
    const [zoomLevel, setZoomLevel] = useState(1)

    /** 缩放至适应 */
    const handleZoomToFit = useCallback(() => {
        const svgEl = svgRef.current
        const zoom = zoomBehaviorRef.current
        if (!svgEl || !zoom) return
        const svg = d3.select(svgEl)
        const g = svg.select<SVGGElement>('.pr-lpv-graph-root')
        if (g.empty()) return

        const bounds = (g.node() as SVGGElement).getBBox()
        if (bounds.width === 0 || bounds.height === 0) return

        const rect = svgEl.getBoundingClientRect()
        const width = rect.width || 800
        const height = rect.height || 500
        const padding = 40
        const scale = Math.min(
            (width - padding * 2) / bounds.width,
            (height - padding * 2) / bounds.height,
            2,
        )
        const midX = bounds.x + bounds.width / 2
        const midY = bounds.y + bounds.height / 2
        const tx = width / 2 - scale * midX
        const ty = height / 2 - scale * midY

        svg.transition()
            .duration(prefersReducedMotion() ? 0 : 350)
            .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale))
    }, [])

    /** 缩放控制 */
    const handleZoom = useCallback((factor: number) => {
        const svgEl = svgRef.current
        const zoom = zoomBehaviorRef.current
        if (!svgEl || !zoom) return
        const svg = d3.select(svgEl)
        svg.transition().duration(prefersReducedMotion() ? 0 : 200).call(zoom.scaleBy, factor)
    }, [])

    useEffect(() => {
        const svgEl = svgRef.current
        if (!svgEl) return

        // ── FLIP · First（Task 3.4）：在清空 SVG 前捕获上一轮节点位置 ──
        // 通过 poemId 索引，供新路径中相同诗篇节点继承位置，制造"原地起势"过渡
        const prevPositions = new Map<string, { x: number; y: number }>()
        if (simRef.current) {
            for (const n of simRef.current.nodes()) {
                if (n.poemId != null && n.x != null && n.y != null) {
                    prevPositions.set(n.poemId, { x: n.x, y: n.y })
                }
            }
        }
        prevPositionsRef.current = prevPositions

        const svg = d3.select(svgEl)
        svg.selectAll('*').remove()

        if (path.length === 0) return

        const rect = svgEl.getBoundingClientRect()
        const width = rect.width || 800
        const height = rect.height || 500

        // FLIP · Invert：标记新节点（旧路径不存在），用于差异化入场动画
        const newNodeIds = new Set<string>()

        // 构建节点
        // FLIP · Invert：既有节点继承上一轮位置（d.x/d.y），新增节点从画布中心淡入
        const simNodes: SimNode[] = path.map((p, idx) => {
            const prev = prevPositions.get(p.poemId)
            if (!prev) newNodeIds.add(p.poemId)
            return {
                poemId: p.poemId,
                title: p.title,
                poet: p.poet,
                dynasty: p.dynasty,
                difficulty: p.difficulty,
                currentMastery: p.currentMastery,
                reason: p.reason,
                relationType: p.relationType,
                strength: p.strength,
                inPath: true,
                pathOrder: idx,
                // 既有节点继承旧位置；新增节点置于画布中心
                x: prev?.x ?? width / 2,
                y: prev?.y ?? height / 2,
            }
        })

        // 构建边：
        // 1. 推荐路径边（path: 节点 i → i+1，虚线箭头）
        // 2. 图谱关联边（related: 有 relationType 的节点连接到前一个节点，实线）
        const simLinks: SimLink[] = []
        for (let i = 0; i < simNodes.length - 1; i++) {
            simLinks.push({
                source: i,
                target: i + 1,
                kind: 'path' as const,
            })
        }
        // 关联边：如果节点有 relationType，连接到路径中的前一个节点（如果不同）
        for (let i = 1; i < simNodes.length; i++) {
            const node = simNodes[i]!
            if (node.relationType && i > 0) {
                // 避免重复边（如果已经有 path 边）
                const hasPathEdge = simLinks.some(
                    (l) =>
                        l.kind === 'path' &&
                        ((l.source === i - 1 && l.target === i) ||
                            (l.source === i && l.target === i - 1)),
                )
                if (!hasPathEdge) {
                    simLinks.push({
                        source: i - 1,
                        target: i,
                        kind: 'related' as const,
                        relationType: node.relationType,
                        strength: node.strength,
                    })
                }
            }
        }

        // 渐变定义（箭头 marker）
        const defs = svg.append('defs')
        const accentColor = readCSSColor('--c-accent-primary')
        const arrowMarker = defs
            .append('marker')
            .attr('id', 'pr-lpv-arrow-path')
            .attr('viewBox', '0 -5 10 10')
            .attr('refX', 10)
            .attr('refY', 0)
            .attr('markerWidth', 6)
            .attr('markerHeight', 6)
            .attr('orient', 'auto')
        arrowMarker
            .append('path')
            .attr('d', 'M0,-5L10,0L0,5')
            .attr('fill', rgba(accentColor, 0.8))

        const infoColor = readCSSColor('--c-accent-info')
        const arrowMarkerRelated = defs
            .append('marker')
            .attr('id', 'pr-lpv-arrow-related')
            .attr('viewBox', '0 -5 10 10')
            .attr('refX', 10)
            .attr('refY', 0)
            .attr('markerWidth', 5)
            .attr('markerHeight', 5)
            .attr('orient', 'auto')
        arrowMarkerRelated
            .append('path')
            .attr('d', 'M0,-5L10,0L0,5')
            .attr('fill', rgba(infoColor, 0.6))

        const g = svg.append('g').attr('class', 'pr-lpv-graph-root')

        // 缩放行为
        const zoom = d3.zoom<SVGSVGElement, unknown>()
            .scaleExtent([0.3, 3])
            .on('zoom', (event) => {
                g.attr('transform', event.transform.toString())
                setZoomLevel(event.transform.k)
            })
        zoomBehaviorRef.current = zoom
        svg.call(zoom)

        // 边
        const edgeG = g.append('g').attr('class', 'pr-lpv-edges')
        const edgeSel = edgeG
            .selectAll<SVGLineElement, SimLink>('line')
            .data(simLinks)
            .join('line')
            .attr('class', (d) => edgeClass(d))
            .attr('stroke-dasharray', (d) => (d.kind === 'path' ? '6 4' : 'none'))
            .attr('marker-end', (d) =>
                d.kind === 'path' ? 'url(#pr-lpv-arrow-path)' : 'url(#pr-lpv-arrow-related)',
            )

        // 节点
        const nodeG = g.append('g').attr('class', 'pr-lpv-nodes')
        const totalInPath = simNodes.length
        const nodeSel = nodeG
            .selectAll<SVGGElement, SimNode>('g')
            .data(simNodes)
            .join('g')
            .attr('class', (d) => nodeClass(d, totalInPath))
            // FLIP · Invert：初始 transform 取继承的旧位置（或画布中心）
            .attr('transform', (d) => `translate(${d.x ?? width / 2},${d.y ?? height / 2})`)
            // 既有节点保持可见；新增节点从 opacity 0 淡入
            .style('opacity', (d) => (newNodeIds.has(d.poemId) ? 0 : 1))
            .style('cursor', 'grab')

        // 入场动画：仅新增节点淡入（既有节点位置过渡由 simulation tick 驱动，避免双重动画）
        // prefers-reduced-motion 时 duration=0 + delay=0（规范 7.11）
        nodeSel
            .filter((d) => newNodeIds.has(d.poemId))
            .transition()
            .duration(prefersReducedMotion() ? 0 : 600)
            .delay((_, i) => (prefersReducedMotion() ? 0 : i * 80))
            .style('opacity', 1)

        // 光环（已学习节点）—— 单色 sequential alpha + 冗余编码（scipilot 规范）
        nodeSel
            .filter((d) => d.currentMastery > 0)
            .append('circle')
            .attr('class', 'pr-lpv-node__halo')
            .attr('r', (d) => nodeRadius(d.difficulty) + 6)
            .attr('fill', 'none')
            .attr('stroke', (d) => {
                const ms = masteryStyle(d.currentMastery)
                return rgba(readCSSColor(ms.colorVar), Math.min(ms.alpha + 0.1, 0.35))
            })
            .attr('stroke-width', 2)

        // 主圆 —— 单色 sequential alpha 渐变 + 冗余编码边框（scipilot 规范）
        nodeSel
            .append('circle')
            .attr('class', 'pr-lpv-node__circle')
            .attr('r', (d) => nodeRadius(d.difficulty))
            .attr('fill', (d) => {
                const ms = masteryStyle(d.currentMastery)
                return rgba(readCSSColor(ms.colorVar), Math.max(ms.alpha * 0.4, 0.12))
            })
            .attr('stroke', (d) => {
                const ms = masteryStyle(d.currentMastery)
                return rgba(readCSSColor(ms.colorVar), Math.min(ms.alpha + 0.2, 0.95))
            })
            .attr('stroke-width', (d) => masteryStyle(d.currentMastery).strokeWidth)
            .attr('stroke-dasharray', (d) => masteryStyle(d.currentMastery).strokeDash)

        // 路径序号
        nodeSel
            .append('text')
            .attr('class', 'pr-lpv-node__order')
            .attr('text-anchor', 'middle')
            .attr('dominant-baseline', 'central')
            .attr('font-size', '11')
            .attr('font-weight', '600')
            .attr('fill', rgba(readCSSColor('--c-text-primary'), 1))
            .text((d) => (d.pathOrder >= 0 ? (d.pathOrder + 1).toString() : ''))

        // 标签
        nodeSel
            .append('text')
            .attr('class', 'pr-lpv-node__label')
            .attr('text-anchor', 'middle')
            .attr('y', (d) => nodeRadius(d.difficulty) + 16)
            .attr('font-size', '12')
            .attr('font-weight', '500')
            .attr('fill', rgba(readCSSColor('--c-text-secondary'), 1))
            .text((d) => d.title)

        // 副标签（诗人·朝代）
        nodeSel
            .append('text')
            .attr('class', 'pr-lpv-node__sublabel')
            .attr('text-anchor', 'middle')
            .attr('y', (d) => nodeRadius(d.difficulty) + 30)
            .attr('font-size', '10')
            .attr('fill', rgba(readCSSColor('--c-text-tertiary'), 1))
            .text((d) => `${d.poet}·${d.dynasty}`)

        // 拖拽
        const drag = d3
            .drag<SVGGElement, SimNode>()
            .on('start', (event, d) => {
                if (!event.active) sim.alphaTarget(0.3).restart()
                d.fx = d.x
                d.fy = d.y
            })
            .on('drag', (event, d) => {
                d.fx = event.x
                d.fy = event.y
            })
            .on('end', (event, d) => {
                if (!event.active) sim.alphaTarget(0)
                d.fx = null
                d.fy = null
            })
        nodeSel.call(drag)

        // hover tooltip
        nodeSel
            .on('mouseenter', (event, d) => {
                const tooltip = tooltipRef.current
                if (!tooltip) return
                tooltip.style.opacity = '1'
                tooltip.style.transform = 'translateY(0)'
                const masteryLabel =
                    d.currentMastery === 0
                        ? '未学习'
                        : `掌握度 ${Math.round(d.currentMastery)}`
                const relationLabel = d.relationType
                    ? `<div class="pr-lpv-tooltip-row"><span class="pr-lpv-tooltip-label">关联</span><span>${escapeHtml(d.relationType)}</span></div>`
                    : ''
                tooltip.innerHTML = `
                    <div class="pr-lpv-tooltip-title">${escapeHtml(d.title)}</div>
                    <div class="pr-lpv-tooltip-subtitle">${escapeHtml(d.poet)} · ${escapeHtml(d.dynasty)}</div>
                    <div class="pr-lpv-tooltip-row"><span class="pr-lpv-tooltip-label">难度</span><span>${escapeHtml(d.difficulty)}</span></div>
                    <div class="pr-lpv-tooltip-row"><span class="pr-lpv-tooltip-label">状态</span><span>${escapeHtml(masteryLabel)}</span></div>
                    ${relationLabel}
                    <div class="pr-lpv-tooltip-reason">${escapeHtml(d.reason)}</div>
                `
                const containerRect = containerRef.current?.getBoundingClientRect()
                if (containerRect) {
                    const x = event.clientX - containerRect.left + 12
                    const y = event.clientY - containerRect.top + 12
                    tooltip.style.left = `${x}px`
                    tooltip.style.top = `${y}px`
                }
            })
            .on('mouseleave', () => {
                const tooltip = tooltipRef.current
                if (!tooltip) return
                tooltip.style.opacity = '0'
                tooltip.style.transform = 'translateY(4px)'
            })

        // simulation
        // FLIP · Play：既有节点从旧位置弹性过渡到新平衡位置
        // alpha=1 确保过渡可见；alphaDecay=0.025 略慢于默认 0.0228，让过渡更丝滑
        const sim = d3
            .forceSimulation<SimNode>(simNodes)
            .alpha(1)
            .alphaDecay(0.025)
            .force('charge', d3.forceManyBody().strength(-200))
            .force(
                'link',
                d3
                    .forceLink<SimNode, SimLink>(simLinks)
                    .distance((d) => (d.kind === 'path' ? 100 : 80))
                    .strength((d) => (d.kind === 'path' ? 0.8 : 0.4)),
            )
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('collision', d3.forceCollide<SimNode>().radius((d) => nodeRadius(d.difficulty) + 20))

        sim.on('tick', () => {
            edgeSel
                .attr('x1', (d) => {
                    const s = d.source as SimNode
                    return s.x ?? 0
                })
                .attr('y1', (d) => {
                    const s = d.source as SimNode
                    return s.y ?? 0
                })
                .attr('x2', (d) => {
                    const t = d.target as SimNode
                    return t.x ?? 0
                })
                .attr('y2', (d) => {
                    const t = d.target as SimNode
                    return t.y ?? 0
                })

            nodeSel.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
        })

        simRef.current = sim

        // 初始化缩放至适应
        window.setTimeout(() => handleZoomToFit(), 100)

        return () => {
            sim.stop()
        }
    }, [path, handleZoomToFit])

    // 清理
    useEffect(() => {
        return () => {
            if (simRef.current) {
                simRef.current.stop()
                simRef.current = null
            }
        }
    }, [])

    const accentVar = readCSSColor('--c-accent-primary')
    const textSecondary = readCSSColor('--c-text-secondary')
    const textTertiary = readCSSColor('--c-text-tertiary')

    return (
        <div className="pr-lpv-container" ref={containerRef}>
            {/* 头部 */}
            <div className="pr-lpv-header">
                <div className="pr-lpv-title-row">
                    <Icon name="graph" size={16} />
                    <h3 className="pr-lpv-title">
                        学习路径图谱
                        {anonymousName && (
                            <span style={{ color: rgba(textTertiary, 1) }}>
                                {' '}· {anonymousName}
                            </span>
                        )}
                    </h3>
                </div>
                {/* 图例 */}
                <div className="pr-lpv-legend">
                    <span className="pr-lpv-legend-item">
                        <span
                            className="pr-lpv-legend-swatch pr-lpv-legend-swatch--path"
                            style={{ backgroundColor: rgba(accentVar, 0.8) }}
                        />
                        <span style={{ color: rgba(textSecondary, 1) }}>推荐路径</span>
                    </span>
                    <span className="pr-lpv-legend-item">
                        <span
                            className="pr-lpv-legend-swatch pr-lpv-legend-swatch--related"
                            style={{ backgroundColor: rgba(readCSSColor('--c-accent-info'), 0.6) }}
                        />
                        <span style={{ color: rgba(textSecondary, 1) }}>图谱关联</span>
                    </span>
                    <span className="pr-lpv-legend-item">
                        <span
                            className="pr-lpv-legend-swatch pr-lpv-legend-swatch--learned"
                            style={{
                                borderColor: rgba(accentVar, 0.7),
                                backgroundColor: rgba(accentVar, 0.2),
                            }}
                        />
                        <span style={{ color: rgba(textSecondary, 1) }}>已学习</span>
                    </span>
                    <span className="pr-lpv-legend-item">
                        <span
                            className="pr-lpv-legend-swatch"
                            style={{
                                borderColor: rgba(readCSSColor('--c-text-tertiary'), 0.5),
                                backgroundColor: 'transparent',
                                borderStyle: 'dotted',
                            }}
                        />
                        <span style={{ color: rgba(textSecondary, 1) }}>未学习</span>
                    </span>
                </div>
            </div>

            {/* SVG 图谱 */}
            <div className="pr-lpv-canvas-wrapper">
                {loading ? (
                    <div className="pr-skeleton" style={{ width: '100%', height: '100%' }} />
                ) : path.length === 0 ? (
                    <div className="pr-lpv-empty">
                        <Icon name="graph" size={32} />
                        <p className="pr-lpv-empty-title">暂无推荐学习路径</p>
                        <p
                            className="pr-lpv-empty-hint"
                            style={{ color: rgba(textTertiary, 1) }}
                        >
                            选择学生后将自动生成个性化学习路径，基于该学生的诊断数据与错题记录智能推荐。
                        </p>
                        {onSwitchToStudent && (
                            <button
                                type="button"
                                className="pr-lpv-empty-cta"
                                onClick={onSwitchToStudent}
                            >
                                选择学生
                            </button>
                        )}
                    </div>
                ) : (
                    <>
                        <svg
                            ref={svgRef}
                            className="pr-lpv-svg"
                            aria-label="学习路径力导向图"
                            role="img"
                        />
                        {/* 缩放控件 */}
                        <div className="pr-lpv-controls">
                            <button
                                type="button"
                                className="pr-lpv-control-btn"
                                onClick={() => handleZoom(1.2)}
                                aria-label="放大"
                            >
                                <Icon name="plus" size={14} />
                            </button>
                            <button
                                type="button"
                                className="pr-lpv-control-btn"
                                onClick={() => handleZoom(1 / 1.2)}
                                aria-label="缩小"
                            >
                                <Icon name="minus" size={14} />
                            </button>
                            <button
                                type="button"
                                className="pr-lpv-control-btn"
                                onClick={handleZoomToFit}
                                aria-label="适应屏幕"
                            >
                                <Icon name="arrows-clockwise" size={14} />
                            </button>
                        </div>
                        {/* 缩放级别指示 */}
                        <div
                            className="pr-lpv-zoom-level"
                            style={{ color: rgba(textTertiary, 1) }}
                        >
                            {Math.round(zoomLevel * 100)}%
                        </div>
                    </>
                )}
            </div>

            {/* hover tooltip */}
            <div
                ref={tooltipRef}
                className="pr-lpv-tooltip"
                style={{ opacity: 0 }}
                aria-hidden
            />
        </div>
    )
})
