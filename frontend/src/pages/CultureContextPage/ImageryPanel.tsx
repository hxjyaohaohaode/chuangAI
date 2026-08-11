/**
 * ImageryPanel 意象文化解读（Task 20）
 *
 * 展示从诗文中提取的意象词，点击后展示深度文化解读：
 * - 意象标签：从诗文提取常见意象（COMMON_IMAGERIES），pill 形式展示
 * - 基础含义：来自 seed-data 的文化内涵（引用块样式，3px accent 左侧条）
 * - 深度解读：brush.creative 生成的 Markdown 解读
 * - 文化维度：思乡、团圆、高洁等文化符号标签
 * - 关联诗列表：同一意象出现的其他诗作
 *
 * 设计要点：
 * - 自动选中首个意象（poem 变更时触发）
 * - 标签完整三态：hover accent 背景 / active scale(0.95) / focus-visible 光晕
 * - 引用块左侧 3px accent 条（规范 9.2 引用块样式）
 * - AI 生成标注
 * - 无 emoji，所有图形语义由 Icon 承载
 */

import { memo, useEffect, useMemo } from 'react'
import { Icon } from '@/components/ui'
import { Markdown } from '@/components/ui/Markdown'
import { useCultureStore, extractImageriesFromContent } from '@/stores/culture'
import { cn } from '@/lib/cn'

interface ImageryPanelProps {
    className?: string
}

export const ImageryPanel = memo(function ImageryPanel({ className }: ImageryPanelProps) {
    const poems = useCultureStore((s) => s.poems)
    const selectedPoemId = useCultureStore((s) => s.selectedPoemId)
    const imagery = useCultureStore((s) => s.imagery)
    const imageryLoading = useCultureStore((s) => s.imageryLoading)
    const selectedImageryName = useCultureStore((s) => s.selectedImageryName)
    const fetchImagery = useCultureStore((s) => s.fetchImagery)
    const refreshImagery = useCultureStore((s) => s.refreshImagery)

    const selectedPoem = poems.find((p) => p.id === selectedPoemId)
    const selectedPoemContent = selectedPoem?.content ?? ''
    const imageries = useMemo(
        () => extractImageriesFromContent(selectedPoemContent),
        [selectedPoemContent],
    )

    // 自动选中首个意象（poem 变更后 selectedImageryName 被清空，触发自动选取）
    useEffect(() => {
        if (imageries.length > 0 && !selectedImageryName) {
            const first = imageries[0]
            if (first) void fetchImagery(first)
        }
    }, [imageries, selectedImageryName, fetchImagery])

    return (
        <section className={cn('pr-culture-section', className)}>
            <div className="pr-culture-section-header">
                <h2 className="pr-culture-section-title">
                    <span className="pr-culture-section-title-icon">
                        <Icon name="compass" size={16} />
                    </span>
                    <span>意象文化解读</span>
                </h2>
                {imagery && selectedImageryName && (
                    <div className="pr-culture-section-meta">
                        {imagery.aiGenerated && (
                            <span className="pr-culture-ai-badge">
                                <Icon name="sparkle" size={10} />
                                AI 生成
                            </span>
                        )}
                        <button
                            type="button"
                            className="pr-culture-imagery-refresh"
                            onClick={() => void refreshImagery(selectedImageryName)}
                            disabled={imageryLoading}
                            title="请求 AI 重新生成深度解读；失败时保留当前内容"
                        >
                            <Icon name="arrows-clockwise" size={13} />
                            {imageryLoading ? '刷新中' : 'AI 深度刷新'}
                        </button>
                    </div>
                )}
            </div>

            {imageries.length === 0 ? (
                <div className="pr-culture-empty">
                    <div className="pr-culture-empty-icon">
                        <Icon name="compass" size={24} />
                    </div>
                    <p className="pr-culture-empty-title">当前诗作未识别到常见意象</p>
                    <p className="pr-culture-empty-desc">
                        可尝试切换其他诗篇，或从诗列表中挑选意象更鲜明的篇目。
                    </p>
                </div>
            ) : (
                <>
                    <div className="pr-culture-imagery-tags">
                        {imageries.map((name) => (
                            <button
                                key={name}
                                type="button"
                                className={cn(
                                    'pr-culture-imagery-tag',
                                    name === selectedImageryName && 'is-active',
                                )}
                                onClick={() => void fetchImagery(name)}
                                aria-pressed={name === selectedImageryName}
                            >
                                {name}
                            </button>
                        ))}
                    </div>

                    {imageryLoading ? (
                        <div className="pr-culture-imagery-skeleton" />
                    ) : imagery ? (
                        <div className="pr-culture-imagery-content pr-culture-fade-in">
                            <div className="pr-culture-imagery-base">
                                {imagery.baseMeaning}
                            </div>
                            <div className="pr-culture-imagery-deep">
                                <Markdown content={imagery.deepInterpretation} />
                            </div>
                            {imagery.culturalDimensions.length > 0 && (
                                <div className="pr-culture-imagery-dimensions">
                                    {imagery.culturalDimensions.map((dim) => (
                                        <span key={dim} className="pr-culture-imagery-dimension">
                                            <Icon name="sparkle" size={10} />
                                            {dim}
                                        </span>
                                    ))}
                                </div>
                            )}
                            {imagery.relatedPoems.length > 0 && (
                                <div className="pr-culture-imagery-related">
                                    <span className="pr-culture-imagery-related-label">
                                        关联诗篇
                                    </span>
                                    <div className="pr-culture-imagery-related-list">
                                        {imagery.relatedPoems.map((rp) => (
                                            <span
                                                key={rp.poemId}
                                                className="pr-culture-imagery-related-item"
                                            >
                                                <span className="pr-culture-imagery-related-item-dynasty">
                                                    {rp.dynasty}
                                                </span>
                                                <span>{rp.title}</span>
                                                <span className="pr-culture-imagery-related-item-dynasty">
                                                    · {rp.poet}
                                                </span>
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : null}
                </>
            )}
        </section>
    )
})
