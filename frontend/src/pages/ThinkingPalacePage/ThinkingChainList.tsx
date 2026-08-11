/**
 * 思考链列表组件（规范第 2、4、7、14 章）
 *
 * 职责：
 *  - 展示思考链列表（ThinkingChain[]），按 createdAt 倒序
 *  - 每项显示：问题摘要 + 思考模式徽章 + 节点数 + 持续时长 + 创建时间
 *  - 选中态：左侧 accent-primary 竖线 + alpha 背景
 *  - 空态：当无思考链时显示说明文案
 *  - 滚动条样式与玻璃态主题协调
 *
 * 设计要点：
 *  - 零硬编码：所有色值引用 tokens.css 变量
 *  - 无硬边框：选中态用 alpha 背景 + 左侧 3px 竖线
 *  - Tabular Numbers：节点数、时长数值列对齐
 *  - 完整三态：item hover 上移 + 背景色变深
 *  - GPU 友好：动画仅 transform/opacity
 */

import { memo, useMemo } from 'react'
import type { ThinkingChain, ThinkingMode } from '@/lib/types'

/* ============================================================
 * 常量
 * ============================================================ */

/** 思考模式徽章文案与样式类映射 */
const MODE_META: Record<ThinkingMode, { label: string; className: string }> = {
    low: { label: '浅思', className: 'chain-item__mode-badge--low' },
    medium: { label: '中思', className: 'chain-item__mode-badge--medium' },
    high: { label: '深思', className: 'chain-item__mode-badge--high' },
    max: { label: '超思', className: 'chain-item__mode-badge--max' },
}

/** 持续时长格式化：ms → "1.2s" / "12s" / "1m20s" */
function formatDuration(ms: number): string {
    if (!ms || !Number.isFinite(ms)) return '—'
    if (ms < 1000) return `${ms}ms`
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
    const min = Math.floor(ms / 60_000)
    const sec = Math.round((ms % 60_000) / 1000)
    return `${min}m${sec}s`
}

/** 相对时间格式化 */
function formatRelativeTime(timestamp: number): string {
    if (!timestamp || !Number.isFinite(timestamp)) return '—'
    const now = Date.now()
    const diff = now - timestamp
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天前`
    try {
        return new Date(timestamp).toLocaleDateString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
        })
    } catch {
        return '—'
    }
}

/* ============================================================
 * 单条思考链卡片（memo 优化）
 * ============================================================ */

interface ChainItemProps {
    chain: ThinkingChain
    isActive: boolean
    onSelect: (chain: ThinkingChain) => void
}

const ChainItem = memo(function ChainItem({ chain, isActive, onSelect }: ChainItemProps) {
    const modeMeta = MODE_META[chain.thinkingMode] ?? MODE_META.medium
    return (
        <button
            type="button"
            className={`chain-item${isActive ? ' is-active' : ''}`}
            onClick={() => onSelect(chain)}
            aria-label={`思考链：${chain.question}`}
            aria-pressed={isActive}
        >
            <p className="chain-item__question" title={chain.question}>
                {chain.question}
            </p>
            <div className="chain-item__meta">
                <span className={`chain-item__mode-badge ${modeMeta.className}`}>
                    {modeMeta.label}
                </span>
                <span>{chain.nodes.length} 节点</span>
                <span>·</span>
                <span>{formatDuration(chain.durationMs)}</span>
                <span style={{ marginLeft: 'auto' }}>
                    {formatRelativeTime(chain.createdAt)}
                </span>
            </div>
        </button>
    )
})

/* ============================================================
 * 主组件 —— ThinkingChainList
 * ============================================================ */

export interface ThinkingChainListProps {
    /** 思考链列表 */
    chains: ThinkingChain[]
    /** 当前选中链 id */
    selectedId?: string | null
    /** 加载状态 */
    loading?: boolean
    /** 选中链回调 */
    onSelect: (chain: ThinkingChain) => void
}

export function ThinkingChainList({
    chains,
    selectedId = null,
    loading = false,
    onSelect,
}: ThinkingChainListProps) {
    /* ---------- 派生：列表计数 ---------- */
    const count = chains.length

    /* ---------- memo：列表项渲染 ---------- */
    const items = useMemo(() => {
        return chains.map((c) => (
            <ChainItem
                key={c.id}
                chain={c}
                isActive={selectedId === c.id}
                onSelect={onSelect}
            />
        ))
    }, [chains, selectedId, onSelect])

    /* ---------- 渲染 ---------- */
    return (
        <section className="chain-list" aria-label="思考链列表">
            <header className="chain-list__header">
                <h3 className="chain-list__title">思考链</h3>
                <span className="chain-list__count" aria-live="polite">
                    {count} 条
                </span>
            </header>

            {loading ? (
                <div className="chain-list__empty" aria-busy="true">
                    <span>加载中…</span>
                </div>
            ) : count === 0 ? (
                <div className="chain-list__empty">
                    <span>暂无思考链</span>
                    <span style={{ fontSize: 'var(--text-xs)', opacity: 0.6, textAlign: 'center' }}>
                        当用户与 AI 助教进行深度对话时，系统将自动记录推理过程
                    </span>
                </div>
            ) : (
                <div className="chain-list__items" role="list">
                    {items}
                </div>
            )}
        </section>
    )
}

export default ThinkingChainList
