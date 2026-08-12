/**
 * 教学驾驶舱页面（4-Tab 架构 —— spec v7 Dashboard 重构）
 *
 * Tab 结构：
 * 1. 仪表盘 —— 数据星云 Hero + Stats + Radar + WeeklyProgress + MagicBento + InnovationCard
 * 2. 诊断 —— DiagnosisPage（3 sub-tabs：班级诊断 / 学生诊断 / 学习路径）
 * 3. 建议 —— SuggestionPanel（教学调整建议，基于诊断数据 + AI 分析）
 * 4. 待办 —— AlertsPanel（实时预警列表）
 *
 * URL 参数 ?tab=dashboard|diagnosis|suggestion|alerts 保持可书签/可前进后退
 * classId/studentId 参数透传给诊断 tab 的 DiagnosisPage
 *
 * 数据流：
 * - useDashboardStore 提供 stats/radar/alerts/weeklyProgress + WS 状态 + 加载态
 * - useDiagnosisStore 提供 suggestionResponse + fetchTeachingSuggestions（建议 tab）
 * - useWSSubscription 订阅全局 wsDispatcher，事件回流至 store.handleWSEvent
 * - 挂载时从后端加载班级列表并默认选中第一个，触发 fetchAll 并行拉取
 *
 * 加载策略（规范第 12 章）：
 * - 首次加载（无 lastSyncedAt）显示骨架屏
 * - 后续刷新保留旧数据，不闪烁
 *
 * 设计要点（规范第 5、8 章）：
 * - 松紧得当：Tab 栏紧带，内容区间稳带
 * - 透明度分层：Tab 栏使用毛玻璃吸顶 + alpha 背景，无硬边框
 * - 响应式：1100px 断点切换单列，767px 进一步压缩
 * - 仅 transform/opacity 动画
 */

import { lazy, Suspense, useCallback, useEffect, useMemo } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import '@/components/ui/icons-extended'
import { GlassCard, SectionErrorBoundary, Icon } from '@/components/ui'
import { Counter } from '@/components/ui/Counter'
import { TextPressure } from '@/components/ui/TextPressure'
import { toast } from '@/stores/toast'
import { useAuthStore } from '@/stores/auth'
import { useDashboardStore } from '@/stores/dashboard'
import { useDiagnosisStore } from '@/stores/diagnosis'
import { useCopilotStore } from '@/stores/copilot'
import { useWSSubscription } from '@/hooks/useWSSubscription'
import { useClasses } from '@/hooks/useClasses'
import { logError } from '@/lib/errors'
import type { ProactiveAlert, ProactiveTargetType } from '@/lib/types'
import { DashboardHeader } from './DashboardHeader'
import { DashboardStatsCard } from './DashboardStats'
import { BloomRadarChart } from './BloomRadarChart'
import { AlertsPanel } from './AlertsPanel'
import { WeeklyProgressTable } from './WeeklyProgressTable'
import { InnovationCard } from './InnovationCard'
import { ClassHotspot } from './ClassHotspot'
import { TeachingLoopSection, type TeachingLoopCard } from './TeachingLoopSection'
import { SuggestionPanel } from '@/pages/DiagnosisPage/SuggestionPanel'
import './DashboardPage.css'

// 诊断 tab 懒加载（保持代码分割，避免首屏加载诊断页全部 D3 依赖）
const DiagnosisPage = lazy(() => import('@/pages/DiagnosisPage/DiagnosisPage'))

/** Dashboard 顶层 Tab 类型 */
type DashboardTab = 'dashboard' | 'diagnosis' | 'suggestion' | 'alerts'

/** Tab 配置 */
type DashboardTabConfig = { key: DashboardTab; label: string; icon: string; description: string }
const TABS: [DashboardTabConfig, ...DashboardTabConfig[]] = [
    { key: 'dashboard', label: '仪表盘', icon: 'chart-bar', description: '班级综合数据星云 · 六阶能力雷达 · 教学闭环全景' },
    { key: 'diagnosis', label: '诊断', icon: 'brain', description: '六阶认知模型 + 知识图谱深度查询 · 个体与共性认知诊断' },
    { key: 'suggestion', label: '建议', icon: 'lightbulb', description: 'AI 综合诊断数据 + 错题本数据生成的针对性教学建议' },
    { key: 'alerts', label: '待办', icon: 'bell', description: '实时预警 · 认知薄弱 / 学生掉队 / 课程延迟 / 掌握度偏低' },
]

/** 从 URL 参数解析当前 Tab */
function parseTab(value: string | null): DashboardTab {
    if (value === 'diagnosis' || value === 'suggestion' || value === 'alerts') return value
    return 'dashboard' // 默认仪表盘
}

/**
 * 教学闭环六大环节 —— MagicBento 卡片数据
 *
 * ── 这一组为什么被重写过 ──
 * 旧版六张卡里有「自学舱强化」和「诗音阁评测」两项，而教师端**根本没有
 * 这两个页面**（App.tsx 的路由表里不存在），卡片点下去无处可去。
 * 驾驶舱在向教师宣传系统没有的功能，属于硬性的内容失真。
 *
 * 现在这六张严格等于教师端真实存在、且首尾相接的六个工作阶段：
 *   诊断 → 命题 → 备课 → 授课 → 批改 → 复盘 →（复盘结论回流到下一轮诊断）
 * 每张卡都带 href，指向一条**已在路由表中注册**的地址。
 *
 * 六张配图均为针对当前环节单独生成、人工核对后随前端发布的 WebP。
 * 不在首屏发起生图请求，也不使用 SVG 或 CSS 假图兜底。
 */
const TEACHING_LOOP_CARDS: TeachingLoopCard[] = [
    {
        label: '课前 · 诊断',
        title: '学情诊断',
        description: '六阶认知模型定位学习起点，挖掘班级共性薄弱点',
        imageUrl: '/images/teaching-loop/diagnose.webp',
        href: '/dashboard?tab=diagnosis',
    },
    {
        label: '课前 · 命题',
        title: '智能命题',
        description: '按诊断结果分配六阶权重，多智能体生成并交叉校验题卡',
        imageUrl: '/images/teaching-loop/workbench.webp',
        href: '/workbench',
    },
    {
        label: '备课',
        title: '教案工坊',
        description: '十二类教案模板 + 教学环节骨架，一键生成可编辑教案',
        imageUrl: '/images/teaching-loop/lesson-plan.webp',
        href: '/lesson-plan',
    },
    {
        label: '课中 · 授课',
        title: '课堂导播',
        description: '飞花令 / 接龙 / 虚拟对手，实时互动与节奏把控',
        imageUrl: '/images/teaching-loop/classroom.webp',
        href: '/classroom',
    },
    {
        label: '课后 · 批改',
        title: '智能批改',
        description: 'OCR 识别 + 认知归因 + 教师审核三阶段流程闭环',
        imageUrl: '/images/teaching-loop/grading.webp',
        href: '/grading',
    },
    {
        label: '复盘',
        title: '教研报告',
        description: '汇总本轮学情与作答证据，产出结论并回流到下一轮诊断',
        imageUrl: '/images/teaching-loop/report.webp',
        href: '/report',
    },
]

export default function DashboardPage() {
    const [searchParams, setSearchParams] = useSearchParams()
    const activeTab = parseTab(searchParams.get('tab'))

    /** Tab 切换 —— 同步到 URL，保留其他参数（classId/studentId 等） */
    const handleTabChange = useCallback(
        (tab: DashboardTab) => {
            const next = new URLSearchParams(searchParams)
            if (tab === 'dashboard') {
                next.delete('tab') // dashboard 是默认值，省略 tab 参数保持 URL 简洁
            } else {
                next.set('tab', tab)
            }
            setSearchParams(next, { replace: true })
        },
        [searchParams, setSearchParams],
    )

    /** 键盘导航：方向键与 Home/End 均同步选中状态和实际焦点。 */
    const handleKeyDown = useCallback(
        (event: ReactKeyboardEvent<HTMLButtonElement>, tab: DashboardTab) => {
            const index = TABS.findIndex((item) => item.key === tab)
            let nextIndex: number
            switch (event.key) {
                case 'ArrowRight':
                case 'ArrowDown':
                    nextIndex = (index + 1) % TABS.length
                    break
                case 'ArrowLeft':
                case 'ArrowUp':
                    nextIndex = (index - 1 + TABS.length) % TABS.length
                    break
                case 'Home':
                    nextIndex = 0
                    break
                case 'End':
                    nextIndex = TABS.length - 1
                    break
                default:
                    return
            }
            event.preventDefault()
            const nextTab = TABS[nextIndex]
            if (!nextTab) return
            handleTabChange(nextTab.key)
            requestAnimationFrame(() => {
                document.querySelector<HTMLButtonElement>(`[data-dashboard-tab="${nextTab.key}"]`)?.focus()
            })
        },
        [handleTabChange],
    )

    const currentTabConfig = useMemo(
        () => TABS.find((t) => t.key === activeTab) ?? TABS[0],
        [activeTab],
    )

    return (
        <div className="pr-dashboard pr-v5-enter-dashboard">
            {/* ── 顶层 Tab 栏 —— 毛玻璃吸顶 + 透明度分层，无边框 ── */}
            <nav
                className="pr-dashboard-tabs"
                role="tablist"
                aria-label="教学驾驶舱功能切换"
            >
                {TABS.map((tab) => {
                    const isActive = tab.key === activeTab
                    return (
                        <button
                            key={tab.key}
                            type="button"
                            role="tab"
                            id={`pr-dash-tab-${tab.key}`}
                            data-dashboard-tab={tab.key}
                            aria-selected={isActive}
                            aria-controls={`pr-dash-panel-${tab.key}`}
                            tabIndex={isActive ? 0 : -1}
                            className={`pr-dashboard-tab ${isActive ? 'is-active' : ''}`}
                            onClick={() => handleTabChange(tab.key)}
                            onKeyDown={(e) => handleKeyDown(e, tab.key)}
                        >
                            <Icon name={tab.icon} size={16} active={isActive} />
                            <span className="pr-dashboard-tab-label">{tab.label}</span>
                            {isActive && (
                                <span className="pr-dashboard-tab-indicator" aria-hidden="true" />
                            )}
                        </button>
                    )
                })}
            </nav>

            {/* Tab 描述条 —— 透明度分层，极淡背景 */}
            <div className="pr-dashboard-tab-meta" aria-live="polite">
                <Icon name="info" size={12} />
                <span>{currentTabConfig.description}</span>
            </div>

            {/* ── Tab 内容区 ── */}
            <div
                id={`pr-dash-panel-${activeTab}`}
                role="tabpanel"
                aria-labelledby={`pr-dash-tab-${activeTab}`}
                className="pr-dashboard-panel"
            >
                {activeTab === 'dashboard' && <DashboardHome />}
                {activeTab === 'diagnosis' && (
                    <Suspense
                        fallback={
                            <div className="pr-dashboard-tab-fallback">
                                <Icon name="circle-notch" size={28} className="pr-app-spin" />
                                <span>加载诊断中心…</span>
                            </div>
                        }
                    >
                        <DiagnosisPage />
                    </Suspense>
                )}
                {activeTab === 'suggestion' && <SuggestionTab />}
                {activeTab === 'alerts' && <AlertsTab />}
            </div>
        </div>
    )
}

// ─────────────────────────────────────────────────────────────
// 仪表盘 Tab —— 数据星云 Hero + Stats + Radar + WeeklyProgress + MagicBento + InnovationCard
// ─────────────────────────────────────────────────────────────

function DashboardHome() {
    const navigate = useNavigate()
    const classId = useDashboardStore((s) => s.classId)
    const className = useDashboardStore((s) => s.className)
    const stats = useDashboardStore((s) => s.stats)
    const wsStatus = useDashboardStore((s) => s.wsStatus)
    const lastSyncedAt = useDashboardStore((s) => s.lastSyncedAt)
    const loading = useDashboardStore((s) => s.loading)

    const setClassId = useDashboardStore((s) => s.setClassId)
    const setAuthClassId = useAuthStore((s) => s.setClass)
    const setWsStatus = useDashboardStore((s) => s.setWsStatus)
    const fetchAll = useDashboardStore((s) => s.fetchAll)
    const handleWSEvent = useDashboardStore((s) => s.handleWSEvent)

    const { classes } = useClasses()

    // v5.0 Task 3.4：订阅全局 wsDispatcher（连接由 App.tsx 统一管理）
    useWSSubscription({
        onEvent: handleWSEvent,
        onStatusChange: setWsStatus,
    })

    // 挂载时初始化默认班级，触发 fetchAll 并行拉取
    useEffect(() => {
        if (!classId && classes.length > 0) {
            const first = classes[0]
            if (first) {
                setClassId(first.id)
                setAuthClassId(first.id)
            }
        }
    }, [classId, setAuthClassId, setClassId, classes])

    /** 同步按钮：手动触发全量刷新 */
    const handleSync = useCallback(() => {
        void fetchAll()
        toast.info({ title: '正在同步', message: '正在拉取最新教学数据' })
    }, [fetchAll])

    /** AI 副驾按钮：跳转到 AI 副驾页 */
    const handleOpenCopilot = useCallback(() => {
        navigate('/ai-copilot')
    }, [navigate])

    /** 班级切换：触发 store 重载该班级数据 */
    const handleClassChange = useCallback(
        (nextId: string) => {
            setClassId(nextId)
            // 统一驾驶舱与设置面板的班级边界，避免长期记忆治理沿用旧班级。
            setAuthClassId(nextId)
        },
        [setAuthClassId, setClassId],
    )

    // 首次加载（无 lastSyncedAt）或未设置班级时显示骨架
    const isInitializing = !classId || lastSyncedAt === null

    // v5.0 Hero 关键数字：班级综合掌握度（仍从 store 读取，Hero 区独立于面板组件）
    const heroMastery = !isInitializing && stats?.masteryRecordCount > 0
        ? Math.round(stats.classMasteryAvg)
        : null
    const heroStudentCount = !isInitializing && stats ? stats.studentCount : null
    const heroLearnedCount = !isInitializing && stats ? stats.weekLearnedPoems : null

    // v5.0 Dashboard 数据真实化：6 个面板组件均通过 TanStack Query 自取数据
    // 仅 classId 作为数据联动入口，组件内部管理 loading/error/empty 三态
    const classIdForQuery = classId || undefined

    return (
        <>

            {stats.dataProvenance?.containsSyntheticData && (
                <div className="pr-dashboard-provenance" role="status" aria-label="演示数据披露">
                    <Icon name="info" size={16} weight="bold" />
                    <div>
                        <strong>当前展示内置演示学情，不代表真实教学成效</strong>
                        <span>
                            当前含 {stats.dataProvenance.syntheticStudentCount} 名演示学生
                            {stats.dataProvenance.syntheticAnswerCount > 0
                                ? `、${stats.dataProvenance.syntheticAnswerCount} 条可复现模拟作答`
                                : ''}，
                            仅用于功能演示；真实应用数据需由课堂、批改与教师审核产生。
                        </span>
                    </div>
                </div>
            )}

            {/* v5.1 Hero：数据星云 —— 稳定标题 + 十字标记锚点 */}
            <section
                className="pr-v5-hero pr-v5-hero--dashboard pr-v51-hero-upgrade"
                aria-label="教学驾驶舱概览"
                data-anchor
                data-anchor-label="数据星云"
            >
                <div className="pr-v5-hero-main pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '0ms' }}>
                    <div className="pr-v51-hero-title-row">
                        <span className="pr-v51-hero-prefix">卷一·</span>
                        <h1 className="pr-hero-title pr-v51-hero-title">教学驾驶舱</h1>
                    </div>
                    <p className="pr-v51-hero-subtitle pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '120ms' }}>
                        数据驱动的教学决策 · 六阶认知 · 实时聚合
                    </p>
                    <DashboardHeader
                        className={className}
                        wsStatus={wsStatus}
                        lastSyncedAt={lastSyncedAt}
                        loading={loading}
                        onSync={handleSync}
                        onOpenCopilot={handleOpenCopilot}
                        onClassChange={handleClassChange}
                        classOptions={classes}
                        currentClassId={classId}
                    />
                </div>
                <aside className="pr-v5-hero-stat pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '80ms' }} aria-label="班级综合掌握度">
                    <span className="pr-v5-hero-stat-label pr-v51-hero-stat-label">六阶能力 · 实时聚合</span>
                    <span className="pr-v5-hero-stat-value pr-v51-hero-stat-value" style={{ color: 'var(--page-dashboard-hero-accent)' }}>
                        {heroMastery !== null ? <Counter value={heroMastery} /> : '待采集'}
                        {heroMastery !== null && <span className="pr-v5-hero-stat-unit">%</span>}
                    </span>
                    <span className="pr-v5-hero-stat-meta pr-v51-hero-stat-meta">
                        {heroStudentCount !== null && heroLearnedCount !== null
                            ? `${heroStudentCount} 位学生 · 本周已学 ${heroLearnedCount} 首 · ${stats.masteryRecordCount} 条有效记录`
                            : '数据星云 · 聚合中'}
                    </span>
                    <span className="pr-v51-hero-cross" aria-hidden />
                </aside>
            </section>

            <div className="pr-dashboard-body">
                <div
                    className="pr-dashboard-main"
                    data-anchor
                    data-anchor-label="综合数据"
                >
                    <DashboardStatsCard classId={classIdForQuery} />
                    <SectionErrorBoundary
                        title="六阶能力雷达加载失败"
                        description="雷达图渲染异常，可点击重试重新加载"
                        resetKeys={[classId]}
                        onError={(err, info) =>
                            logError('DashboardPage/BloomRadarChart', err, { componentStack: info.componentStack })
                        }
                    >
                        <BloomRadarChart classId={classIdForQuery} />
                    </SectionErrorBoundary>
                    <ClassHotspot classId={classIdForQuery} />
                </div>
                <aside
                    className="pr-dashboard-side"
                    data-anchor
                    data-anchor-label="实时预警"
                >
                    <GlassCard className="pr-alerts-card" padding="lg" blur="normal">
                        <AlertsPanel classId={classIdForQuery} />
                    </GlassCard>
                </aside>

                {/* 周进度矩阵横跨整行。
                    它天然是「20 行学生 × 7 天 + 合计」的宽表，挤在左侧 1fr 列里
                    每格只剩几十像素，数字与热力色都读不出来；而右侧告警列本就
                    短于主列，下方大片留白反而浪费。让宽数据占据它应得的宽度，
                    是「内容即设计」——布局由内容形态决定，而不是先划格子再塞。 */}
                <div className="pr-dashboard-fullrow">
                    <WeeklyProgressTable classId={classIdForQuery} />
                </div>
            </div>

            {/* spec v9：TextPressure 变量字体鼠标距离驱动形变
             * 严格移植自《优质前端部件组/2_文本压力.md》
             * 作为"教学理念"交互式文字锚点，鼠标悬停时字重随距离形变
             * 呼应"数据驱动决策"的页面主题，增强 Hero 区的交互深度
             * 容器高度流体响应，minFontSize=48 确保小屏可读性 */}
            <section
                className="pr-dashboard-text-pressure"
                aria-label="教学理念"
                data-anchor
                data-anchor-label="教学理念"
            >
                <TextPressure
                    text="数据为舵"
                    flex
                    weight
                    width
                    alpha
                    textColor="rgb(var(--c-text-primary, 44 36 26))"
                    strokeColor="rgb(var(--c-accent-primary, 197 133 59))"
                    minFontSize={48}
                    className="pr-dashboard-text-pressure-mount"
                />
            </section>

            {/* AI 主动智能区块 —— 主动预警 + 周报（P0-4） */}
            <ProactiveSuggestionsSection />
            <WeeklyReportCard />

            {/* MagicBento 教学闭环光韵卡片矩阵（配图与导航见 TeachingLoopSection） */}
            <TeachingLoopSection cards={TEACHING_LOOP_CARDS} />

            {/* 创新点信息卡 —— 凸显两大核心创新 */}
            <InnovationCard classId={classIdForQuery} />
        </>
    )
}

// ─────────────────────────────────────────────────────────────
// AI 主动智能区块（P0-4）—— 主动预警卡片 + 周报卡片
// ─────────────────────────────────────────────────────────────

/** 严重程度 → 图标映射 */
const SEVERITY_ICON_MAP: Record<string, string> = {
    info: 'lightbulb',
    warning: 'bell',
    critical: 'warning',
}

/** 严重程度 → 中文标签 */
const SEVERITY_LABEL_MAP: Record<string, string> = {
    info: '建议',
    warning: '预警',
    critical: '紧急',
}

/** 目标类型 → 路由映射 */
const TARGET_ROUTE_MAP: Record<ProactiveTargetType, string> = {
    student: '/grading',
    class: '/dashboard',
    agent: '/ai-copilot',
}

/** 格式化时间戳为简短日期 */
function formatPeriod(from: number, to: number): string {
    const fmt = (ts: number): string => {
        const d = new Date(ts)
        return `${d.getMonth() + 1}月${d.getDate()}日`
    }
    return `${fmt(from)} — ${fmt(to)}`
}

/** AI 主动建议区域 —— 展示最新 3 条 proactive 预警 */
function ProactiveSuggestionsSection() {
    const navigate = useNavigate()
    const proactiveAlerts = useCopilotStore((s) => s.proactiveAlerts)

    /** 跳转到对应处置页面 */
    const handleJump = useCallback(
        (alert: ProactiveAlert) => {
            const route = TARGET_ROUTE_MAP[alert.targetType] ?? '/dashboard'
            navigate(route)
        },
        [navigate],
    )

    const latestAlerts = proactiveAlerts.slice(0, 3)

    return (
        <section
            className="pr-proactive-section"
            aria-label="AI 主动建议"
            data-anchor
            data-anchor-label="AI 主动建议"
        >
            <header className="pr-proactive-header">
                <div className="pr-proactive-header-text">
                    <span className="pr-proactive-eyebrow">
                        <Icon name="sparkle" size={12} />
                        <span>AI 主动智能</span>
                    </span>
                    <h2 className="pr-proactive-title">主动建议与预警</h2>
                    <p className="pr-proactive-subtitle">
                        系统持续监测学情、知识图谱与 Agent 进化状态，主动推送教学决策建议
                    </p>
                </div>
            </header>
            {latestAlerts.length === 0 ? (
                <GlassCard className="pr-proactive-empty" padding="lg" blur="normal">
                    <div className="pr-proactive-empty-body">
                        <Icon name="check-circle" size={24} />
                        <span>当前无主动预警，系统持续监测中</span>
                    </div>
                </GlassCard>
            ) : (
                <div className="pr-proactive-grid">
                    {latestAlerts.map((alert) => {
                        const iconName = SEVERITY_ICON_MAP[alert.severity] ?? 'info'
                        const severityLabel = SEVERITY_LABEL_MAP[alert.severity] ?? '建议'
                        return (
                            <GlassCard
                                key={`${alert.type}-${alert.timestamp}`}
                                className={`pr-proactive-card pr-proactive-card--${alert.severity}`}
                                interactive
                                padding="lg"
                                blur="normal"
                            >
                                <div className="pr-proactive-card-header">
                                    <span className="pr-proactive-card-icon">
                                        <Icon name={iconName} size={16} />
                                    </span>
                                    <span className={`pr-proactive-card-severity pr-proactive-severity--${alert.severity}`}>
                                        {severityLabel}
                                    </span>
                                </div>
                                <h3 className="pr-proactive-card-title">{alert.title}</h3>
                                <p className="pr-proactive-card-desc">{alert.description}</p>
                                <div className="pr-proactive-card-action">
                                    <Icon name="arrow-right" size={12} />
                                    <span>{alert.recommendedAction}</span>
                                </div>
                                <button
                                    type="button"
                                    className="pr-proactive-card-jump"
                                    onClick={() => handleJump(alert)}
                                >
                                    查看详情
                                    <Icon name="arrow-square-out" size={12} />
                                </button>
                            </GlassCard>
                        )
                    })}
                </div>
            )}
        </section>
    )
}

/** 周报卡片 —— 展示最新周报摘要与建议 */
function WeeklyReportCard() {
    const navigate = useNavigate()
    const weeklyReport = useCopilotStore((s) => s.weeklyReport)

    const handleViewReport = useCallback(() => {
        navigate('/report')
    }, [navigate])

    if (!weeklyReport) return null

    return (
        <section
            className="pr-weekly-report-section"
            aria-label="周报"
            data-anchor
            data-anchor-label="教学周报"
        >
            <GlassCard className="pr-weekly-report-card" padding="lg" blur="normal">
                <div className="pr-weekly-report-head">
                    <div className="pr-weekly-report-head-text">
                        <span className="pr-weekly-report-eyebrow">
                            <Icon name="calendar" size={12} />
                            <span>教学周报</span>
                        </span>
                        <h3 className="pr-weekly-report-title">{weeklyReport.title}</h3>
                        <span className="pr-weekly-report-period">
                            {formatPeriod(weeklyReport.periodFrom, weeklyReport.periodTo)}
                        </span>
                    </div>
                    <button
                        type="button"
                        className="pr-weekly-report-jump"
                        onClick={handleViewReport}
                    >
                        查看完整报告
                        <Icon name="arrow-right" size={12} />
                    </button>
                </div>
                <p className="pr-weekly-report-summary">{weeklyReport.summary}</p>
                {weeklyReport.keyFindings.length > 0 && (
                    <div className="pr-weekly-report-block">
                        <span className="pr-weekly-report-block-label">关键发现</span>
                        <ul className="pr-weekly-report-list">
                            {weeklyReport.keyFindings.slice(0, 3).map((finding, idx) => (
                                <li key={idx}>{finding}</li>
                            ))}
                        </ul>
                    </div>
                )}
                {weeklyReport.recommendations.length > 0 && (
                    <div className="pr-weekly-report-block">
                        <span className="pr-weekly-report-block-label">教学建议</span>
                        <ul className="pr-weekly-report-list">
                            {weeklyReport.recommendations.slice(0, 3).map((rec, idx) => (
                                <li key={idx}>{rec}</li>
                            ))}
                        </ul>
                    </div>
                )}
            </GlassCard>
        </section>
    )
}

// ─────────────────────────────────────────────────────────────
// 建议 Tab —— SuggestionPanel + 数据加载
// ─────────────────────────────────────────────────────────────

function SuggestionTab() {
    const classId = useDashboardStore((s) => s.classId)
    const suggestionResponse = useDiagnosisStore((s) => s.suggestionResponse)
    const loading = useDiagnosisStore((s) => s.loading.suggestions)
    const fetchTeachingSuggestions = useDiagnosisStore((s) => s.fetchTeachingSuggestions)
    const { classes } = useClasses()

    // 班级变化时自动加载教学建议
    useEffect(() => {
        if (classId) {
            void fetchTeachingSuggestions(classId)
        }
    }, [classId, fetchTeachingSuggestions])

    return (
        <div className="pr-dashboard-suggestion-tab">
            {/* 班级选择条 —— 复用 Dashboard 的班级列表 */}
            <div className="pr-dashboard-suggestion-toolbar">
                <span className="pr-dashboard-suggestion-toolbar-label">
                    <Icon name="graduation" size={14} />
                    <span>当前班级</span>
                </span>
                <span className="pr-dashboard-suggestion-class-name">
                    {classes.find((c) => c.id === classId)?.name ?? '未选择班级'}
                </span>
            </div>
            <SuggestionPanel response={suggestionResponse} loading={loading} />
        </div>
    )
}

// ─────────────────────────────────────────────────────────────
// 待办 Tab —— AlertsPanel（全屏展示，含班级切换）
// ─────────────────────────────────────────────────────────────

function AlertsTab() {
    const classId = useDashboardStore((s) => s.classId)

    return (
        <div className="pr-dashboard-alerts-tab">
            <GlassCard className="pr-alerts-card pr-alerts-card--full" padding="lg" blur="normal">
                <AlertsPanel classId={classId || undefined} />
            </GlassCard>
        </div>
    )
}
