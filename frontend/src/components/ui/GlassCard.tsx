/**
 * GlassCard —— 毛玻璃卡片增强（spec enhance-ui-premium-components-v7 Task 3.2）
 *
 * 基于设计规范第 14.3 节（卡片规格）和第 4 章（透明边框设计体系）实现。
 * 注：优质前端部件组中无对应原始组件。30_卡片的白色福彩.md 实际是 PixelCard
 * （Canvas 像素动画卡片），非玻璃态组件，此前注释的错误归因已修正。
 *
 * 设计规范合规：
 * - backdrop-blur 20px + 85% alpha 半透明背景
 * - 微妙渐变叠加 + 噪点纹理（规范 2.5：表面非纯色）
 * - 无边框（仅 hover 出现 alpha 8% 微边框，规范 4.3）
 * - hover 微升 2px + 阴影扩散（规范 14.3）
 * - 200ms spring-soft 过渡（规范 6.3）
 *
 * 与 Card 的区别：
 * - Card：surface-secondary 实色背景 + 噪点，适用于常规内容容器
 * - GlassCard：半透明玻璃态 + backdrop-blur，适用于浮层、弹窗内卡片、
 *   需要透出底层内容的场景（如模态对话框内的分组卡片、星图页浮层）
 *
 * 设计规范合规：
 * - 零硬编码色值（使用 rgb(var(--c-xxx) / alpha) 语法）
 * - 无 1px 实色边框（透明度分层 + 负空间）
 * - transform/opacity 动画（不触发 Layout）
 * - prefers-reduced-motion 降级（移除 hover 上浮）
 */

import { forwardRef } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import './GlassCard.css'
import { cn } from '@/lib/cn'

export interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
    /** 可交互态：hover 上浮 + 微边框 + 阴影扩散 */
    interactive?: boolean
    /** 卡片内边距，默认 lg */
    padding?: 'none' | 'sm' | 'md' | 'lg'
    /** 玻璃态强度：light（blur 12px）| normal（blur 20px）| heavy（blur 28px） */
    blur?: 'light' | 'normal' | 'heavy'
    children?: ReactNode
}

const paddingMap: Record<NonNullable<GlassCardProps['padding']>, string | undefined> = {
    none: '0',
    sm: 'var(--space-sm)',
    md: 'var(--space-md)',
    lg: undefined,
}

const blurClassMap: Record<NonNullable<GlassCardProps['blur']>, string> = {
    light: 'pr-glasscard--light',
    normal: 'pr-glasscard--normal',
    heavy: 'pr-glasscard--heavy',
}

export const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(function GlassCard(
    {
        interactive = false,
        padding = 'lg',
        blur = 'normal',
        className,
        children,
        ...rest
    },
    ref,
) {
    const padStyle = paddingMap[padding]
    return (
        <div
            ref={ref}
            className={cn(
                'pr-glasscard',
                blurClassMap[blur],
                interactive && 'pr-glasscard--interactive',
                className,
            )}
            style={padStyle ? { padding: padStyle } : undefined}
            tabIndex={interactive ? 0 : undefined}
            role={interactive ? 'group' : undefined}
            {...rest}
        >
            {/* 渐变叠加层（规范 2.5：表面非纯色，必须有微妙渐变） */}
            <span className="pr-glasscard-overlay" aria-hidden="true" />
            {/* 噪点纹理层（规范 2.5：表面叠加 0.3% 噪点） */}
            <span className="pr-glasscard-noise" aria-hidden="true" />
            {/* 内容层 */}
            <div className="pr-glasscard-content">
                {children}
            </div>
        </div>
    )
})
