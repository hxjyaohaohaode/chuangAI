import type { ReactNode } from 'react'
import { Badge } from './Badge'
import { Icon } from './Icon'

/**
 * AI 生成内容徽标（SubTask 28.1 —— AI 内容合规审查）
 *
 * 统一所有 AI 生成内容的水印标识，遵循《界面设计规范》"一致"原则：
 * - 图标：sparkle（Phosphor Icons）
 * - 文案：默认"AI 生成"，可传 label 自定义（如"AI 辅助"/"AI 评估"/"AI 推荐"）
 * - 颜色：primary 强调色 20% alpha 背景 + 100% 文字（WCAG AA 合规）
 *
 * 用法：
 *   <AIBadge />                          // 默认"AI 生成"
 *   <AIBadge label="AI 辅助" />          // 人机协作内容
 *   <AIBadge label="AI 评估" size="xs" />// 朗读评测等
 */

export interface AIBadgeProps {
    /** 自定义文案，默认"AI 生成" */
    label?: string
    /** 尺寸：sm（默认，与正文同高）/ xs（更小，用于密集列表） */
    size?: 'sm' | 'xs'
    /** 自定义 className */
    className?: string
    /** 自定义图标（默认 sparkle） */
    icon?: ReactNode
}

export function AIBadge({
    label = 'AI 生成',
    size = 'sm',
    className,
    icon,
}: AIBadgeProps) {
    const iconSize = size === 'xs' ? 10 : 12
    return (
        <Badge
            variant="primary"
            icon={icon ?? <Icon name="sparkle" size={iconSize} weight="bold" />}
            className={className}
            aria-label={`此内容由${label}`}
        >
            {label}
        </Badge>
    )
}
