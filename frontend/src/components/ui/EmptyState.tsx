import type { CSSProperties, ReactNode } from 'react'
import './EmptyState.css'
import type { IconName } from './Icon'
import type { EmptyStateKey } from '@/assets/illustrations/EmptyStateIllustrations'

// 重新导出 EmptyStateKey 类型，供 barrel file (index.ts) 统一出口使用
export type { EmptyStateKey }

export interface EmptyStateAction {
    /** 操作文案 */
    label: string
    /** 点击回调 */
    onClick: () => void
    /** 图标名（可选） */
    icon?: IconName
}

export interface EmptyStateProps {
    /** 预设主题插画 key（与 illustration 二选一） */
    variant?: EmptyStateKey
    /** 自定义插画（与 variant 二选一，优先级高于 variant） */
    illustration?: ReactNode
    /** 主标题（必填） */
    title: string
    /** 描述文字 */
    description?: string
    /** 主操作按钮 */
    action?: EmptyStateAction
    /** 次要操作按钮 */
    secondaryAction?: EmptyStateAction
    /** 自定义类名 */
    className?: string
    /** 自定义内联样式 */
    style?: CSSProperties
    /** 紧凑模式（减小插画尺寸与间距，用于面板内嵌） */
    compact?: boolean
}
