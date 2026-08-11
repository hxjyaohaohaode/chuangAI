import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '@/components/ui'
import '@/components/ui/icons-extended'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import type {
    CreationGradeLevel,
    CreationGradeResponse,
    CreationRecreateResponse,
    CreationTask,
    CreationTaskType,
    CreationWork,
    WorkbenchPoemOption,
} from '@/lib/types'
import './CreationStudioPage.css'

type WorkAction = 'grading' | 'recreating'

const CREATION_TASK_TYPES: ReadonlyArray<{ value: CreationTaskType; label: string; description: string }> = [
    { value: 'illustration', label: '配画', description: '用画面表达诗句意境' },
    { value: 'rewrite', label: '改写', description: '保留诗意，转写为自己的文字' },
    { value: 'video-script', label: '视频脚本', description: '拆解镜头与旁白，完成短片脚本' },
    { value: 'appreciation', label: '鉴赏文', description: '用证据说明理解与感受' },
]

const CREATION_GRADE_LEVELS: readonly CreationGradeLevel[] = ['1-2年级', '3-4年级', '5-6年级']

function readableError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message
    return '服务暂时不可用'
}

function gradingFeedback(result: CreationGradeResponse): string {
    const suggestions = result.grading.improvements.filter(Boolean).join('；')
    return suggestions || result.grading.overallComment
}

function formatDueAt(dueAt: number | null): string {
    if (!dueAt) return '未设截止时间'
    return new Date(dueAt).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

export default function CreationStudioPage() {
    const navigate = useNavigate()
    const teacherId = useAuthStore((state) => state.userId)
    const classId = useAuthStore((state) => state.classId)
    const [tasks, setTasks] = useState<CreationTask[]>([])
    const [works, setWorks] = useState<CreationWork[]>([])
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [actions, setActions] = useState<Record<string, WorkAction | undefined>>({})
    const [actionErrors, setActionErrors] = useState<Record<string, string | undefined>>({})
    const [gradings, setGradings] = useState<Record<string, CreationGradeResponse | undefined>>({})
    const [recreations, setRecreations] = useState<Record<string, CreationRecreateResponse | undefined>>({})
    const [taskComposerOpen, setTaskComposerOpen] = useState(false)
    const [poems, setPoems] = useState<WorkbenchPoemOption[]>([])
    const [poemsLoading, setPoemsLoading] = useState(false)
    const [poemsError, setPoemsError] = useState<string | null>(null)
    const [taskPoemId, setTaskPoemId] = useState('')
    const [taskType, setTaskType] = useState<CreationTaskType>('illustration')
    const [taskGradeLevel, setTaskGradeLevel] = useState<CreationGradeLevel>('3-4年级')
    const [taskRequirements, setTaskRequirements] = useState('')
    const [taskCreating, setTaskCreating] = useState(false)
    const [taskCreateError, setTaskCreateError] = useState<string | null>(null)
    const [taskPublishedMessage, setTaskPublishedMessage] = useState<string | null>(null)

    const load = useCallback(async () => {
        setLoading(true)
        setLoadError(null)
        try {
            const [taskResponse, wallResponse] = await Promise.all([
                api.creation.tasks({ teacherId, classId: classId || undefined }),
                api.creation.wall({ classId: classId || undefined, page: 1, pageSize: 24 }),
            ])
            setTasks(Array.isArray(taskResponse.tasks) ? taskResponse.tasks : [])
            setWorks(Array.isArray(wallResponse.works) ? wallResponse.works : [])
        } catch (error) {
            setLoadError(readableError(error))
            setTasks([])
            setWorks([])
        } finally {
            setLoading(false)
        }
    }, [classId, teacherId])

    useEffect(() => {
        void load()
    }, [load])

    const participantCount = useMemo(
        () => new Set(works.map((work) => work.studentId)).size,
        [works],
    )

    const selectedTaskPoem = useMemo(
        () => poems.find((poem) => poem.id === taskPoemId) ?? null,
        [poems, taskPoemId],
    )

    const loadPoems = useCallback(async () => {
        setPoemsLoading(true)
        setPoemsError(null)
        try {
            const result = await api.workbench.listPoems()
            const nextPoems = Array.isArray(result.poems) ? result.poems : []
            setPoems(nextPoems)
            setTaskPoemId((current) => (
                current && nextPoems.some((poem) => poem.id === current)
                    ? current
                    : nextPoems[0]?.id ?? ''
            ))
            if (nextPoems.length === 0) {
                setPoemsError('当前没有可用于发布创造任务的诗篇，请先在命题工坊核对诗库。')
            }
        } catch (error) {
            setPoems([])
            setTaskPoemId('')
            setPoemsError(`诗篇列表未能加载：${readableError(error)}。请重试或前往命题工坊核对诗库。`)
        } finally {
            setPoemsLoading(false)
        }
    }, [])

    const openTaskComposer = useCallback(() => {
        setTaskComposerOpen(true)
        setTaskCreateError(null)
        setTaskPublishedMessage(null)
        if (poems.length === 0 && !poemsLoading) void loadPoems()
    }, [loadPoems, poems.length, poemsLoading])

    const createTask = async () => {
        const requirements = taskRequirements.trim()
        if (!teacherId) {
            setTaskCreateError('当前教师身份未就绪，不能发布无法追溯归属的任务。请刷新登录状态后重试。')
            return
        }
        if (!selectedTaskPoem) {
            setTaskCreateError('请先选择一首已加载的诗篇。')
            return
        }
        if (requirements.length < 8) {
            setTaskCreateError('请至少写明 8 个字的任务要求，让学生和教师都能理解创作目标。')
            return
        }

        setTaskCreating(true)
        setTaskCreateError(null)
        try {
            const result = await api.creation.createTask({
                poemId: selectedTaskPoem.id,
                poemTitle: selectedTaskPoem.title,
                poet: selectedTaskPoem.poet,
                dynasty: selectedTaskPoem.dynasty,
                type: taskType,
                requirements,
                gradeLevel: taskGradeLevel,
                teacherId,
                ...(classId ? { classId } : {}),
            })
            setTasks((previous) => [
                result.task,
                ...previous.filter((task) => task.id !== result.task.id),
            ])
            setTaskRequirements('')
            setTaskComposerOpen(false)
            setTaskPublishedMessage(`已发布《${result.task.poemTitle}》${result.task.typeLabel}任务；后续学生作品会进入本页的批改与再创作流程。`)
        } catch (error) {
            setTaskCreateError(`任务尚未发布：${readableError(error)}。原有输入仍保留，可检查后重试。`)
        } finally {
            setTaskCreating(false)
        }
    }

    const grade = async (work: CreationWork) => {
        setActions((previous) => ({ ...previous, [work.id]: 'grading' }))
        setActionErrors((previous) => ({ ...previous, [work.id]: undefined }))
        try {
            const result = await api.creation.gradeWork(work.id, { focus: 'overall' })
            setGradings((previous) => ({ ...previous, [work.id]: result }))
            setRecreations((previous) => ({ ...previous, [work.id]: undefined }))
        } catch (error) {
            setActionErrors((previous) => ({
                ...previous,
                [work.id]: `AI 批改未完成：${readableError(error)}。原作品已保留，可重试或转人工评阅。`,
            }))
        } finally {
            setActions((previous) => ({ ...previous, [work.id]: undefined }))
        }
    }

    const recreate = async (work: CreationWork) => {
        const grading = gradings[work.id]
        if (!grading) return
        setActions((previous) => ({ ...previous, [work.id]: 'recreating' }))
        setActionErrors((previous) => ({ ...previous, [work.id]: undefined }))
        try {
            const result = await api.creation.recreateWork(work.id, {
                feedback: gradingFeedback(grading),
                direction: '保留原作品优点，优先修复批改中的关键问题',
            })
            setRecreations((previous) => ({ ...previous, [work.id]: result }))
        } catch (error) {
            setActionErrors((previous) => ({
                ...previous,
                [work.id]: `再创作未完成：${readableError(error)}。批改意见仍然可用，请学生手动迭代或稍后重试。`,
            }))
        } finally {
            setActions((previous) => ({ ...previous, [work.id]: undefined }))
        }
    }

    return (
        <main className="pr-creation-page" data-testid="creation-studio-page">
            <header className="pr-creation-hero">
                <div>
                    <span className="pr-creation-kicker">
                        <Icon name="sparkle" size={16} weight="bold" aria-hidden />
                        课后创造闭环
                    </span>
                    <h1>创作迭代台</h1>
                    <p>把学生作品从“交上来”推进到“有证据地变得更好”，教师全程保留审核权。</p>
                </div>
                <div className="pr-creation-hero-actions">
                    <button
                        className="pr-creation-task-open"
                        type="button"
                        onClick={openTaskComposer}
                        aria-expanded={taskComposerOpen}
                        aria-controls="pr-creation-task-composer"
                    >
                        <Icon name="plus" size={18} weight="bold" aria-hidden />
                        布置创造任务
                    </button>
                    <button className="pr-creation-refresh" type="button" onClick={() => void load()} disabled={loading}>
                        <Icon name="arrows-clockwise" size={18} weight="bold" aria-hidden />
                        {loading ? '同步中' : '同步数据'}
                    </button>
                </div>
            </header>

            {taskPublishedMessage && (
                <p className="pr-creation-published" role="status">
                    <Icon name="check-circle" size={17} weight="bold" aria-hidden />
                    {taskPublishedMessage}
                </p>
            )}

            {taskComposerOpen && (
                <section id="pr-creation-task-composer" className="pr-creation-composer" aria-labelledby="pr-creation-composer-title">
                    <div className="pr-creation-composer-heading">
                        <div>
                            <span>真实发布</span>
                            <h2 id="pr-creation-composer-title">布置创造任务</h2>
                        </div>
                        <button type="button" className="pr-creation-composer-close" onClick={() => setTaskComposerOpen(false)} aria-label="关闭任务发布面板">
                            <Icon name="x" size={18} weight="bold" />
                        </button>
                    </div>
                    <p className="pr-creation-composer-desc">
                        {classId
                            ? '任务会绑定到当前班级范围；发布成功后不会自动伪造学生提交或 AI 成效。'
                            : '当前没有选定班级；任务会保存到教师名下，但不会被表述为已分发给学生。'}
                    </p>

                    <div className="pr-creation-composer-grid">
                        <label className="pr-creation-field">
                            <span>目标诗篇</span>
                            <select
                                id="pr-creation-task-poem"
                                value={taskPoemId}
                                onChange={(event) => setTaskPoemId(event.target.value)}
                                disabled={poemsLoading || poems.length === 0 || taskCreating}
                            >
                                {poems.length === 0 && <option value="">{poemsLoading ? '正在加载诗篇…' : '暂无可选诗篇'}</option>}
                                {poems.map((poem) => (
                                    <option key={poem.id} value={poem.id}>{poem.title} · {poem.poet}（{poem.dynasty}）</option>
                                ))}
                            </select>
                        </label>
                        <label className="pr-creation-field">
                            <span>适用年级</span>
                            <select value={taskGradeLevel} onChange={(event) => setTaskGradeLevel(event.target.value as CreationGradeLevel)} disabled={taskCreating}>
                                {CREATION_GRADE_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                            </select>
                        </label>
                    </div>

                    <fieldset className="pr-creation-task-types" disabled={taskCreating}>
                        <legend>创造形式</legend>
                        <div>
                            {CREATION_TASK_TYPES.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    aria-pressed={taskType === option.value}
                                    className={taskType === option.value ? 'is-selected' : undefined}
                                    onClick={() => setTaskType(option.value)}
                                >
                                    <strong>{option.label}</strong>
                                    <span>{option.description}</span>
                                </button>
                            ))}
                        </div>
                    </fieldset>

                    <label className="pr-creation-field pr-creation-field--requirements" htmlFor="pr-creation-task-requirements">
                        <span>任务要求</span>
                        <textarea
                            id="pr-creation-task-requirements"
                            value={taskRequirements}
                            onChange={(event) => setTaskRequirements(event.target.value)}
                            placeholder="例如：任选一句诗意象，完成一段 80—120 字的改写，并说明你保留了什么、改变了什么。"
                            maxLength={2000}
                            rows={4}
                            disabled={taskCreating}
                        />
                        <small>{taskRequirements.trim().length}/2000 · 要求会原样保存，教师可在后续审核中追溯。</small>
                    </label>

                    {poemsError && (
                        <div className="pr-creation-composer-error" role="alert">
                            <span>{poemsError}</span>
                            <button type="button" onClick={() => void loadPoems()} disabled={poemsLoading}>重试加载诗篇</button>
                        </div>
                    )}
                    {taskCreateError && <p className="pr-creation-composer-error" role="alert">{taskCreateError}</p>}

                    <div className="pr-creation-composer-actions">
                        <button type="button" className="pr-creation-secondary" onClick={() => setTaskComposerOpen(false)} disabled={taskCreating}>暂不发布</button>
                        <button type="button" className="pr-creation-task-submit" onClick={() => void createTask()} disabled={taskCreating || poemsLoading || poems.length === 0}>
                            <Icon name="paper-plane-tilt" size={17} weight="bold" aria-hidden />
                            {taskCreating ? '正在发布' : '确认发布任务'}
                        </button>
                    </div>
                </section>
            )}

            <ol className="pr-creation-flow" aria-label="创造学习闭环">
                {['教师布置创造任务', '学生提交原创作品', 'AI 多维批改', '依反馈再创作'].map((label, index) => (
                    <li key={label}>
                        <span>{index + 1}</span>
                        <strong>{label}</strong>
                    </li>
                ))}
            </ol>

            <section className="pr-creation-metrics" aria-label="创造学习概览">
                <article><span>开放任务</span><strong>{tasks.filter((task) => task.status === 'open').length}</strong></article>
                <article><span>已收作品</span><strong>{works.length}</strong></article>
                <article><span>参与学生</span><strong>{participantCount}</strong></article>
                <article><span>AI 协作作品</span><strong>{works.filter((work) => work.aiAssisted).length}</strong></article>
            </section>

            {tasks.length > 0 && (
                <section className="pr-creation-tasks" aria-labelledby="pr-creation-tasks-title">
                    <div className="pr-creation-tasks-heading">
                        <div><span>任务看板</span><h2 id="pr-creation-tasks-title">已发布的创造任务</h2></div>
                        <button type="button" onClick={openTaskComposer}>继续布置任务</button>
                    </div>
                    <div className="pr-creation-task-list">
                        {tasks.map((task) => (
                            <article className="pr-creation-task-card" key={task.id}>
                                <div>
                                    <span className={task.status === 'open' ? 'is-open' : undefined}>{task.status === 'open' ? '开放中' : '已关闭'}</span>
                                    {task.demoSample && <span className="is-demo">内置演示任务</span>}
                                </div>
                                <h3>《{task.poemTitle}》· {task.typeLabel}</h3>
                                <p>{task.requirements}</p>
                                <footer><span>{task.gradeLevel}</span><span>{formatDueAt(task.dueAt)}</span></footer>
                            </article>
                        ))}
                    </div>
                </section>
            )}

            {loadError && (
                <section className="pr-creation-state is-error" role="alert">
                    <Icon name="warning" size={24} weight="bold" aria-hidden />
                    <div><strong>创作数据未能加载</strong><p>{loadError}。页面未使用虚构成功数据。</p></div>
                    <button type="button" onClick={() => void load()}>重试</button>
                </section>
            )}

            {!loadError && loading && (
                <section className="pr-creation-state" aria-live="polite">
                    <span className="pr-creation-spinner" aria-hidden />
                    <p>正在核对任务与作品数据…</p>
                </section>
            )}

            {!loadError && !loading && works.length === 0 && (
                <section className="pr-creation-state">
                    <Icon name="paint-brush" size={32} weight="bold" aria-hidden />
                    <div>
                        <strong>当前筛选范围内还没有学生作品</strong>
                        <p>可先在课堂或命题工坊发布创造级任务；作品提交后会在此进入批改与再创作闭环。</p>
                    </div>
                    <button type="button" onClick={() => navigate('/workbench')}>前往命题工坊</button>
                </section>
            )}

            {works.some((work) => work.demoSample) && (
                <aside className="pr-creation-demo-note" role="note">
                    <Icon name="info" size={18} weight="bold" aria-hidden />
                    当前展示的是空环境内置交互样例，不代表真实学生数据、AI 结果或教学成效。
                </aside>
            )}

            {works.length > 0 && (
                <section className="pr-creation-section" aria-labelledby="creation-works-title">
                    <div className="pr-creation-section-heading">
                        <div><span>真实作品流</span><h2 id="creation-works-title">待评阅与已迭代作品</h2></div>
                        <p>AI 结果始终显式标注；任何失败都不覆盖学生原作。</p>
                    </div>
                    <div className="pr-creation-grid">
                        {works.map((work) => {
                            const grading = gradings[work.id]
                            const recreation = recreations[work.id]
                            const action = actions[work.id]
                            const actionError = actionErrors[work.id]
                            return (
                                <article className="pr-creation-card" key={work.id}>
                                    <div className="pr-creation-card-topline">
                                        <span>{work.typeLabel}</span>
                                        <span>{work.anonymousName}</span>
                                    </div>
                                    <h3>{work.title}</h3>
                                    <p className="pr-creation-meta">《{work.poemTitle}》· {work.poet}</p>
                                    <div className="pr-creation-original">
                                        <span>学生原作</span>
                                        <p>{work.content}</p>
                                    </div>
                                    <div className="pr-creation-tags">
                                        <span>{work.aiAssisted ? 'AI 协作过程可追溯' : '学生独立创作'}</span>
                                        <span>{work.likeCount} 次认可</span>
                                    </div>

                                    {!grading && (
                                        <button className="pr-creation-primary" type="button" onClick={() => void grade(work)} disabled={Boolean(action)}>
                                            <Icon name="sparkle" size={17} weight="bold" aria-hidden />
                                            {action === 'grading' ? '正在批改' : 'AI 多维批改'}
                                        </button>
                                    )}

                                    {grading && (
                                        <section className="pr-creation-grading" aria-label={`${work.title}批改结果`}>
                                            <div className="pr-creation-score"><strong>{grading.grading.score}</strong><span>{grading.grading.level}<small>{grading.aiGenerated ? 'AI 生成' : '规则化演示'}</small></span></div>
                                            <p>{grading.grading.overallComment}</p>
                                            <div className="pr-creation-feedback-columns">
                                                <div><strong>亮点</strong><ul>{grading.grading.strengths.map((item) => <li key={item}>{item}</li>)}</ul></div>
                                                <div><strong>下一步</strong><ul>{grading.grading.improvements.map((item) => <li key={item}>{item}</li>)}</ul></div>
                                            </div>
                                            <button className="pr-creation-primary" type="button" onClick={() => void recreate(work)} disabled={Boolean(action)}>
                                                <Icon name="arrows-clockwise" size={17} weight="bold" aria-hidden />
                                                {action === 'recreating' ? '正在再创作' : '应用反馈再创作'}
                                            </button>
                                        </section>
                                    )}

                                    {recreation && (
                                        <section className="pr-creation-recreation">
                                            <span>{recreation.aiGenerated ? 'AI 再创作建议' : '规则化演示建议'} · 待教师/学生采纳</span>
                                            <p>{recreation.recreatedContent}</p>
                                        </section>
                                    )}

                                    {actionError && <p className="pr-creation-action-error" role="alert">{actionError}</p>}
                                </article>
                            )
                        })}
                    </div>
                </section>
            )}
        </main>
    )
}
