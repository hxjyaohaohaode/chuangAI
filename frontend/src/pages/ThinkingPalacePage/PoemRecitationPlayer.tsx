/**
 * SubTask 27.2：诗篇朗诵 AI TTS 模块（规范第 2、4、6、9、14 章）
 *
 * 调用 POST /api/ai/tts（mimo-v2.5-tts）
 * 职责：
 *  - 朗诵按钮（accent-primary 主按钮）
 *  - 播放控制：播放/暂停/停止 + 进度条
 *  - 音色选择：Combobox（男声/女声/童声）
 *  - 语速调节：滑块（0.5-2.0）
 *  - 跟读评分：录音后调用 ASR 识别 + 与原文对比 + 评分
 *  - 评分展示：环形进度条（accent-primary 色）+ 中心数字
 *
 * 设计要点（规范第 2、4、6、14 章）：
 *  - 零硬编码：所有色值引用 tokens.css 变量
 *  - 玻璃态面板：surface-secondary + backdrop-blur 20px
 *  - 无硬边框：透明度分层 + 阴影
 *  - 流体尺寸：clamp() 控制按钮/进度条尺寸
 *  - 完整三态：按钮 hover/active/focus-visible
 *  - GPU 友好：动画仅 transform/opacity
 *
 * 模型约束（大模型API文档.md）：
 *  - 仅使用 mimo-v2.5-tts（限时免费）
 *  - 禁止使用其他 TTS 模型
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
    beginAsyncGeneration,
    invalidateAsyncGeneration,
    isAsyncGenerationCurrent,
    type AsyncGenerationToken,
} from '@/lib/async-generation'
import { toast } from '@/stores/toast'
import { logError } from '@/lib/errors'
import { Icon } from '@/components/ui/Icon'
import { Combobox, type ComboboxOption } from '@/components/ui'
import type { AiAsrResponse, CulturePoem } from '@/lib/types'
import { VoiceInput } from './VoiceInput'

/* ============================================================
 * 常量
 * ============================================================ */

/** 音色选项（与 mimo-v2.5-tts 文档对齐） */
const VOICE_OPTIONS: ComboboxOption[] = [
    { value: 'alloy', label: '合金（中性）' },
    { value: 'male', label: '男声' },
    { value: 'female', label: '女声' },
    { value: 'child', label: '童声' },
]

/** 语速预设档位（与滑块 0.5-2.0 范围对齐） */
const SPEED_PRESETS: Array<{ value: number; label: string }> = [
    { value: 0.7, label: '慢' },
    { value: 1.0, label: '标准' },
    { value: 1.3, label: '快' },
]

/** 环形评分进度条半径 */
const SCORE_RING_RADIUS = 52
/** 环形评分进度条描边宽度 */
const SCORE_RING_STROKE = 6

/* ============================================================
 * 环形评分进度条
 * ============================================================ */

interface ScoreRingProps {
    /** 评分 0-100 */
    score: number
    /** 评分标题（如"相似度"） */
    label?: string
}

function ScoreRing({ score, label = '相似度' }: ScoreRingProps) {
    const clampedScore = Math.max(0, Math.min(100, score))
    const circumference = 2 * Math.PI * SCORE_RING_RADIUS
    const offset = circumference - (clampedScore / 100) * circumference

    // 评分着色：≥80 success / 60-80 primary / 40-60 warning / <40 error
    const colorVar =
        clampedScore >= 80
            ? 'var(--c-accent-success)'
            : clampedScore >= 60
                ? 'var(--c-accent-primary)'
                : clampedScore >= 40
                    ? 'var(--c-accent-warning)'
                    : 'var(--c-accent-error)'

    return (
        <div className="poem-recitation-score-ring" role="img" aria-label={`${label}：${clampedScore} 分`}>
            <svg width={(SCORE_RING_RADIUS + SCORE_RING_STROKE) * 2} height={(SCORE_RING_RADIUS + SCORE_RING_STROKE) * 2}>
                <circle
                    cx={SCORE_RING_RADIUS + SCORE_RING_STROKE}
                    cy={SCORE_RING_RADIUS + SCORE_RING_STROKE}
                    r={SCORE_RING_RADIUS}
                    fill="none"
                    stroke="rgb(var(--c-text-primary) / 0.08)"
                    strokeWidth={SCORE_RING_STROKE}
                />
                <circle
                    cx={SCORE_RING_RADIUS + SCORE_RING_STROKE}
                    cy={SCORE_RING_RADIUS + SCORE_RING_STROKE}
                    r={SCORE_RING_RADIUS}
                    fill="none"
                    stroke={colorVar}
                    strokeWidth={SCORE_RING_STROKE}
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    transform={`rotate(-90 ${SCORE_RING_RADIUS + SCORE_RING_STROKE} ${SCORE_RING_RADIUS + SCORE_RING_STROKE})`}
                    style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.16, 1, 0.3, 1)' }}
                />
            </svg>
            <div className="poem-recitation-score-ring__center">
                <strong style={{ color: colorVar }}>{Math.round(clampedScore)}</strong>
                <span>{label}</span>
            </div>
        </div>
    )
}

/* ============================================================
 * 主组件 —— PoemRecitationPlayer
 * ============================================================ */

export interface PoemRecitationPlayerProps {
    /** 当前选中的诗 */
    poem: CulturePoem | null
}

interface TtsGenerationRequest {
    token: AsyncGenerationToken
    poemId: string
    text: string
    voice: string
    speed: number
}

interface ScopedAudio {
    contextKey: string
    audioUrl: string
    durationMs: number
    cached: boolean
}

interface ScopedAsrResult {
    contextKey: string
    result: AiAsrResponse
}

interface ScopedTranscript {
    contextKey: string
    value: string
}

function revokeBlobAudioUrl(audioUrl: string): void {
    if (audioUrl.startsWith('blob:')) URL.revokeObjectURL(audioUrl)
}

export function PoemRecitationPlayer({ poem }: PoemRecitationPlayerProps) {
    /* ---------- 状态 ---------- */
    const [voice, setVoice] = useState<string>('female')
    const [speed, setSpeed] = useState<number>(1.0)
    const [scopedAudio, setScopedAudio] = useState<ScopedAudio | null>(null)
    const [scopedAsrResult, setScopedAsrResult] = useState<ScopedAsrResult | null>(null)
    const [asrRequestToken, setAsrRequestToken] = useState<AsyncGenerationToken | null>(null)
    /**
     * 跟读 transcript（受控回填给 VoiceInput）。
     * ASR 识别完成后回填为识别文本，用户可在 VoiceInput textarea 中编辑。
     * 数据链路：录音 → onRecordingComplete → api.ai.asr → setFollowTranscript → VoiceInput.transcript
     */
    const [scopedTranscript, setScopedTranscript] = useState<ScopedTranscript | null>(null)

    const audioRef = useRef<HTMLAudioElement | null>(null)
    const [isPlaying, setIsPlaying] = useState(false)
    const [currentTime, setCurrentTime] = useState(0)
    const ttsGenerationRef = useRef(0)
    const asrGenerationRef = useRef(0)
    const mountedRef = useRef(false)
    // TTS/ASR 实际输入中的诗 ID 与正文都进入键；同 ID 改文也必须作废旧结果。
    const poemContextKey = JSON.stringify([poem?.id ?? null, poem?.content ?? null])
    const latestPoemContextKeyRef = useRef(poemContextKey)
    latestPoemContextKeyRef.current = poemContextKey

    const isCurrentTtsGeneration = useCallback((token: AsyncGenerationToken) => (
        isAsyncGenerationCurrent(
            token,
            ttsGenerationRef.current,
            latestPoemContextKeyRef.current,
            mountedRef.current,
        )
    ), [])
    const isCurrentAsrGeneration = useCallback((token: AsyncGenerationToken) => (
        isAsyncGenerationCurrent(
            token,
            asrGenerationRef.current,
            latestPoemContextKeyRef.current,
            mountedRef.current,
        )
    ), [])

    const currentAudio = scopedAudio?.contextKey === poemContextKey ? scopedAudio : null
    const audioUrl = currentAudio?.audioUrl ?? null
    const durationMs = currentAudio?.durationMs ?? 0
    const cached = currentAudio?.cached ?? false
    const asrResult = scopedAsrResult?.contextKey === poemContextKey
        ? scopedAsrResult.result
        : null
    const followTranscript = scopedTranscript?.contextKey === poemContextKey
        ? scopedTranscript.value
        : ''
    const asrLoading = asrRequestToken !== null && isCurrentAsrGeneration(asrRequestToken)

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            invalidateAsyncGeneration(ttsGenerationRef)
            invalidateAsyncGeneration(asrGenerationRef)
        }
    }, [])

    /* ---------- 切换诗或同 ID 正文变化时清空并作废旧异步任务 ---------- */
    useEffect(() => {
        invalidateAsyncGeneration(ttsGenerationRef)
        invalidateAsyncGeneration(asrGenerationRef)
        audioRef.current?.pause()
        setScopedAudio(null)
        setScopedAsrResult(null)
        setAsrRequestToken(null)
        setScopedTranscript(null)
        setIsPlaying(false)
        setCurrentTime(0)
    }, [poemContextKey])

    // /api/ai/tts 返回二进制音频，API 客户端转换为 Blob URL。
    // 替换诗篇、重新生成或卸载时必须释放，避免长时间教研会话累积内存。
    useEffect(() => () => {
        if (scopedAudio) revokeBlobAudioUrl(scopedAudio.audioUrl)
    }, [scopedAudio])

    /* ---------- TanStack Query mutation：TTS 生成 ---------- */
    const ttsMutation = useMutation({
        mutationFn: async (request: TtsGenerationRequest) => {
            return api.ai.tts({
                text: request.text,
                voice: request.voice,
                speed: request.speed,
                responseFormat: 'mp3',
                poemId: request.poemId,
            })
        },
        onSuccess: (data, request) => {
            if (!isCurrentTtsGeneration(request.token)) {
                revokeBlobAudioUrl(data.audioUrl)
                return
            }
            setScopedAudio({
                contextKey: request.token.contextKey,
                audioUrl: data.audioUrl,
                durationMs: data.durationMs,
                cached: data.cached,
            })
            setScopedAsrResult(null)
            toast.success({
                title: '范读生成完成',
                message: data.cached ? '命中缓存，无需重复消耗配额' : '可点击播放按钮试听',
            })
        },
        onError: (err: unknown, request) => {
            if (!isCurrentTtsGeneration(request.token)) return
            logError('PoemRecitationPlayer.tts', err)
            toast.error({
                title: '范读生成失败',
                message: err instanceof Error ? err.message : '请稍后重试',
            })
        },
    })

    const activeTtsToken = ttsMutation.variables?.token
    const ttsBelongsToCurrentPoem = activeTtsToken
        ? isCurrentTtsGeneration(activeTtsToken)
        : false
    const isTtsPending = ttsMutation.isPending && ttsBelongsToCurrentPoem
    const hasTtsError = ttsMutation.isError && ttsBelongsToCurrentPoem

    /* ---------- TTS 生成 ---------- */
    const handleGenerate = useCallback(() => {
        if (!poem) {
            toast.warning({ message: '请先选择古诗' })
            return
        }
        const token = beginAsyncGeneration(ttsGenerationRef, poemContextKey)
        ttsMutation.mutate({
            token,
            poemId: poem.id,
            text: poem.content,
            voice,
            speed,
        })
    }, [poem, poemContextKey, voice, speed, ttsMutation])

    /* ---------- 音频控制 ---------- */
    const handlePlayPause = useCallback(() => {
        const audio = audioRef.current
        if (!audio || !audioUrl) return
        if (audio.paused) {
            void audio.play()
            setIsPlaying(true)
        } else {
            audio.pause()
            setIsPlaying(false)
        }
    }, [audioUrl])

    const handleStop = useCallback(() => {
        const audio = audioRef.current
        if (!audio) return
        audio.pause()
        audio.currentTime = 0
        setIsPlaying(false)
        setCurrentTime(0)
    }, [])

    const handleTimeUpdate = useCallback(() => {
        const audio = audioRef.current
        if (!audio) return
        setCurrentTime(audio.currentTime * 1000)
    }, [])

    const handleEnded = useCallback(() => {
        setIsPlaying(false)
        setCurrentTime(0)
    }, [])

    const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const audio = audioRef.current
        if (!audio || !durationMs) return
        const pct = Number(e.target.value) / 100
        audio.currentTime = (pct * durationMs) / 1000
        setCurrentTime(pct * durationMs)
    }, [durationMs])

    /* ---------- 跟读评分：录音完成回调 ---------- */
    const handleRecordingComplete = useCallback(
        async (audioBlob: Blob) => {
            if (!poem) {
                toast.warning({ message: '请先选择古诗' })
                return
            }
            const token = beginAsyncGeneration(asrGenerationRef, poemContextKey)
            const requestPoemId = poem.id
            const requestText = poem.content
            setAsrRequestToken(token)
            setScopedAsrResult(null)
            // 录音开始时先清空 transcript，给用户即时反馈
            setScopedTranscript({ contextKey: token.contextKey, value: '' })
            try {
                const result = await api.ai.asr(audioBlob, {
                    poemId: requestPoemId,
                    referenceText: requestText,
                })
                if (!isCurrentAsrGeneration(token)) return
                setScopedAsrResult({ contextKey: token.contextKey, result })
                if (result.degraded) {
                    setScopedTranscript({ contextKey: token.contextKey, value: '' })
                    toast.warning({
                        title: result.demo ? '演示模式未执行识别' : '语音识别已降级',
                        message: `未调用 ${result.requestedModel}，因此没有转写文本和评分。`,
                    })
                    return
                }
                // 关键：将 ASR 识别结果回填到 VoiceInput 的 textarea（打通数据链路）
                setScopedTranscript({ contextKey: token.contextKey, value: result.transcript || '' })
                if (result.similarityScore !== undefined) {
                    toast.success({
                        title: '评分完成',
                        message: `相似度 ${Math.round(result.similarityScore)} 分`,
                    })
                } else {
                    toast.info({ message: '识别完成（未提供对比原文）' })
                }
            } catch (err) {
                if (!isCurrentAsrGeneration(token)) return
                logError('PoemRecitationPlayer.asr', err)
                toast.error({
                    title: '识别失败',
                    message: err instanceof Error ? err.message : '请稍后重试',
                })
            } finally {
                if (isCurrentAsrGeneration(token)) setAsrRequestToken(null)
            }
        },
        [poem, poemContextKey, isCurrentAsrGeneration],
    )

    const handleTranscriptChange = useCallback((value: string) => {
        setScopedTranscript({ contextKey: poemContextKey, value })
    }, [poemContextKey])

    /* ---------- 派生 ---------- */
    const progressPct = useMemo(() => {
        if (!durationMs) return 0
        return Math.min(100, (currentTime / durationMs) * 100)
    }, [currentTime, durationMs])

    const formattedTime = useMemo(() => {
        const format = (ms: number) => {
            const total = Math.floor(ms / 1000)
            const m = Math.floor(total / 60)
            const s = total % 60
            return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        }
        return {
            current: format(currentTime),
            total: format(durationMs),
        }
    }, [currentTime, durationMs])

    /* ---------- 渲染 ---------- */
    if (!poem) {
        return (
            <div className="poem-recitation poem-recitation--empty">
                <Icon name="music-note" size={32} />
                <p>请先选择古诗，再生成朗诵范读</p>
            </div>
        )
    }

    return (
        <section
            className="poem-recitation"
            data-anchor
            data-anchor-label="AI 朗诵 TTS"
            aria-label="AI 朗诵 TTS"
        >
            <header className="poem-recitation__header">
                <span className="poem-recitation__eyebrow">
                    <Icon name="sparkle" size={12} weight="bold" />
                    <span>mimo-v2.5-tts · 诗篇朗诵</span>
                </span>
                <h3 className="poem-recitation__title">朗诵范读 · {poem.title}</h3>
                <p className="poem-recitation__subtitle">
                    AI 朗读范读供学生模仿；学生可跟读录音，AI 自动转写并评分。
                </p>
            </header>

            <div className="poem-recitation__controls">
                <div className="poem-recitation__control">
                    <label className="poem-recitation__label">音色</label>
                    <Combobox
                        options={VOICE_OPTIONS}
                        value={voice}
                        onChange={(v) => setVoice(v as string)}
                        mode="single"
                        ariaLabel="音色选择"
                        searchable={false}
                    />
                </div>
                <div className="poem-recitation__control poem-recitation__control--speed">
                    <label className="poem-recitation__label">
                        语速
                        <span className="poem-recitation__speed-value">{speed.toFixed(1)}×</span>
                    </label>
                    <input
                        type="range"
                        min={0.5}
                        max={2.0}
                        step={0.1}
                        value={speed}
                        onChange={(e) => setSpeed(Number(e.target.value))}
                        className="poem-recitation__slider"
                        aria-label="语速调节"
                    />
                    <div className="poem-recitation__speed-presets">
                        {SPEED_PRESETS.map((preset) => (
                            <button
                                key={preset.value}
                                type="button"
                                className={
                                    'poem-recitation__speed-preset' +
                                    (Math.abs(speed - preset.value) < 0.05 ? ' is-active' : '')
                                }
                                onClick={() => setSpeed(preset.value)}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            <div className="poem-recitation__actions">
                <button
                    className="poem-recitation__generate-btn"
                    onClick={handleGenerate}
                    disabled={isTtsPending}
                    aria-busy={isTtsPending}
                >
                    <Icon
                        name={isTtsPending ? 'circle-notch' : 'magic-wand'}
                        size={14}
                        weight={isTtsPending ? 'bold' : 'regular'}
                        className={isTtsPending ? 'pr-app-spin' : ''}
                    />
                    <span>
                        {isTtsPending
                            ? '生成中…'
                            : audioUrl
                                ? '重新生成范读'
                                : '生成朗诵范读'}
                    </span>
                </button>
                {cached && audioUrl && (
                    <span className="poem-recitation__cached-badge">
                        <Icon name="check-fat" size={11} weight="bold" />
                        缓存命中
                    </span>
                )}
            </div>

            {/* 错误态 */}
            {hasTtsError && (
                <div className="poem-recitation__error" role="alert">
                    <Icon name="warning-circle" size={16} />
                    <span>
                        {ttsMutation.error instanceof Error
                            ? ttsMutation.error.message
                            : '生成失败，请稍后重试'}
                    </span>
                </div>
            )}

            {/* 播放器 */}
            {audioUrl && (
                <div className="poem-recitation__player">
                    <audio
                        ref={audioRef}
                        src={audioUrl}
                        onTimeUpdate={handleTimeUpdate}
                        onEnded={handleEnded}
                        onPause={() => setIsPlaying(false)}
                        onPlay={() => setIsPlaying(true)}
                        preload="metadata"
                    />
                    <div className="poem-recitation__player-controls">
                        <button
                            className="poem-recitation__play-btn"
                            onClick={handlePlayPause}
                            aria-label={isPlaying ? '暂停' : '播放'}
                        >
                            <Icon
                                name={isPlaying ? 'stop' : 'play'}
                                size={16}
                                weight="bold"
                            />
                        </button>
                        <button
                            className="poem-recitation__stop-btn"
                            onClick={handleStop}
                            aria-label="停止"
                        >
                            <Icon name="stop" size={14} />
                        </button>
                        <span className="poem-recitation__time poem-recitation__time--current">
                            {formattedTime.current}
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={100}
                            step={0.1}
                            value={progressPct}
                            onChange={handleSeek}
                            className="poem-recitation__progress-slider"
                            aria-label="播放进度"
                        />
                        <span className="poem-recitation__time poem-recitation__time--total">
                            {formattedTime.total}
                        </span>
                    </div>
                    <div className="poem-recitation__poem-text">
                        <Icon name="quotes" size={12} />
                        <p>{poem.content}</p>
                    </div>
                </div>
            )}

            {/* 跟读评分区 */}
            <div className="poem-recitation__follow-read">
                <div className="poem-recitation__follow-read-header">
                    <h4 className="poem-recitation__follow-read-title">
                        <Icon name="microphone" size={14} />
                        跟读评分
                    </h4>
                    <p className="poem-recitation__follow-read-subtitle">
                        点击下方按钮录音，AI 将转写并与原文对比，给出相似度评分。
                    </p>
                </div>

                <VoiceInput
                    onRecordingComplete={handleRecordingComplete}
                    disabled={asrLoading}
                    placeholder="点击录音按钮开始跟读"
                    transcript={followTranscript}
                    onTranscriptChange={handleTranscriptChange}
                />

                {/* 评分结果 */}
                {asrLoading && (
                    <div className="poem-recitation__asr-loading" aria-busy="true">
                        <Icon name="circle-notch" size={20} className="pr-app-spin" />
                        <span>识别中…</span>
                    </div>
                )}

                {asrResult && !asrLoading && (
                    <div className="poem-recitation__asr-result">
                        {asrResult.similarityScore !== undefined && (
                            <ScoreRing score={asrResult.similarityScore} label="相似度" />
                        )}
                        <div className="poem-recitation__asr-detail">
                            {asrResult.degraded && (
                                <div className="poem-recitation__asr-row" role="status">
                                    <span className="poem-recitation__asr-label">
                                        <Icon name="info" size={11} />
                                        来源
                                    </span>
                                    <p className="poem-recitation__asr-text poem-recitation__asr-text--actual">
                                        {asrResult.demo ? '演示占位' : '服务降级'}：未调用 {asrResult.requestedModel}，未产生识别与评分。
                                    </p>
                                </div>
                            )}
                            <div className="poem-recitation__asr-row">
                                <span className="poem-recitation__asr-label">
                                    <Icon name="quotes" size={11} />
                                    原文
                                </span>
                                <p className="poem-recitation__asr-text poem-recitation__asr-text--ref">
                                    {poem.content}
                                </p>
                            </div>
                            <div className="poem-recitation__asr-row">
                                <span className="poem-recitation__asr-label">
                                    <Icon name="microphone" size={11} />
                                    识别
                                </span>
                                <p className="poem-recitation__asr-text poem-recitation__asr-text--actual">
                                    {asrResult.transcript || (asrResult.degraded ? '未执行识别' : '未识别到文字')}
                                </p>
                            </div>
                            {asrResult.diff && asrResult.diff.length > 0 && (
                                <div className="poem-recitation__asr-row">
                                    <span className="poem-recitation__asr-label">
                                        <Icon name="warning-circle" size={11} />
                                        差异
                                    </span>
                                    <ul className="poem-recitation__asr-diff">
                                        {asrResult.diff.slice(0, 8).map((d, i) => (
                                            <li key={i} className={`poem-recitation__asr-diff-item poem-recitation__asr-diff-item--${d.type}`}>
                                                <span className="poem-recitation__asr-diff-type">
                                                    {d.type === 'missing' ? '漏字' : d.type === 'wrong' ? '错字' : '多字'}
                                                </span>
                                                {d.expected && <span>应为「{d.expected}」</span>}
                                                {d.actual && <span>实际为「{d.actual}」</span>}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            <div className="poem-recitation__asr-meta">
                                <span>音频时长：{asrResult.audioDurationSec.toFixed(1)}s</span>
                                <span>·</span>
                                <span>实际处理：{asrResult.model}</span>
                                {asrResult.model !== asrResult.requestedModel && (
                                    <>
                                        <span>·</span>
                                        <span>请求模型：{asrResult.requestedModel}</span>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </section>
    )
}

export default PoemRecitationPlayer
