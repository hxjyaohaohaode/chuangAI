/**
 * A deterministic, word-level title entrance.
 *
 * The component intentionally remains useful before enhancement: all text is
 * rendered as ordinary React content first. Animation is a short CSS-only
 * flourish, never a prerequisite for reading a poem title or using the page.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { subscribeMediaQuery } from '@/lib/media-query'
import './FallingText.css'

export interface FallingTextProps {
    text: string
    highlightWords?: string[]
    highlightClass?: string
    trigger?: 'click' | 'hover' | 'auto' | 'scroll'
    backgroundColor?: string
    /** Retained for visual-debug compatibility; outlines tokens instead of physics bodies. */
    wireframes?: boolean
    /** Controls the entrance travel energy, safely clamped to a visual range. */
    gravity?: number
    /** Controls word stagger density, safely clamped to a visual range. */
    mouseConstraintStiffness?: number
    fontSize?: string
    wordSpacing?: string
    className?: string
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const finite = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

const tokenize = (text: string) => text.split(/\s+/u).filter(Boolean)

export function FallingText({
    text,
    highlightWords = [],
    highlightClass = 'pr-falling-text--highlighted',
    trigger = 'auto',
    backgroundColor = 'transparent',
    wireframes = false,
    gravity = 1,
    mouseConstraintStiffness = 0.2,
    fontSize = '1rem',
    wordSpacing = '2px',
    className = '',
}: FallingTextProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const [reducedMotion, setReducedMotion] = useState(() => (
        typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ))
    const [runId, setRunId] = useState(0)
    const [isAnimating, setIsAnimating] = useState(false)
    const words = useMemo(() => tokenize(text), [text])
    const normalizedHighlights = useMemo(
        () => highlightWords.map((word) => word.trim()).filter(Boolean),
        [highlightWords],
    )

    const safeGravity = clamp(finite(gravity, 1), 0, 3)
    const safeStiffness = clamp(finite(mouseConstraintStiffness, 0.2), 0, 1)
    const staggerMs = Math.round(64 + (1 - safeStiffness) * 72)
    const durationMs = Math.round(720 - safeGravity * 110)

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
        const media = window.matchMedia('(prefers-reduced-motion: reduce)')
        const update = () => setReducedMotion(media.matches)
        update()
        return subscribeMediaQuery(media, update)
    }, [])

    const begin = useCallback(() => {
        if (reducedMotion || words.length === 0) return
        setRunId((value) => value + 1)
        setIsAnimating(true)
    }, [reducedMotion, words.length])

    useEffect(() => {
        if (trigger === 'auto') begin()
    }, [begin, text, trigger])

    useEffect(() => {
        if (reducedMotion) {
            setIsAnimating(false)
            return
        }
        if (trigger !== 'scroll' || !containerRef.current || typeof IntersectionObserver === 'undefined') return

        let observer: IntersectionObserver | null = null
        try {
            observer = new IntersectionObserver(([entry]) => {
                if (!entry?.isIntersecting) return
                begin()
                observer?.disconnect()
            }, { threshold: 0.18 })
            observer.observe(containerRef.current)
        } catch {
            observer?.disconnect()
            // 滚动触发只是装饰性增强；受限 WebView 保留完整静态文本。
            return
        }
        return () => observer?.disconnect()
    }, [begin, reducedMotion, trigger])

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (trigger !== 'click' || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        begin()
    }

    const containerStyle: CSSProperties = {
        backgroundColor,
        ['--falling-text-font-size' as string]: fontSize,
        ['--falling-text-word-gap' as string]: wordSpacing,
        ['--falling-text-duration' as string]: `${Math.max(360, durationMs)}ms`,
    }

    return (
        <div
            ref={containerRef}
            className={[
                'pr-falling-text-container',
                className,
                isAnimating ? 'pr-falling-text-container--animating' : '',
                wireframes ? 'pr-falling-text-container--wireframes' : '',
            ].filter(Boolean).join(' ')}
            style={containerStyle}
            data-falling-trigger={trigger}
            role={trigger === 'click' ? 'button' : undefined}
            tabIndex={trigger === 'click' ? 0 : undefined}
            aria-label={trigger === 'click' ? '播放标题入场效果' : undefined}
            onClick={trigger === 'click' ? begin : undefined}
            onMouseEnter={trigger === 'hover' ? begin : undefined}
            onKeyDown={handleKeyDown}
        >
            <span className="pr-falling-text-target" aria-live="off">
                {words.map((word, index) => {
                    const highlighted = normalizedHighlights.some((prefix) => word.startsWith(prefix))
                    const isLastWord = index === words.length - 1
                    return (
                        <span
                            key={`${runId}-${index}-${word}`}
                            className={`pr-falling-text__word ${highlighted ? highlightClass : ''}`.trim()}
                            style={{ animationDelay: `${index * staggerMs}ms` }}
                            onAnimationEnd={isLastWord ? () => setIsAnimating(false) : undefined}
                        >
                            {word}
                        </span>
                    )
                })}
            </span>
        </div>
    )
}
