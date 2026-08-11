import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUiStore } from '@/stores/ui'
import { Icon } from '@/components/ui/Icon'
import { cn } from '@/lib/cn'
import { captureFlipRects } from '@/lib/flip'
import type { NavItem } from './AppShell'

/**
 * ImmersiveShell 沉浸式外壳（B4.1：immersive 模式专用）
 *
 * 设计依据：
 * - 规范 3.1 反模板化：无 sidebar、无传统 header，全屏沉浸
 * - 规范 4.2 玻璃质感：返回胶囊 + 抽屉均采用 backdrop-blur 24px + 78% 不透明度
 * - 反模板化宣言：抽屉从「右侧」滑入（非左侧），打破常规
 * - 规范 6.2 Spring 物理：抽屉滑入用 ease-out 过渡
 * - 规范 9.3 可访问性：焦点陷阱 + Esc 关闭 + aria-modal
 *
 * 用于：StarMapPage / ClassroomPage / PrivacyPage
 */

export interface ImmersiveShellProps {
    nav: readonly NavItem[]
    activeNav?: string
    onNavigate?: (item: NavItem) => void
    /** 返回回调，默认 navigate(-1) */
    onBack?: () => void
    /** 当前页面标题（显示在返回胶囊中） */
    title?: ReactNode
    /** 主内容 */
    children?: ReactNode
    /** 右上角操作区（NotificationCenter 等） */
    headerExtra?: ReactNode
    /** FLIP 内容容器引用（共享元素过渡） */
    contentRef?: React.RefObject<HTMLElement | null>
}

export function ImmersiveShell({
    nav,
    activeNav,
    onNavigate,
    onBack,
    title,
    children,
    headerExtra,
    contentRef,
}: ImmersiveShellProps) {
    const navigate = useNavigate()
    const reduceMotion = useUiStore((s) => s.reduceMotion)
    const [drawerOpen, setDrawerOpen] = useState(false)
    const drawerRef = useRef<HTMLDivElement | null>(null)
    const menuBtnRef = useRef<HTMLButtonElement | null>(null)

    const closeDrawer = useCallback(() => {
        setDrawerOpen(false)
        // 遮罩不是可聚焦控件；关闭后始终回到打开抽屉的菜单，避免焦点留在离屏导航内。
        window.requestAnimationFrame(() => {
            menuBtnRef.current?.focus({ preventScroll: true })
        })
    }, [])

    const handleBack = () => {
        if (onBack) onBack()
        else navigate(-1)
    }

    const handleNavigate = (item: NavItem) => {
        if (contentRef?.current) captureFlipRects(contentRef.current)
        setDrawerOpen(false)
        onNavigate?.(item)
    }

    // Esc 关闭抽屉 + 焦点陷阱
    useEffect(() => {
        if (!drawerOpen) return

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                closeDrawer()
                return
            }
            // 焦点陷阱：Tab 循环
            if (e.key === 'Tab' && drawerRef.current) {
                const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
                    'button, a, [tabindex]:not([tabindex="-1"])',
                )
                if (focusable.length === 0) return
                const first = focusable[0]
                const last = focusable[focusable.length - 1]
                if (!first || !last) return
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault()
                    last.focus()
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault()
                    first.focus()
                }
            }
        }

        document.addEventListener('keydown', handleKeyDown)
        // 打开时聚焦抽屉第一个元素
        const t = window.setTimeout(() => {
            const first = drawerRef.current?.querySelector<HTMLElement>('button, a')
            first?.focus()
        }, 50)

        return () => {
            document.removeEventListener('keydown', handleKeyDown)
            window.clearTimeout(t)
        }
    }, [drawerOpen, closeDrawer])

    // 抽屉打开时阻止 body 滚动
    useEffect(() => {
        if (drawerOpen) {
            const prev = document.body.style.overflow
            document.body.style.overflow = 'hidden'
            return () => {
                document.body.style.overflow = prev
            }
        }
        return undefined
    }, [drawerOpen])

    return (
        <div className="pr-immersive">
            <main
                className="pr-immersive-content"
                id="pr-main-content"
                tabIndex={-1}
                ref={contentRef as RefObject<HTMLElement> | undefined}
            >
                {children}
            </main>

            {/* 左上角玻璃返回胶囊（规范 4.2） */}
            <button
                type="button"
                className="pr-immersive-back"
                onClick={handleBack}
                aria-label={title ? `返回上一页（${title}）` : '返回上一页'}
            >
                <Icon name="caret-left" size={18} weight="bold" />
                {title && <span className="pr-immersive-back-title">{title}</span>}
            </button>

            {/* 右上角操作区 + 菜单按钮 */}
            <div className="pr-immersive-topright">
                {headerExtra && <div className="pr-immersive-extra">{headerExtra}</div>}
                <button
                    ref={menuBtnRef}
                    type="button"
                    className="pr-immersive-menu-btn"
                    onClick={() => setDrawerOpen((v) => !v)}
                    aria-label={drawerOpen ? '关闭导航菜单' : '打开导航菜单'}
                    aria-expanded={drawerOpen}
                    aria-controls="pr-immersive-drawer"
                >
                    <Icon name="list" size={20} />
                </button>
            </div>

            {/* 左滑抽屉遮罩 */}
            {drawerOpen && (
                <div
                    className="pr-immersive-drawer-overlay"
                    onClick={closeDrawer}
                    aria-hidden="true"
                />
            )}

            {/* 左滑抽屉（v5.0 Task 2.3：从左侧滑入，与 classic 侧边栏语义对齐） */}
            <aside
                id="pr-immersive-drawer"
                ref={drawerRef}
                className={cn('pr-immersive-drawer', drawerOpen && 'is-open')}
                role={drawerOpen ? 'dialog' : undefined}
                aria-modal={drawerOpen ? true : undefined}
                aria-hidden={drawerOpen ? undefined : true}
                aria-label="页面导航"
                style={{
                    transition: reduceMotion ? 'none' : `transform var(--dur-route) var(--ease-out)`,
                }}
            >
                <div className="pr-immersive-drawer-header">
                    <span className="pr-immersive-drawer-brand">诗脉·启明</span>
                    <button
                        type="button"
                        className="pr-immersive-drawer-close"
                        onClick={closeDrawer}
                        aria-label="关闭导航菜单"
                    >
                        <Icon name="x" size={18} />
                    </button>
                </div>
                <nav className="pr-immersive-drawer-nav" aria-label="主导航">
                    {nav.map((item) => (
                        <a
                            key={item.key}
                            href={item.to}
                            className={cn(
                                'pr-immersive-drawer-nav-item',
                                activeNav === item.key && 'is-active',
                            )}
                            onClick={(e) => {
                                e.preventDefault()
                                handleNavigate(item)
                            }}
                            aria-current={activeNav === item.key ? 'page' : undefined}
                        >
                            <Icon name={item.icon} size={20} active={activeNav === item.key} />
                            <span>{item.label}</span>
                        </a>
                    ))}
                </nav>
            </aside>
        </div>
    )
}
