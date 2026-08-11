/**
 * AI 任务计划的人机协作面板。
 *
 * 把“AI 给一段文字”升级为可预览、可修改、可批准、可暂停/恢复、可中止的
 * 业务动作。教师始终拥有最终执行权，AI 草案不会自动调用工具。
 */
import { memo, useMemo, useState } from 'react'
import { Icon } from '@/components/ui'
import { AGENT_LABELS, INTENT_LABELS, type SubTask } from '@/lib/types'
import { useCopilotStore } from '@/stores/copilot'
import { toast } from '@/stores/toast'
import { cn } from '@/lib/cn'
import { ExecutionEvidencePanel } from './ExecutionEvidencePanel'

const STATUS_LABELS: Record<SubTask['status'], string> = {
    pending: '待执行',
    running: '执行中',
    paused: '已暂停',
    success: '已完成',
    failed: '失败',
    skipped: '已跳过',
}

function inputSummary(input: unknown): string {
    try {
        const text = JSON.stringify(input)
        return text.length > 140 ? `${text.slice(0, 137)}…` : text
    } catch {
        return '输入包含无法预览的运行时对象'
    }
}

function TaskRow({ task, canEdit }: { task: SubTask; canEdit: boolean }) {
    const pauseTask = useCopilotStore((state) => state.pauseTask)
    const resumeTask = useCopilotStore((state) => state.resumeTask)
    const updatePlannedTaskInput = useCopilotStore((state) => state.updatePlannedTaskInput)
    const intervening = useCopilotStore((state) => state.intervening)
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(() => JSON.stringify(task.input, null, 2))

    const saveDraft = () => {
        try {
            updatePlannedTaskInput(task.id, JSON.parse(draft) as unknown)
            setEditing(false)
        } catch {
            toast.error({ title: '任务输入格式错误', message: '请输入合法 JSON 后再保存' })
        }
    }

    return (
        <li className={cn('pr-copilot-plan-task', `is-${task.status}`)}>
            <div className="pr-copilot-plan-task-main">
                <span className="pr-copilot-plan-task-status" aria-label={STATUS_LABELS[task.status]}>
                    <Icon
                        name={
                            task.status === 'success' ? 'check-circle'
                                : task.status === 'running' ? 'spinner'
                                    : task.status === 'failed' ? 'warning'
                                        : task.status === 'paused' ? 'pause'
                                            : 'circle-notch'
                        }
                        size={15}
                    />
                </span>
                <div className="pr-copilot-plan-task-copy">
                    <strong>{AGENT_LABELS[task.agentId] ?? task.agentId}</strong>
                    <span>{inputSummary(task.input)}</span>
                    {task.dependencies.length > 0 && (
                        <small>依赖 {task.dependencies.join('、')}</small>
                    )}
                    {task.error && <small className="is-error">{task.error}</small>}
                </div>
                <span className="pr-copilot-plan-task-badge">{STATUS_LABELS[task.status]}</span>
            </div>

            <div className="pr-copilot-plan-task-actions">
                {canEdit && (
                    <button type="button" onClick={() => setEditing((value) => !value)}>
                        <Icon name="pencil" size={13} />
                        {editing ? '取消修改' : '修改输入'}
                    </button>
                )}
                {task.status === 'running' && (
                    <button type="button" disabled={intervening} onClick={() => void pauseTask(task.id)}>
                        <Icon name="pause" size={13} />暂停
                    </button>
                )}
                {task.status === 'paused' && (
                    <button type="button" disabled={intervening} onClick={() => void resumeTask(task.id)}>
                        <Icon name="play" size={13} />恢复
                    </button>
                )}
            </div>

            {editing && (
                <div className="pr-copilot-plan-editor">
                    <label htmlFor={`plan-input-${task.id}`}>任务输入 JSON</label>
                    <textarea
                        id={`plan-input-${task.id}`}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        rows={5}
                        spellCheck={false}
                    />
                    <button type="button" className="is-primary" onClick={saveDraft}>保存修改</button>
                </div>
            )}
        </li>
    )
}

export const PlanApprovalPanel = memo(function PlanApprovalPanel() {
    const currentPlan = useCopilotStore((state) => state.currentPlan)
    const taskStates = useCopilotStore((state) => state.taskStates)
    const sessionStatus = useCopilotStore((state) => state.sessionStatus)
    const executing = useCopilotStore((state) => state.executing)
    const intervening = useCopilotStore((state) => state.intervening)
    const executePlan = useCopilotStore((state) => state.executePlan)
    const discardPlan = useCopilotStore((state) => state.discardPlan)
    const abortSession = useCopilotStore((state) => state.abortSession)
    const sessionId = useCopilotStore((state) => state.sessionId)
    const teacherId = useCopilotStore((state) => state.teacherId)

    const counts = useMemo(() => ({
        done: taskStates.filter((task) => task.status === 'success').length,
        failed: taskStates.filter((task) => task.status === 'failed').length,
    }), [taskStates])

    if (!currentPlan && taskStates.length === 0) return null

    const canApprove = sessionStatus === 'planning' && currentPlan !== null
    const isExecuting = sessionStatus === 'executing' || sessionStatus === 'paused'

    return (
        <section className="pr-copilot-plan" aria-label="AI 任务执行计划" aria-live="polite">
            <header className="pr-copilot-plan-header">
                <div>
                    <span className="pr-copilot-plan-kicker">
                        <Icon name="shield-check" size={14} />教师审批节点
                    </span>
                    <h3>{canApprove ? '执行计划待确认' : '多智能体执行进度'}</h3>
                    <p>
                        {canApprove
                            ? '以下内容是 AI 草案；修改或批准前不会执行任何任务。'
                            : `已完成 ${counts.done}/${taskStates.length}，失败 ${counts.failed}。`}
                    </p>
                </div>
                {currentPlan && (
                    <div className="pr-copilot-plan-meta" aria-label="计划摘要">
                        <span>{INTENT_LABELS[currentPlan.intent]}</span>
                        <span>置信度 {Math.round(currentPlan.confidence * 100)}%</span>
                        <span>预计 {Math.max(1, Math.round(currentPlan.estimatedDurationMs / 1000))} 秒</span>
                    </div>
                )}
            </header>

            <ol className="pr-copilot-plan-tasks">
                {taskStates.map((task) => (
                    <TaskRow key={task.id} task={task} canEdit={canApprove} />
                ))}
            </ol>

            {sessionId && (
                <ExecutionEvidencePanel
                    sessionId={sessionId}
                    teacherId={teacherId}
                    sessionStatus={sessionStatus}
                />
            )}

            <footer className="pr-copilot-plan-footer">
                {canApprove && (
                    <>
                        <button type="button" className="is-secondary" onClick={discardPlan}>
                            <Icon name="x" size={14} />退回修改
                        </button>
                        <button
                            type="button"
                            className="is-primary"
                            disabled={executing}
                            onClick={() => void executePlan()}
                        >
                            <Icon name={executing ? 'spinner' : 'play'} size={14} />
                            {executing ? '正在启动' : '教师批准并执行'}
                        </button>
                    </>
                )}
                {isExecuting && (
                    <button
                        type="button"
                        className="is-danger"
                        disabled={intervening}
                        onClick={() => void abortSession()}
                    >
                        <Icon name="stop" size={14} />中止整个计划
                    </button>
                )}
                {sessionStatus === 'completed' && (
                    <span className="pr-copilot-plan-outcome is-success">
                        <Icon name="check-circle" size={14} />计划执行完成，结果仍需教师复核
                    </span>
                )}
                {sessionStatus === 'aborted' && (
                    <>
                        <span className="pr-copilot-plan-outcome is-warning">
                            <Icon name="warning" size={14} />计划已中止，未完成任务不会冒充成功
                        </span>
                        {currentPlan && (
                            <button
                                type="button"
                                className="is-primary"
                                disabled={executing}
                                onClick={() => void executePlan()}
                            >
                                <Icon name={executing ? 'spinner' : 'arrows-clockwise'} size={14} />
                                {executing ? '正在重启' : '教师确认重新执行'}
                            </button>
                        )}
                    </>
                )}
            </footer>
        </section>
    )
})
