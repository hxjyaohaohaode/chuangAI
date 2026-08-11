import type { GraphData, GraphEdge, GraphNode } from '@/lib/types'
import { POEM_IMAGES, type PoemImageInfo } from '@/lib/poem-images'
import { GENERATED_POEM_IMAGE_BY_ID } from '@/lib/poem-generated-images'

export type PoetrySpherePosition = [number, number, number]

export interface PoetrySpherePresentation {
    anchors: GraphNode[]
    cards: GraphNode[]
    nodes: GraphNode[]
    positions: Map<string, PoetrySpherePosition>
    directEdges: GraphEdge[]
    fullNodeCount: number
    fullEdgeCount: number
    stageLabel: string
}

const MAX_CARDS = 148
const MAX_ANCHORS = 0
const STRUCTURAL_EDGE_TYPES = new Set(['AUTHORED_BY', 'BELONGS_TO_ERA', 'MENTORS'])

function normalizeText(value: string): string {
    return value
        .normalize('NFKC')
        .toLocaleLowerCase('zh-CN')
        .replace(/[《》〈〉「」『』【】〔〕（）()[\]·•—_\s，。！？、：；,.!?:;'"]/g, '')
}

const poemImageByTitle = new Map(
    POEM_IMAGES.map((info) => [normalizeText(info.title), info] as const),
)

/** 图谱诗 ID 与本地文化图库历史 ID 不同，因此以规范化诗名作为稳定数据键。 */
export function getPoemImageForNode(node: GraphNode): PoemImageInfo | undefined {
    if (node.type !== 'Poem') return undefined
    return poemImageByTitle.get(normalizeText(node.label))
}

/**
 * 诗篇 ID → 唯一 AI 位图。不得把一张图片复用于多个诗篇。
 * 生成任务未完成时，仅允许精确诗名命中的历史专属图片作为临时兜底；
 * 不再生成或复用通用 SVG。
 */
export function getPoetryNodeImageSource(node: GraphNode): string | undefined {
    const generated = GENERATED_POEM_IMAGE_BY_ID[node.id]
    if (generated) return generated
    const local = getPoemImageForNode(node)
    if (local) return local.imagePath
    return undefined
}

function scoreNode(node: GraphNode): number {
    const imageBonus = getPoemImageForNode(node) ? 180 : 0
    const typeBonus = node.type === 'Poem'
        ? 90
        : node.type === 'Era'
            ? 70
            : node.type === 'Poet'
                ? 55
                : 20
    return imageBonus + typeBonus + Math.min(80, node.degree ?? 0)
}

function stableNodeSort(a: GraphNode, b: GraphNode): number {
    return scoreNode(b) - scoreNode(a)
        || a.type.localeCompare(b.type)
        || a.label.localeCompare(b.label, 'zh-CN')
        || a.id.localeCompare(b.id)
}

function edgePriority(edge: GraphEdge): number {
    return STRUCTURAL_EDGE_TYPES.has(edge.type) ? 0 : 1
}

function buildAdjacency(edges: GraphEdge[]): Map<string, Set<string>> {
    const adjacency = new Map<string, Set<string>>()
    for (const edge of edges) {
        if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set())
        if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set())
        adjacency.get(edge.source)!.add(edge.target)
        adjacency.get(edge.target)!.add(edge.source)
    }
    return adjacency
}

function addUnique(target: GraphNode[], node: GraphNode | undefined, seen: Set<string>) {
    if (!node || seen.has(node.id)) return
    seen.add(node.id)
    target.push(node)
}

function selectDiversePoems(nodes: GraphNode[], edges: GraphEdge[], limit: number): GraphNode[] {
    const nodeById = new Map(nodes.map((node) => [node.id, node]))
    const poetEra = new Map<string, string>()
    const poemPoet = new Map<string, string>()

    for (const edge of edges) {
        if (edge.type === 'BELONGS_TO_ERA') {
            const source = nodeById.get(edge.source)
            const target = nodeById.get(edge.target)
            if (source?.type === 'Poet' && target?.type === 'Era') poetEra.set(source.id, target.label)
            if (target?.type === 'Poet' && source?.type === 'Era') poetEra.set(target.id, source.label)
        }
        if (edge.type === 'AUTHORED_BY') {
            const source = nodeById.get(edge.source)
            const target = nodeById.get(edge.target)
            if (source?.type === 'Poem' && target?.type === 'Poet') poemPoet.set(source.id, target.id)
            if (target?.type === 'Poem' && source?.type === 'Poet') poemPoet.set(target.id, source.id)
        }
    }

    const groups = new Map<string, GraphNode[]>()
    for (const poem of nodes.filter((node) => node.type === 'Poem').sort(stableNodeSort)) {
        const era = poem.dynasty || poetEra.get(poemPoet.get(poem.id) ?? '') || '跨时代'
        const bucket = groups.get(era) ?? []
        bucket.push(poem)
        groups.set(era, bucket)
    }

    const result: GraphNode[] = []
    const orderedGroups = [...groups.entries()]
        .sort(([, a], [, b]) => scoreNode(b[0]!) - scoreNode(a[0]!))
        .map(([, poems]) => poems)

    for (let depth = 0; result.length < limit; depth++) {
        let found = false
        for (const group of orderedGroups) {
            const poem = group[depth]
            if (!poem) continue
            result.push(poem)
            found = true
            if (result.length >= limit) break
        }
        if (!found) break
    }
    return result
}

function positionCards(cards: GraphNode[], positions: Map<string, PoetrySpherePosition>) {
    const count = Math.max(1, cards.length)
    const goldenAngle = Math.PI * (3 - Math.sqrt(5))
    const radius = count <= 12 ? 5.25 : 6.15
    const yScale = count <= 12 ? 0.72 : 0.74
    const slots: PoetrySpherePosition[] = []

    cards.forEach((_, index) => {
        const y = 1 - ((index + 0.5) / count) * 2
        const radial = Math.sqrt(Math.max(0, 1 - y * y))
        const angle = index * goldenAngle - Math.PI / 2
        slots.push([
            Math.cos(angle) * radial * radius,
            y * radius * yScale,
            Math.sin(angle) * radial * radius,
        ])
    })

    // 本地文化配图优先落在面向初始相机的半球；其余节点保留完整球面纵深。
    slots.sort((a, b) => b[2] - a[2] || a[1] - b[1])
    cards.forEach((node, index) => positions.set(node.id, slots[index]!))
}

function positionAnchors(
    anchors: GraphNode[],
    positions: Map<string, PoetrySpherePosition>,
    selectedId: string | null,
) {
    const remaining = anchors.filter((node) => node.id !== selectedId)
    remaining.forEach((node, index) => {
        const count = Math.max(1, remaining.length)
        const angle = (index / count) * Math.PI * 2 - Math.PI / 2
        positions.set(node.id, [
            Math.cos(angle) * 9.1,
            Math.sin(angle) * 3.7,
            Math.sin(angle * 2) * 1.4 - 0.45,
        ])
    })

    const selectedAnchor = anchors.find((node) => node.id === selectedId)
    if (selectedAnchor) positions.set(selectedAnchor.id, [0, 6.7, 0.25])
}

function isSearchMatch(node: GraphNode, query: string): boolean {
    const normalized = normalizeText(query)
    if (!normalized) return true
    return [
        node.label,
        node.poet,
        node.dynasty,
        node.description,
        node.content,
    ].some((value) => value && normalizeText(value).includes(normalized))
}

export function buildPoetrySpherePresentation(
    graph: GraphData,
    selectedNode: GraphNode | null,
    searchQuery: string,
): PoetrySpherePresentation {
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
    const adjacency = buildAdjacency(graph.edges)
    const anchors: GraphNode[] = []
    const cards: GraphNode[] = []
    const anchorIds = new Set<string>()
    const cardIds = new Set<string>()
    const query = searchQuery.trim()

    const addAsAnchor = (node: GraphNode | undefined) => addUnique(anchors, node, anchorIds)
    const addAsCard = (node: GraphNode | undefined) => addUnique(cards, node, cardIds)
    const selected = selectedNode ? nodeById.get(selectedNode.id) ?? null : null

    let stageLabel = '全景策展'

    if (query) {
        stageLabel = `检索“${query}”`
        const matches = graph.nodes.filter((node) => isSearchMatch(node, query)).sort(stableNodeSort)
        for (const node of matches.slice(0, MAX_CARDS + MAX_ANCHORS)) {
            if (node.type === 'Era' || node.type === 'Poet') addAsAnchor(node)
            else addAsCard(node)
        }
        for (const matched of matches.slice(0, 8)) {
            for (const id of adjacency.get(matched.id) ?? []) {
                const neighbor = nodeById.get(id)
                if (neighbor?.type === 'Era' || neighbor?.type === 'Poet') addAsAnchor(neighbor)
                else addAsCard(neighbor)
            }
        }
    } else if (selected) {
        stageLabel = `${selected.label} · 直接诗境`
        if (selected.type === 'Poem') addAsCard(selected)
        else addAsAnchor(selected)

        const directNodes = [...(adjacency.get(selected.id) ?? [])]
            .map((id) => nodeById.get(id))
            .filter((node): node is GraphNode => Boolean(node))
            .sort(stableNodeSort)

        for (const node of directNodes) {
            if (node.type === 'Era' || node.type === 'Poet') addAsAnchor(node)
            else addAsCard(node)
        }

        if (selected.type === 'Era') {
            const poets = directNodes.filter((node) => node.type === 'Poet')
            for (const poet of poets.slice(0, MAX_ANCHORS - 1)) {
                for (const id of adjacency.get(poet.id) ?? []) {
                    const node = nodeById.get(id)
                    if (node?.type === 'Poem') addAsCard(node)
                }
            }
        } else if (selected.type === 'Poet') {
            for (const node of directNodes) {
                if (node.type === 'Poem') addAsCard(node)
            }
        } else if (selected.type === 'Poem') {
            const authors = directNodes.filter((node) => node.type === 'Poet')
            for (const author of authors) {
                for (const id of adjacency.get(author.id) ?? []) {
                    const sibling = nodeById.get(id)
                    if (sibling?.type === 'Poem') addAsCard(sibling)
                }
            }
        }
    } else {
        selectDiversePoems(graph.nodes, graph.edges, MAX_CARDS).forEach(addAsCard)
    }

    // 无论处于检索、透镜或选中状态，穹顶都保留全部诗篇；
    // 相关诗篇通过排序优先进入前景，而不是把其余诗篇从空间中删除。
    graph.nodes
        .filter((node) => node.type === 'Poem')
        .sort(stableNodeSort)
        .forEach(addAsCard)

    if (cards.length === 0) {
        graph.nodes
            .filter((node) => !anchorIds.has(node.id))
            .sort(stableNodeSort)
            .slice(0, MAX_CARDS)
            .forEach(addAsCard)
    }

    const limitedAnchors = anchors
        .sort((a, b) => {
            if (a.id === selected?.id) return -1
            if (b.id === selected?.id) return 1
            return stableNodeSort(a, b)
        })
        .slice(0, MAX_ANCHORS)
    const limitedCards = cards
        .sort((a, b) => {
            if (a.id === selected?.id) return -1
            if (b.id === selected?.id) return 1
            return stableNodeSort(a, b)
        })
        .slice(0, MAX_CARDS)

    const directEdges = selected
        ? graph.edges
            .filter((edge) => edge.source === selected.id || edge.target === selected.id)
            .sort((a, b) => edgePriority(a) - edgePriority(b))
        : []

    const positions = new Map<string, PoetrySpherePosition>()
    positionCards(limitedCards, positions)
    positionAnchors(limitedAnchors, positions, selected?.id ?? null)

    return {
        anchors: limitedAnchors,
        cards: limitedCards,
        nodes: [...limitedAnchors, ...limitedCards],
        positions,
        directEdges,
        fullNodeCount: graph.nodes.length,
        fullEdgeCount: graph.edges.length,
        stageLabel,
    }
}
