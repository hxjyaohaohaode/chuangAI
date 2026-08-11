/**
 * ThinkingModeSwitcher —— 思考强度切换器
 *
 * 四档思考强度切换器，让教师全局控制所有 LLM 调用的推理投入。
 *
 * 「强度」而非「模式」：它调的是同一件事的**投入程度**（推理链长度 →
 * 质量与耗时同步上升），不是在切换几种不同的工作方式。用「模式」会让人
 * 以为四个选项各有各的用途，实际它们是一条单调递增的强度轴。
 *
 * 四档模式（大模型API文档.md）：
 * - low    : 低速思考，响应最快（批量批改、摘要等高频任务）
 * - medium : 中速思考，平衡速度与深度（推荐、画像等中等复杂度任务）
 * - high   : 高速思考，深度推理（诊断、验收等需要严谨分析的任务）
 * - max    : 超高思考，仅 deepseek-v4-pro 支持（命题、复杂认知诊断）
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
    mode: 'low' | 'medium' | 'high' | 'max'
    label: string
    desc: string
    icon: 'feather' | 'lightbulb' | 'brain' | 'sparkle'
    /** 模型约束提示 */
    modelHint?: string
    /**
     * 耗时提示
     *
     * 思考强度最容易被误解的地方是「看不出它做了什么」——切了档位，
     * 界面上没有任何变化，教师无从判断是否生效。实测各档位对同一次
     * 六阶命题的端到端耗时差异显著（20 秒 → 3 分钟），把这个代价直接
     * 标在选项上，教师才能作出知情选择。
     */
    costHint?: string
}> = [
        {
            mode: 'low',
            label: '轻度',
            desc: '响应最快，适合高频批改',
            icon: 'feather',
            costHint: '命题约 20 秒',
        },
        {
            mode: 'medium',
            label: '中',
            desc: '平衡速度与深度',
            icon: 'lightbulb',
            costHint: '命题约 40 秒',
        },
        {
            mode: 'high',
            label: '高',
            desc: '深度推理，适合诊断验收',
            icon: 'brain',
            costHint: '命题约 1 分钟',
        },
        {
            mode: 'max',
            label: '超高',
            desc: '推理链最长，题目质量最高',
            icon: 'sparkle',
            modelHint: '将强制所有任务路由到 deepseek-v4-pro',
            costHint: '命题约 3 分钟',
        },
    ]

/** 模式中文标签映射（用于触发器显示） */
const MODE_LABELS: Record<string, string> = {
    low: '轻度',
    medium: '中',
    high: '高',
    max: '超高',
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

    const handleSelect = (mode: 'low' | 'medium' | 'high' | 'max' | null) => {
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
                            覆盖命题 / 诊断 / 批改 / 报告等全部 AI 调用；强度越高，推理越深、耗时越长
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

                    {/* 四档模式 */}
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
                                        {cfg.costHint && (
                                            <span className="pr-thinking-switcher__option-cost">
                                                {cfg.costHint}
                                            </span>
                                        )}
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
