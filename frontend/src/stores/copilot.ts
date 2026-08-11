/**
 * AI 副驾全局状态（Task 13）
 *
 * 职责：
 * 1. 持有当前会话（sessionId、消息流、编排计划、任务状态）
 * 2. 管理 WebSocket 推送的多智能体协作进度（task:start/done/failed/paused/resumed）
 * 3. 处理教师中途介入（暂停/恢复/中止/修正/反馈）
 * 4. 流式输出状态管理（streamingMessageId 标记当前流式消息）
 * 5. 会话历史列表（侧边栏展示）
 * 6. localStorage 持久化兜底（刷新后恢复当前会话消息）
 *
 * 设计要点：
 * - chat 仅解析不执行：sendMessage 调用 /api/copilot/chat 获得 plan，教师确认后调 executePlan
 * - WS 事件由 handleWSEvent 统一分发，仅处理当前 sessionId 的事件
 * - 流式动画在 ChatInterface 组件中实现，store 仅跟踪 streamingMessageId
 * - 乐观更新：介入操作立即反馈 UI，失败回滚 + toast
 */

import { getDisplayError } from '@/lib/errors'
import { create } from 'zustand'
import { api } from '@/lib/api'
import { toast } from '@/stores/toast'
import type {
    CopilotMessage,
    CopilotSessionSummary,
    CopilotSessionStatus,
    CopilotQuickAction,
    CopilotQuickActionRequest,
    ParsedInstruction,
    SubTask,
    SubTaskStatus,
    WSStatus,
    WSEvent,
    ProactiveAlert,
    WeeklyReport,
} from '@/lib/types'
import { ORCH_EVENTS } from '@/lib/ws-events'
import { useAuthStore } from '@/stores/auth'
import { businessEvents } from '@/lib/business-events'
import { appendBoundedHistory } from '@/lib/bounded-history'

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

// teacherId 由 useAuthStore 统一管理（P1-B）
const STORAGE_KEY = 'pr-copilot-state'
/** 当前会话与本地恢复统一保留最近 100 条，避免长会话内存和 DOM 无界增长。 */
const MAX_PERSISTED_MESSAGES = 100

// ─────────────────────────────────────────────────────────────
// localStorage 持久化
// ─────────────────────────────────────────────────────────────

interface PersistedState {
    sessionId: string | null
    messages: CopilotMessage[]
    teacherId: string
    classId: string
}

function readPersisted(): Partial<PersistedState> {
    if (typeof window === 'undefined') return {}
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw) as PersistedState
        return {
            sessionId: parsed.sessionId ?? null,
            messages: Array.isArray(parsed.messages) ? parsed.messages.slice(-MAX_PERSISTED_MESSAGES) : [],
            teacherId: parsed.teacherId ?? useAuthStore.getState().teacherId,
            classId: parsed.classId ?? '',
        }
    } catch {
        return {}
    }
}

function writePersisted(state: PersistedState): void {
    if (typeof window === 'undefined') return
    try {
        const payload: PersistedState = {
            sessionId: state.sessionId,
            messages: state.messages.slice(-MAX_PERSISTED_MESSAGES),
            teacherId: state.teacherId,
            classId: state.classId,
        }
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    } catch {
        // localStorage 满或禁用时静默降级
    }
}

function clearPersisted(): void {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.removeItem(STORAGE_KEY)
    } catch {
        // 忽略
    }
}

// ─────────────────────────────────────────────────────────────
// Store 类型
// ─────────────────────────────────────────────────────────────

/** AI 副驾上下文提示（业务事件摘要，供 AI 对话引用） */
export interface ContextHint {
    /** 业务事件类型 */
    type: string
    /** 人类可读的摘要 */
    summary: string
    /** 时间戳 */
    at: number
}

export interface CopilotState {
    // ── 身份 ──
    teacherId: string
    classId: string

    // ── 当前会话 ──
    sessionId: string | null
    messages: CopilotMessage[]
    sessionStatus: CopilotSessionStatus

    // ── 编排计划 ──
    currentPlan: ParsedInstruction | null

    // ── 多智能体任务进度 ──
    taskStates: SubTask[]
    /** 当前正在执行的 agentId（用于高亮） */
    currentAgentId: string | null

    // ── 流式输出 ──
    /** 正在流式输出的消息 id（null 表示无流式） */
    streamingMessageId: string | null

    // ── 会话历史 ──
    sessions: CopilotSessionSummary[]
    sessionsLoading: boolean

    // ── 快捷指令预填 ──
    prefillMessage: string

    // ── 上下文感知（Phase 1.7）──
    /** 最近感知的业务事件摘要，供 AI 对话引用作为上下文（保留最近 5 条） */
    contextHints: ContextHint[]

    // ── 主动智能（P0-4）──
    /** 主动预警列表（proactive:* 事件累积，保留最近 20 条，FIFO） */
    proactiveAlerts: ProactiveAlert[]
    /** 周报数据（由后端定期推送，copilot 持有供 Dashboard 展示） */
    weeklyReport: WeeklyReport | null

    // ── 加载/错误 ──
    sending: boolean
    executing: boolean
    intervening: boolean
    error: string | null

    // ── WebSocket ──
    wsStatus: WSStatus

    // ── 动作 ──
    setClassId: (classId: string) => void
    setWsStatus: (status: WSStatus) => void
    setPrefillMessage: (msg: string) => void
    clearPrefill: () => void
    setStreamingDone: (messageId: string) => void

    /**
     * B2.1 真流式：追加流式分片到指定消息（用于 /stream-chat SSE 端点）
     * 在流式过程中实时更新消息内容，实现 LLM → Store → UI 的真流式渲染。
     */
    appendStreamDelta: (messageId: string, delta: string) => void
    /** B2.1 真流式：创建一个空的 assistant 流式消息，返回 messageId */
    startStreamingAssistant: () => string
    /** B2.1 真流式：标记流式消息为完成（定型） */
    finalizeStreamingMessage: (messageId: string) => void

    sendMessage: (message: string, context?: { currentPage?: string; selectedPoemId?: string }) => Promise<void>
    executePlan: () => Promise<void>
    updatePlannedTaskInput: (taskId: string, newInput: unknown) => void
    discardPlan: () => void
    pauseTask: (taskId: string) => Promise<void>
    resumeTask: (taskId: string) => Promise<void>
    abortSession: () => Promise<void>
    modifyTask: (taskId: string, newInput: unknown) => Promise<void>
    sendFeedback: (feedbackType: 'good' | 'bad' | 'correction', content: string, taskId?: string, agentId?: string) => Promise<void>

    quickAction: (action: CopilotQuickAction, params?: CopilotQuickActionRequest['params']) => Promise<void>

    newSession: () => void
    loadSession: (id: string) => Promise<void>
    deleteSession: (id: string) => Promise<void>
    fetchSessions: () => Promise<void>

    handleWSEvent: (event: WSEvent) => void
    reset: () => void

    // ── 主动智能动作（P0-4）──
    /** 推送一条主动预警（prepend 到 proactiveAlerts，上限 20 条 FIFO 淘汰） */
    pushProactiveAlert: (alert: ProactiveAlert) => void
    /** 设置周报数据（整体替换） */
    setWeeklyReport: (report: WeeklyReport) => void
}

// ─────────────────────────────────────────────────────────────
// Store 实现
// ─────────────────────────────────────────────────────────────

const persisted = readPersisted()

export const useCopilotStore = create<CopilotState>((set, get) => ({
    // ── 身份 ──
    teacherId: persisted.teacherId ?? useAuthStore.getState().teacherId,
    classId: persisted.classId ?? '',

    // ── 当前会话 ──
    sessionId: persisted.sessionId ?? null,
    messages: persisted.messages ?? [],
    sessionStatus: 'idle',

    // ── 编排计划 ──
    currentPlan: null,

    // ── 多智能体任务进度 ──
    taskStates: [],
    currentAgentId: null,

    // ── 流式输出 ──
    streamingMessageId: null,

    // ── 会话历史 ──
    sessions: [],
    sessionsLoading: false,

    // ── 快捷指令预填 ──
    prefillMessage: '',

    // ── 上下文感知（Phase 1.7）──
    contextHints: [],

    // ── 主动智能（P0-4）──
    proactiveAlerts: [],
    weeklyReport: null,

    // ── 加载/错误 ──
    sending: false,
    executing: false,
    intervening: false,
    error: null,

    // ── WebSocket ──
    wsStatus: 'idle',

    // ── 动作实现 ──

    setClassId: (classId) => {
        set({ classId })
        const s = get()
        writePersisted({ sessionId: s.sessionId, messages: s.messages, teacherId: s.teacherId, classId })
    },

    setWsStatus: (wsStatus) => set({ wsStatus }),

    setPrefillMessage: (msg) => set({ prefillMessage: msg }),

    clearPrefill: () => set({ prefillMessage: '' }),

    setStreamingDone: (messageId) => {
        const { streamingMessageId } = get()
        if (streamingMessageId === messageId) {
            set({ streamingMessageId: null })
        }
    },

    // ── B2.1 真流式动作实现 ──

    appendStreamDelta: (messageId, delta) => {
        if (!delta) return
        set((s) => ({
            messages: s.messages.map((m) =>
                m.id === messageId
                    ? { ...m, content: m.content + delta, timestamp: Date.now() }
                    : m,
            ),
        }))
        // 持久化最新消息
        const st = get()
        writePersisted({
            sessionId: st.sessionId,
            messages: st.messages,
            teacherId: st.teacherId,
            classId: st.classId,
        })
    },

    startStreamingAssistant: () => {
        const id = `s-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
        const assistantMessage: CopilotMessage = {
            id,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            aiGenerated: true,
            realStream: true,
        }
        set((s) => ({
            messages: appendBoundedHistory(s.messages, [assistantMessage], MAX_PERSISTED_MESSAGES),
            streamingMessageId: id,
        }))
        return id
    },

    finalizeStreamingMessage: (messageId) => {
        set((s) => ({
            streamingMessageId: s.streamingMessageId === messageId ? null : s.streamingMessageId,
            messages: s.messages.map((m) =>
                m.id === messageId && m.content === ''
                    ? { ...m, content: '（生成被中断，无内容输出）', timestamp: Date.now() }
                    : m,
            ),
        }))
        // 持久化最终消息
        const st = get()
        writePersisted({
            sessionId: st.sessionId,
            messages: st.messages,
            teacherId: st.teacherId,
            classId: st.classId,
        })
    },

    sendMessage: async (message, context) => {
        const state = get()
        const trimmed = message.trim()
        if (!trimmed) return
        if (state.sending) return

        set({ sending: true, error: null })

        // 乐观追加用户消息
        const userMessage: CopilotMessage = {
            id: `u-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
            role: 'user',
            content: trimmed,
            timestamp: Date.now(),
        }
        set((s) => ({
            messages: appendBoundedHistory(s.messages, [userMessage], MAX_PERSISTED_MESSAGES),
        }))

        try {
            const res = await api.copilot.chat({
                message: trimmed,
                sessionId: state.sessionId ?? undefined,
                classId: state.classId || undefined,
                teacherId: state.teacherId,
                context,
            })
            if (!res.sessionId) {
                throw new Error('AI 返回的执行计划不完整，已阻止进入审批与执行阶段')
            }

            // 构造 assistant 消息（解析摘要）
            const assistantContent = buildPlanSummaryMarkdown(res.parsedInstruction)
            const assistantMessage: CopilotMessage = {
                id: `a-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
                role: 'assistant',
                content: assistantContent,
                timestamp: Date.now(),
                agentInvolved: ['orchestrator', ...res.parsedInstruction.estimatedAgents],
                aiGenerated: true,
            }

            set((s) => ({
                messages: appendBoundedHistory(
                    s.messages,
                    [assistantMessage],
                    MAX_PERSISTED_MESSAGES,
                ),
                sessionId: res.sessionId,
                currentPlan: res.parsedInstruction,
                sessionStatus: 'planning',
                taskStates: res.parsedInstruction.subTasks.map((t) => ({ ...t })),
                currentAgentId: null,
                // /copilot/chat 返回的是完整计划摘要，不是 SSE 分片；标成 streaming
                // 会让消息永久显示光标并禁用部分操作。
                streamingMessageId: null,
                sending: false,
            }))

            // 持久化
            const s2 = get()
            writePersisted({
                sessionId: s2.sessionId,
                messages: s2.messages,
                teacherId: s2.teacherId,
                classId: s2.classId,
            })
        } catch (err) {
            const errorMsg = getDisplayError(err, '发送失败')
            // 追加系统错误消息
            const errorMessage: CopilotMessage = {
                id: `e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
                role: 'system',
                content: '消息解析失败，请尝试重新描述您的需求。',
                timestamp: Date.now(),
            }
            set((s) => ({
                messages: appendBoundedHistory(s.messages, [errorMessage], MAX_PERSISTED_MESSAGES),
                sending: false,
                error: errorMsg,
                sessionStatus: 'aborted',
            }))
            toast.error({ title: '发送失败', message: errorMsg })
        }
    },

    executePlan: async () => {
        const state = get()
        if (!state.currentPlan || !state.sessionId) {
            toast.warning({ title: '无可执行计划', message: '请先发送指令让编排官解析' })
            return
        }
        if (state.executing) return

        const resetTask = (task: SubTask): SubTask => ({
            id: task.id,
            agentId: task.agentId,
            input: task.input,
            dependencies: [...task.dependencies],
            condition: undefined,
            status: 'pending',
        })
        const executablePlan: ParsedInstruction = {
            ...state.currentPlan,
            subTasks: state.currentPlan.subTasks.map(resetTask),
            executionPlan: {
                ...state.currentPlan.executionPlan,
                nodes: state.currentPlan.executionPlan.nodes.map(resetTask),
                edges: state.currentPlan.executionPlan.edges.map((edge) => ({ ...edge })),
            },
        }

        set({ executing: true, error: null })

        try {
            await api.orchestrator.execute({
                sessionId: state.sessionId,
                plan: executablePlan,
                teacherId: state.teacherId,
                classId: state.classId || undefined,
            })

            set({
                executing: false,
                sessionStatus: 'executing',
                currentPlan: executablePlan,
                taskStates: executablePlan.subTasks.map((task) => ({ ...task })),
            })

            toast.success({ title: '执行已启动', message: '可在计划面板观察并介入多智能体任务' })
        } catch (err) {
            const errorMsg = getDisplayError(err, '执行失败')
            set({ executing: false, error: errorMsg })
            toast.error({ title: '执行失败', message: errorMsg })
        }
    },

    updatePlannedTaskInput: (taskId, newInput) => {
        const state = get()
        if (state.sessionStatus !== 'planning' || !state.currentPlan) {
            toast.warning({ title: '当前不可编辑', message: '只有待批准计划可以在执行前修改' })
            return
        }
        const updateTask = (task: SubTask): SubTask =>
            task.id === taskId ? { ...task, input: newInput } : task
        set({
            currentPlan: {
                ...state.currentPlan,
                subTasks: state.currentPlan.subTasks.map(updateTask),
                executionPlan: {
                    ...state.currentPlan.executionPlan,
                    nodes: state.currentPlan.executionPlan.nodes.map(updateTask),
                },
            },
            taskStates: state.taskStates.map(updateTask),
        })
        toast.success({ title: '计划已修改', message: '批准执行时将提交这一版任务输入' })
    },

    discardPlan: () => {
        const state = get()
        if (state.sessionStatus !== 'planning') return
        set({
            currentPlan: null,
            taskStates: [],
            sessionStatus: 'idle',
            currentAgentId: null,
        })
        toast.info({ title: '计划已退回', message: '对话记录已保留，可补充要求后重新生成计划' })
    },

    pauseTask: async (taskId) => {
        const state = get()
        if (!state.sessionId) return
        if (state.intervening) return

        set({ intervening: true })

        // 乐观更新
        set((s) => ({
            taskStates: s.taskStates.map((t) =>
                t.id === taskId ? { ...t, status: 'paused' as SubTaskStatus } : t,
            ),
        }))

        try {
            await api.orchestrator.pause({ sessionId: state.sessionId, taskId })
            toast.info({ title: '任务已暂停', message: '当前子任务已暂停执行' })
        } catch (err) {
            // 回滚
            set((s) => ({
                taskStates: s.taskStates.map((t) =>
                    t.id === taskId ? { ...t, status: 'running' as SubTaskStatus } : t,
                ),
            }))
            toast.error({ title: '暂停失败', message: getDisplayError(err, '未知错误') })
        } finally {
            set({ intervening: false })
        }
    },

    resumeTask: async (taskId) => {
        const state = get()
        if (!state.sessionId) return
        if (state.intervening) return

        set({ intervening: true })

        // 乐观更新
        set((s) => ({
            taskStates: s.taskStates.map((t) =>
                t.id === taskId ? { ...t, status: 'running' as SubTaskStatus } : t,
            ),
        }))

        try {
            await api.orchestrator.resume({ sessionId: state.sessionId, taskId })
            toast.success({ title: '任务已恢复', message: '当前子任务已恢复执行' })
        } catch (err) {
            // 回滚
            set((s) => ({
                taskStates: s.taskStates.map((t) =>
                    t.id === taskId ? { ...t, status: 'paused' as SubTaskStatus } : t,
                ),
            }))
            toast.error({ title: '恢复失败', message: getDisplayError(err, '未知错误') })
        } finally {
            set({ intervening: false })
        }
    },

    abortSession: async () => {
        const state = get()
        if (!state.sessionId) return
        if (state.intervening) return

        set({ intervening: true })

        try {
            await api.orchestrator.abort({ sessionId: state.sessionId })
            set({
                sessionStatus: 'aborted',
                currentAgentId: null,
                taskStates: get().taskStates.map((t) =>
                    t.status === 'running' || t.status === 'pending'
                        ? { ...t, status: 'skipped' as SubTaskStatus }
                        : t,
                ),
            })
            toast.warning({ title: '会话已中止', message: '所有运行中任务已停止' })
        } catch (err) {
            toast.error({ title: '中止失败', message: getDisplayError(err, '未知错误') })
        } finally {
            set({ intervening: false })
        }
    },

    modifyTask: async (taskId, newInput) => {
        const state = get()
        if (!state.sessionId) return
        if (state.intervening) return

        set({ intervening: true })

        try {
            await api.orchestrator.modify({ sessionId: state.sessionId, taskId, newInput })
            toast.success({
                title: '任务输入已修正',
                message: '当前子任务已重新执行',
            })
        } catch (err) {
            toast.error({ title: '修正失败', message: getDisplayError(err, '未知错误') })
        } finally {
            set({ intervening: false })
        }
    },

    sendFeedback: async (feedbackType, content, taskId, agentId) => {
        const state = get()
        if (!state.sessionId) {
            toast.warning({ title: '无会话', message: '请先发起一次对话' })
            return
        }

        try {
            await api.copilot.feedback({
                sessionId: state.sessionId,
                taskId,
                agentId,
                feedbackType,
                content,
            })

            // 追加系统消息
            const feedbackLabel = feedbackType === 'good' ? '好评' : feedbackType === 'bad' ? '差评' : '修正建议'
            const feedbackMessage: CopilotMessage = {
                id: `f-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
                role: 'system',
                content: `已记录教师反馈（${feedbackLabel}）。自我进化引擎将据此优化后续编排。`,
                timestamp: Date.now(),
            }
            set((s) => ({
                messages: appendBoundedHistory(
                    s.messages,
                    [feedbackMessage],
                    MAX_PERSISTED_MESSAGES,
                ),
            }))

            const s2 = get()
            writePersisted({
                sessionId: s2.sessionId,
                messages: s2.messages,
                teacherId: s2.teacherId,
                classId: s2.classId,
            })

            // Phase 5.3：反馈回灌 contextHints，让 AI 下次对话引用教师反馈偏好
            const feedbackHint: ContextHint = {
                type: `feedback:${feedbackType}`,
                summary: `教师反馈（${feedbackLabel}）：${content.slice(0, 60)}`,
                at: Date.now(),
            }
            set({ contextHints: [...get().contextHints, feedbackHint].slice(-5) })

            toast.success({ title: '反馈已记录', message: '感谢您的反馈，系统将持续优化' })
        } catch (err) {
            toast.error({ title: '反馈失败', message: getDisplayError(err, '未知错误') })
        }
    },

    quickAction: async (action, params) => {
        const state = get()
        set({ sending: true, error: null })

        try {
            const res = await api.copilot.quickAction({
                action,
                params,
                teacherId: state.teacherId,
            })

            set({
                sessionId: res.sessionId,
                prefillMessage: res.prefillMessage,
                sessionStatus: 'idle',
                currentPlan: null,
                taskStates: [],
                currentAgentId: null,
                sending: false,
            })

            // 持久化
            writePersisted({
                sessionId: res.sessionId,
                messages: get().messages,
                teacherId: get().teacherId,
                classId: get().classId,
            })
        } catch (err) {
            set({ sending: false })
            toast.error({
                title: '快捷指令失败',
                message: getDisplayError(err, '未知错误'),
            })
        }
    },

    newSession: () => {
        set({
            sessionId: null,
            messages: [],
            sessionStatus: 'idle',
            currentPlan: null,
            taskStates: [],
            currentAgentId: null,
            streamingMessageId: null,
            prefillMessage: '',
            error: null,
        })
        clearPersisted()
    },

    loadSession: async (id) => {
        set({ sessionsLoading: true })

        try {
            const res = await api.copilot.getSession(id)
            const session = res.session

            set({
                sessionId: session.id,
                messages: session.messages,
                sessionStatus: session.status,
                currentPlan: null,
                taskStates: [],
                currentAgentId: null,
                streamingMessageId: null,
                sessionsLoading: false,
            })

            // 尝试从编排官拉取任务状态
            try {
                const orchRes = await api.orchestrator.getSession(id)
                if (orchRes.session.taskStates.length > 0) {
                    set({
                        currentPlan: orchRes.session.currentPlan ?? null,
                        taskStates: orchRes.session.taskStates.map((t) => ({
                            id: t.id,
                            agentId: t.agentId,
                            input: t.input,
                            dependencies: t.dependencies,
                            condition: undefined,
                            status: t.status,
                            result: t.result,
                            error: t.error ? getDisplayError(t.error, '子任务执行失败') : undefined,
                            startedAt: t.startedAt,
                            endedAt: t.endedAt,
                        })),
                        sessionStatus: orchRes.session.status,
                    })
                }
            } catch {
                // 编排官会话可能已过期，忽略
            }

            writePersisted({
                sessionId: session.id,
                messages: session.messages,
                teacherId: get().teacherId,
                classId: get().classId,
            })
        } catch (err) {
            set({ sessionsLoading: false })
            toast.error({
                title: '加载会话失败',
                message: getDisplayError(err, '未知错误'),
            })
        }
    },

    deleteSession: async (id) => {
        try {
            await api.copilot.deleteSession(id)
            set((s) => ({
                sessions: s.sessions.filter((sess) => sess.id !== id),
            }))
            // 如果删除的是当前会话，清空
            if (get().sessionId === id) {
                get().newSession()
            }
            toast.success({ title: '会话已删除' })
        } catch (err) {
            toast.error({
                title: '删除失败',
                message: getDisplayError(err, '未知错误'),
            })
        }
    },

    fetchSessions: async () => {
        const state = get()
        set({ sessionsLoading: true })

        try {
            const res = await api.copilot.listSessions(state.teacherId)
            set({ sessions: res.sessions, sessionsLoading: false })
        } catch (err) {
            set({ sessionsLoading: false })
            // 会话列表在 SessionHistory 挂载时被动拉取（非用户主动操作），
            // 失败时静默降级为空列表，避免每次进入页面都弹 toast 干扰用户；
            // 仅在开发模式记录调试日志，便于排查后端连接问题。
            if (import.meta.env.DEV) console.debug('[copilot] fetchSessions 失败:', err)
        }
    },

    handleWSEvent: (event) => {
        const state = get()
        // SESSION_START / INSTRUCTION_PARSED 在 sessionId 尚未建立时也需要处理
        // 其他事件必须匹配当前 sessionId
        const isSessionLifecycleEvent =
            event.type === ORCH_EVENTS.SESSION_START
            || event.type === ORCH_EVENTS.INSTRUCTION_PARSED
        if (!isSessionLifecycleEvent && (!state.sessionId || event.sessionId !== state.sessionId)) return

        switch (event.type) {
            case ORCH_EVENTS.SESSION_START: {
                // P2 修复：补齐 SESSION_START 处理，建立 sessionId 关联并切换 UI 到 executing
                const payload = event.payload as { sessionId?: string; teacherId?: string; classId?: string; intent?: string }
                if (payload.sessionId && !state.sessionId) {
                    set({ sessionId: payload.sessionId, sessionStatus: 'executing' })
                } else {
                    set({ sessionStatus: 'executing' })
                }
                break
            }
            case ORCH_EVENTS.INSTRUCTION_PARSED: {
                // P2 修复：补齐 INSTRUCTION_PARSED 处理，更新编排计划与任务状态
                const payload = event.payload as {
                    intent: string
                    subTaskCount: number
                    estimatedAgents: string[]
                    confidence: number
                }
                // 仅更新 sessionStatus，currentPlan 由 sendMessage/executePlan 流程单独设置
                set({
                    sessionStatus: 'executing',
                    executing: true,
                    error: null,
                })
                if (import.meta.env.DEV) {
                    console.debug('[copilot] 指令解析完成', {
                        intent: payload.intent,
                        subTaskCount: payload.subTaskCount,
                        agents: payload.estimatedAgents,
                        confidence: payload.confidence,
                    })
                }
                break
            }
            case ORCH_EVENTS.TASK_START: {
                const payload = event.payload as { taskId: string; agentId: string }
                set((s) => ({
                    taskStates: s.taskStates.map((t) =>
                        t.id === payload.taskId
                            ? { ...t, status: 'running' as SubTaskStatus, startedAt: Date.now() }
                            : t,
                    ),
                    currentAgentId: payload.agentId,
                    sessionStatus: 'executing',
                }))
                break
            }
            case ORCH_EVENTS.TASK_DONE: {
                const payload = event.payload as { taskId: string; result?: unknown }
                set((s) => ({
                    taskStates: s.taskStates.map((t) =>
                        t.id === payload.taskId
                            ? { ...t, status: 'success' as SubTaskStatus, result: payload.result, endedAt: Date.now() }
                            : t,
                    ),
                }))
                break
            }
            case ORCH_EVENTS.TASK_FAILED: {
                const payload = event.payload as { taskId: string; error: string }
                set((s) => ({
                    taskStates: s.taskStates.map((t) =>
                        t.id === payload.taskId
                            ? { ...t, status: 'failed' as SubTaskStatus, error: getDisplayError(payload.error, '子任务执行失败'), endedAt: Date.now() }
                            : t,
                    ),
                }))
                break
            }
            case ORCH_EVENTS.TASK_PAUSED: {
                const payload = event.payload as { taskId: string }
                set((s) => ({
                    taskStates: s.taskStates.map((t) =>
                        t.id === payload.taskId ? { ...t, status: 'paused' as SubTaskStatus } : t,
                    ),
                }))
                break
            }
            case ORCH_EVENTS.TASK_RESUMED: {
                const payload = event.payload as { taskId: string }
                set((s) => ({
                    taskStates: s.taskStates.map((t) =>
                        t.id === payload.taskId ? { ...t, status: 'running' as SubTaskStatus } : t,
                    ),
                }))
                break
            }
            case ORCH_EVENTS.TASK_SKIPPED: {
                const payload = event.payload as { taskId: string }
                set((s) => ({
                    taskStates: s.taskStates.map((t) =>
                        t.id === payload.taskId ? { ...t, status: 'skipped' as SubTaskStatus } : t,
                    ),
                }))
                break
            }
            case ORCH_EVENTS.REFLECTION: {
                // P2 修复：补齐 REFLECTION 处理，标记会话已生成反思（执行结束）
                // 反思结果由编排官推送，此处仅切换 UI 状态，详细数据通过通知中心展示
                set({ executing: false })
                if (import.meta.env.DEV) {
                    console.debug('[copilot] 反思已生成', event.payload)
                }
                break
            }
            case ORCH_EVENTS.TEACHER_FEEDBACK: {
                // P2 修复：补齐 TEACHER_FEEDBACK 处理，记录教师反馈已接收
                if (import.meta.env.DEV) {
                    console.debug('[copilot] 教师反馈已记录', event.payload)
                }
                break
            }
            case ORCH_EVENTS.SESSION_END: {
                // P2 修复：后端 SESSION_END payload 为 { success, failedTasks, skippedTasks, totalLatencyMs, totalCostYuan, tokenUsage }
                // 前端原先错误读取 status 字段（不存在），导致 sessionStatus 永远不变成 completed
                const payload = event.payload as {
                    success: boolean
                    failedTasks?: string[]
                    skippedTasks?: string[]
                    totalLatencyMs?: number
                    totalCostYuan?: number
                    tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number }
                }
                set({
                    sessionStatus: payload.success ? 'completed' : 'aborted',
                    currentAgentId: null,
                    executing: false,
                })
                break
            }
            default:
                // 其他事件类型（agent:call:* / llm:call:* / billing:record / classroom:* / self-study:*）由对应 store 处理
                break
        }
    },

    reset: () => {
        set({
            sessionId: null,
            messages: [],
            sessionStatus: 'idle',
            currentPlan: null,
            taskStates: [],
            currentAgentId: null,
            streamingMessageId: null,
            prefillMessage: '',
            contextHints: [],
            error: null,
            sending: false,
            executing: false,
            intervening: false,
        })
        clearPersisted()
    },

    // ── 主动智能动作实现（P0-4）──

    pushProactiveAlert: (alert) => {
        // FIFO 累积，上限 20 条，prepend 最新（时间倒序，便于 UI 取最新）
        set((s) => ({
            proactiveAlerts: [alert, ...s.proactiveAlerts].slice(0, 20),
        }))
    },

    setWeeklyReport: (report) => {
        // 整体替换（后端定期推送最新周报）
        set({ weeklyReport: report })
    },
}))

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

/** 将解析计划转为可读的 Markdown 摘要（与后端 buildPlanSummary 对齐）。
 *  注意：不得向终端用户暴露任何内部技术字段（任务 ID、依赖 ID、毫秒数、置信度小数等），
 *  仅保留对用户有意义的语义信息（意图标签、智能体数量、预计耗时、子任务概览）。 */
function buildPlanSummaryMarkdown(plan: ParsedInstruction): string {
    const lines: string[] = []
    const intentLabel = INTENT_LABELS_MAP[plan.intent] ?? '未识别'
    lines.push(`**已解析您的指令** — ${intentLabel}`)
    lines.push('')
    const agentCount = plan.estimatedAgents.length
    const durationSec = Math.max(1, Math.ceil(plan.estimatedDurationMs / 1000))
    lines.push(`预计协同 **${agentCount}** 个智能体，约 **${durationSec} 秒** 完成。`)
    lines.push('')
    lines.push('### 子任务拆解')
    plan.subTasks.forEach((sub, idx) => {
        const label = resolveAgentLabel(sub.agentId)
        const depHint = sub.dependencies.length > 0 ? '（需等待前置任务）' : ''
        lines.push(`${idx + 1}. **${label}**${depHint}`)
    })
    lines.push('')
    lines.push('> 请在右侧编排面板审查计划，确认后点击"确认执行"。')
    return lines.join('\n')
}

const INTENT_LABELS_MAP: Record<string, string> = {
    'generate-questions': '出题',
    'grade-answers': '批改',
    'diagnose-class': '班级诊断',
    'diagnose-student': '学生诊断',
    'generate-report': '教研报告',
    'recommend-path': '路径推荐',
    'vision-annotate': '视觉标注',
    'evaluate-recitation': '朗读评测',
    'generate-tts': '范读生成',
    'generate-creative': '创意素材',
    composite: '复合任务',
    unknown: '未识别',
}

const AGENT_LABELS_MAP: Record<string, string> = {
    'mind.profile': '诗心·画像',
    'mind.diagnose': '诗心·诊断',
    'mind.recommend': '诗心·推荐',
    'mind.verify': '诗心·验收',
    'eye.vision-annotate': '诗眼·标注',
    'eye.asr': '诗眼·识别',
    'eye.tts': '诗眼·范读',
    'brush.question': '诗笔·命题',
    'brush.grade': '诗笔·批改',
    'brush.report': '诗笔·报告',
    'brush.creative': '诗笔·创意',
    orchestrator: '编排官',
}

/** 解析 agentId 为人类可读标签，避免向用户暴露原始技术标识符。
 *  优先查 AGENT_LABELS_MAP；未命中时按前缀推断（mind.*→诗心、eye.*→诗眼、brush.*→诗笔）；
 *  仍无法识别时返回通用文案"智能体"，确保任何情况下都不向终端用户泄漏 agentId。 */
function resolveAgentLabel(agentId: string): string {
    const mapped = AGENT_LABELS_MAP[agentId]
    if (mapped) return mapped
    if (agentId.startsWith('mind.')) return '诗心'
    if (agentId.startsWith('eye.')) return '诗眼'
    if (agentId.startsWith('brush.')) return '诗笔'
    if (agentId === 'orchestrator') return '编排官'
    return '智能体'
}

// ─────────────────────────────────────────────────────────────────────────────
// 业务事件总线订阅 —— 让 AI 副驾感知教学全流程动态（备课→授课→批改→反馈→反思→迭代）
//
// AI 副驾作为教师的智能助手，需要感知教学全流程的 11 类业务事件，
// 以便在教师对话时提供上下文相关的建议。订阅这些事件后，将其摘要追加到
// contextHints（保留最近 5 条），供 AI 对话引用。
//
// Phase 1.7：订阅 3 类学生侧事件（self-study:progress / grading:reviewed / recitation:completed）
// Phase 5.3：补订 8 类教师侧事件，打通完整教学闭环感知链路
//   - workbench:question-ready      命题完成（备课→授课衔接）
//   - classroom:ended               课堂结束（授课→反馈衔接）
//   - report:generated              报告生成（反馈→反思衔接）
//   - diagnosis:updated             诊断更新（批改→反思衔接）
//   - creation:submitted            创作提交（学生创作→教师批改衔接）
//   - lesson-plan:generated         教案生成（备课内部衔接）
//   - lesson-plan:saved             教案保存（备课内部衔接）
//   - error-notebook:review-completed 错题复习完成（迭代环节感知）
//
// 断裂点修复：copilot 此前仅感知 3 类学生事件，对教师侧关键节点（命题/授课/报告/诊断/创作/教案/错题复习）完全无感知
// ─────────────────────────────────────────────────────────────────────────────

/** 追加上下文提示（保留最近 5 条） */
function pushContextHint(hint: ContextHint): void {
    const state = useCopilotStore.getState()
    const next = [...state.contextHints, hint].slice(-5)
    useCopilotStore.setState({ contextHints: next })
}

businessEvents.on('self-study:progress', (event) => {
    const { poemId, stage } = event.payload
    const stageLabel = stage === 'diagnose' ? '诊断'
        : stage === 'quest' ? '闯关'
            : stage === 'recite' ? '朗读'
                : '完成'
    pushContextHint({
        type: 'self-study:progress',
        summary: `学生完成了《${poemId}》的${stageLabel}阶段`,
        at: Date.now(),
    })
})

businessEvents.on('grading:reviewed', (event) => {
    const { reviewCount } = event.payload
    pushContextHint({
        type: 'grading:reviewed',
        summary: `批改完成，共 ${reviewCount} 道题`,
        at: Date.now(),
    })
})

businessEvents.on('recitation:completed', (event) => {
    const { poemId, overallScore } = event.payload
    pushContextHint({
        type: 'recitation:completed',
        summary: `学生完成了《${poemId}》朗读评估，得分 ${overallScore}`,
        at: Date.now(),
    })
})

// ── Phase 5.3：补订 8 类教师侧业务事件，打通完整教学闭环感知链路 ──

businessEvents.on('workbench:question-ready', (event) => {
    const { poemId, count } = event.payload
    pushContextHint({
        type: 'workbench:question-ready',
        summary: `已为《${poemId}》生成 ${count} 道题目，可前往课堂导播台开始授课`,
        at: Date.now(),
    })
})

businessEvents.on('classroom:ended', (event) => {
    const { durationSec } = event.payload
    const durationLabel = durationSec !== undefined ? `（时长 ${Math.round(durationSec / 60)} 分钟）` : ''
    pushContextHint({
        type: 'classroom:ended',
        summary: `课堂已结束${durationLabel}，建议生成教研报告复盘`,
        at: Date.now(),
    })
})

businessEvents.on('report:generated', (event) => {
    const { reportType } = event.payload
    const typeLabel = reportType === 'classroom' ? '课堂协奏报告'
        : reportType === 'student-profile' ? '学生画像报告'
            : '班级诊断报告'
    pushContextHint({
        type: 'report:generated',
        summary: `${typeLabel}已生成，建议查看教学调整建议`,
        at: Date.now(),
    })
})

businessEvents.on('diagnosis:updated', (event) => {
    const { scope, studentId } = event.payload
    const scopeLabel = scope === 'class' ? '班级' : '学生'
    const targetLabel = scope === 'student' && studentId ? `（${studentId}）` : ''
    pushContextHint({
        type: 'diagnosis:updated',
        summary: `${scopeLabel}诊断数据已更新${targetLabel}，建议关注薄弱环节`,
        at: Date.now(),
    })
})

businessEvents.on('creation:submitted', (event) => {
    const { studentId, taskType } = event.payload
    const taskLabel = taskType === 'illustration' ? '配画'
        : taskType === 'rewrite' ? '改写'
            : taskType === 'video-script' ? '视频脚本'
                : taskType === 'appreciation' ? '鉴赏'
                    : '创作'
    pushContextHint({
        type: 'creation:submitted',
        summary: `学生 ${studentId} 提交了${taskLabel}作品，建议前往批改`,
        at: Date.now(),
    })
})

businessEvents.on('lesson-plan:generated', (event) => {
    const { poemId, dataDriven } = event.payload
    const drivenLabel = dataDriven ? '（基于班级诊断数据）' : ''
    pushContextHint({
        type: 'lesson-plan:generated',
        summary: `已为《${poemId}》生成教案${drivenLabel}，可前往命题工坊准备题目`,
        at: Date.now(),
    })
})

businessEvents.on('lesson-plan:saved', (event) => {
    const { poemId, status } = event.payload
    const statusLabel = status === 'published' ? '已发布'
        : status === 'archived' ? '已归档'
            : '已保存草稿'
    pushContextHint({
        type: 'lesson-plan:saved',
        summary: `《${poemId}》教案${statusLabel}`,
        at: Date.now(),
    })
})

businessEvents.on('error-notebook:review-completed', (event) => {
    const { studentId, bloomLevel, newlyMastered } = event.payload
    const masteryLabel = newlyMastered ? '，已新掌握' : ''
    pushContextHint({
        type: 'error-notebook:review-completed',
        summary: `学生 ${studentId} 完成错题复习（${bloomLevel}层级）${masteryLabel}`,
        at: Date.now(),
    })
})
