import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUiStore, type FontSizePref } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { Icon } from '@/components/ui'
import { cn } from '@/lib/cn'
import { ModelCredentials } from './ModelCredentials'
import { MemoryGovernancePanel } from './MemoryGovernancePanel'
import { logoutSession } from '@/lib/auth-session'

/**
 * 设置面板（规范 8.4 状态保持策略 + 7.2 微交互清单）
 *
 * 设计：
 *  - 齿轮按钮，点击展开下拉面板（surface-elevated 玻璃态）
 *  - 侧边栏折叠开关（复用 useUiStore.toggleSidebar）
 *  - 字号三档选择（小/标准/大，调整 --text-base CSS 变量）
 *  - 减少动画开关（无障碍：启用后禁用非必要过渡动画）
 *  - 点击外部 / ESC 关闭面板
 *  - 所有设置持久化至 localStorage，刷新后恢复
 */

const FONT_SIZE_OPTIONS: Array<{ value: FontSizePref; label: string }> = [
    { value: 'small', label: '小' },
    { value: 'standard', label: '标准' },
    { value: 'large', label: '大' },
]

const PANEL_FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

type FocusTrapEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>

function trapPanelFocus(panel: HTMLElement | null, event: FocusTrapEvent) {
    if (event.key !== 'Tab' || !panel) return
    const focusables = panel.querySelectorAll<HTMLElement>(PANEL_FOCUSABLE_SELECTOR)
    if (focusables.length === 0) {
        event.preventDefault()
        panel.focus()
        return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (!first || !last) {
        event.preventDefault()
        panel.focus()
        return
    }
    const active = document.activeElement as HTMLElement | null
    if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
            event.preventDefault()
            last.focus()
        }
    } else if (active === last || !panel.contains(active)) {
        event.preventDefault()
        first.focus()
    }
}

export function SettingsPanel() {
    const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
    const toggleSidebar = useUiStore((s) => s.toggleSidebar)
    const fontSize = useUiStore((s) => s.fontSize)
    const setFontSize = useUiStore((s) => s.setFontSize)
    const reduceMotion = useUiStore((s) => s.reduceMotion)
    const setReduceMotion = useUiStore((s) => s.setReduceMotion)
    const navigate = useNavigate()
    const logout = useAuthStore((s) => s.logout)

    const [open, setOpen] = useState(false)
    const panelRef = useRef<HTMLDivElement | null>(null)
    const buttonRef = useRef<HTMLButtonElement | null>(null)
    const lastFocused = useRef<HTMLElement | null>(null)

    useEffect(() => {
        if (!open) return
        const onClickOutside = (e: MouseEvent) => {
            const target = e.target as Node
            if (
                panelRef.current && !panelRef.current.contains(target) &&
                buttonRef.current && !buttonRef.current.contains(target)
            ) {
                setOpen(false)
            }
        }
        const onEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation()
                setOpen(false)
            }
        }
        // 文档级处理是焦点异常离开面板时的兜底；面板自身也在首帧处理 Tab。
        const onTab = (e: KeyboardEvent) => trapPanelFocus(panelRef.current, e)
        document.addEventListener('mousedown', onClickOutside)
        document.addEventListener('keydown', onEsc)
        document.addEventListener('keydown', onTab)
        return () => {
            document.removeEventListener('mousedown', onClickOutside)
            document.removeEventListener('keydown', onEsc)
            document.removeEventListener('keydown', onTab)
        }
    }, [open])

    // 设置面板挂在 sticky header 的堆叠上下文中，而 Toast 挂在 body 下。
    // 用显式根状态提升 header，避免通知遮住表单；不用 :has()，兼容旧 WebView。
    useEffect(() => {
        if (!open) return
        document.documentElement.dataset.settingsPanelOpen = 'true'
        return () => {
            delete document.documentElement.dataset.settingsPanelOpen
        }
    }, [open])

    // 初始焦点：打开时记录触发元素并聚焦到面板内首个可交互元素（规范 14.4）
    useEffect(() => {
        if (!open) return
        if (!lastFocused.current) {
            lastFocused.current = document.activeElement as HTMLElement | null
        }
        const frame = window.requestAnimationFrame(() => {
            const panel = panelRef.current
            if (!panel) return
            const focusable = panel.querySelector<HTMLElement>(PANEL_FOCUSABLE_SELECTOR)
            ;(focusable ?? panel).focus({ preventScroll: true })
        })
        return () => window.cancelAnimationFrame(frame)
    }, [open])

    // 焦点恢复：关闭时优先返回打开前来源；若并发卸载使来源失效则回到齿轮按钮。
    useEffect(() => {
        if (open) return
        const prev = lastFocused.current
        if (!prev) return
        lastFocused.current = null
        const target = prev.isConnected && typeof prev.focus === 'function'
            ? prev
            : buttonRef.current
        if (!target) return
        const frame = window.requestAnimationFrame(() => {
            if (target.isConnected) target.focus({ preventScroll: true })
        })
        return () => window.cancelAnimationFrame(frame)
    }, [open])

    const handleTriggerClick = () => {
        setOpen((wasOpen) => {
            if (!wasOpen) {
                lastFocused.current = document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : buttonRef.current
            }
            return !wasOpen
        })
    }

    const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.stopPropagation()
            setOpen(false)
            return
        }
        trapPanelFocus(panelRef.current, event)
    }

    return (
        <div className="pr-settings-panel">
            <button
                ref={buttonRef}
                type="button"
                className="pr-icon-button"
                onClick={handleTriggerClick}
                aria-label={open ? '关闭设置面板' : '打开设置面板'}
                aria-expanded={open}
                aria-haspopup="dialog"
            >
                <Icon name="gear" size={18} />
            </button>

            {open && (
                <div
                    ref={panelRef}
                    className="pr-settings-panel-dropdown"
                    role="dialog"
                    aria-modal="true"
                    aria-label="系统设置"
                    tabIndex={-1}
                    onKeyDown={handlePanelKeyDown}
                >
                    <div className="pr-settings-title">显示设置</div>

                    {/* 侧边栏折叠 */}
                    <div className="pr-settings-row">
                        <div className="pr-settings-row-label">
                            <Icon name="sidebar" size={14} />
                            <span>侧边栏折叠</span>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={sidebarCollapsed}
                            aria-label="侧边栏折叠开关"
                            className={cn('pr-switch', sidebarCollapsed && 'is-on')}
                            onClick={toggleSidebar}
                        >
                            <span className="pr-switch-thumb" />
                        </button>
                    </div>

                    {/* 字号 */}
                    <div className="pr-settings-row pr-settings-row-column">
                        <div className="pr-settings-row-label">
                            <Icon name="text-aa" size={14} />
                            <span>字号大小</span>
                        </div>
                        <div className="pr-segmented" role="radiogroup" aria-label="字号大小">
                            {FONT_SIZE_OPTIONS.map((opt) => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    role="radio"
                                    aria-checked={fontSize === opt.value}
                                    className={cn('pr-segmented-item', fontSize === opt.value && 'is-active')}
                                    onClick={() => setFontSize(opt.value)}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 减少动画 —— B4.2 新拟态开关 */}
                    <div className="pr-settings-row">
                        <div className="pr-settings-row-label">
                            <Icon name="sparkle" size={14} />
                            <span>减少动画</span>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={reduceMotion}
                            aria-label="减少动画开关"
                            className={cn('pr-neu-switch', reduceMotion && 'is-on')}
                            onClick={() => setReduceMotion(!reduceMotion)}
                        >
                            <span className="pr-neu-switch-thumb" />
                        </button>
                    </div>

                    <div className="pr-settings-hint">
                        设置会自动保存，刷新后仍然生效
                    </div>

                    {/* ── 模型接入 ──
                        与上方「显示设置」之间用松带分隔：两者分属不同语义域，
                        一个是本机偏好，一个是会影响全系统 AI 能力的服务端配置。 */}
                    <div className="pr-settings-section-divider" />
                    <div className="pr-settings-title">模型接入</div>
                    <p className="pr-settings-section-desc">
                        配置各家大模型的 API Key。保存后立即生效，无需重启服务。
                    </p>
                    <ModelCredentials />

                    <MemoryGovernancePanel />

                    <button
                        type="button"
                        className="pr-settings-logout pr-settings-legal"
                        onClick={() => {
                            setOpen(false)
                            navigate('/privacy')
                        }}
                    >
                        <Icon name="shield-check" size={14} />
                        <span>隐私政策与用户协议</span>
                    </button>

                    {/* 退出登录 */}
                    <button
                        type="button"
                        className="pr-settings-logout"
                        onClick={() => {
                            void logoutSession()
                                .catch(() => {
                                    // 后端离线时仍清除本地缓存；服务器会话按 TTL 自行失效。
                                })
                                .finally(() => {
                                    logout()
                                    navigate('/login', { replace: true })
                                })
                        }}
                    >
                        <Icon name="arrow-square-out" size={14} />
                        <span>退出登录</span>
                    </button>
                </div>
            )}
        </div>
    )
}
