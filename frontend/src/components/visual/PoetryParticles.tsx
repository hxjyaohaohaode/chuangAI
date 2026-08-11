/**
 * PoetryParticles 流体诗意粒子组件（视觉创新层 4/4）
 *
 * 纯 SVG + GSAP（非 Canvas）实现的诗意粒子系统。
 * - 4 种主题：花瓣飘落 / 雪花纷飞 / 萤火虫光点 / 墨点扩散
 * - 数量自适应：mobile 15 个，desktop 30 个
 * - 仅 transform/opacity 动画，will-change: transform（规范 6.6 性能硬指标）
 * - pointer-events: none，不干扰交互
 * - prefers-reduced-motion 降级为静态分布
 * - 暖调色板 alpha，零硬编码
 */

import { useLayoutEffect, useRef, useMemo, type CSSProperties } from 'react'
import { gsap } from 'gsap'
import { cn } from '@/lib/cn'
import './PoetryParticles.css'

/* ============================================================
 * 类型定义
 * ============================================================ */
export type PoetryParticleVariant = 'petals' | 'snow' | 'fireflies' | 'ink'

export interface PoetryParticlesProps {
    /** 粒子主题，默认 petals */
    variant?: PoetryParticleVariant
    /** 粒子数量（不传则按视口自适应：mobile 15 / desktop 30） */
    count?: number
    /** 容器额外 className */
    className?: string
    /** 容器额外 style */
    style?: CSSProperties
}

/** 单粒子初始配置（位置/尺寸/相位均稳定随机） */
interface ParticleConfig {
    x: number
    y: number
    size: number
    delay: number
    duration: number
    drift: number
}

/** 伪随机数生成（基于种子稳定，避免重渲染抖动） */
function seededRand(seed: number): number {
    const x = Math.sin(seed * 9301 + 49297) * 233280
    return x - Math.floor(x)
}

/** 生成 N 个粒子的稳定配置 */
function genConfigs(count: number, seedOffset = 0): ParticleConfig[] {
    return Array.from({ length: count }, (_, i) => {
        const r1 = seededRand(i + 1 + seedOffset)
        const r2 = seededRand(i + 1 + seedOffset + 999)
        const r3 = seededRand(i + 1 + seedOffset + 1999)
        const r4 = seededRand(i + 1 + seedOffset + 2999)
        const r5 = seededRand(i + 1 + seedOffset + 3999)
        return {
            x: r1 * 100,
            y: r2 * 100,
            size: 0.6 + r3 * 1.6,
            delay: r4 * 6,
            duration: 6 + r5 * 8,
            drift: (r3 - 0.5) * 30,
        }
    })
}

/** 视口自适应粒子数量 */
function adaptiveCount(): number {
    if (typeof window === 'undefined') return 20
    return window.innerWidth < 768 ? 15 : 30
}

/* ============================================================
 * 主组件
 * ============================================================ */
export function PoetryParticles({
    variant = 'petals',
    count,
    className,
    style,
}: PoetryParticlesProps) {
    const svgRef = useRef<SVGSVGElement | null>(null)
    const n = useMemo(() => count ?? adaptiveCount(), [count])
    const configs = useMemo(() => genConfigs(n, variant.length * 7), [n, variant])

    useLayoutEffect(() => {
        const svg = svgRef.current
        if (!svg) return

        const particles = svg.querySelectorAll<SVGElement>('.pr-poetry-particles__particle')

        const prefersReducedMotion =
            typeof window !== 'undefined' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (prefersReducedMotion) {
            // 静态分布：保留随机位置，固定低透明度
            particles.forEach((el, i) => {
                const c = configs[i]
                if (!c) return
                gsap.set(el, { x: c.x, y: c.y, opacity: 0.4, scale: 1 })
            })
            return
        }

        const tweens: gsap.core.Tween[] = []

        particles.forEach((el, i) => {
            const c = configs[i]
            if (!c) return

            if (variant === 'petals') {
                // 花瓣：从顶部飘落 + 左右摇摆 + 旋转
                gsap.set(el, { x: c.x, y: -10, rotation: c.drift * 6, opacity: 0 })
                const tl = gsap.timeline({ repeat: -1, delay: c.delay, defaults: { ease: 'none' } })
                tl.to(el, { opacity: 0.8, duration: 1 })
                tl.to(el, { y: 110, duration: c.duration, ease: 'power1.in' }, 0)
                tl.to(el, { x: `+=${c.drift}`, duration: c.duration / 2, ease: 'sine.inOut', yoyo: true, repeat: 1 }, 0)
                tl.to(el, { rotation: `+=${c.drift * 12}`, duration: c.duration, ease: 'none' }, 0)
                tl.to(el, { opacity: 0, duration: 1 }, c.duration - 1)
                tweens.push(tl as unknown as gsap.core.Tween)
            } else if (variant === 'snow') {
                // 雪花：垂直飘落 + 轻微横向漂移
                gsap.set(el, { x: c.x, y: -10, opacity: 0 })
                const tl = gsap.timeline({ repeat: -1, delay: c.delay, defaults: { ease: 'none' } })
                tl.to(el, { opacity: 0.7, duration: 1 })
                tl.to(el, { y: 110, duration: c.duration + 4, ease: 'power0.none' }, 0)
                tl.to(el, { x: `+=${c.drift * 0.6}`, duration: c.duration / 2, ease: 'sine.inOut', yoyo: true, repeat: 3 }, 0)
                tl.to(el, { opacity: 0, duration: 1 }, c.duration + 3)
                tweens.push(tl as unknown as gsap.core.Tween)
            } else if (variant === 'fireflies') {
                // 萤火虫：随机漂浮 + 透明度脉动
                gsap.set(el, { x: c.x, y: c.y, opacity: 0 })
                const tl = gsap.timeline({ repeat: -1, delay: c.delay, defaults: { ease: 'sine.inOut' } })
                tl.to(el, { opacity: 0.9, duration: 1.2 })
                tl.to(el, { x: `+=${c.drift}`, y: `+=${c.drift * 0.7}`, duration: c.duration, yoyo: true, repeat: 1 }, 0)
                tl.to(el, { opacity: 0.15, duration: 1.5, yoyo: true, repeat: -1 }, 1.2)
                tweens.push(tl as unknown as gsap.core.Tween)
            } else {
                // ink：墨点扩散（scale 放大 + 透明度衰减）
                gsap.set(el, { x: c.x, y: c.y, scale: 0, opacity: 0, transformOrigin: 'center' })
                const tl = gsap.timeline({ repeat: -1, delay: c.delay, defaults: { ease: 'power2.out' } })
                tl.to(el, { opacity: 0.5, scale: 1, duration: 1.2 })
                tl.to(el, { scale: 2.4, opacity: 0, duration: 2.6, ease: 'power1.in' })
                tweens.push(tl as unknown as gsap.core.Tween)
            }
        })

        return () => {
            tweens.forEach((t) => t.kill())
        }
    }, [configs, variant])

    return (
        <div className={cn('pr-poetry-particles', className)} style={style} aria-hidden="true">
            <svg
                className="pr-poetry-particles__svg"
                ref={svgRef}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
            >
                {configs.map((c, i) => {
                    if (variant === 'petals') {
                        return (
                            <ellipse
                                key={`petal-${i}`}
                                className="pr-poetry-particles__particle pr-poetry-particles__petal"
                                rx={c.size}
                                ry={c.size * 0.5}
                                cx={0}
                                cy={0}
                            />
                        )
                    }
                    if (variant === 'snow') {
                        return (
                            <circle
                                key={`snow-${i}`}
                                className="pr-poetry-particles__particle pr-poetry-particles__snow"
                                r={c.size * 0.5}
                                cx={0}
                                cy={0}
                            />
                        )
                    }
                    if (variant === 'fireflies') {
                        return (
                            <g key={`firefly-${i}`} className="pr-poetry-particles__particle">
                                <circle
                                    className="pr-poetry-particles__firefly-glow"
                                    r={c.size * 2}
                                    cx={0}
                                    cy={0}
                                />
                                <circle
                                    className="pr-poetry-particles__firefly"
                                    r={c.size * 0.6}
                                    cx={0}
                                    cy={0}
                                />
                            </g>
                        )
                    }
                    // ink
                    return (
                        <circle
                            key={`ink-${i}`}
                            className="pr-poetry-particles__particle pr-poetry-particles__ink"
                            r={c.size}
                            cx={0}
                            cy={0}
                        />
                    )
                })}
            </svg>
        </div>
    )
}
