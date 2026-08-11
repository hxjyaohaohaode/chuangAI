/**
 * 演示录屏回放器（工程保障层 / 演示录屏回放 · 回放端）
 *
 * 设计目的：
 * - 接收 SessionRecorder 录制的视频 Blob + 事件时间线 JSON
 * - 提供视频回放 + 事件时间线同步高亮
 * - 支持跳转到任意事件（点击时间线项即定位视频）
 * - 支持导出 WebM 视频文件 + 时间线 JSON 文件
 *
 * 回放机制：
 * - video 元素 src = URL.createObjectURL(blob)
 * - timeupdate 事件触发时，高亮当前时间对应的事件
 * - 点击时间线项 → video.currentTime = event.offsetMs / 1000
 * - 导出：a 标签 download 属性
 *
 * 严格遵循：
 * - 玻璃态面板：surface-elevated + backdrop-blur 20px
 * - 无边框：透明度分层 + 负空间
 * - 暖调色板：accent-primary 为主
 * - 零 emoji：所有图标使用 Phosphor Icons
 * - 仅 transform/opacity 动画
 * - prefers-reduced-motion 降级
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Icon } from '@/components/ui'
import type { RecordingResult, TimelineEvent } from './SessionRecorder'
import './SessionPlayer.css'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

export interface SessionPlayerProps {
    /** 录制结果（由 SessionRecorder 传入） */
    result: RecordingResult | null
    /** 关闭回放器 */
    onClose?: () => void
}

// ─────────────────────────────────────────────────────────────
// 事件类型标签映射
// ─────────────────────────────────────────────────────────────

const EVENT_LABELS: Record<TimelineEvent['kind'], { label: string; icon: string }> = {
    route: { label: '路由', icon: 'navigation-arrow' },
    agent: { label: 'AI', icon: 'sparkle' },
    ws: { label: 'WS', icon: 'arrows-clockwise' },
    note: { label: '备注', icon: 'pen-nib' },
}

// ─────────────────────────────────────────────────────────────
// SessionPlayer 组件
// ─────────────────────────────────────────────────────────────

export function SessionPlayer({ result, onClose }: SessionPlayerProps) {
    const videoRef = useRef<HTMLVideoElement | null>(null)
    const videoUrlRef = useRef<string | null>(null)
    const [currentTime, setCurrentTime] = useState(0)
    const [duration, setDuration] = useState(0)
    const [isPlaying, setIsPlaying] = useState(false)
    const [activeEventIndex, setActiveEventIndex] = useState(-1)

    // 生成视频 URL（仅在 result 变化时）
    useEffect(() => {
        if (!result) {
            if (videoUrlRef.current) {
                URL.revokeObjectURL(videoUrlRef.current)
                videoUrlRef.current = null
            }
            return
        }
        // 释放旧 URL
        if (videoUrlRef.current) {
            URL.revokeObjectURL(videoUrlRef.current)
        }
        videoUrlRef.current = URL.createObjectURL(result.videoBlob)
        // 强制 video 重新加载
        if (videoRef.current) {
            videoRef.current.load()
        }
        return () => {
            if (videoUrlRef.current) {
                URL.revokeObjectURL(videoUrlRef.current)
                videoUrlRef.current = null
            }
        }
    }, [result])

    // 当前事件高亮（根据视频时间）
    useEffect(() => {
        if (!result || result.timeline.length === 0) {
            setActiveEventIndex(-1)
            return
        }
        const currentMs = currentTime * 1000
        // 找到最后一个 offsetMs <= currentMs 的事件
        let activeIdx = -1
        for (let i = 0; i < result.timeline.length; i++) {
            if (result.timeline[i]!.offsetMs <= currentMs) {
                activeIdx = i
            } else {
                break
            }
        }
        setActiveEventIndex(activeIdx)
    }, [currentTime, result])

    // ── 视频事件监听 ──
    const handleTimeUpdate = useCallback(() => {
        const video = videoRef.current
        if (!video) return
        setCurrentTime(video.currentTime)
    }, [])

    const handleLoadedMetadata = useCallback(() => {
        const video = videoRef.current
        if (!video) return
        setDuration(video.duration)
    }, [])

    const handlePlay = useCallback(() => setIsPlaying(true), [])
    const handlePause = useCallback(() => setIsPlaying(false), [])

    // ── 播放控制 ──
    const togglePlay = useCallback(() => {
        const video = videoRef.current
        if (!video) return
        if (video.paused) {
            void video.play()
        } else {
            video.pause()
        }
    }, [])

    const seekTo = useCallback((timeSec: number) => {
        const video = videoRef.current
        if (!video) return
        video.currentTime = Math.max(0, Math.min(duration, timeSec))
        setCurrentTime(video.currentTime)
    }, [duration])

    const seekToEvent = useCallback((event: TimelineEvent) => {
        seekTo(event.offsetMs / 1000)
    }, [seekTo])

    const handlePrevEvent = useCallback(() => {
        if (!result || activeEventIndex <= 0) return
        const prevEvent = result.timeline[activeEventIndex - 1]
        if (prevEvent) seekToEvent(prevEvent)
    }, [result, activeEventIndex, seekToEvent])

    const handleNextEvent = useCallback(() => {
        if (!result || activeEventIndex < 0) return
        const nextEvent = result.timeline[activeEventIndex + 1]
        if (nextEvent) seekToEvent(nextEvent)
    }, [result, activeEventIndex, seekToEvent])

    // ── 导出 ──
    const handleExportVideo = useCallback(() => {
        if (!result || !videoUrlRef.current) return
        const a = document.createElement('a')
        a.href = videoUrlRef.current
        const ts = new Date(result.startedAt).toISOString().replace(/[:.]/g, '-')
        a.download = `poetic-realm-session-${ts}.webm`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
    }, [result])

    const handleExportTimeline = useCallback(() => {
        if (!result) return
        const json = JSON.stringify({
            startedAt: new Date(result.startedAt).toISOString(),
            durationMs: result.durationMs,
            eventCount: result.timeline.length,
            timeline: result.timeline,
        }, null, 2)
        const blob = new Blob([json], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        const ts = new Date(result.startedAt).toISOString().replace(/[:.]/g, '-')
        a.download = `poetic-realm-timeline-${ts}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    }, [result])

    // ── 格式化时间 ──
    const formatTimeStr = useCallback((sec: number): string => {
        if (!isFinite(sec) || sec < 0) sec = 0
        const m = Math.floor(sec / 60)
        const s = Math.floor(sec % 60)
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    }, [])

    const formatMs = useCallback((ms: number): string => {
        const totalSec = Math.floor(ms / 1000)
        const m = Math.floor(totalSec / 60)
        const s = totalSec % 60
        const cs = Math.floor((ms % 1000) / 10)
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
    }, [])

    // ── 进度百分比 ──
    const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0

    // ── 事件分组统计 ──
    const eventStats = useMemo(() => {
        if (!result) return { route: 0, agent: 0, ws: 0, note: 0 }
        return result.timeline.reduce(
            (acc, e) => {
                acc[e.kind]++
                return acc
            },
            { route: 0, agent: 0, ws: 0, note: 0 } as Record<TimelineEvent['kind'], number>,
        )
    }, [result])

    if (!result) {
        return (
            <div className="pr-session-player pr-session-player--empty">
                <Icon name="camera" size={32} />
                <p className="pr-session-player-empty-text">
                    暂无录制内容
                </p>
                <p className="pr-session-player-empty-hint">
                    点击右上角录屏按钮开始录制，完成后将在此回放
                </p>
            </div>
        )
    }

    return (
        <div className="pr-session-player">
            {/* ── 头部 ── */}
            <div className="pr-session-player-header">
                <div className="pr-session-player-title-row">
                    <Icon name="camera" size={20} />
                    <h3 className="pr-session-player-title">回放器</h3>
                    <span className="pr-session-player-meta">
                        {formatTimeStr(result.durationMs / 1000)} · {result.timeline.length} 事件
                    </span>
                </div>
                <div className="pr-session-player-actions">
                    <button
                        type="button"
                        className="pr-session-player-action-btn"
                        onClick={handleExportVideo}
                        title="导出视频"
                    >
                        <Icon name="download" size={14} />
                        <span>视频</span>
                    </button>
                    <button
                        type="button"
                        className="pr-session-player-action-btn"
                        onClick={handleExportTimeline}
                        title="导出时间线 JSON"
                    >
                        <Icon name="download" size={14} />
                        <span>时间线</span>
                    </button>
                    {onClose && (
                        <button
                            type="button"
                            className="pr-session-player-action-btn pr-session-player-action-btn--close"
                            onClick={onClose}
                            aria-label="关闭回放器"
                        >
                            <Icon name="x" size={14} />
                        </button>
                    )}
                </div>
            </div>

            {/* ── 视频播放区 ── */}
            <div className="pr-session-player-video-section">
                <video
                    ref={videoRef}
                    className="pr-session-player-video"
                    controls={false}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                    onPlay={handlePlay}
                    onPause={handlePause}
                >
                    {videoUrlRef.current && (
                        <source src={videoUrlRef.current} type="video/webm" />
                    )}
                </video>

                {/* 自定义控制条 */}
                <div className="pr-session-player-controls">
                    <button
                        type="button"
                        className="pr-session-player-ctrl"
                        onClick={togglePlay}
                        aria-label={isPlaying ? '暂停' : '播放'}
                    >
                        <Icon name={isPlaying ? 'stop' : 'play'} size={16} />
                    </button>
                    <span className="pr-session-player-time">
                        {formatTimeStr(currentTime)} / {formatTimeStr(duration)}
                    </span>
                    <div
                        className="pr-session-player-progress"
                        onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect()
                            const pct = (e.clientX - rect.left) / rect.width
                            seekTo(pct * duration)
                        }}
                        role="slider"
                        aria-valuenow={Math.round(progressPct)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        tabIndex={0}
                    >
                        <div className="pr-session-player-progress-fill" style={{ width: `${progressPct}%` }} />
                        {/* 事件标记点 */}
                        {result.timeline.map((evt, i) => {
                            const pct = duration > 0 ? (evt.offsetMs / 1000 / duration) * 100 : 0
                            return (
                                <span
                                    key={i}
                                    className="pr-session-player-event-marker"
                                    data-kind={evt.kind}
                                    data-active={i === activeEventIndex}
                                    style={{ left: `${pct}%` }}
                                />
                            )
                        })}
                    </div>
                </div>
            </div>

            {/* ── 事件时间线 ── */}
            <div className="pr-session-player-timeline">
                <div className="pr-session-player-timeline-header">
                    <span className="pr-session-player-timeline-title">事件时间线</span>
                    <div className="pr-session-player-timeline-stats">
                        {eventStats.route > 0 && <span className="pr-session-player-stat pr-session-player-stat--route">路由 {eventStats.route}</span>}
                        {eventStats.agent > 0 && <span className="pr-session-player-stat pr-session-player-stat--agent">AI {eventStats.agent}</span>}
                        {eventStats.ws > 0 && <span className="pr-session-player-stat pr-session-player-stat--ws">WS {eventStats.ws}</span>}
                        {eventStats.note > 0 && <span className="pr-session-player-stat pr-session-player-stat--note">备注 {eventStats.note}</span>}
                    </div>
                </div>

                {/* 上/下事件导航 */}
                <div className="pr-session-player-timeline-nav">
                    <button
                        type="button"
                        className="pr-session-player-ctrl pr-session-player-ctrl--sm"
                        onClick={handlePrevEvent}
                        disabled={activeEventIndex <= 0}
                        aria-label="上一个事件"
                    >
                        <Icon name="caret-left" size={14} />
                    </button>
                    <button
                        type="button"
                        className="pr-session-player-ctrl pr-session-player-ctrl--sm"
                        onClick={handleNextEvent}
                        disabled={activeEventIndex >= result.timeline.length - 1}
                        aria-label="下一个事件"
                    >
                        <Icon name="caret-right" size={14} />
                    </button>
                </div>

                {/* 事件列表 */}
                <div className="pr-session-player-event-list" role="list">
                    {result.timeline.length === 0 ? (
                        <div className="pr-session-player-event-empty">
                            <Icon name="info" size={14} />
                            <span>录制期间未捕获任何事件</span>
                        </div>
                    ) : (
                        result.timeline.map((evt, i) => {
                            const meta = EVENT_LABELS[evt.kind]
                            return (
                                <button
                                    key={i}
                                    type="button"
                                    className="pr-session-player-event-item"
                                    data-kind={evt.kind}
                                    data-active={i === activeEventIndex}
                                    role="listitem"
                                    onClick={() => seekToEvent(evt)}
                                >
                                    <span className="pr-session-player-event-time">
                                        {formatMs(evt.offsetMs)}
                                    </span>
                                    <span className="pr-session-player-event-icon" data-kind={evt.kind}>
                                        <Icon name={meta.icon} size={12} />
                                    </span>
                                    <span className="pr-session-player-event-label">
                                        {meta.label}
                                    </span>
                                    <span className="pr-session-player-event-desc">
                                        {evt.description}
                                    </span>
                                </button>
                            )
                        })
                    )}
                </div>
            </div>
        </div>
    )
}
