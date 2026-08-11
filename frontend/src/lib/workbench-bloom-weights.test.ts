import { describe, expect, it } from 'vitest'
import type { BloomLevel, WorkbenchBloomWeights } from './types'
import { rebalanceBloomWeights, WORKBENCH_BLOOM_ORDER } from './workbench-bloom-weights'

const BALANCED: WorkbenchBloomWeights = {
    记忆: 17,
    理解: 17,
    应用: 17,
    分析: 17,
    评价: 16,
    创造: 16,
}

function expectValidWeights(weights: WorkbenchBloomWeights): void {
    expect(WORKBENCH_BLOOM_ORDER.reduce((sum, level) => sum + weights[level], 0)).toBe(100)
    for (const level of WORKBENCH_BLOOM_ORDER) {
        expect(Number.isInteger(weights[level]), level).toBe(true)
        expect(weights[level], level).toBeGreaterThanOrEqual(0)
        expect(weights[level], level).toBeLessThanOrEqual(100)
    }
}

describe('rebalanceBloomWeights', () => {
    it('sets the edited item and proportionally redistributes every other item', () => {
        const result = rebalanceBloomWeights(BALANCED, '记忆', 40)

        expect(result).toEqual({
            记忆: 40,
            理解: 12,
            应用: 12,
            分析: 12,
            评价: 12,
            创造: 12,
        })
        expectValidWeights(result)
        expect(BALANCED).toEqual({ 记忆: 17, 理解: 17, 应用: 17, 分析: 17, 评价: 16, 创造: 16 })
    })

    it('evenly distributes an all-zero remainder with a fixed tier-order remainder', () => {
        const result = rebalanceBloomWeights({
            记忆: 80,
            理解: 0,
            应用: 0,
            分析: 0,
            评价: 0,
            创造: 0,
        }, '记忆', 33)

        expect(result).toEqual({
            记忆: 33,
            理解: 14,
            应用: 14,
            分析: 13,
            评价: 13,
            创造: 13,
        })
        expectValidWeights(result)
    })

    it('uses stable largest-remainder allocation when fractional shares tie', () => {
        const current: WorkbenchBloomWeights = {
            记忆: 1,
            理解: 1,
            应用: 1,
            分析: 1,
            评价: 1,
            创造: 1,
        }
        const first = rebalanceBloomWeights(current, '创造', 33)
        const second = rebalanceBloomWeights(current, '创造', 33)

        expect(first).toEqual({
            记忆: 14,
            理解: 14,
            应用: 13,
            分析: 13,
            评价: 13,
            创造: 33,
        })
        expect(second).toEqual(first)
        expectValidWeights(first)
    })

    it.each([
        ['negative', -20, 0],
        ['fractional', 33.6, 34],
        ['over 100', 140, 100],
        ['NaN', Number.NaN, 0],
        ['positive infinity', Number.POSITIVE_INFINITY, 100],
        ['negative infinity', Number.NEGATIVE_INFINITY, 0],
    ])('clamps and rounds %s input without producing invalid state', (_label, value, expected) => {
        const result = rebalanceBloomWeights(BALANCED, '分析', value)

        expect(result.分析).toBe(expected)
        expectValidWeights(result)
    })

    it('sanitizes malformed existing weights before proportional redistribution', () => {
        const malformed: WorkbenchBloomWeights = {
            记忆: Number.NaN,
            理解: Number.POSITIVE_INFINITY,
            应用: Number.NEGATIVE_INFINITY,
            分析: 7.6,
            评价: -8,
            创造: 1_000,
        }

        for (const level of WORKBENCH_BLOOM_ORDER as readonly BloomLevel[]) {
            expectValidWeights(rebalanceBloomWeights(malformed, level, Number.NaN))
        }
    })
})
