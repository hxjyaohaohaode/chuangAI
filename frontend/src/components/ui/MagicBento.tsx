/**
 * MagicBento —— 教学闭环入口矩阵
 *
 * 这是项目内独立实现：只使用 React 与 CSS，不创建 Canvas/WebGL 上下文，
 * 不注入全局 DOM，不注册 window/document 监听器，也不启动 RAF/计时器。
 * 所有装饰层都不接收指针事件，链接始终保留浏览器原生语义。
 */

import { useState, type CSSProperties, type MouseEvent } from 'react'
import { cn } from '@/lib/cn'
import './MagicBento.css'

const DEFAULT_PARTICLE_COUNT = 12
const DEFAULT_SPOTLIGHT_RADIUS = 300
// CSS 消费端统一使用现代 `rgb(var(--token) / alpha)` 语法，因此这里必须
// 输出空格分隔的通道；逗号格式与斜杠透明度组合会让整条颜色声明失效。
const DEFAULT_GLOW_COLOR = '152 98 39'
const MAX_DECORATIVE_STARS = 16

export interface MagicBentoCardData {
    /** 卡片上方的短标签。 */
    label: string
    /** 卡片标题。 */
    title: string
    /** 卡片功能说明。 */
    description: string
    /** 可选装饰图；加载失败时自动保留 CSS 山水兜底。 */
    imageUrl?: string
    /** 可选目标地址；有值时使用原生链接。 */
    href?: string
}

export interface MagicBentoProps {
    cards?: MagicBentoCardData[]
    /** 是否限制标题与描述的最大行数，避免异常长文案破坏网格。 */
    textAutoHide?: boolean
    /** 是否展示确定性静态星点。 */
    enableStars?: boolean
    /** 是否展示卡片内的 CSS 径向光层。 */
    enableSpotlight?: boolean
    /** 是否展示聚焦/悬停边缘光。 */
    enableBorderGlow?: boolean
    /** 关闭所有非必要过渡与位移。 */
    disableAnimations?: boolean
    /** 光层半径，单位 px；输入会被限制在安全范围。 */
    spotlightRadius?: number
    /** 每张卡片的装饰星点数量；输入会被限制为 0–16。 */
    particleCount?: number
    /** 保留原 API；映射为有界 CSS 悬停姿态，不进行鼠标追踪。 */
    enableTilt?: boolean
    /** RGB 三元组字符串；非法输入会回退为品牌暖金色。 */
    glowColor?: string
    /** 是否启用原生按压反馈，不创建涟漪节点。 */
    clickEffect?: boolean
    /** 保留原 API；映射为轻量 CSS 抬升，不进行磁吸追踪。 */
    enableMagnetism?: boolean
    className?: string
    /** 仅普通左键/键盘 Enter 走 SPA 回调；组合键与中键交还浏览器。 */
    onCardActivate?: (card: MagicBentoCardData, index: number) => void
}

const DEFAULT_CARDS: MagicBentoCardData[] = [
    {
        label: '学情洞察',
        title: '学习分析',
        description: '追踪学生学习行为，精准定位薄弱环节',
    },
    {
        label: '全景概览',
        title: '学习仪表盘',
        description: '集中展示关键学习数据与进度指标',
    },
    {
        label: '协作共学',
        title: '同侪协作',
        description: '支持学生间无缝协作与知识共享',
    },
    {
        label: '智能自动化',
        title: '流程自动化',
        description: '简化教学流程，释放教师创造力',
    },
    {
        label: '生态集成',
        title: '工具集成',
        description: '连接常用教学工具与平台',
    },
    {
        label: '安全防护',
        title: '企业级安全',
        description: '全链路数据保护与隐私合规',
    },
]

type MagicBentoStyle = CSSProperties & {
    '--magic-bento-glow': string
    '--magic-bento-radius': string
}

type DecorativeStarStyle = CSSProperties & {
    '--star-x': string
    '--star-y': string
    '--star-scale': string
    '--star-delay': string
}

function clampFinite(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
}

function normalizeGlowColor(value: string | undefined): string {
    if (!value) return DEFAULT_GLOW_COLOR

    const channels = value
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)

    if (channels.length !== 3) return DEFAULT_GLOW_COLOR

    const normalized = channels.map((channel) => Number(channel))
    if (normalized.some((channel) => !Number.isFinite(channel))) {
        return DEFAULT_GLOW_COLOR
    }

    return normalized
        .map((channel) => Math.round(Math.min(255, Math.max(0, channel))))
        .join(' ')
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
    return (
        event.button === 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.defaultPrevented
    )
}

function createStarStyle(cardIndex: number, starIndex: number): DecorativeStarStyle {
    const x = 8 + ((starIndex * 37 + cardIndex * 13) % 84)
    const y = 7 + ((starIndex * 29 + cardIndex * 19) % 70)
    const scale = 0.62 + ((starIndex * 7 + cardIndex) % 5) * 0.09

    return {
        '--star-x': `${x}%`,
        '--star-y': `${y}%`,
        '--star-scale': scale.toFixed(2),
        '--star-delay': `${(starIndex % 4) * 18}ms`,
    }
}

function CardMedia({ imageUrl }: { imageUrl?: string }) {
    const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>(
        imageUrl ? 'loading' : 'failed',
    )

    return (
        <div
            className="pr-magic-bento-card__media"
            data-image-state={status}
            aria-hidden="true"
        >
            <span className="pr-magic-bento-card__media-landscape" />
            {imageUrl && status !== 'failed' ? (
                <img
                    className="pr-magic-bento-card__image"
                    src={imageUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    onLoad={() => setStatus('loaded')}
                    onError={() => setStatus('failed')}
                />
            ) : null}
        </div>
    )
}

interface MagicBentoCardProps {
    card: MagicBentoCardData
    index: number
    starCount: number
    textAutoHide: boolean
    enableStars: boolean
    enableSpotlight: boolean
    enableBorderGlow: boolean
    enableTilt: boolean
    enableMagnetism: boolean
    clickEffect: boolean
    onCardActivate?: MagicBentoProps['onCardActivate']
}

function MagicBentoCard({
    card,
    index,
    starCount,
    textAutoHide,
    enableStars,
    enableSpotlight,
    enableBorderGlow,
    enableTilt,
    enableMagnetism,
    clickEffect,
    onCardActivate,
}: MagicBentoCardProps) {
    const href = card.href?.trim()
    const className = cn(
        'pr-magic-bento-card',
        href && 'pr-magic-bento-card--interactive',
        textAutoHide && 'pr-magic-bento-card--text-autohide',
        enableSpotlight && 'pr-magic-bento-card--spotlight',
        enableBorderGlow && 'pr-magic-bento-card--border-glow',
        enableTilt && 'pr-magic-bento-card--tilt',
        enableMagnetism && 'pr-magic-bento-card--magnetism',
    )

    const body = (
        <>
            <span className="pr-magic-bento-card__wash" aria-hidden="true" />
            {enableStars && starCount > 0 ? (
                <span className="pr-magic-bento-card__stars" aria-hidden="true">
                    {Array.from({ length: starCount }, (_, starIndex) => (
                        <span
                            className="pr-magic-bento-card__star"
                            style={createStarStyle(index, starIndex)}
                            key={starIndex}
                        />
                    ))}
                </span>
            ) : null}

            <header className="pr-magic-bento-card__header">
                <span className="pr-magic-bento-card__sequence" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                </span>
                <span className="pr-magic-bento-card__label">{card.label}</span>
                {href ? (
                    <span className="pr-magic-bento-card__go" aria-hidden="true">
                        进入 <span>↗</span>
                    </span>
                ) : null}
            </header>

            <CardMedia key={imageUrlKey(card.imageUrl)} imageUrl={card.imageUrl} />

            <div className="pr-magic-bento-card__content">
                <h3 className="pr-magic-bento-card__title">{card.title}</h3>
                <p className="pr-magic-bento-card__description">{card.description}</p>
            </div>
        </>
    )

    if (href) {
        return (
            <a
                className={className}
                href={href}
                data-card-index={index}
                data-click-effect={clickEffect ? 'on' : 'off'}
                onClick={(event) => {
                    if (!onCardActivate || !isPlainLeftClick(event)) return
                    event.preventDefault()
                    onCardActivate(card, index)
                }}
            >
                {body}
            </a>
        )
    }

    return (
        <article className={className} data-card-index={index} data-click-effect="off">
            {body}
        </article>
    )
}

function imageUrlKey(imageUrl: string | undefined): string {
    return imageUrl?.trim() || 'css-fallback'
}

export function MagicBento({
    cards = DEFAULT_CARDS,
    textAutoHide = true,
    enableStars = true,
    enableSpotlight = true,
    enableBorderGlow = true,
    disableAnimations = false,
    spotlightRadius = DEFAULT_SPOTLIGHT_RADIUS,
    particleCount = DEFAULT_PARTICLE_COUNT,
    enableTilt = false,
    glowColor = DEFAULT_GLOW_COLOR,
    clickEffect = true,
    enableMagnetism = true,
    className,
    onCardActivate,
}: MagicBentoProps) {
    const safeRadius = clampFinite(
        spotlightRadius,
        DEFAULT_SPOTLIGHT_RADIUS,
        80,
        640,
    )
    const starCount = Math.round(
        clampFinite(particleCount, DEFAULT_PARTICLE_COUNT, 0, MAX_DECORATIVE_STARS),
    )
    const style: MagicBentoStyle = {
        '--magic-bento-glow': normalizeGlowColor(glowColor),
        '--magic-bento-radius': `${safeRadius}px`,
    }

    return (
        <div
            className={cn('pr-magic-bento-grid', className)}
            role="list"
            style={style}
            data-magic-bento-renderer="css"
            data-magic-bento-card-count={cards.length}
            data-magic-bento-motion={disableAnimations ? 'off' : 'system'}
            data-magic-bento-stars={enableStars ? 'on' : 'off'}
            data-magic-bento-spotlight={enableSpotlight ? 'on' : 'off'}
        >
            {cards.map((card, index) => (
                <div
                    className="pr-magic-bento-cell"
                    role="listitem"
                    key={`${card.href ?? card.title}-${index}`}
                >
                    <MagicBentoCard
                        card={card}
                        index={index}
                        starCount={starCount}
                        textAutoHide={textAutoHide}
                        enableStars={enableStars}
                        enableSpotlight={enableSpotlight}
                        enableBorderGlow={enableBorderGlow}
                        enableTilt={enableTilt}
                        enableMagnetism={enableMagnetism}
                        clickEffect={clickEffect}
                        onCardActivate={onCardActivate}
                    />
                </div>
            ))}
        </div>
    )
}

export default MagicBento
