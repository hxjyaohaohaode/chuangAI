/**
 * 教研报告全局状态（Task 14 + v5.0 数据真实化）
 *
 * 职责：
 * 1. 持有生成表单状态（班级、时间范围、模板、章节）
 * 2. 追踪当前报告生成进度（WebSocket 推送 + SSE 流式回退）
 * 3. 管理历史报告列表（分页 + 搜索 + 时间/模板/状态筛选）
 * 4. 处理导出、删除等动作（含高级导出 exportAdvanced）
 * 5. WebSocket 事件分发：task:start / task:done / task:failed / session:end
 * 6. v5.0：SSE 流式生成（progress + delta + done），实时 Markdown 增量
 *
 * 设计要点（参考 workbench.ts）：
 * - fire-and-forget：generate 立即返回 reportId + sessionId，结果通过 WS 推送
 * - WS 收到 SESSION_END 或 TASK_DONE(report-finalize) 后自动拉取最终结果
 * - v5.0：streamGenerate 通过 SSE 同步推送 Markdown 增量，无需依赖 WS
 * - 乐观更新：删除后立即更新本地列表
 * - 轮询兜底：WS 未连接且未使用 SSE 时，生成中报告每 2s 轮询 GET /:reportId
 */

import { getDisplayError } from '@/lib/errors'
import { create } from 'zustand'
import { api } from '@/lib/api'
import type { LessonStreamController } from '@/lib/types'
import { toast } from '@/stores/toast'
import { isDemoMode } from '@/lib/demo-mode'
import { useNotificationStore } from '@/stores/notifications'
import { businessEvents } from '@/lib/business-events'
import type {
    ReportTemplate,
    ReportSectionKey,
    ReportRecord,
    ReportSummary,
    ReportTemplateOption,
    ReportSectionOption,
    WSStatus,
    WSEvent,
} from '@/lib/types'
import { useAuthStore } from '@/stores/auth'

// ─────────────────────────────────────────────────────────────
// 默认值
// ─────────────────────────────────────────────────────────────

// teacherId 由 useAuthStore 统一管理（P1-B）

/** 默认时间范围：最近 30 天 */
function getDefaultPeriod(): { from: string; to: string } {
    const now = new Date()
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    return {
        from: from.toISOString().slice(0, 10),
        to: now.toISOString().slice(0, 10),
    }
}

// ─────────────────────────────────────────────────────────────
// Store 类型
// ─────────────────────────────────────────────────────────────

interface ReportState {
    // ── 表单状态 ──
    classId: string
    period: { from: string; to: string }
    template: ReportTemplate
    includeSections: ReportSectionKey[]
    teacherId: string

    // ── 模板与章节选项 ──
    templates: ReportTemplateOption[]
    sections: ReportSectionOption[]
    optionsLoading: boolean

    // ── 当前报告（生成中 / 已完成） ──
    currentReport: ReportRecord | null
    generating: boolean

    // ── v5.0：SSE 流式生成状态 ──
    /** 流式生成的 Markdown 增量内容（生成中实时累积，完成后清空） */
    streamMarkdown: string
    /** 流式生成是否正在输出（用于 ReportPreview 显示脉动光标） */
    streamActive: boolean
    /** SSE 流控制器（用于中断生成） */
    streamController: LessonStreamController | null
    /** 流式生成的进度消息（来自 onProgress 回调） */
    streamMessage: string

    // ── 多智能体任务进度 ──
    agentTasks: Array<{
        taskId: string
        agentId: string
        status: 'running' | 'success' | 'failed'
        startedAt?: number
        endedAt?: number
        error?: string
    }>
    currentAgentId: string | null

    // ── 历史报告 ──
    history: ReportSummary[]
    historyTotal: number
    historyLoading: boolean
    historyKeyword: string
    historyPage: number
    historyPageSize: number
    // v5.0：历史筛选（时间范围/模板/状态）
    historyFilterFrom: string
    historyFilterTo: string
    historyFilterTemplate: ReportTemplate | ''
    historyFilterStatus: ReportSummary['status'] | ''

    // ── 加载/错误 ──
    exporting: boolean
    error: string | null

    // ── WebSocket ──
    wsStatus: WSStatus
    /** 轮询定时器 ID（WS 未连接时兜底） */
    pollTimerId: number | null

    // ── 动作 ──
    setClassId: (classId: string) => void
    setPeriod: (period: { from: string; to: string }) => void
    setTemplate: (template: ReportTemplate) => void
    toggleSection: (section: ReportSectionKey) => void
    setTeacherId: (teacherId: string) => void
    setWsStatus: (status: WSStatus) => void

    // v5.0：历史筛选设置器
    setHistoryFilter: (patch: Partial<{
        keyword: string
        from: string
        to: string
        template: ReportTemplate | ''
        status: ReportSummary['status'] | ''
    }>) => void

    fetchOptions: () => Promise<void>
    generate: () => Promise<void>
    /** v5.0：SSE 流式生成（同步推送 Markdown 增量） */
    streamGenerate: () => Promise<void>
    /** v5.0：中断流式生成 */
    abortStream: () => void
    fetchReport: (reportId: string) => Promise<void>
    fetchHistory: (reset?: boolean) => Promise<void>
    deleteReport: (reportId: string) => Promise<void>
    exportReport: (reportId: string, format: 'word' | 'pdf' | 'markdown') => Promise<void>
    /** v5.0：高级导出（POST，支持模块/图表/验收信息选择） */
    exportAdvanced: (req: {
        reportId: string
        format: 'word' | 'pdf' | 'markdown' | 'excel'
        includeSections?: ReportSectionKey[]
        includeCharts?: boolean
        includeVerification?: boolean
    }) => Promise<void>
    previewPrint: (reportId: string) => void

    handleWSEvent: (event: WSEvent) => void
    reset: () => void
}

type ReportStateSetter = (
    partial: Partial<ReportState> | ((state: ReportState) => Partial<ReportState>),
) => void
type ReportStateGetter = () => ReportState

/**
 * 非 SSE 报告拉取的运行时状态。
 *
 * `reportGeneration` 隔离“报告身份”：reset、重新生成或查看另一份报告后，
 * 旧请求即使晚到也无权再写 store。`pollGeneration` 隔离“轮询会话”：WS
 * 接管、页面隐藏或重启轮询后，上一轮 tick 不得继续调度下一次请求。
 * 这些值刻意不放进 Zustand 响应式状态，避免纯生命周期 bookkeeping
 * 引发组件重渲染；公开的 `pollTimerId` 仍保留以兼容既有调用方。
 */
interface ReportPollingRuntime {
    reportGeneration: number
    activeReportId: string | null
    pollGeneration: number
    pollActive: boolean
    pollReportId: string | null
    pollTimerId: number | null
    visibilityCleanup: (() => void) | null
    activeRequest: {
        reportId: string
        reportGeneration: number
        source: 'manual' | 'poll'
        pollGeneration: number | null
        controller: AbortController
        promise: Promise<void>
    } | null
}

const REPORT_POLL_INTERVAL_MS = 2_000
const reportPollingRuntime: ReportPollingRuntime = {
    reportGeneration: 0,
    activeReportId: null,
    pollGeneration: 0,
    pollActive: false,
    pollReportId: null,
    pollTimerId: null,
    visibilityCleanup: null,
    activeRequest: null,
}

// ─────────────────────────────────────────────────────────────
// Store 实现
// ─────────────────────────────────────────────────────────────

export const useReportStore = create<ReportState>((set, get) => ({
    // ── 初始表单状态 ──
    classId: '',
    period: getDefaultPeriod(),
    template: 'standard',
    includeSections: ['background', 'intervention', 'evidence', 'reflection'],
    teacherId: useAuthStore.getState().teacherId,

    // ── 模板与章节选项 ──
    templates: [],
    sections: [],
    optionsLoading: false,

    // ── 当前报告 ──
    currentReport: null,
    generating: false,

    // v5.0：SSE 流式生成状态
    streamMarkdown: '',
    streamActive: false,
    streamController: null,
    streamMessage: '',

    // ── 多智能体任务进度 ──
    agentTasks: [],
    currentAgentId: null,

    // ── 历史报告 ──
    history: [],
    historyTotal: 0,
    historyLoading: false,
    historyKeyword: '',
    historyPage: 0,
    // v5.0：每页 20 条（按用户要求）
    historyPageSize: 20,
    // v5.0：历史筛选
    historyFilterFrom: '',
    historyFilterTo: '',
    historyFilterTemplate: '' as ReportTemplate | '',
    historyFilterStatus: '' as ReportSummary['status'] | '',

    // ── 加载/错误 ──
    exporting: false,
    error: null,

    // ── WebSocket ──
    wsStatus: 'idle',
    pollTimerId: null,

    // ── 动作实现 ──

    setClassId: (classId) => set({ classId }),
    setPeriod: (period) => set({ period }),
    setTemplate: (template) => set({ template }),
    setTeacherId: (teacherId) => set({ teacherId }),

    toggleSection: (section) =>
        set((state) => {
            const has = state.includeSections.includes(section)
            const next = has
                ? state.includeSections.filter((s) => s !== section)
                : [...state.includeSections, section]
            return { includeSections: next.length > 0 ? next : state.includeSections }
        }),

    setWsStatus: (wsStatus) => {
        const previousStatus = get().wsStatus
        set({ wsStatus })

        // WS 一旦可用便立即接管，连正在等待的 HTTP 轮询请求也一并取消。
        if (wsStatus === 'connected') {
            stopPolling(set, get)
            return
        }

        // 仅从已连接状态掉线时恢复兜底；重复的 disconnected/error 通知
        // 不得创建第二条计时链。SSE 有独立控制器，不参与此轮询生命周期。
        const state = get()
        if (
            previousStatus === 'connected' &&
            state.generating &&
            state.currentReport?.status === 'generating' &&
            !state.streamActive &&
            !state.streamController
        ) {
            startPolling(set, get, state.currentReport.id)
        }
    },

    // v5.0：历史筛选统一设置器
    setHistoryFilter: (patch) => {
        set(() => {
            const next: Partial<ReportState> = {}
            if (patch.keyword !== undefined) {
                next.historyKeyword = patch.keyword
                next.historyPage = 0
            }
            if (patch.from !== undefined) {
                next.historyFilterFrom = patch.from
                next.historyPage = 0
            }
            if (patch.to !== undefined) {
                next.historyFilterTo = patch.to
                next.historyPage = 0
            }
            if (patch.template !== undefined) {
                next.historyFilterTemplate = patch.template
                next.historyPage = 0
            }
            if (patch.status !== undefined) {
                next.historyFilterStatus = patch.status
                next.historyPage = 0
            }
            return next
        })
    },

    fetchOptions: async () => {
        // v5.0 Task 5.8：DEMO 模式下跳过 API 调用，保留空模板列表
        if (isDemoMode()) {
            set({ optionsLoading: false })
            return
        }
        set({ optionsLoading: true })
        try {
            const res = await api.report.templates()
            // 防御性校验：templates/sections 可能为 undefined/null（后端契约漂移），降级为空数组
            set({
                templates: Array.isArray(res.templates) ? res.templates : [],
                sections: Array.isArray(res.sections) ? res.sections : [],
                optionsLoading: false,
            })
        } catch (err) {
            set({ optionsLoading: false })
            toast.error({ title: '加载模板失败', message: getDisplayError(err, '未知错误') })
        }
    },

    generate: async () => {
        const state = get()
        if (!state.classId) {
            toast.warning({ title: '请先选择班级', message: '生成教研报告需指定目标班级' })
            return
        }

        // 构造 ISO 时间字符串（日期 → ISO 起止）
        const fromIso = new Date(`${state.period.from}T00:00:00Z`).toISOString()
        const toIso = new Date(`${state.period.to}T23:59:59Z`).toISOString()

        if (Date.parse(fromIso) >= Date.parse(toIso)) {
            toast.warning({ title: '时间范围无效', message: '开始日期需早于结束日期' })
            return
        }

        // 新一次生成拥有独立报告代际；此前所有计时器和在途拉取均失效。
        const generation = beginReportLifecycle(set, get, null)

        set({
            generating: true,
            error: null,
            currentReport: null,
            agentTasks: [],
            currentAgentId: null,
        })

        try {
            const res = await api.report.generate({
                classId: state.classId,
                period: { from: fromIso, to: toIso },
                template: state.template,
                includeSections: state.includeSections,
                teacherId: state.teacherId,
            })

            // reset、切换报告或再次点击生成后，旧 generate 响应不得复活 UI。
            if (!isCurrentReportGeneration(generation, null)) return
            reportPollingRuntime.activeReportId = res.reportId

            // 立即创建一个生成中的报告占位，便于 UI 反馈
            const placeholder: ReportRecord = {
                id: res.reportId,
                teacherId: state.teacherId,
                classId: state.classId,
                className: '',
                period: { from: Date.parse(fromIso), to: Date.parse(toIso) },
                template: state.template,
                includeSections: state.includeSections,
                status: 'generating',
                progress: 0,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }
            set({ currentReport: placeholder })
            toast.info({ title: '报告生成已启动', message: '多智能体正在协作，请稍候' })

            // WS 未连接时启动轮询兜底
            if (get().wsStatus !== 'connected') {
                startPolling(set, get, res.reportId)
            }
        } catch (err) {
            if (!isCurrentReportGeneration(generation, null)) return
            set({ generating: false })
            const msg = getDisplayError(err, '未知错误')
            set({ error: msg })
            toast.error({ title: '生成启动失败', message: msg })
        }
    },

    fetchReport: (reportId) => fetchReportWithLifecycle(set, get, reportId, 'manual'),

    fetchHistory: async (reset = false) => {
        const state = get()
        const page = reset ? 0 : state.historyPage
        // v5.0 Task 5.8：DEMO 模式下跳过 API 调用，保留空历史列表
        if (isDemoMode()) {
            set({ history: [], historyTotal: 0, historyPage: page, historyLoading: false })
            return
        }
        set({ historyLoading: true })
        try {
            // v5.0：优先使用扩展的 history 接口（支持时间范围/模板/状态筛选）
            // 仅当无筛选条件时降级使用 list（向后兼容）
            const hasAdvancedFilter =
                !!state.historyFilterFrom ||
                !!state.historyFilterTo ||
                !!state.historyFilterTemplate ||
                !!state.historyFilterStatus

            if (hasAdvancedFilter) {
                const res = await api.report.history({
                    teacherId: state.teacherId,
                    classId: state.classId || undefined,
                    from: state.historyFilterFrom || undefined,
                    to: state.historyFilterTo || undefined,
                    template: state.historyFilterTemplate || undefined,
                    status: state.historyFilterStatus || undefined,
                    keyword: state.historyKeyword || undefined,
                    limit: state.historyPageSize,
                    offset: page * state.historyPageSize,
                })
                set({
                    history: Array.isArray(res.items) ? res.items : [],
                    historyTotal: typeof res.total === 'number' ? res.total : 0,
                    historyPage: page,
                    historyLoading: false,
                })
            } else {
                const res = await api.report.list({
                    teacherId: state.teacherId,
                    classId: state.classId || undefined,
                    limit: state.historyPageSize,
                    offset: page * state.historyPageSize,
                    keyword: state.historyKeyword || undefined,
                })
                // 防御性校验：res.items 可能为 undefined/null，降级为空数组；res.total 降级为 0
                set({
                    history: Array.isArray(res.items) ? res.items : [],
                    historyTotal: typeof res.total === 'number' ? res.total : 0,
                    historyPage: page,
                    historyLoading: false,
                })
            }
        } catch (err) {
            set({ historyLoading: false })
            toast.error({ title: '加载历史失败', message: getDisplayError(err, '未知错误') })
        }
    },

    deleteReport: async (reportId) => {
        const state = get()
        try {
            await api.report.delete(reportId, state.teacherId)
            set((s) => ({
                currentReport: s.currentReport?.id === reportId ? null : s.currentReport,
                history: s.history.filter((h) => h.id !== reportId),
                historyTotal: Math.max(0, s.historyTotal - 1),
            }))
            toast.success({ title: '已删除', message: '报告已从历史中移除' })
        } catch (err) {
            toast.error({ title: '删除失败', message: getDisplayError(err, '未知错误') })
        }
    },

    exportReport: async (reportId, format) => {
        const state = get()
        const report = state.currentReport
        const fileName = report && report.className
            ? `${report.className}-教研报告`
            : '教研报告'
        set({ exporting: true })
        try {
            await api.report.exportReport(reportId, format, fileName)
            set({ exporting: false })
            const label = format === 'word'
                ? 'Word 兼容文档（.doc）'
                : format === 'pdf'
                    ? '打印版 HTML（可另存为 PDF）'
                    : 'Markdown'
            toast.success({ title: '导出成功', message: `已导出为 ${label} 文件` })
        } catch (err) {
            set({ exporting: false })
            toast.error({ title: '导出失败', message: getDisplayError(err, '未知错误') })
        }
    },

    // v5.0：高级导出（POST，支持模块/图表/验收信息选择）
    exportAdvanced: async (req) => {
        const state = get()
        const report = state.currentReport
        const fileName = report && report.className
            ? `${report.className}-教研报告`
            : '教研报告'
        set({ exporting: true })
        try {
            await api.report.exportAdvanced(
                {
                    reportId: req.reportId,
                    format: req.format,
                    includeSections: req.includeSections,
                    includeCharts: req.includeCharts,
                    includeVerification: req.includeVerification,
                },
                fileName,
            )
            set({ exporting: false })
            const labelMap: Record<string, string> = {
                word: 'Word 兼容文档（.doc）',
                pdf: '打印版 HTML（可另存为 PDF）',
                markdown: 'Markdown',
                excel: 'Excel 兼容 CSV',
            }
            toast.success({ title: '导出成功', message: `已导出为 ${labelMap[req.format] ?? req.format} 文件` })
        } catch (err) {
            set({ exporting: false })
            toast.error({ title: '导出失败', message: getDisplayError(err, '未知错误') })
        }
    },

    // v5.0：SSE 流式生成（同步推送 Markdown 增量）
    streamGenerate: async () => {
        const state = get()
        if (!state.classId) {
            toast.warning({ title: '请先选择班级', message: '生成教研报告需指定目标班级' })
            return
        }

        // 构造 ISO 时间字符串
        const fromIso = new Date(`${state.period.from}T00:00:00Z`).toISOString()
        const toIso = new Date(`${state.period.to}T23:59:59Z`).toISOString()

        if (Date.parse(fromIso) >= Date.parse(toIso)) {
            toast.warning({ title: '时间范围无效', message: '开始日期需早于结束日期' })
            return
        }

        // 中断已有流
        const existingController = state.streamController
        if (existingController && existingController.streaming) {
            existingController.abort()
        }

        // SSE 不使用轮询；同时让此前非 SSE 报告的晚到响应永久失效。
        beginReportLifecycle(set, get, null)

        set({
            generating: true,
            error: null,
            currentReport: null,
            agentTasks: [],
            currentAgentId: null,
            streamMarkdown: '',
            streamActive: true,
            streamController: null,
            streamMessage: '准备启动多智能体协作…',
        })

        try {
            const controller = api.report.streamGenerate(
                {
                    classId: state.classId,
                    period: { from: fromIso, to: toIso },
                    template: state.template,
                    includeSections: state.includeSections,
                    teacherId: state.teacherId,
                },
                {
                    onProgress: (progress, agentId, message) => {
                        set((s) => ({
                            currentReport: s.currentReport
                                ? { ...s.currentReport, progress, updatedAt: Date.now() }
                                : null,
                            currentAgentId: agentId ?? s.currentAgentId,
                            streamMessage: message ?? s.streamMessage,
                        }))
                        if (agentId && !get().agentTasks.some((t) => t.agentId === agentId)) {
                            set((s) => ({
                                agentTasks: [
                                    ...s.agentTasks,
                                    {
                                        taskId: `${agentId}-${Date.now()}`,
                                        agentId,
                                        status: 'running' as const,
                                        startedAt: Date.now(),
                                    },
                                ],
                            }))
                        }
                    },
                    onDelta: (content) => {
                        set((s) => ({ streamMarkdown: s.streamMarkdown + content }))
                    },
                    onDone: (reportId) => {
                        set({ streamActive: false, streamController: null })
                        // 流结束后用最终 reportId 拉取完整报告（含 sections / exportedData 等）
                        const finalReportId = reportId || ''
                        if (finalReportId) {
                            void get().fetchReport(finalReportId)
                        } else {
                            // 无 reportId 时仅终止 generating 状态
                            set({ generating: false })
                        }
                    },
                    onError: (err) => {
                        set({
                            generating: false,
                            streamActive: false,
                            streamController: null,
                            error: getDisplayError(err, '未知错误'),
                        })
                        toast.error({ title: '生成失败', message: getDisplayError(err, '未知错误') })
                    },
                },
            )
            set({ streamController: controller })
            toast.info({ title: '报告生成已启动', message: '多智能体正在协作，请稍候' })
        } catch (err) {
            set({
                generating: false,
                streamActive: false,
                streamController: null,
                error: getDisplayError(err, '未知错误'),
            })
            toast.error({ title: '生成启动失败', message: getDisplayError(err, '未知错误') })
        }
    },

    // v5.0：中断流式生成
    abortStream: () => {
        const state = get()
        const controller = state.streamController
        if (controller && controller.streaming) {
            controller.abort()
        }
        beginReportLifecycle(set, get, null)
        set({
            generating: false,
            streamActive: false,
            streamController: null,
            streamMessage: '',
            // 保留 streamMarkdown 内容（用户可查看已生成的部分）
        })
        toast.info({ title: '已中断生成', message: '报告生成已停止，已生成内容保留在预览区' })
    },

    previewPrint: (reportId) => {
        api.report.previewPrint(reportId)
    },

    handleWSEvent: (event) => {
        const state = get()
        const currentReport = state.currentReport
        if (!currentReport) return

        // 仅处理与当前报告相关的事件（sessionId 匹配或 payload.reportId 匹配）
        const payload = event.payload as {
            taskId?: string
            agentId?: string
            status?: string
            error?: string
            endedAt?: number
            reportId?: string
            progress?: number
        }

        const isRelated = payload.reportId === currentReport.id
        if (!isRelated) return

        switch (event.type) {
            case 'orch:task:start': {
                if (payload.taskId && payload.agentId) {
                    // 提取为局部 const，避免 set 闭包内类型窄化丢失（TS 限制）
                    const taskId = payload.taskId
                    const agentId = payload.agentId
                    set((s) => ({
                        agentTasks: [
                            ...s.agentTasks,
                            {
                                taskId,
                                agentId,
                                status: 'running' as const,
                                startedAt: event.timestamp,
                            },
                        ],
                        currentAgentId: agentId,
                    }))
                }
                break
            }
            case 'orch:task:done': {
                if (payload.taskId) {
                    set((s) => ({
                        agentTasks: s.agentTasks.map((t) =>
                            t.taskId === payload.taskId
                                ? { ...t, status: 'success' as const, endedAt: payload.endedAt ?? event.timestamp }
                                : t,
                        ),
                        currentReport: payload.progress !== undefined && s.currentReport
                            ? { ...s.currentReport, progress: payload.progress, updatedAt: event.timestamp }
                            : s.currentReport,
                    }))
                }
                break
            }
            case 'orch:task:failed': {
                if (payload.taskId) {
                    set((s) => ({
                        agentTasks: s.agentTasks.map((t) =>
                            t.taskId === payload.taskId
                                ? { ...t, status: 'failed' as const, error: getDisplayError(payload.error, '任务执行失败'), endedAt: payload.endedAt ?? event.timestamp }
                                : t,
                        ),
                        error: getDisplayError(payload.error, '任务执行失败'),
                    }))
                }
                break
            }
            case 'orch:session:end': {
                // 会话结束，拉取最终结果
                void get().fetchReport(currentReport.id)
                break
            }
            default:
                break
        }
    },

    reset: () => {
        // v5.0：清理流式状态
        const state = get()
        const controller = state.streamController
        if (controller && controller.streaming) {
            controller.abort()
        }
        beginReportLifecycle(set, get, null)
        set({
            currentReport: null,
            generating: false,
            agentTasks: [],
            currentAgentId: null,
            error: null,
            streamMarkdown: '',
            streamActive: false,
            streamController: null,
            streamMessage: '',
        })
    },
}))

// ─────────────────────────────────────────────────────────────
// 非 SSE 报告拉取 + 递归单飞轮询兜底
// ─────────────────────────────────────────────────────────────

function isPageHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function isCurrentReportGeneration(generation: number, reportId: string | null): boolean {
    return reportPollingRuntime.reportGeneration === generation &&
        reportPollingRuntime.activeReportId === reportId
}

function clearScheduledPoll(set: ReportStateSetter, get: ReportStateGetter): void {
    const runtimeTimerId = reportPollingRuntime.pollTimerId
    const stateTimerId = get().pollTimerId

    if (typeof window !== 'undefined') {
        if (runtimeTimerId !== null) window.clearTimeout(runtimeTimerId)
        if (stateTimerId !== null && stateTimerId !== runtimeTimerId) {
            window.clearTimeout(stateTimerId)
        }
    }

    reportPollingRuntime.pollTimerId = null
    if (stateTimerId !== null) set({ pollTimerId: null })
}

function abortActivePollRequest(): void {
    const request = reportPollingRuntime.activeRequest
    if (request?.source === 'poll' && !request.controller.signal.aborted) {
        request.controller.abort()
    }
}

/** 暂停但保留 visibility 监听；用于后台标签页，回到前台后可恢复同一报告。 */
function pausePolling(set: ReportStateSetter, get: ReportStateGetter): void {
    reportPollingRuntime.pollGeneration += 1
    clearScheduledPoll(set, get)
    abortActivePollRequest()
}

/** 完全停止当前轮询会话；可安全重复调用（含 React StrictMode 双 cleanup）。 */
function stopPolling(set: ReportStateSetter, get: ReportStateGetter): void {
    reportPollingRuntime.pollGeneration += 1
    reportPollingRuntime.pollActive = false
    reportPollingRuntime.pollReportId = null
    clearScheduledPoll(set, get)
    abortActivePollRequest()
    reportPollingRuntime.visibilityCleanup?.()
    reportPollingRuntime.visibilityCleanup = null
}

/**
 * 开启一个新的报告身份代际。所有旧计时器、旧 HTTP 响应和旧 visibility
 * 回调都会因代际不匹配而失效；AbortController 只是加速释放资源，不是正确性前提。
 */
function beginReportLifecycle(
    set: ReportStateSetter,
    get: ReportStateGetter,
    reportId: string | null,
): number {
    stopPolling(set, get)
    const request = reportPollingRuntime.activeRequest
    if (request && !request.controller.signal.aborted) request.controller.abort()
    reportPollingRuntime.reportGeneration += 1
    reportPollingRuntime.activeReportId = reportId
    return reportPollingRuntime.reportGeneration
}

function selectReportForManualFetch(
    set: ReportStateSetter,
    get: ReportStateGetter,
    reportId: string,
): number {
    if (reportPollingRuntime.activeReportId === reportId) {
        return reportPollingRuntime.reportGeneration
    }

    const previousReportId = reportPollingRuntime.activeReportId ?? get().currentReport?.id ?? null
    const generation = beginReportLifecycle(set, get, reportId)
    // 查看另一份历史报告不能沿用上一份报告的 generating→terminal 迁移，
    // 否则会误触发“刚生成完成”的通知。SSE 完成时 activeReportId 为空，需保留。
    if (previousReportId !== null && previousReportId !== reportId && get().generating) {
        set({ generating: false })
    }
    return generation
}

function isRequestCurrent(request: NonNullable<ReportPollingRuntime['activeRequest']>): boolean {
    if (
        request.controller.signal.aborted ||
        !isCurrentReportGeneration(request.reportGeneration, request.reportId)
    ) {
        return false
    }
    if (request.source === 'poll') {
        return request.pollGeneration === reportPollingRuntime.pollGeneration &&
            reportPollingRuntime.pollActive &&
            reportPollingRuntime.pollReportId === request.reportId
    }
    return true
}

function handleTerminalTransition(
    set: ReportStateSetter,
    get: ReportStateGetter,
    report: ReportRecord,
    wasGenerating: boolean,
): void {
    if (report.status !== 'completed' && report.status !== 'failed') return

    stopPolling(set, get)
    // 响应可能被 WS、手动查看与轮询重复触发；只有真实的 generating→terminal
    // 状态迁移拥有一次性业务副作用。
    if (!wasGenerating) return

    if (report.status === 'completed') {
        const description = report.output?.title ?? '教研报告已就绪'
        toast.success({ title: '报告已生成', message: description })
        useNotificationStore.getState().push({
            type: 'success',
            title: '教研报告已生成',
            description,
            linkTo: '/report',
        })
        void get().fetchHistory(false)
        businessEvents.emit('report:generated', {
            classId: report.classId,
            reportType: 'class-diagnosis',
        })
        return
    }

    toast.error({ title: '生成失败', message: '报告生成失败，请稍后重试或联系管理员' })
}

function fetchReportWithLifecycle(
    set: ReportStateSetter,
    get: ReportStateGetter,
    reportId: string,
    source: 'manual' | 'poll',
    expectedPollGeneration: number | null = null,
): Promise<void> {
    const reportGeneration = source === 'manual'
        ? selectReportForManualFetch(set, get, reportId)
        : reportPollingRuntime.reportGeneration

    if (!isCurrentReportGeneration(reportGeneration, reportId)) return Promise.resolve()
    if (
        source === 'poll' &&
        (expectedPollGeneration === null ||
            expectedPollGeneration !== reportPollingRuntime.pollGeneration ||
            !reportPollingRuntime.pollActive)
    ) {
        return Promise.resolve()
    }

    const existingRequest = reportPollingRuntime.activeRequest
    const existingPollIsCurrent = existingRequest?.source !== 'poll' || (
        existingRequest.pollGeneration === reportPollingRuntime.pollGeneration &&
        reportPollingRuntime.pollActive
    )
    if (
        existingRequest &&
        existingRequest.reportId === reportId &&
        existingRequest.reportGeneration === reportGeneration &&
        existingPollIsCurrent &&
        !existingRequest.controller.signal.aborted
    ) {
        return existingRequest.promise
    }
    if (existingRequest && !existingRequest.controller.signal.aborted) {
        existingRequest.controller.abort()
    }

    const controller = new AbortController()
    const request: NonNullable<ReportPollingRuntime['activeRequest']> = {
        reportId,
        reportGeneration,
        source,
        pollGeneration: source === 'poll' ? expectedPollGeneration : null,
        controller,
        promise: Promise.resolve(),
    }

    request.promise = (async () => {
        try {
            const res = await api.report.getReport(reportId, controller.signal)
            if (!isRequestCurrent(request)) return
            if (res.report.id !== reportId) {
                throw new Error('报告响应标识不匹配，请稍后重试')
            }

            const stateBefore = get()
            const wasGenerating = stateBefore.generating && (
                stateBefore.currentReport === null || stateBefore.currentReport.id === reportId
            )
            set({
                currentReport: res.report,
                generating: res.report.status === 'generating',
                error: null,
            })
            handleTerminalTransition(set, get, res.report, wasGenerating)
        } catch (err) {
            // 主动取消、reset、换报告、WS 接管或 hidden 都是正常生命周期，不得误报。
            if (controller.signal.aborted || !isRequestCurrent(request)) return

            const message = getDisplayError(err, '未知错误')
            if (source === 'poll') {
                // 单次网络抖动不应宣判长任务失败；保留 generating 并由递归链重试。
                set({ error: message })
                return
            }

            stopPolling(set, get)
            set({ generating: false, error: message })
            toast.error({ title: '拉取报告失败', message })
        } finally {
            if (reportPollingRuntime.activeRequest === request) {
                reportPollingRuntime.activeRequest = null
            }
        }
    })()

    reportPollingRuntime.activeRequest = request
    return request.promise
}

function canContinuePolling(get: ReportStateGetter, reportId: string): boolean {
    const state = get()
    return reportPollingRuntime.pollActive &&
        reportPollingRuntime.pollReportId === reportId &&
        reportPollingRuntime.activeReportId === reportId &&
        state.wsStatus !== 'connected' &&
        state.generating &&
        state.currentReport?.id === reportId &&
        state.currentReport.status === 'generating' &&
        !state.streamActive &&
        !state.streamController
}

function scheduleNextPoll(
    set: ReportStateSetter,
    get: ReportStateGetter,
    reportId: string,
): void {
    if (
        typeof window === 'undefined' ||
        isPageHidden() ||
        reportPollingRuntime.pollTimerId !== null ||
        !canContinuePolling(get, reportId)
    ) {
        return
    }

    // 如果取消中的旧 fetch 尚未释放，让它的 finally 负责接续，避免并发叠加。
    const activeRequest = reportPollingRuntime.activeRequest
    if (activeRequest?.source === 'poll' && !activeRequest.controller.signal.aborted) return

    const pollGeneration = reportPollingRuntime.pollGeneration
    const timerId = window.setTimeout(() => {
        if (reportPollingRuntime.pollTimerId === timerId) {
            reportPollingRuntime.pollTimerId = null
            if (get().pollTimerId === timerId) set({ pollTimerId: null })
        }
        void runPollCycle(set, get, reportId, pollGeneration)
    }, REPORT_POLL_INTERVAL_MS)
    reportPollingRuntime.pollTimerId = timerId
    set({ pollTimerId: timerId })
}

async function runPollCycle(
    set: ReportStateSetter,
    get: ReportStateGetter,
    reportId: string,
    pollGeneration: number,
): Promise<void> {
    if (
        pollGeneration !== reportPollingRuntime.pollGeneration ||
        isPageHidden() ||
        !canContinuePolling(get, reportId)
    ) {
        return
    }

    await fetchReportWithLifecycle(set, get, reportId, 'poll', pollGeneration)

    // 请求结束后才安排下一次，保证任意网络时延下最大并发数恒为 1。
    // 若 hidden→visible 发生在 AbortPromise 收尾之前，这里也会接续新代际。
    if (canContinuePolling(get, reportId) && !isPageHidden()) {
        scheduleNextPoll(set, get, reportId)
    }
}

function installVisibilityLifecycle(set: ReportStateSetter, get: ReportStateGetter): void {
    if (
        reportPollingRuntime.visibilityCleanup ||
        typeof document === 'undefined' ||
        typeof document.addEventListener !== 'function'
    ) {
        return
    }

    const onVisibilityChange = () => {
        if (!reportPollingRuntime.pollActive) return
        if (isPageHidden()) {
            pausePolling(set, get)
            return
        }

        const reportId = reportPollingRuntime.pollReportId
        if (reportId && canContinuePolling(get, reportId)) {
            scheduleNextPoll(set, get, reportId)
        }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    let listening = true
    reportPollingRuntime.visibilityCleanup = () => {
        if (!listening) return
        listening = false
        document.removeEventListener?.('visibilitychange', onVisibilityChange)
    }
}

function startPolling(
    set: ReportStateSetter,
    get: ReportStateGetter,
    reportId: string,
): void {
    stopPolling(set, get)
    if (
        get().wsStatus === 'connected' ||
        !get().generating ||
        get().currentReport?.id !== reportId ||
        get().currentReport?.status !== 'generating'
    ) {
        return
    }

    // HMR/恢复态下运行时身份可能为空；在不改变 UI 状态的情况下重新绑定。
    if (reportPollingRuntime.activeReportId !== reportId) {
        const request = reportPollingRuntime.activeRequest
        if (request && !request.controller.signal.aborted) request.controller.abort()
        reportPollingRuntime.reportGeneration += 1
        reportPollingRuntime.activeReportId = reportId
    }

    reportPollingRuntime.pollGeneration += 1
    reportPollingRuntime.pollActive = true
    reportPollingRuntime.pollReportId = reportId
    installVisibilityLifecycle(set, get)
    if (!isPageHidden()) scheduleNextPoll(set, get, reportId)
}
