/**
 * 点选 + AI 语音输入辅助条
 *
 * 统一交互顺序：
 * 1. 优先点击常用表达；
 * 2. 内容不在选项中时，点击麦克风口述；
 * 3. ASR 只回填文字，由用户确认后再提交。
 *
 * 语音链路使用项目真实的 POST /api/ai/asr（mimo-v2.5-asr），
 * 不依赖浏览器 SpeechRecognition 的兼容性与在线服务。
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { getDisplayError } from '@/lib/errors'
import { toast } from '@/stores/toast'
import { Icon } from './Icon'
import './icons-extended'
import './QuickVoiceAssist.css'

type VoiceState = 'idle' | 'requesting' | 'recording' | 'transcribing'

const MAX_RECORDING_MS = 30_000

/**
 * 一次语音采集的唯一资源所有者。
 *
 * 浏览器的权限兑现、MediaRecorder 的最后一个 dataavailable 与 onstop 都是异步的；
 * 因而“点击取消”“父级禁用”“组件卸载”不能只改 React 状态。会话对象把正常转写
 * 与取消路径分开，保证失去用户意图的音频不会进入 ASR，也不会遗留设备轨道。
 */
interface VoiceCaptureSession {
    recorder: MediaRecorder
    stream: MediaStream
    chunks: Blob[]
    mimeType: string
    shouldTranscribe: boolean
    completed: boolean
    stopTracks: () => void
    complete: () => void
}

function pickAudioMimeType(): string | undefined {
    if (typeof MediaRecorder === 'undefined') return undefined
    const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
    ]
    return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate))
}

function audioFileName(mimeType: string): string {
    return mimeType.includes('mp4') ? 'voice-input.m4a' : 'voice-input.webm'
}

export interface VoiceCaptureButtonProps {
    onTranscript: (text: string) => void
    disabled?: boolean
    compact?: boolean
    label?: string
    className?: string
}

export const VoiceCaptureButton = memo(function VoiceCaptureButton({
    onTranscript,
    disabled = false,
    compact = false,
    label = '语音输入',
    className = '',
}: VoiceCaptureButtonProps) {
    const [state, setState] = useState<VoiceState>('idle')
    const stateRef = useRef<VoiceState>('idle')
    const activeSessionRef = useRef<VoiceCaptureSession | null>(null)
    const timerRef = useRef<number | null>(null)
    const mountedRef = useRef(true)
    const disabledRef = useRef(disabled)
    const requestIdRef = useRef(0)
    const onTranscriptRef = useRef(onTranscript)

    const setVoiceState = useCallback((nextState: VoiceState) => {
        stateRef.current = nextState
        if (mountedRef.current) setState(nextState)
    }, [])

    const clearRecordingTimer = useCallback(() => {
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current)
            timerRef.current = null
        }
    }, [])

    /**
     * 取消正在等待授权、录音或转写的操作。请求代次递增后，迟到的 getUserMedia
     * 结果即使成功也只会立即停止轨道，不能在用户已取消后默默开始后台录音。
     */
    const cancelCapture = useCallback(() => {
        requestIdRef.current += 1
        clearRecordingTimer()

        const session = activeSessionRef.current
        if (session) {
            session.shouldTranscribe = false
            activeSessionRef.current = null
            try {
                if (session.recorder.state !== 'inactive') session.recorder.stop()
            } catch {
                // 设备断开时浏览器可能已停止录音；complete 仍保持幂等收尾。
            }
            session.stopTracks()
            if (session.recorder.state === 'inactive') session.complete()
        }

        setVoiceState('idle')
    }, [clearRecordingTimer, setVoiceState])

    useEffect(() => {
        onTranscriptRef.current = onTranscript
    }, [onTranscript])

    useEffect(() => {
        disabledRef.current = disabled
        if (disabled) cancelCapture()
    }, [cancelCapture, disabled])

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            cancelCapture()
        }
    }, [cancelCapture])

    const stopRecording = useCallback(() => {
        const session = activeSessionRef.current
        if (!session || session.completed) return

        // 正常停止必须保留最终 dataavailable；真正回收和发起 ASR 都交给 onstop。
        session.shouldTranscribe = true
        clearRecordingTimer()
        try {
            if (session.recorder.state !== 'inactive') {
                session.recorder.stop()
                return
            }
        } catch {
            session.shouldTranscribe = false
            if (mountedRef.current) {
                toast.error({ title: '录音停止失败', message: '浏览器未能完成录音收尾，请重新录制' })
            }
        }
        session.complete()
    }, [clearRecordingTimer])

    const startRecording = useCallback(async () => {
        if (disabledRef.current || stateRef.current !== 'idle' || activeSessionRef.current) return
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
            toast.error({
                title: '当前设备不能录音',
                message: '请使用新版 Chrome 或 Edge，也可以继续键盘输入',
            })
            return
        }

        const requestId = ++requestIdRef.current
        setVoiceState('requesting')
        let stream: MediaStream | null = null
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            })
            if (requestId !== requestIdRef.current || !mountedRef.current || disabledRef.current) {
                stream.getTracks().forEach((track) => track.stop())
                return
            }

            const mimeType = pickAudioMimeType()
            const recorder = mimeType
                ? new MediaRecorder(stream, { mimeType })
                : new MediaRecorder(stream)

            let tracksStopped = false
            const session: VoiceCaptureSession = {
                recorder,
                stream,
                chunks: [],
                mimeType: recorder.mimeType || mimeType || 'audio/webm',
                shouldTranscribe: false,
                completed: false,
                stopTracks: () => {
                    if (tracksStopped) return
                    tracksStopped = true
                    stream?.getTracks().forEach((track) => track.stop())
                },
                complete: () => {},
            }

            session.complete = () => {
                if (session.completed) return
                session.completed = true
                clearRecordingTimer()
                if (activeSessionRef.current === session) activeSessionRef.current = null
                session.stopTracks()

                const canTranscribe = session.shouldTranscribe
                    && requestId === requestIdRef.current
                    && mountedRef.current
                const blob = new Blob(session.chunks, { type: session.mimeType })
                session.chunks = []
                if (!canTranscribe) {
                    if (requestId === requestIdRef.current && mountedRef.current) setVoiceState('idle')
                    return
                }
                if (blob.size === 0) {
                    setVoiceState('idle')
                    toast.error({ title: '没有录到声音', message: '请确认麦克风已开启' })
                    return
                }

                setVoiceState('transcribing')
                void api.ai.asr(blob, {}, audioFileName(session.mimeType))
                    .then((result) => {
                        if (requestId !== requestIdRef.current || !mountedRef.current) return
                        if (result.degraded) {
                            toast.warning({
                                title: '语音识别未执行',
                                message: `当前未调用 ${result.requestedModel}；请连接后端并配置模型后重试`,
                            })
                            return
                        }
                        const transcript = result.transcript?.trim() ?? ''
                        if (!transcript) {
                            toast.error({ title: '没有听清', message: '请放慢语速、靠近麦克风再说一次' })
                            return
                        }
                        onTranscriptRef.current(transcript)
                        toast.success({ title: '已转成文字', message: '请检查一下，再确认提交' })
                    })
                    .catch((error) => {
                        if (requestId !== requestIdRef.current || !mountedRef.current) return
                        toast.error({
                            title: '语音识别失败',
                            message: getDisplayError(error, '请稍后重试，也可以继续键盘输入'),
                        })
                    })
                    .finally(() => {
                        if (requestId === requestIdRef.current && mountedRef.current) setVoiceState('idle')
                    })
            }

            recorder.ondataavailable = (event) => {
                if (!session.completed && event.data.size > 0) session.chunks.push(event.data)
            }
            recorder.onerror = () => {
                session.shouldTranscribe = false
                session.complete()
                if (requestId === requestIdRef.current && mountedRef.current) {
                    toast.error({ title: '录音中断', message: '请靠近麦克风后再试一次' })
                }
            }
            recorder.onstop = session.complete

            recorder.start(250)
            activeSessionRef.current = session
            setVoiceState('recording')
            timerRef.current = window.setTimeout(stopRecording, MAX_RECORDING_MS)
        } catch (error) {
            stream?.getTracks().forEach((track) => track.stop())
            if (requestId !== requestIdRef.current || !mountedRef.current) return
            clearRecordingTimer()
            activeSessionRef.current = null
            setVoiceState('idle')
            const denied = error instanceof DOMException && error.name === 'NotAllowedError'
            toast.error({
                title: denied ? '需要麦克风权限' : '无法开始录音',
                message: denied
                    ? '请在浏览器地址栏允许麦克风，然后再试一次'
                    : getDisplayError(error, '请检查设备麦克风'),
            })
        }
    }, [clearRecordingTimer, setVoiceState, stopRecording])

    const handleClick = useCallback(() => {
        if (disabled) return
        if (stateRef.current === 'recording') {
            stopRecording()
            return
        }
        if (stateRef.current === 'requesting') {
            cancelCapture()
            return
        }
        if (stateRef.current === 'idle') void startRecording()
    }, [cancelCapture, disabled, startRecording, stopRecording])

    const stateLabel = state === 'requesting'
        ? '正在请求麦克风权限，再次点击取消'
        : state === 'recording'
            ? '说完点这里'
            : state === 'transcribing'
                ? 'AI 识别中'
                : label

    return (
        <button
            type="button"
            className={[
                'pr-voice-capture',
                compact ? 'pr-voice-capture--compact' : '',
                state === 'recording' ? 'is-recording' : '',
                state === 'requesting' ? 'is-requesting' : '',
                className,
            ].filter(Boolean).join(' ')}
            onClick={handleClick}
            disabled={disabled || state === 'transcribing'}
            aria-label={`${stateLabel}。录音内容会转成文字，确认后再提交`}
            aria-pressed={state === 'recording'}
            aria-busy={state === 'requesting' || state === 'transcribing'}
            title={state === 'requesting'
                ? '正在等待麦克风权限；再次点击可取消'
                : '点击开始说话，再点一次结束；AI 转成文字后可修改'}
        >
            <span className="pr-voice-capture__icon" aria-hidden="true">
                <Icon
                    name={state === 'recording' ? 'stop' : state === 'requesting' || state === 'transcribing' ? 'spinner' : 'microphone'}
                    size={compact ? 16 : 18}
                    weight={state === 'recording' ? 'fill' : 'regular'}
                />
            </span>
            <span>{stateLabel}</span>
            {state === 'recording' && (
                <span className="pr-voice-capture__live" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                </span>
            )}
        </button>
    )
})

export interface QuickVoiceAssistProps {
    suggestions?: readonly string[]
    onPick: (value: string) => void
    onTranscript?: (text: string) => void
    label?: string
    voiceLabel?: string
    disabled?: boolean
    compact?: boolean
    hideVoice?: boolean
    className?: string
}

export const QuickVoiceAssist = memo(function QuickVoiceAssist({
    suggestions = [],
    onPick,
    onTranscript,
    label = '点一点，或直接说',
    voiceLabel = '说出内容',
    disabled = false,
    compact = false,
    hideVoice = false,
    className = '',
}: QuickVoiceAssistProps) {
    return (
        <div
            className={[
                'pr-quick-voice',
                compact ? 'pr-quick-voice--compact' : '',
                className,
            ].filter(Boolean).join(' ')}
            role="group"
            aria-label={label}
        >
            <div className="pr-quick-voice__head">
                <span className="pr-quick-voice__label">
                    <Icon name="sparkles" size={compact ? 12 : 14} />
                    {label}
                </span>
                {!hideVoice && onTranscript && (
                    <VoiceCaptureButton
                        onTranscript={onTranscript}
                        disabled={disabled}
                        compact={compact}
                        label={voiceLabel}
                    />
                )}
            </div>
            {suggestions.length > 0 && (
                <div className="pr-quick-voice__choices">
                    {suggestions.map((suggestion) => (
                        <button
                            key={suggestion}
                            type="button"
                            className="pr-quick-voice__choice"
                            onClick={() => onPick(suggestion)}
                            disabled={disabled}
                        >
                            {suggestion}
                        </button>
                    ))}
                </div>
            )}
            <span className="pr-sr-only" aria-live="polite">
                可选择建议，也可用 AI 语音转文字；内容不会自动提交
            </span>
        </div>
    )
})

export default QuickVoiceAssist
