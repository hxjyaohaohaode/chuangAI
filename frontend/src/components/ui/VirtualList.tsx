/**
 * VirtualList —— 自研虚拟列表组件（SubTask 25.2）
 *
 * 设计依据：
 * - 任务要求：每项 80px 高，固定容器 calc(100vh - 200px)，缓冲区上下各 5 项
 * - 性能：React.memo + useCallback，避免重渲染
 * - 平滑：CSS scroll-behavior: smooth
 * - GPU 友好：transform 定位
 *
 * 实现要点：
 * - 容器固定高度，内部用 padding 撑开总高度（itemCount × itemHeight）
 * - 监听 scrollTop，计算可见区间 [start, end]，buffer 上下各 5 项
 * - 可见项用 transform: translateY 定位（避免触发 layout）
 * - 节流滚动事件（100ms）避免高频重算
 * - 传入 renderItem 回调渲染每一项
 *
 * 用法：
 *   <VirtualList
 *     items={templates}
 *     itemHeight={80}
 *     renderItem={(item, index) => <TemplateCard item={item} />}
 *   />
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observeElementResize } from '@/lib/resize-observer'
import './VirtualList.css'

/** 默认每项高度（px），任务规定 80px */
const DEFAULT_ITEM_HEIGHT = 80

/** 默认缓冲区项数，任务规定上下各 5 项 */
const DEFAULT_BUFFER = 5

/** 默认容器高度（CSS 字符串），任务规定 calc(100vh - 200px) */
const DEFAULT_CONTAINER_HEIGHT = 'calc(100vh - 200px)'

/** 滚动事件节流时长（ms），规范 15.3 ResizeObserver debounce 100ms，对齐 */
const SCROLL_THROTTLE_MS = 100

export interface VirtualListProps<T> {
    /** 数据项数组 */
    items: T[]
    /** 每项高度（px），默认 80 */
    itemHeight?: number
    /** 缓冲区项数（上下各 N 项），默认 5 */
    buffer?: number
    /** 容器高度（CSS 字符串），默认 calc(100vh - 200px) */
    containerHeight?: string
    /** 渲染每一项的回调 */
    renderItem: (item: T, index: number) => React.ReactNode
    /** 空状态渲染回调（可选） */
    renderEmpty?: () => React.ReactNode
    /** 加载态渲染回调（可选） */
    renderLoading?: () => React.ReactNode
    /** 是否加载中（为 true 时显示 renderLoading） */
    loading?: boolean
    /** 键名提取函数（用于 React key，提升 diff 性能） */
    getKey?: (item: T, index: number) => string | number
    /** 自定义类名 */
    className?: string
    /** 滚动到指定索引（受控，可选） */
    scrollToIndex?: number
    /** 滚动事件回调（节流后触发） */
    onScroll?: (scrollTop: number) => void
}

/**
 * 自研虚拟列表组件
 *
 * - 仅渲染可见区域 + 上下缓冲区项，O(buffer × 2 + visibleCount) 复杂度
 * - 滚动事件节流 100ms，避免高频 setState
 * - React.memo + useCallback 阻断不必要重渲染
 */
function VirtualListInner<T>({
    items,
    itemHeight = DEFAULT_ITEM_HEIGHT,
    buffer = DEFAULT_BUFFER,
    containerHeight = DEFAULT_CONTAINER_HEIGHT,
    renderItem,
    renderEmpty,
    renderLoading,
    loading = false,
    getKey,
    className,
    scrollToIndex,
    onScroll,
}: VirtualListProps<T>) {
    const containerRef = useRef<HTMLDivElement>(null)
    const [scrollTop, setScrollTop] = useState(0)
    const [viewportHeight, setViewportHeight] = useState(0)
    // 节流时间戳
    const lastScrollTimeRef = useRef(0)
    // 缓存上一次 onScroll 调用的时间戳
    const lastOnScrollCallRef = useRef(0)

    // 测量视口高度（ResizeObserver debounce 100ms，规范 15.3）
    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        // 初始测量
        setViewportHeight(container.clientHeight)

        let debounceTimer: number | null = null

        const stopObserving = observeElementResize(container, () => {
            // debounce 100ms
            if (debounceTimer !== null) {
                window.clearTimeout(debounceTimer)
            }
            debounceTimer = window.setTimeout(() => {
                if (container) {
                    setViewportHeight(container.clientHeight)
                }
            }, 100)
        })

        return () => {
            stopObserving()
            if (debounceTimer !== null) window.clearTimeout(debounceTimer)
        }
    }, [])

    // 节流滚动监听
    const handleScroll = useCallback(
        (e: React.UIEvent<HTMLDivElement>) => {
            const now = Date.now()
            const target = e.currentTarget
            // 节流：100ms 内只触发一次 setState
            if (now - lastScrollTimeRef.current < SCROLL_THROTTLE_MS) {
                return
            }
            lastScrollTimeRef.current = now
            setScrollTop(target.scrollTop)

            // 外部 onScroll 回调节流
            if (onScroll) {
                if (now - lastOnScrollCallRef.current < SCROLL_THROTTLE_MS) return
                lastOnScrollCallRef.current = now
                onScroll(target.scrollTop)
            }
        },
        [onScroll],
    )

    // 受控滚动：scrollToIndex 变化时滚动到指定项
    useEffect(() => {
        if (scrollToIndex === undefined || scrollToIndex < 0) return
        const container = containerRef.current
        if (!container) return
        const targetTop = scrollToIndex * itemHeight
        // 平滑滚动（CSS scroll-behavior: smooth 已设置，但 scrollTo 仍需指定 behavior）
        container.scrollTo({ top: targetTop, behavior: 'smooth' })
    }, [scrollToIndex, itemHeight])

    // 计算可见区间（含缓冲区）
    const { startIdx, endIdx, totalHeight, offsetY } = useMemo(() => {
        const total = items.length * itemHeight
        const firstVisible = Math.max(0, Math.floor(scrollTop / itemHeight) - buffer)
        const visibleCount = Math.ceil(viewportHeight / itemHeight) + buffer * 2
        const lastVisible = Math.min(items.length - 1, firstVisible + visibleCount)
        return {
            startIdx: firstVisible,
            endIdx: lastVisible,
            totalHeight: total,
            // 用 padding-top 撑开滚动区，可见项相对 padding 定位
            offsetY: firstVisible * itemHeight,
        }
    }, [items.length, itemHeight, scrollTop, viewportHeight, buffer])

    // 渲染可见项
    const visibleItems = useMemo(() => {
        if (loading || items.length === 0) return []
        const result: Array<{ item: T; index: number; key: string | number }> = []
        for (let i = startIdx; i <= endIdx; i++) {
            const item = items[i]
            if (!item) continue
            const key = getKey ? getKey(item, i) : i
            result.push({ item, index: i, key })
        }
        return result
    }, [items, startIdx, endIdx, loading, getKey])

    // 加载态
    if (loading && renderLoading) {
        return (
            <div
                className={`pr-virtual-list pr-virtual-list--loading ${className ?? ''}`}
                style={{ height: containerHeight }}
            >
                {renderLoading()}
            </div>
        )
    }

    // 空状态
    if (!loading && items.length === 0 && renderEmpty) {
        return (
            <div
                className={`pr-virtual-list pr-virtual-list--empty ${className ?? ''}`}
                style={{ height: containerHeight }}
            >
                {renderEmpty()}
            </div>
        )
    }

    return (
        <div
            ref={containerRef}
            className={`pr-virtual-list ${className ?? ''}`}
            style={{ height: containerHeight }}
            onScroll={handleScroll}
            role="list"
            aria-label="虚拟列表"
        >
            {/* 撑开总高度，保证滚动条正确 */}
            <div
                className="pr-virtual-list-spacer"
                style={{ height: totalHeight, position: 'relative' }}
                aria-hidden
            >
                {/* 可见项容器：用 transform 定位，避免触发 layout */}
                <div
                    className="pr-virtual-list-viewport"
                    style={{ transform: `translateY(${offsetY}px)` }}
                >
                    {visibleItems.map(({ item, index, key }) => (
                        <div
                            key={key}
                            className="pr-virtual-list-item"
                            style={{ height: itemHeight }}
                            role="listitem"
                        >
                            {renderItem(item, index)}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}

// React.memo 阻断不必要重渲染（浅比较 props）
export const VirtualList = memo(VirtualListInner) as <T>(
    props: VirtualListProps<T>,
) => React.ReactElement

export type VirtualListPropsOf<T> = VirtualListProps<T>
