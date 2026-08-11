/**
 * 进化模式侧面板（规范第 2、4、7、14 章 · SubTask 26.3）
 *
 * 职责：
 *  - 展示进化引擎采集到的模式列表（PatternItem[]）
 *  - SubTask 26.3 增强：
 *      - 出现次数：按 pattern 字符串聚合，显示该模式被采集的次数
 *      - 平均提升：联接 GenealogyEdge.improvementReward，按 pattern 匹配求平均
 *      - 最近触发时间：同 pattern 组中最新的 timestamp
 *      - 相关版本：联接 GenealogyEdge，列出该模式触发的版本（最多 3 个）
 *      - 排序：按出现次数 / 最近时间 / 平均提升 三种排序
 *      - 筛选：按来源（teacher-correction / agent-error / verify-reject）多选筛选
 *  - 每条模式卡片：来源徽章 + agent 标识 + 时间戳 + 上下文摘要 + 聚合指标
 *  - 空态：当无模式时显示说明文案 + 引导动作（避免死路，规范 14）
 *  - 滚动条样式与玻璃态主题协调
 *
 * 设计要点：
 *  - 零硬编码：所有色值引用 tokens.css 变量
 *  - 无硬边框：区域分隔使用透明度差异
 *  - Tabular Numbers：时间戳与 agent id 数值列右对齐
 *  - 完整三态：item hover 上移 + 背景色变深（150ms ease-out）
 *  - GPU 友好：动画仅 transform/opacity
 */

import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { PatternItem, EvolutionSource, GenealogyEdge, GenealogyNode } from '@/lib/types'
import { Button, Combobox, type ComboboxOption } from '@/components/ui'
import { formatCompactAgentId } from './agent-label'

/* ============================================================
 * 常量
 * ============================================================ */

/** 来源徽章文案与色相映射（对齐 CSS .pattern-item__badge--* 类） */
const SOURCE_META: Record<EvolutionSource, { label: string; className: string }> = {
    'teacher-correction': {
        label: '教师纠正',
        className: 'pattern-item__badge--teacher-correction',
    },
    'agent-error': {
        label: '智能体错误',
        className: 'pattern-item__badge--agent-error',
    },
    'verify-reject': {
        label: '验证否决',
        className: 'pattern-item__badge--verify-reject',
    },
}

/** 时间戳格式化：相对时间（如 "3 分钟前"） */
function formatRelativeTime(timestamp: number): string {
    if (!timestamp || !Number.isFinite(timestamp)) return '—'
    const now = Date.now()
    const diff = now - timestamp
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
    // 超过一周显示日期
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
 * 排序与筛选类型
 * ============================================================ */

type SortKey = 'recent' | 'occurrences' | 'improvement'

const SORT_OPTIONS: ComboboxOption[] = [
    { value: 'recent', label: '最近触发' },
    { value: 'occurrences', label: '出现次数' },
    { value: 'improvement', label: '平均提升' },
]

const SOURCE_FILTER_OPTIONS: ComboboxOption[] = [
    { value: 'teacher-correction', label: '教师纠正' },
    { value: 'agent-error', label: '智能体错误' },
    { value: 'verify-reject', label: '验证否决' },
]

/* ============================================================
 * 工具 —— 聚合模式（按 pattern 字符串分组）
 * ============================================================ */

interface AggregatedPattern {
    /** 任意一条代表项（取最新） */
    representative: PatternItem
    /** 该 pattern 出现的总次数 */
    occurrenceCount: number
    /** 最近触发时间 */
    lastTriggeredAt: number
    /** 平均提升（来自 GenealogyEdge.improvementReward，可能为 null） */
    avgImprovement: number | null
    /** 相关版本标签列表（最多 3 个；保留节点 id 作为稳定 React key） */
    relatedVersions: Array<{ id: string; label: string; available: boolean }>
}

function aggregatePatterns(
    patterns: PatternItem[],
    edges: GenealogyEdge[],
    nodes: GenealogyNode[],
): AggregatedPattern[] {
    // 同名模式由不同 Agent 采集时不能混合统计或借用彼此的谱系边。
    const groupKey = (agentId: string, pattern: string) => `${agentId}\u0000${pattern}`
    const groups = new Map<string, PatternItem[]>()
    for (const p of patterns) {
        const key = groupKey(p.agentId, p.pattern)
        const arr = groups.get(key) ?? []
        arr.push(p)
        groups.set(key, arr)
    }

    // 同一复合键联接谱系边；节点存在时向教师展示可读的版本名，而不是难以区分的 id 前缀。
    const edgeIndexByPattern = new Map<string, GenealogyEdge[]>()
    for (const e of edges) {
        const key = groupKey(e.agentId, e.pattern)
        const arr = edgeIndexByPattern.get(key) ?? []
        arr.push(e)
        edgeIndexByPattern.set(key, arr)
    }
    const nodeById = new Map(nodes.map((node) => [node.id, node]))

    const result: AggregatedPattern[] = []
    for (const [, items] of groups) {
        // 按 timestamp 倒序，取最新作为代表
        items.sort((a, b) => b.timestamp - a.timestamp)
        const representative = items[0]
        if (!representative) continue
        const occurrenceCount = items.length
        const lastTriggeredAt = representative.timestamp

        const matchedEdges = edgeIndexByPattern.get(groupKey(representative.agentId, representative.pattern)) ?? []
        const improvements = matchedEdges
            .map((e) => e.improvementReward)
            .filter((v): v is number => v !== null && Number.isFinite(v))
        const avgImprovement = improvements.length > 0
            ? improvements.reduce((s, v) => s + v, 0) / improvements.length
            : null

        // 相关版本：按稳定 node id 去重，优先展示真实 version，节点已删除时回退显示 id。
        const relatedVersions: Array<{ id: string; label: string; available: boolean }> = []
        const relatedNodeIds = new Set<string>()
        for (const e of matchedEdges) {
            if (relatedNodeIds.has(e.to)) continue
            relatedNodeIds.add(e.to)
            const node = nodeById.get(e.to)
            relatedVersions.push({
                id: e.to,
                label: node?.version ?? '关联节点已失效',
                available: Boolean(node),
            })
            if (relatedVersions.length >= 3) break
        }

        result.push({
            representative,
            occurrenceCount,
            lastTriggeredAt,
            avgImprovement,
            relatedVersions,
        })
    }

    return result
}

/* ============================================================
 * 单条模式卡片（memo 优化重渲染）
 * ============================================================ */

interface PatternItemCardProps {
    agg: AggregatedPattern
    /** 仅在存在可核验关联版本时调用，打开该模式对应的谱系节点。 */
    onOpenRelatedVersion?: (item: PatternItem) => void
    /** 仅当关联边的目标节点仍存在时才允许展示跳转动作。 */
    hasRelatedVersion?: (item: PatternItem) => boolean
}

const PatternItemCard = memo(function PatternItemCard({
    agg,
    onOpenRelatedVersion,
    hasRelatedVersion,
}: PatternItemCardProps) {
    const item = agg.representative
    const meta = SOURCE_META[item.source] ?? {
        label: '未知',
        className: 'pattern-item__badge--teacher-correction',
    }
    const canOpenRelatedVersion = Boolean(onOpenRelatedVersion && hasRelatedVersion?.(item))

    return (
        <article className="pattern-item" role="listitem">
            <div className="pattern-item__meta">
                <span className={`pattern-item__badge ${meta.className}`}>
                    {meta.label}
                </span>
                <span
                    className="pattern-item__agent"
                    title={item.agentId}
                    style={{ marginLeft: 'auto' } as CSSProperties}
                >
                    {formatCompactAgentId(item.agentId)}
                </span>
            </div>
            <p className="pattern-item__text" title={item.pattern}>
                {item.pattern}
            </p>

            {/* SubTask 26.3：聚合指标 */}
            <div className="pattern-item__metrics">
                <div className="pattern-item__metric">
                    <span className="pattern-item__metric-label">出现</span>
                    <strong className="pattern-item__metric-value">
                        {agg.occurrenceCount}
                    </strong>
                </div>
                <div className="pattern-item__metric">
                    <span className="pattern-item__metric-label">平均提升</span>
                    <strong
                        className="pattern-item__metric-value"
                        style={{
                            color: agg.avgImprovement !== null && agg.avgImprovement > 0
                                ? 'rgb(var(--c-accent-success))'
                                : 'rgb(var(--c-text-tertiary))',
                        }}
                    >
                        {agg.avgImprovement !== null
                            ? (agg.avgImprovement >= 0 ? '+' : '') + agg.avgImprovement.toFixed(3)
                            : '—'}
                    </strong>
                </div>
                <div className="pattern-item__metric">
                    <span className="pattern-item__metric-label">最近</span>
                    <strong className="pattern-item__metric-value">
                        {formatRelativeTime(agg.lastTriggeredAt)}
                    </strong>
                </div>
            </div>

            {/* 相关版本（最多 3 个） */}
            {agg.relatedVersions.length > 0 && (
                <div className="pattern-item__versions">
                    <span className="pattern-item__versions-label">相关版本</span>
                    {agg.relatedVersions.map((version) => (
                        <span
                            key={version.id}
                            className={`pattern-item__version-chip${version.available ? '' : ' pattern-item__version-chip--stale'}`}
                            title={version.available
                                ? `关联版本：${version.label}（节点 ${version.id}）`
                                : `关联节点已失效（节点 ${version.id}）`}
                        >
                            {version.label}
                        </span>
                    ))}
                </div>
            )}
            {canOpenRelatedVersion && (
                <button
                    type="button"
                    className="pattern-item__open"
                    onClick={() => onOpenRelatedVersion?.(item)}
                    aria-label={`在族谱中查看模式“${item.pattern}”的关联版本`}
                >
                    查看关联版本
                </button>
            )}
        </article>
    )
})

/* ============================================================
 * 主组件 —— PatternPanel
 * ============================================================ */

export interface PatternPanelProps {
    /** 模式列表（按 timestamp 倒序由后端返回） */
    patterns: PatternItem[]
    /** 版本谱系边数据（用于联接计算 avgImprovement 与 relatedVersions） */
    edges?: GenealogyEdge[]
    /** 当前可定位的版本节点（用于显示可读版本标签并筛除失效关系入口） */
    nodes?: GenealogyNode[]
    /** 加载状态 */
    loading?: boolean
    /** 打开模式对应的真实关联版本（用于谱系高亮）；无关联证据时不渲染动作。 */
    onOpenRelatedVersion?: (item: PatternItem) => void
    /** 判断模式是否有仍可定位的关联版本；陈旧边不能制造不可兑现的入口。 */
    hasRelatedVersion?: (item: PatternItem) => boolean
    /** 重新读取已持久化的进化证据；空态下提供真实恢复入口。 */
    onRefresh?: () => void
    /** 打开 AI 运行证据页；不以演示数据替代真实信号。 */
    onOpenEvidence?: () => void
}

export function PatternPanel({
    patterns,
    edges = [],
    nodes = [],
    loading = false,
    onOpenRelatedVersion,
    hasRelatedVersion,
    onRefresh,
    onOpenEvidence,
}: PatternPanelProps) {
    /* ---------- 排序与筛选状态 ---------- */
    const [sortKey, setSortKey] = useState<SortKey>('recent')
    const [sourceFilter, setSourceFilter] = useState<string[]>([])

    /* ---------- 聚合（按 pattern 字符串分组） ---------- */
    const aggregated = useMemo(() => aggregatePatterns(patterns, edges, nodes), [patterns, edges, nodes])

    /* ---------- 筛选 + 排序 ---------- */
    const visibleList = useMemo(() => {
        // 按来源筛选
        const filtered = sourceFilter.length === 0
            ? aggregated
            : aggregated.filter((a) => sourceFilter.includes(a.representative.source))

        // 排序
        const sorted = [...filtered]
        switch (sortKey) {
            case 'occurrences':
                sorted.sort((a, b) => b.occurrenceCount - a.occurrenceCount)
                break
            case 'improvement':
                sorted.sort((a, b) => (b.avgImprovement ?? -Infinity) - (a.avgImprovement ?? -Infinity))
                break
            case 'recent':
            default:
                sorted.sort((a, b) => b.lastTriggeredAt - a.lastTriggeredAt)
                break
        }
        return sorted
    }, [aggregated, sortKey, sourceFilter])

    /* ---------- 稳定回调 ---------- */
    const handleSortChange = useCallback((v: string | string[]) => {
        setSortKey(v as SortKey)
    }, [])
    const handleFilterChange = useCallback((v: string | string[]) => {
        setSourceFilter(v as string[])
    }, [])

    /* ---------- 当 sourceFilter 选项失效时重置 ---------- */
    useEffect(() => {
        // Combobox 不会自动清空失效选项，这里不需要重置
        // 因为 SOURCE_FILTER_OPTIONS 是静态的
    }, [])

    /* ---------- memo：列表项渲染 ---------- */
    const items = useMemo(() => {
        return visibleList.map((agg) => (
            <PatternItemCard
                key={`${agg.representative.id}-${agg.representative.createdAt}`}
                agg={agg}
                onOpenRelatedVersion={onOpenRelatedVersion}
                hasRelatedVersion={hasRelatedVersion}
            />
        ))
    }, [visibleList, onOpenRelatedVersion, hasRelatedVersion])

    /* ---------- 渲染 ---------- */
    return (
        <section className="pattern-panel" aria-label="进化模式列表">
            <header className="pattern-panel__header">
                <h3 className="pattern-panel__title">进化模式</h3>
                <span className="pattern-panel__count" aria-live="polite">
                    {visibleList.length} 条
                </span>
            </header>

            {/* 没有任何真实模式时，排序/筛选没有语义；直接给出形成证据的条件与恢复入口。 */}
            {patterns.length > 0 && (
                <div className="pattern-panel__controls">
                    <label className="pattern-panel__control">
                        <span className="pattern-panel__control-label">排序</span>
                        <Combobox
                            mode="single"
                            options={SORT_OPTIONS}
                            value={sortKey}
                            onChange={handleSortChange}
                            ariaLabel="排序方式"
                            searchable={false}
                        />
                    </label>
                    <label className="pattern-panel__control">
                        <span className="pattern-panel__control-label">来源筛选</span>
                        <Combobox
                            mode="multi"
                            options={SOURCE_FILTER_OPTIONS}
                            value={sourceFilter}
                            onChange={handleFilterChange}
                            placeholder="全部来源"
                            ariaLabel="按来源筛选"
                        />
                    </label>
                </div>
            )}

            {loading ? (
                <div className="pattern-panel__empty" aria-busy="true">
                    <span>加载中…</span>
                </div>
            ) : patterns.length === 0 ? (
                <div className="pattern-panel__empty pattern-panel__empty--evidence">
                    <span className="pattern-panel__empty-kicker">当前可核验状态</span>
                    <strong>暂无进化模式</strong>
                    <p>
                        这里只展示从教师纠正、智能体错误和验证否决中持久化的信号；浏览页面、单次任务或演示模式不会新增记录。
                    </p>
                    <ol className="pattern-panel__evidence-sources" aria-label="模式采集来源">
                        <li>教师纠正被确认</li>
                        <li>智能体错误被记录</li>
                        <li>验证结果明确否决</li>
                    </ol>
                    <div className="pattern-panel__empty-actions">
                        <Button variant="secondary" onClick={onRefresh} loading={loading} loadingLabel="正在刷新证据">
                            刷新已保存证据
                        </Button>
                        <Button variant="ghost" onClick={onOpenEvidence}>查看 AI 运行证据</Button>
                    </div>
                </div>
            ) : visibleList.length === 0 ? (
                <div className="pattern-panel__empty">
                    <strong>当前筛选条件下无匹配模式</strong>
                    <span>模式记录仍保留在系统中；可清除来源筛选后重新查看。</span>
                    <Button variant="ghost" onClick={() => setSourceFilter([])}>清除来源筛选</Button>
                </div>
            ) : (
                <div className="pattern-panel__list" role="list">
                    {items}
                </div>
            )}
        </section>
    )
}

export default PatternPanel
