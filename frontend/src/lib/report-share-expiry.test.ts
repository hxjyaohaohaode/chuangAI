import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    PUBLIC_SHARE_TIMEOUT_SEGMENT_MS,
    schedulePublicShareExpiry,
} from './report-share-expiry'

describe('public report expiry scheduler', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('re-arms a 30-day link instead of expiring at the first 32-bit timer segment', () => {
        vi.useFakeTimers()
        vi.setSystemTime(0)
        const onExpire = vi.fn()
        const thirtyDays = 30 * 24 * 60 * 60 * 1000
        schedulePublicShareExpiry(thirtyDays, onExpire)

        vi.advanceTimersByTime(PUBLIC_SHARE_TIMEOUT_SEGMENT_MS)
        expect(onExpire).not.toHaveBeenCalled()
        vi.advanceTimersByTime(thirtyDays - PUBLIC_SHARE_TIMEOUT_SEGMENT_MS - 1)
        expect(onExpire).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(onExpire).toHaveBeenCalledTimes(1)
    })

    it('supports repeated segments for 90 days and cleanup cancels the terminal callback', () => {
        vi.useFakeTimers()
        vi.setSystemTime(10_000)
        const onExpire = vi.fn()
        const ninetyDays = 90 * 24 * 60 * 60 * 1000
        const cancel = schedulePublicShareExpiry(10_000 + ninetyDays, onExpire)

        vi.advanceTimersByTime(PUBLIC_SHARE_TIMEOUT_SEGMENT_MS * 2)
        expect(onExpire).not.toHaveBeenCalled()
        cancel()
        vi.advanceTimersByTime(ninetyDays)
        expect(onExpire).not.toHaveBeenCalled()
    })

    it('expires immediately when the page mounts at or after expireAt', () => {
        vi.useFakeTimers()
        vi.setSystemTime(500)
        const onExpire = vi.fn()
        schedulePublicShareExpiry(500, onExpire)
        expect(onExpire).toHaveBeenCalledTimes(1)
    })
})
