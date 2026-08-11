/**
 * Lightweight decorative border rings.
 *
 * Percentage-based SVG rectangles follow the host size without measuring the
 * DOM. The component has no observer, listener, timer or JavaScript animation.
 */

import { memo, type CSSProperties, type HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import './MagicRings.css'

export interface MagicRingsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'color'> {
    /** Duration of one desktop border pass in seconds. */
    speed?: number
    color?: string
    strokeWidth?: number
    layers?: number
    borderRadius?: number
}

const finite = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const LAYERS = [
    { dash: '200 800', opacity: 0.86 },
    { dash: '150 850', opacity: 0.56 },
    { dash: '100 900', opacity: 0.34 },
] as const

export const MagicRings = memo(function MagicRings({
    speed = 4,
    color = 'rgb(var(--c-accent-primary))',
    strokeWidth = 2,
    layers = 2,
    borderRadius = 12,
    className,
    style,
    children,
    ...rest
}: MagicRingsProps) {
    const duration = clamp(finite(speed, 4), 0.4, 60)
    const layerCount = clamp(Math.floor(finite(layers, 2)), 1, 3)
    const radius = clamp(finite(borderRadius, 12), 0, 999)
    const width = clamp(finite(strokeWidth, 2), 0.5, 8)
    const variables: CSSProperties = {
        ...style,
        borderRadius: `${radius}px`,
        ['--magic-rings-color' as string]: color,
        ['--magic-rings-duration' as string]: `${duration}s`,
    }

    return (
        <div
            className={cn('pr-magic-rings-container', className)}
            style={variables}
            {...rest}
        >
            <svg
                className="pr-magic-rings-svg"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
                focusable="false"
            >
                {LAYERS.slice(0, layerCount).map((layer, index) => (
                    <rect
                        key={layer.dash}
                        className="pr-magic-rings-track"
                        x="0"
                        y="0"
                        width="100"
                        height="100"
                        rx={radius}
                        ry={radius}
                        pathLength={1000}
                        fill="none"
                        vectorEffect="non-scaling-stroke"
                        style={{
                            ['--magic-rings-dash' as string]: layer.dash,
                            ['--magic-rings-opacity' as string]: String(layer.opacity),
                            ['--magic-rings-delay' as string]: `${duration * index / layerCount}s`,
                            strokeWidth: width,
                        }}
                    />
                ))}
            </svg>
            {children ? <div className="pr-magic-rings-content">{children}</div> : null}
        </div>
    )
})
