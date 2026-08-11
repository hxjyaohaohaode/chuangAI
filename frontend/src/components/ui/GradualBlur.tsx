/**
 * Decorative, non-blocking edge blur.
 *
 * It is intentionally an overlay: no content, focus target or pointer input is
 * placed inside it.  The component keeps the previous public options but does
 * not install global resize listeners; dimensions are native CSS values and
 * react naturally to their positioned parent.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { cn } from '@/lib/cn'
import { subscribeMediaQuery } from '@/lib/media-query'
import './GradualBlur.css'

type Position = 'top' | 'bottom' | 'left' | 'right'
type Curve = 'linear' | 'bezier' | 'ease-in' | 'ease-out' | 'ease-in-out'

interface GradualBlurConfig {
    position: Position
    strength: number
    height: string
    width?: string
    divCount: number
    exponential: boolean
    curve: Curve
    opacity: number
    animated: boolean | 'scroll'
    duration: string
    easing: string
    hoverIntensity?: number
    target: 'parent' | 'page'
    zIndex: number
}

const PRESETS: Record<string, Partial<GradualBlurConfig>> = {
    top: { position: 'top', height: '6rem' },
    bottom: { position: 'bottom', height: '6rem' },
    left: { position: 'left', height: '6rem' },
    right: { position: 'right', height: '6rem' },
    subtle: { height: '4rem', strength: 1, opacity: 0.8, divCount: 3 },
    intense: { height: '10rem', strength: 4, divCount: 8, exponential: true },
    smooth: { height: '8rem', curve: 'bezier', divCount: 8 },
    sharp: { height: '5rem', curve: 'linear', divCount: 4 },
    header: { position: 'top', height: '8rem', curve: 'ease-out' },
    footer: { position: 'bottom', height: '8rem', curve: 'ease-out' },
    sidebar: { position: 'left', height: '6rem', strength: 2.5 },
    'page-header': { position: 'top', height: '10rem', target: 'page', strength: 3 },
    'page-footer': { position: 'bottom', height: '10rem', target: 'page', strength: 3 },
}

const DEFAULTS: GradualBlurConfig = {
    position: 'bottom',
    strength: 2,
    height: '6rem',
    divCount: 5,
    exponential: false,
    curve: 'linear',
    opacity: 1,
    animated: false,
    duration: '0.3s',
    easing: 'ease-out',
    target: 'parent',
    zIndex: 1000,
}

export interface GradualBlurProps {
    position?: Position
    strength?: number
    height?: string
    width?: string
    divCount?: number
    exponential?: boolean
    curve?: Curve
    opacity?: number
    animated?: boolean | 'scroll'
    duration?: string
    easing?: string
    hoverIntensity?: number
    target?: 'parent' | 'page'
    preset?: keyof typeof PRESETS
    /** Kept for API compatibility; CSS dimensions remain responsive by default. */
    responsive?: boolean
    zIndex?: number
    onAnimationComplete?: () => void
    className?: string
    style?: CSSProperties
}

const clamp = (value: number, minimum: number, maximum: number) =>
    Math.min(Math.max(value, minimum), maximum)

const curveValue = (progress: number, curve: Curve) => {
    if (curve === 'bezier') return progress * progress * (3 - 2 * progress)
    if (curve === 'ease-in') return progress * progress
    if (curve === 'ease-out') return 1 - (1 - progress) ** 2
    if (curve === 'ease-in-out') return progress < 0.5 ? 2 * progress ** 2 : 1 - (-2 * progress + 2) ** 2 / 2
    return progress
}

const maskDirection: Record<Position, string> = {
    top: 'to top', bottom: 'to bottom', left: 'to left', right: 'to right',
}

const durationToMilliseconds = (value: string) => {
    const parsed = Number.parseFloat(value)
    if (!Number.isFinite(parsed)) return 300
    return value.trim().endsWith('ms') ? clamp(parsed, 0, 10_000) : clamp(parsed * 1000, 0, 10_000)
}

export function GradualBlur({
    position,
    strength,
    height,
    width,
    divCount,
    exponential,
    curve,
    opacity,
    animated,
    duration,
    easing,
    hoverIntensity,
    target,
    preset,
    responsive: _responsive,
    zIndex,
    onAnimationComplete,
    className,
    style,
}: GradualBlurProps) {
    const overlayRef = useRef<HTMLDivElement>(null)
    const [hovered, setHovered] = useState(false)
    const [reducedMotion, setReducedMotion] = useState(false)
    const [visible, setVisible] = useState(animated !== 'scroll')

    const config = useMemo<GradualBlurConfig>(() => ({
        ...DEFAULTS,
        ...(preset ? PRESETS[preset] : undefined),
        ...(position !== undefined ? { position } : {}),
        ...(strength !== undefined ? { strength } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(divCount !== undefined ? { divCount } : {}),
        ...(exponential !== undefined ? { exponential } : {}),
        ...(curve !== undefined ? { curve } : {}),
        ...(opacity !== undefined ? { opacity } : {}),
        ...(animated !== undefined ? { animated } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(easing !== undefined ? { easing } : {}),
        ...(hoverIntensity !== undefined ? { hoverIntensity } : {}),
        ...(target !== undefined ? { target } : {}),
        ...(zIndex !== undefined ? { zIndex } : {}),
    }), [animated, curve, divCount, duration, easing, exponential, height, hoverIntensity, opacity, position, preset, strength, target, width, zIndex])

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
        const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
        const update = () => setReducedMotion(mediaQuery.matches)
        update()
        return subscribeMediaQuery(mediaQuery, update)
    }, [])

    useEffect(() => {
        if (config.animated !== 'scroll' || reducedMotion || typeof IntersectionObserver === 'undefined') {
            setVisible(true)
            return
        }

        const element = overlayRef.current
        if (!element) return
        setVisible(false)
        let observer: IntersectionObserver | null = null
        try {
            observer = new IntersectionObserver((entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return
                setVisible(true)
                observer?.disconnect()
            }, { threshold: 0.01 })
            observer.observe(element)
        } catch {
            observer?.disconnect()
            setVisible(true)
            return
        }
        return () => observer?.disconnect()
    }, [config.animated, reducedMotion])

    useEffect(() => {
        if (!visible || config.animated !== 'scroll' || !onAnimationComplete) return
        const timer = window.setTimeout(onAnimationComplete, durationToMilliseconds(config.duration))
        return () => window.clearTimeout(timer)
    }, [config.animated, config.duration, onAnimationComplete, visible])

    const layers = useMemo(() => {
        const count = clamp(Math.floor(config.divCount), 1, 10)
        const effectiveStrength = config.strength * (hovered ? config.hoverIntensity ?? 1 : 1)
        return Array.from({ length: count }, (_, index) => {
            const progress = curveValue((index + 1) / count, config.curve)
            const blur = config.exponential
                ? ((2 ** (progress * 4)) * 0.0625 * effectiveStrength)
                : (0.0625 * (progress * count + 1) * effectiveStrength)
            const segmentStart = Math.round((index / count) * 1000) / 10
            const segmentEnd = Math.round(((index + 1) / count) * 1000) / 10
            const fadeEnd = Math.min(100, Math.round(((index + 2) / count) * 1000) / 10)
            const gradient = `linear-gradient(${maskDirection[config.position]}, transparent ${segmentStart}%, black ${segmentEnd}%, transparent ${fadeEnd}%)`
            return {
                maskImage: gradient,
                WebkitMaskImage: gradient,
                backdropFilter: `blur(${blur.toFixed(3)}rem)`,
                WebkitBackdropFilter: `blur(${blur.toFixed(3)}rem)`,
                opacity: clamp(config.opacity, 0, 1),
            } as CSSProperties
        })
    }, [config, hovered])

    const vertical = config.position === 'top' || config.position === 'bottom'
    const overlayStyle: CSSProperties = {
        position: config.target === 'page' ? 'fixed' : 'absolute',
        zIndex: config.target === 'page' ? config.zIndex + 100 : config.zIndex,
        opacity: visible ? 1 : 0,
        transition: config.animated ? `opacity ${config.duration} ${config.easing}` : undefined,
        pointerEvents: config.hoverIntensity ? 'auto' : 'none',
        ...(vertical
            ? { height: config.height, width: config.width ?? '100%', [config.position]: 0, left: 0, right: 0 }
            : { width: config.width ?? config.height, height: '100%', [config.position]: 0, top: 0, bottom: 0 }),
        ...style,
    }

    return (
        <div
            ref={overlayRef}
            className={cn('pr-gradual-blur', config.target === 'page' && 'pr-gradual-blur--page', className)}
            style={overlayStyle}
            aria-hidden="true"
            onPointerEnter={config.hoverIntensity ? () => setHovered(true) : undefined}
            onPointerLeave={config.hoverIntensity ? () => setHovered(false) : undefined}
        >
            {layers.map((layer, index) => <span key={index} className="pr-gradual-blur-layer" style={layer} />)}
        </div>
    )
}
