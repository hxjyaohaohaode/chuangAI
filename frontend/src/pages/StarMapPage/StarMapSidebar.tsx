/**
 * 诗脉星图 · 统一左侧边栏（Task 15.1-15.4）
 *
 * 重构目标：将原顶部工具栏 + 右侧详情面板布局统一为「左侧边栏 + 主区画布 + 浮动详情面板」
 *
 * 结构：
 *  - 顶部：搜索框 + 诗歌宇宙/星体目录视图切换
 *  - 中部：三个 Tab（诗词按朝代 / 意象按类别 / 关系按类型）+ 节点列表
 *  - 底部：图例（节点形状 + 关系颜色 + 掌握度色阶）
 *
 * 设计要点（规范第 2、4、5、6、8 章）：
 *  - 零硬编码色值：全 CSS class + tokens.css 变量
 *  - 玻璃态侧边栏：surface-glass + backdrop-blur 20px
 *  - 选中态：3px accent-primary 左侧竖线 + 20% accent alpha 背景
 *  - 完整三态：hover/active/focus-visible
 *  - 响应式：移动端折叠为抽屉（Drawer），通过 isMobileOpen 控制显隐
 *  - 280px 固定宽度（桌面），流体高度撑满主区
 */

import { memo, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { GraphData, GraphEdge, GraphNode, NodeType, ViewMode, EdgeType } from '@/lib/types'
import { NODE_TYPE_LABELS, EDGE_TYPE_LABELS } from '@/lib/types'
import { useStarMapStore, ALL_NODE_TYPES } from '@/stores/starmap'
import { Icon } from '@/components/ui/Icon'
import '@/components/ui/icons-extended'
import { cn } from '@/lib/cn'
import { shapePath } from './nodeShape'
import { matchSearch } from './graphRender'
import { relationCss, RELATION_COLORS } from './graphRelations'

/* ============================================================
 * 常量
 * ============================================================ */

/** 侧边栏 Tab 类型 */
export type SidebarTab = 'poems' | 'images' | 'relations'

/** Tab 配置 */
const SIDEBAR_TABS: ReadonlyArray<{ id: SidebarTab; label: string; icon: string }> = [
    { id: 'poems', label: '诗词', icon: 'scroll' },
    { id: 'images', label: '意象', icon: 'lightbulb' },
    { id: 'relations', label: '关系', icon: 'graph' },
]

/** 沉浸式宇宙为唯一图形视图；列表仅用于检索与降级。 */
export type CanvasView = 'universe' | 'list'

/** 节点类型 → 图标名 */
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

/** 节点类型 → 中文标签的子集分组 */
const POEM_GROUP_TYPES: ReadonlySet<NodeType> = new Set(['Poet', 'Poem', 'Era'])
const IMAGE_GROUP_TYPES: ReadonlySet<NodeType> = new Set(['Image', 'Theme', 'Rhetoric'])

/* ============================================================
 * 分组结构
 * ============================================================ */

interface ListGroup {
    key: string
    title: string
    icon: string
    nodes: GraphNode[]
}

/** 诗词 Tab：按朝代分组 Poet/Poem/Era */
function groupPoems(data: GraphData, enabledTypes: Set<NodeType>, searchQuery: string): ListGroup[] {
    const q = searchQuery.trim()
    const filtered = data.nodes.filter((n) => {
        if (!POEM_GROUP_TYPES.has(n.type)) return false
        if (!enabledTypes.has(n.type)) return false
        if (q && !matchSearch(n, q)) return false
        return true
    })

    const dynastyGroups = new Map<string, GraphNode[]>()
    const others: GraphNode[] = []
    for (const node of filtered) {
        const dynasty = node.dynasty || (node.type === 'Era' ? node.label : '')
        if (dynasty) {
            const arr = dynastyGroups.get(dynasty) ?? []
            arr.push(node)
            dynastyGroups.set(dynasty, arr)
        } else {
            others.push(node)
        }
    }

    // 朝代按时间顺序排序（粗序，未匹配的放最后）
    const DYNASTY_ORDER = ['先秦', '汉', '魏晋', '南北朝', '隋', '唐', '五代', '宋', '辽', '金', '元', '明', '清', '近现代', '当代']
    const groups: ListGroup[] = []
    const sortedDynasties = [...dynastyGroups.entries()].sort((a, b) => {
        const ai = DYNASTY_ORDER.findIndex((d) => a[0].includes(d))
        const bi = DYNASTY_ORDER.findIndex((d) => b[0].includes(d))
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    })
    for (const [dynasty, nodes] of sortedDynasties) {
        groups.push({ key: `dynasty-${dynasty}`, title: dynasty, icon: 'calendar', nodes })
    }
    if (others.length > 0) {
        groups.push({ key: 'others', title: '未分类', icon: 'dots-three', nodes: others })
    }
    return groups
}

/** 意象 Tab：按类型分组 Image/Theme/Rhetoric */
function groupImages(data: GraphData, enabledTypes: Set<NodeType>, searchQuery: string): ListGroup[] {
    const q = searchQuery.trim()
    const byType = new Map<NodeType, GraphNode[]>()
    for (const node of data.nodes) {
        if (!IMAGE_GROUP_TYPES.has(node.type)) continue
        if (!enabledTypes.has(node.type)) continue
        if (q && !matchSearch(node, q)) continue
        const arr = byType.get(node.type) ?? []
        arr.push(node)
        byType.set(node.type, arr)
    }
    const groups: ListGroup[] = []
    for (const type of ['Image', 'Theme', 'Rhetoric'] as NodeType[]) {
        const nodes = byType.get(type) ?? []
        if (nodes.length === 0) continue
        groups.push({
            key: `type-${type}`,
            title: NODE_TYPE_LABELS[type],
            icon: nodeTypeIcon(type),
            nodes: [...nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0)),
        })
    }
    return groups
}

/** 关系 Tab：按关系类型分组（边视角） */
function groupRelations(data: GraphData, searchQuery: string): ListGroup[] {
    const q = searchQuery.trim()
    const byEdgeType = new Map<EdgeType, { edge: GraphEdge; source: GraphNode; target: GraphNode }[]>()
    const nodeMap = new Map(data.nodes.map((n) => [n.id, n]))
    for (const edge of data.edges) {
        const source = nodeMap.get(edge.source)
        const target = nodeMap.get(edge.target)
        if (!source || !target) continue
        if (q) {
            const sq = q.toLowerCase()
            const sm = source.label.toLowerCase().includes(sq) || EDGE_TYPE_LABELS[edge.type].includes(q)
            const tm = target.label.toLowerCase().includes(sq)
            if (!sm && !tm) continue
        }
        const arr = byEdgeType.get(edge.type) ?? []
        arr.push({ edge, source, target })
        byEdgeType.set(edge.type, arr)
    }
    const groups: ListGroup[] = []
    // 按关系语义排序
    const ORDER: EdgeType[] = ['AUTHORED_BY', 'BELONGS_TO_ERA', 'MENTORS', 'CONTEMPORARY', 'USES_IMAGE', 'USES_THEME', 'USES_RHETORIC', 'SHARES_IMAGE', 'SHARES_THEME', 'SHARES_RHETORIC', 'RELATED_TO']
    for (const type of ORDER) {
        const items = byEdgeType.get(type)
        if (!items || items.length === 0) continue
        // 将关系项转换为"伪节点"以复用列表渲染逻辑
        groups.push({
            key: `edge-${type}`,
            title: EDGE_TYPE_LABELS[type],
            icon: 'graph',
            nodes: items.map((item, idx) => ({
                id: `${item.edge.source}->${item.edge.target}:${item.edge.type}:${idx}`,
                type: 'Theme' as NodeType, // 占位类型，渲染时根据 edge 区分
                label: `${item.source.label} → ${item.target.label}`,
                degree: item.edge.weight,
            })),
        })
    }
    return groups
}

/* ============================================================
 * 侧边栏主组件
 * ============================================================ */

export interface StarMapSidebarProps {
    /** 完整图谱数据 */
    data: GraphData
    /** 当前视图模式（type/mastery） */
    viewMode: ViewMode
    /** 当前画布视图（诗歌宇宙/星体目录） */
    canvasView: CanvasView
    /** 切换画布视图 */
    onCanvasViewChange: (view: CanvasView) => void
    /** 是否使用 mock 数据 */
    usingMock: boolean
    /** 移动端抽屉是否打开 */
    isMobileOpen: boolean
    /** 关闭移动端抽屉 */
    onMobileClose: () => void
}

export const StarMapSidebar = memo(function StarMapSidebar({
    data,
    viewMode,
    canvasView,
    onCanvasViewChange,
    usingMock,
    isMobileOpen,
    onMobileClose,
}: StarMapSidebarProps) {
    const searchQuery = useStarMapStore((s) => s.searchQuery)
    const setSearchQuery = useStarMapStore((s) => s.setSearchQuery)
    const setViewMode = useStarMapStore((s) => s.setViewMode)
    const enabledTypes = useStarMapStore((s) => s.enabledTypes)
    const toggleType = useStarMapStore((s) => s.toggleType)
    const setAllTypes = useStarMapStore((s) => s.setAllTypes)
    const selectedNode = useStarMapStore((s) => s.selectedNode)
    const selectNode = useStarMapStore((s) => s.selectNode)
    const [activeTab, setActiveTab] = useState<SidebarTab>('poems')
    const sidebarRef = useRef<HTMLElement>(null)
    const searchInputRef = useRef<HTMLInputElement>(null)

    useLayoutEffect(() => {
        const sidebar = sidebarRef.current
        if (!sidebar) return
        if (!isMobileOpen) {
            sidebar.setAttribute('inert', '')
            return
        }
        sidebar.removeAttribute('inert')
        // 打开提交时先同步解除 inert，再聚焦真实输入。额外在点击事件结束和
        // 抽屉首帧之后校准两次，避免触发按钮/浏览器默认聚焦在 React 提交后
        // 又夺回焦点；所有任务都随关闭或卸载清理，不能产生迟到焦点跳转。
        const focusSearch = () => searchInputRef.current?.focus({ preventScroll: true })
        focusSearch()
        const frame = window.requestAnimationFrame(focusSearch)
        const eventTimer = window.setTimeout(focusSearch, 0)
        const settleTimer = window.setTimeout(focusSearch, 50)
        return () => {
            window.cancelAnimationFrame(frame)
            window.clearTimeout(eventTimer)
            window.clearTimeout(settleTimer)
        }
    }, [isMobileOpen])

    const handleSidebarTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const currentIndex = SIDEBAR_TABS.findIndex((tab) => tab.id === activeTab)
        let nextIndex: number
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                nextIndex = (currentIndex + 1) % SIDEBAR_TABS.length
                break
            case 'ArrowLeft':
            case 'ArrowUp':
                nextIndex = (currentIndex - 1 + SIDEBAR_TABS.length) % SIDEBAR_TABS.length
                break
            case 'Home':
                nextIndex = 0
                break
            case 'End':
                nextIndex = SIDEBAR_TABS.length - 1
                break
            default:
                return
        }
        event.preventDefault()
        const nextTab = SIDEBAR_TABS[nextIndex]
        if (!nextTab) return
        setActiveTab(nextTab.id)
        event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-starmap-sidebar-tab="${nextTab.id}"]`)
            ?.focus()
    }

    const groups = useMemo<ListGroup[]>(() => {
        if (activeTab === 'poems') return groupPoems(data, enabledTypes, searchQuery)
        if (activeTab === 'images') return groupImages(data, enabledTypes, searchQuery)
        return groupRelations(data, searchQuery)
    }, [activeTab, data, enabledTypes, searchQuery])

    const handleReset = () => {
        setSearchQuery('')
        setAllTypes(true)
        setViewMode('type')
    }

    const handleNodeClick = (node: GraphNode) => {
        // 关系 Tab 中的"伪节点" id 格式为 "sourceId->targetId:type:idx"，不能直接 selectNode
        // 检测到该格式时跳过（关系 Tab 仅展示，点击不触发选中）
        if (node.id.includes('->') && node.id.includes(':')) return
        selectNode(node)
        onMobileClose()
    }

    const totalNodes = data.nodes.length
    const totalEdges = data.edges.length

    return (
        <>
            {/* 移动端遮罩 */}
            {isMobileOpen && (
                <div
                    className="pr-sm-sidebar-overlay"
                    onClick={onMobileClose}
                    aria-hidden
                />
            )}
            <aside
                ref={sidebarRef}
                id="pr-sm-sidebar"
                className={cn('pr-sm-sidebar', isMobileOpen && 'is-mobile-open')}
                aria-label="星图导航侧边栏"
                aria-hidden={!isMobileOpen}
            >
                <div className="pr-sm-sidebar-heading">
                    <div>
                        <span>OBSERVATORY</span>
                        <strong>观星舱</strong>
                    </div>
                    <button type="button" onClick={onMobileClose} aria-label="关闭观星舱">
                        <Icon name="x" size={16} />
                    </button>
                </div>

                {/* ============ 顶部：搜索 + 视图切换 ============ */}
                <div className="pr-sm-sidebar-top">
                    <div className="pr-sm-sidebar-search">
                        <Icon name="magnifying-glass" size={14} className="pr-sm-sidebar-search-icon" />
                        <input
                            ref={searchInputRef}
                            className="pr-sm-sidebar-search-input"
                            type="text"
                            placeholder="搜索诗人、诗篇、意象…"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            aria-label="搜索图谱节点"
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                className="pr-sm-sidebar-search-clear"
                                onClick={() => setSearchQuery('')}
                                aria-label="清除搜索"
                            >
                                <Icon name="x" size={12} />
                            </button>
                        )}
                    </div>

                    <div className="pr-sm-sidebar-view" role="group" aria-label="画布视图切换">
                        {([
                            { id: 'universe' as CanvasView, label: '诗歌宇宙', icon: 'sparkle' },
                            { id: 'list' as CanvasView, label: '星体目录', icon: 'list' },
                        ]).map((opt) => (
                            <button
                                key={opt.id}
                                type="button"
                                className={cn('pr-sm-sidebar-view-btn', canvasView === opt.id && 'is-active')}
                                onClick={() => onCanvasViewChange(opt.id)}
                                aria-pressed={canvasView === opt.id}
                                title={`${opt.label}视图`}
                            >
                                <Icon name={opt.icon} size={13} />
                                <span>{opt.label}</span>
                            </button>
                        ))}
                    </div>

                    <div className="pr-sm-sidebar-viewmode" role="group" aria-label="着色模式">
                        <button
                            type="button"
                            className={cn('pr-sm-sidebar-viewmode-btn', viewMode === 'type' && 'is-active')}
                            onClick={() => setViewMode('type')}
                            aria-pressed={viewMode === 'type'}
                        >
                            <Icon name="faders-horizontal" size={12} />
                            <span>类型</span>
                        </button>
                        <button
                            type="button"
                            className={cn('pr-sm-sidebar-viewmode-btn', viewMode === 'mastery' && 'is-active')}
                            onClick={() => setViewMode('mastery')}
                            aria-pressed={viewMode === 'mastery'}
                        >
                            <Icon name="chart-bar" size={12} />
                            <span>掌握度</span>
                        </button>
                    </div>
                </div>

                {/* ============ 类型筛选 ============ */}
                <div className="pr-sm-sidebar-types" role="group" aria-label="节点类型筛选">
                    {ALL_NODE_TYPES.map((type) => (
                        <button
                            key={type}
                            type="button"
                            className={cn('pr-sm-sidebar-type-chip', enabledTypes.has(type) && 'is-active')}
                            onClick={() => toggleType(type)}
                            aria-pressed={enabledTypes.has(type)}
                            title={NODE_TYPE_LABELS[type]}
                        >
                            <svg className="pr-sm-sidebar-type-swatch" viewBox="-6 -6 12 12" aria-hidden>
                                <path d={shapePath(type, 4)} fill="currentColor" stroke="none" />
                            </svg>
                            <span>{NODE_TYPE_LABELS[type]}</span>
                        </button>
                    ))}
                    <button
                        type="button"
                        className="pr-sm-sidebar-reset"
                        onClick={handleReset}
                        aria-label="重置筛选"
                        title="重置筛选条件"
                    >
                        <Icon name="arrows-clockwise" size={12} />
                    </button>
                </div>

                {/* ============ 中部：Tab + 节点列表 ============ */}
                <div className="pr-sm-sidebar-tabs" role="tablist" aria-label="节点分类浏览" onKeyDown={handleSidebarTabKeyDown}>
                    {SIDEBAR_TABS.map((tab) => (
                        <button
                            key={tab.id}
                            id={`pr-sm-sidebar-tab-${tab.id}`}
                            data-starmap-sidebar-tab={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={activeTab === tab.id}
                            aria-controls="pr-sm-sidebar-tab-panel"
                            tabIndex={activeTab === tab.id ? 0 : -1}
                            className={cn('pr-sm-sidebar-tab', activeTab === tab.id && 'is-active')}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            <Icon name={tab.icon} size={13} />
                            <span>{tab.label}</span>
                        </button>
                    ))}
                </div>

                <div
                    id="pr-sm-sidebar-tab-panel"
                    className="pr-sm-sidebar-list"
                    role="tabpanel"
                    aria-labelledby={`pr-sm-sidebar-tab-${activeTab}`}
                >
                    {groups.length === 0 ? (
                        <div className="pr-sm-sidebar-empty">
                            <Icon name="magnifying-glass" size={22} />
                            <p className="pr-sm-sidebar-empty-title">暂无匹配项</p>
                            <p className="pr-sm-sidebar-empty-desc">
                                {searchQuery.trim() ? '可清除搜索或切换其他 Tab 查看完整内容' : '当前类型已全部过滤，可重置筛选恢复'}
                            </p>
                            {(searchQuery.trim() || enabledTypes.size < 6) && (
                                <button
                                    type="button"
                                    className="pr-sm-sidebar-empty-cta"
                                    onClick={handleReset}
                                >
                                    重置筛选条件
                                </button>
                            )}
                        </div>
                    ) : (
                        groups.map((group) => (
                            <div className="pr-sm-sidebar-group" key={group.key}>
                                <div className="pr-sm-sidebar-group-header">
                                    <Icon name={group.icon} size={12} />
                                    <span className="pr-sm-sidebar-group-title">{group.title}</span>
                                    <span className="pr-sm-sidebar-group-count">{group.nodes.length}</span>
                                </div>
                                <ul className="pr-sm-sidebar-items">
                                    {group.nodes.map((node) => {
                                        const isSelected = selectedNode?.id === node.id
                                        return (
                                            <li key={node.id}>
                                                <button
                                                    type="button"
                                                    className={cn('pr-sm-sidebar-item', isSelected && 'is-selected')}
                                                    onClick={() => handleNodeClick(node)}
                                                    aria-pressed={isSelected}
                                                >
                                                    <Icon name={nodeTypeIcon(node.type)} size={13} className="pr-sm-sidebar-item-icon" />
                                                    <span className="pr-sm-sidebar-item-label">{node.label}</span>
                                                    {typeof node.degree === 'number' && node.degree > 0 && (
                                                        <span className="pr-sm-sidebar-item-meta">{node.degree}</span>
                                                    )}
                                                </button>
                                            </li>
                                        )
                                    })}
                                </ul>
                            </div>
                        ))
                    )}
                </div>

                {/* ============ 底部：图例 + 状态 ============ */}
                <div className="pr-sm-sidebar-legend" aria-label="图例">
                    <div className="pr-sm-sidebar-legend-group">
                        <span className="pr-sm-sidebar-legend-title">节点形状</span>
                        <div className="pr-sm-sidebar-legend-items">
                            {ALL_NODE_TYPES.map((type) => (
                                <div className="pr-sm-sidebar-legend-item" key={type}>
                                    <svg className={cn('pr-sm-sidebar-legend-shape', type)} viewBox="-8 -8 16 16" aria-hidden>
                                        <path d={shapePath(type, 6)} />
                                    </svg>
                                    <span>{NODE_TYPE_LABELS[type]}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="pr-sm-sidebar-legend-group">
                        <span className="pr-sm-sidebar-legend-title">关系色彩</span>
                        <div className="pr-sm-sidebar-legend-items">
                            {(Object.keys(RELATION_COLORS) as EdgeType[])
                                .filter((t) => t !== 'RELATED_TO')
                                .slice(0, 6)
                                .map((type) => (
                                    <div className="pr-sm-sidebar-legend-item" key={type}>
                                        <span
                                            className="pr-sm-sidebar-legend-line"
                                            style={{ background: relationCss(type) }}
                                            aria-hidden
                                        />
                                        <span>{EDGE_TYPE_LABELS[type]}</span>
                                    </div>
                                ))}
                        </div>
                    </div>
                    <div className="pr-sm-sidebar-status" aria-live="polite">
                        <span className={cn('pr-sm-sidebar-status-dot', usingMock && 'is-mock')} />
                        <span>{totalNodes} 节点 · {totalEdges} 关系</span>
                        {usingMock && <span aria-hidden>· 演示数据</span>}
                    </div>
                </div>
            </aside>
        </>
    )
})
