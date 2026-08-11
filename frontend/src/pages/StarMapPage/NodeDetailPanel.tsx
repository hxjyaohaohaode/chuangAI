/**
 * 诗脉星图 · 节点详情面板（SubTask 8.3）
 *
 * 点击节点时右侧滑入面板（surface-glass-heavy + backdrop-blur 24px）。
 * 按节点类型展示差异化内容：
 *  - Poem：标题/诗人/朝代 + 原文 Markdown + 六阶雷达图 + 关联节点 + 认知暗物质标记 + 靶向练习
 *  - Poet：姓名/朝代 + 生平 + 关联节点（含作品/师承/朝代）
 *  - Image/Theme/Rhetoric：标签 + 文化内涵 + 相关诗篇
 *  - Era：朝代 + 描述 + 关联节点
 *
 * 设计要点（规范第 2、4、5、6、9、14 章）：
 *  - 零硬编码色值：全部通过 CSS class + tokens.css 变量
 *  - 零 emoji：所有图形语义由 Phosphor SVG 图标承载
 *  - 玻璃态：surface-glass-heavy + backdrop-blur 24px
 *  - 流体尺寸：面板宽度由 --sm-panel-width clamp() 控制
 *  - 完整三态：关闭按钮、关联项、靶向练习按钮均 hover/active/focus-visible
 *  - 雷达图：SVG 120×120，六边形 4 层网格 + 数据多边形 + 六阶标签
 *  - Hooks 安全：所有 hooks 在条件 return 之前调用；useMemo 依赖最小化
 */

import { memo, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { GraphNode, GraphData, EdgeType, NodeType, Mastery, MasteryLevel } from '@/lib/types'
import {
    MASTERY_TIERS,
    NODE_TYPE_LABELS,
    EDGE_TYPE_LABELS,
    classifyMastery,
} from '@/lib/types'
import { useStarMapStore } from '@/stores/starmap'
import { Icon } from '@/components/ui/Icon'
import '@/components/ui/icons-extended'
import { Button } from '@/components/ui/Button'
import { Markdown } from '@/components/ui/Markdown'
import { PoemImage } from '@/components/ui/PoemImage'
import { getPoemImage } from '@/lib/poem-images'
import { getPoetryNodeImageSource } from './poetrySphere'

export interface NodeDetailPanelProps {
    /** 完整图谱数据，用于查找关联节点 */
    data: GraphData
    /** 当前选中节点（不传则从 store 读取） */
    node?: GraphNode | null
    /** 点击关联节点的回调（默认调用 store.selectNode） */
    onNodeClick?: (node: GraphNode) => void
    /** 关闭面板（默认调用 store.selectNode(null)） */
    onClose?: () => void
}

/* ============================================================
 * 常量
 * ============================================================ */

const MASTERY_LEVEL_LABELS: Record<MasteryLevel, string> = {
    mastered: '六阶皆通',
    'high-weak': '高阶薄弱',
    'memory-stuck': '基础卡顿',
    unlearned: '尚未学习',
}

/** 雷达图几何参数 */
const RADAR_SIZE = 120
const RADAR_CENTER = RADAR_SIZE / 2
const RADAR_MAX_RADIUS = 36
const RADAR_LABEL_RADIUS = 48
const RADAR_GRID_LEVELS = 4
const RADAR_VERTICES = MASTERY_TIERS.length // 6

/** 边类型展示顺序（作者→朝代→师承→使用→共享→泛化） */
const EDGE_TYPE_ORDER: EdgeType[] = [
    'AUTHORED_BY',
    'BELONGS_TO_ERA',
    'MENTORS',
    'CONTEMPORARY',
    'USES_IMAGE',
    'USES_THEME',
    'USES_RHETORIC',
    'SHARES_IMAGE',
    'SHARES_THEME',
    'SHARES_RHETORIC',
    'RELATED_TO',
]

/* ============================================================
 * 雷达图几何计算
 * ============================================================ */

/** 雷达图顶点坐标（index 0 在正上方，顺时针每 60° 一个） */
function radarVertex(index: number, ratio: number): { x: number; y: number } {
    const angle = (-90 + index * (360 / RADAR_VERTICES)) * (Math.PI / 180)
    const r = ratio * RADAR_MAX_RADIUS
    return {
        x: RADAR_CENTER + r * Math.cos(angle),
        y: RADAR_CENTER + r * Math.sin(angle),
    }
}

/** 雷达图标签坐标（顶点外侧） */
function radarLabelPos(index: number): { x: number; y: number } {
    const angle = (-90 + index * (360 / RADAR_VERTICES)) * (Math.PI / 180)
    return {
        x: RADAR_CENTER + RADAR_LABEL_RADIUS * Math.cos(angle),
        y: RADAR_CENTER + RADAR_LABEL_RADIUS * Math.sin(angle),
    }
}

/** 将坐标数组转为 SVG points 字符串 */
function polygonPoints(points: Array<{ x: number; y: number }>): string {
    return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
}

/* ============================================================
 * 节点类型 → 图标映射
 * ============================================================ */

function nodeTypeIcon(type: NodeType): string {
    switch (type) {
        case 'Poet': return 'feather'
        case 'Poem': return 'scroll'
        case 'Image': return 'lightbulb'
        case 'Theme': return 'sparkle'
        case 'Era': return 'calendar'
        case 'Rhetoric': return 'pen-nib'
    }
}

/* ============================================================
 * 关联节点分组（按边类型）
 * ============================================================ */

interface RelatedGroup {
    edgeType: EdgeType
    items: Array<{
        node: GraphNode
        evidence?: string[]
        note?: string
        confidence?: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'
    }>
}

function groupRelated(nodeId: string, data: GraphData): RelatedGroup[] {
    const nodeMap = new Map<string, GraphNode>()
    for (const n of data.nodes) {
        nodeMap.set(n.id, n)
    }

    const groups = new Map<EdgeType, RelatedGroup['items']>()
    for (const edge of data.edges) {
        let otherId: string | null = null
        if (edge.source === nodeId) otherId = edge.target
        else if (edge.target === nodeId) otherId = edge.source
        if (!otherId) continue

        const other = nodeMap.get(otherId)
        if (!other) continue

        const item = {
            node: other,
            evidence: edge.evidence,
            note: edge.note,
            confidence: edge.confidence,
        }
        const arr = groups.get(edge.type)
        if (arr) arr.push(item)
        else groups.set(edge.type, [item])
    }

    return EDGE_TYPE_ORDER
        .map((t) => ({ edgeType: t, items: groups.get(t) ?? [] }))
        .filter((g) => g.items.length > 0)
}

/* ============================================================
 * 六阶雷达图组件
 * ============================================================ */

function MasteryRadar({ mastery }: { mastery: Mastery | undefined }) {
    const values = useMemo(() => {
        if (!mastery) return new Array<number>(RADAR_VERTICES).fill(0)
        return MASTERY_TIERS.map((t) => mastery[t.key] || 0)
    }, [mastery])

    const dataPoints = useMemo(
        () =>
            values.map((v, i) => {
                const ratio = Math.max(0, Math.min(100, v)) / 100
                return radarVertex(i, ratio)
            }),
        [values],
    )

    const gridPolygons = useMemo(() => {
        const polys: string[] = []
        for (let lvl = 1; lvl <= RADAR_GRID_LEVELS; lvl++) {
            const ratio = lvl / RADAR_GRID_LEVELS
            const pts = Array.from({ length: RADAR_VERTICES }, (_, i) => radarVertex(i, ratio))
            polys.push(polygonPoints(pts))
        }
        return polys
    }, [])

    const axisLines = useMemo(
        () =>
            Array.from({ length: RADAR_VERTICES }, (_, i) => {
                const end = radarVertex(i, 1)
                return { x1: RADAR_CENTER, y1: RADAR_CENTER, x2: end.x, y2: end.y }
            }),
        [],
    )

    return (
        <svg
            className="pr-sm-radar"
            width={RADAR_SIZE}
            height={RADAR_SIZE}
            viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`}
            role="img"
            aria-label="六阶认知掌握度雷达图"
        >
            {gridPolygons.map((pts, i) => (
                <polygon key={i} className="pr-sm-radar-grid" points={pts} />
            ))}
            {axisLines.map((l, i) => (
                <line key={i} className="pr-sm-radar-axis" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
            ))}
            <polygon className="pr-sm-radar-area" points={polygonPoints(dataPoints)} />
            {dataPoints.map((p, i) => (
                <circle key={i} className="pr-sm-radar-point" cx={p.x} cy={p.y} r={2.5} />
            ))}
            {MASTERY_TIERS.map((tier, i) => {
                const pos = radarLabelPos(i)
                return (
                    <text
                        key={tier.key}
                        className="pr-sm-radar-label"
                        x={pos.x}
                        y={pos.y}
                        dominantBaseline="middle"
                    >
                        {tier.label}
                    </text>
                )
            })}
        </svg>
    )
}

/* ============================================================
 * 关联节点列表
 * ============================================================ */

function RelatedNodeList({
    groups,
    onNodeClick,
}: {
    groups: RelatedGroup[]
    onNodeClick: (node: GraphNode) => void
}) {
    if (groups.length === 0) {
        return <p className="pr-sm-related-empty">暂无关联</p>
    }
    const relationSentence = (edgeType: EdgeType, other: GraphNode): string => {
        switch (edgeType) {
            case 'AUTHORED_BY': return `创作关系 · ${other.label}`
            case 'BELONGS_TO_ERA': return `时代归属 · ${other.label}`
            case 'MENTORS': return `诗学影响 · ${other.label}`
            case 'CONTEMPORARY': return `生年有重叠 · ${other.label}`
            case 'SHARES_IMAGE': return `共享意象 · ${other.label}`
            case 'SHARES_THEME': return `共享主题 · ${other.label}`
            case 'SHARES_RHETORIC': return `共享修辞 · ${other.label}`
            case 'USES_IMAGE': return `文本意象 · ${other.label}`
            case 'USES_THEME': return `表达主题 · ${other.label}`
            case 'USES_RHETORIC': return `表达手法 · ${other.label}`
            case 'RELATED_TO': return `知识关联 · ${other.label}`
        }
    }

    return (
        <div className="pr-sm-related-groups">
            {groups.map((g) => (
                <div key={g.edgeType} className="pr-sm-related-group">
                    <p className="pr-sm-related-group-title">
                        <span>{EDGE_TYPE_LABELS[g.edgeType]}</span>
                        <span className="pr-sm-related-group-count">{g.items.length}</span>
                    </p>
                    <ul className="pr-sm-related-list">
                        {g.items.map((item, itemIndex) => (
                            <li key={`${g.edgeType}:${item.node.id}:${itemIndex}`}>
                                <button
                                    type="button"
                                    className="pr-sm-related-item"
                                    onClick={() => onNodeClick(item.node)}
                                >
                                    <Icon name={nodeTypeIcon(item.node.type)} size={14} />
                                    <span className="pr-sm-related-item-copy">
                                        <span className="pr-sm-related-item-label">
                                            {relationSentence(g.edgeType, item.node)}
                                        </span>
                                        {(item.evidence?.length || item.note) && (
                                            <span className="pr-sm-related-item-evidence">
                                                {item.evidence?.length
                                                    ? `依据：${item.evidence.join('、')}`
                                                    : item.note}
                                            </span>
                                        )}
                                    </span>
                                    <span className="pr-sm-related-item-type">
                                        {item.confidence === 'INFERRED' ? '推断' : NODE_TYPE_LABELS[item.node.type]}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </div>
    )
}

/* ============================================================
 * Section 容器（章节标题 + 内容）
 * ============================================================ */

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="pr-sm-panel-section">
            <h3 className="pr-sm-panel-section-title">{title}</h3>
            {children}
        </section>
    )
}

/* ============================================================
 * Poem 节点内容
 * ============================================================ */

function PoemContent({
    node,
    masteryLevel,
    relatedGroups,
    onNodeClick,
    onTargetedPractice,
}: {
    node: GraphNode
    masteryLevel: MasteryLevel
    relatedGroups: RelatedGroup[]
    onNodeClick: (n: GraphNode) => void
    onTargetedPractice: () => void
}) {
    const darkMatter = node.darkMatter ?? []
    const hasDarkMatter = darkMatter.length > 0

    // 获取古诗配图（SubTask 5.2 —— 24 张图片资源接入）
    const poemImage = getPoemImage(node.id)
    const nodeImageSource = getPoetryNodeImageSource(node)

    return (
        <>
            {node.isDarkMatter && (
                <div className="pr-sm-darkmatter-badge">
                    <Icon name="warning-circle" size={14} />
                    <span>班级共性卡顿</span>
                </div>
            )}

            {node.content && (
                <Section title="原文">
                    <div className="pr-sm-panel-content">
                        <Markdown content={node.content} />
                    </div>
                </Section>
            )}

            {nodeImageSource && (
                <Section title="配图">
                    <PoemImage
                        src={nodeImageSource}
                        alt={poemImage?.alt ?? `${node.label}专属诗境图`}
                        size="full"
                        ratio="4/3"
                        caption={poemImage
                            ? `${poemImage.title} · ${poemImage.imagery}`
                            : `${node.label} · 专属诗境`}
                        aiLabel="Wan2.7 生成"
                        showAiBadge
                    />
                </Section>
            )}

            <Section title="认知掌握度">
                {node.mastery ? (
                    <div className="pr-sm-radar-wrapper">
                        <MasteryRadar mastery={node.mastery} />
                        <p className="pr-sm-mastery-label">{MASTERY_LEVEL_LABELS[masteryLevel]}</p>
                    </div>
                ) : (
                    <div className="pr-sm-mastery-empty">
                        <Icon name="chart-line" size={18} />
                        <p>暂无该班在本诗上的有效作答记录，不生成推测分数。</p>
                    </div>
                )}
            </Section>

            {hasDarkMatter && (
                <Section title="卡顿阶层">
                    <div className="pr-sm-darkmatter-tags">
                        {darkMatter.map((tier) => (
                            <span key={tier} className="pr-sm-darkmatter-tag">
                                {tier}
                            </span>
                        ))}
                    </div>
                </Section>
            )}

            <Section title="关联节点">
                <RelatedNodeList groups={relatedGroups} onNodeClick={onNodeClick} />
            </Section>

            {hasDarkMatter && (
                <Button
                    variant="primary"
                    block
                    leftIcon={<Icon name="graduation" size={16} />}
                    onClick={onTargetedPractice}
                >
                    一键靶向练习
                </Button>
            )}
        </>
    )
}

/* ============================================================
 * Poet 节点内容
 * ============================================================ */

function PoetContent({
    node,
    relatedGroups,
    onNodeClick,
}: {
    node: GraphNode
    relatedGroups: RelatedGroup[]
    onNodeClick: (n: GraphNode) => void
}) {
    return (
        <>
            {node.bio && (
                <Section title="生平简介">
                    <p className="pr-sm-panel-content">{node.bio}</p>
                </Section>
            )}
            <Section title="关联节点">
                <RelatedNodeList groups={relatedGroups} onNodeClick={onNodeClick} />
            </Section>
        </>
    )
}

/* ============================================================
 * Era 节点内容
 * ============================================================ */

function EraContent({
    node,
    relatedGroups,
    onNodeClick,
}: {
    node: GraphNode
    relatedGroups: RelatedGroup[]
    onNodeClick: (n: GraphNode) => void
}) {
    return (
        <>
            {node.description && (
                <Section title="朝代简介">
                    <p className="pr-sm-panel-content">{node.description}</p>
                </Section>
            )}
            <Section title="关联节点">
                <RelatedNodeList groups={relatedGroups} onNodeClick={onNodeClick} />
            </Section>
        </>
    )
}

/* ============================================================
 * Image / Theme / Rhetoric 节点内容
 * ============================================================ */

function TagContent({
    node,
    relatedGroups,
    onNodeClick,
}: {
    node: GraphNode
    relatedGroups: RelatedGroup[]
    onNodeClick: (n: GraphNode) => void
}) {
    return (
        <>
            {node.description && (
                <Section title="文化内涵">
                    <p className="pr-sm-panel-content">{node.description}</p>
                </Section>
            )}
            <Section title="相关诗篇">
                <RelatedNodeList groups={relatedGroups} onNodeClick={onNodeClick} />
            </Section>
        </>
    )
}

/* ============================================================
 * 主组件
 * ============================================================ */

export const NodeDetailPanel = memo(function NodeDetailPanel({ data, node, onNodeClick, onClose }: NodeDetailPanelProps) {
    const navigate = useNavigate()
    const storeNode = useStarMapStore((s) => s.selectedNode)
    const storeSelectNode = useStarMapStore((s) => s.selectNode)

    const current = node ?? storeNode
    const currentId = current?.id

    const relatedGroups = useMemo(
        () => (currentId ? groupRelated(currentId, data) : []),
        [currentId, data],
    )

    // 所有 hooks 已调用完毕，可安全提前返回
    if (!current) return null

    const handleClose = () => {
        if (onClose) onClose()
        else storeSelectNode(null)
    }

    const handleNodeClick = (n: GraphNode) => {
        if (onNodeClick) onNodeClick(n)
        else storeSelectNode(n)
    }

    const handleTargetedPractice = () => {
        const tier = current.darkMatter?.[0] ?? ''
        const params = new URLSearchParams({
            poemId: current.id,
            tier,
            source: 'starmap-targeted',
        })
        // 修复：此前跳转 /workshop（路由不存在），改为 /workbench（命题工坊，已注册）
        navigate(`/workbench?${params.toString()}`)
    }

    const subtitleParts: string[] = [NODE_TYPE_LABELS[current.type]]
    if (current.dynasty) subtitleParts.push(current.dynasty)
    if (current.poet) subtitleParts.push(current.poet)

    return (
        <aside className="pr-sm-panel" aria-label="节点详情">
            <header className="pr-sm-panel-header">
                <div className="pr-sm-panel-heading">
                    <h2 className="pr-sm-panel-title">{current.label}</h2>
                    <p className="pr-sm-panel-subtitle">{subtitleParts.join(' · ')}</p>
                </div>
                <button
                    type="button"
                    className="pr-sm-panel-close"
                    onClick={handleClose}
                    aria-label="关闭详情面板"
                >
                    <Icon name="x" size={16} />
                </button>
            </header>

            <div className="pr-sm-panel-body">
                {current.type === 'Poem' && (
                    <PoemContent
                        node={current}
                        masteryLevel={classifyMastery(current.mastery)}
                        relatedGroups={relatedGroups}
                        onNodeClick={handleNodeClick}
                        onTargetedPractice={handleTargetedPractice}
                    />
                )}
                {current.type === 'Poet' && (
                    <PoetContent
                        node={current}
                        relatedGroups={relatedGroups}
                        onNodeClick={handleNodeClick}
                    />
                )}
                {current.type === 'Era' && (
                    <EraContent
                        node={current}
                        relatedGroups={relatedGroups}
                        onNodeClick={handleNodeClick}
                    />
                )}
                {(current.type === 'Image' || current.type === 'Theme' || current.type === 'Rhetoric') && (
                    <TagContent
                        node={current}
                        relatedGroups={relatedGroups}
                        onNodeClick={handleNodeClick}
                    />
                )}
            </div>
        </aside>
    )
})
