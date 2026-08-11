/**
 * 进化预测 AI 组件（规范第 2、6、7、11、14 章 · SubTask 26.4）
 *
 * 职责：
 *  - 调用 POST /evolution/predict 走 SSE 流式输出（api.evolution.streamPredict）
 *  - 大模型：deepseek-v4-pro，thinking_mode: high（由后端调用，前端只发请求）
 *  - 思考过程流式渲染（StreamText typewriter 效果，规范 11.1）
 *  - 预测方向卡片：accent-primary glow + MagicRings 装饰
 *  - 中断/继续按钮（规范 11.1：用户可随时中断流式输出）
 *  - 错误降级：后端 endpoint 不可用时显示明确错误，不阻塞页面其他功能
 *
 * 设计要点：
 *  - 零硬编码：所有色值引用 tokens.css 变量
 *  - 无硬边框：区域分隔用透明度差异 + backdrop-blur
 *  - Tabular Numbers：置信度、预期提升数值右对齐
 *  - 完整三态：按钮 hover/active/focus-visible
 *  - GPU 友好：动画仅 transform/opacity
 *  - 无障碍：aria-live="polite" 让屏幕阅读器感知流式更新
 *  - prefers-reduced-motion：StreamText 内部已处理降级
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { logError } from '@/lib/errors'
import { toast } from '@/stores/toast'
import { Icon } from '@/components/ui/Icon'
import { MagicRings } from '@/components/ui/MagicRings'
import type {
    EvolutionPredictionDirection,
    EvolutionPredictionResult,
    EvolutionPredictRequest,
    GenealogyNode,
    PatternItem,
} from '@/lib/types'
import type { LessonStreamController } from '@/lib/types'

/* ============================================================
 * 类型
 * ============================================================ */

type PredictorStatus = 'idle' | 'streaming' | 'done' | 'error'

interface EvolutionPredictorProps {
    /** 当前版本节点（作为预测的输入上下文） */
    currentVersions: GenealogyNode[]
    /** 历史进化模式（作为预测的输入上下文） */
    historicalPatterns: PatternItem[]
    /** 预测结果回调（用于联动 3D 预测路径渲染） */
    onPredictions?: (predictions: EvolutionPredictionDirection[]) => void
}

/* ============================================================
 * 单条预测方向卡片
 * ============================================================ */

interface PredictionCardProps {
    prediction: EvolutionPredictionDirection
    index: number
}

function PredictionCard({ prediction, index }: PredictionCardProps) {
    // 置信度 → 颜色梯度（高置信度 → accent-primary，低 → accent-info）
    const confidenceColor = prediction.confidence > 0.7
        ? 'rgb(var(--c-accent-primary))'
        : prediction.confidence > 0.4
            ? 'rgb(var(--c-accent-info))'
            : 'rgb(var(--c-text-tertiary))'

    return (
        <article
            className="predictor-card"
            style={{
                animationDelay: `${index * 80}ms`,
            }}
            aria-label={`预测方向 ${index + 1}：${prediction.direction}`}
        >
            {/* MagicRings 装饰：accent-primary 光韵流转 */}
            <div className="predictor-card__rings" aria-hidden="true">
                <MagicRings
                    color="rgb(var(--c-accent-primary))"
                    speed={6}
                    layers={1}
                    borderRadius={14}
                    strokeWidth={1.2}
                />
            </div>

            <header className="predictor-card__header">
                <span className="predictor-card__index" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                </span>
                <h4 className="predictor-card__direction">{prediction.direction}</h4>
            </header>

            <p className="predictor-card__suggestion">{prediction.suggestion}</p>

            <footer className="predictor-card__footer">
                <div className="predictor-card__metric">
                    <span className="predictor-card__metric-label">预期提升</span>
                    <strong
                        className="predictor-card__metric-value"
                        style={{ color: 'rgb(var(--c-accent-success))' }}
                    >
                        +{(prediction.expectedImprovement * 100).toFixed(1)}%
                    </strong>
                </div>
                <div className="predictor-card__metric">
                    <span className="predictor-card__metric-label">置信度</span>
                    <div className="predictor-card__confidence-bar" aria-hidden="true">
                        <div
                            className="predictor-card__confidence-fill"
                            style={{
                                // 下限 0.04：置信度为 0 时仍留一丝可见宽度，
                                // 让教师看到「有这个指标但值极低」，而不是一条空轨道
                                transform: `scaleX(${Math.max(0.04, prediction.confidence)})`,
                                background: confidenceColor,
                            }}
                        />
                    </div>
                    <strong
                        className="predictor-card__metric-value"
                        style={{ color: confidenceColor }}
                    >
                        {(prediction.confidence * 100).toFixed(0)}%
                    </strong>
                </div>
            </footer>
        </article>
    )
}

/* ============================================================
 * 主组件 —— EvolutionPredictor
 * ============================================================ */

export function EvolutionPredictor({
    currentVersions,
    historicalPatterns,
    onPredictions,
}: EvolutionPredictorProps) {
    /* ---------- 状态 ---------- */
    const [status, setStatus] = useState<PredictorStatus>('idle')
    const [thinking, setThinking] = useState('') // 思考过程 token 流
    const [predictions, setPredictions] = useState<EvolutionPredictionDirection[]>([])
    const [errorMessage, setErrorMessage] = useState<string>('')
    const [result, setResult] = useState<EvolutionPredictionResult | null>(null)

    const controllerRef = useRef<LessonStreamController | null>(null)
    const thinkingBufferRef = useRef<string>('')
    const rafRef = useRef<number | null>(null)

    /* ---------- 思考过程流式更新（rAF 合并，避免每个 token 都 setState） ---------- */
    const flushThinking = useCallback(() => {
        rafRef.current = null
        setThinking(thinkingBufferRef.current)
    }, [])

    const appendToken = useCallback((token: string) => {
        thinkingBufferRef.current += token
        if (rafRef.current === null) {
            rafRef.current = requestAnimationFrame(flushThinking)
        }
    }, [flushThinking])

    /* ---------- 清理 ---------- */
    useEffect(() => {
        return () => {
            if (controllerRef.current) {
                controllerRef.current.abort()
                controllerRef.current = null
            }
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current)
            }
        }
    }, [])

    /* ---------- 生成预测 ---------- */
    const handleGenerate = useCallback(() => {
        if (status === 'streaming') return

        // 重置状态
        setStatus('streaming')
        setThinking('')
        setPredictions([])
        setResult(null)
        setErrorMessage('')
        thinkingBufferRef.current = ''

        // 构造请求体
        const request: EvolutionPredictRequest = {
            historicalPatterns: historicalPatterns.slice(0, 30).map((p) => ({
                pattern: p.pattern,
                source: p.source,
                timestamp: p.timestamp,
            })),
            currentVersions: currentVersions.slice(0, 12).map((n) => ({
                version: n.version,
                agentId: n.agentId,
                isActive: n.isActive,
                quality: n.quality,
                createdAt: n.createdAt,
            })),
            horizon: 7,
        }

        // 数据不足时直接报错
        if (request.historicalPatterns.length === 0 && request.currentVersions.length === 0) {
            setStatus('error')
            setErrorMessage('当前无历史模式与版本数据，无法生成预测')
            return
        }

        const controller = api.evolution.streamPredict(request, {
            onToken: (token) => appendToken(token),
            onPredictions: (preds) => {
                setPredictions(preds)
                onPredictions?.(preds)
            },
            onDone: (finalResult) => {
                controllerRef.current = null
                if (rafRef.current !== null) {
                    cancelAnimationFrame(rafRef.current)
                    rafRef.current = null
                }
                setThinking(thinkingBufferRef.current)
                if (finalResult.predictions.length > 0) {
                    setPredictions(finalResult.predictions)
                    onPredictions?.(finalResult.predictions)
                }
                setResult(finalResult)
                setStatus('done')
                if (finalResult.aiGenerated) {
                    toast.success({
                        title: '预测完成',
                        message: `已生成 ${finalResult.predictions.length} 条进化方向`,
                    })
                } else {
                    toast.info({
                        title: '使用本地统计预测',
                        message: '模型结果未通过校验或暂不可用，已使用可解释的本地统计预测',
                    })
                }
            },
            onError: (err) => {
                controllerRef.current = null
                if (rafRef.current !== null) {
                    cancelAnimationFrame(rafRef.current)
                    rafRef.current = null
                }
                logError('EvolutionPredictor.streamPredict', err)
                setStatus('error')
                setErrorMessage(err.message || '预测请求失败')
                toast.error({
                    title: '预测失败',
                    message: err.message || '后端接口不可用，请稍后重试',
                })
            },
        })

        controllerRef.current = controller
    }, [status, historicalPatterns, currentVersions, onPredictions, appendToken])

    /* ---------- 中断 ---------- */
    const handleAbort = useCallback(() => {
        if (controllerRef.current) {
            controllerRef.current.abort()
            controllerRef.current = null
        }
        if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current)
            rafRef.current = null
        }
        setThinking(thinkingBufferRef.current)
        setStatus('done')
        toast.info({
            title: '已中断',
            message: '预测流已中断，已生成的部分结果保留',
        })
    }, [])

    /* ---------- 派生：是否可生成 ---------- */
    const canGenerate = useMemo(() => {
        return (
            status !== 'streaming' &&
            (historicalPatterns.length > 0 || currentVersions.length > 0)
        )
    }, [status, historicalPatterns.length, currentVersions.length])

    /* ---------- 渲染 ---------- */
    return (
        <section className="predictor" aria-label="进化预测 AI">
            <header className="predictor__header">
                <div className="predictor__title-row">
                    <Icon name="sparkle" size={16} weight="bold" />
                    <h3 className="predictor__title">进化预测 AI</h3>
                    {result && (
                        <span
                            className={`predictor__badge ${result.aiGenerated ? 'predictor__badge--ai' : 'predictor__badge--template'}`}
                            aria-label={result.aiGenerated ? 'AI 生成' : '模板降级'}
                        >
                            {result.aiGenerated ? 'AI 生成' : '模板降级'}
                        </span>
                    )}
                </div>
                <p className="predictor__subtitle">
                    基于 deepseek-v4-pro（thinking_mode: high）分析历史进化模式与当前版本，
                    预测未来 7 天的进化方向。
                </p>
            </header>

            {/* 控制按钮区 */}
            <div className="predictor__controls">
                {status === 'streaming' ? (
                    <button
                        type="button"
                        className="predictor__btn predictor__btn--abort"
                        onClick={handleAbort}
                        aria-label="中断预测"
                    >
                        <Icon name="stop" size={14} />
                        <span>中断</span>
                    </button>
                ) : (
                    <button
                        type="button"
                        className="predictor__btn predictor__btn--generate"
                        onClick={handleGenerate}
                        disabled={!canGenerate}
                        aria-label="生成预测"
                    >
                        <Icon name="sparkle" size={14} weight="bold" />
                        <span>{status === 'done' ? '重新生成' : '生成预测'}</span>
                    </button>
                )}
                <span className="predictor__status" aria-live="polite">
                    {status === 'idle' && '就绪'}
                    {status === 'streaming' && '正在分析…'}
                    {status === 'done' && `完成 · ${predictions.length} 条方向`}
                    {status === 'error' && '错误'}
                </span>
            </div>

            {/* 错误降级提示 */}
            {status === 'error' && (
                <div className="predictor__error" role="alert">
                    <Icon name="warning-circle" size={16} />
                    <div>
                        <strong>预测服务暂不可用</strong>
                        <span>{errorMessage}</span>
                    </div>
                    <button
                        type="button"
                        className="predictor__retry"
                        onClick={handleGenerate}
                    >
                        重试
                    </button>
                </div>
            )}

            {/* 思考过程流式输出（规范 11.1：typewriter 效果） */}
            {thinking && (
                <details className="predictor__thinking" open={status === 'streaming'}>
                    <summary>
                        <Icon name="brain" size={14} />
                        <span>思考过程</span>
                        <span className="predictor__thinking-meta">
                            {thinking.length} 字符
                        </span>
                    </summary>
                    <div className="predictor__thinking-body" aria-live="polite">
                        {thinking}
                        {status === 'streaming' && (
                            <span className="predictor__cursor" aria-hidden="true" />
                        )}
                    </div>
                </details>
            )}

            {/* 预测方向卡片列表 */}
            {predictions.length > 0 && (
                <div className="predictor__cards" role="list">
                    {predictions.map((p, i) => (
                        <PredictionCard key={`pred-${i}-${p.direction}`} prediction={p} index={i} />
                    ))}
                </div>
            )}

            {/* 空态：尚未生成 */}
            {status === 'idle' && (
                <div className="predictor__empty">
                    <Icon name="compass" size={28} />
                    <strong>尚未生成预测</strong>
                    <span>
                        点击"生成预测"，AI 将基于
                        {historicalPatterns.length} 条历史模式与
                        {currentVersions.length} 个版本节点，
                        推演未来进化方向。
                    </span>
                </div>
            )}
        </section>
    )
}

export default EvolutionPredictor
