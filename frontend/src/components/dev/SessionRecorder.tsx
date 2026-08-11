/**
 * 演示录屏录制器（工程保障层 / 演示录屏回放 · 录制端）
 *
 * 设计目的：
 * - 使用 MediaRecorder API 录制页面屏幕（canvas.captureStream + 音频）
 * - 同步记录关键事件时间线（路由变化、AI 调用、WS 事件）
 * - 生成 WebM 视频文件 + 事件时间线 JSON
 * - 录制控制浮窗：小红点 + 计时器 + 开始/停止按钮
 *
 * 录制流程：
 * 1. 用户点击开始 → 获取 displayMedia + userMedia（可选音频）
 * 2. 创建 MediaRecorder 实例，ondataavailable 收集 Blob
 * 3. 订阅 wsDispatcher 事件 + 监听路由变化，写入事件时间线
 * 4. 用户点击停止 → 生成 WebM Blob + 下载 JSON 时间线
 * 5. 自动调用 SessionPlayer 进行预览回放
 *
 * 严格遵循：
 * - 玻璃态浮窗：surface-glass + backdrop-blur 12px
 * - 无边框：透明度分层 + 负空间
 * - 暖调色板：accent-error（录制中）/ accent-primary（待机）
 * - 零 emoji：所有图标使用 Phosphor Icons
 * - 仅 transform/opacity 动画
 * - prefers-reduced-motion 降级
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { Icon } from '@/components/ui'
import { wsDispatcher } from '@/lib/ws-dispatcher'
import './SessionRecorder.css'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

type RecordState = 'idle' | 'recording' | 'stopped' | 'error'

interface TimelineEvent {
    /** 事件时间戳（相对于录制开始的 ms） */
    offsetMs: number
    /** 事件类型 */
    kind: 'route' | 'agent' | 'ws' | 'note'
    /** 事件描述 */
    description: string
    /** 路由路径（route 事件） */
    route?: string
    /** WS 事件类型（ws 事件） */
    wsType?: string
}

interface RecordingResult {
    /** 视频 Blob */
    videoBlob: Blob
    /** 事件时间线 */
    timeline: TimelineEvent[]
    /** 录制开始时间戳 */
    startedAt: number
    /** 录制时长（ms） */
    durationMs: number
}

// ─────────────────────────────────────────────────────────────
// SessionRecorder 组件
// ─────────────────────────────────────────────────────────────

export interface SessionRecorderProps {
    /** 录制完成回调（向 SessionPlayer 传递结果） */
    onRecordingComplete?: (result: RecordingResult) => void
}

export function SessionRecorder({ onRecordingComplete }: SessionRecorderProps) {
    const location = useLocation()
    const [recordState, setRecordState] = useState<RecordState>('idle')
    const [elapsedSec, setElapsedSec] = useState(0)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [eventCount, setEventCount] = useState(0)

    // 录制相关引用
    const mediaRecorderRef = useRef<MediaRecorder | null>(null)
    const streamRef = useRef<MediaStream | null>(null)
    const chunksRef = useRef<Blob[]>([])
    const timelineRef = useRef<TimelineEvent[]>([])
    const startTimeRef = useRef<number>(0)
    const timerRef = useRef<number | null>(null)
    const unsubWsRef = useRef<(() => void) | null>(null)
    const lastRouteRef = useRef<string>('')

    // 格式化时间 mm:ss
    const formatTime = useCallback((sec: number): string => {
        const m = Math.floor(sec / 60)
        const s = sec % 60
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    }, [])

    // 添加事件到时间线
    const addTimelineEvent = useCallback((event: Omit<TimelineEvent, 'offsetMs'>) => {
        if (recordState !== 'recording') return
        const offsetMs = performance.now() - startTimeRef.current
        timelineRef.current.push({ ...event, offsetMs })
        setEventCount(timelineRef.current.length)
    }, [recordState])

    // 监听路由变化
    useEffect(() => {
        if (recordState !== 'recording') return
        if (lastRouteRef.current === location.pathname) return
        lastRouteRef.current = location.pathname
        addTimelineEvent({
            kind: 'route',
            description: `导航到 ${location.pathname}`,
            route: location.pathname,
        })
    }, [location.pathname, recordState, addTimelineEvent])

    // ── 开始录制 ──
    const handleStart = useCallback(async () => {
        setErrorMessage(null)
        timelineRef.current = []
        chunksRef.current = []
        setEventCount(0)

        try {
            // 请求屏幕共享流（含系统音频）
            const displayMedia = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: 30 },
                audio: true,
            })
            streamRef.current = displayMedia

            // 尝试获取麦克风音频（可选，失败不影响录制）
            let combinedStream: MediaStream = displayMedia
            try {
                const userMedia = await navigator.mediaDevices.getUserMedia({ audio: true })
                // 合并视频轨道 + 麦克风音频
                const audioTracks = userMedia.getAudioTracks()
                const videoTracks = displayMedia.getVideoTracks()
                const combined = new MediaStream([...videoTracks, ...audioTracks])
                combinedStream = combined
            } catch {
                // 麦克风获取失败，仅使用屏幕共享流
            }

            // 创建 MediaRecorder
            const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
                ? 'video/webm;codecs=vp9,opus'
                : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
                    ? 'video/webm;codecs=vp8,opus'
                    : 'video/webm'

            const recorder = new MediaRecorder(combinedStream, {
                mimeType,
                videoBitsPerSecond: 4_000_000,
            })
            mediaRecorderRef.current = recorder

            recorder.ondataavailable = (e: BlobEvent) => {
                if (e.data.size > 0) {
                    chunksRef.current.push(e.data)
                }
            }

            recorder.onstop = () => {
                const videoBlob = new Blob(chunksRef.current, { type: 'video/webm' })
                const durationMs = performance.now() - startTimeRef.current
                const result: RecordingResult = {
                    videoBlob,
                    timeline: [...timelineRef.current],
                    startedAt: startTimeRef.current,
                    durationMs,
                }
                onRecordingComplete?.(result)
            }

            // 监听用户在浏览器原生 UI 中停止共享
            displayMedia.getVideoTracks()[0]?.addEventListener('ended', () => {
                if (mediaRecorderRef.current?.state === 'recording') {
                    mediaRecorderRef.current.stop()
                }
                setRecordState('stopped')
                if (timerRef.current !== null) {
                    window.clearInterval(timerRef.current)
                    timerRef.current = null
                }
                if (unsubWsRef.current) {
                    unsubWsRef.current()
                    unsubWsRef.current = null
                }
            })

            // 开始录制
            recorder.start(1000) // 每秒收集一次数据
            startTimeRef.current = performance.now()
            lastRouteRef.current = location.pathname
            setRecordState('recording')

            // 记录首个路由事件
            addTimelineEvent({
                kind: 'route',
                description: `开始录制，当前页面 ${location.pathname}`,
                route: location.pathname,
            })

            // 订阅 WS 事件，记录到时间线
            const unsub = wsDispatcher.subscribe((event) => {
                if (event.type === 'pong' || event.type === 'ping') return
                addTimelineEvent({
                    kind: event.type.startsWith('agent:') ? 'agent' : 'ws',
                    description: `WS 事件: ${event.type}`,
                    wsType: event.type,
                })
            })
            unsubWsRef.current = unsub

            // 启动计时器
            timerRef.current = window.setInterval(() => {
                setElapsedSec(Math.floor((performance.now() - startTimeRef.current) / 1000))
            }, 500)
        } catch (err) {
            const msg = err instanceof Error ? err.message : '未知错误'
            setErrorMessage(`无法开始录制：${msg}`)
            setRecordState('error')
        }
    }, [location.pathname, addTimelineEvent, onRecordingComplete])

    // ── 停止录制 ──
    const handleStop = useCallback(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.stop()
        }
        // 停止所有轨道
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop())
            streamRef.current = null
        }
        if (timerRef.current !== null) {
            window.clearInterval(timerRef.current)
            timerRef.current = null
        }
        if (unsubWsRef.current) {
            unsubWsRef.current()
            unsubWsRef.current = null
        }
        setRecordState('stopped')
    }, [])

    // ── 添加手动备注 ──
    const handleAddNote = useCallback(() => {
        const note = window.prompt('输入备注内容：')
        if (note && note.trim()) {
            addTimelineEvent({
                kind: 'note',
                description: note.trim(),
            })
        }
    }, [addTimelineEvent])

    // ── 清理 ──
    useEffect(() => {
        return () => {
            if (mediaRecorderRef.current?.state === 'recording') {
                mediaRecorderRef.current.stop()
            }
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((track) => track.stop())
            }
            if (timerRef.current !== null) {
                window.clearInterval(timerRef.current)
            }
            if (unsubWsRef.current) {
                unsubWsRef.current()
            }
        }
    }, [])

    const isRecording = recordState === 'recording'

    return (
        <div className="pr-session-recorder" data-state={recordState}>
            {/* 录制控制浮窗 */}
            <button
                type="button"
                className="pr-recorder-toggle"
                onClick={isRecording ? handleStop : handleStart}
                aria-label={isRecording ? '停止录制' : '开始录屏'}
            >
                <span className="pr-recorder-dot" data-recording={isRecording} />
                <span className="pr-recorder-label">
                    {isRecording ? '录制中' : recordState === 'stopped' ? '已停止' : '录屏'}
                </span>
                {isRecording && (
                    <span className="pr-recorder-timer" aria-live="polite" aria-atomic="true">
                        {formatTime(elapsedSec)}
                    </span>
                )}
            </button>

            {/* 录制中额外操作 */}
            {isRecording && (
                <button
                    type="button"
                    className="pr-recorder-note-btn"
                    onClick={handleAddNote}
                    aria-label="添加时间线备注"
                    title="添加备注到时间线"
                >
                    <Icon name="pen-nib" size={14} />
                </button>
            )}

            {/* 事件计数 */}
            {isRecording && eventCount > 0 && (
                <span className="pr-recorder-events">
                    {eventCount} 事件
                </span>
            )}

            {/* 错误提示 */}
            {errorMessage && (
                <div className="pr-recorder-error" role="alert">
                    <Icon name="warning-circle" size={14} />
                    <span>{errorMessage}</span>
                    <button
                        type="button"
                        className="pr-recorder-error-close"
                        onClick={() => setErrorMessage(null)}
                        aria-label="关闭错误提示"
                    >
                        <Icon name="x" size={12} />
                    </button>
                </div>
            )}
        </div>
    )
}

// ─────────────────────────────────────────────────────────────
// 导出类型
// ─────────────────────────────────────────────────────────────

export type { RecordingResult, TimelineEvent }
