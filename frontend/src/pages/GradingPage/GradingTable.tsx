/**
 * GradingTable 批改结果表格（SubTask 12.1）
 *
 * 列：
 * - 学生（studentId 或 "匿名"）
 * - 客观题/主观题（题目类型推断，简化为统一显示）
 * - 认知归因（截断显示，悬浮 tooltip）
 * - 置信度（色环 + 百分比）
 * - 操作（展开详情 / 审核）
 *
 * 设计要点（规范第 14.6 章 —— 无边框表格）：
 * - 表头底部仅 1px alpha 6% 分割线
 * - 奇偶行透明度差异（偶数行 25% alpha）
 * - 行 hover 切换至 surface-tertiary
 * - needsHumanReview 行左侧 3px accent-warning 竖线（无 hard border）
 * - 行点击展开详情（GradingDetail 组件）
 * - 数字列右对齐 + tabular-nums
 */

import { memo, useCallback } from 'react'
import { Icon, Badge } from '@/components/ui'
import { AnimatedList } from '@/components/ui/AnimatedList'
import { useGradingStore } from '@/stores/grading'
import { GradingDetail } from './GradingDetail'
import type { GradingResult } from '@/lib/types'

interface GradingTableProps {
    /** 可选外部传入 results（覆盖 store） */
    results?: GradingResult[]
    /** 空状态 CTA：跳转到上传区（由父组件传入滚动/切阶段回调） */
    onUploadClick?: () => void
}

/** 置信度等级 */
function confidenceTone(c: number): 'success' | 'warning' | 'error' {
    if (c >= 0.8) return 'success'
    if (c >= 0.6) return 'warning'
    return 'error'
}

/** 截断长文本 */
function truncate(text: string, max = 24): string {
    if (text.length <= max) return text
    return text.slice(0, max) + '...'
}

export const GradingTable = memo(function GradingTable({ results: overrideResults, onUploadClick }: GradingTableProps) {
    const storeResults = useGradingStore((s) => s.results)
    const expandedFileId = useGradingStore((s) => s.expandedFileId)
    const setExpanded = useGradingStore((s) => s.setExpanded)
    const setReviewing = useGradingStore((s) => s.setReviewing)

    const results = overrideResults ?? storeResults

    const handleRowClick = useCallback(
        (fileId: string) => {
            setExpanded(fileId)
        },
        [setExpanded],
    )

    const handleReviewClick = useCallback(
        (e: React.MouseEvent, fileId: string) => {
            e.stopPropagation()
            setReviewing(fileId)
        },
        [setReviewing],
    )

    if (results.length === 0) {
        return (
            <div className="pr-grading-table pr-grading-table--empty">
                <div className="pr-grading-table-empty-icon">
                    <Icon name="file-image" size={32} />
                </div>
                <p className="pr-grading-table-empty-text">暂无批改记录</p>
                <p className="pr-grading-table-empty-hint">
                    上传答题图片后，批改结果将显示在此处。支持批量上传，AI 将自动识别并批改。
                </p>
                {onUploadClick && (
                    <button type="button" className="pr-grading-table-empty-cta" onClick={onUploadClick}>
                        去上传答题图片
                    </button>
                )}
            </div>
        )
    }

    return (
        <div className="pr-grading-table" role="table" aria-label="批改结果">
            <div role="rowgroup">
                <div className="pr-grading-table-header" role="row">
                    <div className="pr-grading-table-cell pr-grading-table-cell--student" role="columnheader">
                        学生
                    </div>
                    <div className="pr-grading-table-cell pr-grading-table-cell--type" role="columnheader">
                        题型
                    </div>
                    <div className="pr-grading-table-cell pr-grading-table-cell--attribution" role="columnheader">
                        认知归因
                    </div>
                    <div className="pr-grading-table-cell pr-grading-table-cell--confidence" role="columnheader">
                        置信度
                    </div>
                    <div className="pr-grading-table-cell pr-grading-table-cell--actions" role="columnheader">
                        操作
                    </div>
                </div>
            </div>

            {/* 批改结果列表 —— 使用 AnimatedList 实现交错入场动画（50ms staggered） */}
            <AnimatedList
                className="pr-grading-table-body pr-grading-table-list"
                items={results}
                getKey={(r) => r.fileId}
                itemClassName="pr-grading-table-list-item"
                containerRole="rowgroup"
                itemRole="presentation"
                renderItem={(r, idx) => {
                    const isExpanded = expandedFileId === r.fileId
                    const needsReview = r.needsHumanReview && !r.reviewed
                    const rowTone = needsReview ? 'needs-review' : r.reviewed ? 'reviewed' : 'default'

                    return (
                        <>
                            <div
                                className={`pr-grading-table-row pr-grading-table-row--${rowTone} ${isExpanded ? 'is-expanded' : ''} ${idx % 2 === 1 ? 'is-even' : ''}`}
                                onClick={() => handleRowClick(r.fileId)}
                                role="row"
                                tabIndex={0}
                                aria-expanded={isExpanded}
                                aria-controls={isExpanded ? `grading-detail-${r.fileId}` : undefined}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault()
                                        handleRowClick(r.fileId)
                                    }
                                }}
                            >
                                <div className="pr-grading-table-cell pr-grading-table-cell--student" role="cell">
                                    <span className="pr-grading-table-student">
                                        {r.studentId ? '学生' : '匿名'}
                                    </span>
                                </div>

                                <div className="pr-grading-table-cell pr-grading-table-cell--type" role="cell">
                                    {r.correct ? (
                                        <Badge variant="success" icon={<Icon name="check" size={10} />}>
                                            正确
                                        </Badge>
                                    ) : r.partialScore !== undefined && r.partialScore > 0 ? (
                                        <Badge variant="warning">部分 {r.partialScore}</Badge>
                                    ) : (
                                        <Badge variant="error" icon={<Icon name="x" size={10} />}>
                                            错误
                                        </Badge>
                                    )}
                                </div>

                                <div className="pr-grading-table-cell pr-grading-table-cell--attribution" role="cell">
                                    <span title={r.teacherAttribution || r.cognitiveAttribution}>
                                        {truncate(r.teacherAttribution || r.cognitiveAttribution)}
                                    </span>
                                </div>

                                <div
                                    className={`pr-grading-table-cell pr-grading-table-cell--confidence pr-grading-table-confidence--${confidenceTone(r.confidence)}`}
                                    role="cell"
                                >
                                    <span className="pr-grading-table-confidence-dot" />
                                    <span>{Math.round(r.confidence * 100)}%</span>
                                </div>

                                <div className="pr-grading-table-cell pr-grading-table-cell--actions" role="cell">
                                    <button
                                        type="button"
                                        className="pr-grading-table-action"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            handleRowClick(r.fileId)
                                        }}
                                        aria-label={isExpanded ? '收起详情' : '展开详情'}
                                    >
                                        <Icon name={isExpanded ? 'caret-up' : 'caret-down'} size={16} />
                                    </button>
                                    <button
                                        type="button"
                                        className="pr-grading-table-action"
                                        onClick={(e) => handleReviewClick(e, r.fileId)}
                                        aria-label="审核"
                                    >
                                        <Icon name="edit" size={16} />
                                    </button>
                                </div>
                            </div>

                            {isExpanded && (
                                <div id={`grading-detail-${r.fileId}`} className="pr-grading-table-detail" role="row">
                                    <div className="pr-grading-table-detail-cell" role="cell" aria-colspan={5}>
                                        <GradingDetail fileId={r.fileId} />
                                    </div>
                                </div>
                            )}
                        </>
                    )
                }}
            />
        </div>
    )
})
