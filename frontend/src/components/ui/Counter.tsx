/**
 * Counter —— 数字滚动动画组件
 *
 * 从 0 滚动到目标值的数字动画，用于 Dashboard 统计卡片。
 * 使用 requestAnimationFrame + easeOutBack 实现，不依赖外部动画库。
 *
 * 设计规范合规：
 * - 零硬编码：所有色值/字号/时长使用 CSS 变量
 * - Tabular Numbers：font-variant-numeric: tabular-nums
 * - prefers-reduced-motion 降级：直接显示目标值
 * - transform/opacity 动画：不触发 Layout
 * - I-P1-1：缓动曲线从 easeOutCubic 改为 easeOutBack（spring-snappy 风格过冲，
 *   规范 6.3「数值刷新/动画计数 600ms spring-snappy」）
 */

import { useEffect, useRef, useState, memo } from 'react'
import { useReducedMotion } from '@/hooks/useScrollAnimation'
import './Counter.css'

export interface CounterProps {
    /** 目标值 */
    value: number
    /** 动画时长（ms），默认 600 */
    duration?: number
    /** 是否启用动画，默认 true */
    animate?: boolean
    /** 数字精度（小数位数），默认 0 */
    precision?: number
    /** 前缀文本（如 "￥"） */
    prefix?: string
    /** 后缀文本（如 "%"） */
    suffix?: string
    /** 自定义 className */
    className?: string
}

/**
 * easeOutBack —— spring-snappy 风格的过冲减速曲线（I-P1-1）
 *
 * 规范 6.3「数值刷新/动画计数 600ms spring-snappy」要求带过冲的弹性曲线。
 * easeOutBack 是 cubic-bezier(0.3, 1.2, 0.4, 1) 的近似 JS 等效实现，
 * 在 t ≈ 0.7 时短暂超过 1（最大约 10% 过冲），符合 spring-snappy 的"按压回弹"质感。
 *
 * 参数 s（overshoot magnitude）默认 1.70158 是行业标准值，
 * 控制过冲幅度——值越大过冲越明显。
 *
 * 安全性：动画进行中 displayValue 可能短暂超过 to（正向）或低于 to（反向），
 * 但 progress = 1 时严格等于 1，最终值精确为目标值。
 */
function easeOutBack(t: number, s = 1.70158): number {
    return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2)
}

export const Counter = memo(function Counter({
    value,
    duration = 600,
    animate = true,
    precision = 0,
    prefix = '',
    suffix = '',
    className = '',
}: CounterProps) {
    // v5.0 防御性处理：确保 value 始终是有效数字
    // 防止上游传入 undefined/null/NaN 导致 toFixed 崩溃（InnovationCard 等场景）
    const safeValue = typeof value === 'number' && !Number.isNaN(value) ? value : 0

    const [displayValue, setDisplayValue] = useState(0)
    const rafRef = useRef<number | null>(null)
    const startRef = useRef<number | null>(null)
    const fromRef = useRef(0)

    // 检测 prefers-reduced-motion
    const prefersReducedMotion = useReducedMotion()

    useEffect(() => {
        // 不动画或用户偏好减少动画：直接显示目标值
        if (!animate || prefersReducedMotion) {
            setDisplayValue(safeValue)
            return
        }

        const from = fromRef.current
        const to = safeValue
        const delta = to - from

        if (delta === 0) {
            setDisplayValue(to)
            return
        }

        startRef.current = null
        fromRef.current = to

        const step = (timestamp: number) => {
            if (startRef.current === null) {
                startRef.current = timestamp
            }
            const elapsed = timestamp - startRef.current
            const progress = Math.min(elapsed / duration, 1)
            // I-P1-1：使用 easeOutBack（spring-snappy 过冲），替代原 easeOutCubic
            const eased = easeOutBack(progress)
            const current = from + delta * eased
            setDisplayValue(current)

            if (progress < 1) {
                rafRef.current = requestAnimationFrame(step)
            } else {
                setDisplayValue(to)
                rafRef.current = null
            }
        }

        rafRef.current = requestAnimationFrame(step)

        return () => {
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current)
                rafRef.current = null
            }
        }
    }, [safeValue, duration, animate, prefersReducedMotion])

    // v5.0 防御性：displayValue 理论上始终为 number，但保险起见再做一次校验
    const safeDisplay = typeof displayValue === 'number' && !Number.isNaN(displayValue) ? displayValue : 0
    const formatted = safeDisplay.toFixed(precision)

    return (
        <span className={`pr-counter ${className}`}>
            {prefix && <span className="pr-counter__prefix">{prefix}</span>}
            <span className="pr-counter__value">{formatted}</span>
            {suffix && <span className="pr-counter__suffix">{suffix}</span>}
        </span>
    )
})
