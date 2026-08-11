/**
 * One-shot reveal for a short sentence or a page section.
 *
 * Content starts readable before JavaScript runs.  When browser capabilities
 * permit it, a local IntersectionObserver adds a short CSS-only entrance; the
 * observer disconnects as soon as the section enters the viewport.  This
 * keeps report content independent of a scroll-animation runtime.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import './ScrollReveal.css'

export interface ScrollRevealProps {
    /** string children use word-level visual staging; other nodes use a section entrance */
    children: ReactNode
    /** Optional scroll container; omitted means the browser viewport */
    scrollContainerRef?: React.RefObject<HTMLElement>
    /** Apply blur only to text staging, default true */
    enableBlur?: boolean
    /** Initial opacity once progressive enhancement is active, default 0.1 */
    baseOpacity?: number
    /** Initial text rotation in degrees, default 3 */
    baseRotation?: number
    /** Initial text blur strength in pixels, default 4 */
    blurStrength?: number
    /** Container className */
    containerClassName?: string
    /** Text className for string children */
    textClassName?: string
    /** Compatibility input retained for callers; reveal is one-shot rather than scrubbed */
    rotationEnd?: string
    /** Compatibility input retained for callers; reveal is one-shot rather than scrubbed */
    wordAnimationEnd?: string
}

const clamp = (value: number, minimum: number, maximum: number, fallback: number) =>
    Number.isFinite(value) ? Math.min(Math.max(value, minimum), maximum) : fallback

const MAX_ANIMATED_TEXT_SEGMENTS = 80
const MAX_SEGMENTED_TEXT_LENGTH = 8_000

function segmentRevealText(text: string): ReactNode {
    if (text.length === 0 || text.length > MAX_SEGMENTED_TEXT_LENGTH) return text

    let segments: string[]
    try {
        segments = typeof Intl.Segmenter === 'function'
            ? Array.from(
                new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(text),
                (part) => part.segment,
            )
            : text.split(/(\s+)/u)
    } catch {
        segments = text.split(/(\s+)/u)
    }

    const animatedCount = segments.reduce(
        (count, segment) => count + (/^\s+$/u.test(segment) ? 0 : 1),
        0,
    )
    if (animatedCount === 0 || animatedCount > MAX_ANIMATED_TEXT_SEGMENTS) return text

    return segments.map((segment, index) => /^\s+$/u.test(segment)
        ? segment
        : <span key={`${index}-${segment}`} className="pr-scroll-reveal-word">{segment}</span>)
}

export function ScrollReveal({
    children,
    scrollContainerRef,
    enableBlur = true,
    baseOpacity = 0.1,
    baseRotation = 3,
    blurStrength = 4,
    containerClassName,
    textClassName,
    rotationEnd: _rotationEnd,
    wordAnimationEnd: _wordAnimationEnd,
}: ScrollRevealProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null)
    const [enhanced, setEnhanced] = useState(false)
    const [revealed, setRevealed] = useState(false)
    const [reducedMotion, setReducedMotion] = useState(false)
    const isTextMode = typeof children === 'string'

    const words = useMemo(() => {
        if (!isTextMode) return null
        return segmentRevealText(children as string)
    }, [children, isTextMode])

    // RefObject.current 变化本身不会触发 effect；每次父级提交后同步真实滚动根节点。
    useEffect(() => {
        const nextRoot = scrollContainerRef?.current ?? null
        setScrollRoot((previous) => previous === nextRoot ? previous : nextRoot)
    })

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            setRevealed(true)
            return
        }

        const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
        const updatePreference = () => setReducedMotion(mediaQuery.matches)
        updatePreference()
        if (typeof mediaQuery.addEventListener === 'function') {
            mediaQuery.addEventListener('change', updatePreference)
            return () => mediaQuery.removeEventListener('change', updatePreference)
        }
        if (typeof mediaQuery.addListener === 'function') {
            mediaQuery.addListener(updatePreference)
            return () => mediaQuery.removeListener?.(updatePreference)
        }
        return undefined
    }, [])

    useEffect(() => {
        const element = containerRef.current
        if (!element || reducedMotion || typeof IntersectionObserver === 'undefined') {
            setRevealed(true)
            return
        }

        let observer: IntersectionObserver
        try {
            observer = new IntersectionObserver(
                (entries) => {
                    if (!entries.some((entry) => entry.isIntersecting)) return
                    setRevealed(true)
                    observer.disconnect()
                },
                { root: scrollRoot, threshold: 0.08, rootMargin: '0px 0px -5% 0px' },
            )
        } catch {
            setEnhanced(false)
            setRevealed(true)
            return
        }
        setEnhanced(true)
        try {
            observer.observe(element)
        } catch {
            observer.disconnect()
            setEnhanced(false)
            setRevealed(true)
            return
        }
        return () => observer.disconnect()
    }, [reducedMotion, scrollRoot])

    const style = {
        '--pr-scroll-reveal-opacity': String(clamp(baseOpacity, 0, 1, 0.1)),
        '--pr-scroll-reveal-rotation': `${clamp(baseRotation, -12, 12, 3)}deg`,
        '--pr-scroll-reveal-blur': `${enableBlur ? clamp(blurStrength, 0, 16, 4) : 0}px`,
    } as CSSProperties

    return (
        <div
            ref={containerRef}
            className={cn(
                'pr-scroll-reveal-container',
                isTextMode && 'is-text',
                enhanced && 'is-enhanced',
                revealed && 'is-revealed',
                containerClassName,
            )}
            style={style}
        >
            {isTextMode
                ? <p className={cn('pr-scroll-reveal-text', textClassName)}>{words}</p>
                : children}
        </div>
    )
}
