import { forwardRef, useEffect, useRef, useState } from 'react'
import type { InputHTMLAttributes, TextareaHTMLAttributes, ReactNode } from 'react'
import './Input.css'
import { cn } from '@/lib/cn'

/**
 * Input 输入框（规范 14.2）
 *
 * 常态：surface-primary 背景 + border-primary-alpha(18%) 边框
 * hover：边框 alpha 18% → 30%
 * focus：accent-primary 边框 + 3px accent 12% alpha 光晕
 * error：accent-error 边框 + 4px shake 抖动动画
 *
 * 支持 input 与 textarea 两种形态，支持前缀/后缀 icon 槽。
 */

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
    /** 多行文本模式 */
    multiline?: false
    /** 错误态 */
    error?: boolean
    /** 前缀图标/文本 */
    prefix?: ReactNode
    /** 后缀图标/文本 */
    suffix?: ReactNode
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
    multiline: true
    error?: boolean
    prefix?: never
    suffix?: never
}

export type InputComponentProps = InputProps | TextareaProps

export const Input = forwardRef<HTMLInputElement | HTMLTextAreaElement, InputComponentProps>(
    function Input(props, ref) {
        if (props.multiline) {
            const { multiline: _multiline, error, className, rows = 4, ...rest } = props
            void _multiline
            return (
                <TextareaImpl ref={ref as React.Ref<HTMLTextAreaElement>} error={error} className={className} rows={rows} {...rest} />
            )
        }
        const { multiline: _multiline, error, prefix, suffix, className, ...rest } = props
        void _multiline
        return (
            <InputImpl
                ref={ref as React.Ref<HTMLInputElement>}
                error={error}
                prefix={prefix}
                suffix={suffix}
                className={className}
                {...rest}
            />
        )
    },
)

const InputImpl = forwardRef<HTMLInputElement, Omit<InputProps, 'multiline'>>(
    function InputImpl({ error, prefix, suffix, className, ...rest }, ref) {
        const shakeKey = useShakeOnMount(error)
        return (
            <span
                className={cn(
                    'pr-input-wrapper',
                    prefix && 'pr-input-wrapper--with-prefix',
                    suffix && 'pr-input-wrapper--with-suffix',
                )}
            >
                {prefix && <span className="pr-input-prefix">{prefix}</span>}
                <input
                    ref={ref}
                    aria-invalid={error || undefined}
                    className={cn('pr-input', error && 'pr-input--error', error && shakeKey && 'pr-input--error-shake', className)}
                    {...rest}
                />
                {suffix && <span className="pr-input-suffix">{suffix}</span>}
            </span>
        )
    },
)

const TextareaImpl = forwardRef<HTMLTextAreaElement, Omit<TextareaProps, 'multiline'>>(
    function TextareaImpl({ error, className, ...rest }, ref) {
        const shakeKey = useShakeOnMount(error)
        return (
            <textarea
                ref={ref}
                aria-invalid={error || undefined}
                className={cn('pr-input pr-input--textarea', error && 'pr-input--error', error && shakeKey && 'pr-input--error-shake', className)}
                {...rest}
            />
        )
    },
)

/**
 * 当 error 状态首次出现时触发一次 shake 动画。
 * 通过 key 重置确保连续错误也能再次抖动。
 */
function useShakeOnMount(error?: boolean): number {
    const [key, setKey] = useState(0)
    const prev = useRef(false)
    useEffect(() => {
        if (error && !prev.current) {
            setKey((k) => k + 1)
        }
        prev.current = Boolean(error)
    }, [error])
    return key
}
