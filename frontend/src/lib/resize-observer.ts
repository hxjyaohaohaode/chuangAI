/**
 * 观察元素尺寸变化。优先使用 ResizeObserver；旧浏览器、受限 WebView 或
 * 存在但构造/observe 会抛错的残缺实现，退回 window resize。两者皆不可用
 * 时返回空清理函数，调用方仍保留首帧测量和完整内容。
 */
export function observeElementResize(element: Element, callback: () => void): () => void {
    if (typeof ResizeObserver === 'function') {
        let observer: ResizeObserver | null = null
        try {
            observer = new ResizeObserver(callback)
            observer.observe(element)
            return () => observer?.disconnect()
        } catch {
            observer?.disconnect()
        }
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('resize', callback, { passive: true })
        return () => window.removeEventListener('resize', callback)
    }
    return () => undefined
}
