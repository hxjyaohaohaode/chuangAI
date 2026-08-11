/**
 * Responsive, semantic card grid retained behind the historical MasonryGrid API.
 *
 * Content is laid out by deterministic CSS Grid from the first paint. A single,
 * one-shot IntersectionObserver may opt into a short CSS entrance; if it is
 * unavailable, all cards remain fully visible and readable.
 */

import {
    Children,
    cloneElement,
    createContext,
    isValidElement,
    memo,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type HTMLAttributes,
    type ReactNode,
} from 'react'
import { cn } from '@/lib/cn'
import './MasonryGrid.css'

type EntranceDirection = 'top' | 'bottom' | 'left' | 'right' | 'center' | 'random'

interface MasonryContextValue {
    enhanced: boolean
    scaleOnHover: boolean
    hoverScale: number
    durationMs: number
    staggerMs: number
    timing: string
    animateFrom: EntranceDirection
    blurToFocus: boolean
}

const MasonryContext = createContext<MasonryContextValue | null>(null)
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const finite = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

const toCssTiming = (ease: string) => {
    const normalized = ease.toLowerCase()
    if (normalized.includes('inout')) return 'cubic-bezier(0.65, 0, 0.35, 1)'
    if (normalized.includes('in')) return 'cubic-bezier(0.64, 0, 0.78, 0)'
    if (normalized.includes('elastic') || normalized.includes('back')) return 'cubic-bezier(0.22, 1.35, 0.36, 1)'
    return 'cubic-bezier(0.22, 1, 0.36, 1)'
}

const resolveDirection = (direction: EntranceDirection, index: number): Exclude<EntranceDirection, 'random'> => {
    if (direction !== 'random') return direction
    return (['bottom', 'left', 'top', 'right'] as const)[index % 4] ?? 'bottom'
}

export interface MasonryItemProps extends HTMLAttributes<HTMLDivElement> {
    children?: ReactNode
    /** Whether this item participates in the optional entrance. */
    fadeIn?: boolean
    /** Extra entrance delay in milliseconds. */
    delay?: number
    /** @internal Supplied by MasonryGrid to keep stagger deterministic. */
    __masonryIndex?: number
}

export const MasonryItem = memo(function MasonryItem({
    children,
    className,
    fadeIn = true,
    delay = 0,
    __masonryIndex = 0,
    style,
    ...rest
}: MasonryItemProps) {
    const context = useContext(MasonryContext)
    const direction = resolveDirection(context?.animateFrom ?? 'bottom', __masonryIndex)
    const offset = direction === 'top'
        ? { x: '0px', y: '-22px' }
        : direction === 'left'
            ? { x: '-22px', y: '0px' }
            : direction === 'right'
                ? { x: '22px', y: '0px' }
                : { x: '0px', y: direction === 'center' ? '0px' : '22px' }
    const baseDelay = Math.max(0, finite(delay, 0)) + __masonryIndex * (context?.staggerMs ?? 0)
    const itemStyle: CSSProperties = {
        ...style,
        ['--masonry-item-delay' as string]: `${baseDelay}ms`,
        ['--masonry-item-duration' as string]: `${context?.durationMs ?? 600}ms`,
        ['--masonry-item-timing' as string]: context?.timing ?? 'cubic-bezier(0.22, 1, 0.36, 1)',
        ['--masonry-enter-x' as string]: offset.x,
        ['--masonry-enter-y' as string]: offset.y,
        ['--masonry-hover-scale' as string]: String(context?.hoverScale ?? 1),
    }

    return (
        <div
            className={cn('pr-masonry-item', className)}
            style={itemStyle}
            role="listitem"
            data-masonry-fade={fadeIn && context?.enhanced ? 'true' : undefined}
            data-masonry-blur={context?.blurToFocus ? 'true' : undefined}
            data-masonry-hover={context?.scaleOnHover ? 'true' : undefined}
            {...rest}
        >
            {children}
        </div>
    )
})

export interface MasonryGridProps extends HTMLAttributes<HTMLDivElement> {
    /** Maximum desktop column count; narrow viewports step down responsively. */
    columns?: number
    gap?: string
    /** A GSAP-style name is accepted and mapped to a bounded CSS timing curve. */
    ease?: string
    /** Entrance duration in seconds. */
    duration?: number
    /** Extra delay between cards in seconds. */
    stagger?: number
    animateFrom?: EntranceDirection
    scaleOnHover?: boolean
    hoverScale?: number
    blurToFocus?: boolean
    children?: ReactNode
}

const MasonryGridComponent = memo(function MasonryGrid({
    columns,
    gap = '12px',
    ease = 'power3.out',
    duration = 0.6,
    stagger = 0.05,
    animateFrom = 'bottom',
    scaleOnHover = true,
    hoverScale = 0.98,
    blurToFocus = true,
    className,
    children,
    style,
    ...rest
}: MasonryGridProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const [enhanced, setEnhanced] = useState(false)
    const explicitColumns = columns === undefined ? undefined : clamp(Math.round(finite(columns, 1)), 1, 5)
    const contextValue = useMemo<MasonryContextValue>(() => ({
        enhanced,
        scaleOnHover,
        hoverScale: clamp(finite(hoverScale, 0.98), 0.9, 1.04),
        durationMs: Math.round(clamp(finite(duration, 0.6), 0.18, 1.5) * 1000),
        staggerMs: Math.round(clamp(finite(stagger, 0.05), 0, 0.3) * 1000),
        timing: toCssTiming(ease),
        animateFrom,
        blurToFocus,
    }), [animateFrom, blurToFocus, duration, ease, enhanced, hoverScale, scaleOnHover, stagger])

    useEffect(() => {
        const container = containerRef.current
        if (!container || typeof IntersectionObserver === 'undefined') return
        let observer: IntersectionObserver | null = null
        try {
            observer = new IntersectionObserver(([entry]) => {
                if (!entry?.isIntersecting) return
                setEnhanced(true)
                observer?.disconnect()
            }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' })
            observer.observe(container)
        } catch {
            observer?.disconnect()
            // 基础 CSS Grid 从首帧就完整可见；观察器失败时不启用入场动画。
            return
        }
        return () => observer?.disconnect()
    }, [])

    const indexedChildren = Children.map(children, (child, index) => {
        if (!isValidElement<MasonryItemProps>(child) || child.type !== MasonryItem) return child
        return cloneElement(child, { __masonryIndex: index })
    })
    const variables: CSSProperties = {
        ...style,
        ['--masonry-gap' as string]: gap,
    }

    return (
        <MasonryContext.Provider value={contextValue}>
            <div
                ref={containerRef}
                className={cn('pr-masonry', enhanced && 'pr-masonry--enhanced', className)}
                style={variables}
                role="list"
                data-masonry-columns={explicitColumns}
                {...rest}
            >
                {indexedChildren}
            </div>
        </MasonryContext.Provider>
    )
})

export const MasonryGrid = Object.assign(MasonryGridComponent, { Item: MasonryItem })
