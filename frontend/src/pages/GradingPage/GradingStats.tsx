/**
 * GradingStats 批改统计仪表（SubTask 12.6）
 *
 * 顶部统计卡片，展示：
 * - 总批改数
 * - 正确率
 * - 待审核数
 * - 平均置信度
 * - Top 3 认知归因
 *
 * 设计要点（规范第 10 章 —— 数据可视化）：
 * - 无 chartjunk：无网格线、无背景色、无 3D
 * - 字体统一 Inter，数字使用 tabular-nums
 * - 卡片无边框，使用透明度差异 + 噪点纹理
 * - 流体网格：clamp() 自适应列数
 */

import { memo, useMemo } from 'react'
import { Icon } from '@/components/ui'
import { useGradingStore, computeAttributionStats } from '@/stores/grading'
import type { GradingSummary, GradingResult } from '@/lib/types'

interface GradingStatsProps {
    /** 可选的外部传入 summary（覆盖 store） */
    summary?: GradingSummary
    /** 可选的外部传入 results（用于归因统计） */
    results?: GradingResult[]
}

/** 单个统计卡片 */
const StatCard = memo(function StatCard({
    label,
    value,
    suffix,
    icon,
    tone = 'default',
    hint,
}: {
    label: string
    value: string | number
    suffix?: string
    icon: string
    tone?: 'default' | 'success' | 'warning' | 'error'
    hint?: string
}) {
    const toneClass = `pr-grading-stat--${tone}`
    return (
        <div className={`pr-grading-stat-card ${toneClass}`}>
            <div className="pr-grading-stat-icon">
                <Icon name={icon} size={18} />
            </div>
            <div className="pr-grading-stat-body">
                <div className="pr-grading-stat-label">{label}</div>
                <div className="pr-grading-stat-value">
                    {value}
                    {suffix && <span className="pr-grading-stat-suffix">{suffix}</span>}
                </div>
                {hint && <div className="pr-grading-stat-hint">{hint}</div>}
            </div>
        </div>
    )
})

/** 计算正确率百分比 */
function accuracyRate(s: GradingSummary): number {
    if (s.total === 0) return 0
    return Math.round(((s.correct + s.partial * 0.5) / s.total) * 1000) / 10
}

export const GradingStats = memo(function GradingStats({
    summary: overrideSummary,
    results: overrideResults,
}: GradingStatsProps) {
    const storeSummary = useGradingStore((s) => s.summary)
    const storeResults = useGradingStore((s) => s.results)

    const summary = overrideSummary ?? storeSummary
    const results = overrideResults ?? storeResults

    const attributions = useMemo(() => computeAttributionStats(results, 3), [results])

    if (summary.total === 0) {
        return (
            <div className="pr-grading-stats pr-grading-stats--empty">
                <div className="pr-grading-stats-empty-icon">
                    <Icon name="chart-bar" size={32} />
                </div>
                <p className="pr-grading-stats-empty-text">
                    上传答题图片后，此处将展示批改统计
                </p>
            </div>
        )
    }

    return (
        <div className="pr-grading-stats">
            <div className="pr-grading-stats-grid">
                <StatCard
                    label="总批改数"
                    value={summary.total}
                    icon="file-image"
                    tone="default"
                    hint={`共 ${summary.total} 份答题`}
                />
                <StatCard
                    label="正确率"
                    value={accuracyRate(summary).toFixed(1)}
                    suffix="%"
                    icon="check-circle"
                    tone="success"
                    hint={`正确 ${summary.correct} · 部分 ${summary.partial} · 错误 ${summary.wrong}`}
                />
                <StatCard
                    label="待审核"
                    value={summary.needsReview}
                    icon="warning-circle"
                    tone={summary.needsReview > 0 ? 'warning' : 'default'}
                    hint={summary.needsReview > 0 ? '置信度低于阈值，需人工确认' : '全部高置信度'}
                />
                <StatCard
                    label="平均置信度"
                    value={Math.round(summary.avgConfidence * 100)}
                    suffix="%"
                    icon="sparkle"
                    tone={summary.avgConfidence >= 0.8 ? 'success' : 'warning'}
                    hint={summary.avgConfidence >= 0.8 ? 'AI 批改可信度高' : 'AI 批改可信度偏低'}
                />
            </div>

            {attributions.length > 0 && (
                <div className="pr-grading-attribution">
                    <div className="pr-grading-attribution-header">
                        <Icon name="lightbulb" size={16} />
                        <span>Top 3 认知归因</span>
                    </div>
                    <div className="pr-grading-attribution-list">
                        {attributions.map((a, i) => (
                            <div key={`${a.label}-${i}`} className="pr-grading-attribution-item">
                                <span className="pr-grading-attribution-rank">#{i + 1}</span>
                                <span className="pr-grading-attribution-label">{a.label}</span>
                                <span className="pr-grading-attribution-count">{a.count} 次</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
})
