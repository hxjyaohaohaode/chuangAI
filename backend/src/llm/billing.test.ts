/**
 * llm/billing.ts 单元测试
 *
 * 覆盖：
 * - record()：写入记录、计算费用、emit billing:record 事件
 * - calcCost()：各模型单价、缓存命中 token、ASR 时长计费、TTS 免费、未知模型
 * - query()：按 agent / since / until 筛选
 * - summary()：汇总与按 agent 分组
 * - aggregateSession()：按 sessionId 聚合
 * - LRU 淘汰（容量 10000）
 * - clear() / size
 *
 * 设计原则：
 * - 使用真实 EventEmitter，不 mock，验证事件正确性
 * - 使用 vi.useFakeTimers 控制 Date.now，便于 since/until 断言
 * - 费用断言使用 toBeCloseTo 容忍浮点误差（实现已做 6 位小数四舍五入）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TokenBilling, type BillingRecord } from './billing.js'

// ─────────────────────────────────────────────────────────────
// 辅助构造函数
// ─────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<Omit<BillingRecord, 'costYuan' | 'timestamp'>> = {}) {
    return {
        agent: 'mind',
        task: 'diagnose',
        provider: 'deepseek' as const,
        model: 'deepseek-v4-pro',
        promptTokens: 1000,
        completionTokens: 500,
        latencyMs: 100,
        success: true,
        ...overrides,
    }
}

// ─────────────────────────────────────────────────────────────
// calcCost（通过 record 间接验证）
// ─────────────────────────────────────────────────────────────

describe('TokenBilling — 费用计算', () => {
    let billing: TokenBilling

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
        billing = new TokenBilling()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('deepseek-v4-pro：输入 3 元/M + 输出 6 元/M', () => {
        const rec = billing.record(makeRecord({
            model: 'deepseek-v4-pro',
            promptTokens: 1_000_000,
            completionTokens: 1_000_000,
        }))
        // 1M 输入 × 3 + 1M 输出 × 6 = 9 元
        expect(rec.costYuan).toBe(9)
    })

    it('deepseek-v4-flash：输入 1 元/M + 输出 3 元/M', () => {
        const rec = billing.record(makeRecord({
            model: 'deepseek-v4-flash',
            promptTokens: 1_000_000,
            completionTokens: 1_000_000,
        }))
        // 1M 输入 × 1 + 1M 输出 × 3 = 4 元
        expect(rec.costYuan).toBe(4)
    })

    it('mimo-v2.5：输入 1 元/M + 输出 2 元/M', () => {
        const rec = billing.record(makeRecord({
            provider: 'mimo',
            model: 'mimo-v2.5',
            promptTokens: 1_000_000,
            completionTokens: 1_000_000,
        }))
        // 1M 输入 × 1 + 1M 输出 × 2 = 3 元
        expect(rec.costYuan).toBe(3)
    })

    it('mimo-v2.5-pro：输入 3 元/M + 输出 6 元/M', () => {
        const rec = billing.record(makeRecord({
            provider: 'mimo',
            model: 'mimo-v2.5-pro',
            promptTokens: 1_000_000,
            completionTokens: 1_000_000,
        }))
        expect(rec.costYuan).toBe(9)
    })

    it('缓存命中部分按 0.025 元/M 计费（deepseek-v4-pro）', () => {
        const rec = billing.record(makeRecord({
            model: 'deepseek-v4-pro',
            promptTokens: 1_000_000,
            completionTokens: 0,
            cachedTokens: 600_000,
        }))
        // 非缓存 400k × 3 / 1M = 1.2
        // 缓存 600k × 0.025 / 1M = 0.015
        // 合计 1.215 元
        expect(rec.costYuan).toBeCloseTo(1.215, 6)
    })

    it('cachedTokens 超过 promptTokens 时 nonCachedInput 钳为 0', () => {
        // 实现中 Math.max(0, promptTokens - cached)
        // 当 cached > prompt 时，nonCachedInput = 0，全部按缓存价计费
        const rec = billing.record(makeRecord({
            model: 'deepseek-v4-pro',
            promptTokens: 1_000_000,
            completionTokens: 0,
            cachedTokens: 2_000_000,
        }))
        // 全部按缓存价：2M × 0.025 / 1M = 0.05 元
        expect(rec.costYuan).toBeCloseTo(0.05, 6)
    })

    it('ASR 按时长计费：0.5 元/小时 = 0.5/3600 元/秒', () => {
        const rec = billing.record(makeRecord({
            provider: 'mimo',
            model: 'mimo-v2.5-asr',
            promptTokens: 0,
            completionTokens: 0,
            audioDurationSec: 3600,
        }))
        // 1 小时 = 0.5 元
        expect(rec.costYuan).toBeCloseTo(0.5, 6)
    })

    it('ASR 缺少 audioDurationSec 时费用为 0', () => {
        const rec = billing.record(makeRecord({
            provider: 'mimo',
            model: 'mimo-v2.5-asr',
            promptTokens: 0,
            completionTokens: 0,
        }))
        // asrPerSecond 定义但 audioDurationSec 未提供 → 不走 ASR 分支
        // 继续往下走 TTS / 文本分支，文本 0 token → 0 元
        expect(rec.costYuan).toBe(0)
    })

    it('TTS 模型免费', () => {
        const rec = billing.record(makeRecord({
            provider: 'mimo',
            model: 'mimo-v2.5-tts',
            promptTokens: 999,
            completionTokens: 999,
        }))
        expect(rec.costYuan).toBe(0)
    })

    it('未知模型费用为 0', () => {
        const rec = billing.record(makeRecord({
            model: 'unknown-model-xyz',
        }))
        expect(rec.costYuan).toBe(0)
    })

    it('零 token 计费返回 0', () => {
        const rec = billing.record(makeRecord({
            model: 'deepseek-v4-pro',
            promptTokens: 0,
            completionTokens: 0,
        }))
        expect(rec.costYuan).toBe(0)
    })

    it('费用精度保留 6 位小数（四舍五入）', () => {
        // 1 token × 3 / 1M = 0.000003 元
        const rec = billing.record(makeRecord({
            model: 'deepseek-v4-pro',
            promptTokens: 1,
            completionTokens: 0,
        }))
        expect(rec.costYuan).toBeCloseTo(0.000003, 6)
    })
})

// ─────────────────────────────────────────────────────────────
// record / 事件
// ─────────────────────────────────────────────────────────────

describe('TokenBilling — record 与事件', () => {
    let billing: TokenBilling

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
        billing = new TokenBilling()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('record 返回完整 BillingRecord，含 timestamp 与 costYuan', () => {
        const rec = billing.record(makeRecord())
        expect(rec.timestamp).toBe(Date.now())
        expect(typeof rec.costYuan).toBe('number')
        expect(rec.agent).toBe('mind')
        expect(rec.success).toBe(true)
    })

    it('record 推送 billing:record 事件', () => {
        let emitted: BillingRecord | undefined
        billing.on('billing:record', (r: BillingRecord) => {
            emitted = r
        })
        const rec = billing.record(makeRecord({ agent: 'eye' }))
        expect(emitted).toBeDefined()
        expect(emitted?.agent).toBe('eye')
        expect(emitted).toBe(rec)
    })

    it('size 随 record 增加', () => {
        expect(billing.size).toBe(0)
        billing.record(makeRecord())
        expect(billing.size).toBe(1)
        billing.record(makeRecord())
        expect(billing.size).toBe(2)
    })

    it('多次 record 产生不同 ID，按插入顺序存储', () => {
        billing.record(makeRecord({ agent: 'a' }))
        billing.record(makeRecord({ agent: 'b' }))
        billing.record(makeRecord({ agent: 'c' }))
        const all = billing.query({})
        expect(all.length).toBe(3)
        expect(all[0]!.agent).toBe('a')
        expect(all[1]!.agent).toBe('b')
        expect(all[2]!.agent).toBe('c')
    })
})

// ─────────────────────────────────────────────────────────────
// query
// ─────────────────────────────────────────────────────────────

describe('TokenBilling — query 筛选', () => {
    let billing: TokenBilling

    beforeEach(() => {
        vi.useFakeTimers()
        billing = new TokenBilling()
        // t=100: mind
        vi.setSystemTime(new Date('2026-01-01T00:00:00.100Z'))
        billing.record(makeRecord({ agent: 'mind', model: 'deepseek-v4-pro' }))
        // t=200: eye
        vi.setSystemTime(new Date('2026-01-01T00:00:00.200Z'))
        billing.record(makeRecord({ agent: 'eye', model: 'mimo-v2.5' }))
        // t=300: brush
        vi.setSystemTime(new Date('2026-01-01T00:00:00.300Z'))
        billing.record(makeRecord({ agent: 'brush', model: 'deepseek-v4-flash' }))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('无筛选条件返回全部', () => {
        expect(billing.query({}).length).toBe(3)
    })

    it('按 agent 筛选', () => {
        const result = billing.query({ agent: 'eye' })
        expect(result.length).toBe(1)
        expect(result[0]!.agent).toBe('eye')
    })

    it('agent 筛选不匹配时返回空', () => {
        expect(billing.query({ agent: 'nonexistent' })).toEqual([])
    })

    it('按 since 筛选（含边界）', () => {
        const t200 = new Date('2026-01-01T00:00:00.200Z').getTime()
        const result = billing.query({ since: t200 })
        expect(result.length).toBe(2)
        expect(result[0]!.agent).toBe('eye')
        expect(result[1]!.agent).toBe('brush')
    })

    it('按 until 筛选（含边界）', () => {
        const t200 = new Date('2026-01-01T00:00:00.200Z').getTime()
        const result = billing.query({ until: t200 })
        expect(result.length).toBe(2)
        expect(result[0]!.agent).toBe('mind')
        expect(result[1]!.agent).toBe('eye')
    })

    it('since + until 组合筛选', () => {
        const t150 = new Date('2026-01-01T00:00:00.150Z').getTime()
        const t250 = new Date('2026-01-01T00:00:00.250Z').getTime()
        const result = billing.query({ since: t150, until: t250 })
        expect(result.length).toBe(1)
        expect(result[0]!.agent).toBe('eye')
    })

    it('结果按时间正序', () => {
        const result = billing.query({})
        expect(result[0]!.timestamp).toBeLessThanOrEqual(result[1]!.timestamp)
        expect(result[1]!.timestamp).toBeLessThanOrEqual(result[2]!.timestamp)
    })
})

// ─────────────────────────────────────────────────────────────
// summary
// ─────────────────────────────────────────────────────────────

describe('TokenBilling — summary 汇总', () => {
    let billing: TokenBilling

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
        billing = new TokenBilling()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('空记录 summary 返回 0', () => {
        const s = billing.summary()
        expect(s.totalCalls).toBe(0)
        expect(s.totalCostYuan).toBe(0)
        expect(Object.keys(s.byAgent)).toHaveLength(0)
    })

    it('汇总 totalCalls / totalCostYuan / byAgent', () => {
        billing.record(makeRecord({ agent: 'mind', promptTokens: 1_000_000, completionTokens: 1_000_000 }))
        // mind: 1M+1M pro = 9 元
        billing.record(makeRecord({ agent: 'mind', promptTokens: 1_000_000, completionTokens: 0 }))
        // mind: 1M pro 输入 = 3 元
        billing.record(makeRecord({ agent: 'eye', provider: 'mimo', model: 'mimo-v2.5', promptTokens: 1_000_000, completionTokens: 0 }))
        // eye: 1M mimo-v2.5 输入 = 1 元

        const s = billing.summary()
        expect(s.totalCalls).toBe(3)
        expect(s.totalCostYuan).toBeCloseTo(13, 6)
        expect(s.byAgent.mind?.calls).toBe(2)
        expect(s.byAgent.mind?.cost).toBeCloseTo(12, 6)
        expect(s.byAgent.eye?.calls).toBe(1)
        expect(s.byAgent.eye?.cost).toBeCloseTo(1, 6)
    })

    it('totalCostYuan 保留 6 位小数精度', () => {
        billing.record(makeRecord({ promptTokens: 1, completionTokens: 0 }))
        // 1 × 3 / 1M = 3e-6 元
        const s = billing.summary()
        expect(s.totalCostYuan).toBeCloseTo(0.000003, 6)
    })
})

// ─────────────────────────────────────────────────────────────
// aggregateSession
// ─────────────────────────────────────────────────────────────

describe('TokenBilling — aggregateSession 会话聚合', () => {
    let billing: TokenBilling

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
        billing = new TokenBilling()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('无 sessionId 匹配时返回 0', () => {
        billing.record(makeRecord({ sessionId: 'sess-1' }))
        const agg = billing.aggregateSession('nonexistent')
        expect(agg.totalCalls).toBe(0)
        expect(agg.totalCostYuan).toBe(0)
        expect(agg.tokenUsage.promptTokens).toBe(0)
        expect(agg.tokenUsage.completionTokens).toBe(0)
        expect(agg.tokenUsage.cachedTokens).toBe(0)
    })

    it('按 sessionId 聚合调用数、费用、token 用量', () => {
        billing.record(makeRecord({
            sessionId: 'sess-1',
            promptTokens: 1_000_000,
            completionTokens: 500_000,
            cachedTokens: 200_000,
        }))
        billing.record(makeRecord({
            sessionId: 'sess-1',
            promptTokens: 500_000,
            completionTokens: 250_000,
        }))
        billing.record(makeRecord({
            sessionId: 'sess-2',
            promptTokens: 999_999,
            completionTokens: 999_999,
        }))

        const agg = billing.aggregateSession('sess-1')
        expect(agg.totalCalls).toBe(2)
        // rec1: (1M-200k)*3/1M + 200k*0.025/1M + 500k*6/1M = 2.4 + 0.005 + 3 = 5.405
        // rec2: 500k*3/1M + 250k*6/1M = 1.5 + 1.5 = 3
        // 合计 8.405
        expect(agg.totalCostYuan).toBeCloseTo(8.405, 6)
        expect(agg.tokenUsage.promptTokens).toBe(1_500_000)
        expect(agg.tokenUsage.completionTokens).toBe(750_000)
        expect(agg.tokenUsage.cachedTokens).toBe(200_000)
    })

    it('无 sessionId 字段的记录不参与任何会话聚合', () => {
        billing.record(makeRecord({ promptTokens: 100, completionTokens: 100 }))
        billing.record(makeRecord({ sessionId: undefined, promptTokens: 200, completionTokens: 200 }))
        const agg = billing.aggregateSession('sess-1')
        expect(agg.totalCalls).toBe(0)
    })
})

// ─────────────────────────────────────────────────────────────
// clear / LRU 淘汰
// ─────────────────────────────────────────────────────────────

describe('TokenBilling — clear 与 LRU 淘汰', () => {
    let billing: TokenBilling

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
        billing = new TokenBilling()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('clear 清空所有记录并重置 seq', () => {
        billing.record(makeRecord())
        billing.record(makeRecord())
        expect(billing.size).toBe(2)
        billing.clear()
        expect(billing.size).toBe(0)
        // 清空后仍可继续 record
        const rec = billing.record(makeRecord({ agent: 'new' }))
        expect(rec.agent).toBe('new')
        expect(billing.size).toBe(1)
    })

    it('LRU 淘汰：超出 10000 容量时删除最早记录', () => {
        // 写入 10000 条
        for (let i = 0; i < 10_000; i++) {
            billing.record(makeRecord({ agent: `agent-${i}` }))
        }
        expect(billing.size).toBe(10_000)

        // 再写 1 条，应淘汰最早的 agent-0
        billing.record(makeRecord({ agent: 'overflow' }))
        expect(billing.size).toBe(10_000)

        const all = billing.query({})
        // agent-0 应已被淘汰
        const agents = all.map((r) => r.agent)
        expect(agents).not.toContain('agent-0')
        // agent-1 应仍存在
        expect(agents).toContain('agent-1')
        // overflow 应在最后
        expect(all[all.length - 1]!.agent).toBe('overflow')
    })
})
