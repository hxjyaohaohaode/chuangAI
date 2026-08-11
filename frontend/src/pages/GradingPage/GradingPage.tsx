/**
 * GradingPage 智能批改台主页面（SubTask 12.7）
 *
 * 组装全部子组件：
 * - 顶部：标题 + 班级选择 + 阶段指示
 * - GradingStats 统计仪表
 * - 主体网格：
 *   - 左主区：UploadZone → RecognitionResult → GradingTable
 *   - 右侧栏：ReviewPanel（吸顶）
 *
 * 阶段流转：
 *   idle → uploaded → recognizing → recognized → grading → reviewing
 *
 * 设计要点：
 * - 顶部 header 滚动 48px 后切换为玻璃态（由 AppShell 处理）
 * - 主体网格桌面 1fr 360px，平板/移动单列
 * - 阶段指示器用 stepper 可视化
 * - 流体尺寸 clamp() 响应 600-2400px
 */

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { Button, Combobox, Icon, Badge, type ComboboxOption } from '@/components/ui'
import { GlowBorder } from '@/components/ui/GlowBorder'
import { api } from '@/lib/api'
import { useSearchParams } from 'react-router-dom'
import { useGradingStore } from '@/stores/grading'
import { useClasses } from '@/hooks/useClasses'
import type { GradingStage } from '@/stores/grading'
import type {
    GradingQuestionOption,
    GradingStudentOption,
    GradingBatchHistoryItem,
    WorkbenchPoemOption,
} from '@/lib/types'
import { registerGradingIcons } from './icons'
import '@/components/ui/icons-extended'
import { GradingStats } from './GradingStats'
import { UploadZone } from './UploadZone'
import { RecognitionResult } from './RecognitionResult'
import { GradingTable } from './GradingTable'
import { ReviewPanel } from './ReviewPanel'
import { ShowcaseCards } from './ShowcaseCards'
import './GradingPage.css'

/** 阶段步骤定义 */
const STAGES: Array<{ key: GradingStage; label: string; icon: string }> = [
    { key: 'idle', label: '上传', icon: 'upload' },
    { key: 'uploaded', label: '上传', icon: 'upload' },
    { key: 'recognizing', label: '识别', icon: 'eye' },
    { key: 'recognized', label: '识别', icon: 'eye' },
    { key: 'grading', label: '批改', icon: 'pen-nib' },
    { key: 'reviewing', label: '审核', icon: 'check-square' },
]

/** 阶段顺序索引（用于 stepper 高亮） */
const STAGE_ORDER: Record<GradingStage, number> = {
    idle: 0,
    uploaded: 0,
    recognizing: 1,
    recognized: 1,
    grading: 2,
    reviewing: 3,
}

export default function GradingPage() {
    // 注册扩展图标（幂等）
    useEffect(() => {
        registerGradingIcons()
    }, [])

    // 逐字段 selector：避免无关字段变化触发本组件重渲染（B3.2 优化）
    const stage = useGradingStore((s) => s.stage)
    const loading = useGradingStore((s) => s.loading)
    const classId = useGradingStore((s) => s.classId)
    const setClassId = useGradingStore((s) => s.setClassId)
    const recognized = useGradingStore((s) => s.recognized)
    const grade = useGradingStore((s) => s.grade)
    const reset = useGradingStore((s) => s.reset)
    const batchId = useGradingStore((s) => s.batchId)
    const results = useGradingStore((s) => s.results)
    const setContext = useGradingStore((s) => s.setContext)
    const loadBatch = useGradingStore((s) => s.loadBatch)

    const { classes } = useClasses()
    const [searchParams] = useSearchParams()
    const urlPoemId = searchParams.get('poemId') ?? ''
    const urlQuestionId = searchParams.get('questionIds')?.split(',')[0] ?? ''
    const [poems, setPoems] = useState<WorkbenchPoemOption[]>([])
    const [poemId, setPoemId] = useState('')
    const [questions, setQuestions] = useState<GradingQuestionOption[]>([])
    const [students, setStudents] = useState<GradingStudentOption[]>([])
    const [selectedQuestionId, setSelectedQuestionId] = useState('')
    const [currentRecognitionFileId, setCurrentRecognitionFileId] = useState<string | undefined>()
    const [history, setHistory] = useState<GradingBatchHistoryItem[]>([])

    const handleRecognitionTabKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        if (recognized.length === 0) return
        const currentIndex = recognized.findIndex((item) => item.fileId === currentRecognitionFileId)
        const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0
        let nextIndex: number
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                nextIndex = (safeCurrentIndex + 1) % recognized.length
                break
            case 'ArrowLeft':
            case 'ArrowUp':
                nextIndex = (safeCurrentIndex - 1 + recognized.length) % recognized.length
                break
            case 'Home':
                nextIndex = 0
                break
            case 'End':
                nextIndex = recognized.length - 1
                break
            default:
                return
        }
        event.preventDefault()
        const nextItem = recognized[nextIndex]
        if (!nextItem) return
        setCurrentRecognitionFileId(nextItem.fileId)
        event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-grading-recognition-tab="${nextItem.fileId}"]`)
            ?.focus()
    }, [currentRecognitionFileId, recognized])

    useEffect(() => {
        let active = true
        void api.workbench.listPoems().then((response) => {
            if (!active) return
            setPoems(response.poems)
            setPoemId((current) => {
                if (current) return current
                if (urlPoemId && response.poems.some((poem) => poem.id === urlPoemId)) return urlPoemId
                return response.poems[0]?.id || ''
            })
        }).catch(() => undefined)
        return () => { active = false }
    }, [urlPoemId])

    useEffect(() => {
        if (!classId) {
            setStudents([])
            return
        }
        let active = true
        void api.grading.students(classId).then((response) => {
            if (active) setStudents(response.students)
        }).catch(() => {
            if (active) setStudents([])
        })
        return () => { active = false }
    }, [classId])

    useEffect(() => {
        if (!classId) {
            setHistory([])
            return
        }
        let active = true
        void api.grading.history(classId).then((response) => {
            if (active) setHistory(response.batches)
        }).catch(() => {
            if (active) setHistory([])
        })
        return () => { active = false }
    }, [classId, results.length])

    useEffect(() => {
        if (!poemId) {
            setQuestions([])
            return
        }
        let active = true
        void api.grading.questions(poemId).then((response) => {
            if (!active) return
            setQuestions(response.questions)
            setSelectedQuestionId((current) => {
                if (response.questions.some((question) => question.id === current)) return current
                if (urlQuestionId && response.questions.some((question) => question.id === urlQuestionId)) return urlQuestionId
                return response.questions[0]?.id ?? ''
            })
        }).catch(() => {
            if (active) setQuestions([])
        })
        return () => { active = false }
    }, [poemId, urlQuestionId])

    useEffect(() => {
        // 已打开的批次上下文来自服务端权威快照；本地选择器不能在历史批次
        // 加载后的下一次 effect 中把 lessonId/questionId 覆盖掉。
        if (batchId) return
        setContext(undefined, selectedQuestionId || undefined)
    }, [batchId, selectedQuestionId, setContext])

    useEffect(() => {
        if (recognized.length === 0) {
            setCurrentRecognitionFileId(undefined)
            return
        }
        setCurrentRecognitionFileId((current) =>
            recognized.some((item) => item.fileId === current) ? current : recognized[0]?.fileId)
    }, [recognized])

    const currentStep = STAGE_ORDER[stage]

    /** 是否展示识别结果区（有识别数据且阶段 ≥ recognized） */
    const showRecognition = useMemo(
        () => recognized.length > 0 && (stage === 'recognized' || stage === 'grading' || stage === 'reviewing'),
        [recognized.length, stage],
    )

    /** 是否展示批改表格（有结果或阶段 = reviewing） */
    const showTable = useMemo(
        () => stage === 'reviewing' || results.length > 0,
        [stage, results.length],
    )
    const gradingContextComplete = useMemo(
        () => recognized.length > 0 && recognized.every((item) =>
            Boolean(item.questionId && item.studentId && item.studentAnswer.trim())),
        [recognized],
    )

    /** 返回上传阶段（useCallback 防止传递给 memo 子组件 GradingTable 时引用变化导致重渲染） */
    const handleBackToUpload = useCallback(() => {
        // 已建立批次不可复用 /upload 追加文件；回到上传必须完整开启一个新批次。
        reset()
    }, [reset])

    const handleLoadHistory = useCallback(async (item: GradingBatchHistoryItem) => {
        const loaded = await loadBatch(item.batchId)
        if (!loaded) return
        // 只有服务端明确返回的历史上下文才能进入锁定选择器；缺失时保持空值，
        // 不能沿用当前题目冒充旧批次的归档对象。
        setPoemId(item.poemId ?? '')
        setSelectedQuestionId(item.questionId ?? '')
    }, [loadBatch])

    return (
        <div className="pr-grading pr-v5-enter-grading">
            {/* Hero 区：批改流水线意象 —— 试卷堆叠 + 阶段统计 */}
            <section className="pr-grading-hero" aria-labelledby="pr-grading-hero-title" data-anchor data-anchor-label="批改台">
                <div className="pr-grading-hero-stack" aria-hidden="true">
                    {/* 试卷图片堆叠：3 张错落，模拟待批改的试卷 */}
                    <div className="pr-grading-hero-stack-page pr-grading-hero-stack-page--back" />
                    <div className="pr-grading-hero-stack-page pr-grading-hero-stack-page--mid" />
                    <div className="pr-grading-hero-stack-page pr-grading-hero-stack-page--front">
                        <span className="pr-grading-hero-stack-glyph">诗</span>
                    </div>
                    {/* 已移除装饰性「识别」进度环。
                        它 aria-hidden、不绑定任何真实状态，环上的填充比例是写死的，
                        却顶着「识别」二字摆在流程图旁边——教师会以为那是识别进度。
                        批改流程的真实进度由下方 上传→识别→批改→审核 步骤条承担，
                        这里再放一个假进度环既冗余又误导。 */}
                </div>
                <div className="pr-grading-hero-text">
                    <span className="pr-grading-hero-eyebrow pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '0ms' }}>
                        <Icon name="pen-nib" size={14} />
                        <span>智能批改台</span>
                    </span>
                    <h1 id="pr-grading-hero-title" className="pr-grading-hero-title pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '80ms' }}>
                        诗眼识别 · 诗笔批改 · 诗心归因
                    </h1>
                    <p className="pr-grading-hero-subtitle pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '160ms' }}>
                        多模态手写答题批改流水线 · 朱砂批注 · 认知归因
                    </p>
                    <div className="pr-grading-hero-meta pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '240ms' }}>
                        <div className="pr-grading-header-class">
                            <label className="pr-grading-header-class-label">
                                <Icon name="graduation" size={14} />
                                <span>班级</span>
                            </label>
                            <Combobox
                                className="pr-grading-header-class-select"
                                ariaLabel="班级"
                                value={classId}
                                disabled={Boolean(batchId) || loading}
                                onChange={(v) => setClassId(v as string)}
                                placeholder="请选择班级..."
                                options={[
                                    { value: '', label: '请选择班级...' },
                                    ...classes.map<ComboboxOption>((c) => ({
                                        value: c.id,
                                        label: c.name,
                                    })),
                                ]}
                            />
                        </div>
                        <div className="pr-grading-header-class">
                            <label className="pr-grading-header-class-label">
                                <Icon name="book-open" size={14} />
                                <span>诗篇</span>
                            </label>
                            <Combobox
                                className="pr-grading-header-class-select"
                                ariaLabel="诗篇"
                                value={poemId}
                                disabled={Boolean(batchId) || loading}
                                onChange={(v) => setPoemId(v as string)}
                                placeholder="请选择诗篇..."
                                options={poems.map<ComboboxOption>((poem) => ({
                                    value: poem.id,
                                    label: `${poem.title} · ${poem.poet}`,
                                }))}
                            />
                        </div>
                        <div className="pr-grading-header-class pr-grading-header-question">
                            <label className="pr-grading-header-class-label">
                                <Icon name="check-square" size={14} />
                                <span>题目</span>
                            </label>
                            <Combobox
                                className="pr-grading-header-class-select"
                                ariaLabel="目标题目"
                                value={selectedQuestionId}
                                disabled={Boolean(batchId) || loading}
                                onChange={(v) => setSelectedQuestionId(v as string)}
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
                        {batchId && (
                            <Button
                                variant="ghost"
                                size="sm"
                                leftIcon={<Icon name="arrows-clockwise" size={14} />}
                                disabled={loading}
                                onClick={() => reset()}
                            >
                                新建批次
                            </Button>
                        )}
                    </div>
                </div>
            </section>

            {/* 阶段指示器 */}
            <div className="pr-grading-stepper" role="navigation" aria-label="批改流程" data-anchor data-anchor-label="批改流程">
                {STAGES.filter((s, i, arr) => i === 0 || s.label !== arr[i - 1]?.label).map((s, idx) => {
                    const isCompleted = currentStep > idx
                    const isCurrent = currentStep === idx
                    return (
                        <div
                            key={`${s.key}-${idx}`}
                            className={`pr-grading-step ${isCompleted ? 'is-completed' : ''} ${isCurrent ? 'is-current' : ''}`}
                        >
                            <div className="pr-grading-step-icon">
                                <Icon name={s.icon} size={16} active={isCurrent || isCompleted} />
                            </div>
                            <span className="pr-grading-step-label">{s.label}</span>
                            {idx < 3 && <div className="pr-grading-step-connector" />}
                        </div>
                    )
                })}
            </div>

            {/* 主体网格：真实批改任务优先于历史、统计和展示内容，避免首屏主操作被信息卡片挤出视野。 */}
            <div className="pr-grading-body">
                <main className="pr-grading-main" data-anchor data-anchor-label="批改工作区">
                    {/* 上传区（idle / uploaded 阶段显示） */}
                    {(stage === 'idle' || stage === 'uploaded' || stage === 'recognizing') && (
                        <UploadZone />
                    )}

                    {/* 识别结果区（recognized 之后显示） */}
                    {showRecognition && currentRecognitionFileId && (
                        <section className="pr-grading-section">
                            <div className="pr-grading-section-header">
                                <h2 className="pr-grading-section-title">
                                    <Icon name="eye" size={18} />
                                    <span>识别结果</span>
                                </h2>
                                <Badge variant="info">
                                    {recognized.length} 条
                                </Badge>
                            </div>
                            <div className="pr-grading-file-switch" role="tablist" aria-label="逐张作业" onKeyDown={handleRecognitionTabKeyDown}>
                                {recognized.map((item, index) => (
                                    <button
                                        key={item.fileId}
                                        id={`pr-grading-recognition-tab-${item.fileId}`}
                                        data-grading-recognition-tab={item.fileId}
                                        type="button"
                                        role="tab"
                                        aria-selected={item.fileId === currentRecognitionFileId}
                                        aria-controls="pr-grading-recognition-panel"
                                        tabIndex={item.fileId === currentRecognitionFileId ? 0 : -1}
                                        className={item.fileId === currentRecognitionFileId ? 'is-active' : ''}
                                        onClick={() => setCurrentRecognitionFileId(item.fileId)}
                                    >
                                        第 {index + 1} 张
                                        {item.studentId ? <span className="is-linked">已归档</span> : <span>待选学生</span>}
                                    </button>
                                ))}
                            </div>
                            <div
                                id="pr-grading-recognition-panel"
                                role="tabpanel"
                                aria-labelledby={`pr-grading-recognition-tab-${currentRecognitionFileId}`}
                            >
                                <RecognitionResult
                                    fileId={currentRecognitionFileId}
                                    students={students}
                                    questions={questions}
                                />
                            </div>

                            {/* 批改按钮 */}
                            {stage === 'recognized' && (
                                <div className="pr-grading-section-actions">
                                    <Button
                                        variant="primary"
                                        size="lg"
                                        leftIcon={<Icon name="pen-nib" size={18} />}
                                        onClick={() => void grade()}
                                        loading={loading}
                                        disabled={!gradingContextComplete}
                                    >
                                        开始批改
                                    </Button>
                                    <span className="pr-grading-section-actions-hint">
                                        {gradingContextComplete
                                            ? '批改结果将写入学生作答记录、六阶掌握度与错题追踪'
                                            : '请先为每张作业确认学生、题目与识别文本'}
                                    </span>
                                </div>
                            )}
                        </section>
                    )}

                    {/* 批改结果表格 —— GlowBorder 高亮重点区域 */}
                    {showTable && (
                        <GlowBorder active radius={16} color="accent-primary">
                            <section className="pr-grading-section pr-grading-section--glow">
                                <div className="pr-grading-section-header">
                                    <h2 className="pr-grading-section-title">
                                        <Icon name="chart-bar" size={18} />
                                        <span>批改结果</span>
                                    </h2>
                                </div>
                                <GradingTable
                                    onUploadClick={handleBackToUpload}
                                />
                            </section>
                        </GlowBorder>
                    )}
                </main>

                {/* 右侧审核面板 */}
                <aside className="pr-grading-side" data-anchor data-anchor-label="审核面板">
                    <ReviewPanel sticky />
                </aside>
            </div>

            {/* 历史、统计和展示内容属于补充信息：在当前批改工作区之后呈现。 */}
            {history.length > 0 && (
                <section className="pr-grading-history" aria-label="最近批改记录" data-anchor data-anchor-label="历史记录">
                    <div className="pr-grading-history-head">
                        <div>
                            <span>连续记录</span>
                            <h2>最近批改批次</h2>
                        </div>
                        <strong>{history.length} 个批次</strong>
                    </div>
                    <div className="pr-grading-history-list">
                        {history.slice(0, 8).map((item) => (
                            <button
                                key={item.batchId}
                                type="button"
                                className={item.batchId === batchId ? 'is-current' : ''}
                                onClick={() => void handleLoadHistory(item)}
                                disabled={loading}
                            >
                                <span className="pr-grading-history-date">
                                    {new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                                </span>
                                <strong>{item.fileCount} 份作业</strong>
                                <span>
                                    {item.questionStem
                                        ? `题目：${item.questionStem}`
                                        : item.questionId
                                            ? `题目 ID：${item.questionId}`
                                            : '历史题目上下文未保存'}
                                </span>
                                <span>{item.resultCount} 份已批 · {item.reviewedCount} 份已核</span>
                                {item.needsReview > 0
                                    ? <em>{item.needsReview} 份待审核</em>
                                    : <em className="is-done">已完成</em>}
                            </button>
                        ))}
                    </div>
                </section>
            )}

            {/* 统计仪表 */}
            <GradingStats />

            {/* 三卡片展示区（SubTask 23.1-23.3）：CardSwap 轮播 + StackGallery 叠加 + PixelTransition 蒙版 */}
            <ShowcaseCards />
        </div>
    )
}
