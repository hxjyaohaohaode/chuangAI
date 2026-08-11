/**
 * ReviewPanel 审核面板（SubTask 12.5）
 *
 * 侧边面板，聚焦展示 needsHumanReview 的批改项：
 * - X/Y 进度指示（已审核 / 总待审核）
 * - 待审核项列表（点击切换聚焦）
 * - "全部确认"批量操作按钮
 * - 当前聚焦项的快速审核操作
 *
 * 设计要点：
 * - 吸顶 sticky 定位（桌面端）
 * - 玻璃态背景（surface-glass + backdrop-blur）
 * - 进度条用 accent-success 渐变
 * - 空态（无待审核）显示完成祝贺
 */

import { memo, useMemo } from 'react'
import { Button, Icon, Badge } from '@/components/ui'
import { useGradingStore } from '@/stores/grading'

interface ReviewPanelProps {
    /** 可选：是否吸顶（桌面端 true，移动端 false） */
    sticky?: boolean
}

export const ReviewPanel = memo(function ReviewPanel({ sticky = true }: ReviewPanelProps) {
    const results = useGradingStore((s) => s.results)
    const reviewingFileId = useGradingStore((s) => s.reviewingFileId)
    const setReviewing = useGradingStore((s) => s.setReviewing)
    const confirmAll = useGradingStore((s) => s.confirmAll)
    const batchId = useGradingStore((s) => s.batchId)
    const review = useGradingStore((s) => s.review)
    const reviewPendingByFileId = useGradingStore((s) => s.reviewPendingByFileId)

    /** 待审核项（needsHumanReview 且未审核） */
    const pending = useMemo(
        () => results.filter((r) => r.needsHumanReview && !r.reviewed),
        [results],
    )

    /** 已审核项 */
    const reviewedCount = useMemo(
        () => results.filter((r) => r.reviewed).length,
        [results],
    )

    const totalNeedsReview = useMemo(
        () => results.filter((r) => r.needsHumanReview).length,
        [results],
    )

    const progress = totalNeedsReview > 0 ? reviewedCount / totalNeedsReview : 0
    const progressPercent = Math.round(progress * 100)

    const current = reviewingFileId
        ? results.find((r) => r.fileId === reviewingFileId)
        : pending[0]
    const anyReviewPending = Object.keys(reviewPendingByFileId).length > 0
    const currentReviewPending = current
        ? reviewPendingByFileId[current.fileId] !== undefined
        : false

    if (results.length === 0) {
        return (
            <div className={`pr-grading-review ${sticky ? 'is-sticky' : ''}`}>
                <div className="pr-grading-review-empty">
                    <Icon name="check-circle" size={28} />
                    <p>批改完成后，待审核项将显示在此处</p>
                </div>
            </div>
        )
    }

    if (totalNeedsReview === 0) {
        return (
            <div className={`pr-grading-review ${sticky ? 'is-sticky' : ''}`}>
                <div className="pr-grading-review-done">
                    <div className="pr-grading-review-done-icon">
                        <Icon name="check-circle" size={32} />
                    </div>
                    <h3 className="pr-grading-review-done-title">全部审核完成</h3>
                    <p className="pr-grading-review-done-text">
                        共 {results.length} 条结果已处理
                    </p>
                </div>
            </div>
        )
    }

    return (
        <div className={`pr-grading-review ${sticky ? 'is-sticky' : ''}`}>
            <div className="pr-grading-review-header">
                <div className="pr-grading-review-title">
                    <Icon name="warning" size={18} />
                    <span>待人工审核</span>
                </div>
                <Badge variant="warning">
                    {reviewedCount} / {totalNeedsReview}
                </Badge>
            </div>

            {/* 进度条 */}
            <div className="pr-grading-review-progress">
                <div className="pr-grading-review-progress-track">
                    <div
                        className="pr-grading-review-progress-fill"
                        style={{ transform: `scaleX(${progressPercent / 100})` }}
                    />
                </div>
                <span className="pr-grading-review-progress-text">{progressPercent}%</span>
            </div>

            {/* 全部确认按钮 */}
            {pending.length > 1 && (
                <Button
                    variant="success"
                    size="sm"
                    block
                    leftIcon={<Icon name="check-square" size={14} />}
                    onClick={() => void confirmAll()}
                    loading={anyReviewPending}
                    loadingLabel="审核保存中"
                >
                    全部确认（{pending.length}）
                </Button>
            )}

            {/* 待审核列表 */}
            <div className="pr-grading-review-list">
                {pending.slice(0, 10).map((r) => {
                    const isActive = current?.fileId === r.fileId
                    return (
                        <button
                            key={r.fileId}
                            type="button"
                            className={`pr-grading-review-item ${isActive ? 'is-active' : ''}`}
                            onClick={() => setReviewing(r.fileId)}
                        >
                            <div className="pr-grading-review-item-header">
                                <span className="pr-grading-review-item-student">
                                    {r.studentId ? '学生' : '匿名'}
                                </span>
                                <span className="pr-grading-review-item-confidence">
                                    {Math.round(r.confidence * 100)}%
                                </span>
                            </div>
                            <p className="pr-grading-review-item-attribution">
                                {r.cognitiveAttribution}
                            </p>
                        </button>
                    )
                })}
                {pending.length > 10 && (
                    <div className="pr-grading-review-list-more">
                        还有 {pending.length - 10} 项...
                    </div>
                )}
            </div>

            {/* 当前聚焦项快速审核 */}
            {current && batchId && (
                <div className="pr-grading-review-current">
                    <div className="pr-grading-review-current-title">当前项</div>
                    <div className="pr-grading-review-current-actions">
                        <Button
                            variant="success"
                            size="sm"
                            block
                            leftIcon={<Icon name="check" size={14} />}
                            onClick={() =>
                                void review({
                                    fileId: current.fileId,
                                    batchId,
                                    action: 'confirm',
                                })
                            }
                            loading={currentReviewPending}
                            loadingLabel="保存中"
                        >
                            确认 AI 判定
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            block
                            leftIcon={<Icon name="bookmark" size={14} />}
                            onClick={() =>
                                void review({
                                    fileId: current.fileId,
                                    batchId,
                                    action: 'reference',
                                })
                            }
                            disabled={currentReviewPending}
                        >
                            标记为参考
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
})
