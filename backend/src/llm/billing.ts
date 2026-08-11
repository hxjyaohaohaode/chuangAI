/**
 * Token 计费与延迟统计
 *
 * 维护 LRU 计费记录（容量 10000），实时推送 `billing:record` 事件
 * 供 WebSocket 订阅。生产单例使用 SQLite，避免服务重启后成本证据丢失；
 * 独立单元测试实例默认使用内存存储，保证测试隔离。
 *
 * 价格表（每百万 tokens，元）：
 * ┌─────────────────────┬───────────────┬──────────────────┬────────────┐
 * │ 模型                │ 输入(缓存未命中)│ 输入(缓存命中)    │ 输出        │
 * ├─────────────────────┼───────────────┼──────────────────┼────────────┤
 * │ deepseek-v4-pro     │ 3             │ 0.025            │ 6          │
 * │ deepseek-v4-flash   │ 1             │ 0.02             │ 3          │
 * │ mimo-v2.5           │ 1             │ 0.02             │ 2          │
 * │ mimo-v2.5-pro       │ 3             │ 0.025            │ 6          │
 * │ mimo-v2.5-asr       │ 0.5 元/小时音频                  │ —          │
 * │ mimo-v2.5-tts       │ 限时免费                        │ —          │
 * └─────────────────────┴───────────────┴──────────────────┴────────────┘
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { SqliteMap } from '../db/runtime-store.js'

// ─────────────────────────────────────────────────────────────
// 计费记录类型
// ─────────────────────────────────────────────────────────────

export interface BillingRecord {
    /** 记录时间戳（ms） */
    timestamp: number
    /** 智能体名 */
    agent: string
    /** 任务名 */
    task: string
    /** 会话 ID */
    sessionId?: string
    /** 服务提供方 */
    provider: 'deepseek' | 'mimo'
    /** 模型名 */
    model: string
    /** 输入 token 数 */
    promptTokens: number
    /** 输出 token 数 */
    completionTokens: number
    /** 缓存命中 token 数（DeepSeek 扩展字段） */
    cachedTokens?: number
    /** ASR 音频时长（秒） */
    audioDurationSec?: number
    /** 请求延迟（ms） */
    latencyMs: number
    /** 计算得出的费用（元） */
    costYuan: number
    /** 调用是否成功 */
    success: boolean
    /** 是否为降级模式 */
    fallback?: boolean
}

// ─────────────────────────────────────────────────────────────
// 汇总类型
// ─────────────────────────────────────────────────────────────

export interface BillingSummary {
    totalCalls: number
    totalCostYuan: number
    byAgent: Record<string, { calls: number; cost: number }>
}

/**
 * 单会话计费聚合结果
 *
 * 供 Orchestrator 在会话结束时调用，填充 ExecutionResult.totalCostYuan
 * 与 SESSION_END 事件的 tokenUsage 字段，实现成本闭环。
 */
export interface SessionBillingAggregate {
    /** 会话内总调用数（含失败） */
    totalCalls: number
    /** 会话内总费用（元） */
    totalCostYuan: number
    /** 会话内 token 用量汇总 */
    tokenUsage: {
        promptTokens: number
        completionTokens: number
        cachedTokens: number
    }
}

// ─────────────────────────────────────────────────────────────
// 价格表
// ─────────────────────────────────────────────────────────────

interface ModelPricing {
    /** 输入价格（元/百万 tokens，缓存未命中） */
    inputPerMillion: number
    /** 输入价格（元/百万 tokens，缓存命中） */
    cachedInputPerMillion: number
    /** 输出价格（元/百万 tokens） */
    outputPerMillion: number
    /** ASR 价格（元/秒，仅 ASR 模型） */
    asrPerSecond?: number
    /** TTS 免费 */
    ttsFree?: boolean
}

/**
 * 模型价格表
 * 数据来源：大模型API文档.md
 */
const PRICING: Record<string, ModelPricing> = {
    'deepseek-v4-pro': {
        inputPerMillion: 3,
        cachedInputPerMillion: 0.025,
        outputPerMillion: 6,
    },
    'deepseek-v4-flash': {
        inputPerMillion: 1,
        cachedInputPerMillion: 0.02,
        outputPerMillion: 3,
    },
    'mimo-v2.5': {
        inputPerMillion: 1,
        cachedInputPerMillion: 0.02,
        outputPerMillion: 2,
    },
    'mimo-v2.5-pro': {
        inputPerMillion: 3,
        cachedInputPerMillion: 0.025,
        outputPerMillion: 6,
    },
    'mimo-v2.5-asr': {
        inputPerMillion: 0,
        cachedInputPerMillion: 0,
        outputPerMillion: 0,
        asrPerSecond: 0.5 / 3600, // 0.5 元/小时 = 0.5/3600 元/秒
    },
    'mimo-v2.5-tts': {
        inputPerMillion: 0,
        cachedInputPerMillion: 0,
        outputPerMillion: 0,
        ttsFree: true,
    },
}

// ─────────────────────────────────────────────────────────────
// TokenBilling — 计费引擎
// ─────────────────────────────────────────────────────────────

/**
 * Token 计费引擎
 *
 * 继承 EventEmitter，每次 record 时推送 `billing:record` 事件
 * 内部维护 LRU Map（容量 10000），超出时淘汰最早记录
 */
export class TokenBilling extends EventEmitter {
    /** Map 与 SqliteMap 均实现标准 Map 接口；生产环境可选择落盘。 */
    private readonly records: Map<string, BillingRecord> | SqliteMap<string, BillingRecord>
    /** 最大容量 */
    private static readonly MAX_CAPACITY = 10000

    constructor(opts: { persistent?: boolean } = {}) {
        super()
        this.records = opts.persistent
            ? new SqliteMap<string, BillingRecord>({
                table: 'llm_billing_records',
                indexes: [
                    { name: 'agent', extract: (value) => value.agent },
                    { name: 'session_id', extract: (value) => value.sessionId ?? null },
                    { name: 'timestamp_ms', extract: (value) => value.timestamp },
                ],
                maxSize: TokenBilling.MAX_CAPACITY,
            })
            : new Map<string, BillingRecord>()
    }

    /**
     * 记录一次调用的计费信息
     *
     * @param rec 不含 costYuan 与 timestamp 的记录字段
     * @returns 完整的计费记录（含计算得出的费用与时间戳）
     */
    record(rec: Omit<BillingRecord, 'costYuan' | 'timestamp'>): BillingRecord {
        const costYuan = this.calcCost(rec)
        const full: BillingRecord = {
            ...rec,
            timestamp: Date.now(),
            costYuan,
        }

        // UUID 避免服务重启后自增序号归零覆盖历史记录。
        const key = randomUUID()
        this.records.set(key, full)

        // 内存模式手动 LRU 淘汰；SqliteMap 在 set() 内按 updated_at 淘汰。
        if (this.records.size > TokenBilling.MAX_CAPACITY) {
            const firstKey = this.records.keys().next().value
            if (firstKey !== undefined) {
                this.records.delete(firstKey)
            }
        }

        // 实时推送事件供 WebSocket 订阅
        this.emit('billing:record', full)

        return full
    }

    /**
     * 计算费用（元）
     *
     * 计算规则：
     * - 文本模型：输入 token 费用（区分缓存命中/未命中）+ 输出 token 费用
     * - ASR 模型：音频时长 × 每秒单价
     * - TTS 模型：免费（0 元）
     */
    private calcCost(rec: Omit<BillingRecord, 'costYuan' | 'timestamp'>): number {
        const pricing = PRICING[rec.model]
        if (!pricing) {
            return 0
        }

        // ASR 按时长计费
        if (pricing.asrPerSecond !== undefined && rec.audioDurationSec !== undefined) {
            return rec.audioDurationSec * pricing.asrPerSecond
        }

        // TTS 免费
        if (pricing.ttsFree) {
            return 0
        }

        // 文本模型计费
        // 缓存命中部分按缓存价格，未命中部分按正常价格
        const cached = rec.cachedTokens ?? 0
        const nonCachedInput = Math.max(0, rec.promptTokens - cached)

        const inputCost = (nonCachedInput * pricing.inputPerMillion + cached * pricing.cachedInputPerMillion) / 1_000_000
        const outputCost = (rec.completionTokens * pricing.outputPerMillion) / 1_000_000

        // 保留 6 位小数精度（元），避免浮点误差
        return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000
    }

    /**
     * 查询计费记录
     *
     * @param filter 筛选条件
     * @returns 符合条件的记录数组（按时间正序）
     */
    query(filter: { agent?: string; since?: number; until?: number }): BillingRecord[] {
        const result: BillingRecord[] = []
        for (const rec of this.records.values()) {
            if (filter.agent !== undefined && rec.agent !== filter.agent) continue
            if (filter.since !== undefined && rec.timestamp < filter.since) continue
            if (filter.until !== undefined && rec.timestamp > filter.until) continue
            result.push(rec)
        }
        return result
    }

    /**
     * 汇总计费信息
     *
     * @returns 总调用数、总费用、按 agent 分组的统计
     */
    summary(): BillingSummary {
        let totalCalls = 0
        let totalCostYuan = 0
        const byAgent: Record<string, { calls: number; cost: number }> = {}

        for (const rec of this.records.values()) {
            totalCalls++
            totalCostYuan += rec.costYuan

            const aggregate = byAgent[rec.agent] ?? { calls: 0, cost: 0 }
            aggregate.calls++
            aggregate.cost += rec.costYuan
            byAgent[rec.agent] = aggregate
        }

        return {
            totalCalls,
            totalCostYuan: Math.round(totalCostYuan * 1_000_000) / 1_000_000,
            byAgent,
        }
    }

    /**
     * 聚合指定会话的计费数据
     *
     * 按 sessionId 过滤记录，汇总调用数、费用与 token 用量。
     * 供 Orchestrator.buildExecutionResult 在会话结束时调用，
     * 替代硬编码的 totalCostYuan = 0，实现成本闭环。
     *
     * @param sessionId 会话 ID
     * @returns 会话级聚合结果（无记录时各项为 0）
     */
    aggregateSession(sessionId: string): SessionBillingAggregate {
        let totalCalls = 0
        let totalCostYuan = 0
        let promptTokens = 0
        let completionTokens = 0
        let cachedTokens = 0

        for (const rec of this.records.values()) {
            if (rec.sessionId !== sessionId) continue
            totalCalls++
            totalCostYuan += rec.costYuan
            promptTokens += rec.promptTokens
            completionTokens += rec.completionTokens
            cachedTokens += rec.cachedTokens ?? 0
        }

        return {
            totalCalls,
            totalCostYuan: Math.round(totalCostYuan * 1_000_000) / 1_000_000,
            tokenUsage: { promptTokens, completionTokens, cachedTokens },
        }
    }

    /** 清空所有计费记录 */
    clear(): void {
        this.records.clear()
    }

    /** 当前记录数 */
    get size(): number {
        return this.records.size
    }
}
