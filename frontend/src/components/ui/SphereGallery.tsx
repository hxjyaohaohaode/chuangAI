import {
    memo,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type FocusEvent,
    type KeyboardEvent,
    type UIEvent,
} from 'react'
import { createPortal } from 'react-dom'
import './SphereGallery.css'

export interface SphereGalleryImage {
    src?: string | null
    alt: string
    caption?: string
    id?: string
}

export interface SphereGalleryProps {
    images: readonly SphereGalleryImage[]
    className?: string
    activation?: 'preview' | 'select'
    ariaLabel?: string
    selectedIndex?: number | null
    focusIndex?: number | null
    emphasisIndices?: readonly number[] | null
    onImageSelect?: (index: number) => void
    onImageHover?: (index: number | null) => void
    onActiveImageChange?: (index: number) => void
}

type ImageLoadState = 'loading' | 'loaded' | 'failed'

const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',')

function clampIndex(index: number | null | undefined, count: number, fallback = 0): number {
    if (count <= 0) return 0
    if (typeof index !== 'number' || !Number.isFinite(index)) {
        return Math.min(Math.max(fallback, 0), count - 1)
    }
    return Math.min(Math.max(Math.trunc(index), 0), count - 1)
}

function resolveOptionalIndex(index: number | null | undefined, count: number): number | null {
    if (
        typeof index !== 'number'
        || !Number.isFinite(index)
        || index < 0
        || index >= count
    ) return null
    return Math.trunc(index)
}

function imageStateKey(image: SphereGalleryImage, index: number): string {
    return `${image.id ?? ''}\u0000${image.src ?? ''}\u0000${index}`
}

function ArrowIcon({ direction }: { direction: 'left' | 'right' }) {
    const points = direction === 'left' ? '15 18 9 12 15 6' : '9 18 15 12 9 6'
    return (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
            <polyline
                points={points}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    )
}

function CloseIcon() {
    return (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
            <path
                d="M6 6l12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
            />
        </svg>
    )
}

/**
 * 轻量图片画廊：以原生滚动、scroll-snap 与 DOM 按钮承载内容。
 *
 * 组件只回应用户的点击、键盘、触控或原生滚动；不启动自动播放、帧循环、
 * 定时器或全局指针监听。这使它在低性能设备、触摸屏、减少动效和打印环境下
 * 都保持同一套内容与交互语义。
 */
export const SphereGallery = memo(function SphereGallery({
    images,
    className,
    activation = 'preview',
    ariaLabel = '图片画廊',
    selectedIndex,
    focusIndex,
    emphasisIndices,
    onImageSelect,
    onImageHover,
    onActiveImageChange,
}: SphereGalleryProps) {
    const count = images.length
    const initialIndex = clampIndex(focusIndex ?? selectedIndex, count)
    const [activeIndex, setActiveIndex] = useState(initialIndex)
    const [rovingIndex, setRovingIndex] = useState(initialIndex)
    const [internalSelectedIndex, setInternalSelectedIndex] = useState<number | null>(null)
    const [previewIndex, setPreviewIndex] = useState<number | null>(null)
    const [loadStates, setLoadStates] = useState<Record<string, ImageLoadState>>({})

    const listRef = useRef<HTMLUListElement>(null)
    const itemButtonRefs = useRef<Array<HTMLButtonElement | null>>([])
    const previewPanelRef = useRef<HTMLDivElement>(null)
    const previewCloseRef = useRef<HTMLButtonElement>(null)
    const previewTriggerRef = useRef<HTMLButtonElement | null>(null)
    const itemCentersRef = useRef<number[]>([])
    const titleId = useId()
    const descriptionId = useId()

    const resolvedSelectedIndex = selectedIndex === undefined
        ? internalSelectedIndex
        : resolveOptionalIndex(selectedIndex, count)
    const emphasisSet = useMemo(
        () => new Set((emphasisIndices ?? []).filter((index) => (
            Number.isInteger(index) && index >= 0 && index < count
        ))),
        [count, emphasisIndices],
    )
    const isPreviewOpen = previewIndex !== null
    const previewImage = previewIndex === null ? null : images[previewIndex] ?? null

    const setImageState = useCallback((image: SphereGalleryImage, index: number, state: ImageLoadState) => {
        const key = imageStateKey(image, index)
        setLoadStates((current) => current[key] === state ? current : { ...current, [key]: state })
    }, [])

    const getImageState = useCallback((image: SphereGalleryImage, index: number): ImageLoadState => {
        if (!image.src) return 'failed'
        return loadStates[imageStateKey(image, index)] ?? 'loading'
    }, [loadStates])

    const commitActiveIndex = useCallback((nextIndex: number) => {
        if (count <= 0) return
        const safeIndex = clampIndex(nextIndex, count)
        setActiveIndex((current) => current === safeIndex ? current : safeIndex)
        setRovingIndex((current) => current === safeIndex ? current : safeIndex)
    }, [count])

    const revealIndex = useCallback((nextIndex: number, moveFocus: boolean) => {
        if (count <= 0) return
        const safeIndex = clampIndex(nextIndex, count)
        commitActiveIndex(safeIndex)
        const button = itemButtonRefs.current[safeIndex]
        button?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' })
        if (moveFocus) button?.focus({ preventScroll: true })
    }, [commitActiveIndex, count])

    const measureItemCenters = useCallback(() => {
        itemCentersRef.current = itemButtonRefs.current.map((button) => {
            const item = button?.parentElement
            return item ? item.offsetLeft + item.offsetWidth / 2 : Number.NaN
        })
    }, [])

    useLayoutEffect(() => {
        const list = listRef.current
        if (!list || count <= 0) {
            itemCentersRef.current = []
            return
        }

        measureItemCenters()
        if (typeof ResizeObserver === 'function') {
            let observer: ResizeObserver | null = null
            try {
                observer = new ResizeObserver(measureItemCenters)
                observer.observe(list)
                return () => observer?.disconnect()
            } catch {
                observer?.disconnect()
            }
        }

        if (typeof window !== 'undefined') {
            window.addEventListener('resize', measureItemCenters, { passive: true })
            return () => window.removeEventListener('resize', measureItemCenters)
        }
        return undefined
    }, [count, measureItemCenters])

    useEffect(() => {
        itemButtonRefs.current.length = count
        if (count <= 0) {
            setActiveIndex(0)
            setRovingIndex(0)
            setInternalSelectedIndex(null)
            setPreviewIndex(null)
            return
        }
        setActiveIndex((current) => clampIndex(current, count))
        setRovingIndex((current) => clampIndex(current, count))
        setInternalSelectedIndex((current) => current == null ? null : clampIndex(current, count))
        setPreviewIndex((current) => current == null ? null : clampIndex(current, count))
    }, [count])

    useEffect(() => {
        const currentKeys = new Set(images.map(imageStateKey))
        setLoadStates((current) => {
            const retainedEntries = Object.entries(current).filter(([key]) => currentKeys.has(key))
            return retainedEntries.length === Object.keys(current).length
                ? current
                : Object.fromEntries(retainedEntries)
        })
    }, [images])

    useEffect(() => {
        const nextFocusIndex = resolveOptionalIndex(focusIndex, count)
        if (nextFocusIndex == null) return
        revealIndex(nextFocusIndex, false)
    }, [count, focusIndex, revealIndex])

    useEffect(() => {
        if (count > 0) onActiveImageChange?.(activeIndex)
    }, [activeIndex, count, onActiveImageChange])

    useEffect(() => {
        if (!isPreviewOpen || typeof document === 'undefined') return

        const trigger = previewTriggerRef.current
        const body = document.body
        const previousOverflow = body.style.overflow
        const previousPaddingRight = body.style.paddingRight
        const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth)
        body.style.overflow = 'hidden'
        if (scrollbarWidth > 0) {
            const computedPadding = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0
            body.style.paddingRight = `${computedPadding + scrollbarWidth}px`
        }
        previewCloseRef.current?.focus({ preventScroll: true })

        return () => {
            body.style.overflow = previousOverflow
            body.style.paddingRight = previousPaddingRight
            if (trigger?.isConnected) trigger.focus({ preventScroll: true })
        }
    }, [isPreviewOpen])

    const closePreview = useCallback(() => setPreviewIndex(null), [])

    const activateImage = useCallback((index: number, trigger: HTMLButtonElement) => {
        const safeIndex = clampIndex(index, count)
        commitActiveIndex(safeIndex)
        onImageSelect?.(safeIndex)
        if (activation === 'preview') {
            previewTriggerRef.current = trigger
            setPreviewIndex(safeIndex)
        } else {
            setInternalSelectedIndex(safeIndex)
        }
    }, [activation, commitActiveIndex, count, onImageSelect])

    const handleItemKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        let nextIndex: number | null = null
        switch (event.key) {
            case 'ArrowLeft':
            case 'ArrowUp':
                nextIndex = (index - 1 + count) % count
                break
            case 'ArrowRight':
            case 'ArrowDown':
                nextIndex = (index + 1) % count
                break
            case 'Home':
                nextIndex = 0
                break
            case 'End':
                nextIndex = count - 1
                break
            default:
                return
        }
        event.preventDefault()
        revealIndex(nextIndex, true)
    }, [count, revealIndex])

    const handleListScroll = useCallback((event: UIEvent<HTMLUListElement>) => {
        const focusedIndex = itemButtonRefs.current.findIndex(
            (button) => button === document.activeElement,
        )
        if (focusedIndex >= 0) {
            // Keyboard/programmatic focus is authoritative: scrollIntoView may emit a
            // later scroll event whose transient visual centre still points at the
            // previous card. Unfocused direct scrolling continues through the
            // geometry-based branch below.
            commitActiveIndex(focusedIndex)
            return
        }

        // 使用缓存中心点二分查找，避免每个滚动事件对全部卡片执行
        // getBoundingClientRect 强制布局；保持组件无 RAF/计时器的轻量契约。
        const list = event.currentTarget
        const updateFromScroll = () => {
            let centers = itemCentersRef.current
            if (centers.length !== count || centers.some((value) => !Number.isFinite(value))) {
                measureItemCenters()
                centers = itemCentersRef.current
            }
            if (centers.length === 0) return

            const target = list.scrollLeft + list.clientWidth / 2
            let low = 0
            let high = centers.length - 1
            while (low < high) {
                const middle = Math.floor((low + high) / 2)
                if ((centers[middle] ?? Number.POSITIVE_INFINITY) < target) low = middle + 1
                else high = middle
            }
            const right = low
            const left = Math.max(0, right - 1)
            const closest = Math.abs((centers[left] ?? 0) - target)
                <= Math.abs((centers[right] ?? 0) - target)
                ? left
                : right
            commitActiveIndex(closest)
        }

        updateFromScroll()
    }, [commitActiveIndex, count, measureItemCenters])

    const handleItemBlur = useCallback((event: FocusEvent<HTMLButtonElement>) => {
        const next = event.relatedTarget
        if (!(next instanceof Node) || !listRef.current?.contains(next)) onImageHover?.(null)
    }, [onImageHover])

    const handlePreviewKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            closePreview()
            return
        }
        if (event.key !== 'Tab') return

        const panel = previewPanelRef.current
        if (!panel) return
        const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
            .filter((element) => element.getClientRects().length > 0)
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (!first || !last) {
            event.preventDefault()
            panel.focus()
            return
        }
        const current = document.activeElement
        if (event.shiftKey && (current === first || !panel.contains(current))) {
            event.preventDefault()
            last.focus()
        } else if (!event.shiftKey && (current === last || !panel.contains(current))) {
            event.preventDefault()
            first.focus()
        }
    }, [closePreview])

    const showPreviewSibling = useCallback((direction: -1 | 1) => {
        setPreviewIndex((current) => {
            if (current == null) return current
            const next = clampIndex(current + direction, count, current)
            commitActiveIndex(next)
            itemButtonRefs.current[next]?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' })
            return next
        })
    }, [commitActiveIndex, count])

    const rootClassName = ['pr-sphere-gallery', className].filter(Boolean).join(' ')
    const activeImage = images[activeIndex]
    const activeStatus = activeImage ? getImageState(activeImage, activeIndex) : null

    return (
        <section
            className={rootClassName}
            data-sphere-gallery="lightweight"
            data-gallery-count={count}
            data-gallery-active-index={count > 0 ? activeIndex : -1}
            data-gallery-selected-index={resolvedSelectedIndex ?? -1}
            data-gallery-motion="manual-only"
            data-gallery-activation={activation}
            role="region"
            aria-roledescription="轮播图"
            aria-label={ariaLabel}
        >
            <div className="pr-sphere-gallery__heading">
                <div>
                    <p className="pr-sphere-gallery__eyebrow">图片预览</p>
                    <p className="pr-sphere-gallery__status" aria-live="polite" aria-atomic="true">
                        {activeImage
                            ? `${activeImage.alt}，第 ${activeIndex + 1} 张，共 ${count} 张${activeStatus === 'failed' ? '，图像暂不可用' : ''}`
                            : '暂无可预览图片'}
                    </p>
                </div>
                <span className="pr-sphere-gallery__counter" aria-hidden="true">
                    <strong>{count > 0 ? String(activeIndex + 1).padStart(2, '0') : '00'}</strong>
                    <span>/ {String(count).padStart(2, '0')}</span>
                </span>
            </div>

            {count > 0 ? (
                <div className="pr-sphere-gallery__stage">
                    <button
                        type="button"
                        className="pr-sphere-gallery__nav pr-sphere-gallery__nav--previous"
                        aria-label="上一张"
                        disabled={activeIndex <= 0}
                        onClick={() => revealIndex(activeIndex - 1, true)}
                    >
                        <ArrowIcon direction="left" />
                    </button>

                    <ul
                        ref={listRef}
                        className="pr-sphere-gallery__list"
                        data-gallery-track="true"
                        aria-label={`${ariaLabel}图片列表`}
                        onScroll={handleListScroll}
                    >
                        {images.map((image, index) => {
                            const state = getImageState(image, index)
                            const isActive = activeIndex === index
                            const isSelected = resolvedSelectedIndex === index
                            const isEmphasized = emphasisSet.size === 0 || emphasisSet.has(index)
                            return (
                                <li
                                    key={imageStateKey(image, index)}
                                    className="pr-sphere-gallery__item"
                                >
                                    <button
                                        ref={(node) => { itemButtonRefs.current[index] = node }}
                                        type="button"
                                        className={`pr-sphere-gallery-card${isActive ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}${isEmphasized ? ' is-emphasized' : ' is-muted'}`}
                                        data-gallery-index={index}
                                        data-gallery-id={image.id ?? undefined}
                                        data-image-state={state}
                                        tabIndex={rovingIndex === index ? 0 : -1}
                                        aria-current={isActive ? 'true' : undefined}
                                        aria-pressed={activation === 'select' ? isSelected : undefined}
                                        aria-label={`${image.alt}，第 ${index + 1} 张，共 ${count} 张${state === 'failed' ? '，图像暂不可用' : ''}，${activation === 'preview' ? '打开大图预览' : '选择此图'}`}
                                        onClick={(event) => activateImage(index, event.currentTarget)}
                                        onKeyDown={(event) => handleItemKeyDown(event, index)}
                                        onFocus={() => {
                                            commitActiveIndex(index)
                                            onImageHover?.(index)
                                        }}
                                        onBlur={handleItemBlur}
                                        onMouseEnter={() => onImageHover?.(index)}
                                        onMouseLeave={() => onImageHover?.(null)}
                                    >
                                        <span className="pr-sphere-gallery-card__media" aria-hidden="true">
                                            {state !== 'failed' && image.src ? (
                                                <img
                                                    className="pr-sphere-gallery-card__image"
                                                    src={image.src}
                                                    alt=""
                                                    loading="lazy"
                                                    decoding="async"
                                                    onLoad={() => setImageState(image, index, 'loaded')}
                                                    onError={() => setImageState(image, index, 'failed')}
                                                />
                                            ) : (
                                                <span className="pr-sphere-gallery-card__fallback">
                                                    <span className="pr-sphere-gallery-card__fallback-mark">图</span>
                                                    <span>图像暂不可用</span>
                                                </span>
                                            )}
                                        </span>
                                        <span className="pr-sphere-gallery-card__copy">
                                            <strong>{image.alt}</strong>
                                            <span>{image.caption ?? (activation === 'preview' ? '点击查看大图' : '点击选择')}</span>
                                        </span>
                                        <span className="pr-sphere-gallery-card__number" aria-hidden="true">
                                            {String(index + 1).padStart(2, '0')}
                                        </span>
                                    </button>
                                </li>
                            )
                        })}
                    </ul>

                    <button
                        type="button"
                        className="pr-sphere-gallery__nav pr-sphere-gallery__nav--next"
                        aria-label="下一张"
                        disabled={activeIndex >= count - 1}
                        onClick={() => revealIndex(activeIndex + 1, true)}
                    >
                        <ArrowIcon direction="right" />
                    </button>
                </div>
            ) : (
                <div className="pr-sphere-gallery__empty" role="status">
                    <span aria-hidden="true">图</span>
                    <p>当前没有可预览的图片</p>
                </div>
            )}

            {isPreviewOpen && previewImage && typeof document !== 'undefined' && createPortal(
                <div
                    className="pr-sphere-gallery-dialog-backdrop"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) closePreview()
                    }}
                >
                    <div
                        ref={previewPanelRef}
                        className="pr-sphere-gallery-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby={titleId}
                        aria-describedby={descriptionId}
                        tabIndex={-1}
                        onKeyDown={handlePreviewKeyDown}
                    >
                        <header className="pr-sphere-gallery-dialog__header">
                            <div>
                                <p className="pr-sphere-gallery-dialog__eyebrow">模板图片预览</p>
                                <h2 id={titleId}>{previewImage.alt}</h2>
                            </div>
                            <button
                                ref={previewCloseRef}
                                type="button"
                                className="pr-sphere-gallery-dialog__close"
                                aria-label="关闭图片预览"
                                onClick={closePreview}
                            >
                                <CloseIcon />
                            </button>
                        </header>

                        <figure className="pr-sphere-gallery-dialog__figure">
                            <div
                                className="pr-sphere-gallery-dialog__media"
                                data-image-state={getImageState(previewImage, previewIndex)}
                            >
                                {getImageState(previewImage, previewIndex) !== 'failed' && previewImage.src ? (
                                    <img
                                        src={previewImage.src}
                                        alt={previewImage.alt}
                                        decoding="async"
                                        onLoad={() => setImageState(previewImage, previewIndex, 'loaded')}
                                        onError={() => setImageState(previewImage, previewIndex, 'failed')}
                                    />
                                ) : (
                                    <div
                                        className="pr-sphere-gallery-dialog__fallback"
                                        role="status"
                                        aria-live="polite"
                                        aria-atomic="true"
                                    >
                                        <span aria-hidden="true">图</span>
                                        <strong>图像暂时无法显示</strong>
                                        <p>仍可关闭预览或查看其他图片，不影响模板的选择和套用。</p>
                                    </div>
                                )}
                            </div>
                            <figcaption id={descriptionId}>
                                <span>{previewImage.caption ?? '教案模板视觉预览'}</span>
                                <strong>{previewIndex + 1} / {count}</strong>
                            </figcaption>
                        </figure>

                        <footer className="pr-sphere-gallery-dialog__controls">
                            <button
                                type="button"
                                disabled={previewIndex <= 0}
                                onClick={() => showPreviewSibling(-1)}
                            >
                                <ArrowIcon direction="left" />
                                <span>上一张</span>
                            </button>
                            <button
                                type="button"
                                disabled={previewIndex >= count - 1}
                                onClick={() => showPreviewSibling(1)}
                            >
                                <span>下一张</span>
                                <ArrowIcon direction="right" />
                            </button>
                        </footer>
                    </div>
                </div>,
                document.body,
            )}
        </section>
    )
})
