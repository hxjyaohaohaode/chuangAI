/**
 * 共享元素 FLIP 过渡工具（规范 6.4 / 8.3）
 *
 * FLIP = First, Last, Invert, Play
 * 用于路由切换时图表/标题等共享元素的位置平滑过渡。
 *
 * 工作流：
 * 1. captureFlipRects(container)：在导航发生「前」记录旧页面 [data-flip-id] 元素位置
 * 2. playFlipEnter(container)：新页面挂载「后」读取新位置，计算 delta，反向应用 transform，然后过渡到 identity
 *
 * 用法（在 AppShell 中）：
 *   const handleNavigate = (item) => {
 *     captureFlipRects(contentRef.current)
 *     navigate(item.to)
 *   }
 *   useEffect(() => {
 *     playFlipEnter(contentRef.current)
 *   }, [pathname])
 *
 * 标记共享元素：
 *   <h1 data-flip-id="page-title">标题</h1>
 *   <canvas data-flip-id="radar-chart" />
 *
 * 性能（规范 6.6）：
 * - 仅 transform 动画（GPU 加速）
 * - prefers-reduced-motion 降级：跳过动画，直接显示
 */

const flipRects = new Map<string, DOMRect>()

/**
 * 捕获容器内所有 [data-flip-id] 元素的当前 bounding rect。
 * 应在导航触发「前」调用（旧 DOM 仍在）。
 */
export function captureFlipRects(container: HTMLElement | null): void {
    if (!container) return
    flipRects.clear()
    const els = container.querySelectorAll<HTMLElement>('[data-flip-id]')
    els.forEach((el) => {
        const id = el.dataset.flipId
        if (id) {
            flipRects.set(id, el.getBoundingClientRect())
        }
    })
}

/**
 * 在新内容挂载后播放 FLIP 入场动画。
 * 对每个 [data-flip-id] 元素：若有旧 rect，计算位移与缩放，反向应用后过渡到 identity。
 */
export function playFlipEnter(container: HTMLElement | null): void {
    if (!container) return

    // prefers-reduced-motion 降级
    const reduceMotion =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
        flipRects.clear()
        return
    }

    const els = container.querySelectorAll<HTMLElement>('[data-flip-id]')
    els.forEach((el) => {
        const id = el.dataset.flipId
        if (!id) return
        const oldRect = flipRects.get(id)
        if (!oldRect) return

        const newRect = el.getBoundingClientRect()
        const dx = oldRect.left - newRect.left
        const dy = oldRect.top - newRect.top
        const sx = newRect.width > 0 ? oldRect.width / newRect.width : 1
        const sy = newRect.height > 0 ? oldRect.height / newRect.height : 1

        // 位移/缩放过小则跳过（避免无意义重绘）
        if (
            Math.abs(dx) < 1 &&
            Math.abs(dy) < 1 &&
            Math.abs(sx - 1) < 0.02 &&
            Math.abs(sy - 1) < 0.02
        ) {
            return
        }

        // Invert：反向应用 transform，使元素视觉上回到旧位置
        el.style.transformOrigin = 'top left'
        el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`
        el.style.transition = 'none'
        el.style.willChange = 'transform'

        // 强制 reflow，确保 Invert 生效
        void el.offsetWidth

        // Play：过渡到 identity
        el.style.transition = 'transform var(--dur-route) var(--ease-out)'
        el.style.transform = ''

        const cleanup = () => {
            el.style.transition = ''
            el.style.transform = ''
            el.style.transformOrigin = ''
            el.style.willChange = ''
            el.removeEventListener('transitionend', cleanup)
            el.removeEventListener('transitioncancel', cleanup)
        }
        el.addEventListener('transitionend', cleanup, { once: true })
        el.addEventListener('transitioncancel', cleanup, { once: true })
    })

    // 清理旧 rect（已消费）
    flipRects.clear()
}
