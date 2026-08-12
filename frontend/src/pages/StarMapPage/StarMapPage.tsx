/**
 * 诗脉星图页面（Task 8 主入口 · Task 15 重构为统一侧边栏布局）
 *
 * 职责：
 *  - 数据加载：优先 api.knowledgeGraph.masteryColored(classId)，失败显示可追溯降级状态
 *  - 布局结构（Task 15.1）：
 *      ≥1024px  桌面：左侧边栏(280px) + 主区画布 + 浮动详情面板(320px)
 *      768-1023 平板：左侧边栏(260px) + 主区画布，详情面板覆盖
 *      <768px   移动：侧边栏折叠为抽屉，主区画布全屏，详情面板覆盖
 *  - 状态托管：selectedNode / hoveredNode 由 Zustand store 同步（≤50ms，规范 12.2）
 *  - 路由参数：支持 ?classId=xxx 预设班级
 *
 * 设计要点（规范第 2、5、6、8、12、14 章）：
 *  - 零硬编码色值：全 CSS class + tokens.css 变量
 *  - 零 emoji：所有图形语义由 SVG 图标承载
 *  - 流体尺寸：图谱容器高度 clamp()，面板宽度 clamp()
 *  - 玻璃态：侧边栏 surface-glass 20px / 浮动面板 surface-glass-heavy 24px
 *  - 完整三态：所有交互元素 hover/active/focus-visible
 *  - 加载态：骨架屏（与 surface-secondary 同色系，无边框）
 *  - 降级策略：API 不可达时静默切换至 mock，仅首次提示
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { GraphData, GraphEdge, GraphNode, MasteryLevel } from '@/lib/types'
import { classifyMastery, NODE_TYPE_LABELS } from '@/lib/types'
import { api } from '@/lib/api'
import { useStarMapStore } from '@/stores/starmap'
import { toast } from '@/stores/toast'
import { Icon } from '@/components/ui/Icon'
import { SectionErrorBoundary } from '@/components/ui'
import { logError } from '@/lib/errors'
import { subscribeMediaQuery } from '@/lib/media-query'
import { StarMapListView } from './StarMapListView'
import { StarMapSidebar, type CanvasView } from './StarMapSidebar'
import { buildMockGraph } from './graphMock'
import { completeExplicitRelations } from './graphRender'
import { buildUniverseScene } from './graphUniverse'
import { RelationEvidenceCard, StarMapRelationLens } from './StarMapRelationLens'
import { RELATION_LENSES, type RelationLens } from './graphRelations'
import './StarMapPage.css'

// 沉浸穹顶与详情面板按需加载；穹顶本身使用轻量原生画廊，避免为浏览诗篇加载 WebGL。
const StarMapDome = lazy(() =>
    import('./StarMapDome').then((m) => ({ default: m.StarMapDome })),
)
const NodeDetail3DPanel = lazy(() =>
    import('./NodeDetail3DPanel').then((m) => ({ default: m.NodeDetail3DPanel })),
)

/* ============================================================
 * Tooltip 常量 —— 掌握度分级标签（与 NodeDetailPanel 对齐）
 * ============================================================ */

const MASTERY_LEVEL_LABELS: Record<MasteryLevel, string> = {
    mastered: '六阶皆通',
    'high-weak': '高阶薄弱',
    'memory-stuck': '基础卡顿',
    unlearned: '尚未学习',
}

/** 统计节点关联数（无向，从 data.edges 计数） */
function countRelations(nodeId: string, edges: GraphData['edges']): number {
    let n = 0
    for (const e of edges) {
        if (e.source === nodeId || e.target === nodeId) n++
    }
    return n
}

/* ============================================================
 * 媒体查询 Hook —— matchMedia 监听断点
 * ============================================================ */

/** 监听 matchMedia 断点，SSR 安全（首渲染返回 fallback） */
function useMediaQuery(query: string, fallback = false): boolean {
    const [matches, setMatches] = useState<boolean>(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return fallback
        }
        return window.matchMedia(query).matches
    })

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return
        }
        const mql = window.matchMedia(query)
        const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
        setMatches(mql.matches)
        return subscribeMediaQuery(mql, onChange)
    }, [query])

    return matches
}

/* ============================================================
 * 加载状态机
 * ============================================================ */

type LoadStatus = 'loading' | 'loaded'

/* ============================================================
 * ESC 键关闭浮动面板（Task 15.4：ESC 等同于关闭按钮）
 * ============================================================ */

function useEscapeKey(handler: () => void, active: boolean) {
    useEffect(() => {
        if (!active) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') handler()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [handler, active])
}

/* ============================================================
 * 主页面组件
 * ============================================================ */

export function StarMapPage() {
    // 响应式断点
    const isMobile = useMediaQuery('(max-width: 767px)')
    const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

    // 路由参数：classId
    const [searchParams, setSearchParams] = useSearchParams()
    const classIdFromUrl = searchParams.get('classId') ?? ''

    // 全局 store
    const selectedNode = useStarMapStore((s) => s.selectedNode)
    const hoveredNode = useStarMapStore((s) => s.hoveredNode)
    const viewMode = useStarMapStore((s) => s.viewMode)
    const enabledTypes = useStarMapStore((s) => s.enabledTypes)
    const searchQuery = useStarMapStore((s) => s.searchQuery)
    const storeClassId = useStarMapStore((s) => s.classId)
    const usingMock = useStarMapStore((s) => s.usingMock)
    const selectNode = useStarMapStore((s) => s.selectNode)
    const setHoveredNode = useStarMapStore((s) => s.setHoveredNode)
    const setClassId = useStarMapStore((s) => s.setClassId)
    const setUsingMock = useStarMapStore((s) => s.setUsingMock)
    const refreshSignal = useStarMapStore((s) => s.refreshSignal)

    // 本地数据状态
    const [data, setData] = useState<GraphData>({ nodes: [], edges: [] })
    const [status, setStatus] = useState<LoadStatus>('loading')
    const fetchIdRef = useRef(0)
    const hasNotifiedRef = useRef(false)

    // 常规桌面仍以沉浸星图为主；小屏与“减少动态效果”环境优先进入完整、
    // 可访问的星体目录，避免尚未确认需求时加载沉浸渲染资源。教师主动切回
    // 宇宙视图后保持该选择，不能因为一次视口变化把正在探索的图谱强制切走。
    const [hasExplicitlyEnabledImmersiveView, setHasExplicitlyEnabledImmersiveView] = useState(false)
    const [canvasView, setCanvasView] = useState<CanvasView>(() => (
        isMobile || prefersReducedMotion ? 'list' : 'universe'
    ))
    const [relationLens, setRelationLens] = useState<RelationLens>('context')
    const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null)
    const [sidebarOpen, setSidebarOpen] = useState(false)
    const sidebarTriggerRef = useRef<HTMLButtonElement>(null)
    const [focusNodeId, setFocusNodeId] = useState<string | null>(null)
    // Task 15.4：浮动详情面板可见性
    const panelVisible = selectedNode !== null

    // classId 优先级：URL > store > 默认 demo
    const effectiveClassId = classIdFromUrl || storeClassId || ''
    const shouldPreferLightweightView = isMobile || prefersReducedMotion
    const isUsingLightweightView = shouldPreferLightweightView && !hasExplicitlyEnabledImmersiveView

    /* ---------- 数据加载（带三级降级） ---------- */
    const fetchData = useCallback(async () => {
        const id = ++fetchIdRef.current
        setStatus('loading')

        // 掌握度着色必须带 classId：后端 mastery-colored 要求该参数，
        // 传空串会稳定收到 400，白白浪费一次请求并在控制台留下误导性错误。
        // 班级未选定时直接走下一级（全量图谱），图谱照常显示、只是不着色。
        if (effectiveClassId) {
            try {
                const graph = await api.knowledgeGraph.masteryColored(effectiveClassId)
                if (fetchIdRef.current !== id) return
                setData(completeExplicitRelations(graph))
                setUsingMock(false)
                setStatus('loaded')
                return
            } catch (err) {
                if (import.meta.env.DEV) console.warn('[StarMap] masteryColored 降级:', err)
            }
        }

        try {
            const graph = await api.knowledgeGraph.full()
            if (fetchIdRef.current !== id) return
            setData(completeExplicitRelations(graph))
            setUsingMock(false)
            setStatus('loaded')
            return
        } catch (err) {
            if (import.meta.env.DEV) console.warn('[StarMap] full graph 降级:', err)
        }

        if (fetchIdRef.current !== id) return
        setData(completeExplicitRelations(buildMockGraph()))
        setUsingMock(true)
        setStatus('loaded')
        if (!hasNotifiedRef.current) {
            hasNotifiedRef.current = true
            toast.info({
                title: '使用演示数据',
                message: '后端图谱服务暂不可达，已切换至本地演示数据',
            })
        }
    }, [effectiveClassId, setUsingMock])

    useEffect(() => {
        if (classIdFromUrl && classIdFromUrl !== storeClassId) {
            setClassId(classIdFromUrl)
        }
        void fetchData()
    }, [classIdFromUrl, storeClassId, setClassId, fetchData])

    useEffect(() => {
        if (refreshSignal === 0) return
        void fetchData()
    }, [refreshSignal, fetchData])

    useEffect(() => {
        if (classIdFromUrl) return
        if (storeClassId) {
            const next = new URLSearchParams(searchParams)
            next.set('classId', storeClassId)
            setSearchParams(next, { replace: true })
        }
    }, [classIdFromUrl, storeClassId, searchParams, setSearchParams])

    useEffect(() => {
        if (!isUsingLightweightView) return
        setCanvasView((current) => current === 'list' ? current : 'list')
    }, [isUsingLightweightView])

    /* ---------- 回调 ---------- */
    const handleSelectNode = useCallback(
        (node: GraphNode | null) => {
            selectNode(node)
            if (node) setSelectedEdge(null)
            // 选中后让观星舱自动让出画布，详情以右侧档案浮层呈现。
            if (node && sidebarOpen) setSidebarOpen(false)
        },
        [selectNode, sidebarOpen],
    )

    const handleRelationLensChange = useCallback((lens: RelationLens) => {
        setRelationLens(lens)
        setSelectedEdge(null)
        // 关系透镜只改变关系表达，不再关闭详情或退出局部宇宙。
        // 用户可以保持当前诗篇档案，同时连续比较意象、主题与修辞网络。
    }, [])

    const handleCanvasViewChange = useCallback((nextView: CanvasView) => {
        if (nextView === 'universe') setHasExplicitlyEnabledImmersiveView(true)
        setCanvasView(nextView)
    }, [])

    const handleToggleCanvasView = useCallback(() => {
        if (canvasView === 'list') {
            setHasExplicitlyEnabledImmersiveView(true)
            setCanvasView('universe')
            return
        }
        setCanvasView('list')
    }, [canvasView])

    const handleHoverNode = useCallback(
        (node: GraphNode | null) => {
            setHoveredNode(node)
        },
        [setHoveredNode],
    )

    const handleRetry = useCallback(() => {
        hasNotifiedRef.current = false
        void fetchData()
    }, [fetchData])

    const handleExpandSubgraph = useCallback(
        (node: GraphNode) => {
            selectNode(node)
            setFocusNodeId(node.id)
            toast.info({
                title: '已进入局部宇宙',
                message: `正在探索「${node.label}」的两跳诗脉`,
            })
        },
        [selectNode],
    )

    const handleSidebarClose = useCallback(() => {
        setSidebarOpen(false)
        window.requestAnimationFrame(() => sidebarTriggerRef.current?.focus({ preventScroll: true }))
    }, [])

    const handleSidebarToggle = useCallback(() => {
        if (sidebarOpen) {
            handleSidebarClose()
            return
        }
        setSidebarOpen(true)
    }, [handleSidebarClose, sidebarOpen])

    const handleClosePanel = useCallback(() => {
        selectNode(null)
    }, [selectNode])

    const handleExitFocus = useCallback(() => {
        setFocusNodeId(null)
        setSelectedEdge(null)
    }, [])

    // ESC 键关闭浮动面板（Task 15.4）
    useEscapeKey(handleClosePanel, panelVisible)

    /* ---------- 派生数据 ---------- */
    const universeScene = useMemo(
        () => buildUniverseScene(data, enabledTypes, relationLens, focusNodeId),
        [data, enabledTypes, relationLens, focusNodeId],
    )
    // 轻量穹顶始终保留全库每一篇诗；搜索、关系透镜和局部宇宙只改变强调，
    // 不再从画廊或可访问树过滤节点，因此概览口径必须与实际卡片数一致。
    const domeNodeCount = useMemo(
        () => data.nodes.filter((node) => node.type === 'Poem').length,
        [data.nodes],
    )
    const visiblePoemNodeCount = useMemo(
        () => universeScene.graph.nodes.filter((node) => node.type === 'Poem').length,
        [universeScene.graph.nodes],
    )
    const relationLensLabel = RELATION_LENSES.find((lens) => lens.id === relationLens)?.label ?? '全部诗脉'

    /* ---------- 渲染 ---------- */

    if (status === 'loading') {
        return <StarMapSkeleton />
    }

    return (
        <div
            className="starmap-container pr-v5-enter-starmap pr-sm-layout pr-sm-universe"
            role="region"
            aria-label="诗脉星图"
        >
            <div className="pr-sm-universe-atmosphere" aria-hidden />

            <StarMapSidebar
                data={data}
                viewMode={viewMode}
                canvasView={canvasView}
                onCanvasViewChange={handleCanvasViewChange}
                usingMock={usingMock}
                isMobileOpen={sidebarOpen}
                onMobileClose={handleSidebarClose}
            />

            <main className="pr-sm-main" aria-label="星图画布主区">
                <header className="pr-sm-universe-header" aria-label="星图概览">
                    <div className="pr-sm-universe-heading">
                        <span className="pr-sm-universe-kicker">SHI MAI · POETIC DOME ARCHIVE</span>
                        <h1>诗脉 · 星图</h1>
                        <p>{focusNodeId ? `局部宇宙 · ${selectedNode?.label ?? '诗脉焦点'}` : relationLensLabel}</p>
                    </div>
                    <div className="pr-sm-universe-metrics" aria-label="星图数据口径">
                        <span data-testid="starmap-library-nodes">
                            <small>诗篇总数</small>
                            <strong>{domeNodeCount}</strong>
                            <em>首</em>
                        </span>
                        <span data-testid="starmap-visible-nodes">
                            <small>{canvasView === 'universe' ? '穹顶展示' : '当前筛选'}</small>
                            <strong>{canvasView === 'universe' ? domeNodeCount : visiblePoemNodeCount}</strong>
                            <em>首</em>
                        </span>
                        <span data-testid="starmap-visible-edges">
                            <small>当前关系</small>
                            <strong>{universeScene.graph.edges.length}</strong>
                            <em>条</em>
                        </span>
                        <span data-testid="starmap-library-edges">
                            <small>全库关系</small>
                            <strong>{universeScene.fullEdgeCount}</strong>
                            <em>条</em>
                        </span>
                    </div>
                </header>

                <div className="pr-sm-canvas-area" data-anchor data-anchor-label="诗脉图谱">
                    {canvasView === 'list' && isUsingLightweightView && (
                        <div className="pr-sm-lightweight-view-note" role="status" data-testid="starmap-lightweight-view-note">
                            <Icon name="list" size={15} aria-hidden={true} />
                            <span>
                                {prefersReducedMotion
                                    ? '已尊重“减少动态效果”设置，先使用可检索、可点选的星体目录。'
                                    : '当前为小屏设备，先使用可检索、可点选的星体目录。'}
                            </span>
                        </div>
                    )}
                    {canvasView === 'list' ? (
                        <SectionErrorBoundary
                            title="星图列表加载失败"
                            description="节点列表渲染异常，可点击重试重新加载"
                            resetKeys={[effectiveClassId]}
                            onError={(err, info) =>
                                logError('StarMapPage/StarMapListView', err, {
                                    componentStack: info.componentStack,
                                })
                            }
                        >
                            <StarMapListView data={universeScene.graph} onNodeClick={handleSelectNode} />
                        </SectionErrorBoundary>
                    ) : (
                        <div className="pr-sm-graph-wrap">
                            <SectionErrorBoundary
                                title="诗脉星图渲染失败"
                                description="沉浸穹顶渲染异常，已切换到可访问的列表视图"
                                resetKeys={[effectiveClassId, canvasView]}
                                onError={(err, info) => {
                                    logError('StarMapPage/StarMapDome', err, { componentStack: info.componentStack })
                                    setCanvasView('list')
                                }}
                            >
                                <Suspense
                                    fallback={
                                        <div className="pr-sm-skeleton pr-sm-skeleton-canvas" aria-hidden>
                                            <div className="pr-sm-skeleton-spinner">
                                                <Icon name="arrows-clockwise" size={28} />
                                                <span>正在汇聚诗歌宇宙…</span>
                                            </div>
                                        </div>
                                    }
                                >
                                    <StarMapDome
                                        data={data}
                                        viewMode={viewMode}
                                        enabledTypes={enabledTypes}
                                        searchQuery={searchQuery}
                                        selectedNode={selectedNode}
                                        onSelectNode={handleSelectNode}
                                        onHoverNode={handleHoverNode}
                                        relationLens={relationLens}
                                        onSelectEdge={setSelectedEdge}
                                        onDoubleClick={handleExpandSubgraph}
                                        focusNodeId={focusNodeId}
                                    />
                                </Suspense>
                            </SectionErrorBoundary>
                            {selectedEdge && (
                                <RelationEvidenceCard
                                    edge={selectedEdge}
                                    data={data}
                                    onClose={() => setSelectedEdge(null)}
                                />
                            )}
                        </div>
                    )}
                </div>
            </main>

            <div className="pr-sm-universe-actions" aria-label="星图工具">
                <button
                    ref={sidebarTriggerRef}
                    type="button"
                    className={sidebarOpen ? 'is-active' : ''}
                    onClick={handleSidebarToggle}
                    aria-label={sidebarOpen ? '关闭观星舱' : '打开观星舱'}
                    aria-expanded={sidebarOpen}
                    aria-controls="pr-sm-sidebar"
                >
                    <Icon name="compass" size={18} />
                    <span>观星舱</span>
                </button>
                        <button
                            type="button"
                            className={canvasView === 'list' ? 'is-active' : ''}
                            data-testid="starmap-toggle-immersive-view"
                            onClick={handleToggleCanvasView}
                            aria-label={canvasView === 'list'
                                ? (isUsingLightweightView ? '开启沉浸星图' : '返回诗境穹顶')
                                : '打开星体目录'}
                        >
                            <Icon name={canvasView === 'list' ? 'sparkle' : 'list'} size={18} />
                            <span>{canvasView === 'list'
                                ? (isUsingLightweightView ? '开启沉浸星图' : '返回宇宙')
                                : '星体目录'}
                            </span>
                        </button>
            </div>

            {canvasView === 'universe' && (
                <div className="pr-sm-universe-lens">
                    <StarMapRelationLens value={relationLens} onChange={handleRelationLensChange} />
                </div>
            )}

            {focusNodeId && canvasView === 'universe' && (
                <button type="button" className="pr-sm-universe-exit-focus" onClick={handleExitFocus}>
                    <Icon name="arrows-clockwise" size={15} />
                    退出局部宇宙
                </button>
            )}

            {panelVisible && (
                <div
                    className="pr-sm-floating-panel-overlay"
                    onClick={handleClosePanel}
                    aria-hidden
                />
            )}
            <aside
                className={`pr-sm-floating-panel${panelVisible ? ' is-visible' : ''}`}
                aria-label="节点详情"
                aria-hidden={!panelVisible}
            >
                {selectedNode && (
                    <Suspense fallback={null}>
                        <NodeDetail3DPanel
                            data={data}
                            node={selectedNode}
                            onNodeClick={handleSelectNode}
                            onClose={handleClosePanel}
                            onExpandSubgraph={handleExpandSubgraph}
                            isSubgraphActive={focusNodeId === selectedNode.id}
                        />
                    </Suspense>
                )}
            </aside>

            {/* hovered 节点的玻璃态 tooltip（仅桌面显示） */}
            {!isMobile && hoveredNode && hoveredNode.id !== selectedNode?.id && (
                <HoverTooltip
                    node={hoveredNode}
                    edgeCount={countRelations(hoveredNode.id, universeScene.graph.edges)}
                />
            )}

            {/* 使用 mock 时提供"重新加载"入口 */}
            {usingMock && (
                <button
                    type="button"
                    className="pr-sm-retry-fab"
                    onClick={handleRetry}
                    aria-label="重新加载图谱"
                    title="后端不可达，点击重试"
                >
                    <Icon name="arrows-clockwise" size={14} />
                </button>
            )}
        </div>
    )
}

/* ============================================================
 * HoverTooltip —— 玻璃态节点悬浮提示（SubTask 2.4.3）
 * ============================================================ */

interface HoverTooltipProps {
    node: GraphNode
    edgeCount: number
}

function HoverTooltip({ node, edgeCount }: HoverTooltipProps) {
    const masteryLevel = node.type === 'Poem' ? classifyMastery(node.mastery) : null
    const metaParts: string[] = []
    if (node.poet) metaParts.push(node.poet)
    if (node.dynasty) metaParts.push(node.dynasty)
    metaParts.push(NODE_TYPE_LABELS[node.type])

    return (
        <div className="pr-sm-hover-hint" role="status" aria-live="polite">
            <span className="pr-sm-hover-hint-kicker">POETIC PREVIEW · 诗境预览</span>
            <span className="pr-sm-hover-hint-title">{node.label}</span>
            {metaParts.length > 0 && (
                <div className="pr-sm-hover-hint-meta">
                    {metaParts.map((part, i) => (
                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                            {i > 0 && <span className="pr-sm-hover-hint-meta-divider" aria-hidden />}
                            {part}
                        </span>
                    ))}
                </div>
            )}
            <div className="pr-sm-hover-hint-stats">
                {masteryLevel && (
                    <span className="pr-sm-hover-hint-stat">
                        <span
                            className={`pr-sm-hover-hint-mastery-dot is-${masteryLevel}`}
                            aria-hidden
                        />
                        {MASTERY_LEVEL_LABELS[masteryLevel]}
                    </span>
                )}
                <span className="pr-sm-hover-hint-stat">
                    <Icon name="graph" size={11} />
                    点击查看 {edgeCount} 条直接关系
                </span>
            </div>
            <span className="pr-sm-hover-hint-action">点击锁定 · 双击进入局部宇宙</span>
        </div>
    )
}

/* ============================================================
 * 骨架屏（加载态）—— 与新布局对齐
 * ============================================================ */

function StarMapSkeleton() {
    return (
        <div className="starmap-container pr-v5-enter-starmap pr-sm-layout pr-sm-universe" role="region" aria-label="诗脉星图加载中" aria-busy="true">
            <div className="pr-sm-main">
                <div className="pr-sm-skeleton pr-sm-skeleton-canvas" aria-hidden>
                    <div className="pr-sm-skeleton-spinner">
                        <Icon name="arrows-clockwise" size={28} />
                        <span>正在汇聚诗歌宇宙…</span>
                    </div>
                </div>
            </div>
        </div>
    )
}
