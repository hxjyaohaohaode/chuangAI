/**
 * 中央编排官
 *
 * 多智能体系统的"指挥中枢"，职责：
 * 1. parseInstruction — 将教师自然语言指令解析为可执行的 DAG
 * 2. execute          — 调度 DAG，并行/串行/条件分支执行
 * 3. pause/resume/abort/modify — 教师中途介入
 * 4. reflect          — 执行后反思，供自我进化引擎
 *
 * 设计哲学：
 * - Harness Engineering：编排官是驾驭 LLM 的 harness，拆解任务、调度 Agent、收集结果
 * - Loop Engineering：编排官自身也是 loop（plan → execute → observe → reflect）
 * - 教师 in-the-loop：教师可随时暂停/修正任一 Agent
 * - 透明度：所有编排决策通过 WebSocket 实时推送
 *
 * 关键工程：
 * - DAG 调度：无依赖节点 Promise.allSettled 并行，有依赖节点等待前置
 * - AbortSignal 传播：教师 abort 时，运行中的 Agent.invoke 收到 signal 并清理
 * - 60s 超时：每个节点默认 60s 超时，超时自动标记失败
 * - 内存安全：activeExecutors 容量上限 100，超出拒绝新建
 */

import { z } from 'zod'
import type { LLMRouter } from '../llm/router.js'
import type { TokenBilling } from '../llm/billing.js'
import type { ChatMessage } from '../llm/types.js'
import type { BaseAgent } from '../agents/base/Agent.js'
import type { AgentContext } from '../agents/base/types.js'
import {
    buildContextBlock,
    STANDARD_CONTEXT_TAGS,
    getFewShotBlock,
    safeJsonParse,
    standardEntry,
    withConstraint,
} from '../agents/base/prompts.js'
import type { WSBroadcaster } from './websocket/broadcaster.js'
import { evolutionEngine } from '../agents/base/evolution-engine.js'
import { DAGScheduler } from './dag-scheduler.js'
import { validateExecutablePlan } from './plan-validation.js'
import {
    ORCH_EVENTS,
    type AgentInvocation,
    type DAG,
    type ExecutionResult,
    type OrchestratorContext,
    type ParsedInstruction,
    type Reflection,
    type SubTask,
} from './types.js'

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 单节点默认超时（毫秒） */
const DEFAULT_NODE_TIMEOUT_MS = 60_000

/** 最大并发执行会话数（内存保护） */
const MAX_ACTIVE_EXECUTIONS = 100

// ─────────────────────────────────────────────────────────────
// Agent 能力描述（注入 parseInstruction 的 prompt）
// ─────────────────────────────────────────────────────────────

interface AgentCapability {
    id: string
    name: string
    description: string
    inputHint: string
}

/**
 * 全部 11 个子 Agent 的能力描述
 *
 * 编排官在解析阶段注入此清单，避免 LLM 编造不存在的 Agent。
 */
const AGENT_CAPABILITIES: readonly AgentCapability[] = [
    {
        id: 'mind.profile',
        name: '学情画像',
        description: '基于学习事件构建学生六阶认知画像',
        inputHint: '{ studentId: string, events: LearningEvent[] }',
    },
    {
        id: 'mind.diagnose',
        name: '认知诊断',
        description: '识别认知暗物质、知识盲区与布鲁姆失衡',
        inputHint: '{ scope: "class"|"student", targetId: string, profiles?: StudentProfile[] }',
    },
    {
        id: 'mind.recommend',
        name: '路径推荐',
        description: '基于诊断结果推荐个性化学习路径',
        inputHint: '{ studentId: string, diagnosis: DiagnosisResult }',
    },
    {
        id: 'mind.verify',
        name: '独立验收',
        description: '对其他 Agent 输出进行独立质量审核',
        inputHint: '{ targetAgentId: string, output: unknown, dimensions?: VerifyDimension[] }',
    },
    {
        id: 'eye.vision-annotate',
        name: '视觉标注',
        description: 'Tri-MARF 视觉→文本标注，识别图片中的诗词元素',
        inputHint: '{ images: Array<{ url: controlledInlineImageOrDashscopeOss }>, purpose: VisionPurpose }',
    },
    {
        id: 'eye.asr',
        name: '语音识别',
        description: '语音识别 + 朗读评估，标注发音错误',
        inputHint: '{ audio: Buffer|base64, language?: "zh"|"en" }（禁止 URL）',
    },
    {
        id: 'eye.tts',
        name: '范读合成',
        description: '标准范读语音合成',
        inputHint: '{ text: string, voice?: string, speed?: number }',
    },
    {
        id: 'brush.question',
        name: '六阶命题',
        description: '按布鲁姆六阶生成古诗词题目',
        inputHint: '{ poemId: string, gradeLevel: GradeLevel, questionTypes: QuestionType[], bloomWeights: BloomWeights, count: number }',
    },
    {
        id: 'brush.grade',
        name: '智能批改',
        description: '批改学生答题，给出得分与反馈',
        inputHint: '{ questions: Question[], answers: Array<{ questionId: string, studentAnswer: string }> }',
    },
    {
        id: 'brush.report',
        name: '教研报告',
        description: '生成班级/年级教研分析报告',
        inputHint: '{ classId: string, diagnosis?: DiagnosisResult, grades?: GradeOutput[] }',
    },
    {
        id: 'brush.creative',
        name: '创意素材',
        description: '生成诗词配图、动画脚本、改编剧本等创意素材',
        inputHint: '{ poemId: string, creativeType: CreativeType, gradeLevel: CreativeGradeLevel }',
    },
] as const

/** Agent id → 能力描述 索引 */
const CAPABILITY_INDEX: ReadonlyMap<string, AgentCapability> = new Map(
    AGENT_CAPABILITIES.map((c) => [c.id, c]),
)

// ─────────────────────────────────────────────────────────────
// parseInstruction 的 zod schema
// ─────────────────────────────────────────────────────────────

const intentSchema = z.enum([
    'generate-questions',
    'grade-answers',
    'diagnose-class',
    'diagnose-student',
    'generate-report',
    'recommend-path',
    'vision-annotate',
    'evaluate-recitation',
    'generate-tts',
    'generate-creative',
    'composite',
    'unknown',
])

const subTaskNodeSchema = z.object({
    id: z.string().min(1),
    agentId: z.string().min(1),
    input: z.unknown(),
    dependencies: z.array(z.string()).default([]),
})

const parsedInstructionSchema = z.object({
    intent: intentSchema,
    subTasks: z.array(subTaskNodeSchema).min(1),
    dependencies: z.array(z.object({
        from: z.string(),
        to: z.string(),
        condition: z.string().optional(),
    })).default([]),
    estimatedDurationMs: z.number().int().positive().default(30_000),
    confidence: z.number().min(0).max(1).default(0.5),
    reasoning: z.string().optional(),
})

// ─────────────────────────────────────────────────────────────
// 活跃执行上下文
// ─────────────────────────────────────────────────────────────

interface ActiveExecution {
    sessionId: string
    scheduler: DAGScheduler
    ctx: OrchestratorContext
    /** 运行中任务的 AbortController（taskId -> controller） */
    runningControllers: Map<string, AbortController>
    /** 暂停的 taskId 集合（等待 resume） */
    pausedTasks: Set<string>
    /** 会话级 AbortController（abortSession 用） */
    sessionController: AbortController
    /** Agent 调用统计 */
    agentInvocations: AgentInvocation[]
    /** 起始时间 */
    startedAt: number
}

// ─────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────

export class Orchestrator {
    /** Agent 注册表：agentId -> BaseAgent */
    private readonly agentRegistry: Map<string, BaseAgent>
    /** 活跃执行上下文：sessionId -> ActiveExecution */
    private readonly activeExecutions = new Map<string, ActiveExecution>()
    constructor(
        private readonly router: LLMRouter,
        agents: Record<string, BaseAgent>,
        private readonly broadcaster: WSBroadcaster,
        private readonly billing: TokenBilling,
    ) {
        this.agentRegistry = new Map(Object.entries(agents))
    }

    /**
     * 校验教师在预览界面回传的计划，并按当前真实 Agent 注册表重建执行图。
     * 客户端计划属于不可信输入，不能仅依赖 TypeScript 类型或最初的 LLM 解析校验。
     */
    validatePlanForExecution(value: unknown): ParsedInstruction {
        return validateExecutablePlan(value, this.agentRegistry.keys())
    }

    // ─────────────────────────────────────────────────────────
    // 1. 解析教师自然语言指令
    // ─────────────────────────────────────────────────────────

    /**
     * 解析教师自然语言指令为可执行的 DAG
     *
     * 调用 router.execute('orchestrator', 'route', ...)，
     * 通过 XML 标签注入可用 Agent 清单，输出严格 JSON。
     * zod 校验失败时抛出明确错误。
     */
    async parseInstruction(
        instruction: string,
        ctx: { teacherId: string; classId?: string },
    ): Promise<ParsedInstruction> {
        const systemPrompt = this.buildParseSystemPrompt()
        const userPrompt = this.buildParseUserPrompt(instruction, ctx)

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ]

        const result = await this.router.execute('orchestrator', 'route', {
            messages,
            jsonOutput: true,
            metadata: {
                agent: 'orchestrator',
                task: 'parse-instruction',
            },
        })

        const parsed = safeJsonParse(result.content)
        const validated = parsedInstructionSchema.safeParse(parsed)
        if (!validated.success) {
            throw new Error(
                `编排官解析输出校验失败: ${validated.error.issues
                    .map((i) => `${i.path.join('.')}: ${i.message}`)
                    .join('; ')}`,
            )
        }

        // 校验 agentId 合法性（必须在能力清单中）
        for (const sub of validated.data.subTasks) {
            if (!CAPABILITY_INDEX.has(sub.agentId)) {
                throw new Error(
                    `编排官输出了不存在的 agentId: ${sub.agentId}，可用 Agent 见 <available_agents>`,
                )
            }
        }

        // 校验依赖项存在性
        const taskIds = new Set(validated.data.subTasks.map((s) => s.id))
        for (const sub of validated.data.subTasks) {
            for (const dep of sub.dependencies) {
                if (!taskIds.has(dep)) {
                    throw new Error(
                        `子任务 ${sub.id} 依赖不存在的任务: ${dep}`,
                    )
                }
            }
        }

        // 构建 SubTask 数组（初始状态 pending）
        const subTasks: SubTask[] = validated.data.subTasks.map((s) => ({
            id: s.id,
            agentId: s.agentId,
            input: s.input,
            dependencies: s.dependencies,
            status: 'pending' as const,
        }))

        // 构建 DAG
        const dag: DAG = {
            nodes: subTasks,
            edges: validated.data.dependencies,
        }

        // 估算涉及 Agent
        const estimatedAgents = Array.from(new Set(subTasks.map((s) => s.agentId)))

        // 广播解析完成事件
        this.broadcaster.broadcast({
            type: ORCH_EVENTS.INSTRUCTION_PARSED,
            timestamp: Date.now(),
            sessionId: '',
            payload: {
                intent: validated.data.intent,
                subTaskCount: subTasks.length,
                estimatedAgents,
                confidence: validated.data.confidence,
            },
        })

        return {
            intent: validated.data.intent,
            subTasks,
            executionPlan: dag,
            estimatedAgents,
            estimatedDurationMs: validated.data.estimatedDurationMs,
            confidence: validated.data.confidence,
        }
    }

    // ─────────────────────────────────────────────────────────
    // 2. 执行 DAG
    // ─────────────────────────────────────────────────────────

    /**
     * 执行已解析的 DAG
     *
     * 调度策略：
     * 1. 拓扑排序后获取就绪节点
     * 2. 无依赖的节点 Promise.allSettled 并行执行
     * 3. 每完成一个节点，重新评估条件 + 获取下一批就绪节点
     * 4. 监听 pauseSignal（暂停调度）与 abortSignal（中止全部）
     * 5. 每个节点 60s 超时
     *
     * 支持中途 pause/resume/abort/modify（通过 setActiveExecution 注册）。
     */
    async execute(
        plan: ParsedInstruction,
        ctx: OrchestratorContext,
    ): Promise<ExecutionResult> {
        if (this.activeExecutions.has(ctx.sessionId)) {
            throw new Error(`会话 ${ctx.sessionId} 已在执行，不能启动第二个调度循环`)
        }
        if (this.activeExecutions.size >= MAX_ACTIVE_EXECUTIONS) {
            throw new Error(
                `活跃执行数已达上限 ${MAX_ACTIVE_EXECUTIONS}，请等待现有会话完成`,
            )
        }

        const execution: ActiveExecution = {
            sessionId: ctx.sessionId,
            scheduler: new DAGScheduler(plan.executionPlan),
            ctx,
            runningControllers: new Map(),
            pausedTasks: new Set(),
            sessionController: new AbortController(),
            agentInvocations: [],
            startedAt: Date.now(),
        }
        this.activeExecutions.set(ctx.sessionId, execution)

        const { sessionController } = execution

        // 若外部 abortSignal 触发，联动 sessionController
        const onExternalAbort = () => sessionController.abort()
        if (ctx.abortSignal) {
            if (ctx.abortSignal.aborted) {
                sessionController.abort()
            } else {
                ctx.abortSignal.addEventListener('abort', onExternalAbort, { once: true })
            }
        }

        try {
            await this.runDAGLoop(execution)
        } finally {
            ctx.abortSignal?.removeEventListener('abort', onExternalAbort)
            this.activeExecutions.delete(ctx.sessionId)
        }

        return this.buildExecutionResult(execution)
    }

    // ─────────────────────────────────────────────────────────
    // 3. 教师介入接口
    // ─────────────────────────────────────────────────────────

    /**
     * 暂停某任务
     *
     * 触发该任务的 AbortController（reason: 'pause'），
     * executeNode 捕获后标记为 paused 而非 failed。
     */
    async pause(sessionId: string, taskId: string): Promise<void> {
        const execution = this.requireActiveTask(sessionId, taskId)
        const controller = execution.runningControllers.get(taskId)
        if (!controller) throw new Error(`任务 ${taskId} 当前未运行`)
        execution.pausedTasks.add(taskId)
        controller.abort('pause')
        while (execution.runningControllers.has(taskId)) await sleep(10)
        if (execution.scheduler.getNode(taskId)?.status !== 'paused') {
            throw new Error(`任务 ${taskId} 未能进入暂停状态`)
        }
    }

    /**
     * 恢复某任务
     *
     * 将 paused 状态的任务重置为 pending，
     * execute 循环会在下一轮 getReadyNodes 中拾取。
     */
    resume(sessionId: string, taskId: string): void {
        const execution = this.requireActiveTask(sessionId, taskId)
        const node = execution.scheduler.getNode(taskId)
        if (node?.status !== 'paused') throw new Error(`任务 ${taskId} 当前未暂停`)
        execution.pausedTasks.delete(taskId)
        execution.scheduler.modifyInput(taskId, node.input)
        execution.ctx.onTaskUpdate?.(execution.scheduler.getNode(taskId)!)
    }

    /**
     * 中止单个任务
     *
     * 触发 AbortController（reason: 'abort'），
     * executeNode 捕获后标记为 failed。
     */
    abort(sessionId: string, taskId: string): void {
        const execution = this.requireActiveTask(sessionId, taskId)
        const controller = execution.runningControllers.get(taskId)
        if (!controller) throw new Error(`任务 ${taskId} 当前未运行`)
        controller.abort('abort')
    }

    /**
     * 修正任务输入后重跑
     *
     * 中止当前运行（若有）+ 修改输入 + 重置为 pending。
     */
    async modify(sessionId: string, taskId: string, newInput: unknown): Promise<void> {
        const execution = this.requireActiveTask(sessionId, taskId)
        const controller = execution.runningControllers.get(taskId)
        if (controller) {
            execution.pausedTasks.add(taskId)
            controller.abort('modify')
            while (execution.runningControllers.has(taskId)) await sleep(10)
        }
        if (execution.sessionController.signal.aborted) throw new Error('会话已中止')
        execution.scheduler.modifyInput(taskId, newInput)
        execution.pausedTasks.delete(taskId)
        execution.ctx.onTaskUpdate?.(execution.scheduler.getNode(taskId)!)
    }

    /**
     * 中止整个 session
     */
    abortSession(sessionId: string): void {
        const execution = this.activeExecutions.get(sessionId)
        if (execution) {
            execution.sessionController.abort()
        }
    }

    private requireActiveTask(sessionId: string, taskId: string): ActiveExecution {
        const execution = this.activeExecutions.get(sessionId)
        if (!execution) throw new Error(`会话 ${sessionId} 当前未执行`)
        if (!execution.scheduler.getNode(taskId)) throw new Error(`会话 ${sessionId} 中不存在任务 ${taskId}`)
        return execution
    }

    // ─────────────────────────────────────────────────────────
    // 4. 反思与改进
    // ─────────────────────────────────────────────────────────

    /**
     * 反思执行结果
     *
     * 调用 router.execute('orchestrator', 'summarize', ...)，
     * 输出哪些 Agent 表现好/差，下次编排建议。
     */
    async reflect(executionResult: ExecutionResult): Promise<Reflection> {
        const systemPrompt = `你是诗脉·启明的反思引擎，负责分析编排官的执行结果，给出改进建议。

## 输出要求
输出严格 JSON，包含字段：
- strongAgents: 表现优秀的 Agent id 数组
- weakAgents: 表现欠佳的 Agent id 数组
- suggestions: 下次编排建议字符串数组
- confidence: 反思置信度 0-1

不输出任何解释文字、Markdown 标记或代码块包裹。`

        const userPrompt = buildContextBlock([
            {
                tag: 'execution_summary',
                content: JSON.stringify({
                    sessionId: executionResult.sessionId,
                    success: executionResult.success,
                    failedTasks: executionResult.failedTasks,
                    skippedTasks: executionResult.skippedTasks,
                    totalLatencyMs: executionResult.totalLatencyMs,
                    totalCostYuan: executionResult.totalCostYuan,
                    agentInvocations: executionResult.agentInvocations,
                }, null, 2),
            },
        ])

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ]

        const result = await this.router.execute('orchestrator', 'summarize', {
            messages,
            jsonOutput: true,
            metadata: {
                agent: 'orchestrator',
                task: 'reflect',
                sessionId: executionResult.sessionId,
            },
        })

        const parsed = safeJsonParse(result.content)
        const reflectionSchema = z.object({
            strongAgents: z.array(z.string()).default([]),
            weakAgents: z.array(z.string()).default([]),
            suggestions: z.array(z.string()).default([]),
            confidence: z.number().min(0).max(1).default(0.5),
        })

        const validated = reflectionSchema.safeParse(parsed)
        if (!validated.success) {
            // 反思失败不阻塞流程，返回默认值
            return {
                sessionId: executionResult.sessionId,
                strongAgents: [],
                weakAgents: [],
                suggestions: ['反思生成失败，请检查 orchestrator:summarize 路由'],
                confidence: 0,
                timestamp: Date.now(),
            }
        }

        const reflection: Reflection = {
            sessionId: executionResult.sessionId,
            strongAgents: validated.data.strongAgents,
            weakAgents: validated.data.weakAgents,
            suggestions: validated.data.suggestions,
            confidence: validated.data.confidence,
            timestamp: Date.now(),
        }

        this.broadcaster.broadcast({
            type: ORCH_EVENTS.REFLECTION,
            timestamp: Date.now(),
            sessionId: executionResult.sessionId,
            payload: reflection,
        })

        return reflection
    }

    // ─────────────────────────────────────────────────────────
    // 内部：DAG 执行循环
    // ─────────────────────────────────────────────────────────

    /**
     * DAG 执行主循环
     *
     * 不断获取就绪节点并并行执行，直到：
     * - 全部节点终结（success/failed/skipped）
     * - 会话被中止
     * - 无就绪节点且无运行中任务（死锁或全部暂停）
     */
    private async runDAGLoop(execution: ActiveExecution): Promise<void> {
        const { scheduler, sessionController } = execution

        while (!scheduler.isComplete()) {
            // 会话中止
            if (sessionController.signal.aborted) {
                this.abortAllRunning(execution)
                await this.waitForRunningTasks(execution)
                for (const node of scheduler.getAllNodes()) {
                    if (node.status === 'pending' || node.status === 'paused') {
                        scheduler.markSkipped(node.id, '会话已中止')
                        const skipped = scheduler.getNode(node.id)
                        if (skipped) execution.ctx.onTaskUpdate?.(skipped)
                    }
                }
                break
            }

            // 评估条件分支
            scheduler.evaluateConditions(scheduler.collectResults())

            // 获取就绪节点
            const ready = scheduler.getReadyNodes()

            if (ready.length === 0) {
                // 无就绪节点：检查是否有运行中任务
                if (execution.runningControllers.size === 0) {
                    // 无运行中任务也无就绪节点：可能全部暂停或死锁
                    const snap = scheduler.snapshot()
                    if (snap.paused > 0) {
                        // 等待 resume（短暂让出事件循环）
                        await sleep(100)
                        continue
                    }
                    // 真正的死锁或完成
                    break
                }
                // 等待运行中任务完成
                await this.waitForRunningTasks(execution)
                continue
            }

            // 并行执行就绪节点
            const batchPromises = ready.map((node) => this.executeNode(node, execution))
            await Promise.allSettled(batchPromises)

            // 批次完成后再次评估条件
            scheduler.evaluateConditions(scheduler.collectResults())
        }
    }

    /**
     * 执行单个节点
     *
     * 1. markRunning
     * 2. emit orch:task:start
     * 3. 调用 Agent.invoke（带超时与 AbortSignal）
     * 4. 成功：markDone + emit orch:task:done
     * 5. 失败：markFailed + emit orch:task:failed
     * 6. 暂停：markPaused + emit orch:task:paused（不传播失败）
     */
    private async executeNode(
        node: SubTask,
        execution: ActiveExecution,
    ): Promise<void> {
        const { scheduler, ctx, sessionController } = execution
        const agent = this.agentRegistry.get(node.agentId)

        if (!agent) {
            scheduler.markFailed(node.id, `未注册的 Agent: ${node.agentId}`)
            this.emitTaskEvent(ORCH_EVENTS.TASK_FAILED, ctx.sessionId, node.id, {
                agentId: node.agentId,
                error: `未注册的 Agent: ${node.agentId}`,
            })
            return
        }

        // 创建任务级 AbortController，联动会话级 signal
        const taskController = new AbortController()
        execution.runningControllers.set(node.id, taskController)

        // 会话中止 → 联动任务中止
        const onSessionAbort = () => taskController.abort('session-abort')
        sessionController.signal.addEventListener('abort', onSessionAbort, { once: true })

        // markRunning
        scheduler.markRunning(node.id)
        this.emitTaskEvent(ORCH_EVENTS.TASK_START, ctx.sessionId, node.id, {
            agentId: node.agentId,
            inputPreview: this.previewInput(node.input),
        })
        const runningNode = scheduler.getNode(node.id)
        if (runningNode) ctx.onTaskUpdate?.(runningNode)

        const startedAt = Date.now()

        try {
            // 构建 AgentContext
            const baseAgentCtx: AgentContext = {
                taskId: node.id,
                sessionId: ctx.sessionId,
                signal: taskController.signal,
                teacherIntent: undefined,
            }
            // 闭环4补全（BP4-1 关键修复）：注入进化后的 Prompt 覆盖
            // 自我进化引擎生成的新版本 Prompt 通过 promptOverride 字段注入 AgentContext，
            // BaseAgent.invoke 在 L88/L118 使用 ctx.promptOverride?.systemPrompt 替代默认 systemPrompt，
            // 使进化后的 Prompt 在下次 Agent 调用时自动生效。
            // 若 A/B 测试进行中，getPromptOverride 会按流量分配返回候选或活跃版本。
            const agentCtx = evolutionEngine.injectPromptOverride(baseAgentCtx, node.agentId)

            // 带超时调用
            const result = await this.invokeWithTimeout(
                agent,
                node.input,
                agentCtx,
                DEFAULT_NODE_TIMEOUT_MS,
                taskController,
            )

            // 成功
            scheduler.markDone(node.id, result.output)
            const latency = Date.now() - startedAt
            execution.agentInvocations.push({
                agentId: node.agentId,
                latencyMs: latency,
                tokens: result.usage.promptTokens + result.usage.completionTokens,
            })

            this.emitTaskEvent(ORCH_EVENTS.TASK_DONE, ctx.sessionId, node.id, {
                agentId: node.agentId,
                latencyMs: latency,
                tokens: result.usage.promptTokens + result.usage.completionTokens,
            })
            const completedNode = scheduler.getNode(node.id)
            if (completedNode) ctx.onTaskUpdate?.(completedNode)
        } catch (err) {
            const isPaused = execution.pausedTasks.has(node.id)
            const reason = this.getAbortReason(taskController.signal)

            if (isPaused || reason === 'pause' || reason === 'modify') {
                // 暂停：标记为 paused，不传播失败
                scheduler.markPaused(node.id)
                this.emitTaskEvent(ORCH_EVENTS.TASK_PAUSED, ctx.sessionId, node.id, {
                    agentId: node.agentId,
                    reason: reason ?? 'pause',
                })
            } else {
                // 真正失败
                const errMsg = err instanceof Error ? err.message : String(err)
                scheduler.markFailed(node.id, errMsg)
                this.emitTaskEvent(ORCH_EVENTS.TASK_FAILED, ctx.sessionId, node.id, {
                    agentId: node.agentId,
                    error: errMsg,
                })
            }
            const settledNode = scheduler.getNode(node.id)
            if (settledNode) ctx.onTaskUpdate?.(settledNode)
        } finally {
            execution.runningControllers.delete(node.id)
            sessionController.signal.removeEventListener('abort', onSessionAbort)
        }
    }

    /**
     * 带超时调用 Agent.invoke
     *
     * 超时或 abort 时抛出 AbortError。
     */
    private async invokeWithTimeout(
        agent: BaseAgent,
        input: unknown,
        ctx: AgentContext,
        timeoutMs: number,
        controller: AbortController,
    ): Promise<ReturnType<BaseAgent['invoke']>> {
        const signal = controller.signal
        return new Promise((resolve, reject) => {
            let timedOut = false
            const timer = setTimeout(() => {
                // 超时不仅结束等待 Promise，还中止传给 Agent/SDK 的信号，
                // 避免模型调用在编排层已失败后继续占用连接、费用和副作用。
                timedOut = true
                signal.removeEventListener('abort', onAbort)
                controller.abort('node-timeout')
                reject(new Error(`节点超时（${timeoutMs}ms）`))
            }, timeoutMs)
            timer.unref?.()

            const onAbort = () => {
                clearTimeout(timer)
                if (timedOut) return
                reject(new DOMException('Aborted', 'AbortError'))
            }

            if (signal.aborted) {
                onAbort()
                return
            }
            signal.addEventListener('abort', onAbort, { once: true })

            agent.invoke(input, ctx).then(
                (result) => {
                    clearTimeout(timer)
                    signal.removeEventListener('abort', onAbort)
                    resolve(result)
                },
                (err) => {
                    clearTimeout(timer)
                    signal.removeEventListener('abort', onAbort)
                    reject(err)
                },
            )
        })
    }

    /**
     * 等待所有运行中任务完成
     *
     * 通过轮询 runningControllers 大小判断是否全部完成。
     * 简单但可靠，轮询间隔 50ms。
     */
    private async waitForRunningTasks(execution: ActiveExecution): Promise<void> {
        while (execution.runningControllers.size > 0) {
            await sleep(50)
        }
    }

    /**
     * 中止所有运行中任务（用于 session abort）
     */
    private abortAllRunning(execution: ActiveExecution): void {
        for (const controller of execution.runningControllers.values()) {
            controller.abort('session-abort')
        }
    }

    // ─────────────────────────────────────────────────────────
    // 内部：结果构建
    // ─────────────────────────────────────────────────────────

    private buildExecutionResult(execution: ActiveExecution): ExecutionResult {
        const { scheduler, ctx } = execution
        const results = scheduler.collectResults()
        const failedTasks = scheduler.collectFailed()
        const skippedTasks = scheduler.collectSkipped()
        const totalLatencyMs = Date.now() - execution.startedAt

        // 从 billing 聚合本会话真实费用与 token 用量，实现成本闭环
        const sessionBilling = this.billing.aggregateSession(ctx.sessionId)
        const totalCostYuan = sessionBilling.totalCostYuan

        const success = !execution.sessionController.signal.aborted
            && failedTasks.length === 0 && scheduler.isComplete()

        const result: ExecutionResult = {
            sessionId: ctx.sessionId,
            success,
            results,
            failedTasks,
            skippedTasks,
            totalLatencyMs,
            totalCostYuan,
            agentInvocations: execution.agentInvocations,
        }

        // 广播会话结束事件（含成本与 token 用量，供前端观测台展示）
        this.broadcaster.broadcast({
            type: ORCH_EVENTS.SESSION_END,
            timestamp: Date.now(),
            sessionId: ctx.sessionId,
            payload: {
                success,
                failedTasks,
                skippedTasks,
                totalLatencyMs,
                totalCostYuan,
                tokenUsage: sessionBilling.tokenUsage,
            },
        })

        return result
    }

    // ─────────────────────────────────────────────────────────
    // 内部：Prompt 构建
    // ─────────────────────────────────────────────────────────

    private buildParseSystemPrompt(): string {
        const agentsList = AGENT_CAPABILITIES.map(
            (a) => `- ${a.id}: ${a.name} — ${a.description}（输入: ${a.inputHint}）`,
        ).join('\n')

        const constraints = withConstraint([
            '必须输出合法 JSON，不包含任何解释文字、Markdown 标记或代码块包裹',
            'intent 必须从枚举值中选择，无法识别时用 "unknown"',
            'subTasks 数组至少 1 个元素，每个元素含 id / agentId / input / dependencies',
            'agentId 必须严格来自 <available_agents> 清单，禁止编造',
            'dependencies 中的 id 必须在 subTasks 中存在',
            '无依赖关系的任务应并行执行（dependencies 为空数组）',
            '有数据依赖的任务必须显式声明 dependencies',
            '复合任务用 intent="composite"，拆解为多个子任务',
            'input 字段为对象，符合对应 Agent 的输入 schema',
            'confidence 反映解析置信度 0-1',
            'estimatedDurationMs 为预估总耗时（毫秒）',
        ])

        const fewShot = getFewShotBlock('orchestrator.route')

        return `你是诗脉·启明的中央编排官（Prompt v2.0.0），负责将教师的自然语言指令拆解为可执行的子任务 DAG（有向无环图）。

## 核心职责
1. 理解教师指令的真实意图（出题/批改/诊断/报告等）
2. 选择合适的 Agent 组合（每个子任务对应一个 Agent）
3. 设计执行顺序：并行（无依赖）或串行（有依赖）
4. 标注条件分支（可选）

<available_agents>
${agentsList}
</available_agents>

## 意图分类
- generate-questions: 出题（调用 brush.question）
- grade-answers: 批改（调用 brush.grade）
- diagnose-class: 班级诊断（调用 mind.diagnose + mind.profile）
- diagnose-student: 学生诊断（调用 mind.profile + mind.diagnose + mind.recommend）
- generate-report: 教研报告（调用 brush.report，可能依赖 diagnose/grade 结果）
- recommend-path: 推荐路径（调用 mind.recommend，依赖 diagnose 结果）
- vision-annotate: 视觉标注（调用 eye.vision-annotate）
- evaluate-recitation: 朗读评测（调用 eye.asr，可能配合 eye.tts 范读对比）
- generate-tts: 范读生成（调用 eye.tts）
- generate-creative: 创意素材（调用 brush.creative）
- composite: 复合任务（需拆解为多个子任务，如"出题+批改+报告"）

## 输出 JSON 格式
{
  "intent": "generate-questions" | "grade-answers" | ...,
  "subTasks": [
    {
      "id": "t1",
      "agentId": "brush.question",
      "input": { ... },
      "dependencies": []
    }
  ],
  "dependencies": [
    { "from": "t1", "to": "t2" }
  ],
  "estimatedDurationMs": 30000,
  "confidence": 0.85,
  "reasoning": "可选的决策说明"
}

## 路由决策纪律
- agentId 必须严格来自 <available_agents> 清单，禁止编造不存在的 Agent
- 数据依赖须显式声明（如"报告依赖诊断结果"→ t2.dependencies: ["t1"]）
- 无依赖任务须并行（如"出 5 道题 + 生成配图"→ 两个 subTask dependencies 均为空）
- input 字段须符合对应 Agent 的输入 schema（如 brush.question 需 poemId/gradeLevel/questionTypes/bloomWeights/count）
- 复合任务须拆解完整（如"诊断+报告"→ 两个 subTask，不可只输出一个）
- confidence 须反映解析置信度：指令清晰≥0.9，模糊<0.7

${constraints}

${fewShot}`
    }

    private buildParseUserPrompt(
        instruction: string,
        ctx: { teacherId: string; classId?: string },
    ): string {
        const contextBlock = buildContextBlock([
            standardEntry(STANDARD_CONTEXT_TAGS.TASK_INSTRUCTION, '解析教师自然语言指令为可执行的子任务 DAG'),
            { tag: 'teacher_id', content: ctx.teacherId },
            standardEntry(STANDARD_CONTEXT_TAGS.CLASS_CONTEXT, ctx.classId ?? '(未指定)'),
            { tag: 'teacher_instruction', content: instruction },
            standardEntry(STANDARD_CONTEXT_TAGS.OUTPUT_FORMAT, {
                fields: 'intent, subTasks[{id,agentId,input,dependencies}], dependencies[{from,to}], estimatedDurationMs, confidence, reasoning?',
                note: 'agentId 必须来自 available_agents；无依赖任务 dependencies 为空数组',
            }),
        ])

        return `请解析以下教师指令，输出可执行的子任务 DAG。

${contextBlock}

请输出严格 JSON。`
    }

    // ─────────────────────────────────────────────────────────
    // 内部：辅助方法
    // ─────────────────────────────────────────────────────────

    private emitTaskEvent(
        type: string,
        sessionId: string,
        taskId: string,
        payload: Record<string, unknown>,
    ): void {
        this.broadcaster.broadcast({
            type,
            timestamp: Date.now(),
            sessionId,
            payload: { taskId, ...payload },
        })
    }

    private previewInput(input: unknown): string {
        if (typeof input === 'string') return input.slice(0, 200)
        try {
            return JSON.stringify(input).slice(0, 200)
        } catch {
            return '[unserializable input]'
        }
    }

    private getAbortReason(signal: AbortSignal): string | undefined {
        // Node 18+ 支持 signal.reason
        const reason = (signal as { reason?: unknown }).reason
        if (typeof reason === 'string') return reason
        if (reason instanceof Error) return reason.message
        return undefined
    }

    /** 获取活跃执行数（用于诊断） */
    get activeExecutionCount(): number {
        return this.activeExecutions.size
    }
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─────────────────────────────────────────────────────────────
// Agent 扁平化工具
// ─────────────────────────────────────────────────────────────

/**
 * 将三大主 Agent 的子 Agent 扁平化为 Record<string, BaseAgent>
 *
 * 编排官通过 agentId（如 'brush.question'）查找对应子 Agent。
 * 主 Agent（mind/eye/brush）本身不直接调用 LLM，不纳入注册表。
 */
export function flattenAgents(agents: {
    mind: { profile: BaseAgent; diagnose: BaseAgent; recommend: BaseAgent; verify: BaseAgent }
    eye: { visionAnnotate: BaseAgent; asr: BaseAgent; tts: BaseAgent }
    brush: { question: BaseAgent; grade: BaseAgent; report: BaseAgent; creative: BaseAgent }
}): Record<string, BaseAgent> {
    return {
        'mind.profile': agents.mind.profile,
        'mind.diagnose': agents.mind.diagnose,
        'mind.recommend': agents.mind.recommend,
        'mind.verify': agents.mind.verify,
        'eye.vision-annotate': agents.eye.visionAnnotate,
        'eye.asr': agents.eye.asr,
        'eye.tts': agents.eye.tts,
        'brush.question': agents.brush.question,
        'brush.grade': agents.brush.grade,
        'brush.report': agents.brush.report,
        'brush.creative': agents.brush.creative,
    }
}

/** 仅供单测/类型校验使用：导出能力清单 */
export { AGENT_CAPABILITIES, CAPABILITY_INDEX }


