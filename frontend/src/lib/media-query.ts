export type MediaQueryChangeHandler = (event: MediaQueryListEvent) => void

/** 安全读取媒体查询首值；API 缺失或残缺实现抛错时返回显式兜底值。 */
export function matchesMediaQuery(query: string, fallback = false): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return fallback
    try {
        return window.matchMedia(query).matches
    } catch {
        return fallback
    }
}

/**
 * 订阅媒体查询变化，同时兼容现代 EventTarget API 与旧 Safari/WebView 的
 * addListener API。两套 API 都缺失时保持静态首值，不让渐进增强拖垮页面。
 */
export function subscribeMediaQuery(
    query: MediaQueryList,
    handler: MediaQueryChangeHandler,
): () => void {
    if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', handler)
        return () => query.removeEventListener?.('change', handler)
    }
    if (typeof query.addListener === 'function') {
        query.addListener(handler)
        return () => query.removeListener?.(handler)
    }
    return () => undefined
}
