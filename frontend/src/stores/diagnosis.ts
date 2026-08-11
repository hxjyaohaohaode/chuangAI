/**
 * 认知诊断中心全局状态（Task 17）
 *
 * 职责：
 * 1. 持有诊断中心四类数据：班级诊断 / 学生诊断 / 暗物质 / 学习路径
 * 2. 管理 Tab 切换与班级/学生选择
 * 3. 提供并行拉取与降级保留旧数据策略
 * 4. 班级切换自动重载班级维度数据；学生切换自动重载学生维度数据
 *
 * 设计要点（规范第 12 章 —— 实时数据同步）：
 * - 同页面内组件数据变更即时同步（≤50ms，Zustand 同步更新）
 * - 加载失败时降级保留旧数据，不空白
 * - loading 采用 Record<key, boolean> 精细控制，避免全局 loading 阻塞
 * - 学生列表从 heatmap 数据中提取（后端无单独学生列表端点）
 */

import { getDisplayError } from '@/lib/errors'
import { create } from 'zustand'
import { api } from '@/lib/api'
import { isDemoMode } from '@/lib/demo-mode'
import { businessEvents } from '@/lib/business-events'
import type {
    DiagnosisTab,
    DiagnosisLoadingKey,
    BloomDistributionResponse,
    HeatmapResponse,
    HeatmapStudent,
    StudentProfileResponse,
    StudentGap,
    DarkMatter,
    DarkMatterReportResponse,
    LearningPathNode,
    BloomLevel,
    WSStatus,
    WSEvent,
    // Phase 4.2：教学调整建议类型（基于诊断数据 + 错题本数据生成）
    TeachingSuggestion,
    TeachingSuggestionResponse,
    // 批改诊断深化能力 4/5：学习路径生成
    LearningPathOutput,
    LearningPathGenerateRequest,
    // 批改诊断深化能力 5/5：个性化处方
    PrescriptionOutput,
    PrescriptionGenerateRequest,
    // v5.0 学情诊断 AI 建议流式
    AiChatMessage,
    AiChatStreamRequest,
    AiChatStreamController,
    AiChatStreamCallbacks,
    AiChatStreamChunk,
    AiThinkingMode,
} from '@/lib/types'
import type { DiagnosisStreamCallbacks } from '@/lib/api'
import { appendBoundedHistory } from '@/lib/bounded-history'

/** 诊断聊天保留最近 20 轮；模型请求仍只取最近 3 轮作为上下文。 */
const MAX_SUGGESTION_MESSAGES = 40

/** 空数据初始值，避免 undefined 导致组件类型断言 */
const EMPTY_BLOOM_DISTRIBUTION: BloomDistributionResponse = {
    classId: '',
    levels: [
        { level: '记忆', avg: 0, stdDev: 0, studentCount: 0 },
        { level: '理解', avg: 0, stdDev: 0, studentCount: 0 },
        { level: '应用', avg: 0, stdDev: 0, studentCount: 0 },
        { level: '分析', avg: 0, stdDev: 0, studentCount: 0 },
        { level: '评价', avg: 0, stdDev: 0, studentCount: 0 },
        { level: '创造', avg: 0, stdDev: 0, studentCount: 0 },
    ],
    aiGenerated: false,
}

const EMPTY_HEATMAP: HeatmapResponse = {
    classId: '',
    students: [],
    poems: [],
    cells: [],
    aiGenerated: false,
}

const EMPTY_RADAR: Record<BloomLevel, number> = {
    记忆: 0, 理解: 0, 应用: 0, 分析: 0, 评价: 0, 创造: 0,
}

const EMPTY_PROFILE: StudentProfileResponse = {
    studentId: '',
    anonymousName: '',
    bloomRadar: EMPTY_RADAR,
    gaps: [],
    learningPath: [],
    aiGenerated: false,
}

/** 解析 LLM 流式拼接后的 JSON；兼容模型偶尔附带的 Markdown 代码围栏。 */
function parseStreamedJson<T>(raw: string): T {
    const normalized = raw.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim()
    return JSON.parse(normalized) as T
}

const EMPTY_DARK_MATTER_REPORT: DarkMatterReportResponse = {
    classId: '',
    totalDarkMatter: 0,
    byBloomLevel: {},
    byTheme: {},
    byImage: {},
    topPatterns: [],
    aiGenerated: false,
}

/** Phase 4.2：教学建议空数据初始值 */
const EMPTY_SUGGESTIONS: TeachingSuggestion[] = []

/** Phase 4.2：教学建议响应空数据初始值（含数据摘要） */
const EMPTY_SUGGESTION_RESPONSE: TeachingSuggestionResponse = {
    classId: '',
    suggestions: [],
    generatedAt: 0,
    dataSummary: {
        classMasteryAvg: 0,
        darkMatterCount: 0,
        weakestBloomLevel: '记忆',
        dueTodayCount: 0,
    },
    aiGenerated: false,
}

/** 初始 loading 状态（全部 false） */
const INITIAL_LOADING: Record<DiagnosisLoadingKey, boolean> = {
    bloomDistribution: false,
    heatmap: false,
    studentProfile: false,
    studentGaps: false,
    darkMatter: false,
    darkMatterReport: false,
    learningPath: false,
    students: false,
    // Phase 4.2：教学建议加载态
    suggestions: false,
    // 批改诊断深化能力加载态
    multiDimScore: false,
    ocr: false,
    errorAttribution: false,
    aiLearningPath: false,
    prescription: false,
    // v5.0 学情诊断 AI 建议流式
    aiSuggestion: false,
}

interface DiagnosisState {
    // ── 导航状态 ──
    activeTab: DiagnosisTab
    selectedClassId: string | null
    selectedStudentId: string | null

    // ── 班级维度数据 ──
    bloomDistribution: BloomDistributionResponse
    heatmapData: HeatmapResponse
    darkMatterList: DarkMatter[]
    darkMatterReport: DarkMatterReportResponse

    // ── 学生维度数据 ──
    studentList: HeatmapStudent[]
    studentProfile: StudentProfileResponse
    studentGaps: StudentGap[]
    learningPath: LearningPathNode[]

    // ── Phase 4.2：教学调整建议（基于诊断数据 + 错题本数据） ──
    teachingSuggestions: TeachingSuggestion[]
    suggestionResponse: TeachingSuggestionResponse

    // ── 批改诊断深化能力 4/5：AI 学习路径（区别于规则路径 learningPath） ──
    /** AI 生成的学习路径（含起点测试 + 薄弱点 + 序列 + 检查点） */
    aiLearningPath: LearningPathOutput | null
    /** 流式生成的学习路径文本（逐字累积，用于打字机效果） */
    streamingPathText: string
    /** 流式控制器引用（用于中断） */
    pathStreamController: { abort: () => void; readonly streaming: boolean } | null
    /** 学习路径流会话版本；取消、重试或切换学生后，旧 SSE 回调不得再写入。 */
    pathStreamToken: number

    // ── 批改诊断深化能力 5/5：个性化处方 ──
    /** AI 生成的个性化处方（七大模块） */
    prescription: PrescriptionOutput | null
    /** 流式生成的处方文本（逐字累积，用于打字机效果） */
    streamingPrescriptionText: string
    /** 流式控制器引用（用于中断） */
    prescriptionStreamController: { abort: () => void; readonly streaming: boolean } | null
    /** 个性化处方流会话版本；用于隔离迟到的 SSE 分片与完成事件。 */
    prescriptionStreamToken: number

    // ── v5.0 学情诊断 AI 建议流式（POST /api/ai/chat）──
    /** AI 建议对话历史（含 system + 多轮 user/assistant，至少 3 轮记忆） */
    suggestionMessages: AiChatMessage[]
    /** 流式累积的 AI 建议正文（逐字累积，用于打字机效果） */
    streamingSuggestionText: string
    /** 流式累积的思考过程（reasoning，思考模式开启时） */
    streamingSuggestionReasoning: string
    /** 流式控制器引用（用于中断） */
    suggestionStreamController: AiChatStreamController | null
    /** 最近一次 AI 建议生成的错误信息（null 表示无错误） */
    suggestionError: string | null
    /** AI 建议流会话版本；清空、重试或切换学生后，旧流不得恢复已清空的对话。 */
    suggestionStreamToken: number

    // ── 加载态 ──
    loading: Record<DiagnosisLoadingKey, boolean>
    /** 错误信息（null 表示无错误） */
    error: string | null

    // ── 动作 ──
    /** 切换 Tab */
    setActiveTab: (tab: DiagnosisTab) => void
    /** 选择班级（触发班级维度数据重载） */
    selectClass: (classId: string) => void
    /** 选择学生（触发学生维度数据重载） */
    selectStudent: (studentId: string) => void
    /** 拉取班级六阶分布 */
    fetchBloomDistribution: (classId?: string) => Promise<void>
    /** 拉取班级热力图（同时更新 studentList） */
    fetchHeatmap: (classId?: string) => Promise<void>
    /** 拉取学生认知画像 */
    fetchStudentProfile: (studentId?: string) => Promise<void>
    /** 拉取学生知识漏洞 */
    fetchStudentGaps: (studentId?: string) => Promise<void>
    /** 拉取班级暗物质列表 */
    fetchDarkMatter: (classId?: string) => Promise<void>
    /** 拉取暗物质汇总报告 */
    fetchDarkMatterReport: (classId?: string) => Promise<void>
    /** 拉取推荐学习路径 */
    fetchLearningPath: (studentId?: string) => Promise<void>
    /** Phase 4.2：拉取教学调整建议（基于诊断数据 + 错题本数据） */
    fetchTeachingSuggestions: (classId?: string) => Promise<void>
    /** 重置 store */
    reset: () => void

    // ── 批改诊断深化能力 4/5 动作 ──
    /** 拉取 AI 生成的学习路径（非流式） */
    fetchAiLearningPath: (studentId?: string) => Promise<void>
    /** 流式生成 AI 学习路径（SSE，逐字推送 + 打字机效果） */
    streamAiLearningPath: (studentId: string, req?: LearningPathGenerateRequest) => void
    /** 中断学习路径流式生成 */
    abortPathStream: () => void

    // ── 批改诊断深化能力 5/5 动作 ──
    /** 拉取个性化处方（非流式） */
    fetchPrescription: (studentId?: string) => Promise<void>
    /** 流式生成个性化处方（SSE，逐字推送 + 打字机效果） */
    streamPrescription: (studentId: string, req?: PrescriptionGenerateRequest) => void
    /** 中断处方流式生成 */
    abortPrescriptionStream: () => void

    // ── v5.0 学情诊断 AI 建议流式动作 ──
    /**
     * 发起 AI 建议流式对话（POST /api/ai/chat SSE）
     *
     * 自动维护至少 3 轮上下文记忆（截取最近 6 条 user/assistant 消息 + 1 条 system）。
     * 流式期间通过 streamingSuggestionText 累积正文，streamingSuggestionReasoning 累积思考过程。
     * 流式完成后将 assistant 消息追加到 suggestionMessages。
     */
    streamSuggestion: (params: {
        studentId: string
        userMessage: string
        systemPrompt?: string
        thinkingMode?: AiThinkingMode
    }) => void
    /** 中断 AI 建议流式生成（保留已生成的部分文本） */
    abortSuggestionStream: () => void
    /** 清空 AI 建议对话历史与流式状态（切换学生时调用） */
    clearSuggestion: () => void

    // ── WebSocket（v5.0 Task 3.5）──
    /** WebSocket 连接状态 */
    wsStatus: WSStatus
    /** 设置 WS 连接状态 */
    setWsStatus: (status: WSStatus) => void
    /** 处理 WS 事件（orch:session:end/task:done/task:failed 触发当前维度数据刷新） */
    handleWSEvent: (event: WSEvent) => void
}

/** 事件触发刷新的 debounce 延迟（ms），避免高频 WS 事件风暴 */
const REFRESH_DEBOUNCE_MS = 800
/** 内部 debounce 定时器引用（模块级，避免 store 重置丢失） */
let refreshTimer: number | null = null

/**
 * Diagnosis Zustand store
 *
 * 用法：
 *   const { activeTab, bloomDistribution, selectClass } = useDiagnosisStore()
 *   useDiagnosisStore.getState().selectClass('class-001')
 */
export const useDiagnosisStore = create<DiagnosisState>((set, get) => ({
    // ── WebSocket（v5.0 Task 3.5）──
    wsStatus: 'idle',
    setWsStatus: (status) => set({ wsStatus: status }),
    handleWSEvent: (event) => {
        // Phase 1.3：实现 WS 事件处理，编排官会话结束/任务完成时刷新当前维度数据
        // 断裂点#7修复：handleWSEvent 此前为空，WS 事件无法触发诊断数据刷新
        const shouldRefresh = event.type === 'orch:session:end'
            || event.type === 'orch:task:done'
            || event.type === 'orch:task:failed'
        if (!shouldRefresh) return

        if (refreshTimer !== null) {
            window.clearTimeout(refreshTimer)
        }
        refreshTimer = window.setTimeout(() => {
            const state = get()
            // 优先刷新学生维度（若已选学生），否则刷新班级维度
            if (state.selectedStudentId) {
                void state.fetchStudentProfile()
                void state.fetchStudentGaps()
                void state.fetchLearningPath()
            } else if (state.selectedClassId) {
                void state.fetchBloomDistribution()
                void state.fetchHeatmap()
            }
            refreshTimer = null
        }, REFRESH_DEBOUNCE_MS)
    },

    activeTab: 'class',
    selectedClassId: null,
    selectedStudentId: null,

    bloomDistribution: EMPTY_BLOOM_DISTRIBUTION,
    heatmapData: EMPTY_HEATMAP,
    darkMatterList: [],
    darkMatterReport: EMPTY_DARK_MATTER_REPORT,

    studentList: [],
    studentProfile: EMPTY_PROFILE,
    studentGaps: [],
    learningPath: [],

    // Phase 4.2：教学建议初始值
    teachingSuggestions: EMPTY_SUGGESTIONS,
    suggestionResponse: EMPTY_SUGGESTION_RESPONSE,

    // 批改诊断深化能力初始值
    aiLearningPath: null,
    streamingPathText: '',
    pathStreamController: null,
    pathStreamToken: 0,
    prescription: null,
    streamingPrescriptionText: '',
    prescriptionStreamController: null,
    prescriptionStreamToken: 0,

    // v5.0 学情诊断 AI 建议流式初始值
    suggestionMessages: [],
    streamingSuggestionText: '',
    streamingSuggestionReasoning: '',
    suggestionStreamController: null,
    suggestionError: null,
    suggestionStreamToken: 0,

    loading: { ...INITIAL_LOADING },
    error: null,

    setActiveTab: (tab) => {
        set({ activeTab: tab })
    },

    selectClass: (classId) => {
        // 切班是完整实体上下文切换：先令学生 SSE/对话失效，再清除上一班级
        // 的可见数据。所有班级请求完成时还会二次核对 selectedClassId。
        get().abortPathStream()
        get().abortPrescriptionStream()
        get().clearSuggestion()
        set({
            selectedClassId: classId,
            selectedStudentId: null,
            bloomDistribution: EMPTY_BLOOM_DISTRIBUTION,
            heatmapData: EMPTY_HEATMAP,
            darkMatterList: [],
            darkMatterReport: EMPTY_DARK_MATTER_REPORT,
            studentList: [],
            studentProfile: EMPTY_PROFILE,
            studentGaps: [],
            learningPath: [],
            teachingSuggestions: EMPTY_SUGGESTIONS,
            suggestionResponse: EMPTY_SUGGESTION_RESPONSE,
            aiLearningPath: null,
            streamingPathText: '',
            prescription: null,
            streamingPrescriptionText: '',
            loading: { ...INITIAL_LOADING },
            error: null,
        })
        // 班级切换后并行重载班级维度数据
        const { fetchBloomDistribution, fetchHeatmap, fetchDarkMatter, fetchDarkMatterReport } = get()
        void Promise.allSettled([
            fetchBloomDistribution(classId),
            fetchHeatmap(classId),
            fetchDarkMatter(classId),
            fetchDarkMatterReport(classId),
        ])
    },

    selectStudent: (studentId) => {
        // 切换学生时绝不把上一位学生的画像、漏洞、路径或处方标注到新学生名下。
        // 异步请求将在各自完成时再次核对 selectedStudentId，双层隔离迟到响应。
        get().abortPathStream()
        get().abortPrescriptionStream()
        set({
            selectedStudentId: studentId,
            studentProfile: EMPTY_PROFILE,
            studentGaps: [],
            learningPath: [],
            aiLearningPath: null,
            prescription: null,
            streamingPathText: '',
            streamingPrescriptionText: '',
        })
        // v5.0：切换学生时清空 AI 建议对话历史（不同学生上下文不共享）
        get().clearSuggestion()
        // 学生切换后并行重载学生维度数据（含个性化处方，5 组件联动）
        const { fetchStudentProfile, fetchStudentGaps, fetchLearningPath, fetchPrescription } = get()
        void Promise.allSettled([
            fetchStudentProfile(studentId),
            fetchStudentGaps(studentId),
            fetchLearningPath(studentId),
            fetchPrescription(studentId),
        ])
    },

    fetchBloomDistribution: async (classIdOverride?: string) => {
        const classId = classIdOverride ?? get().selectedClassId
        if (!classId) return
        // v5.0 Task 5.8：DEMO 模式下跳过 API 调用，避免 500 错误雪崩
        if (isDemoMode()) return

        set((s) => ({ loading: { ...s.loading, bloomDistribution: true } }))
        try {
            const res = await api.diagnosis.bloomDistribution(classId)
            if (get().selectedClassId !== classId) return
            set((s) => ({
                bloomDistribution: res,
                loading: { ...s.loading, bloomDistribution: false },
                error: null,
            }))
        } catch (err) {
            if (get().selectedClassId !== classId) return
            set((s) => ({
                loading: { ...s.loading, bloomDistribution: false },
                error: getDisplayError(err, '六阶分布加载失败'),
            }))
        }
    },

    fetchHeatmap: async (classIdOverride?: string) => {
        const classId = classIdOverride ?? get().selectedClassId
        if (!classId) return
        // v5.0 Task 5.8：DEMO 模式下跳过 API 调用，避免 500 错误雪崩
        if (isDemoMode()) return

        set((s) => ({
            loading: { ...s.loading, heatmap: true, students: true },
        }))
        try {
            const res = await api.diagnosis.heatmap(classId)
            if (get().selectedClassId !== classId) return
            // 热力图数据同时提供学生列表（后端无单独端点）
            set((s) => ({
                heatmapData: res,
                studentList: res.students,
                loading: { ...s.loading, heatmap: false, students: false },
                error: null,
            }))
        } catch (err) {
            if (get().selectedClassId !== classId) return
            set((s) => ({
                loading: { ...s.loading, heatmap: false, students: false },
                error: getDisplayError(err, '热力图加载失败'),
            }))
        }
    },

    fetchStudentProfile: async (studentIdOverride?: string) => {
        const studentId = studentIdOverride ?? get().selectedStudentId
        if (!studentId) return
        // v5.0 Task 5.8：DEMO 模式下跳过 API 调用，避免 500 错误雪崩
        if (isDemoMode()) return

        set((s) => ({ loading: { ...s.loading, studentProfile: true } }))
        try {
            const res = await api.diagnosis.studentProfile(studentId)
            if (get().selectedStudentId !== studentId) return
            set((s) => ({
                studentProfile: res,
                loading: { ...s.loading, studentProfile: false },
                error: null,
            }))
        } catch (err) {
            if (get().selectedStudentId !== studentId) return
            set((s) => ({
                loading: { ...s.loading, studentProfile: false },
                error: getDisplayError(err, '学生画像加载失败'),
            }))
        }
    },

    fetchStudentGaps: async (studentIdOverride?: string) => {
        const studentId = studentIdOverride ?? get().selectedStudentId
        if (!studentId) return
        // v5.0 Task 5.8：DEMO 模式下跳过 API 调用，避免 500 错误雪崩
        if (isDemoMode()) return

        set((s) => ({ loading: { ...s.loading, studentGaps: true } }))
        try {
            const res = await api.diagnosis.studentGaps(studentId)
            if (get().selectedStudentId !== studentId) return
            set((s) => ({
                studentGaps: res.gaps,
                loading: { ...s.loading, studentGaps: false },
                error: null,
            }))
        } catch (err) {
            if (get().selectedStudentId !== studentId) return
            set((s) => ({
                loading: { ...s.loading, studentGaps: false },
                error: getDisplayError(err, '知识漏洞加载失败'),
            }))
        }
    },

    fetchDarkMatter: async (classIdOverride?: string) => {
        const classId = classIdOverride ?? get().selectedClassId
        if (!classId) return
        // v5.0 Task 5.8：DEMO 模式下跳过 API 调用，避免 500 错误雪崩
        if (isDemoMode()) return

        set((s) => ({ loading: { ...s.loading, darkMatter: true } }))
        try {
            const res = await api.diagnosis.darkMatter(classId)
            if (get().selectedClassId !== classId) return
            set((s) => ({
                darkMatterList: res.darkMatter,
                loading: { ...s.loading, darkMatter: false },
                error: null,
            }))
        } catch (err) {
            if (get().selectedClassId !== classId) return
            set((s) => ({
                loading: { ...s.loading, darkMatter: false },
                error: getDisplayError(err, '暗物质检测失败'),
            }))
        }
    },

    fetchDarkMatterReport: async (classIdOverride?: string) => {
        const classId = classIdOverride ?? get().selectedClassId
        if (!classId) return
        // v5.0 Task 5.8：DEMO 模式下跳过 API 调用，避免 500 错误雪崩
        if (isDemoMode()) return

        set((s) => ({ loading: { ...s.loading, darkMatterReport: true } }))
        try {
            const res = await api.diagnosis.darkMatterReport(classId)
            if (get().selectedClassId !== classId) return
            set((s) => ({
                darkMatterReport: res,
                loading: { ...s.loading, darkMatterReport: false },
                error: null,
            }))
        } catch (err) {
            if (get().selectedClassId !== classId) return
            set((s) => ({
                loading: { ...s.loading, darkMatterReport: false },
                error: getDisplayError(err, '暗物质报告加载失败'),
            }))
        }
    },

    fetchLearningPath: async (studentIdOverride?: string) => {
        const studentId = studentIdOverride ?? get().selectedStudentId
        if (!studentId) return
        // v5.0 Task 5.8：DEMO 模式下跳过 API 调用，避免 500 错误雪崩
        if (isDemoMode()) return

        set((s) => ({ loading: { ...s.loading, learningPath: true } }))
        try {
            const res = await api.diagnosis.learningPath(studentId)
            if (get().selectedStudentId !== studentId) return
            set((s) => ({
                learningPath: res.path,
                loading: { ...s.loading, learningPath: false },
                error: null,
            }))
        } catch (err) {
            if (get().selectedStudentId !== studentId) return
            set((s) => ({
                loading: { ...s.loading, learningPath: false },
                error: getDisplayError(err, '学习路径推荐失败'),
            }))
        }
    },

    // ── Phase 4.2：教学调整建议 ──
    // 基于诊断数据（六阶分布 + 暗物质）和错题本数据（SM-2 算法到期错题），
    // 由 AI 生成针对性教学建议，回应"我是老师，这篇诗我应该如何教"的核心追问。
    // 设计要点：
    // - DEMO 模式下直接调用 DEMO 数据源（api.ts 内部已处理），store 层不跳过
    //   （与其他 fetch 方法不同，因为建议数据需要展示给评委预览）
    // - 失败时降级保留旧数据，不空白
    // - 错题本复习完成后会触发 error-notebook:review-completed 事件，自动刷新建议
    fetchTeachingSuggestions: async (classIdOverride?: string) => {
        const classId = classIdOverride ?? get().selectedClassId
        // 班级未选择时不拉取（DEMO 模式下 api.ts 会返回 DEMO 数据，但 store 层仍需 classId 守卫）
        if (!classId) return

        set((s) => ({ loading: { ...s.loading, suggestions: true } }))
        try {
            const res = await api.diagnosis.suggestions(classId)
            if (get().selectedClassId !== classId) return
            set((s) => ({
                teachingSuggestions: res.suggestions,
                suggestionResponse: res,
                loading: { ...s.loading, suggestions: false },
                error: null,
            }))
        } catch (err) {
            if (get().selectedClassId !== classId) return
            set((s) => ({
                loading: { ...s.loading, suggestions: false },
                error: getDisplayError(err, '教学建议加载失败'),
            }))
        }
    },

    // ── 批改诊断深化能力 4/5：AI 学习路径（含 SSE 流式生成） ──

    fetchAiLearningPath: async (studentIdOverride?: string) => {
        const studentId = studentIdOverride ?? get().selectedStudentId
        if (!studentId) return
        if (isDemoMode()) return

        set((s) => ({ loading: { ...s.loading, aiLearningPath: true } }))
        try {
            const res = await api.diagnosis.getAiLearningPath(studentId)
            if (get().selectedStudentId !== studentId) return
            set((s) => ({
                aiLearningPath: res,
                loading: { ...s.loading, aiLearningPath: false },
                error: null,
            }))
        } catch (err) {
            if (get().selectedStudentId !== studentId) return
            set((s) => ({
                loading: { ...s.loading, aiLearningPath: false },
                error: getDisplayError(err, 'AI 学习路径加载失败'),
            }))
        }
    },

    streamAiLearningPath: (studentId, req) => {
        if (isDemoMode()) return
        // 中断已有流
        get().abortPathStream()
        // 不能只依赖 AbortController：网络缓冲中的最后一帧仍可能在 abort 后抵达。
        // 以单调 token 将本次会话与任何迟到回调隔离，即使同一学生连续重试也不串写。
        const pathStreamToken = get().pathStreamToken + 1

        set({
            streamingPathText: '',
            loading: { ...get().loading, aiLearningPath: true },
            pathStreamController: null,
            pathStreamToken,
        })

        const callbacks: DiagnosisStreamCallbacks = {
            onDelta: (content) => {
                if (get().pathStreamToken !== pathStreamToken) return
                set((s) => ({ streamingPathText: s.streamingPathText + content }))
            },
            onDone: () => {
                if (get().pathStreamToken !== pathStreamToken) return
                try {
                    const output = parseStreamedJson<LearningPathOutput>(get().streamingPathText)
                    set((s) => ({
                        aiLearningPath: output,
                        loading: { ...s.loading, aiLearningPath: false },
                        pathStreamController: null,
                        error: null,
                    }))
                } catch (err) {
                    set((s) => ({
                        loading: { ...s.loading, aiLearningPath: false },
                        pathStreamController: null,
                        error: getDisplayError(err, 'AI 学习路径结果解析失败'),
                    }))
                }
            },
            onError: (err) => {
                if (get().pathStreamToken !== pathStreamToken) return
                set((s) => ({
                    loading: { ...s.loading, aiLearningPath: false },
                    pathStreamController: null,
                    error: getDisplayError(err, 'AI 学习路径生成失败'),
                }))
            },
        }

        const controller = api.diagnosis.streamAiLearningPath(studentId, req ?? {}, callbacks)
        set({ pathStreamController: controller })
    },

    abortPathStream: () => {
        const { pathStreamController } = get()
        if (pathStreamController?.streaming) {
            pathStreamController.abort()
        }
        set((s) => ({
            pathStreamController: null,
            pathStreamToken: s.pathStreamToken + 1,
            loading: { ...s.loading, aiLearningPath: false },
        }))
    },

    // ── 批改诊断深化能力 5/5：个性化处方（含 SSE 流式生成） ──

    fetchPrescription: async (studentIdOverride?: string) => {
        const studentId = studentIdOverride ?? get().selectedStudentId
        if (!studentId) return
        if (isDemoMode()) return

        set((s) => ({ loading: { ...s.loading, prescription: true } }))
        try {
            const res = await api.diagnosis.getPrescription(studentId)
            if (get().selectedStudentId !== studentId) return
            set((s) => ({
                prescription: res,
                loading: { ...s.loading, prescription: false },
                error: null,
            }))
        } catch (err) {
            if (get().selectedStudentId !== studentId) return
            set((s) => ({
                loading: { ...s.loading, prescription: false },
                error: getDisplayError(err, '个性化处方加载失败'),
            }))
        }
    },

    streamPrescription: (studentId, req) => {
        if (isDemoMode()) return
        // 中断已有流
        get().abortPrescriptionStream()
        // Abort 不能证明服务端最后一帧绝不会抵达；token 同时隔离换学生与同学生重试。
        const prescriptionStreamToken = get().prescriptionStreamToken + 1

        set({
            streamingPrescriptionText: '',
            loading: { ...get().loading, prescription: true },
            prescriptionStreamController: null,
            prescriptionStreamToken,
        })

        const callbacks: DiagnosisStreamCallbacks = {
            onDelta: (content) => {
                if (get().prescriptionStreamToken !== prescriptionStreamToken) return
                set((s) => ({ streamingPrescriptionText: s.streamingPrescriptionText + content }))
            },
            onDone: () => {
                if (get().prescriptionStreamToken !== prescriptionStreamToken) return
                try {
                    const output = parseStreamedJson<PrescriptionOutput>(get().streamingPrescriptionText)
                    set((s) => ({
                        prescription: output,
                        loading: { ...s.loading, prescription: false },
                        prescriptionStreamController: null,
                        error: null,
                    }))
                } catch (err) {
                    set((s) => ({
                        loading: { ...s.loading, prescription: false },
                        prescriptionStreamController: null,
                        error: getDisplayError(err, '个性化处方结果解析失败'),
                    }))
                }
            },
            onError: (err) => {
                if (get().prescriptionStreamToken !== prescriptionStreamToken) return
                set((s) => ({
                    loading: { ...s.loading, prescription: false },
                    prescriptionStreamController: null,
                    error: getDisplayError(err, '个性化处方生成失败'),
                }))
            },
        }

        const controller = api.diagnosis.streamPrescription(studentId, req ?? {}, callbacks)
        set({ prescriptionStreamController: controller })
    },

    abortPrescriptionStream: () => {
        const { prescriptionStreamController } = get()
        if (prescriptionStreamController?.streaming) {
            prescriptionStreamController.abort()
        }
        set((s) => ({
            prescriptionStreamController: null,
            prescriptionStreamToken: s.prescriptionStreamToken + 1,
            loading: { ...s.loading, prescription: false },
        }))
    },

    // ── v5.0 学情诊断 AI 建议流式实现 ──

    streamSuggestion: ({ studentId, userMessage, systemPrompt, thinkingMode }) => {
        if (isDemoMode()) {
            set({ suggestionError: '演示模式下不可用 AI 建议流式' })
            return
        }
        // 中断已有流
        get().abortSuggestionStream()
        // 清空、重试或切换学生后都推进 token，防止取消后的迟到 chunk 复活旧上下文。
        const suggestionStreamToken = get().suggestionStreamToken + 1

        // 构造 system prompt（若未提供则使用默认教学建议 prompt）
        const defaultSystemPrompt = `你是诗脉·启明系统的教学诊断助手，专注于为教师提供针对单个学生的个性化教学建议。
当前正在为学生 ${studentId} 生成教学建议。请基于教师提供的学情数据，给出具体、可执行的教学策略。
建议应包含：
1. 学生现状诊断（基于六阶认知模型）
2. 薄弱环节分析与归因
3. 针对性教学策略（含具体方法与资源）
4. 预期效果与检查节点
请使用清晰的 Markdown 格式输出，避免空洞的套话。`

        const finalSystemPrompt = systemPrompt ?? defaultSystemPrompt

        // 构造 messages：保留至少 3 轮上下文记忆（最近 6 条 user/assistant + 1 条 system）
        const prevMessages = get().suggestionMessages
        const recentHistory = prevMessages.slice(-6) // 最近 3 轮（每轮 user+assistant 共 2 条）
        const newUserMessage: AiChatMessage = { role: 'user', content: userMessage }

        const messagesForRequest: AiChatMessage[] = [
            { role: 'system', content: finalSystemPrompt },
            ...recentHistory.filter((m) => m.role !== 'system'),
            newUserMessage,
        ]

        // 重置流式状态，进入加载态
        set({
            streamingSuggestionText: '',
            streamingSuggestionReasoning: '',
            suggestionError: null,
            suggestionStreamController: null,
            suggestionStreamToken,
            loading: { ...get().loading, aiSuggestion: true },
        })

        // 构造请求体
        const req: AiChatStreamRequest = {
            messages: messagesForRequest,
            model: 'deepseek-v4-pro',
            thinking_mode: thinkingMode ?? 'medium',
            stream: true,
            session_id: `diagnosis-suggestion-${studentId}`,
        }

        // 流式回调
        let accumulatedContent = ''
        let accumulatedReasoning = ''

        const callbacks: AiChatStreamCallbacks = {
            onChunk: (chunk: AiChatStreamChunk) => {
                if (get().suggestionStreamToken !== suggestionStreamToken) return
                if (chunk.content) {
                    accumulatedContent += chunk.content
                    set({ streamingSuggestionText: accumulatedContent })
                }
                if (chunk.reasoning) {
                    accumulatedReasoning += chunk.reasoning
                    set({ streamingSuggestionReasoning: accumulatedReasoning })
                }
            },
            onDone: () => {
                if (get().suggestionStreamToken !== suggestionStreamToken) return
                // 流式完成：将 assistant 消息追加到历史
                const assistantMessage: AiChatMessage = {
                    role: 'assistant',
                    content: accumulatedContent,
                }
                set((s) => ({
                    suggestionMessages: appendBoundedHistory(
                        s.suggestionMessages,
                        [newUserMessage, assistantMessage],
                        MAX_SUGGESTION_MESSAGES,
                    ),
                    suggestionStreamController: null,
                    loading: { ...s.loading, aiSuggestion: false },
                    suggestionError: null,
                }))
            },
            onError: (err) => {
                if (get().suggestionStreamToken !== suggestionStreamToken) return
                set((s) => ({
                    suggestionStreamController: null,
                    loading: { ...s.loading, aiSuggestion: false },
                    suggestionError: getDisplayError(err, 'AI 建议生成失败'),
                }))
            },
        }

        const controller = api.ai.chatStream(req, callbacks)
        set({ suggestionStreamController: controller })
    },

    abortSuggestionStream: () => {
        const { suggestionStreamController } = get()
        if (suggestionStreamController?.streaming) {
            suggestionStreamController.abort()
        }
        // 中断后仍保留已生成的部分文本（用户可继续追问）
        set((s) => ({
            suggestionStreamController: null,
            suggestionStreamToken: s.suggestionStreamToken + 1,
            loading: { ...s.loading, aiSuggestion: false },
        }))
    },

    clearSuggestion: () => {
        // 中断已有流
        const { suggestionStreamController } = get()
        if (suggestionStreamController?.streaming) {
            suggestionStreamController.abort()
        }
        set({
            suggestionMessages: [],
            streamingSuggestionText: '',
            streamingSuggestionReasoning: '',
            suggestionStreamController: null,
            suggestionError: null,
            suggestionStreamToken: get().suggestionStreamToken + 1,
            loading: { ...get().loading, aiSuggestion: false },
        })
    },

    reset: () => {
        if (refreshTimer !== null) {
            window.clearTimeout(refreshTimer)
            refreshTimer = null
        }
        // 中断流式生成
        const state = get()
        state.abortPathStream()
        state.abortPrescriptionStream()
        state.abortSuggestionStream()
        set({
            activeTab: 'class',
            selectedClassId: null,
            selectedStudentId: null,
            bloomDistribution: EMPTY_BLOOM_DISTRIBUTION,
            heatmapData: EMPTY_HEATMAP,
            darkMatterList: [],
            darkMatterReport: EMPTY_DARK_MATTER_REPORT,
            studentList: [],
            studentProfile: EMPTY_PROFILE,
            studentGaps: [],
            learningPath: [],
            // Phase 4.2：重置教学建议
            teachingSuggestions: EMPTY_SUGGESTIONS,
            suggestionResponse: EMPTY_SUGGESTION_RESPONSE,
            // 批改诊断深化能力重置
            aiLearningPath: null,
            streamingPathText: '',
            pathStreamController: null,
            prescription: null,
            streamingPrescriptionText: '',
            prescriptionStreamController: null,
            // v5.0 AI 建议流式重置
            suggestionMessages: [],
            streamingSuggestionText: '',
            streamingSuggestionReasoning: '',
            suggestionStreamController: null,
            suggestionError: null,
            loading: { ...INITIAL_LOADING },
            error: null,
        })
    },
}))

// ─────────────────────────────────────────────────────────────────────────────
// v5.0 Task 4.6：业务事件总线订阅 —— grading → diagnosis 数据断点修复
//
// 教师在批改台完成审核后，grading store 会发射 'grading:reviewed' 业务事件。
// diagnosis store 在模块加载时订阅该事件，当事件携带的 classId 与当前选中
// 班级一致时，刷新班级维度的认知归因数据（六阶分布 / 热力图 / 暗物质 / 暗物质报告）。
//
// 严苛验收：grading 审核完成后，切到 diagnosis，认知归因 Top N 已更新。
// ─────────────────────────────────────────────────────────────────────────────
businessEvents.on('grading:reviewed', (event) => {
    const { classId } = event.payload
    const state = useDiagnosisStore.getState()
    // 仅当事件携带 classId 且与当前选中班级一致时刷新，避免加载非当前班级数据
    if (!classId || !state.selectedClassId || classId !== state.selectedClassId) return
    void state.fetchBloomDistribution()
    void state.fetchHeatmap()
    void state.fetchDarkMatter()
    void state.fetchDarkMatterReport()
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.3：业务事件总线订阅 —— 补齐 diagnosis store 的事件订阅缺口
//
// 断裂点#3/#4/#5/#6修复：diagnosis 此前仅订阅 grading:reviewed，对以下事件无感知：
// - diagnosis:updated   —— 学生完成诊断，画像与漏洞应即时刷新
// - self-study:progress —— 学生自学进度更新，班级热力图可能变化
// - classroom:ended     —— 课堂结束，班级诊断数据全面变化
// - report:generated    —— 班级诊断报告生成，刷新班级维度
// - recitation:completed —— 朗读完成，学生画像与班级热力图可能变化
//
// 设计要点：
// - 所有订阅共享同一个 debounce 定时器（refreshTimer），避免短时间内多次刷新
// - 刷新前校验 selectedClassId/selectedStudentId，避免加载非当前上下文的数据
// - fetch 方法内部有 DEMO 模式跳过，无后端环境下不会发起无效请求
// ─────────────────────────────────────────────────────────────────────────────

/** 统一 debounce 刷新：根据维度刷新对应数据 */
function debouncedRefreshDimension(dimension: 'class' | 'student'): void {
    if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer)
    }
    refreshTimer = window.setTimeout(() => {
        const state = useDiagnosisStore.getState()
        if (dimension === 'class' && state.selectedClassId) {
            void state.fetchBloomDistribution()
            void state.fetchHeatmap()
            void state.fetchDarkMatter()
            void state.fetchDarkMatterReport()
        } else if (dimension === 'student' && state.selectedStudentId) {
            void state.fetchStudentProfile()
            void state.fetchStudentGaps()
            void state.fetchLearningPath()
        }
        refreshTimer = null
    }, REFRESH_DEBOUNCE_MS)
}

// Phase 1.2：诊断数据更新 → 按事件 scope 刷新对应维度
// 学生完成自学舱诊断题后 self-study store 发射此事件，diagnosis 应即时刷新画像
businessEvents.on('diagnosis:updated', (event) => {
    const { scope, classId, studentId } = event.payload
    const state = useDiagnosisStore.getState()
    if (scope === 'student' && studentId && studentId === state.selectedStudentId) {
        debouncedRefreshDimension('student')
    } else if (scope === 'class' && classId && classId === state.selectedClassId) {
        debouncedRefreshDimension('class')
    }
})

// Phase 1.3：学生自学进度更新 → 刷新班级维度（热力图/六阶分布可能变化）
businessEvents.on('self-study:progress', (event) => {
    const { classId, studentId } = event.payload
    const state = useDiagnosisStore.getState()
    // 班级维度：事件 classId 与当前选中班级一致时刷新
    if (classId && classId === state.selectedClassId) {
        debouncedRefreshDimension('class')
    }
    // 学生维度：事件 studentId 与当前选中学生一致时刷新
    if (studentId && studentId === state.selectedStudentId) {
        debouncedRefreshDimension('student')
    }
})

// Phase 1.3：课堂结束 → 班级诊断数据全面变化，刷新班级维度
businessEvents.on('classroom:ended', (event) => {
    const { classId } = event.payload
    const state = useDiagnosisStore.getState()
    // 课堂结束影响整个班级，若未指定 classId 或与当前班级一致则刷新
    if (!classId || classId === state.selectedClassId) {
        debouncedRefreshDimension('class')
    }
})

// Phase 1.3：报告生成 → 按报告类型刷新对应维度
businessEvents.on('report:generated', (event) => {
    const { reportType, classId, studentId } = event.payload
    const state = useDiagnosisStore.getState()
    if (reportType === 'class-diagnosis') {
        if (!classId || classId === state.selectedClassId) {
            debouncedRefreshDimension('class')
        }
    } else if (reportType === 'student-profile') {
        if (studentId && studentId === state.selectedStudentId) {
            debouncedRefreshDimension('student')
        }
    }
})

// Phase 1.3：朗读完成 → 学生画像与班级热力图可能变化
businessEvents.on('recitation:completed', (event) => {
    const { classId, studentId } = event.payload
    const state = useDiagnosisStore.getState()
    if (studentId && studentId === state.selectedStudentId) {
        debouncedRefreshDimension('student')
    }
    if (classId && classId === state.selectedClassId) {
        debouncedRefreshDimension('class')
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4.2：业务事件总线订阅 —— error-notebook:review-completed → 教学建议刷新
//
// 数据闭环关键节点：学生在错题本完成 SM-2 间隔复习后，error-notebook store
// 发射 'error-notebook:review-completed' 事件。diagnosis store 订阅该事件，
// 当班级已选中时刷新教学建议（因为错题本数据是教学建议的核心输入之一，
// 复习完成后错题到期数/掌握度变化，建议的优先级和内容应随之更新）。
//
// 设计要点：
// - 事件载荷无 classId（学生维度事件），仅当班级已选中时刷新
// - 使用 debounce 避免短时间内多次复习导致的请求风暴
// - 仅刷新教学建议（suggestions），不影响六阶分布等其他维度
//   （其他维度由各自的事件订阅负责刷新）
// ─────────────────────────────────────────────────────────────────────────────
let suggestionRefreshTimer: number | null = null
businessEvents.on('error-notebook:review-completed', () => {
    const state = useDiagnosisStore.getState()
    // 班级未选中时不刷新（教学建议是班级维度数据）
    if (!state.selectedClassId) return
    // debounce 1500ms（比 REFRESH_DEBOUNCE_MS 略长，因为复习是连续操作）
    if (suggestionRefreshTimer !== null) {
        window.clearTimeout(suggestionRefreshTimer)
    }
    suggestionRefreshTimer = window.setTimeout(() => {
        void useDiagnosisStore.getState().fetchTeachingSuggestions()
        suggestionRefreshTimer = null
    }, 1500)
})

// ─────────────────────────────────────────────────────────────────────────────
// 批改诊断深化能力：业务事件订阅
//
// 后端通过 WSBroadcaster 推送以下事件，diagnosis store 订阅后刷新对应数据：
// - diagnosis:prescribed            —— 个性化处方生成完成，刷新处方数据
// - diagnosis:learning-path-generated —— AI 学习路径生成完成，刷新路径数据
// - grading:scored                  —— 多维度评分完成（刷新学生画像可能变化）
// - grading:ocr-completed           —— 手写识别完成（无直接关联数据，仅通知）
// ─────────────────────────────────────────────────────────────────────────────

businessEvents.on('diagnosis:prescribed', (event) => {
    const { studentId } = event.payload
    const state = useDiagnosisStore.getState()
    if (studentId && studentId === state.selectedStudentId) {
        void state.fetchPrescription()
    }
})

businessEvents.on('diagnosis:learning-path-generated', (event) => {
    const { studentId } = event.payload
    const state = useDiagnosisStore.getState()
    if (studentId && studentId === state.selectedStudentId) {
        void state.fetchAiLearningPath()
    }
})

businessEvents.on('grading:scored', () => {
    const state = useDiagnosisStore.getState()
    // 评分完成后刷新学生维度数据（掌握度可能变化）
    if (state.selectedStudentId) {
        debouncedRefreshDimension('student')
    }
})
