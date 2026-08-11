/**
 * 诗脉星图 · 渲染共享逻辑
 *
 * 包含：
 *  - buildAdjacency：从边构建邻接表（用于 hover 高亮邻居）
 *  - matchSearch：搜索匹配（诗名/诗人/朝代/描述）
 *  - Canvas 颜色读取器：从 tokens.css 的 --c-* 通道派生 rgba，零硬编码
 *  - svgNodeClasses：SVG 节点 class 列表计算（视图模式 + 掌握度 + 状态）
 *
 * 设计：SVG 用 CSS class + var() 着色（原生）；Canvas 读取 --c-* RGB 通道后
 *      组装 rgba(r,g,b,a) 字符串（canvas fillStyle 不支持 var()）。
 */

import type { GraphData, GraphNode, GraphEdge, NodeType, ViewMode, MasteryLevel, EdgeType } from '@/lib/types'
import { classifyMastery } from '@/lib/types'
import { RELATION_COLORS } from './graphRelations'

/* ============================================================
 * 邻接表
 * ============================================================ */

/** source/target → Set<邻居 id>（无向） */
export function buildAdjacency(edges: ReadonlyArray<GraphEdge>): Map<string, Set<string>> {
    const adj = new Map<string, Set<string>>()
    for (const e of edges) {
        if (!adj.has(e.source)) adj.set(e.source, new Set())
        if (!adj.has(e.target)) adj.set(e.target, new Set())
        adj.get(e.source)!.add(e.target)
        adj.get(e.target)!.add(e.source)
    }
    return adj
}

/* ============================================================
 * 搜索匹配
 * ============================================================ */

/** 是否匹配搜索词（label/poet/dynasty/description 任一包含） */
export function matchSearch(node: GraphNode, query: string): boolean {
    const q = query.trim().toLowerCase()
    if (!q) return false
    const fields = [node.label, node.poet, node.dynasty, node.description].filter(Boolean) as string[]
    return fields.join(' ').toLowerCase().includes(q)
}

/* ============================================================
 * Canvas 颜色 —— 从 --c-* 通道派生 rgba
 * ============================================================ */

type RGB = [number, number, number]

function rgba(r: number, g: number, b: number, a: number): string {
    return `rgba(${r},${g},${b},${a})`
}

/** Canvas 颜色缓存 —— 一次性读取所有需要的 RGB 通道 */
export interface CanvasPalette {
    accentPrimary: RGB
    accentSuccess: RGB
    accentWarning: RGB
    accentError: RGB
    accentInfo: RGB
    textPrimary: RGB
    textTertiary: RGB
    textSecondary: RGB
    surfaceElevated: RGB
    typePoem: RGB
    typePoet: RGB
    typeImage: RGB
    typeTheme: RGB
    typeEra: RGB
    typeRhetoric: RGB
    edge: string
    edgeHighlight: string
    edgeDim: string
    /** 关系色 rgba 字符串映射（已预读取 CSS 变量），Canvas 边线绘制直接查表使用 */
    relationColors: Record<EdgeType, string>
}

/** 从指定元素读取 CSS 变量构建调色板（元素需能继承到 --c-* 与 --sm-edge-*） */
export function buildCanvasPalette(el: Element): CanvasPalette {
    const cs = getComputedStyle(el)
    const ch = (name: string): RGB => {
        const raw = cs.getPropertyValue(name).trim()
        const parts = raw.split(/\s+/)
        const n = (i: number): number => {
            const v = Number(parts[i])
            return Number.isFinite(v) ? v : 0
        }
        return [n(0), n(1), n(2)]
    }
    const readRgba = (name: string, fallback: string): string => {
        const v = cs.getPropertyValue(name).trim()
        return v || fallback
    }
    // 预读取关系色：将每个 EdgeType 对应的 CSS 变量解析为 rgba(R,G,B,1) 字符串
    const relationColors = {} as Record<EdgeType, string>
    for (const typeStr of Object.keys(RELATION_COLORS) as EdgeType[]) {
        const varName = RELATION_COLORS[typeStr]
        relationColors[typeStr] = `rgba(${ch(varName).join(',')},1)`
    }
    return {
        accentPrimary: ch('--c-accent-primary'),
        accentSuccess: ch('--c-accent-success'),
        accentWarning: ch('--c-accent-warning'),
        accentError: ch('--c-accent-error'),
        accentInfo: ch('--c-accent-info'),
        textPrimary: ch('--c-text-primary'),
        textTertiary: ch('--c-text-tertiary'),
        textSecondary: ch('--c-text-secondary'),
        surfaceElevated: ch('--c-surface-elevated'),
        typePoem: ch('--sm-poem-rgb'),
        typePoet: ch('--sm-poet-rgb'),
        typeImage: ch('--sm-image-rgb'),
        typeTheme: ch('--sm-theme-rgb'),
        typeEra: ch('--sm-era-rgb'),
        typeRhetoric: ch('--sm-rhetoric-rgb'),
        edge: readRgba('--sm-edge', 'rgba(44,36,26,0.06)'),
        edgeHighlight: readRgba('--sm-edge-highlight', 'rgba(152,98,39,0.40)'),
        edgeDim: readRgba('--sm-edge-dim', 'rgba(44,36,26,0.02)'),
        relationColors,
    }
}

/** Canvas 节点填充/描边色 —— 与 SVG CSS 着色规则完全一致 */
export function canvasNodeColors(
    node: GraphNode,
    viewMode: ViewMode,
    pal: CanvasPalette,
): { fill: string; stroke: string } {
    if (viewMode === 'mastery' && node.type === 'Poem') {
        const level: MasteryLevel = classifyMastery(node.mastery)
        switch (level) {
            case 'mastered':
                return { fill: rgba(...pal.accentSuccess, 0.40), stroke: rgba(...pal.accentSuccess, 1) }
            case 'high-weak':
                return { fill: rgba(...pal.accentWarning, 0.40), stroke: rgba(...pal.accentWarning, 1) }
            case 'memory-stuck':
                return { fill: rgba(...pal.accentError, 0.40), stroke: rgba(...pal.accentError, 1) }
            case 'unlearned':
                return { fill: rgba(...pal.textTertiary, 0.20), stroke: rgba(...pal.textTertiary, 1) }
        }
    }
    switch (node.type) {
        case 'Poem': return { fill: rgba(...pal.typePoem, 0.78), stroke: rgba(...pal.typePoem, 1) }
        case 'Poet': return { fill: rgba(...pal.typePoet, 0.9), stroke: rgba(...pal.typePoet, 1) }
        case 'Image': return { fill: rgba(...pal.typeImage, 0.74), stroke: rgba(...pal.typeImage, 1) }
        case 'Theme': return { fill: rgba(...pal.typeTheme, 0.78), stroke: rgba(...pal.typeTheme, 1) }
        case 'Era': return { fill: rgba(...pal.typeEra, 0.74), stroke: rgba(...pal.typeEra, 1) }
        case 'Rhetoric': return { fill: rgba(...pal.typeRhetoric, 0.74), stroke: rgba(...pal.typeRhetoric, 1) }
    }
}

/* ============================================================
 * SVG 节点 class 列表
 * ============================================================ */

/**
 * 计算 SVG 节点 <g> 的 class 列表
 *  - 基础：pr-sm-node pr-sm-node--{viewMode} {type}
 *  - 掌握度（仅 mastery 视图 + Poem）：mastered/high-weak/memory-stuck/unlearned
 *  - 状态：is-selected / is-match / is-neighbor / is-dimmed
 *
 * 高亮规则：
 *  - 有 hover 节点时：hover 节点本身保持，邻居 is-neighbor，其余 is-dimmed
 *  - 有搜索词时：匹配 is-match，非匹配 is-dimmed（hover 优先级更高）
 */
export function svgNodeClasses(
    node: GraphNode,
    viewMode: ViewMode,
    searchQuery: string,
    selectedId: string | null,
    hoveredId: string | null,
    neighbors: Set<string> | null,
): string {
    const cls = ['pr-sm-node', `pr-sm-node--${viewMode}`, node.type]
    if (viewMode === 'mastery' && node.type === 'Poem') {
        cls.push(classifyMastery(node.mastery))
    }
    if (selectedId === node.id) cls.push('is-selected')

    const matched = matchSearch(node, searchQuery)
    if (searchQuery.trim() && matched) cls.push('is-match')

    if (hoveredId) {
        if (node.id === hoveredId) {
            // hover 节点本身保持满透明度
        } else if (neighbors?.has(node.id)) {
            cls.push('is-neighbor')
        } else {
            cls.push('is-dimmed')
        }
    } else if (searchQuery.trim() && !matched) {
        cls.push('is-dimmed')
    }

    return cls.join(' ')
}

/** 边是否与给定节点 id 相连 */
export function edgeTouches(edge: GraphEdge, id: string): boolean {
    return edge.source === id || edge.target === id
}

/* ============================================================
 * 图谱过滤
 * ============================================================ */

/** 按启用类型过滤节点与相关边，并重算 degree */
export function filterGraph(data: GraphData, enabledTypes: Set<NodeType>): GraphData {
    const nodes = data.nodes.filter((n) => enabledTypes.has(n.type))
    const idSet = new Set(nodes.map((n) => n.id))
    const edges = data.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target))
    const deg = new Map<string, number>()
    for (const e of edges) {
        deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
        deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
    }
    return {
        nodes: nodes.map((n) => ({ ...n, degree: deg.get(n.id) ?? 0 })),
        edges,
    }
}

/**
 * 为画布保留一张可读的“教学主脉”。
 * 完整关系仍保存在页面 data 中供详情面板查询；画布只对高密度推断边做每节点限额，
 * 避免数千条同主题/同意象/同修辞关系形成不可解释的毛线团。
 *
 * 2026 深度优化：
 *  - inferredPerNode 默认从 2 提升至 4，让连线更完整（用户反馈"连线不全"）
 *  - 按关系类型分组限额（每类每节点最多 perType 条），避免某类关系独占名额
 *  - 同一节点对的多条关系全部保留（同一首诗与同一诗人的多条关系不应被裁剪）
 *  - 高权重（weight ≥ 0.85）的推断边无条件保留，体现强语义关联
 */
export function simplifyGraphForDisplay(data: GraphData, inferredPerNode = 4): GraphData {
    const directTypes = new Set<GraphEdge['type']>([
        'AUTHORED_BY',
        'BELONGS_TO_ERA',
        'USES_IMAGE',
        'USES_THEME',
        'USES_RHETORIC',
        'MENTORS',
    ])
    const direct = data.edges.filter((edge) => directTypes.has(edge.type))
    const inferred = data.edges
        .filter((edge) => !directTypes.has(edge.type))
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))

    // 每类关系每节点最多保留 perType 条（默认 2），总和不超过 inferredPerNode
    const perType = Math.max(2, Math.ceil(inferredPerNode / 2))
    const typeCounts = new Map<string, number>() // key: `${nodeId}|${type}`
    const totalCounts = new Map<string, number>() // key: nodeId
    const selected: GraphEdge[] = []
    const strongEdges: GraphEdge[] = [] // 仅保留 0–1 归一化置信度中的高置信关系

    for (const edge of inferred) {
        /*
         * 后端不同关系的 weight 单位并不相同：
         * - SIMILAR_THEME 是 0–1 Jaccard 分数
         * - SHARES_IMAGE / BORROWS_RHETORIC 是共享项数量，可能大于 1
         * 只有已经归一化到 0–1 的分数才能使用 0.85 强关系阈值，避免把
         * “共享 2 个修辞”误判成 2.0 置信度并无条件保留数千条推断边。
         */
        const weight = edge.weight
        if (typeof weight === 'number' && weight > 0 && weight <= 1 && weight >= 0.85) {
            strongEdges.push(edge)
            continue
        }
        const sKey = `${edge.source}|${edge.type}`
        const tKey = `${edge.target}|${edge.type}`
        const sTotal = totalCounts.get(edge.source) ?? 0
        const tTotal = totalCounts.get(edge.target) ?? 0
        if (sTotal >= inferredPerNode || tTotal >= inferredPerNode) continue
        const sTypeCount = typeCounts.get(sKey) ?? 0
        const tTypeCount = typeCounts.get(tKey) ?? 0
        if (sTypeCount >= perType && tTypeCount >= perType) continue
        selected.push(edge)
        typeCounts.set(sKey, sTypeCount + 1)
        typeCounts.set(tKey, tTypeCount + 1)
        totalCounts.set(edge.source, sTotal + 1)
        totalCounts.set(edge.target, tTotal + 1)
    }

    const edges = [...direct, ...strongEdges, ...selected]
    const degree = new Map<string, number>()
    for (const edge of edges) {
        degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
        degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
    }
    return {
        nodes: data.nodes.map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 })),
        edges,
    }
}

/**
 * 当接口只返回节点属性、关系边不完整时，根据明确字段补齐可验证关系。
 * 只使用 poetId / poet / dynasty / works / mentors，不做语义猜测。
 */
export function completeExplicitRelations(data: GraphData): GraphData {
    if (data.nodes.length === 0) return data

    const edges = [...data.edges]
    const edgeKeys = new Set(edges.map((edge) => `${edge.source}|${edge.target}|${edge.type}`))
    const nodeIds = new Set(data.nodes.map((node) => node.id))
    const poetsByLabel = new Map(
        data.nodes.filter((node) => node.type === 'Poet').map((node) => [node.label.trim(), node.id]),
    )
    const erasByLabel = new Map<string, string>()
    for (const node of data.nodes) {
        if (node.type !== 'Era') continue
        const label = node.label.trim().replace(/朝代$|代$/u, '')
        erasByLabel.set(label, node.id)
    }

    const add = (source: string | undefined, target: string | undefined, type: GraphEdge['type']) => {
        if (!source || !target || source === target || !nodeIds.has(source) || !nodeIds.has(target)) return
        const directKey = `${source}|${target}|${type}`
        const reverseKey = `${target}|${source}|${type}`
        if (edgeKeys.has(directKey) || edgeKeys.has(reverseKey)) return
        edgeKeys.add(directKey)
        edges.push({ source, target, type, weight: 0.72 })
    }

    for (const node of data.nodes) {
        const dynastyKey = node.dynasty?.trim().replace(/朝代$|代$/u, '')
        const eraId = dynastyKey ? erasByLabel.get(dynastyKey) : undefined

        if (node.type === 'Poem') {
            add(node.id, node.poetId ?? (node.poet ? poetsByLabel.get(node.poet.trim()) : undefined), 'AUTHORED_BY')
            add(node.id, eraId, 'BELONGS_TO_ERA')
        }

        if (node.type === 'Poet') {
            add(node.id, eraId, 'BELONGS_TO_ERA')
            for (const workId of node.works ?? []) add(workId, node.id, 'AUTHORED_BY')
            for (const mentorId of node.mentors ?? []) add(node.id, mentorId, 'MENTORS')
        }
    }

    const degree = new Map<string, number>()
    for (const edge of edges) {
        degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
        degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
    }

    return {
        nodes: data.nodes.map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 })),
        edges,
    }
}
