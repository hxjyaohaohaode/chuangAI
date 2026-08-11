/**
 * ShowcaseCards 三卡片展示区（SubTask 23.1-23.3 集成容器）
 *
 * 设计目标：
 * - 将 CardSwap / StackGallery / PixelTransition 三张卡片组织为响应式网格
 * - 桌面端 3 列，平板端 2 列（第三张占满），移动端单列
 * - 每张卡片采用玻璃态面板 + 250ms spring-soft 入场动画
 * - staggered 入场：相邻卡片 50ms 延迟
 * - 完整加载/错误/空态处理（规范第 6、14 章）
 *
 * 数据来源：
 * - useCardSwapQuery / useStackGalleryQuery / useProgressStateQuery
 * - 数据源由 hook 内部决定（live / store / demo）
 *
 * 设计规范合规：
 * - 无硬边框（玻璃态 + box-shadow + 圆角）
 * - 透明度驱动的暖调色板
 * - prefers-reduced-motion 降级
 * - 完整 hover/focus 三态
 */

import { memo, useMemo } from 'react'
import { CardSwap, Card } from '@/components/ui/CardSwap'
import { StackGallery, type StackGalleryCard } from '@/components/ui/StackGallery'
import { PixelTransition } from '@/components/ui/PixelTransition'
import { Icon } from '@/components/ui'
import { useGradingStore } from '@/stores/grading'
import {
    useCardSwapQuery,
    useStackGalleryQuery,
    useProgressStateQuery,
    type CardSwapItem,
    type ProgressStateItem,
} from './useGradingShowcase'
import { GradingMediaImage } from './GradingMediaImage'
import './ShowcaseCards.css'

// ============================================================
// 卡片内单个内容渲染（CardSwap 单张卡片）
// ============================================================

const TONE_LABEL_COLOR: Record<CardSwapItem['tone'], string> = {
    primary: 'rgb(var(--c-accent-primary))',
    success: 'rgb(var(--c-accent-success))',
    warning: 'rgb(var(--c-accent-warning))',
    info: 'rgb(var(--c-accent-info))',
}

const TONE_BG: Record<CardSwapItem['tone'], string> = {
    primary: 'var(--accent-primary-10)',
    success: 'var(--accent-success-10)',
    warning: 'var(--accent-warning-10)',
    info: 'var(--accent-info-10)',
}

/**
 * Produces a compact, deterministic revision token for locally-derived showcase
 * queries.  The query cache previously keyed this content only by batchId, so
 * upload → recognise → grade transitions within one batch could render a
 * stale empty state for up to the query staleTime.  Do not put student answers
 * or teacher feedback directly into a query key: React Query tools can expose
 * keys during diagnosis.  Two independent non-secret hashes are sufficient
 * here because this token is solely an in-memory invalidation signal, not an
 * integrity or security primitive.
 */
function createShowcaseRevision(snapshot: unknown): string {
    const serialized = JSON.stringify(snapshot)
    let fnv = 0x811c9dc5
    let djb = 5381

    for (let index = 0; index < serialized.length; index += 1) {
        const code = serialized.charCodeAt(index)
        fnv = Math.imul(fnv ^ code, 0x01000193)
        djb = Math.imul(djb, 33) ^ code
    }

    return `${serialized.length}:${(fnv >>> 0).toString(36)}:${(djb >>> 0).toString(36)}`
}

function CardSwapContent({ item }: { item: CardSwapItem }) {
    return (
        <div className="pr-grading-showcase-card-content" style={{ ['--card-tone' as string]: TONE_LABEL_COLOR[item.tone] }}>
            <div className="pr-grading-showcase-card-tag" style={{ backgroundColor: TONE_BG[item.tone], color: TONE_LABEL_COLOR[item.tone] }}>
                {item.label}
            </div>
            {item.imageUrl ? (
                <div className="pr-grading-showcase-card-image">
                    <GradingMediaImage src={item.imageUrl} alt={item.title} />
                </div>
            ) : (
                <div className="pr-grading-showcase-card-glyph">
                    <Icon name="quotes" size={28} />
                </div>
            )}
            <div className="pr-grading-showcase-card-title">{item.title}</div>
            <div className="pr-grading-showcase-card-subtitle">{item.subtitle}</div>
            {item.text && (
                <div className="pr-grading-showcase-card-text">{item.text}</div>
            )}
        </div>
    )
}

// ============================================================
// 卡片 1：CardSwap 轮播 —— 批改前后对比
// ============================================================

const CardSwapCard = memo(function CardSwapCard() {
    const batchId = useGradingStore((s) => s.batchId)
    const files = useGradingStore((s) => s.files)
    const recognized = useGradingStore((s) => s.recognized)
    const results = useGradingStore((s) => s.results)
    const revision = useMemo(() => createShowcaseRevision({
        files: files.map((file) => [file.id, file.url, file.fileName ?? '']),
        recognized: recognized.map((item) => [item.fileId, item.studentAnswer, item.confidence, item.needsManualMatch]),
        results: results.map((item) => [item.fileId, item.correct, item.partialScore, item.confidence, item.reviewed, item.cognitiveAttribution, item.teacherFeedback]),
    }), [files, recognized, results])
    const { data, isLoading, isError, error } = useCardSwapQuery(batchId, revision)

    const items = data?.items ?? []

    return (
        <article
            className="pr-grading-showcase-card pr-grading-showcase-card--swap"
            aria-labelledby="pr-grading-showcase-swap-title"
            style={{ ['--showcase-stagger' as string]: '0ms' }}
        >
            <header className="pr-grading-showcase-card-header">
                <h3 id="pr-grading-showcase-swap-title" className="pr-grading-showcase-card-heading">
                    <Icon name="arrows-clockwise" size={16} />
                    <span>批改前后对比</span>
                </h3>
                <span className="pr-grading-showcase-card-meta">
                    {data?.source === 'live' ? '实时数据' : data?.source === 'store' ? '当前批次' : '尚无数据'}
                </span>
            </header>

            <div className="pr-grading-showcase-card-body">
                {isLoading ? (
                    <ShowcaseSkeleton variant="tall" />
                ) : isError ? (
                    <ShowcaseError message={error?.message ?? '加载失败'} />
                ) : items.length === 0 ? (
                    <ShowcaseEmpty message="暂无批改对比数据" />
                ) : (
                    <div className="pr-grading-showcase-card-swap-wrap">
                        <CardSwap
                            width="min(360px, 100%)"
                            height={280}
                            delay={6000}
                            pauseOnHover
                            skewAmount={5}
                            cardDistance={48}
                            verticalDistance={56}
                            easing="elastic"
                        >
                            {items.map((item) => (
                                <Card key={item.id}>
                                    <CardSwapContent item={item} />
                                </Card>
                            ))}
                        </CardSwap>
                    </div>
                )}
            </div>
        </article>
    )
})

// ============================================================
// 卡片 2：StackGallery 叠加 —— 学生答题图片堆
// ============================================================

const StackGalleryCard = memo(function StackGalleryCardView() {
    const batchId = useGradingStore((s) => s.batchId)
    const files = useGradingStore((s) => s.files)
    const revision = useMemo(
        () => createShowcaseRevision(files.map((file) => [file.id, file.url, file.fileName ?? ''])),
        [files],
    )
    const { data, isLoading, isError, error } = useStackGalleryQuery(batchId, revision)

    const cards: StackGalleryCard[] = useMemo(
        () =>
            (data?.items ?? []).map((item) => ({
                id: item.id,
                caption: item.caption,
                content: item.imageUrl ? (
                    <GradingMediaImage
                        src={item.imageUrl}
                        alt={item.caption}
                        fallbackHint="资源可能已过期，可重新上传或在详情中重试"
                    />
                ) : (
                    <div className="pr-grading-showcase-stack-placeholder">
                        <Icon name="file-image" size={28} />
                        <span>{item.caption}</span>
                    </div>
                ),
            })),
        [data?.items],
    )

    return (
        <article
            className="pr-grading-showcase-card pr-grading-showcase-card--stack"
            aria-labelledby="pr-grading-showcase-stack-title"
            style={{ ['--showcase-stagger' as string]: '50ms' }}
        >
            <header className="pr-grading-showcase-card-header">
                <h3 id="pr-grading-showcase-stack-title" className="pr-grading-showcase-card-heading">
                    <Icon name="chart-bar" size={16} />
                    <span>答题图片堆</span>
                </h3>
                <span className="pr-grading-showcase-card-meta">
                    {data ? `${cards.length} 张` : ''}
                </span>
            </header>

            <div className="pr-grading-showcase-card-body">
                {isLoading ? (
                    <ShowcaseSkeleton variant="tall" />
                ) : isError ? (
                    <ShowcaseError message={error?.message ?? '加载失败'} />
                ) : cards.length === 0 ? (
                    <ShowcaseEmpty message="暂无答题图片" />
                ) : (
                    <div className="pr-grading-showcase-card-stack-wrap">
                        <StackGallery
                            cards={cards}
                            randomRotation
                            sensitivity={120}
                            sendToBackOnClick={false}
                            autoplay
                            autoplayDelay={4000}
                            pauseOnHover
                            maxVisible={5}
                            ariaLabel="学生答题图片堆，可点击查看大图"
                        />
                    </div>
                )}
            </div>
        </article>
    )
})

// ============================================================
// 卡片 3：PixelTransition 蒙版 —— 批改进度状态
// ============================================================

const TONE_PROGRESS_BG: Record<ProgressStateItem['tone'], string> = {
    primary: 'rgb(var(--c-accent-primary))',
    success: 'rgb(var(--c-accent-success))',
    warning: 'rgb(var(--c-accent-warning))',
    info: 'rgb(var(--c-accent-info))',
}

const ProgressStateCard = memo(function ProgressStateCardView() {
    const batchId = useGradingStore((s) => s.batchId)
    const classId = useGradingStore((s) => s.classId)
    const files = useGradingStore((s) => s.files)
    const recognized = useGradingStore((s) => s.recognized)
    const results = useGradingStore((s) => s.results)
    const summary = useGradingStore((s) => s.summary)
    const stage = useGradingStore((s) => s.stage)
    const revision = useMemo(() => createShowcaseRevision({
        fileIds: files.map((file) => file.id),
        recognizedIds: recognized.map((item) => item.fileId),
        results: results.map((item) => [item.fileId, item.reviewed]),
        summary,
        stage,
    }), [files, recognized, results, stage, summary])
    const { data, isLoading, isError, error } = useProgressStateQuery(batchId, classId || undefined, revision)

    const items = data?.items ?? []

    // 默认展示第一状态（pending），hover 后切换为第二状态（grading）
    const firstItem = items[0]
    const secondItem = items[1]

    return (
        <article
            className="pr-grading-showcase-card pr-grading-showcase-card--progress"
            aria-labelledby="pr-grading-showcase-progress-title"
            style={{ ['--showcase-stagger' as string]: '100ms' }}
        >
            <header className="pr-grading-showcase-card-header">
                <h3 id="pr-grading-showcase-progress-title" className="pr-grading-showcase-card-heading">
                    <Icon name="gauge" size={16} />
                    <span>批改进度</span>
                </h3>
                <span className="pr-grading-showcase-card-meta">
                    {data?.source === 'live' ? '聚合数据' : data?.source === 'store' ? '当前批次' : '尚无数据'}
                </span>
            </header>

            <div className="pr-grading-showcase-card-body">
                {isLoading ? (
                    <ShowcaseSkeleton variant="tall" />
                ) : isError ? (
                    <ShowcaseError message={error?.message ?? '加载失败'} />
                ) : items.length === 0 ? (
                    <ShowcaseEmpty message="暂无进度数据" />
                ) : firstItem && secondItem ? (
                    <div className="pr-grading-showcase-card-pixel-wrap">
                        <PixelTransition
                            firstContent={<ProgressStateView item={firstItem} />}
                            secondContent={<ProgressStateView item={secondItem} />}
                            gridSize={8}
                            pixelColor={TONE_PROGRESS_BG[firstItem.tone]}
                            animationStepDuration={0.6}
                            aspectRatio="100%"
                            once={false}
                            ariaLabel="切换批改进度概览"
                        />
                        {/* 其他状态条形指示器 */}
                        {items.length > 2 && (
                            <div className="pr-grading-showcase-progress-list">
                                {items.map((item) => (
                                    <div
                                        key={item.id}
                                        className="pr-grading-showcase-progress-item"
                                        style={{ ['--progress-tone' as string]: TONE_PROGRESS_BG[item.tone] }}
                                    >
                                        <span className="pr-grading-showcase-progress-label">{item.label}</span>
                                        <div className="pr-grading-showcase-progress-track">
                                            {/* v7：width → transform: scaleX（GPU 加速）通过 --progress-scale 变量驱动 */}
                                            <div
                                                className="pr-grading-showcase-progress-fill"
                                                style={{ ['--progress-scale' as string]: item.percentage / 100 }}
                                            />
                                        </div>
                                        <span className="pr-grading-showcase-progress-count">{item.count}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ) : null}
            </div>
        </article>
    )
})

function ProgressStateView({ item }: { item: ProgressStateItem }) {
    // v7：SVG 渐变 id 需基于 tone 唯一，避免多个 ProgressStateView 实例 id 冲突
    const gradientId = `pr-grading-progress-grad-${item.id}`
    const toneColor = TONE_PROGRESS_BG[item.tone]
    // 周长 = 2π × r = 2π × 20 ≈ 125.664
    const circumference = 125.664
    const dashLen = (item.percentage / 100) * circumference

    return (
        <div
            className="pr-grading-showcase-progress-view"
            style={{ ['--progress-tone' as string]: toneColor }}
        >
            <div className="pr-grading-showcase-progress-ring">
                <svg viewBox="0 0 48 48" className="pr-grading-showcase-progress-ring-svg" aria-hidden="true">
                    {/* v7：渐变定义 —— 从 tone 色到亮色，增加立体感 */}
                    <defs>
                        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stopColor={toneColor} stopOpacity="1" />
                            <stop offset="100%" stopColor={toneColor} stopOpacity="0.65" />
                        </linearGradient>
                    </defs>
                    {/* 背景轨道 */}
                    <circle cx="24" cy="24" r="20" className="pr-grading-showcase-progress-ring-track" />
                    {/* v7：渐变 stroke + drop-shadow 光晕，stroke-linecap round 让端点圆润 */}
                    <circle
                        cx="24"
                        cy="24"
                        r="20"
                        className="pr-grading-showcase-progress-ring-fill"
                        style={{
                            strokeDasharray: `${dashLen} ${circumference}`,
                            stroke: `url(#${gradientId})`,
                        }}
                    />
                </svg>
                <div className="pr-grading-showcase-progress-ring-label">
                    <span className="pr-grading-showcase-progress-ring-value">{item.percentage}%</span>
                </div>
            </div>
            <div className="pr-grading-showcase-progress-info">
                <Icon name={item.icon as 'hourglass' | 'spinner-gap' | 'check-circle' | 'check-fat'} size={18} />
                <div className="pr-grading-showcase-progress-info-text">
                    <span className="pr-grading-showcase-progress-info-label">{item.label}</span>
                    <span className="pr-grading-showcase-progress-info-count">{item.count} 份</span>
                </div>
            </div>
        </div>
    )
}

// ============================================================
// 通用加载/错误/空态
// ============================================================

function ShowcaseSkeleton({ variant = 'tall' }: { variant?: 'tall' | 'short' }) {
    return (
        <div className={`pr-grading-showcase-skeleton is-${variant}`} role="status" aria-live="polite">
            <div className="pr-grading-showcase-skeleton-bar" style={{ width: '60%' }} />
            <div className="pr-grading-showcase-skeleton-bar" style={{ width: '40%' }} />
            <div className="pr-grading-showcase-skeleton-block" />
            <span className="pr-grading-showcase-skeleton-text">加载中...</span>
        </div>
    )
}

function ShowcaseError({ message }: { message: string }) {
    return (
        <div className="pr-grading-showcase-error" role="alert">
            <Icon name="warning" size={20} />
            <span>{message}</span>
        </div>
    )
}

function ShowcaseEmpty({ message }: { message: string }) {
    return (
        <div className="pr-grading-showcase-empty">
            <Icon name="eye" size={20} />
            <span>{message}</span>
        </div>
    )
}

// ============================================================
// 主组件：三卡片网格
// ============================================================

export const ShowcaseCards = memo(function ShowcaseCards() {
    return (
        <section className="pr-grading-showcase" aria-labelledby="pr-grading-showcase-title">
            <div className="pr-grading-showcase-header">
                <h2 id="pr-grading-showcase-title" className="pr-grading-showcase-title">
                    <Icon name="lightning" size={18} />
                    <span>批改可视化</span>
                </h2>
                <p className="pr-grading-showcase-subtitle">
                    前后对比 · 答题图片 · 进度状态 —— 三视角同步呈现
                </p>
            </div>

            <div className="pr-grading-showcase-grid">
                <CardSwapCard />
                <StackGalleryCard />
                <ProgressStateCard />
            </div>
        </section>
    )
})
