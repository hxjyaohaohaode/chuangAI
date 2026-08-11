import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import './Button.css'
import { cn } from '@/lib/cn'

/**
 * Button 按钮（规范 14.1）
 *
 * 变体：
 * - primary：accent 主色背景 + 噪点纹理 + hover 上浮 + active 缩放
 * - secondary：透明 + alpha 40% 边框 + hover alpha 10% 背景
 * - ghost：全透明 + hover alpha 6% 背景
 * - danger / success：对应语义色
 *
 * 完整三态：hover / active(scale 0.97) / focus-visible(双环光晕)
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant
    size?: ButtonSize
    /** 撑满父容器宽度 */
    block?: boolean
    /** 左侧图标 */
    leftIcon?: ReactNode
    /** 右侧图标 */
    rightIcon?: ReactNode
    /** 加载态（禁用并展示 spinner） */
    loading?: boolean
    /** 纯图标按钮：提供正方形触控区；必须同时传入 aria-label */
    iconOnly?: boolean
    /** 加载时替换按钮文字，避免动作语义不清 */
    loadingLabel?: ReactNode
    children?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    {
        variant = 'primary',
        size = 'md',
        block = false,
        leftIcon,
        rightIcon,
        loading = false,
        iconOnly = false,
        loadingLabel,
        disabled,
        className,
        children,
        type = 'button',
        ...rest
    },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            disabled={disabled || loading}
            aria-busy={loading || undefined}
            className={cn(
                'pr-btn',
                `pr-btn--${variant}`,
                `pr-btn--${size}`,
                block && 'pr-btn--block',
                iconOnly && 'pr-btn--icon-only',
                className,
            )}
            {...rest}
        >
            {leftIcon && <span className="pr-btn__icon" aria-hidden>{leftIcon}</span>}
            {loading ? (
                <span className="pr-btn__loading" role="status" aria-live="polite">
                    <span className="pr-btn__spinner" aria-hidden />
                    <span>{loadingLabel ?? children}</span>
                </span>
            ) : (
                children
            )}
            {rightIcon && !loading && <span className="pr-btn__icon" aria-hidden>{rightIcon}</span>}
        </button>
    )
})
