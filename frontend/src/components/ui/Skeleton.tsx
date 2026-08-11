/**
 * 骨架屏组件（规范 6.4 / 14.x）
 *
 * 模拟真实内容布局形状（非简单灰色块），shimmer 微光动画。
 * 200ms 延迟后启动，避免快速加载时闪烁。
 *
 * 组件族：
 * - Skeleton：基础块（支持 width/height/radius/circle）
 * - SkeletonText：多行文本骨架（模拟段落形状）
 * - SkeletonCircle：圆形头像骨架
 * - SkeletonCard：卡片骨架（模拟统计卡片布局）
 *
 * 设计要点：
 * - shimmer：横向渐变扫光（surface-tertiary → surface-elevated → surface-tertiary）
 * - 200ms 延迟启动（animation-delay），快速加载不闪烁
 * - 圆角与真实组件一致
 * - prefers-reduced-motion 降级：静态色块
 */

import { memo } from 'react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'

export interface SkeletonProps {
    /** 宽度，默认 100% */
    width?: number | string
    /** 高度，默认 14px */
    height?: number | string
    /** 圆角，默认 var(--radius-sm) */
    radius?: number | string
    /** 是否圆形 */
    circle?: boolean
    /** 自定义 class */
    className?: string
    /** 自定义 style */
    style?: CSSProperties
}

export const Skeleton = memo(function Skeleton({
    width = '100%',
    height = 14,
    radius,
    circle = false,
    className,
    style,
}: SkeletonProps) {
    return (
        <span
            className={cn('pr-skeleton-shimmer', className)}
            style={{
                width,
                height,
                borderRadius: circle ? '50%' : (radius ?? 'var(--radius-sm)'),
                display: 'block',
                ...style,
            }}
            aria-hidden="true"
        />
    )
})

/* ============================================================
 * SkeletonText —— 多行文本骨架
 * ============================================================ */

export interface SkeletonTextProps {
    /** 行数，默认 3 */
    lines?: number
    /** 每行宽度比例（数组），默认自动递减 100/85/60%
     * 最后一行宽度自动收窄，模拟自然段落
     */
    widths?: Array<number | string>
    /** 行高，默认 12 */
    lineHeight?: number
    /** 行间距，默认 var(--space-xs) */
    gap?: number | string
    className?: string
}

/* ============================================================
 * SkeletonCircle —— 圆形骨架
 * ============================================================ */

export interface SkeletonCircleProps {
    size?: number
    className?: string
}

export const SkeletonCircle = memo(function SkeletonCircle({
    size = 40,
    className,
}: SkeletonCircleProps) {
    return <Skeleton width={size} height={size} circle className={className} />
})

/* ============================================================
 * SkeletonCard —— 统计卡片骨架（模拟 DashboardStats 布局）
 * ============================================================ */

export interface SkeletonCardProps {
    className?: string
}


