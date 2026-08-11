/**
 * 智能题卡推荐 IntelligentRecommendation（Task 22 SubTask 22.1 + 22.2 + 22.3）
 *
 * v5.0 Task 22 能力：
 * 1. 学生选择 Combobox（按班级过滤）
 *    - 端点：GET /api/students?classId=xxx
 * 2. 薄弱点标签云
 *    - 端点：GET /api/students/:id/weak-points
 *    - 按 level 0-100 着色（越低越薄弱，颜色越红）
 *    - 点击标签可过滤推荐题卡
 * 3. 推荐题卡列表
 *    - 端点：GET /api/workbench/questions（拉取题库全量，按 knowledgePoints 匹配）
 *    - 前端按命中薄弱知识点数排序
 *    - 卡片显示：题干摘要 + 匹配的薄弱知识点 + 推荐理由 + 难度匹配度
 *    - 操作：加入组卷 / 查看详情
 * 4. 智能组卷（SubTask 22.3）
 *    - 端点：POST /api/workbench/smart-compose
 *    - 参数：题数 / 难度分布（易:中:难）/ 知识点覆盖 / 总分
 *    - 返回：组卷结果（题卡列表 + 覆盖率 + 难度图 + 总分）
 *
 * 设计依据：
 * - 规范第 2 章：透明度驱动暖调色板
 * - 规范第 6 章：spring-soft 250ms 入场
 * - 规范第 10 章：图表（难度分布柱状图）使用自定义色板
 * - TanStack Query useQuery + useMutation
 * - Combobox 单选模式
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Badge, Button, Icon, Modal } from '@/components/ui'
import { Combobox, type ComboboxOption } from '@/components/ui'
import { Markdown } from '@/components/ui/Markdown'
import { api } from '@/lib/api'
import { getDisplayError } from '@/lib/errors'
import { toast } from '@/stores/toast'
import { useAuthStore } from '@/stores/auth'
import {
    WORKBENCH_BLOOM_COLORS,
    type RecommendedQuestion,
    type StudentOption,
    type StudentWeakPoint,
    type WorkbenchQuestionMeta,
    type WorkbenchSmartComposeRequest,
    type WorkbenchSmartComposeResponse,
} from '@/lib/types'
import './IntelligentRecommendation.css'

/* ============================================================
 * 常量与工具
 * ============================================================ */

/** 难度档位 */
type DifficultyTier = 'easy' | 'medium' | 'hard'

/** 推荐题卡拉取数量（一次拉取 100 条用于本地匹配） */
const RECOMMEND_FETCH_SIZE = 100

/** 根据掌握度（0-100）确定颜色档位 */
function getWeakPointColor(level: number): { color: string; bg: string; label: string } {
    if (level < 30) {
        return {
            color: 'rgb(var(--c-accent-error))',
            bg: 'var(--accent-error-10)',
            label: '严重薄弱',
        }
    }
    if (level < 60) {
        return {
            color: 'rgb(var(--c-accent-warning))',
            bg: 'var(--accent-warning-10)',
            label: '一般薄弱',
        }
    }
    if (level < 80) {
        return {
            color: 'rgb(var(--c-accent-info))',
            bg: 'var(--accent-info-10)',
            label: '基本掌握',
        }
    }
    return {
        color: 'rgb(var(--c-accent-success))',
        bg: 'var(--accent-success-10)',
        label: '熟练掌握',
    }
}

/** 根据难度（1-5）确定档位 */
function getDifficultyTier(difficulty: number): DifficultyTier {
    if (difficulty <= 2) return 'easy'
    if (difficulty <= 3) return 'medium'
    return 'hard'
}

/** 难度档位标签 */
const TIER_LABEL: Record<DifficultyTier, string> = {
    easy: '易',
    medium: '中',
    hard: '难',
}

/** 难度档位颜色 */
const TIER_COLOR: Record<DifficultyTier, string> = {
    easy: 'rgb(var(--c-accent-success))',
    medium: 'rgb(var(--c-accent-warning))',
    hard: 'rgb(var(--c-accent-error))',
}

/**
 * 根据薄弱知识点列表和题卡库，计算推荐题卡列表
 *
 * 匹配规则：
 * 1. 题卡 knowledgePoints 与学生 weakPoints.knowledge 取交集
 * 2. 命中数越多，推荐度越高
 * 3. 难度档位匹配学生薄弱程度（越薄弱推荐越基础）
 * 4. matchScore = (命中数 / 总薄弱点数) * 60 + (难度匹配度) * 40
 */
function computeRecommendations(
    questions: WorkbenchQuestionMeta[],
    weakPoints: StudentWeakPoint[],
    activeFilter?: string,
): RecommendedQuestion[] {
    if (weakPoints.length === 0) return []
    const weakSet = new Map<string, StudentWeakPoint>()
    for (const wp of weakPoints) {
        weakSet.set(wp.knowledge, wp)
    }

    const results: RecommendedQuestion[] = []

    for (const q of questions) {
        // 过滤：如果设置了 activeFilter，仅显示命中该知识点的题卡
        if (activeFilter && !(q.knowledgePoints ?? []).includes(activeFilter)) {
            continue
        }

        const matched = (q.knowledgePoints ?? []).filter((kp) => weakSet.has(kp))
        if (matched.length === 0) continue

        // 难度匹配度：薄弱学生（avg level < 50）推荐易/中档；熟练学生推荐中/难档
        const avgLevel =
            weakPoints.reduce((sum, wp) => sum + wp.level, 0) / weakPoints.length
        const tier = getDifficultyTier(q.difficulty)
        let difficultyMatch = 0
        if (avgLevel < 50) {
            // 薄弱学生：易=100, 中=70, 难=30
            difficultyMatch = tier === 'easy' ? 100 : tier === 'medium' ? 70 : 30
        } else if (avgLevel < 80) {
            // 中等学生：易=70, 中=100, 难=70
            difficultyMatch = tier === 'medium' ? 100 : 70
        } else {
            // 熟练学生：易=40, 中=80, 难=100
            difficultyMatch = tier === 'hard' ? 100 : tier === 'medium' ? 80 : 40
        }

        const coverageScore = (matched.length / weakPoints.length) * 60
        const matchScore = Math.round(coverageScore + (difficultyMatch / 100) * 40)

        // 推荐理由
        const reasons: string[] = []
        if (matched.length === 1) {
            reasons.push(`命中薄弱知识点「${matched[0]}」`)
        } else {
            reasons.push(`命中 ${matched.length} 个薄弱知识点`)
        }
        reasons.push(`难度档位 ${TIER_LABEL[tier]}（匹配度 ${difficultyMatch}%）`)
        if (matchScore >= 80) {
            reasons.push('强烈推荐')
        } else if (matchScore >= 60) {
            reasons.push('建议练习')
        }

        results.push({
            ...q,
            reason: reasons.join(' · '),
            matchScore,
            matchedWeakPoints: matched,
        })
    }

    // 按匹配度降序排序
    results.sort((a, b) => b.matchScore - a.matchScore)
    return results
}

/* ============================================================
 * 主组件
 * ============================================================ */

interface IntelligentRecommendationProps {
    /** 选中学生 ID（受控，可选；不传则组件内部管理） */
    studentId?: string
    /** 选中学生变化回调 */
    onStudentChange?: (studentId: string) => void
}

export const IntelligentRecommendation = memo(function IntelligentRecommendation({
    studentId: controlledStudentId,
    onStudentChange,
}: IntelligentRecommendationProps) {
    const teacherId = useAuthStore((s) => s.teacherId)

    /* ------------------------------------------------------------
     * 内部状态（非受控模式）
     * ---------------------------------------------------------- */
    const [internalStudentId, setInternalStudentId] = useState<string>('')
    const effectiveStudentId = controlledStudentId ?? internalStudentId

    const [activeFilter, setActiveFilter] = useState<string | undefined>(undefined)
    const [composeModalOpen, setComposeModalOpen] = useState(false)
    const [composeTotal, setComposeTotal] = useState(8)
    const [composeEasy, setComposeEasy] = useState(40)
    const [composeHard, setComposeHard] = useState(20)
    const [composeScore, setComposeScore] = useState(40)

    /* ------------------------------------------------------------
     * Query 1：学生列表
     * ---------------------------------------------------------- */
    const studentsQuery = useQuery({
        queryKey: ['students', 'list', teacherId],
        queryFn: () => api.students.list(),
        staleTime: 60_000,
    })

    const studentOptions: ComboboxOption[] = useMemo(() => {
        const list = studentsQuery.data?.students ?? []
        return list.map((s: StudentOption) => ({
            value: s.id,
            label: s.className ? `${s.name}（${s.className}）` : s.name,
            group: s.className ?? '未分班',
        }))
    }, [studentsQuery.data])

    /* ------------------------------------------------------------
     * Query 2：学生薄弱点
     * ---------------------------------------------------------- */
    const weakPointsQuery = useQuery({
        queryKey: ['students', 'weak-points', effectiveStudentId],
        queryFn: () => api.students.weakPoints(effectiveStudentId),
        enabled: !!effectiveStudentId,
        staleTime: 30_000,
    })

    const weakPoints: StudentWeakPoint[] = weakPointsQuery.data?.weakPoints ?? []

    /* ------------------------------------------------------------
     * Query 3：题卡库（用于本地匹配推荐）
     * ---------------------------------------------------------- */
    const questionsQuery = useQuery({
        queryKey: ['workbench', 'questions', { page: 1, pageSize: RECOMMEND_FETCH_SIZE }],
        queryFn: () =>
            api.workbench.listQuestions({
                page: 1,
                pageSize: RECOMMEND_FETCH_SIZE,
                sortBy: 'createdAt',
                sortOrder: 'desc',
            }),
        staleTime: 60_000,
    })

    const allQuestions: WorkbenchQuestionMeta[] = questionsQuery.data?.questions ?? []

    /* ------------------------------------------------------------
     * 计算推荐题卡列表
     * ---------------------------------------------------------- */
    const recommendations = useMemo(
        () => computeRecommendations(allQuestions, weakPoints, activeFilter),
        [allQuestions, weakPoints, activeFilter],
    )

    /* ------------------------------------------------------------
     * Mutation：智能组卷
     * ---------------------------------------------------------- */
    const smartComposeMutation = useMutation({
        mutationFn: async (req: WorkbenchSmartComposeRequest) => {
            return api.workbench.smartCompose(req)
        },
        onSuccess: (data: WorkbenchSmartComposeResponse) => {
            toast.success({
                title: '智能组卷完成',
                message: `已生成 ${data.paper.length} 道题卡 · 覆盖率 ${data.coverage}% · 总分 ${data.totalScore}`,
            })
            setComposeModalOpen(false)
        },
        onError: (err) => {
            toast.error({ title: '组卷失败', message: getDisplayError(err, '请稍后重试') })
        },
    })

    /* ------------------------------------------------------------
     * 学生选择处理
     * ---------------------------------------------------------- */
    const handleStudentChange = useCallback(
        (value: string | string[]) => {
            const v = Array.isArray(value) ? value[0] ?? '' : value
            if (controlledStudentId === undefined) {
                setInternalStudentId(v)
            }
            onStudentChange?.(v)
            setActiveFilter(undefined)
        },
        [controlledStudentId, onStudentChange],
    )

    /* ------------------------------------------------------------
     * 智能组卷处理
     * ---------------------------------------------------------- */
    const openComposeModal = useCallback(() => {
        if (!effectiveStudentId) {
            toast.warning({ title: '请先选择学生', message: '智能组卷需要基于学生薄弱点' })
            return
        }
        if (weakPoints.length === 0) {
            toast.warning({ title: '暂无薄弱点数据', message: '该学生暂无薄弱点分析结果' })
            return
        }
        // 默认参数：基于薄弱点数量推荐题数
        setComposeTotal(Math.max(5, Math.min(20, weakPoints.length * 2)))
        setComposeEasy(40)
        setComposeHard(20)
        setComposeScore(40)
        setComposeModalOpen(true)
    }, [effectiveStudentId, weakPoints.length])

    const handleConfirmCompose = useCallback(() => {
        if (!effectiveStudentId || weakPoints.length === 0) return
        const medium = 100 - composeEasy - composeHard
        if (medium < 0 || medium > 100) {
            toast.warning({ title: '难度分布不合理', message: '易+难比例不能超过 100%' })
            return
        }
        const req: WorkbenchSmartComposeRequest = {
            totalCount: composeTotal,
            difficultyDistribution: {
                easy: composeEasy,
                medium,
                hard: composeHard,
            },
            knowledgePoints: weakPoints.map((wp) => wp.knowledge),
            totalScore: composeScore,
        }
        smartComposeMutation.mutate(req)
    }, [effectiveStudentId, weakPoints, composeTotal, composeEasy, composeHard, composeScore, smartComposeMutation])

    /* ------------------------------------------------------------
     * 重置筛选
     * ---------------------------------------------------------- */
    useEffect(() => {
        if (!effectiveStudentId) {
            setActiveFilter(undefined)
        }
    }, [effectiveStudentId])

    /* ------------------------------------------------------------
     * 渲染辅助
     * ---------------------------------------------------------- */
    const isLoadingStudents = studentsQuery.isLoading
    const isLoadingWeak = weakPointsQuery.isLoading && !!effectiveStudentId
    const isLoadingQuestions = questionsQuery.isLoading
    const hasStudent = !!effectiveStudentId
    const hasWeakPoints = weakPoints.length > 0
    const hasRecommendations = recommendations.length > 0
    const isComposing = smartComposeMutation.isPending
    const composeResult = smartComposeMutation.data

    const mediumPercent = 100 - composeEasy - composeHard

    return (
        <div className="pr-wb-recommend">
            {/* 头部 */}
            <header className="pr-wb-recommend-header">
                <div className="pr-wb-recommend-title">
                    <Icon name="lightbulb" size={18} />
                    <h3>智能题卡推荐</h3>
                    <Badge variant="info">AI 推荐</Badge>
                </div>
                <p className="pr-wb-recommend-desc">
                    基于学生学情数据，精准推荐薄弱知识点对应题卡，支持一键智能组卷
                </p>
            </header>

            {/* 学生选择 */}
            <section className="pr-wb-recommend-student">
                <label className="pr-wb-recommend-label">
                    <Icon name="student" size={14} />
                    <span>选择学生</span>
                </label>
                {isLoadingStudents ? (
                    <div className="pr-wb-recommend-skeleton">
                        <Icon name="circle-notch" size={14} />
                        <span>加载学生列表…</span>
                    </div>
                ) : studentsQuery.error ? (
                    <div className="pr-wb-recommend-error">
                        <Icon name="warning-circle" size={14} />
                        <span>加载失败</span>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => studentsQuery.refetch()}
                            leftIcon={<Icon name="arrows-clockwise" size={12} />}
                        >
                            重试
                        </Button>
                    </div>
                ) : (
                    <Combobox
                        options={studentOptions}
                        value={effectiveStudentId}
                        onChange={handleStudentChange}
                        placeholder="搜索学生姓名或班级…"
                        ariaLabel="选择学生"
                    />
                )}
            </section>

            {/* 薄弱点标签云 */}
            {hasStudent && (
                <section className="pr-wb-recommend-weak">
                    <div className="pr-wb-recommend-label">
                        <Icon name="target" size={14} />
                        <span>薄弱知识点</span>
                        {hasWeakPoints && (
                            <Badge variant="default">{weakPoints.length} 项</Badge>
                        )}
                        {activeFilter && (
                            <button
                                type="button"
                                className="pr-wb-recommend-weak-clear"
                                onClick={() => setActiveFilter(undefined)}
                            >
                                <Icon name="x" size={11} />
                                <span>清除筛选</span>
                            </button>
                        )}
                    </div>
                    {isLoadingWeak ? (
                        <div className="pr-wb-recommend-skeleton">
                            <Icon name="circle-notch" size={14} />
                            <span>分析薄弱点…</span>
                        </div>
                    ) : weakPointsQuery.error ? (
                        <div className="pr-wb-recommend-error">
                            <Icon name="warning-circle" size={14} />
                            <span>薄弱点加载失败</span>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => weakPointsQuery.refetch()}
                                leftIcon={<Icon name="arrows-clockwise" size={12} />}
                            >
                                重试
                            </Button>
                        </div>
                    ) : !hasWeakPoints ? (
                        <div className="pr-wb-recommend-empty">
                            <Icon name="check-circle" size={20} />
                            <span>该学生暂无薄弱点数据，请先完成诊断</span>
                        </div>
                    ) : (
                        <div className="pr-wb-recommend-tags">
                            {weakPoints.map((wp) => {
                                const colorInfo = getWeakPointColor(wp.level)
                                const isActive = activeFilter === wp.knowledge
                                return (
                                    <button
                                        key={wp.knowledge}
                                        type="button"
                                        className={`pr-wb-recommend-tag${isActive ? ' is-active' : ''}`}
                                        style={{
                                            color: colorInfo.color,
                                            backgroundColor: colorInfo.bg,
                                        }}
                                        onClick={() =>
                                            setActiveFilter(isActive ? undefined : wp.knowledge)
                                        }
                                        title={`${colorInfo.label} · 掌握度 ${wp.level}%`}
                                    >
                                        <span className="pr-wb-recommend-tag-name">{wp.knowledge}</span>
                                        <span className="pr-wb-recommend-tag-level">{wp.level}</span>
                                    </button>
                                )
                            })}
                        </div>
                    )}
                </section>
            )}

            {/* 推荐题卡列表 */}
            {hasStudent && hasWeakPoints && (
                <section className="pr-wb-recommend-list">
                    <div className="pr-wb-recommend-list-head">
                        <div className="pr-wb-recommend-label">
                            <Icon name="sparkle" size={14} />
                            <span>推荐题卡</span>
                            {hasRecommendations && (
                                <Badge variant="primary">{recommendations.length} 道</Badge>
                            )}
                        </div>
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={openComposeModal}
                            disabled={!hasWeakPoints}
                            leftIcon={<Icon name="magic-wand" size={14} />}
                        >
                            智能组卷
                        </Button>
                    </div>

                    {isLoadingQuestions ? (
                        <div className="pr-wb-recommend-skeleton">
                            <Icon name="circle-notch" size={14} />
                            <span>匹配推荐题卡…</span>
                        </div>
                    ) : questionsQuery.error ? (
                        <div className="pr-wb-recommend-error">
                            <Icon name="warning-circle" size={14} />
                            <span>题卡加载失败</span>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => questionsQuery.refetch()}
                                leftIcon={<Icon name="arrows-clockwise" size={12} />}
                            >
                                重试
                            </Button>
                        </div>
                    ) : !hasRecommendations ? (
                        <div className="pr-wb-recommend-empty">
                            <Icon name="lightbulb" size={20} />
                            <span>暂无匹配的题卡，请先生成更多题卡或调整薄弱点</span>
                        </div>
                    ) : (
                        <ul className="pr-wb-recommend-cards">
                            {recommendations.slice(0, 12).map((rec) => (
                                <RecommendCard
                                    key={rec.id}
                                    recommendation={rec}
                                    onCompose={() => {
                                        toast.info({
                                            title: '已加入组卷候选',
                                            message: `「${rec.stem.slice(0, 20)}…」`,
                                        })
                                    }}
                                />
                            ))}
                        </ul>
                    )}
                </section>
            )}

            {/* 智能组卷弹窗（SubTask 22.3） */}
            <Modal
                open={composeModalOpen}
                onClose={() => {
                    if (!isComposing) setComposeModalOpen(false)
                }}
                size="md"
                title="智能组卷参数"
                footer={
                    <div className="pr-wb-recommend-compose-footer">
                        <Button
                            variant="ghost"
                            size="md"
                            onClick={() => setComposeModalOpen(false)}
                            disabled={isComposing}
                        >
                            取消
                        </Button>
                        <Button
                            variant="primary"
                            size="md"
                            onClick={handleConfirmCompose}
                            loading={isComposing}
                            loadingLabel="组卷中…"
                            leftIcon={!isComposing ? <Icon name="magic-wand" size={14} /> : undefined}
                        >
                            一键组卷
                        </Button>
                    </div>
                }
            >
                <div className="pr-wb-recommend-compose">
                    {/* 题数 */}
                    <section className="pr-wb-recommend-compose-field">
                        <label className="pr-wb-recommend-compose-label">
                            <Icon name="list" size={12} />
                            <span>题卡数量</span>
                            <Badge variant="primary">{composeTotal}</Badge>
                        </label>
                        <input
                            type="range"
                            min={5}
                            max={20}
                            step={1}
                            value={composeTotal}
                            onChange={(e) => setComposeTotal(Number(e.target.value))}
                            disabled={isComposing}
                            className="pr-wb-recommend-slider"
                        />
                        <div className="pr-wb-recommend-compose-range">
                            <span>5</span>
                            <span>20</span>
                        </div>
                    </section>

                    {/* 难度分布 */}
                    <section className="pr-wb-recommend-compose-field">
                        <label className="pr-wb-recommend-compose-label">
                            <Icon name="chart-bar" size={12} />
                            <span>难度分布</span>
                        </label>
                        <div className="pr-wb-recommend-compose-diff">
                            <div className="pr-wb-recommend-diff-item">
                                <span
                                    className="pr-wb-recommend-diff-dot"
                                    style={{ backgroundColor: TIER_COLOR.easy }}
                                />
                                <span className="pr-wb-recommend-diff-name">易</span>
                                <input
                                    type="range"
                                    min={0}
                                    max={100}
                                    step={5}
                                    value={composeEasy}
                                    onChange={(e) => setComposeEasy(Number(e.target.value))}
                                    disabled={isComposing}
                                    className="pr-wb-recommend-slider"
                                />
                                <span className="pr-wb-recommend-diff-pct">{composeEasy}%</span>
                            </div>
                            <div className="pr-wb-recommend-diff-item">
                                <span
                                    className="pr-wb-recommend-diff-dot"
                                    style={{ backgroundColor: TIER_COLOR.medium }}
                                />
                                <span className="pr-wb-recommend-diff-name">中</span>
                                <input
                                    type="range"
                                    min={0}
                                    max={100}
                                    step={5}
                                    value={mediumPercent}
                                    onChange={(e) => {
                                        const v = Number(e.target.value)
                                        setComposeEasy(Math.max(0, 100 - v - composeHard))
                                    }}
                                    disabled={isComposing}
                                    className="pr-wb-recommend-slider"
                                />
                                <span className="pr-wb-recommend-diff-pct">{mediumPercent}%</span>
                            </div>
                            <div className="pr-wb-recommend-diff-item">
                                <span
                                    className="pr-wb-recommend-diff-dot"
                                    style={{ backgroundColor: TIER_COLOR.hard }}
                                />
                                <span className="pr-wb-recommend-diff-name">难</span>
                                <input
                                    type="range"
                                    min={0}
                                    max={100}
                                    step={5}
                                    value={composeHard}
                                    onChange={(e) => setComposeHard(Number(e.target.value))}
                                    disabled={isComposing}
                                    className="pr-wb-recommend-slider"
                                />
                                <span className="pr-wb-recommend-diff-pct">{composeHard}%</span>
                            </div>
                        </div>
                        {mediumPercent < 0 && (
                            <div className="pr-wb-recommend-compose-warn">
                                <Icon name="warning-circle" size={12} />
                                <span>易 + 难 比例超过 100%，请调整</span>
                            </div>
                        )}
                    </section>

                    {/* 总分 */}
                    <section className="pr-wb-recommend-compose-field">
                        <label className="pr-wb-recommend-compose-label">
                            <Icon name="star" size={12} />
                            <span>试卷总分</span>
                            <Badge variant="primary">{composeScore}</Badge>
                        </label>
                        <input
                            type="range"
                            min={20}
                            max={100}
                            step={5}
                            value={composeScore}
                            onChange={(e) => setComposeScore(Number(e.target.value))}
                            disabled={isComposing}
                            className="pr-wb-recommend-slider"
                        />
                        <div className="pr-wb-recommend-compose-range">
                            <span>20</span>
                            <span>100</span>
                        </div>
                    </section>

                    {/* 知识点覆盖 */}
                    <section className="pr-wb-recommend-compose-field">
                        <label className="pr-wb-recommend-compose-label">
                            <Icon name="target" size={12} />
                            <span>知识点覆盖</span>
                            <Badge variant="info">{weakPoints.length} 项</Badge>
                        </label>
                        <div className="pr-wb-recommend-compose-kps">
                            {weakPoints.map((wp) => (
                                <span
                                    key={wp.knowledge}
                                    className="pr-wb-recommend-compose-kp"
                                    style={{
                                        color: getWeakPointColor(wp.level).color,
                                        backgroundColor: getWeakPointColor(wp.level).bg,
                                    }}
                                >
                                    {wp.knowledge}
                                </span>
                            ))}
                        </div>
                    </section>

                    {/* 组卷结果预览 */}
                    {composeResult && (
                        <section className="pr-wb-recommend-compose-result">
                            <div className="pr-wb-recommend-compose-result-head">
                                <Icon name="check-circle" size={14} />
                                <span>组卷完成</span>
                            </div>
                            <div className="pr-wb-recommend-compose-result-stats">
                                <div className="pr-wb-recommend-compose-result-stat">
                                    <span className="pr-wb-recommend-compose-result-stat-label">题数</span>
                                    <span className="pr-wb-recommend-compose-result-stat-value">
                                        {composeResult.paper.length}
                                    </span>
                                </div>
                                <div className="pr-wb-recommend-compose-result-stat">
                                    <span className="pr-wb-recommend-compose-result-stat-label">覆盖率</span>
                                    <span className="pr-wb-recommend-compose-result-stat-value">
                                        {composeResult.coverage}%
                                    </span>
                                </div>
                                <div className="pr-wb-recommend-compose-result-stat">
                                    <span className="pr-wb-recommend-compose-result-stat-label">总分</span>
                                    <span className="pr-wb-recommend-compose-result-stat-value">
                                        {composeResult.totalScore}
                                    </span>
                                </div>
                            </div>
                            <div className="pr-wb-recommend-compose-result-chart">
                                <div
                                    className="pr-wb-recommend-compose-result-bar"
                                    style={{
                                        gridTemplateColumns: `${composeResult.difficultyChart.easy}fr ${composeResult.difficultyChart.medium}fr ${composeResult.difficultyChart.hard}fr`,
                                    }}
                                >
                                    <span
                                        style={{ backgroundColor: TIER_COLOR.easy }}
                                        title={`易 ${composeResult.difficultyChart.easy}%`}
                                    />
                                    <span
                                        style={{ backgroundColor: TIER_COLOR.medium }}
                                        title={`中 ${composeResult.difficultyChart.medium}%`}
                                    />
                                    <span
                                        style={{ backgroundColor: TIER_COLOR.hard }}
                                        title={`难 ${composeResult.difficultyChart.hard}%`}
                                    />
                                </div>
                            </div>
                        </section>
                    )}
                </div>
            </Modal>
        </div>
    )
})

/* ============================================================
 * 子组件：推荐题卡卡片
 * ============================================================ */

interface RecommendCardProps {
    recommendation: RecommendedQuestion
    onCompose: () => void
}

const RecommendCard = memo(function RecommendCard({ recommendation, onCompose }: RecommendCardProps) {
    const [expanded, setExpanded] = useState(false)
    const bloomColor = WORKBENCH_BLOOM_COLORS[recommendation.bloomLevel]
    const tier = getDifficultyTier(recommendation.difficulty)

    return (
        <li
            className="pr-wb-recommend-card"
            style={{ borderLeftColor: bloomColor }}
        >
            <div className="pr-wb-recommend-card-head">
                <div className="pr-wb-recommend-card-badges">
                    <Badge variant="primary">{recommendation.type}</Badge>
                    <Badge variant="default">
                        {recommendation.bloomLevel}
                    </Badge>
                    <Badge variant="default">
                        <span
                            className="pr-wb-recommend-diff-dot"
                            style={{
                                backgroundColor: TIER_COLOR[tier],
                                display: 'inline-block',
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                marginRight: 4,
                            }}
                        />
                        {TIER_LABEL[tier]} · {recommendation.difficulty}/5
                    </Badge>
                </div>
                <div className="pr-wb-recommend-card-match">
                    <div className="pr-wb-recommend-card-match-ring">
                        <svg viewBox="0 0 36 36" className="pr-wb-recommend-card-match-svg">
                            <circle
                                cx="18"
                                cy="18"
                                r="16"
                                fill="none"
                                stroke="rgba(180, 170, 155, 0.18)"
                                strokeWidth="3"
                            />
                            <circle
                                cx="18"
                                cy="18"
                                r="16"
                                fill="none"
                                stroke="rgb(var(--c-accent-primary))"
                                strokeWidth="3"
                                strokeDasharray={`${(recommendation.matchScore / 100) * 100.5} 100.5`}
                                strokeLinecap="round"
                                transform="rotate(-90 18 18)"
                            />
                        </svg>
                        <span className="pr-wb-recommend-card-match-num">
                            {recommendation.matchScore}
                        </span>
                    </div>
                    <span className="pr-wb-recommend-card-match-label">匹配度</span>
                </div>
            </div>

            <div className="pr-wb-recommend-card-stem">
                <Markdown content={recommendation.stem} />
            </div>

            <div className="pr-wb-recommend-card-reason">
                <Icon name="lightbulb" size={12} />
                <span>{recommendation.reason}</span>
            </div>

            {recommendation.matchedWeakPoints.length > 0 && (
                <div className="pr-wb-recommend-card-kps">
                    {recommendation.matchedWeakPoints.map((kp) => (
                        <span key={kp} className="pr-wb-recommend-card-kp">
                            {kp}
                        </span>
                    ))}
                </div>
            )}

            <div className="pr-wb-recommend-card-actions">
                <button
                    type="button"
                    className="pr-wb-recommend-card-action"
                    onClick={() => setExpanded((v) => !v)}
                >
                    <Icon name={expanded ? 'caret-up' : 'caret-down'} size={12} />
                    <span>{expanded ? '收起详情' : '查看详情'}</span>
                </button>
                <button
                    type="button"
                    className="pr-wb-recommend-card-action pr-wb-recommend-card-action--primary"
                    onClick={onCompose}
                >
                    <Icon name="plus" size={12} />
                    <span>加入组卷</span>
                </button>
            </div>

            {expanded && (
                <div className="pr-wb-recommend-card-detail">
                    <div className="pr-wb-recommend-card-detail-section">
                        <div className="pr-wb-recommend-card-detail-label">答案</div>
                        <div className="pr-wb-recommend-card-detail-body">
                            {recommendation.answer}
                        </div>
                    </div>
                    <div className="pr-wb-recommend-card-detail-section">
                        <div className="pr-wb-recommend-card-detail-label">解析</div>
                        <div className="pr-wb-recommend-card-detail-body">
                            <Markdown content={recommendation.analysis} />
                        </div>
                    </div>
                    {recommendation.options && recommendation.options.length > 0 && (
                        <div className="pr-wb-recommend-card-detail-section">
                            <div className="pr-wb-recommend-card-detail-label">选项</div>
                            <ol className="pr-wb-recommend-card-detail-options">
                                {recommendation.options.map((opt, i) => (
                                    <li key={i}>{opt}</li>
                                ))}
                            </ol>
                        </div>
                    )}
                </div>
            )}
        </li>
    )
})
