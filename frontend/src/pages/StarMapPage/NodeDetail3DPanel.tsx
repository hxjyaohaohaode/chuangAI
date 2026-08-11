/**
 * 诗脉星图 · 沉浸视图节点详情面板（规范第 2、4、6、14 章）
 *
 * 为兼容现有懒加载入口，文件名与组件名继续保留 NodeDetail3DPanel；
 * 当前面板服务于轻量原生诗篇画廊，不依赖 3D 或 WebGL 交互。
 *
 * 职责：
 *  - 复用 NodeDetailPanel 渲染节点详情内容（节点信息/关联节点/诗歌原文）
 *  - 在面板底部追加沉浸视图操作按钮：
 *    - "进入局部宇宙"：以当前节点为中心展开两跳诗脉
 *  - 玻璃态浮层，右侧滑入（surface-glass-heavy + backdrop-blur 24px）
 *
 * 设计要点：
 *  - 复用优先：内部渲染 NodeDetailPanel，避免代码重复
 *  - 视觉一体：footer 延续面板玻璃态，顶部用极淡 alpha 分割线（非硬边框）
 *  - 完整三态：按钮 hover/active/focus-visible（规范 7.2）
 *  - 零硬编码：所有色值引用 tokens.css 变量
 */

import { memo, useMemo } from 'react'
import type { GraphData, GraphNode } from '@/lib/types'
import { Icon } from '@/components/ui/Icon'
import '@/components/ui/icons-extended'
import { NodeDetailPanel } from './NodeDetailPanel'
import './NodeDetail3DPanel.css'

export interface NodeDetail3DPanelProps {
    /** 完整图谱数据（传递给 NodeDetailPanel 用于查找关联节点） */
    data: GraphData
    /** 当前选中节点 */
    node: GraphNode | null
    /** 点击关联节点的回调 */
    onNodeClick?: (node: GraphNode) => void
    /** 关闭面板回调 */
    onClose?: () => void
    /** 展开子图回调（以当前节点为中心） */
    onExpandSubgraph: (node: GraphNode) => void
    /** 当前节点是否已经成为局部宇宙中心 */
    isSubgraphActive?: boolean
}

/**
 * 沉浸视图专用的节点详情面板
 *
 * 包装 NodeDetailPanel，在底部追加局部宇宙操作按钮。
 * 当 node 为 null 时返回 null（不渲染任何内容）。
 */
export const NodeDetail3DPanel = memo(function NodeDetail3DPanel({
    data,
    node,
    onNodeClick,
    onClose,
    onExpandSubgraph,
    isSubgraphActive = false,
}: NodeDetail3DPanelProps) {
    const contextSummary = useMemo(() => {
        if (!node) return { relationCount: 0, poemCount: 0, conceptCount: 0 }
        const nodeById = new Map(data.nodes.map((item) => [item.id, item]))
        const relatedPoems = new Set<string>()
        const relatedConcepts = new Set<string>()
        let relationCount = 0

        data.edges.forEach((edge) => {
            if (edge.source !== node.id && edge.target !== node.id) return
            relationCount += 1
            const peerId = edge.source === node.id ? edge.target : edge.source
            const peer = nodeById.get(peerId)
            if (peer?.type === 'Poem') relatedPoems.add(peer.id)
            if (peer && ['Image', 'Theme', 'Rhetoric'].includes(peer.type)) {
                relatedConcepts.add(peer.id)
            }
        })

        return {
            relationCount,
            poemCount: relatedPoems.size,
            conceptCount: relatedConcepts.size,
        }
    }, [data.edges, data.nodes, node])

    if (!node) return null

    return (
        <div className="pr-sm3d-panel-wrapper">
            {/* 复用完整节点档案内容（节点信息/关联节点/诗歌原文/雷达图等） */}
            <NodeDetailPanel
                data={data}
                node={node}
                onNodeClick={onNodeClick}
                onClose={onClose}
            />

            {/* 沉浸视图的局部宇宙操作 */}
            <div className="pr-sm3d-panel-footer">
                <div className="pr-sm3d-panel-context">
                    <span>LIVE POETIC CONTEXT · 当前诗脉</span>
                    <p>
                        <strong>{contextSummary.relationCount}</strong> 条直接关系
                        <i />
                        <strong>{contextSummary.poemCount}</strong> 篇关联诗
                        <i />
                        <strong>{contextSummary.conceptCount}</strong> 个意象/主题
                    </p>
                    <small>
                        侧栏会保持打开；用左右方向键或横向滑动浏览，再按回车或点击诗篇切换档案
                    </small>
                </div>
                <button
                    type="button"
                    className={`pr-sm3d-panel-action pr-sm3d-panel-action--primary${isSubgraphActive ? ' is-active' : ''}`}
                    onClick={() => onExpandSubgraph(node)}
                    aria-pressed={isSubgraphActive}
                    aria-label="以当前节点为中心进入局部宇宙"
                >
                    <Icon name="graph" size={16} />
                    <span>{isSubgraphActive ? '已进入当前局部宇宙' : '进入局部宇宙'}</span>
                </button>
            </div>
        </div>
    )
})
