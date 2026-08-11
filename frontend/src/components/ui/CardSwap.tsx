/**
 * CardSwap —— 批改结果的分层对比视图。
 *
 * 2026-08-09 独立实现：本文件不再移植本地“优质前端部件组”中的实现。
 * 它只保留产品需要的行为契约：多个批改结果可辨识地错层展示、可选自动轮换、
 * 显式暂停、键盘等价操作，以及减弱动态下完全静止。动画使用受控 React 状态和
 * CSS 过渡，不依赖 GSAP，也不把装饰性卡片伪装成可点击控件。
 */

import {
    Children,
    cloneElement,
    forwardRef,
    isValidElement,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type AriaRole,
    type CSSProperties,
    type KeyboardEventHandler,
    type MouseEventHandler,
    type ReactNode,
} from 'react'
import './CardSwap.css'
import { usePlaybackVisibility } from '@/hooks/usePlaybackVisibility'
import { matchesMediaQuery } from '@/lib/media-query'

export interface CardSwapProps {
    /** 卡片容器宽度（px 或 CSS 长度） */
    width?: number | string
    /** 卡片容器高度（px 或 CSS 长度） */
    height?: number | string
    /** 相邻层的水平偏移量 */
    cardDistance?: number
    /** 相邻层的垂直偏移量 */
    verticalDistance?: number
    /** 自动轮换间隔（毫秒） */
    delay?: number
    /** 指针悬停时是否临时暂停 */
    pauseOnHover?: boolean
    /** 使卡片成为可操作元素的可选回调 */
    onCardClick?: (idx: number) => void
    /** 卡片的视觉倾斜角度 */
    skewAmount?: number
    /** 切换的视觉节奏，不改变可访问性或暂停策略 */
    easing?: 'linear' | 'elastic'
    children: ReactNode
}

export interface CardProps {
    customClass?: string
    className?: string
    style?: CSSProperties
    onClick?: MouseEventHandler<HTMLDivElement>
    onKeyDown?: KeyboardEventHandler<HTMLDivElement>
    children?: ReactNode
}

/** 内容容器本身默认不是按钮；只有真实操作回调才获得按钮语义。 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
    { customClass, className, ...rest },
    ref,
) {
    return (
        <div
            ref={ref}
            {...rest}
            className={`pr-card-swap__card ${customClass ?? ''} ${className ?? ''}`.trim()}
        />
    )
})

interface LayerSlot {
    x: number
    y: number
    z: number
    zIndex: number
}

function layerSlot(position: number, total: number, horizontal: number, vertical: number): LayerSlot {
    return {
        x: position * horizontal,
        y: -position * vertical,
        z: -position * horizontal * 1.25,
        zIndex: total - position,
    }
}

function getReducedMotionPreference(): boolean {
    return matchesMediaQuery('(prefers-reduced-motion: reduce)')
}

function formatTransform(slot: LayerSlot, skewAmount: number): string {
    return `translate3d(calc(-50% + ${slot.x}px), calc(-50% + ${slot.y}px), ${slot.z}px) skewY(${skewAmount}deg)`
}

type CardElementProps = CardProps & {
    ref?: React.Ref<HTMLDivElement>
    role?: AriaRole
    tabIndex?: number
}

/**
 * 评分页的结果轮换器。
 *
 * 状态更新只在计时器到期时发生；暂停或系统减弱动态时计时器被取消。暂停瞬间
 * 记录浏览器已计算的 transform，以便冻结正在过渡的卡片，而不是仅更改按钮文案。
 */
export function CardSwap({
    width = 500,
    height = 400,
    cardDistance = 60,
    verticalDistance = 70,
    delay = 5000,
    pauseOnHover = false,
    onCardClick,
    skewAmount = 6,
    easing = 'elastic',
    children,
}: CardSwapProps) {
    const childArr = useMemo(() => Children.toArray(children), [children])
    const childIdentity = useMemo(
        () => childArr.map((child, index) => (isValidElement(child) ? String(child.key ?? index) : String(index))).join('|'),
        [childArr],
    )
    const [order, setOrder] = useState<number[]>(() => childArr.map((_, index) => index))
    const [reducedMotion, setReducedMotion] = useState(getReducedMotionPreference)
    const [userPaused, setUserPaused] = useState(false)
    const [hoverPaused, setHoverPaused] = useState(false)
    const [focusPaused, setFocusPaused] = useState(false)
    const [frozenTransforms, setFrozenTransforms] = useState<Record<number, string> | null>(null)
    const cardRefs = useRef<Array<HTMLDivElement | null>>([])
    const motionControlRef = useRef<HTMLButtonElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const playbackVisibility = usePlaybackVisibility(containerRef)

    const playbackPaused = reducedMotion || userPaused || hoverPaused || focusPaused || !playbackVisibility.active

    useEffect(() => {
        setOrder(childArr.map((_, index) => index))
        cardRefs.current = cardRefs.current.slice(0, childArr.length)
    }, [childArr, childIdentity])

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
        const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
        const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches)
        setReducedMotion(mediaQuery.matches)
        if (typeof mediaQuery.addEventListener === 'function') {
            mediaQuery.addEventListener('change', onChange)
            return () => mediaQuery.removeEventListener('change', onChange)
        }
        if (typeof mediaQuery.addListener === 'function') {
            mediaQuery.addListener(onChange)
            return () => mediaQuery.removeListener(onChange)
        }
        return undefined
    }, [])

    useEffect(() => {
        if (childArr.length < 2 || playbackPaused) return
        const timeout = window.setTimeout(() => {
            setOrder((previous) => previous.length < 2 ? previous : [...previous.slice(1), previous[0] as number])
        }, delay)
        return () => window.clearTimeout(timeout)
    }, [childArr.length, childIdentity, delay, order, playbackPaused])

    // useLayoutEffect 发生在浏览器绘制前：显式暂停不会让一个正在进行的 CSS
    // transform 在后续帧继续推进。恢复时移除覆盖值，下一次轮换从当前状态继续。
    useLayoutEffect(() => {
        if (!playbackPaused) {
            if (frozenTransforms !== null) setFrozenTransforms(null)
            return
        }
        if (frozenTransforms !== null) return
        const transforms: Record<number, string> = {}
        cardRefs.current.forEach((card, index) => {
            if (!card) return
            transforms[index] = window.getComputedStyle(card).transform
        })
        setFrozenTransforms(transforms)
    }, [frozenTransforms, playbackPaused])

    const slotByCard = useMemo(() => {
        const slots = new Map<number, LayerSlot>()
        order.forEach((cardIndex, layerIndex) => {
            slots.set(cardIndex, layerSlot(layerIndex, childArr.length, cardDistance, verticalDistance))
        })
        return slots
    }, [cardDistance, childArr.length, order, verticalDistance])

    const handleFocusCapture = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
        if (!motionControlRef.current?.contains(event.target)) setFocusPaused(true)
    }, [])

    const handleBlurCapture = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
        const nextTarget = event.relatedTarget
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) setFocusPaused(false)
    }, [])

    const motionState = reducedMotion
        ? 'reduced-motion'
        : userPaused
            ? 'paused-by-user'
            : !playbackVisibility.active
                ? 'paused-by-environment'
            : hoverPaused || focusPaused
                ? 'paused-by-interaction'
                : 'running'
    const transitionDuration = easing === 'elastic' ? '780ms' : '460ms'
    const transitionEasing = easing === 'elastic'
        ? 'cubic-bezier(.22, 1.34, .38, 1)'
        : 'cubic-bezier(.2, .7, .3, 1)'

    const rendered = childArr.map((child, index) => {
        if (!isValidElement(child)) return child
        const childProps = child.props as CardElementProps
        const childOnClick = childProps.onClick
        const childOnKeyDown = childProps.onKeyDown
        const interactive = Boolean(childOnClick || onCardClick)
        const slot = slotByCard.get(index) ?? layerSlot(index, childArr.length, cardDistance, verticalDistance)
        const frozenTransform = frozenTransforms?.[index]
        const cardStyle: CSSProperties = {
            ...childProps.style,
            width: '100%',
            height: '100%',
            zIndex: slot.zIndex,
            transform: frozenTransform && frozenTransform !== 'none'
                ? frozenTransform
                : formatTransform(slot, skewAmount),
            transformOrigin: 'center center',
            transition: playbackPaused
                ? 'none'
                : `transform ${transitionDuration} ${transitionEasing}, box-shadow var(--dur-micro) var(--ease-out)`,
        }
        const className = [childProps.className, interactive ? 'pr-card-swap__card--interactive' : '']
            .filter(Boolean)
            .join(' ')
        return cloneElement(child as React.ReactElement<CardElementProps>, {
            key: child.key ?? index,
            ref: (element: HTMLDivElement | null) => { cardRefs.current[index] = element },
            style: cardStyle,
            className,
            role: interactive ? 'button' : undefined,
            tabIndex: interactive ? 0 : undefined,
            onClick: interactive
                ? (event: React.MouseEvent<HTMLDivElement>) => {
                    childOnClick?.(event)
                    onCardClick?.(index)
                }
                : undefined,
            onKeyDown: interactive
                ? (event: React.KeyboardEvent<HTMLDivElement>) => {
                    childOnKeyDown?.(event)
                    if (event.defaultPrevented || (event.key !== 'Enter' && event.key !== ' ')) return
                    event.preventDefault()
                    onCardClick?.(index)
                }
                : childOnKeyDown,
        })
    })

    return (
        <div
            ref={containerRef}
            className="pr-card-swap-container"
            style={{ width, height }}
            data-card-swap-motion={motionState}
            data-card-swap-viewport={playbackVisibility.inViewport ? 'visible' : 'hidden'}
            data-card-swap-document={playbackVisibility.documentVisible ? 'visible' : 'hidden'}
            onMouseEnter={pauseOnHover ? () => setHoverPaused(true) : undefined}
            onMouseLeave={pauseOnHover ? () => setHoverPaused(false) : undefined}
            onFocusCapture={handleFocusCapture}
            onBlurCapture={handleBlurCapture}
        >
            {rendered}
            {childArr.length > 1 && (
                <button
                    ref={motionControlRef}
                    type="button"
                    className="pr-card-swap__motion-control"
                    onClick={() => setUserPaused((paused) => !paused)}
                    aria-pressed={userPaused}
                    aria-label={reducedMotion
                        ? '已按系统减弱动态偏好静止显示'
                        : userPaused
                            ? '继续自动轮播'
                            : '暂停自动轮播'}
                    disabled={reducedMotion}
                >
                    {reducedMotion ? '静止显示' : userPaused ? '继续轮播' : '暂停轮播'}
                </button>
            )}
        </div>
    )
}
