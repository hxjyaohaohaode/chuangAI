/**
 * BackgroundPanel 文化背景包展示（Task 20）
 *
 * 展示 brush.creative 生成的四区文化背景：
 * - 历史背景（scroll 图标）
 * - 诗人境遇（feather 图标）
 * - 创作情境（lightbulb 图标）
 * - 文化常识（globe 图标）
 *
 * 设计要点：
 * - 2×2 网格布局，移动端单列
 * - 每区使用 Markdown 渲染 AI 生成内容
 * - 骨架屏加载态（4 个 shimmer 块）
 * - AI 生成标注 + 缓存命中提示
 * - 无 emoji，所有图形语义由 Icon 承载
 * - 完整三态：hover 背景变色 / 无 active 态（非交互卡片）
 */

import { memo } from 'react'
import { Icon } from '@/components/ui'
import { Markdown } from '@/components/ui/Markdown'
import type { KnownIconName } from '@/components/ui'
import { useCultureStore } from '@/stores/culture'
import type { BackgroundSectionKey } from '@/lib/types'
import { cn } from '@/lib/cn'

interface BackgroundSectionMeta {
    key: BackgroundSectionKey
    label: string
    icon: KnownIconName
}

const SECTIONS: BackgroundSectionMeta[] = [
    { key: 'historical', label: '历史背景', icon: 'scroll' },
    { key: 'poet', label: '诗人境遇', icon: 'feather' },
    { key: 'creation', label: '创作情境', icon: 'lightbulb' },
    { key: 'cultural', label: '文化常识', icon: 'globe' },
]

interface BackgroundPanelProps {
    className?: string
}

export const BackgroundPanel = memo(function BackgroundPanel({ className }: BackgroundPanelProps) {
    const background = useCultureStore((s) => s.background)
    const backgroundLoading = useCultureStore((s) => s.backgroundLoading)
    const backgroundCached = useCultureStore((s) => s.backgroundCached)

    return (
        <section className={cn('pr-culture-section', className)}>
            <div className="pr-culture-section-header">
                <h2 className="pr-culture-section-title">
                    <span className="pr-culture-section-title-icon">
                        <Icon name="book-open" size={16} />
                    </span>
                    <span>文化背景包</span>
                </h2>
                <div className="pr-culture-section-meta">
                    {background?.aiGenerated && (
                        <span className="pr-culture-ai-badge">
                            <Icon name="sparkle" size={10} />
                            AI 生成
                        </span>
                    )}
                    {backgroundCached && <span>缓存命中</span>}
                </div>
            </div>

            {backgroundLoading ? (
                <div className="pr-culture-background-grid">
                    {[0, 1, 2, 3].map((i) => (
                        <div key={i} className="pr-culture-bg-skeleton" />
                    ))}
                </div>
            ) : background ? (
                <div className="pr-culture-background-grid pr-culture-fade-in">
                    {SECTIONS.map((section) => (
                        <BackgroundSectionCard
                            key={section.key}
                            section={section}
                            content={background[section.key]}
                        />
                    ))}
                </div>
            ) : (
                <div className="pr-culture-empty">
                    <div className="pr-culture-empty-icon">
                        <Icon name="scroll" size={24} />
                    </div>
                    <p className="pr-culture-empty-title">选诗后展开四维文化背景</p>
                    <p className="pr-culture-empty-desc">
                        历史背景、诗人境遇、创作情境、文化常识将由诗心 Agent 即时生成。
                    </p>
                </div>
            )}
        </section>
    )
})

interface BackgroundSectionCardProps {
    section: BackgroundSectionMeta
    content: string
}

const BackgroundSectionCard = memo(function BackgroundSectionCard({
    section,
    content,
}: BackgroundSectionCardProps) {
    return (
        <div className="pr-culture-bg-section">
            <div className="pr-culture-bg-section-header">
                <span className="pr-culture-bg-section-icon">
                    <Icon name={section.icon} size={16} />
                </span>
                <span className="pr-culture-bg-section-label">{section.label}</span>
            </div>
            <div className="pr-culture-bg-section-content">
                <Markdown content={content} />
            </div>
        </div>
    )
})
