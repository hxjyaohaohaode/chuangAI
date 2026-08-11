/**
 * PoemList 古诗选择列表（Task 20 + v5.1 体裁色融合 + Task 28.5 TanStack Query 重构）
 *
 * 展示可选古诗列表，用户选择后触发文化背景包与图片库的并行拉取。
 * - 紧凑列表布局，左侧随文档流定位
 * - 选中态：左侧 accent 竖线 + 背景色差
 * - 骨架屏加载态、错误态（含重试）、空数据态
 * - 无 emoji：所有图形语义由 Icon 承载
 *
 * v5.1 设计融入（千问 --Color10/20/100 三阶 alpha 色阶启发）：
 * - 每首诗根据标题/内容/作者推断体裁（6 种：山水/田园/边塞/咏物/送别/思乡）
 * - 体裁标签使用对应 genre color 的 10% alpha 背景 + 100% 实色文字
 * - 选中态使用 20% alpha 背景 + 体裁色左侧竖线（替代通用 accent-primary）
 * - 体裁色形成视觉分类锚点，便于教师在长列表中快速识别诗类
 *
 * Task 28.5 重构要点：
 * - 数据获取由 Zustand loadPoems 迁移至 TanStack Query（staleTime 5min）
 * - 添加两个 Combobox 筛选器（朝代 + 体裁，mode="single"）
 * - 显示标题/作者/朝代/分类（体裁）
 * - 选择诗词后通过 store.selectPoem 触发整个页面同步刷新
 * - 完整三态：isLoading 骨架屏 / isError 错误+重试 / 空数据 空态 CTA
 * - query data 通过 setPoemsFromQuery 同步到 store，保留 CultureContextPage 的 winter poem 检测
 *
 * 设计要点：
 * - 无边框卡片，用透明度差异区分
 * - 完整三态：hover 背景变色 / active 缩放 / focus-visible 光晕
 * - 选中态左侧 3px 体裁色竖线（无 hard border）
 */

import { memo, useMemo, useCallback, useDeferredValue, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Combobox, Icon, type ComboboxOption } from '@/components/ui'
import { useCultureStore } from '@/stores/culture'
import { api } from '@/lib/api'
import type { CulturePoem, RecitationPoem } from '@/lib/types'
import { cn } from '@/lib/cn'
import {
    GENRE_BADGE_CLASS,
    resolvePoemTheme,
    POEM_GENRE_LABEL,
    type PoemGenre,
} from '@/lib/poem-genre'

interface PoemListProps {
    className?: string
}

/**
 * 题材色系筛选项（6 个固定色系，顺序固定以便 Tab 顺序一致）
 *
 * 这是**粗粒度**筛选：教材题材有 60 余个受控词，全部铺进下拉框反而难用，
 * 因此按 6 色系聚合。卡片徽章上展示的仍是题材原文，不受此聚合影响。
 */
const GENRE_OPTIONS: readonly ComboboxOption[] = (
    Object.keys(POEM_GENRE_LABEL) as PoemGenre[]
).map((g) => ({
    value: g,
    label: POEM_GENRE_LABEL[g],
}))

/** "全部" 选项的统一 value */
const ALL_VALUE = '__all__'

/** 全部选项（用于朝代/体裁 Combobox 的"不筛选"项） */
const ALL_OPTION: ComboboxOption = { value: ALL_VALUE, label: '全部' }

/**
 * 将 RecitationPoem[] 转换为 CulturePoem[]（仅保留文化语境所需字段）
 * 防御性处理：res.poems 可能为 undefined/null（后端契约漂移），降级为空数组
 */
function mapToCulturePoems(res: { poems?: RecitationPoem[] } | null | undefined): CulturePoem[] {
    const rawPoems = Array.isArray(res?.poems) ? res.poems : []
    return rawPoems.map((p) => ({
        id: p.id,
        title: p.title,
        poet: p.poet,
        dynasty: p.dynasty,
        content: p.content,
        // 透传教材题材/修辞：体裁徽章与筛选依赖它，缺了就会退回关键字猜测
        theme: p.theme,
        rhetoric: p.rhetoric,
        gradeLevel: p.gradeLevel,
    }))
}

export const PoemList = memo(function PoemList({ className }: PoemListProps) {
    // ── store：仅消费选中态与 setPoemsFromQuery 同步入口 ──
    const selectedPoemId = useCultureStore((s) => s.selectedPoemId)
    const selectPoem = useCultureStore((s) => s.selectPoem)
    const setPoemsFromQuery = useCultureStore((s) => s.setPoemsFromQuery)

    // ── TanStack Query：5min staleTime，复用全局 QueryClient ──
    const { data, isLoading, isError, refetch } = useQuery({
        queryKey: ['culture', 'poems'],
        queryFn: () => api.recitation.listPoems().then(mapToCulturePoems),
        staleTime: 5 * 60 * 1000,
    })

    // ── 同步 query data 到 store（保留 winter poem 检测能力）──
    // data 为 undefined 时不写入（避免清空已加载的数据）
    useEffect(() => {
        if (data) {
            setPoemsFromQuery(data)
        }
    }, [data, setPoemsFromQuery])

    // ── 筛选状态：文本搜索 + 朝代 + 体裁 ──
    const [query, setQuery] = useState('')
    const [dynastyFilter, setDynastyFilter] = useState<string>(ALL_VALUE)
    const [genreFilter, setGenreFilter] = useState<string>(ALL_VALUE)
    const deferredQuery = useDeferredValue(query.trim().toLowerCase())

    // ── 派生朝代选项列表（基于 query data）──
    const dynastyOptions = useMemo<ComboboxOption[]>(() => {
        if (!data) return [ALL_OPTION]
        const dynasties = Array.from(new Set(data.map((p) => p.dynasty))).sort()
        return [ALL_OPTION, ...dynasties.map((d) => ({ value: d, label: d }))]
    }, [data])

    // ── 三层筛选：文本 → 朝代 → 体裁 ──
    const visiblePoems = useMemo(() => {
        if (!data) return []
        return data.filter((poem) => {
            // 朝代筛选
            if (dynastyFilter !== ALL_VALUE && poem.dynasty !== dynastyFilter) return false
            // 体裁筛选：以教材题材标签映射出的色系为准（无题材数据时按标题线索兜底）
            if (genreFilter !== ALL_VALUE) {
                const { genre } = resolvePoemTheme(poem)
                if (genre !== genreFilter) return false
            }
            // 文本筛选
            if (deferredQuery) {
                const haystack = `${poem.title} ${poem.poet} ${poem.dynasty} ${poem.content}`.toLowerCase()
                if (!haystack.includes(deferredQuery)) return false
            }
            return true
        })
    }, [data, dynastyFilter, genreFilter, deferredQuery])

    /** 错误态 CTA：重试 */
    const handleRetry = useCallback(() => {
        void refetch()
    }, [refetch])

    /** 筛选空态 CTA：清除所有筛选 */
    const handleClearFilters = useCallback(() => {
        setQuery('')
        setDynastyFilter(ALL_VALUE)
        setGenreFilter(ALL_VALUE)
    }, [])

    const totalCount = data?.length ?? 0
    const hasActiveFilter =
        deferredQuery !== '' || dynastyFilter !== ALL_VALUE || genreFilter !== ALL_VALUE

    return (
        <div className={cn('pr-culture-poem-list', className)}>
            <div className="pr-culture-poem-list-header">
                <span className="pr-culture-poem-list-title">古诗列表</span>
                <span className="pr-culture-poem-list-count">
                    {hasActiveFilter
                        ? `${visiblePoems.length} / ${totalCount}`
                        : totalCount}{' '}
                    首
                </span>
            </div>

            {/* 筛选器组：仅在数据已加载且非空时显示 */}
            {totalCount > 0 && (
                <div className="pr-culture-poem-filters">
                    <label className="pr-culture-poem-search">
                        <Icon name="magnifying-glass" size={16} />
                        <span className="sr-only">搜索古诗</span>
                        <input
                            type="search"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="搜索诗题、作者或诗句"
                            aria-label="搜索古诗"
                        />
                    </label>
                    <div className="pr-culture-poem-filter-row">
                        <Combobox
                            options={dynastyOptions}
                            value={dynastyFilter}
                            onChange={(v) => setDynastyFilter(v as string)}
                            mode="single"
                            placeholder="朝代"
                            ariaLabel="按朝代筛选"
                            searchable
                        />
                        <Combobox
                            options={[ALL_OPTION, ...GENRE_OPTIONS]}
                            value={genreFilter}
                            onChange={(v) => setGenreFilter(v as string)}
                            mode="single"
                            placeholder="体裁"
                            ariaLabel="按体裁筛选"
                            searchable
                        />
                    </div>
                </div>
            )}

            {/* ── 三态渲染 ── */}
            {isLoading ? (
                <div className="pr-culture-poem-list-items">
                    {[0, 1, 2, 3, 4].map((i) => (
                        <div key={i} className="pr-culture-poem-skeleton">
                            <div className="pr-culture-poem-skeleton-line" />
                            <div className="pr-culture-poem-skeleton-line" />
                        </div>
                    ))}
                </div>
            ) : isError ? (
                <div className="pr-culture-empty" role="alert">
                    <div className="pr-culture-empty-icon">
                        <Icon name="warning-circle" size={28} />
                    </div>
                    <p className="pr-culture-empty-title">古诗库加载失败</p>
                    <p className="pr-culture-empty-desc">
                        暂时无法连接真实诗库；未显示内置诗篇，避免把演示内容误当作当前教材。恢复服务后可重新加载。
                    </p>
                    <button
                        type="button"
                        className="pr-culture-empty-cta"
                        onClick={handleRetry}
                    >
                        重试
                    </button>
                </div>
            ) : totalCount === 0 ? (
                <div className="pr-culture-empty">
                    <div className="pr-culture-empty-icon">
                        <Icon name="book-open" size={28} />
                    </div>
                    <p className="pr-culture-empty-title">古诗库暂无数据</p>
                    <p className="pr-culture-empty-desc">
                        系统正在同步古诗数据，若长时间无响应可尝试重新加载。
                    </p>
                    <button
                        type="button"
                        className="pr-culture-empty-cta"
                        onClick={handleRetry}
                    >
                        重新加载
                    </button>
                </div>
            ) : visiblePoems.length === 0 ? (
                <div className="pr-culture-poem-search-empty">
                    <Icon name="magnifying-glass" size={20} />
                    <span>未找到匹配古诗</span>
                    <button type="button" onClick={handleClearFilters}>
                        清除筛选
                    </button>
                </div>
            ) : (
                <div className="pr-culture-poem-list-items">
                    {visiblePoems.map((poem) => (
                        <PoemCard
                            key={poem.id}
                            poem={poem}
                            isSelected={poem.id === selectedPoemId}
                            onSelect={selectPoem}
                        />
                    ))}
                </div>
            )}
        </div>
    )
})

interface PoemCardProps {
    poem: CulturePoem
    isSelected: boolean
    onSelect: (poemId: string) => void
}

const PoemCard = memo(function PoemCard({ poem, isSelected, onSelect }: PoemCardProps) {
    // 题材解析：徽章文案取教材校订的题材标签原文，配色取其映射到的 6 色系之一。
    // 仅当该诗没有题材数据时才退回标题启发式（此时 authoritative 为 false）。
    const { genre, label: genreLabel, authoritative } = useMemo(
        () => resolvePoemTheme(poem),
        [poem],
    )
    const genreClass = GENRE_BADGE_CLASS[genre as PoemGenre]

    return (
        <button
            type="button"
            className={cn('pr-culture-poem-card', isSelected && 'is-selected')}
            onClick={() => onSelect(poem.id)}
            aria-pressed={isSelected}
            aria-label={`${poem.title} ${poem.dynasty} ${poem.poet}，题材${genreLabel}`}
            data-genre={genre}
        >
            <div className="pr-culture-poem-card-head">
                <div className="pr-culture-poem-card-title">{poem.title}</div>
                {/* 题材标签：文案取教材校订原文，10% alpha 背景 + 100% 实色文字。
                    无题材数据时（authoritative=false）标注为「推断」，
                    不让推测结果冒充教材结论。 */}
                <span
                    className={cn('pr-culture-poem-card-genre', genreClass.badge)}
                    title={
                        authoritative
                            ? `题材：${genreLabel}（教材标注）`
                            : `题材：${genreLabel}（暂无教材标注，按诗题推断）`
                    }
                    data-inferred={authoritative ? undefined : 'true'}
                >
                    {genreLabel}
                </span>
            </div>
            <div className="pr-culture-poem-card-meta">
                {poem.dynasty} · {poem.poet}
            </div>
            <div className="pr-culture-poem-card-content">{poem.content}</div>
            {/* v5.1：选中态体裁色竖线（CSS 通过 button[data-genre] 属性匹配） */}
            <span className="pr-culture-poem-card-stripe" aria-hidden />
        </button>
    )
})
