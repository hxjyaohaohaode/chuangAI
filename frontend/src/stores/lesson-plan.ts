/**
 * 教案工坊全局状态（Phase 3 —— 教师教学流程闭环 + 智能备课 5 大能力）
 *
 * 职责：
 * 1. 持有教案列表 / 当前教案 / 生成依据
 * 2. 编排"选择诗篇 → AI 生成教案 → 教师审阅 → 保存发布"完整备课流程
 * 3. 数据驱动备课：基于班级诊断数据（diagnosis store 的 dark-matter）生成针对性教案
 * 4. 业务事件联动：教案生成/保存后发射事件，通知 dashboard/classroom 刷新
 * 5. 智能备课 5 大能力：
 *    - 能力1：诗歌库智能检索（多维+全文+语义相似）
 *    - 能力2：教学目标智能生成（Bloom 六阶）
 *    - 能力3：分层教学设计（基础/提高/挑战层）
 *    - 能力4：教案 AI 生成与精修（max 思考模式 + SSE 流式 + 选段精修）
 *    - 能力5：资源调度（按相关度排序）
 *
 * 设计要点：
 * - 流程状态机：从列表选择 → 进入教案详情 → 可选 AI 生成 → 保存发布
 * - 五步式备课向导：选诗 → 目标 → 分层 → 教案 → 资源
 * - 数据闭环：生成教案时若提供 classId，会基于班级共性薄弱点强化教学环节
 * - 失败降级：AI 调用失败时 toast 提示，不空白
 * - 乐观更新 + 失败回滚：所有 mutations 遵循"先更新 UI → 失败回滚 + toast"
 * - 流式输出：教案生成/精修支持 SSE 流式，实时累积 streamingContent
 * - 业务事件：生成完成 emit 'lesson:generated' / 'lesson-plan:generated'
 *
 * 业务事件订阅方：
 * - dashboard store：订阅 lesson-plan:generated/saved，刷新"已备课"统计
 * - classroom store：订阅 lesson-plan:generated，提示教师可基于此教案开课
 * - notification store：订阅 lesson:generated，推送通知
 */

import { getDisplayError } from '@/lib/errors'
import { create } from 'zustand'
import { api } from '@/lib/api'
import { toast } from '@/stores/toast'
import { businessEvents } from '@/lib/business-events'
import type {
    LessonPlan,
    LessonPlanListItem,
    LessonPlanGenerateRequest,
    LessonPlanGenerateResponse,
    LessonPlanSaveResponse,
    LessonPlanListResponse,
    LessonPlanLoadingKey,
    // 智能备课 5 大能力类型
    PoemSearchQuery,
    PoemSearchResult,
    PoemDetail,
    ObjectiveGenerateRequest,
    ObjectiveGenerateResponse,
    LayeredDesignRequest,
    LayeredDesignResponse,
    LessonGenerateRequest,
    GeneratedLesson,
    LessonRefineRequest,
    LessonRefineResponse,
    LessonResourcesResponse,
    LessonStreamController,
    LessonStreamChunk,
    RefineStreamChunk,
    // SubTask 25.5/25.6：教案模板 + AI 流式生成类型
    LessonPlanTemplate,
    LessonPlanTemplateListResponse,
    LessonPlanTemplateFilter,
    LessonPlanTemplateSort,
    LessonPlanAIGenerateRequest,
    LessonAIGenerateStreamChunk,
    LessonAIGenerateStreamController,
} from '@/lib/types'

/** 教案生成/精修流式调用选项 */
export interface LessonStreamOptions {
    /** 是否启用流式输出（默认 true） */
    stream?: boolean
    /** 内容 chunk 回调（每段增量内容） */
    onChunk?: (content: string) => void
    /** 思考过程回调（reasoning_content 增量） */
    onReasoning?: (content: string) => void
}

/** 五步式备课向导步骤 */
export type WizardStep = 'select-poem' | 'objectives' | 'layered' | 'lesson' | 'resources'

interface LessonPlanState {
    // ── 教案列表 ──
    /** 教案列表（精简版，用于列表展示） */
    lessonPlanList: LessonPlanListItem[]
    /** 列表总数 */
    totalCount: number

    // ── 当前教案 ──
    /** 当前选中的教案 ID */
    currentLessonPlanId: string | null
    /** 当前教案完整内容 */
    currentLessonPlan: LessonPlan | null
    /** 生成依据（AI 生成时返回的班级学情数据摘要） */
    currentBasis: LessonPlanGenerateResponse['basis'] | null

    // ── 智能备课 5 大能力状态 ──
    /** 能力1：诗歌检索结果 */
    poemSearchResults: PoemSearchResult[]
    /** 能力1：检索结果总数 */
    poemSearchTotal: number
    /** 能力1：当前诗歌详情（含 AI 意象分析） */
    currentPoemDetail: PoemDetail | null
    /** 能力2：当前教学目标（Bloom 六阶） */
    currentObjectives: ObjectiveGenerateResponse | null
    /** 能力3：当前分层教学设计 */
    currentLayeredDesign: LayeredDesignResponse | null
    /** 能力4：当前 AI 生成的教案（深化版） */
    currentGeneratedLesson: GeneratedLesson | null
    /** 能力4：当前选段精修结果 */
    currentRefineResult: LessonRefineResponse | null
    /** 能力5：当前资源调度结果 */
    currentResources: LessonResourcesResponse | null

    // ── 流式输出状态 ──
    /** 流式输出累积的内容（教案生成/精修共用） */
    streamingContent: string
    /** 流式思考过程累积（reasoning_content） */
    streamingReasoning: string
    /** 是否正在流式输出 */
    isStreaming: boolean
    /** 当前流式控制器（用于中止） */
    currentStreamController: LessonStreamController | null

    // ── 五步式向导状态 ──
    /** 当前向导步骤 */
    wizardStep: WizardStep

    // ── SubTask 25.5：教案模板状态 ──
    /** 教案模板列表 */
    lessonPlanTemplates: LessonPlanTemplate[]
    /** 模板总数 */
    templateTotal: number
    /** 当前选中的模板 ID */
    currentTemplateId: string | null
    /** 当前选中的模板详情 */
    currentTemplate: LessonPlanTemplate | null
    /** 模板筛选条件（持久化，供 UI 回显） */
    templateFilter: LessonPlanTemplateFilter
    /** 模板排序方式（持久化，供 UI 回显） */
    templateSort: LessonPlanTemplateSort

    // ── SubTask 25.6：AI 流式生成状态 ──
    /** AI 生成流式累积的教案内容 */
    aiStreamingContent: string
    /** AI 生成流式累积的思考过程 */
    aiStreamingReasoning: string
    /** 是否正在 AI 流式生成 */
    isAIGenerating: boolean
    /** 当前 AI 流式控制器（用于中止） */
    currentAIStreamController: LessonAIGenerateStreamController | null
    /** AI 生成完成的教案（流式 done 帧返回的完整教案） */
    aiGeneratedLessonPlan: LessonPlan | null

    // ── 加载态与错误 ──
    loading: Partial<Record<LessonPlanLoadingKey, boolean>>
    error: string | null

    // ── 动作：教案列表与详情 ──
    /** 拉取教案列表 */
    fetchList: () => Promise<void>
    /** 拉取单个教案详情 */
    fetchLessonPlan: (lessonPlanId: string, poemId?: string) => Promise<void>
    /**
     * AI 生成教案（数据驱动备课，旧版端点，保留兼容）
     *
     * @param req 生成请求（poemId/gradeLevel/classId/includeReflection/lessonCount）
     * @returns 生成成功与否
     */
    generateLessonPlan: (req: LessonPlanGenerateRequest) => Promise<boolean>
    /** 保存教案（draft → published） */
    saveLessonPlan: () => Promise<boolean>
    /** 选择教案（从列表中选中一个，自动拉取详情） */
    selectLessonPlan: (lessonPlanId: string, poemId?: string) => Promise<void>
    /** 清空当前教案（返回列表视图） */
    clearCurrentLessonPlan: () => void
    /** 设置加载态 */
    setLoading: (key: LessonPlanLoadingKey, loading: boolean) => void

    // ── 动作：智能备课 5 大能力 ──
    /** 能力1：诗歌库智能检索（多维+全文+语义相似） */
    searchPoems: (query: PoemSearchQuery) => Promise<boolean>
    /** 能力1：获取诗歌详情（含 AI 意象分析/典故/文化背景） */
    fetchPoemDetail: (poemId: string) => Promise<boolean>
    /** 能力2：教学目标智能生成（Bloom 六阶） */
    generateObjectives: (req: ObjectiveGenerateRequest) => Promise<boolean>
    /** 能力3：分层教学设计（基础/提高/挑战层） */
    generateLayeredDesign: (req: LayeredDesignRequest) => Promise<boolean>
    /**
     * 能力4：教案 AI 生成（max 思考模式 + SSE 流式）
     * 乐观更新：流式开始时即设置 isStreaming，累积 streamingContent
     * 失败回滚：清除 streamingContent，toast 错误
     */
    generateLesson: (req: LessonGenerateRequest, options?: LessonStreamOptions) => Promise<boolean>
    /**
     * 能力4：教案选段精修（SSE 流式）
     * 乐观更新：流式开始时即设置 isStreaming，累积 streamingContent
     * 失败回滚：清除 streamingContent，toast 错误
     */
    refineLesson: (req: LessonRefineRequest, options?: LessonStreamOptions) => Promise<boolean>
    /** 能力5：资源调度（按相关度排序推荐资源） */
    getResources: (lessonId: string, poemId: string) => Promise<boolean>

    // ── 流式控制与向导 ──
    /** 中止当前流式输出 */
    abortStream: () => void
    /** 清空流式输出状态 */
    clearStreaming: () => void
    /** 设置向导步骤 */
    setWizardStep: (step: WizardStep) => void
    /** 清空向导状态（返回第一步） */
    resetWizard: () => void
    /** 清空所有智能备课状态 */
    clearWizardState: () => void

    // ── SubTask 25.5：教案模板动作 ──
    /** 拉取教案模板列表（支持筛选 + 排序） */
    fetchTemplates: (filter?: LessonPlanTemplateFilter, sort?: LessonPlanTemplateSort) => Promise<void>
    /** 选择模板（拉取详情） */
    selectTemplate: (templateId: string) => Promise<void>
    /** 设置模板筛选条件（持久化，不立即拉取） */
    setTemplateFilter: (filter: LessonPlanTemplateFilter) => void
    /** 设置模板排序方式（持久化，不立即拉取） */
    setTemplateSort: (sort: LessonPlanTemplateSort) => void
    /** 清空当前选中模板 */
    clearCurrentTemplate: () => void

    // ── SubTask 25.6：AI 流式生成动作 ──
    /**
     * AI 流式生成教案（基于 deepseek-v4-pro + SSE）
     *
     * 乐观更新策略：
     * - 流式开始时即设置 isAIGenerating，清空旧内容
     * - 累积 aiStreamingContent / aiStreamingReasoning
     * - done 帧到达时，写入 aiGeneratedLessonPlan
     * - 失败/中止：保留已生成内容，toast 提示
     *
     * @param req AI 生成请求
     * @param options 可选回调（onChunk/onReasoning/onDone/onError）
     * @returns 生成成功与否（done 帧到达为 true，否则 false）
     */
    aiGenerateLessonPlan: (
        req: LessonPlanAIGenerateRequest,
        options?: {
            onChunk?: (content: string) => void
            onReasoning?: (content: string) => void
            onDone?: (lessonPlan: LessonPlan) => void
            onError?: (err: Error) => void
        },
    ) => Promise<boolean>
    /** 中止 AI 流式生成 */
    abortAIGenerate: () => void
    /** 清空 AI 生成状态 */
    clearAIGenerate: () => void
}

/**
 * LessonPlan Zustand store
 *
 * 用法：
 *   const { lessonPlanList, fetchList } = useLessonPlanStore()
 *   await useLessonPlanStore.getState().generateLessonPlan({ poemId, gradeLevel })
 *   await useLessonPlanStore.getState().generateLesson(req, { stream: true, onChunk: (c) => ... })
 */
export const useLessonPlanStore = create<LessonPlanState>((set, get) => ({
    // ── 教案列表 ──
    lessonPlanList: [],
    totalCount: 0,

    // ── 当前教案 ──
    currentLessonPlanId: null,
    currentLessonPlan: null,
    currentBasis: null,

    // ── 智能备课 5 大能力状态 ──
    poemSearchResults: [],
    poemSearchTotal: 0,
    currentPoemDetail: null,
    currentObjectives: null,
    currentLayeredDesign: null,
    currentGeneratedLesson: null,
    currentRefineResult: null,
    currentResources: null,

    // ── 流式输出状态 ──
    streamingContent: '',
    streamingReasoning: '',
    isStreaming: false,
    currentStreamController: null,

    // ── 五步式向导状态 ──
    wizardStep: 'select-poem',

    // ── SubTask 25.5：教案模板状态 ──
    lessonPlanTemplates: [],
    templateTotal: 0,
    currentTemplateId: null,
    currentTemplate: null,
    templateFilter: {},
    templateSort: 'newest',

    // ── SubTask 25.6：AI 流式生成状态 ──
    aiStreamingContent: '',
    aiStreamingReasoning: '',
    isAIGenerating: false,
    currentAIStreamController: null,
    aiGeneratedLessonPlan: null,

    // ── 加载态与错误 ──
    loading: {},
    error: null,

    // ──────────────────────────────────────────────────────────
    // 教案列表与详情
    // ──────────────────────────────────────────────────────────

    fetchList: async () => {
        get().setLoading('list', true)
        set({ error: null })
        try {
            const res: LessonPlanListResponse = await api.lessonPlan.list()
            // 防御性校验：lessonPlans 可能为 undefined/null，降级为空数组；total 降级为 0
            set({
                lessonPlanList: Array.isArray(res.lessonPlans) ? res.lessonPlans : [],
                totalCount: typeof res.total === 'number' ? res.total : 0,
            })
        } catch (err) {
            const message = getDisplayError(err, '加载教案列表失败')
            set({ error: message })
            toast.error({ title: message })
        } finally {
            get().setLoading('list', false)
        }
    },

    fetchLessonPlan: async (lessonPlanId: string, poemId?: string) => {
        get().setLoading('detail', true)
        set({ error: null })
        try {
            const res: LessonPlan = await api.lessonPlan.get(lessonPlanId, poemId)
            set({
                currentLessonPlanId: res.id,
                currentLessonPlan: res,
                currentBasis: null, // 详情不携带 basis
            })
        } catch (err) {
            const message = getDisplayError(err, '加载教案详情失败')
            set({ error: message })
            toast.error({ title: message })
        } finally {
            get().setLoading('detail', false)
        }
    },

    generateLessonPlan: async (req: LessonPlanGenerateRequest) => {
        get().setLoading('generate', true)
        set({ error: null })
        try {
            const res: LessonPlanGenerateResponse = await api.lessonPlan.generate(req)
            set({
                currentLessonPlanId: res.lessonPlan.id,
                currentLessonPlan: res.lessonPlan,
                currentBasis: res.basis,
            })
            toast.success({ title: `已为《${res.lessonPlan.poemTitle}》生成教案` })

            // 发射业务事件：lesson-plan:generated
            // 订阅方：dashboard store（刷新"已备课"统计）、classroom store（提示可开课）
            businessEvents.emit('lesson-plan:generated', {
                lessonPlanId: res.lessonPlan.id,
                poemId: res.lessonPlan.poemId,
                classId: res.lessonPlan.classId ?? undefined,
                teacherName: res.lessonPlan.teacherName,
                weakBloomLevels: res.basis.weakBloomLevels,
                dataDriven: !!req.classId, // 若提供 classId，则视为数据驱动
            })

            return true
        } catch (err) {
            const message = getDisplayError(err, '生成教案失败')
            set({ error: message })
            toast.error({ title: message })
            return false
        } finally {
            get().setLoading('generate', false)
        }
    },

    saveLessonPlan: async () => {
        const { currentLessonPlan } = get()
        if (!currentLessonPlan) {
            toast.error({ title: '没有可保存的教案' })
            return false
        }
        get().setLoading('save', true)
        set({ error: null })
        try {
            const res: LessonPlanSaveResponse = await api.lessonPlan.save(currentLessonPlan)
            set({
                currentLessonPlan: res.lessonPlan,
            })
            toast.success({ title: `教案《${res.lessonPlan.title}》已保存` })

            // 发射业务事件：lesson-plan:saved
            // 订阅方：dashboard store（刷新"已备课"统计）
            businessEvents.emit('lesson-plan:saved', {
                lessonPlanId: res.lessonPlan.id,
                poemId: res.lessonPlan.poemId,
                status: res.lessonPlan.status,
                savedAt: Date.now(),
            })

            // 同步刷新列表（让列表反映最新的状态）
            void get().fetchList()

            return true
        } catch (err) {
            const message = getDisplayError(err, '保存教案失败')
            set({ error: message })
            toast.error({ title: message })
            return false
        } finally {
            get().setLoading('save', false)
        }
    },

    selectLessonPlan: async (lessonPlanId: string, poemId?: string) => {
        await get().fetchLessonPlan(lessonPlanId, poemId)
    },

    clearCurrentLessonPlan: () => {
        set({
            currentLessonPlanId: null,
            currentLessonPlan: null,
            currentBasis: null,
            error: null,
        })
    },

    setLoading: (key, loading) => {
        set((state) => ({
            loading: { ...state.loading, [key]: loading },
        }))
    },

    // ──────────────────────────────────────────────────────────
    // 智能备课 5 大能力
    // ──────────────────────────────────────────────────────────

    /**
     * 能力1：诗歌库智能检索
     *
     * 乐观更新策略：
     * - 检索开始时清空旧结果（避免用户看到陈旧数据）
     * - 成功：写入新结果
     * - 失败：恢复空结果 + toast 错误
     */
    searchPoems: async (query: PoemSearchQuery) => {
        get().setLoading('searchPoems', true)
        // 乐观更新：先清空旧结果，避免显示陈旧数据
        const prevResults = get().poemSearchResults
        const prevTotal = get().poemSearchTotal
        set({ error: null, poemSearchResults: [], poemSearchTotal: 0 })
        try {
            const res = await api.lessonPlan.searchPoems(query)
            set({
                poemSearchResults: Array.isArray(res.results) ? res.results : [],
                poemSearchTotal: typeof res.total === 'number' ? res.total : 0,
            })
            return true
        } catch (err) {
            // 失败回滚
            const message = getDisplayError(err, '诗歌检索失败')
            set({
                error: message,
                poemSearchResults: prevResults,
                poemSearchTotal: prevTotal,
            })
            toast.error({ title: message })
            return false
        } finally {
            get().setLoading('searchPoems', false)
        }
    },

    /**
     * 能力1：获取诗歌详情（含 AI 意象分析/典故/文化背景）
     */
    fetchPoemDetail: async (poemId: string) => {
        get().setLoading('poemDetail', true)
        const prevDetail = get().currentPoemDetail
        // 乐观更新：先清空，避免显示旧诗的详情
        set({ error: null, currentPoemDetail: null })
        try {
            const res = await api.lessonPlan.getPoemDetail(poemId)
            set({ currentPoemDetail: res })
            return true
        } catch (err) {
            // 失败回滚
            const message = getDisplayError(err, '获取诗歌详情失败')
            set({ error: message, currentPoemDetail: prevDetail })
            toast.error({ title: message })
            return false
        } finally {
            get().setLoading('poemDetail', false)
        }
    },

    /**
     * 能力2：教学目标智能生成（Bloom 六阶）
     *
     * 乐观更新策略：
     * - 生成开始时保留旧目标（教师可对比）
     * - 成功：写入新目标
     * - 失败：保留旧目标 + toast 错误
     */
    generateObjectives: async (req: ObjectiveGenerateRequest) => {
        get().setLoading('objectives', true)
        set({ error: null })
        try {
            const res = await api.lessonPlan.generateObjectives(req)
            set({ currentObjectives: res })
            toast.success({ title: `已生成 ${res.objectives.length} 个教学目标` })
            return true
        } catch (err) {
            const message = getDisplayError(err, '生成教学目标失败')
            set({ error: message })
            toast.error({ title: message })
            return false
        } finally {
            get().setLoading('objectives', false)
        }
    },

    /**
     * 能力3：分层教学设计（基础/提高/挑战层）
     */
    generateLayeredDesign: async (req: LayeredDesignRequest) => {
        get().setLoading('layeredDesign', true)
        set({ error: null })
        try {
            const res = await api.lessonPlan.generateLayeredDesign(req)
            set({ currentLayeredDesign: res })
            toast.success({ title: '已生成三层分层教学设计' })
            return true
        } catch (err) {
            const message = getDisplayError(err, '生成分层教学设计失败')
            set({ error: message })
            toast.error({ title: message })
            return false
        } finally {
            get().setLoading('layeredDesign', false)
        }
    },

    /**
     * 能力4：教案 AI 生成（max 思考模式 + SSE 流式）
     *
     * 流式模式（默认）：
     * - 调用 streamGenerateLesson，实时累积 streamingContent/streamingReasoning
     * - onChunk 回调通知调用方增量内容
     * - done 时设置 currentGeneratedLesson
     * - 发射 'lesson:generated' 业务事件
     *
     * 非流式模式：
     * - 调用 generateLesson，直接获取完整教案
     *
     * 失败回滚：
     * - 清除 streamingContent
     * - 保留旧 currentGeneratedLesson
     * - toast 错误
     */
    generateLesson: async (req: LessonGenerateRequest, options?: LessonStreamOptions) => {
        const useStream = options?.stream !== false // 默认流式

        // 中止已有流式输出
        get().abortStream()

        get().setLoading('lessonGenerate', true)
        set({
            error: null,
            streamingContent: '',
            streamingReasoning: '',
            isStreaming: useStream,
        })

        try {
            if (useStream) {
                // ── 流式模式 ──
                return await new Promise<boolean>((resolve) => {
                    const controller = api.lessonPlan.streamGenerateLesson(req, {
                        onChunk: (chunk: LessonStreamChunk) => {
                            const state = get()
                            if (chunk.type === 'chunk') {
                                // 累积内容
                                set({ streamingContent: state.streamingContent + chunk.content })
                                options?.onChunk?.(chunk.content)
                            } else if (chunk.type === 'reasoning') {
                                // 累积思考过程
                                set({ streamingReasoning: state.streamingReasoning + chunk.content })
                                options?.onReasoning?.(chunk.content)
                            } else if (chunk.type === 'done') {
                                // 流式完成：设置最终教案
                                set({
                                    currentGeneratedLesson: chunk.lesson,
                                    isStreaming: false,
                                    currentStreamController: null,
                                })
                                toast.success({ title: `已为《${chunk.lesson.poemTitle}》生成教案` })

                                // 发射业务事件：lesson:generated（智能备课深化版）
                                // 注意：此处不发射 lesson-plan:generated，因为该事件要求 lessonPlanId（必填），
                                // 而 AI 生成的教案尚未保存到数据库，没有教案 ID。
                                // lesson-plan:generated 将在 saveLessonPlan 成功后由旧流程发射。
                                businessEvents.emit('lesson:generated', {
                                    poemId: chunk.lesson.poemId,
                                    poemTitle: chunk.lesson.poemTitle,
                                    lessonCount: chunk.lesson.lessonCount,
                                    totalDurationMin: chunk.lesson.totalDurationMin,
                                    aiGenerated: chunk.lesson.aiGenerated,
                                    generatedAt: chunk.lesson.generatedAt,
                                })

                                get().setLoading('lessonGenerate', false)
                                resolve(true)
                            } else if (chunk.type === 'aborted') {
                                // 用户中止
                                set({
                                    isStreaming: false,
                                    currentStreamController: null,
                                })
                                get().setLoading('lessonGenerate', false)
                                toast.info({ title: '已中止教案生成' })
                                resolve(false)
                            }
                        },
                        onError: (err: Error) => {
                            // 失败回滚：清除流式内容，保留旧教案
                            const message = getDisplayError(err, '生成教案失败')
                            set({
                                error: message,
                                streamingContent: '',
                                streamingReasoning: '',
                                isStreaming: false,
                                currentStreamController: null,
                            })
                            toast.error({ title: message })
                            get().setLoading('lessonGenerate', false)
                            resolve(false)
                        },
                    })
                    set({ currentStreamController: controller })
                })
            } else {
                // ── 非流式模式 ──
                const res = await api.lessonPlan.generateLesson(req)
                set({ currentGeneratedLesson: res.lesson })
                toast.success({ title: `已为《${res.lesson.poemTitle}》生成教案` })

                // 发射业务事件
                businessEvents.emit('lesson:generated', {
                    poemId: res.lesson.poemId,
                    poemTitle: res.lesson.poemTitle,
                    lessonCount: res.lesson.lessonCount,
                    totalDurationMin: res.lesson.totalDurationMin,
                    aiGenerated: res.lesson.aiGenerated,
                    generatedAt: res.lesson.generatedAt,
                })

                return true
            }
        } catch (err) {
            // 失败回滚
            const message = getDisplayError(err, '生成教案失败')
            set({
                error: message,
                streamingContent: '',
                streamingReasoning: '',
                isStreaming: false,
                currentStreamController: null,
            })
            toast.error({ title: message })
            return false
        } finally {
            // 仅在非流式模式下清除 loading（流式模式在 Promise 内已清除）
            if (!useStream) {
                get().setLoading('lessonGenerate', false)
            }
        }
    },

    /**
     * 能力4：教案选段精修（SSE 流式）
     *
     * 流式模式（默认）：
     * - 调用 streamRefineLesson，实时累积 streamingContent
     * - done 时设置 currentRefineResult
     *
     * 失败回滚：
     * - 清除 streamingContent
     * - 保留旧 currentRefineResult
     * - toast 错误
     */
    refineLesson: async (req: LessonRefineRequest, options?: LessonStreamOptions) => {
        const useStream = options?.stream !== false

        // 中止已有流式输出
        get().abortStream()

        get().setLoading('lessonRefine', true)
        set({
            error: null,
            streamingContent: '',
            streamingReasoning: '',
            isStreaming: useStream,
        })

        try {
            if (useStream) {
                // ── 流式模式 ──
                return await new Promise<boolean>((resolve) => {
                    const controller = api.lessonPlan.streamRefineLesson(req, {
                        onChunk: (chunk: RefineStreamChunk) => {
                            const state = get()
                            if (chunk.type === 'chunk') {
                                set({ streamingContent: state.streamingContent + chunk.content })
                                options?.onChunk?.(chunk.content)
                            } else if (chunk.type === 'reasoning') {
                                set({ streamingReasoning: state.streamingReasoning + chunk.content })
                                options?.onReasoning?.(chunk.content)
                            } else if (chunk.type === 'done') {
                                // 精修完成
                                set({
                                    currentRefineResult: {
                                        refinedContent: chunk.refinedContent,
                                        changeSummary: chunk.changeSummary,
                                        aiGenerated: true,
                                    },
                                    isStreaming: false,
                                    currentStreamController: null,
                                })
                                toast.success({ title: '段落精修完成' })

                                // 发射业务事件：lesson:refined
                                businessEvents.emit('lesson:refined', {
                                    lessonId: req.lessonId,
                                    targetSection: req.targetSection,
                                    changeSummary: chunk.changeSummary,
                                })

                                get().setLoading('lessonRefine', false)
                                resolve(true)
                            } else if (chunk.type === 'aborted') {
                                set({
                                    isStreaming: false,
                                    currentStreamController: null,
                                })
                                get().setLoading('lessonRefine', false)
                                toast.info({ title: '已中止精修' })
                                resolve(false)
                            }
                        },
                        onError: (err: Error) => {
                            const message = getDisplayError(err, '精修教案失败')
                            set({
                                error: message,
                                streamingContent: '',
                                streamingReasoning: '',
                                isStreaming: false,
                                currentStreamController: null,
                            })
                            toast.error({ title: message })
                            get().setLoading('lessonRefine', false)
                            resolve(false)
                        },
                    })
                    set({ currentStreamController: controller })
                })
            } else {
                // ── 非流式模式 ──
                const res = await api.lessonPlan.refineLesson(req)
                set({ currentRefineResult: res })
                toast.success({ title: '段落精修完成' })

                businessEvents.emit('lesson:refined', {
                    lessonId: req.lessonId,
                    targetSection: req.targetSection,
                    changeSummary: res.changeSummary,
                })

                return true
            }
        } catch (err) {
            const message = getDisplayError(err, '精修教案失败')
            set({
                error: message,
                streamingContent: '',
                streamingReasoning: '',
                isStreaming: false,
                currentStreamController: null,
            })
            toast.error({ title: message })
            return false
        } finally {
            if (!useStream) {
                get().setLoading('lessonRefine', false)
            }
        }
    },

    /**
     * 能力5：资源调度（按相关度排序推荐资源）
     */
    getResources: async (lessonId: string, poemId: string) => {
        get().setLoading('resources', true)
        const prevResources = get().currentResources
        set({ error: null, currentResources: null })
        try {
            const res = await api.lessonPlan.getResources(lessonId, poemId)
            set({ currentResources: res })
            toast.success({ title: `已推荐 ${res.resources.length} 个相关资源` })
            return true
        } catch (err) {
            // 失败回滚
            const message = getDisplayError(err, '获取资源推荐失败')
            set({ error: message, currentResources: prevResources })
            toast.error({ title: message })
            return false
        } finally {
            get().setLoading('resources', false)
        }
    },

    // ──────────────────────────────────────────────────────────
    // 流式控制与向导
    // ──────────────────────────────────────────────────────────

    /** 中止当前流式输出 */
    abortStream: () => {
        const controller = get().currentStreamController
        if (controller && controller.streaming) {
            controller.abort()
        }
        set({
            isStreaming: false,
            currentStreamController: null,
        })
    },

    /** 清空流式输出状态 */
    clearStreaming: () => {
        get().abortStream()
        set({
            streamingContent: '',
            streamingReasoning: '',
        })
    },

    /** 设置向导步骤 */
    setWizardStep: (step: WizardStep) => {
        set({ wizardStep: step })
    },

    /** 清空向导状态（返回第一步） */
    resetWizard: () => {
        get().abortStream()
        set({
            wizardStep: 'select-poem',
            poemSearchResults: [],
            poemSearchTotal: 0,
            currentPoemDetail: null,
            currentObjectives: null,
            currentLayeredDesign: null,
            currentGeneratedLesson: null,
            currentRefineResult: null,
            currentResources: null,
            streamingContent: '',
            streamingReasoning: '',
            isStreaming: false,
            currentStreamController: null,
            error: null,
        })
    },

    /** 清空所有智能备课状态（保留教案列表） */
    clearWizardState: () => {
        get().abortStream()
        set({
            poemSearchResults: [],
            poemSearchTotal: 0,
            currentPoemDetail: null,
            currentObjectives: null,
            currentLayeredDesign: null,
            currentGeneratedLesson: null,
            currentRefineResult: null,
            currentResources: null,
            streamingContent: '',
            streamingReasoning: '',
            isStreaming: false,
            currentStreamController: null,
            wizardStep: 'select-poem',
            error: null,
        })
    },

    // ──────────────────────────────────────────────────────────
    // SubTask 25.5：教案模板动作
    // ──────────────────────────────────────────────────────────

    /**
     * 拉取教案模板列表（支持筛选 + 排序）
     *
     * 策略：
     * - 调用 api.lessonPlan.templates
     * - 持久化 filter / sort（供 UI 回显）
     * - 失败：toast 错误，保留旧列表
     */
    fetchTemplates: async (filter?: LessonPlanTemplateFilter, sort?: LessonPlanTemplateSort) => {
        get().setLoading('templates', true)
        const nextFilter = filter ?? get().templateFilter
        const nextSort = sort ?? get().templateSort
        set({ error: null, templateFilter: nextFilter, templateSort: nextSort })
        try {
            const res: LessonPlanTemplateListResponse = await api.lessonPlan.templates(nextFilter, nextSort)
            set({
                lessonPlanTemplates: Array.isArray(res.templates) ? res.templates : [],
                templateTotal: typeof res.total === 'number' ? res.total : 0,
            })
        } catch (err) {
            const message = getDisplayError(err, '加载教案模板失败')
            set({ error: message })
            toast.error({ title: message })
        } finally {
            get().setLoading('templates', false)
        }
    },

    /** 选择模板（拉取详情） */
    selectTemplate: async (templateId: string) => {
        // 优先从本地列表中查找（避免不必要的网络请求）
        const local = get().lessonPlanTemplates.find((t) => t.id === templateId)
        if (local) {
            set({ currentTemplateId: templateId, currentTemplate: local })
            return
        }
        get().setLoading('templates', true)
        set({ error: null })
        try {
            const res = await api.lessonPlan.getTemplate(templateId)
            set({ currentTemplateId: templateId, currentTemplate: res })
        } catch (err) {
            const message = getDisplayError(err, '加载模板详情失败')
            set({ error: message })
            toast.error({ title: message })
        } finally {
            get().setLoading('templates', false)
        }
    },

    /** 设置模板筛选条件（持久化，不立即拉取） */
    setTemplateFilter: (filter: LessonPlanTemplateFilter) => {
        set({ templateFilter: filter })
    },

    /** 设置模板排序方式（持久化，不立即拉取） */
    setTemplateSort: (sort: LessonPlanTemplateSort) => {
        set({ templateSort: sort })
    },

    /** 清空当前选中模板 */
    clearCurrentTemplate: () => {
        set({ currentTemplateId: null, currentTemplate: null })
    },

    // ──────────────────────────────────────────────────────────
    // SubTask 25.6：AI 流式生成教案动作
    // ──────────────────────────────────────────────────────────

    /**
     * AI 流式生成教案（基于 deepseek-v4-pro + SSE）
     *
     * 乐观更新策略：
     * - 流式开始时即设置 isAIGenerating，清空旧内容和教案
     * - 累积 aiStreamingContent / aiStreamingReasoning
     * - done 帧到达时，写入 aiGeneratedLessonPlan，并同步到 currentLessonPlan
     * - 失败/中止：保留已生成内容，toast 提示
     *
     * 返回值：done 帧到达为 true，否则 false
     */
    aiGenerateLessonPlan: async (req, options) => {
        // 若正在生成，先中止旧的
        if (get().isAIGenerating) {
            get().abortAIGenerate()
        }

        get().setLoading('aiGenerate', true)
        set({
            error: null,
            isAIGenerating: true,
            aiStreamingContent: '',
            aiStreamingReasoning: '',
            aiGeneratedLessonPlan: null,
        })

        return new Promise<boolean>((resolve) => {
            let succeeded = false

            const controller = api.lessonPlan.streamAIGenerateLessonPlan(req, {
                onChunk: (chunk: LessonAIGenerateStreamChunk) => {
                    switch (chunk.type) {
                        case 'reasoning': {
                            set((s) => ({ aiStreamingReasoning: s.aiStreamingReasoning + chunk.content }))
                            options?.onReasoning?.(chunk.content)
                            break
                        }
                        case 'chunk': {
                            set((s) => ({ aiStreamingContent: s.aiStreamingContent + chunk.content }))
                            options?.onChunk?.(chunk.content)
                            break
                        }
                        case 'done': {
                            succeeded = true
                            set({
                                aiGeneratedLessonPlan: chunk.lessonPlan,
                                currentLessonPlan: chunk.lessonPlan,
                                currentLessonPlanId: chunk.lessonPlan.id,
                            })
                            options?.onDone?.(chunk.lessonPlan)
                            break
                        }
                        case 'aborted': {
                            // 中止不算成功
                            break
                        }
                    }
                },
                onError: (err: Error) => {
                    const message = getDisplayError(err, 'AI 生成教案失败')
                    set({ error: message })
                    toast.error({ title: message })
                    options?.onError?.(err)
                },
            })

            set({ currentAIStreamController: controller })

            // 轮询检测流式结束（streaming === false）
            // 由于 streamAIGenerateLessonPlan 不提供 onDone 回调（chunks 中已含 done 帧），
            // 此处通过 polling 检测 controller.streaming 来 resolve Promise
            const poll = () => {
                if (!controller.streaming) {
                    set({
                        isAIGenerating: false,
                        currentAIStreamController: null,
                    })
                    get().setLoading('aiGenerate', false)
                    if (succeeded) {
                        toast.success({ title: 'AI 教案已生成' })
                        // 发射业务事件
                        businessEvents.emit('lesson-plan:generated', {
                            lessonPlanId: get().aiGeneratedLessonPlan?.id ?? '',
                            poemId: get().aiGeneratedLessonPlan?.poemId ?? '',
                            classId: req.classId,
                            dataDriven: !!req.classId,
                        })
                    }
                    resolve(succeeded)
                } else {
                    setTimeout(poll, 80)
                }
            }
            // 延迟启动 polling，确保 controller 已开始
            setTimeout(poll, 100)
        })
    },

    /** 中止 AI 流式生成 */
    abortAIGenerate: () => {
        const controller = get().currentAIStreamController
        if (controller && controller.streaming) {
            controller.abort()
        }
        set({
            isAIGenerating: false,
            currentAIStreamController: null,
        })
        get().setLoading('aiGenerate', false)
    },

    /** 清空 AI 生成状态 */
    clearAIGenerate: () => {
        get().abortAIGenerate()
        set({
            aiStreamingContent: '',
            aiStreamingReasoning: '',
            isAIGenerating: false,
            currentAIStreamController: null,
            aiGeneratedLessonPlan: null,
        })
    },
}))

// ─────────────────────────────────────────────────────────────────────────────
// 闭环1（教学闭环）补全：订阅 report:generated / classroom:ended / diagnosis:updated
//
// 断点修复：lesson-plan store 此前仅单向 emit 业务事件，未订阅任何事件。
// 导致课堂结束/报告生成/诊断数据更新后，教案的"生成依据"（basis）不会自动刷新，
// 教师再生成教案时仍使用陈旧的 mastery 数据，无法反映最新诊断结论。
//
// 闭环链路：LessonPlan → Classroom → ClassroomReport → Diagnosis → (此处订阅) → LessonPlan
// - report:generated (reportType=classroom)    → 刷新当前教案的 basis（若 lessonId 匹配）
// - classroom:ended                            → 标记当前教案关联班级的 basis 待刷新
// - diagnosis:updated (scope=class)            → 班级诊断变化时刷新 basis
//
// 设计要点：
// - 仅当 currentLessonPlan 携带 classId 且与事件 classId 一致时刷新
// - 使用 debounce 1500ms 避免短时间内多次事件触发重复请求
// - 仅刷新 currentBasis（轻量端点），不重新生成教案
// ─────────────────────────────────────────────────────────────────────────────

let basisRefreshTimer: number | null = null

function debouncedRefreshBasis(): void {
    if (basisRefreshTimer !== null) {
        window.clearTimeout(basisRefreshTimer)
    }
    basisRefreshTimer = window.setTimeout(() => {
        const state = useLessonPlanStore.getState()
        // 仅当当前教案关联班级时刷新 basis
        const classId = state.currentLessonPlan?.classId
        const poemId = state.currentLessonPlan?.poemId
        if (!classId || !poemId) {
            basisRefreshTimer = null
            return
        }
        // 重新拉取教案以获取最新的 basis（后端 computeBasis 会读取最新 mastery + 暗物质）
        void state.fetchLessonPlan(state.currentLessonPlanId ?? '', poemId)
        basisRefreshTimer = null
    }, 1500)
}

// 课堂结束 → 班级 mastery 已变化，刷新 basis
businessEvents.on('classroom:ended', (event) => {
    const state = useLessonPlanStore.getState()
    const currentClassId = state.currentLessonPlan?.classId
    if (!currentClassId) return
    // 事件 classId 缺省（全班）或与当前教案班级一致时刷新
    if (!event.payload.classId || event.payload.classId === currentClassId) {
        debouncedRefreshBasis()
    }
})

// 课堂报告生成 → basis 可能包含报告数据，刷新
businessEvents.on('report:generated', (event) => {
    const state = useLessonPlanStore.getState()
    const currentClassId = state.currentLessonPlan?.classId
    if (!currentClassId) return
    // 仅课堂报告与班级诊断报告影响教案 basis
    if (event.payload.reportType !== 'classroom' && event.payload.reportType !== 'class-diagnosis') return
    if (!event.payload.classId || event.payload.classId === currentClassId) {
        debouncedRefreshBasis()
    }
})

// 班级诊断更新 → basis 中的薄弱层级可能变化
businessEvents.on('diagnosis:updated', (event) => {
    const state = useLessonPlanStore.getState()
    const currentClassId = state.currentLessonPlan?.classId
    if (!currentClassId) return
    if (event.payload.scope !== 'class') return
    if (!event.payload.classId || event.payload.classId === currentClassId) {
        debouncedRefreshBasis()
    }
})
