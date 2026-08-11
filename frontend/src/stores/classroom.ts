/**
 * 课堂导播台全局状态（Task 11 —— 实时数据同步）
 *
 * 职责：
 * 1. 持有课堂运行时状态：lessonId / mode / 当前题目 / 学生作答 / 启发提示 / 讨论题
 * 2. 管理 WebSocket 连接状态与课堂事件流（classroom:* 系列）
 * 3. 提供异步动作：start / refreshStatus / next / submit / pushHint / pushDiscuss / end
 * 4. 维护 AI 副驾消息历史（诗心 / 诗笔 Agent 输出）
 * 5. 持有课堂协奏报告（end 后填充）
 *
 * 设计要点（规范第 12 章 —— 实时数据同步）：
 * - 同页面组件数据变更即时同步（≤50ms，Zustand 同步更新）
 * - WebSocket 事件触发响应式更新，不重新拉取全部数据
 * - 加载失败时降级保留旧状态，不空白
 * - 乐观更新：submit 后立即在 responses 中追加，后台确认失败再回滚
 *
 * 性能：
 * - 高频 WS 事件（classroom:response / classroom:cognitive）直接更新 state，不 debounce
 * - 低频 WS 事件（classroom:next / classroom:end）触发局部刷新
 */

import { getDisplayError } from '@/lib/errors'
import { create } from 'zustand'
import { api } from '@/lib/api'
import { toast } from '@/stores/toast'
import { useNotificationStore } from '@/stores/notifications'
import { businessEvents } from '@/lib/business-events'
import { useWorkbenchStore } from '@/stores/workbench'
import type {
    ClassroomMode,
    ClassroomStatus,
    ClassroomQuestion,
    StudentResponse,
    HintRecord,
    DiscussionRecord,
    ClassroomReport,
    StartClassroomResponse,
    WSStatus,
    WSEvent,
    ClassroomWSPayload,
    AIOpponentState,
    AIOpponentLevel,
    AIOpponentAnswerRequest,
    AIOpponentAnswerResult,
    SmartScoreRequest,
    SmartScoreResult,
    ClassroomCommentChunk,
    PoemRelaySession,
    PoemRelayLine,
    QuestSnapshot,
    LevelClearedEvent,
} from '@/lib/types'
import { CLASSROOM_MODE_LABELS, AI_OPPONENT_LEVEL_LABELS } from '@/lib/types'
import { appendBoundedHistory } from '@/lib/bounded-history'

/**
 * 共舞/作答的完整事实记录由后端课堂事件与报告保存；前端副驾面板只保留
 * 最近 120 条，避免数小时课堂持续增加 React 状态和 Markdown/滚动成本。
 */
const MAX_LIVE_AI_MESSAGES = 120

/** 空状态初始值，避免 undefined */
const EMPTY_STATUS: ClassroomStatus = {
    lessonId: '',
    mode: 'collective-race',
    currentQuestionIndex: 0,
    totalQuestions: 0,
    currentQuestion: undefined,
    activeStudents: 0,
    responses: [],
    classMood: 'focused',
    cognitiveLoad: 20,
    engagement: 50,
    hintsDelivered: 0,
    joinCode: '',
    flyingFlowerKeyword: undefined,
    aiGenerated: true,
}

/**
 * 大转盘完成定时器由 store 持有，而不是交给页面组件持有。
 * 这样路由卸载调用 resetWheel 时可以真正取消尚未完成的旋转。
 */
let wheelSpinTimer: number | null = null
let wheelSpinGeneration = 0

function cancelWheelSpinTimer(): void {
    if (wheelSpinTimer !== null) {
        window.clearTimeout(wheelSpinTimer)
        wheelSpinTimer = null
    }
}

/** AI 副驾消息角色 */
export type AIAssistantRole = 'brush.grade' | 'brush.creative' | 'mind.diagnose' | 'brush.report'

/**
 * 开课失败的反馈归属。
 *
 * store 默认仍以 Toast 服务未拥有页面上下文的调用方；开课页已经渲染具名、
 * 可持续读取且包含安全重试的错误区时，可显式选择 inline，避免同一失败被
 * 两个独立 live region 重复播报。
 */
export type ClassroomStartFailureFeedback = 'toast' | 'inline'

/** AI 副驾消息记录 */
export interface AIAssistantMessage {
    id: string
    role: AIAssistantRole
    /** 消息类型：批改反馈 / 启发提示 / 讨论题 / 报告片段 */
    kind: 'feedback' | 'hint' | 'discussion' | 'report'
    /** 消息文本内容 */
    content: string
    /** 关联题目 ID */
    questionId?: string
    /** 关联学生 ID */
    studentId?: string
    /** 时间戳 */
    at: number
    /** AI 生成标记 */
    aiGenerated: boolean
}

/** 课堂 store 状态 */
interface ClassroomState {
    // ── 课堂运行时 ──
    /** 课堂 ID */
    lessonId: string
    /** 加入码 */
    joinCode: string
    /** 课堂模式 */
    mode: ClassroomMode
    /** 课堂是否已开始 */
    started: boolean
    /** 课堂是否已结束 */
    ended: boolean
    /** 课堂实时状态（轮询 / WS 更新） */
    status: ClassroomStatus
    /**
     * 闯关状态（关卡 / 诗力值 / 三榜）
     *
     * 七个模式共用这一份：切模式不清零，HUD 也只认它。
     * 由服务端算好后整份下发，前端不再自行推算分数与名次——
     * 各模式各算一遍必然算出不一致的结果。
     */
    quest: QuestSnapshot | null
    /** 最近一次通关事件，用于播放通关动画后即清空 */
    lastLevelCleared: LevelClearedEvent | null

    // ── 题目与作答 ──
    /** 当前题目 */
    currentQuestion: ClassroomQuestion | undefined
    /** 当前题目的学生作答列表 */
    responses: StudentResponse[]
    /** 启发提示历史 */
    hints: HintRecord[]
    /** 讨论题历史 */
    discussions: DiscussionRecord[]

    // ── AI 副驾 ──
    /** AI 副驾消息流（按时间顺序） */
    aiMessages: AIAssistantMessage[]

    // ── v5.0 Task 18-20：AI 虚拟对手 + 智能赋分 + 新模式状态 ──
    /** AI 虚拟对手（陪练角色） */
    aiOpponent: AIOpponentState
    /** 智能赋分累积记录（按时间顺序） */
    scoreEntries: SmartScoreResult[]
    /** 当前 AI 点评是否流式输出中 */
    commentStreaming: boolean
    /** 当前 AI 点评累积文本（流式拼接） */
    commentText: string
    /** 接龙会话（poem-relay 模式专用） */
    poemRelay: PoemRelaySession | null
    /** 大转盘当前角度（poem-wheel 模式专用，0-360） */
    wheelAngle: number
    /** 大转盘是否正在旋转 */
    wheelSpinning: boolean
    /** 大转盘最近命中的题目索引 */
    wheelSelectedIndex: number | null
    /** 拼图模式当前关卡 ID（imagery-puzzle 模式专用） */
    puzzleLevel: number
    /** 拼图模式 4 选 1 选项（每次生成 4 个候选诗篇） */
    puzzleOptions: Array<{ id: string; title: string; poet: string; imageUrl: string }>

    // ── 课堂报告 ──
    /** 课堂协奏报告（end 后填充） */
    report: ClassroomReport | null

    // ── 连接状态 ──
    /** WebSocket 连接状态 */
    wsStatus: WSStatus
    /** 最后一次 WS 事件时间戳 */
    lastEventAt: number | null

    // ── 加载态 ──
    /** 开始课堂加载中 */
    starting: boolean
    /** 切换下一题加载中 */
    advancing: boolean
    /** 推送提示加载中 */
    pushingHint: boolean
    /** 推送讨论题加载中 */
    pushingDiscuss: boolean
    /** 结束课堂加载中 */
    ending: boolean
    /** 同步状态加载中 */
    refreshing: boolean
    /** AI 虚拟对手作答中 */
    aiOpponentThinking: boolean
    /** 智能赋分进行中 */
    scoring: boolean
    /** 错误信息 */
    error: string | null

    // ── 动作 ──
    /** 开始课堂；页面已提供持久失败区时传入 inline，其他调用默认 Toast。 */
    start: (
        classId: string,
        poemId: string,
        mode: ClassroomMode,
        questionIds?: string[],
        failureFeedback?: ClassroomStartFailureFeedback,
    ) => Promise<string | null>
    /** 通过 lessonId 加载课堂状态 */
    loadByLessonId: (lessonId: string) => Promise<void>
    /** 通过加入码加入课堂（学生端） */
    joinByCode: (joinCode: string) => Promise<string | null>
    /** 刷新课堂状态 */
    refreshStatus: () => Promise<void>
    /** 进入下一题 */
    next: () => Promise<void>
    /** 提交答案 */
    submit: (studentId: string, answer: string, studentName?: string, latencyMs?: number) => Promise<boolean>
    /** 推送启发提示 */
    pushHint: (type?: 'nudge' | 'scaffold' | 'reframe') => Promise<void>
    /** 推送讨论题 */
    pushDiscuss: (angle?: 'cultural' | 'comparative' | 'creative') => Promise<void>
    /** 课堂指挥深化：切换课堂模式（乐观更新 + 业务事件） */
    switchMode: (newMode: ClassroomMode) => Promise<boolean>
    /** 结束课堂并生成报告 */
    end: () => Promise<void>
    /** 拉取历史课堂报告（GET /report，支持已结束课堂） */
    loadReport: (lessonId: string) => Promise<boolean>
    /** 处理 WS 事件 */
    handleWSEvent: (event: WSEvent) => void
    /** 设置 WS 连接状态 */
    setWsStatus: (status: WSStatus) => void
    /** 重置 store（退出课堂） */
    reset: () => void

    // ── v5.0 Task 18-20：AI 虚拟对手 / 智能赋分 / AI 点评 动作 ──
    /** 启用 / 禁用 AI 虚拟对手 */
    setAIOpponentEnabled: (enabled: boolean) => void
    /** 设置 AI 虚拟对手难度 */
    setAIOpponentLevel: (level: AIOpponentLevel) => void
    /** 重置 AI 虚拟对手（清零分数与统计） */
    resetAIOpponent: () => void
    /** 触发 AI 虚拟对手作答（调用 deepseek-v4-pro） */
    triggerAIOpponent: (req: AIOpponentAnswerRequest) => Promise<AIOpponentAnswerResult | null>
    /** 智能赋分（学生作答后调用，0-100 + 个性化反馈） */
    scoreAnswer: (req: SmartScoreRequest) => Promise<SmartScoreResult | null>
    /** 启动 AI 实时点评（SSE 流式） */
    streamComment: (
        req: { studentId: string; answer: string; questionId?: string; commentType?: 'praise' | 'guide' | 'challenge' | 'correct' },
        callbacks?: { onDone?: () => void; onError?: (err: Error) => void },
    ) => { abort: () => void; streaming: boolean }
    /** 中断 AI 点评 */
    abortComment: () => void
    /** 接龙：学生提交下一句 */
    submitRelayLine: (line: string, studentId: string, studentName?: string) => Promise<boolean>
    /** 接龙：AI 接下一句（基于上句调用 AI 虚拟对手） */
    aiRelayContinue: (studentId?: string) => Promise<boolean>
    /** 大转盘：旋转到随机角度 */
    spinWheel: () => void
    /** 大转盘：根据当前角度计算命中索引 */
    setWheelSelected: (index: number | null) => void
    /** 大转盘：重置 */
    resetWheel: () => void
    /** 拼图：加载关卡 */
    loadPuzzleLevel: (level: number) => void
    /** 拼图：设置候选诗篇选项 */
    setPuzzleOptions: (opts: Array<{ id: string; title: string; poet: string; imageUrl: string }>) => void
}

/** 内部 ID 生成器（用于 AI 消息） */
let messageCounter = 0
function nextMessageId(): string {
    messageCounter += 1
    return `ai-msg-${Date.now()}-${messageCounter}`
}

/** 默认 AI 虚拟对手（初始禁用，启用时按 easy 难度起步） */
const DEFAULT_AI_OPPONENT: AIOpponentState = {
    name: '诗仙 AI',
    level: 'medium',
    score: 0,
    correctCount: 0,
    totalCount: 0,
    avgLatencyMs: 0,
    enabled: false,
}

/** 默认接龙会话（空，未启动） */
const EMPTY_RELAY: PoemRelaySession | null = null

/**
 * AI 点评 SSE 控制器引用
 * 用作 store 之外的"逃逸舱"，避免将其放入响应式 state 触发无谓渲染
 */
const commentControllerRef: { controller: { abort: () => void; streaming: boolean } | null } = {
    controller: null,
}

/**
 * Classroom Zustand store
 *
 * 用法：
 *   const { status, next, handleWSEvent } = useClassroomStore()
 *   useClassroomStore.getState().start('class-001', 'poem-001', 'collective-race')
 */
export const useClassroomStore = create<ClassroomState>((set, get) => ({
    lessonId: '',
    joinCode: '',
    mode: 'collective-race',
    started: false,
    ended: false,
    status: EMPTY_STATUS,
    quest: null,
    lastLevelCleared: null,

    currentQuestion: undefined,
    responses: [],
    hints: [],
    discussions: [],

    aiMessages: [],

    // v5.0 Task 18-20：新状态字段
    aiOpponent: { ...DEFAULT_AI_OPPONENT },
    scoreEntries: [],
    commentStreaming: false,
    commentText: '',
    poemRelay: EMPTY_RELAY,
    wheelAngle: 0,
    wheelSpinning: false,
    wheelSelectedIndex: null,
    puzzleLevel: 1,
    puzzleOptions: [],

    report: null,

    wsStatus: 'idle',
    lastEventAt: null,

    starting: false,
    advancing: false,
    pushingHint: false,
    pushingDiscuss: false,
    ending: false,
    refreshing: false,
    aiOpponentThinking: false,
    scoring: false,
    error: null,

    // ── v5.0 Task 18-20 新动作实现 ──

    /** AI 点评控制器引用（用于 abortComment） */
    // 注意：不放在 state 中，避免触发不必要的渲染

    setAIOpponentEnabled: (enabled) => {
        const ai = get().aiOpponent
        set({ aiOpponent: { ...ai, enabled } })
        toast.info({
            title: enabled ? 'AI 虚拟对手已上场' : 'AI 虚拟对手已下场',
            message: enabled ? `${ai.name}（${AI_OPPONENT_LEVEL_LABELS[ai.level]}）加入对战` : '回到纯学生 PK 模式',
        })
    },

    setAIOpponentLevel: (level) => {
        const ai = get().aiOpponent
        const name = level === 'easy' ? '小诗童 AI' : level === 'medium' ? '老练 AI' : '诗仙 AI'
        set({ aiOpponent: { ...ai, level, name } })
        toast.info({ title: 'AI 难度已调整', message: `当前难度：${AI_OPPONENT_LEVEL_LABELS[level]}` })
    },

    resetAIOpponent: () => {
        const ai = get().aiOpponent
        set({ aiOpponent: { ...DEFAULT_AI_OPPONENT, enabled: ai.enabled, level: ai.level, name: ai.name } })
    },

    triggerAIOpponent: async (req) => {
        const { lessonId } = get()
        if (!lessonId) return null
        const ai = get().aiOpponent
        if (!ai.enabled) return null
        set({ aiOpponentThinking: true, error: null })
        try {
            const result = await api.classroom.aiOpponentAnswer(lessonId, req)
            // 累计 AI 对手统计
            const newTotal = ai.totalCount + 1
            const newCorrect = ai.correctCount + (result.correct ? 1 : 0)
            const newScore = ai.score + result.score
            const newAvgLatency = Math.round((ai.avgLatencyMs * ai.totalCount + result.latencyMs) / newTotal)
            set({
                aiOpponent: {
                    ...ai,
                    score: newScore,
                    correctCount: newCorrect,
                    totalCount: newTotal,
                    avgLatencyMs: newAvgLatency,
                    lastAnswerAt: result.answeredAt,
                },
                aiOpponentThinking: false,
            })
            // 追加一条学生作答记录（标记为 AI 对手）
            const aiResponse: StudentResponse = {
                studentId: 'ai-opponent',
                studentName: ai.name,
                answer: result.answer,
                correct: result.correct,
                score: result.score,
                at: result.answeredAt,
            }
            set({ responses: [...get().responses, aiResponse] })
            toast.info({
                title: `${ai.name} 已作答`,
                message: result.correct ? `答对！+${result.score} 分` : '答错，AI 也需要再练习',
            })
            return result
        } catch (err) {
            const msg = getDisplayError(err, 'AI 虚拟对手作答失败')
            set({ aiOpponentThinking: false, error: msg })
            toast.error({ title: 'AI 对手失灵', message: msg })
            return null
        }
    },

    scoreAnswer: async (req) => {
        const { lessonId } = get()
        if (!lessonId) return null
        set({ scoring: true, error: null })
        try {
            const result = await api.classroom.score(lessonId, req)
            // 累积赋分记录
            set({ scoreEntries: [...get().scoreEntries, result], scoring: false })
            // 追加 AI 副驾反馈消息
            const aiMessage: AIAssistantMessage = {
                id: nextMessageId(),
                role: 'brush.grade',
                kind: 'feedback',
                content: `${result.score} / 100 分\n${result.feedback}`,
                questionId: req.questionId,
                studentId: req.studentId,
                at: result.scoredAt,
                aiGenerated: result.aiGenerated,
            }
            set({
                aiMessages: appendBoundedHistory(
                    get().aiMessages,
                    [aiMessage],
                    MAX_LIVE_AI_MESSAGES,
                ),
            })
            return result
        } catch (err) {
            const msg = getDisplayError(err, '智能赋分失败')
            set({ scoring: false, error: msg })
            toast.error({ title: '赋分失败', message: msg })
            return null
        }
    },

    streamComment: (req, callbacks) => {
        const { lessonId } = get()
        // 重置点评文本
        set({ commentStreaming: true, commentText: '' })
        const controller = api.classroom.comment(
            lessonId,
            req,
            {
                onChunk: (chunk: ClassroomCommentChunk) => {
                    if (chunk.done) {
                        set({ commentStreaming: false })
                        callbacks?.onDone?.()
                        return
                    }
                    if (chunk.delta) {
                        set({ commentText: get().commentText + chunk.delta })
                    }
                },
                onError: (err: Error) => {
                    set({ commentStreaming: false })
                    toast.error({ title: 'AI 点评中断', message: err.message })
                    callbacks?.onError?.(err)
                },
                onDone: () => {
                    set({ commentStreaming: false })
                    callbacks?.onDone?.()
                },
            },
        )
        // 把 abort 控制器存到 store 实例外的闭包，供 abortComment 使用
        commentControllerRef.controller = controller
        return controller
    },

    abortComment: () => {
        const ctrl = commentControllerRef.controller
        if (ctrl) {
            ctrl.abort()
            commentControllerRef.controller = null
        }
        set({ commentStreaming: false })
    },

    submitRelayLine: async (line, studentId, studentName) => {
        const relay = get().poemRelay
        if (!relay || relay.finished) {
            toast.error({ title: '接龙未开始', message: '请先选择起始诗篇并启动接龙模式' })
            return false
        }
        // 乐观追加学生句
        const newLine: PoemRelayLine = {
            line,
            source: 'student',
            isStudentAnswer: true,
            correct: true, // 默认标记为正确，AI 后续可校正
            at: Date.now(),
        }
        set({ poemRelay: { ...relay, chain: [...relay.chain, newLine] } })
        // 追加 AI 副驾消息（讨论题类）
        const aiMessage: AIAssistantMessage = {
            id: nextMessageId(),
            role: 'brush.creative',
            kind: 'discussion',
            content: `学生 ${studentName ?? studentId} 接：${line}`,
            at: Date.now(),
            aiGenerated: true,
        }
        set({
            aiMessages: appendBoundedHistory(
                get().aiMessages,
                [aiMessage],
                MAX_LIVE_AI_MESSAGES,
            ),
        })
        return true
    },

    aiRelayContinue: async (_studentId) => {
        const relay = get().poemRelay
        if (!relay || relay.finished) return false
        const lastLine = relay.chain[relay.chain.length - 1]
        if (!lastLine) return false
        const ai = get().aiOpponent
        if (!ai.enabled) {
            toast.info({ title: 'AI 对手未启用', message: '请先开启 AI 虚拟对手作为陪练' })
            return false
        }
        const result = await get().triggerAIOpponent({
            mode: 'poem-relay',
            level: ai.level,
            relayPrevious: lastLine.line,
        })
        if (!result) return false
        const aiLine: PoemRelayLine = {
            line: result.answer,
            source: 'ai-opponent',
            correct: result.correct,
            poemTitle: result.reasoning,
            at: result.answeredAt,
        }
        const currentRelay = get().poemRelay
        if (currentRelay) {
            set({ poemRelay: { ...currentRelay, chain: [...currentRelay.chain, aiLine] } })
        }
        return true
    },

    spinWheel: () => {
        // Store 动作也可能被脚本/快捷键直接重复调用，不能只依赖按钮 disabled。
        cancelWheelSpinTimer()
        const generation = ++wheelSpinGeneration
        // 旋转 5 圈 + 随机停止角度
        const targetAngle = 360 * 5 + Math.floor(Math.random() * 360)
        set({ wheelAngle: targetAngle, wheelSpinning: true, wheelSelectedIndex: null })
        // 2 秒后停止旋转，根据角度计算命中索引（8 等分）
        wheelSpinTimer = window.setTimeout(() => {
            // reset / 新一轮 spin 后，旧回调不得改写共享 store 或发跨页面 Toast。
            if (generation !== wheelSpinGeneration || !get().wheelSpinning) return
            wheelSpinTimer = null
            const finalAngle = targetAngle % 360
            const section = 45 // 360 / 8
            const idx = Math.floor((360 - finalAngle + section / 2) / section) % 8
            set({ wheelSpinning: false, wheelSelectedIndex: idx })
            toast.success({ title: '大转盘停止', message: `命中第 ${idx + 1} 题` })
        }, 2000)
    },

    setWheelSelected: (index) => {
        set({ wheelSelectedIndex: index })
    },

    resetWheel: () => {
        wheelSpinGeneration += 1
        cancelWheelSpinTimer()
        set({ wheelAngle: 0, wheelSpinning: false, wheelSelectedIndex: null })
    },

    loadPuzzleLevel: (level) => {
        set({ puzzleLevel: level, puzzleOptions: [] })
    },

    setPuzzleOptions: (opts) => {
        set({ puzzleOptions: opts })
    },

    start: async (classId, poemId, mode, questionIds, failureFeedback = 'toast') => {
        set({ starting: true, error: null })
        try {
            // Phase 5.3：命题→授课一键贯通 —— 若未传入 questionIds，自动从命题工坊拉取已生成的题目
            let resolvedQuestionIds = questionIds
            if (!resolvedQuestionIds || resolvedQuestionIds.length === 0) {
                const workbenchState = useWorkbenchStore.getState()
                // 仅当 workbench 选中的诗篇与当前课堂诗篇一致时，才自动复用题目
                if (workbenchState.poemId === poemId && workbenchState.questions.length > 0) {
                    resolvedQuestionIds = workbenchState.questions.map((q) => q.id)
                }
            }
            const res: StartClassroomResponse = await api.classroom.start(classId, poemId, mode, resolvedQuestionIds)
            set({
                lessonId: res.lessonId,
                joinCode: res.joinCode,
                mode,
                started: true,
                ended: false,
                starting: false,
                report: null,
                aiMessages: [],
                hints: [],
                discussions: [],
                responses: [],
                scoreEntries: [],
                commentStreaming: false,
                commentText: '',
                aiOpponent: { ...DEFAULT_AI_OPPONENT },
                poemRelay: EMPTY_RELAY,
                wheelAngle: 0,
                wheelSpinning: false,
                wheelSelectedIndex: null,
                puzzleLevel: 1,
                puzzleOptions: [],
            })
            // 立即拉取首次状态
            await get().refreshStatus()
            toast.success({ title: '课堂已开始', message: `加入码 ${res.joinCode}` })
            return res.lessonId
        } catch (err) {
            const msg = getDisplayError(err, '开始课堂失败')
            set({ starting: false, error: msg })
            if (failureFeedback === 'toast') {
                toast.error({ title: '开始失败', message: msg })
            }
            return null
        }
    },

    loadByLessonId: async (lessonId) => {
        set({ lessonId, refreshing: true, error: null })
        await get().refreshStatus()
    },

    joinByCode: async (joinCode) => {
        try {
            const res = await api.classroom.join(joinCode)
            set({
                lessonId: res.lessonId,
                mode: res.mode,
                started: true,
                ended: false,
            })
            await get().refreshStatus()
            return res.lessonId
        } catch (err) {
            const msg = getDisplayError(err, '加入码无效')
            set({ error: msg })
            toast.error({ title: '加入失败', message: msg })
            return null
        }
    },

    refreshStatus: async () => {
        const { lessonId } = get()
        if (!lessonId) return
        set({ refreshing: true })
        try {
            const status: ClassroomStatus = await api.classroom.status(lessonId)
            set({
                status,
                mode: status.mode,
                joinCode: status.joinCode,
                currentQuestion: status.currentQuestion,
                responses: status.responses,
                // 从 status 补水闯关快照：刷新页面 / 中途接入大屏时，
                // HUD 不能因为错过了 WS 事件就一片空白
                quest: status.quest ?? null,
                started: true,
                refreshing: false,
                error: null,
            })
        } catch (err) {
            const msg = getDisplayError(err, '获取课堂状态失败')
            set({ refreshing: false, error: msg })
        }
    },

    next: async () => {
        const { lessonId } = get()
        if (!lessonId) return
        set({ advancing: true, error: null })
        try {
            const res = await api.classroom.next(lessonId)
            set({
                currentQuestion: res.currentQuestion,
                status: {
                    ...get().status,
                    currentQuestionIndex: res.currentQuestionIndex,
                    currentQuestion: res.currentQuestion,
                },
                responses: [],
                advancing: false,
            })
            toast.info({ title: '已切换题目', message: `第 ${res.currentQuestionIndex + 1} 题` })
        } catch (err) {
            const msg = getDisplayError(err, '切换题目失败')
            set({ advancing: false, error: msg })
            toast.error({ title: '切换失败', message: msg })
        }
    },

    submit: async (studentId, answer, studentName, latencyMs) => {
        const { lessonId, currentQuestion } = get()
        if (!lessonId || !currentQuestion) return false
        try {
            const res = await api.classroom.submit(
                lessonId,
                studentId,
                answer,
                currentQuestion.id,
                studentName,
                latencyMs,
            )
            // 乐观更新：追加到 responses
            const newResponse: StudentResponse = {
                studentId,
                answer,
                correct: res.correct,
                at: Date.now(),
            }
            set((state) => {
                const exists = state.responses.some(
                    (response) =>
                        response.studentId === newResponse.studentId &&
                        response.answer === newResponse.answer,
                )
                return exists ? state : { responses: [...state.responses, newResponse] }
            })
            // 追加 AI 副驾消息（批改反馈）
            const aiMessage: AIAssistantMessage = {
                id: nextMessageId(),
                role: 'brush.grade',
                kind: 'feedback',
                content: res.feedback,
                questionId: currentQuestion.id,
                studentId,
                at: Date.now(),
                aiGenerated: res.aiGenerated,
            }
            set({
                aiMessages: appendBoundedHistory(
                    get().aiMessages,
                    [aiMessage],
                    MAX_LIVE_AI_MESSAGES,
                ),
            })
            return res.correct
        } catch (err) {
            const msg = getDisplayError(err, '提交失败')
            toast.error({ title: '提交失败', message: msg })
            return false
        }
    },

    pushHint: async (type = 'nudge') => {
        const { lessonId, currentQuestion } = get()
        if (!lessonId || !currentQuestion) return
        set({ pushingHint: true, error: null })
        try {
            const res = await api.classroom.hint(lessonId, currentQuestion.id, type)
            const record: HintRecord = {
                id: `hint-${Date.now()}`,
                questionId: currentQuestion.id,
                type,
                hint: res.hint,
                deliveredAt: Date.now(),
                aiGenerated: true,
            }
            set({
                hints: [...get().hints, record],
                pushingHint: false,
            })
            // 追加 AI 副驾消息（启发提示）
            const aiMessage: AIAssistantMessage = {
                id: nextMessageId(),
                role: 'brush.creative',
                kind: 'hint',
                content: res.hint,
                questionId: currentQuestion.id,
                at: Date.now(),
                aiGenerated: true,
            }
            set({
                aiMessages: appendBoundedHistory(
                    get().aiMessages,
                    [aiMessage],
                    MAX_LIVE_AI_MESSAGES,
                ),
            })
            toast.success({ title: '已推送启发提示', message: type === 'nudge' ? '轻推式' : type === 'scaffold' ? '脚手架式' : '重构式' })
        } catch (err) {
            const msg = getDisplayError(err, '推送提示失败')
            set({ pushingHint: false, error: msg })
            toast.error({ title: '推送失败', message: msg })
        }
    },

    pushDiscuss: async (angle = 'cultural') => {
        const { lessonId, currentQuestion } = get()
        if (!lessonId || !currentQuestion) return
        set({ pushingDiscuss: true, error: null })
        try {
            const res = await api.classroom.discuss(lessonId, currentQuestion.id, angle)
            const record: DiscussionRecord = {
                id: `discuss-${Date.now()}`,
                questionId: currentQuestion.id,
                angle,
                topic: res.discussionTopic,
                followUp: res.followUp,
                generatedAt: Date.now(),
                aiGenerated: true,
            }
            set({
                discussions: [...get().discussions, record],
                pushingDiscuss: false,
            })
            // 追加 AI 副驾消息（讨论题）
            const content = `${res.discussionTopic}\n${res.followUp.map((f) => `· ${f}`).join('\n')}`
            const aiMessage: AIAssistantMessage = {
                id: nextMessageId(),
                role: 'brush.creative',
                kind: 'discussion',
                content,
                questionId: currentQuestion.id,
                at: Date.now(),
                aiGenerated: true,
            }
            set({
                aiMessages: appendBoundedHistory(
                    get().aiMessages,
                    [aiMessage],
                    MAX_LIVE_AI_MESSAGES,
                ),
            })
            toast.success({ title: '已生成讨论题', message: record.topic.slice(0, 30) })
        } catch (err) {
            const msg = getDisplayError(err, '生成讨论题失败')
            set({ pushingDiscuss: false, error: msg })
            toast.error({ title: '生成失败', message: msg })
        }
    },

    switchMode: async (newMode) => {
        const { mode: oldMode, lessonId } = get()
        if (oldMode === newMode || !lessonId) return false
        try {
            const result = await api.classroom.switchMode(lessonId, newMode)
            set({
                mode: result.mode,
                status: {
                    ...get().status,
                    mode: result.mode,
                    flyingFlowerKeyword: result.flyingFlowerKeyword ?? get().status.flyingFlowerKeyword,
                },
            })
            businessEvents.emit('classroom:mode-changed', {
                lessonId,
                fromMode: oldMode,
                toMode: result.mode,
                changedAt: Date.now(),
            })
            toast.success({ title: '课堂模式已切换', message: `全班端已同步为 ${CLASSROOM_MODE_LABELS[result.mode]}` })
            return true
        } catch (err) {
            const msg = getDisplayError(err, '切换课堂模式失败')
            set({ error: msg })
            toast.error({ title: '切换失败', message: msg })
            return false
        }
    },

    end: async () => {
        const { lessonId } = get()
        if (!lessonId) return
        set({ ending: true, error: null })
        try {
            const res: ClassroomReport = await api.classroom.end(lessonId)
            // 追加 AI 副驾消息（报告片段）
            const aiMessage: AIAssistantMessage = {
                id: nextMessageId(),
                role: 'brush.report',
                kind: 'report',
                content: res.report.summary,
                at: Date.now(),
                aiGenerated: res.report.aiGenerated,
            }
            set({
                report: res,
                ended: true,
                ending: false,
                aiMessages: appendBoundedHistory(
                    get().aiMessages,
                    [aiMessage],
                    MAX_LIVE_AI_MESSAGES,
                ),
            })
            toast.success({ title: '课堂已结束', message: '协奏报告已生成' })
            useNotificationStore.getState().push({
                type: 'success',
                title: '课堂协奏报告已生成',
                description: res.report.summary.slice(0, 80),
                linkTo: `/classroom/${lessonId}?view=report`,
            })
            // v5.0 Task 4.7：发射业务事件，通知 dashboard 刷新统计与周进度
            businessEvents.emit('classroom:ended', {
                lessonId,
            })
            businessEvents.emit('report:generated', {
                lessonId,
                reportType: 'classroom',
            })
        } catch (err) {
            const msg = getDisplayError(err, '结束课堂失败')
            set({ ending: false, error: msg })
            toast.error({ title: '结束失败', message: msg })
        }
    },

    loadReport: async (lessonId) => {
        try {
            const res = await api.classroom.getReport(lessonId)
            set({
                lessonId,
                report: res,
                ended: true,
                started: true,
                error: null,
            })
            return true
        } catch (err) {
            const msg = getDisplayError(err, '加载课堂报告失败')
            set({ error: msg })
            toast.error({ title: '报告加载失败', message: msg })
            return false
        }
    },

    handleWSEvent: (event) => {
        set({ lastEventAt: event.timestamp })

        // 仅处理 classroom:* 系列事件
        if (!event.type.startsWith('classroom:')) return

        const payload = event.payload as ClassroomWSPayload
        const state = get()

        // 校验 lessonId 匹配（若有）
        if (payload.lessonId && state.lessonId && payload.lessonId !== state.lessonId) return

        try {
            switch (event.type) {
                case 'classroom:level-cleared': {
                    // 通关：整份覆盖快照，并记下事件供 HUD 播放通关动画
                    if (payload.quest) set({ quest: payload.quest as QuestSnapshot })
                    set({
                        lastLevelCleared: {
                            clearedLevel: String(payload.clearedLevel ?? ''),
                            nextLevel: (payload.nextLevel as string | null) ?? null,
                            allCleared: Boolean(payload.allCleared),
                        },
                    })
                    return
                }

                case 'classroom:quest': {
                    // 分组变更 / AI 对手出手等纯状态更新
                    if (payload.quest) set({ quest: payload.quest as QuestSnapshot })
                    return
                }

                case 'classroom:ai-feedback': {
                    // AI 讲评异步回填：对错可能在此刻才最终确定
                    if (payload.quest) set({ quest: payload.quest as QuestSnapshot })
                    if (payload.studentId && payload.feedback) {
                        set({
                            responses: state.responses.map((r) =>
                                r.studentId === payload.studentId
                                    ? { ...r, correct: Boolean(payload.correct) }
                                    : r,
                            ),
                        })
                    }
                    return
                }

                case 'classroom:response': {
                    // 服务端在每次作答后整份下发闯关快照，直接覆盖
                    if (payload.quest) set({ quest: payload.quest as QuestSnapshot })
                    // 学生作答事件 —— 追加到 responses 与 AI 消息
                    if (!payload.studentId || !payload.answer) return
                    const newResponse: StudentResponse = {
                        studentId: payload.studentId,
                        studentName: payload.studentName,
                        answer: payload.answer,
                        correct: payload.correct,
                        score: payload.score,
                        at: event.timestamp,
                    }
                    // 避免重复（乐观更新已追加）
                    const exists = state.responses.some(
                        (r) => r.studentId === newResponse.studentId && r.answer === newResponse.answer,
                    )
                    if (exists) return
                    set({ responses: [...state.responses, newResponse] })

                    // 追加 AI 副驾反馈消息
                    if (payload.feedback) {
                        const aiMessage: AIAssistantMessage = {
                            id: nextMessageId(),
                            role: 'brush.grade',
                            kind: 'feedback',
                            content: payload.feedback,
                            questionId: payload.questionId,
                            studentId: payload.studentId,
                            at: event.timestamp,
                            aiGenerated: true,
                        }
                        set({
                            aiMessages: appendBoundedHistory(
                                state.aiMessages,
                                [aiMessage],
                                MAX_LIVE_AI_MESSAGES,
                            ),
                        })
                    }
                    break
                }
                case 'classroom:hint': {
                    if (!payload.hint || !payload.questionId) return
                    const record: HintRecord = {
                        id: `hint-ws-${event.timestamp}`,
                        questionId: payload.questionId,
                        type: payload.type ?? 'nudge',
                        hint: payload.hint,
                        deliveredAt: payload.deliveredAt ?? event.timestamp,
                        aiGenerated: true,
                    }
                    set({
                        hints: [...state.hints, record],
                        status: { ...state.status, hintsDelivered: state.status.hintsDelivered + 1 },
                    })
                    const aiMessage: AIAssistantMessage = {
                        id: nextMessageId(),
                        role: 'brush.creative',
                        kind: 'hint',
                        content: payload.hint,
                        questionId: payload.questionId,
                        at: event.timestamp,
                        aiGenerated: true,
                    }
                    set({
                        aiMessages: appendBoundedHistory(
                            state.aiMessages,
                            [aiMessage],
                            MAX_LIVE_AI_MESSAGES,
                        ),
                    })
                    break
                }
                case 'classroom:discuss': {
                    if (!payload.topic || !payload.questionId) return
                    const record: DiscussionRecord = {
                        id: `discuss-ws-${event.timestamp}`,
                        questionId: payload.questionId,
                        angle: payload.angle ?? 'cultural',
                        topic: payload.topic,
                        followUp: payload.followUp ?? [],
                        generatedAt: event.timestamp,
                        aiGenerated: true,
                    }
                    set({ discussions: [...state.discussions, record] })
                    const content = `${payload.topic}\n${(payload.followUp ?? []).map((f) => `· ${f}`).join('\n')}`
                    const aiMessage: AIAssistantMessage = {
                        id: nextMessageId(),
                        role: 'brush.creative',
                        kind: 'discussion',
                        content,
                        questionId: payload.questionId,
                        at: event.timestamp,
                        aiGenerated: true,
                    }
                    set({
                        aiMessages: appendBoundedHistory(
                            state.aiMessages,
                            [aiMessage],
                            MAX_LIVE_AI_MESSAGES,
                        ),
                    })
                    break
                }
                case 'classroom:next': {
                    // 切换题目 —— 触发局部刷新获取新题目完整内容
                    if (payload.currentIndex !== undefined) {
                        set({
                            status: {
                                ...state.status,
                                currentQuestionIndex: payload.currentIndex,
                                totalQuestions: payload.totalQuestions ?? state.status.totalQuestions,
                            },
                            responses: [],
                        })
                    }
                    void state.refreshStatus()
                    break
                }
                case 'classroom:cognitive': {
                    // 认知负荷与课堂氛围更新 —— 直接更新 state
                    set({
                        status: {
                            ...state.status,
                            cognitiveLoad: payload.cognitiveLoad ?? state.status.cognitiveLoad,
                            classMood: payload.classMood ?? state.status.classMood,
                            engagement: payload.engagement ?? state.status.engagement,
                        },
                    })
                    break
                }
                case 'classroom:end': {
                    if (payload.report) {
                        set({
                            report: {
                                lessonId: state.lessonId,
                                report: payload.report,
                            },
                            ended: true,
                        })
                    }
                    break
                }
                case 'classroom:start':
                default:
                    // start 事件由 store.start 动作本身处理，此处忽略
                    break
            }
        } catch (err) {
            // WS 事件为被动推送且可能频繁触发，处理失败时弹 toast 会刷屏；
            // 仅在开发模式记录调试日志，便于定位畸形 payload 等问题。
            if (import.meta.env.DEV) console.debug('[classroom] handleWSEvent 错误:', err)
        }
    },

    setWsStatus: (status) => {
        set({ wsStatus: status })
    },

    reset: () => {
        // 中断可能进行中的 AI 点评
        const ctrl = commentControllerRef.controller
        if (ctrl) {
            ctrl.abort()
            commentControllerRef.controller = null
        }
        set({
            lessonId: '',
            joinCode: '',
            mode: 'collective-race',
            started: false,
            ended: false,
            status: EMPTY_STATUS,
            currentQuestion: undefined,
            responses: [],
            hints: [],
            discussions: [],
            aiMessages: [],
            report: null,
            wsStatus: 'idle',
            lastEventAt: null,
            starting: false,
            advancing: false,
            pushingHint: false,
            pushingDiscuss: false,
            ending: false,
            refreshing: false,
            aiOpponentThinking: false,
            scoring: false,
            error: null,
            // v5.0 Task 18-20：重置新状态
            aiOpponent: { ...DEFAULT_AI_OPPONENT },
            scoreEntries: [],
            commentStreaming: false,
            commentText: '',
            poemRelay: EMPTY_RELAY,
            wheelAngle: 0,
            wheelSpinning: false,
            wheelSelectedIndex: null,
            puzzleLevel: 1,
            puzzleOptions: [],
        })
    },
}))

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.4：业务事件总线订阅 —— workbench → classroom 数据断点修复
//
// 教师在命题工坊生成题目并发起批改时，WorkbenchPage 发射 'workbench:question-ready'
// 业务事件。classroom store 订阅该事件，在课堂未进行时推送通知，引导教师前往
// 课堂导播台开始授课，打通"命题 → 授课"环节。
//
// 断裂点修复：classroom 此前不订阅该事件，教师生成题目后需手动切换页面
// ─────────────────────────────────────────────────────────────────────────────
businessEvents.on('workbench:question-ready', (event) => {
    const state = useClassroomStore.getState()
    // 仅在课堂未开始或已结束时推送通知，避免干扰进行中的课堂
    if (state.started && !state.ended) return
    useNotificationStore.getState().push({
        type: 'info',
        title: '题目已就绪',
        description: `${event.payload.count} 道题目已生成，可前往课堂导播台开始授课`,
        linkTo: '/classroom',
    })
})
