/**
 * llm/rate-limiter.ts 单元测试
 *
 * 覆盖：
 * - TokenBucket：tryTake / timeToNextTokenMs / 时间补充
 * - Semaphore：acquire/release / FIFO 唤醒顺序 / release 幂等
 * - ProviderRateLimiter：双限整合、未知 provider 抛错
 * - toRateLimitProvider：路由决策 → 限流 provider 映射
 *
 * 设计原则：使用 vi.useFakeTimers 控制 Date.now，避免真实时间漂移导致断言不稳。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    ProviderRateLimiter,
    RateLimitTimeoutError,
    Semaphore,
    TokenBucket,
    toRateLimitProvider,
    type RateLimitProvider,
} from './rate-limiter.js'
import type { RouteDecision } from './types.js'

// ─────────────────────────────────────────────────────────────
// 辅助：等待微任务/宏任务排空
// ─────────────────────────────────────────────────────────────

/** 让事件循环跑 n 个 tick，便于 Promise 链路稳定 */
async function flush(n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
        await Promise.resolve()
    }
}

// ─────────────────────────────────────────────────────────────
// TokenBucket
// ─────────────────────────────────────────────────────────────

describe('TokenBucket', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('初始容量等于 capacity，可以连续取到 capacity 个令牌', () => {
        const bucket = new TokenBucket(5, 5 / 60)
        for (let i = 0; i < 5; i++) {
            expect(bucket.tryTake()).toBe(true)
        }
        // 第 6 个令牌应失败
        expect(bucket.tryTake()).toBe(false)
    })

    it('令牌耗尽后，timeToNextTokenMs 返回正数', () => {
        const bucket = new TokenBucket(2, 2 / 60) // 每秒补 2/60 个
        expect(bucket.tryTake()).toBe(true)
        expect(bucket.tryTake()).toBe(true)
        expect(bucket.tryTake()).toBe(false)
        const wait = bucket.timeToNextTokenMs()
        expect(wait).toBeGreaterThan(0)
    })

    it('令牌可用时 timeToNextTokenMs 返回 0', () => {
        const bucket = new TokenBucket(3, 1)
        expect(bucket.timeToNextTokenMs()).toBe(0)
    })

    it('按 refillPerSecond 速率补充令牌', () => {
        // 容量 1，每秒补 1 个
        const bucket = new TokenBucket(1, 1)
        expect(bucket.tryTake()).toBe(true)
        expect(bucket.tryTake()).toBe(false)
        // 推进 500ms：补充 0.5 个，仍不足 1
        vi.advanceTimersByTime(500)
        expect(bucket.tryTake()).toBe(false)
        // 再推进 500ms：累计 1 个，可取
        vi.advanceTimersByTime(500)
        expect(bucket.tryTake()).toBe(true)
    })

    it('补充不超过 capacity（容量上限）', () => {
        const bucket = new TokenBucket(3, 100)
        // 推进很长时间，令牌不应超过 3
        vi.advanceTimersByTime(60_000)
        expect(bucket.tryTake()).toBe(true)
        expect(bucket.tryTake()).toBe(true)
        expect(bucket.tryTake()).toBe(true)
        expect(bucket.tryTake()).toBe(false)
    })

    it('零容量 bucket 始终取不到令牌', () => {
        const bucket = new TokenBucket(0, 1)
        expect(bucket.tryTake()).toBe(false)
        expect(bucket.timeToNextTokenMs()).toBeGreaterThan(0)
    })

    it('refill 时若时间未推进则不补充', () => {
        const bucket = new TokenBucket(1, 1)
        expect(bucket.tryTake()).toBe(true)
        // 同一时刻再取，不应补充
        expect(bucket.tryTake()).toBe(false)
    })
})

// ─────────────────────────────────────────────────────────────
// Semaphore
// ─────────────────────────────────────────────────────────────

describe('Semaphore', () => {
    it('容量内 acquire 立即返回 release 函数', async () => {
        const sem = new Semaphore(2)
        const r1 = await sem.acquire()
        const r2 = await sem.acquire()
        expect(typeof r1).toBe('function')
        expect(typeof r2).toBe('function')
        r1()
        r2()
    })

    it('超出容量时 acquire 排队等待，release 后被唤醒', async () => {
        const sem = new Semaphore(1)
        const r1 = await sem.acquire()
        let acquired = false
        const p = sem.acquire().then((r) => {
            acquired = true
            return r
        })
        await flush()
        expect(acquired).toBe(false)
        r1()
        await flush()
        expect(acquired).toBe(true)
        const r2 = await p
        r2()
    })

    it('FIFO 唤醒顺序', async () => {
        const sem = new Semaphore(1)
        const r0 = await sem.acquire()
        const order: string[] = []
        const p1 = sem.acquire().then((r) => {
            order.push('p1')
            return r
        })
        const p2 = sem.acquire().then((r) => {
            order.push('p2')
            return r
        })
        const p3 = sem.acquire().then((r) => {
            order.push('p3')
            return r
        })
        await flush()
        expect(order).toEqual([])
        // r0 释放 → p1 唤醒
        r0()
        const r1 = await p1
        expect(order).toEqual(['p1'])
        // r1 释放 → p2 唤醒
        r1()
        const r2 = await p2
        expect(order).toEqual(['p1', 'p2'])
        // r2 释放 → p3 唤醒
        r2()
        const r3 = await p3
        expect(order).toEqual(['p1', 'p2', 'p3'])
        r3()
    })

    it('release 幂等：重复调用不释放多个槽位', async () => {
        const sem = new Semaphore(1)
        const r1 = await sem.acquire()
        // 重复 release
        r1()
        r1()
        r1()
        // 此时仍只有 1 个槽位可用
        const r2 = await sem.acquire()
        let acquired = false
        const p = sem.acquire().then((r) => {
            acquired = true
            return r
        })
        await flush()
        expect(acquired).toBe(false)
        r2()
        await flush()
        expect(acquired).toBe(true)
        const r3 = await p
        r3()
    })

    it('release 后槽位可被复用（容量回到初始）', async () => {
        const sem = new Semaphore(3)
        const releases = []
        for (let i = 0; i < 3; i++) {
            releases.push(await sem.acquire())
        }
        // 全部释放
        for (const r of releases) r()
        // 应能再次取 3 个
        const r2 = []
        for (let i = 0; i < 3; i++) {
            r2.push(await sem.acquire())
        }
        expect(r2.length).toBe(3)
        for (const r of r2) r()
    })

    it('零容量信号量 acquire 必须等待 release 才能解锁', async () => {
        const sem = new Semaphore(0)
        let acquired = false
        const p = sem.acquire().then((r) => {
            acquired = true
            return r
        })
        await flush()
        expect(acquired).toBe(false)
        // 没有人 release，永远不会 acquired
        // 这里我们手动模拟：先 release（虽然未持有）会怎样？
        // 实际上零容量下若直接 acquire，会陷入无限等待；
        // 我们用 Promise.race + 超时来验证它确实在等待
        const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50))
        const result = await Promise.race([p.then(() => 'acquired'), timeout])
        expect(result).toBe('timeout')
    })

    it('取消排队请求后不会留下幽灵 waiter 或吞掉后续槽位', async () => {
        const sem = new Semaphore(1)
        const firstRelease = await sem.acquire()
        const controller = new AbortController()
        const pending = sem.acquire(controller.signal)
        controller.abort()
        await expect(pending).rejects.toThrow('Aborted')

        firstRelease()
        const secondRelease = await sem.acquire()
        expect(typeof secondRelease).toBe('function')
        secondRelease()
    })
})

// ─────────────────────────────────────────────────────────────
// toRateLimitProvider
// ─────────────────────────────────────────────────────────────

describe('toRateLimitProvider', () => {
    it('mimo provider 映射到 mimo', () => {
        const decision: RouteDecision = {
            provider: 'mimo',
            model: 'mimo-v2.5',
            thinking: 'medium',
            reason: 'test',
        }
        expect(toRateLimitProvider(decision)).toBe<RateLimitProvider>('mimo')
    })

    it('deepseek + flash 模型映射到 deepseek-flash', () => {
        const decision: RouteDecision = {
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            thinking: 'low',
            reason: 'test',
        }
        expect(toRateLimitProvider(decision)).toBe<RateLimitProvider>('deepseek-flash')
    })

    it('deepseek + pro 模型映射到 deepseek', () => {
        const decision: RouteDecision = {
            provider: 'deepseek',
            model: 'deepseek-v4-pro',
            thinking: 'max',
            reason: 'test',
        }
        expect(toRateLimitProvider(decision)).toBe<RateLimitProvider>('deepseek')
    })

    it('deepseek + 模型名包含 flash 子串仍映射到 deepseek-flash', () => {
        const decision: RouteDecision = {
            provider: 'deepseek',
            model: 'deepseek-v4-flash-experimental',
            reason: 'test',
        }
        expect(toRateLimitProvider(decision)).toBe<RateLimitProvider>('deepseek-flash')
    })

    it('deepseek + 不含 flash 的模型名映射到 deepseek', () => {
        const decision: RouteDecision = {
            provider: 'deepseek',
            model: 'deepseek-v4-pro',
            reason: 'test',
        }
        expect(toRateLimitProvider(decision)).toBe<RateLimitProvider>('deepseek')
    })
})

// ─────────────────────────────────────────────────────────────
// ProviderRateLimiter
// ─────────────────────────────────────────────────────────────

describe('ProviderRateLimiter', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('对三个 provider 都初始化了 bucket + semaphore', async () => {
        const limiter = new ProviderRateLimiter()
        // 三个 provider 都应能立即 acquire（容量远大于 1）
        const r1 = await limiter.acquire('deepseek')
        const r2 = await limiter.acquire('deepseek-flash')
        const r3 = await limiter.acquire('mimo')
        expect(typeof r1).toBe('function')
        expect(typeof r2).toBe('function')
        expect(typeof r3).toBe('function')
        r1()
        r2()
        r3()
    })

    it('未知 provider 抛出错误', async () => {
        const limiter = new ProviderRateLimiter()
        await expect(
            limiter.acquire('unknown' as unknown as RateLimitProvider),
        ).rejects.toThrow(/未知限流 provider/)
    })

    it('acquire 返回的 release 释放后可再次 acquire', async () => {
        // mimo 并发 100，足够测试，用真实容量验证释放复用
        const limiter = new ProviderRateLimiter()
        const r1 = await limiter.acquire('mimo')
        r1()
        const r2 = await limiter.acquire('mimo')
        r2()
        // 不应抛错即视为通过
        expect(true).toBe(true)
    })

    it('令牌等待期间收到 AbortSignal 后立即取消，不继续幽灵排队', async () => {
        const limiter = new ProviderRateLimiter()
        const releases: Array<() => void> = []
        for (let i = 0; i < 100; i++) {
            releases.push(await limiter.acquire('mimo'))
        }

        const controller = new AbortController()
        const pending = limiter.acquire('mimo', controller.signal)
        controller.abort('request-closed')

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        for (const release of releases) release()
    })

    it('并发槽等待期间收到 AbortSignal 后从信号量队列移除', async () => {
        type LimiterInternals = {
            semaphores: Map<RateLimitProvider, Semaphore>
        }
        const limiter = new ProviderRateLimiter()
        const internals = limiter as unknown as LimiterInternals
        internals.semaphores.set('mimo', new Semaphore(0))

        const controller = new AbortController()
        const pending = limiter.acquire('mimo', controller.signal)
        controller.abort('request-closed')

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('RateLimitTimeoutError 携带 provider 与 timeoutMs', () => {
        const err = new RateLimitTimeoutError('mimo', 30_000)
        expect(err.provider).toBe('mimo')
        expect(err.timeoutMs).toBe(30_000)
        expect(err.message).toContain('mimo')
        expect(err.message).toContain('30000')
        expect(err.name).toBe('RateLimitTimeoutError')
    })

    it('令牌耗尽 + 等待超时 → 抛 RateLimitTimeoutError', async () => {
        // 自定义一个小容量限流器
        // 通过构造私有内部状态难以注入，这里改用真实 mimo（RPM=100）
        // 用大量 acquire 耗尽 100 个令牌后，第 101 个会进入等待
        // 推进时间超过 30s 后应抛 RateLimitTimeoutError
        const limiter = new ProviderRateLimiter()
        // 耗尽 mimo 令牌（容量 100）
        const releases: Array<() => void> = []
        for (let i = 0; i < 100; i++) {
            releases.push(await limiter.acquire('mimo'))
        }
        // 此时令牌已耗尽，再 acquire 会进入 waitForToken 轮询
        const acquirePromise = limiter.acquire('mimo')
        // 立即附加 rejection handler，防止在 advanceTimers 期间产生 Unhandled Rejection
        acquirePromise.catch(() => { })
        // 异步推进 31 秒，让 microtask 串联执行
        // 超过 30s 超时
        await vi.advanceTimersByTimeAsync(31_000)
        await expect(acquirePromise).rejects.toBeInstanceOf(RateLimitTimeoutError)
        // 清理：释放所有持有的槽位
        for (const r of releases) r()
    }, 30_000)

    it('令牌耗尽后在超时前补充令牌 → acquire 成功', async () => {
        const limiter = new ProviderRateLimiter()
        const releases: Array<() => void> = []
        // mimo RPM=100，并发 100。先 acquire 100 次耗尽令牌
        for (let i = 0; i < 100; i++) {
            releases.push(await limiter.acquire('mimo'))
        }
        // 立即释放所有 semaphore 槽位（令牌不返还，仍为 0）
        // 这样 semaphore 全部可用，仅令牌桶为空
        for (const rel of releases) rel()
        releases.length = 0

        // 第 101 个 acquire 进入 waitForToken 等待
        let resolved = false
        const p = limiter.acquire('mimo').then((r) => {
            resolved = true
            return r
        })
        // 立即附加 rejection handler，防止意外 rejection 成为 Unhandled Rejection
        p.catch(() => { })
        // 推进 60 秒，按 RPM=100 → 每秒补 100/60 ≈ 1.67 个令牌
        // 60 秒后会补满 100 个令牌，肯定能取到
        await vi.advanceTimersByTimeAsync(60_000)
        expect(resolved).toBe(true)
        const r = await p
        r()
    }, 30_000)

    it('令牌超时、迟到槽位和队列拒绝均返回受控结果', async () => {
        type LimiterInternals = {
            buckets: Map<RateLimitProvider, TokenBucket>
            semaphores: Map<RateLimitProvider, Semaphore>
        }

        // 令牌桶永不补充，覆盖 waitForToken 的 deadline 分支。
        const tokenTimeout = new ProviderRateLimiter()
        const tokenInternals = tokenTimeout as unknown as LimiterInternals
        tokenInternals.buckets.set('mimo', new TokenBucket(0, 0))
        const tokenPromise = tokenTimeout.acquire('mimo')
        tokenPromise.catch(() => { })
        await vi.advanceTimersByTimeAsync(30_001)
        await expect(tokenPromise).rejects.toBeInstanceOf(RateLimitTimeoutError)

        // 模拟外部/实现变更导致槽位在超时后才返回，验证 release 兜底。
        const lateAcquire = new ProviderRateLimiter()
        const lateInternals = lateAcquire as unknown as LimiterInternals
        lateInternals.semaphores.set('mimo', {
            acquire: () => new Promise((resolve) => {
                setTimeout(() => resolve(() => { }), 31_000)
            }),
        } as unknown as Semaphore)
        const latePromise = lateAcquire.acquire('mimo')
        latePromise.catch(() => { })
        await vi.advanceTimersByTimeAsync(30_001)
        await expect(latePromise).rejects.toBeInstanceOf(RateLimitTimeoutError)
        await vi.advanceTimersByTimeAsync(1_000)

        // 队列实现主动拒绝时，仍转换为统一限流错误，而不是泄漏原始异常。
        const rejectedAcquire = new ProviderRateLimiter()
        const rejectedInternals = rejectedAcquire as unknown as LimiterInternals
        rejectedInternals.semaphores.set('mimo', {
            acquire: () => Promise.reject(new Error('queue-aborted')),
        } as unknown as Semaphore)
        await expect(rejectedAcquire.acquire('mimo')).rejects.toBeInstanceOf(RateLimitTimeoutError)
    }, 35_000)
})
