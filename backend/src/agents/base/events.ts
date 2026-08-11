/**
 * Agent 事件系统
 *
 * 定义所有 Agent 生命周期事件常量与全局事件总线。
 * 与 LLM 层的 llm:call:* 事件互补，本层聚焦于 Agent 级别的可观测性：
 * - agent:call:start    — Agent 调用开始（含输入预览、上下文元数据）
 * - agent:call:success  — Agent 调用成功（含输出、用量、延迟）
 * - agent:call:error    — Agent 调用失败（含错误信息）
 * - agent:stream:delta  — Agent 流式分片（供 WebSocket 转发）
 * - agent:fallback      — Agent 触发降级
 * - agent:verify        — 验收 Agent 完成一次审核
 *
 * 事件总线为全局单例 `agentEvents`，供 Task 5（编排官）订阅以实现
 * 全链路追踪与 Task 22（自我进化引擎）的数据采集。
 */

import { EventEmitter } from 'node:events'

// ─────────────────────────────────────────────────────────────
// 事件常量
// ─────────────────────────────────────────────────────────────

export const AGENT_EVENTS = {
    CALL_START: 'agent:call:start',
    CALL_SUCCESS: 'agent:call:success',
    CALL_ERROR: 'agent:call:error',
    STREAM_DELTA: 'agent:stream:delta',
    FALLBACK: 'agent:fallback',
    VERIFY: 'agent:verify',
    /** 闭环4补全：Prompt 进化完成（自我进化引擎生成新版本后发射） */
    PROMPT_EVOLVED: 'prompt:evolved',
    /** 闭环4补全：A/B 测试候选版本胜出并自动激活 */
    AB_TEST_WON: 'ab-test:won',
} as const

export type AgentEventName = (typeof AGENT_EVENTS)[keyof typeof AGENT_EVENTS]

// ─────────────────────────────────────────────────────────────
// 事件载荷类型
// ─────────────────────────────────────────────────────────────

export interface AgentCallStartPayload {
    agentId: string
    domain: string
    function: string
    bloomLevel: string
    promptVersion: string
    taskId: string
    sessionId?: string
    inputPreview: string
    timestamp: number
}

export interface AgentCallSuccessPayload {
    agentId: string
    taskId: string
    sessionId?: string
    output: unknown
    usage: { promptTokens: number; completionTokens: number; cachedTokens?: number }
    latencyMs: number
    promptVersion: string
    timestamp: number
}

export interface AgentCallErrorPayload {
    agentId: string
    taskId: string
    sessionId?: string
    error: string
    errorName: string
    timestamp: number
}

export interface AgentFallbackPayload {
    agentId: string
    taskId: string
    sessionId?: string
    reason: string
    timestamp: number
}

export interface AgentVerifyPayload {
    targetAgentId: string
    taskId?: string
    sessionId?: string
    verdict: 'pass' | 'revise' | 'reject'
    score: number
    timestamp: number
}

/** 闭环4补全：Prompt 进化完成事件载荷 */
export interface PromptEvolvedPayload {
    agentId: string
    version: string
    triggerPattern: string
    evolvedAt: number
}

/** 闭环4补全：A/B 测试胜出事件载荷 */
export interface ABTestWonPayload {
    agentId: string
    winningVersion: string
    candidateSuccessRate: number
    activeSuccessRate: number
    activatedAt: number
}

// ─────────────────────────────────────────────────────────────
// 全局事件总线单例
// ─────────────────────────────────────────────────────────────

/**
 * Agent 事件总线
 *
 * 全局单例，所有 BaseAgent 实例共享。提升监听器上限至 50，
 * 以支持编排官、计费观测、自我进化引擎等多个订阅者。
 */
export const agentEvents = new EventEmitter()
agentEvents.setMaxListeners(50)
