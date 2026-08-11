/**
 * 诗脉星图 · 移动端列表视图（SubTask 8.4）
 *
 * 当视口 <768px 时，用列表替代力导向图，保证移动端可用性。
 *
 * 功能：
 *  - 按朝代分组 Poet/Poem 节点，无朝代的节点归入"其他"
 *  - 响应搜索与类型筛选（从 store 读取）
 *  - 点击列表项选中节点（触发详情面板）
 *
 * 设计要点：
 *  - 无边框列表：行间用透明度差分隔
 *  - 分组标题：字体 display + 朝代图标
 *  - 完整三态：hover/active/focus-visible
 *  - 零硬编码：全 CSS class + tokens 变量
 */

import { memo, useMemo, useState } from 'react'
import type { GraphData, GraphNode, NodeType } from '@/lib/types'
import { NODE_TYPE_LABELS } from '@/lib/types'
import { useStarMapStore } from '@/stores/starmap'
import { matchSearch } from './graphRender'
import { Icon } from '@/components/ui/Icon'
import '@/components/ui/icons-extended'

interface ListGroup {
    key: string
    title: string
    nodes: GraphNode[]
}

/** 节点类型 → 图标 */
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

/**
 * 按朝代分组（Poet/Poem 按 dynasty 归组，其余归"其他"）
 * 同时响应类型筛选与搜索
 */
function groupForList(
    data: GraphData,
    enabledTypes: Set<NodeType>,
    searchQuery: string,
): ListGroup[] {
    const q = searchQuery.trim()
    const filtered = data.nodes.filter((n) => {
        if (!enabledTypes.has(n.type)) return false
        if (q && !matchSearch(n, q)) return false
        return true
    })

    const dynastyGroups = new Map<string, GraphNode[]>()
    const others: GraphNode[] = []

    for (const node of filtered) {
        if ((node.type === 'Poet' || node.type === 'Poem') && node.dynasty) {
            const arr = dynastyGroups.get(node.dynasty) ?? []
            arr.push(node)
            dynastyGroups.set(node.dynasty, arr)
        } else {
            others.push(node)
        }
    }

    const groups: ListGroup[] = []
    for (const [dynasty, nodes] of dynastyGroups) {
        groups.push({ key: `dynasty-${dynasty}`, title: dynasty, nodes })
    }
    if (others.length > 0) {
        groups.push({ key: 'others', title: '其他', nodes: others })
    }
    return groups
}

export interface StarMapListViewProps {
    data: GraphData
    onNodeClick?: (node: GraphNode) => void
}

export const StarMapListView = memo(function StarMapListView({ data, onNodeClick }: StarMapListViewProps) {
    const enabledTypes = useStarMapStore((s) => s.enabledTypes)
    const searchQuery = useStarMapStore((s) => s.searchQuery)
    const setSearchQuery = useStarMapStore((s) => s.setSearchQuery)
    const setAllTypes = useStarMapStore((s) => s.setAllTypes)
    const storeSelectNode = useStarMapStore((s) => s.selectNode)
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set(['__first__']))

    const groups = useMemo(
        () => groupForList(data, enabledTypes, searchQuery),
        [data, enabledTypes, searchQuery],
    )

    const handleClick = (n: GraphNode) => {
        if (onNodeClick) onNodeClick(n)
        else storeSelectNode(n)
    }

    const toggleGroup = (key: string, isFirst: boolean) => {
        setExpandedGroups((current) => {
            const next = new Set(current)
            if (next.has('__first__')) {
                next.delete('__first__')
                if (!isFirst) next.add(key)
                return next
            }
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    if (groups.length === 0) {
        // 全国一等奖冲刺：空状态四要素齐全（图标+标题+描述+CTA），防止 dead-end
        // 用户筛选/搜索后无结果时，提供一键重置入口
        const handleReset = () => {
            setSearchQuery('')
            setAllTypes(true) // 启用全部 6 种节点类型
        }
        const hasFilter = searchQuery.trim() !== '' || enabledTypes.size < 6 // 6 = Poet/Poem/Image/Theme/Era/Rhetoric 全部节点类型
        return (
            <div className="pr-sm-list-empty">
                <Icon name="magnifying-glass" size={28} />
                <p className="pr-sm-list-empty-title">
                    {hasFilter ? '星图暂无匹配节点' : '星图节点尚未加载'}
                </p>
                <p className="pr-sm-list-empty-desc">
                    {hasFilter
                        ? '当前筛选或搜索条件下未找到相关诗词节点，可重置筛选重新查看完整星图。'
                        : '图谱数据正在同步中，请稍候或检查后端图谱服务是否可用。'}
                </p>
                {hasFilter && (
                    <button
                        type="button"
                        className="pr-sm-list-empty-cta"
                        onClick={handleReset}
                    >
                        重置筛选条件
                    </button>
                )}
            </div>
        )
    }

    return (
        <div className="pr-sm-list">
            {groups.map((group, index) => {
                const expanded = Boolean(searchQuery.trim()) || expandedGroups.has(group.key) || (expandedGroups.has('__first__') && index === 0)
                return (
                <div className="pr-sm-list-group" key={group.key}>
                    <button
                        type="button"
                        className="pr-sm-list-group-header"
                        onClick={() => toggleGroup(group.key, index === 0)}
                        aria-expanded={expanded}
                    >
                        <Icon name="calendar" size={16} />
                        <h3 className="pr-sm-list-group-title">{group.title}</h3>
                        <span className="pr-sm-list-group-count">{group.nodes.length}</span>
                        <Icon name={expanded ? 'caret-up' : 'caret-down'} size={14} />
                    </button>
                    {expanded && <ul className="pr-sm-list-items">
                        {group.nodes.map((node) => (
                            <li key={node.id}>
                                <button
                                    type="button"
                                    className="pr-sm-list-item"
                                    onClick={() => handleClick(node)}
                                >
                                    <Icon name={nodeTypeIcon(node.type)} size={16} />
                                    <span className="pr-sm-list-item-title">{node.label}</span>
                                    <span className="pr-sm-list-item-meta">
                                        {NODE_TYPE_LABELS[node.type]}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>}
                </div>
                )
            })}
        </div>
    )
})
