/**
 * 本地运行证据存储。
 *
 * 只持久化可用于复核的白名单元数据；提示词、输入预览、学生身份、模型原始
 * 输出和错误原文一律不进入该存储。这样即使教师导出或展示证据链，也不会
 * 顺带泄露教学内容。
 */

import { randomUUID } from 'node:crypto'
import { SqliteMap } from '../db/runtime-store.js'

const MAX_TRACE_EVENTS = 50_000
const MAX_EVENTS_PER_QUERY = 500

export type TraceLayer = 'orchestrator' | 'agent' | 'llm' | 'billing' | 'evaluation'
export type TracePhase =
    | 'created'
    | 'approved'
    | 'start'
    | 'success'
    | 'retry'
    | 'error'
    | 'fallback'
    | 'paused'
    | 'resumed'
    | 'aborted'
    | 'modified'
    | 'verified'

export interface TraceUsage {
    promptTokens: number
    completionTokens: number
    cachedTokens: number
}

export interface TraceEventRecord {
    id: string
    traceId: string
    sessionId: string
    type: string
    layer: TraceLayer
    phase: TracePhase
    timestamp: number
    agentId?: string
    taskId?: string
    domain?: string
    function?: string
    provider?: string
    model?: string
    thinking?: string
    promptVersion?: string
    latencyMs?: number
    costYuan?: number
    usage?: TraceUsage
    fallback?: boolean
    errorCategory?: string
    verdict?: 'pass' | 'revise' | 'reject'
    score?: number
}

export interface TraceSummary {
    traceId: string
    sessionId: string
    status: 'planning' | 'running' | 'success' | 'error' | 'aborted'
    startedAt?: number
    lastEventAt?: number
    durationMs: number
    eventCount: number
    llmCalls: number
    agentCalls: number
    retries: number
    errors: number
    fallbacks: number
    evaluations: number
    totalTokens: number
    costYuan: number
    promptVersions: string[]
    models: string[]
}

export interface TraceDetail {
    summary: TraceSummary
    events: TraceEventRecord[]
    privacy: {
        rawPromptsStored: false
        rawOutputsStored: false
        studentIdentityStored: false
        policy: string
    }
    truncated: boolean
}

type Payload = Record<string, unknown>

const EVENT_SHAPES: Record<string, { layer: TraceLayer; phase: TracePhase }> = {
    'orchestrator:plan:created': { layer: 'orchestrator', phase: 'created' },
    'orchestrator:plan:approved': { layer: 'orchestrator', phase: 'approved' },
    'orchestrator:execution:start': { layer: 'orchestrator', phase: 'start' },
    'orchestrator:execution:success': { layer: 'orchestrator', phase: 'success' },
    'orchestrator:execution:error': { layer: 'orchestrator', phase: 'error' },
    'orchestrator:execution:paused': { layer: 'orchestrator', phase: 'paused' },
    'orchestrator:execution:resumed': { layer: 'orchestrator', phase: 'resumed' },
    'orchestrator:execution:aborted': { layer: 'orchestrator', phase: 'aborted' },
    'orchestrator:execution:modified': { layer: 'orchestrator', phase: 'modified' },
    'llm:call:start': { layer: 'llm', phase: 'start' },
    'llm:call:success': { layer: 'llm', phase: 'success' },
    'llm:call:error': { layer: 'llm', phase: 'error' },
    'llm:fallback': { layer: 'llm', phase: 'fallback' },
    'billing:record': { layer: 'billing', phase: 'success' },
    'agent:call:start': { layer: 'agent', phase: 'start' },
    'agent:call:success': { layer: 'agent', phase: 'success' },
    'agent:call:error': { layer: 'agent', phase: 'error' },
    'agent:fallback': { layer: 'agent', phase: 'fallback' },
    'agent:verify': { layer: 'evaluation', phase: 'verified' },
}

function asRecord(value: unknown): Payload | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Payload
        : undefined
}

function safeString(value: unknown, max = 128): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > max) return undefined
    return trimmed
}

function safeNumber(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
        ? value
        : undefined
}

function safeBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined
}

function classifyError(payload: Payload): string {
    const error = safeString(payload.error, 500)
    if (error?.startsWith('重试 ')) return 'retryable'
    const name = safeString(payload.errorName) ?? safeString(payload.errorType)
    if (!name) return 'unknown'
    const normalized = name.toLowerCase()
    if (normalized.includes('timeout')) return 'timeout'
    if (normalized.includes('rate')) return 'rate_limit'
    if (normalized.includes('abort')) return 'aborted'
    if (normalized.includes('validation') || normalized.includes('zod')) return 'validation'
    if (normalized.includes('network') || normalized.includes('fetch')) return 'network'
    return 'runtime'
}

function normalizeUsage(payload: Payload): TraceUsage | undefined {
    const nested = asRecord(payload.usage)
    const source = nested ?? payload
    const promptTokens = safeNumber(source.promptTokens)
    const completionTokens = safeNumber(source.completionTokens)
    const cachedTokens = safeNumber(source.cachedTokens) ?? 0
    if (promptTokens === undefined && completionTokens === undefined && cachedTokens === 0) return undefined
    return {
        promptTokens: promptTokens ?? 0,
        completionTokens: completionTokens ?? 0,
        cachedTokens,
    }
}

/** 把任意事件载荷收缩成无内容、无身份信息的证据记录。 */
export function sanitizeTraceEvent(type: string, payload: unknown): TraceEventRecord | undefined {
    const shape = EVENT_SHAPES[type]
    const data = asRecord(payload)
    if (!shape || !data) return undefined

    const sessionId = safeString(data.sessionId)
    if (!sessionId) return undefined

    let phase = shape.phase
    let errorCategory: string | undefined
    if (phase === 'error') {
        errorCategory = classifyError(data)
        if (errorCategory === 'retryable') phase = 'retry'
    }

    const verdictValue = safeString(data.verdict)
    const verdict = verdictValue === 'pass' || verdictValue === 'revise' || verdictValue === 'reject'
        ? verdictValue
        : undefined
    const timestamp = safeNumber(data.timestamp, 1, 9_999_999_999_999) ?? Date.now()

    const record: TraceEventRecord = {
        id: randomUUID(),
        traceId: sessionId,
        sessionId,
        type,
        layer: shape.layer,
        phase,
        timestamp,
        agentId: safeString(data.agentId) ?? safeString(data.agent),
        taskId: safeString(data.taskId) ?? safeString(data.task),
        domain: safeString(data.domain),
        function: safeString(data.function),
        provider: safeString(data.provider),
        model: safeString(data.model),
        thinking: safeString(data.thinking),
        promptVersion: safeString(data.promptVersion),
        latencyMs: safeNumber(data.latencyMs, 0, 86_400_000),
        costYuan: safeNumber(data.costYuan, 0, 1_000_000),
        usage: normalizeUsage(data),
        fallback: safeBoolean(data.fallback),
        errorCategory,
        verdict,
        score: safeNumber(data.score, 0, 100),
    }

    // JSON 输出中不保留 undefined 字段，降低证据体积并让契约更清晰。
    return Object.fromEntries(
        Object.entries(record).filter(([, value]) => value !== undefined),
    ) as unknown as TraceEventRecord
}

export class TraceStore {
    private readonly events: Map<string, TraceEventRecord>

    constructor(options: {
        durable?: boolean
        tableName?: string
        storage?: Map<string, TraceEventRecord>
    } = {}) {
        this.events = options.storage ?? (options.durable
            ? new SqliteMap<string, TraceEventRecord>({
                table: options.tableName ?? 'observability_trace_events',
                maxSize: MAX_TRACE_EVENTS,
                indexes: [
                    { name: 'session_id', extract: (event) => event.sessionId },
                    { name: 'event_layer', extract: (event) => event.layer },
                ],
            })
            : new Map<string, TraceEventRecord>())
    }

    record(type: string, payload: unknown): TraceEventRecord | undefined {
        const event = sanitizeTraceEvent(type, payload)
        if (!event) return undefined
        this.events.set(event.id, event)
        return event
    }

    getTrace(sessionId: string, limit = MAX_EVENTS_PER_QUERY): TraceDetail {
        const safeLimit = Math.max(1, Math.min(MAX_EVENTS_PER_QUERY, Math.floor(limit)))
        const all = [...this.events.values()]
            .filter((event) => event.sessionId === sessionId)
            .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
        const events = all.slice(-safeLimit)
        return {
            summary: summarizeTrace(sessionId, all),
            events,
            privacy: {
                rawPromptsStored: false,
                rawOutputsStored: false,
                studentIdentityStored: false,
                policy: '仅保存模型、Agent、版本、耗时、Token、费用、降级与验收等白名单元数据',
            },
            truncated: events.length < all.length,
        }
    }

    deleteTrace(sessionId: string): number {
        const ids = [...this.events.values()]
            .filter((event) => event.sessionId === sessionId)
            .map((event) => event.id)
        for (const id of ids) this.events.delete(id)
        return ids.length
    }

    get size(): number {
        return this.events.size
    }
}

function summarizeTrace(sessionId: string, events: TraceEventRecord[]): TraceSummary {
    const first = events[0]
    const last = events.at(-1)
    let status: TraceSummary['status'] = 'planning'
    if (events.some((event) => event.type === 'orchestrator:execution:aborted')) status = 'aborted'
    else if (events.some((event) => event.type === 'orchestrator:execution:error')) status = 'error'
    else if (events.some((event) => event.type === 'orchestrator:execution:success')) status = 'success'
    else if (events.some((event) => event.type === 'orchestrator:execution:start')) status = 'running'

    const billingEvents = events.filter((event) => event.layer === 'billing')
    const promptVersions = [...new Set(events.map((event) => event.promptVersion).filter((v): v is string => Boolean(v)))]
    const models = [...new Set(events.map((event) => event.model).filter((v): v is string => Boolean(v)))]

    return {
        traceId: sessionId,
        sessionId,
        status,
        startedAt: first?.timestamp,
        lastEventAt: last?.timestamp,
        durationMs: first && last ? Math.max(0, last.timestamp - first.timestamp) : 0,
        eventCount: events.length,
        llmCalls: events.filter((event) => event.type === 'llm:call:start').length,
        agentCalls: events.filter((event) => event.type === 'agent:call:start').length,
        retries: events.filter((event) => event.phase === 'retry').length,
        errors: events.filter((event) => event.phase === 'error').length,
        fallbacks: events.filter((event) => event.phase === 'fallback' || event.fallback === true).length,
        evaluations: events.filter((event) => event.layer === 'evaluation').length,
        totalTokens: billingEvents.reduce((total, event) => total +
            (event.usage?.promptTokens ?? 0) + (event.usage?.completionTokens ?? 0), 0),
        costYuan: Number(billingEvents.reduce((total, event) => total + (event.costYuan ?? 0), 0).toFixed(6)),
        promptVersions,
        models,
    }
}

export const traceStore = new TraceStore({ durable: process.env.NODE_ENV !== 'test' })
