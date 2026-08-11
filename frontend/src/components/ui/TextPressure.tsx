/**
 * TextPressure —— 教学理念的低干扰文字锚点。
 *
 * 2026-08-09 独立实现：替换本地“优质前端部件组”中来源未闭合的逐字鼠标形变实现。
 * 它不加载外部字体、不注册全局鼠标/触摸监听器，也不以持续动画损害阅读；仅在有
 * 指针悬停能力时提供克制的逐字层次反馈，系统减弱动态时保持稳定文本。
 */

import { memo, useMemo, type CSSProperties } from 'react'
import { cn } from '@/lib/cn'
import './TextPressure.css'

export interface TextPressureProps {
    text?: string
    /** 保留调用契约；外部字体不再由组件加载，调用方应通过本地 CSS 提供字体。 */
    fontFamily?: string
    /** 保留兼容字段；出于 CSP、性能和来源边界，不再发起外部字体请求。 */
    fontUrl?: string
    flex?: boolean
    scale?: boolean
    alpha?: boolean
    stroke?: boolean
    width?: boolean
    weight?: boolean
    italic?: boolean
    textColor?: string
    strokeColor?: string
    className?: string
    minFontSize?: number
}

export const TextPressure = memo(function TextPressure({
    text = 'Compressa',
    fontFamily = 'Inter, "Inter Display", "Noto Sans SC", sans-serif',
    flex = true,
    scale = false,
    alpha = false,
    stroke = false,
    width = true,
    weight = true,
    italic = false,
    textColor = 'rgb(var(--c-text-primary, 44 36 26))',
    strokeColor = 'rgb(var(--c-accent-primary, 152 98 39))',
    className,
    minFontSize = 24,
}: TextPressureProps) {
    const characters = useMemo(() => Array.from(text), [text])
    const safeMinimum = Math.max(16, Math.min(112, Number.isFinite(minFontSize) ? minFontSize : 24))
    const styles = {
        '--pr-text-pressure-color': textColor,
        '--pr-text-pressure-stroke': strokeColor,
        '--pr-text-pressure-font': fontFamily,
        '--pr-text-pressure-min': `${safeMinimum}px`,
    } as CSSProperties

    return (
        <div
            className={cn(
                'pr-text-pressure',
                flex && 'pr-text-pressure--flex',
                scale && 'pr-text-pressure--scale',
                alpha && 'pr-text-pressure--alpha',
                stroke && 'pr-text-pressure--stroke',
                width && 'pr-text-pressure--width',
                weight && 'pr-text-pressure--weight',
                italic && 'pr-text-pressure--italic',
                className,
            )}
            style={styles}
        >
            <p className="pr-text-pressure-title">
                {characters.map((character, index) => (
                    <span
                        key={`${character}-${index}`}
                        className="pr-text-pressure-char"
                        style={{ '--pr-text-pressure-index': index } as CSSProperties}
                    >
                        {character === ' ' ? '\u00a0' : character}
                    </span>
                ))}
            </p>
        </div>
    )
})
