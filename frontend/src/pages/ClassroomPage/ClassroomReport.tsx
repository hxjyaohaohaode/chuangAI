/**
 * 课堂协奏报告 Modal（SubTask 11.5）
 *
 * 职责：
 * 1. 展示课堂总结（AI 生成的整体评价）
 * 2. 关键指标卡片：参与度 / 掌握度前 / 掌握度后 / 提升幅度
 * 3. 掌握度对比条：before vs after 可视化
 * 4. 课堂亮点列表（accent-success 图标）
 * 5. 改进建议列表（accent-warning 图标）
 *
 * 数据来源：
 * - report：从 useClassroomStore 获取（end 后填充）
 * - 包含 summary / participation / masteryChange / highlights / improvements
 *
 * 设计要点（规范第 9、14 章）：
 * - Modal 使用 surface-glass-heavy + backdrop-blur 24px
 * - 指标卡片网格自适应（auto-fit minmax 140px）
 * - 掌握度对比使用双条堆叠（info-before + success-after）
 * - 列表项使用图标前缀，无 emoji
 */

import { memo } from 'react'
import { Modal, Button, Icon, AIBadge } from '@/components/ui'
import { useNavigate } from 'react-router-dom'
import { toast } from '@/stores/toast'
import type { ClassroomReport } from '@/lib/types'

export interface ClassroomReportModalProps {
    /** 是否打开 */
    open: boolean
    /** 关闭回调 */
    onClose: () => void
    /** 报告数据 */
    report: ClassroomReport | null
}

export const ClassroomReportModal = memo(function ClassroomReportModal({ open, onClose, report }: ClassroomReportModalProps) {
    const data = report?.report
    const navigate = useNavigate()

    const masteryDelta = data ? data.masteryChange.after - data.masteryChange.before : 0
    const isImprovement = masteryDelta >= 0

    /** v5.0 Task 4.7：基于本课命题 —— 跳转命题工坊，透传 lessonId 作为学情参考 */
    const handleStartWorkbench = () => {
        if (!report?.lessonId) {
            toast.warning({ title: '课堂 ID 缺失', message: '无法跳转命题工坊' })
            return
        }
        const params = new URLSearchParams({
            lessonId: report.lessonId,
            source: 'classroom-report',
        })
        navigate(`/workbench?${params.toString()}`)
        onClose()
    }

    /** 导出课堂报告为 JSON 文件 */
    const handleExport = () => {
        if (!report || !data) return
        const reportData = {
            lessonId: report.lessonId,
            summary: data.summary,
            participation: data.participation,
            masteryChange: data.masteryChange,
            highlights: data.highlights,
            improvements: data.improvements,
            aiGenerated: data.aiGenerated,
            exportedAt: new Date().toISOString(),
        }
        const blob = new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `课堂报告_${report.lessonId}_${Date.now()}.json`
        a.click()
        URL.revokeObjectURL(url)
        toast.success({ title: '报告已导出', message: '课堂报告已下载至本地' })
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            title="课堂协奏报告"
            size="lg"
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>关闭</Button>
                    <Button
                        variant="secondary"
                        leftIcon={<Icon name="feather" size={16} />}
                        onClick={handleStartWorkbench}
                    >
                        基于本课命题
                    </Button>
                    <Button
                        variant="primary"
                        leftIcon={<Icon name="download" size={16} />}
                        onClick={handleExport}
                    >
                        导出报告
                    </Button>
                </>
            }
        >
            {!data ? (
                <div
                    style={{
                        padding: 'var(--space-2xl)',
                        textAlign: 'center',
                        color: 'rgb(var(--c-text-tertiary))',
                    }}
                >
                    报告生成中...
                </div>
            ) : (
                <div className="pr-report">
                    {/* 总结 */}
                    <div className="pr-report-section">
                        <div className="pr-report-section-title">
                            <Icon name="quotes" size={14} />
                            课堂总结
                            <AIBadge size="xs" />
                        </div>
                        <div className="pr-report-summary">{data.summary}</div>
                    </div>

                    {/* 关键指标 */}
                    <div className="pr-report-section">
                        <div className="pr-report-section-title">
                            <Icon name="chart-bar" size={14} />
                            关键指标
                        </div>
                        <div className="pr-report-metrics">
                            <div className="pr-report-metric">
                                <span className="pr-report-metric-label">参与度</span>
                                <span className="pr-report-metric-value">
                                    {data.participation}
                                    <span className="pr-report-metric-value-suffix">%</span>
                                </span>
                            </div>
                            <div className="pr-report-metric">
                                <span className="pr-report-metric-label">课前掌握度</span>
                                <span className="pr-report-metric-value">
                                    {data.masteryChange.before}
                                    <span className="pr-report-metric-value-suffix">/100</span>
                                </span>
                            </div>
                            <div className="pr-report-metric">
                                <span className="pr-report-metric-label">课后掌握度</span>
                                <span className="pr-report-metric-value">
                                    {data.masteryChange.after}
                                    <span className="pr-report-metric-value-suffix">/100</span>
                                </span>
                            </div>
                            <div className="pr-report-metric">
                                <span className="pr-report-metric-label">提升幅度</span>
                                <span
                                    className="pr-report-metric-value"
                                    style={{
                                        color: isImprovement
                                            ? 'rgb(var(--c-accent-success))'
                                            : 'rgb(var(--c-accent-error))',
                                    }}
                                >
                                    {isImprovement ? '+' : ''}{masteryDelta}
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* 掌握度对比 */}
                    <div className="pr-report-section">
                        <div className="pr-report-section-title">
                            <Icon name="arrows-clockwise" size={14} />
                            掌握度前后对比
                        </div>
                        <div className="pr-report-mastery">
                            <div className="pr-report-mastery-row">
                                <span className="pr-report-mastery-label">课前</span>
                                <div className="pr-report-mastery-bar">
                                    <div
                                        className="pr-report-mastery-before"
                                        style={{ width: `${data.masteryChange.before}%` }}
                                    />
                                </div>
                                <span className="pr-report-mastery-value">
                                    {data.masteryChange.before}
                                </span>
                            </div>
                            <div className="pr-report-mastery-row">
                                <span className="pr-report-mastery-label">课后</span>
                                <div className="pr-report-mastery-bar">
                                    <div
                                        className="pr-report-mastery-after"
                                        style={{ width: `${data.masteryChange.after}%` }}
                                    />
                                </div>
                                <span className="pr-report-mastery-value">
                                    {data.masteryChange.after}
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* 亮点 */}
                    {data.highlights.length > 0 && (
                        <div className="pr-report-section">
                            <div className="pr-report-section-title">
                                <Icon name="star" size={14} />
                                课堂亮点
                            </div>
                            <ul className="pr-report-list">
                                {data.highlights.map((item, idx) => (
                                    <li key={idx} className="pr-report-list-item">
                                        <span className="pr-report-list-item-icon pr-report-list-item-icon--highlight">
                                            <Icon name="check-circle" size={14} />
                                        </span>
                                        <span>{item}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* 改进建议 */}
                    {data.improvements.length > 0 && (
                        <div className="pr-report-section">
                            <div className="pr-report-section-title">
                                <Icon name="lightbulb" size={14} />
                                改进建议
                            </div>
                            <ul className="pr-report-list">
                                {data.improvements.map((item, idx) => (
                                    <li key={idx} className="pr-report-list-item">
                                        <span className="pr-report-list-item-icon pr-report-list-item-icon--improvement">
                                            <Icon name="warning-circle" size={14} />
                                        </span>
                                        <span>{item}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </Modal>
    )
})
