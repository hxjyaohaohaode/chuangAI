/**
 * Local pointer-proximity typography.
 *
 * The effect is intentionally scoped to this element: it uses no global mouse
 * or touch listener and no permanent animation frame.  A title only performs
 * distance work while a mouse/pen pointer is actually over it, then returns to
 * its defined resting variation when focus or pointer leaves.
 */

import {
    forwardRef,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type KeyboardEvent,
    type PointerEvent,
    type ReactNode,
} from 'react'
import './VariableProximity.css'
import { cn } from '@/lib/cn'

export interface VariableProximityProps {
    /** 显示的文本内容 */
    label: string
    /** 静止时 font-variation-settings */
    fromFontVariationSettings?: string
    /** 指针接近时 font-variation-settings */
    toFontVariationSettings?: string
    /** 保留兼容接口；字距计算基于每个实际文字节点 */
    containerRef?: React.RefObject<HTMLElement | null>
    /** 影响半径（px），默认 50 */
    radius?: number
    /** 衰减模式：linear / exponential / gaussian，默认 linear */
    falloff?: 'linear' | 'exponential' | 'gaussian'
    /** 额外 className */
    className?: string
    /** 点击回调；提供时组件成为键盘可激活的按钮 */
    onClick?: () => void
    /** 额外样式 */
    style?: CSSProperties
    /** 兼容保留；视觉文本仍以 label 为单一真相源 */
    children?: ReactNode
}

type Falloff = NonNullable<VariableProximityProps['falloff']>

interface FontAxis {
    axis: string
    from: number
    to: number
}

const clamp = (value: number, minimum: number, maximum: number) =>
    Math.min(Math.max(value, minimum), maximum)

function parseSettings(settings: string): Map<string, number> {
    const result = new Map<string, number>()
    for (const item of settings.split(',')) {
        const [rawAxis, rawValue] = item.trim().split(/\s+/, 2)
        const value = Number.parseFloat(rawValue ?? '')
        const axis = rawAxis?.replace(/["']/g, '')
        if (axis && Number.isFinite(value)) result.set(axis, value)
    }
    return result
}

function calculateFalloff(distance: number, radius: number, falloff: Falloff): number {
    const normalized = clamp(1 - distance / radius, 0, 1)
    if (falloff === 'exponential') return normalized ** 2
    if (falloff === 'gaussian') return Math.exp(-((distance / (radius / 2)) ** 2) / 2)
    return normalized
}

function formatVariation(axes: FontAxis[], amount: number): string {
    return axes
        .map(({ axis, from, to }) => `'${axis}' ${from + (to - from) * amount}`)
        .join(', ')
}

export const VariableProximity = forwardRef<HTMLSpanElement, VariableProximityProps>(
    function VariableProximity(
        {
            label,
            fromFontVariationSettings = "'wght' 400, 'opsz' 9",
            toFontVariationSettings = "'wght' 800, 'opsz' 40",
            containerRef: _containerRef,
            radius = 50,
            falloff = 'linear',
            className,
            onClick,
            style,
            children: _children,
        },
        ref,
    ) {
        const letters = useMemo(() => Array.from(label), [label])
        const letterRefs = useRef<Array<HTMLSpanElement | null>>([])
        const visualRef = useRef<HTMLSpanElement>(null)
        const letterCentersRef = useRef<Array<{ x: number; y: number } | null>>([])
        const measuredScrollRef = useRef({ x: 0, y: 0 })
        const pendingPointerRef = useRef<{ x: number; y: number } | null>(null)
        const frameRef = useRef<number | null>(null)
        const [interactionDisabled, setInteractionDisabled] = useState(false)
        const [variations, setVariations] = useState<string[]>(() =>
            letters.map(() => fromFontVariationSettings),
        )

        const axes = useMemo<FontAxis[]>(() => {
            const from = parseSettings(fromFontVariationSettings)
            const to = parseSettings(toFontVariationSettings)
            return Array.from(from.entries()).map(([axis, fromValue]) => ({
                axis,
                from: fromValue,
                to: to.get(axis) ?? fromValue,
            }))
        }, [fromFontVariationSettings, toFontVariationSettings])

        const reset = useCallback(() => {
            setVariations((current) => {
                const next = letters.map(() => fromFontVariationSettings)
                return current.length === next.length && current.every((value, index) => value === next[index])
                    ? current
                    : next
            })
        }, [fromFontVariationSettings, letters])

        useEffect(() => {
            reset()
        }, [reset])

        useEffect(() => {
            if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
            const mediaQueries = [
                window.matchMedia('(prefers-reduced-motion: reduce)'),
                window.matchMedia('(pointer: coarse)'),
                window.matchMedia('(hover: none)'),
            ]
            const updatePreference = () => setInteractionDisabled(mediaQueries.some((query) => query.matches))
            updatePreference()
            const cleanups: Array<() => void> = []
            for (const query of mediaQueries) {
                if (typeof query.addEventListener === 'function') {
                    query.addEventListener('change', updatePreference)
                    cleanups.push(() => query.removeEventListener('change', updatePreference))
                } else if (typeof query.addListener === 'function') {
                    query.addListener(updatePreference)
                    cleanups.push(() => query.removeListener(updatePreference))
                }
            }
            return () => cleanups.forEach((cleanup) => cleanup())
        }, [])

        const refreshLetterCenters = useCallback(() => {
            letterCentersRef.current = letterRefs.current.map((letter) => {
                if (!letter) return null
                const rect = letter.getBoundingClientRect()
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
            })
            measuredScrollRef.current = {
                x: typeof window === 'undefined' ? 0 : window.scrollX,
                y: typeof window === 'undefined' ? 0 : window.scrollY,
            }
        }, [])

        useEffect(() => {
            const visual = visualRef.current
            if (!visual || typeof ResizeObserver !== 'function') return
            let observer: ResizeObserver | null = null
            try {
                observer = new ResizeObserver(refreshLetterCenters)
                observer.observe(visual)
            } catch {
                observer?.disconnect()
            }
            return () => observer?.disconnect()
        }, [letters, refreshLetterCenters])

        const cancelPendingFrame = useCallback(() => {
            if (frameRef.current !== null && typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(frameRef.current)
            }
            frameRef.current = null
            pendingPointerRef.current = null
        }, [])

        useEffect(() => () => cancelPendingFrame(), [cancelPendingFrame])

        useEffect(() => {
            if (!interactionDisabled) return
            cancelPendingFrame()
            reset()
        }, [cancelPendingFrame, interactionDisabled, reset])

        const handlePointerMove = useCallback((event: PointerEvent<HTMLSpanElement>) => {
            if (interactionDisabled || event.pointerType === 'touch' || !Number.isFinite(radius) || radius <= 0) return
            if (
                letterCentersRef.current.length !== letters.length
                || (typeof window !== 'undefined' && (
                    measuredScrollRef.current.x !== window.scrollX
                    || measuredScrollRef.current.y !== window.scrollY
                ))
            ) refreshLetterCenters()

            pendingPointerRef.current = { x: event.clientX, y: event.clientY }
            if (frameRef.current !== null) return
            const update = () => {
                frameRef.current = null
                const pointer = pendingPointerRef.current
                pendingPointerRef.current = null
                if (!pointer) return
                const next = letterCentersRef.current.map((center) => {
                    if (!center) return fromFontVariationSettings
                    const distance = Math.hypot(pointer.x - center.x, pointer.y - center.y)
                    return formatVariation(axes, calculateFalloff(distance, radius, falloff))
                })
                setVariations((current) =>
                    current.length === next.length && current.every((value, index) => value === next[index])
                        ? current
                        : next,
                )
            }
            if (typeof requestAnimationFrame === 'function') frameRef.current = requestAnimationFrame(update)
            else update()
        }, [axes, falloff, fromFontVariationSettings, interactionDisabled, letters.length, radius, refreshLetterCenters])

        const handlePointerExit = useCallback(() => {
            cancelPendingFrame()
            reset()
        }, [cancelPendingFrame, reset])

        const handleKeyDown = useCallback((event: KeyboardEvent<HTMLSpanElement>) => {
            if (!onClick || (event.key !== 'Enter' && event.key !== ' ')) return
            event.preventDefault()
            onClick()
        }, [onClick])

        const interactiveProps = onClick
            ? { role: 'button' as const, tabIndex: 0, onKeyDown: handleKeyDown }
            : {}

        return (
            <span
                ref={ref}
                className={cn('pr-variable-proximity', className)}
                style={style}
                onClick={onClick}
                onPointerEnter={refreshLetterCenters}
                onPointerMove={handlePointerMove}
                onPointerLeave={handlePointerExit}
                onPointerCancel={handlePointerExit}
                {...interactiveProps}
            >
                <span className="pr-variable-proximity-sr-only">{label}</span>
                <span ref={visualRef} aria-hidden="true">
                    {letters.map((letter, index) => (
                        <span
                            key={`${letter}-${index}`}
                            ref={(element) => {
                                letterRefs.current[index] = element
                            }}
                            className="pr-variable-proximity-letter"
                            style={{ fontVariationSettings: variations[index] ?? fromFontVariationSettings }}
                        >
                            {letter === ' ' ? '\u00a0' : letter}
                        </span>
                    ))}
                </span>
            </span>
        )
    },
)

VariableProximity.displayName = 'VariableProximity'
