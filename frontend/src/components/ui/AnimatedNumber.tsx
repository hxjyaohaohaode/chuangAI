/**
 * 数值刷新动画组件（规范 6.3 / 14.x）
 *
 * spring-bounce 动画计数（600ms），Tabular Numbers 保持对齐。
 * 应用场景：Dashboard 统计数字、Diagnosis 分数、Grading 正确率。
 *
 * 设计要点：
 * - 数字从旧值平滑过渡到新值，使用 spring-snappy 缓动
 * - 支持整数 / 小数（指定 precision）
 * - 支持千分位格式化
 * - rAF 驱动，60fps
 * - prefers-reduced-motion 降级：直接显示终值
 * - font-variant-numeric: tabular-nums 保证数字宽度一致
 */

import { useEffect, useRef, useState, memo } from 'react'

export interface AnimatedNumberProps {
    /** 目标数值 */
    value: number
    /** 小数位数，默认 0 */
    precision?: number
    /** 是否千分位格式化，默认 true */
    thousandsSeparator?: boolean
    /** 动画时长（ms），默认 600 */
    duration?: number
    /** 前缀（如货币符号） */
    prefix?: string
    /** 后缀（如 %、单位） */
    suffix?: string
    /** 字号 class（继承父级或自定义） */
    className?: string
    /** aria-label */
    ariaLabel?: string
}

/** spring-snappy 缓动函数（cubic-bezier(0.3, 1.2, 0.4, 1) 的 JS 近似） */
function springSnappy(t: number): number {
    // 超出回弹的 spring 近似：先冲过 1 再回落
    // 使用一个带轻微过冲的缓动
    const c = 1.2 // 过冲量
    const t2 = t - 1
    return 1 + (c + 1) * t2 * t2 * t2 + c * t2 * t2
}

/** 格式化数字 */
function formatNumber(
    n: number,
    precision: number,
    thousandsSeparator: boolean,
): string {
    const fixed = n.toFixed(precision)
    if (!thousandsSeparator) return fixed
    const parts = fixed.split('.')
    const intPart = parts[0] ?? ''
    const decPart = parts[1]
    const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return decPart !== undefined ? `${withSep}.${decPart}` : withSep
}

export const AnimatedNumber = memo(function AnimatedNumber({
    value,
    precision = 0,
    thousandsSeparator = true,
    duration = 600,
    prefix = '',
    suffix = '',
    className,
    ariaLabel,
}: AnimatedNumberProps) {
    const [display, setDisplay] = useState(value)
    const fromRef = useRef(value)
    const rafRef = useRef(0)
    const startRef = useRef(0)

    useEffect(() => {
        // prefers-reduced-motion 降级
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        if (reduceMotion || duration <= 0) {
            setDisplay(value)
            fromRef.current = value
            return
        }

        const from = fromRef.current
        const to = value

        // 值未变化
        if (from === to) return

        const delta = to - from

        const tick = (now: number) => {
            if (!startRef.current) startRef.current = now
            const elapsed = now - startRef.current
            const t = Math.min(1, elapsed / duration)
            const eased = springSnappy(t)
            // 当前值（可能在接近 1 时略微超出，最终回到 to）
            const current = from + delta * eased
            setDisplay(current)

            if (t < 1) {
                rafRef.current = requestAnimationFrame(tick)
            } else {
                setDisplay(to)
                fromRef.current = to
                startRef.current = 0
            }
        }

        startRef.current = 0
        rafRef.current = requestAnimationFrame(tick)

        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current)
            // 卸载时更新起点，避免下次从旧值开始
            fromRef.current = value
        }
    }, [value, duration])

    const formatted = formatNumber(display, precision, thousandsSeparator)

    return (
        <span
            className={className}
            style={{ fontVariantNumeric: 'tabular-nums' }}
            aria-label={ariaLabel ?? `${prefix}${formatted}${suffix}`}
            role="status"
            aria-live="polite"
        >
            {prefix}
            {formatted}
            {suffix}
        </span>
    )
})
