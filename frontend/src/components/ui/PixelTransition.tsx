/**
 * PixelTransition —— 批改进度的双视图揭示器。
 *
 * 2026-08-09 独立实现：本文件不再移植本地“优质前端部件组”中的代码，也不依赖
 * GSAP 或直接写入 DOM。它以 React 状态和 CSS 网格完成一次可中断的“遮盖→切换→揭示”
 * 过程，保留产品需要的交互契约：鼠标悬停只是渐进增强，触摸、点击、Enter 和 Space
 * 都可切换；系统请求减弱动态时立即静态切换。
 */

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type KeyboardEvent,
    type ReactNode,
} from 'react'
import { matchesMediaQuery, subscribeMediaQuery } from '@/lib/media-query'
import './PixelTransition.css'

export interface PixelTransitionProps {
    /** 默认显示的内容（图片、状态摘要或其他非交互 ReactNode） */
    firstContent: ReactNode
    /** 触发后显示的内容 */
    secondContent: ReactNode
    /** 像素网格行列数，限制为 1–16，默认 7 */
    gridSize?: number
    /** 遮盖网格颜色，默认暖金 */
    pixelColor?: string
    /** 一次遮盖与揭示的总时长（秒），默认 0.3 */
    animationStepDuration?: number
    /** 保留既有的 padding-top 宽高比 API，例如 100% */
    aspectRatio?: string
    /** true 时只允许从第一视图切换到第二视图一次 */
    once?: boolean
    /** 用于说明该切换器的可访问名称 */
    ariaLabel?: string
    className?: string
    style?: CSSProperties
}

type TransitionPhase = 'idle' | 'covering' | 'revealing'

const DEFAULT_PIXEL_COLOR = 'rgb(var(--c-accent-primary, 197 133 59))'

function clampGridSize(value: number): number {
    if (!Number.isFinite(value)) return 7
    return Math.min(16, Math.max(1, Math.round(value)))
}

/** Deterministic shuffle: the visual order never jumps just because the component rerenders. */
function buildPixelOrder(gridSize: number): number[] {
    const total = gridSize * gridSize
    return Array.from({ length: total }, (_, index) => index).sort((left, right) => {
        const leftHash = ((left + 17) * 1103515245 + 12345) >>> 0
        const rightHash = ((right + 17) * 1103515245 + 12345) >>> 0
        return leftHash - rightHash
    })
}

function readReducedMotionPreference(): boolean {
    return matchesMediaQuery('(prefers-reduced-motion: reduce)')
}

export function PixelTransition({
    firstContent,
    secondContent,
    gridSize = 7,
    pixelColor = DEFAULT_PIXEL_COLOR,
    animationStepDuration = 0.3,
    aspectRatio = '100%',
    once = false,
    ariaLabel = '切换展示内容',
    className,
    style,
}: PixelTransitionProps) {
    const safeGridSize = clampGridSize(gridSize)
    const pixelOrder = useMemo(() => buildPixelOrder(safeGridSize), [safeGridSize])
    const [isActive, setIsActive] = useState(false)
    const [phase, setPhase] = useState<TransitionPhase>('idle')
    const [reducedMotion, setReducedMotion] = useState(readReducedMotionPreference)
    const activeRef = useRef(false)
    const targetRef = useRef(false)
    const timersRef = useRef<number[]>([])

    const cancelTransition = useCallback(() => {
        timersRef.current.forEach((timer) => window.clearTimeout(timer))
        timersRef.current = []
    }, [])

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
        const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
        const onChange = (event: MediaQueryListEvent) => {
            cancelTransition()
            setReducedMotion(event.matches)
            setPhase('idle')
            targetRef.current = activeRef.current
        }
        setReducedMotion(mediaQuery.matches)
        const unsubscribe = subscribeMediaQuery(mediaQuery, onChange)
        return () => {
            cancelTransition()
            unsubscribe()
        }
    }, [cancelTransition])

    const setActiveView = useCallback((nextActive: boolean) => {
        const currentTarget = targetRef.current
        if (nextActive === currentTarget) return
        if (!nextActive && once && currentTarget) return

        cancelTransition()
        targetRef.current = nextActive

        if (reducedMotion) {
            activeRef.current = nextActive
            setIsActive(nextActive)
            setPhase('idle')
            return
        }

        const totalDuration = Math.min(2400, Math.max(120, Math.round(animationStepDuration * 1000)))
        const coverDuration = Math.max(60, Math.round(totalDuration * 0.45))
        const revealDuration = Math.max(60, totalDuration - coverDuration)
        setPhase('covering')

        timersRef.current = [
            window.setTimeout(() => {
                activeRef.current = nextActive
                setIsActive(nextActive)
                setPhase('revealing')
            }, coverDuration),
            window.setTimeout(() => {
                setPhase('idle')
                timersRef.current = []
            }, coverDuration + revealDuration),
        ]
    }, [animationStepDuration, cancelTransition, once, reducedMotion])

    const toggle = useCallback(() => {
        setActiveView(!targetRef.current)
    }, [setActiveView])

    const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        toggle()
    }, [toggle])

    const cellDelay = phase === 'idle'
        ? 0
        : Math.max(1, Math.round((Math.min(2400, Math.max(120, animationStepDuration * 1000)) * 0.45) / pixelOrder.length))
    const mergedStyle = {
        ...style,
        '--pr-pixel-color': pixelColor,
        '--pr-pixel-grid': safeGridSize,
        '--pr-pixel-delay': `${cellDelay}ms`,
        '--pr-pixel-last-order': pixelOrder.length - 1,
    } as CSSProperties

    return (
        <div
            className={`pr-pixel-transition ${className ?? ''}`.trim()}
            style={mergedStyle}
            data-pixel-phase={phase}
            data-pixel-active={isActive ? 'true' : 'false'}
            onMouseEnter={() => setActiveView(true)}
            onMouseLeave={() => {
                if (!once) setActiveView(false)
            }}
            onClick={toggle}
            onKeyDown={onKeyDown}
            role="button"
            aria-label={ariaLabel}
            aria-pressed={isActive}
            tabIndex={0}
        >
            <div className="pr-pixel-transition__ratio" style={{ paddingTop: aspectRatio }} aria-hidden="true" />
            <div className="pr-pixel-transition__default" aria-hidden={isActive}>
                {firstContent}
            </div>
            <div className="pr-pixel-transition__active" aria-hidden={!isActive}>
                {secondContent}
            </div>
            <div className="pr-pixel-transition__pixels" aria-hidden="true">
                {pixelOrder.map((cell, visualOrder) => (
                    <span
                        key={cell}
                        className="pr-pixel-transition__pixel"
                        style={{ '--pr-pixel-order': visualOrder } as CSSProperties}
                    />
                ))}
            </div>
        </div>
    )
}
