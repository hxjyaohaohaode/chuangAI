/**
 * 底部浮动操作栏 v6（Task 24.6 全面重做）
 *
 * 职责：
 * 1. 模型选择 Combobox（deepseek-v4-pro / flash / mimo-v2.5 / mimo-v2.5-pro）
 * 2. 思考模式 Combobox（low / medium / high / max）
 * 3. 温度滑块（0-2，步长 0.1）
 * 4. 清空对话按钮（两次点击确认，调用 newSession()）
 * 5. 导出 Markdown 按钮（生成 .md 文件下载）
 *
 * 设计要点（规范第 7、14 章）：
 * - surface-glass + backdrop-blur 12px 玻璃态浮层
 * - 紧凑横向工具栏，分组：模型参数 | 操作按钮
 * - 零 emoji，全部使用 Phosphor SVG 图标
 * - 完整三态：hover/active/focus-visible
 * - 两次点击确认清空（与 SessionHistory 删除确认逻辑一致）
 */

import { memo, useCallback, useRef, useState } from 'react'
import { Icon, Combobox, type ComboboxOption } from '@/components/ui'
import { useCopilotStore } from '@/stores/copilot'
import { cn } from '@/lib/cn'
import { toast } from '@/stores/toast'

// ─────────────────────────────────────────────────────────────
// 选项配置
// ─────────────────────────────────────────────────────────────

/** 模型选项 —— 严格遵循系统限制：仅 deepseek 系列 + mimo 系列 */
const MODEL_OPTIONS: ComboboxOption[] = [
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro · 深度推理' },
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash · 快速响应' },
    { value: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro · 纯文本旗舰' },
    { value: 'mimo-v2.5', label: 'MiMo V2.5 · 多模态' },
]

const thinkingModeOptions = (model: string): ComboboxOption[] => model === 'deepseek-v4-flash'
    ? [
        { value: 'low', label: '低（V4 Flash 官方档）' },
        { value: 'high', label: '高（官方默认）' },
        { value: 'max', label: '最大（V4 Flash 官方档）' },
    ]
    : model === 'deepseek-v4-pro'
        ? [
            { value: 'high', label: '高（V4 Pro 官方档）' },
            { value: 'max', label: '最大（V4 Pro 官方档）' },
        ]
        : [{ value: 'high', label: '开启思考（MiMo 官方开关）' }]

// ─────────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────────

export interface InterventionBarProps {
    interactionMode: CopilotInteractionMode
    onInteractionModeChange: (mode: CopilotInteractionMode) => void
    /** 当前模型 */
    chatModel: string
    /** 当前思考模式 */
    chatThinkingMode: 'low' | 'high' | 'max'
    /** 当前温度 */
    chatTemperature: number
    /** 模型变更回调 */
    onModelChange: (model: string) => void
    /** 思考模式变更回调 */
    onThinkingModeChange: (mode: 'low' | 'high' | 'max') => void
    /** 温度变更回调 */
    onTemperatureChange: (temp: number) => void
}

export type CopilotInteractionMode = 'ask' | 'agent'

export const InterventionBar = memo(function InterventionBar({
    interactionMode,
    onInteractionModeChange,
    chatModel,
    chatThinkingMode,
    chatTemperature,
    onModelChange,
    onThinkingModeChange,
    onTemperatureChange,
}: InterventionBarProps) {
    const newSession = useCopilotStore((s) => s.newSession)

    /** 清空确认态（第一次点击进入确认态，3 秒后自动取消） */
    const [confirmingClear, setConfirmingClear] = useState(false)
    const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const handleModelChange = useCallback(
        (value: string | string[]) => {
            onModelChange(value as string)
        },
        [onModelChange],
    )

    const handleThinkingModeChange = useCallback(
        (value: string | string[]) => {
            onThinkingModeChange(value as 'low' | 'high' | 'max')
        },
        [onThinkingModeChange],
    )

    const handleTemperatureChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            onTemperatureChange(parseFloat(e.target.value))
        },
        [onTemperatureChange],
    )

    /**
     * 清空对话 —— 两次点击确认
     * 第一次点击进入确认态（按钮变红 + 文字变为"确认清空"）
     * 第二次点击执行清空（调用 newSession()）
     * 3 秒内未确认自动取消
     */
    const handleClear = useCallback(() => {
        if (confirmingClear) {
            // 第二次点击：执行清空
            const messages = useCopilotStore.getState().messages
            if (messages.length === 0) {
                toast.info({ title: '当前无消息', message: '对话已为空' })
            } else {
                newSession()
                toast.success({ title: '已清空对话', message: '可开始新的对话' })
            }
            setConfirmingClear(false)
            if (clearTimerRef.current) {
                clearTimeout(clearTimerRef.current)
                clearTimerRef.current = null
            }
        } else {
            // 第一次点击：进入确认态
            setConfirmingClear(true)
            if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
            clearTimerRef.current = setTimeout(() => setConfirmingClear(false), 3000)
        }
    }, [confirmingClear, newSession])

    /**
     * 导出 Markdown —— 生成 .md 文件下载
     * 格式：标题 + 元信息 + 分隔线 + 每条消息（角色 + 时间 + 内容）
     */
    const handleExportMarkdown = useCallback(() => {
        const messages = useCopilotStore.getState().messages
        if (messages.length === 0) {
            toast.warning({ title: '无可导出的对话', message: '当前没有消息可导出' })
            return
        }

        const now = new Date()
        const timeStr = now.toLocaleString('zh-CN')

        const lines: string[] = [
            '# AI 副驾对话记录',
            '',
            `**导出时间**：${timeStr}`,
            `**模型**：${chatModel}`,
            `**思考模式**：${chatThinkingMode}`,
            `**温度**：${chatTemperature.toFixed(1)}`,
            '',
            '---',
            '',
        ]

        for (const msg of messages) {
            const role = msg.role === 'user' ? '教师' : msg.role === 'assistant' ? 'AI 副驾' : '系统'
            const msgTime = new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
            })
            lines.push(`## ${role}（${msgTime}）`)
            lines.push('')
            lines.push(msg.content)
            lines.push('')
        }

        const markdown = lines.join('\n')
        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `ai-copilot-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)

        toast.success({ title: '导出成功', message: '对话记录已导出为 Markdown 文件' })
    }, [chatModel, chatThinkingMode, chatTemperature])

    return (
        <section className="pr-copilot-intervene pr-copilot-intervene-v6" aria-label="模型参数与操作">
            <div className="pr-copilot-intervene-bar">
                <div className="pr-copilot-mode-switch" role="group" aria-label="AI 交互模式">
                    <button
                        type="button"
                        aria-pressed={interactionMode === 'ask'}
                        className={cn({ 'is-active': interactionMode === 'ask' })}
                        onClick={() => onInteractionModeChange('ask')}
                    >
                        <Icon name="chat-circle" size={14} />问答模式
                    </button>
                    <button
                        type="button"
                        aria-pressed={interactionMode === 'agent'}
                        className={cn({ 'is-active': interactionMode === 'agent' })}
                        onClick={() => onInteractionModeChange('agent')}
                    >
                        <Icon name="graph" size={14} />任务编排
                    </button>
                </div>
                {/* 左侧：模型参数组 */}
                {interactionMode === 'ask' ? <div className="pr-copilot-intervene-params">
                    {/* 模型选择 */}
                    <div className="pr-copilot-intervene-param">
                        <label className="pr-copilot-intervene-param-label" htmlFor="copilot-model-select">
                            <Icon name="robot" size={12} />
                            <span>模型</span>
                        </label>
                        <Combobox
                            id="copilot-model-select"
                            className="pr-copilot-intervene-combobox"
                            value={chatModel}
                            onChange={handleModelChange}
                            ariaLabel="选择模型"
                            options={MODEL_OPTIONS}
                        />
                    </div>

                    {/* 思考模式 */}
                    <div className="pr-copilot-intervene-param">
                        <label className="pr-copilot-intervene-param-label" htmlFor="copilot-thinking-select">
                            <Icon name="brain" size={12} />
                            <span>思考</span>
                        </label>
                        <Combobox
                            id="copilot-thinking-select"
                            className="pr-copilot-intervene-combobox"
                            value={chatThinkingMode}
                            onChange={handleThinkingModeChange}
                            ariaLabel="选择思考模式"
                            options={thinkingModeOptions(chatModel)}
                        />
                    </div>

                    {/* 温度滑块 */}
                    <div className="pr-copilot-intervene-param pr-copilot-intervene-param--temperature">
                        <label className="pr-copilot-intervene-param-label" htmlFor="copilot-temperature-slider">
                            <Icon name="gauge" size={12} />
                            <span>温度</span>
                            <span className="pr-copilot-intervene-temperature-value">
                                {chatTemperature.toFixed(1)}
                            </span>
                        </label>
                        <input
                            id="copilot-temperature-slider"
                            type="range"
                            min={0}
                            max={2}
                            step={0.1}
                            value={chatTemperature}
                            disabled={chatModel.startsWith('mimo-')}
                            onChange={handleTemperatureChange}
                            className="pr-copilot-intervene-temperature-slider"
                            aria-label="采样温度"
                            aria-valuemin={0}
                            aria-valuemax={2}
                            aria-valuenow={chatTemperature}
                        />
                        {chatModel.startsWith('mimo-') && (
                            <span className="pr-copilot-intervene-param-note">MiMo 思考模式会按官网固定温度执行</span>
                        )}
                    </div>
                </div> : (
                    <div className="pr-copilot-routing-note" role="status">
                        <Icon name="graph" size={14} />
                        <span><strong>编排官自动路由</strong> DeepSeek / MiMo，并在执行前等待教师审批</span>
                    </div>
                )}

                {/* 右侧：操作按钮组 */}
                <div className="pr-copilot-intervene-actions">
                    <button
                        type="button"
                        className={cn('pr-copilot-intervene-btn pr-copilot-intervene-btn--export', {
                            'is-disabled': useCopilotStore.getState().messages.length === 0,
                        })}
                        onClick={handleExportMarkdown}
                        aria-label="导出对话为 Markdown"
                        title="导出对话为 Markdown 文件"
                    >
                        <Icon name="download" size={14} />
                        <span>导出</span>
                    </button>
                    <button
                        type="button"
                        className={cn('pr-copilot-intervene-btn', {
                            'pr-copilot-intervene-btn--danger-confirm': confirmingClear,
                        })}
                        onClick={handleClear}
                        aria-label={confirmingClear ? '再次点击确认清空' : '清空对话'}
                        title={confirmingClear ? '再次点击确认清空' : '清空对话'}
                    >
                        <Icon name={confirmingClear ? 'warning' : 'trash'} size={14} />
                        <span>{confirmingClear ? '确认清空' : '清空'}</span>
                    </button>
                </div>
            </div>
        </section>
    )
})
