/**
 * StackGallery —— 答题图片的可访问卡片堆。
 *
 * 2026-08-09 独立实现：本组件不再移植本地“优质前端部件组”中的实现，也不依赖
 * GSAP。它只保留产品需要、并可独立验证的行为：有限层数的图片预览、顶卡拖拽/轮换、
 * 自动播放、键盘可达的大图预览、焦点闭环和减弱动态静态降级。
 */

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from 'react'
import './StackGallery.css'
import { usePlaybackVisibility } from '@/hooks/usePlaybackVisibility'
import { matchesMediaQuery } from '@/lib/media-query'

export interface StackGalleryAnimationConfig {
    /** 数值越高，轮换后的 CSS 过渡越短；保留既有调用契约。 */
    stiffness?: number
    /** 数值越高，轮换后的 CSS 过渡越克制；保留既有调用契约。 */
    damping?: number
}

export interface StackGalleryCard {
    id: string | number
    /** 推荐 <img> 或带可读失败终态的媒体组件；不得嵌套其他交互控件。 */
    content: ReactNode
    caption?: string
}

export interface StackGalleryProps {
    cards: StackGalleryCard[]
    randomRotation?: boolean
    sensitivity?: number
    sendToBackOnClick?: boolean
    animationConfig?: StackGalleryAnimationConfig
    autoplay?: boolean
    autoplayDelay?: number
    pauseOnHover?: boolean
    maxVisible?: number
    onCardClick?: (idx: number, card: StackGalleryCard) => void
    ariaLabel?: string
    className?: string
    style?: CSSProperties
}

interface StackItem extends StackGalleryCard {
    rotation: number
}

interface DragState {
    pointerId: number
    cardId: string | number
    startX: number
    startY: number
    x: number
    y: number
}

function readReducedMotionPreference(): boolean {
    return matchesMediaQuery('(prefers-reduced-motion: reduce)')
}

function stableRotation(id: string | number, index: number, enabled: boolean): number {
    if (!enabled) return 0
    const input = `${id}:${index}`
    let hash = 2166136261
    for (let position = 0; position < input.length; position += 1) {
        hash = Math.imul(hash ^ input.charCodeAt(position), 16777619)
    }
    return ((hash >>> 0) % 81) / 10 - 4
}

function createStack(cards: StackGalleryCard[], randomRotation: boolean): StackItem[] {
    return cards.map((card, index) => ({
        ...card,
        rotation: stableRotation(card.id, index, randomRotation),
    }))
}

function clampVisibleCount(value: number): number {
    if (!Number.isFinite(value)) return 5
    return Math.max(1, Math.min(8, Math.round(value)))
}

function motionDuration(config: StackGalleryAnimationConfig): number {
    const stiffness = Math.min(600, Math.max(80, config.stiffness ?? 260))
    const damping = Math.min(48, Math.max(8, config.damping ?? 20))
    return Math.round(Math.min(560, Math.max(180, 640 - stiffness * 0.9 + damping * 7)))
}

export function StackGallery({
    cards,
    randomRotation = false,
    sensitivity = 200,
    sendToBackOnClick = false,
    animationConfig = { stiffness: 260, damping: 20 },
    autoplay = false,
    autoplayDelay = 3000,
    pauseOnHover = false,
    maxVisible = 5,
    onCardClick,
    ariaLabel = '图片堆叠画廊',
    className,
    style,
}: StackGalleryProps) {
    const [stack, setStack] = useState<StackItem[]>(() => createStack(cards, randomRotation))
    const [reducedMotion, setReducedMotion] = useState(readReducedMotionPreference)
    const [hoverPaused, setHoverPaused] = useState(false)
    const [focusPaused, setFocusPaused] = useState(false)
    const [drag, setDrag] = useState<DragState | null>(null)
    const [lightboxId, setLightboxId] = useState<string | number | null>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const playbackVisibility = usePlaybackVisibility(containerRef)
    const lightboxRef = useRef<HTMLDivElement>(null)
    const lightboxCloseRef = useRef<HTMLButtonElement>(null)
    const lightboxTriggerRef = useRef<HTMLButtonElement | null>(null)
    const wasLightboxOpenRef = useRef(false)
    const dragRef = useRef<DragState | null>(null)
    const suppressClickUntilRef = useRef(0)

    const visibleCount = clampVisibleCount(maxVisible)
    const currentLightboxIndex = useMemo(
        () => lightboxId === null ? -1 : stack.findIndex((card) => card.id === lightboxId),
        [lightboxId, stack],
    )
    const currentLightboxCard = currentLightboxIndex >= 0 ? stack[currentLightboxIndex] ?? null : null
    const playbackPaused = reducedMotion
        || hoverPaused
        || focusPaused
        || drag !== null
        || lightboxId !== null
        || !playbackVisibility.active
    const transitionMs = motionDuration(animationConfig)

    // 新上传/删除图片时，保留教师刚刚浏览后的顺序；不存在的旧卡片才会移除。
    useEffect(() => {
        setStack((previous) => {
            const previousById = new Map(previous.map((card) => [card.id, card]))
            const incomingById = new Map(cards.map((card) => [card.id, card]))
            const retained = previous
                .filter((card) => incomingById.has(card.id))
                .map((card) => {
                    const incoming = incomingById.get(card.id) as StackGalleryCard
                    return {
                        ...incoming,
                        rotation: randomRotation ? card.rotation : 0,
                    }
                })
            const appended = cards
                .filter((card) => !previousById.has(card.id))
                .map((card, index) => ({
                    ...card,
                    rotation: stableRotation(card.id, retained.length + index, randomRotation),
                }))
            return [...retained, ...appended]
        })
    }, [cards, randomRotation])

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
        const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
        const onChange = (event: MediaQueryListEvent) => {
            setReducedMotion(event.matches)
            dragRef.current = null
            setDrag(null)
        }
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
        if (lightboxId !== null && !stack.some((card) => card.id === lightboxId)) {
            setLightboxId(null)
        }
    }, [lightboxId, stack])

    const sendToBack = useCallback((id: string | number) => {
        setStack((previous) => {
            if (previous.length < 2) return previous
            const index = previous.findIndex((card) => card.id === id)
            if (index < 0) return previous
            const next = [...previous]
            const [card] = next.splice(index, 1)
            return card ? [card, ...next] : previous
        })
    }, [])

    useEffect(() => {
        if (!autoplay || stack.length < 2 || playbackPaused) return
        const timeout = window.setTimeout(() => {
            const topCard = stack[stack.length - 1]
            if (topCard) sendToBack(topCard.id)
        }, Math.max(1200, autoplayDelay))
        return () => window.clearTimeout(timeout)
    }, [autoplay, autoplayDelay, playbackPaused, sendToBack, stack])

    const resetDrag = useCallback(() => {
        dragRef.current = null
        setDrag(null)
    }, [])

    const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>, cardId: string | number) => {
        if (reducedMotion || cardId !== stack[stack.length - 1]?.id) return
        const nextDrag: DragState = {
            pointerId: event.pointerId,
            cardId,
            startX: event.clientX,
            startY: event.clientY,
            x: 0,
            y: 0,
        }
        dragRef.current = nextDrag
        setDrag(nextDrag)
        try {
            event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
            // 某些嵌入式 WebView 不支持 pointer capture；失效时仍可点击预览。
        }
    }, [reducedMotion, stack])

    const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
        const current = dragRef.current
        if (!current || current.pointerId !== event.pointerId) return
        const nextDrag = {
            ...current,
            x: event.clientX - current.startX,
            y: event.clientY - current.startY,
        }
        dragRef.current = nextDrag
        setDrag(nextDrag)
    }, [])

    const finishDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
        const current = dragRef.current
        if (!current || current.pointerId !== event.pointerId) return
        const distance = Math.hypot(current.x, current.y)
        try {
            event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {
            // capture 未建立时 release 会抛错，保持可点击的安全降级。
        }
        resetDrag()
        if (cancelled) return
        if (distance > 8) suppressClickUntilRef.current = Date.now() + 260
        if (distance >= Math.max(40, sensitivity)) sendToBack(current.cardId)
    }, [resetDrag, sendToBack, sensitivity])

    const openLightbox = useCallback((event: ReactMouseEvent<HTMLButtonElement>, index: number, card: StackItem) => {
        if (Date.now() <= suppressClickUntilRef.current) return
        const isTop = index === stack.length - 1
        if (isTop && sendToBackOnClick) {
            sendToBack(card.id)
            return
        }
        lightboxTriggerRef.current = event.currentTarget
        setLightboxId(card.id)
        onCardClick?.(index, { id: card.id, content: card.content, caption: card.caption })
    }, [onCardClick, sendToBack, sendToBackOnClick, stack.length])

    const closeLightbox = useCallback(() => setLightboxId(null), [])
    const showPrevious = useCallback(() => {
        if (currentLightboxIndex > 0) setLightboxId(stack[currentLightboxIndex - 1]?.id ?? null)
    }, [currentLightboxIndex, stack])
    const showNext = useCallback(() => {
        if (currentLightboxIndex >= 0 && currentLightboxIndex < stack.length - 1) {
            setLightboxId(stack[currentLightboxIndex + 1]?.id ?? null)
        }
    }, [currentLightboxIndex, stack])

    useEffect(() => {
        if (lightboxId !== null) {
            wasLightboxOpenRef.current = true
            const frame = window.requestAnimationFrame(() => lightboxCloseRef.current?.focus({ preventScroll: true }))
            return () => window.cancelAnimationFrame(frame)
        }
        if (!wasLightboxOpenRef.current) return
        wasLightboxOpenRef.current = false
        const trigger = lightboxTriggerRef.current
        const frame = window.requestAnimationFrame(() => {
            if (trigger?.isConnected) trigger.focus({ preventScroll: true })
            lightboxTriggerRef.current = null
        })
        return () => window.cancelAnimationFrame(frame)
    }, [lightboxId])

    useEffect(() => {
        if (!currentLightboxCard) return
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closeLightbox()
            if (event.key === 'ArrowLeft') showPrevious()
            if (event.key === 'ArrowRight') showNext()
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [closeLightbox, currentLightboxCard, showNext, showPrevious])

    const trapLightboxFocus = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Tab') return
        const focusable = Array.from(lightboxRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? []).filter((element) => !element.hasAttribute('hidden') && element.getClientRects().length > 0)
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (!first || !last) {
            event.preventDefault()
            return
        }
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
        }
    }, [])

    const handleFocusCapture = useCallback(() => setFocusPaused(true), [])
    const handleBlurCapture = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
        const nextTarget = event.relatedTarget
        if (nextTarget instanceof Node && containerRef.current?.contains(nextTarget)) return
        setFocusPaused(false)
    }, [])

    return (
        <div
            ref={containerRef}
            className={`pr-stack-gallery ${className ?? ''}`.trim()}
            style={style}
            role="group"
            aria-label={ariaLabel}
            data-gallery-motion={reducedMotion ? 'reduced' : playbackPaused ? 'paused' : 'running'}
            data-gallery-viewport={playbackVisibility.inViewport ? 'visible' : 'hidden'}
            data-gallery-document={playbackVisibility.documentVisible ? 'visible' : 'hidden'}
            onMouseEnter={pauseOnHover ? () => setHoverPaused(true) : undefined}
            onMouseLeave={pauseOnHover ? () => setHoverPaused(false) : undefined}
            onFocusCapture={handleFocusCapture}
            onBlurCapture={handleBlurCapture}
        >
            {stack.map((card, index) => {
                const fromTop = stack.length - 1 - index
                const isVisible = fromTop < visibleCount
                const isTop = fromTop === 0
                const isDragging = drag?.cardId === card.id
                const offsetY = Math.min(30, fromTop * 7)
                const dragX = isDragging ? drag.x : 0
                const dragY = isDragging ? drag.y : 0
                const scale = Math.max(.72, 1 - fromTop * .045)
                const cardStyle: CSSProperties = {
                    zIndex: stack.length - fromTop,
                    opacity: isVisible ? 1 : 0,
                    pointerEvents: isVisible ? 'auto' : 'none',
                    transform: `translate3d(${dragX}px, ${offsetY + dragY}px, 0) rotateZ(${fromTop * 3 + card.rotation}deg) scale(${scale})`,
                    transitionDuration: reducedMotion || isDragging ? '0ms' : `${transitionMs}ms`,
                }
                return (
                    <button
                        type="button"
                        key={card.id}
                        className={`pr-stack-gallery__card ${isTop ? 'is-top' : ''} ${isDragging ? 'is-dragging' : ''}`.trim()}
                        style={cardStyle}
                        onPointerDown={(event) => handlePointerDown(event, card.id)}
                        onPointerMove={handlePointerMove}
                        onPointerUp={finishDrag}
                        onPointerCancel={(event) => finishDrag(event, true)}
                        onLostPointerCapture={resetDrag}
                        onClick={(event) => openLightbox(event, index, card)}
                        tabIndex={isVisible ? 0 : -1}
                        aria-hidden={isVisible ? undefined : true}
                        aria-current={isTop ? 'true' : undefined}
                        aria-label={`查看答题图片：${card.caption ?? `卡片 ${index + 1}`}`}
                    >
                        {card.content}
                    </button>
                )
            })}

            {currentLightboxCard && (
                <div
                    ref={lightboxRef}
                    className="pr-stack-gallery-lightbox"
                    role="dialog"
                    aria-modal="true"
                    aria-label={currentLightboxCard.caption ?? '图片大图查看'}
                    onClick={closeLightbox}
                    onKeyDown={trapLightboxFocus}
                >
                    <button
                        ref={lightboxCloseRef}
                        type="button"
                        className="pr-stack-gallery-lightbox__close"
                        aria-label="关闭"
                        onClick={(event) => {
                            event.stopPropagation()
                            closeLightbox()
                        }}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                    {currentLightboxIndex > 0 && (
                        <button type="button" className="pr-stack-gallery-lightbox__nav pr-stack-gallery-lightbox__nav--prev" aria-label="上一张" onClick={(event) => { event.stopPropagation(); showPrevious() }}>
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
                        </button>
                    )}
                    <div className="pr-stack-gallery-lightbox__content" onClick={(event) => event.stopPropagation()}>
                        {currentLightboxCard.content}
                        {currentLightboxCard.caption && <p className="pr-stack-gallery-lightbox__caption">{currentLightboxCard.caption}</p>}
                        <p className="pr-stack-gallery-lightbox__counter">{currentLightboxIndex + 1} / {stack.length}</p>
                    </div>
                    {currentLightboxIndex < stack.length - 1 && (
                        <button type="button" className="pr-stack-gallery-lightbox__nav pr-stack-gallery-lightbox__nav--next" aria-label="下一张" onClick={(event) => { event.stopPropagation(); showNext() }}>
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}
