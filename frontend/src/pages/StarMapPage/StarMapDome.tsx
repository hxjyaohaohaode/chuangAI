import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    FlyingPosters,
    type FlyingPosterItem,
} from '@/components/ui/FlyingPosters'
import { Icon } from '@/components/ui/Icon'
import type { GraphData, GraphEdge, GraphNode, NodeType, ViewMode } from '@/lib/types'
import { EDGE_TYPE_LABELS, NODE_TYPE_LABELS } from '@/lib/types'
import { buildUniverseScene } from './graphUniverse'
import { RELATION_LENSES, type RelationLens } from './graphRelations'
import {
    buildPoetrySpherePresentation,
    getPoetryNodeImageSource,
} from './poetrySphere'
import './StarMapDome.css'

interface PoemRelationTrack {
    node: GraphNode
    reason: string
    score: number
}

export interface StarMapDomeProps {
    data: GraphData
    viewMode: ViewMode
    enabledTypes: Set<NodeType>
    searchQuery: string
    selectedNode: GraphNode | null
    onSelectNode: (node: GraphNode | null) => void
    onHoverNode: (node: GraphNode | null) => void
    relationLens: RelationLens
    onSelectEdge: (edge: GraphEdge) => void
    onDoubleClick?: (node: GraphNode) => void
    focusNodeId?: string | null
}

function relationPeer(edge: GraphEdge, selectedId: string, nodeById: Map<string, GraphNode>) {
    return nodeById.get(edge.source === selectedId ? edge.target : edge.source)
}

function narrativeExcerpt(node: GraphNode): string {
    const source = node.description || node.content || node.bio || ''
    const compact = source.replace(/[#>*_\n\r]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (compact) return compact.length > 74 ? `${compact.slice(0, 74)}…` : compact
    if (node.type === 'Era') return `沿时代脉络进入${node.label}的诗人、诗篇与文化意象。`
    if (node.type === 'Poet') return `从${node.label}出发，浏览其作品、时代归属及诗意回声。`
    return `进入「${node.label}」的直接关系与诗意语境。`
}

function clampGalleryIndex(index: number, count: number): number {
    if (count <= 0 || !Number.isFinite(index)) return 0
    return Math.max(0, Math.min(count - 1, Math.trunc(index)))
}

export function StarMapDome({
    data,
    enabledTypes,
    searchQuery,
    selectedNode,
    onSelectNode,
    relationLens,
    onSelectEdge,
    onDoubleClick,
    focusNodeId = null,
}: StarMapDomeProps) {
    const scene = useMemo(
        () => buildUniverseScene(data, enabledTypes, relationLens, focusNodeId).graph,
        [data, enabledTypes, relationLens, focusNodeId],
    )
    const presentation = useMemo(
        () => buildPoetrySpherePresentation(scene, selectedNode, searchQuery),
        [scene, selectedNode, searchQuery],
    )

    // 3D 海报严格只接收同 ID 的真实位图。未完成生成的诗篇仍保留在
    // 页面原生星体目录中，但不能拿另一首诗的图片或 SVG 占位冒充。
    const galleryEntries = useMemo(
        () => data.nodes
            .filter((node) => node.type === 'Poem')
            .sort((left, right) => left.id.localeCompare(right.id))
            .flatMap((node) => {
                const src = getPoetryNodeImageSource(node)
                return src ? [{ node, src }] : []
            }),
        [data.nodes],
    )
    const nodes = useMemo(() => galleryEntries.map((entry) => entry.node), [galleryEntries])
    const nodeIndexById = useMemo(
        () => new Map(nodes.map((node, index) => [node.id, index])),
        [nodes],
    )
    const nodeById = useMemo(() => new Map(scene.nodes.map((node) => [node.id, node])), [scene.nodes])
    const edgesByNode = useMemo(() => {
        const adjacency = new Map<string, GraphEdge[]>()
        scene.edges.forEach((edge) => {
            adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge])
            adjacency.set(edge.target, [...(adjacency.get(edge.target) ?? []), edge])
        })
        return adjacency
    }, [scene.edges])
    const images = useMemo<FlyingPosterItem[]>(
        () => galleryEntries.map(({ node, src }) => ({
            id: node.id,
            src,
            alt: `${node.label}${[node.dynasty, node.poet].filter(Boolean).length > 0
                ? ` · ${[node.dynasty, node.poet].filter(Boolean).join(' · ')}`
                : ''}`,
        })),
        [galleryEntries],
    )

    const [activeIndex, setActiveIndex] = useState(0)
    const galleryRegionRef = useRef<HTMLDivElement>(null)
    const restoreFocusIndexRef = useRef<number | null>(null)
    const selectionWasOpenRef = useRef(Boolean(selectedNode))

    const safeActiveIndex = clampGalleryIndex(activeIndex, nodes.length)
    const foregroundNode = nodes[safeActiveIndex] ?? null
    const relationRoot = selectedNode?.type === 'Poem' ? selectedNode : foregroundNode
    const selectedPoemIndex = selectedNode?.type === 'Poem'
        ? nodeIndexById.get(selectedNode.id) ?? null
        : null
    const lens = RELATION_LENSES.find((item) => item.id === relationLens)
    const lensLabel = lens?.label ?? '全部诗脉'
    const lensDescription = lens?.description ?? '显示全部可验证关系'

    const focusGalleryCard = useCallback((_index: number) => {
        galleryRegionRef.current
            ?.querySelector<HTMLCanvasElement>('.pr-flying-posters__canvas')
            ?.focus({ preventScroll: true })
    }, [])

    // 外部选中诗篇时让前景与选中态同步；关闭详情后回到触发详情的准确诗篇按钮。
    useEffect(() => {
        if (selectedPoemIndex != null) {
            restoreFocusIndexRef.current = selectedPoemIndex
            setActiveIndex(selectedPoemIndex)
        }

        const selectionIsOpen = selectedNode !== null
        if (selectionWasOpenRef.current && !selectionIsOpen && restoreFocusIndexRef.current != null) {
            focusGalleryCard(restoreFocusIndexRef.current)
        }
        selectionWasOpenRef.current = selectionIsOpen
    }, [focusGalleryCard, selectedNode, selectedPoemIndex])

    const handleSelectIndex = useCallback((index: number) => {
        const safeIndex = clampGalleryIndex(index, nodes.length)
        const node = nodes[safeIndex]
        if (!node) return
        restoreFocusIndexRef.current = safeIndex
        setActiveIndex(safeIndex)
        onSelectNode(node)
    }, [nodes, onSelectNode])

    const handleActiveIndex = useCallback((index: number) => {
        setActiveIndex(clampGalleryIndex(index, nodes.length))
    }, [nodes.length])

    const visibleRelations = useMemo(() => {
        if (!selectedNode) return []
        return presentation.directEdges
            .map((edge) => ({ edge, peer: relationPeer(edge, selectedNode.id, nodeById) }))
            .filter((item): item is { edge: GraphEdge; peer: GraphNode } => Boolean(item.peer))
            .slice(0, 6)
    }, [nodeById, presentation.directEdges, selectedNode])

    const poemRelationTracks = useMemo(() => {
        if (!relationRoot) return []
        const candidates = new Map<string, PoemRelationTrack>()
        const rootEdges = edgesByNode.get(relationRoot.id) ?? []
        rootEdges.forEach((rootEdge) => {
            const peerId = rootEdge.source === relationRoot.id ? rootEdge.target : rootEdge.source
            const peer = nodeById.get(peerId)
            if (!peer) return
            if (peer.type === 'Poem' && peer.id !== relationRoot.id && nodeIndexById.has(peer.id)) {
                candidates.set(peer.id, {
                    node: peer,
                    reason: EDGE_TYPE_LABELS[rootEdge.type],
                    score: 120,
                })
                return
            }
            const connectorEdges = edgesByNode.get(peer.id) ?? []
            connectorEdges.forEach((connectorEdge) => {
                const targetId = connectorEdge.source === peer.id
                    ? connectorEdge.target
                    : connectorEdge.source
                if (targetId === relationRoot.id) return
                const target = nodeById.get(targetId)
                if (!target || target.type !== 'Poem' || !nodeIndexById.has(target.id)) return
                const score = peer.type === 'Poet'
                    ? 92
                    : peer.type === 'Theme'
                        ? 78
                        : peer.type === 'Image'
                            ? 72
                            : peer.type === 'Rhetoric'
                                ? 66
                                : 56
                const previous = candidates.get(target.id)
                if (!previous || score > previous.score) {
                    candidates.set(target.id, {
                        node: target,
                        reason: `经由${peer.label}`,
                        score,
                    })
                }
            })
        })
        return [...candidates.values()]
            .sort((left, right) => right.score - left.score || left.node.label.localeCompare(right.node.label))
            .slice(0, 5)
    }, [edgesByNode, nodeById, nodeIndexById, relationRoot])

    const emphasizedIndices = useMemo(() => {
        if (relationLens === 'all' && !focusNodeId) return undefined

        const emphasizedPoemIds = focusNodeId
            ? new Set([
                ...(selectedNode?.type === 'Poem' ? [selectedNode.id] : []),
                ...poemRelationTracks.map((track) => track.node.id),
            ])
            : new Set(
                scene.nodes
                    .filter((node) => node.type === 'Poem')
                    .map((node) => node.id),
            )

        const matchingIndices = nodes.flatMap((node, index) => (
            emphasizedPoemIds.has(node.id) ? [index] : []
        ))
        // 通用画廊把空强调集解释为“不启用弱化”。筛选确实无匹配时仍保留
        // 当前前景作为视觉锚点，但不会从 DOM 或可访问树删除任何其他诗篇。
        if (matchingIndices.length > 0 || nodes.length === 0) return matchingIndices
        return [selectedPoemIndex ?? safeActiveIndex]
    }, [focusNodeId, nodes, poemRelationTracks, relationLens, safeActiveIndex, scene.nodes, selectedNode, selectedPoemIndex])
    const emphasizedPoemCount = emphasizedIndices?.length ?? nodes.length

    return (
        <div
            className={`pr-sm-dome${selectedNode ? ' has-selection' : ''}`}
            data-relation-lens={relationLens}
            role="region"
            aria-label="诗境穹顶"
        >
            <div className="pr-sm-dome-grain" aria-hidden />
            <div className="pr-sm-dome-orbit pr-sm-dome-orbit--outer" aria-hidden />
            <div className="pr-sm-dome-orbit pr-sm-dome-orbit--inner" aria-hidden />

            <div ref={galleryRegionRef} className="pr-sm-dome-gallery-region">
                <FlyingPosters
                    items={images}
                    className="pr-sm-dome-gallery"
                    ariaLabel="3D 旋转诗境画廊"
                    activeIndex={safeActiveIndex}
                    distortion={0}
                    planeWidth={440}
                    planeHeight={248}
                    onActivate={handleSelectIndex}
                    onActiveIndexChange={handleActiveIndex}
                />
            </div>

            {nodes.length === 0 && (
                <p className="pr-sm-dome-empty" role="status">当前数据中暂无可展示的诗篇</p>
            )}

            {selectedNode && relationRoot && (
                <section
                    key={`${relationLens}:${focusNodeId ?? 'archive'}`}
                    className="pr-sm-dome-relation-status"
                    aria-labelledby="pr-sm-dome-relation-heading"
                >
                    <div className="pr-sm-dome-relation-status-heading">
                        <h3 id="pr-sm-dome-relation-heading">
                            {focusNodeId ? 'LOCAL UNIVERSE' : 'RELATION LENS'} · {lensLabel}
                        </h3>
                        <strong>{scene.edges.length} 条证据</strong>
                    </div>
                    <p>
                        {lensDescription}；当前强调 {emphasizedPoemCount} 篇诗，
                        「{relationRoot.label}」关联诗篇 {poemRelationTracks.length} 篇。
                    </p>
                    <i aria-hidden>
                        <b
                            style={{
                                width: `${Math.max(
                                    4,
                                    Math.min(100, (emphasizedPoemCount / Math.max(nodes.length, 1)) * 100),
                                )}%`,
                            }}
                        />
                    </i>
                </section>
            )}

            {foregroundNode && (
                <>
                    <section className="pr-sm-dome-foreground">
                        <span>
                            {String(safeActiveIndex + 1).padStart(2, '0')}
                            <i />
                            {String(nodes.length).padStart(2, '0')}
                        </span>
                        <p>{lensLabel} · {NODE_TYPE_LABELS[foregroundNode.type]}</p>
                        <h2>{foregroundNode.label}</h2>
                        <small>
                            {[foregroundNode.dynasty, foregroundNode.poet].filter(Boolean).join(' · ')
                                || presentation.stageLabel}
                        </small>
                    </section>

                    <aside className="pr-sm-dome-narrative">
                        <span>FOREGROUND POETIC NODE</span>
                        <p>{narrativeExcerpt(foregroundNode)}</p>
                        <button type="button" onClick={() => handleSelectIndex(safeActiveIndex)}>
                            查看诗脉
                            <Icon name="arrow-square-out" size={14} />
                        </button>
                    </aside>

                    <button
                        type="button"
                        className="pr-sm-dome-focus-button"
                        onClick={() => handleSelectIndex(safeActiveIndex)}
                        aria-label={`查看${foregroundNode.label}的直接关系`}
                    >
                        <Icon name="arrow-square-out" size={20} />
                    </button>
                </>
            )}

            {selectedNode && relationRoot && poemRelationTracks.length > 0 && (
                <section className="pr-sm-dome-poem-relations" aria-labelledby="pr-sm-dome-poem-relations-heading">
                    <h3 id="pr-sm-dome-poem-relations-heading">
                        与「{relationRoot.label}」相关的诗篇
                    </h3>
                    <ol>
                        {poemRelationTracks.map((track) => {
                            const index = nodeIndexById.get(track.node.id)
                            if (index == null) return null
                            return (
                                <li key={track.node.id}>
                                    <button
                                        type="button"
                                        onFocus={() => setActiveIndex(index)}
                                        onClick={() => handleSelectIndex(index)}
                                    >
                                        <small>{track.reason}</small>
                                        <strong>{track.node.label}</strong>
                                    </button>
                                </li>
                            )
                        })}
                    </ol>
                </section>
            )}

            {selectedNode && visibleRelations.length > 0 && (
                <section className="pr-sm-dome-relations" aria-labelledby="pr-sm-dome-direct-relations-heading">
                    <h3 id="pr-sm-dome-direct-relations-heading">
                        「{selectedNode.label}」的直接关系 · {visibleRelations.length}
                    </h3>
                    <ul>
                        {visibleRelations.map(({ edge, peer }) => (
                            <li key={`${edge.source}:${edge.type}:${edge.target}`}>
                                <button type="button" onClick={() => onSelectEdge(edge)}>
                                    <small>{EDGE_TYPE_LABELS[edge.type]}</small>
                                    <strong>{peer.label}</strong>
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <div className="pr-sm-dome-controls" role="group" aria-label="局部宇宙控制">
                <button
                    type="button"
                    className={focusNodeId ? 'is-active' : undefined}
                    onClick={() => foregroundNode && onDoubleClick?.(foregroundNode)}
                    disabled={!foregroundNode}
                    aria-pressed={Boolean(focusNodeId)}
                    aria-label={focusNodeId ? '当前处于局部宇宙' : '进入当前诗篇的局部宇宙'}
                    title={focusNodeId ? '当前处于局部宇宙' : '进入局部宇宙'}
                >
                    <Icon name="graph" size={14} />
                </button>
            </div>

            <div className="pr-sm-dome-instruction" aria-hidden>
                <i />
                方向键浏览 · Enter 追溯 · 关系列表直达证据
            </div>
        </div>
    )
}
