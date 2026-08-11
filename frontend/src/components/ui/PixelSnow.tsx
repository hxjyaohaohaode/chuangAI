/**
 * PixelSnow —— 确定性的像素落雪装饰。
 *
 * 这是项目独立实现：最多渲染 48 个 Halton 序列雪片，不创建 Canvas/WebGL
 * 上下文，也不使用计时器、RAF、观察器、事件监听或运行时 DOM 注入。
 * 动态效果完全交给 CSS，并在减弱动态、粗指针、强制色与打印环境中降级。
 */

import { memo, type CSSProperties } from 'react'
import './PixelSnow.css'

export type SnowVariant = 'square' | 'round' | 'snowflake'

export interface PixelSnowProps {
    /** 雪花颜色，默认使用设计系统的暖白表面色 */
    color?: string
    /** 雪花基础尺寸（兼容原场景单位），默认 0.01 */
    flakeSize?: number
    /** 最小雪花尺寸（屏幕像素），默认 1.25 */
    minFlakeSize?: number
    /** 像素分辨率；数值越低，雪片越粗粝，默认 200 */
    pixelResolution?: number
    /** 动画速度倍数；0 表示静态，默认 1.25 */
    speed?: number
    /** 深度淡出强度，默认 8 */
    depthFade?: number
    /** 远平面距离，默认 20 */
    farPlane?: number
    /** 亮度倍数，默认 1 */
    brightness?: number
    /** Gamma 校正值，默认 0.4545 */
    gamma?: number
    /** 雪花密度 (0-1)，默认 0.3 */
    density?: number
    /** 雪花形状，默认 snowflake */
    variant?: SnowVariant
    /** 风向角度 (0-360)，默认 125 */
    direction?: number
    /** 自定义类名 */
    className?: string
    /** 自定义样式；pointer-events 始终由组件锁定为 none */
    style?: CSSProperties
}

interface PixelSnowRootStyle extends CSSProperties {
    '--pr-snow-color': string
}

interface PixelSnowFlakeStyle extends CSSProperties {
    '--pr-snow-x': string
    '--pr-snow-y': string
    '--pr-snow-size': string
    '--pr-snow-opacity': string
    '--pr-snow-rotation': string
    '--pr-snow-scale': string
    '--pr-snow-drift': string
    '--pr-snow-duration': string
    '--pr-snow-delay': string
}

interface NormalizedSnowConfig {
    flakeSize: number
    minFlakeSize: number
    pixelResolution: number
    speed: number
    depthFade: number
    farPlane: number
    brightness: number
    gamma: number
    density: number
    direction: number
}

const MAX_FLAKES = 48
const DEFAULT_COLOR = 'rgb(var(--c-surface-primary))'

function clampFinite(value: number | undefined, fallback: number, min: number, max: number): number {
    const finiteValue = typeof value === 'number' && Number.isFinite(value) ? value : fallback
    return Math.min(max, Math.max(min, finiteValue))
}

function normalizeVariant(value: SnowVariant | undefined): SnowVariant {
    if (value === 'square' || value === 'round' || value === 'snowflake') return value
    return 'snowflake'
}

function normalizeColor(value: string | undefined): string {
    if (typeof value !== 'string') return DEFAULT_COLOR
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > 160 || /[;{}]/.test(trimmed)) return DEFAULT_COLOR
    return trimmed
}

function normalizeDirection(value: number | undefined): number {
    const finiteValue = typeof value === 'number' && Number.isFinite(value) ? value : 125
    return ((finiteValue % 360) + 360) % 360
}

function normalizeConfig(props: PixelSnowProps): NormalizedSnowConfig {
    return {
        flakeSize: clampFinite(props.flakeSize, 0.01, 0.001, 0.1),
        minFlakeSize: clampFinite(props.minFlakeSize, 1.25, 0.5, 8),
        pixelResolution: clampFinite(props.pixelResolution, 200, 16, 1024),
        speed: clampFinite(props.speed, 1.25, 0, 4),
        depthFade: clampFinite(props.depthFade, 8, 0.1, 40),
        farPlane: clampFinite(props.farPlane, 20, 1, 100),
        brightness: clampFinite(props.brightness, 1, 0, 2),
        gamma: clampFinite(props.gamma, 0.4545, 0.1, 3),
        density: clampFinite(props.density, 0.3, 0, 1),
        direction: normalizeDirection(props.direction),
    }
}

/** Low-discrepancy sequence: stable across renders, SSR and test runs. */
function halton(index: number, base: number): number {
    let result = 0
    let fraction = 1
    let remaining = index

    while (remaining > 0) {
        fraction /= base
        result += fraction * (remaining % base)
        remaining = Math.floor(remaining / base)
    }

    return result
}

function fixed(value: number, digits = 3): string {
    return value.toFixed(digits)
}

function buildFlakeStyle(index: number, config: NormalizedSnowConfig): PixelSnowFlakeStyle {
    const sequenceIndex = index + 1
    const x = halton(sequenceIndex, 2)
    const y = halton(sequenceIndex, 3)
    const depth = halton(sequenceIndex, 5)
    const phase = halton(sequenceIndex, 7)

    const pixelScale = Math.min(2.4, Math.max(0.65, 200 / config.pixelResolution))
    const depthScale = 0.65 + (1 - depth) * 0.85
    const baseSize = Math.max(config.minFlakeSize, config.flakeSize * 220)
    const size = Math.min(12, Math.max(0.5, baseSize * pixelScale * depthScale))

    const depthDistance = 1 + depth * (config.farPlane - 1)
    const depthVisibility = 1 / (1 + (depthDistance - 1) / (config.depthFade * 3))
    const light = Math.min(1, Math.max(0, config.brightness * depthVisibility))
    const opacity = Math.min(0.72, Math.max(0, Math.pow(light, config.gamma) * 0.72))

    const radians = (config.direction * Math.PI) / 180
    const drift = Math.cos(radians) * (8 + depth * 18)
    const duration = config.speed > 0
        ? Math.min(60, Math.max(5, (15 / config.speed) * (0.8 + depth * 0.7)))
        : 60

    return {
        '--pr-snow-x': `${fixed(x * 100)}%`,
        '--pr-snow-y': `${fixed(y * 100)}%`,
        '--pr-snow-size': `${fixed(size)}px`,
        '--pr-snow-opacity': fixed(opacity),
        '--pr-snow-rotation': `${fixed(phase * 360, 2)}deg`,
        '--pr-snow-scale': fixed(depthScale),
        '--pr-snow-drift': `${fixed(drift)}cqh`,
        '--pr-snow-duration': `${fixed(duration)}s`,
        '--pr-snow-delay': `${fixed(-phase * duration)}s`,
    }
}

export const PixelSnow = memo(function PixelSnow(props: PixelSnowProps) {
    const config = normalizeConfig(props)
    const normalizedVariant = normalizeVariant(props.variant)
    const flakeCount = Math.round(MAX_FLAKES * config.density)
    const rootClassName = ['pr-pixel-snow', props.className?.trim()].filter(Boolean).join(' ')
    const rootStyle: PixelSnowRootStyle = {
        ...props.style,
        pointerEvents: 'none',
        '--pr-snow-color': normalizeColor(props.color),
    }

    return (
        <div
            className={rootClassName}
            style={rootStyle}
            aria-hidden="true"
            data-pixel-snow="decorative"
            data-snow-variant={normalizedVariant}
            data-snow-count={flakeCount}
            data-snow-motion={config.speed > 0 ? 'enabled' : 'static'}
        >
            {Array.from({ length: flakeCount }, (_, index) => (
                <span
                    key={index}
                    data-snow-flake=""
                    className="pr-pixel-snow__flake"
                    style={buildFlakeStyle(index, config)}
                />
            ))}
        </div>
    )
})
