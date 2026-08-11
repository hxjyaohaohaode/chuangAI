import { useCallback, useEffect, useState } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import './Markdown.css'
import { Icon } from './Icon'
import { cn } from '@/lib/cn'

/**
 * Markdown 渲染组件（规范第 9 章）
 *
 * 严格按规范第 9 章实现各元素排版：
 * - h1-h6 字号字重边距按表
 * - 段落 24px 段间距
 * - 无序列表 marker text-tertiary
 * - 有序列表数字 text-secondary + tabular-nums
 * - 引用块：2% accent-primary 背景 + 3px 左侧条 + 略斜体
 * - 代码块：JetBrains Mono + surface-tertiary + 8px 圆角 + 顶部栏（语言标签 + 复制按钮）
 * - 行内代码：6% alpha 背景 + 4px 圆角
 * - 表格：无外边框，表头底部 1px alpha 8%，奇偶行色差
 * - 图片：8px 圆角
 * - hr：1px alpha 6% + 上下 space-xl
 * - 链接：accent-primary + hover 下划线（40% alpha）+ 外部链接图标
 *
 * 支持流式光标（streaming prop，末尾显示脉动光标）。
 */

export interface MarkdownProps {
    /** Markdown 源文本 */
    content: string
    /** 是否处于流式输出态（末尾显示脉动光标） */
    streaming?: boolean
    className?: string
}

export function Markdown({ content, streaming = false, className }: MarkdownProps) {
    // v5.0 Task 5.5：流式光标 200ms 淡出（与 Typewriter 保持一致，避免瞬时移除造成视觉突兀）
    const [cursorVisible, setCursorVisible] = useState(streaming)
    const [cursorFading, setCursorFading] = useState(false)

    useEffect(() => {
        if (streaming) {
            setCursorVisible(true)
            setCursorFading(false)
        } else if (cursorVisible) {
            // streaming 由 true → false：触发 200ms 淡出后再卸载
            setCursorFading(true)
            const timer = window.setTimeout(() => {
                setCursorVisible(false)
                setCursorFading(false)
            }, 200)
            return () => window.clearTimeout(timer)
        }
        return undefined
    }, [streaming, cursorVisible])

    return (
        <div className={cn('pr-md', className)}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
                components={components}
            >
                {content}
            </ReactMarkdown>
            {cursorVisible && (
                <span className={cn('pr-md-cursor', cursorFading && 'is-fading')} aria-hidden />
            )}
        </div>
    )
}

/** 外部链接判断 */
function isExternalUrl(url: string): boolean {
    return /^https?:\/\//i.test(url)
}

/** a 标签渲染：外部链接追加图标 */
function Anchor({ href, children, ...rest }: ComponentPropsWithoutRef<'a'>) {
    const external = href ? isExternalUrl(href) : false
    return (
        <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined} {...rest}>
            {children}
            {external && (
                <span className="pr-md-link-external" aria-hidden>
                    <Icon name="arrow-right" size={12} />
                </span>
            )}
        </a>
    )
}

type MarkdownImageState = 'loading' | 'loaded' | 'failed'

/**
 * 仅对可重新请求的 HTTP(S) 图片添加重试标记；data/blob 资源保持原值，避免
 * 改写富文本内容本身。浏览器遇到同一失败 URL 时可能直接复用失败缓存，因而
 * HTTP(S) 重试必须显式得到一个新的资源请求。
 */
function getRetriedImageSource(src: string | undefined, retryAttempt: number): string | undefined {
    if (!src || retryAttempt === 0 || !/^https?:\/\//i.test(src)) return src
    try {
        const url = new URL(src)
        url.searchParams.set('_prMarkdownImageRetry', String(retryAttempt))
        return url.toString()
    } catch {
        const separator = src.includes('?') ? '&' : '?'
        return `${src}${separator}_prMarkdownImageRetry=${retryAttempt}`
    }
}

/**
 * img 渲染：模糊缩略图加载态 + 可恢复失败态。
 *
 * 富文本来自 AI 回复、报告及命题内容，图片 URL 可能因离线、CDN、过期签名或
 * 外部资源下线而失败。不能让失败图片永久保留“正在加载”的假象，也不能仅依赖
 * 浏览器破图图标；必须说明边界并给出不修改原 Markdown 内容的本地重试入口。
 */
function Image({
    alt,
    src,
    className,
    style,
    onLoad,
    onError,
    ...rest
}: ComponentPropsWithoutRef<'img'>) {
    const [state, setState] = useState<MarkdownImageState>(() => (src ? 'loading' : 'failed'))
    const [retryAttempt, setRetryAttempt] = useState(0)

    useEffect(() => {
        setState(src ? 'loading' : 'failed')
        setRetryAttempt(0)
    }, [src])

    const imageSource = getRetriedImageSource(src, retryAttempt)
    const failureDescription = alt
        ? `无法显示：${alt}`
        : '图片资源暂不可用，可重新加载。'

    if (state === 'failed') {
        return (
            <figure className={cn('pr-md-image-fallback', className)}>
                <span className="pr-md-image-fallback__icon" aria-hidden>
                    <Icon name="warning-circle" size={20} />
                </span>
                <figcaption className="pr-md-image-fallback__body" role="status" aria-live="polite">
                    <strong>图片加载失败</strong>
                    <span>{failureDescription}</span>
                </figcaption>
                <button
                    type="button"
                    className="pr-md-image-fallback__retry"
                    onClick={() => {
                        setState('loading')
                        setRetryAttempt((current) => current + 1)
                    }}
                    aria-label={alt ? `重新加载图片：${alt}` : '重新加载图片'}
                >
                    <Icon name="arrows-clockwise" size={14} aria-hidden />
                    <span>重新加载</span>
                </button>
            </figure>
        )
    }

    return (
        <img
            key={`${src ?? 'missing'}:${retryAttempt}`}
            src={imageSource}
            alt={alt ?? ''}
            className={className}
            loading="lazy"
            onLoad={(event) => {
                setState('loaded')
                onLoad?.(event)
            }}
            onError={(event) => {
                setState('failed')
                onError?.(event)
            }}
            style={
                state === 'loaded'
                    ? style
                    : {
                        ...style,
                        filter: 'blur(10px)',
                        transition: 'filter 200ms ease-out',
                    }
            }
            {...rest}
        />
    )
}

/** pre 渲染：包裹顶部栏（语言标签 + 复制按钮） */
function Pre({ children, ...rest }: ComponentPropsWithoutRef<'pre'> & { 'data-language'?: string }) {
    const language = rest['data-language'] ?? extractLanguage(children)
    const onCopy = useCopyCode(children)
    return (
        <div className="pr-md-pre-wrapper">
            <div className="pr-md-pre-header">
                <span>{language || 'text'}</span>
                <button className="pr-md-pre-copy" onClick={onCopy} type="button" aria-label="复制代码">
                    <Icon name="copy" size={12} />
                    <span>复制</span>
                </button>
            </div>
            <pre {...rest}>{children}</pre>
        </div>
    )
}

/** 从 children 的 code 元素中提取语言类名 */
function extractLanguage(children: ReactNode): string | undefined {
    if (!children || typeof children !== 'object') return undefined
    const child = children as { props?: { className?: string } }
    const cls = child?.props?.className ?? ''
    const m = /language-([\w-]+)/.exec(cls)
    return m?.[1]
}

/** 提取代码文本用于复制 */
function getCodeText(children: ReactNode): string {
    if (typeof children === 'string') return children
    if (Array.isArray(children)) return children.map(getCodeText).join('')
    if (children && typeof children === 'object' && 'props' in children) {
        const props = (children as { props?: { children?: ReactNode } }).props
        return props ? getCodeText(props.children) : ''
    }
    return ''
}

function useCopyCode(children: ReactNode) {
    return useCallback(() => {
        const text = getCodeText(children)
        if (text) {
            void navigator.clipboard?.writeText(text)
        }
    }, [children])
}

/** 组件映射 —— 传给 react-markdown 的 components */
const components = {
    a: Anchor,
    img: Image,
    pre: Pre,
} as const
