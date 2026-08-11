/**
 * 六阶命题工坊主页面（SubTask 10.8 —— 布局组装）
 *
 * 教师最常用的命题功能入口，组装全部子组件：
 *
 * 布局（桌面三列 / 平板双列 / 移动单列）：
 * - 顶部 Header：页面标题 + WS 状态 + 班级选择器
 * - 左列（窄）：命题表单 WorkbenchForm + 多智能体进度面板 AgentProgressPanel
 * - 中列（宽）：六阶步骤条 BloomStepper + 工具栏 WorkbenchToolbar + 题目卡片列表 QuestionCardList
 * - 右列（窄）：验收结果面板 VerificationPanel
 *
 * 数据流：
 * - useWorkbenchStore 提供表单状态、生成结果、Agent 进度
 * - useWSSubscription 订阅全局 wsDispatcher（连接由 App.tsx 统一管理），事件回流至 store.handleWSEvent
 * - 挂载时自动拉取古诗列表
 * - RefineModal 状态由本页面持有，QuestionCardList 触发微调时打开
 *
 * 设计要点（规范第 5、8、12 章）：
 * - 松紧得当：header 紧带，三列间稳带，列内组件间稳带
 * - 实时数据同步：WS 事件 ≤200ms 触发 store 更新
 * - 响应式：1400px / 900px 双断点切换列数
 * - 流体尺寸：列宽用 clamp()，间距用 tokens 变量
 */

import { useCallback, useEffect, useState, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Card, Combobox, Icon, GlassCard, VariableProximity, type ComboboxOption } from '@/components/ui'
import { StreamText } from '@/components/ui/StreamText'
import '@/components/ui/icons-extended'
import { api } from '@/lib/api'
import { useWorkbenchStore } from '@/stores/workbench'
import { useWSSubscription } from '@/hooks/useWSSubscription'
import { useClasses } from '@/hooks/useClasses'
import { toast } from '@/stores/toast'
import { businessEvents } from '@/lib/business-events'
import { matchesMediaQuery } from '@/lib/media-query'
import type { GradingQuestionOption, WorkbenchQuestion } from '@/lib/types'
import { WorkbenchForm } from './WorkbenchForm'
import { BloomStepper } from './BloomStepper'
import { QuestionCardList } from './QuestionCardList'
import { VerificationPanel } from './VerificationPanel'
import { RefineModal } from './RefineModal'
import { WorkbenchToolbar } from './WorkbenchToolbar'
import { AgentProgressPanel } from './AgentProgressPanel'
import { IntelligentRecommendation } from './IntelligentRecommendation'
import './WorkbenchPage.css'

/** WS 状态中文标签 */
const WS_STATUS_LABELS: Record<string, string> = {
    idle: '未连接',
    connecting: '连接中',
    connected: '实时同步',
    disconnected: '已断开',
    error: '连接异常',
}

export default function WorkbenchPage() {
    const wsStatus = useWorkbenchStore((s) => s.wsStatus)
    const setWsStatus = useWorkbenchStore((s) => s.setWsStatus)
    const handleWSEvent = useWorkbenchStore((s) => s.handleWSEvent)
    const classId = useWorkbenchStore((s) => s.classId)
    const setClassId = useWorkbenchStore((s) => s.setClassId)
    const publishQuestions = useWorkbenchStore((s) => s.publishQuestions)
    const questions = useWorkbenchStore((s) => s.questions)
    const poemId = useWorkbenchStore((s) => s.poemId)
    const generating = useWorkbenchStore((s) => s.generating)
    const hydrateFromURL = useWorkbenchStore((s) => s.hydrateFromURL)
    const navigate = useNavigate()
    /** P6 融合：VariableProximity 容器 ref，Hero 标题字重随鼠标距离变化 */
    const heroMainRef = useRef<HTMLDivElement>(null)
    const questionWorkspaceRef = useRef<HTMLElement>(null)
    const [bankQuestions, setBankQuestions] = useState<GradingQuestionOption[]>([])

    const { classes } = useClasses()

    // 从 URL 读取参数（StarMap 一键靶向练习跳转携带 poemId / tier）
    const [searchParams] = useSearchParams()

    // 挂载时从 URL 恢复参数，自动选中对应古诗
    useEffect(() => {
        const poemId = searchParams.get('poemId') ?? undefined
        const tier = searchParams.get('tier') ?? undefined
        if (poemId || tier) {
            hydrateFromURL({ poemId, tier })
        }
    }, [searchParams, hydrateFromURL])

    useEffect(() => {
        if (!poemId) {
            setBankQuestions([])
            return
        }
        let active = true
        void api.grading.questions(poemId).then((response) => {
            if (active) setBankQuestions(response.questions)
        }).catch(() => {
            if (active) setBankQuestions([])
        })
        return () => { active = false }
    }, [poemId, questions.length])

    // 生成完成后立即把结果工作区带入视野，不要求教师继续向下寻找。
    const previousQuestionCountRef = useRef(questions.length)
    useEffect(() => {
        if (questions.length > 0 && previousQuestionCountRef.current === 0) {
            questionWorkspaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
        previousQuestionCountRef.current = questions.length
    }, [questions.length])

    // 微调弹窗状态
    const [refineOpen, setRefineOpen] = useState(false)
    const [refineTarget, setRefineTarget] = useState<WorkbenchQuestion | null>(null)

    // v5.0 Task 3.4：订阅全局 wsDispatcher
    useWSSubscription({
        onEvent: handleWSEvent,
        onStatusChange: setWsStatus,
    })

    /** 题目卡片触发微调 */
    const handleRefine = useCallback((question: WorkbenchQuestion) => {
        setRefineTarget(question)
        setRefineOpen(true)
    }, [])

    /** 关闭微调弹窗 */
    const handleCloseRefine = useCallback(() => {
        setRefineOpen(false)
    }, [])

    /** 发布闯关：检查班级后调用 store.publishQuestions */
    const handlePublish = useCallback(() => {
        if (!classId) {
            toast.warning({ title: '请先选择班级', message: '发布闯关需指定目标班级' })
            return
        }
        if (questions.length === 0) {
            toast.warning({ title: '无可发布题目', message: '请先生成题目' })
            return
        }
        // 默认发布为六阶沉浸模式（最贴合命题工坊场景）
        void publishQuestions('six-level-immersive')
    }, [classId, questions.length, publishQuestions])

    /** 班级切换 */
    const handleClassChange = useCallback((nextId: string) => {
        setClassId(nextId)
    }, [setClassId])

    /**
     * 首屏只承担“启动任务”的职责：将教师直接带到真正承载诗篇选择的表单控件。
     *
     * 不在 Hero 复制第二个诗篇下拉框，避免两个受控输入的状态、键盘行为和来源提示
     * 出现不同步；复用唯一的 #wb-poem-select，既保证语义单一，也让点击、键盘和
     * 屏幕阅读器都抵达同一个真实命题入口。
     */
    const handleFocusPoemConfiguration = useCallback(() => {
        const target = document.getElementById('wb-poem-select')
        if (!(target instanceof HTMLInputElement) || target.disabled) return

        const reducedMotion = matchesMediaQuery('(prefers-reduced-motion: reduce)')
        target.scrollIntoView({
            behavior: reducedMotion ? 'auto' : 'smooth',
            block: 'center',
        })
        // Combobox 在获得焦点后会打开可选诗篇；preventScroll 防止焦点行为撤销上面的定位。
        window.requestAnimationFrame(() => target.focus({ preventScroll: true }))
    }, [])

    /**
     * v5.0 Task 4.5：发起批改 —— workbench → grading 断点修复
     *
     * 题目生成完成后，教师可一键跳转批改台，将题目带入批改流程。
     * 同时发射 'workbench:question-ready' 业务事件，通知相关 store。
     */
    const handleStartGrading = useCallback(() => {
        if (questions.length === 0) {
            toast.warning({ title: '无可批改题目', message: '请先生成题目' })
            return
        }
        const poemId = questions[0]?.poemId
        if (!poemId) {
            toast.warning({ title: '诗篇信息缺失', message: '题目未关联诗篇，无法跳转' })
            return
        }
        const questionIds = questions.map((q) => q.id)
        // 发射业务事件（通知 dashboard / diagnosis 等订阅者）
        businessEvents.emit('workbench:question-ready', {
            poemId,
            questionIds,
            count: questionIds.length,
        })
        // 跳转批改台，URL 参数透传 poemId + questionIds
        const params = new URLSearchParams({
            poemId,
            questionIds: questionIds.join(','),
            source: 'workbench',
        })
        navigate(`/grading?${params.toString()}`)
    }, [questions, navigate])

    /**
     * 去备课：打通"迭代→备课"教学闭环
     * 题目生成完成后，教师可一键跳转教案工坊，将题目融入教学流程设计。
     * 携带 poemId 透传上下文，教案工坊可基于该诗篇生成教案。
     */
    const handleGoToLessonPlan = useCallback(() => {
        if (questions.length === 0) {
            toast.warning({ title: '请先生成题目', message: '生成题目后方可跳转教案工坊' })
            return
        }
        const poemId = questions[0]?.poemId
        const params = new URLSearchParams()
        if (poemId) params.set('poemId', poemId)
        navigate(`/lesson-plan?${params.toString()}`)
    }, [questions, navigate])

    const wsStatusLabel = WS_STATUS_LABELS[wsStatus] ?? '未连接'
    const wsStatusClass = `pr-wb-ws-status pr-wb-ws-status--${wsStatus}`

    return (
        <div className="pr-wb pr-v5-enter-workbench">
            {/* v5.0 Hero 区 —— 金字塔 3D 透视升起意象（Task A.4）
             * 左侧文字区（eyebrow + 巨型标题 + 副标题 + WS 状态/班级选择）+
             * 右侧装饰性六阶金字塔 SVG（6 层从底到顶逐层缩小），
             * 呼应 pr-v5-enter-workbench 的"金字塔 3D 透视升起"动效。
             * 非对称 1fr : 1.4fr，避免容器对容器对称。 */}
            <section className="pr-v5-hero pr-v5-hero--workbench" aria-label="六阶命题工坊概览" data-anchor data-anchor-label="命题工坊">
                <div
                    ref={heroMainRef}
                    className="pr-v5-hero-main pr-v5-stagger-item"
                    style={{ ['--v5-stagger-delay' as string]: '0ms' }}
                >
                    <span className="pr-wb-hero-eyebrow">
                        <span className="pr-wb-hero-eyebrow-dot" aria-hidden />
                        六阶命题工坊
                    </span>
                    <h1 className="pr-wb-hero-title">
                        <VariableProximity
                            label="六阶命题"
                            fromFontVariationSettings="'wght' 400, 'opsz' 14"
                            toFontVariationSettings="'wght' 700, 'opsz' 36"
                            containerRef={heroMainRef}
                            radius={120}
                            falloff="gaussian"
                        />
                    </h1>
                    <p className="pr-wb-hero-subtitle">
                        多智能体协作 · 按布鲁姆六阶（记忆·理解·应用·分析·评价·创造）精准生成、验收、微调。
                    </p>
                    {generating ? (
                        <StreamText
                            content="正在生成、验收并保存题目；完成后将自动定位到结果工作区。"
                            charStagger={20}
                            charDuration={300}
                            showCursor
                            className="pr-wb-hero-stream"
                        />
                    ) : (
                        <p className="pr-wb-hero-stream">
                            配置、历史题库与生成结果同屏联动；每项配置都直接进入命题请求。
                        </p>
                    )}
                    <div className="pr-wb-hero-actions">
                        <Button
                            className="pr-wb-hero-start"
                            size="md"
                            onClick={handleFocusPoemConfiguration}
                            aria-describedby="wb-hero-start-hint"
                        >
                            选择目标诗篇，开始配置
                        </Button>

                        <span className="pr-wb-hero-action-hint" id="wb-hero-start-hint">
                            第一步：确定命题所依据的诗篇
                        </span>

                        {/* 班级可在生成前选定；不阻塞先配置命题本身。 */}
                        <Combobox
                            className="pr-wb-class-select"
                            value={classId}
                            onChange={(v) => handleClassChange(v as string)}
                            ariaLabel="选择目标班级"
                            placeholder="选择班级"
                            options={[
                                { value: '', label: '选择班级' },
                                ...classes.map<ComboboxOption>((opt) => ({
                                    value: opt.id,
                                    label: opt.name,
                                })),
                            ]}
                        />

                        {/* WS 状态指示器 */}
                        <span className={wsStatusClass} title={`WebSocket: ${wsStatusLabel}`}>
                            <span className="pr-wb-ws-dot" aria-hidden />
                            {wsStatusLabel}
                        </span>
                    </div>
                </div>
                <aside
                    className="pr-v5-hero-stat pr-v5-stagger-item"
                    style={{ ['--v5-stagger-delay' as string]: '80ms' }}
                    aria-label="六阶认知进阶图景"
                >
                    <img
                        className="pr-wb-hero-image"
                        src="/images/generated/workbench-bloom-hero-v1.png"
                        alt=""
                        aria-hidden
                        decoding="async"
                    />
                </aside>
            </section>

            {/* 主体三列网格 */}
            <div className="pr-wb-body">
                {/* 左列：命题表单 + Agent 进度 */}
                <aside className="pr-wb-col pr-wb-col--left" data-anchor data-anchor-label="命题配置">
                    <Card className="pr-wb-form-card" padding="lg">
                        <div className="pr-wb-section-head">
                            <Icon name="faders-horizontal" size={16} />
                            <h2 className="pr-wb-section-title">命题配置</h2>
                        </div>
                        <WorkbenchForm />
                    </Card>

                    <Card className="pr-wb-agent-card" padding="lg">
                        <AgentProgressPanel />
                    </Card>
                </aside>

                {/* 中列：步骤条 + 工具栏 + 题目列表 */}
                <main className="pr-wb-col pr-wb-col--center" ref={questionWorkspaceRef} data-anchor data-anchor-label="题目工作区">
                    {poemId && (
                        <Card className="pr-wb-bank-card" padding="md">
                            <div className="pr-wb-bank-head">
                                <div>
                                    <span>历史题库</span>
                                    <strong>{bankQuestions.length} 道可复用题目</strong>
                                </div>
                                <small>包含课程基线题与教师历史生成题</small>
                            </div>
                            <div className="pr-wb-bank-list">
                                {bankQuestions.slice(0, 12).map((question) => (
                                    <article key={question.id}>
                                        <span>{question.bloomLevel} · {question.type}</span>
                                        <p>{question.stem}</p>
                                    </article>
                                ))}
                            </div>
                        </Card>
                    )}
                    <Card className="pr-wb-stepper-card" padding="md">
                        <BloomStepper />
                    </Card>

                    <Card className="pr-wb-list-card" padding="none" flat>
                        <div className="pr-wb-list-head">
                            <div className="pr-wb-section-head">
                                <Icon name="list" size={16} />
                                <h2 className="pr-wb-section-title">题目列表</h2>
                            </div>
                            <WorkbenchToolbar onPublish={handlePublish} />
                        </div>
                        <div className="pr-wb-list-body">
                            <QuestionCardList onRefine={handleRefine} />
                        </div>
                        {/* v5.0 Task 4.5：发起批改入口 —— 题目就绪后一键跳转批改台 */}
                        {/* 全国一等奖冲刺：去备课入口 —— 打通"迭代→备课"教学闭环 */}
                        {questions.length > 0 && (
                            <div className="pr-wb-list-action">
                                <Button
                                    variant="secondary"
                                    size="md"
                                    leftIcon={<Icon name="pencil-simple-line" size={14} />}
                                    onClick={handleStartGrading}
                                >
                                    发起批改（{questions.length} 题）
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="md"
                                    leftIcon={<Icon name="notebook" size={14} />}
                                    onClick={handleGoToLessonPlan}
                                >
                                    去备课
                                </Button>
                            </div>
                        )}
                    </Card>

                </main>

                {/* 右列：验收结果 */}
                <aside className="pr-wb-col pr-wb-col--right" data-anchor data-anchor-label="验收结果">
                    <GlassCard className="pr-wb-verify-card" padding="lg" blur="normal">
                        <VerificationPanel />
                    </GlassCard>
                </aside>
            </div>

            {/* v5.0 Task 22：智能题卡推荐 —— 基于学生学情数据精准推荐 */}
            <section className="pr-wb-recommend-section" data-anchor data-anchor-label="智能推荐">
                <IntelligentRecommendation />
            </section>

            {/* 微调弹窗 */}
            <RefineModal
                open={refineOpen}
                onClose={handleCloseRefine}
                question={refineTarget}
            />
        </div >
    )
}
