/**
 * ImageGallery 文化文物图片库（Task 20）
 *
 * 展示 Wan2.7 生成图或本地教学插画，并如实呈现来源：
 * - 自适应网格布局（auto-fill，160-220px 每列）
 * - 图片骨架屏加载 + opacity 淡入动画
 * - 点击查看详情（三视角标注 + 文化内涵 + 关联诗句）
 * - hover 显示描述 overlay
 *
 * 设计要点：
 * - 图片加载用骨架屏 + opacity 淡入（规范 11.2 图片渐进渲染）
 * - 完整三态：hover translateY(-2px) / active scale(0.98) / focus-visible 光晕
 * - AI 生成标注
 * - Tabular Numbers 显示图片数量
 * - 无 emoji，所有图形语义由 Icon 承载
 */

import { memo } from 'react'
import { Icon } from '@/components/ui'
import { PoemImage } from '@/components/ui/PoemImage'
import { useCultureStore } from '@/stores/culture'
import type { CultureImage } from '@/lib/types'
import { cn } from '@/lib/cn'

interface ImageGalleryProps {
    className?: string
}

export const ImageGallery = memo(function ImageGallery({ className }: ImageGalleryProps) {
    const images = useCultureStore((s) => s.images)
    const imagesLoading = useCultureStore((s) => s.imagesLoading)
    const imagesCached = useCultureStore((s) => s.imagesCached)
    const selectedImage = useCultureStore((s) => s.selectedImage)
    const selectImage = useCultureStore((s) => s.selectImage)

    return (
        <section className={cn('pr-culture-section', className)}>
            <div className="pr-culture-section-header">
                <h2 className="pr-culture-section-title">
                    <span className="pr-culture-section-title-icon">
                        <Icon name="mountains" size={16} />
                    </span>
                    <span>文物图片库</span>
                </h2>
                <div className="pr-culture-section-meta">
                    {images.length > 0 && <span>{images.length} 张</span>}
                    {imagesCached && <span>缓存命中</span>}
                </div>
            </div>

            {imagesLoading ? (
                <div className="pr-culture-image-grid">
                    {[0, 1, 2, 3].map((i) => (
                        <ImageSkeleton key={i} />
                    ))}
                </div>
            ) : images.length === 0 ? (
                <div className="pr-culture-empty">
                    <div className="pr-culture-empty-icon">
                        <Icon name="mountains" size={24} />
                    </div>
                    <p className="pr-culture-empty-title">选诗后汇集文物图片与文生图作品</p>
                    <p className="pr-culture-empty-desc">
                        视觉智能体会结合诗歌意象与时代语境，生成对应且可用于课堂的视觉素材。
                    </p>
                </div>
            ) : (
                <>
                    <div className="pr-culture-image-grid pr-culture-fade-in">
                        {images.map((image) => (
                            <ImageCard
                                key={image.id}
                                image={image}
                                isSelected={selectedImage?.id === image.id}
                                onSelect={selectImage}
                            />
                        ))}
                    </div>
                    {selectedImage && <ImageDetail image={selectedImage} />}
                </>
            )}
        </section>
    )
})

/** 图片骨架屏占位 */
function ImageSkeleton() {
    return (
        <div className="pr-culture-image-frame">
            <div className="pr-culture-image-skeleton" />
        </div>
    )
}

interface ImageCardProps {
    image: CultureImage
    isSelected: boolean
    onSelect: (imageId: string) => void
}

const ImageCard = memo(function ImageCard({ image, isSelected, onSelect }: ImageCardProps) {
    return (
        <button
            type="button"
            className={cn('pr-culture-image-card', isSelected && 'is-selected')}
            onClick={() => onSelect(image.id)}
            aria-pressed={isSelected}
        >
            <div
                className={cn(
                    'pr-culture-image-frame',
                    image.orientation === 'portrait' && 'is-portrait',
                )}
            >
                <PoemImage
                    src={image.imageUrl}
                    alt={image.title}
                    className="pr-culture-image-img"
                    ratio="auto"
                    size="full"
                    showAiBadge={image.aiGenerated}
                    aiLabel={image.model ?? 'Wan2.7 生成'}
                />
                <div className="pr-culture-image-overlay">
                    <span className="pr-culture-image-overlay-text">
                        {image.description}
                    </span>
                </div>
            </div>
            <div className="pr-culture-image-title">{image.title}</div>
            <div className="pr-culture-image-desc">{image.description}</div>
        </button>
    )
})

interface ImageDetailProps {
    image: CultureImage
}

function ImageDetail({ image }: ImageDetailProps) {
    const hasPerspectives = !!image.perspectives
    return (
        <div className="pr-culture-image-detail pr-culture-fade-in">
            <PoemImage
                src={image.imageUrl}
                alt={image.title}
                size="full"
                ratio={image.orientation === 'portrait' ? '3/4' : '16/9'}
                aiLabel={image.model ?? 'Wan2.7 生成'}
                showAiBadge={image.aiGenerated}
                caption={image.title}
                lazy={false}
            />

            <div className="pr-culture-image-detail-title">{image.title}</div>
            <div className="pr-culture-image-detail-desc">{image.description}</div>

            {image.relatedVerse && (
                <div className="pr-culture-imagery-base">{image.relatedVerse}</div>
            )}

            {hasPerspectives && image.perspectives && (
                <div className="pr-culture-image-detail-perspectives">
                    <PerspectiveItem
                        label="色彩构图"
                        text={image.perspectives.color_composition}
                    />
                    <PerspectiveItem
                        label="情感氛围"
                        text={image.perspectives.emotion_atmosphere}
                    />
                    <PerspectiveItem
                        label="文化符号"
                        text={image.perspectives.cultural_symbols}
                    />
                </div>
            )}

            <div className="pr-culture-image-detail-desc">{image.culturalMeaning}</div>

            <div className="pr-culture-section-meta">
                <span className="pr-culture-ai-badge">
                    <Icon name={image.aiGenerated ? 'sparkle' : 'image'} size={10} />
                    {image.aiGenerated
                        ? `${image.model ?? 'Wan2.7'} 生成`
                        : '系统教学插画'}
                </span>
            </div>
        </div>
    )
}

interface PerspectiveItemProps {
    label: string
    text: string
}

function PerspectiveItem({ label, text }: PerspectiveItemProps) {
    return (
        <div className="pr-culture-image-detail-perspective">
            <span className="pr-culture-image-detail-perspective-label">{label}</span>
            <span className="pr-culture-image-detail-perspective-text">{text}</span>
        </div>
    )
}
