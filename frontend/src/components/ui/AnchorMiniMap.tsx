/**
 * AnchorMiniMap —— 锚点迷你地图组件
 *
 * 设计依据：
 * - 规范 2.3 透明度分层：surface-elevated rgba(255,252,248,0.85) + backdrop-blur 20px
 * - 规范 2.4 强调色体系：active 态使用 accent-primary 10% alpha 背景 + 100% 文字
 * - 规范 4.1 无边框设计：仅 active 态显示 2px 左侧 accent 竖线作为指示
 * - 规范 6.2 / 6.3 时长：宽高过渡 200ms ease-out
 * - 规范 7.2 微交互：hover 100ms 反馈背景色变
 * - 规范 8.4 状态保持：展开状态持久化 localStorage
 * - 规范 13.1 无 emoji：纯 SVG 图标语义
 * - 规范 15.1 CSS 变量：所有色值/时长/缓动均引用 token，零硬编码
 *
 * 工作机制：
 * 1. 挂载后扫描 containerSelector 容器内所有 [data-anchor] 元素
 * 2. 为每个元素生成目录项（id + label）
 * 3. IntersectionObserver 监听章节可见性，激活当前章节
 * 4. 点击目录项平滑滚动到对应锚点
 * 5. 收起态保留 44px 触控轨，hover / focus / 固定展开后扩展为 200px 面板
 * 6. 展开状态持久化到 localStorage（poetic-realm.anchormap-expanded）
 * 7. 章节数 ≤ 2 时不渲染（return null）
 * 8. 移动端 / 平板（≤1024px）不渲染
 *
 * 使用示例：
 * <AnchorMiniMap />
 * <AnchorMiniMap containerSelector=".pr-dashboard-main" />
 * <AnchorMiniMap containerSelector="main" className="custom-map" />
 *
 * 配合页面内章节使用：
 * <section data-anchor data-anchor-label="六阶能力雷达">...</section>
 * <section data-anchor data-anchor-label="周进度表">...</section>
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { matchesMediaQuery } from '@/lib/media-query'
import './AnchorMiniMap.css'

/** localStorage key —— 与规范 8.4 状态保持策略一致 */
const STORAGE_KEY = 'poetic-realm.anchormap-expanded'

/** 移动端 / 平板断点 —— ≤1024px 不渲染（避免遮挡内容） */
const MOBILE_BREAKPOINT = 1024

/** 章节最少数 —— 不足此数不渲染（无导航意义） */
const MIN_SECTIONS = 2

export interface AnchorMiniMapProps {
    /** 扫描容器选择器，默认 'main'，回退到 '.pr-main'，再回退到 document.body */
    containerSelector?: string
    /** 外部 className，允许覆盖样式 */
    className?: string
}

/** 目录项数据结构 */
interface AnchorSection {
    key: string
    label: string
}

/** 安全读取 localStorage boolean */
function readStoredExpanded(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
        // 隐私模式 / 配额已满 —— 静默降级，默认未展开
        return false
    }
}

/** 安全写入 localStorage */
function writeStoredExpanded(value: boolean): void {
    try {
        localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
    } catch {
        // 静默失败：localStorage 可能被禁用或配额已满
    }
}

/** 检测当前视口是否超出移动端断点 */
function getIsDesktop(): boolean {
    if (typeof window === 'undefined') return false
    if (typeof window.matchMedia === 'function') return matchesMediaQuery(`(min-width: ${MOBILE_BREAKPOINT + 1}px)`)
    return window.innerWidth > MOBILE_BREAKPOINT
}

function shouldReduceMotion(): boolean {
    return matchesMediaQuery('(prefers-reduced-motion: reduce)')
}

export function AnchorMiniMap({
    containerSelector = 'main, .pr-main',
    className,
}: AnchorMiniMapProps) {
    const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'root'
    const listId = `pr-anchor-map-list-${reactId}`
    const anchorKeyByElementRef = useRef(new WeakMap<Element, string>())
    const anchorTargetByKeyRef = useRef(new Map<string, HTMLElement>())
    const nextAnchorKeyRef = useRef(0)
    const anchorSignatureRef = useRef<string | null>(null)
    const [sections, setSections] = useState<AnchorSection[]>([])
    const [activeKey, setActiveKey] = useState<string | null>(null)
    const [isExpanded, setIsExpanded] = useState<boolean>(readStoredExpanded)
    const [isDesktop, setIsDesktop] = useState<boolean>(getIsDesktop)

    // 移动端断点监听 —— 切换 desktop / mobile 状态
    useEffect(() => {
        anchorSignatureRef.current = null
        if (typeof window.matchMedia !== 'function') {
            const syncFromViewport = () => setIsDesktop(window.innerWidth > MOBILE_BREAKPOINT)
            syncFromViewport()
            window.addEventListener('resize', syncFromViewport, { passive: true })
            return () => window.removeEventListener('resize', syncFromViewport)
        }
        const media = window.matchMedia(`(min-width: ${MOBILE_BREAKPOINT + 1}px)`)
        const sync = () => setIsDesktop(media.matches)
        sync()
        if (typeof media.addEventListener === 'function') {
            media.addEventListener('change', sync)
            return () => media.removeEventListener('change', sync)
        }
        // Safari 13 及部分比赛机内嵌 WebView 只实现旧版 MediaQueryList API。
        if (typeof media.addListener === 'function') {
            media.addListener(sync)
            return () => media.removeListener?.(sync)
        }
        return undefined
    }, [])

    // 扫描 [data-anchor] 元素 + 启动 IntersectionObserver
    // v10 修复：
    // - 仅收录带 data-anchor-label 的锚点（杜绝 textContent 截断产生的乱码条目）
    // - 仅收录当前可见锚点（Tab 面板 display:none 的子锚点不进入导航）
    // - MutationObserver 监听容器 class/子树变化，Tab 切换后自动重扫
    useEffect(() => {
        // 多选择器回退：依次尝试每个，命中第一个即用
        const selectors = containerSelector.split(',').map((s) => s.trim()).filter(Boolean)
        let matchedContainer: Element | null = null
        for (const sel of selectors) {
            try {
                matchedContainer = document.querySelector(sel)
            } catch {
                // 外部传入非法 selector 时跳过该项，最终安全回退到 document.body。
                matchedContainer = null
            }
            if (matchedContainer) break
        }
        const container = matchedContainer ?? document.body

        let observer: IntersectionObserver | null = null

        const scan = () => {
            const anchors = Array.from(container.querySelectorAll('[data-anchor]'))
                // 仅保留有非空语义标签的锚点，避免空白标签让锚点与目录项索引错位。
                .filter((el) => !!el.getAttribute('data-anchor-label')?.trim())
                // 仅保留当前渲染可见的锚点（display:none 面板内的锚点 offsetParent 为 null）
                .filter((el) => (el as HTMLElement).offsetParent !== null)

            const items: AnchorSection[] = anchors.flatMap((el) => {
                const label = el.getAttribute('data-anchor-label')?.trim().slice(0, 80)
                if (!label) return []

                let key = anchorKeyByElementRef.current.get(el)
                if (!key) {
                    // 可见索引会随 Tab/异步区块变化，不能用于身份；单调 key 对元素生命周期稳定。
                    do {
                        key = `pr-anchor-${reactId}-${nextAnchorKeyRef.current++}`
                    } while (anchorTargetByKeyRef.current.has(key))
                    anchorKeyByElementRef.current.set(el, key)
                }
                // 只为缺少 id 的普通章节补全全局唯一 DOM id；已有业务 id/ARIA 关系绝不改写。
                if (!el.id) {
                    let candidate = key
                    while (document.getElementById(candidate)) {
                        candidate = `pr-anchor-${reactId}-${nextAnchorKeyRef.current++}`
                    }
                    el.id = candidate
                }
                return [{ key, label }]
            })

            anchorTargetByKeyRef.current = new Map(
                items.map((item, index) => [item.key, anchors[index] as HTMLElement]),
            )

            // 高频 live UI 的 class/style 变化会触发 MutationObserver；目录身份未变时
            // 不重建 IntersectionObserver，也不提交等值 React state。
            const signature = items.map((item) => `${item.key}\u0000${item.label}`).join('\u0001')
            if (anchorSignatureRef.current === signature) return
            anchorSignatureRef.current = signature

            setSections(items)
            setActiveKey((prev) => {
                if (prev && items.some((it) => it.key === prev)) return prev
                return items[0]?.key ?? null
            })

            // IntersectionObserver：rootMargin 让"视口中段"的章节算激活
            // -20% 0px -70% 0px → 视口顶部 20% ~ 30% 区间为激活判定带
            observer?.disconnect()
            if (typeof IntersectionObserver === 'function') {
                try {
                    const nextObserver = new IntersectionObserver(
                        (entries) => {
                            // 多个同时交叉时，取最靠上方的 isIntersecting 项
                            const intersecting = entries
                                .filter((e) => e.isIntersecting)
                                .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
                            const top = intersecting[0]
                            if (top) {
                                const key = anchorKeyByElementRef.current.get(top.target)
                                if (key) setActiveKey(key)
                            }
                        },
                        { rootMargin: '-20% 0px -70% 0px', threshold: 0 },
                    )
                    observer = nextObserver
                    anchors.forEach((el) => nextObserver.observe(el))
                } catch {
                    // 受限 WebView 的不完整 IO 只降级当前章节跟随，不影响目录点击。
                    observer = null
                }
            }
        }

        scan()

        // Tab 切换 / 懒加载完成后自动重扫（防抖 250ms）
        let debounceT = 0
        let mo: MutationObserver | null = null
        if (typeof MutationObserver === 'function') {
            try {
                mo = new MutationObserver((records) => {
                    const hasRelevantMutation = records.some((record) => {
                        const target = record.target instanceof Element
                            ? record.target
                            : record.target.parentElement
                        return !target?.closest('[data-anchor-map="navigation"]')
                    })
                    if (!hasRelevantMutation) return
                    window.clearTimeout(debounceT)
                    debounceT = window.setTimeout(scan, 250)
                })
                mo.observe(container, {
                    attributes: true,
                    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-anchor', 'data-anchor-label', 'id'],
                    childList: true,
                    subtree: true,
                })
            } catch {
                mo?.disconnect()
                mo = null
            }
        }

        return () => {
            window.clearTimeout(debounceT)
            mo?.disconnect()
            observer?.disconnect()
        }
    }, [containerSelector, reactId])

    // 展开 / 收起持久化
    useEffect(() => {
        writeStoredExpanded(isExpanded)
    }, [isExpanded])

    // 点击章节：平滑滚动到锚点
    const handleSelect = (key: string) => {
        const el = anchorTargetByKeyRef.current.get(key)
        if (el?.isConnected && el.offsetParent !== null) {
            el.scrollIntoView({ behavior: shouldReduceMotion() ? 'auto' : 'smooth', block: 'start' })
            setActiveKey(key)
        }
    }

    // 派生：是否应渲染
    // - 桌面端
    // - 章节数 > MIN_SECTIONS（默认 2）
    const shouldRender = useMemo(
        () => isDesktop && sections.length > MIN_SECTIONS,
        [isDesktop, sections.length],
    )

    // 非桌面端不渲染（hooks 之后再 return，保证 hooks 调用顺序稳定）
    if (!shouldRender) return null

    return (
        <nav
            className={cn('pr-anchor-map', isExpanded && 'is-expanded', className)}
            aria-label="页面章节导航"
            data-anchor-map="navigation"
        >
            <button
                type="button"
                className="pr-anchor-map-toggle"
                aria-label="章节导航"
                aria-expanded={isExpanded}
                aria-controls={listId}
                onClick={() => setIsExpanded((value) => !value)}
                title={isExpanded ? '收起章节导航' : '固定展开章节导航'}
            >
                <span className="pr-anchor-map-toggle-mark" aria-hidden="true" />
                <span className="pr-anchor-map-toggle-text">
                    {isExpanded ? '收起导航' : '章节导航'}
                </span>
            </button>
            <div className="pr-anchor-map-title" aria-hidden="true">
                快速跳转
            </div>
            {sections.length === 0 ? (
                <div className="pr-anchor-map-empty">暂无章节</div>
            ) : (
                <ul id={listId} className="pr-anchor-list" role="list">
                    {sections.map((section) => {
                        const isActive = section.key === activeKey
                        return (
                            <li key={section.key}>
                                <button
                                    type="button"
                                    className={cn('pr-anchor-item', isActive && 'is-active')}
                                    onClick={() => handleSelect(section.key)}
                                    aria-current={isActive ? 'location' : undefined}
                                    title={section.label}
                                >
                                    <span className="pr-anchor-item-text">{section.label}</span>
                                </button>
                            </li>
                        )
                    })}
                </ul>
            )}
        </nav>
    )
}
