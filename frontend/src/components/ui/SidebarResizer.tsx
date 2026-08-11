import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { subscribeMediaQuery } from '@/lib/media-query'
import './SidebarResizer.css'

/**
 * SidebarResizer —— 侧边栏宽度可调节手柄
 *
 * 设计依据：
 * - 规范 2.4 强调色体系：仅 hover/drag 显 accent-primary
 * - 规范 4.1 无边框设计：常态透明，hover 显色块
 * - 规范 6.2 spring-soft 缓动：cubic-bezier(0.25, 0.1, 0.07, 1.45)
 * - 规范 6.3 时长：微交互 150ms
 * - 规范 8.4 状态保持：宽度持久化 localStorage
 *
 * 交互：
 * - 拖拽：mousedown 启动 → document mousemove 实时更新 → mouseup 结束
 * - 双击：在六档预设间循环切换
 * - 触摸：touchstart/touchmove/touchend 等价鼠标交互
 * - 移动端（<768px）不渲染
 *
 * 全局副作用：
 * - 拖拽中：body.sidebar-resizing 类（cursor: col-resize + 禁用文本选择）
 * - 同步：AppShell aside 通过 body.sidebar-resizing 类禁用 width transition
 */

const STORAGE_KEY = 'poetic-realm.sidebar-width'
const PRESETS = [220, 280, 360, 480, 560, 640] as const
const MOBILE_BREAKPOINT = 767

export interface SidebarResizerProps {
    /** 当前侧边栏宽度（px） */
    width: number
    /** 宽度变化回调（拖拽中实时触发） */
    onResize: (width: number) => void
    /** 最小宽度，默认 200 */
    minWidth?: number
    /** 最大宽度，默认 640。保留至少一块可工作的主内容区，避免侧栏吞没画布。 */
    maxWidth?: number
}

function getIsMobile(): boolean {
    return (
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches
    )
}

function clamp(v: number, min: number, max: number): number {
    return Math.min(Math.max(v, min), max)
}

export function SidebarResizer({
    width,
    onResize,
    minWidth = 200,
    maxWidth = 640,
}: SidebarResizerProps) {
    const [isDragging, setIsDragging] = useState(false)
    const [isMobile, setIsMobile] = useState<boolean>(getIsMobile)
    const dragStateRef = useRef<{ startX: number; startWidth: number }>({
        startX: 0,
        startWidth: 0,
    })

    // 移动端检测：监听媒体查询变化
    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return
        const media = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`)
        const sync = () => setIsMobile(media.matches)
        sync()
        return subscribeMediaQuery(media, sync)
    }, [])

    // 宽度持久化：debounce 200ms 保存到 localStorage
    useEffect(() => {
        const t = window.setTimeout(() => {
            try {
                localStorage.setItem(STORAGE_KEY, String(width))
            } catch {
                // 静默失败：localStorage 可能被禁用或配额已满
            }
        }, 200)
        return () => window.clearTimeout(t)
    }, [width])

    const handleMouseMove = useCallback(
        (e: MouseEvent) => {
            const delta = e.clientX - dragStateRef.current.startX
            const next = clamp(dragStateRef.current.startWidth + delta, minWidth, maxWidth)
            onResize(next)
        },
        [onResize, minWidth, maxWidth],
    )

    const handleTouchMove = useCallback(
        (e: TouchEvent) => {
            const touch = e.touches[0]
            if (!touch) return
            // 阻止页面跟随滚动
            if (e.cancelable) e.preventDefault()
            const delta = touch.clientX - dragStateRef.current.startX
            const next = clamp(dragStateRef.current.startWidth + delta, minWidth, maxWidth)
            onResize(next)
        },
        [onResize, minWidth, maxWidth],
    )

    const handleEnd = useCallback(() => {
        setIsDragging(false)
        document.body.classList.remove('sidebar-resizing')
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleEnd)
        document.removeEventListener('touchmove', handleTouchMove)
        document.removeEventListener('touchend', handleEnd)
        document.removeEventListener('touchcancel', handleEnd)
    }, [handleMouseMove, handleTouchMove])

    // 桌面窗口在拖拽途中被缩窄到移动断点时，手柄会卸载。此时主动撤销
    // document 级监听器和 body 光标状态，避免鼠标松开事件落在已隐藏控件外
    // 后留下持续的 col-resize 光标或禁止选择状态。
    useEffect(() => {
        if (isMobile) handleEnd()
    }, [isMobile, handleEnd])

    // 组件卸载时清理全局监听器与 body 类
    useEffect(() => {
        return () => {
            document.body.classList.remove('sidebar-resizing')
            document.removeEventListener('mousemove', handleMouseMove)
            document.removeEventListener('mouseup', handleEnd)
            document.removeEventListener('touchmove', handleTouchMove)
            document.removeEventListener('touchend', handleEnd)
            document.removeEventListener('touchcancel', handleEnd)
        }
    }, [handleMouseMove, handleEnd, handleTouchMove])

    // 移动端不渲染（hooks 之后再 return，保证 hooks 调用顺序稳定）
    if (isMobile) return null

    const startDrag = (clientX: number, currentWidth: number) => {
        dragStateRef.current.startX = clientX
        dragStateRef.current.startWidth = currentWidth
        setIsDragging(true)
        document.body.classList.add('sidebar-resizing')
        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', handleEnd)
        document.addEventListener('touchmove', handleTouchMove, { passive: false })
        document.addEventListener('touchend', handleEnd)
        document.addEventListener('touchcancel', handleEnd)
    }

    const handleMouseDown = (e: React.MouseEvent) => {
        // 阻止默认行为：避免触发文本选择/拖拽 ghost
        e.preventDefault()
        startDrag(e.clientX, width)
    }

    const handleTouchStart = (e: React.TouchEvent) => {
        const touch = e.touches[0]
        if (!touch) return
        startDrag(touch.clientX, width)
    }

    const handleDoubleClick = () => {
        // 在六档预设间循环切换：当前命中某档 → 取下一档；未命中 → 取大于当前宽度的最近档
        const currentIdx = PRESETS.findIndex((p) => p === width)
        let nextIdx: number
        if (currentIdx === -1) {
            const nextLarger = PRESETS.findIndex((p) => p > width)
            nextIdx = nextLarger === -1 ? 0 : nextLarger
        } else {
            nextIdx = (currentIdx + 1) % PRESETS.length
        }
        const preset = PRESETS[nextIdx]
        if (preset === undefined) return
        const next = clamp(preset, minWidth, maxWidth)
        onResize(next)
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        // 可调 separator 遵循连续值控件的键盘预期：箭头微调、Page 大步、
        // Home/End 直接到边界。所有分支经 clamp，父级即使传入非预设宽度也安全。
        const step = e.shiftKey ? 32 : 8
        let next: number | null = null
        if (e.key === 'ArrowLeft') next = width - step
        else if (e.key === 'ArrowRight') next = width + step
        else if (e.key === 'PageDown') next = width - 32
        else if (e.key === 'PageUp') next = width + 32
        else if (e.key === 'Home') next = minWidth
        else if (e.key === 'End') next = maxWidth
        if (next !== null) {
            e.preventDefault()
            onResize(clamp(next, minWidth, maxWidth))
        }
    }

    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label="侧边栏宽度"
            aria-description="可拖拽或双击切换预设；左右方向键微调，PageUp 和 PageDown 大步调节，Home 和 End 到达最小或最大宽度。"
            aria-valuenow={Math.round(width)}
            aria-valuemin={minWidth}
            aria-valuemax={maxWidth}
            aria-valuetext={`当前侧边栏宽度 ${Math.round(width)} 像素`}
            tabIndex={0}
            className={cn('sidebar-resizer', isDragging && 'dragging')}
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleKeyDown}
        />
    )
}
