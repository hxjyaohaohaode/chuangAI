/**
 * GlowBorder —— 重点内容的令牌化光韵边界。
 *
 * 2026-08-09 独立实现：替换本地“优质前端部件组”中来源未闭合的完整移植版本。
 * 本组件不向 document.head 注入样式、不追踪指针坐标，也不把装饰性光效置于内容之上。
 * 它只提供可预测的视觉层级：活跃或悬停时强调边界，减弱动态时保留静态色彩提示。
 */

import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import './GlowBorder.css'

export interface GlowBorderProps {
    active?: boolean
    children?: ReactNode
    className?: string
    radius?: number
    color?: 'accent-primary' | 'accent-success' | 'accent-warning' | 'accent-error' | 'accent-info'
    /** 保留旧 API；数值越高，非激活状态越克制。 */
    edgeSensitivity?: number
    /** 外发光最大半径（px），限制为 0–96。 */
    glowRadius?: number
    /** 外发光不透明度倍数，限制为 0–1.5。 */
    glowIntensity?: number
    /** 保留旧 API；控制流光带的宽度，限制为 8–80。 */
    coneSpread?: number
    /** 仅在普通动态偏好下播放一次低频扫描。 */
    animated?: boolean
    /** 可选三色渐变，保留旧 API。 */
    colors?: [string, string, string]
    /** 内容层的色彩渗透强度，限制为 0–1。 */
    fillOpacity?: number
    style?: CSSProperties
}

const ACCENT_RGB: Record<NonNullable<GlowBorderProps['color']>, string> = {
    'accent-primary': '197 133 59',
    'accent-success': '91 140 90',
    'accent-warning': '197 150 60',
    'accent-error': '193 85 79',
    'accent-info': '90 138 168',
}

function clamp(value: number, minimum: number, maximum: number): number {
    if (!Number.isFinite(value)) return minimum
    return Math.min(maximum, Math.max(minimum, value))
}

export function GlowBorder({
    active = false,
    children,
    className,
    radius = 12,
    color = 'accent-primary',
    edgeSensitivity = 30,
    glowRadius = 40,
    glowIntensity = 1,
    coneSpread = 25,
    animated = false,
    colors,
    fillOpacity = .5,
    style,
}: GlowBorderProps) {
    const accent = ACCENT_RGB[color]
    const fallbackColors: [string, string, string] = [
        `rgb(${accent} / .96)`,
        `rgb(${accent} / .58)`,
        `rgb(${accent} / .24)`,
    ]
    const [first, second, third] = colors ?? fallbackColors
    const safeRadius = clamp(radius, 0, 64)
    const safeSensitivity = clamp(edgeSensitivity, 0, 100)
    const safeGlowRadius = clamp(glowRadius, 0, 96)
    const safeIntensity = clamp(glowIntensity, 0, 1.5)
    const safeConeSpread = clamp(coneSpread, 8, 80)
    const safeFillOpacity = clamp(fillOpacity, 0, 1)
    const cssVars = {
        '--pr-glow-radius': `${safeRadius}px`,
        '--pr-glow-content-radius': `${Math.max(0, safeRadius - 1)}px`,
        '--pr-glow-one': first,
        '--pr-glow-two': second,
        '--pr-glow-three': third,
        '--pr-glow-opacity': String(safeIntensity),
        '--pr-glow-blur': `${Math.round(safeGlowRadius / 4)}px`,
        '--pr-glow-visibility': String(Math.max(.08, (100 - safeSensitivity) / 100)),
        '--pr-glow-beam-size': `${safeConeSpread}%`,
        '--pr-glow-fill-opacity': String(safeFillOpacity),
    } as CSSProperties

    return (
        <div
            className={cn('pr-glowborder', active && 'is-active', animated && 'is-animated', className)}
            style={{ ...cssVars, ...style }}
        >
            <div className="pr-glowborder-content">{children}</div>
        </div>
    )
}
