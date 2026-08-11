import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './Modal.css'
import { Icon } from './Icon'
import { cn } from '@/lib/cn'

/**
 * Modal 模态对话框（规范 14.4）
 *
 * 遮罩：rgba(44,36,26,0.30) + backdrop-blur(4px)
 * 面板：surface-glass-heavy + 16px 圆角 + shadow-modal
 * 入场：遮罩 200ms ease-out + 面板 scale 0.95→1 + opacity 0→1，300ms spring-soft
 * 离场：遮罩延迟 100ms 后淡出 + 面板 scale 1→0.97，200ms ease-in
 * 关闭：点击遮罩 / ESC / 关闭按钮（行为一致）
 * size: sm | md | lg | full
 */

export type ModalSize = 'sm' | 'md' | 'lg' | 'full'

export interface ModalProps {
    open: boolean
    onClose: () => void
    /** 尺寸 */
    size?: ModalSize
    /** 标题 */
    title?: ReactNode
    /**
     * 无可见标题时的对话框名称；有标题时默认由标题元素命名。
     * 仅当展示标题无法准确描述该流程时才覆盖默认标题名称。
     */
    ariaLabel?: string
    /** 是否显示关闭按钮，默认 true */
    closable?: boolean
    /** 点击遮罩是否关闭，默认 true */
    maskClosable?: boolean
    /** 透传到 body 的额外内容（无 title 时整体自定义） */
    children?: ReactNode
    /** 自定义 footer */
    footer?: ReactNode
    /** 透传到面板的 className */
    className?: string
    /** 透传到 body 的 className */
    bodyClassName?: string
}

export function Modal({
    open,
    onClose,
    size = 'md',
    title,
    ariaLabel,
    closable = true,
    maskClosable = true,
    children,
    footer,
    className,
    bodyClassName,
}: ModalProps) {
    const [render, setRender] = useState(open)
    const [leaving, setLeaving] = useState(false)
    const closingTimer = useRef<number | null>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const lastFocused = useRef<HTMLElement | null>(null)
    const titleId = useId()
    const hasTitle = title !== undefined && title !== null && title !== false
    const dialogLabelledBy = hasTitle && !ariaLabel ? titleId : undefined
    const dialogLabel = ariaLabel ?? (hasTitle ? undefined : '对话框')

    /**
     * 无论组件是走完离场动画，还是父组件因为条件渲染而直接卸载，都必须把
     * 键盘焦点交还给打开弹窗的控件。否则 Escape 后焦点会落到 body，键盘用户
     * 无法继续原来的工作流。isConnected 防止路由卸载后重新聚焦已离开文档的节点。
     */
    const restoreFocus = useCallback(() => {
        const previous = lastFocused.current
        lastFocused.current = null
        if (previous?.isConnected && typeof previous.focus === 'function') {
            previous.focus({ preventScroll: true })
        }
    }, [])

    // 开启：渲染并入场
    useEffect(() => {
        if (open) {
            setRender(true)
            setLeaving(false)
        }
    }, [open])

    // 关闭：先离场动画，再卸载（不再回调 onClose，由父级控制 open 状态）。
    // 焦点必须等面板退出可访问树后再交回来源；否则动画尚在显示 aria-modal
    // 对话框时，焦点已落在背景，会形成短暂但真实的焦点逃逸。
    const startClose = useCallback(() => {
        setLeaving(true)
        // 遮罩延迟 100ms 后淡出，整体 200ms，故 300ms 后卸载
        if (closingTimer.current) window.clearTimeout(closingTimer.current)
        closingTimer.current = window.setTimeout(() => {
            setRender(false)
            setLeaving(false)
            window.requestAnimationFrame(restoreFocus)
        }, 300)
    }, [restoreFocus])

    // open 变为 false 时触发离场
    useEffect(() => {
        if (!open && render && !leaving) {
            startClose()
        }
    }, [open, render, leaving, startClose])

    // ESC 关闭
    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !e.defaultPrevented) {
                e.stopPropagation()
                onClose()
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [open, onClose])

    // 焦点管理：记录触发元素 + 打开时移入焦点（initial focus）
    useEffect(() => {
        if (!open) return
        lastFocused.current = document.activeElement as HTMLElement | null
        // 延迟一帧，等待面板渲染完成（render 由前一个 effect 触发）
        const t = window.setTimeout(() => {
            const panel = panelRef.current
            if (!panel) return
            const focusable = panel.querySelector<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            )
                ; (focusable ?? panel).focus()
        }, 0)
        return () => window.clearTimeout(t)
    }, [open])

    // 焦点陷阱：Tab/Shift+Tab 循环约束在 panel 内（focus trap）
    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return
            const panel = panelRef.current
            if (!panel) return
            const focusables = panel.querySelectorAll<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            )
            if (focusables.length === 0) {
                e.preventDefault()
                panel.focus()
                return
            }
            const first = focusables[0]
            const last = focusables[focusables.length - 1]
            if (!first || !last) {
                e.preventDefault()
                panel.focus()
                return
            }
            const active = document.activeElement as HTMLElement | null
            if (e.shiftKey) {
                if (active === first || !panel.contains(active)) {
                    e.preventDefault()
                    last.focus()
                }
            } else {
                if (active === last || !panel.contains(active)) {
                    e.preventDefault()
                    first.focus()
                }
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [open])

    // 卸载清理
    useEffect(() => {
        return () => {
            if (closingTimer.current) window.clearTimeout(closingTimer.current)
            // 某些业务弹窗会在 close 时直接条件卸载；这时上面的 open=false
            // effect 没有机会运行，仍需执行同一条安全的焦点恢复路径。
            restoreFocus()
        }
    }, [restoreFocus])

    // 锁定滚动
    useEffect(() => {
        if (!render) return
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
            document.body.style.overflow = prev
        }
    }, [render])

    if (!render) return null

    return createPortal(
        <div
            className={cn('pr-modal-overlay', leaving ? 'pr-modal-overlay--leaving' : 'pr-modal-overlay--entering')}
            onMouseDown={(e) => {
                if (maskClosable && e.target === e.currentTarget) onClose()
            }}
        >
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={dialogLabelledBy}
                aria-label={dialogLabel}
                tabIndex={-1}
                className={cn(
                    'pr-modal-panel',
                    `pr-modal-panel--${size}`,
                    leaving ? 'pr-modal-panel--leaving' : 'pr-modal-panel--entering',
                    className,
                )}
                onMouseDown={(e) => e.stopPropagation()}
            >
                {(hasTitle || closable) && (
                    <div className="pr-modal-header">
                        {hasTitle && <h2 id={titleId} className="pr-modal-title">{title}</h2>}
                        {closable && (
                            <button className="pr-modal-close" onClick={onClose} aria-label="关闭" type="button">
                                <Icon name="x" size={18} />
                            </button>
                        )}
                    </div>
                )}
                <div className={cn('pr-modal-body', bodyClassName)}>{children}</div>
                {footer && <div className="pr-modal-footer">{footer}</div>}
            </div>
        </div>,
        document.body,
    )
}
