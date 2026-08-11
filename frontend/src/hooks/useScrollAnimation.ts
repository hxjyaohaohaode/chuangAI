/**
 * 滚动驱动动画 Hooks（规范第 6.5 章）
 *
 * 提供：
 * - useInView：Intersection Observer 入场触发（进入视口 20% 时触发淡入 + 上移）
 * - useParallax：视差层次（Hero 背景元素 0.4-0.6 倍速跟随滚动）
 * - useStickyGlass：吸顶毛玻璃（滚动超过阈值后触发 surface-glass + backdrop-blur 12px）
 *
 * 性能（规范 6.6）：
 * - 仅使用 transform / opacity，禁止 layout 属性
 * - ResizeObserver / scroll 回调 debounce 100ms
 * - prefers-reduced-motion 降级：视差与入场降级为 0
 */

import { useEffect, useRef, useState, useCallback } from 'react'

/* ============================================================
 * useInView —— Intersection Observer 入场触发
 * ============================================================ */

export interface UseInViewOptions {
    /** 触发阈值（0-1），默认 0.2（进入视口 20%） */
    threshold?: number
    /** 只触发一次（默认 true） */
    once?: boolean
    /** root margin */
    rootMargin?: string
    /** 初始可见态（默认 false） */
    initialVisible?: boolean
}

export function useInView<T extends HTMLElement = HTMLDivElement>(
    options: UseInViewOptions = {},
): [React.RefCallback<T>, boolean] {
    const { threshold = 0.2, once = true, rootMargin = '0px', initialVisible = false } = options
    const safeThreshold = Number.isFinite(threshold) ? Math.max(0, Math.min(1, threshold)) : 0.2
    const safeRootMargin = typeof rootMargin === 'string' && rootMargin.length <= 120
        ? rootMargin
        : '0px'
    const reduceMotion = useReducedMotion()
    // callback ref 让“异步数据到达后才挂载”的节点也会触发 effect。
    // 单纯 RefObject 的 current 变化不会触发渲染，条件渲染列表会永久漏观察。
    const [node, setNode] = useState<T | null>(null)
    const ref = useCallback((nextNode: T | null) => setNode(nextNode), [])
    const [inView, setInView] = useState(initialVisible)

    useEffect(() => {
        if (!node) return

        // 无 IO 支持时直接可见
        if (typeof IntersectionObserver === 'undefined') {
            setInView(true)
            return
        }

        // prefers-reduced-motion 降级：直接可见；动态切换时也立即停止等待入场。
        if (reduceMotion) {
            setInView(true)
            return
        }

        let observer: IntersectionObserver
        try {
            observer = new IntersectionObserver(
                (entries) => {
                    for (const entry of entries) {
                        if (entry.isIntersecting) {
                            setInView(true)
                            if (once) observer.disconnect()
                        } else if (!once) {
                            setInView(false)
                        }
                    }
                },
                { threshold: safeThreshold, rootMargin: safeRootMargin },
            )
        } catch {
            // 非法 rootMargin 或受限 WebView 的不完整实现不能让正文永久透明。
            setInView(true)
            return
        }

        try {
            observer.observe(node)
        } catch {
            observer.disconnect()
            setInView(true)
            return
        }
        return () => observer.disconnect()
    }, [node, safeThreshold, once, safeRootMargin, reduceMotion])

    return [ref, inView]
}

/* ============================================================
 * useParallax —— 视差层次
 * ============================================================ */

export interface UseParallaxOptions {
    /** 滚动倍速，0.4-0.6 为推荐值（背景慢于前景） */
    speed?: number
    /** 是否禁用（响应式控制） */
    disabled?: boolean
}

/**
 * 返回 [ref, style]。
 * style 包含 transform，直接展开到目标元素上。
 * 视差通过 translateY 跟随 scrollY * (1 - speed) 实现。
 */
export function useParallax<T extends HTMLElement = HTMLDivElement>(
    options: UseParallaxOptions = {},
): [React.RefObject<T>, React.CSSProperties] {
    const { speed = 0.5, disabled = false } = options
    const safeSpeed = Number.isFinite(speed) ? Math.max(-1, Math.min(2, speed)) : 0.5
    const reduceMotion = useReducedMotion()
    const ref = useRef<T>(null)
    const [offset, setOffset] = useState(0)

    useEffect(() => {
        if (disabled || reduceMotion) return

        let raf = 0
        let ticking = false

        const update = () => {
            ticking = false
            const scrollY = window.scrollY || 0
            // 负向偏移：背景向上移动慢于滚动，产生深度感
            setOffset(scrollY * (safeSpeed - 1))
        }

        const onScroll = () => {
            if (!ticking) {
                raf = requestAnimationFrame(update)
                ticking = true
            }
        }

        window.addEventListener('scroll', onScroll, { passive: true })
        update()
        return () => {
            window.removeEventListener('scroll', onScroll)
            if (raf) cancelAnimationFrame(raf)
        }
    }, [safeSpeed, disabled, reduceMotion])

    return [
        ref,
        {
            transform: disabled || reduceMotion ? undefined : `translate3d(0, ${offset}px, 0)`,
        },
    ]
}

/* ============================================================
 * useStickyGlass —— 吸顶毛玻璃触发器
 * ============================================================ */

/**
 * 监听滚动位置，超过阈值后返回 true（用于切换 surface-glass 玻璃态）。
 * 规范 6.5：导航栏滚动超过 48px 后触发 surface-glass（backdrop-blur 12px），200ms 过渡。
 */
export function useStickyGlass(threshold = 48): boolean {
    const safeThreshold = Number.isFinite(threshold) ? Math.max(0, threshold) : 48
    const [scrolled, setScrolled] = useState(false)

    useEffect(() => {
        let raf = 0
        let ticking = false

        const update = () => {
            ticking = false
            setScrolled((window.scrollY || 0) > safeThreshold)
        }

        const onScroll = () => {
            if (!ticking) {
                raf = requestAnimationFrame(update)
                ticking = true
            }
        }

        window.addEventListener('scroll', onScroll, { passive: true })
        update()
        return () => {
            window.removeEventListener('scroll', onScroll)
            if (raf) cancelAnimationFrame(raf)
        }
    }, [safeThreshold])

    return scrolled
}

/* ============================================================
 * useReducedMotion —— 检测用户是否偏好减弱动效
 * ============================================================ */

export function useReducedMotion(): boolean {
    const [reduced, setReduced] = useState(() => (
        typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ))

    useEffect(() => {
        const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
        if (!mq) return
        setReduced(mq.matches)
        const handler = (e: MediaQueryListEvent) => setReduced(e.matches)
        if (typeof mq.addEventListener === 'function') {
            mq.addEventListener('change', handler)
            return () => mq.removeEventListener('change', handler)
        }
        if (typeof mq.addListener === 'function') {
            mq.addListener(handler)
            return () => mq.removeListener?.(handler)
        }
        return undefined
    }, [])

    return reduced
}

/* ============================================================
 * useScrollProgress —— 整页滚动进度（0-1）
 * 用于顶部阅读进度条等场景
 * ============================================================ */

export function useScrollProgress(): number {
    const [progress, setProgress] = useState(0)

    const onScroll = useCallback(() => {
        const doc = document.documentElement
        const max = doc.scrollHeight - doc.clientHeight
        setProgress(max > 0 ? Math.max(0, Math.min(1, (window.scrollY || 0) / max)) : 0)
    }, [])

    useEffect(() => {
        let raf = 0
        let ticking = false
        const handler = () => {
            if (!ticking) {
                raf = requestAnimationFrame(() => {
                    onScroll()
                    ticking = false
                })
                ticking = true
            }
        }
        window.addEventListener('scroll', handler, { passive: true })
        window.addEventListener('resize', handler, { passive: true })
        onScroll()
        return () => {
            window.removeEventListener('scroll', handler)
            window.removeEventListener('resize', handler)
            if (raf) cancelAnimationFrame(raf)
        }
    }, [onScroll])

    return progress
}
