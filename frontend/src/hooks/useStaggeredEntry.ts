/**
 * 列表入场 staggered 动画 Hook（规范 6.3 / 7.2）
 *
 * 列表项逐个入场，每项 50ms 延迟 × N，spring-snappy 缓动。
 * 应用场景：Dashboard 预警列表、Workbench 题目列表、Grading 批改队列。
 *
 * 用法：
 *   const { ref, itemStyle } = useStaggeredEntry(items.length)
 *   <ul ref={ref}>
 *     {items.map((it, i) => <li style={itemStyle(i)}>{...}</li>)}
 *   </ul>
 *
 * 性能（规范 6.6）：
 * - 仅 transform / opacity 动画
 * - 单页并发动画 ≤ 30 个（超过 30 项后延迟封顶）
 * - prefers-reduced-motion 降级为 0 时长
 */

import { useEffect, useState } from 'react'
import { useInView } from './useScrollAnimation'

export interface UseStaggeredEntryOptions {
    /** 每项延迟（ms），默认 50 */
    step?: number
    /** 最大延迟封顶（ms），默认 600（防超长列表卡顿） */
    maxDelay?: number
    /** 触发阈值，默认 0.1 */
    threshold?: number
    /** 是否在视口外也触发（默认 false，进入视口才触发） */
    immediate?: boolean
}

export function useStaggeredEntry<T extends HTMLElement = HTMLUListElement>(
    itemCount: number,
    options: UseStaggeredEntryOptions = {},
) {
    const { step = 50, maxDelay = 600, threshold = 0.1, immediate = false } = options
    const safeItemCount = Number.isFinite(itemCount) ? Math.max(0, Math.floor(itemCount)) : 0
    const safeStep = Number.isFinite(step) ? Math.max(0, Math.min(1_000, Math.round(step))) : 50
    const safeMaxDelay = Number.isFinite(maxDelay)
        ? Math.max(0, Math.min(5_000, Math.round(maxDelay)))
        : 600
    // 规范 6.6: 单页并发动画 ≤ 30 个；超出部分立即显示，无延迟
    const animatedCount = Math.min(safeItemCount, 30)
    const [ref, inView] = useInView<T>({ threshold, once: true, initialVisible: immediate })
    const [started, setStarted] = useState(immediate)

    useEffect(() => {
        if (inView && !started) {
            setStarted(true)
        }
    }, [inView, started])

    /** 获取第 index 项的入场样式 */
    const itemStyle = (index: number): React.CSSProperties => {
        if (!started) {
            // 初始隐藏态
            return {
                opacity: 0,
                transform: 'translateY(12px)',
            }
        }
        // 超出并发上限的项立即显示，无延迟（规范 6.6）
        const delay = index < animatedCount ? Math.min(index * safeStep, safeMaxDelay) : 0
        return {
            opacity: 1,
            transform: 'translateY(0)',
            transition: `opacity var(--dur-medium) var(--spring-snappy) ${delay}ms, transform var(--dur-medium) var(--spring-snappy) ${delay}ms`,
        }
    }

    return { ref, started, itemStyle }
}
