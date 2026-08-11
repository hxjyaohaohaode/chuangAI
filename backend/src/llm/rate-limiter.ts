/**
 * 主动限流闸门
 *
 * 在 LLM 调用前主动施加双层限流，避免被动 429 兜底造成的尾部延迟与配额浪费：
 *
 * 1. 令牌桶（TokenBucket）—— 按 RPM 限流：容量 = RPM，每秒补充 RPM/60 个令牌
 * 2. 信号量（Semaphore）  —— 按并发限流：acquire/release 配对，超出容量则排队
 *
 * ProviderRateLimiter 按 provider 维护双限，acquire(provider) 先等令牌再等并发槽，
 * 返回 release 函数；等待超过 30s 抛出 RateLimitTimeoutError。
 *
 * 限流参数（依据大模型API文档.md）：
 * ┌─────────────────┬─────────┬──────┐
 * │ Provider        │ 并发    │ RPM  │
 * ├─────────────────┼─────────┼──────┤
 * │ deepseek        │ 500     │ 500  │  v4-pro，保守取 min(并发, RPM)
 * │ deepseek-flash  │ 2500    │ 2500 │  v4-flash
 * │ mimo            │ 100     │ 100  │  v2.5 / v2.5-pro / tts / asr
 * └─────────────────┴─────────┴──────┘
 */

import type { RouteDecision } from './types.js'

// ─────────────────────────────────────────────────────────────
// 限流 Provider 类型
// ─────────────────────────────────────────────────────────────

/**
 * 限流维度 provider 键
 *
 * 注意：与 RouteDecision.provider（'deepseek' | 'mimo'）不同，
 * 此处将 deepseek 拆分为 pro / flash 两条独立限流通道，
 * 因为两者并发与 RPM 配额独立计算。
 */
export type RateLimitProvider = 'deepseek' | 'deepseek-flash' | 'mimo'

/**
 * 将路由决策映射到限流 provider
 *
 * - deepseek + v4-flash 模型 → 'deepseek-flash'
 * - deepseek + 其他模型（v4-pro） → 'deepseek'
 * - mimo（任意 mimo 模型） → 'mimo'
 */
export function toRateLimitProvider(decision: RouteDecision): RateLimitProvider {
    if (decision.provider === 'mimo') return 'mimo'
    // deepseek 族：按模型名区分 pro / flash
    if (decision.model.includes('flash')) return 'deepseek-flash'
    return 'deepseek'
}

// ─────────────────────────────────────────────────────────────
// 限流配置
// ─────────────────────────────────────────────────────────────

interface ProviderLimit {
    /** 最大并发 */
    concurrency: number
    /** 每分钟最大请求数 */
    rpm: number
}

const PROVIDER_LIMITS: Record<RateLimitProvider, ProviderLimit> = {
    deepseek: { concurrency: 500, rpm: 500 },
    'deepseek-flash': { concurrency: 2500, rpm: 2500 },
    mimo: { concurrency: 100, rpm: 100 },
}

/** acquire 等待超时（毫秒） */
const ACQUIRE_TIMEOUT_MS = 30_000

// ─────────────────────────────────────────────────────────────
// RateLimitTimeoutError
// ─────────────────────────────────────────────────────────────

/**
 * 限流等待超时错误
 *
 * acquire 在令牌桶或信号量等待超过 30s 时抛出。
 */
export class RateLimitTimeoutError extends Error {
    constructor(
        public readonly provider: RateLimitProvider,
        public readonly timeoutMs: number,
    ) {
        super(`限流等待超时: provider=${provider}, timeout=${timeoutMs}ms`)
        this.name = 'RateLimitTimeoutError'
    }
}

// ─────────────────────────────────────────────────────────────
// TokenBucket —— 令牌桶（按 RPM 限流）
// ─────────────────────────────────────────────────────────────

/**
 * 令牌桶
 *
 * 容量 = RPM，每秒补充 RPM/60 个令牌。
 * tryTake() 尝试取 1 个令牌，成功返回 true，失败返回 false。
 * 令牌数可为小数（连续补充），取令牌时判断是否 >= 1。
 */
export class TokenBucket {
    private tokens: number
    private lastRefillMs: number

    constructor(
        private readonly capacity: number,
        private readonly refillPerSecond: number,
    ) {
        this.tokens = capacity
        this.lastRefillMs = Date.now()
    }

    /** 按时间流逝补充令牌 */
    private refill(): void {
        const now = Date.now()
        const elapsedSec = (now - this.lastRefillMs) / 1000
        if (elapsedSec <= 0) return
        this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond)
        this.lastRefillMs = now
    }

    /** 尝试取 1 个令牌，成功返回 true */
    tryTake(): boolean {
        this.refill()
        if (this.tokens >= 1) {
            this.tokens -= 1
            return true
        }
        return false
    }

    /** 返回距下一个令牌可用还需等待的毫秒数（0 表示立即可用） */
    timeToNextTokenMs(): number {
        this.refill()
        if (this.tokens >= 1) return 0
        // 还需 (1 - tokens) 个令牌，每秒补充 refillPerSecond 个
        return ((1 - this.tokens) / this.refillPerSecond) * 1000
    }
}

// ─────────────────────────────────────────────────────────────
// Semaphore —— 并发信号量
// ─────────────────────────────────────────────────────────────

/**
 * 异步并发信号量
 *
 * acquire() 获取一个槽位，返回 release 函数。
 * 槽位耗尽时 acquire 排队等待，release 时按 FIFO 唤醒。
 * release 幂等：重复调用无效（防止使用方误用导致槽位泄漏）。
 */
export class Semaphore {
    private available: number
    private readonly waiters: Array<{
        resolve: (release: () => void) => void
        reject: (reason: unknown) => void
        signal?: AbortSignal
        onAbort?: () => void
        cancelled: boolean
    }> = []

    constructor(capacity: number) {
        this.available = capacity
    }

    async acquire(signal?: AbortSignal): Promise<() => void> {
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError')
        }
        if (this.available > 0) {
            this.available--
            return this.createRelease()
        }
        // 排队等待
        return new Promise<() => void>((resolve, reject) => {
            const waiter = {
                resolve,
                reject,
                signal,
                onAbort: undefined as (() => void) | undefined,
                cancelled: false,
            }
            if (signal) {
                waiter.onAbort = () => {
                    waiter.cancelled = true
                    const index = this.waiters.indexOf(waiter)
                    if (index >= 0) this.waiters.splice(index, 1)
                    reject(new DOMException('Aborted', 'AbortError'))
                }
                signal.addEventListener('abort', waiter.onAbort, { once: true })
            }
            this.waiters.push(waiter)
        })
    }

    /** 将一个释放的槽位交给首个仍有效的等待者。 */
    private handoff(): void {
        while (this.waiters.length > 0) {
            const next = this.waiters.shift()
            if (!next || next.cancelled) continue
            if (next.signal && next.onAbort) {
                next.signal.removeEventListener('abort', next.onAbort)
            }
            // 被唤醒时直接获得槽位（available 已由 release 让渡，不再 -1）
            next.resolve(this.createRelease())
            return
        }
        this.available++
    }

    private createRelease(): () => void {
        let released = false
        return () => {
            if (released) return
            released = true
            // 直接将槽位让渡给下一个等待者；若队列中的请求已超时/取消，
            // handoff 会跳过它们并最终恢复 available，避免“幽灵”占槽。
            this.handoff()
        }
    }
}

// ─────────────────────────────────────────────────────────────
// ProviderRateLimiter —— 按 provider 维护双限
// ─────────────────────────────────────────────────────────────

/**
 * 按 provider 维护令牌桶 + 信号量的双限流器
 *
 * acquire(provider) 流程：
 * 1. 等待令牌桶令牌（RPM 限流）
 * 2. 获取并发信号量（并发限流）
 * 3. 返回 release 函数，调用方在 LLM 调用结束后必须调用以释放并发槽
 *
 * 任一阶段等待超过 30s 抛出 RateLimitTimeoutError。
 * 令牌桶令牌一旦消耗不可返还（令牌桶语义）；信号量槽位由 release 释放。
 */
export class ProviderRateLimiter {
    private readonly buckets: Map<RateLimitProvider, TokenBucket>
    private readonly semaphores: Map<RateLimitProvider, Semaphore>

    constructor() {
        this.buckets = new Map()
        this.semaphores = new Map()
        for (const provider of Object.keys(PROVIDER_LIMITS) as RateLimitProvider[]) {
            const limit = PROVIDER_LIMITS[provider]
            this.buckets.set(provider, new TokenBucket(limit.rpm, limit.rpm / 60))
            this.semaphores.set(provider, new Semaphore(limit.concurrency))
        }
    }

    /**
     * 获取限流许可
     *
     * @param provider 限流 provider 键
     * @returns release 函数，调用以释放并发槽位（令牌不返还）
     * @throws RateLimitTimeoutError 等待超过 30s
     */
    async acquire(provider: RateLimitProvider, signal?: AbortSignal): Promise<() => void> {
        throwIfAborted(signal)
        const bucket = this.buckets.get(provider)
        const semaphore = this.semaphores.get(provider)
        if (!bucket || !semaphore) {
            throw new Error(`未知限流 provider: ${provider}`)
        }

        const deadline = Date.now() + ACQUIRE_TIMEOUT_MS

        // 阶段 1：等待令牌桶令牌
        await this.waitForToken(provider, bucket, deadline, signal)

        // 阶段 2：等待并发信号量（若超时，令牌已消耗不可返还）
        return this.waitForSemaphore(provider, semaphore, deadline, signal)
    }

    /** 轮询等待令牌桶令牌，超时抛出 RateLimitTimeoutError */
    private async waitForToken(
        provider: RateLimitProvider,
        bucket: TokenBucket,
        deadline: number,
        signal?: AbortSignal,
    ): Promise<void> {
        while (true) {
            throwIfAborted(signal)
            if (bucket.tryTake()) return
            const now = Date.now()
            if (now >= deadline) {
                throw new RateLimitTimeoutError(provider, ACQUIRE_TIMEOUT_MS)
            }
            // 等待下一令牌或超时，取较小值，并限制单次轮询上限 100ms
            const wait = Math.min(bucket.timeToNextTokenMs(), deadline - now, 100)
            await sleep(Math.max(wait, 1), signal)
        }
    }

    /** 等待信号量槽位，超时抛出 RateLimitTimeoutError；超时后若仍获得槽位则立即释放避免泄漏 */
    private async waitForSemaphore(
        provider: RateLimitProvider,
        semaphore: Semaphore,
        deadline: number,
        signal?: AbortSignal,
    ): Promise<() => void> {
        throwIfAborted(signal)
        return new Promise<() => void>((resolve, reject) => {
            let settled = false
            const timeoutController = new AbortController()
            const cleanup = (): void => {
                clearTimeout(timer)
                signal?.removeEventListener('abort', onAbort)
            }
            const onAbort = (): void => {
                if (settled) return
                settled = true
                timeoutController.abort(signal?.reason)
                cleanup()
                reject(createAbortError())
            }
            const timer = setTimeout(() => {
                if (settled) return
                settled = true
                timeoutController.abort('rate-limit-timeout')
                cleanup()
                reject(new RateLimitTimeoutError(provider, ACQUIRE_TIMEOUT_MS))
            }, Math.max(deadline - Date.now(), 0))
            signal?.addEventListener('abort', onAbort, { once: true })

            semaphore.acquire(timeoutController.signal).then((release) => {
                if (settled) {
                    // 已超时，立即释放避免槽位泄漏
                    release()
                } else {
                    settled = true
                    cleanup()
                    resolve(release)
                }
            }, () => {
                // Abort 只表示等待者已从队列移除；若超时回调尚未完成，
                // 仍由这里统一返回同一个业务错误。
                if (!settled) {
                    settled = true
                    cleanup()
                    reject(signal?.aborted
                        ? createAbortError()
                        : new RateLimitTimeoutError(provider, ACQUIRE_TIMEOUT_MS))
                }
            })
        })
    }
}

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw createAbortError()
}

function createAbortError(): DOMException {
    return new DOMException('Aborted', 'AbortError')
}

/** 可中断的 sleep；请求取消后立即移除计时器，避免幽灵限流等待。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(createAbortError())
    return new Promise((resolve, reject) => {
        const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
        const timer = setTimeout(() => {
            cleanup()
            resolve()
        }, ms)
        const onAbort = (): void => {
            clearTimeout(timer)
            cleanup()
            reject(createAbortError())
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}
