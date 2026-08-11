/**
 * 六阶命题工坊全局状态（Task 10）
 *
 * 职责：
 * 1. 持有命题表单状态（古诗、年级、题型、六阶权重、数量）
 * 2. 管理生成结果（题目列表、验收结果、覆盖率）
 * 3. 追踪多智能体协作进度（WebSocket 推送的 task 状态）
 * 4. 处理微调、导出、发布等异步动作
 * 5. WebSocket 事件分发：task:start / task:done / task:failed
 *
 * 设计要点：
 * - fire-and-forget：generate 立即返回 sessionId，结果通过 WS 推送
 * - WS 收到 SESSION_END 后自动拉取最终结果
 * - 乐观更新：微调时立即替换题目，失败回滚
 * - 选中态管理：支持单选/多选题目用于批量操作
 */

import { getDisplayError } from '@/lib/errors'
import { create } from 'zustand'
import { api } from '@/lib/api'
import { toast } from '@/stores/toast'
import { useNotificationStore } from '@/stores/notifications'
import { isDemoMode } from '@/lib/demo-mode'
import { DEMO_POEMS } from '@/lib/demo-data'
import type {
    WorkbenchAgentKind,
    WorkbenchAgentRuntime,
    WorkbenchAgentStreamController,
    WorkbenchQuestion,
    WorkbenchVerification,
    WorkbenchBloomWeights,
    WorkbenchGradeLevel,
    WorkbenchQuestionType,
    WorkbenchPoemOption,
    WorkbenchAgentTask,
    WorkbenchQuestionsResponse,
    WSStatus,
    WSEvent,
    BloomLevel,
    ClassroomMode,
} from '@/lib/types'
import { WORKBENCH_PRESETS } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { businessEvents } from '@/lib/business-events'
import { rebalanceBloomWeights } from '@/lib/workbench-bloom-weights'

// ─────────────────────────────────────────────────────────────
// 默认值
// ─────────────────────────────────────────────────────────────

const balancedPreset = WORKBENCH_PRESETS['balanced']
const DEFAULT_WEIGHTS: WorkbenchBloomWeights = balancedPreset
    ? { ...balancedPreset.weights }
    : { 记忆: 17, 理解: 17, 应用: 17, 分析: 17, 评价: 16, 创造: 16 }

// teacherId 由 useAuthStore 统一管理（P1-B）

/**
 * 4 个 Agent 槽位定义
 *
 * desc 必须如实描述后端实际做的事：
 *  - refiner 走的是 brush.question 的复议轮（同为 v4-pro max），验收通过时**不执行**
 *  - accepter 不调用大模型，只做落库与终审汇总
 * 之前这里写着「medium / low 思考档」，与后端实现不符，会误导教师判断耗时来源。
 */
export const WORKBENCH_AGENT_NODES: ReadonlyArray<{
    agentId: WorkbenchAgentKind
    label: string
    desc: string
    icon: string
    /** 该阶段的经验耗时（毫秒），用于剩余时间预估 */
    typicalMs: number
}> = [
    {
        agentId: 'question_generator',
        label: '出题 Agent',
        desc: 'brush.question 按六阶权重生成题目（deepseek-v4-pro · max 深度思考）',
        icon: 'feather',
        typicalMs: 110_000,
    },
    {
        agentId: 'verifier',
        label: '验证 Agent',
        desc: 'mind.verify 六维独立验收（deepseek-v4-pro · high）',
        icon: 'check-circle',
        typicalMs: 48_000,
    },
    {
        agentId: 'refiner',
        label: '精修 Agent',
        desc: '验收未通过时携带问题反馈复议重出（deepseek-v4-pro · max）；通过则跳过',
        icon: 'wand',
        typicalMs: 43_000,
    },
    {
        agentId: 'accepter',
        label: '验收 Agent',
        desc: '终审并落库，不调用大模型',
        icon: 'seal-check',
        typicalMs: 1_000,
    },
]

/** 全流程经验总耗时（用于进度未知时的兜底预估） */
export const WORKBENCH_TYPICAL_TOTAL_MS = WORKBENCH_AGENT_NODES.reduce((sum, n) => sum + n.typicalMs, 0)

function createInitialAgentRuntimes(): Record<WorkbenchAgentKind, WorkbenchAgentRuntime> {
    const runtimes = {} as Record<WorkbenchAgentKind, WorkbenchAgentRuntime>
    for (const node of WORKBENCH_AGENT_NODES) {
        runtimes[node.agentId] = {
            agentId: node.agentId,
            label: node.label,
            desc: node.desc,
            icon: node.icon,
            status: 'pending',
            progress: 0,
            output: '',
        }
    }
    return runtimes
}

/**
 * SSE 控制器（模块级单例，刻意不放进 state）
 *
 * 控制器是命令式句柄而非可渲染数据，放进 state 只会带来无意义的重渲染；
 * 放模块级还能保证路由切换、组件卸载后连接依然存活——这正是"后台继续"的实现方式。
 */
let orchestrateStream: WorkbenchAgentStreamController | null = null

/** 单个 Agent 输出预览的最大保留字符数（防止长时间流式导致内存膨胀） */
const MAX_AGENT_OUTPUT_CHARS = 800

/**
 * 诗篇选择不是纯展示数据：它决定后续题目、班级发布与审计对象。局部接口失败时
 * 可以提供内置诗篇让评委查看界面，但不能把它与当前真实诗库混为同一来源。
 */
type WorkbenchPoemSource = 'unknown' | 'live' | 'demo-mode' | 'fallback'

// ─────────────────────────────────────────────────────────────
// Store 类型
// ─────────────────────────────────────────────────────────────

interface WorkbenchState {
    // ── 表单状态 ──
    poemId: string
    gradeLevel: WorkbenchGradeLevel
    questionTypes: WorkbenchQuestionType[]
    bloomWeights: WorkbenchBloomWeights
    count: number
    excludeUsedQuestions: boolean
    teacherId: string
    classId: string

    // ── 古诗列表 ──
    poems: WorkbenchPoemOption[]
    poemsLoading: boolean
    poemsSource: WorkbenchPoemSource
    poemsLoadError: string | null

    // ── 生成结果 ──
    sessionId: string | null
    questions: WorkbenchQuestion[]
    verification: WorkbenchVerification | null
    coverage: WorkbenchBloomWeights | null

    // ── 多智能体任务进度 ──
    agentTasks: WorkbenchAgentTask[]
    currentAgentId: string | null

    // ── 多智能体编排（SSE）──
    // 编排状态放在 store 而非组件内：命题一次要跑数分钟，教师中途切到别的
    // 页面再回来是常态。放组件里会随卸载丢掉全部进度并中断连接。
    /** 4 个 Agent 的实时运行态 */
    agentRuntimes: Record<WorkbenchAgentKind, WorkbenchAgentRuntime>
    /** 编排是否进行中 */
    orchestrating: boolean
    /** 本次编排开始时间（用于总耗时与剩余时间预估） */
    orchestrateStartedAt: number | null
    /** 编排层错误（与表单校验错误区分） */
    orchestrateError: string | null

    // ── 选中态 ──
    selectedIds: Set<string>

    // ── 加载/错误 ──
    generating: boolean
    refining: boolean
    exporting: boolean
    publishing: boolean
    error: string | null

    // ── WebSocket ──
    wsStatus: WSStatus

    // ── 动作 ──
    setPoemId: (poemId: string) => void
    setGradeLevel: (gradeLevel: WorkbenchGradeLevel) => void
    toggleQuestionType: (type: WorkbenchQuestionType) => void
    setBloomWeight: (level: BloomLevel, value: number) => void
    applyPreset: (key: string) => void
    setCount: (count: number) => void
    setExcludeUsedQuestions: (exclude: boolean) => void
    setClassId: (classId: string) => void
    setWsStatus: (status: WSStatus) => void

    /** v5.0 Task 21.1：AgentProgressPanel 直接控制生成态 */
    setGenerating: (generating: boolean) => void
    /** v5.0 Task 21.1：AgentProgressPanel 设置会话 ID（SSE 启动后立即写入临时 ID） */
    setSessionId: (sessionId: string | null) => void
    /** v5.0 Task 21.1：AgentProgressPanel 同步 DAG 节点（支持函数式更新） */
    setAgentTasks: (
        tasks:
            | WorkbenchAgentTask[]
            | ((prev: WorkbenchAgentTask[]) => WorkbenchAgentTask[]),
    ) => void
    /** v5.0 Task 21.1：AgentProgressPanel 设置当前运行 Agent */
    setCurrentAgentId: (id: string | null) => void

    /** v5.0 SubTask 21.4：RefineModal 直接控制 refining 状态（AI 流式精修） */
    setRefining: (refining: boolean) => void

    /** 启动多智能体编排（SSE）；已在运行时重复调用会被忽略 */
    startOrchestration: () => void
    /** 中止编排：关闭 SSE，后端随之中止在途 LLM 调用；已生成内容保持可见 */
    abortOrchestration: () => void

    fetchPoems: () => Promise<void>
    generate: () => Promise<void>
    fetchQuestions: (sessionId: string) => Promise<void>
    refineQuestion: (questionId: string, instruction: string) => Promise<void>
    exportQuestions: (format: 'json' | 'csv') => Promise<void>
    publishQuestions: (mode: WorkbenchPublishMode) => Promise<void>

    toggleSelect: (id: string) => void
    selectAll: () => void
    selectNone: () => void

    handleWSEvent: (event: WSEvent) => void
    reset: () => void

    /** 从 URL search params 恢复参数（StarMap 一键靶向练习跳转入口，由 WorkbenchPage 挂载时调用） */
    hydrateFromURL: (params: { poemId?: string; tier?: string }) => void
}

/**
 * 发布模式必须与课堂端和后端的 LESSON_MODES 同步。
 *
 * 命题工坊目前的快捷入口默认发布到六阶沉浸课，但保留完整课堂模式类型，
 * 避免后续为创新课堂增加发布入口时前端在类型层先行拒绝一个后端已支持的模式。
 */
type WorkbenchPublishMode = ClassroomMode

/** v5.0 Task 4.11：发布模式中文标签，用于通知中心描述 */
const PUBLISH_MODE_LABEL: Record<WorkbenchPublishMode, string> = {
    'collective-race': '集体争霸',
    'speed-pk': '竞速 PK',
    'flying-flower': '飞花令',
    'six-level-immersive': '六阶沉浸',
    'poem-wheel': '诗词大转盘',
    'poem-relay': '诗词接龙',
    'imagery-puzzle': '意境拼图',
}

// ─────────────────────────────────────────────────────────────
// Store 实现
// ─────────────────────────────────────────────────────────────

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
    // ── 初始表单状态 ──
    poemId: '',
    gradeLevel: '3-4年级',
    questionTypes: ['选择', '填空', '简答'],
    bloomWeights: { ...DEFAULT_WEIGHTS },
    count: 6,
    excludeUsedQuestions: true,
    teacherId: useAuthStore.getState().teacherId,
    classId: '',

    // ── 古诗列表 ──
    poems: [],
    poemsLoading: false,
    poemsSource: 'unknown',
    poemsLoadError: null,

    // ── 生成结果 ──
    sessionId: null,
    questions: [],
    verification: null,
    coverage: null,

    // ── 多智能体任务进度 ──
    agentTasks: [],
    currentAgentId: null,
    agentRuntimes: createInitialAgentRuntimes(),
    orchestrating: false,
    orchestrateStartedAt: null,
    orchestrateError: null,

    // ── 选中态 ──
    selectedIds: new Set<string>(),

    // ── 加载/错误 ──
    generating: false,
    refining: false,
    exporting: false,
    publishing: false,
    error: null,

    // ── WebSocket ──
    wsStatus: 'idle',

    // ── 动作实现 ──

    setPoemId: (poemId) => set({ poemId }),

    setGradeLevel: (gradeLevel) => set({ gradeLevel }),

    toggleQuestionType: (type) =>
        set((state) => {
            const has = state.questionTypes.includes(type)
            const next = has
                ? state.questionTypes.filter((t) => t !== type)
                : [...state.questionTypes, type]
            return { questionTypes: next.length > 0 ? next : state.questionTypes }
        }),

    setBloomWeight: (level, value) =>
        set((state) => ({
            bloomWeights: rebalanceBloomWeights(state.bloomWeights, level, value),
        })),

    applyPreset: (key) => {
        const preset = WORKBENCH_PRESETS[key]
        if (preset) {
            set({ bloomWeights: { ...preset.weights } })
        }
    },

    setCount: (count) => set({ count: Math.max(1, Math.min(20, count)) }),
    setExcludeUsedQuestions: (exclude) => set({ excludeUsedQuestions: exclude }),
    setClassId: (classId) => set({ classId }),
    setWsStatus: (wsStatus) => set({ wsStatus }),

    // v5.0 Task 21.1：AgentProgressPanel 直接控制生成态（SSE 启动/中止）
    setGenerating: (generating) => set({ generating }),
    setSessionId: (sessionId) => set({ sessionId }),
    setAgentTasks: (tasks) =>
        set((state) => ({
            agentTasks:
                typeof tasks === 'function'
                    ? (tasks as (prev: WorkbenchAgentTask[]) => WorkbenchAgentTask[])(state.agentTasks)
                    : tasks,
        })),
    setCurrentAgentId: (currentAgentId) => set({ currentAgentId }),

    // v5.0 SubTask 21.4：RefineModal 直接控制 refining（AI 流式精修同步状态）
    setRefining: (refining) => set({ refining }),

    hydrateFromURL: (params) => {
        const updates: Partial<WorkbenchState> = {}
        if (params.poemId) {
            updates.poemId = params.poemId
        }
        // tier 参数处理：打通"反思→迭代"闭环
        // 从 DashboardPage 雷达图"针对性命题"或 StarMap"一键靶向练习"跳转时携带，
        // tier 为最薄弱的 Bloom 层级名称。自动调整六阶权重：该层级 40%，其余五层各 12%。
        if (params.tier) {
            const currentWeights = get().bloomWeights
            const validLevels = Object.keys(currentWeights) as BloomLevel[]
            const tierLevel = params.tier as BloomLevel
            if (validLevels.includes(tierLevel)) {
                const otherCount = validLevels.length - 1 // 5
                const otherWeight = Math.round(60 / otherCount) // 12
                const newWeights = { ...currentWeights }
                for (const level of validLevels) {
                    newWeights[level] = level === tierLevel ? 40 : otherWeight
                }
                // 修正取整误差：将偏差累加到靶向层级，确保总和 = 100
                const sum = Object.values(newWeights).reduce((a, b) => a + b, 0)
                if (sum !== 100) {
                    newWeights[tierLevel] += 100 - sum
                }
                updates.bloomWeights = newWeights
                if (import.meta.env.DEV) {
                    console.info(`[workbench] 靶向命题：${tierLevel} 权重提升至 ${newWeights[tierLevel]}%`)
                }
            }
        }
        if (Object.keys(updates).length > 0) {
            set(updates)
        }
    },

    fetchPoems: async () => {
        // v5.0 Task 5.8：DEMO 模式下直接使用演示诗列表，避免无效请求
        if (isDemoMode()) {
            set((state) => ({
                poems: DEMO_POEMS,
                poemsLoading: false,
                poemsSource: 'demo-mode',
                poemsLoadError: null,
                poemId: DEMO_POEMS.some((poem) => poem.id === state.poemId) ? state.poemId : '',
            }))
            return
        }
        set({ poemsLoading: true, poemsLoadError: null })
        try {
            const res = await api.workbench.listPoems()
            // 防御性校验：res.poems 可能为 undefined/null（后端契约漂移），降级为空数组
            const poems = Array.isArray(res.poems) ? res.poems : []
            set((state) => ({
                poems,
                poemsLoading: false,
                poemsSource: 'live',
                poemsLoadError: null,
                poemId: poems.some((poem) => poem.id === state.poemId) ? state.poemId : '',
            }))
        } catch (err) {
            const reason = getDisplayError(err, '诗篇列表暂时不可用')
            const previous = get()
            const hasLivePoems = previous.poemsSource === 'live' && previous.poems.length > 0
            // 已有真实诗篇时不以演示数据覆盖它，但明确指出本次刷新没有完成。
            if (hasLivePoems) {
                set({ poemsLoading: false, poemsLoadError: `未能刷新真实诗库：${reason}。当前继续使用已加载的诗篇。` })
            } else {
                // 局部失败的兜底只用于浏览/配置；表单会显示持久来源标识并阻断
                // 命题启动，直到下一次真实诗库请求成功，避免混用演示诗篇和真实产出。
                toast.warning({
                    title: '后端不可达，已切换演示数据',
                    message: '古诗列表降级为演示数据；恢复真实诗库前不会启动命题。',
                })
                set((state) => ({
                    poems: DEMO_POEMS,
                    poemsLoading: false,
                    poemsSource: 'fallback',
                    poemsLoadError: `真实诗库未能加载：${reason}。当前列表仅用于界面预览，不会写入教学记录。`,
                    poemId: DEMO_POEMS.some((poem) => poem.id === state.poemId) ? state.poemId : '',
                }))
            }
            if (import.meta.env.DEV) {
                console.error('[workbench.fetchPoems] 加载古诗列表失败', err)
            }
        }
    },

    startOrchestration: () => {
        const state = get()
        if (state.orchestrating) return
        if (!state.poemId) {
            toast.warning({ title: '请先选择古诗', message: '命题前需指定目标诗篇' })
            return
        }
        if (state.questionTypes.length === 0) {
            toast.warning({ title: '请选择题型', message: '至少选择一种题型' })
            return
        }

        orchestrateStream?.abort()
        set({
            agentRuntimes: createInitialAgentRuntimes(),
            orchestrating: true,
            orchestrateStartedAt: Date.now(),
            orchestrateError: null,
            generating: true,
            questions: [],
            verification: null,
            coverage: null,
            agentTasks: [],
            currentAgentId: null,
            selectedIds: new Set(),
            // sessionId 置空：真实会话 ID 由后端首帧下发，绝不在此处编造临时 ID。
            // 旧实现塞了一个 session-${Date.now()} 的假 ID，导致流程结束后
            // 拿着这个不存在的会话去查结果，永远查不到题目。
            sessionId: null,
        })

        orchestrateStream = api.workbench.orchestrateAgents(
            {
                task: 'question_generate',
                params: {
                    poemId: state.poemId,
                    gradeLevel: state.gradeLevel,
                    questionTypes: state.questionTypes,
                    bloomWeights: state.bloomWeights,
                    count: state.count,
                    teacherId: state.teacherId,
                    classId: state.classId || undefined,
                    excludeUsedQuestions: state.excludeUsedQuestions ? [] : undefined,
                },
            },
            {
                onEvent: (event) => {
                    // 首帧即可拿到后端真实 sessionId，后续拉取结果全部以它为准
                    if (event.sessionId && get().sessionId !== event.sessionId) {
                        set({ sessionId: event.sessionId })
                    }

                    if (event.type === 'session:error') {
                        set({
                            orchestrating: false,
                            generating: false,
                            orchestrateError: event.error ?? '多智能体编排失败',
                        })
                        return
                    }
                    if (event.type === 'session:end') return
                    if (!event.agentId) return

                    const agentId = event.agentId
                    set((s) => {
                        const current = s.agentRuntimes[agentId]
                        if (!current) return s
                        const next: WorkbenchAgentRuntime = { ...current }

                        switch (event.type) {
                            case 'agent:start':
                                next.status = 'running'
                                next.progress = 0
                                next.output = ''
                                next.startedAt = event.timestamp
                                next.endedAt = undefined
                                next.elapsedMs = undefined
                                next.error = undefined
                                break
                            case 'agent:progress':
                                if (typeof event.progress === 'number') {
                                    next.progress = Math.max(0, Math.min(100, Math.round(event.progress)))
                                }
                                if (event.delta) {
                                    next.output = (current.output + event.delta).slice(-MAX_AGENT_OUTPUT_CHARS)
                                }
                                break
                            case 'agent:output': {
                                if (typeof event.delta === 'string') {
                                    next.output = (current.output + event.delta).slice(-MAX_AGENT_OUTPUT_CHARS)
                                }
                                if (typeof event.progress === 'number') {
                                    next.progress = Math.max(0, Math.min(100, Math.round(event.progress)))
                                }
                                break
                            }
                            case 'agent:done':
                                next.status = 'success'
                                next.progress = 100
                                next.endedAt = event.timestamp
                                next.elapsedMs = event.elapsedMs
                                    ?? (next.startedAt ? event.timestamp - next.startedAt : undefined)
                                if (event.output) next.output = event.output
                                break
                            case 'agent:failed':
                                next.status = 'failed'
                                next.endedAt = event.timestamp
                                next.error = event.error ?? '执行失败'
                                next.elapsedMs = event.elapsedMs
                                    ?? (next.startedAt ? event.timestamp - next.startedAt : undefined)
                                break
                            default:
                                return s
                        }

                        return {
                            ...s,
                            agentRuntimes: { ...s.agentRuntimes, [agentId]: next },
                            currentAgentId: next.status === 'running' ? agentId : s.currentAgentId,
                        }
                    })
                },
                onDone: () => {
                    set({ orchestrating: false })
                    // 用后端下发的真实 sessionId 拉取最终题目
                    const finalSessionId = get().sessionId
                    if (finalSessionId) {
                        void get().fetchQuestions(finalSessionId)
                    } else {
                        set({ generating: false })
                    }
                },
                onError: (err) => {
                    const msg = getDisplayError(err, '多智能体编排失败')
                    set({ orchestrating: false, generating: false, orchestrateError: msg })
                    toast.error({ title: '命题失败', message: msg })
                },
            },
        )
    },

    abortOrchestration: () => {
        orchestrateStream?.abort()
        orchestrateStream = null
        set((s) => ({
            orchestrating: false,
            generating: false,
            // 已跑完的节点保留成功态，仅把「运行中」标记为已中止，
            // 让教师清楚看到中断发生在哪一步、之前的产出仍然有效。
            agentRuntimes: Object.fromEntries(
                Object.entries(s.agentRuntimes).map(([k, v]) => [
                    k,
                    v.status === 'running'
                        ? { ...v, status: 'failed' as const, error: '已由教师手动中止' }
                        : v,
                ]),
            ) as Record<WorkbenchAgentKind, WorkbenchAgentRuntime>,
        }))
        toast.info({ title: '已中止命题', message: '在途的大模型调用已同步停止，不再继续计费' })
    },

    generate: async () => {
        const state = get()
        if (!state.poemId) {
            toast.warning({ title: '请先选择古诗', message: '命题前需指定目标诗篇' })
            return
        }
        if (state.questionTypes.length === 0) {
            toast.warning({ title: '请选择题型', message: '至少选择一种题型' })
            return
        }

        set({
            generating: true,
            error: null,
            questions: [],
            verification: null,
            coverage: null,
            agentTasks: [],
            currentAgentId: null,
            selectedIds: new Set(),
        })

        try {
            const res = await api.workbench.generate({
                poemId: state.poemId,
                gradeLevel: state.gradeLevel,
                questionTypes: state.questionTypes,
                bloomWeights: state.bloomWeights,
                count: state.count,
                teacherId: state.teacherId,
                classId: state.classId || undefined,
                excludeUsedQuestions: state.excludeUsedQuestions ? [] : undefined,
            })
            set({ sessionId: res.sessionId, generating: true })
            toast.info({ title: '命题已启动', message: '多智能体正在协作生成，请稍候' })
        } catch (err) {
            set({ generating: false })
            const msg = getDisplayError(err, '未知错误')
            set({ error: msg })
            toast.error({ title: '命题启动失败', message: msg })
        }
    },

    fetchQuestions: async (sessionId) => {
        try {
            const res: WorkbenchQuestionsResponse = await api.workbench.questions(sessionId)
            // 防御性校验：res.questions 可能为 undefined/null（后端契约漂移），降级为空数组
            const safeQuestions = Array.isArray(res.questions) ? res.questions : []
            set({
                questions: safeQuestions,
                verification: res.verification ?? null,
                coverage: res.coverage ?? null,
                generating: false,
            })
            if (safeQuestions.length > 0) {
                toast.success({ title: '命题完成', message: `已生成 ${safeQuestions.length} 道题目` })
                // v5.0 Task 4.11：通知中心推送 —— 命题是异步长流程，教师可能切走查看其他模块
                useNotificationStore.getState().push({
                    type: 'success',
                    title: '命题完成',
                    description: `已生成 ${safeQuestions.length} 道题目，可前往微调或发布闯关`,
                    linkTo: '/workbench',
                })
                // Phase 5.3：发射业务事件，通知 classroom/copilot 命题已完成（打通"备课→授课"感知链路）
                const { poemId } = get()
                businessEvents.emit('workbench:question-ready', {
                    poemId,
                    questionIds: safeQuestions.map((q) => q.id),
                    count: safeQuestions.length,
                })
            }
        } catch (err) {
            set({ generating: false })
            toast.error({ title: '拉取结果失败', message: getDisplayError(err, '未知错误') })
        }
    },

    refineQuestion: async (questionId, instruction) => {
        const state = get()
        const question = state.questions.find((q) => q.id === questionId)
        if (!question) {
            toast.error({ title: '微调失败', message: '未找到目标题目' })
            return
        }

        set({ refining: true })
        try {
            const res = await api.workbench.refine({
                question,
                instruction,
                poemId: state.poemId,
                gradeLevel: state.gradeLevel,
                teacherId: state.teacherId,
            })
            // 乐观更新：立即替换题目
            set((s) => ({
                questions: s.questions.map((q) => (q.id === questionId ? res.refined : q)),
                refining: false,
            }))
            toast.success({ title: '微调完成', message: '题目已更新' })
        } catch (err) {
            set({ refining: false })
            toast.error({ title: '微调失败', message: getDisplayError(err, '未知错误') })
        }
    },

    exportQuestions: async (format) => {
        const state = get()
        const ids = state.selectedIds.size > 0
            ? Array.from(state.selectedIds)
            : state.questions.map((q) => q.id)
        if (ids.length === 0) {
            toast.warning({ title: '无可导出题目', message: '请先生成或选择题目' })
            return
        }

        set({ exporting: true })
        try {
            const res = await api.workbench.export({ questionIds: ids, format })
            // 触发浏览器下载
            const blob = new Blob([res.data], {
                type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8',
            })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `命题导出_${Date.now()}.${format}`
            a.click()
            URL.revokeObjectURL(url)
            set({ exporting: false })
            toast.success({ title: '导出成功', message: `已导出 ${res.count} 道题目（${format.toUpperCase()}）` })
        } catch (err) {
            set({ exporting: false })
            toast.error({ title: '导出失败', message: getDisplayError(err, '未知错误') })
        }
    },

    publishQuestions: async (mode) => {
        const state = get()
        if (!state.classId) {
            toast.warning({ title: '请先选择班级', message: '发布闯关需指定目标班级' })
            return
        }
        if (!state.poemId) {
            toast.warning({ title: '请先选择古诗', message: '发布闯关需指定诗篇' })
            return
        }
        const ids = state.selectedIds.size > 0
            ? Array.from(state.selectedIds)
            : state.questions.map((q) => q.id)
        const questions = state.questions.filter((q) => ids.includes(q.id))
        if (questions.length === 0) {
            toast.warning({ title: '无可发布题目', message: '请先生成或选择题目' })
            return
        }

        set({ publishing: true })
        try {
            const res = await api.workbench.publish({
                classId: state.classId,
                poemId: state.poemId,
                teacherId: state.teacherId,
                questions,
                mode,
            })
            set({ publishing: false })
            toast.success({ title: '发布成功', message: `已创建闯关任务，含 ${res.questionIds.length} 道题目` })
            // v5.0 Task 4.11：通知中心推送 —— 发布闯关影响班级，教师可在通知中心回看
            useNotificationStore.getState().push({
                type: 'success',
                title: '闯关已发布',
                description: `${PUBLISH_MODE_LABEL[mode]} · ${res.questionIds.length} 道题目已下发到班级`,
                linkTo: '/workbench',
            })
        } catch (err) {
            set({ publishing: false })
            toast.error({ title: '发布失败', message: getDisplayError(err, '未知错误') })
        }
    },

    toggleSelect: (id) =>
        set((state) => {
            const next = new Set(state.selectedIds)
            if (next.has(id)) {
                next.delete(id)
            } else {
                next.add(id)
            }
            return { selectedIds: next }
        }),

    selectAll: () =>
        set((state) => ({
            selectedIds: new Set(state.questions.map((q) => q.id)),
        })),

    selectNone: () => set({ selectedIds: new Set() }),

    handleWSEvent: (event) => {
        const state = get()
        if (!state.sessionId || event.sessionId !== state.sessionId) return

        const payload = event.payload as {
            taskId?: string
            agentId?: string
            status?: string
            error?: string
            endedAt?: number
        }

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
                                status: 'running',
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
                if (state.sessionId) {
                    void get().fetchQuestions(state.sessionId)
                }
                break
            }
            default:
                break
        }
    },

    reset: () =>
        set({
            poemId: '',
            questions: [],
            verification: null,
            coverage: null,
            sessionId: null,
            agentTasks: [],
            currentAgentId: null,
            selectedIds: new Set(),
            generating: false,
            error: null,
        }),
}))
