/**
 * Dashboard 全局状态（规范第 12 章 —— 实时数据同步）
 *
 * 职责：
 * 1. 持有 dashboard 四类数据：stats / radar / alerts / weeklyProgress
 * 2. 管理 WebSocket 连接状态与最后事件时间戳
 * 3. 提供 fetchAll / refreshAlerts / refreshStats 等异步动作
 * 4. handleWSEvent 处理编排官实时事件，触发关联视图同步更新（≤200ms）
 *
 * 设计要点：
 * - 数据同步遵循"乐观更新 + 后台重验证"模式（规范 12.3）
 * - 任何一处的数据变化，所有关联视图在感知阈值内同步更新
 * - 班级切换时自动重新拉取全部数据
 * - 加载失败时降级保留旧数据，不空白
 *
 * 性能（规范 12.2）：
 * - 同页面内组件数据变更即时同步（≤50ms，Zustand 同步更新）
 * - WebSocket 事件触发 refresh 时使用 debounce，避免高频事件风暴
 */

import { getDisplayError } from '@/lib/errors'
import { useNotificationStore } from '@/stores/notifications'
import { businessEvents } from '@/lib/business-events'
import { create } from 'zustand'
import { api } from '@/lib/api'
import type {
    DashboardStats,
    BloomRadar,
    DashboardAlert,
    WeeklyDay,
    WSStatus,
    WSEvent,
    BloomLevel,
} from '@/lib/types'

/** 空数据初始值，避免 undefined 导致组件类型断言 */
const EMPTY_STATS: DashboardStats = {
    classId: '',
    className: '',
    studentCount: 0,
    weekLearnedPoems: 0,
    classMasteryAvg: 0,
    masteryRecordCount: 0,
    pendingAlerts: 0,
    weekProgress: { learned: 0, total: 0 },
}

const EMPTY_RADAR: BloomRadar = {
    classId: '',
    sampleSize: 0,
    radar: {
        记忆: 0, 理解: 0, 应用: 0, 分析: 0, 评价: 0, 创造: 0,
    } as Record<BloomLevel, number>,
}

/** 事件触发刷新的 debounce 延迟（ms） */
const REFRESH_DEBOUNCE_MS = 800

interface DashboardState {
    /** 当前班级 ID */
    classId: string
    /** 班级名称 */
    className: string

    /** 顶部统计卡片数据 */
    stats: DashboardStats
    /** 六阶能力雷达数据 */
    radar: BloomRadar
    /** 实时预警列表 */
    alerts: DashboardAlert[]
    /** 本周教学进度 */
    weeklyProgress: WeeklyDay[]

    /** WebSocket 连接状态 */
    wsStatus: WSStatus
    /** 最后一次接收到的 WS 事件时间戳 */
    lastEventAt: number | null
    /** 最后一次成功同步时间戳 */
    lastSyncedAt: number | null

    /** 加载态 */
    loading: boolean
    /** 错误信息（null 表示无错误） */
    error: string | null

    // ── 动作 ──
    /** 设置当前班级（会触发数据重载） */
    setClassId: (classId: string) => void
    /** 设置 WS 连接状态 */
    setWsStatus: (status: WSStatus) => void
    /** 拉取全部 dashboard 数据 */
    fetchAll: (classId?: string) => Promise<void>
    /** 仅刷新预警列表（高频更新场景） */
    refreshAlerts: () => Promise<void>
    /** 仅刷新统计卡片 */
    refreshStats: () => Promise<void>
    /** 仅刷新本周进度（v5.0 Task 4.4：self-study → dashboard 同步） */
    refreshWeeklyProgress: () => Promise<void>
    /** 处理 WS 事件（编排官事件流） */
    handleWSEvent: (event: WSEvent) => void
    /** 重置 store */
    reset: () => void
}

/** 内部 debounce 定时器引用（模块级，避免 store 重置丢失） */
let refreshTimer: number | null = null

/**
 * Dashboard Zustand store
 *
 * 用法：
 *   const { stats, fetchAll, wsStatus } = useDashboardStore()
 *   useDashboardStore.getState().setClassId('class-001')
 */
export const useDashboardStore = create<DashboardState>((set, get) => ({
    classId: '',
    className: '',

    stats: EMPTY_STATS,
    radar: EMPTY_RADAR,
    alerts: [],
    weeklyProgress: [],

    wsStatus: 'idle',
    lastEventAt: null,
    lastSyncedAt: null,

    loading: false,
    error: null,

    setClassId: (classId) => {
        // 班级是整个 Dashboard 的实体边界。切换时先清空旧班展示，避免在新班
        // 标题下短暂呈现旧统计；每个异步完成态还会再次核对 classId。
        set({
            classId,
            className: '',
            stats: EMPTY_STATS,
            radar: EMPTY_RADAR,
            alerts: [],
            weeklyProgress: [],
            lastSyncedAt: null,
            loading: true,
            error: null,
        })
        // 班级切换后自动重载全部数据
        void get().fetchAll(classId)
    },

    setWsStatus: (status) => {
        set({ wsStatus: status })
    },

    fetchAll: async (classIdOverride?: string) => {
        const classId = classIdOverride ?? get().classId
        if (!classId) {
            set({ error: '未设置班级 ID' })
            return
        }

        set({ loading: true, error: null })

        try {
            // 并行拉取四类数据，任一失败不影响其他
            const results = await Promise.allSettled([
                api.dashboard.stats(classId),
                api.dashboard.bloomRadar(classId),
                api.dashboard.alerts(classId, 10),
                api.dashboard.weeklyProgress(classId),
            ])
            if (get().classId !== classId) return

            const next: Partial<DashboardState> = {
                loading: false,
                lastSyncedAt: Date.now(),
            }

            const statsResult = results[0]
            if (statsResult && statsResult.status === 'fulfilled') {
                next.stats = statsResult.value
                next.className = statsResult.value.className
            }

            const radarResult = results[1]
            if (radarResult && radarResult.status === 'fulfilled') {
                next.radar = radarResult.value
            }

            const alertsResult = results[2]
            if (alertsResult && alertsResult.status === 'fulfilled') {
                // 防御性校验：alerts 可能为 undefined/null（后端契约漂移），降级为空数组
                next.alerts = Array.isArray(alertsResult.value.alerts)
                    ? alertsResult.value.alerts
                    : []
            }

            const weeklyResult = results[3]
            if (weeklyResult && weeklyResult.status === 'fulfilled') {
                // 防御性校验：days 可能为 undefined/null，降级为空数组
                next.weeklyProgress = Array.isArray(weeklyResult.value.days)
                    ? weeklyResult.value.days
                    : []
            }

            // 收集首个失败原因作为错误提示（不阻塞其他数据展示）
            const firstError = results.find((r) => r.status === 'rejected')
            if (firstError && firstError.status === 'rejected') {
                next.error = firstError.reason instanceof Error
                    ? firstError.reason.message
                    : String(firstError.reason)
            } else {
                next.error = null
            }

            set(next)
        } catch (err) {
            if (get().classId !== classId) return
            set({
                loading: false,
                error: getDisplayError(err, '数据加载失败'),
            })
        }
    },

    refreshAlerts: async () => {
        const { classId } = get()
        if (!classId) return
        try {
            const res = await api.dashboard.alerts(classId, 10)
            if (get().classId !== classId) return
            set({ alerts: res.alerts, lastSyncedAt: Date.now() })
        } catch {
            // 静默失败，保留旧数据
        }
    },

    refreshStats: async () => {
        const { classId } = get()
        if (!classId) return
        try {
            const stats = await api.dashboard.stats(classId)
            if (get().classId !== classId) return
            set({ stats, className: stats.className, lastSyncedAt: Date.now() })
        } catch {
            // 静默失败
        }
    },

    refreshWeeklyProgress: async () => {
        const { classId } = get()
        if (!classId) return
        try {
            const res = await api.dashboard.weeklyProgress(classId)
            if (get().classId !== classId) return
            set({ weeklyProgress: res.days, lastSyncedAt: Date.now() })
        } catch {
            // 静默失败，保留旧数据
        }
    },

    handleWSEvent: (event) => {
        // 记录事件时间戳
        set({ lastEventAt: event.timestamp })

        // 编排会话结束 → 推送通知中心消息（通知不参与 debounce，即时送达）
        if (event.type === 'orch:session:end') {
            useNotificationStore.getState().push({
                type: 'info',
                title: '编排会话已结束',
                description: '多智能体协作任务已完成，点击查看详情',
                linkTo: '/ai-copilot',
            })
        }

        // 根据事件类型决定是否触发数据刷新
        // 使用 debounce 避免高频事件风暴（如 agent:call:success 连续触发）
        const shouldRefresh = shouldTriggerRefresh(event.type)
        if (!shouldRefresh) return

        if (refreshTimer !== null) {
            window.clearTimeout(refreshTimer)
        }
        refreshTimer = window.setTimeout(() => {
            // 任务完成 / 失败 → 刷新统计与预警
            // 会话结束 → 刷新全部数据
            const { fetchAll, refreshStats, refreshAlerts } = get()
            if (event.type === 'orch:session:end') {
                void fetchAll()
            } else {
                void refreshStats()
                void refreshAlerts()
            }
            refreshTimer = null
        }, REFRESH_DEBOUNCE_MS)
    },

    reset: () => {
        if (refreshTimer !== null) {
            window.clearTimeout(refreshTimer)
            refreshTimer = null
        }
        set({
            classId: '',
            className: '',
            stats: EMPTY_STATS,
            radar: EMPTY_RADAR,
            alerts: [],
            weeklyProgress: [],
            wsStatus: 'idle',
            lastEventAt: null,
            lastSyncedAt: null,
            loading: false,
            error: null,
        })
    },
}))

/**
 * 判断事件类型是否应触发 dashboard 数据刷新
 *
 * 触发刷新的事件：
 * - orch:task:done / orch:task:failed —— 任务完成或失败，统计与预警可能变化
 * - orch:session:end —— 会话结束，全量刷新
 * - orch:task:skipped —— 任务跳过，统计可能变化
 *
 * 不触发刷新的事件：
 * - orch:task:progress —— 仅进度更新，不影响统计
 * - agent:call:* / llm:call:* —— 底层调用，由 task:done 聚合
 * - billing:record —— 计费事件，与 dashboard 无关
 */
function shouldTriggerRefresh(eventType: string): boolean {
    switch (eventType) {
        case 'orch:task:done':
        case 'orch:task:failed':
        case 'orch:task:skipped':
        case 'orch:session:end':
            return true
        default:
            return false
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// v5.0 Task 4.4：业务事件总线订阅 —— self-study → dashboard 数据断点修复
//
// 学生在自学舱完成关键节点（诊断 / 闯关 / 朗读）时，self-study store 会发射
// 'self-study:progress' 业务事件。dashboard 在模块加载时订阅该事件，触发
// 预警列表与本周进度的后台刷新，确保教师切回驾驶舱时看到最新数据（无需手动刷新）。
//
// 严苛验收：在 self-study 完成任务后，切到 dashboard，预警数和周进度已更新。
// ─────────────────────────────────────────────────────────────────────────────
businessEvents.on('self-study:progress', () => {
    void useDashboardStore.getState().refreshAlerts()
    void useDashboardStore.getState().refreshWeeklyProgress()
    // 统计卡片（学生数 / 平均掌握度）也可能变化，一并刷新
    void useDashboardStore.getState().refreshStats()
})

// v5.0 Task 4.6：批改完成 → 刷新 dashboard 统计与预警（认知漏洞可能变化）
businessEvents.on('grading:reviewed', () => {
    void useDashboardStore.getState().refreshStats()
    void useDashboardStore.getState().refreshAlerts()
})

// v5.0 Task 4.7：课堂结束 → 全量刷新 dashboard（统计 / 预警 / 周进度全部可能变化）
businessEvents.on('classroom:ended', () => {
    void useDashboardStore.getState().fetchAll()
})

// v5.0 Task 4.7：报告生成 → 刷新统计（课堂报告生成后，参与度等指标可能更新）
businessEvents.on('report:generated', () => {
    void useDashboardStore.getState().refreshStats()
    void useDashboardStore.getState().refreshWeeklyProgress()
})

// Phase 1.1：朗读完成 → 刷新周进度与统计（学生完成朗读评估，本周学习进度变化）
// 断裂点#1修复：recitation:completed 事件此前无订阅者，朗读数据无法同步至驾驶舱
businessEvents.on('recitation:completed', () => {
    void useDashboardStore.getState().refreshWeeklyProgress()
    void useDashboardStore.getState().refreshStats()
})

// Phase 1.5：作品提交 → 刷新统计（学生创造作品提交，参与度指标变化）
// 断裂点修复：creation store 此前不参与事件总线，作品数据无法同步至驾驶舱
businessEvents.on('creation:submitted', () => {
    void useDashboardStore.getState().refreshStats()
    void useDashboardStore.getState().refreshWeeklyProgress()
})
