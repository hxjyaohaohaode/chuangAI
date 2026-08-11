/**
 * 思考节点详情面板（规范第 2、4、7、14 章）
 *
 * 职责：
 *  - 展示选中思考链的元信息：问题、模型、思考模式、Token 用量、持续时长
 *  - 展示选中节点的内容：按节点类型分色徽章 + 完整文本
 *  - 节点导航：上一节点 / 下一节点按钮
 *  - 空态：未选中链或节点时显示引导文案
 *
 * 设计要点：
 *  - 零硬编码：所有色值引用 tokens.css 变量
 *  - 无硬边框：区域分隔用透明度差
 *  - Tabular Numbers：Token 数值、时长数值列对齐
 *  - 完整三态：导航按钮 hover/active
 *  - GPU 友好：动画仅 transform/opacity
 */

import { memo, useCallback } from 'react'
import { Icon } from '@/components/ui/Icon'
import type { ThinkingChain, ThinkingNode, ThinkingNodeType } from '@/lib/types'

/* ============================================================
 * 常量
 * ============================================================ */

/** 节点类型 → 中文标签 + 徽章样式类 */
const NODE_TYPE_META: Record<ThinkingNodeType, { label: string; badgeClass: string }> = {
    hypothesis: { label: '假设', badgeClass: 'node-detail__type-badge--hypothesis' },
    reasoning: { label: '推理', badgeClass: 'node-detail__type-badge--reasoning' },
    evidence: { label: '证据', badgeClass: 'node-detail__type-badge--evidence' },
    question: { label: '质疑', badgeClass: 'node-detail__type-badge--question' },
    conclusion: { label: '结论', badgeClass: 'node-detail__type-badge--conclusion' },
}

/** 持续时长格式化 */
function formatDuration(ms: number): string {
    if (!ms || !Number.isFinite(ms)) return '—'
    if (ms < 1000) return `${ms}ms`
    if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
    const min = Math.floor(ms / 60_000)
    const sec = ((ms % 60_000) / 1000).toFixed(1)
    return `${min}m${sec}s`
}

/** Token 数量格式化：> 1000 时用 k 单位 */
function formatTokens(n: number): string {
    if (!n || !Number.isFinite(n)) return '0'
    if (n < 1000) return String(n)
    return `${(n / 1000).toFixed(1)}k`
}

/* ============================================================
 * 子组件 —— 节点内容卡片
 * ============================================================ */

interface NodeContentCardProps {
    node: ThinkingNode
    isActive: boolean
    onSelect: () => void
}

const NodeContentCard = memo(function NodeContentCard({ node, isActive, onSelect }: NodeContentCardProps) {
    const meta = NODE_TYPE_META[node.type] ?? NODE_TYPE_META.reasoning
    return (
        <button
            type="button"
            className="chain-item"
            style={isActive ? { background: 'rgb(var(--c-accent-primary) / 0.12)' } : undefined}
            onClick={onSelect}
            aria-pressed={isActive}
        >
            <div className="chain-item__meta">
                <span className={`node-detail__type-badge ${meta.badgeClass}`}>
                    {meta.label}
                </span>
                <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
                    #{node.index + 1}
                </span>
            </div>
            <p
                className="chain-item__question"
                style={{ WebkitLineClamp: 3, maxHeight: 'none' }}
            >
                {node.content}
            </p>
        </button>
    )
})

/* ============================================================
 * 主组件 —— ThinkingNodeDetail
 * ============================================================ */

export interface ThinkingNodeDetailProps {
    /** 当前选中的思考链 */
    chain: ThinkingChain | null
    /** 当前选中的节点索引 */
    selectedNodeIndex: number | null
    /** 选中节点回调 */
    onSelectNode: (index: number) => void
}

export function ThinkingNodeDetail({
    chain,
    selectedNodeIndex,
    onSelectNode,
}: ThinkingNodeDetailProps) {
    /* ---------- 选中节点 ---------- */
    const selectedNode = chain && selectedNodeIndex !== null
        ? chain.nodes[selectedNodeIndex] ?? null
        : null

    /* ---------- 节点导航回调 ---------- */
    const goToPrev = useCallback(() => {
        if (!chain || selectedNodeIndex === null) return
        const prev = Math.max(0, selectedNodeIndex - 1)
        onSelectNode(prev)
    }, [chain, selectedNodeIndex, onSelectNode])

    const goToNext = useCallback(() => {
        if (!chain || selectedNodeIndex === null) return
        const next = Math.min(chain.nodes.length - 1, selectedNodeIndex + 1)
        onSelectNode(next)
    }, [chain, selectedNodeIndex, onSelectNode])

    /* ---------- 渲染：空态 ---------- */
    if (!chain) {
        return (
            <section className="node-detail" aria-label="思考节点详情">
                <header className="node-detail__header">
                    <h3 className="node-detail__title">节点详情</h3>
                </header>
                <div className="node-detail__empty">
                    <Icon name="brain" size={32} weight="regular" />
                    <span>选择左侧思考链查看详情</span>
                    <span style={{ fontSize: 'var(--text-xs)', opacity: 0.6 }}>
                        点击 3D 场景中的节点可定位到对应详情
                    </span>
                </div>
            </section>
        )
    }

    /* ---------- 渲染：选中链 ---------- */
    const selectedMeta = selectedNode ? NODE_TYPE_META[selectedNode.type] : null

    return (
        <section className="node-detail" aria-label="思考节点详情">
            <header className="node-detail__header">
                <h3 className="node-detail__title">节点详情</h3>
                {selectedMeta && (
                    <span className={`node-detail__type-badge ${selectedMeta.badgeClass}`}>
                        {selectedMeta.label}
                    </span>
                )}
            </header>

            <div className="node-detail__content">
                {/* 思考链元信息 */}
                <div className="node-detail__section">
                    <span className="node-detail__section-title">原始问题</span>
                    <p className="node-detail__text">{chain.question}</p>
                </div>

                <div className="node-detail__meta-grid">
                    <div className="node-detail__meta-item">
                        <span className="node-detail__meta-label">思考模式</span>
                        <span className="node-detail__meta-value">
                            {chain.thinkingMode}
                        </span>
                    </div>
                    <div className="node-detail__meta-item">
                        <span className="node-detail__meta-label">模型</span>
                        <span className="node-detail__meta-value">{chain.model}</span>
                    </div>
                    <div className="node-detail__meta-item">
                        <span className="node-detail__meta-label">Prompt Tokens</span>
                        <span className="node-detail__meta-value">
                            {formatTokens(chain.promptTokens)}
                        </span>
                    </div>
                    <div className="node-detail__meta-item">
                        <span className="node-detail__meta-label">Completion Tokens</span>
                        <span className="node-detail__meta-value">
                            {formatTokens(chain.completionTokens)}
                        </span>
                    </div>
                    <div className="node-detail__meta-item">
                        <span className="node-detail__meta-label">持续时长</span>
                        <span className="node-detail__meta-value">
                            {formatDuration(chain.durationMs)}
                        </span>
                    </div>
                    <div className="node-detail__meta-item">
                        <span className="node-detail__meta-label">节点数</span>
                        <span className="node-detail__meta-value">
                            {chain.nodes.length}
                        </span>
                    </div>
                </div>

                {/* 选中节点内容 */}
                {selectedNode && (
                    <div className="node-detail__section">
                        <span className="node-detail__section-title">
                            节点 #{selectedNode.index + 1} 内容
                        </span>
                        <p className="node-detail__text">{selectedNode.content}</p>
                        {selectedNode.durationMs !== undefined && (
                            <span
                                style={{
                                    fontSize: 'var(--text-2xs)',
                                    color: 'rgb(var(--c-text-tertiary))',
                                    fontVariantNumeric: 'tabular-nums',
                                }}
                            >
                                本节点耗时 {formatDuration(selectedNode.durationMs)}
                            </span>
                        )}
                    </div>
                )}

                {/* 节点导航 */}
                {chain.nodes.length > 0 && (
                    <div className="node-detail__section">
                        <span className="node-detail__section-title">节点列表</span>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
                            {chain.nodes.map((node, idx) => (
                                <NodeContentCard
                                    key={`${chain.id}-node-${idx}`}
                                    node={node}
                                    isActive={selectedNodeIndex === idx}
                                    onSelect={() => onSelectNode(idx)}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* 节点导航按钮 */}
            {chain.nodes.length > 0 && selectedNodeIndex !== null && (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 'var(--space-sm)',
                        marginTop: 'var(--space-sm)',
                        paddingTop: 'var(--space-sm)',
                        borderTop: '1px solid rgb(var(--c-text-primary) / 0.06)',
                    }}
                >
                    <button
                        onClick={goToPrev}
                        disabled={selectedNodeIndex === 0}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 'var(--space-xs)',
                            padding: 'var(--space-xs) var(--space-sm)',
                            background: 'transparent',
                            color: 'rgb(var(--c-text-secondary))',
                            border: 'none',
                            borderRadius: 'var(--radius-xs)',
                            cursor: selectedNodeIndex === 0 ? 'not-allowed' : 'pointer',
                            fontSize: 'var(--text-xs)',
                            opacity: selectedNodeIndex === 0 ? 0.4 : 1,
                        }}
                        aria-label="上一节点"
                    >
                        <Icon name="caret-left" size={14} />
                        上一节点
                    </button>
                    <span
                        style={{
                            fontSize: 'var(--text-2xs)',
                            color: 'rgb(var(--c-text-tertiary))',
                            fontVariantNumeric: 'tabular-nums',
                        }}
                    >
                        {selectedNodeIndex + 1} / {chain.nodes.length}
                    </span>
                    <button
                        onClick={goToNext}
                        disabled={selectedNodeIndex === chain.nodes.length - 1}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 'var(--space-xs)',
                            padding: 'var(--space-xs) var(--space-sm)',
                            background: 'transparent',
                            color: 'rgb(var(--c-text-secondary))',
                            border: 'none',
                            borderRadius: 'var(--radius-xs)',
                            cursor: selectedNodeIndex === chain.nodes.length - 1 ? 'not-allowed' : 'pointer',
                            fontSize: 'var(--text-xs)',
                            opacity: selectedNodeIndex === chain.nodes.length - 1 ? 0.4 : 1,
                        }}
                        aria-label="下一节点"
                    >
                        下一节点
                        <Icon name="caret-right" size={14} />
                    </button>
                </div>
            )}
        </section>
    )
}

export default ThinkingNodeDetail
