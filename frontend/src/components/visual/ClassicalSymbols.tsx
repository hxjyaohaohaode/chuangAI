/**
 * ClassicalSymbols 古典文化符号组件库（视觉创新层 2/4）
 *
 * 全部 SVG 手绘，零 emoji（规范 13.1）。颜色使用 currentColor 继承父级 + 设计 token。
 *
 * 组件清单：
 * - <Seal stamp="已阅" />               朱砂印章（状态徽记/认证标记）
 * - <ScrollExpand>...</ScrollExpand>    折扇展开容器（children 从中心展开）
 * - <BambooSlip lines={[...]} />        竹简表序容器（竖排文字）
 * - <FolioPage>...</FolioPage>          册页卷帙容器（带装订线）
 * - <CloudPattern>...</CloudPattern>    云纹装饰边框
 *
 * 设计规范合规：
 * - 透明度驱动分层，无边框优先（规范 4.1）
 * - 动画仅 transform/opacity，时长 150-400ms，缓动 --ease-out/--spring-soft（规范 6.x）
 * - prefers-reduced-motion 降级（规范 6.6）
 */

import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { gsap } from 'gsap'
import { cn } from '@/lib/cn'
import './ClassicalSymbols.css'

/* ============================================================
 * 1. Seal —— 朱砂印章
 * ============================================================ */
export interface SealProps {
    /** 印文（1-4 字） */
    stamp: string
    /** 形状，默认 square */
    shape?: 'square' | 'round'
    /** 尺寸，默认 3.5em */
    size?: string | number
    /** 是否播放盖章入场动画，默认 true */
    animated?: boolean
    className?: string
    style?: CSSProperties
}

export function Seal({
    stamp,
    shape = 'square',
    size,
    animated = true,
    className,
    style,
}: SealProps) {
    const chars = Array.from(stamp).slice(0, 4)
    // 印文布局：1 字居中；2 字上下；3-4 字 2x2
    const layout = chars.length <= 1 ? '1x1' : chars.length === 2 ? '1x2' : '2x2'

    // 文字坐标（viewBox 0 0 100 100）
    const positions: Record<'1x1' | '1x2' | '2x2', Array<{ x: number; y: number }>> = {
        '1x1': [{ x: 50, y: 50 }],
        '1x2': [{ x: 50, y: 34 }, { x: 50, y: 66 }],
        '2x2': [
            { x: 34, y: 34 },
            { x: 66, y: 34 },
            { x: 34, y: 66 },
            { x: 66, y: 66 },
        ],
    }
    const pos = positions[layout]
    const fontSize = layout === '1x1' ? 44 : layout === '1x2' ? 30 : 26

    const containerStyle: CSSProperties = {
        ...style,
        width: typeof size === 'number' ? `${size}px` : size,
        height: typeof size === 'number' ? `${size}px` : size,
    }

    return (
        <span
            className={cn(
                'pr-seal',
                `pr-seal--${shape}`,
                animated && 'pr-seal--animated',
                className,
            )}
            style={containerStyle}
            role="img"
            aria-label={`印章：${stamp}`}
        >
            <svg className="pr-seal__svg" viewBox="0 0 100 100" aria-hidden="true">
                {shape === 'square' ? (
                    <rect className="pr-seal__body" x="6" y="6" width="88" height="88" rx="6" />
                ) : (
                    <circle className="pr-seal__body" cx="50" cy="50" r="44" />
                )}
                {/* 内框 */}
                {shape === 'square' ? (
                    <rect className="pr-seal__frame" x="12" y="12" width="76" height="76" rx="3" />
                ) : (
                    <circle className="pr-seal__frame" cx="50" cy="50" r="38" />
                )}
                {/* 印文 */}
                {chars.map((ch, i) => (
                    <text
                        key={`${ch}-${i}`}
                        className="pr-seal__text"
                        x={pos[i]?.x ?? 50}
                        y={pos[i]?.y ?? 50}
                        fontSize={fontSize}
                    >
                        {ch}
                    </text>
                ))}
            </svg>
        </span>
    )
}

/* ============================================================
 * 2. ScrollExpand —— 折扇展开容器
 * ============================================================ */
export interface ScrollExpandProps {
    children: ReactNode
    /** 展开时长（毫秒），默认 400 */
    duration?: number
    /** 延迟（毫秒），默认 0 */
    delay?: number
    className?: string
    style?: CSSProperties
}

export function ScrollExpand({
    children,
    duration = 400,
    delay = 0,
    className,
    style,
}: ScrollExpandProps) {
    const contentRef = useRef<HTMLDivElement | null>(null)

    useLayoutEffect(() => {
        const el = contentRef.current
        if (!el) return

        const prefersReducedMotion =
            typeof window !== 'undefined' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (prefersReducedMotion) {
            gsap.set(el, { scaleX: 1, opacity: 1 })
            return
        }

        // 折扇展开：scaleX 0 → 1，从中心展开 + 淡入
        gsap.set(el, { scaleX: 0, opacity: 0, transformOrigin: 'center' })
        const tween = gsap.to(el, {
            scaleX: 1,
            opacity: 1,
            duration: duration / 1000,
            delay: delay / 1000,
            ease: 'power3.out',
        })
        return () => {
            tween.kill()
        }
    }, [duration, delay])

    return (
        <div className={cn('pr-scroll-expand', className)} style={style}>
            <div className="pr-scroll-expand__content" ref={contentRef}>
                {children}
            </div>
        </div>
    )
}

/* ============================================================
 * 3. BambooSlip —— 竹简表序容器
 * ============================================================ */
export interface BambooSlipProps {
    /** 诗句行（每行渲染为一片竹简，竖排书写） */
    lines: string[]
    /** 是否播放逐片展开入场，默认 true */
    animated?: boolean
    className?: string
}

export function BambooSlip({ lines, animated = true, className }: BambooSlipProps) {
    const containerRef = useRef<HTMLDivElement | null>(null)

    useLayoutEffect(() => {
        const el = containerRef.current
        if (!el || !animated) return

        const slips = el.querySelectorAll<HTMLElement>('.pr-bamboo-slip__slip')

        const prefersReducedMotion =
            typeof window !== 'undefined' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (prefersReducedMotion) {
            gsap.set(slips, { opacity: 1, y: 0 })
            return
        }

        // 逐片从下淡入，stagger 80ms（规范 6.3 列表交错入场）
        gsap.set(slips, { opacity: 0, y: 8 })
        const tween = gsap.to(slips, {
            opacity: 1,
            y: 0,
            duration: 0.3,
            stagger: 0.08,
            ease: 'power2.out',
        })
        return () => {
            tween.kill()
        }
    }, [animated, lines.length])

    return (
        <div className={cn('pr-bamboo-slip', className)} ref={containerRef} role="list">
            {lines.map((line, i) => (
                <div className="pr-bamboo-slip__slip" key={`slip-${i}`} role="listitem">
                    <span className="pr-bamboo-slip__cord pr-bamboo-slip__cord--top" aria-hidden="true" />
                    <span className="pr-bamboo-slip__text">{line}</span>
                    <span className="pr-bamboo-slip__cord pr-bamboo-slip__cord--bottom" aria-hidden="true" />
                </div>
            ))}
        </div>
    )
}

/* ============================================================
 * 4. FolioPage —— 册页卷帙容器（带装订线）
 * ============================================================ */
export interface FolioPageProps {
    children: ReactNode
    /** 装订孔数量，默认 6 */
    holes?: number
    className?: string
    style?: CSSProperties
}

export function FolioPage({ children, holes = 6, className, style }: FolioPageProps) {
    return (
        <div className={cn('pr-folio-page', className)} style={style}>
            <div className="pr-folio-page__binding" aria-hidden="true">
                {Array.from({ length: holes }, (_, i) => (
                    <span className="pr-folio-page__hole" key={`hole-${i}`} />
                ))}
            </div>
            <span className="pr-folio-page__thread" aria-hidden="true" />
            {children}
        </div>
    )
}

/* ============================================================
 * 5. CloudPattern —— 云纹装饰边框
 * ============================================================ */
export interface CloudPatternProps {
    children: ReactNode
    className?: string
    style?: CSSProperties
}

export function CloudPattern({ children, className, style }: CloudPatternProps) {
    return (
        <div className={cn('pr-cloud-pattern', className)} style={style}>
            <svg className="pr-cloud-pattern__svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                {/* 顶部云纹带 */}
                <g>
                    <path className="pr-cloud-pattern__stroke" d="M2 6 Q 10 2 18 6 T 34 6 T 50 6 T 66 6 T 82 6 T 98 6" />
                    <path className="pr-cloud-pattern__stroke" d="M2 12 Q 10 8 18 12 T 34 12 T 50 12 T 66 12 T 82 12 T 98 12" opacity="0.5" />
                </g>
                {/* 底部云纹带（镜像） */}
                <g transform="translate(0 100) scale(1 -1)">
                    <path className="pr-cloud-pattern__stroke" d="M2 6 Q 10 2 18 6 T 34 6 T 50 6 T 66 6 T 82 6 T 98 6" />
                    <path className="pr-cloud-pattern__stroke" d="M2 12 Q 10 8 18 12 T 34 12 T 50 12 T 66 12 T 82 12 T 98 12" opacity="0.5" />
                </g>
                {/* 左右云纹点缀 */}
                <path className="pr-cloud-pattern__stroke" d="M4 50 Q 2 40 8 38 Q 14 36 14 46 Q 14 54 8 54 Q 2 54 4 50 Z" opacity="0.4" />
                <path className="pr-cloud-pattern__stroke" d="M96 50 Q 98 40 92 38 Q 86 36 86 46 Q 86 54 92 54 Q 98 54 96 50 Z" opacity="0.4" />
            </svg>
            {children}
        </div>
    )
}
