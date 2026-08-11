/**
 * Radar —— 低成本、可降级的雷达扫描装饰。
 *
 * 组件保留历史公开参数，但渲染层已独立重写为 CSS：
 * - 不创建 Canvas / WebGL 上下文；
 * - 不注册全局 resize / pointer 监听器；
 * - 不运行 requestAnimationFrame 循环；
 * - 减少动态、粗指针、打印场景自动静止；
 * - 颜色直接接受 HEX、rgb() 与 CSS 变量，无运行时解析失败风险。
 *
 * 该图形只传达“诊断扫描”的氛围，不承载数据或操作，因此始终从
 * 辅助技术树中隐藏。需要表达真实诊断数据时应使用带文本等价物的图表组件。
 */

import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'
import './Radar.css'

type RadarCSSProperties = CSSProperties & Record<`--pr-radar-${string}`, string | number>

const clamp = (value: number, min: number, max: number): number => (
    Math.min(max, Math.max(min, value))
)

const finiteOr = (value: number, fallback: number): number => (
    Number.isFinite(value) ? value : fallback
)

const boundedInteger = (value: number, fallback: number, min: number, max: number): number => (
    Math.round(clamp(finiteOr(value, fallback), min, max))
)

/** 兼容旧 shader 约定：纯黑背景值代表不绘制底色。 */
const normalizeBackground = (value: string): string => {
    const normalized = value.trim().toLowerCase()
    return normalized === '#000' || normalized === '#000000' ? 'transparent' : value
}

export interface RadarProps {
    /** 整体动画速度倍率；0 表示静止。 */
    speed?: number
    /** 雷达图案缩放级别。 */
    scale?: number
    /** 同心环数量。 */
    ringCount?: number
    /** 径向辐条数量。 */
    spokeCount?: number
    /** 同心环线条粗细。 */
    ringThickness?: number
    /** 径向辐条线条粗细。 */
    spokeThickness?: number
    /** 扫描光束旋转速度倍率；0 表示静止。 */
    sweepSpeed?: number
    /** 扫描拖尾收束度；值越大，拖尾越窄。 */
    sweepWidth?: number
    /** 扫描光束数量。 */
    sweepLobes?: number
    /** 主雷达颜色；支持任意合法 CSS 颜色。 */
    color?: string
    /** 雷达底色；支持任意合法 CSS 颜色。 */
    backgroundColor?: string
    /** 边缘淡出强度。 */
    falloff?: number
    /** 整体亮度倍率。 */
    brightness?: number
    /** @deprecated 仅保留调用兼容；装饰层始终放行指针事件。 */
    enableMouseInteraction?: boolean
    /** @deprecated 仅保留调用兼容；不再跟踪指针坐标。 */
    mouseInfluence?: number
    /** 额外 CSS 类。 */
    className?: string
    /** 内联样式。 */
    style?: CSSProperties
}

export const Radar = ({
    speed = 1,
    scale = 0.5,
    ringCount = 10,
    spokeCount = 10,
    ringThickness = 0.05,
    spokeThickness = 0.01,
    sweepSpeed = 1,
    sweepWidth = 2,
    sweepLobes = 1,
    color = 'rgb(var(--c-accent-primary))',
    backgroundColor = 'rgb(var(--c-surface-primary))',
    falloff = 2,
    brightness = 1,
    enableMouseInteraction = true,
    mouseInfluence = 0.1,
    className,
    style,
}: RadarProps) => {
    const rings = boundedInteger(ringCount, 10, 1, 24)
    const spokes = boundedInteger(spokeCount, 10, 2, 36)
    const lobes = boundedInteger(sweepLobes, 1, 1, 6)
    const normalizedScale = clamp(Math.abs(finiteOr(scale, 0.5)), 0.35, 2)
    const fieldScale = clamp(1 / normalizedScale, 0.78, 1.2)
    const normalizedBrightness = clamp(finiteOr(brightness, 1), 0, 1.6)
    const normalizedFalloff = clamp(Math.abs(finiteOr(falloff, 2)), 0.2, 5)
    const motionRate = Math.abs(finiteOr(speed, 1) * finiteOr(sweepSpeed, 1))
    const duration = motionRate < 0.05 ? 0 : clamp(12 / motionRate, 4, 40)
    const ringWidth = clamp(Math.abs(finiteOr(ringThickness, 0.05)) * 18, 0.65, 3.2)
    const spokeWidth = clamp(Math.abs(finiteOr(spokeThickness, 0.01)) * 150, 0.45, 4)
    const beamAngle = clamp(92 / clamp(Math.abs(finiteOr(sweepWidth, 2)), 0.5, 10), 10, 96)
    const edgeStart = clamp(72 - normalizedFalloff * 8, 42, 70)
    const legacyMouseInfluence = clamp(Math.abs(finiteOr(mouseInfluence, 0.1)), 0, 1)

    const radarStyle: RadarCSSProperties = {
        ...style,
        '--pr-radar-color': color,
        '--pr-radar-background': normalizeBackground(backgroundColor),
        '--pr-radar-ring-step': `${100 / rings}%`,
        '--pr-radar-ring-width': `${ringWidth}px`,
        '--pr-radar-spoke-step': `${360 / spokes}deg`,
        '--pr-radar-spoke-width': `${spokeWidth}deg`,
        '--pr-radar-beam-angle': `${beamAngle}deg`,
        '--pr-radar-duration': `${duration}s`,
        '--pr-radar-field-scale': fieldScale,
        '--pr-radar-edge-start': `${edgeStart}%`,
        '--pr-radar-backdrop-opacity': clamp(0.86 * normalizedBrightness, 0, 1),
        '--pr-radar-grid-opacity': clamp(0.42 * normalizedBrightness, 0, 0.72),
        '--pr-radar-sweep-opacity': clamp(0.62 * normalizedBrightness, 0, 0.9),
        '--pr-radar-core-opacity': clamp(0.78 * normalizedBrightness, 0, 1),
    }

    return (
        <div
            aria-hidden="true"
            className={cn('pr-radar-container', className)}
            data-radar-interactive={enableMouseInteraction ? 'legacy-requested' : 'disabled'}
            data-radar-mouse-influence={legacyMouseInfluence}
            data-radar-motion={duration > 0 ? 'animated' : 'static'}
            data-radar-renderer="css"
            style={radarStyle}
        >
            <span className="pr-radar-backdrop" />
            <span className="pr-radar-field" />
            {Array.from({ length: lobes }, (_, index) => (
                <span
                    className="pr-radar-sweep"
                    key={index}
                    style={{ '--pr-radar-lobe-offset': `${(360 / lobes) * index}deg` } as RadarCSSProperties}
                />
            ))}
            <span className="pr-radar-core" />
        </div>
    )
}
