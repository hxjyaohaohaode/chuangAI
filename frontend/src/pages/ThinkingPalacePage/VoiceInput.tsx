/**
 * SubTask 27.3：语音输入 AI ASR 模块（规范第 2、4、6、9、14 章）
 *
 * 调用 POST /api/ai/asr（mimo-v2.5-asr）
 * 职责：
 *  - 录音按钮（按住录音 / 点击录音两种模式）
 *  - 录音中：波形动画 + 计时器
 *  - 录音完成：自动回调父组件（由父组件调用 ASR）
 *  - 识别结果：显示在输入框（可编辑）
 *  - 用于诗篇重构：学生口述重构内容，AI 转文字
 *
 * 浏览器 API：
 *  - navigator.mediaDevices.getUserMedia({ audio: true })
 *  - MediaRecorder 录制 audio/webm
 *
 * 设计要点（规范第 2、4、6、14 章）：
 *  - 零硬编码：所有色值引用 tokens.css 变量
 *  - 录音中波形：CSS keyframe 动画，GPU 友好
 *  - 完整三态：按钮 hover/active/focus-visible
 *  - 无障碍：aria-label + role + 键盘可达
 *
 * 模型约束（大模型API文档.md）：
 *  - 仅使用 mimo-v2.5-asr（0.5元/小时）
 *  - 禁止使用其他 ASR 模型
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/ui/Icon'
import { toast } from '@/stores/toast'

/* ============================================================
 * 常量
 * ============================================================ */

/** 录音最大时长（ms），超过自动停止 */
const MAX_RECORDING_MS = 60_000

/** 波形条数量（视觉装饰，无功能性需求） */
const WAVEFORM_BARS = 5

/* ============================================================
 * 主组件 —— VoiceInput
 * ============================================================ */

export interface VoiceInputProps {
    /** 录音完成回调（父组件负责调用 ASR） */
    onRecordingComplete: (audioBlob: Blob) => void | Promise<void>
    /** 是否禁用（父组件正在处理时） */
    disabled?: boolean
    /** 输入框占位提示文案 */
    placeholder?: string
    /** 是否启用按住录音模式（默认 false，点击模式） */
    pressToTalk?: boolean
    /**
     * 受控 transcript（识别结果，可编辑）。
     * 传入时为受控模式，textarea 的 value 来自此 prop。
     * 用于父组件在 ASR 识别完成后回填结果。
     */
    transcript?: string
    /** transcript 变更回调（用户编辑 textarea 时触发） */
    onTranscriptChange?: (value: string) => void
}

/**
 * 一次录音的资源所有权。
 *
 * MediaRecorder 的 `stop`、最后一个 `dataavailable` 与 `onstop` 都是异步事件；
 * 因此不能在点击“停止”后立刻清空 chunks 或假定 getUserMedia 已经结束。会话对象
 * 将“正常交付”和“因卸载/禁用而取消”区分开，确保同一段音频至多回调一次。
 */
interface RecordingSession {
    recorder: MediaRecorder
    stream: MediaStream
    chunks: Blob[]
    mimeType: string
    shouldDeliver: boolean
    completed: boolean
    stopTracks: () => void
    complete: () => void
}

function VoiceInputImpl({
    onRecordingComplete,
    disabled = false,
    placeholder = '点击麦克风开始录音',
    pressToTalk = false,
    transcript,
    onTranscriptChange,
}: VoiceInputProps) {
    /* ---------- 状态 ---------- */
    const [isRecording, setIsRecording] = useState(false)
    const [isStarting, setIsStarting] = useState(false)
    const [elapsedMs, setElapsedMs] = useState(0)
    // 非受控模式下的内部 transcript（向后兼容）
    const [internalTranscript, setInternalTranscript] = useState('')

    // 受控优先：传入 transcript prop 时使用 prop 值，否则使用内部状态
    const displayTranscript = transcript !== undefined ? transcript : internalTranscript

    const activeSessionRef = useRef<RecordingSession | null>(null)
    const timerRef = useRef<number | null>(null)
    const startTimeRef = useRef(0)
    /** 每次启动/取消都推进；迟到的 getUserMedia 结果据此自行释放。 */
    const requestIdRef = useRef(0)
    const startingRef = useRef(false)
    /** 按住模式的输入所有权，避免授权兑现晚于释放动作时仍启动后台录音。 */
    const pressGestureActiveRef = useRef(false)
    const pressKeyboardActiveRef = useRef(false)
    const mountedRef = useRef(true)
    const disabledRef = useRef(disabled)
    const onRecordingCompleteRef = useRef(onRecordingComplete)
    // 用 ref 持有 stopRecording，避免 startRecording 的 setInterval 闭包陈旧
    const stopRecordingRef = useRef<() => void>(() => { })

    /** 只负责计时器；录音数据与媒体轨道由对应会话的 complete 统一回收。 */
    const clearTimer = useCallback(() => {
        if (timerRef.current) {
            window.clearInterval(timerRef.current)
            timerRef.current = null
        }
    }, [])

    /**
     * 取消当前录音或仍在等待授权的启动请求。
     * 取消路径永不调用 onRecordingComplete，防止页面卸载后把半段或无归属音频送往 ASR。
     */
    const cancelActiveRecording = useCallback(() => {
        requestIdRef.current += 1
        startingRef.current = false
        pressGestureActiveRef.current = false
        pressKeyboardActiveRef.current = false
        clearTimer()
        const session = activeSessionRef.current
        if (!session) {
            if (mountedRef.current) setIsStarting(false)
            return
        }

        session.shouldDeliver = false
        activeSessionRef.current = null
        try {
            if (session.recorder.state !== 'inactive') session.recorder.stop()
        } catch {
            // 浏览器可能已在设备断开时自行停止；complete 会保持幂等。
        }
        session.stopTracks()
        if (session.recorder.state === 'inactive') session.complete()
        if (mountedRef.current) {
            setIsRecording(false)
            setIsStarting(false)
            setElapsedMs(0)
        }
    }, [clearTimer])

    // onRecordingComplete、禁用状态与装载状态都经 ref 保持最新，避免异步媒体事件
    // 捕获到旧父级回调或在已卸载组件上继续启动录音。
    useEffect(() => {
        onRecordingCompleteRef.current = onRecordingComplete
    }, [onRecordingComplete])

    useEffect(() => {
        disabledRef.current = disabled
        if (disabled) cancelActiveRecording()
    }, [disabled, cancelActiveRecording])

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            cancelActiveRecording()
        }
    }, [cancelActiveRecording])

    /* ---------- 停止录音 ---------- */
    const stopRecording = useCallback(() => {
        const session = activeSessionRef.current
        if (!session || session.completed) return

        // 正常主动停止保留已采集的 chunk；最终由 onstop 在 dataavailable 之后交付。
        session.shouldDeliver = true
        clearTimer()
        if (mountedRef.current) setIsRecording(false)
        try {
            if (session.recorder.state !== 'inactive') {
                session.recorder.stop()
                // 立即释放麦克风指示灯；停止前已采集的数据仍会由 onstop 收尾。
                session.stopTracks()
                return
            }
        } catch {
            session.shouldDeliver = false
            if (mountedRef.current) {
                toast.error({ title: '录音停止失败', message: '浏览器未能完成录音收尾，请重新录制' })
            }
        }
        session.complete()
    }, [clearTimer])

    // 同步 stopRecording 到 ref，确保 startRecording 内的 setInterval 始终拿到最新引用
    useEffect(() => {
        stopRecordingRef.current = stopRecording
    }, [stopRecording])

    /* ---------- 开始录音 ---------- */
    const startRecording = useCallback(async () => {
        if (disabledRef.current || isRecording || startingRef.current || activeSessionRef.current) return
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
            toast.error({
                title: '不支持录音',
                message: '当前浏览器不支持麦克风录音，请使用 Chrome / Edge',
            })
            return
        }
        startingRef.current = true
        if (mountedRef.current) setIsStarting(true)
        const requestId = ++requestIdRef.current
        let stream: MediaStream | null = null
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true },
            })
            // 用户已离开页面、ASR 进入禁用态或已有后续请求时，迟到的授权结果必须
            // 立即关闭轨道，不能悄悄启动后台录音。
            if (requestId !== requestIdRef.current || !mountedRef.current || disabledRef.current) {
                stream.getTracks().forEach((track) => track.stop())
                return
            }

            const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
                && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : 'audio/webm'
            const recorder = new MediaRecorder(stream, { mimeType })
            let tracksStopped = false
            const session: RecordingSession = {
                recorder,
                stream,
                chunks: [],
                mimeType,
                shouldDeliver: false,
                completed: false,
                stopTracks: () => {
                    if (tracksStopped) return
                    tracksStopped = true
                    stream?.getTracks().forEach((track) => track.stop())
                },
                complete: () => { },
            }
            session.complete = () => {
                if (session.completed) return
                session.completed = true
                clearTimer()
                if (activeSessionRef.current === session) activeSessionRef.current = null
                session.stopTracks()
                if (mountedRef.current) setIsRecording(false)
                if (!session.shouldDeliver || !mountedRef.current) return

                const blob = new Blob(session.chunks, { type: session.mimeType })
                if (blob.size === 0) {
                    toast.error({ title: '录音无有效数据', message: '未收到可识别的录音，请检查麦克风后重新录制' })
                    return
                }
                void Promise.resolve(onRecordingCompleteRef.current(blob)).catch(() => {
                    if (mountedRef.current) {
                        toast.error({ title: '录音处理失败', message: '录音已结束，但未能提交识别，请重新尝试' })
                    }
                })
            }
            recorder.ondataavailable = (event) => {
                if (!session.completed && event.data.size > 0) session.chunks.push(event.data)
            }
            recorder.onstop = session.complete
            recorder.onerror = () => {
                session.shouldDeliver = false
                session.complete()
                if (mountedRef.current) {
                    toast.error({ title: '录音中断', message: '浏览器中断了录音，请重新尝试' })
                }
            }
            recorder.start()
            activeSessionRef.current = session
            setIsRecording(true)
            setElapsedMs(0)
            startTimeRef.current = Date.now()

            // 计时器：通过 ref 调用 stopRecording，避免闭包陈旧
            timerRef.current = window.setInterval(() => {
                const elapsed = Date.now() - startTimeRef.current
                setElapsedMs(elapsed)
                if (elapsed >= MAX_RECORDING_MS) {
                    stopRecordingRef.current()
                }
            }, 100)
        } catch (err) {
            stream?.getTracks().forEach((track) => track.stop())
            if (requestId === requestIdRef.current) {
                activeSessionRef.current = null
                clearTimer()
            }
            const msg = err instanceof DOMException && err.name === 'NotAllowedError'
                ? '麦克风权限被拒绝，请在浏览器设置中允许访问'
            : err instanceof Error ? err.message : '录音启动失败'
            if (mountedRef.current) toast.error({ title: '录音失败', message: msg })
        } finally {
            if (requestId === requestIdRef.current) {
                startingRef.current = false
                if (mountedRef.current) setIsStarting(false)
            }
        }
    }, [clearTimer, isRecording])

    /* ---------- textarea 变更：受控/非受控双模式同步 ---------- */
    const handleTranscriptChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value
        if (onTranscriptChange) onTranscriptChange(value)
        if (transcript === undefined) setInternalTranscript(value)
    }, [onTranscriptChange, transcript])

    /* ---------- 点击切换模式 ---------- */
    const handleClick = useCallback(() => {
        if (disabled) return
        if (isRecording) {
            stopRecording()
        } else if (startingRef.current) {
            // 第二次点击发生在权限提示尚未兑现时代表“取消”，而不是静默忽略；
            // 否则用户离开按钮后仍可能在后台开始录音。
            cancelActiveRecording()
        } else {
            void startRecording()
        }
    }, [cancelActiveRecording, disabled, isRecording, startRecording, stopRecording])

    /* ---------- 按住模式：按下/松开 ---------- */
    const completePressGesture = useCallback((cancelled = false) => {
        pressGestureActiveRef.current = false
        if (cancelled) {
            cancelActiveRecording()
            return
        }
        // 授权尚未兑现时没有 recorder；此时释放动作必须使迟到的 stream 失效。
        if (activeSessionRef.current?.recorder.state === 'recording') {
            stopRecording()
        } else {
            cancelActiveRecording()
        }
    }, [cancelActiveRecording, stopRecording])

    const handlePointerDown = useCallback(
        (e: React.PointerEvent<HTMLButtonElement>) => {
            if (!pressToTalk || disabled || isRecording || e.button !== 0 || !e.isPrimary) return
            e.preventDefault()
            pressGestureActiveRef.current = true
            void startRecording()
        },
        [pressToTalk, disabled, isRecording, startRecording],
    )

    const handlePointerUp = useCallback(() => {
        if (!pressToTalk || !pressGestureActiveRef.current) return
        completePressGesture()
    }, [completePressGesture, pressToTalk])

    const handlePointerLeave = useCallback(() => {
        if (!pressToTalk || !pressGestureActiveRef.current) return
        completePressGesture()
    }, [completePressGesture, pressToTalk])

    const handlePointerCancel = useCallback(() => {
        if (!pressToTalk || !pressGestureActiveRef.current) return
        completePressGesture(true)
    }, [completePressGesture, pressToTalk])

    const handlePressKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
        if (!pressToTalk || disabled || isRecording || e.repeat || (e.key !== ' ' && e.key !== 'Enter')) return
        e.preventDefault()
        pressKeyboardActiveRef.current = true
        void startRecording()
    }, [disabled, isRecording, pressToTalk, startRecording])

    const handlePressKeyUp = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
        if (!pressToTalk || !pressKeyboardActiveRef.current || (e.key !== ' ' && e.key !== 'Enter')) return
        e.preventDefault()
        pressKeyboardActiveRef.current = false
        if (activeSessionRef.current?.recorder.state === 'recording') {
            stopRecording()
        } else {
            cancelActiveRecording()
        }
    }, [cancelActiveRecording, pressToTalk, stopRecording])

    const handlePressBlur = useCallback(() => {
        if (!pressToTalk || (!pressGestureActiveRef.current && !pressKeyboardActiveRef.current)) return
        cancelActiveRecording()
    }, [cancelActiveRecording, pressToTalk])

    /* ---------- 计时格式化 ---------- */
    const formattedTime = (() => {
        const total = Math.floor(elapsedMs / 1000)
        const m = Math.floor(total / 60)
        const s = total % 60
        const ms = Math.floor((elapsedMs % 1000) / 100)
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`
    })()

    /* ---------- 渲染 ---------- */
    return (
        <div className="voice-input" role="group" aria-label="语音输入">
            <div className="voice-input__controls">
                <button
                    type="button"
                    className={
                        'voice-input__btn' +
                        (isRecording ? ' is-recording' : '') +
                        (isStarting ? ' is-starting' : '') +
                        (disabled ? ' is-disabled' : '')
                    }
                    onClick={pressToTalk ? undefined : handleClick}
                    onPointerDown={pressToTalk ? handlePointerDown : undefined}
                    onPointerUp={pressToTalk ? handlePointerUp : undefined}
                    onPointerLeave={pressToTalk ? handlePointerLeave : undefined}
                    onPointerCancel={pressToTalk ? handlePointerCancel : undefined}
                    onKeyDown={pressToTalk ? handlePressKeyDown : undefined}
                    onKeyUp={pressToTalk ? handlePressKeyUp : undefined}
                    onBlur={pressToTalk ? handlePressBlur : undefined}
                    disabled={disabled}
                    aria-label={isRecording ? '停止录音' : isStarting ? '取消录音授权' : '开始录音'}
                    aria-pressed={isRecording}
                >
                    <Icon
                        name={isRecording ? 'stop' : 'microphone'}
                        size={18}
                        weight={isRecording ? 'bold' : 'regular'}
                    />
                </button>

                {/* 录音中：波形 + 计时器 */}
                {isRecording ? (
                    <div className="voice-input__waveform" aria-hidden="true">
                        {Array.from({ length: WAVEFORM_BARS }, (_, i) => (
                            <span
                                key={i}
                                className="voice-input__wave-bar"
                                style={{
                                    animationDelay: `${i * 100}ms`,
                                    animationDuration: `${600 + i * 80}ms`,
                                }}
                            />
                        ))}
                        <span className="voice-input__timer" aria-live="polite">
                            {formattedTime}
                        </span>
                    </div>
                ) : (
                    <span className="voice-input__hint">
                        {disabled ? '处理中…' : isStarting ? '正在请求麦克风权限，再次点击取消' : pressToTalk ? '按住说话（空格或 Enter）' : '点击录音'}
                    </span>
                )}
            </div>

            {/* 识别结果输入框（可编辑） —— 受控模式：父组件 ASR 完成后回填 */}
            <textarea
                className="voice-input__transcript"
                value={displayTranscript}
                onChange={handleTranscriptChange}
                placeholder={placeholder}
                aria-label="识别结果（可编辑）"
                rows={3}
            />
        </div>
    )
}

export const VoiceInput = memo(VoiceInputImpl)
export default VoiceInput
