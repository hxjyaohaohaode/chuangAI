/**
 * RecognitionResult 识别结果（SubTask 12.3）
 *
 * 布局：左侧原图 + 右侧可编辑识别文本
 *
 * 功能：
 * - 显示上传的答题图片（从 /api/grading/files/:fileId 获取）
 * - 右侧显示诗眼 Agent 识别出的文本（可编辑 textarea）
 * - 题目下拉选择（未自动匹配时手动选择）
 * - 学生下拉选择（可选）
 * - 置信度指示器
 * - "重新识别"按钮（调用 /recognize 重试单张）
 *
 * 设计要点：
 * - 双栏布局：图片占 40%，文本占 60%（移动端堆叠）
 * - 置信度用色环可视化（绿/黄/红）
 * - 编辑即时同步至 store
 */

import { memo, useCallback } from 'react'
import { Button, Combobox, Icon, Badge, AIBadge, type ComboboxOption } from '@/components/ui'
import { useGradingStore } from '@/stores/grading'
import type { GradingQuestionOption, GradingStudentOption } from '@/lib/types'
import { GradingMediaImage } from './GradingMediaImage'

interface RecognitionResultProps {
    /** 当前查看的 fileId */
    fileId: string
    students: GradingStudentOption[]
    questions: GradingQuestionOption[]
}

/** 置信度等级 */
function confidenceLevel(c: number): 'high' | 'medium' | 'low' {
    if (c >= 0.8) return 'high'
    if (c >= 0.6) return 'medium'
    return 'low'
}

export const RecognitionResult = memo(function RecognitionResult({ fileId, students, questions }: RecognitionResultProps) {
    const recognized = useGradingStore((s) => s.recognized)
    const files = useGradingStore((s) => s.files)
    const updateRecognized = useGradingStore((s) => s.updateRecognized)
    const recognize = useGradingStore((s) => s.recognize)
    const loading = useGradingStore((s) => s.loading)

    const item = recognized.find((r) => r.fileId === fileId)
    const file = files.find((f) => f.id === fileId)

    const handleAnswerChange = useCallback(
        (e: React.ChangeEvent<HTMLTextAreaElement>) => {
            updateRecognized(fileId, { studentAnswer: e.target.value })
        },
        [fileId, updateRecognized],
    )

    const handleQuestionIdChange = useCallback(
        (value: string | string[]) => {
            const questionId = (value as string) || undefined
            updateRecognized(fileId, { questionId, needsManualMatch: !questionId })
        },
        [fileId, updateRecognized],
    )

    const handleStudentIdChange = useCallback(
        (value: string | string[]) => {
            updateRecognized(fileId, { studentId: (value as string) || undefined })
        },
        [fileId, updateRecognized],
    )

    if (!item || !file) {
        return (
            <div className="pr-grading-recognition pr-grading-recognition--empty">
                <Icon name="eye" size={24} />
                <span>无识别结果</span>
            </div>
        )
    }

    const confLevel = confidenceLevel(item.confidence)
    // SVG 环形进度参数：半径 20，周长 ≈ 125.66（用于 strokeDasharray 计算）
    const RING_RADIUS = 20
    const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
    const confidencePercent = Math.round(item.confidence * 100)
    const ringDashArray = `${(item.confidence * RING_CIRCUMFERENCE).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`

    return (
        <div className="pr-grading-recognition">
            <div className="pr-grading-recognition-image">
                <GradingMediaImage
                    src={file.url}
                    alt={file.fileName ? `答题图片 ${file.fileName}` : '答题图片'}
                />
            </div>

            <div className="pr-grading-recognition-content">
                <div className="pr-grading-recognition-header">
                    <div className="pr-grading-recognition-title">
                        <Icon name="eye" size={16} />
                        <span>诗眼 Agent 识别结果</span>
                        <AIBadge size="xs" />
                    </div>
                    {/* SVG 环形进度条 + flexbox 居中（SubTask 23.4）
                     * 用 SVG 圆环可视化置信度，与右侧文字精度数据对齐
                     * 环形进度条：周长 125.66，strokeDasharray 按置信度比例填充 */}
                    <div
                        className={`pr-grading-recognition-confidence pr-grading-recognition-confidence--${confLevel}`}
                        role="meter"
                        aria-valuenow={confidencePercent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`识别置信度 ${confidencePercent}%`}
                    >
                        <svg
                            className="pr-grading-recognition-confidence-ring"
                            viewBox="0 0 48 48"
                            aria-hidden="true"
                            focusable="false"
                        >
                            <circle
                                cx="24"
                                cy="24"
                                r={RING_RADIUS}
                                className="pr-grading-recognition-confidence-ring-track"
                            />
                            <circle
                                cx="24"
                                cy="24"
                                r={RING_RADIUS}
                                className="pr-grading-recognition-confidence-ring-fill"
                                style={{ strokeDasharray: ringDashArray }}
                            />
                        </svg>
                        <span className="pr-grading-recognition-confidence-value">
                            {confidencePercent}%
                        </span>
                    </div>
                </div>

                <div className="pr-grading-recognition-field">
                    <label className="pr-grading-recognition-label">
                        识别文本（可编辑）
                    </label>
                    <textarea
                        className="pr-grading-recognition-textarea"
                        value={item.studentAnswer}
                        onChange={handleAnswerChange}
                        placeholder="识别文本将在此显示，教师可手动修正..."
                        rows={5}
                    />
                </div>

                <div className="pr-grading-recognition-fields">
                    <div className="pr-grading-recognition-field">
                        <label className="pr-grading-recognition-label">
                            题目
                            {item.needsManualMatch && (
                                <Badge variant="warning" icon={<Icon name="warning" size={10} />}>
                                    未匹配
                                </Badge>
                            )}
                        </label>
                        <Combobox
                            className="pr-grading-recognition-select"
                            ariaLabel="题目"
                            value={item.questionId ?? ''}
                            onChange={handleQuestionIdChange}
                            placeholder="请选择题目..."
                            options={[
                                { value: '', label: '请选择题目...' },
                                ...questions.map<ComboboxOption>((question) => ({
                                    value: question.id,
                                    label: `${question.bloomLevel} · ${question.stem}`,
                                })),
                            ]}
                        />
                    </div>

                    <div className="pr-grading-recognition-field">
                        <label className="pr-grading-recognition-label">
                            学生归档
                            {!item.studentId && <Badge variant="warning">未归档</Badge>}
                        </label>
                        <Combobox
                            className="pr-grading-recognition-select"
                            value={item.studentId ?? ''}
                            onChange={handleStudentIdChange}
                            ariaLabel="学生"
                            placeholder="请选择学生..."
                            options={[
                                { value: '', label: '请选择学生...' },
                                ...students.map<ComboboxOption>((student) => ({
                                    value: student.id,
                                    label: student.name,
                                })),
                            ]}
                        />
                    </div>
                </div>

                <div className="pr-grading-recognition-actions">
                    <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Icon name="arrows-clockwise" size={14} />}
                        onClick={() => void recognize()}
                        loading={loading}
                    >
                        重新识别
                    </Button>
                </div>
            </div>
        </div>
    )
})
