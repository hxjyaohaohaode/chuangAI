/**
 * ImmersiveProjector 沉浸式投屏控制（Task 20）
 *
 * 控制文化图片的沉浸式投屏播放：
 * - 16:9 预览区，展示当前投屏图片
 * - 状态指示器（idle/running/paused/stopped）+ 彩色圆点
 * - 启动/停止控制按钮
 * - 设置：切换间隔（秒）、朗读开关、背景音开关
 * - 信息面板：当前进度、总图片数、开始时间
 *
 * 设计要点：
 * - 投屏运行时轮询状态更新（2s 间隔，数据同步 ≤200ms 感知）
 * - 设置仅在非运行态可编辑（运行中显示服务端状态）
 * - 开关组件 spring 动画（规范 6.2 spring-snappy）
 * - 完整三态：hover 色变 / active scale(0.97) / focus-visible 光晕
 * - Tabular Numbers 显示进度与时间
 * - AI 生成标注
 * - 无 emoji
 */

import { memo, useEffect, useState } from 'react'
import { Icon } from '@/components/ui'
import { PoemImage } from '@/components/ui/PoemImage'
import { useCultureStore } from '@/stores/culture'
import type { ImmersiveStatus } from '@/lib/types'
import { cn } from '@/lib/cn'

interface ImmersiveProjectorProps {
    className?: string
}

export const ImmersiveProjector = memo(function ImmersiveProjector({
    className,
}: ImmersiveProjectorProps) {
    const selectedPoemId = useCultureStore((s) => s.selectedPoemId)
    const images = useCultureStore((s) => s.images)
    const immersiveState = useCultureStore((s) => s.immersiveState)
    const immersiveLoading = useCultureStore((s) => s.immersiveLoading)
    const startImmersive = useCultureStore((s) => s.startImmersive)
    const stopImmersive = useCultureStore((s) => s.stopImmersive)
    const fetchImmersiveStatus = useCultureStore((s) => s.fetchImmersiveStatus)

    // 本地设置（启动前可编辑，启动后由服务端状态接管显示）
    const [slideIntervalSec, setSlideIntervalSec] = useState(8)
    const [narrationEnabled, setNarrationEnabled] = useState(true)
    const [bgmEnabled, setBgmEnabled] = useState(false)

    const isRunning = immersiveState?.status === 'running'
    const isPaused = immersiveState?.status === 'paused'
    const isActive = isRunning || isPaused

    // 运行中单飞轮询投屏状态；隐藏页暂停，切诗/卸载会 Abort 旧请求。
    useEffect(() => {
        if (!isRunning || !selectedPoemId) return
        let cancelled = false
        let timer: number | undefined
        let controller: AbortController | null = null

        const schedule = (delay: number) => {
            if (cancelled || document.visibilityState === 'hidden') return
            if (timer !== undefined) window.clearTimeout(timer)
            timer = window.setTimeout(() => void poll(), delay)
        }
        const poll = async () => {
            if (cancelled || document.visibilityState === 'hidden') return
            controller?.abort()
            const ownController = new AbortController()
            controller = ownController
            try {
                await fetchImmersiveStatus(selectedPoemId, ownController.signal)
            } finally {
                if (controller === ownController) controller = null
                schedule(2_000)
            }
        }
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                if (timer !== undefined) window.clearTimeout(timer)
                timer = undefined
                controller?.abort()
                return
            }
            schedule(0)
        }

        document.addEventListener('visibilitychange', onVisibilityChange)
        schedule(0)
        return () => {
            cancelled = true
            if (timer !== undefined) window.clearTimeout(timer)
            controller?.abort()
            document.removeEventListener('visibilitychange', onVisibilityChange)
        }
    }, [isRunning, selectedPoemId, fetchImmersiveStatus])

    const handleStart = () => {
        if (!selectedPoemId || images.length === 0) return
        void startImmersive({
            poemId: selectedPoemId,
            slideIntervalSec,
            narrationEnabled,
            bgmEnabled,
        })
    }

    const handleStop = () => {
        void stopImmersive(selectedPoemId ?? undefined)
    }

    // 当前预览图片（运行中按 currentImageIndex 取，非运行取首张或空）
    const currentIndex = immersiveState?.currentImageIndex ?? 0
    const currentImage = images[currentIndex]
    // 展示用的设置值（运行中取服务端状态，非运行取本地设置）
    const displayInterval = isActive
        ? Math.round((immersiveState?.slideIntervalMs ?? 8000) / 1000)
        : slideIntervalSec
    const displayNarration = isActive
        ? (immersiveState?.narrationEnabled ?? false)
        : narrationEnabled
    const displayBgm = isActive
        ? (immersiveState?.bgmEnabled ?? false)
        : bgmEnabled

    const statusLabel = getStatusLabel(immersiveState?.status)
    const canStart = !!selectedPoemId && images.length > 0 && !isActive && !immersiveLoading

    return (
        <div className={cn('pr-culture-projector', className)}>
            <div className="pr-culture-section-header">
                <h2 className="pr-culture-section-title">
                    <span className="pr-culture-section-title-icon">
                        <Icon name="play" size={16} />
                    </span>
                    <span>沉浸式投屏</span>
                </h2>
                {immersiveState && (
                    <div className="pr-culture-section-meta">
                        <span className="pr-culture-ai-badge">
                            <Icon name="sparkle" size={10} />
                            AI 生成
                        </span>
                    </div>
                )}
            </div>

            {/* 预览区 16:9 */}
            <div className="pr-culture-projector-preview">
                {currentImage ? (
                    <PoemImage
                        src={currentImage.imageUrl}
                        alt={currentImage.title}
                        className="pr-culture-projector-preview-img"
                        ratio="16/9"
                        size="full"
                    />
                ) : (
                    <div className="pr-culture-projector-preview-empty">
                        <Icon name="mountains" size={32} />
                        <span className="pr-culture-projector-preview-empty-text">
                            {selectedPoemId ? '点击启动开始投屏' : '请先选择古诗'}
                        </span>
                    </div>
                )}
                {immersiveState && (
                    <div className="pr-culture-projector-status">
                        <span
                            className={cn(
                                'pr-culture-projector-status-dot',
                                immersiveState.status === 'idle' && 'is-idle',
                                immersiveState.status === 'stopped' && 'is-stopped',
                            )}
                        />
                        {statusLabel}
                    </div>
                )}
            </div>

            {/* 控制按钮 */}
            <div className="pr-culture-projector-controls">
                <button
                    type="button"
                    className="pr-culture-projector-btn pr-culture-projector-btn-start"
                    onClick={handleStart}
                    disabled={!canStart}
                >
                    <Icon name="play" size={14} />
                    <span>启动投屏</span>
                </button>
                <button
                    type="button"
                    className="pr-culture-projector-btn pr-culture-projector-btn-stop"
                    onClick={handleStop}
                    disabled={!isActive || immersiveLoading}
                >
                    <Icon name="stop" size={14} />
                    <span>停止</span>
                </button>
            </div>

            {/* 设置面板 */}
            <div className="pr-culture-projector-settings">
                <div className="pr-culture-projector-setting">
                    <span className="pr-culture-projector-setting-label">
                        <Icon name="timer" size={14} />
                        切换间隔
                    </span>
                    {isActive ? (
                        <span className="pr-culture-projector-setting-value">
                            {displayInterval} 秒
                        </span>
                    ) : (
                        <div className="pr-culture-projector-setting-slider">
                            <input
                                type="range"
                                min={3}
                                max={20}
                                step={1}
                                value={slideIntervalSec}
                                onChange={(e) => setSlideIntervalSec(Number(e.target.value))}
                                aria-label="切换间隔秒数"
                            />
                            <span className="pr-culture-projector-setting-value">
                                {slideIntervalSec} 秒
                            </span>
                        </div>
                    )}
                </div>
                <div className="pr-culture-projector-setting">
                    <span className="pr-culture-projector-setting-label">
                        <Icon name="microphone" size={14} />
                        朗读音频
                    </span>
                    <Toggle
                        isOn={displayNarration}
                        onChange={setNarrationEnabled}
                        disabled={isActive}
                        ariaLabel="朗读音频"
                    />
                </div>
                <div className="pr-culture-projector-setting">
                    <span className="pr-culture-projector-setting-label">
                        <Icon name="music-note" size={14} />
                        背景音乐
                    </span>
                    <Toggle
                        isOn={displayBgm}
                        onChange={setBgmEnabled}
                        disabled={isActive}
                        ariaLabel="背景音乐"
                    />
                </div>
            </div>

            {/* 投屏运行信息 */}
            {immersiveState && (
                <div className="pr-culture-projector-info">
                    <div className="pr-culture-projector-info-row">
                        <span className="pr-culture-projector-info-label">当前进度</span>
                        <span className="pr-culture-projector-info-value">
                            {currentIndex + 1} / {images.length}
                        </span>
                    </div>
                    <div className="pr-culture-projector-info-row">
                        <span className="pr-culture-projector-info-label">开始时间</span>
                        <span className="pr-culture-projector-info-value">
                            {formatTimestamp(immersiveState.startedAt)}
                        </span>
                    </div>
                </div>
            )}
        </div>
    )
})

/** 获取投屏状态中文标签 */
function getStatusLabel(status: ImmersiveStatus | undefined): string {
    switch (status) {
        case 'running':
            return '运行中'
        case 'paused':
            return '已暂停'
        case 'stopped':
            return '已停止'
        default:
            return '待机'
    }
}

/** 格式化时间戳为 HH:MM:SS */
function formatTimestamp(ts: number): string {
    const date = new Date(ts)
    const h = String(date.getHours()).padStart(2, '0')
    const m = String(date.getMinutes()).padStart(2, '0')
    const s = String(date.getSeconds()).padStart(2, '0')
    return `${h}:${m}:${s}`
}

interface ToggleProps {
    isOn: boolean
    onChange: (value: boolean) => void
    disabled?: boolean
    ariaLabel: string
}

/** 开关组件 —— spring 动画 thumb 滑动（规范 14.x 开关） */
function Toggle({ isOn, onChange, disabled, ariaLabel }: ToggleProps) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={isOn}
            aria-label={ariaLabel}
            className={cn('pr-culture-toggle', isOn && 'is-on')}
            onClick={() => onChange(!isOn)}
            disabled={disabled}
        >
            <span className="pr-culture-toggle-thumb" />
        </button>
    )
}
