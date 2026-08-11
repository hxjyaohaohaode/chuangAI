import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { getGroupsForRole, getDefaultRoute, isRouteAllowed } from '@/config/nav'
import { Icon, type IconName } from '@/components/ui/Icon'
import { SidebarResizer } from '@/components/ui/SidebarResizer'
import { PerformanceMonitor } from '@/components/dev'
import { cn } from '@/lib/cn'
import { matchesMediaQuery } from '@/lib/media-query'
import { useRouteDirection } from '@/hooks/useRouteDirection'
import { captureFlipRects, playFlipEnter } from '@/lib/flip'
import { ImmersiveShell } from './ImmersiveShell'
import './AppShell.css'

const QueryCommandPalette = lazy(() => import('@/components/ui/QueryCommandPalette'))

/**
 * localStorage key —— 与 SidebarResizer 内部 STORAGE_KEY 保持一致
 * 用于初始化 sidebarWidth 状态（拖拽中实时同步由 SidebarResizer 负责） */
const SIDEBAR_WIDTH_STORAGE_KEY = 'poetic-realm.sidebar-width'
const SIDEBAR_WIDTH_DEFAULT = 280

/**
 * AppShell 流体布局外壳（v9 纯教师端 + 规范第 8、5.4 章）
 *
 * v9 变更：
 * - 移除学生端，专注教师全流程
 * - 从 auth store 读取 role，按角色过滤可见导航项
 * - 导航按 group 字段分组渲染，显示分组标题
 * - 路由守卫：角色无权访问的路由自动重定向到默认页
 *
 * classic 模式：左侧 sidebar（分组导航）+ 右侧主内容
 * immersive 模式：全屏沉浸 + 玻璃返回胶囊 + 左滑抽屉导航
 */

export type AppShellVariant = 'classic' | 'immersive'

export interface NavItem {
    key: string
    label: string
    /** 图标名称（支持核心注册表与扩展注册表，规范第 13 章） */
    icon: IconName | (string & {})
    to: string
    /** v8 角色分离：该项对哪个角色可见 */
    role?: 'teacher' | 'student' | 'both'
    /** v8 分组：该项属于哪个导航分组 */
    group?: string
}

export interface AppShellProps {
    /** 顶部标题 */
    title?: ReactNode
    /** 侧边栏导航项（全量，AppShell 内部按 role 过滤） */
    nav?: readonly NavItem[]
    /** 当前激活导航 key */
    activeNav?: string
    /** 导航点击回调 */
    onNavigate?: (item: NavItem) => void
    /** 右上角操作区 */
    headerExtra?: ReactNode
    /** 主内容 */
    children?: ReactNode
    /** 品牌标识 */
    brand?: ReactNode
    /** 布局变体（B4.1，默认 classic） */
    variant?: AppShellVariant
    /** immersive 模式返回胶囊回调（默认 navigate(-1)） */
    onBack?: () => void
}

// ─────────────────────────────────────────────────────────────
// 分组导航渲染
// ─────────────────────────────────────────────────────────────

interface GroupedNavProps {
    nav: readonly NavItem[]
    activeNav?: string
    onNavigate: (item: NavItem) => void
    collapsed: boolean
    role: 'teacher' | 'student'
}

function GroupedNav({ nav, activeNav, onNavigate, collapsed, role }: GroupedNavProps) {
    // 获取当前角色可见的分组
    const groups = useMemo(() => getGroupsForRole(role), [role])

    // 按分组组织导航项
    const groupedNav = useMemo(() => {
        const map = new Map<string, NavItem[]>()
        for (const item of nav) {
            const groupKey = item.group ?? 'default'
            if (!map.has(groupKey)) map.set(groupKey, [])
            map.get(groupKey)!.push(item)
        }
        return map
    }, [nav])

    return (
        <>
            {groups.map((group) => {
                const items = groupedNav.get(group.key) ?? []
                if (items.length === 0) return null
                return (
                    <div key={group.key} className="pr-sidebar-nav-group">
                        {!collapsed && (
                            <div className="pr-sidebar-group-label">{group.label}</div>
                        )}
                        {items.map((item) => (
                            <a
                                key={item.key}
                                href={item.to}
                                className={cn(
                                    'pr-sidebar-nav-item',
                                    activeNav === item.key && 'is-active',
                                )}
                                onClick={(e) => {
                                    e.preventDefault()
                                    onNavigate(item)
                                }}
                                aria-current={activeNav === item.key ? 'page' : undefined}
                                aria-label={collapsed ? item.label : undefined}
                                title={collapsed ? item.label : undefined}
                            >
                                <Icon name={item.icon} size={20} active={activeNav === item.key} />
                                <span className="pr-sidebar-nav-label">{item.label}</span>
                            </a>
                        ))}
                    </div>
                )
            })}
        </>
    )
}

// ─────────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────────

export function AppShell({
    title,
    nav = [],
    activeNav,
    onNavigate,
    headerExtra,
    children,
    brand,
    variant = 'classic',
    onBack,
}: AppShellProps) {
    const collapsed = useUiStore((s) => s.sidebarCollapsed)
    const toggle = useUiStore((s) => s.toggleSidebar)
    const location = useLocation()
    const navigate = useNavigate()
    const { direction } = useRouteDirection()
    const [scrolled, setScrolled] = useState(false)
    const [showExitMask, setShowExitMask] = useState(false)
    const [isMobile, setIsMobile] = useState(
        () => matchesMediaQuery('(max-width: 767px)'),
    )
    const [mobileNavOpen, setMobileNavOpen] = useState(false)
    // 侧边栏宽度（仅桌面端生效）：从 localStorage 初始化，拖拽时实时更新
    // 折叠态使用 CSS .pr-sidebar--collapsed 的 var(--sidebar-collapsed)，不应用此宽度
    const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
        try {
            const stored = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
            const parsed = stored ? parseInt(stored, 10) : NaN
            // 边界保护：若 localStorage 中是异常值（NaN / 越界），回落到默认 280px
            if (!Number.isFinite(parsed)) return SIDEBAR_WIDTH_DEFAULT
            return Math.min(Math.max(parsed, 200), 640)
        } catch {
            return SIDEBAR_WIDTH_DEFAULT
        }
    })
    const contentRef = useRef<HTMLElement | null>(null)
    const lastPathRef = useRef<string>(location.pathname)
    // P0-D1：路由离场动画——延迟卸载，保留旧内容播放 opacity 1→0 + scale 1→0.98 离场过渡（规范 6.4 / 8.3）
    // 路径变化时：旧 displayChildren 持续渲染 200ms 并应用 pr-route--leaving 类播放离场动画
    // 200ms 后：切换为新 children，key 变化触发 React 重挂载，入场动画自然播放
    const [displayChildren, setDisplayChildren] = useState<ReactNode>(children)
    const [displayPath, setDisplayPath] = useState<string>(location.pathname)
    const [isLeaving, setIsLeaving] = useState(false)
    const prevPathRef = useRef<string>(location.pathname)
    // isLeavingRef：避免 isLeaving 进入 useEffect 依赖导致循环触发，用 ref 在同步代码中读取最新值
    const isLeavingRef = useRef(false)

    // v8 角色分离：从 auth store 读取 role
    const role = useAuthStore((s) => s.role)

    // Command Palette 状态（Task 3 重做：Cmd+K / Ctrl+K 全局唤起）
    const [cmdOpen, setCmdOpen] = useState(false)

    // 全局快捷键：Cmd+K（macOS）/ Ctrl+K（Windows）切换 Command Palette
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault()
                setCmdOpen((prev) => !prev)
            }
        }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [])

    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return
        const media = window.matchMedia('(max-width: 767px)')
        const sync = () => {
            setIsMobile(media.matches)
            if (!media.matches) setMobileNavOpen(false)
        }
        sync()
        if (typeof media.addEventListener === 'function') {
            media.addEventListener('change', sync)
            return () => media.removeEventListener('change', sync)
        }
        if (typeof media.addListener === 'function') {
            media.addListener(sync)
            return () => media.removeListener(sync)
        }
        return undefined
    }, [])

    // v8 角色过滤：仅显示当前角色可见的导航项
    const visibleNav = useMemo(() => {
        // 如果传入的 nav 已经是过滤后的（如 CommandPalette），直接用
        // 否则按 role 过滤
        const hasRoleField = nav.some((item) => item.role !== undefined)
        if (!hasRoleField) return nav
        return nav.filter((item) => !item.role || item.role === role || item.role === 'both')
    }, [nav, role])

    // v8 路由守卫：当前角色无权访问的路由重定向到默认页
    useEffect(() => {
        if (!isRouteAllowed(location.pathname, role)) {
            navigate(getDefaultRoute(role), { replace: true })
        }
    }, [location.pathname, role, navigate])

    // 监听主内容滚动，48px 后切换 header 玻璃态
    useEffect(() => {
        let previous = window.scrollY > 48
        const onScroll = () => {
            const next = window.scrollY > 48
            if (next === previous) return
            previous = next
            setScrolled(next)
        }
        setScrolled(previous)
        window.addEventListener('scroll', onScroll, { passive: true })
        return () => window.removeEventListener('scroll', onScroll)
    }, [])

    // P0-D1：路由离场动画——延迟卸载，让旧内容播放 opacity 1→0 + scale 1→0.98 离场过渡（规范 6.4 / 8.3）
    // 路径变化时：保留旧 displayChildren 播放离场动画，200ms 后切换为新 children 并触入场
    // 路径未变时：同步更新 displayChildren（页面内部状态变化的实时反映）
    useEffect(() => {
        if (location.pathname === prevPathRef.current) {
            // 路径未变且不在离场中：同步更新 displayChildren
            if (!isLeavingRef.current) {
                setDisplayChildren(children)
            }
            return
        }

        // 路由变化：触发离场动画
        isLeavingRef.current = true
        setIsLeaving(true)

        // 200ms 后切换内容并触发入场
        const switchT = window.setTimeout(() => {
            setDisplayChildren(children)
            setDisplayPath(location.pathname)
            setIsLeaving(false)
            isLeavingRef.current = false
            prevPathRef.current = location.pathname
        }, 200) // 200ms 离场（规范 6.4 / 8.3：ease-in 200ms）

        return () => window.clearTimeout(switchT)
    }, [location.pathname, children])

    // 路由切换：displayPath 变化时（即 200ms 延迟后内容切换），触发遮罩 + FLIP 入场
    // L-P1-8：遮罩时长 200ms → 350ms，与路由过渡 var(--dur-route) 一致
    useEffect(() => {
        if (displayPath === lastPathRef.current) return
        setShowExitMask(true)
        const t = window.setTimeout(() => setShowExitMask(false), 350)
        const raf = requestAnimationFrame(() => {
            playFlipEnter(contentRef.current)
        })
        lastPathRef.current = displayPath
        return () => {
            window.clearTimeout(t)
            cancelAnimationFrame(raf)
        }
    }, [displayPath])

    // 统一导航处理：先捕获 FLIP rects，再触发回调
    const handleNavigate = (item: NavItem) => {
        captureFlipRects(contentRef.current)
        setMobileNavOpen(false)
        onNavigate?.(item)
    }

    // —— immersive 模式：委托给 ImmersiveShell ——
    if (variant === 'immersive') {
        return (
            <>
                <ImmersiveShell
                    nav={visibleNav}
                    activeNav={activeNav}
                    onNavigate={handleNavigate}
                    onBack={onBack}
                    title={title}
                    headerExtra={headerExtra}
                    contentRef={contentRef}
                >
                    <div key={displayPath} className={cn('pr-route', isLeaving && 'pr-route--leaving')} data-direction={direction}>
                        {displayChildren}
                    </div>
                    {showExitMask && <div className="pr-route-exit-mask" aria-hidden />}
                    {import.meta.env.DEV && <PerformanceMonitor defaultExpanded={false} />}
                </ImmersiveShell>
                {cmdOpen && (
                    <Suspense fallback={null}>
                        <QueryCommandPalette
                            open
                            onClose={() => setCmdOpen(false)}
                            onNavigate={(path) => {
                                navigate(path)
                                setCmdOpen(false)
                            }}
                        />
                    </Suspense>
                )}
            </>
        )
    }

    // —— classic 模式：分组 sidebar + main 结构 ——
    return (
        <>
            <div className="pr-shell">
                {isMobile && mobileNavOpen && (
                    <button
                        type="button"
                        className="pr-sidebar-overlay"
                        aria-label="关闭主导航"
                        onClick={() => setMobileNavOpen(false)}
                    />
                )}
                <aside
                    className={cn(
                        'pr-sidebar',
                        collapsed && !isMobile && 'pr-sidebar--collapsed',
                        isMobile && mobileNavOpen && 'is-mobile-open',
                    )}
                    style={
                        !isMobile && !collapsed
                            ? ({ width: `${sidebarWidth}px` } as CSSProperties)
                            : undefined
                    }
                >
                    <div className="pr-sidebar-brand">
                        <span className="pr-sidebar-brand-mark">
                            <Icon name="feather" size={26} weight="bold" />
                        </span>
                        {brand ?? <span className="pr-sidebar-brand-text">诗脉·启明</span>}
                    </div>

                    <nav className="pr-sidebar-nav" aria-label="主导航">
                        <GroupedNav
                            nav={visibleNav}
                            activeNav={activeNav}
                            onNavigate={handleNavigate}
                            collapsed={isMobile ? false : collapsed}
                            role={role}
                        />
                    </nav>

                    <button
                        className="pr-sidebar-toggle"
                        onClick={() => isMobile ? setMobileNavOpen(false) : toggle()}
                        aria-label={isMobile ? '关闭主导航' : collapsed ? '展开侧边栏' : '折叠侧边栏'}
                        type="button"
                    >
                        <Icon name={isMobile ? 'x' : collapsed ? 'caret-right' : 'caret-left'} size={18} />
                    </button>

                    {/* 侧边栏宽度可调节手柄（移动端 SidebarResizer 内部 return null） */}
                    <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />
                </aside>

                <div className="pr-main">
                    <header className={cn('pr-header', scrolled && 'is-scrolled')}>
                        <button
                            type="button"
                            className="pr-mobile-nav-trigger"
                            aria-label="打开主导航"
                            aria-expanded={mobileNavOpen}
                            onClick={() => setMobileNavOpen(true)}
                        >
                            <Icon name="list" size={22} />
                        </button>
                        {title && <div className="pr-header-title">{title}</div>}
                        <div className="pr-header-actions">
                            {headerExtra}
                        </div>
                    </header>

                    <main className="pr-content" id="pr-main-content" tabIndex={-1} ref={contentRef}>
                        <div key={displayPath} className={cn('pr-route', isLeaving && 'pr-route--leaving')} data-direction={direction}>
                            {displayChildren}
                        </div>
                        {showExitMask && <div className="pr-route-exit-mask" aria-hidden />}
                    </main>

                    <footer className="pr-footer">
                        <div className="pr-footer-inner">
                            <span className="pr-footer-copyright">
                                诗脉·启明 PoeticRealm AI v5.0 · 异构多智能体古诗词复习系统
                            </span>
                            <nav className="pr-footer-nav" aria-label="页脚导航">
                                <a
                                    href="/privacy"
                                    className="pr-footer-link"
                                    onClick={(e) => {
                                        e.preventDefault()
                                        captureFlipRects(contentRef.current)
                                        navigate('/privacy')
                                    }}
                                >
                                    <Icon name="shield-check" size={13} />
                                    <span>隐私政策与用户协议</span>
                                </a>
                            </nav>
                        </div>
                    </footer>
                </div>
                {import.meta.env.DEV && <PerformanceMonitor defaultExpanded={false} />}
            </div>
            {cmdOpen && (
                <Suspense fallback={null}>
                    <QueryCommandPalette
                        open
                        onClose={() => setCmdOpen(false)}
                        onNavigate={(path) => {
                            navigate(path)
                            setCmdOpen(false)
                        }}
                    />
                </Suspense>
            )}
        </>
    )
}
