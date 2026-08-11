import { memo, useEffect, useState } from 'react'
import { Icon } from '@/components/ui'
import { api } from '@/lib/api'
import type { CopilotSessionStatus, OrchestratorTraceResponse } from '@/lib/types'

const PHASE_LABELS: Record<string, string> = {
    created: '计划生成',
    approved: '教师批准',
    start: '开始',
    success: '完成',
    retry: '安全重试',
    error: '失败',
    fallback: '降级',
    paused: '暂停',
    resumed: '恢复',
    aborted: '中止',
    modified: '教师修正',
    verified: '独立验收',
}

function formatDuration(ms: number): string {
    if (ms < 1_000) return `${Math.round(ms)}ms`
    return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function eventTitle(event: OrchestratorTraceResponse['trace']['events'][number]): string {
    const subject = event.agentId ?? event.model ?? event.taskId ?? event.layer
    return `${PHASE_LABELS[event.phase] ?? event.phase} · ${subject}`
}

export const ExecutionEvidencePanel = memo(function ExecutionEvidencePanel({
    sessionId,
    teacherId,
    sessionStatus,
}: {
    sessionId: string
    teacherId: string
    sessionStatus: CopilotSessionStatus
}) {
    const [trace, setTrace] = useState<OrchestratorTraceResponse['trace'] | null>(null)
    const [unavailable, setUnavailable] = useState(false)
    const active = sessionStatus === 'executing' || sessionStatus === 'paused'

    useEffect(() => {
        let cancelled = false
        let timer: number | undefined
        let loading = false

        const schedule = (delay: number) => {
            if (cancelled || !active || document.visibilityState === 'hidden') return
            if (timer !== undefined) window.clearTimeout(timer)
            timer = window.setTimeout(() => void load(), delay)
        }

        const load = async () => {
            if (cancelled || loading || document.visibilityState === 'hidden') return
            loading = true
            try {
                const response = await api.orchestrator.getTrace(sessionId, teacherId)
                if (!cancelled) {
                    setTrace(response.trace)
                    setUnavailable(false)
                }
            } catch {
                if (!cancelled) setUnavailable(true)
            } finally {
                loading = false
                schedule(2_000)
            }
        }

        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                if (timer !== undefined) window.clearTimeout(timer)
                timer = undefined
                return
            }
            if (!loading) schedule(0)
        }

        document.addEventListener('visibilitychange', onVisibilityChange)
        if (document.visibilityState !== 'hidden') void load()
        return () => {
            cancelled = true
            if (timer !== undefined) window.clearTimeout(timer)
            document.removeEventListener('visibilitychange', onVisibilityChange)
        }
    }, [active, sessionId, teacherId])

    if (!trace && !unavailable) {
        return (
            <div className="pr-copilot-evidence is-loading" role="status">
                <Icon name="spinner" size={14} />正在读取脱敏运行证据…
            </div>
        )
    }

    if (!trace) {
        return (
            <div className="pr-copilot-evidence is-unavailable" role="status">
                <Icon name="warning" size={14} />
                运行证据暂不可读取；任务状态仍以计划面板为准，可稍后重试。
            </div>
        )
    }

    const { summary, events, privacy } = trace
    const timeline = events.slice(-8).reverse()

    return (
        <details className="pr-copilot-evidence" open={sessionStatus === 'completed'}>
            <summary>
                <span>
                    <Icon name="shield-check" size={14} />
                    <strong>可验真运行证据</strong>
                </span>
                <small>{summary.eventCount} 条 · {summary.models.length || 0} 个模型</small>
            </summary>

            <div className="pr-copilot-evidence-body">
                <div className="pr-copilot-evidence-stats" aria-label="运行证据摘要">
                    <span><strong>{summary.agentCalls}</strong>Agent 调用</span>
                    <span><strong>{summary.llmCalls}</strong>模型调用</span>
                    <span><strong>{summary.totalTokens.toLocaleString('zh-CN')}</strong>Token</span>
                    <span><strong>¥{summary.costYuan.toFixed(4)}</strong>估算费用</span>
                    <span><strong>{summary.fallbacks}</strong>降级</span>
                    <span><strong>{summary.errors}</strong>最终错误</span>
                </div>

                {summary.promptVersions.length > 0 && (
                    <p className="pr-copilot-evidence-versions">
                        Prompt 版本：{summary.promptVersions.join('、')}
                    </p>
                )}

                {timeline.length > 0 ? (
                    <ol className="pr-copilot-evidence-timeline">
                        {timeline.map((event) => (
                            <li key={event.id} className={`is-${event.phase}`}>
                                <span>{eventTitle(event)}</span>
                                <small>
                                    {new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
                                    {event.latencyMs !== undefined ? ` · ${formatDuration(event.latencyMs)}` : ''}
                                </small>
                            </li>
                        ))}
                    </ol>
                ) : (
                    <p className="pr-copilot-evidence-empty">计划已建立，执行事件尚未产生。</p>
                )}

                <p className="pr-copilot-evidence-privacy">
                    <Icon name="info" size={13} />{privacy.policy}；不保存完整提示词、学生姓名或模型原始输出。
                </p>
            </div>
        </details>
    )
})
