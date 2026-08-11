/**
 * 课堂控制面板（SubTask 11.2）
 *
 * 职责：
 * 1. 课堂氛围仪表盘：classMood + engagement 可视化
 * 2. 认知负荷指示器：cognitiveLoad 三档（低/中/高）+ 教学建议
 * 3. 学生标签云：按作答状态着色（正确/错误/待答）
 * 4. 题目导航：题号 + 题干摘要 + 当前题高亮
 * 5. 控制按钮组：下一题 / 推送提示 / 推送讨论题 / 结束课堂
 *
 * 数据来源：
 * - status.classMood / cognitiveLoad / engagement / activeStudents
 * - responses（学生标签着色）
 * - currentQuestionIndex / totalQuestions（导航）
 *
 * 设计要点（规范第 7、14 章）：
 * - 所有交互元素完整三态（hover/active/focus-visible）
 * - 认知负荷颜色：低=success，中=warning，高=error
 * - 学生标签密度自适应，超出换行
 */

import { memo, useMemo, useState } from 'react'
import { Button, Icon, Badge } from '@/components/ui'
import {
    CLASSROOM_MODE_LABELS,
    CLASS_MOOD_LABELS,
    type ClassroomMode,
    type ClassroomStatus,
    type StudentResponse,
} from '@/lib/types'

/** 课堂模式分段控制器选项
 *
 * 设计：基础 4 模式 + 创新 3 模式，共 7 模式分组展示
 * - 基础模式：collective-race / speed-pk / flying-flower / six-level-immersive
 * - 创新模式：poem-wheel（诗词大转盘）/ poem-relay（诗词接龙）/ imagery-puzzle（意境拼图）
 * 图标选用语义：
 * - graduation: 集体协作 / 课堂共闯
 * - lightbulb: 抢答 / 灵光一闪
 * - feather: 飞花令 / 文学意境
 * - chart-bar: 六阶认知 / 数据递进
 * - sparkles: 大转盘 / 幸运抽题（创新 1）
 * - repeat: 接龙 / 循环相接（创新 2）
 * - puzzle-piece: 拼图 / 意境重组（创新 3）
 */
const MODE_SEGMENTS: Array<{
    mode: ClassroomMode
    icon: 'graduation' | 'lightbulb' | 'feather' | 'chart-bar' | 'sparkles' | 'repeat' | 'puzzle-piece'
    innovative?: boolean
}> = [
        { mode: 'collective-race', icon: 'graduation' },
        { mode: 'speed-pk', icon: 'lightbulb' },
        { mode: 'flying-flower', icon: 'feather' },
        { mode: 'six-level-immersive', icon: 'chart-bar' },
        { mode: 'poem-wheel', icon: 'sparkles', innovative: true },
        { mode: 'poem-relay', icon: 'repeat', innovative: true },
        { mode: 'imagery-puzzle', icon: 'puzzle-piece', innovative: true },
    ]

/** 模式元信息（场景 + 时长） */
type ModeMeta = Record<ClassroomMode, { scenario: string; duration: string }>

export interface ClassroomControlProps {
    /** 课堂模式 */
    mode: ClassroomMode
    /** 课堂实时状态 */
    status: ClassroomStatus
    /** 学生作答列表（用于标签云着色） */
    responses: StudentResponse[]
    /** 当前题号（0-based） */
    questionIndex: number
    /** 题目总数 */
    totalQuestions: number
    /** 切换下一题加载中 */
    advancing: boolean
    /** 推送提示加载中 */
    pushingHint: boolean
    /** 推送讨论题加载中 */
    pushingDiscuss: boolean
    /** 结束课堂加载中 */
    ending: boolean
    /** 模式切换中（禁用切换按钮） */
    modeSwitching?: boolean
    /** 模式元信息（场景 + 时长） */
    modeMeta?: ModeMeta
    /** 下一题回调 */
    onNext: () => void
    /** 推送启发提示 */
    onPushHint: (type?: 'nudge' | 'scaffold' | 'reframe') => void
    /** 推送讨论题 */
    onPushDiscuss: (angle?: 'cultural' | 'comparative' | 'creative') => void
    /** 结束课堂 */
    onEnd: () => void
    /** 模式切换回调 */
    onModeSwitch?: (newMode: ClassroomMode) => void
}

/** 认知负荷分级 */
function cognitiveLevel(load: number): 'low' | 'mid' | 'high' {
    if (load < 40) return 'low'
    if (load < 70) return 'mid'
    return 'high'
}

/** 认知负荷教学建议 */
function cognitiveHint(load: number): string {
    if (load < 40) return '学生负荷较低，可适当增加挑战性内容'
    if (load < 70) return '负荷适中，保持当前节奏'
    return '负荷偏高，建议放缓节奏或推送脚手架提示'
}

/** 课堂氛围图标映射 */
const MOOD_ICONS: Record<string, 'check-circle' | 'star' | 'warning-circle' | 'info'> = {
    focused: 'check-circle',
    excited: 'star',
    bored: 'warning-circle',
    confused: 'info',
}

export const ClassroomControl = memo(function ClassroomControl({
    mode,
    status,
    responses,
    questionIndex,
    totalQuestions,
    advancing,
    pushingHint,
    pushingDiscuss,
    ending,
    modeSwitching = false,
    modeMeta,
    onNext,
    onPushHint,
    onPushDiscuss,
    onEnd,
    onModeSwitch,
}: ClassroomControlProps) {
    const { classMood, cognitiveLoad, engagement, activeStudents } = status

    const cogLevel = cognitiveLevel(cognitiveLoad)
    const cogValueClass = `pr-control-cognitive-value--${cogLevel}`

    /** 待确认切换的模式（点击一次高亮，再次点击确认） */
    const [pendingMode, setPendingMode] = useState<ClassroomMode | null>(null)

    /** 处理模式切换：首次点击高亮，再次点击确认 */
    const handleModeClick = (targetMode: ClassroomMode) => {
        if (!onModeSwitch || modeSwitching) return
        if (targetMode === mode) {
            setPendingMode(null)
            return
        }
        if (pendingMode === targetMode) {
            // 二次点击 → 确认切换
            setPendingMode(null)
            onModeSwitch(targetMode)
        } else {
            // 首次点击 → 标记待确认
            setPendingMode(targetMode)
        }
    }

    /** 学生标签：按 studentId 去重，取最新作答状态 */
    const studentTags = useMemo(() => {
        // 按 at 降序排序，遍历时首次遇到的即为该学生最新作答
        const sorted = [...responses].sort((a, b) => b.at - a.at)
        const map = new Map<string, { studentId: string; studentName: string; correct: boolean | undefined }>()
        for (const r of sorted) {
            if (map.has(r.studentId)) continue
            map.set(r.studentId, {
                studentId: r.studentId,
                studentName: r.studentName ?? `学生${r.studentId.slice(-4)}`,
                correct: r.correct,
            })
        }
        return Array.from(map.values())
    }, [responses])

    /** 题目导航项 */
    const navItems = useMemo(() => {
        return Array.from({ length: totalQuestions }, (_, i) => ({
            index: i,
            isCurrent: i === questionIndex,
            isAnswered: i < questionIndex,
        }))
    }, [totalQuestions, questionIndex])

    return (
        <div className="pr-control">
            {/* 模式分段控制器（玻璃态）—— 课堂指挥深化 Task 1
             * v5.0 Task 19-20：扩展为 7 模式（基础 4 + 创新 3），分组展示
             * - 基础模式：4 项 2×2 网格
             * - 创新模式：3 项独立分组，使用 accent-info 微高亮 + "创新" 标签
             */}
            <div className="pr-control-mode-segment">
                <div className="pr-control-mode-segment-label">
                    <Icon name="switch" size={12} />
                    <span>教学模式</span>
                    {modeSwitching && (
                        <span className="pr-control-mode-segment-switching">切换中…</span>
                    )}
                </div>
                {/* 基础模式分组 */}
                <div className="pr-control-mode-segment-group-label">基础模式</div>
                <div className="pr-control-mode-segment-grid">
                    {MODE_SEGMENTS.filter((seg) => !seg.innovative).map((seg) => {
                        const isActive = seg.mode === mode
                        const isPending = pendingMode === seg.mode
                        const meta = modeMeta?.[seg.mode]
                        return (
                            <button
                                key={seg.mode}
                                type="button"
                                className={`pr-control-mode-card ${isActive ? 'pr-control-mode-card--active' : ''} ${isPending ? 'pr-control-mode-card--pending' : ''}`}
                                disabled={!onModeSwitch || modeSwitching || ending}
                                onClick={() => handleModeClick(seg.mode)}
                                aria-pressed={isActive}
                                aria-label={`${CLASSROOM_MODE_LABELS[seg.mode]}${meta ? ` · ${meta.scenario} · ${meta.duration}` : ''}`}
                            >
                                <span className="pr-control-mode-card-icon">
                                    <Icon name={seg.icon} size={14} />
                                </span>
                                <span className="pr-control-mode-card-name">
                                    {CLASSROOM_MODE_LABELS[seg.mode]}
                                </span>
                                {meta && (
                                    <span className="pr-control-mode-card-meta">
                                        {meta.scenario} · {meta.duration}
                                    </span>
                                )}
                                {isPending && (
                                    <span className="pr-control-mode-card-confirm">
                                        <Icon name="check" size={10} />
                                        确认
                                    </span>
                                )}
                            </button>
                        )
                    })}
                </div>
                {/* 创新模式分组 —— v5.0 Task 19 新增 */}
                <div className="pr-control-mode-segment-group-label pr-control-mode-segment-group-label--innovative">
                    <Icon name="sparkles" size={11} />
                    创新模式 · 寓教于乐
                </div>
                <div className="pr-control-mode-segment-grid pr-control-mode-segment-grid--innovative">
                    {MODE_SEGMENTS.filter((seg) => seg.innovative).map((seg) => {
                        const isActive = seg.mode === mode
                        const isPending = pendingMode === seg.mode
                        const meta = modeMeta?.[seg.mode]
                        return (
                            <button
                                key={seg.mode}
                                type="button"
                                className={`pr-control-mode-card pr-control-mode-card--innovative ${isActive ? 'pr-control-mode-card--active' : ''} ${isPending ? 'pr-control-mode-card--pending' : ''}`}
                                disabled={!onModeSwitch || modeSwitching || ending}
                                onClick={() => handleModeClick(seg.mode)}
                                aria-pressed={isActive}
                                aria-label={`${CLASSROOM_MODE_LABELS[seg.mode]}${meta ? ` · ${meta.scenario} · ${meta.duration}` : ''}`}
                            >
                                <span className="pr-control-mode-card-icon">
                                    <Icon name={seg.icon} size={14} />
                                </span>
                                <span className="pr-control-mode-card-name">
                                    {CLASSROOM_MODE_LABELS[seg.mode]}
                                </span>
                                {meta && (
                                    <span className="pr-control-mode-card-meta">
                                        {meta.scenario} · {meta.duration}
                                    </span>
                                )}
                                {isPending && (
                                    <span className="pr-control-mode-card-confirm">
                                        <Icon name="check" size={10} />
                                        确认
                                    </span>
                                )}
                            </button>
                        )
                    })}
                </div>
            </div>

            {/* 课堂氛围 */}
            <div className="pr-control-section">
                <div className="pr-control-section-title">课堂氛围</div>
                <div className="pr-control-mood">
                    <div className="pr-control-mood-header">
                        <span className="pr-control-mood-label">
                            <Icon name={MOOD_ICONS[classMood] ?? 'info'} size={14} />
                            {CLASS_MOOD_LABELS[classMood]}
                        </span>
                        <span className="pr-control-mood-value">活跃度 {engagement}%</span>
                    </div>
                    <div className="pr-control-mood-bar">
                        <div
                            className={`pr-control-mood-fill pr-control-mood-fill--${classMood}`}
                            style={{ width: `${engagement}%` }}
                        />
                    </div>
                </div>
            </div>

            {/* 认知负荷 */}
            <div className="pr-control-section">
                <div className="pr-control-section-title">认知负荷</div>
                <div className="pr-control-cognitive">
                    <div className="pr-control-cognitive-header">
                        <span className="pr-control-cognitive-label">
                            <Icon name="chart-bar" size={14} />
                            负荷指数
                        </span>
                        <span className={`pr-control-cognitive-value ${cogValueClass}`}>
                            {cognitiveLoad}
                        </span>
                    </div>
                    <div className="pr-control-cognitive-bar">
                        <div
                            className="pr-control-cognitive-fill"
                            style={{ transform: `scaleX(${cognitiveLoad / 100})` }}
                        />
                    </div>
                    <div className="pr-control-cognitive-hint">{cognitiveHint(cognitiveLoad)}</div>
                </div>
            </div>

            {/* 学生标签云 */}
            <div className="pr-control-section">
                <div className="pr-control-section-title">
                    学生作答 · {studentTags.length}/{activeStudents}
                </div>
                <div className="pr-control-students">
                    {studentTags.length === 0 ? (
                        <span
                            style={{
                                fontSize: 'var(--text-2xs)',
                                color: 'rgb(var(--c-text-tertiary))',
                                padding: 'var(--space-xs) 0',
                            }}
                        >
                            等待学生作答...
                        </span>
                    ) : (
                        studentTags.map((tag) => {
                            const cls =
                                tag.correct === true
                                    ? 'pr-control-student-tag--correct'
                                    : tag.correct === false
                                        ? 'pr-control-student-tag--wrong'
                                        : ''
                            return (
                                <span key={tag.studentId} className={`pr-control-student-tag ${cls}`}>
                                    <span className="pr-control-student-tag-dot" />
                                    {tag.studentName}
                                </span>
                            )
                        })
                    )}
                </div>
            </div>

            {/* 题目导航 */}
            <div className="pr-control-section">
                <div className="pr-control-section-title">题目导航</div>
                <div className="pr-control-nav">
                    <div className="pr-control-nav-list">
                        {navItems.map((item) => (
                            <button
                                key={item.index}
                                type="button"
                                className={`pr-control-nav-item ${item.isCurrent ? 'pr-control-nav-item--active' : ''}`}
                                disabled
                                aria-disabled="true"
                            /* 题目导航仅展示，不支持回跳（避免破坏课堂节奏） */
                            >
                                <span className="pr-control-nav-item-index">
                                    {String(item.index + 1).padStart(2, '0')}
                                </span>
                                <span className="pr-control-nav-item-stem">
                                    {item.isCurrent ? '当前题' : item.isAnswered ? '已作答' : '待进行'}
                                </span>
                                <span className="pr-control-nav-item-status">
                                    {item.isAnswered && !item.isCurrent && (
                                        <Icon name="check" size={12} />
                                    )}
                                    {item.isCurrent && (
                                        <Badge variant="primary">进行中</Badge>
                                    )}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* 控制按钮组 */}
            <div className="pr-control-actions">
                <div className="pr-control-actions-row">
                    <Button
                        variant="primary"
                        block
                        loading={advancing}
                        disabled={ending}
                        onClick={onNext}
                        leftIcon={<Icon name="caret-right" size={16} />}
                    >
                        下一题
                    </Button>
                </div>
                <div className="pr-control-actions-row">
                    <Button
                        variant="secondary"
                        loading={pushingHint}
                        disabled={ending}
                        onClick={() => onPushHint('nudge')}
                        leftIcon={<Icon name="lightbulb" size={16} />}
                    >
                        推送提示
                    </Button>
                    <Button
                        variant="secondary"
                        loading={pushingDiscuss}
                        disabled={ending}
                        onClick={() => onPushDiscuss('cultural')}
                        leftIcon={<Icon name="quotes" size={16} />}
                    >
                        讨论题
                    </Button>
                </div>
                <div className="pr-control-actions-row">
                    <Button
                        variant="danger"
                        block
                        loading={ending}
                        onClick={onEnd}
                        leftIcon={<Icon name="x" size={16} />}
                    >
                        结束课堂
                    </Button>
                </div>
            </div>
        </div>
    )
})
