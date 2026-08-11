/**
 * 开发环境组件统一入口（工程保障层 barrel）
 *
 * 设计目的：
 * - 统一导出所有 dev 组件，便于 App.tsx 条件渲染
 * - 仅在 import.meta.env.DEV 或 URL 参数控制下激活
 * - 生产构建时，Vite tree-shaking 会移除整个 dev 模块
 *
 * 包含组件：
 * 1. TeacherSwitcher       - 教师身份切换器（已有）
 * 2. DegradationIndicator  - 故障降级指示器
 * 3. PerformanceMonitor    - 性能监控面板
 * 4. ScriptPlayer          - 剧本播放器（一键演示）
 * 5. SessionRecorder       - 演示录屏录制器
 * 6. SessionPlayer         - 演示录屏回放器
 *
 * 使用方式（App.tsx）：
 *   {import.meta.env.DEV && <DevTools />}
 *   或通过 URL 参数 ?perf=1 ?scripts=1 ?record=1 控制
 *
 * 注意：本文件为 .tsx（包含 DevTools 聚合组件的 JSX）
 */

// 已有组件
export { TeacherSwitcher } from './TeacherSwitcher'

// 工程保障层组件
export { DegradationIndicator } from './DegradationIndicator'
export { PerformanceMonitor, type PerformanceMonitorProps } from './PerformanceMonitor'
export { ScriptPlayer, type ScriptPlayerProps } from './ScriptPlayer'
export { SessionRecorder, type SessionRecorderProps, type RecordingResult, type TimelineEvent } from './SessionRecorder'
export { SessionPlayer, type SessionPlayerProps } from './SessionPlayer'

// ─────────────────────────────────────────────────────────────
// DevTools 聚合组件（统一条件渲染入口）
// ─────────────────────────────────────────────────────────────

import { useState, useCallback } from 'react'
import { DegradationIndicator } from './DegradationIndicator'
import { SessionRecorder } from './SessionRecorder'
import type { RecordingResult } from './SessionRecorder'
import { SessionPlayer } from './SessionPlayer'

/**
 * DevTools 聚合组件
 *
 * 在 App.tsx 中条件渲染：
 *   {import.meta.env.DEV && <DevTools />}
 *
 * 功能：
 * - 始终渲染 DegradationIndicator（降级时自动显示）
 * - 始终渲染 SessionRecorder（?record=1 时显示浮窗）
 * - 当有录制结果时，渲染 SessionPlayer（?playback=1 时强制显示）
 *
 * 注意：PerformanceMonitor 已迁移至 AppShell 常驻渲染（生产环境默认折叠），
 *   不再在此处重复渲染，避免 DEV 模式下出现两份胶囊实例。
 */
export function DevTools() {
    const [recordingResult, setRecordingResult] = useState<RecordingResult | null>(null)
    const [showPlayback, setShowPlayback] = useState(false)

    const handleRecordingComplete = useCallback((result: RecordingResult) => {
        setRecordingResult(result)
        setShowPlayback(true)
    }, [])

    const handleClosePlayback = useCallback(() => {
        setShowPlayback(false)
    }, [])

    // 检查 URL 参数决定是否显示录屏与回放
    const shouldShowRecorder = checkUrlFlag('record')
    const shouldShowPlayback = checkUrlFlag('playback') || showPlayback

    return (
        <>
            <DegradationIndicator />
            {shouldShowRecorder && (
                <SessionRecorder onRecordingComplete={handleRecordingComplete} />
            )}
            {shouldShowPlayback && (
                <div className="pr-dev-playback-overlay">
                    <SessionPlayer result={recordingResult} onClose={handleClosePlayback} />
                </div>
            )}
        </>
    )
}

/**
 * 检查 URL 参数标志
 * @param key URL 参数名
 * @returns 是否存在且值为 '1' 或 'true'
 */
function checkUrlFlag(key: string): boolean {
    if (typeof window === 'undefined') return false
    const params = new URLSearchParams(window.location.search)
    const value = params.get(key)
    return value === '1' || value === 'true'
}
