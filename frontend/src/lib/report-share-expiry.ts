/** 浏览器 32 位 timeout 的安全分段上限，略低于 2^31-1。 */
export const PUBLIC_SHARE_TIMEOUT_SEGMENT_MS = 2_147_000_000

/**
 * 在准确到期时触发回调，并为 25–90 天链接分段重新排程。
 *
 * 不能把长 remaining 直接截断后无条件判过期：30 天链接会因此提前约 5 天
 * 消失。每一段结束都重新读取当前时间；系统休眠、时钟跳变和浏览器节流后也
 * 只有在权威 expireAt 已到时才进入失效态。
 */
export function schedulePublicShareExpiry(
    expireAt: number,
    onExpire: () => void,
    now: () => number = () => Date.now(),
): () => void {
    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const arm = () => {
        if (cancelled) return
        const remaining = expireAt - now()
        if (remaining <= 0) {
            onExpire()
            return
        }
        timeoutId = globalThis.setTimeout(
            arm,
            Math.min(remaining, PUBLIC_SHARE_TIMEOUT_SEGMENT_MS),
        )
    }

    arm()
    return () => {
        cancelled = true
        if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId)
    }
}
