/**
 * TabSplitPanel —— 全局长滚动解决方案基础设施（规范第 5、6、8 章）
 *
 * 设计目标：将长页面拆分为多个 Tab 面板，默认只显示第一个 Tab 内容，
 * 用户按需切换查看其他面板。配合 CommandPalette + CardSwap 实现三合一方案。
 *
 * 核心能力：
 * - 顶部 Tab 切换栏（玻璃态吸顶，透明度差异分隔，非硬边框）
 * - spring-soft 250ms 切换动画（opacity + translateY，GPU 加速）
 * - 完整键盘导航（←→ Home End 切换 Tab）
 * - 可选 badge（显示每个 Tab 的状态/数量/警告）
 * - 可选 URL hash 同步（切换 Tab 时更新 URL，刷新可恢复）
 * - 流体响应式（Tab 栏自适应宽度，移动端横向滚动）
 * - 完整三态交互（hover/active/focus-visible）
 * - 无障碍：role=tablist/tab/tabpanel，aria-selected，aria-controls
 *
 * 设计依据：
 * - 透明度驱动暖调色板（规范第 2 章）
 * - 无边框优先策略（规范第 4 章）
 * - 松紧得当（规范 5.3）：Tab 栏紧带，面板间稳带
 * - 即时反馈三态（规范 7.1 / 7.2）
 * - 入场 250ms spring-soft / 离场 200ms ease-in（规范 6.3）
 *
 * 用法：
 *   <TabSplitPanel
 *     tabs={[
 *       { key: 'overview', label: '概览', content: <Overview /> },
 *       { key: 'detail', label: '详情', badge: 12, content: <Detail /> },
 *       { key: 'settings', label: '设置', content: <Settings /> },
 *     ]}
 *     storageKey="my-page-tab"
 *   />
 */

import { useCallback, useId, useMemo, useRef, useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { cn } from '@/lib/cn'
import './TabSplitPanel.css'

/* ============================================================
 * 类型定义
 * ============================================================ */

export interface TabSplitPanelTab {
    /** Tab 唯一标识 */
    key: string
    /** 显示标签 */
    label: string
    /** 可选图标 */
    icon?: IconName | (string & {})
    /** 可选徽标（数字或字符串，显示在标签右侧） */
    badge?: number | string
    /** 徽标类型（影响颜色） */
    badgeVariant?: 'info' | 'success' | 'warning' | 'error'
    /** 面板内容 */
    content: ReactNode
    /** 禁用态 */
    disabled?: boolean
}

export interface TabSplitPanelProps {
    /** Tab 列表（至少 1 项） */
    tabs: TabSplitPanelTab[]
    /** 默认激活 Tab key（非受控） */
    defaultActiveKey?: string
    /** 受控激活 Tab key */
    activeKey?: string
    /** Tab 变化回调 */
    onChange?: (key: string) => void
    /** localStorage 持久化 key（可选，用于记忆用户选择） */
    storageKey?: string
    /** 是否同步到 URL hash（可选，如 #tab-detail） */
    syncHash?: boolean
    /** 自定义类名 */
    className?: string
    /** Tab 栏位置，默认 top */
    tabPosition?: 'top' | 'left'
    /** 是否吸顶（sticky），默认 true */
    sticky?: boolean
    /** aria-label 文案 */
    ariaLabel?: string
}

/* ============================================================
 * 工具函数
 * ============================================================ */

function getInitialActiveKey(
    tabs: TabSplitPanelTab[],
    defaultActiveKey: string | undefined,
    storageKey: string | undefined,
    syncHash: boolean | undefined,
): string {
    // 优先级：URL hash > localStorage > defaultActiveKey > 第一个可用 Tab
    if (syncHash && typeof window !== 'undefined') {
        const hash = window.location.hash.replace(/^#tab-/, '')
        if (hash && tabs.some((t) => t.key === hash && !t.disabled)) {
            return hash
        }
    }

    if (storageKey && typeof window !== 'undefined') {
        try {
            const stored = window.localStorage.getItem(storageKey)
            if (stored && tabs.some((t) => t.key === stored && !t.disabled)) {
                return stored
            }
        } catch {
            // localStorage 不可用，静默降级
        }
    }

    if (defaultActiveKey && tabs.some((t) => t.key === defaultActiveKey && !t.disabled)) {
        return defaultActiveKey
    }

    // 回落：第一个非禁用 Tab
    const first = tabs.find((t) => !t.disabled)
    return first?.key ?? tabs[0]?.key ?? ''
}

/* ============================================================
 * TabSplitPanel 组件
 * ============================================================ */

export function TabSplitPanel({
    tabs,
    defaultActiveKey,
    activeKey: controlledActiveKey,
    onChange,
    storageKey,
    syncHash = false,
    className,
    tabPosition = 'top',
    sticky = true,
    ariaLabel,
}: TabSplitPanelProps) {
    const reactId = useId()
    const tablistId = `pr-tabsplit-${reactId}`

    const isControlled = controlledActiveKey !== undefined
    const [internalActive, setInternalActive] = useState<string>(() =>
        getInitialActiveKey(tabs, defaultActiveKey, storageKey, syncHash),
    )
    const activeKey = isControlled ? controlledActiveKey : internalActive

    const tablistRef = useRef<HTMLDivElement>(null)
    const tabsRef = useRef<Array<HTMLButtonElement | null>>([])

    // 切换 Tab
    const setActive = useCallback(
        (key: string) => {
            const tab = tabs.find((t) => t.key === key)
            if (!tab || tab.disabled) return

            if (!isControlled) setInternalActive(key)
            onChange?.(key)

            // 持久化
            if (storageKey && typeof window !== 'undefined') {
                try {
                    window.localStorage.setItem(storageKey, key)
                } catch {
                    // 静默失败
                }
            }

            // URL hash 同步
            if (syncHash && typeof window !== 'undefined') {
                const newHash = `#tab-${key}`
                if (window.location.hash !== newHash) {
                    window.history.replaceState(null, '', newHash)
                }
            }
        },
        [tabs, isControlled, onChange, storageKey, syncHash],
    )

    // 监听 URL hash 变化（仅 syncHash 模式）
    useEffect(() => {
        if (!syncHash) return
        const onHashChange = () => {
            const hash = window.location.hash.replace(/^#tab-/, '')
            if (hash && hash !== activeKey && tabs.some((t) => t.key === hash && !t.disabled)) {
                setActive(hash)
            }
        }
        window.addEventListener('hashchange', onHashChange)
        return () => window.removeEventListener('hashchange', onHashChange)
    }, [syncHash, activeKey, tabs, setActive])

    // 键盘导航：←→ Home End
    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLElement>, currentIndex: number) => {
            const enabledTabs = tabs
                .map((t, i) => ({ key: t.key, disabled: t.disabled, index: i }))
                .filter((t) => !t.disabled)
            if (enabledTabs.length === 0) return

            const currentEnabledIdx = enabledTabs.findIndex((t) => t.index === currentIndex)
            if (currentEnabledIdx === -1) return

            let nextEnabledIdx: number | null = null
            switch (e.key) {
                case 'ArrowRight':
                case 'ArrowDown':
                    e.preventDefault()
                    nextEnabledIdx = (currentEnabledIdx + 1) % enabledTabs.length
                    break
                case 'ArrowLeft':
                case 'ArrowUp':
                    e.preventDefault()
                    nextEnabledIdx = (currentEnabledIdx - 1 + enabledTabs.length) % enabledTabs.length
                    break
                case 'Home':
                    e.preventDefault()
                    nextEnabledIdx = 0
                    break
                case 'End':
                    e.preventDefault()
                    nextEnabledIdx = enabledTabs.length - 1
                    break
            }

            if (nextEnabledIdx !== null) {
                const nextTab = enabledTabs[nextEnabledIdx]
                if (nextTab) {
                    setActive(nextTab.key)
                    // 异步聚焦，确保在状态更新后
                    requestAnimationFrame(() => {
                        tabsRef.current[nextTab.index]?.focus()
                    })
                }
            }
        },
        [tabs, setActive],
    )

    // 当前激活 Tab 索引
    const activeIndex = useMemo(
        () => Math.max(0, tabs.findIndex((t) => t.key === activeKey)),
        [tabs, activeKey],
    )

    // Tab 栏指示器位置（用于滑动动画）
    const indicatorStyle = useMemo(() => {
        if (tabPosition === 'left') {
            return {
                '--pr-tabsplit-indicator-top': `${activeIndex * 100}%`,
                '--pr-tabsplit-indicator-height': '100%',
            } as React.CSSProperties
        }
        return {
            '--pr-tabsplit-indicator-left': `${(activeIndex / Math.max(1, tabs.length)) * 100}%`,
            '--pr-tabsplit-indicator-width': `${(1 / Math.max(1, tabs.length)) * 100}%`,
        } as React.CSSProperties
    }, [activeIndex, tabs.length, tabPosition])

    if (tabs.length === 0) return null
    if (tabs.length === 1) {
        // 单 Tab 时直接返回内容，不渲染 Tab 栏
        const single = tabs[0]
        return single
            ? <div className={cn('pr-tabsplit-single', className)}>{single.content}</div>
            : null
    }

    return (
        <div
            className={cn(
                'pr-tabsplit',
                `pr-tabsplit--${tabPosition}`,
                sticky && 'pr-tabsplit--sticky',
                className,
            )}
        >
            {/* Tab 栏 */}
            <div
                ref={tablistRef}
                className="pr-tabsplit-tablist"
                role="tablist"
                aria-label={ariaLabel ?? '内容分区切换'}
                aria-orientation={tabPosition === 'left' ? 'vertical' : 'horizontal'}
                style={indicatorStyle}
            >
                <div className="pr-tabsplit-tablist-inner">
                    {tabs.map((tab, index) => {
                        const isActive = tab.key === activeKey
                        const tabId = `${tablistId}-tab-${tab.key}`
                        const panelId = `${tablistId}-panel-${tab.key}`
                        return (
                            <button
                                key={tab.key}
                                ref={(el) => {
                                    tabsRef.current[index] = el
                                }}
                                id={tabId}
                                type="button"
                                role="tab"
                                aria-selected={isActive}
                                aria-controls={panelId}
                                aria-disabled={tab.disabled || undefined}
                                tabIndex={isActive ? 0 : -1}
                                className={cn(
                                    'pr-tabsplit-tab',
                                    isActive && 'is-active',
                                    tab.disabled && 'is-disabled',
                                )}
                                onClick={() => setActive(tab.key)}
                                onKeyDown={(e) => handleKeyDown(e, index)}
                                disabled={tab.disabled}
                            >
                                {tab.icon && (
                                    <Icon
                                        name={tab.icon}
                                        size={15}
                                        className="pr-tabsplit-tab-icon"
                                        aria-hidden
                                    />
                                )}
                                <span className="pr-tabsplit-tab-label">{tab.label}</span>
                                {tab.badge !== undefined && tab.badge !== 0 && (
                                    <span
                                        className={cn(
                                            'pr-tabsplit-tab-badge',
                                            `is-${tab.badgeVariant ?? 'info'}`,
                                        )}
                                    >
                                        {tab.badge}
                                    </span>
                                )}
                            </button>
                        )
                    })}
                </div>
                {/* 滑动指示器（透明度驱动的下划线/左划线，非硬边框） */}
                <div className="pr-tabsplit-indicator" aria-hidden />
            </div>

            {/* 面板区 */}
            <div className="pr-tabsplit-panels">
                {tabs.map((tab) => {
                    const isActive = tab.key === activeKey
                    const panelId = `${tablistId}-panel-${tab.key}`
                    const tabId = `${tablistId}-tab-${tab.key}`
                    return (
                        <div
                            key={tab.key}
                            id={panelId}
                            role="tabpanel"
                            aria-labelledby={tabId}
                            className={cn(
                                'pr-tabsplit-panel',
                                isActive && 'is-active',
                            )}
                            hidden={!isActive}
                            tabIndex={0}
                        >
                            {isActive ? tab.content : null}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
