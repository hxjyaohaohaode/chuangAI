import { forwardRef } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import './Card.css'
import { cn } from '@/lib/cn'

/**
 * Card 卡片（规范 14.3）
 *
 * 常态：surface-secondary 背景 + 噪点纹理 + 12px 圆角 + 无边框
 * interactive 模式：hover translateY(-2px) + shadow + 1px alpha 8% 微边框
 * 200ms spring-soft 过渡
 *
 * 卡片内禁止嵌套卡片 —— CSS 中已对 .pr-card .pr-card 做了去背景处理。
 */

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
    /** 可交互态：hover 上浮 + 微边框 */
    interactive?: boolean
    /** 默认带极淡阴影 */
    flat?: boolean
    /** 卡片内边距，默认 lg */
    padding?: 'none' | 'sm' | 'md' | 'lg'
    children?: ReactNode
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
    { interactive = false, flat = false, padding = 'lg', className, children, ...rest },
    ref,
) {
    const padStyle = paddingMap[padding]
    return (
        <div
            ref={ref}
            className={cn('pr-card', interactive && 'pr-card--interactive', flat && 'pr-card--flat', className)}
            style={padStyle ? { padding: padStyle } : undefined}
            tabIndex={interactive ? 0 : undefined}
            role={interactive ? 'group' : undefined}
            {...rest}
        >
            {children}
        </div>
    )
})

const paddingMap: Record<NonNullable<CardProps['padding']>, string | undefined> = {
    none: '0',
    sm: 'var(--space-sm)',
    md: 'var(--space-md)',
    lg: undefined,
}
