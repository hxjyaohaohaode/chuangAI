/**
 * AnimatedList —— 交错入场列表组件
 *
 * 列表项进入视口时以 50ms 间隔交错入场（staggered）。
 * 使用原生 CSS animation + IntersectionObserver，不依赖 motion。
 *
 * 设计规范合规：
 * - staggered 每项 50ms 延迟（规范 6.3）
 * - transform/opacity 动画（不触发 Layout，GPU 合成）
 * - prefers-reduced-motion 降级：无延迟直接显示（规范 6.6）
 * - 选中态使用透明度差 + 左侧 accent 竖线（规范 7.2）
 * - hover 态背景变为 surface-tertiary（规范 7.2 列表项 hover）
 *
 * 实现要点：
 * - 列表项初始 opacity:0 + scale(0.95)，animation 默认 paused
 * - 容器进入视口后添加 .is-visible 类，子项 animation-play-state → running
 * - 通过 inline animationDelay 实现每项 50ms 交错（delay 在 paused 期间无效果）
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import type { AriaRole, ReactNode, CSSProperties } from 'react'
import { cn } from '@/lib/cn'
import { matchesMediaQuery } from '@/lib/media-query'
import './AnimatedList.css'

/** 辅助类型：将数据包装为带 id 的列表项（可选使用） */
export interface AnimatedListItem<T> {
    id: string
    data: T
}

export interface AnimatedListProps<T> {
    /** 列表项数据 */
    items: T[]
    /** 从数据中提取唯一 key 的函数 */
    getKey: (item: T, index: number) => string
    /** 渲染每项内容 */
    renderItem: (item: T, index: number) => ReactNode
    /** 选中项回调 */
    onItemSelect?: (item: T, index: number) => void
    /** 每项延迟（ms），默认 50 */
    itemDelay?: number
    /** 是否启用键盘导航，默认 false */
    enableKeyboardNav?: boolean
    /** 自定义 className */
    className?: string
    /** 每项的 className */
    itemClassName?: string
    /** 初始选中索引，默认 -1（无选中） */
    initialSelectedIndex?: number
    /** 容器的 ARIA 角色；默认静态列表为 list，可选择条目时为 group。 */
    containerRole?: AriaRole
    /** 动画包装项的 ARIA 角色；仅作动画包装时可使用 presentation。 */
    itemRole?: AriaRole
}

export function AnimatedList<T>({
    items,
    getKey,
    renderItem,
    onItemSelect,
    itemDelay = 50,
    enableKeyboardNav = false,
    className,
    itemClassName,
    initialSelectedIndex = -1,
    containerRole,
    itemRole = 'listitem',
}: AnimatedListProps<T>) {
    const safeInitialIndex = Number.isInteger(initialSelectedIndex)
        && initialSelectedIndex >= 0
        && initialSelectedIndex < items.length
        ? initialSelectedIndex
        : -1
    const itemKeys = items.map((item, index) => getKey(item, index))
    const itemKeySignature = itemKeys.map((key) => `${key.length}:${key}`).join('|')
    const initialKey = safeInitialIndex >= 0 ? itemKeys[safeInitialIndex] ?? null : null
    const containerRef = useRef<HTMLDivElement | null>(null)
    const itemRefs = useRef<Array<HTMLDivElement | null>>([])
    const [visible, setVisible] = useState(false)
    const [selectedKey, setSelectedKey] = useState<string | null>(initialKey)
    const [focusKey, setFocusKey] = useState<string | null>(initialKey ?? itemKeys[0] ?? null)

    // 进入视口时触发入场；prefers-reduced-motion 时直接可见
    useEffect(() => {
        const el = containerRef.current
        if (!el) return

        const prefersReducedMotion = matchesMediaQuery('(prefers-reduced-motion: reduce)')
        if (prefersReducedMotion) {
            setVisible(true)
            return
        }

        if (typeof IntersectionObserver !== 'function') {
            setVisible(true)
            return
        }

        let observer: IntersectionObserver
        try {
            observer = new IntersectionObserver(
                (entries) => {
                    entries.forEach((entry) => {
                        if (entry.isIntersecting) {
                            setVisible(true)
                            observer.unobserve(entry.target)
                        }
                    })
                },
                { threshold: 0.1 },
            )
        } catch {
            // 受限 WebView 的不完整 IO 实现不得让真实列表永久透明。
            setVisible(true)
            return
        }

        try {
            observer.observe(el)
        } catch {
            observer.disconnect()
            setVisible(true)
            return
        }
        return () => observer.disconnect()
    }, [])

    // 数据变化后收敛 roving tabindex 与选中索引，避免删除末项后留下不可达焦点。
    useEffect(() => {
        itemRefs.current.length = items.length
        setFocusKey((previous) => previous !== null && itemKeys.includes(previous)
            ? previous
            : itemKeys[0] ?? null)
        setSelectedKey((previous) => previous !== null && itemKeys.includes(previous) ? previous : null)
    }, [itemKeySignature, items.length])

    const moveFocus = useCallback((nextIndex: number) => {
        if (items.length === 0) return
        const bounded = Math.max(0, Math.min(items.length - 1, nextIndex))
        setFocusKey(itemKeys[bounded] ?? null)
        const focusTarget = () => itemRefs.current[bounded]?.focus({ preventScroll: true })
        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(focusTarget)
        } else {
            focusTarget()
        }
    }, [itemKeySignature, items.length])

    const handleContainerKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!enableKeyboardNav || !onItemSelect || items.length === 0) return
        const currentIndex = itemRefs.current.indexOf(event.target as HTMLDivElement)
        // 仅处理包装项自身的按键；不得截获 renderItem 内输入框或原生控件的方向键。
        if (currentIndex < 0) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            event.preventDefault()
            moveFocus(currentIndex >= items.length - 1 ? 0 : currentIndex + 1)
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            event.preventDefault()
            moveFocus(currentIndex <= 0 ? items.length - 1 : currentIndex - 1)
        } else if (event.key === 'Home') {
            event.preventDefault()
            moveFocus(0)
        } else if (event.key === 'End') {
            event.preventDefault()
            moveFocus(items.length - 1)
        }
    }, [enableKeyboardNav, items.length, moveFocus, onItemSelect])

    const handleClick = useCallback(
        (item: T, index: number) => {
            setSelectedKey(itemKeys[index] ?? null)
            onItemSelect?.(item, index)
        },
        [itemKeySignature, onItemSelect],
    )

    const isItemInteractive = Boolean(onItemSelect)
    const safeItemDelay = Number.isFinite(itemDelay)
        ? Math.max(0, Math.min(1_000, Math.round(itemDelay)))
        : 50
    const resolvedContainerRole = containerRole ?? (isItemInteractive ? 'group' : 'list')

    return (
        <div
            ref={containerRef}
            className={cn('pr-animated-list', visible && 'is-visible', className)}
            role={resolvedContainerRole}
            onKeyDown={handleContainerKeyDown}
        >
            {items.map((item, index) => {
                const key = itemKeys[index]!
                const isSelected = key === selectedKey
                return (
                    <div
                        key={key}
                        ref={(node) => { itemRefs.current[index] = node }}
                        role={isItemInteractive ? 'button' : itemRole}
                        className={cn(
                            'pr-animated-list__item',
                            isSelected && 'pr-animated-list__item--selected',
                            isItemInteractive && 'pr-animated-list__item--interactive',
                            itemClassName,
                        )}
                        style={{ animationDelay: `${Math.min(index * safeItemDelay, 1_200)}ms` } as CSSProperties}
                        onClick={isItemInteractive
                            ? (event) => {
                                const nestedControl = event.target instanceof Element
                                    ? event.target.closest(
                                        'button, a, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"]',
                                    )
                                    : null
                                if (nestedControl && nestedControl !== event.currentTarget) return
                                handleClick(item, index)
                            }
                            : undefined}
                        tabIndex={isItemInteractive
                                ? enableKeyboardNav
                                ? (key === focusKey ? 0 : -1)
                                : 0
                            : undefined}
                        onFocus={isItemInteractive ? () => setFocusKey(key) : undefined}
                        aria-pressed={isItemInteractive ? isSelected : undefined}
                        onKeyDown={isItemInteractive
                            ? (event) => {
                                if (event.target !== event.currentTarget) return
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    handleClick(item, index)
                                }
                            }
                            : undefined}
                    >
                        {renderItem(item, index)}
                    </div>
                )
            })}
        </div>
    )
}
