/**
 * AI 副驾路由（Task 13）—— 教师与系统对话的统一入口
 *
 * 所有指令可通过自然语言输入，编排官解析为 DAG 后由教师确认执行。
 *
 * 架构（薄封装 + 会话消息存储）：
 *   POST /chat           发送消息 → 编排官解析 → 返回 plan（执行由 /api/orchestrator/execute 触发）
 *   GET  /sessions       列出历史会话（按 teacherId 过滤）
 *   GET  /sessions/:id   查询会话详情（含完整消息流与编排日志）
 *   POST /quick-action   快捷指令（预填消息模板，附带 sessionId）
 *   POST /feedback       教师反馈（写入自我进化引擎）
 *
 * 设计说明：
 * - copilot 会话与 orchestration session 共用同一 id（chat 时同时创建两者）
 * - 聊天消息维护在内存 Map<sessionId, CopilotMessage[]> 中，LRU 上限 500 会话
 * - 解析与执行分离：chat 仅解析，教师审查 plan 后由前端调用 orchestrator/execute
 * - 全部事件通过 broadcaster 推送 WebSocket，前端实时可视化
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Orchestrator } from '../orchestrator/Orchestrator.js'
import type { SessionStore } from '../orchestrator/session-store.js'
import type { InterventionManager } from '../orchestrator/intervention.js'
import type { WSBroadcaster } from '../orchestrator/websocket/broadcaster.js'
import type { TraceStore } from '../observability/trace-store.js'
import {
    ORCH_EVENTS,
    type ParsedInstruction,
    type SessionStatus,
    type WSEvent,
} from '../orchestrator/types.js'
import { handleRouteError } from './_helpers.js'
import { validateBody, validateParams, validateQuery, schemas } from '../lib/validation.js'
// 持久化存储：原内存 Map<string, CopilotSessionState> → SQLite copilot_sessions 表
import { SqliteMap } from '../db/runtime-store.js'
// LLM 抽象层：B2.1 流式管道接通真 LLM（deepseek-v4-flash）
import { router as llmRouter } from '../llm/index.js'
import type { ChatChunk, ChatMessage, ThinkingMode } from '../llm/types.js'
import { config } from '../config.js'
import { bindSseDisconnectAbort, createPublicSseError, writeSseFrame } from '../lib/sse.js'
// 数据仓储层：Thinking Palace 思考链持久化
import { repos } from '../db/index.js'
// Thinking Palace 思考链节点切分器（将 reasoning 文本切分为带类型的节点数组）
import { splitReasoningIntoNodes } from '../db/repositories/thinking-chain.repository.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 消息角色 */
export type CopilotMessageRole = 'user' | 'assistant' | 'system'

/** 聊天消息 */
export interface CopilotMessage {
    id: string
    role: CopilotMessageRole
    content: string
    timestamp: number
    /** 涉及的 Agent id 列表 */
    agentInvolved?: string[]
    /** 是否 AI 生成 */
    aiGenerated?: boolean
}

/** 会话摘要（列表用） */
export interface CopilotSessionSummary {
    id: string
    title: string
    lastMessage: string
    updatedAt: number
}

/** 会话详情 */
export interface CopilotSessionDetail {
    id: string
    messages: CopilotMessage[]
    orchestrationLog: WSEvent[]
    createdAt: number
    status: SessionStatus
}

/** quick-action 请求体 */
interface QuickActionBody {
    action:
    | 'generate-questions'
    | 'grade-answers'
    | 'diagnose-class'
    | 'generate-report'
    | 'prepare-lesson'
    | 'create-materials'
    params?: {
        classId?: string
        poemId?: string
        studentId?: string
        [key: string]: unknown
    }
    teacherId?: string
}

// ─────────────────────────────────────────────────────────────
// Zod schemas（B6.3 输入校验）
// ─────────────────────────────────────────────────────────────

/** POST /chat 请求体 */
const chatSchema = z.object({
    message: schemas.sanitizedString(5000),
    sessionId: schemas.sessionId.optional(),
    classId: schemas.classId.optional(),
    teacherId: schemas.teacherId.optional(),
    context: z
        .object({
            currentPage: schemas.optionalSanitizedString(200),
            selectedPoemId: schemas.optionalSanitizedString(128),
            selectedClassId: schemas.optionalSanitizedString(128),
        })
        .optional(),
})

/** GET /sessions 查询参数 */
const sessionsQuerySchema = z.object({
    teacherId: schemas.optionalSanitizedString(128),
})

/** GET/DELETE /sessions/:id 路径参数 */
const sessionIdParamsSchema = z.object({ id: schemas.sessionId })

/** POST /quick-action 请求体 */
const quickActionSchema = z.object({
    action: z.enum([
        'generate-questions',
        'grade-answers',
        'diagnose-class',
        'generate-report',
        'prepare-lesson',
        'create-materials',
    ]),
    params: z
        .object({
            classId: schemas.optionalSanitizedString(128),
            poemId: schemas.optionalSanitizedString(128),
            studentId: schemas.optionalSanitizedString(128),
        })
        .passthrough()
        .optional(),
    teacherId: schemas.optionalSanitizedString(128),
})

/** POST /feedback 请求体 */
const feedbackSchema = z.object({
    sessionId: schemas.sessionId,
    taskId: schemas.optionalSanitizedString(128),
    agentId: schemas.optionalSanitizedString(128),
    feedbackType: z.enum(['good', 'bad', 'correction']),
    content: schemas.sanitizedString(5000),
})

/**
 * POST /stream-chat 请求体（B2.1 真流式 SSE 端点）
 *
 * 与 /chat 不同：/stream-chat 直接走 LLM 流式输出，不经编排官解析。
 * 用于教师自由对话场景，messages 数组承载完整对话上下文。
 */
const streamChatSchema = z.object({
    /** 对话消息数组（OpenAI ChatCompletion 兼容格式） */
    messages: z
        .array(
            z.object({
                role: z.enum(['system', 'user', 'assistant', 'tool']),
                content: schemas.sanitizedString(20000),
                name: schemas.optionalSanitizedString(128),
                tool_call_id: schemas.optionalSanitizedString(128),
            }),
        )
        .min(1, 'messages 不能为空')
        .max(100, 'messages 不能超过 100 条'),
    /** 会话 ID（可选，仅用于计费追踪，不影响 LLM 调用） */
    sessionId: schemas.sessionId.optional(),
    /** 教师 ID（可选，用于计费追踪） */
    teacherId: schemas.teacherId.optional(),
    /** 采样温度 0-2，默认 0.7 */
    temperature: z.number().min(0).max(2).optional(),
    /** 最大输出 token，默认 2048（流式场景不宜过大） */
    maxTokens: z.number().int().positive().max(8192).optional(),
})

/**
 * POST /thinking-mode 请求体（v5.0 创新点：深度思考模式 UI 暴露）
 *
 * 全局思考模式覆盖：教师通过 ThinkingModeSwitcher 控制所有 LLM 调用的思考深度。
 * - 'low'    : 低速思考，响应最快（适合批量批改、摘要等高频任务）
 * - 'medium' : 中速思考，平衡速度与深度（适合推荐、画像等中等复杂度任务）
 * - 'high'   : 高速思考，深度推理（适合诊断、验收等需要严谨分析的任务）
 * - 'max'    : 超高思考，仅 deepseek-v4-pro 支持（适合命题、复杂认知诊断）
 * - undefined: 清除覆盖，恢复路由矩阵预设
 *
 * 约束（大模型API文档.md）：
 * - max 模式仅 deepseek-v4-pro 支持，其他模型调用 max 会抛出校验错误
 * - 路由器在 max 模式下会强制将所有任务路由到 deepseek-v4-pro
 */
const setThinkingModeSchema = z.object({
    mode: z.enum(['low', 'medium', 'high', 'max']).nullable(),
})

/** GET /thinking-chains 查询参数 */
const thinkingChainsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    agentId: schemas.optionalSanitizedString(128),
    sessionId: schemas.optionalSanitizedString(128),
})

/** GET /thinking-chains/:id 路径参数 */
const thinkingChainIdParamsSchema = z.object({ id: schemas.id })

// ─────────────────────────────────────────────────────────────
// 聊天会话存储（SQLite 持久化，重启不丢失）
// 原 Map<string, CopilotSessionState> → SqliteMap<string, CopilotSessionState>
// 表：copilot_sessions（key=sessionId, value=JSON, teacher_id 索引）
// ─────────────────────────────────────────────────────────────

interface CopilotSessionState {
    id: string
    teacherId: string
    title: string
    messages: CopilotMessage[]
    /** 关联的 orchestration sessionId（与 copilot id 一致） */
    orchestrationSessionId?: string
    createdAt: number
    updatedAt: number
}

const MAX_COPILOT_SESSIONS = 500
const MAX_MESSAGES_PER_SESSION = 1000

class CopilotSessionStore {
    // SqliteMap 持久化：写入立即落盘，LRU 上限 500 会话
    private readonly sessions = new SqliteMap<string, CopilotSessionState>({
        table: 'copilot_sessions',
        indexes: [{ name: 'teacher_id', extract: (v) => v.teacherId }],
        maxSize: MAX_COPILOT_SESSIONS,
    })

    create(id: string, teacherId: string, firstMessage: string): CopilotSessionState {
        const session: CopilotSessionState = {
            id,
            teacherId,
            title: deriveTitle(firstMessage),
            messages: [],
            // copilot 会话与 orchestration session 共用同一 id
            orchestrationSessionId: id,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }
        this.sessions.set(id, session)
        return session
    }

    get(id: string): CopilotSessionState | undefined {
        const session = this.sessions.get(id)
        if (!session) return undefined
        // LRU 更新：重新 set 触发 updated_at 刷新（SqliteMap 内部保留 created_at）
        this.sessions.set(id, session)
        return session
    }

    appendMessage(id: string, message: CopilotMessage): void {
        const session = this.sessions.get(id)
        if (!session) return
        session.messages.push(message)
        if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
            session.messages.splice(0, session.messages.length - MAX_MESSAGES_PER_SESSION)
        }
        session.updatedAt = message.timestamp
        // 用最新用户消息刷新标题（仅当首条消息时）
        if (session.messages.length === 1 && message.role === 'user') {
            session.title = deriveTitle(message.content)
        }
        // 关键：mutation 后必须显式 set() 才能落盘
        // （SqliteMap.get() 返回的是新对象，修改不会自动持久化）
        this.sessions.set(id, session)
    }

    listByTeacher(teacherId: string): CopilotSessionState[] {
        // 使用 teacher_id 索引加速查询（避免全表扫描）
        const result = this.sessions
            .findByIndex('teacher_id', teacherId)
            .map((r) => r.value)
        result.sort((a, b) => b.updatedAt - a.updatedAt)
        return result
    }

    delete(id: string): boolean {
        return this.sessions.delete(id)
    }
}

/** 从消息内容派生会话标题（截断前 24 字符） */
function deriveTitle(message: string): string {
    const trimmed = message.trim().replace(/\s+/g, ' ')
    return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed
}

// ─────────────────────────────────────────────────────────────
// 快捷指令模板
// ─────────────────────────────────────────────────────────────

const QUICK_ACTION_TEMPLATES: Record<QuickActionBody['action'], (params: QuickActionBody['params']) => string> = {
    'generate-questions': (p) =>
        `帮我为${p?.poemId ? `诗篇 ${p.poemId} ` : ''}出 5 道题，覆盖六阶认知层级${p?.classId ? `，面向班级 ${p.classId}` : ''
        }。`,
    'grade-answers': () => '分析本周答题情况，调用诗笔批改并给出认知归因。',
    'diagnose-class': (p) =>
        `诊断${p?.classId ? `班级 ${p.classId} ` : ''}的认知暗物质，识别布鲁姆失衡与知识盲区。`,
    'generate-report': () => '生成本周教研报告，汇总班级诊断与批改结果。',
    'prepare-lesson': (p) =>
        `为${p?.poemId ? `诗篇 ${p.poemId} ` : ''}设计一节课，包含导入、六阶推进与拓展。`,
    'create-materials': (p) =>
        `为${p?.poemId ? `诗篇 ${p.poemId} ` : ''}生成配图描述与创意素材。`,
}

// ─────────────────────────────────────────────────────────────
// Agent id → 中文标签映射（用于 assistant 消息水印）
// ─────────────────────────────────────────────────────────────

const AGENT_LABELS: Record<string, string> = {
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

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

export interface CopilotRoutesOptions {
    orchestrator: Orchestrator
    sessionStore: SessionStore
    intervention: InterventionManager
    broadcaster: WSBroadcaster
    traceStore: TraceStore
}

export const copilotRoutes: FastifyPluginAsync<CopilotRoutesOptions> = async (
    app: FastifyInstance,
    opts: CopilotRoutesOptions,
) => {
    const { orchestrator, sessionStore, intervention, broadcaster, traceStore } = opts
    const copilotStore = new CopilotSessionStore()

    // ── POST /chat — 发送消息，解析指令 ──
    app.post('/chat', async (req: FastifyRequest, reply) => {
        const body = validateBody(chatSchema, req, reply)
        if (!body) return

        const {
            message,
            sessionId: existingSessionId,
            classId,
            context,
        } = body
        const teacherId = req.auth!.id

        const trimmed = message
        const now = Date.now()

        // 续接会话 or 新建会话
        let copilotSession: CopilotSessionState
        let sessionId: string

        if (existingSessionId) {
            const existing = copilotStore.get(existingSessionId)
            if (!existing) {
                return reply.status(404).send({
                    status: 'error',
                    message: `会话不存在: ${existingSessionId}`,
                })
            }
            if (existing.teacherId !== teacherId) {
                return reply.status(403).send({ status: 'error', message: '会话不属于当前教师' })
            }
            copilotSession = existing
            sessionId = existingSessionId
        } else {
            // 创建 orchestration session（同时作为 copilot session id）
            const orchSession = sessionStore.createSession(teacherId, classId)
            sessionId = orchSession.id
            copilotSession = copilotStore.create(sessionId, teacherId, trimmed)
            copilotSession.orchestrationSessionId = sessionId

            // 广播会话开始
            broadcaster.broadcast({
                type: ORCH_EVENTS.SESSION_START,
                timestamp: now,
                sessionId,
                payload: { teacherId, classId, source: 'copilot' },
            })
        }

        // 追加用户消息
        const userMessage: CopilotMessage = {
            id: randomUUID(),
            role: 'user',
            content: trimmed,
            timestamp: now,
        }
        copilotStore.appendMessage(sessionId, userMessage)

        // 调用编排官解析
        try {
            const plan = await orchestrator.parseInstruction(trimmed, { teacherId, classId })
            sessionStore.setPlan(sessionId, plan)
            sessionStore.setStatus(sessionId, 'planning')
            traceStore.record('orchestrator:plan:created', {
                sessionId,
                timestamp: Date.now(),
            })

            // 生成 assistant 消息（解析摘要）
            const summaryLines = buildPlanSummary(plan)
            const assistantContent = summaryLines.join('\n')
            const assistantMessage: CopilotMessage = {
                id: randomUUID(),
                role: 'assistant',
                content: assistantContent,
                timestamp: Date.now(),
                agentInvolved: ['orchestrator', ...plan.estimatedAgents],
                aiGenerated: true,
            }
            copilotStore.appendMessage(sessionId, assistantMessage)

            // 广播解析完成事件
            broadcaster.broadcast({
                type: ORCH_EVENTS.INSTRUCTION_PARSED,
                timestamp: Date.now(),
                sessionId,
                payload: {
                    intent: plan.intent,
                    subTaskCount: plan.subTasks.length,
                    estimatedAgents: plan.estimatedAgents,
                    confidence: plan.confidence,
                    context,
                },
            })

            return reply.send({
                status: 'ok',
                sessionId,
                parsedInstruction: plan,
                copilotStatus: 'planning' as const,
            })
        } catch (err) {
            req.log.error({ err, path: req.url }, 'AI 副驾解析失败')

            // 追加错误 assistant 消息（静态文案，不暴露内部错误）
            const errorMessage: CopilotMessage = {
                id: randomUUID(),
                role: 'system',
                content: '解析失败，请尝试重新描述您的需求。',
                timestamp: Date.now(),
            }
            copilotStore.appendMessage(sessionId, errorMessage)

            sessionStore.setStatus(sessionId, 'aborted')

            handleRouteError(err, req, reply, 'AI 副驾解析失败')
            return
        }
    })

    // ── GET /sessions — 列出历史会话 ──
    app.get('/sessions', async (req: FastifyRequest, reply) => {
        const query = validateQuery(sessionsQuerySchema, req, reply)
        if (!query) return
        const teacherId = req.auth!.id
        const sessions = copilotStore.listByTeacher(teacherId)

        const summaries: CopilotSessionSummary[] = sessions.map((s) => {
            const lastMsg = s.messages.length > 0 ? s.messages[s.messages.length - 1] : null
            return {
                id: s.id,
                title: s.title,
                lastMessage: lastMsg ? truncate(lastMsg.content, 60) : '（空会话）',
                updatedAt: s.updatedAt,
            }
        })

        return reply.send({
            status: 'ok',
            sessions: summaries,
        })
    })

    // ── GET /sessions/:id — 查询会话详情 ──
    app.get('/sessions/:id', async (req: FastifyRequest, reply) => {
        const params = validateParams(sessionIdParamsSchema, req, reply)
        if (!params) return
        const { id } = params
        const copilotSession = copilotStore.get(id)
        if (!copilotSession) {
            return reply.status(404).send({
                status: 'error',
                message: `会话不存在: ${id}`,
            })
        }
        if (copilotSession.teacherId !== req.auth!.id) {
            return reply.status(403).send({ status: 'error', message: '会话不属于当前教师' })
        }

        const orchSession = sessionStore.getSession(id)
        const orchestrationLog: WSEvent[] = orchSession ? orchSession.events.slice(-200) : []

        const detail: CopilotSessionDetail = {
            id,
            messages: copilotSession.messages,
            orchestrationLog,
            createdAt: copilotSession.createdAt,
            status: orchSession ? orchSession.status : 'idle',
        }

        return reply.send({
            status: 'ok',
            session: detail,
        })
    })

    // ── DELETE /sessions/:id — 删除会话 ──
    app.delete('/sessions/:id', async (req: FastifyRequest, reply) => {
        const params = validateParams(sessionIdParamsSchema, req, reply)
        if (!params) return
        const { id } = params
        const existing = copilotStore.get(id)
        if (!existing) {
            return reply.status(404).send({ status: 'error', message: `会话不存在: ${id}` })
        }
        if (existing.teacherId !== req.auth!.id) {
            return reply.status(403).send({ status: 'error', message: '会话不属于当前教师' })
        }
        copilotStore.delete(id)
        sessionStore.deleteSession(id)
        return reply.send({ status: 'ok', deleted: id })
    })

    // ── POST /quick-action — 快捷指令 ──
    app.post('/quick-action', async (req: FastifyRequest, reply) => {
        const body = validateBody(quickActionSchema, req, reply)
        if (!body) return

        const { action, params = {} } = body
        const teacherId = req.auth!.id

        const templateFn = QUICK_ACTION_TEMPLATES[action]
        if (!templateFn) {
            return reply.status(400).send({
                status: 'error',
                message: `未知的快捷指令: ${action}`,
            })
        }

        const prefillMessage = templateFn(params)

        // 预创建会话，返回 sessionId
        const orchSession = sessionStore.createSession(teacherId, params.classId)
        const copilotSession = copilotStore.create(orchSession.id, teacherId, prefillMessage)
        copilotSession.orchestrationSessionId = orchSession.id

        return reply.send({
            status: 'ok',
            sessionId: orchSession.id,
            prefillMessage,
        })
    })

    // ── POST /feedback — 教师反馈 ──
    app.post('/feedback', async (req: FastifyRequest, reply) => {
        const body = validateBody(feedbackSchema, req, reply)
        if (!body) return

        const { sessionId, taskId = '', agentId = '', feedbackType, content } = body

        try {
            intervention.recordFeedback({
                sessionId,
                taskId,
                agentId,
                feedbackType,
                content,
                timestamp: Date.now(),
            })

            // 追加系统消息记录反馈
            const copilotSession = copilotStore.get(sessionId)
            if (copilotSession) {
                const feedbackLabel = feedbackType === 'good' ? '好评' : feedbackType === 'bad' ? '差评' : '修正建议'
                copilotStore.appendMessage(sessionId, {
                    id: randomUUID(),
                    role: 'system',
                    content: `已记录教师反馈（${feedbackLabel}）。自我进化引擎将据此优化后续编排。`,
                    timestamp: Date.now(),
                })
            }

            return reply.send({ status: 'ok', message: '反馈已记录', sessionId })
        } catch (err) {
            req.log.error({ err, path: req.url }, 'AI 副驾反馈记录失败')
            handleRouteError(err, req, reply, '反馈记录失败')
            return
        }
    })

    // ── GET /agent-labels — Agent 中文标签（前端水印用） ──
    app.get('/agent-labels', async (_req, reply) => {
        return reply.send({ status: 'ok', labels: AGENT_LABELS })
    })

    // ─────────────────────────────────────────────────────────────
    // B2.1 真流式 SSE 端点：POST /stream-chat
    // ─────────────────────────────────────────────────────────────
    //
    // 设计目标：打通 LLM → SSE → 前端 的真流式管道，替代 Typewriter 伪流式。
    //
    // 数据流：
    //   前端 fetch POST → 后端 reply.hijack() 接管 raw response
    //   → llmRouter.executeStream('orchestrator', 'summarize', ...) 走 deepseek-v4-flash
    //   → 逐 ChatChunk 写入 `data: {...}\n\n` SSE 帧
    //   → 完成写入 `data: [DONE]\n\n` 后 reply.raw.end()
    //
    // 关键约束：
    //   - 使用 deepseek-v4-flash（路由矩阵 'orchestrator:summarize' 已映射）
    //   - 输入校验复用 validation.ts sanitizedString
    //   - 不破坏现有 /chat（并行端点，原 /chat 保持不变）
    //   - 错误降级：API key 缺失、网络中断、LLM 调用失败均通过 SSE 错误帧返回
    //   - 客户端断开：监听 req.raw 'close' 事件，触发 AbortSignal 中止 LLM 流
    app.post('/stream-chat', async (req: FastifyRequest, reply) => {
        // 1. 校验请求体
        const body = validateBody(streamChatSchema, req, reply)
        if (!body) return

        // 2. API 密钥可用性预检（避免流式握手后才 401）
        // 演示模式（DEMO_MODE=true）下给出明确错误而非空转
        if (!config.deepseek.apiKey && !config.demoMode) {
            return reply.code(503).send({
                status: 'error',
                error: 'LLM_NOT_CONFIGURED',
                message: 'DeepSeek API 密钥未配置，无法启用流式输出。请在 .env 中设置 DEEPSEEK_API_KEY。',
            })
        }
        if (config.demoMode && !config.deepseek.apiKey) {
            return reply.code(503).send({
                status: 'error',
                error: 'LLM_NOT_CONFIGURED',
                message: '演示模式下未配置真实 API 密钥，流式端点不可用。请配置 DEEPSEEK_API_KEY 后重试。',
            })
        }

        const { messages, sessionId, temperature, maxTokens } = body
        const teacherId = req.auth!.id

        // 3. 接管 Fastify 响应，手动写入 SSE 流
        // reply.hijack() 告知 Fastify "我将自行处理响应"，框架不再自动 send
        reply.hijack()

        const raw = reply.raw
        // 写入 SSE 响应头
        raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, private, no-store, no-transform',
            Connection: 'keep-alive',
            // 禁用 Nginx/CDN 缓冲，确保分片实时透传
            'X-Accel-Buffering': 'no',
            // CORS：开发期前后端跨域（生产期同源亦无害）
            'Access-Control-Allow-Origin': '*',
        })

        // 4. 客户端断开检测：请求被中止或响应连接关闭时均中止上游 LLM 流。
        const abortController = new AbortController()
        const removeDisconnectHandlers = bindSseDisconnectAbort(req.raw, raw, abortController)
        const writeSSE = (payload: unknown) => writeSseFrame(raw, payload, abortController.signal)

        try {
            // 6. 调用 LLM 路由器流式接口
            // 路由矩阵 'orchestrator:summarize' → deepseek-v4-flash + low thinking
            // 满足"使用 deepseek-v4-flash"约束，且具备限流/错误恢复/计费/事件桥接
            const chatMessages: ChatMessage[] = messages.map((m) => ({
                role: m.role,
                content: m.content,
                ...(m.name ? { name: m.name } : {}),
                ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
            }))

            // Thinking Palace：累积 reasoning 与 content 分片，流式结束后持久化为思考链
            const reasoningParts: string[] = []
            const contentParts: string[] = []
            const streamStartTime = Date.now()
            let lastUsage: { promptTokens?: number; completionTokens?: number } | null = null
            let completedForClient = false

            const stream = llmRouter.executeStream('orchestrator', 'summarize', {
                messages: chatMessages,
                temperature: temperature ?? 0.7,
                maxTokens: maxTokens ?? 2048,
                signal: abortController.signal,
                metadata: {
                    agent: 'copilot',
                    task: 'stream-chat',
                    sessionId,
                },
            })

            // 7. 逐分片写入 SSE 帧
            for await (const chunk of stream) {
                if (abortController.signal.aborted) break
                // executeStream 返回 AsyncGenerator<unknown>，实际 yield ChatChunk
                const chatChunk = chunk as ChatChunk
                // 累积 reasoning 与 content（供思考链持久化）
                if (chatChunk.reasoning) reasoningParts.push(chatChunk.reasoning)
                if (chatChunk.content) contentParts.push(chatChunk.content)
                if (chatChunk.usage) lastUsage = chatChunk.usage
                const { reasoning: privateReasoning, ...publicChunk } = chatChunk
                void privateReasoning
                if (!await writeSSE(publicChunk)) {
                    // 背压超时、写入失败或客户端断开：停止上游，而不是积压或落库半截推理。
                    if (!abortController.signal.aborted) abortController.abort()
                    break
                }
            }

            // 8. 只有所有内容和结束帧都真正交付给仍连接的客户端，才可视为完成。
            if (!abortController.signal.aborted) {
                completedForClient = await writeSSE('[DONE]')
                if (!completedForClient && !abortController.signal.aborted) abortController.abort()
            }

            // Thinking Palace：仅持久化完整、已交付会话的思考链。断连/背压失败意味着
            // 用户撤回了本次流，不得把部分 reasoning 伪装为一条已完成的交互记录。
            const reasoning = reasoningParts.join('')
            if (completedForClient && !abortController.signal.aborted && reasoning.length > 0) {
                const content = contentParts.join('')
                // 安全提取用户问题文本：ChatMessage.content 可能是 string | ContentPart[]，
                // 此处 schema 已校验为 sanitizedString，运行时恒为 string，做类型守卫确保类型安全
                const userContent = chatMessages.find((m) => m.role === 'user')?.content
                const question = typeof userContent === 'string' ? userContent.slice(0, 500) : ''
                const nodes = splitReasoningIntoNodes(reasoning)
                const durationMs = Date.now() - streamStartTime
                // 路由矩阵 'orchestrator:summarize' 对应 deepseek-v4-flash + low thinking
                const model = 'deepseek-v4-flash'
                const thinkingMode: ThinkingMode = 'low'
                try {
                    repos.thinkingChains.create({
                        agentId: 'copilot',
                        sessionId: sessionId ?? `ephemeral-${Date.now()}`,
                        question,
                        reasoning,
                        answer: content || null,
                        nodes,
                        thinkingMode,
                        durationMs,
                        model,
                        promptTokens: lastUsage?.promptTokens ?? 0,
                        completionTokens: lastUsage?.completionTokens ?? 0,
                        metadata: { source: 'stream-chat', teacherId: teacherId ?? null },
                    })
                } catch (persistErr) {
                    req.log.debug({ err: persistErr, path: req.url }, '思考链持久化失败（非阻塞）')
                }
            }

            // 记录成功日志（不含用户内容，避免日志泄漏）
            req.log.info(
                { path: req.url, sessionId, teacherId, model: 'deepseek-v4-flash' },
                'SSE 流式输出完成',
            )
        } catch (err) {
            // 9. 错误处理：通过 SSE 错误帧返回（而非 HTTP 500，因头部已发送）
            // AbortError 是客户端主动断开导致的，不算服务端错误，仅 debug 日志
            if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
                req.log.debug({ path: req.url, sessionId }, 'LLM 流被客户端中止')
            } else {
                req.log.error({ err, path: req.url, sessionId }, 'SSE 流式输出失败')
                await writeSSE(createPublicSseError('LLM_STREAM_FAILED', err))
            }
        } finally {
            // 10. 清理同一注册对象上的全部断连监听器，结束响应。
            removeDisconnectHandlers()
            if (!raw.writableEnded) {
                raw.end()
            }
        }
    })

    // ─────────────────────────────────────────────────────────────
    // Thinking Palace 端点：思考链查询
    // ─────────────────────────────────────────────────────────────

    // ── GET /thinking-chains — 思考链列表（最近优先） ──
    app.get('/thinking-chains', async (req: FastifyRequest, reply) => {
        const query = validateQuery(thinkingChainsQuerySchema, req, reply)
        if (!query) return
        const { limit, agentId, sessionId } = query

        try {
            let chains
            if (agentId) {
                chains = repos.thinkingChains.findByAgentId(agentId, limit)
            } else if (sessionId) {
                chains = repos.thinkingChains.findBySessionId(sessionId, limit)
            } else {
                chains = repos.thinkingChains.findRecent(limit)
            }
            return reply.send({
                status: 'ok',
                chains,
                aiGenerated: false as const,
            })
        } catch (err) {
            req.log.error({ err, path: req.url }, '思考链列表查询失败')
            return reply.send({
                status: 'ok',
                chains: [],
                aiGenerated: false as const,
            })
        }
    })

    // ── GET /thinking-chains/:id — 思考链详情 ──
    app.get('/thinking-chains/:id', async (req: FastifyRequest, reply) => {
        const params = validateParams(thinkingChainIdParamsSchema, req, reply)
        if (!params) return
        const { id } = params

        try {
            const chain = repos.thinkingChains.findById(id)
            if (!chain) {
                return reply.code(404).send({
                    status: 'error',
                    error: 'NOT_FOUND',
                    message: '思考链不存在',
                })
            }
            return reply.send({
                status: 'ok',
                chain,
                aiGenerated: false as const,
            })
        } catch (err) {
            req.log.error({ err, path: req.url, id }, '思考链详情查询失败')
            handleRouteError(err, req, reply, '思考链详情查询失败')
            return
        }
    })

    // ─────────────────────────────────────────────────────────────
    // v5.0 创新点：深度思考模式 UI 暴露
    // ─────────────────────────────────────────────────────────────
    //
    // 设计目标：教师通过 ThinkingModeSwitcher 全局覆盖 LLM 思考深度。
    //
    // 数据流：
    //   前端 POST /api/copilot/thinking-mode { mode: 'max' }
    //   → llmRouter.setThinkingMode('max')
    //   → 路由器 resolve() 时应用覆盖：max → 强制 deepseek-v4-pro
    //   → broadcaster 广播 thinking-mode:changed 事件
    //   → 前端所有 LLM 调用即时切换到新思考模式
    //
    // 约束（大模型API文档.md）：
    //   - max 模式仅 deepseek-v4-pro 支持，路由器自动强制模型
    //   - low/medium/high 任意模型均支持
    //   - 传入 null 清除覆盖，恢复路由矩阵预设

    // ── GET /thinking-mode — 获取当前全局思考模式 ──
    app.get('/thinking-mode', async (_req, reply) => {
        const mode = llmRouter.getThinkingMode()
        return reply.send({
            status: 'ok',
            mode: mode ?? null,
            aiGenerated: false as const,
        })
    })

    // ── POST /thinking-mode — 设置全局思考模式覆盖 ──
    app.post('/thinking-mode', async (req: FastifyRequest, reply) => {
        const body = validateBody(setThinkingModeSchema, req, reply)
        if (!body) return

        const { mode } = body
        // null 表示清除覆盖，恢复路由矩阵预设
        const nextMode: ThinkingMode | undefined = mode ?? undefined

        try {
            llmRouter.setThinkingMode(nextMode)

            // 广播思考模式变更事件（前端 WS 订阅即时刷新 UI）
            broadcaster.broadcast({
                type: 'thinking-mode:changed',
                timestamp: Date.now(),
                sessionId: 'global',
                payload: {
                    mode: nextMode ?? null,
                    changedAt: Date.now(),
                },
            })

            const modeLabel = nextMode
                ? { low: '轻度', medium: '中', high: '高', max: '超高（仅 deepseek-v4-pro）' }[nextMode]
                : '默认（路由矩阵预设）'

            req.log.info(
                { path: req.url, mode: nextMode ?? 'default' },
                `全局思考模式已切换为：${modeLabel}`,
            )

            return reply.send({
                status: 'ok',
                mode: nextMode ?? null,
                message: `思考模式已切换为：${modeLabel}`,
                aiGenerated: false as const,
            })
        } catch (err) {
            req.log.error({ err, path: req.url, mode: nextMode }, '思考模式设置失败')
            handleRouteError(err, req, reply, '思考模式设置失败')
            return
        }
    })
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

/** 将解析计划转为可读的 Markdown 摘要 */
function buildPlanSummary(plan: ParsedInstruction): string[] {
    const lines: string[] = []
    const intentLabel = INTENT_LABELS[plan.intent] ?? plan.intent
    lines.push(`**已解析您的指令** — 意图：${intentLabel}（置信度 ${(plan.confidence * 100).toFixed(0)}%）`)
    lines.push('')
    lines.push(`预计涉及 **${plan.estimatedAgents.length}** 个 Agent，耗时约 **${(plan.estimatedDurationMs / 1000).toFixed(1)}s**。`)
    lines.push('')
    lines.push('### 子任务拆解')
    for (const sub of plan.subTasks) {
        const label = AGENT_LABELS[sub.agentId] ?? sub.agentId
        const deps = sub.dependencies.length > 0 ? `（依赖 ${sub.dependencies.join(', ')}）` : ''
        lines.push(`- **${label}** \`${sub.id}\`${deps}`)
    }
    lines.push('')
    lines.push('> 请在右侧编排面板审查计划，确认后点击"确认执行"。')
    return lines
}

const INTENT_LABELS: Record<string, string> = {
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

/** 截断字符串 */
function truncate(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max)}…` : s
}
