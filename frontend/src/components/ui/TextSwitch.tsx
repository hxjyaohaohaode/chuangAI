/**
 * TextSwitch —— 可访问、可暂停的原子文本切换器。
 *
 * 组件保留旧 RotatingText 兼容 API，但不再拆分字符，也不再依赖外部动画运行时。
 * 所有可见文本始终作为完整字符串渲染；CSS 只负责一次、有限时长的整串入场。
 */

import {
    forwardRef,
    memo,
    useCallback,
    useEffect,
    useId,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import type {
    CSSProperties,
    FocusEvent as ReactFocusEvent,
    KeyboardEvent as ReactKeyboardEvent,
    ReactNode,
    Ref,
} from 'react'
import { cn } from '@/lib/cn'
import { matchesMediaQuery, subscribeMediaQuery } from '@/lib/media-query'
import './TextSwitch.css'

/** 动画状态（保留 motion/react 兼容字段，应用于整串文本）。 */
export interface TextSwitchAnimationState {
    y?: string | number
    x?: string | number
    opacity?: number
    scale?: number
    rotate?: number
    filter?: string
}

/** Transition 配置（保留原有公开契约）。 */
export interface TextSwitchTransition {
    type?: 'spring' | 'tween' | 'ease'
    duration?: number
    damping?: number
    stiffness?: number
    ease?: string | string[]
    delay?: number
}

export interface TextSwitchHandle {
    /** 切换到下一条。 */
    next: () => void
    /** 切换到上一条。 */
    previous: () => void
    /** 跳转到指定索引；NaN / Infinity 安全忽略。 */
    jumpTo: (index: number) => void
    /** 重置到第一条。 */
    reset: () => void
    /** 手动暂停自动切换。 */
    pause: () => void
    /** 解除手动暂停。 */
    resume: () => void
    /** 切换手动暂停状态。 */
    togglePause: () => void
}

export interface TextSwitchProps {
    /** 要切换的文本数组。 */
    texts: string[]

    /* === 原始 RotatingText Props（保留向后兼容） === */

    /** 轮播间隔（ms）；优先于 interval，默认 2000。 */
    rotationInterval?: number
    /** 原子文本入场起点。 */
    initial?: TextSwitchAnimationState
    /** 原子文本入场终点。 */
    animate?: TextSwitchAnimationState
    /** 保留的旧退场状态；轻量实现不再创建重复退场层。 */
    exit?: TextSwitchAnimationState
    /** 保留的旧 presence 模式。 */
    animatePresenceMode?: 'wait' | 'sync' | 'popLayout'
    /** 首屏是否执行一次入场动画，默认 false。 */
    animatePresenceInitial?: boolean
    /** 保留的旧逐元素延迟；原子渲染中不再拆字。 */
    staggerDuration?: number
    /** 保留的旧 stagger 起点。 */
    staggerFrom?: 'first' | 'last' | 'center' | 'random' | number
    /** Transition 配置。duration 单位沿用旧 API：秒。 */
    transition?: TextSwitchTransition
    /** 是否循环，默认 true。 */
    loop?: boolean
    /** 是否自动轮播，默认 false。 */
    auto?: boolean
    /** 保留的旧拆分模式；可见 DOM 始终为完整字符串。 */
    splitBy?: 'characters' | 'words' | 'lines' | string
    /** 索引切换请求回调。 */
    onNext?: (index: number) => void
    /** 主容器类名。 */
    mainClassName?: string
    /** 兼容旧 split 层类名，应用到原子内容容器。 */
    splitLevelClassName?: string
    /** 兼容旧元素类名，应用到完整字符串节点。 */
    elementLevelClassName?: string

    /* === 兼容别名 === */

    /** rotationInterval 别名（ms）。 */
    interval?: number
    /** 保留的旧逐字符延迟别名（ms）。 */
    charStagger?: number
    /** mainClassName 别名。 */
    className?: string
    /** onNext 兼容回调。 */
    onChange?: (index: number) => void
    /** transition.duration 的毫秒别名。 */
    duration?: number

    /* === 扩展 Props === */

    /** 受控模式：当前激活索引。 */
    activeIndex?: number
    /** 非受控模式默认索引，默认 0。 */
    defaultIndex?: number
    /** 自定义渲染函数；使用时不额外创建 live region。 */
    renderText?: (text: string, index: number) => ReactNode
    /** 自定义根节点样式。 */
    style?: CSSProperties

    /** 受控手动暂停状态。 */
    paused?: boolean
    /** 非受控手动暂停初值，默认 false。 */
    defaultPaused?: boolean
    /** 手动暂停状态变更请求。 */
    onPausedChange?: (paused: boolean) => void
}

const DEFAULT_INITIAL: TextSwitchAnimationState = { y: '38%', opacity: 0 }
const DEFAULT_ANIMATE: TextSwitchAnimationState = { y: 0, opacity: 1 }
const DEFAULT_TRANSITION: TextSwitchTransition = {
    type: 'spring',
    damping: 25,
    stiffness: 300,
}

const DEFAULT_INTERVAL_MS = 2_000
const MAX_INTERVAL_MS = 300_000
const DEFAULT_DURATION_MS = 360
const MAX_DURATION_MS = 600

type TextSwitchStyle = CSSProperties & Record<`--pr-textswitch-${string}`, string | number>

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum)
}

function sanitizeTexts(texts: string[] | null | undefined): string[] {
    if (!Array.isArray(texts)) return []
    return texts.map((text) => (typeof text === 'string' ? text : String(text ?? '')))
}

function normalizeIndex(value: number, itemCount: number, fallback = 0): number {
    if (itemCount <= 0) return 0
    if (!Number.isFinite(value)) return clamp(Math.trunc(fallback), 0, itemCount - 1)
    return clamp(Math.trunc(value), 0, itemCount - 1)
}

function normalizeRequestedIndex(value: number, itemCount: number): number | null {
    if (itemCount <= 0 || !Number.isFinite(value)) return null
    return clamp(Math.trunc(value), 0, itemCount - 1)
}

function resolveRotationInterval(rotationInterval: number | undefined, interval: number | undefined): number {
    const candidate = rotationInterval ?? interval ?? DEFAULT_INTERVAL_MS
    if (!Number.isFinite(candidate)) return DEFAULT_INTERVAL_MS
    return clamp(Math.trunc(candidate), DEFAULT_INTERVAL_MS, MAX_INTERVAL_MS)
}

function resolveDuration(duration: number | undefined, transition: TextSwitchTransition): number {
    const transitionDuration = transition.duration
    const candidate = transitionDuration === undefined
        ? (duration ?? DEFAULT_DURATION_MS)
        : transitionDuration * 1_000
    if (!Number.isFinite(candidate)) return DEFAULT_DURATION_MS
    return clamp(candidate, 0, MAX_DURATION_MS)
}

function resolveDelay(transition: TextSwitchTransition): number {
    if (!Number.isFinite(transition.delay)) return 0
    return clamp((transition.delay ?? 0) * 1_000, 0, MAX_DURATION_MS)
}

function resolveLength(value: string | number | undefined, fallback: string): string {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? `${clamp(value, -2_000, 2_000)}px` : fallback
    }
    if (typeof value !== 'string') return fallback
    const normalized = value.trim()
    if (
        normalized.length <= 32
        && (
            /^-?0(?:\.0+)?$/.test(normalized)
            || /^-?\d+(?:\.\d+)?(?:px|%|em|rem|vh|vw)$/i.test(normalized)
        )
    ) {
        return normalized
    }
    return fallback
}

function resolveOpacity(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) ? clamp(value ?? fallback, 0, 1) : fallback
}

function resolveScale(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) ? clamp(value ?? fallback, 0, 4) : fallback
}

function resolveRotate(value: number | undefined, fallback: number): string {
    return Number.isFinite(value) ? `${clamp(value ?? fallback, -1_080, 1_080)}deg` : `${fallback}deg`
}

function resolveFilter(value: string | undefined, fallback: string): string {
    if (typeof value !== 'string') return fallback
    const normalized = value.trim()
    if (!normalized || normalized.length > 120 || /url\s*\(/i.test(normalized)) return fallback
    return normalized
}

function resolveMotionStyle(
    initial: TextSwitchAnimationState,
    animate: TextSwitchAnimationState,
    durationMs: number,
    delayMs: number,
): TextSwitchStyle {
    return {
        '--pr-textswitch-duration': `${durationMs}ms`,
        '--pr-textswitch-delay': `${delayMs}ms`,
        '--pr-textswitch-from-x': resolveLength(initial.x, '0px'),
        '--pr-textswitch-from-y': resolveLength(initial.y, '38%'),
        '--pr-textswitch-from-opacity': resolveOpacity(initial.opacity, 0),
        '--pr-textswitch-from-scale': resolveScale(initial.scale, 1),
        '--pr-textswitch-from-rotate': resolveRotate(initial.rotate, 0),
        '--pr-textswitch-from-filter': resolveFilter(initial.filter, 'none'),
        '--pr-textswitch-to-x': resolveLength(animate.x, '0px'),
        '--pr-textswitch-to-y': resolveLength(animate.y, '0px'),
        '--pr-textswitch-to-opacity': resolveOpacity(animate.opacity, 1),
        '--pr-textswitch-to-scale': resolveScale(animate.scale, 1),
        '--pr-textswitch-to-rotate': resolveRotate(animate.rotate, 0),
        '--pr-textswitch-to-filter': resolveFilter(animate.filter, 'none'),
    }
}

function normalizeAccessibleText(text: string, index: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim()
    return normalized || `空白文本 ${index + 1}`
}

const TextSwitch = memo(
    forwardRef<TextSwitchHandle, TextSwitchProps>(function TextSwitch(
        props,
        ref: Ref<TextSwitchHandle>,
    ) {
        const {
            texts,
            rotationInterval,
            initial = DEFAULT_INITIAL,
            animate = DEFAULT_ANIMATE,
            animatePresenceMode = 'wait',
            animatePresenceInitial = false,
            transition = DEFAULT_TRANSITION,
            loop = true,
            auto = false,
            splitBy = 'characters',
            onNext,
            mainClassName,
            splitLevelClassName,
            elementLevelClassName,
            interval,
            className,
            onChange,
            duration,
            activeIndex: controlledIndex,
            defaultIndex = 0,
            renderText,
            style,
            paused: controlledPaused,
            defaultPaused = false,
            onPausedChange,
        } = props

        const safeTexts = useMemo(() => sanitizeTexts(texts), [texts])
        const itemCount = safeTexts.length
        const isControlled = controlledIndex !== undefined

        const [uncontrolledIndex, setUncontrolledIndex] = useState(() => (
            normalizeIndex(defaultIndex, itemCount)
        ))
        const [uncontrolledPaused, setUncontrolledPaused] = useState(Boolean(defaultPaused))
        const [documentHidden, setDocumentHidden] = useState(() => (
            typeof document === 'undefined' || document.visibilityState !== 'visible'
        ))
        const [reducedMotion, setReducedMotion] = useState(() => (
            matchesMediaQuery('(prefers-reduced-motion: reduce)', true)
        ))
        const [coarsePointer, setCoarsePointer] = useState(() => (
            matchesMediaQuery('(pointer: coarse)')
        ))
        const [isIntersecting, setIsIntersecting] = useState(false)
        const [hasFocusWithin, setHasFocusWithin] = useState(false)
        const [isHovered, setIsHovered] = useState(false)
        const [animationCycle, setAnimationCycle] = useState(animatePresenceInitial ? 1 : 0)
        const [animationActive, setAnimationActive] = useState(animatePresenceInitial)

        const visibleIndex = isControlled
            ? normalizeIndex(controlledIndex, itemCount)
            : normalizeIndex(uncontrolledIndex, itemCount)
        const currentText = safeTexts[visibleIndex] ?? ''
        const manualPaused = controlledPaused ?? uncontrolledPaused
        const resolvedInterval = resolveRotationInterval(rotationInterval, interval)
        const resolvedDuration = resolveDuration(duration, transition)
        const resolvedDelay = resolveDelay(transition)
        const resolvedMainClassName = mainClassName ?? className
        const intersectionObserverAvailable = typeof window !== 'undefined' && 'IntersectionObserver' in window
        const motionReduced = reducedMotion || coarsePointer
        const canRequestControlledChange = Boolean(onNext || onChange)
        const atTerminalItem = !loop && itemCount > 0 && visibleIndex >= itemCount - 1

        const rootRef = useRef<HTMLDivElement>(null)
        const previousIndexRef = useRef(visibleIndex)
        const wasControlledRef = useRef(isControlled)
        const lastControlledIndexRef = useRef(visibleIndex)
        const textSwitchId = useId()

        if (isControlled) lastControlledIndexRef.current = visibleIndex

        useLayoutEffect(() => {
            if (wasControlledRef.current && !isControlled) {
                setUncontrolledIndex(lastControlledIndexRef.current)
            }
            wasControlledRef.current = isControlled
        }, [isControlled])

        useLayoutEffect(() => {
            const previousIndex = previousIndexRef.current
            previousIndexRef.current = visibleIndex
            if (previousIndex === visibleIndex) return

            if (motionReduced || resolvedDuration === 0) {
                setAnimationActive(false)
                return
            }
            setAnimationCycle((cycle) => cycle + 1)
            setAnimationActive(true)
        }, [motionReduced, resolvedDuration, visibleIndex])

        useEffect(() => {
            if (motionReduced || resolvedDuration === 0) {
                setAnimationActive(false)
            }
        }, [motionReduced, resolvedDuration])

        useEffect(() => {
            if (isControlled) return
            const normalized = normalizeIndex(uncontrolledIndex, itemCount)
            if (normalized !== uncontrolledIndex) setUncontrolledIndex(normalized)
        }, [isControlled, itemCount, uncontrolledIndex])

        useEffect(() => {
            if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return

            const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
            const coarsePointerQuery = window.matchMedia('(pointer: coarse)')
            const handleReducedMotion = (event: MediaQueryListEvent) => setReducedMotion(event.matches)
            const handleCoarsePointer = (event: MediaQueryListEvent) => setCoarsePointer(event.matches)

            setReducedMotion(reducedMotionQuery.matches)
            setCoarsePointer(coarsePointerQuery.matches)
            const unsubscribeReducedMotion = subscribeMediaQuery(reducedMotionQuery, handleReducedMotion)
            const unsubscribeCoarsePointer = subscribeMediaQuery(coarsePointerQuery, handleCoarsePointer)

            return () => {
                unsubscribeReducedMotion()
                unsubscribeCoarsePointer()
            }
        }, [])

        useEffect(() => {
            if (typeof document === 'undefined') return
            const handleVisibilityChange = () => setDocumentHidden(document.visibilityState !== 'visible')
            handleVisibilityChange()
            document.addEventListener('visibilitychange', handleVisibilityChange)
            return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
        }, [])

        useEffect(() => {
            const root = rootRef.current
            if (!root || !intersectionObserverAvailable) {
                setIsIntersecting(false)
                return
            }

            let observer: IntersectionObserver | null = null
            try {
                observer = new IntersectionObserver(
                    (entries) => {
                        const entry = entries[0]
                        setIsIntersecting(Boolean(
                            entry
                            && entry.isIntersecting
                            && entry.intersectionRatio >= 0.5
                        ))
                    },
                    { threshold: [0, 0.5, 1] },
                )
                observer.observe(root)
            } catch {
                observer?.disconnect()
                // 受限 WebView 无可靠可见性信号时 fail-open；其余暂停门仍然有效。
                setIsIntersecting(true)
                return
            }
            return () => observer?.disconnect()
        }, [intersectionObserverAvailable])

        const pauseReasons = useMemo(() => {
            const reasons: string[] = []
            if (!auto) reasons.push('auto-disabled')
            if (itemCount <= 1) reasons.push('insufficient-items')
            if (manualPaused) reasons.push('manual')
            if (reducedMotion) reasons.push('reduced-motion')
            if (coarsePointer) reasons.push('coarse-pointer')
            if (documentHidden) reasons.push('document-hidden')
            if (!intersectionObserverAvailable) reasons.push('intersection-unavailable')
            else if (!isIntersecting) reasons.push('offscreen')
            if (hasFocusWithin) reasons.push('focus-within')
            if (isHovered) reasons.push('hover')
            if (isControlled && !canRequestControlledChange) reasons.push('controlled-without-handler')
            if (atTerminalItem) reasons.push('complete')
            return reasons
        }, [
            atTerminalItem,
            auto,
            canRequestControlledChange,
            coarsePointer,
            documentHidden,
            hasFocusWithin,
            intersectionObserverAvailable,
            isControlled,
            isHovered,
            isIntersecting,
            itemCount,
            manualPaused,
            reducedMotion,
        ])

        const isPlaying = pauseReasons.length === 0

        const requestIndex = useCallback((candidate: number) => {
            const nextIndex = normalizeRequestedIndex(candidate, itemCount)
            if (nextIndex === null || nextIndex === visibleIndex) return

            if (!isControlled) setUncontrolledIndex(nextIndex)
            onNext?.(nextIndex)
            onChange?.(nextIndex)
        }, [isControlled, itemCount, onChange, onNext, visibleIndex])

        const next = useCallback(() => {
            if (itemCount <= 1) return
            const nextIndex = loop
                ? (visibleIndex + 1) % itemCount
                : Math.min(visibleIndex + 1, itemCount - 1)
            requestIndex(nextIndex)
        }, [itemCount, loop, requestIndex, visibleIndex])

        const previous = useCallback(() => {
            if (itemCount <= 1) return
            const previousIndex = loop
                ? (visibleIndex - 1 + itemCount) % itemCount
                : Math.max(visibleIndex - 1, 0)
            requestIndex(previousIndex)
        }, [itemCount, loop, requestIndex, visibleIndex])

        const jumpTo = useCallback((index: number) => {
            if (!Number.isFinite(index)) return
            requestIndex(index)
        }, [requestIndex])

        const reset = useCallback(() => requestIndex(0), [requestIndex])

        const requestPausedState = useCallback((nextPaused: boolean) => {
            if (nextPaused === manualPaused) return
            if (controlledPaused === undefined) setUncontrolledPaused(nextPaused)
            onPausedChange?.(nextPaused)
        }, [controlledPaused, manualPaused, onPausedChange])

        const pause = useCallback(() => requestPausedState(true), [requestPausedState])
        const resume = useCallback(() => requestPausedState(false), [requestPausedState])
        const togglePause = useCallback(
            () => requestPausedState(!manualPaused),
            [manualPaused, requestPausedState],
        )

        useImperativeHandle(
            ref,
            (): TextSwitchHandle => ({ next, previous, jumpTo, reset, pause, resume, togglePause }),
            [jumpTo, next, pause, previous, reset, resume, togglePause],
        )

        useEffect(() => {
            if (!isPlaying) return
            const timerId = window.setTimeout(next, resolvedInterval)
            return () => window.clearTimeout(timerId)
        }, [isPlaying, next, resolvedInterval])

        const handleFocusCapture = useCallback(() => setHasFocusWithin(true), [])
        const handleBlurCapture = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setHasFocusWithin(false)
        }, [])

        const handleIndicatorKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
            if (itemCount <= 1) return
            const focusedIndexValue = (event.target as HTMLElement).dataset.textswitchIndex
            const focusedIndex = focusedIndexValue === undefined
                ? visibleIndex
                : normalizeIndex(Number(focusedIndexValue), itemCount, visibleIndex)

            let nextIndex: number
            switch (event.key) {
                case 'ArrowRight':
                case 'ArrowDown':
                    nextIndex = (focusedIndex + 1) % itemCount
                    break
                case 'ArrowLeft':
                case 'ArrowUp':
                    nextIndex = (focusedIndex - 1 + itemCount) % itemCount
                    break
                case 'Home':
                    nextIndex = 0
                    break
                case 'End':
                    nextIndex = itemCount - 1
                    break
                default:
                    return
            }

            event.preventDefault()
            jumpTo(nextIndex)
            event.currentTarget
                .querySelector<HTMLButtonElement>(`[data-textswitch-index="${nextIndex}"]`)
                ?.focus()
        }, [itemCount, jumpTo, visibleIndex])

        const motionStyle = useMemo(
            () => resolveMotionStyle(initial, animate, resolvedDuration, resolvedDelay),
            [animate, initial, resolvedDelay, resolvedDuration],
        )
        const contentId = `${textSwitchId}-content`
        const contentClassName = cn(
            'pr-textswitch-content',
            splitBy === 'lines' && 'pr-textswitch-lines',
            splitLevelClassName,
        )

        return (
            <div
                ref={rootRef}
                className={cn('pr-textswitch', resolvedMainClassName)}
                style={style}
                data-textswitch-root="true"
                data-textswitch-active-index={visibleIndex}
                data-textswitch-playback={isPlaying ? 'playing' : 'paused'}
                data-textswitch-pause-reasons={pauseReasons.length > 0 ? pauseReasons.join(' ') : 'none'}
                data-textswitch-motion={motionReduced ? 'reduced' : 'full'}
                data-textswitch-presence-mode={animatePresenceMode}
                onFocusCapture={handleFocusCapture}
                onBlurCapture={handleBlurCapture}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <div className="pr-textswitch-stage">
                    <span className="pr-textswitch-measure" aria-hidden="true">
                        {(safeTexts.length > 0 ? safeTexts : ['']).map((text, index) => (
                            <span className="pr-textswitch-measure-item" key={`${index}-${text}`}>
                                {text}
                            </span>
                        ))}
                    </span>

                    <div
                        key={`${visibleIndex}-${animationCycle}`}
                        id={contentId}
                        className={contentClassName}
                        data-textswitch-content="true"
                        style={motionStyle}
                        data-animate={animationActive && !motionReduced && resolvedDuration > 0 ? 'true' : 'false'}
                        aria-hidden={renderText ? undefined : 'true'}
                        onAnimationEnd={(event) => {
                            if (event.target === event.currentTarget) setAnimationActive(false)
                        }}
                    >
                        {renderText
                            ? renderText(currentText, visibleIndex)
                            : (
                                <span className={cn(
                                    'pr-textswitch-value',
                                    elementLevelClassName,
                                )}>
                                    {currentText}
                                </span>
                            )}
                    </div>
                </div>

                {!renderText && (
                    <span
                        className="pr-sr-only"
                        data-textswitch-live="true"
                        aria-live="polite"
                        aria-atomic="true"
                    >
                        {currentText}
                    </span>
                )}

                {itemCount > 1 && (
                    <div className="pr-textswitch-controls">
                        <div
                            className="pr-textswitch-dots"
                            role="group"
                            aria-label="切换展示文本"
                            aria-controls={contentId}
                            onKeyDown={handleIndicatorKeyDown}
                        >
                            {safeTexts.map((text, index) => {
                                const isActive = index === visibleIndex
                                const accessibleText = normalizeAccessibleText(text, index)
                                return (
                                    <button
                                        key={`${index}-${text}`}
                                        id={`${textSwitchId}-indicator-${index}`}
                                        data-textswitch-index={index}
                                        type="button"
                                        aria-pressed={isActive}
                                        aria-label={isActive
                                            ? `第 ${index + 1} 条：${accessibleText}，当前展示`
                                            : `切换到第 ${index + 1} 条：${accessibleText}`}
                                        className={cn('pr-textswitch-dot', isActive && 'is-active')}
                                        onClick={() => jumpTo(index)}
                                        tabIndex={isActive ? 0 : -1}
                                    />
                                )
                            })}
                        </div>

                        {auto && (
                            <button
                                type="button"
                                className="pr-textswitch-pause"
                                data-textswitch-pause-toggle="true"
                                data-textswitch-pause-control="true"
                                aria-pressed={manualPaused}
                                aria-label={manualPaused ? '继续自动切换' : '暂停自动切换'}
                                title={manualPaused ? '继续自动切换' : '暂停自动切换'}
                                onClick={togglePause}
                            >
                                <span className="pr-textswitch-pause-icon" aria-hidden="true">
                                    {manualPaused ? '▶' : 'Ⅱ'}
                                </span>
                            </button>
                        )}
                    </div>
                )}
            </div>
        )
    }),
)

TextSwitch.displayName = 'TextSwitch'

export { TextSwitch }
export default TextSwitch
