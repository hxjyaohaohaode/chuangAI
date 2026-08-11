import { describe, expect, it } from 'vitest'
import { getRemainingCountdownSeconds, normalizeCountdownSeconds } from './countdown'

describe('absolute countdown clock', () => {
    it('normalizes malformed and out-of-range durations', () => {
        expect(normalizeCountdownSeconds(Number.NaN)).toBe(60)
        expect(normalizeCountdownSeconds(Number.POSITIVE_INFINITY)).toBe(60)
        expect(normalizeCountdownSeconds(-30)).toBe(1)
        expect(normalizeCountdownSeconds(3.9)).toBe(3)
        expect(normalizeCountdownSeconds(99_999)).toBe(3600)
    })

    it('derives time from the deadline instead of callback count', () => {
        const startedAt = 1_000_000
        const deadline = startedAt + 60_000
        expect(getRemainingCountdownSeconds(deadline, startedAt)).toBe(60)
        expect(getRemainingCountdownSeconds(deadline, startedAt + 1_001)).toBe(59)
        // 模拟标签页被节流 47.2 秒后仅执行了一次回调。
        expect(getRemainingCountdownSeconds(deadline, startedAt + 47_200)).toBe(13)
        expect(getRemainingCountdownSeconds(deadline, deadline)).toBe(0)
        expect(getRemainingCountdownSeconds(deadline, deadline + 20_000)).toBe(0)
    })

    it('fails closed for non-finite clock values', () => {
        expect(getRemainingCountdownSeconds(Number.NaN, Date.now())).toBe(0)
        expect(getRemainingCountdownSeconds(Date.now(), Number.POSITIVE_INFINITY)).toBe(0)
    })
})
