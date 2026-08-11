/**
 * 编排官共享类型定义
 *
 * 定义中央编排官、DAG 调度器、WebSocket 广播器、介入管理器
 * 与会话存储共用的类型。所有类型严格 TypeScript，零 any，
 * 适配 noUncheckedIndexedAccess 与 strictNullChecks。
 *
 * 设计原则：
 * - Intent 枚举覆盖全部 11 类教学意图 + composite + unknown
 * - SubTask 携带 dependencies 与 condition 支持任意 DAG 形态
 * - WSEvent 为统一事件信封，承载全链路可观测数据
 */

import type { AgentResult } from '../agents/base/types.js'

// ─────────────────────────────────────────────────────────────
// 意图分类
// ─────────────────────────────────────────────────────────────

/**
 * 教师指令意图分类
 *
 * 11 类教学核心意图 + composite（需进一步拆解）+ unknown（无法识别）。
 * 编排官解析阶段必须输出其中之一。
 */
export type Intent =
    | 'generate-questions'    // 出题
    | 'grade-answers'         // 批改
    | 'diagnose-class'        // 班级诊断
    | 'diagnose-student'      // 学生诊断
    | 'generate-report'       // 教研报告
    | 'recommend-path'        // 推荐路径
    | 'vision-annotate'       // 视觉标注
    | 'evaluate-recitation'   // 朗读评测
    | 'generate-tts'          // 范读生成
    | 'generate-creative'     // 创意素材
    | 'composite'             // 复合任务（需进一步拆解）
    | 'unknown'               // 无法识别

// ─────────────────────────────────────────────────────────────
// 子任务与 DAG
// ─────────────────────────────────────────────────────────────

/**
 * 子任务状态机
 * - pending  : 等待依赖完成
 * - running  : 正在执行
 * - paused   : 被教师暂停
 * - success  : 执行成功
 * - failed   : 执行失败
 * - skipped  : 因条件不满足或依赖失败被跳过
 */
export type SubTaskStatus =
    | 'pending'
    | 'running'
    | 'paused'
    | 'success'
    | 'failed'
    | 'skipped'

/**
 * 子任务条件函数
 *
 * 依赖完成后评估，返回 false 则跳过当前节点。
 * 入参为已完成节点的结果映射（taskId -> result）。
 */
export type SubTaskCondition = (results: Map<string, unknown>) => boolean

/**
 * DAG 中的子任务节点
 */
export interface SubTask {
    /** 唯一 ID（UUID） */
    id: string
    /** 目标 Agent id，如 'brush.question' */
    agentId: string
    /** Agent 调用输入（不透明载荷） */
    input: unknown
    /** 依赖的 subTask id 列表（必须全部完成后才能执行） */
    dependencies: string[]
    /** 条件分支：依赖完成后评估，false 则跳过 */
    condition?: SubTaskCondition
    /** 当前状态 */
    status: SubTaskStatus
    /** 执行结果（success 时填充） */
    result?: unknown
    /** 错误信息（failed 时填充） */
    error?: string
    /** 开始时间戳 */
    startedAt?: number
    /** 结束时间戳 */
    endedAt?: number
}

/**
 * DAG 边
 *
 * 携带可选条件标识，用于在 condition 评估失败时跳过目标节点。
 */
export interface DAGEdge {
    from: string
    to: string
    /** 条件标识（仅用于文档化与可观测性，实际评估在 SubTask.condition 中） */
    condition?: string
}

/**
 * 有向无环图
 */
export interface DAG {
    nodes: SubTask[]
    edges: DAGEdge[]
}

// ─────────────────────────────────────────────────────────────
// 解析后的指令
// ─────────────────────────────────────────────────────────────

/**
 * 编排官解析教师自然语言指令后的结构化产物
 */
export interface ParsedInstruction {
    intent: Intent
    subTasks: SubTask[]
    executionPlan: DAG
    /** 预计涉及的 Agent id 列表（去重） */
    estimatedAgents: string[]
    /** 预计总耗时（毫秒） */
    estimatedDurationMs: number
    /** 解析置信度 0-1 */
    confidence: number
}

// ─────────────────────────────────────────────────────────────
// 执行上下文与结果
// ─────────────────────────────────────────────────────────────

/**
 * 编排官执行上下文
 *
 * 携带会话与教师身份，注入中止信号与实时回调。
 */
export interface OrchestratorContext {
    sessionId: string
    teacherId: string
    classId?: string
    /** 暂停信号（外部触发后，下一批节点不再启动） */
    pauseSignal?: AbortSignal
    /** 中止信号（外部触发后，运行中的 Agent 调用收到 abort） */
    abortSignal?: AbortSignal
    /** 每个节点状态变化时回调（供 WebSocket 实时推送） */
    onTaskUpdate?: (task: SubTask) => void
}

/**
 * 单次 Agent 调用统计
 */
export interface AgentInvocation {
    agentId: string
    latencyMs: number
    tokens: number
}

/**
 * DAG 执行结果
 */
export interface ExecutionResult {
    sessionId: string
    success: boolean
    /** taskId -> result 映射（仅成功节点） */
    results: Map<string, unknown>
    /** 失败的 taskId 列表 */
    failedTasks: string[]
    /** 被跳过的 taskId 列表 */
    skippedTasks: string[]
    /** 总耗时（毫秒） */
    totalLatencyMs: number
    /** 总费用（元） */
    totalCostYuan: number
    /** 各 Agent 调用统计 */
    agentInvocations: AgentInvocation[]
}

/**
 * 反思产物
 *
 * 由 reflect() 调用 LLM 总结得出，用于自我进化引擎（Task 22）。
 */
export interface Reflection {
    sessionId: string
    /** 表现优秀的 Agent id 列表 */
    strongAgents: string[]
    /** 表现欠佳的 Agent id 列表 */
    weakAgents: string[]
    /** 下次编排建议 */
    suggestions: string[]
    /** 反思置信度 0-1 */
    confidence: number
    /** 生成时间戳 */
    timestamp: number
}

// ─────────────────────────────────────────────────────────────
// 会话状态
// ─────────────────────────────────────────────────────────────

/**
 * 会话状态
 *
 * 一个会话对应一次完整的"教师指令 → 解析 → 执行 → 反思"流程。
 * SessionStore 内部维护，容量上限 1000（LRU 淘汰）。
 */
export type SessionStatus =
    | 'idle'
    | 'planning'
    | 'executing'
    | 'paused'
    | 'completed'
    | 'aborted'

export interface SessionState {
    id: string
    teacherId: string
    classId?: string
    startedAt: number
    endedAt?: number
    status: SessionStatus
    /** 当前解析出的执行计划 */
    currentPlan?: ParsedInstruction
    /** taskId -> SubTask 状态映射 */
    taskStates: Map<string, SubTask>
    /** 事件历史（上限 10000/session，超出 LRU） */
    events: WSEvent[]
    /** 反思结果列表 */
    reflections?: Reflection[]
    /** 执行结果（完成后填充） */
    executionResult?: ExecutionResult
}

// ─────────────────────────────────────────────────────────────
// WebSocket 事件
// ─────────────────────────────────────────────────────────────

/**
 * WebSocket 事件信封
 *
 * 所有编排官、Agent、LLM、计费层事件统一封装为此结构后广播。
 * sessionId 可选，全局事件（如 billing:record）可为空。
 */
export interface WSEvent {
    /** 事件类型，如 'orch:task:start' / 'agent:call:success' */
    type: string
    /** 时间戳（ms） */
    timestamp: number
    /** 关联会话 ID（全局事件为空字符串） */
    sessionId: string
    /** 事件载荷 */
    payload: unknown
}

/**
 * WebSocket 订阅过滤器
 *
 * 客户端连接时可通过 orch:subscribe 消息设置过滤条件，
 * 服务端仅推送匹配的事件。
 */
export interface WSSubscriptionFilter {
    sessionId?: string
    agentIds?: string[]
    eventTypes?: string[]
}

// ─────────────────────────────────────────────────────────────
// 教师反馈（Task 22 自我进化引擎预留）
// ─────────────────────────────────────────────────────────────

export type FeedbackType = 'good' | 'bad' | 'correction'

export interface TeacherFeedback {
    sessionId: string
    taskId: string
    agentId: string
    feedbackType: FeedbackType
    content: string
    timestamp: number
}

// ─────────────────────────────────────────────────────────────
// 编排事件常量
// ─────────────────────────────────────────────────────────────

/**
 * 编排官事件类型常量
 *
 * 与 AGENT_EVENTS / llm:call:* / billing:record 互补，
 * 构成完整的全链路可观测事件族。
 */
export const ORCH_EVENTS = {
    INSTRUCTION_PARSED: 'orch:instruction:parsed',
    TASK_START: 'orch:task:start',
    TASK_PROGRESS: 'orch:task:progress',
    TASK_DONE: 'orch:task:done',
    TASK_FAILED: 'orch:task:failed',
    TASK_PAUSED: 'orch:task:paused',
    TASK_RESUMED: 'orch:task:resumed',
    TASK_SKIPPED: 'orch:task:skipped',
    SESSION_START: 'orch:session:start',
    SESSION_END: 'orch:session:end',
    REFLECTION: 'orch:reflection',
    TEACHER_FEEDBACK: 'orch:teacher:feedback',
} as const

export type OrchEventName = (typeof ORCH_EVENTS)[keyof typeof ORCH_EVENTS]

// ─────────────────────────────────────────────────────────────
// Agent 调用入口签名
// ─────────────────────────────────────────────────────────────

/**
 * Agent 调用入口类型
 *
 * 编排官不直接持有 BaseAgent 实例（避免循环依赖与类型耦合），
 * 而是通过此接口调用。BaseAgent.invoke 的签名即满足此接口。
 */
export type AgentInvokeFn = (
    input: unknown,
    ctx: import('../agents/base/types.js').AgentContext,
) => Promise<AgentResult<unknown>>
