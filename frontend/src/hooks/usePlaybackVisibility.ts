import { useEffect, useState, type RefObject } from 'react'

export interface PlaybackVisibility {
    documentVisible: boolean
    inViewport: boolean
    active: boolean
}

/**
 * 自动轮播/装饰动画的统一生命周期门。
 *
 * 页面隐藏或元素离开视口时返回 active=false；IntersectionObserver 缺失、
 * 构造或 observe 失败时 fail-open，保证老 WebView 仍能使用组件而不会白屏。
 */
export function usePlaybackVisibility(targetRef: RefObject<Element | null>): PlaybackVisibility {
    const [documentVisible, setDocumentVisible] = useState(() => (
        typeof document === 'undefined' || document.visibilityState !== 'hidden'
    ))
    const [inViewport, setInViewport] = useState(true)

    useEffect(() => {
        if (typeof document === 'undefined') return
        const sync = () => setDocumentVisible(document.visibilityState !== 'hidden')
        sync()
        document.addEventListener('visibilitychange', sync)
        return () => document.removeEventListener('visibilitychange', sync)
    }, [])

    useEffect(() => {
        const target = targetRef.current
        if (!target || typeof IntersectionObserver !== 'function') {
            setInViewport(true)
            return
        }

        let observer: IntersectionObserver | null = null
        try {
            observer = new IntersectionObserver(
                ([entry]) => setInViewport(Boolean(entry?.isIntersecting)),
                { rootMargin: '120px 0px', threshold: 0.01 },
            )
            observer.observe(target)
        } catch {
            observer?.disconnect()
            setInViewport(true)
            return
        }
        return () => observer?.disconnect()
    }, [targetRef])

    return {
        documentVisible,
        inViewport,
        active: documentVisible && inViewport,
    }
}
