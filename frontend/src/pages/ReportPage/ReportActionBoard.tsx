import { memo, useEffect, useMemo, useState } from 'react'
import { Icon } from '@/components/ui'
import { useReportStore } from '@/stores/report'
import './ReportActionBoard.css'

export const ReportActionBoard = memo(function ReportActionBoard() {
    const report = useReportStore((state) => state.currentReport)
    const [completed, setCompleted] = useState<Set<number>>(() => new Set())

    useEffect(() => {
        setCompleted(new Set())
    }, [report?.id])

    const actions = report?.output?.recommendations ?? []
    const findings = report?.output?.keyFindings ?? []
    const metrics = useMemo(() => {
        if (!report) return []
        return [
            {
                label: '验收可信度',
                value: report.verification ? `${report.verification.score} 分` : '待验收',
                icon: 'check-circle' as const,
            },
            {
                label: '诊断暗点',
                value: report.darkMatterReport ? `${report.darkMatterReport.totalDarkMatter} 项` : '未检出',
                icon: 'brain' as const,
            },
            {
                label: '样本覆盖',
                value: report.exportedData
                    ? `${report.exportedData.anonymizedStudents.length} 人`
                    : '待汇集',
                icon: 'users' as const,
            },
        ]
    }, [report])

    const toggleAction = (index: number) => {
        setCompleted((current) => {
            const next = new Set(current)
            if (next.has(index)) next.delete(index)
            else next.add(index)
            return next
        })
    }

    return (
        <section className="pr-rpt-action-board" aria-labelledby="report-action-board-title">
            <header className="pr-rpt-action-board__header">
                <div>
                    <span className="pr-rpt-action-board__eyebrow">
                        REPORT TO ACTION
                    </span>
                    <h3 id="report-action-board-title">教学改进行动台</h3>
                    <p>把报告建议转成可核验的课堂动作，完成状态仅保存在当前工作区。</p>
                </div>
                <div className="pr-rpt-action-board__progress" aria-label="行动完成进度">
                    <strong>{completed.size}/{actions.length}</strong>
                    <span>已完成</span>
                </div>
            </header>

            {!report?.output ? (
                <div className="pr-rpt-action-board__empty">
                    <Icon name="lightbulb" size={20} />
                    <div>
                        <strong>生成报告后自动形成行动清单</strong>
                        <p>系统会对齐关键发现、教学建议、验收结果与脱敏样本，不再引入无关的家校数据。</p>
                    </div>
                </div>
            ) : (
                <>
                    <div className="pr-rpt-action-board__metrics">
                        {metrics.map((metric) => (
                            <div key={metric.label}>
                                <Icon name={metric.icon} size={14} />
                                <span>{metric.label}</span>
                                <strong>{metric.value}</strong>
                            </div>
                        ))}
                    </div>

                    <div className="pr-rpt-action-board__grid">
                        {actions.length > 0 ? actions.map((action, index) => {
                            const isCompleted = completed.has(index)
                            const evidence = findings[index % Math.max(findings.length, 1)]
                            return (
                                <button
                                    key={`${index}:${action}`}
                                    type="button"
                                    className={isCompleted ? 'is-completed' : undefined}
                                    onClick={() => toggleAction(index)}
                                    aria-pressed={isCompleted}
                                >
                                    <span className="pr-rpt-action-board__index">
                                        {String(index + 1).padStart(2, '0')}
                                    </span>
                                    <span className="pr-rpt-action-board__content">
                                        <strong>{action}</strong>
                                        {evidence && <small>证据依据 · {evidence}</small>}
                                    </span>
                                    <Icon name={isCompleted ? 'check-circle' : 'circle'} size={20} />
                                </button>
                            )
                        }) : (
                            <div className="pr-rpt-action-board__no-actions">
                                <Icon name="info" size={18} />
                                当前报告尚未给出教学建议，可在重新生成时勾选“教学干预”章节。
                            </div>
                        )}
                    </div>
                </>
            )}
        </section>
    )
})

