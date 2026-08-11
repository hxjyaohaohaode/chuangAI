/**
 * 课堂导播台主页面（SubTask 11.6 —— 布局组装）
 *
 * 组装课堂全部子组件，构成教师实时教学核心工具：
 * - 顶部：Header（标题 + 加入码 + 学生数 + WS 状态 + 刷新/报告按钮）
 * - 未开始：Setup Card（模式选择 + 班级/诗篇输入 + 开始按钮）
 * - 进行中：主体网格（桌面 1fr 380px）
 *   - 左列主区：ClassroomStage（大屏）→ AIAssistant（AI 副驾）
 *   - 右列边栏：ClassroomControl（控制面板）
 * - 已结束：ClassroomReportModal（协奏报告）
 *
 * 数据流：
 * - useClassroomStore 提供课堂运行时状态 + WS 状态 + 加载态
 * - useWSSubscription 订阅全局 wsDispatcher（连接由 App.tsx 统一管理），事件回流至 store.handleWSEvent
 * - URL 参数 /classroom/:lessonId 加载已有课堂
 *
 * 设计要点（规范第 5、8、12 章）：
 * - 松紧得当：header 紧带，主体组件间稳带
 * - 响应式：1100px 断点切换单列，767px 进一步压缩
 * - 实时同步：WS 事件 ≤50ms 更新 state，不重新拉取全部数据
 */

import { useEffect, useState, useRef, useCallback, type KeyboardEvent } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { Button, Combobox, Icon, GlassCard, type ComboboxOption } from '@/components/ui'
import { ElectricBorder } from '@/components/ui/ElectricBorder'
import { TextSwitch } from '@/components/ui/TextSwitch'
import { api } from '@/lib/api'
import { useClassroomStore } from '@/stores/classroom'
import { useWSSubscription } from '@/hooks/useWSSubscription'
import { useClasses } from '@/hooks/useClasses'
import {
    CLASSROOM_MODE_LABELS,
    type ClassroomMode,
    type ClassroomReadiness,
    type WorkbenchPoemOption,
} from '@/lib/types'
import { useDemoModeStore } from '@/lib/demo-mode'
import { businessEvents } from '@/lib/business-events'
import { captureFlipRects, playFlipEnter } from '@/lib/flip'
import { ClassroomStage } from './ClassroomStage'
import { QuestHud } from './QuestHud'
import { ClassroomControl } from './ClassroomControl'
import { AIAssistant } from './AIAssistant'
import { ClassroomReportModal } from './ClassroomReport'
import { ExplainPanel } from './ExplainPanel'
import { DanceStage } from './DanceStage'
import { EventTimeline } from './EventTimeline'
import type { ClassroomEventItem } from './event-timeline-types'
import '@/components/ui/icons-extended'
import './ClassroomPage.css'
import './ModesEnhanced.css'

/** 课堂模式选项
 *
 * v5.0 Task 19-20：扩展为 7 模式（基础 4 + 创新 3）
 * - 基础模式：集体闯关 / 速答 PK / 飞花令擂台 / 六阶沉浸课
 * - 创新模式：诗词大转盘 / 诗词接龙 / 意境拼图（寓教于乐）
 */
const MODE_OPTIONS: Array<{
    mode: ClassroomMode
    icon: 'graduation' | 'lightbulb' | 'feather' | 'chart-bar' | 'sparkles' | 'repeat' | 'puzzle-piece'
    desc: string
    innovative?: boolean
}> = [
        { mode: 'collective-race', icon: 'graduation', desc: '全班共同闯关，60秒倒计时' },
        { mode: 'speed-pk', icon: 'lightbulb', desc: '抢答积分制，实时排行榜' },
        { mode: 'flying-flower', icon: 'feather', desc: '飞花令擂台，关键字接花' },
        { mode: 'six-level-immersive', icon: 'chart-bar', desc: '六阶认知沉浸，逐层攻克' },
        { mode: 'poem-wheel', icon: 'sparkles', desc: '大转盘抽题，幸运字命题', innovative: true },
        { mode: 'poem-relay', icon: 'repeat', desc: '诗词接龙，AI 智能续接', innovative: true },
        { mode: 'imagery-puzzle', icon: 'puzzle-piece', desc: '拼图重组意境，AI 生图', innovative: true },
    ]

/** 课堂模式元信息（供分段控制器展示：场景 + 时长） */
const MODE_META: Record<ClassroomMode, { scenario: string; duration: string }> = {
    'collective-race': { scenario: '全班协作闯关', duration: '约 15 分钟' },
    'speed-pk': { scenario: '分组抢答竞技', duration: '约 10 分钟' },
    'flying-flower': { scenario: '关键字飞花接花', duration: '约 12 分钟' },
    'six-level-immersive': { scenario: '六阶认知递进', duration: '约 25 分钟' },
    'poem-wheel': { scenario: '幸运转盘抽题', duration: '约 8 分钟' },
    'poem-relay': { scenario: '诗词接龙 AI 陪练', duration: '约 15 分钟' },
    'imagery-puzzle': { scenario: '意境拼图重组', duration: '约 18 分钟' },
}

/** v7 功能真实性修复：Hero 轮播文本从 MODE_OPTIONS 派生，展示真实模式标签
 * 原先硬编码 ['互动教学','实时反馈','协作探究','多智能体协奏'] 是营销热词，
 * 与实际模式标签（集体闯关/速答PK/飞花令擂台/六阶沉浸课）完全不匹配 */
const HERO_MODE_TEXTS: string[] = MODE_OPTIONS.map(opt => CLASSROOM_MODE_LABELS[opt.mode])

const CLASSROOM_VIEW_MODES = ['quiz', 'explain', 'dance'] as const

/** WS 状态中文标签 */
const WS_STATUS_LABELS: Record<string, string> = {
    idle: '未连接',
    connecting: '连接中',
    connected: '已连接',
    disconnected: '已断开',
    error: '连接异常',
}

/** 开课页诗库状态：局部故障不能把本地样例冒充当前可用教材。 */
type ClassroomPoemSource = 'loading' | 'live' | 'demo-mode' | 'stale-live' | 'unavailable'

export default function ClassroomPage() {
    const { lessonId: urlLessonId } = useParams<{ lessonId: string }>()
    const [searchParams] = useSearchParams()
    const navigate = useNavigate()
    const isReportView = searchParams.get('view') === 'report'
    // v5.0 Task 4.2：从 URL 参数读取 classId，自动选中对应班级
    const urlClassId = searchParams.get('classId')

    // 从开课配置切换到运行态时 React Router 不会自动复位滚动位置。
    // 若保留启动按钮所在的旧滚动量，教师会直接落在页面中段，错过课堂总览与当前题。
    useEffect(() => {
        window.scrollTo({ top: 0, behavior: 'auto' })
    }, [urlLessonId])

    // ── Store 状态 ──
    const lessonId = useClassroomStore((s) => s.lessonId)
    const joinCode = useClassroomStore((s) => s.joinCode)
    const mode = useClassroomStore((s) => s.mode)
    const started = useClassroomStore((s) => s.started)
    const ended = useClassroomStore((s) => s.ended)
    const status = useClassroomStore((s) => s.status)
    const responses = useClassroomStore((s) => s.responses)
    const aiMessages = useClassroomStore((s) => s.aiMessages)
    const report = useClassroomStore((s) => s.report)
    const wsStatus = useClassroomStore((s) => s.wsStatus)
    const starting = useClassroomStore((s) => s.starting)
    const advancing = useClassroomStore((s) => s.advancing)
    const pushingHint = useClassroomStore((s) => s.pushingHint)
    const pushingDiscuss = useClassroomStore((s) => s.pushingDiscuss)
    const ending = useClassroomStore((s) => s.ending)

    // ── Store 动作 ──
    const start = useClassroomStore((s) => s.start)
    const loadByLessonId = useClassroomStore((s) => s.loadByLessonId)
    const loadReport = useClassroomStore((s) => s.loadReport)
    const next = useClassroomStore((s) => s.next)
    const pushHint = useClassroomStore((s) => s.pushHint)
    const pushDiscuss = useClassroomStore((s) => s.pushDiscuss)
    const end = useClassroomStore((s) => s.end)
    const handleWSEvent = useClassroomStore((s) => s.handleWSEvent)
    const setWsStatus = useClassroomStore((s) => s.setWsStatus)
    const reset = useClassroomStore((s) => s.reset)
    const switchMode = useClassroomStore((s) => s.switchMode)

    // ── 本地 UI 状态 ──
    const [selectedMode, setSelectedMode] = useState<ClassroomMode>('collective-race')
    /** 小屏开课页默认只呈现当前模式，教师可按需展开其余模式，避免配置区被七张卡片推离首屏。 */
    const [launchModesExpanded, setLaunchModesExpanded] = useState(false)
    /**
     * 开课请求已返回失败，但页面仍停留在同一份真实配置上。
     *
     * 不把后端错误正文直接显示给教师：生产环境需要避免 SQL、栈和供应商细节泄漏。
     * 这里仅陈述浏览器可验证的事实——本次没有建立课堂、没有生成加入码、可以安全重试。
     */
    const [launchFailure, setLaunchFailure] = useState(false)
    const [classId, setClassId] = useState<string>('')
    // 课堂相关 API 必须使用后端题库的规范主键（如 tongbian-003），所以不能
    // 在接口失败时以图谱样例主键冒充可开课教材。仅在已进入全局演示模式时，
    // 才允许 API 返回明确标识的演示诗库。
    const [poemId, setPoemId] = useState<string>('')
    const [poemOptions, setPoemOptions] = useState<WorkbenchPoemOption[]>([])
    const [poemSource, setPoemSource] = useState<ClassroomPoemSource>('loading')
    const [poemLoadError, setPoemLoadError] = useState<string | null>(null)
    const [poemReloadVersion, setPoemReloadVersion] = useState(0)
    const livePoemOptionsRef = useRef<WorkbenchPoemOption[] | null>(null)
    const [readiness, setReadiness] = useState<ClassroomReadiness | null>(null)
    const [readinessLoading, setReadinessLoading] = useState(false)
    const [reportOpen, setReportOpen] = useState(false)
    /** 报告视图初始化标记：避免重复请求 */
    const [reportViewInitiated, setReportViewInitiated] = useState(false)
    /** Phase 4.3：课堂视图模式 —— quiz 答题 / explain 讲解 / dance 共舞舞台 */
    const [viewMode, setViewMode] = useState<'quiz' | 'explain' | 'dance'>('quiz')
    /** 投屏时可收起控制轨，为主舞台释放完整宽度 */
    const [controlCollapsed, setControlCollapsed] = useState(false)

    const handleViewModeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        const currentIndex = CLASSROOM_VIEW_MODES.indexOf(viewMode)
        let nextIndex: number
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                nextIndex = (currentIndex + 1) % CLASSROOM_VIEW_MODES.length
                break
            case 'ArrowLeft':
            case 'ArrowUp':
                nextIndex = (currentIndex - 1 + CLASSROOM_VIEW_MODES.length) % CLASSROOM_VIEW_MODES.length
                break
            case 'Home':
                nextIndex = 0
                break
            case 'End':
                nextIndex = CLASSROOM_VIEW_MODES.length - 1
                break
            default:
                return
        }
        event.preventDefault()
        const nextMode = CLASSROOM_VIEW_MODES[nextIndex]
        if (!nextMode) return
        setViewMode(nextMode)
        event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-classroom-view-tab="${nextMode}"]`)
            ?.focus()
    }, [viewMode])

    // ── 课堂指挥深化：FLIP 模式切换 + 事件时间轴 ──
    /** 模式切换中标记（控制 fade-out / fade-in 过渡） */
    const [modeSwitching, setModeSwitching] = useState(false)
    /** 课堂事件时间轴数据 */
    const [timelineEvents, setTimelineEvents] = useState<ClassroomEventItem[]>([])
    /** FLIP 动画容器引用 */
    const contentRef = useRef<HTMLDivElement>(null)
    /** 事件 ID 计数器 */
    const eventIdRef = useRef(0)
    /** 课堂开始时间戳（用于时间轴显示，0 表示未开始） */
    const startedAtRef = useRef<number>(0)
    const isDemoMode = useDemoModeStore((s) => s.isDemoMode)

    const { classes } = useClasses()
    const selectedClassName = classes.find((item) => item.id === classId)?.name ?? '等待选择班级'
    const selectedPoem = poemOptions.find((item) => item.id === poemId)
    const selectedModeMeta = MODE_META[selectedMode]
    // 始终将教师刚刚选择的模式固定在主卡位置：大卡表达“当前要开的课”，
    // 其余六种模式仍可见且可切换，避免桌面端把未选模式放大而留下无信息留白。
    const orderedModeOptions = [
        ...MODE_OPTIONS.filter((option) => option.mode === selectedMode),
        ...MODE_OPTIONS.filter((option) => option.mode !== selectedMode),
    ]

    // 使用完整诗库，而不是仅展示 20 首有插图的诗；真实接口故障时清空首次
    // 加载的选项并持续说明来源，只有已经确认过来源的列表可以标为 stale-live 保留。
    useEffect(() => {
        let active = true
        const cachedLive = livePoemOptionsRef.current
        if (isDemoMode) {
            setPoemSource('loading')
            setPoemLoadError(null)
        } else if (cachedLive) {
            setPoemOptions(cachedLive)
            setPoemSource('live')
            setPoemLoadError(null)
        } else {
            setPoemOptions([])
            setPoemId('')
            setPoemSource('loading')
            setPoemLoadError(null)
        }

        void api.workbench.listPoems().then((response) => {
            if (!active) return
            const nextOptions = response.poems
            setPoemOptions(nextOptions)
            setPoemId((current) => nextOptions.some((poem) => poem.id === current)
                ? current
                : nextOptions[0]?.id ?? '')
            setPoemLoadError(null)
            if (isDemoMode) {
                setPoemSource('demo-mode')
                return
            }
            livePoemOptionsRef.current = nextOptions
            setPoemSource('live')
        }).catch(() => {
            if (!active) return
            if (isDemoMode) {
                setPoemOptions([])
                setPoemId('')
                setPoemSource('unavailable')
                setPoemLoadError('离线演示诗库暂不可用；请恢复服务后重试。')
                return
            }
            if (cachedLive) {
                setPoemOptions(cachedLive)
                setPoemSource('stale-live')
                setPoemLoadError('真实诗库最新同步失败；当前仅保留此前加载的真实诗篇。')
                return
            }
            setPoemOptions([])
            setPoemId('')
            setPoemSource('unavailable')
            setPoemLoadError('暂时无法连接真实诗库；未显示本地样例，避免以演示诗篇启动课堂。')
        })
        return () => { active = false }
    }, [isDemoMode, poemReloadVersion])

    const handleRetryPoems = useCallback(() => {
        setPoemReloadVersion((version) => version + 1)
    }, [])

    // 开课前实时核验题库数量与六阶覆盖，避免点击后才发现课堂不可用。
    useEffect(() => {
        if (!poemId || started || poemSource === 'loading' || poemSource === 'unavailable') {
            setReadiness(null)
            setReadinessLoading(false)
            return
        }
        let active = true
        setReadinessLoading(true)
        setReadiness(null)
        void api.classroom.readiness(poemId, selectedMode)
            .then((result) => {
                if (active) setReadiness(result)
            })
            .catch(() => {
                if (active) setReadiness(null)
            })
            .finally(() => {
                if (active) setReadinessLoading(false)
            })
        return () => { active = false }
    }, [poemId, poemSource, selectedMode, started])

    // 班级列表加载后默认选中第一个；v5.0 Task 4.2：URL 携带 classId 时优先选中对应班级
    useEffect(() => {
        if (!classId && classes.length > 0) {
            if (urlClassId && classes.some((c) => c.id === urlClassId)) {
                setClassId(urlClassId)
            } else {
                const first = classes[0]
                if (first) setClassId(first.id)
            }
        }
    }, [classId, classes, urlClassId])

    // 订阅后端实际提供的全局实时通道；课堂事件在 store 内按 lessonId 过滤。
    // 不再额外建立 /ws/classroom/:lessonId：后端未注册该路由，双连接还会互相覆盖状态。
    useWSSubscription({
        enabled: started && !ended,
        onEvent: handleWSEvent,
        onStatusChange: setWsStatus,
    })

    // URL 参数加载已有课堂
    // 报告视图（?view=report）：优先调用 loadReport 拉取历史报告（支持 runtime 已清除的历史课堂），
    //   同时尝试 loadByLessonId 获取实时状态（若 runtime 仍存在），两者并行互不阻塞。
    // 普通视图：仅调用 loadByLessonId 加载课堂状态。
    useEffect(() => {
        if (!urlLessonId) return
        if (urlLessonId === lessonId && reportViewInitiated) return

        if (isReportView) {
            setReportViewInitiated(true)
            void loadReport(urlLessonId).then((ok) => {
                if (ok) {
                    setReportOpen(true)
                } else {
                    // 报告加载失败（课堂未结束或报告不存在）→ 返回驾驶舱
                    navigate('/dashboard', { replace: true })
                }
            })
            // 同时尝试加载状态（runtime 可能已清除，静默失败）
            void loadByLessonId(urlLessonId).catch((err) => {
                if (import.meta.env.DEV) console.warn('[classroom] loadByLessonId 静默失败', err)
            })
        } else {
            void loadByLessonId(urlLessonId)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [urlLessonId, isReportView])

    // 课堂结束时自动弹出报告（仅非报告视图，报告视图由上方 effect 显式打开）
    useEffect(() => {
        if (ended && report && !isReportView) {
            setReportOpen(true)
        }
    }, [ended, report, isReportView])

    // 记录课堂开始时间戳（用于时间轴显示）
    useEffect(() => {
        if (started && startedAtRef.current === 0) {
            startedAtRef.current = Date.now()
        }
    }, [started])

    /** 开始课堂 */
    const handleStart = async () => {
        if (poemSource === 'loading' || poemSource === 'unavailable') return
        setLaunchFailure(false)
        // 当前页面会在失败时以持久、具名的 alert 说明事实和重试动作；这里
        // 明确接管反馈，避免 store 额外投放一条泛化 Toast 与主操作区重复播报。
        const newLessonId = await start(classId, poemId, selectedMode, undefined, 'inline')
        if (newLessonId) {
            navigate(`/classroom/${encodeURIComponent(newLessonId)}`, { replace: true })
            return
        }
        // `start()` 只在服务端确认 classroom runtime 与 lessons 均已保存后返回 lessonId。
        // 所以这里的 null 是一个可安全披露的失败关闭状态，而不是“启动中”。
        setLaunchFailure(true)
    }

    /** 下一题 */
    const handleNext = () => {
        void next()
    }

    /** 推送提示 */
    const handlePushHint = (type?: 'nudge' | 'scaffold' | 'reframe') => {
        void pushHint(type)
    }

    /** 推送讨论题 */
    const handlePushDiscuss = (angle?: 'cultural' | 'comparative' | 'creative') => {
        void pushDiscuss(angle)
    }

    /** 结束课堂 */
    const handleEnd = () => {
        void end()
    }

    /** 退出课堂 */
    const handleExit = () => {
        reset()
        navigate('/classroom', { replace: true })
        setReportOpen(false)
        setReportViewInitiated(false)
        setTimelineEvents([])
        startedAtRef.current = 0
    }

    /** 追加时间轴事件 */
    const addTimelineEvent = useCallback((event: Omit<ClassroomEventItem, 'id' | 'timestamp'> & { timestamp?: number }) => {
        eventIdRef.current += 1
        const fullEvent: ClassroomEventItem = {
            id: `evt-${Date.now()}-${eventIdRef.current}`,
            timestamp: event.timestamp ?? Date.now(),
            ...event,
        }
        setTimelineEvents((prev) => [...prev.slice(-49), fullEvent])
    }, [])

    /** FLIP 动画模式切换：200ms 淡出 → 切换模式 → 350ms 淡入 */
    const handleModeSwitch = useCallback((newMode: ClassroomMode) => {
        if (modeSwitching || newMode === mode) return

        // 1. 捕获旧元素位置（FLIP First）
        captureFlipRects(contentRef.current)

        // 2. 触发淡出（200ms）
        setModeSwitching(true)

        // 3. 200ms 后切换模式 + 触发淡入
        window.setTimeout(() => {
            void switchMode(newMode).finally(() => {
                setModeSwitching(false)
                requestAnimationFrame(() => {
                    playFlipEnter(contentRef.current)
                })
            })
        }, 200)
    }, [modeSwitching, mode, switchMode, addTimelineEvent])

    // 订阅业务事件，追加时间轴
    useEffect(() => {
        if (!started || ended) return

        const unsubModeChanged = businessEvents.on('classroom:mode-changed', (evt) => {
            addTimelineEvent({
                type: 'mode-changed',
                summary: `${evt.payload.fromMode} → ${evt.payload.toMode}`,
                timestamp: evt.payload.changedAt,
            })
        })

        const unsubAISuggested = businessEvents.on('classroom:ai-suggested', (evt) => {
            addTimelineEvent({
                type: 'ai-suggested',
                summary: evt.payload.summary.slice(0, 30),
                questionId: evt.payload.questionId,
                studentId: evt.payload.studentId,
                timestamp: evt.payload.suggestedAt,
            })
        })

        return () => {
            unsubModeChanged()
            unsubAISuggested()
        }
    }, [started, ended, addTimelineEvent])

    const wsConnected = wsStatus === 'connected'
    const activeStudents = status.activeStudents

    // ── 未开始：显示 Hero + Setup ──
    if (!started) {
        return (
            <div className="pr-classroom pr-v5-enter-classroom">
                <div className="pr-classroom-launch-shell">
                    {/* Hero 区：剧场帷幕意象 + 4 模式 Bento 错落预览 */}
                    <section className="pr-classroom-hero" aria-labelledby="pr-classroom-hero-title">
                        <div className="pr-classroom-hero-curtain pr-classroom-hero-curtain--left" aria-hidden="true" />
                        <div className="pr-classroom-hero-curtain pr-classroom-hero-curtain--right" aria-hidden="true" />
                        <div className="pr-classroom-hero-inner">
                            <span className="pr-classroom-hero-eyebrow pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '0ms' }}>
                                <Icon name="graduation" size={14} />
                                <span>课堂导播台</span>
                            </span>
                            <h1 id="pr-classroom-hero-title" className="pr-classroom-hero-title pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '80ms' }}>
                                一堂 AI 驱动的<br />古诗沉浸课
                            </h1>
                            <p className="pr-classroom-hero-subtitle pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '160ms' }}>
                                七种教学模式 · 实时学情同步 · 多智能体协奏
                            </p>

                            {/* 关键概念轮播 —— TextSwitch 驱动注意力引导 */}
                            <div className="pr-classroom-hero-switch pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '200ms' }}>
                                <TextSwitch
                                    texts={HERO_MODE_TEXTS}
                                    auto
                                    interval={3000}
                                    className="pr-classroom-hero-switch-text"
                                />
                            </div>

                            {/* 7 模式 Bento 错落预览（v5.0 Task 19-20：基础 4 + 创新 3）
                             * 布局：第 1 张大卡（feature）+ 基础 3 张小卡 + 创新 3 张小卡
                             * 创新模式卡片使用 accent-info 微高亮 + "创新" 角标。
                             * 窄屏默认仅保留当前模式与显式展开入口，避免把班级/诗篇配置推离可见区域。 */}
                            <div id="pr-classroom-launch-modes" className="pr-classroom-hero-modes">
                                {orderedModeOptions.map((opt, idx) => (
                                    <button
                                        key={opt.mode}
                                        type="button"
                                        className={`pr-classroom-mode-card pr-classroom-mode-card--hero pr-v5-stagger-item ${selectedMode === opt.mode ? 'pr-classroom-mode-card--active' : ''} ${idx === 0 ? 'pr-classroom-mode-card--feature' : ''} ${opt.innovative ? 'pr-classroom-mode-card--innovative' : ''} ${!launchModesExpanded && selectedMode !== opt.mode ? 'pr-classroom-mode-card--mobile-collapsed' : ''}`}
                                        style={{ ['--v5-stagger-delay' as string]: `${240 + idx * 70}ms` }}
                                        onClick={() => {
                                            setSelectedMode(opt.mode)
                                            setLaunchFailure(false)
                                        }}
                                        aria-pressed={selectedMode === opt.mode}
                                    >
                                        {selectedMode === opt.mode && (
                                            <ElectricBorder
                                                speed={0.8}
                                                chaos={0.08}
                                                borderRadius={12}
                                                className="pr-classroom-mode-card-eb-overlay"
                                            />
                                        )}
                                        <span className="pr-classroom-mode-card-icon">
                                            <Icon name={opt.icon} size={idx === 0 ? 22 : 18} />
                                        </span>
                                        <span className="pr-classroom-mode-card-name">
                                            {CLASSROOM_MODE_LABELS[opt.mode]}
                                        </span>
                                        <span className="pr-classroom-mode-card-desc">{opt.desc}</span>
                                        {idx === 0 && (
                                            <span className="pr-classroom-mode-card-feature-details">
                                                <span className="pr-classroom-mode-card-feature-detail">
                                                    <span>课堂组织</span>
                                                    <strong>{MODE_META[opt.mode].scenario}</strong>
                                                </span>
                                                <span className="pr-classroom-mode-card-feature-detail">
                                                    <span>建议节奏</span>
                                                    <strong>{MODE_META[opt.mode].duration}</strong>
                                                </span>
                                            </span>
                                        )}
                                        {opt.innovative && (
                                            <span className="pr-classroom-mode-card-badge">
                                                <Icon name="sparkles" size={9} />
                                                创新
                                            </span>
                                        )}
                                    </button>
                                ))}
                            </div>
                            <button
                                type="button"
                                className="pr-classroom-launch-mode-toggle"
                                aria-controls="pr-classroom-launch-modes"
                                aria-expanded={launchModesExpanded}
                                onClick={() => setLaunchModesExpanded((expanded) => !expanded)}
                            >
                                <Icon name={launchModesExpanded ? 'caret-up' : 'caret-down'} size={14} />
                                <span>
                                    {launchModesExpanded
                                        ? '收起其余教学模式'
                                        : `展开其余 ${MODE_OPTIONS.length - 1} 种教学模式`}
                                </span>
                            </button>
                        </div>
                    </section>

                    {/* 配置区：班级 + 诗篇 + 开始 —— GlassCard 玻璃态增强 */}
                    <GlassCard className="pr-classroom-setup">
                        <div className="pr-classroom-setup-form">
                            {/* 班级选择 */}
                            <div className="pr-classroom-setup-field">
                                <label className="pr-classroom-setup-label">班级</label>
                                <Combobox
                                    value={classId}
                                    onChange={(v) => {
                                        setClassId(v as string)
                                        setLaunchFailure(false)
                                    }}
                                    ariaLabel="班级"
                                    placeholder="请选择班级..."
                                    className="pr-classroom-setup-combobox"
                                    options={[
                                        { value: '', label: '请选择班级...' },
                                        ...classes.map<ComboboxOption>((c) => ({
                                            value: c.id,
                                            label: c.name,
                                        })),
                                    ]}
                                />
                            </div>

                            {/* 诗篇选择 */}
                            <div className="pr-classroom-setup-field">
                                <label className="pr-classroom-setup-label">诗篇</label>
                                <Combobox
                                    value={poemId}
                                    onChange={(v) => {
                                        setPoemId(v as string)
                                        setLaunchFailure(false)
                                    }}
                                    ariaLabel="诗篇"
                                    placeholder={poemSource === 'loading' ? '正在加载真实诗库…' : '请选择诗篇'}
                                    className="pr-classroom-setup-combobox"
                                    options={poemOptions.map<ComboboxOption>((p) => ({
                                        value: p.id,
                                        label: `${p.title} · ${p.poet} · ${p.dynasty}`,
                                    }))}
                                    disabled={poemSource === 'loading' || poemSource === 'unavailable'}
                                />
                            </div>

                            {poemSource !== 'live' && (
                                <div
                                    className={`pr-classroom-poem-source is-${poemSource}`}
                                    role={poemSource === 'unavailable' ? 'alert' : 'status'}
                                >
                                    <Icon
                                        name={poemSource === 'unavailable' ? 'warning-circle' : 'info'}
                                        size={16}
                                        weight="bold"
                                        aria-hidden
                                    />
                                    <div>
                                        <strong>
                                            {poemSource === 'demo-mode'
                                                ? '当前诗篇来自离线演示数据'
                                                : poemSource === 'stale-live'
                                                    ? '正在使用已加载的真实诗篇'
                                                    : poemSource === 'loading'
                                                        ? '正在加载真实诗库'
                                                        : '真实诗库暂不可用'}
                                        </strong>
                                        <span>
                                            {poemSource === 'demo-mode'
                                                ? '仅用于演示课堂流程，不能作为真实教学记录依据。'
                                                : poemSource === 'loading'
                                                    ? '加载完成后才能选择教材并开始开课核验。'
                                                    : poemLoadError}
                                        </span>
                                    </div>
                                    {(poemSource === 'unavailable' || poemSource === 'stale-live') && (
                                        <button type="button" onClick={handleRetryPoems}>
                                            重试真实诗库
                                        </button>
                                    )}
                                </div>
                            )}

                            <div className={`pr-classroom-readiness ${readiness?.ready ? 'is-ready' : ''}`}>
                                <div className="pr-classroom-readiness-main">
                                    <span className="pr-classroom-readiness-kicker">开课核验</span>
                                    <strong>
                                        {readinessLoading
                                            ? '正在核验题库…'
                                            : readiness?.ready
                                                ? `${readiness.questionCount} 道真实题目已就绪`
                                                : '当前诗篇尚无可用题目'}
                                    </strong>
                                    <span>
                                        {readiness?.ready
                                            ? '题目来自历史题库；课堂作答将同步进入掌握度、批改记录与课后报告。'
                                            : '请先到命题工坊生成并保存题目，系统不会用占位题开课。'}
                                    </span>
                                </div>
                                <div className="pr-classroom-readiness-levels" aria-label="六阶题目覆盖">
                                    {(['记忆', '理解', '应用', '分析', '评价', '创造'] as const).map((level) => (
                                        <span key={level} className={(readiness?.bloomCoverage[level] ?? 0) > 0 ? 'has-data' : ''}>
                                            {level}<b>{readiness?.bloomCoverage[level] ?? 0}</b>
                                        </span>
                                    ))}
                                </div>
                                {!readinessLoading && !readiness?.ready && (
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => navigate(`/workbench?poemId=${encodeURIComponent(poemId)}`)}
                                    >
                                        去命题工坊
                                    </Button>
                                )}
                            </div>

                            {launchFailure && (
                                <div
                                    id="pr-classroom-launch-failure"
                                    className="pr-classroom-launch-failure"
                                    role="alert"
                                    aria-live="assertive"
                                    data-classroom-launch-failure="true"
                                >
                                    <Icon name="warning-circle" size={18} weight="bold" aria-hidden />
                                    <div>
                                        <strong>课堂尚未启动</strong>
                                        <span>
                                            本次操作没有建立课堂，未生成加入码或开放实时通道。请确认开课条件后重新尝试。
                                        </span>
                                    </div>
                                </div>
                            )}

                            <section className="pr-classroom-launch-brief" aria-labelledby="pr-classroom-launch-brief-title">
                                <div className="pr-classroom-launch-brief-heading">
                                    <div>
                                        <span className="pr-classroom-launch-brief-kicker">本次课堂摘要</span>
                                        <strong id="pr-classroom-launch-brief-title">
                                            {CLASSROOM_MODE_LABELS[selectedMode]}
                                        </strong>
                                    </div>
                                    <span className={`pr-classroom-launch-brief-state ${readiness?.ready ? 'is-ready' : ''}`}>
                                        <Icon name={readiness?.ready ? 'check-circle' : 'clock'} size={13} aria-hidden />
                                        {readinessLoading ? '核验中' : readiness?.ready ? '可开课' : '待补齐'}
                                    </span>
                                </div>
                                <dl className="pr-classroom-launch-brief-facts">
                                    <div>
                                        <dt>班级</dt>
                                        <dd>{selectedClassName}</dd>
                                    </div>
                                    <div>
                                        <dt>诗篇</dt>
                                        <dd>{selectedPoem ? `《${selectedPoem.title}》· ${selectedPoem.poet}` : '等待加载真实诗库'}</dd>
                                    </div>
                                    <div>
                                        <dt>课堂节奏</dt>
                                        <dd>{selectedModeMeta.scenario} · {selectedModeMeta.duration}</dd>
                                    </div>
                                </dl>
                                <ol className="pr-classroom-launch-brief-flow" aria-label="开课后的真实工作流">
                                    <li><Icon name="book-open" size={13} aria-hidden /><span>题库核验</span></li>
                                    <li><Icon name="graduation" size={13} aria-hidden /><span>建立课堂</span></li>
                                    <li><Icon name="chart-bar" size={13} aria-hidden /><span>实时采集</span></li>
                                </ol>
                            </section>

                            <Button
                                variant="primary"
                                block
                                size="lg"
                                loading={starting}
                                disabled={!classId || !poemId || poemSource === 'loading' || poemSource === 'unavailable' || readinessLoading || !readiness?.ready}
                                onClick={handleStart}
                                leftIcon={<Icon name="graduation" size={18} />}
                                aria-describedby={launchFailure ? 'pr-classroom-launch-failure' : undefined}
                                data-classroom-launch-action="true"
                            >
                                {launchFailure ? '重新尝试启动' : '开始课堂'}
                            </Button>
                        </div>
                    </GlassCard>
                </div>
            </div >
        )
    }

    // ── 已开始：显示课堂主界面 ──
    return (
        <div className={`pr-classroom pr-v5-enter-classroom ${modeSwitching ? 'pr-classroom--mode-switching' : ''}`}>
            {/* Header */}
            <div className="pr-classroom-header">
                <div className="pr-classroom-header-left">
                    <span className="pr-classroom-header-title-icon" data-flip-id="classroom-mode-icon">
                        <Icon name="graduation" size={18} />
                    </span>
                    <h2 className="pr-classroom-header-title" data-flip-id="classroom-mode-title">
                        {CLASSROOM_MODE_LABELS[mode]}
                        {ended && <span style={{ color: 'rgb(var(--c-accent-success))', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium, 500)' }}> · 已结束</span>}
                    </h2>
                </div>

                <div className="pr-classroom-header-meta">
                    <span className="pr-classroom-join-code">
                        <Icon name="share" size={12} />
                        {joinCode || '—'}
                    </span>
                    <span className="pr-classroom-student-count">
                        <Icon name="user" size={12} />
                        {activeStudents} 人在线
                    </span>
                    <span
                        className="pr-classroom-student-count"
                        style={{
                            color: wsConnected
                                ? 'rgb(var(--c-accent-success))'
                                : 'rgb(var(--c-text-tertiary))',
                        }}
                    >
                        <span
                            style={{
                                width: 6,
                                height: 6,
                                borderRadius: 'var(--radius-full)',
                                backgroundColor: wsConnected
                                    ? 'rgb(var(--c-accent-success))'
                                    : 'rgb(var(--c-text-tertiary))',
                                display: 'inline-block',
                            }}
                        />
                        {WS_STATUS_LABELS[wsStatus] ?? wsStatus}
                    </span>
                </div>

                <div className="pr-classroom-header-actions">
                    {!ended && (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setControlCollapsed((value) => !value)}
                            leftIcon={<Icon name={controlCollapsed ? 'caret-left' : 'caret-right'} size={14} />}
                            aria-expanded={!controlCollapsed}
                            aria-controls="classroom-control-rail"
                        >
                            {controlCollapsed ? '展开控制台' : '收起控制台'}
                        </Button>
                    )}
                    {ended && report && (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setReportOpen(true)}
                            leftIcon={<Icon name="chart-bar" size={14} />}
                        >
                            查看报告
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleExit}
                        leftIcon={<Icon name="arrow-left" size={14} />}
                    >
                        {ended ? '返回' : '退出课堂'}
                    </Button>
                </div>
            </div>

            {/* 主体网格 —— 报告视图显示精简报告回看卡片，非报告视图显示完整课堂舞台 */}
            {isReportView ? (
                <div className="pr-classroom-body pr-classroom-report-review">
                    <div className="pr-classroom-report-review-card">
                        <div className="pr-classroom-report-review-icon">
                            <Icon name="chart-bar" size={32} />
                        </div>
                        <div className="pr-classroom-report-review-body">
                            <h3 className="pr-classroom-report-review-title">
                                课堂协奏报告
                            </h3>
                            <p className="pr-classroom-report-review-summary">
                                {report?.report.summary ?? '报告加载中…'}
                            </p>
                            {report && (
                                <div className="pr-classroom-report-review-meta">
                                    <span>
                                        <Icon name="user" size={12} />
                                        {report.report.participation} 人参与
                                    </span>
                                    <span>
                                        <Icon name="chart-line-up" size={12} />
                                        掌握度 {report.report.masteryChange.before}% → {report.report.masteryChange.after}%
                                    </span>
                                </div>
                            )}
                        </div>
                        {report && (
                            <Button
                                variant="primary"
                                size="md"
                                onClick={() => setReportOpen(true)}
                                leftIcon={<Icon name="chart-bar" size={16} />}
                            >
                                查看完整报告
                            </Button>
                        )}
                    </div>
                </div>
            ) : (
                <div
                    className={`pr-classroom-body ${controlCollapsed ? 'pr-classroom-body--control-collapsed' : ''}`}
                    ref={contentRef}
                >
                        <div
                            id="pr-classroom-view-panel"
                            className="pr-classroom-main"
                            role="tabpanel"
                            aria-labelledby={`pr-classroom-view-tab-${viewMode}`}
                        >
                        {/* Phase 4.3：课堂视图模式切换 —— quiz 答题 / explain 讲解 / dance 共舞 */}
                        <div className="pr-classroom-view-switch" role="tablist" aria-label="课堂视图模式" onKeyDown={handleViewModeKeyDown}>
                            <button
                                id="pr-classroom-view-tab-quiz"
                                data-classroom-view-tab="quiz"
                                type="button"
                                role="tab"
                                aria-selected={viewMode === 'quiz'}
                                aria-controls="pr-classroom-view-panel"
                                tabIndex={viewMode === 'quiz' ? 0 : -1}
                                className={`pr-classroom-view-tab ${viewMode === 'quiz' ? 'pr-classroom-view-tab--active' : ''}`}
                                onClick={() => setViewMode('quiz')}
                            >
                                <Icon name="graduation" size={14} />
                                答题模式
                            </button>
                            <button
                                id="pr-classroom-view-tab-explain"
                                data-classroom-view-tab="explain"
                                type="button"
                                role="tab"
                                aria-selected={viewMode === 'explain'}
                                aria-controls="pr-classroom-view-panel"
                                tabIndex={viewMode === 'explain' ? 0 : -1}
                                className={`pr-classroom-view-tab ${viewMode === 'explain' ? 'pr-classroom-view-tab--active' : ''}`}
                                onClick={() => setViewMode('explain')}
                            >
                                <Icon name="book-open" size={14} />
                                讲解模式
                            </button>
                            <button
                                id="pr-classroom-view-tab-dance"
                                data-classroom-view-tab="dance"
                                type="button"
                                role="tab"
                                aria-selected={viewMode === 'dance'}
                                aria-controls="pr-classroom-view-panel"
                                tabIndex={viewMode === 'dance' ? 0 : -1}
                                className={`pr-classroom-view-tab ${viewMode === 'dance' ? 'pr-classroom-view-tab--active' : ''}`}
                                onClick={() => setViewMode('dance')}
                            >
                                <Icon name="magic-wand" size={14} />
                                共舞舞台
                            </button>
                        </div>

                        {/* 闯关 HUD —— 七个模式共用，且在讲解/编舞视图下同样常驻：
                            关卡进度与全班诗力值是贯穿整节课的，不该随视图切换而消失 */}
                        <QuestHud />

                        {viewMode === 'explain' ? (
                            <ExplainPanel poemId={status.currentQuestion?.poemId ?? poemId} />
                        ) : viewMode === 'dance' ? (
                            <DanceStage
                                lessonId={lessonId}
                                poemId={status.currentQuestion?.poemId ?? poemId}
                            />
                        ) : (
                            <ClassroomStage
                                mode={mode}
                                question={status.currentQuestion}
                                questionIndex={status.currentQuestionIndex}
                                totalQuestions={status.totalQuestions}
                                responses={responses}
                                activeStudents={activeStudents}
                                flyingFlowerKeyword={status.flyingFlowerKeyword}
                                onTimeout={() => {
                                    // 集体闯关倒计时归零，自动切换下一题
                                    void next()
                                }}
                            />
                        )}
                        <AIAssistant
                            messages={aiMessages}
                            wsConnected={wsConnected}
                            lessonId={lessonId}
                            currentQuestionId={status.currentQuestion?.id}
                            responses={responses}
                        />
                    </div>

                    <div
                        id="classroom-control-rail"
                        className="pr-classroom-side"
                        aria-hidden={controlCollapsed}
                    >
                        <ClassroomControl
                            mode={mode}
                            status={status}
                            responses={responses}
                            questionIndex={status.currentQuestionIndex}
                            totalQuestions={status.totalQuestions}
                            advancing={advancing}
                            pushingHint={pushingHint}
                            pushingDiscuss={pushingDiscuss}
                            ending={ending}
                            modeSwitching={modeSwitching}
                            modeMeta={MODE_META}
                            onNext={handleNext}
                            onPushHint={handlePushHint}
                            onPushDiscuss={handlePushDiscuss}
                            onEnd={handleEnd}
                            onModeSwitch={handleModeSwitch}
                        />
                    </div>

                    {/* 课堂事件时间轴（Task 4）—— 横跨主体底部 */}
                    {started && !ended && (
                        <EventTimeline
                            events={timelineEvents}
                            currentTime={Date.now()}
                            startedAt={startedAtRef.current}
                        />
                    )}
                </div>
            )}

            {/* 课堂协奏报告 Modal */}
            <ClassroomReportModal
                open={reportOpen}
                onClose={() => setReportOpen(false)}
                report={report}
            />
        </div>
    )
}
