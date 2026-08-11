/**
 * 剧本播放器（工程保障层 / 5+ 剧本矩阵 · 一键演示）
 *
 * 设计目的：
 * - 提供卡片式剧本选择列表，一键播放预置演示剧本
 * - 播放控制器：播放 / 暂停 / 重置 / 上一步 / 下一步
 * - 当前步骤进度条（实时显示步骤进度）
 * - 解说文案显示区（typewriter 流式效果）
 * - 一键重置数据（清除 localStorage 中的演示状态）
 *
 * 播放机制：
 * - 每步根据 durationMs 自动推进
 * - 步骤开始时：路由跳转 + 派发 preset-data 事件（store 可监听）
 * - 步骤中的 actions 通过 querySelector 模拟点击
 * - 进度条实时反映当前步骤的进度
 *
 * 严格遵循：
 * - 玻璃态面板：surface-glass-heavy + backdrop-blur 24px
 * - 无边框：透明度分层 + 负空间
 * - 暖调色板：accent-primary 为主，accent-success/warning 辅助
 * - 零 emoji：所有图标使用 Phosphor Icons
 * - 仅 transform/opacity 动画
 * - prefers-reduced-motion 降级
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '@/components/ui'
import {
    DEMO_SCRIPTS,
    findScript,
    getTotalDurationMs,
    formatDuration,
    type DemoScript,
    type ScriptStep,
} from '@/lib/demo-scripts'
import './ScriptPlayer.css'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

type PlayState = 'idle' | 'playing' | 'paused' | 'ended'

interface PlayProgress {
    /** 当前步骤索引（0-based） */
    stepIndex: number
    /** 当前步骤内已用时间（ms） */
    elapsedInStep: number
    /** 当前步骤总时长（ms） */
    stepDuration: number
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** localStorage 中演示数据相关 key 前缀 */
const DEMO_LS_PREFIX = 'pr-demo-'

// ─────────────────────────────────────────────────────────────
// ScriptPlayer 组件
// ─────────────────────────────────────────────────────────────

export interface ScriptPlayerProps {
    /** 初始剧本 ID（可选，默认无选择） */
    initialScriptId?: string
}

export function ScriptPlayer({ initialScriptId }: ScriptPlayerProps) {
    const navigate = useNavigate()
    const [selectedId, setSelectedId] = useState<string | null>(initialScriptId ?? null)
    const [playState, setPlayState] = useState<PlayState>('idle')
    const [progress, setProgress] = useState<PlayProgress>({
        stepIndex: 0,
        elapsedInStep: 0,
        stepDuration: 0,
    })
    const [showResetConfirm, setShowResetConfirm] = useState(false)
    const [resetDone, setResetDone] = useState(false)

    const tickRef = useRef<number | null>(null)
    const lastTickRef = useRef<number>(0)

    const script = useMemo(() => (selectedId ? findScript(selectedId) : undefined), [selectedId])
    const totalDurationMs = useMemo(() => (script ? getTotalDurationMs(script) : 0), [script])

    // 当前步骤
    const currentStep: ScriptStep | undefined = script?.steps[progress.stepIndex]

    // ── 步骤执行：路由跳转 + 派发 preset 事件 + 模拟操作 ──
    const executeStep = useCallback(
        (step: ScriptStep) => {
            // 1. 路由跳转
            navigate(step.route)

            // 2. 派发 preset-data 事件（store 可监听 window 事件来预填数据）
            if (step.preset) {
                window.dispatchEvent(
                    new CustomEvent('pr-script:preset', {
                        detail: { preset: step.preset, stepIndex: step.index },
                    }),
                )
            }

            // 3. 模拟操作（延迟执行，等待路由渲染）
            if (step.actions && step.actions.length > 0) {
                const actionDelay = window.setTimeout(() => {
                    for (const action of step.actions ?? []) {
                        if (action.type === 'click' && action.selector) {
                            const el = document.querySelector<HTMLElement>(action.selector)
                            if (el) {
                                el.click()
                            }
                        } else if (action.type === 'input' && action.selector) {
                            const el = document.querySelector<HTMLInputElement>(action.selector)
                            if (el && action.value !== undefined) {
                                el.value = action.value
                                el.dispatchEvent(new Event('input', { bubbles: true }))
                            }
                        } else if (action.type === 'scroll') {
                            window.scrollTo({ top: action.scrollY ?? 0, behavior: 'smooth' })
                        } else if (action.type === 'toggle' && action.selector) {
                            const el = document.querySelector<HTMLElement>(action.selector)
                            if (el) el.click()
                        }
                    }
                }, 800) // 等待路由渲染
                return () => window.clearTimeout(actionDelay)
            }
            return undefined
        },
        [navigate],
    )

    // ── 播放循环 ──
    useEffect(() => {
        if (playState !== 'playing' || !script) return

        lastTickRef.current = performance.now()

        const tick = (now: number) => {
            const delta = now - lastTickRef.current
            lastTickRef.current = now

            setProgress((prev) => {
                const newElapsed = prev.elapsedInStep + delta
                const currentStepDuration = script.steps[prev.stepIndex]?.durationMs ?? 0

                if (newElapsed >= currentStepDuration) {
                    // 当前步骤结束
                    const nextIndex = prev.stepIndex + 1
                    if (nextIndex >= script.steps.length) {
                        // 剧本结束
                        setPlayState('ended')
                        return { stepIndex: prev.stepIndex, elapsedInStep: currentStepDuration, stepDuration: currentStepDuration }
                    }
                    // 进入下一步
                    const nextStep = script.steps[nextIndex]
                    if (nextStep) {
                        executeStep(nextStep)
                        return { stepIndex: nextIndex, elapsedInStep: 0, stepDuration: nextStep.durationMs }
                    }
                    return prev
                }
                return { ...prev, elapsedInStep: newElapsed }
            })

            tickRef.current = requestAnimationFrame(tick)
        }
        tickRef.current = requestAnimationFrame(tick)

        return () => {
            if (tickRef.current !== null) {
                cancelAnimationFrame(tickRef.current)
                tickRef.current = null
            }
        }
    }, [playState, script, executeStep])

    // ── 播放控制 ──
    const handlePlay = useCallback(() => {
        if (!script) return
        if (playState === 'ended') {
            // 从头开始
            setProgress({ stepIndex: 0, elapsedInStep: 0, stepDuration: script.steps[0]?.durationMs ?? 0 })
            setPlayState('playing')
            executeStep(script.steps[0]!)
        } else if (playState === 'idle') {
            // 首次播放
            const firstStep = script.steps[0]
            if (firstStep) {
                setProgress({ stepIndex: 0, elapsedInStep: 0, stepDuration: firstStep.durationMs })
                setPlayState('playing')
                executeStep(firstStep)
            }
        } else {
            setPlayState('playing')
        }
    }, [script, playState, executeStep])

    const handlePause = useCallback(() => {
        setPlayState('paused')
    }, [])

    const handleReset = useCallback(() => {
        if (!script) return
        setPlayState('idle')
        const firstStep = script.steps[0]
        setProgress({
            stepIndex: 0,
            elapsedInStep: 0,
            stepDuration: firstStep?.durationMs ?? 0,
        })
    }, [script])

    const handlePrev = useCallback(() => {
        if (!script || progress.stepIndex === 0) return
        const prevIndex = progress.stepIndex - 1
        const prevStep = script.steps[prevIndex]
        if (prevStep) {
            setProgress({ stepIndex: prevIndex, elapsedInStep: 0, stepDuration: prevStep.durationMs })
            executeStep(prevStep)
        }
    }, [script, progress.stepIndex, executeStep])

    const handleNext = useCallback(() => {
        if (!script) return
        const nextIndex = progress.stepIndex + 1
        const nextStep = script.steps[nextIndex]
        if (nextStep) {
            setProgress({ stepIndex: nextIndex, elapsedInStep: 0, stepDuration: nextStep.durationMs })
            executeStep(nextStep)
        } else {
            setPlayState('ended')
        }
    }, [script, progress.stepIndex, executeStep])

    const handleSelectScript = useCallback(
        (s: DemoScript) => {
            setPlayState('idle')
            setSelectedId(s.id)
            const firstStep = s.steps[0]
            setProgress({
                stepIndex: 0,
                elapsedInStep: 0,
                stepDuration: firstStep?.durationMs ?? 0,
            })
        },
        [],
    )

    // ── 一键重置数据 ──
    const handleResetData = useCallback(() => {
        // 清除所有演示相关 localStorage
        const keysToRemove: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key && (key.startsWith(DEMO_LS_PREFIX) || key.startsWith('pr-'))) {
                keysToRemove.push(key)
            }
        }
        for (const key of keysToRemove) {
            localStorage.removeItem(key)
        }
        setShowResetConfirm(false)
        setResetDone(true)
        window.setTimeout(() => setResetDone(false), 2400)
    }, [])

    // ── 进度百分比 ──
    const stepProgressPct = progress.stepDuration > 0
        ? Math.min(100, (progress.elapsedInStep / progress.stepDuration) * 100)
        : 0
    const totalElapsedMs = useMemo(() => {
        if (!script) return 0
        let total = 0
        for (let i = 0; i < progress.stepIndex && i < script.steps.length; i++) {
            total += script.steps[i]?.durationMs ?? 0
        }
        total += progress.elapsedInStep
        return total
    }, [script, progress.stepIndex, progress.elapsedInStep])
    const totalProgressPct = totalDurationMs > 0 ? (totalElapsedMs / totalDurationMs) * 100 : 0

    return (
        <div className="pr-script-player">
            {/* ── 头部 ── */}
            <div className="pr-script-player-header">
                <div className="pr-script-player-title-row">
                    <Icon name="magic-wand" size={20} />
                    <h2 className="pr-script-player-title">剧本播放器</h2>
                    <span className="pr-script-player-badge">{DEMO_SCRIPTS.length} 部</span>
                </div>
                <button
                    type="button"
                    className="pr-script-player-reset-btn"
                    onClick={() => setShowResetConfirm(true)}
                    aria-label="一键重置数据"
                >
                    <Icon name="trash" size={14} />
                    <span>重置数据</span>
                </button>
            </div>

            {/* ── 剧本选择列表 ── */}
            <div className="pr-script-list" role="listbox" aria-label="演示剧本列表">
                {DEMO_SCRIPTS.map((s) => {
                    const isSelected = s.id === selectedId
                    const totalSec = getTotalDurationMs(s) / 1000
                    return (
                        <button
                            key={s.id}
                            type="button"
                            className="pr-script-card"
                            data-selected={isSelected}
                            data-playing={isSelected && playState === 'playing'}
                            role="option"
                            aria-selected={isSelected}
                            onClick={() => handleSelectScript(s)}
                        >
                            <div className="pr-script-card-header">
                                <span className="pr-script-card-title">{s.title}</span>
                                <span className="pr-script-card-duration">{formatDuration(totalSec)}</span>
                            </div>
                            <p className="pr-script-card-desc">{s.description}</p>
                            <div className="pr-script-card-tags">
                                {s.tags.map((t) => (
                                    <span key={t} className="pr-script-tag">{t}</span>
                                ))}
                            </div>
                            {isSelected && (
                                <div className="pr-script-card-progress">
                                    <div
                                        className="pr-script-card-progress-bar"
                                        style={{ width: `${totalProgressPct}%` }}
                                    />
                                </div>
                            )}
                        </button>
                    )
                })}
            </div>

            {/* ── 播放控制区 ── */}
            {script && currentStep && (
                <div className="pr-script-controls-section">
                    {/* 当前步骤信息 */}
                    <div className="pr-script-step-info">
                        <span className="pr-script-step-index">
                            步骤 {progress.stepIndex + 1} / {script.steps.length}
                        </span>
                        <span className="pr-script-step-title">{currentStep.title}</span>
                    </div>

                    {/* 进度条 */}
                    <div
                        className="pr-script-progress-bar"
                        role="progressbar"
                        aria-valuenow={Math.round(stepProgressPct)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label="当前步骤进度"
                    >
                        <div className="pr-script-progress-fill" style={{ width: `${stepProgressPct}%` }} />
                    </div>

                    {/* 控制按钮 */}
                    <div className="pr-script-controls">
                        <button
                            type="button"
                            className="pr-script-ctrl-btn"
                            onClick={handlePrev}
                            disabled={progress.stepIndex === 0}
                            aria-label="上一步"
                        >
                            <Icon name="caret-left" size={18} />
                        </button>
                        {playState === 'playing' ? (
                            <button
                                type="button"
                                className="pr-script-ctrl-btn pr-script-ctrl-btn--primary"
                                onClick={handlePause}
                                aria-label="暂停"
                            >
                                <Icon name="stop" size={18} />
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="pr-script-ctrl-btn pr-script-ctrl-btn--primary"
                                onClick={handlePlay}
                                aria-label={playState === 'ended' ? '重新播放' : '播放'}
                            >
                                <Icon name="play" size={18} />
                            </button>
                        )}
                        <button
                            type="button"
                            className="pr-script-ctrl-btn"
                            onClick={handleNext}
                            disabled={progress.stepIndex >= script.steps.length - 1 && playState === 'ended'}
                            aria-label="下一步"
                        >
                            <Icon name="caret-right" size={18} />
                        </button>
                        <button
                            type="button"
                            className="pr-script-ctrl-btn"
                            onClick={handleReset}
                            aria-label="重置"
                        >
                            <Icon name="arrows-clockwise" size={16} />
                        </button>
                    </div>

                    {/* 解说文案 */}
                    <div className="pr-script-narration" aria-live="polite">
                        <div className="pr-script-narration-label">
                            <Icon name="info" size={12} />
                            <span>解说</span>
                        </div>
                        <p className="pr-script-narration-text">{currentStep.narration}</p>
                        <div className="pr-script-narration-route">
                            <Icon name="navigation-arrow" size={12} />
                            <code>{currentStep.route}</code>
                        </div>
                    </div>

                    {/* 总进度 */}
                    <div className="pr-script-total-progress">
                        <span className="pr-script-total-label">
                            总进度 {formatDuration(Math.round(totalElapsedMs / 1000))} / {formatDuration(Math.round(totalDurationMs / 1000))}
                        </span>
                        <div className="pr-script-total-bar">
                            <div className="pr-script-total-fill" style={{ width: `${totalProgressPct}%` }} />
                        </div>
                    </div>
                </div>
            )}

            {/* ── 空状态 ── */}
            {!script && (
                <div className="pr-script-empty">
                    <Icon name="magic-wand" size={32} />
                    <p>选择上方剧本卡片即可开始播放</p>
                    <p className="pr-script-empty-hint">播放器将自动跳转路由并模拟操作</p>
                </div>
            )}

            {/* ── 重置确认对话框 ── */}
            {showResetConfirm && (
                <div className="pr-script-reset-confirm" role="dialog" aria-label="确认重置数据">
                    <div className="pr-script-reset-confirm-panel">
                        <div className="pr-script-reset-confirm-header">
                            <Icon name="warning-circle" size={20} />
                            <span>重置演示数据</span>
                        </div>
                        <p className="pr-script-reset-confirm-text">
                            将清除所有 localStorage 中的演示状态数据（pr-* 前缀）。此操作不可撤销。
                        </p>
                        <div className="pr-script-reset-confirm-actions">
                            <button
                                type="button"
                                className="pr-script-ctrl-btn"
                                onClick={() => setShowResetConfirm(false)}
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                className="pr-script-ctrl-btn pr-script-ctrl-btn--danger"
                                onClick={handleResetData}
                            >
                                <Icon name="trash" size={14} />
                                <span>确认重置</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── 重置成功提示 ── */}
            {resetDone && (
                <div className="pr-script-reset-toast" role="status">
                    <Icon name="check-circle" size={16} />
                    <span>数据已重置</span>
                </div>
            )}
        </div>
    )
}
