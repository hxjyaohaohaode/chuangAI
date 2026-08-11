import type { HTMLAttributes, ReactNode } from 'react'
import './Badge.css'
import { cn } from '@/lib/cn'

/**
 * Badge 徽标（规范 14.x）
 *
 * 类型：default | primary | success | warning | error | info
 * 使用对应强调色 20% alpha 背景 + 100% 文字
 * 10px 字号 + 600 字重
 */

export type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
    variant?: BadgeVariant
    /** 左侧图标 */
    icon?: ReactNode
    children?: ReactNode
}

export function Badge({ variant = 'default', icon, className, children, ...rest }: BadgeProps) {
    return (
        <span className={cn('pr-badge', `pr-badge--${variant}`, className)} {...rest}>
            {icon && <span className="inline-flex shrink-0" aria-hidden>{icon}</span>}
            {children}
        </span>
    )
}
