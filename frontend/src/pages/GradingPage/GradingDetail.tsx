/**
 * GradingDetail 批改详情（SubTask 12.4）
 *
 * 表格行展开后显示的详情面板：
 * - 左侧：答题图片 + 识别文本
 * - 右侧：题目答案 + AI 批改结果 + 教师审核操作
 *
 * 审核操作：
 * 1. 确认 —— 采纳 AI 批改结果
 * 2. 修正 —— 教师修改 correct/feedback/cognitiveAttribution
 * 3. 标记为参考 —— 仅作参考不计入统计
 *
 * 设计要点：
 * - 双栏布局，移动端堆叠
 * - 审核动作触发 store.review，乐观更新
 * - 已审核项显示审核状态徽标
 */

import { memo, useCallback, useState } from 'react'
import { Button, Icon, Badge, AIBadge } from '@/components/ui'
import { QuickVoiceAssist } from '@/components/ui/QuickVoiceAssist'
import { useGradingStore } from '@/stores/grading'
import type { ReviewAction } from '@/lib/types'
import { GradingMediaImage } from './GradingMediaImage'

interface GradingDetailProps {
    fileId: string
}

export const GradingDetail = memo(function GradingDetail({ fileId }: GradingDetailProps) {
    const results = useGradingStore((s) => s.results)
    const files = useGradingStore((s) => s.files)
    const recognized = useGradingStore((s) => s.recognized)
    const batchId = useGradingStore((s) => s.batchId)
    const review = useGradingStore((s) => s.review)
    const reviewPending = useGradingStore((s) => s.reviewPendingByFileId[fileId] !== undefined)

    const result = results.find((r) => r.fileId === fileId)
    const file = files.find((f) => f.id === fileId)
    const recognition = recognized.find((r) => r.fileId === fileId)

    // 教师修正表单本地态
    const [modifyMode, setModifyMode] = useState(false)
    const [modifyCorrect, setModifyCorrect] = useState(result?.correct ?? false)
    const [modifyFeedback, setModifyFeedback] = useState(result?.feedback ?? '')
    const [modifyAttribution, setModifyAttribution] = useState(result?.cognitiveAttribution ?? '')

    const handleAction = useCallback(
        async (action: ReviewAction) => {
            if (!batchId) return

            if (action === 'modify') {
                const saved = await review({
                    fileId,
                    batchId,
                    action: 'modify',
                    correct: modifyCorrect,
                    feedback: modifyFeedback,
                    cognitiveAttribution: modifyAttribution,
                })
                // 保存失败时保留教师输入，避免网络错误把尚未提交的修正内容清空。
                if (saved) setModifyMode(false)
            } else {
                await review({
                    fileId,
                    batchId,
                    action,
                })
            }
        },
        [batchId, fileId, review, modifyCorrect, modifyFeedback, modifyAttribution],
    )

    if (!result) {
        return (
            <div className="pr-grading-detail pr-grading-detail--empty">
                <span>无批改结果</span>
            </div>
        )
    }

    return (
        <div className="pr-grading-detail">
            <div className="pr-grading-detail-left">
                {file && (
                    <div className="pr-grading-detail-image">
                        <GradingMediaImage src={file.url} alt={file.fileName ? `答题 ${file.fileName}` : '答题图片'} />
                    </div>
                )}
                {recognition && (
                    <div className="pr-grading-detail-recognition">
                        <div className="pr-grading-detail-section-title">
                            <Icon name="eye" size={14} />
                            <span>识别文本</span>
                        </div>
                        <p className="pr-grading-detail-text">{recognition.studentAnswer}</p>
                    </div>
                )}
            </div>

            <div className="pr-grading-detail-right">
                <div className="pr-grading-detail-section">
                    <div className="pr-grading-detail-section-title">
                        <Icon name="quotes" size={14} />
                        <span>AI 批改结果</span>
                        <AIBadge size="xs" />
                        {result.reviewed && (
                            <Badge
                                variant={result.reviewAction === 'modify' ? 'warning' : 'success'}
                                icon={<Icon name={result.reviewAction === 'modify' ? 'edit' : 'check'} size={10} />}
                            >
                                {result.reviewAction === 'confirm' ? '已确认' : result.reviewAction === 'modify' ? '已修正' : '参考'}
                            </Badge>
                        )}
                    </div>
                    <dl className="pr-grading-detail-meta">
                        <div className="pr-grading-detail-meta-row">
                            <dt>判定</dt>
                            <dd>
                                {result.correct ? (
                                    <Badge variant="success">正确</Badge>
                                ) : result.partialScore !== undefined && result.partialScore > 0 ? (
                                    <Badge variant="warning">部分正确（{result.partialScore}）</Badge>
                                ) : (
                                    <Badge variant="error">错误</Badge>
                                )}
                            </dd>
                        </div>
                        <div className="pr-grading-detail-meta-row">
                            <dt>认知归因</dt>
                            <dd>{result.teacherAttribution || result.cognitiveAttribution}</dd>
                        </div>
                        <div className="pr-grading-detail-meta-row">
                            <dt>反馈</dt>
                            <dd>{result.teacherFeedback || result.feedback}</dd>
                        </div>
                        {result.teacherHint && (
                            <div className="pr-grading-detail-meta-row">
                                <dt>教学提示</dt>
                                <dd>{result.teacherHint}</dd>
                            </div>
                        )}
                        <div className="pr-grading-detail-meta-row">
                            <dt>置信度</dt>
                            <dd>{Math.round(result.confidence * 100)}%</dd>
                        </div>
                    </dl>
                </div>

                {/* 教师修正表单 */}
                {modifyMode && (
                    <div className="pr-grading-detail-modify">
                        <div className="pr-grading-detail-section-title">
                            <Icon name="pencil-line" size={14} />
                            <span>教师修正</span>
                        </div>
                        <div className="pr-grading-detail-modify-field">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={modifyCorrect}
                                    onChange={(e) => setModifyCorrect(e.target.checked)}
                                />
                                <span>判定为正确</span>
                            </label>
                        </div>
                        <div className="pr-grading-detail-modify-field">
                            <label>反馈</label>
                            <textarea
                                value={modifyFeedback}
                                onChange={(e) => setModifyFeedback(e.target.value)}
                                rows={3}
                                placeholder="教师反馈..."
                                aria-label="教师反馈"
                            />
                            <QuickVoiceAssist
                                suggestions={[
                                    '答案正确，表达清楚',
                                    '思路基本正确，请补充理由',
                                    '请注意诗句中的关键词',
                                    '再读题并检查一次',
                                ]}
                                onPick={setModifyFeedback}
                                onTranscript={setModifyFeedback}
                                label="常用反馈"
                                voiceLabel="口述反馈"
                                compact
                            />
                        </div>
                        <div className="pr-grading-detail-modify-field">
                            <label>认知归因</label>
                            <textarea
                                value={modifyAttribution}
                                onChange={(e) => setModifyAttribution(e.target.value)}
                                rows={2}
                                placeholder="认知归因修正..."
                                aria-label="认知归因修正"
                            />
                            <QuickVoiceAssist
                                suggestions={[
                                    '字词理解不牢',
                                    '审题不清',
                                    '意象理解偏差',
                                    '表达不完整',
                                ]}
                                onPick={setModifyAttribution}
                                onTranscript={setModifyAttribution}
                                label="点选认知归因"
                                voiceLabel="口述归因"
                                compact
                            />
                        </div>
                    </div>
                )}

                {/* 审核操作按钮 */}
                <div className="pr-grading-detail-actions">
                    {!modifyMode ? (
                        <>
                            <Button
                                variant="success"
                                size="sm"
                                leftIcon={<Icon name="check-square" size={14} />}
                                onClick={() => void handleAction('confirm')}
                                loading={reviewPending}
                                loadingLabel="保存中"
                                disabled={result.reviewed && result.reviewAction === 'confirm'}
                            >
                                确认
                            </Button>
                            <Button
                                variant="secondary"
                                size="sm"
                                leftIcon={<Icon name="pencil-line" size={14} />}
                                onClick={() => {
                                    setModifyCorrect(result.correct)
                                    setModifyFeedback(result.feedback)
                                    setModifyAttribution(result.cognitiveAttribution)
                                    setModifyMode(true)
                                }}
                                disabled={reviewPending}
                            >
                                修正
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                leftIcon={<Icon name="bookmark" size={14} />}
                                onClick={() => void handleAction('reference')}
                                disabled={reviewPending}
                            >
                                标记为参考
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={() => void handleAction('modify')}
                                loading={reviewPending}
                                loadingLabel="保存中"
                            >
                                保存修正
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setModifyMode(false)}
                                disabled={reviewPending}
                            >
                                取消
                            </Button>
                        </>
                    )}
                </div>
            </div>
        </div>
    )
})
