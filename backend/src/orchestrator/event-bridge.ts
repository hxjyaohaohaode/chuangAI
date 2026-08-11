/**
 * 事件桥接器
 *
 * 将 LLM 层、Agent 层、计费层的事件转发到 WebSocket 广播器，
 * 供前端观测台实时可视化全链路状态。
 *
 * 桥接的事件：
 * - llm:call:start / llm:call:success / llm:call:error / llm:stream:delta
 *   来自 LLMRouter（EventEmitter）
 * - llm:fallback
 *   来自 ErrorRecovery（EventEmitter）
 * - billing:record
 *   来自 TokenBilling（EventEmitter）
 * - agent:call:start / agent:call:success / agent:call:error / agent:stream:delta / agent:fallback / agent:verify
 *   来自 agentEvents（全局 EventEmitter）
 *
 * 内存安全：
 * - 所有 on 都有对应的 off（destroy 时统一移除）
 * - 监听器上限提升至 50（agentEvents 已设置）
 */

import type { EventEmitter } from 'node:events'
import type { WSBroadcaster } from './websocket/broadcaster.js'
import type { WSEvent } from './types.js'
import type { TraceStore } from '../observability/trace-store.js'

// ─────────────────────────────────────────────────────────────
// EventBridge
// ─────────────────────────────────────────────────────────────

export class EventBridge {
    /** 已注册的监听器列表，用于 destroy 时统一移除 */
    private readonly listeners: Array<{ emitter: EventEmitter; event: string; fn: (...args: unknown[]) => void }> = []
    private destroyed = false

    constructor(
        private readonly router: EventEmitter,
        private readonly errorRecovery: EventEmitter,
        private readonly billing: EventEmitter,
        private readonly agentEvents: EventEmitter,
        private readonly broadcaster: WSBroadcaster,
        private readonly traceStore?: TraceStore,
    ) {
        this.subscribeAll()
    }

    /**
     * 订阅全部事件并转发到广播器
     */
    private subscribeAll(): void {
        // ── LLM 层事件（router） ──
        this.bind(this.router, 'llm:call:start', (payload) => {
            this.forward('llm:call:start', payload)
        })
        this.bind(this.router, 'llm:call:success', (payload) => {
            this.forward('llm:call:success', payload)
        })
        this.bind(this.router, 'llm:call:error', (payload) => {
            this.forward('llm:call:error', payload)
        })
        this.bind(this.router, 'llm:stream:delta', (payload) => {
            this.forward('llm:stream:delta', payload)
        })

        // ── 错误恢复事件 ──
        this.bind(this.errorRecovery, 'llm:fallback', (payload) => {
            this.forward('llm:fallback', payload)
        })

        // ── 计费事件 ──
        this.bind(this.billing, 'billing:record', (payload) => {
            this.forward('billing:record', payload)
        })

        // ── Agent 层事件 ──
        this.bind(this.agentEvents, 'agent:call:start', (payload) => {
            this.forward('agent:call:start', payload)
        })
        this.bind(this.agentEvents, 'agent:call:success', (payload) => {
            this.forward('agent:call:success', payload)
        })
        this.bind(this.agentEvents, 'agent:call:error', (payload) => {
            this.forward('agent:call:error', payload)
        })
        this.bind(this.agentEvents, 'agent:stream:delta', (payload) => {
            this.forward('agent:stream:delta', payload)
        })
        this.bind(this.agentEvents, 'agent:fallback', (payload) => {
            this.forward('agent:fallback', payload)
        })
        this.bind(this.agentEvents, 'agent:verify', (payload) => {
            this.forward('agent:verify', payload)
        })
    }

    /**
     * 绑定事件监听器并记录，便于后续 destroy
     */
    private bind(
        emitter: EventEmitter,
        event: string,
        handler: (payload: unknown) => void,
    ): void {
        // 包装为 (...args: unknown[]) => void 以兼容 EventEmitter
        const wrapped = (...args: unknown[]): void => {
            // 大多数事件只传一个 payload 参数
            handler(args[0])
        }
        emitter.on(event, wrapped as (...args: unknown[]) => void)
        this.listeners.push({ emitter, event, fn: wrapped })
    }

    /**
     * 转发事件到 WebSocket 广播器
     *
     * 从 payload 中提取 sessionId（若有），否则使用空字符串（全局事件）。
     */
    private forward(type: string, payload: unknown): void {
        if (this.destroyed) return

        // 尝试从 payload 提取 sessionId
        let sessionId = ''
        if (payload !== null && typeof payload === 'object') {
            const obj = payload as { sessionId?: unknown }
            if (typeof obj.sessionId === 'string') {
                sessionId = obj.sessionId
            }
        }

        const event: WSEvent = {
            type,
            timestamp: Date.now(),
            sessionId,
            payload,
        }
        // 持久化层使用严格白名单清洗；原始 payload 仅在当前回环 WebSocket
        // 会话中实时转发，不会被证据库落盘。
        this.traceStore?.record(type, payload)
        this.broadcaster.broadcast(event)
    }

    /**
     * 销毁桥接器，移除所有监听器
     *
     * 必须在服务关闭时调用，避免 EventEmitter 内存泄漏。
     */
    destroy(): void {
        if (this.destroyed) return
        this.destroyed = true

        for (const { emitter, event, fn } of this.listeners) {
            emitter.off(event, fn)
        }
        this.listeners.length = 0
    }
}
