/**
 * A/B 测试结果 SVG 图表（规范第 2、10、14 章 · SubTask 26.2）
 *
 * 职责：
 *  - 渲染当前活跃 A/B 测试：候选版本 vs 当前活跃版本的成功率对比柱状图
 *  - 渲染历史激活记录：时间线摘要
 *  - 自定义 SVG（不依赖图表库），遵循规范第 10 章：
 *      - 无 chartjunk（无网格线、无背景色、无 3D）
 *      - 字体统一使用 CSS 变量
 *      - 色彩语义化：候选=info、活跃=primary（SubTask 26.2 改用 accent-info）
 *  - Tabular Numbers：所有数值列右对齐 + tabular-nums
 *  - 响应式：viewBox 自适应宽度
 *  - 空态：当无活跃测试与历史时显示说明
 *  - SubTask 26.2 增强：
 *      - Combobox 选择版本对（候选+活跃）联动高亮
 *      - hover 显示数值 tooltip
 *      - 图例可切换（点击隐藏/显示对应系列）
 *      - 显示样本数、提升幅度（margin）
 *
 * 设计要点：
 *  - 零硬编码色值：使用 rgb(var(--c-*)) 通道
 *  - 无硬边框：仅用极淡 alpha 线作为坐标参考
 *  - 完整三态：bar-group hover 时透明度变化
 *  - GPU 友好：过渡仅 opacity/transform
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { ABTestResultData, ABTestCandidateInfo, ABTestHistoryItem } from '@/lib/types'
import { Combobox, type ComboboxOption } from '@/components/ui'
import { formatCompactAgentId } from './agent-label'

/* ============================================================
 * 常量
 * ============================================================ */

/** SVG 视图盒尺寸（响应式按 width: 100% 缩放） */
const VIEWBOX_WIDTH = 320
const VIEWBOX_HEIGHT = 200
const PADDING = { top: 20, right: 16, bottom: 36, left: 40 }

/** 柱状图布局参数 */
const BAR_WIDTH = 28
const BAR_GAP = 8
const GROUP_GAP = 24

/** 成功率转坐标：100% → 顶部，0% → 底部 */
function rateToY(rate: number, chartTop: number, chartBottom: number): number {
    const clamped = Math.max(0, Math.min(1, rate))
    return chartBottom - clamped * (chartBottom - chartTop)
}

/** 时间戳格式化（短日期） */
function formatShortDate(timestamp: number): string {
    if (!timestamp || !Number.isFinite(timestamp)) return '—'
    try {
        return new Date(timestamp).toLocaleDateString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
        })
    } catch {
        return '—'
    }
}

/* ============================================================
 * 子组件 —— 单组柱状（候选 vs 活跃）含 hover tooltip
 * ============================================================ */

interface BarGroupProps {
    candidate: ABTestCandidateInfo
    chartTop: number
    chartBottom: number
    originX: number
    isHighlighted: boolean
    isDimmed: boolean
    showCandidate: boolean
    showActive: boolean
    onHover: (info: { candidate: ABTestCandidateInfo; x: number; y: number } | null) => void
}

const BarGroup = memo(function BarGroup({
    candidate,
    chartTop,
    chartBottom,
    originX,
    isHighlighted,
    isDimmed,
    showCandidate,
    showActive,
    onHover,
}: BarGroupProps) {
    const candidateY = rateToY(candidate.candidateSuccessRate, chartTop, chartBottom)
    const activeY = rateToY(candidate.activeSuccessRate, chartTop, chartBottom)
    const candidateHeight = chartBottom - candidateY
    const activeHeight = chartBottom - activeY

    const handleEnter = (e: React.MouseEvent<SVGGElement>) => {
        // SVG 坐标系：将鼠标在 svg 中的相对位置传给 tooltip 容器
        const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement | null)?.getBoundingClientRect()
        if (!rect) return
        onHover({ candidate, x: e.clientX - rect.left, y: e.clientY - rect.top })
    }
    const handleLeave = () => onHover(null)

    return (
        <g
            className="ab-test-bar-group"
            transform={`translate(${originX}, 0)`}
            style={{
                opacity: isDimmed ? 0.35 : 1,
                transition: 'opacity var(--dur-small) var(--ease-out)',
            }}
            onMouseEnter={handleEnter}
            onMouseLeave={handleLeave}
        >
            {/* 透明命中区，便于 hover 检测 */}
            <rect
                x={-4}
                y={chartTop - 8}
                width={BAR_WIDTH * 2 + BAR_GAP + 8}
                height={chartBottom - chartTop + 16}
                fill="transparent"
            />

            {/* 候选版本柱（info 色）—— SubTask 26.2 改为 accent-info */}
            {showCandidate && (
                <>
                    <rect
                        x={0}
                        y={candidateY}
                        width={BAR_WIDTH}
                        height={Math.max(0, candidateHeight)}
                        rx={3}
                        fill="rgb(var(--c-accent-info) / 0.70)"
                        style={{
                            filter: isHighlighted ? 'brightness(1.08)' : 'none',
                            transition: 'filter var(--dur-small) var(--ease-out)',
                        }}
                    />
                    <text
                        x={BAR_WIDTH / 2}
                        y={candidateY - 4}
                        textAnchor="middle"
                        className="ab-test-value"
                        fill="rgb(var(--c-accent-info))"
                    >
                        {(candidate.candidateSuccessRate * 100).toFixed(0)}%
                    </text>
                </>
            )}

            {/* 活跃版本柱（primary 色） */}
            {showActive && (
                <>
                    <rect
                        x={BAR_WIDTH + BAR_GAP}
                        y={activeY}
                        width={BAR_WIDTH}
                        height={Math.max(0, activeHeight)}
                        rx={3}
                        fill="rgb(var(--c-accent-primary) / 0.70)"
                        style={{
                            filter: isHighlighted ? 'brightness(1.08)' : 'none',
                            transition: 'filter var(--dur-small) var(--ease-out)',
                        }}
                    />
                    <text
                        x={BAR_WIDTH + BAR_GAP + BAR_WIDTH / 2}
                        y={activeY - 4}
                        textAnchor="middle"
                        className="ab-test-value"
                        fill="rgb(var(--c-accent-primary))"
                    >
                        {(candidate.activeSuccessRate * 100).toFixed(0)}%
                    </text>
                </>
            )}

            {/* 样本数与 agentId 标签 */}
            <text
                x={BAR_WIDTH + BAR_GAP / 2}
                y={chartBottom + 14}
                textAnchor="middle"
                className="ab-test-label"
            >
                {formatCompactAgentId(candidate.agentId)}
            </text>
            <text
                x={BAR_WIDTH + BAR_GAP / 2}
                y={chartBottom + 26}
                textAnchor="middle"
                className="ab-test-label"
                fill="rgb(var(--c-text-tertiary))"
            >
                {candidate.samples} 样本
            </text>

            {/* 提升幅度标记 */}
            {candidate.margin > 0 && (
                <text
                    x={BAR_WIDTH + BAR_GAP / 2}
                    y={chartTop - 6}
                    textAnchor="middle"
                    className="ab-test-margin"
                    fill="rgb(var(--c-accent-success))"
                >
                    +{(candidate.margin * 100).toFixed(1)}%
                </text>
            )}
        </g>
    )
})

/* ============================================================
 * 子组件 —— 历史时间线
 * ============================================================ */

interface HistoryListProps {
    history: ABTestHistoryItem[]
}

function HistoryList({ history }: HistoryListProps) {
    if (history.length === 0) return null
    return (
        <div
            style={{
                marginTop: 'var(--space-md)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-xs)',
            }}
        >
            <h4
                style={{
                    fontSize: 'var(--text-xs)',
                    fontWeight: 600,
                    color: 'rgb(var(--c-text-secondary))',
                    letterSpacing: '0.01em',
                }}
            >
                历史激活记录
            </h4>
            {history.slice(0, 5).map((h, idx) => (
                <div
                    key={`${h.agentId}-${h.activatedAt}-${idx}`}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-xs)',
                        fontSize: 'var(--text-2xs)',
                        color: 'rgb(var(--c-text-tertiary))',
                        fontVariantNumeric: 'tabular-nums',
                    }}
                >
                    <span
                        style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: 'rgb(var(--c-accent-success) / 0.80)',
                            flexShrink: 0,
                        }}
                        aria-hidden="true"
                    />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {formatCompactAgentId(h.agentId)} · {h.pattern.slice(0, 24)}
                    </span>
                    <span style={{ flexShrink: 0 }}>
                        {(h.candidateSuccessRate * 100).toFixed(0)}% →{' '}
                        {formatShortDate(h.activatedAt)}
                    </span>
                </div>
            ))}
        </div>
    )
}

/* ============================================================
 * 子组件 —— 图例（可切换显示/隐藏系列）
 * ============================================================ */

interface LegendProps {
    showCandidate: boolean
    showActive: boolean
    onToggleCandidate: () => void
    onToggleActive: () => void
}

function Legend({ showCandidate, showActive, onToggleCandidate, onToggleActive }: LegendProps) {
    return (
        <div
            className="ab-test-legend"
            role="group"
            aria-label="图例（可切换显示）"
        >
            <button
                type="button"
                className={`ab-test-legend__item ${showCandidate ? 'is-active' : 'is-dimmed'}`}
                onClick={onToggleCandidate}
                aria-pressed={showCandidate}
                aria-label="切换候选版本系列显示"
            >
                <span
                    className="ab-test-legend__dot"
                    style={{ background: 'rgb(var(--c-accent-info) / 0.85)' }}
                    aria-hidden="true"
                />
                <span>候选版本</span>
            </button>
            <button
                type="button"
                className={`ab-test-legend__item ${showActive ? 'is-active' : 'is-dimmed'}`}
                onClick={onToggleActive}
                aria-pressed={showActive}
                aria-label="切换活跃版本系列显示"
            >
                <span
                    className="ab-test-legend__dot"
                    style={{ background: 'rgb(var(--c-accent-primary) / 0.85)' }}
                    aria-hidden="true"
                />
                <span>活跃版本</span>
            </button>
        </div>
    )
}

/* ============================================================
 * 子组件 —— Tooltip 浮层
 * ============================================================ */

interface TooltipState {
    candidate: ABTestCandidateInfo
    x: number
    y: number
}

function ABTestTooltip({ state }: { state: TooltipState }) {
    const { candidate, x, y } = state
    return (
        <div
            className="ab-test-tooltip"
            role="tooltip"
            style={{
                left: x,
                top: y,
                transform: 'translate(-50%, -100%)',
            }}
        >
            <div className="ab-test-tooltip__title">
                {formatCompactAgentId(candidate.agentId, 12)} · {candidate.version}
            </div>
            <div className="ab-test-tooltip__row">
                <span style={{ color: 'rgb(var(--c-accent-info))' }}>●</span>
                <span>候选成功率</span>
                <strong>{(candidate.candidateSuccessRate * 100).toFixed(1)}%</strong>
            </div>
            <div className="ab-test-tooltip__row">
                <span style={{ color: 'rgb(var(--c-accent-primary))' }}>●</span>
                <span>活跃成功率</span>
                <strong>{(candidate.activeSuccessRate * 100).toFixed(1)}%</strong>
            </div>
            <div className="ab-test-tooltip__row">
                <span style={{ color: 'rgb(var(--c-accent-success))' }}>▲</span>
                <span>提升幅度</span>
                <strong>+{(candidate.margin * 100).toFixed(2)}%</strong>
            </div>
            <div className="ab-test-tooltip__row">
                <span>样本</span>
                <strong>{candidate.samples}</strong>
            </div>
            <div className="ab-test-tooltip__row">
                <span>最小样本</span>
                <strong>{candidate.minSamplesReached ? '已达到' : '未达到'}</strong>
            </div>
        </div>
    )
}

/* ============================================================
 * 主组件 —— ABTestChart
 * ============================================================ */

export interface ABTestChartProps {
    /** A/B 测试结果数据 */
    data: ABTestResultData
    /** 加载状态 */
    loading?: boolean
}

export function ABTestChart({ data, loading = false }: ABTestChartProps) {
    /* ---------- 图例显示状态（可切换） ---------- */
    const [showCandidate, setShowCandidate] = useState(true)
    const [showActive, setShowActive] = useState(true)

    /* ---------- 版本对选择（Combobox） ---------- */
    // 候选版本列表作为可选项，value=agentId+version 复合键
    const versionOptions: ComboboxOption[] = useMemo(() => {
        return data.active.map((c) => ({
            value: `${c.agentId}::${c.version}`,
            label: `${formatCompactAgentId(c.agentId)} · ${c.version}`,
            group: c.agentId,
        }))
    }, [data.active])

    const [selectedPair, setSelectedPair] = useState<string>('')

    // 默认选第一个候选
    useEffect(() => {
        if (!selectedPair && versionOptions.length > 0) {
            setSelectedPair(versionOptions[0]!.value)
        }
        // 若选择项已失效（数据刷新后丢失），重置
        if (selectedPair && !versionOptions.some((o) => o.value === selectedPair)) {
            setSelectedPair(versionOptions[0]?.value ?? '')
        }
    }, [versionOptions, selectedPair])

    /* ---------- tooltip 状态 ---------- */
    const [tooltip, setTooltip] = useState<TooltipState | null>(null)

    /* ---------- 派生：图表布局 ---------- */
    const layout = useMemo(() => {
        const chartTop = PADDING.top
        const chartBottom = VIEWBOX_HEIGHT - PADDING.bottom
        const chartLeft = PADDING.left
        const groupWidth = BAR_WIDTH * 2 + BAR_GAP
        const activeCount = data.active.length
        const totalWidth = activeCount > 0
            ? activeCount * groupWidth + (activeCount - 1) * GROUP_GAP
            : 0
        return { chartTop, chartBottom, chartLeft, groupWidth, totalWidth }
    }, [data.active.length])

    /* ---------- 稳定回调 ---------- */
    const handleHover = useCallback(
        (info: { candidate: ABTestCandidateInfo; x: number; y: number } | null) => {
            setTooltip(info)
        },
        [],
    )
    const toggleCandidate = useCallback(() => setShowCandidate((p) => !p), [])
    const toggleActive = useCallback(() => setShowActive((p) => !p), [])

    /* ---------- 渲染 ---------- */
    return (
        <section className="ab-test-chart" aria-label="A/B 测试结果">
            <header className="ab-test-chart__header">
                <h3 className="ab-test-chart__title">A/B 测试</h3>
                <Legend
                    showCandidate={showCandidate}
                    showActive={showActive}
                    onToggleCandidate={toggleCandidate}
                    onToggleActive={toggleActive}
                />
            </header>

            {/* 版本对选择 Combobox（仅当多组候选时显示） */}
            {data.active.length > 1 && (
                <div className="ab-test-chart__selector">
                    <label className="ab-test-chart__selector-label">
                        <span>版本对</span>
                        <Combobox
                            mode="single"
                            options={versionOptions}
                            value={selectedPair}
                            onChange={(v) => setSelectedPair(v as string)}
                            placeholder="选择版本对"
                            ariaLabel="选择版本对"
                        />
                    </label>
                </div>
            )}

            {loading ? (
                <div className="ab-test-chart__empty" aria-busy="true">
                    加载中…
                </div>
            ) : data.active.length === 0 && data.history.length === 0 ? (
                <div className="ab-test-chart__empty">
                    暂无 A/B 测试记录
                </div>
            ) : (
                <>
                    {data.active.length > 0 && (
                        <div className="ab-test-chart__canvas">
                            <svg
                                className="ab-test-chart__svg"
                                viewBox={`0 0 ${Math.max(VIEWBOX_WIDTH, layout.totalWidth + PADDING.left + PADDING.right)} ${VIEWBOX_HEIGHT}`}
                                preserveAspectRatio="xMidYMid meet"
                                role="img"
                                aria-label={`当前 ${data.active.length} 组 A/B 测试`}
                            >
                                {/* Y 轴参考线（0%、50%、100%）—— 极淡 alpha */}
                                {[0, 0.5, 1].map((r) => {
                                    const y = rateToY(r, layout.chartTop, layout.chartBottom)
                                    return (
                                        <g key={`grid-${r}`}>
                                            <line
                                                x1={PADDING.left}
                                                y1={y}
                                                x2={Math.max(VIEWBOX_WIDTH, layout.totalWidth + PADDING.left + PADDING.right) - PADDING.right}
                                                y2={y}
                                                stroke="rgb(var(--c-text-primary) / 0.06)"
                                                strokeWidth={1}
                                            />
                                            <text
                                                x={PADDING.left - 6}
                                                y={y + 3}
                                                textAnchor="end"
                                                className="ab-test-label"
                                            >
                                                {Math.round(r * 100)}%
                                            </text>
                                        </g>
                                    )
                                })}

                                {/* 候选 vs 活跃 柱状组 */}
                                {data.active.map((c, idx) => {
                                    const pairKey = `${c.agentId}::${c.version}`
                                    const isHighlighted = pairKey === selectedPair
                                    const isDimmed = !!selectedPair && !isHighlighted
                                    return (
                                        <BarGroup
                                            key={`${c.agentId}-${c.version}-${idx}`}
                                            candidate={c}
                                            chartTop={layout.chartTop}
                                            chartBottom={layout.chartBottom}
                                            originX={layout.chartLeft + idx * (layout.groupWidth + GROUP_GAP)}
                                            isHighlighted={isHighlighted}
                                            isDimmed={isDimmed}
                                            showCandidate={showCandidate}
                                            showActive={showActive}
                                            onHover={handleHover}
                                        />
                                    )
                                })}
                            </svg>

                            {/* Tooltip 浮层（脱离 svg，使用 absolute 定位） */}
                            {tooltip && (
                                <ABTestTooltip state={tooltip} />
                            )}
                        </div>
                    )}

                    {/* 阈值与最小样本数说明 */}
                    <div
                        style={{
                            display: 'flex',
                            gap: 'var(--space-md)',
                            marginTop: 'var(--space-sm)',
                            fontSize: 'var(--text-2xs)',
                            color: 'rgb(var(--c-text-tertiary))',
                            fontVariantNumeric: 'tabular-nums',
                        }}
                    >
                        <span>胜出阈值 ≥ {(data.threshold * 100).toFixed(1)}%</span>
                        <span>最小样本数 {data.minSamples}</span>
                    </div>

                    {/* 历史激活记录 */}
                    <HistoryList history={data.history} />
                </>
            )}
        </section>
    )
}

export default ABTestChart
