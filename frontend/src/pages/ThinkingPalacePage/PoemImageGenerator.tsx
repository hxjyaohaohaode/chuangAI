/**
 * SubTask 27.1：诗境 AI 生图模块（规范第 2、4、6、9、14 章）
 *
 * 调用 POST /api/ai/image-generate（wan2.7-image）
 * 职责：
 *  - 基于诗词内容自动构造画面描述 prompt
 *  - 1-4 张可配置批量生成
 *  - 加载态：骨架屏 + 进度条
 *  - 完成态：2×2 玻璃态卡片网格
 *  - 交互：点击图片 lightbox 大图查看 + 下载 + 重新生成
 *
 * 设计要点（规范第 2、4、6、14 章）：
 *  - 零硬编码：所有色值/间距/圆角引用 tokens.css 变量
 *  - 玻璃态卡片：surface-secondary + backdrop-blur 20px
 *  - 无硬边框：透明度分层 + 阴影
 *  - 流体尺寸：clamp() 控制网格列宽
 *  - 完整三态：hover 微升 2px + 阴影扩散
 *  - GPU 友好：动画仅 transform/opacity
 *  - 图片懒加载：loading="lazy" + decoding="async"
 *
 * 模型约束（大模型API文档.md）：
 *  - 仅使用 wan2.7-image（DASHSCOPE_API_KEY 由后端代理）
 *  - 禁止使用其他生图模型
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
    beginAsyncGeneration,
    invalidateAsyncGeneration,
    isAsyncGenerationCurrent,
    type AsyncGenerationToken,
} from '@/lib/async-generation'
import { toast } from '@/stores/toast'
import { logError } from '@/lib/errors'
import { Icon } from '@/components/ui/Icon'
import { Combobox, type ComboboxOption } from '@/components/ui'
import type { AiGeneratedImage, CulturePoem } from '@/lib/types'

/* ============================================================
 * 常量
 * ============================================================ */

/** 生成数量选项 */
const COUNT_OPTIONS: readonly ComboboxOption[] = [
    { value: '1', label: '1 张' },
    { value: '2', label: '2 张' },
    { value: '3', label: '3 张' },
    { value: '4', label: '4 张' },
]

/** 图片方向选项 */
const ORIENTATION_OPTIONS: ComboboxOption[] = [
    { value: 'landscape', label: '横屏' },
    { value: 'portrait', label: '竖屏' },
]

/** 进度条假动画时长（ms）—— 真实进度由后端控制，此处仅为视觉反馈 */
const PROGRESS_ANIM_MS = 1500

/* ============================================================
 * Prompt 构造器：基于诗词内容生成画面描述
 *
 * 设计意图：
 *  - 不直接发原诗给生图模型（古诗意境抽象，模型理解困难）
 *  - 抽取关键词 + 朝代 + 风格 hint，构造具象画面描述
 *  - 保留 verse 字段供 UI 展示"这张图对应哪一句"
 * ============================================================ */

function buildImagePrompt(poem: CulturePoem, verse?: string): string {
    const eraHint = poem.dynasty ? `${poem.dynasty}时期` : '古代中国'
    const baseText = verse ?? poem.content.split(/[。！？；\n]+/)[0] ?? poem.title
    return [
        `中国古典诗境插画，${eraHint}风格，`,
        `画面主体：「${baseText}」`,
        `情景：${poem.title} · ${poem.poet}`,
        '工笔重彩与水墨写意结合，柔和暖色调，',
        '高细节，电影级构图，诗意氛围，',
        '无文字水印，无人物面部特写',
    ].join('，')
}

/**
 * 重试图片时只为 HTTP(S) 地址附加一次无语义的缓存键。
 * data/blob 等本地 URL 不应被拼接查询串，否则会把合法资源变成非法地址。
 */
function imageSourceForAttempt(source: string, attempt: number): string {
    if (attempt === 0) return source
    try {
        const url = new URL(source, window.location.href)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return source
        url.searchParams.set('_prImageRetry', String(attempt))
        return url.href
    } catch {
        return source
    }
}

/* ============================================================
 * 单张图片卡片（memo 优化）
 * ============================================================ */

interface ImageCardProps {
    image: AiGeneratedImage
    index: number
    onOpen: (image: AiGeneratedImage) => void
    registerOpenTrigger: (imageId: string, element: HTMLButtonElement | null) => void
}

const ImageCard = memo(function ImageCard({ image, index, onOpen, registerOpenTrigger }: ImageCardProps) {
    const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>('loading')
    const [retryAttempt, setRetryAttempt] = useState(0)

    useEffect(() => {
        setLoadState('loading')
        setRetryAttempt(0)
    }, [image.id, image.url])

    const imageSource = useMemo(
        () => imageSourceForAttempt(image.url, retryAttempt),
        [image.url, retryAttempt],
    )
    const failed = loadState === 'failed'
    const reloadImage = useCallback(() => {
        setLoadState('loading')
        setRetryAttempt((attempt) => attempt + 1)
    }, [])

    return (
        <article
            className="poem-image-card"
            role="listitem"
            style={{ animationDelay: `${index * 60}ms` }}
        >
            <button
                type="button"
                className="poem-image-card__open"
                ref={(element) => registerOpenTrigger(image.id, element)}
                onClick={() => {
                    if (!failed) onOpen(image)
                }}
                disabled={failed}
                aria-label={failed
                    ? `插画 ${index + 1} 加载失败；请重新加载图片或重新生成`
                    : `查看大图 ${index + 1}：${image.verse ?? '诗境插画'}`}
            >
                <div className="poem-image-card__media">
                    {loadState === 'loading' && <div className="poem-image-card__skeleton" aria-hidden="true" />}
                    {failed ? (
                        <div className="poem-image-card__failure" role="status">
                            <Icon name="file-image" size={24} weight="bold" aria-hidden />
                            <strong>插画加载失败</strong>
                            <span>可重新加载或重新生成</span>
                        </div>
                    ) : (
                        <img
                            src={imageSource}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            onLoad={() => setLoadState('loaded')}
                            onError={() => setLoadState('failed')}
                            className={loadState === 'loaded' ? 'is-loaded' : ''}
                        />
                    )}
                </div>
                {image.verse && (
                    <p className="poem-image-card__verse" title={image.verse}>
                        {image.verse}
                    </p>
                )}
                {image.degraded && (
                    <p className="poem-image-card__verse" role="status">
                        {image.demo ? '演示占位图' : '服务降级占位图'} · 未调用 {image.requestedModel}
                    </p>
                )}
            </button>
            <div className="poem-image-card__actions">
                {failed ? (
                    <button
                        type="button"
                        className="poem-image-card__reload"
                        onClick={reloadImage}
                        aria-label="重新加载图片"
                    >
                        <Icon name="arrows-clockwise" size={14} />
                        <span>重新加载</span>
                    </button>
                ) : image.degraded ? (
                    <span className="poem-image-card__reload" aria-label="本地占位图，不提供生成图片下载">
                        <Icon name="info" size={14} />
                        <span>本地占位</span>
                    </span>
                ) : (
                    <a
                        href={image.url}
                        download={`诗境插画-${index + 1}.png`}
                        target="_blank"
                        rel="noreferrer"
                        className="poem-image-card__action"
                        aria-label="下载图片"
                    >
                        <Icon name="download" size={14} />
                    </a>
                )}
            </div>
        </article>
    )
})

/* ============================================================
 * Lightbox 大图查看器
 * ============================================================ */

interface LightboxProps {
    image: AiGeneratedImage | null
    onClose: () => void
    onPrev: () => void
    onNext: () => void
    hasPrev: boolean
    hasNext: boolean
}

function Lightbox({ image, onClose, onPrev, onNext, hasPrev, hasNext }: LightboxProps) {
    const dialogRef = useRef<HTMLDivElement>(null)
    const closeButtonRef = useRef<HTMLButtonElement>(null)
    const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>('loading')
    const [retryAttempt, setRetryAttempt] = useState(0)
    const imageSource = useMemo(
        () => image ? imageSourceForAttempt(image.url, retryAttempt) : '',
        [image, retryAttempt],
    )
    const failed = loadState === 'failed'
    const reloadImage = useCallback(() => {
        setLoadState('loading')
        setRetryAttempt((attempt) => attempt + 1)
    }, [])

    useEffect(() => {
        if (!image) return
        const previousBodyOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const focusFrame = window.requestAnimationFrame(() => {
            closeButtonRef.current?.focus()
        })
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
            } else if (e.key === 'ArrowLeft' && hasPrev) onPrev()
            else if (e.key === 'ArrowRight' && hasNext) onNext()
            else if (e.key === 'Tab') {
                const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
                    'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
                ) ?? [])
                if (focusable.length === 0) {
                    e.preventDefault()
                    dialogRef.current?.focus()
                    return
                }
                const first = focusable[0]
                const last = focusable[focusable.length - 1]
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault()
                    last?.focus()
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault()
                    first?.focus()
                }
            }
        }
        window.addEventListener('keydown', onKey)
        return () => {
            document.body.style.overflow = previousBodyOverflow
            window.cancelAnimationFrame(focusFrame)
            window.removeEventListener('keydown', onKey)
        }
    }, [image, onClose, onPrev, onNext, hasPrev, hasNext])

    if (!image || typeof document === 'undefined') return null
    return createPortal((
        <div
            ref={dialogRef}
            className="poem-image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="图片大图查看"
            tabIndex={-1}
            onClick={onClose}
        >
            <button
                ref={closeButtonRef}
                className="poem-image-lightbox__close"
                onClick={(event) => {
                    event.stopPropagation()
                    onClose()
                }}
                aria-label="关闭"
            >
                <Icon name="x" size={20} />
            </button>
            {hasPrev && (
                <button
                    className="poem-image-lightbox__nav poem-image-lightbox__nav--prev"
                    onClick={(e) => {
                        e.stopPropagation()
                        onPrev()
                    }}
                    aria-label="上一张"
                >
                    <Icon name="caret-left" size={24} />
                </button>
            )}
            {hasNext && (
                <button
                    className="poem-image-lightbox__nav poem-image-lightbox__nav--next"
                    onClick={(e) => {
                        e.stopPropagation()
                        onNext()
                    }}
                    aria-label="下一张"
                >
                    <Icon name="caret-right" size={24} />
                </button>
            )}
            <figure
                className="poem-image-lightbox__figure"
                onClick={(e) => e.stopPropagation()}
            >
                {failed ? (
                    <div className="poem-image-lightbox__failure" role="status">
                        <Icon name="file-image" size={32} weight="bold" aria-hidden />
                        <strong>大图加载失败</strong>
                        <span>原资源暂不可用，可重新加载、切换图片或重新生成。</span>
                        <button
                            type="button"
                            className="poem-image-lightbox__retry"
                            onClick={reloadImage}
                        >
                            <Icon name="arrows-clockwise" size={14} />
                            重新加载图片
                        </button>
                    </div>
                ) : (
                    <img
                        src={imageSource}
                        alt={image.verse ?? '诗境插画'}
                        onLoad={() => setLoadState('loaded')}
                        onError={() => setLoadState('failed')}
                    />
                )}
                {image.verse && (
                    <figcaption className="poem-image-lightbox__caption">
                        <Icon name="quotes" size={14} />
                        <span>{image.verse}</span>
                    </figcaption>
                )}
                {!failed && !image.degraded && (
                    <a
                        href={image.url}
                        download={`诗境插画-${image.id}.png`}
                        target="_blank"
                        rel="noreferrer"
                        className="poem-image-lightbox__download"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <Icon name="download" size={14} />
                        <span>下载图片</span>
                    </a>
                )}
            </figure>
        </div>
    ), document.body)
}

/* ============================================================
 * 主组件 —— PoemImageGenerator
 * ============================================================ */

export interface PoemImageGeneratorProps {
    /** 当前选中的诗 */
    poem: CulturePoem | null
}

interface ImageGenerationRequest {
    token: AsyncGenerationToken
    poem: CulturePoem
    count: number
    orientation: 'portrait' | 'landscape'
}

interface ScopedImages {
    contextKey: string
    images: AiGeneratedImage[]
}

export function PoemImageGenerator({ poem }: PoemImageGeneratorProps) {
    /* ---------- 状态 ---------- */
    const [count, setCount] = useState<string>('2')
    const [orientation, setOrientation] = useState<string>('landscape')
    const [scopedImages, setScopedImages] = useState<ScopedImages | null>(null)
    const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
    const [progress, setProgress] = useState(0)
    const progressTimerRef = useRef<number | null>(null)
    const progressResetTimerRef = useRef<number | null>(null)
    const imageOpenTriggerRefs = useRef(new Map<string, HTMLButtonElement>())
    const lastOpenedImageIdRef = useRef<string | null>(null)
    const generationRef = useRef(0)
    const mountedRef = useRef(false)
    // prompt 实际读取的字段全部进入上下文键；同 ID 正文/署名变化也必须视为新实体版本。
    const poemContextKey = JSON.stringify([
        poem?.id ?? null,
        poem?.title ?? null,
        poem?.poet ?? null,
        poem?.dynasty ?? null,
        poem?.content ?? null,
    ])
    const latestPoemContextKeyRef = useRef(poemContextKey)
    latestPoemContextKeyRef.current = poemContextKey
    const images = scopedImages?.contextKey === poemContextKey ? scopedImages.images : []

    const isCurrentImageGeneration = useCallback((token: AsyncGenerationToken) => (
        isAsyncGenerationCurrent(
            token,
            generationRef.current,
            latestPoemContextKeyRef.current,
            mountedRef.current,
        )
    ), [])

    const clearProgressTimers = useCallback(() => {
        if (progressTimerRef.current !== null) {
            window.clearInterval(progressTimerRef.current)
            progressTimerRef.current = null
        }
        if (progressResetTimerRef.current !== null) {
            window.clearTimeout(progressResetTimerRef.current)
            progressResetTimerRef.current = null
        }
    }, [])

    /* ---------- 进度条假动画（生图过程中给用户视觉反馈） ---------- */
    const startProgressAnimation = useCallback((token: AsyncGenerationToken) => {
        clearProgressTimers()
        if (!isCurrentImageGeneration(token)) return
        setProgress(0)
        const startTime = Date.now()
        progressTimerRef.current = window.setInterval(() => {
            if (!isCurrentImageGeneration(token)) {
                clearProgressTimers()
                return
            }
            const elapsed = Date.now() - startTime
            // 上限 92%，等待真实完成后由 mutate onSuccess 跳到 100%
            const fake = Math.min(92, (elapsed / PROGRESS_ANIM_MS) * 92)
            setProgress(fake)
        }, 50)
    }, [clearProgressTimers, isCurrentImageGeneration])

    const completeProgressAnimation = useCallback((token: AsyncGenerationToken) => {
        clearProgressTimers()
        if (!isCurrentImageGeneration(token)) return
        setProgress(100)
        // 200ms 后重置进度（光标淡出风格）
        progressResetTimerRef.current = window.setTimeout(() => {
            progressResetTimerRef.current = null
            if (isCurrentImageGeneration(token)) setProgress(0)
        }, 200)
    }, [clearProgressTimers, isCurrentImageGeneration])

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            invalidateAsyncGeneration(generationRef)
            clearProgressTimers()
        }
    }, [clearProgressTimers])

    /* ---------- TanStack Query mutation ---------- */
    const mutation = useMutation({
        mutationFn: async (request: ImageGenerationRequest) => {
            const verses = request.poem.content
                .split(/[。！？；\n]+/)
                .map((line) => line.trim())
                .filter(Boolean)
            const n = request.count
            // 多张时尝试关联不同诗句
            const versesToUse = verses.length >= n ? verses.slice(0, n) : verses
            const prompts: Array<{ prompt: string; verse?: string }> = []
            for (let i = 0; i < n; i++) {
                const verse = versesToUse[i % Math.max(1, versesToUse.length)]
                prompts.push({
                    prompt: buildImagePrompt(request.poem, verse),
                    verse,
                })
            }
            // 并发请求每张图（后端按 prompt 维度命中缓存）
            const responses = await Promise.all(
                prompts.map((p) =>
                    api.ai.imageGenerate({
                        prompt: p.prompt,
                        orientation: request.orientation,
                        n: 1,
                        poemId: request.poem.id,
                        verse: p.verse,
                    }),
                ),
            )
            return {
                images: responses.flatMap((response) => response.images),
            }
        },
        onMutate: (request) => {
            startProgressAnimation(request.token)
        },
        onSuccess: (data, request) => {
            if (!isCurrentImageGeneration(request.token)) return
            completeProgressAnimation(request.token)
            setScopedImages({ contextKey: request.token.contextKey, images: data.images })
            toast.success({
                title: '生成完成',
                message: `已由 wan2.7-image 生成 ${data.images.length} 张诗境插画`,
            })
        },
        onError: (err: unknown, request) => {
            if (!isCurrentImageGeneration(request.token)) return
            clearProgressTimers()
            setProgress(0)
            logError('PoemImageGenerator.generate', err)
            toast.error({
                title: '生成失败',
                message: err instanceof Error ? err.message : '请稍后重试',
            })
        },
    })

    /* ---------- 切换诗或同 ID 正文变更时立即隔离旧请求与旧结果 ---------- */
    useEffect(() => {
        invalidateAsyncGeneration(generationRef)
        clearProgressTimers()
        setProgress(0)
        setScopedImages(null)
        setLightboxIndex(null)
        lastOpenedImageIdRef.current = null
    }, [poemContextKey, clearProgressTimers])

    const activeMutationToken = mutation.variables?.token
    const mutationBelongsToCurrentPoem = activeMutationToken
        ? isCurrentImageGeneration(activeMutationToken)
        : false
    const isGenerating = mutation.isPending && mutationBelongsToCurrentPoem
    const hasGenerationError = mutation.isError && mutationBelongsToCurrentPoem
    const pendingCount = isGenerating
        ? mutation.variables?.count ?? Math.max(1, Math.min(4, Number(count) || 1))
        : Math.max(1, Math.min(4, Number(count) || 1))

    /* ---------- 手动触发生成 ---------- */
    const handleGenerate = useCallback(() => {
        if (!poem) {
            toast.warning({ message: '请先选择古诗' })
            return
        }
        const token = beginAsyncGeneration(generationRef, poemContextKey)
        mutation.mutate({
            token,
            poem: { ...poem },
            count: Math.max(1, Math.min(4, Number(count) || 1)),
            orientation: orientation === 'portrait' ? 'portrait' : 'landscape',
        })
    }, [poem, poemContextKey, count, orientation, mutation])

    /* ---------- Lightbox 控制 ---------- */
    const registerOpenTrigger = useCallback((imageId: string, element: HTMLButtonElement | null) => {
        if (element) {
            imageOpenTriggerRefs.current.set(imageId, element)
        } else {
            imageOpenTriggerRefs.current.delete(imageId)
        }
    }, [])

    const openLightbox = useCallback((image: AiGeneratedImage) => {
        const idx = images.findIndex((i) => i.id === image.id)
        if (idx >= 0) {
            lastOpenedImageIdRef.current = image.id
            setLightboxIndex(idx)
        }
    }, [images])

    const closeLightbox = useCallback(() => {
        const triggerId = lastOpenedImageIdRef.current
        setLightboxIndex(null)
        if (triggerId) {
            window.requestAnimationFrame(() => imageOpenTriggerRefs.current.get(triggerId)?.focus())
        }
    }, [])
    const prevLightbox = useCallback(() => {
        setLightboxIndex((prev) => (prev !== null && prev > 0 ? prev - 1 : prev))
    }, [])
    const nextLightbox = useCallback(() => {
        setLightboxIndex((prev) =>
            prev !== null && prev < images.length - 1 ? prev + 1 : prev,
        )
    }, [images.length])

    const lightboxImage = lightboxIndex !== null ? images[lightboxIndex] ?? null : null

    /* ---------- 派生：当前诗的可用诗句（供用户预览 prompt 依据） ---------- */
    const versesPreview = useMemo(() => {
        if (!poem) return []
        return poem.content
            .split(/[。！？；\n]+/)
            .map((line) => line.trim())
            .filter(Boolean)
    }, [poem])

    /* ---------- 渲染 ---------- */
    if (!poem) {
        return (
            <div className="poem-image-generator poem-image-generator--empty">
                <Icon name="paint-brush" size={32} />
                <p>请先选择古诗，再生成诗境插画</p>
            </div>
        )
    }

    return (
        <section
            className="poem-image-generator"
            data-anchor
            data-anchor-label="AI 诗境生图"
            aria-label="AI 诗境生图"
        >
            <header className="poem-image-generator__header">
                <div className="poem-image-generator__title-group">
                    <span className="poem-image-generator__eyebrow">
                        <Icon name="sparkle" size={12} weight="bold" />
                        <span>wan2.7-image · 诗境生图</span>
                    </span>
                    <h3 className="poem-image-generator__title">
                        为「{poem.title}」生成插画
                    </h3>
                    <p className="poem-image-generator__subtitle">
                        AI 将基于诗句内容构造画面描述，生成 1-4 张诗境插画。可点击查看大图、下载或重新生成。
                    </p>
                </div>
            </header>

            <div className="poem-image-generator__controls">
                <div className="poem-image-generator__control">
                    <label className="poem-image-generator__label">生成数量</label>
                    <Combobox
                        options={COUNT_OPTIONS}
                        value={count}
                        onChange={(v) => setCount(v as string)}
                        mode="single"
                        ariaLabel="生成数量"
                        searchable={false}
                    />
                </div>
                <div className="poem-image-generator__control">
                    <label className="poem-image-generator__label">图片方向</label>
                    <Combobox
                        options={ORIENTATION_OPTIONS}
                        value={orientation}
                        onChange={(v) => setOrientation(v as string)}
                        mode="single"
                        ariaLabel="图片方向"
                        searchable={false}
                    />
                </div>
                <button
                    className="poem-image-generator__btn"
                    onClick={handleGenerate}
                    disabled={isGenerating}
                    aria-busy={isGenerating}
                >
                    <Icon
                        name={isGenerating ? 'circle-notch' : 'magic-wand'}
                        size={14}
                        weight={isGenerating ? 'bold' : 'regular'}
                        className={isGenerating ? 'pr-app-spin' : ''}
                    />
                    <span>{isGenerating ? '生成中…' : images.length > 0 ? '重新生成' : '生成插画'}</span>
                </button>
            </div>

            {/* 进度条（生图过程中） */}
            {isGenerating && (
                <div className="poem-image-generator__progress" aria-hidden="true">
                    <div
                        className="poem-image-generator__progress-bar"
                        style={{ width: `${progress}%` }}
                    />
                </div>
            )}

            {/* 错误态 */}
            {hasGenerationError && !isGenerating && (
                <div className="poem-image-generator__error" role="alert">
                    <Icon name="warning-circle" size={18} />
                    <div>
                        <strong>生成失败</strong>
                        <span>
                            {mutation.error instanceof Error
                                ? mutation.error.message
                                : '请稍后重试'}
                        </span>
                    </div>
                    <button onClick={handleGenerate} className="poem-image-generator__retry">
                        <Icon name="arrows-clockwise" size={13} />
                        重试
                    </button>
                </div>
            )}

            {/* 空态（首次进入） */}
            {!isGenerating && !hasGenerationError && images.length === 0 && (
                <div className="poem-image-generator__placeholder">
                    <Icon name="mountains" size={42} />
                    <p>点击「生成插画」开始创作</p>
                    {versesPreview.length > 0 && (
                        <div className="poem-image-generator__verses-preview">
                            <span className="poem-image-generator__verses-label">
                                <Icon name="quotes" size={11} />
                                将基于以下诗句生成：
                            </span>
                            <ul>
                                {versesPreview.slice(0, 4).map((v, i) => (
                                    <li key={i}>{v}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}

            {/* 骨架屏（首次加载） */}
            {isGenerating && images.length === 0 && (
                <div className="poem-image-generator__grid">
                    {Array.from({ length: pendingCount }, (_, i) => (
                        <div key={i} className="poem-image-card poem-image-card--skeleton">
                            <div className="poem-image-card__media">
                                <div className="poem-image-card__skeleton" />
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* 图片网格（2×2） */}
            {!isGenerating && images.length > 0 && (
                <div className="poem-image-generator__grid" role="list">
                    {images.map((image, i) => (
                        <ImageCard
                            key={image.id}
                            image={image}
                            index={i}
                            onOpen={openLightbox}
                            registerOpenTrigger={registerOpenTrigger}
                        />
                    ))}
                </div>
            )}

            {/* Lightbox */}
            <Lightbox
                key={lightboxImage?.id ?? 'no-image'}
                image={lightboxImage}
                onClose={closeLightbox}
                onPrev={prevLightbox}
                onNext={nextLightbox}
                hasPrev={lightboxIndex !== null && lightboxIndex > 0}
                hasNext={lightboxIndex !== null && lightboxIndex < images.length - 1}
            />
        </section>
    )
}

export default PoemImageGenerator
