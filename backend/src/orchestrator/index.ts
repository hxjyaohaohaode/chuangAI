/**
 * 编排官 barrel export
 *
 * 统一导出编排官全部模块与单例。
 *
 * 架构：
 *   ┌──────────────────────────────────────────────────────┐
 *   │  REST API（routes.ts）                                │
 *   │  POST /parse /execute /pause /resume /abort /modify  │
 *   │  GET  /sessions/:id                                   │
 *   ├──────────────────────────────────────────────────────┤
 *   │  WebSocket（websocket/handlers.ts）                   │
 *   │  /ws/orchestrator                                     │
 *   ├──────────────────────────────────────────────────────┤
 *   │  InterventionManager（介入管理器）                    │
 *   │  pause / resume / abortSession / modifyAndRerun      │
 *   ├──────────────────────────────────────────────────────┤
 *   │  Orchestrator（中央编排官）                            │
 *   │  parseInstruction / execute / reflect                │
 *   │  pause / resume / abort / modify                     │
 *   ├──────────────────────────────────────────────────────┤
 *   │  DAGScheduler（DAG 调度器）                            │
 *   │  topologicalSort / getReadyNodes / markDone          │
 *   ├──────────────────────────────────────────────────────┤
 *   │  EventBridge（事件桥接器）                             │
 *   │  LLM/Agent/Billing 事件 → WSBroadcaster              │
 *   ├──────────────────────────────────────────────────────┤
 *   │  WSBroadcaster（WebSocket 广播器）                    │
 *   │  registerConnection / broadcast                      │
 *   ├──────────────────────────────────────────────────────┤
 *   │  SessionStore（会话存储，LRU 1000 sessions）          │
 *   └──────────────────────────────────────────────────────┘
 *
 * 初始化流程（在 server.ts 中调用）：
 *   const { orchestrator, broadcaster, intervention, eventBridge } = initOrchestrator(app)
 *   await app.register(orchestratorRoutes, { prefix: '/api/orchestrator', ... })
 *   await app.register(orchestratorWSPlugin, { ... })
 */

import type { FastifyInstance } from 'fastify'
import { router } from '../llm/index.js'
import { errorRecovery } from '../llm/index.js'
import { billing } from '../llm/index.js'
import { agents } from '../agents/index.js'
import { agentEvents, AGENT_EVENTS } from '../agents/base/events.js'
import { evolutionEngine } from '../agents/base/evolution-engine.js'
import { ProactiveIntelligence, proactiveIntelligence } from '../agents/base/proactive-intelligence.js'
import { Orchestrator, flattenAgents } from './Orchestrator.js'
import { WSBroadcaster } from './websocket/broadcaster.js'
import { InterventionManager } from './intervention.js'
import { SessionStore, sessionStore } from './session-store.js'
import { EventBridge } from './event-bridge.js'
import { TraceStore, traceStore } from '../observability/trace-store.js'

// ─────────────────────────────────────────────────────────────
// 类型导出
// ─────────────────────────────────────────────────────────────

export type {
    Intent,
    SubTask,
    SubTaskStatus,
    SubTaskCondition,
    DAGEdge,
    DAG,
    ParsedInstruction,
    OrchestratorContext,
    AgentInvocation,
    ExecutionResult,
    Reflection,
    SessionStatus,
    SessionState,
    WSEvent,
    WSSubscriptionFilter,
    FeedbackType,
    TeacherFeedback,
    OrchEventName,
    AgentInvokeFn,
} from './types.js'

export { ORCH_EVENTS } from './types.js'

// ─────────────────────────────────────────────────────────────
// 类导出
// ─────────────────────────────────────────────────────────────

export { Orchestrator, flattenAgents } from './Orchestrator.js'
export { DAGScheduler, DAGErr, VALID_TRANSITIONS } from './dag-scheduler.js'
export { WSBroadcaster } from './websocket/broadcaster.js'
export { orchestratorWSPlugin } from './websocket/handlers.js'
export type { OrchestratorWSPluginOptions } from './websocket/handlers.js'
export { InterventionManager } from './intervention.js'
export { SessionStore, sessionStore } from './session-store.js'
export { EventBridge } from './event-bridge.js'
export { TraceStore, traceStore } from '../observability/trace-store.js'
export { orchestratorRoutes } from './routes.js'
export type { OrchestratorRoutesOptions } from './routes.js'

// ─────────────────────────────────────────────────────────────
// 初始化函数
// ─────────────────────────────────────────────────────────────

/**
 * 初始化编排官全套组件
 *
 * 在 server.ts 中调用，注入 fastify 实例后返回：
 * - orchestrator  : 中央编排官
 * - broadcaster   : WebSocket 广播器
 * - intervention  : 教师介入管理器
 * - eventBridge   : 事件桥接器（LLM/Agent/Billing → WS）
 *
 * 注意：此函数必须在 @fastify/websocket 插件注册后调用。
 *
 * @example
 * ```typescript
 * await app.register(websocket, { ... })
 * const orch = initOrchestrator(app)
 * await app.register(orchestratorRoutes, {
 *   prefix: '/api/orchestrator',
 *   ...orch,
 * })
 * await app.register(orchestratorWSPlugin, { ...orch })
 * ```
 */
export function initOrchestrator(fastify: FastifyInstance): {
    orchestrator: Orchestrator
    broadcaster: WSBroadcaster
    intervention: InterventionManager
    eventBridge: EventBridge
    sessionStore: SessionStore
    proactive: ProactiveIntelligence
    traceStore: TraceStore
} {
    const broadcaster = new WSBroadcaster(fastify)
    const flatAgents = flattenAgents(agents)
    const orchestrator = new Orchestrator(router, flatAgents, broadcaster, billing)
    const intervention = new InterventionManager(orchestrator, sessionStore, broadcaster)
    const eventBridge = new EventBridge(router, errorRecovery, billing, agentEvents, broadcaster, traceStore)

    // ── P7：启动自我进化引擎 ──
    // 订阅 grading:review / agent:call:error / agent:verify / agent:call:success 事件，
    // 提炼进化模式，累计达阈值触发 Prompt 进化；A/B 测试候选版本通过 CALL_SUCCESS 追踪表现。
    // 闭环4补全：绑定 broadcaster，使 prompt:evolved / ab-test:won 事件能推送到前端。
    evolutionEngine.attachBroadcaster(broadcaster)
    evolutionEngine.start()

    // ── P7：主动智能 —— 绑定 broadcaster + Agent 调用追踪 ──
    proactiveIntelligence.attachBroadcaster(broadcaster)
    // 订阅 CALL_SUCCESS / CALL_ERROR，统计滑动窗口失败率，
    // 失败率超阈值时触发 checkAgentFailureRate → evolutionEngine.evolvePrompt
    const onAgentCallSuccess = (payload: unknown) => {
        const data = payload as { agentId?: string }
        if (data?.agentId) {
            proactiveIntelligence.recordAgentCall(data.agentId, true)
        }
    }
    const onAgentCallError = (payload: unknown) => {
        const data = payload as { agentId?: string }
        if (data?.agentId) {
            proactiveIntelligence.recordAgentCall(data.agentId, false)
            // 异步触发失败率检查，不阻塞事件流
            void proactiveIntelligence.checkAgentFailureRate(data.agentId)
        }
    }
    agentEvents.on(AGENT_EVENTS.CALL_SUCCESS, onAgentCallSuccess)
    agentEvents.on(AGENT_EVENTS.CALL_ERROR, onAgentCallError)

    // initOrchestrator 可被测试、热重载或多实例宿主重复调用。把所有全局
    // EventEmitter 监听器与长寿命引擎绑定到 Fastify 生命周期，防止旧实例
    // 在 app.close() 后继续消费事件、持有旧 broadcaster 和 Fastify 引用。
    let shutdown = false
    fastify.addHook('onClose', async () => {
        if (shutdown) return
        shutdown = true
        agentEvents.off(AGENT_EVENTS.CALL_SUCCESS, onAgentCallSuccess)
        agentEvents.off(AGENT_EVENTS.CALL_ERROR, onAgentCallError)
        evolutionEngine.stop()
        evolutionEngine.detachBroadcaster()
        proactiveIntelligence.detachBroadcaster()
        eventBridge.destroy()
        broadcaster.closeAll()
    })

    return {
        orchestrator,
        broadcaster,
        intervention,
        eventBridge,
        sessionStore,
        proactive: proactiveIntelligence,
        traceStore,
    }
}
