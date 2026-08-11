import { useEffect, useMemo, useState } from 'react'
import { useToastStore, type ToastType } from '@/stores/toast'
import { Icon, type IconName } from './Icon'
import { cn } from '@/lib/cn'
import './Toast.css'

/**
 * Toast 通知容器（规范 14.x）
 *
 * 位置：右上固定
 * 入场：200ms translateY -16 → 0
 * 自动消失：默认 3000ms（store 侧定时器控制）
 * 同时显示多个 Toast 堆叠
 *
 * 用法：在应用根部渲染一次 <ToastContainer />，业务侧调用 toast.success({...})
 */

const ICON_MAP: Record<ToastType, IconName> = {
    info: 'info',
    success: 'check-circle',
    warning: 'warning-circle',
    error: 'x-circle',
}

/**
 * 右上角通知是“短时反馈”，不能在教师执行课堂操作时覆盖整个首屏。
 *
 * 只在折叠态限制视觉上同时出现的数量；所有通知仍保留在 store 中，
 * 且错误 / 警告优先可见。教师可以显式展开查看其余通知，不会丢失反馈。
 */
const MAX_COLLAPSED_TOASTS = 2

export function ToastContainer() {
    const toasts = useToastStore((s) => s.toasts)
    const dismiss = useToastStore((s) => s.dismiss)
    const [expanded, setExpanded] = useState(false)

    useEffect(() => {
        if (toasts.length <= MAX_COLLAPSED_TOASTS) {
            setExpanded(false)
        }
    }, [toasts.length])

    const visibleToasts = useMemo(() => {
        if (expanded || toasts.length <= MAX_COLLAPSED_TOASTS) return toasts

        // 风险反馈优先：即使连续成功提示较多，也不允许错误或警告被挤出视野。
        const attention = toasts.filter((toast) => toast.type === 'error' || toast.type === 'warning')
        const ambient = toasts.filter((toast) => toast.type !== 'error' && toast.type !== 'warning')
        const selected = [
            ...attention.slice(-MAX_COLLAPSED_TOASTS),
            ...ambient.slice(-Math.max(0, MAX_COLLAPSED_TOASTS - attention.length)),
        ]

        // 按原产生顺序展示，避免同一次操作的反馈倒序阅读。
        return selected.sort((a, b) => toasts.indexOf(a) - toasts.indexOf(b))
    }, [expanded, toasts])

    const hiddenCount = toasts.length - visibleToasts.length

    return (
        <div className={cn('pr-toast-container', expanded && 'is-expanded')} role="region" aria-label="通知" aria-live="polite">
            {hiddenCount > 0 && (
                <button
                    type="button"
                    className="pr-toast-overflow-toggle"
                    aria-expanded={expanded}
                    onClick={() => setExpanded(true)}
                >
                    <Icon name="bell" size={14} />
                    <span>还有 {hiddenCount} 条通知</span>
                    <Icon name="caret-down" size={12} />
                </button>
            )}
            {expanded && toasts.length > MAX_COLLAPSED_TOASTS && (
                <button
                    type="button"
                    className="pr-toast-overflow-toggle pr-toast-overflow-toggle--collapse"
                    aria-expanded
                    onClick={() => setExpanded(false)}
                >
                    <Icon name="caret-up" size={12} />
                    <span>收起通知</span>
                </button>
            )}
            {visibleToasts.map((t) => (
                <ToastItem
                    key={t.id}
                    type={t.type}
                    title={t.title}
                    message={t.message}
                    onClose={() => dismiss(t.id)}
                />
            ))}
        </div>
    )
}

interface ToastItemProps {
    type: ToastType
    title?: string
    message?: string
    onClose: () => void
}

function ToastItem({ type, title, message, onClose }: ToastItemProps) {
    // 退场动画：先标记 leaving，180ms 后真正卸载由 store dismiss 处理
    const [leaving, setLeaving] = useState(false)

    const handleClose = () => {
        setLeaving(true)
        window.setTimeout(onClose, 180)
    }

    return (
        <div
            className={cn('pr-toast', `pr-toast--${type}`, leaving && 'pr-toast--leaving')}
            role="status"
            style={leaving ? { animation: 'pr-modal-overlay-out 180ms ease-in both' } : undefined}
        >
            <span className="pr-toast-icon">
                <Icon name={ICON_MAP[type]} size={18} />
            </span>
            <div className="pr-toast-content">
                {title && <div className="pr-toast-title">{title}</div>}
                {message && <div className="pr-toast-message">{message}</div>}
            </div>
            <button className="pr-toast-close" onClick={handleClose} aria-label="关闭通知" type="button">
                <Icon name="x" size={14} />
            </button>
        </div>
    )
}
