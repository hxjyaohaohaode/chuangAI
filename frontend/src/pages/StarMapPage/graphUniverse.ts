import type { GraphData, GraphEdge, GraphNode, NodeType } from '@/lib/types'
import { buildAdjacency, filterGraph, simplifyGraphForDisplay } from './graphRender'
import { relationMatchesLens, type RelationLens } from './graphRelations'

const FOCUS_DEPTH = 2
const FOCUS_NODE_LIMIT = 180

export interface UniverseScene {
    graph: GraphData
    fullNodeCount: number
    fullEdgeCount: number
    filteredNodeCount: number
    filteredEdgeCount: number
    focused: boolean
}

/**
 * 页面数据指标、轻量诗篇穹顶与可选图形渲染器共用的唯一场景派生入口。
 * 任何显示在“当前视野 / 关系轨道”中的数字都直接来自这里，避免各视图
 * 分别过滤后产生口径漂移。
 */
export function buildUniverseScene(
    data: GraphData,
    enabledTypes: Set<NodeType>,
    relationLens: RelationLens,
    focusNodeId: string | null = null,
): UniverseScene {
    const filtered = filterGraph(data, enabledTypes)
    const display = simplifyGraphForDisplay(filtered)
    const lensEdges = display.edges.filter((edge) => relationMatchesLens(edge, relationLens))
    const lensNodeIds = relationLens === 'all'
        ? new Set(display.nodes.map((node) => node.id))
        : new Set(lensEdges.flatMap((edge) => [edge.source, edge.target]))

    let visibleIds = lensNodeIds
    let focused = false

    if (focusNodeId && display.nodes.some((node) => node.id === focusNodeId)) {
        // 局部宇宙的两跳范围由完整可验证图谱决定，关系透镜只负责决定
        // 其中展示哪一类边。这样切换“意象 / 主题”等透镜时不会把焦点
        // 节点连同整个局部宇宙意外清空。
        const adjacency = buildAdjacency(display.edges)
        const discovered = new Map<string, number>([[focusNodeId, 0]])
        let frontier = [focusNodeId]

        for (let depth = 1; depth <= FOCUS_DEPTH && frontier.length; depth += 1) {
            const next: string[] = []
            for (const id of frontier) {
                for (const neighbor of adjacency.get(id) ?? []) {
                    if (discovered.has(neighbor)) continue
                    discovered.set(neighbor, depth)
                    next.push(neighbor)
                }
            }
            frontier = next
        }

        const degree = new Map<string, number>()
        for (const edge of display.edges) {
            degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
            degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
        }
        const ranked = [...discovered.keys()].sort((a, b) => {
            if (a === focusNodeId) return -1
            if (b === focusNodeId) return 1
            const depthDelta = (discovered.get(a) ?? 99) - (discovered.get(b) ?? 99)
            if (depthDelta) return depthDelta
            return (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b)
        })
        visibleIds = new Set(ranked.slice(0, FOCUS_NODE_LIMIT))
        focused = true
    }

    const nodes = display.nodes.filter((node) => visibleIds.has(node.id))
    const edges = lensEdges.filter(
        (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    )

    return {
        graph: { nodes, edges },
        fullNodeCount: data.nodes.length,
        fullEdgeCount: data.edges.length,
        filteredNodeCount: filtered.nodes.length,
        filteredEdgeCount: filtered.edges.length,
        focused,
    }
}

const DYNASTY_ORDER = [
    '先秦', '汉', '三国', '魏晋', '东晋', '南北朝', '隋', '唐',
    '五代', '宋', '辽', '金', '元', '明', '清', '近现代', '现代', '当代',
] as const

function normalizedDynasty(value?: string): string {
    return (value ?? '').trim().replace(/朝代$|代$/u, '')
}

function dynastyRank(value?: string): number {
    const key = normalizedDynasty(value)
    const exact = DYNASTY_ORDER.findIndex((item) => key === item)
    if (exact >= 0) return exact
    const partial = DYNASTY_ORDER.findIndex((item) => key.includes(item) || item.includes(key))
    return partial >= 0 ? partial : DYNASTY_ORDER.length
}

function hash01(value: string, salt = 0): number {
    let hash = 2166136261 ^ salt
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0) / 4294967295
}

function average(points: ReadonlyArray<readonly [number, number, number]>): [number, number, number] {
    if (!points.length) return [0, 0, 0]
    const total = points.reduce(
        (sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]],
        [0, 0, 0],
    )
    return [total[0] / points.length, total[1] / points.length, total[2] / points.length]
}

type UniversePoint = [number, number, number]

const NODE_CLEARANCE: Record<NodeType, number> = {
    Era: 1.72,
    Poet: 1.06,
    Poem: 0.7,
    Image: 0.74,
    Theme: 0.82,
    Rhetoric: 0.76,
}

const NODE_MOBILITY: Record<NodeType, number> = {
    Era: 0,
    Poet: 0.48,
    Poem: 1,
    Image: 0.82,
    Theme: 0.76,
    Rhetoric: 0.72,
}

const VERTICAL_BANDS: Record<NodeType, readonly [number, number]> = {
    Era: [5.25, 7.2],
    Poet: [1.25, 4.8],
    Poem: [-1.75, 2.35],
    Image: [-4.1, -1.65],
    Theme: [-5.35, -2.75],
    Rhetoric: [-6.2, -3.65],
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}

/**
 * 确定性防碰撞松弛。
 *
 * 初始位置负责表达“朝代 → 诗人 → 诗篇 → 概念”的语义，松弛器只在节点
 * 低于安全间距时移动它们，并持续轻拉回语义锚点。它不会使用随机数，因此同一
 * 数据、同一透镜下的星图位置完全稳定，也不会在刷新或筛选时无意义跳变。
 */
function relaxUniversePositions(
    nodes: ReadonlyArray<GraphNode>,
    anchors: ReadonlyMap<string, UniversePoint>,
): Map<string, UniversePoint> {
    const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id))
    const result = new Map<string, UniversePoint>()
    for (const node of ordered) {
        const anchor = anchors.get(node.id) ?? [0, 0, 0]
        result.set(node.id, [...anchor])
    }

    const iterations = ordered.length > 500 ? 20 : 30
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const cooling = 1 - iteration / iterations

        for (let i = 0; i < ordered.length; i += 1) {
            const a = ordered[i]!
            const pointA = result.get(a.id)!
            for (let j = i + 1; j < ordered.length; j += 1) {
                const b = ordered[j]!
                const pointB = result.get(b.id)!
                let dx = pointB[0] - pointA[0]
                let dy = pointB[1] - pointA[1]
                let dz = pointB[2] - pointA[2]
                const minDistance = (NODE_CLEARANCE[a.type] + NODE_CLEARANCE[b.type]) * 0.5
                const mobilityA = NODE_MOBILITY[a.type]
                const mobilityB = NODE_MOBILITY[b.type]
                const totalMobility = Math.max(0.001, mobilityA + mobilityB)

                // 默认正面机位下的投影防碰撞：不能仅靠 z 深度“看似分开”。
                let screenDistance = Math.hypot(dx, dy)
                const minScreenDistance = minDistance * 0.78
                if (screenDistance < minScreenDistance) {
                    if (screenDistance < 0.0001) {
                        const angle = hash01(`${a.id}:${b.id}`, 197) * Math.PI * 2
                        dx = Math.cos(angle)
                        dy = Math.sin(angle)
                        screenDistance = 1
                    }
                    const overlap = (minScreenDistance - screenDistance) * 0.52 * cooling
                    const nx = dx / screenDistance
                    const ny = dy / screenDistance
                    const moveA = overlap * (mobilityA / totalMobility)
                    const moveB = overlap * (mobilityB / totalMobility)
                    pointA[0] -= nx * moveA
                    pointA[1] -= ny * moveA
                    pointB[0] += nx * moveB
                    pointB[1] += ny * moveB
                    dx = pointB[0] - pointA[0]
                    dy = pointB[1] - pointA[1]
                }

                let distance = Math.hypot(dx, dy, dz)
                if (distance >= minDistance) continue

                if (distance < 0.0001) {
                    const angle = hash01(`${a.id}:${b.id}`, 211) * Math.PI * 2
                    dx = Math.cos(angle)
                    dy = (hash01(`${b.id}:${a.id}`, 223) - 0.5) * 0.7
                    dz = Math.sin(angle)
                    distance = Math.hypot(dx, dy, dz)
                }

                const overlap = (minDistance - distance) * 0.56 * cooling
                const invDistance = 1 / distance
                const moveA = overlap * (mobilityA / totalMobility)
                const moveB = overlap * (mobilityB / totalMobility)
                const nx = dx * invDistance
                const ny = dy * invDistance
                const nz = dz * invDistance

                pointA[0] -= nx * moveA
                pointA[1] -= ny * moveA
                pointA[2] -= nz * moveA
                pointB[0] += nx * moveB
                pointB[1] += ny * moveB
                pointB[2] += nz * moveB
            }
        }

        for (const node of ordered) {
            if (node.type === 'Era') continue
            const point = result.get(node.id)!
            const anchor = anchors.get(node.id)!
            const anchorPull = node.type === 'Poet'
                ? 0.075
                : node.type === 'Poem'
                    ? 0.038
                    : 0.026
            point[0] += (anchor[0] - point[0]) * anchorPull
            point[1] += (anchor[1] - point[1]) * anchorPull
            point[2] += (anchor[2] - point[2]) * anchorPull

            const [minY, maxY] = VERTICAL_BANDS[node.type]
            point[1] = clamp(point[1], minY, maxY)
            point[2] = clamp(point[2], -10, 10)
        }
    }

    return result
}

/**
 * 确定性的混合语义布局：
 * 朝代沿诗史弧展开，诗人进入各自时代的空间单元，诗篇围绕作者形成稀疏星簇，
 * 概念节点由相关诗篇质心生成，最后进行不破坏语义层的全局防碰撞松弛。
 */
export function buildUniversePositions(graph: GraphData): Map<string, [number, number, number]> {
    const positions = new Map<string, UniversePoint>()
    const eras = graph.nodes
        .filter((node) => node.type === 'Era')
        .sort((a, b) => dynastyRank(a.label) - dynastyRank(b.label) || a.label.localeCompare(b.label))
    const eraByDynasty = new Map<string, GraphNode>()

    eras.forEach((era) => {
        eraByDynasty.set(normalizedDynasty(era.label), era)
    })

    const eraEdgeByNode = new Map<string, string>()
    const authorByPoem = new Map<string, string>()
    const conceptPoems = new Map<string, string[]>()
    for (const edge of graph.edges) {
        if (edge.type === 'BELONGS_TO_ERA') eraEdgeByNode.set(edge.source, edge.target)
        if (edge.type === 'AUTHORED_BY') authorByPoem.set(edge.source, edge.target)
        if (edge.type === 'USES_IMAGE' || edge.type === 'USES_THEME' || edge.type === 'USES_RHETORIC') {
            const list = conceptPoems.get(edge.target) ?? []
            list.push(edge.source)
            conceptPoems.set(edge.target, list)
        }
    }

    const poets = graph.nodes
        .filter((node) => node.type === 'Poet')
        .sort((a, b) => dynastyRank(a.dynasty) - dynastyRank(b.dynasty) || a.label.localeCompare(b.label))
    const poetsByEra = new Map<string, GraphNode[]>()
    const poetEraById = new Map<string, string>()
    for (const poet of poets) {
        const eraId = eraEdgeByNode.get(poet.id)
            ?? eraByDynasty.get(normalizedDynasty(poet.dynasty))?.id
            ?? '__unbound__'
        const list = poetsByEra.get(eraId) ?? []
        list.push(poet)
        poetsByEra.set(eraId, list)
        poetEraById.set(poet.id, eraId)
    }

    const poemCountByEra = new Map<string, number>()
    for (const poem of graph.nodes.filter((node) => node.type === 'Poem')) {
        const poetId = authorByPoem.get(poem.id) ?? poem.poetId ?? '__unbound__'
        const eraId = poetEraById.get(poetId)
            ?? eraEdgeByNode.get(poem.id)
            ?? eraByDynasty.get(normalizedDynasty(poem.dynasty))?.id
            ?? '__unbound__'
        poemCountByEra.set(eraId, (poemCountByEra.get(eraId) ?? 0) + 1)
    }

    // 高负载时代获得更宽的星域，避免唐宋等数据密集区与稀疏时代等距挤压。
    const eraCellWidth = new Map<string, number>()
    const gap = 1.05
    const cellWidths = eras.map((era) => {
        const poetCount = poetsByEra.get(era.id)?.length ?? 0
        const poemCount = poemCountByEra.get(era.id) ?? 0
        const load = poetCount + poemCount * 0.62
        const width = clamp(2.2 + Math.sqrt(Math.max(1, load)) * 0.72, 2.85, 8.8)
        eraCellWidth.set(era.id, width)
        return width
    })
    const totalEraWidth = cellWidths.reduce((sum, width) => sum + width, 0)
        + Math.max(0, eras.length - 1) * gap
    let eraCursor = -totalEraWidth / 2
    eras.forEach((era, index) => {
        const width = cellWidths[index] ?? 3
        const progress = eras.length <= 1 ? 0.5 : index / (eras.length - 1)
        positions.set(era.id, [
            eraCursor + width / 2,
            5.65 + Math.sin(progress * Math.PI) * 0.92,
            (hash01(era.id, 101) - 0.5) * 1.7,
        ])
        eraCursor += width + gap
    })

    for (const [eraId, group] of poetsByEra) {
        const eraPosition = positions.get(eraId) ?? [0, 5.8, 0]
        const availableColumns = Math.max(2, Math.floor((eraCellWidth.get(eraId) ?? 4) / 1.1))
        const columns = clamp(Math.ceil(Math.sqrt(group.length * 1.5)), 2, Math.min(7, availableColumns))
        group.forEach((poet, index) => {
            const column = index % columns
            const row = Math.floor(index / columns)
            const xOffset = (column - (columns - 1) / 2) * 1.12
            const zOffset = (hash01(poet.id, 113) - 0.5) * 7.2
            positions.set(poet.id, [
                eraPosition[0] + xOffset + (hash01(poet.id, 109) - 0.5) * 0.24,
                eraPosition[1] - 1.75 - row * 1.08,
                eraPosition[2] + zOffset,
            ])
        })
    }

    const poemsByPoet = new Map<string, GraphNode[]>()
    for (const poem of graph.nodes.filter((node) => node.type === 'Poem')) {
        const poetId = authorByPoem.get(poem.id) ?? poem.poetId ?? '__unbound__'
        const list = poemsByPoet.get(poetId) ?? []
        list.push(poem)
        poemsByPoet.set(poetId, list)
    }
    for (const [poetId, poems] of poemsByPoet) {
        const poetPosition = positions.get(poetId) ?? [0, 0.8, 0]
        poems
            .sort((a, b) => a.label.localeCompare(b.label))
            .forEach((poem, index) => {
                const shell = Math.floor(index / 6)
                const orbit = 0.72 + shell * 0.48
                const angle = index * 2.399963 + hash01(poem.id, 17) * 0.92
                positions.set(poem.id, [
                    poetPosition[0] + Math.cos(angle) * orbit,
                    poetPosition[1] - 1.0 + Math.sin(angle * 1.37) * orbit * 0.62,
                    poetPosition[2] + Math.sin(angle) * orbit * 1.38,
                ])
            })
    }

    const conceptLayer: Record<Extract<NodeType, 'Image' | 'Theme' | 'Rhetoric'>, {
        y: number
        z: number
        spread: number
    }> = {
        Image: { y: -2.35, z: -1.2, spread: 1.55 },
        Theme: { y: -3.65, z: -2.2, spread: 1.35 },
        Rhetoric: { y: -4.85, z: -3.2, spread: 1.15 },
    }
    for (const node of graph.nodes) {
        if (node.type !== 'Image' && node.type !== 'Theme' && node.type !== 'Rhetoric') continue
        const poemPositions = (conceptPoems.get(node.id) ?? [])
            .map((id) => positions.get(id))
            .filter((point): point is [number, number, number] => Boolean(point))
        const center = average(poemPositions)
        const layer = conceptLayer[node.type]
        const angle = hash01(node.id, 31) * Math.PI * 2
        const radius = (0.35 + hash01(node.id, 47)) * layer.spread
        positions.set(node.id, [
            center[0] + Math.cos(angle) * radius,
            Math.min(center[1] - 0.7, layer.y) + Math.sin(angle) * radius * 0.38,
            center[2] + layer.z + (hash01(node.id, 61) - 0.5) * 3.4,
        ])
    }

    // 极端降级：任何未归类节点仍获得确定性位置，不会落到原点叠成一团。
    for (const node of graph.nodes) {
        if (positions.has(node.id)) continue
        const angle = hash01(node.id, 73) * Math.PI * 2
        const radius = 4 + hash01(node.id, 89) * 7
        positions.set(node.id, [
            Math.cos(angle) * radius,
            (hash01(node.id, 97) - 0.5) * 8,
            Math.sin(angle) * radius,
        ])
    }

    return relaxUniversePositions(graph.nodes, positions)
}

export function edgesForNode(edges: ReadonlyArray<GraphEdge>, nodeId: string): number {
    return edges.reduce(
        (count, edge) => count + (edge.source === nodeId || edge.target === nodeId ? 1 : 0),
        0,
    )
}
