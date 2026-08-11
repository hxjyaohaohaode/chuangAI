/**
 * AI 副驾页面 v6（Task 24 全面重做）
 *
 * 设计理念：内容即设计 —— 移除所有装饰性元素，回归对话本质。
 * 三栏布局：左 240px 会话历史 + 中自适应对话区 + 右 320px 可拖拽上下文物料库。
 * 底部浮动操作栏：模型选择 + 思考模式 + 温度 + 清空/导出。
 *
 * WebSocket：保留 /ws/orchestrator 订阅，用于主动通知（ProactiveNotificationBar）。
 *
 * 模型参数（chatModel / chatThinkingMode / chatTemperature）由本页面统一管理，
 * 通过 props 传递给 ChatInterface（流式调用）和 InterventionBar（参数控制）。
 *
 * 物料插入：QuickActions 点击/拖拽物料 → setPendingInsert → ChatInterface 追加引用。
 */

import { useCallback, useEffect, memo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '@/components/ui/icons-extended'
import { Icon, SectionErrorBoundary } from '@/components/ui'
import { useCopilotStore } from '@/stores/copilot'
import { useWSSubscription } from '@/hooks/useWSSubscription'
import { cn } from '@/lib/cn'
import { logError } from '@/lib/errors'
import type { WSStatus, ProactiveAlert, ProactiveTargetType } from '@/lib/types'
import { SessionHistory } from './SessionHistory'
import { QuickActions } from './QuickActions'
import { ChatInterface } from './ChatInterface'
import { InterventionBar } from './InterventionBar'
import type { CopilotInteractionMode } from './InterventionBar'
import './AICopilotPage.css'

// ─────────────────────────────────────────────────────────────
// 主动通知浮层 —— 顶部滑入，5 秒自动消失（保留功能性，非装饰）
// ─────────────────────────────────────────────────────────────

const PROACTIVE_ICON_MAP: Record<string, string> = {
    info: 'lightbulb',
    warning: 'bell',
    critical: 'warning',
}

const PROACTIVE_ROUTE_MAP: Record<ProactiveTargetType, string> = {
    student: '/grading',
    class: '/dashboard',
    agent: '/ai-copilot',
}

function ProactiveNotificationBar() {
    const navigate = useNavigate()
    const proactiveAlerts = useCopilotStore((s) => s.proactiveAlerts)
    const [visibleAlert, setVisibleAlert] = useState<ProactiveAlert | null>(null)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const latestAlert = proactiveAlerts[0] ?? null
    const latestKey = latestAlert ? `${latestAlert.type}-${latestAlert.timestamp}` : null

    useEffect(() => {
        if (!latestAlert || !latestKey) {
            setVisibleAlert(null)
            return
        }
        setVisibleAlert(latestAlert)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setVisibleAlert(null), 5000)
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [latestKey])

    const handleClose = useCallback(() => {
        setVisibleAlert(null)
        if (timerRef.current) clearTimeout(timerRef.current)
    }, [])

    const handleViewDetails = useCallback(() => {
        if (!visibleAlert) return
        const route = PROACTIVE_ROUTE_MAP[visibleAlert.targetType] ?? '/dashboard'
        navigate(route)
        handleClose()
    }, [visibleAlert, navigate, handleClose])

    if (!visibleAlert) return null

    const iconName = PROACTIVE_ICON_MAP[visibleAlert.severity] ?? 'info'
    const severityClass = `pr-proactive-bar--${visibleAlert.severity}`

    return (
        <div className={cn('pr-proactive-bar', severityClass)} role="alert" aria-live="assertive">
            <div className="pr-proactive-bar-body">
                <span className="pr-proactive-bar-icon">
                    <Icon name={iconName} size={18} />
                </span>
                <div className="pr-proactive-bar-content">
                    <span className="pr-proactive-bar-title">{visibleAlert.title}</span>
                    <span className="pr-proactive-bar-desc">{visibleAlert.description}</span>
                </div>
                <div className="pr-proactive-bar-actions">
                    <button
                        type="button"
                        className="pr-proactive-bar-detail"
                        onClick={handleViewDetails}
                    >
                        查看详情
                        <Icon name="arrow-square-out" size={12} />
                    </button>
                    <button
                        type="button"
                        className="pr-proactive-bar-close"
                        onClick={handleClose}
                        aria-label="关闭通知"
                    >
                        <Icon name="x" size={14} />
                    </button>
                </div>
            </div>
        </div>
    )
}

// ─────────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────────

export const AICopilotPage = memo(function AICopilotPage() {
    const handleWSEvent = useCopilotStore((s) => s.handleWSEvent)
    const setWsStatus = useCopilotStore((s) => s.setWsStatus)

    // 模型参数 —— 由本页面统一管理，props 传递给 ChatInterface / InterventionBar
    const [chatModel, setChatModel] = useState<string>('deepseek-v4-pro')
    const [chatThinkingMode, setChatThinkingMode] = useState<'low' | 'medium' | 'high' | 'max'>('medium')
    const [chatTemperature, setChatTemperature] = useState<number>(0.7)
    const [interactionMode, setInteractionMode] = useState<CopilotInteractionMode>('ask')

    // 物料插入 —— QuickActions 点击/拖拽物料后，通过此 state 传递引用文本到 ChatInterface
    const [pendingInsert, setPendingInsert] = useState<string | null>(null)

    const handleInsertContext = useCallback((reference: string) => {
        setPendingInsert(reference)
    }, [])

    const handleInsertConsumed = useCallback(() => {
        setPendingInsert(null)
    }, [])

    // WebSocket 事件回调（使用 ref 避免重连）
    const onEvent = useCallback(
        (event: Parameters<typeof handleWSEvent>[0]) => {
            handleWSEvent(event)
        },
        [handleWSEvent],
    )

    const onStatusChange = useCallback(
        (status: WSStatus) => {
            setWsStatus(status)
        },
        [setWsStatus],
    )

    useWSSubscription({
        onEvent,
        onStatusChange,
        enabled: true,
    })

    return (
        // pr-page--viewport：向 AppShell 声明"本页要锁到视口高度"。
        // 对话页的滚动必须发生在消息区内部，输入框常驻视口底部；
        // 否则消息一多，整页被撑高，输入框会被推到屏幕外（旧版即如此）。
        <div className="pr-copilot pr-copilot-v6 pr-page--viewport">
            <h1 className="pr-sr-only">AI 教学副驾</h1>
            <ProactiveNotificationBar />

            <div className="pr-copilot-body">
                {/* 左栏：会话历史（可折叠） */}
                <aside className="pr-copilot-col pr-copilot-col--left">
                    <SessionHistory />
                </aside>

                {/* 中栏：对话区（卡片式 + 流式 + 输入区） */}
                <main className="pr-copilot-col pr-copilot-col--center">
                    <SectionErrorBoundary
                        title="AI 对话加载失败"
                        description="对话消息渲染异常，可点击重试恢复对话"
                        onError={(err, info) =>
                            logError('AICopilotPage/ChatInterface', err, {
                                componentStack: info.componentStack,
                            })
                        }
                    >
                        <ChatInterface
                            interactionMode={interactionMode}
                            chatModel={chatModel}
                            chatThinkingMode={chatThinkingMode}
                            chatTemperature={chatTemperature}
                            pendingInsert={pendingInsert}
                            onInsertConsumed={handleInsertConsumed}
                        />
                    </SectionErrorBoundary>
                </main>

                {/* 右栏：可拖拽上下文物料库 */}
                <aside className="pr-copilot-col pr-copilot-col--right">
                    <QuickActions onInsertContext={handleInsertContext} />
                </aside>
            </div>

            {/* 底部浮动操作栏：模型参数 + 清空/导出 */}
            <InterventionBar
                interactionMode={interactionMode}
                onInteractionModeChange={setInteractionMode}
                chatModel={chatModel}
                chatThinkingMode={chatThinkingMode}
                chatTemperature={chatTemperature}
                onModelChange={setChatModel}
                onThinkingModeChange={setChatThinkingMode}
                onTemperatureChange={setChatTemperature}
            />
        </div>
    )
})

export default AICopilotPage
