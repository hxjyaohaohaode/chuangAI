/**
 * A lightweight, decorative selection border.
 *
 * This implementation deliberately uses native CSS rather than a canvas render
 * loop.  The component is safe to use as an empty, absolute-positioned
 * decoration or as a wrapper around real content: it never captures pointer
 * input, has no global listeners, and retains a readable static outline when
 * animation is unavailable or disabled.
 */

import type { CSSProperties, ReactNode } from 'react'
import './ElectricBorder.css'

export interface ElectricBorderProps {
    /** Outline and glow colour. */
    color?: string
    /** Animation-rate multiplier. `0` renders a static outline. */
    speed?: number
    /** Visual energy from 0 to 1; values outside that range are safely clamped. */
    chaos?: number
    /** Rounded-corner radius in pixels. */
    borderRadius?: number
    className?: string
    style?: CSSProperties
    children?: ReactNode
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const toFiniteNumber = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

export function ElectricBorder({
    children,
    color = 'rgb(197, 133, 59)',
    speed = 1,
    chaos = 0.12,
    borderRadius = 24,
    className,
    style,
}: ElectricBorderProps) {
    const safeSpeed = clamp(toFiniteNumber(speed, 1), 0, 3)
    const safeChaos = clamp(toFiniteNumber(chaos, 0.12), 0, 1)
    const safeRadius = clamp(toFiniteNumber(borderRadius, 24), 0, 999)
    const hasContent = children !== null && children !== undefined && children !== false
    const isStatic = safeSpeed === 0
    const glowOpacity = 0.16 + safeChaos * 0.34

    // Keep the former public API while translating its behavioural intent to
    // CSS variables. The min duration prevents an accidental speed value from
    // creating a distracting, high-frequency animation.
    const variables: CSSProperties = {
        ['--electric-border-color' as string]: color,
        ['--electric-border-radius' as string]: `${safeRadius}px`,
        ['--electric-border-duration' as string]: `${Math.max(1.8, 7.2 / Math.max(safeSpeed, 0.2)).toFixed(2)}s`,
        ['--electric-border-glow-opacity' as string]: glowOpacity.toFixed(2),
        ['--electric-border-rest-opacity' as string]: (glowOpacity * 0.72).toFixed(2),
        ['--electric-border-glow-size' as string]: `${Math.round(8 + safeChaos * 16)}px`,
        ['--electric-border-motion-state' as string]: isStatic ? 'paused' : 'running',
    }

    return (
        <div
            className={`pr-electric-border ${className ?? ''}`.trim()}
            style={{ ...variables, ...style }}
            aria-hidden={hasContent ? undefined : true}
            data-electric-decoration={hasContent ? undefined : 'true'}
        >
            {hasContent ? <div className="pr-electric-border__content">{children}</div> : null}
        </div>
    )
}
