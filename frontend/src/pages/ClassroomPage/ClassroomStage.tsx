/**
 * 课堂大屏预览（SubTask 11.1）
 *
 * 职责：
 * 1. 投屏布局：题干 + 选项 + 答题进度 + 实时统计
 * 2. 顶部渲染模式专属组件（倒计时 / 积分榜 / 关键字 / 六阶雷达）
 * 3. 题目流转时的视觉过渡（淡入 + 上移）
 *
 * 数据来源：
 * - question / questionIndex / totalQuestions：从 store 透传
 * - responses / activeStudents：实时作答与活跃人数
 * - flyingFlowerKeyword：飞花令模式关键字
 *
 * 设计要点（规范第 5、6、9 章）：
 * - 大屏信息密度高但呼吸感不丢：题干区稳带，统计区紧带
 * - 答题进度条使用分段式（正确/错误/待答），语义清晰
 * - 选项可点击（教师端预览答题），但不影响真实作答
 */

import { memo, useMemo } from 'react'
import { Icon, Badge } from '@/components/ui'
import {
    CLASSROOM_MODE_LABELS,
    type ClassroomMode,
    type ClassroomQuestion,
    type StudentResponse,
} from '@/lib/types'
import { CollectiveRaceMode } from './modes/CollectiveRaceMode'
import { SpeedPkMode } from './modes/SpeedPkMode'
import { FlyingFlowerMode } from './modes/FlyingFlowerMode'
import { SixLevelImmersiveMode } from './modes/SixLevelImmersiveMode'
import { PoemWheelMode } from './modes/PoemWheelMode'
import { PoemRelayMode } from './modes/PoemRelayMode'
import { ImageryPuzzleMode } from './modes/ImageryPuzzleMode'

export interface ClassroomStageProps {
    /** 课堂模式 */
    mode: ClassroomMode
    /** 当前题目 */
    question: ClassroomQuestion | undefined
    /** 当前题目序号（0-based） */
    questionIndex: number
    /** 题目总数 */
    totalQuestions: number
    /** 学生作答列表 */
    responses: StudentResponse[]
    /** 活跃学生数 */
    activeStudents: number
    /** 飞花令关键字（仅 flying-flower 模式） */
    flyingFlowerKeyword?: string
    /** 集体闯关倒计时归零回调 */
    onTimeout?: () => void
}

export const ClassroomStage = memo(function ClassroomStage({
    mode,
    question,
    questionIndex,
    totalQuestions,
    responses,
    activeStudents,
    flyingFlowerKeyword,
    onTimeout,
}: ClassroomStageProps) {
    const latestResponses = useMemo(() => {
        const byStudent = new Map<string, StudentResponse>()
        for (const response of responses) {
            if (response.studentId === 'ai-opponent') continue
            const current = byStudent.get(response.studentId)
            if (!current || response.at >= current.at) {
                byStudent.set(response.studentId, response)
            }
        }
        return Array.from(byStudent.values())
    }, [responses])
    const correctCount = useMemo(
        () => latestResponses.filter((response) => response.correct).length,
        [latestResponses],
    )
    const wrongCount = useMemo(
        () => latestResponses.filter((response) => response.correct === false).length,
        [latestResponses],
    )
    const pendingCount = Math.max(0, activeStudents - correctCount - wrongCount)

    const progressPercent = totalQuestions > 0 ? ((questionIndex + 1) / totalQuestions) * 100 : 0
    const responseRate = activeStudents > 0
        ? Math.min(100, Math.round((latestResponses.length / activeStudents) * 100))
        : 0

    /** 渲染模式专属组件 */
    const renderModeComponent = () => {
        switch (mode) {
            case 'collective-race':
                return (
                    <CollectiveRaceMode
                        question={question}
                        questionIndex={questionIndex}
                        responseCount={responses.length}
                        totalStudents={activeStudents}
                        onTimeout={onTimeout}
                    />
                )
            case 'speed-pk':
                return <SpeedPkMode responses={responses} totalStudents={activeStudents} />
            case 'flying-flower':
                return (
                    <FlyingFlowerMode
                        keyword={flyingFlowerKeyword}
                        responses={responses}
                        totalStudents={activeStudents}
                    />
                )
            case 'six-level-immersive':
                return (
                    <SixLevelImmersiveMode
                        question={question}
                        responses={responses}
                    />
                )
            case 'poem-wheel':
                return <PoemWheelMode question={question} />
            case 'poem-relay':
                return <PoemRelayMode />
            case 'imagery-puzzle':
                return <ImageryPuzzleMode question={question} />
            default:
                return null
        }
    }

    /** 选项字母标号 */
    const optionLabel = (idx: number): string => String.fromCharCode(65 + idx)

    // 空状态：课堂未开始或无题目
    if (!question) {
        return (
            <div className="pr-stage">
                <div className="pr-stage-empty">
                    <div className="pr-stage-empty-icon">
                        <Icon name="book-open" size={32} />
                    </div>
                    <div className="pr-stage-empty-title">等待题目投屏</div>
                    <div className="pr-stage-empty-text">
                        {totalQuestions === 0
                            ? '课堂尚未开始，请在右侧控制面板选择模式与诗篇后开始课堂'
                            : `已完成 ${questionIndex}/${totalQuestions} 题，点击"下一题"继续`}
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="pr-stage">
            {/* 顶部：标题 + 进度 */}
            <div className="pr-stage-header">
                <div className="pr-stage-title-row">
                    <h2 className="pr-stage-title">{CLASSROOM_MODE_LABELS[mode]}</h2>
                    <Badge variant="primary" icon={<Icon name="sparkle" size={10} />}>
                        第 {questionIndex + 1} / {totalQuestions} 题
                    </Badge>
                </div>
                <div className="pr-stage-progress">
                    <span>进度</span>
                    <div className="pr-stage-progress-bar">
                        <div className="pr-stage-progress-fill" style={{ transform: `scaleX(${progressPercent / 100})` }} />
                    </div>
                    <span>{Math.round(progressPercent)}%</span>
                </div>
            </div>

            {/* 模式专属组件 */}
            {renderModeComponent()}

            {/* 题目主体 */}
            <div className="pr-stage-question">
                <div className="pr-stage-question-meta">
                    <Badge variant="info">{question.bloomLevel}</Badge>
                    <Badge variant="default">{question.type}</Badge>
                    <span
                        style={{
                            fontSize: 'var(--text-xs)',
                            color: 'rgb(var(--c-text-tertiary))',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 'var(--space-xs)',
                        }}
                    >
                        <Icon name="clock" size={12} />
                        建议 {question.estimatedTimeSec} 秒
                    </span>
                    <span
                        style={{
                            fontSize: 'var(--text-xs)',
                            color: 'rgb(var(--c-text-tertiary))',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 'var(--space-xs)',
                        }}
                    >
                        <Icon name="star" size={12} />
                        难度 {question.difficulty}/5
                    </span>
                </div>

                <div className="pr-stage-question-stem">{question.stem}</div>

                {question.options && question.options.length > 0 && (
                    <div className="pr-stage-question-options">
                        {question.options.map((opt, idx) => (
                            <div key={idx} className="pr-stage-question-option" role="presentation">
                                <span className="pr-stage-question-option-key">{optionLabel(idx)}</span>
                                <span>{opt}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* 答题进度与统计 */}
            <div className="pr-stage-responses">
                <div className="pr-stage-responses-header">
                    <span className="pr-stage-responses-title">答题进度</span>
                    <div className="pr-stage-responses-stats">
                        <span className="pr-stage-responses-stat--correct">
                            <Icon name="check" size={12} /> {correctCount} 正确
                        </span>
                        <span className="pr-stage-responses-stat--wrong">
                            <Icon name="x" size={12} /> {wrongCount} 错误
                        </span>
                        <span>
                            <Icon name="clock" size={12} /> {pendingCount} 待答
                        </span>
                        <span>响应率 {responseRate}%</span>
                    </div>
                </div>

                {/* 分段式进度条：正确/错误/待答 */}
                <div className="pr-stage-progress-track">
                    {activeStudents > 0 && (
                        <>
                            <div
                                className="pr-stage-progress-segment pr-stage-progress-segment--correct"
                                style={{ width: `${(correctCount / activeStudents) * 100}%` }}
                            />
                            <div
                                className="pr-stage-progress-segment pr-stage-progress-segment--wrong"
                                style={{ width: `${(wrongCount / activeStudents) * 100}%` }}
                            />
                            <div
                                className="pr-stage-progress-segment pr-stage-progress-segment--pending"
                                style={{ width: `${(pendingCount / activeStudents) * 100}%` }}
                            />
                        </>
                    )}
                </div>
            </div>
        </div>
    )
})
