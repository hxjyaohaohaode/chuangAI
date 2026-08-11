import { memo, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import './PoemImage.css'
import { cn } from '@/lib/cn'
import { getPreferredPoeticImageUrl } from '@/lib/poem-images'
import { Icon } from './Icon'

/**
 * AI 图片展示组件（SubTask 5.2.2 / 5.4.1）
 *
 * 统一展示古诗配图 / 文化场景图，并按真实来源选择性标注 AI 水印：
 * - 图片右上角叠加"AI 生成"徽标（accent-primary 20% alpha 底 + sparkle 图标）
 * - 旧版 SVG URL 自动升级为已审计的无水印 WebP
 * - 骨架屏加载态（规范 11.2 图片渐进渲染）
 * - hover 微升 + 透明微边框（规范 14.3 卡片交互）
 * - 圆角 8px，严禁纯黑纯白
 *
 * 用法：
 *   <PoemImage src="/images/generated/starmap/tongbian-003.webp" alt="静夜思配图" />
 *   <PoemImage src="/images/generated/starmap/tongbian-003.webp" alt="静夜思" caption="AI 生成" />
 *   <PoemImage src="/images/generated/starmap/tongbian-043-v2.webp" alt="古琴演奏" size="lg" />
 */
export interface PoemImageProps {
    /** 图片 URL（public 目录下的相对路径，如 /images/generated/starmap/tongbian-003.webp） */
    src: string
    /** alt 文本 */
    alt: string
    /** 自定义类名 */
    className?: string
    /** 自定义内联样式 */
    style?: CSSProperties
    /** 尺寸模式 */
    size?: 'sm' | 'md' | 'lg' | 'full'
    /** 加载失败时的回退 SVG（可选） */
    fallback?: React.ReactNode
    /** 是否显示"AI 生成"水印（默认 false，必须由图片来源元数据显式开启） */
    showAiBadge?: boolean
    /** 自定义水印文案（默认"AI 生成"） */
    aiLabel?: string
    /** 是否显示标题/说明（图片下方） */
    caption?: string
    /** 图片比例 */
    ratio?: 'auto' | '4/3' | '16/9' | '1/1' | '3/4'
    /** 懒加载（默认 true） */
    lazy?: boolean
    /** 点击回调 */
    onClick?: () => void
}

/** 尺寸 -> 最大宽度映射 */
const SIZE_MAX_WIDTH: Record<NonNullable<PoemImageProps['size']>, string> = {
    sm: '160px',
    md: '240px',
    lg: '360px',
    full: '100%',
}

/** 比例 -> padding-top 映射（用于 aspect-ratio 容器） */
const RATIO_PADDING: Record<NonNullable<PoemImageProps['ratio']>, string> = {
    auto: 'auto',
    '4/3': '75%',
    '16/9': '56.25%',
    '1/1': '100%',
    '3/4': '133.33%',
}

export const PoemImage = memo(function PoemImage({
    src,
    alt,
    className,
    style,
    size = 'md',
    fallback,
    showAiBadge = false,
    aiLabel = 'AI 生成',
    caption,
    ratio = '4/3',
    lazy = true,
    onClick,
}: PoemImageProps) {
    const [loaded, setLoaded] = useState(false)
    const [errored, setErrored] = useState(false)

    const isInteractive = !!onClick
    const maxWidth = SIZE_MAX_WIDTH[size]
    const ratioPadding = RATIO_PADDING[ratio]
    const preferredSrc = getPreferredPoeticImageUrl(src)

    useEffect(() => {
        setLoaded(false)
        setErrored(false)
    }, [preferredSrc])

    return (
        <figure
            className={cn('pr-poem-image', isInteractive && 'is-interactive', className)}
            style={{ ...style, maxWidth }}
            onClick={onClick}
            role={isInteractive ? 'button' : undefined}
            tabIndex={isInteractive ? 0 : undefined}
            onKeyDown={(e) => {
                if (isInteractive && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    onClick()
                }
            }}
        >
            <div
                className="pr-poem-image__frame"
                style={{ paddingTop: ratio === 'auto' ? undefined : ratioPadding }}
            >
                {/* 骨架屏 —— 加载中 */}
                {!loaded && !errored && (
                    <div className="pr-poem-image__skeleton" aria-hidden="true" />
                )}

                {/* 图片或回退插画 */}
                {errored && fallback ? (
                    <div className="pr-poem-image__fallback">{fallback}</div>
                ) : errored ? (
                    <DefaultImagePlaceholder alt={alt} />
                ) : (
                    !errored && (
                        <img
                            src={preferredSrc}
                            alt={alt}
                            className={cn('pr-poem-image__img', loaded && 'is-loaded')}
                            onLoad={() => setLoaded(true)}
                            onError={() => setErrored(true)}
                            loading={lazy ? 'lazy' : 'eager'}
                        />
                    )
                )}

                {/* AI 生成水印 —— 右上角徽标 */}
                {showAiBadge && !errored && (
                    <span className="pr-poem-image__ai-badge" aria-label={`此图片由${aiLabel}`}>
                        <Icon name="sparkle" size={10} weight="bold" />
                        <span className="pr-poem-image__ai-badge-text">{aiLabel}</span>
                    </span>
                )}
            </div>

            {/* 标题/说明 —— 图片下方 */}
            {caption && (
                <figcaption className="pr-poem-image__caption">{caption}</figcaption>
            )}
        </figure>
    )
})

/**
 * 图片不可用时采用语义化空态，不再伪造低质量插画。
 */
interface DefaultImagePlaceholderProps {
    alt: string
}

function DefaultImagePlaceholder({ alt }: DefaultImagePlaceholderProps) {
    return (
        <div
            className="pr-poem-image__placeholder"
            role="img"
            aria-label={alt}
        >
            <Icon name="image" size={22} />
            <span>图片暂不可用</span>
        </div>
    )
}

