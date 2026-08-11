/**
 * Lightweight decorative starfield for fallback and error pages.
 *
 * The historical public props remain compatible, but the implementation is
 * deliberately CSS-only: a recovery page must not depend on WebGL, a canvas,
 * global listeners or a perpetual JavaScript animation loop.
 */

import { memo, type CSSProperties } from 'react'
import { cn } from '@/lib/cn'
import './StarfieldBackground.css'

export interface StarfieldBackgroundProps {
    particleCount?: number
    particleSpread?: number
    speed?: number
    particleColors?: string[]
    moveParticlesOnHover?: boolean
    particleHoverFactor?: number
    alphaParticles?: boolean
    particleBaseSize?: number
    sizeRandomness?: number
    cameraDistance?: number
    disableRotation?: boolean
    pixelRatio?: number
    count?: number
    minRadius?: number
    maxRadius?: number
    twinkleSpeed?: number
    twinkleAmplitude?: number
    className?: string
}

const finite = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const safeColor = (value: string | undefined, fallback: string) => {
    if (!value) return fallback
    return typeof CSS === 'undefined' || CSS.supports('color', value) ? value : fallback
}

export const StarfieldBackground = memo(function StarfieldBackground({
    particleCount,
    particleSpread = 10,
    speed = 0.1,
    particleColors,
    alphaParticles = true,
    particleBaseSize = 100,
    sizeRandomness = 1,
    disableRotation = false,
    count,
    className,
}: StarfieldBackgroundProps) {
    const resolvedCount = clamp(Math.round(finite(particleCount ?? count, 80)), 12, 240)
    const densitySpacing = clamp(112 - resolvedCount * 0.34, 34, 108)
    const spread = clamp(finite(particleSpread, 10) / 10, 0.65, 1.8)
    const dotSize = clamp(finite(particleBaseSize, 100) / 72, 0.8, 3)
    const variation = clamp(finite(sizeRandomness, 1), 0, 2)
    const speedValue = clamp(Math.abs(finite(speed, 0.1)), 0, 2)
    const duration = speedValue === 0 ? 0 : clamp(22 / speedValue, 16, 220)
    const variables: CSSProperties = {
        ['--starfield-color-a' as string]: safeColor(particleColors?.[0], 'rgb(var(--c-accent-primary))'),
        ['--starfield-color-b' as string]: safeColor(particleColors?.[1], 'rgb(var(--c-accent-secondary, var(--c-accent-primary)))'),
        ['--starfield-color-c' as string]: safeColor(particleColors?.[2], 'rgb(var(--c-text-tertiary))'),
        ['--starfield-spacing' as string]: `${densitySpacing}px`,
        ['--starfield-spacing-wide' as string]: `${densitySpacing * 1.7}px`,
        ['--starfield-spacing-tight' as string]: `${densitySpacing * 0.72}px`,
        ['--starfield-spacing-far' as string]: `${densitySpacing * 1.22}px`,
        ['--starfield-spacing-farthest' as string]: `${densitySpacing * 2.1}px`,
        ['--starfield-spacing-mid' as string]: `${densitySpacing * 0.9}px`,
        ['--starfield-spread' as string]: String(spread),
        ['--starfield-dot-size' as string]: `${dotSize}px`,
        ['--starfield-dot-large' as string]: `${dotSize * (1.5 + variation * 0.2)}px`,
        ['--starfield-duration' as string]: `${duration}s`,
        ['--starfield-duration-far' as string]: `${duration * 1.35}s`,
        ['--starfield-drift-x' as string]: `${10 * spread}px`,
        ['--starfield-drift-y' as string]: `${-14 * spread}px`,
        ['--starfield-opacity' as string]: alphaParticles ? '0.56' : '0.72',
    }

    return (
        <div
            className={cn('pr-starfield', className)}
            style={variables}
            aria-hidden="true"
            data-starfield-static={disableRotation || duration === 0 ? 'true' : undefined}
        >
            <span className="pr-starfield__layer pr-starfield__layer--near" />
            <span className="pr-starfield__layer pr-starfield__layer--far" />
            <span className="pr-starfield__glow" />
        </div>
    )
})
