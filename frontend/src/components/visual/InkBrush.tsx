/**
 * InkBrush 水墨笔触动画组件（视觉创新层 1/4）
 *
 * 核心机制：GSAP 驱动 SVG <text> 的 stroke-dashoffset 描边动画，模拟毛笔逐字书写。
 * - 每个字符渲染为独立 SVG，<text> 同时承载 stroke（运笔轨迹）与 fill（填墨浓淡）
 * - paint-order: stroke fill → 先勾勒字形轮廓，再填墨，形成"先勾勒后填墨"的书写感
 * - 4 种笔触风格：造笔(起笔)、晕染(浓淡)、枯笔(飞白)、飞白(收笔)
 *
 * 设计规范合规：
 * - 颜色使用 --c-text-primary 不同 alpha（规范 2.x），零硬编码
 * - 动画仅 transform/opacity/stroke-dashoffset（GPU 合成 + 可绘属性，规范 6.6）
 * - 缓动 --ease-out，时长 150-450ms（笔触绘制稍长以可见，规范 6.3）
 * - prefers-reduced-motion 降级：直接显示完整文字（规范 6.6）
 * - GSAP tween 卸载时 kill，防内存泄漏
 *
 * 三大子组件：
 * - <InkBrush text="诗韵" />      逐字毛笔书写
 * - <InkDivider />               水墨分割线（自绘笔触）
 * - <InkSplash />                墨迹扩散背景装饰
 */

import { useLayoutEffect, useRef, useMemo, type CSSProperties } from 'react'
import { gsap } from 'gsap'
import { cn } from '@/lib/cn'
import './InkBrush.css'

/* ============================================================
 * 类型定义
 * ============================================================ */

/** 笔触风格 —— 对应书法运笔四法 */
export type InkBrushStyle = 'zao' | 'yun' | 'ku' | 'fei'

export interface InkBrushProps {
    /** 要书写的文字（逐字绘制） */
    text: string
    /** 笔触风格，默认 zao（起笔） */
    brushStyle?: InkBrushStyle
    /** 字号，默认继承 */
    fontSize?: string | number
    /** 每字书写时长（毫秒），默认 480（可见的毛笔节奏） */
    duration?: number
    /** 字间停顿（毫秒），默认 120 */
    stagger?: number
    /** 是否循环书写，默认 false */
    loop?: boolean
    /** 是否显示书写光标，默认 true */
    showCursor?: boolean
    /** 容器额外 className */
    className?: string
    /** 容器额外 style */
    style?: CSSProperties
}

/** 各风格的填墨目标不透明度（浓淡） */
const FILL_TARGET: Record<InkBrushStyle, number> = {
    zao: 0.85, // 起笔：实墨
    yun: 0.78, // 晕染：浓淡过渡
    ku: 0.58, // 枯笔：干涩少墨
    fei: 0.72, // 飞白：收笔略淡
}

// 描边虚线长度上限（text stroke 无法精确测长，用足够大的值覆盖字形周长）
const STROKE_DASH = 320

/* ============================================================
 * InkBrush —— 逐字毛笔书写主组件
 * ============================================================ */
export function InkBrush({
    text,
    brushStyle = 'zao',
    fontSize,
    duration = 480,
    stagger = 120,
    loop = false,
    showCursor = true,
    className,
    style,
}: InkBrushProps) {
    const containerRef = useRef<HTMLSpanElement | null>(null)
    const chars = useMemo(() => Array.from(text), [text])
    const fillTarget = FILL_TARGET[brushStyle]

    useLayoutEffect(() => {
        const el = containerRef.current
        if (!el) return

        const charEls = el.querySelectorAll<HTMLElement>('.pr-ink-brush__char')
        const strokeEls = el.querySelectorAll<SVGElement>('.pr-ink-brush__stroke')
        const fillEls = el.querySelectorAll<SVGElement>('.pr-ink-brush__fill')
        const cursorEl = el.querySelector<HTMLElement>('.pr-ink-brush__cursor')

        // prefers-reduced-motion：直接显示完整文字（规范 6.6）
        const prefersReducedMotion =
            typeof window !== 'undefined' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches

        if (prefersReducedMotion) {
            gsap.set(charEls, { opacity: 1 })
            gsap.set(fillEls, { opacity: fillTarget })
            gsap.set(strokeEls, { strokeDashoffset: 0 })
            return
        }

        // 初始状态：字符隐藏、描边未绘制、填墨透明
        gsap.set(charEls, { opacity: 0 })
        gsap.set(strokeEls, { strokeDasharray: STROKE_DASH, strokeDashoffset: STROKE_DASH })
        gsap.set(fillEls, { opacity: 0 })

        const tweens: gsap.core.Tween[] = []

        // 逐字时间线：字符显现 → 描边绘制 → 填墨晕染
        const tl = gsap.timeline({
            repeat: loop ? -1 : 0,
            defaults: { ease: 'power2.out' },
        })
        tweens.push(tl as unknown as gsap.core.Tween)

        chars.forEach((_, i) => {
            const charEl = charEls[i]
            const strokeEl = strokeEls[i]
            const fillEl = fillEls[i]
            if (!charEl || !strokeEl || !fillEl) return

            const pos = i * (duration + stagger)

            // 1. 字符容器淡入（造笔：起笔利落）
            tl.to(charEl, { opacity: 1, duration: 0.15 }, pos)
            // 2. 描边绘制（运笔轨迹，stroke-dashoffset → 0）
            tl.to(strokeEl, { strokeDashoffset: 0, duration: duration / 1000 }, pos)
            // 3. 填墨晕染（描边完成 60% 时开始填墨，模拟墨色渗透）
            tl.to(fillEl, { opacity: fillTarget, duration: 0.28 }, pos + (duration / 1000) * 0.6)
        })

        // 光标：最后字符书写时点亮，结束后淡出
        if (showCursor && cursorEl) {
            const lastPos = Math.max(0, chars.length - 1) * (duration + stagger)
            tl.to(cursorEl, { opacity: 0.7, duration: 0.15 }, lastPos)
            tl.to(cursorEl, { opacity: 0, duration: 0.2, ease: 'power2.in' }, lastPos + duration / 1000 + 0.4)
        }

        return () => {
            tweens.forEach((t) => t.kill())
        }
    }, [text, brushStyle, duration, stagger, loop, showCursor, fillTarget, chars.length])

    const containerStyle: CSSProperties = {
        ...style,
        fontSize: typeof fontSize === 'number' ? `${fontSize}px` : fontSize,
    }

    return (
        <span
            ref={containerRef}
            className={cn('pr-ink-brush', `pr-ink-brush--style-${brushStyle}`, className)}
            style={containerStyle}
            role="text"
            aria-label={text}
        >
            {chars.map((ch, i) => (
                <span className="pr-ink-brush__char" key={`${ch}-${i}`}>
                    <svg
                        className="pr-ink-brush__svg"
                        width="1em"
                        height="1em"
                        viewBox="0 0 100 100"
                        aria-hidden="true"
                    >
                        {/* fill 层在下，stroke 层在上（paint-order 已控制绘制顺序） */}
                        <text
                            className="pr-ink-brush__fill"
                            x="50"
                            y="76"
                            fontSize="80"
                            textAnchor="middle"
                            fontFamily="var(--font-serif-italic)"
                        >
                            {ch}
                        </text>
                        <text
                            className="pr-ink-brush__stroke"
                            x="50"
                            y="76"
                            fontSize="80"
                            textAnchor="middle"
                            fontFamily="var(--font-serif-italic)"
                        >
                            {ch}
                        </text>
                    </svg>
                </span>
            ))}
            {showCursor && <span className="pr-ink-brush__cursor" aria-hidden="true" />}
        </span>
    )
}

/* ============================================================
 * InkDivider —— 水墨分割线
 * ============================================================ */
export interface InkDividerProps {
    /** 居中收束变体，默认 false（满宽） */
    center?: boolean
    /** 是否播放绘制动画，默认 true */
    animated?: boolean
    className?: string
}

export function InkDivider({ center = false, animated = true, className }: InkDividerProps) {
    const pathRef = useRef<SVGPathElement | null>(null)

    useLayoutEffect(() => {
        const el = pathRef.current
        if (!el || !animated) return

        const prefersReducedMotion =
            typeof window !== 'undefined' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (prefersReducedMotion) {
            gsap.set(el, { strokeDashoffset: 0 })
            return
        }

        const len = el.getTotalLength()
        gsap.set(el, { strokeDasharray: len, strokeDashoffset: len })
        const tween = gsap.to(el, {
            strokeDashoffset: 0,
            duration: 0.9,
            ease: 'power1.inOut',
        })
        return () => {
            tween.kill()
        }
    }, [animated])

    // 一笔挥就的水墨分割路径：起笔重 → 中段起伏 → 收笔
    const d = 'M2 7 Q 60 3 120 8 T 240 7 T 360 8 T 480 7 T 600 8 T 720 7'

    return (
        <div className={cn('pr-ink-divider', center && 'pr-ink-divider--center', className)} role="separator">
            <svg
                className="pr-ink-divider__svg"
                viewBox="0 0 720 14"
                preserveAspectRatio="none"
                aria-hidden="true"
            >
                <path className="pr-ink-divider__path" ref={pathRef} d={d} />
            </svg>
        </div>
    )
}

/* ============================================================
 * InkSplash —— 墨迹扩散背景装饰
 * ============================================================ */
export interface InkSplashProps {
    /** 墨团数量，默认 3 */
    blobs?: number
    /** 墨点数量，默认 8 */
    dots?: number
    className?: string
}

/** 生成伪随机但不重复的墨团参数（基于索引稳定） */
function blobParams(i: number) {
    const seed = (i * 9301 + 49297) % 233280
    const r = seed / 233280
    const x = 10 + r * 80
    const y = ((i * 53 + 17) % 100)
    const scale = 0.6 + r * 0.9
    const opacity = 0.04 + r * 0.05
    return { x, y, scale, opacity }
}

export function InkSplash({ blobs = 3, dots = 8, className }: InkSplashProps) {
    const svgRef = useRef<SVGSVGElement | null>(null)

    // 预生成墨团/墨点参数（useMemo 稳定）
    const blobData = useMemo(
        () => Array.from({ length: blobs }, (_, i) => blobParams(i)),
        [blobs],
    )
    const dotData = useMemo(
        () =>
            Array.from({ length: dots }, (_, i) => {
                const seed = (i * 4099 + 7919) % 233280
                const r = seed / 233280
                return {
                    x: r * 100,
                    y: ((i * 137 + 41) % 100),
                    r: 1 + r * 2.4,
                    opacity: 0.05 + r * 0.06,
                }
            }),
        [dots],
    )

    useLayoutEffect(() => {
        const svg = svgRef.current
        if (!svg) return

        const blobEls = svg.querySelectorAll<SVGElement>('.pr-ink-splash__blob')
        const dotEls = svg.querySelectorAll<SVGElement>('.pr-ink-splash__dot')

        const prefersReducedMotion =
            typeof window !== 'undefined' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (prefersReducedMotion) {
            blobEls.forEach((el, i) => {
                gsap.set(el, { opacity: blobData[i]?.opacity ?? 0.05, scale: 1 })
            })
            dotEls.forEach((el, i) => {
                gsap.set(el, { opacity: dotData[i]?.opacity ?? 0.05 })
            })
            return
        }

        const tweens: gsap.core.Tween[] = []

        // 墨团：从 0 扩散到目标，缓慢循环呼吸
        blobEls.forEach((el, i) => {
            const p = blobData[i]
            if (!p) return
            gsap.set(el, { transformOrigin: 'center', scale: 0, opacity: 0 })
            const tl = gsap.timeline({ delay: i * 0.6, repeat: -1, yoyo: true, defaults: { ease: 'sine.inOut' } })
            tl.to(el, { scale: p.scale, opacity: p.opacity, duration: 2.4 })
            tl.to(el, { opacity: p.opacity * 0.5, duration: 2.8 })
            tweens.push(tl as unknown as gsap.core.Tween)
        })

        // 墨点：错峰淡入后保持
        dotEls.forEach((el, i) => {
            const p = dotData[i]
            if (!p) return
            gsap.set(el, { opacity: 0 })
            const tween = gsap.to(el, { opacity: p.opacity, duration: 0.6, delay: 0.8 + i * 0.15 })
            tweens.push(tween)
        })

        return () => {
            tweens.forEach((t) => t.kill())
        }
    }, [blobData, dotData])

    return (
        <div className={cn('pr-ink-splash', className)} aria-hidden="true">
            <svg className="pr-ink-splash__svg" ref={svgRef} viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
                {blobData.map((p, i) => (
                    <path
                        key={`blob-${i}`}
                        className="pr-ink-splash__blob"
                        // 不规则墨团形状（手调 path）
                        d={`M${p.x} ${p.y} q 4 -6 10 -2 q 6 3 3 9 q -1 5 -7 4 q -7 0 -6 -11 z`}
                    />
                ))}
                {dotData.map((p, i) => (
                    <circle
                        key={`dot-${i}`}
                        className="pr-ink-splash__dot"
                        cx={p.x}
                        cy={p.y}
                        r={p.r}
                    />
                ))}
            </svg>
        </div>
    )
}
