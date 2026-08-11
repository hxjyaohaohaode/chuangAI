const DEFAULT_COUNTDOWN_SECONDS = 60
const MAX_COUNTDOWN_SECONDS = 60 * 60

/**
 * 把来自题目数据的时长收敛到可展示、可调度的有限整数范围。
 * 后端正常契约为 5..3600 秒；这里仍保留 1 秒的前端容错下限，避免旧数据
 * 或演示夹具把倒计时变成负数、Infinity 或持续数天的后台任务。
 */
export function normalizeCountdownSeconds(
    value: unknown,
    fallback = DEFAULT_COUNTDOWN_SECONDS,
): number {
    const safeFallback = Number.isFinite(fallback)
        ? Math.min(MAX_COUNTDOWN_SECONDS, Math.max(1, Math.floor(fallback)))
        : DEFAULT_COUNTDOWN_SECONDS
    if (typeof value !== 'number' || !Number.isFinite(value)) return safeFallback
    return Math.min(MAX_COUNTDOWN_SECONDS, Math.max(1, Math.floor(value)))
}

/** 根据绝对截止时间计算剩余整秒；不依赖定时器是否被浏览器节流。 */
export function getRemainingCountdownSeconds(deadlineMs: number, nowMs: number): number {
    if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return 0
    return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000))
}
