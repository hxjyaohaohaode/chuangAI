import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { BrowserRouter, Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom'
import { Icon, ErrorBoundary, SyncProgressBar, OfflineBanner } from '@/components/ui'
import { AppShell } from '@/components/layout/AppShell'
import { NAV, getVariantForPath, getDefaultRoute } from '@/config/nav'
import { useAuthStore } from '@/stores/auth'
import { wsDispatcher } from '@/lib/ws-dispatcher'
import { crossTabSync } from '@/lib/cross-tab-sync'
import { useDemoModeStore } from '@/lib/demo-mode'
import { getAuthStatus } from '@/lib/auth-session'
import type { ProactiveAlert, ProactiveTargetType } from '@/lib/types'
// 全部页面懒加载（路由级代码分割），降低首屏 JS 体积
// 首屏仅加载 AppShell + 基础 UI + 当前路由对应的页面 chunk
function queryPage(loader: () => Promise<{ default: ComponentType }>) {
    return lazy(async () => {
        const [pageModule, queryModule] = await Promise.all([
            loader(),
            import('@/components/providers/QueryProvider'),
        ])
        return { default: queryModule.withQueryProvider(pageModule.default) }
    })
}

const DashboardPage = queryPage(() => import('@/pages/DashboardPage/DashboardPage'))
const ClassroomPage = lazy(() => import('@/pages/ClassroomPage/ClassroomPage'))
const LessonPlanPage = lazy(() =>
    import('@/pages/LessonPlanPage/LessonPlanPage').then((m) => ({ default: m.LessonPlanPage })),
)
const WorkbenchPage = queryPage(() => import('@/pages/WorkbenchPage/WorkbenchPage'))

// spec v7 Dashboard 重构：认知诊断合并到 Dashboard 诊断 tab，教研报告保留独立路由
// /diagnosis-report 和 /diagnosis 重定向到 /dashboard?tab=diagnosis
const ReportPage = queryPage(() => import('@/pages/ReportPage/ReportPage'))

const CultureContextPage = queryPage(() => import('@/pages/CultureContextPage/CultureContextPage'))

// v7 审计修复 P0-A1：恢复 6 个已完整实现的功能页面路由
// 之前误指向 DevPage 占位页导致功能完全不可用（用户反馈"页面完全不能用"根因）
const StarMapPage = lazy(() =>
    import('@/pages/StarMapPage/StarMapPage').then((m) => ({ default: m.StarMapPage })),
)
const GradingPage = queryPage(() => import('@/pages/GradingPage/GradingPage'))
const CreationStudioPage = lazy(() => import('@/pages/CreationStudioPage/CreationStudioPage'))
const AICopilotPage = queryPage(() => import('@/pages/AICopilotPage/AICopilotPage'))

// v5.0 创新可视化页面：进化之眼基因谱 + 思考宫殿 3D 链
const EvolutionEyePage = lazy(() => import('@/pages/EvolutionEyePage/EvolutionEyePage'))
const ThinkingPalacePage = queryPage(() => import('@/pages/ThinkingPalacePage/ThinkingPalacePage'))

// 合规页面懒加载（Task 28.4：隐私政策与用户协议）
const PrivacyPage = lazy(() => import('@/pages/PrivacyPage/PrivacyPage'))

// 404 兜底页面懒加载（B3.1：智能推荐 + 遥测）
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage/NotFoundPage'))

// 403 权限拦截页面懒加载（B3.5：认证流程 + 403 页面）
const ForbiddenPage = lazy(() => import('@/pages/ForbiddenPage/ForbiddenPage'))

// v7 审计修复 P0-A1：DevPage 占位页已删除（6 个功能页面已恢复真实路由，不再需要占位页）

// 教师登录页（认证入口，独立于 AppShell）
const LoginPage = lazy(() => import('@/pages/LoginPage/LoginPage'))

// 公开分享页必须在 DemoApp 认证树之外精确挂载；只有这一条
// 路由可以绕过登录，其他未知路径仍进入原有失败关闭的认证守卫。
const SharedReportPage = lazy(() => import('@/pages/SharedReportPage/SharedReportPage'))

// 通知、模型设置和思考强度均不是首屏主任务；延迟加载并保留固定宽度占位，
// 减少初始 modulepreload，同时避免工具到达时引发顶栏布局偏移。
const HeaderTools = lazy(() => import('@/components/layout/HeaderTools'))
const ToastContainer = lazy(() =>
    import('@/components/ui/Toast').then((module) => ({ default: module.ToastContainer })),
)
const DevTools = import.meta.env.DEV
    ? lazy(() => import('@/components/dev').then((module) => ({ default: module.DevTools })))
    : null

// 开发展厅必须连动态 import 一起受 DEV 常量守卫。仅在 Route 外层加条件会让
// Rollup 仍生成生产 chunk，造成隐藏调试代码进入发布包。
const VisualShowcase = import.meta.env.DEV
    ? lazy(() => import('@/pages/_dev/VisualShowcase'))
    : null
const ScriptsPage = import.meta.env.DEV
    ? lazy(() => import('@/pages/_dev/ScriptsPage'))
    : null

/**
 * 应用路由与导航配置
 *
 * 导航分组：
 * - 教学核心：驾驶舱 / 星图 / 认知诊断
 * - 备课授课：教案工坊 / 命题工坊 / 课堂导播 / 智能批改
 * - AI 协作：AI 副驾
 * - 文化沉淀：文化语境
 * - 教研沉淀：教研报告
 *
 * NAV 与 getVariantForPath 已提取至 @/config/nav（B3.1：404 兜底路由共享真相源）
 */

/**
 * 路由标题映射（WCAG 2.4.2 Page Titled A 级）
 *
 * 路由切换时 document.title 会更新为 `${title} · 诗脉·启明`，
 * 屏幕阅读器用户和浏览器标签页可识别当前页面。
 * classroom/:lessonId 通过前缀匹配处理。
 */
const ROUTE_TITLES: Record<string, string> = {
    '/dashboard': '教学驾驶舱',
    '/starmap': '诗词星图',
    '/lesson-plan': '教案工坊',
    '/workbench': '命题工坊',
    '/classroom': '课堂导播',
    '/grading': '智能批改',
    '/creation-studio': '创作迭代台',
    '/ai-copilot': 'AI 副驾',
    '/evolution-eye': '进化之眼',
    '/thinking-palace': '思考宫殿',
    '/culture': '文化语境',
    '/report': '教研报告',
    '/privacy': '隐私政策',
    '/forbidden': '无权访问',
    '/login': '教师登录',
}

// 顶栏在 390px 级别仍需优先呈现可辨识的中文主品牌。桌面保留完整中英名称，
// 辅助技术始终获得同一完整名称，避免用视觉截断替代品牌层级设计。
const APP_BRAND_ACCESSIBLE_NAME = '诗脉·启明 PoeticRealm AI v5.0'
const AppBrandTitle = () => (
    <span className="pr-header-brand-title">
        <span className="pr-header-brand-title__visible" aria-hidden="true">
            <span className="pr-header-brand-title__primary">诗脉·启明</span>
            <span className="pr-header-brand-title__secondary">PoeticRealm AI v5.0</span>
        </span>
        <span className="pr-sr-only">{APP_BRAND_ACCESSIBLE_NAME}</span>
    </span>
)

/** 懒加载页面统一 Suspense fallback。
 * 填满 Header 以下的内容区，避免真实页面加载时产生明显布局跳动。 */
function PageFallback() {
    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 56px)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-md)' }}>
                <Icon name="circle-notch" size={32} className="pr-app-spin" />
                <span style={{ color: 'rgb(var(--c-text-secondary))', fontSize: 'var(--text-sm)' }}>页面加载中…</span>
            </div>
        </div>
    )
}

/** v8 角色分离：根据当前角色重定向到默认落地页 */
function RoleRedirect() {
    const role = useAuthStore((s) => s.role)
    return <Navigate to={getDefaultRoute(role)} replace />
}

function DemoApp() {
    const navigate = useNavigate()
    const location = useLocation()
    const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
    const login = useAuthStore((s) => s.login)
    const logout = useAuthStore((s) => s.logout)
    const [sessionReady, setSessionReady] = useState(false)
    const activeKey = NAV.find((n) => n.to === location.pathname)?.key ?? 'dashboard'
    const variant = getVariantForPath(location.pathname)

    // localStorage 只作为离线演示缓存，不能成为在线身份真相源。每次应用启动都向
    // 服务器验证 HttpOnly 会话；401/过期事件统一清理浏览器状态并回到登录页。
    useEffect(() => {
        const controller = new AbortController()
        let active = true
        const onExpired = () => {
            if (!active) return
            logout()
            setSessionReady(true)
            navigate('/login', { replace: true })
        }
        window.addEventListener('pr:auth-expired', onExpired)
        void getAuthStatus(controller.signal)
            .then((status) => {
                if (!active) return
                if (status.authenticated && status.user) {
                    login({ id: status.user.id, name: status.user.name, role: status.user.role })
                } else {
                    logout()
                }
            })
            .catch(() => {
                // 验证服务不可达时默认失败关闭，绝不让伪造 localStorage 自动进入业务界面。
                if (active) logout()
            })
            .finally(() => {
                if (active) setSessionReady(true)
            })
        return () => {
            active = false
            controller.abort()
            window.removeEventListener('pr:auth-expired', onExpired)
        }
    }, [login, logout, navigate])

    // WCAG 2.4.2 Page Titled（A 级）：路由切换时动态设置 document.title
    // 屏幕阅读器在路由切换时朗读新标题，浏览器标签页/历史记录显示有意义的标题
    useEffect(() => {
        // 精确匹配优先，回退到前缀匹配（处理 /classroom/:lessonId 等动态路由）
        const title = ROUTE_TITLES[location.pathname]
            ?? Object.entries(ROUTE_TITLES).find(([prefix]) => location.pathname.startsWith(prefix + '/'))?.[1]
        if (title) {
            document.title = `${title} · 诗脉·启明`
        }
    }, [location.pathname])

    // 扩展图标由各懒加载页面在自身模块顶部 `import '@/components/ui/icons-extended'`
    // 引入，随该路由 chunk 一并到达，用到时必然已注册。
    //
    // 这里刻意**不再**做全局预加载：那样等于每个用户首屏都额外拉取 44KB(gzip)
    // 的图标包，而常驻 chrome 需要的图标已全部登记在 Icon.tsx 的核心表中。

    // v5.0 Task 3.3：初始化全局 WSDispatcher 单例
    // 整个应用共享一条 WebSocket 连接，通过 subscribe / subscribeStatus fan-out
    // 到各 Page 与 Store，替代 5 个页面各自创建独立 useWebSocket 的旧模式
    useEffect(() => {
        if (!sessionReady || !isAuthenticated) {
            wsDispatcher.disconnect()
            return
        }
        wsDispatcher.connect()
        return () => {
            wsDispatcher.disconnect()
        }
    }, [isAuthenticated, sessionReady])

    // P2 数据闭环：初始化跨 Tab 同步总线（规范 12.2 跨页面/Tab 同步 ≤ 200ms）
    // BroadcastChannel 优先，不支持时降级为 storage 事件
    // 通知中心、业务事件、鉴权状态在多 Tab 间实时同步
    useEffect(() => {
        crossTabSync.init()
        return () => {
            crossTabSync.destroy()
        }
    }, [])

    // P4 LLM 路由透明：订阅 llm:call:* 事件，转发到 llm-router store
    // llm:call:start/success/error 经 event-bridge 桥接到 WS
    // 此处仅注册一次全局监听，所有页面共享 llm-router store 状态
    useEffect(() => {
        let active = true
        let routerModule: Promise<typeof import('@/stores/llm-router')> | undefined
        const loadRouter = () => {
            routerModule ??= import('@/stores/llm-router').catch((error: unknown) => {
                routerModule = undefined
                throw error
            })
            return routerModule
        }
        const unsubLLM = wsDispatcher.subscribe((event) => {
            const isCallEvent = event.type.startsWith('llm:call:')
            const isThinkingModeEvent = event.type === 'thinking-mode:changed'
            if (!isCallEvent && !isThinkingModeEvent) return
            void loadRouter()
                .then(({ useLLMRouterStore }) => {
                    if (!active) return
                    const store = useLLMRouterStore.getState()
                    if (isCallEvent) store.handleWSEvent(event)
                    else store.handleThinkingModeWSEvent(event)
                })
                .catch(() => {
                    // 瞬时离线或 chunk 失败后允许下一条事件重新加载。
                })
        })
        return () => {
            active = false
            unsubLLM()
        }
    }, [])

    // P0-4 主动智能：订阅 proactive:* 事件，转发到 notifications + copilot store
    // 4 大主动智能场景通过 WS 推送：
    //   proactive:alert:mastery / proactive:alert:blindspot / proactive:suggestion / proactive:evolution
    // 此处统一转换 payload → AppNotification（severity 映射）+ pushProactiveAlert，
    // 并按 targetType 路由 linkTo（student→/grading, class→/dashboard, agent→/ai-copilot）
    useEffect(() => {
        let active = true
        let proactiveStores: Promise<[
            typeof import('@/stores/copilot'),
            typeof import('@/stores/notifications'),
        ]> | undefined
        const loadProactiveStores = () => {
            proactiveStores ??= Promise.all([
                import('@/stores/copilot'),
                import('@/stores/notifications'),
            ]).catch((error: unknown) => {
                proactiveStores = undefined
                throw error
            })
            return proactiveStores
        }
        const unsubProactive = wsDispatcher.subscribe((event) => {
            if (!event.type.startsWith('proactive:')) return
            const alert = event.payload as ProactiveAlert
            if (!alert || typeof alert.severity !== 'string') return
            void loadProactiveStores()
                .then(([{ useCopilotStore }, { useNotificationStore }]) => {
                    if (!active) return
                    // 1. 推送到 copilot store（让 AI 副驾感知主动建议）
                    useCopilotStore.getState().pushProactiveAlert(alert)

                    // 2. 转换为 AppNotification 并推送到通知中心
                    const severityMap: Record<string, 'info' | 'warning' | 'error'> = {
                        info: 'info',
                        warning: 'warning',
                        critical: 'error',
                    }
                    const notifType = severityMap[alert.severity] ?? 'info'
                    const linkMap: Record<ProactiveTargetType, string> = {
                        student: '/grading',
                        class: '/dashboard',
                        agent: '/ai-copilot',
                    }
                    useNotificationStore.getState().push({
                        type: notifType,
                        title: alert.title,
                        description: alert.description,
                        linkTo: linkMap[alert.targetType] ?? '/dashboard',
                    })
                })
                .catch(() => {
                    // 保留下一事件的重试机会；不得用伪通知掩盖真实加载失败。
                })
        })
        return () => {
            active = false
            unsubProactive()
        }
    }, [])

    // v5.0 Task 5.8：启动 DEMO 模式心跳检测 + 同步 WS 状态
    // - 心跳检测：定期 GET /api/health，连续失败 2 次进入 DEMO 模式
    // - WS 状态同步：WS 错误作为 DEMO 模式辅助信号
    // - 应用卸载时停止心跳，避免内存泄漏
    useEffect(() => {
        const demoStore = useDemoModeStore.getState()
        demoStore.startHeartbeat()
        // 订阅 WS 状态变化，同步到 demo-mode（WS 错误作为辅助信号）
        const unsubStatus = wsDispatcher.subscribeStatus((status) => {
            demoStore.syncWithWSStatus(status)
        })
        return () => {
            demoStore.stopHeartbeat()
            unsubStatus()
        }
    }, [])

    // v5.0 Task 5.8：DEMO 模式退出后自动重连 WebSocket
    // - 进入 DEMO 模式时 WSDispatcher.scheduleReconnect 会停止重连
    // - 退出 DEMO 模式（后端恢复）时需要手动触发重连
    // - 仅在 isDemoMode 从 true → false 变化时触发，避免首次挂载时误触发
    const isDemoMode = useDemoModeStore((s) => s.isDemoMode)
    const prevDemoModeRef = useRef(false)
    useEffect(() => {
        const wasDemo = prevDemoModeRef.current
        prevDemoModeRef.current = isDemoMode
        // 仅在从 DEMO 模式退出（true → false）时重连 WS
        if (wasDemo && !isDemoMode) {
            if (wsDispatcher.getStatus() !== 'connected') {
                wsDispatcher.disconnect()
                wsDispatcher.connect()
            }
        }
    }, [isDemoMode])

    // v8 角色分离：当前用户角色（AppShell 内部用于导航过滤与权限守卫）
    const role = useAuthStore((s) => s.role)

    // 在服务器会话检查完成前不渲染缓存身份对应的业务界面，阻断 localStorage 伪造闪现。
    if (!sessionReady) return <PageFallback />

    // 认证守卫：未登录时仅渲染登录页，阻止访问任何业务路由
    if (!isAuthenticated) {
        return (
            <Suspense fallback={<PageFallback />}>
                <Routes>
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="*" element={<Navigate to="/login" replace />} />
                </Routes>
            </Suspense>
        )
    }

    return (
        <>
            {/* B6.1: Skip-to-content 链接（WCAG 2.1 SC 2.4.1 跳过块）
                键盘用户按 Tab 首先聚焦此链接，回车后跳过 sidebar直达主内容 */}
            <a href="#pr-main-content" className="pr-skip-link">
                跳到主内容
            </a>
            <SyncProgressBar active={false} />
            <OfflineBanner />
            <AppShell
                title={<AppBrandTitle />}
                nav={NAV}
                activeNav={activeKey}
                onNavigate={(item) => navigate(item.to)}
                variant={variant}
                headerExtra={
                    <Suspense
                        fallback={(
                            <span
                                className={`pr-header-tools-placeholder pr-header-tools-placeholder--${role}`}
                                aria-hidden="true"
                            />
                        )}
                    >
                        <HeaderTools role={role} />
                    </Suspense>
                }
            >
                <ErrorBoundary resetKeys={[location.pathname]}>
                    <Suspense fallback={<PageFallback />}>
                        <Routes>
                            {/* v8 角色分离：默认重定向到当前角色落地页 */}
                            <Route path="/" element={<RoleRedirect />} />
                            {/* 教学核心 */}
                            <Route path="/dashboard" element={<DashboardPage />} />
                            {/* v7 审计修复 P0-A1：恢复 6 个已完整实现的功能页面 */}
                            <Route path="/starmap" element={<StarMapPage />} />
                            {/* spec v7 Dashboard 重构：/diagnosis-report + /diagnosis 重定向到 Dashboard 诊断 tab */}
                            <Route path="/diagnosis-report" element={<Navigate to="/dashboard?tab=diagnosis" replace />} />
                            <Route path="/diagnosis" element={<Navigate to="/dashboard?tab=diagnosis" replace />} />
                            {/* 备课授课 */}
                            <Route path="/lesson-plan" element={<LessonPlanPage />} />
                            <Route path="/workbench" element={<WorkbenchPage />} />
                            <Route path="/classroom" element={<ClassroomPage />} />
                            <Route path="/classroom/:lessonId" element={<ClassroomPage />} />
                            <Route path="/grading" element={<GradingPage />} />
                            <Route path="/creation-studio" element={<CreationStudioPage />} />
                            {/* AI 协作 */}
                            <Route path="/ai-copilot" element={<AICopilotPage />} />
                            {/* v5.0 创新可视化：进化之眼基因谱 + 思考宫殿 3D 链 */}
                            <Route path="/evolution-eye" element={<EvolutionEyePage />} />
                            <Route path="/thinking-palace" element={<ThinkingPalacePage />} />
                            {/* 文化沉淀 */}
                            <Route path="/culture" element={<CultureContextPage />} />
                            {/* 教研沉淀 —— spec v7：教研报告独立路由（原 /diagnosis-report 拆分后保留） */}
                            <Route path="/report" element={<ReportPage />} />
                            {/* 合规页面（不在侧边栏导航，通过 Footer 入口访问） */}
                            <Route path="/privacy" element={<PrivacyPage />} />
                            {/* 403 权限拦截路由（B3.5：认证流程 + 403 页面 + 身份切换） */}
                            <Route path="/forbidden" element={<ForbiddenPage />} />
                            {/* 视觉创新层组件展示（仅开发环境渲染，规范：DEV 守卫） */}
                            {VisualShowcase && (
                                <Route path="/dev/visual" element={<VisualShowcase />} />
                            )}
                            {/* 工程保障层 - 剧本矩阵（仅开发环境，路由 /dev/scripts） */}
                            {ScriptsPage && (
                                <Route path="/dev/scripts" element={<ScriptsPage />} />
                            )}
                            {/* 404 兜底路由（B3.1：智能推荐 + 遥测 + Levenshtein 路径匹配） */}
                            <Route path="*" element={<NotFoundPage />} />
                        </Routes>
                    </Suspense>
                </ErrorBoundary>
            </AppShell>
            {/* Command Palette 已迁移至 AppShell 内部（Task 3 重做，由 AppShell 统一管理快捷键 + 状态） */}
            {/* 工程保障层：仅在开发环境渲染 DevTools 聚合组件
                含 DegradationIndicator / PerformanceMonitor / SessionRecorder / SessionPlayer
                生产构建时 Vite tree-shaking 会移除整个 dev 模块 */}
            {DevTools && (
                <Suspense fallback={null}>
                    <DevTools />
                </Suspense>
            )}
        </>
    )
}

/** 认证侧通知状态不挂入匿名公开页，避免同一 SPA 会话残留的内部提示外露。 */
function PrivateApplication() {
    return (
        <>
            <DemoApp />
            <Suspense fallback={null}>
                <ToastContainer />
            </Suspense>
        </>
    )
}

/* ---------- 根组件 ---------- */

function App() {
    return (
        <BrowserRouter>
            <Routes>
                <Route
                    path="/shared/report/:token"
                    element={(
                        <ErrorBoundary resetKeys={['shared-report']}>
                            <Suspense fallback={<PageFallback />}>
                                <SharedReportPage />
                            </Suspense>
                        </ErrorBoundary>
                    )}
                />
                <Route path="*" element={<PrivateApplication />} />
            </Routes>
        </BrowserRouter>
    )
}

export default App
