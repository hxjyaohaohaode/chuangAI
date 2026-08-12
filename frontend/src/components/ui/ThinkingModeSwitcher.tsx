/**
 * ThinkingModeSwitcher —— 思考强度切换器
 *
 * 依据供应商公开契约提供两档真实可执行的思考强度。
 *
 * 「强度」而非「模式」：它调的是同一件事的**投入程度**（推理链长度 →
 * 质量与耗时同步上升），不是在切换几种不同的工作方式。用「模式」会让人
 * 以为四个选项各有各的用途，实际它们是一条单调递增的强度轴。
 *
 * - high：DeepSeek 官方 high；MiMo 官方 thinking.enabled
 * - max：仅 DeepSeek V4 Pro 官方支持
 *
 * 设计规范合规：
 * - 玻璃态浮层（规范 2.3 第 3 层 surface-elevated）
 * - 无硬边框（规范 4.1）
 * - 选中态 20% alpha + 100% 文字（规范 2.4）
 * - transform/opacity 动画（规范 6.6）
 * - 即时反馈 ≤100ms（规范 7.1）
 */

import { memo, useState, useRef, useEffect } from 'react'
import { Icon } from '@/components/ui'
import { useLLMRouterStore } from '@/stores/llm-router'
import './ThinkingModeSwitcher.css'

/** 思考强度档位配置 */
const MODE_CONFIG: Array<{
    mode: 'high' | 'max'
    label: string
    desc: string
    icon: 'feather' | 'lightbulb' | 'brain' | 'sparkle'
    /** 模型约束提示 */
    modelHint?: string
}> = [
        {
            mode: 'high',
            label: '标准深度',
            desc: 'DeepSeek high；MiMo 启用思考',
            icon: 'brain',
        },
        {
            mode: 'max',
            label: '最大深度',
            desc: '仅 DeepSeek V4 Pro 官方支持',
            icon: 'sparkle',
            modelHint: '将强制所有任务路由到 deepseek-v4-pro',
        },
    ]

/** 模式中文标签映射（用于触发器显示） */
const MODE_LABELS: Record<string, string> = {
    low: '标准深度（兼容）',
    medium: '标准深度（兼容）',
    high: '标准深度',
    max: '最大深度',
}

function ThinkingModeSwitcherImpl() {
    const thinkingMode = useLLMRouterStore((s) => s.thinkingMode)
    const thinkingModeLoading = useLLMRouterStore((s) => s.thinkingModeLoading)
    const setThinkingMode = useLLMRouterStore((s) => s.setThinkingMode)
    const initThinkingMode = useLLMRouterStore((s) => s.initThinkingMode)

    const [open, setOpen] = useState(false)
    const popoverRef = useRef<HTMLDivElement>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)

    // 首次挂载：从后端拉取当前思考模式
    useEffect(() => {
        void initThinkingMode()
    }, [initThinkingMode])

    // 点击外部关闭（规范 7.2：下拉菜单交互）
    useEffect(() => {
        if (!open) return
        const handleClickOutside = (e: MouseEvent) => {
            if (
                popoverRef.current &&
                !popoverRef.current.contains(e.target as Node) &&
                triggerRef.current &&
                !triggerRef.current.contains(e.target as Node)
            ) {
                setOpen(false)
            }
        }
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', handleClickOutside)
        document.addEventListener('keydown', handleEscape)
        return () => {
            document.removeEventListener('mousedown', handleClickOutside)
            document.removeEventListener('keydown', handleEscape)
        }
    }, [open])

    const currentLabel = thinkingMode ? MODE_LABELS[thinkingMode] : '默认'

    const handleSelect = (mode: 'high' | 'max' | null) => {
        void setThinkingMode(mode)
        setOpen(false)
    }

    return (
        <div className="pr-thinking-switcher" ref={popoverRef}>
            <button
                ref={triggerRef}
                type="button"
                className={`pr-thinking-switcher__trigger${open ? ' pr-thinking-switcher__trigger--open' : ''}`}
                onClick={() => setOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={`思考强度：当前 ${currentLabel}`}
                disabled={thinkingModeLoading}
            >
                <Icon name="brain" size={14} />
                <span className="pr-thinking-switcher__trigger-label">
                    思考强度
                    <span className="pr-thinking-switcher__trigger-current">{currentLabel}</span>
                </span>
                {thinkingModeLoading && (
                    <Icon name="circle-notch" size={12} className="pr-app-spin" />
                )}
                <Icon name="caret-down" size={12} className="pr-thinking-switcher__caret" />
            </button>

            {open && (
                <div
                    className="pr-thinking-switcher__panel"
                    role="listbox"
                    aria-label="选择思考强度"
                >
                    <div className="pr-thinking-switcher__panel-head">
                        <span className="pr-thinking-switcher__panel-title">思考强度</span>
                        <span className="pr-thinking-switcher__panel-desc">
                            只展示供应商官网明确支持的强度；MiMo 仅支持启用或关闭思考
                        </span>
                    </div>

                    {/* 默认选项：清除覆盖 */}
                    <button
                        type="button"
                        role="option"
                        aria-selected={thinkingMode === null}
                        className={`pr-thinking-switcher__option${thinkingMode === null ? ' pr-thinking-switcher__option--active' : ''
                            }`}
                        onClick={() => handleSelect(null)}
                    >
                        <span className="pr-thinking-switcher__option-icon">
                            <Icon name="circle-notch" size={14} />
                        </span>
                        <span className="pr-thinking-switcher__option-text">
                            <span className="pr-thinking-switcher__option-label">默认</span>
                            <span className="pr-thinking-switcher__option-desc">
                                使用路由矩阵预设（各任务独立最优）
                            </span>
                        </span>
                        {thinkingMode === null && (
                            <Icon name="check" size={14} className="pr-thinking-switcher__option-check" />
                        )}
                    </button>

                    {/* 官方可执行的两档模式 */}
                    {MODE_CONFIG.map((cfg) => {
                        const active = thinkingMode === cfg.mode
                        return (
                            <button
                                key={cfg.mode}
                                type="button"
                                role="option"
                                aria-selected={active}
                                className={`pr-thinking-switcher__option${active ? ' pr-thinking-switcher__option--active' : ''
                                    }`}
                                onClick={() => handleSelect(cfg.mode)}
                            >
                                <span className="pr-thinking-switcher__option-icon">
                                    <Icon name={cfg.icon} size={14} active={active} />
                                </span>
                                <span className="pr-thinking-switcher__option-text">
                                    <span className="pr-thinking-switcher__option-label">
                                        {cfg.label}
                                        {cfg.modelHint && (
                                            <span className="pr-thinking-switcher__option-badge">
                                                v4-pro
                                            </span>
                                        )}
                                    </span>
                                    <span className="pr-thinking-switcher__option-desc">
                                        {cfg.desc}
                                    </span>
                                </span>
                                {active && (
                                    <Icon name="check" size={14} className="pr-thinking-switcher__option-check" />
                                )}
                            </button>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

export const ThinkingModeSwitcher = memo(ThinkingModeSwitcherImpl)
