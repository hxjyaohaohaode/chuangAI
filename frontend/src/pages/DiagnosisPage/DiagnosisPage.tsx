/**
 * 认知诊断中心主页面（Task 17）
 *
 * 三 Tab 架构：
 * 1. 班级诊断 —— 六阶能力分布柱状图 + 学生×诗×六阶掌握度热力图
 * 2. 学生诊断 —— 左侧学生列表 + 右侧认知画像（六阶雷达 + 漏洞 + 路径）
 * 3. 学习路径 —— D3 力导向图可视化推荐学习路径
 *
 * 数据流：
 * - useDiagnosisStore 提供数据 + 加载态 + 班级/学生选择
 * - useClasses 从后端动态加载班级列表，挂载后默认选中第一个
 * - 班级切换自动重载班级维度数据（六阶分布/热力图）
 * - 学生切换自动重载学生维度数据（画像/漏洞/学习路径）
 *
 * 加载策略（规范第 12 章）：
 * - 首次加载显示骨架屏
 * - 后续刷新保留旧数据，不闪烁
 *
 * 设计要点（规范第 5、8 章）：
 * - 松紧得当：Tab 栏紧带，内容区间稳带
 * - 响应式：平板/移动自适应
 * - 零硬编码色值
 * - 仅 transform/opacity 动画
 */

import { useEffect, useCallback, useRef, type KeyboardEvent } from 'react'
import '@/components/ui/icons-extended'
import { useSearchParams } from 'react-router-dom'
import { Card, Combobox, Icon, VariableProximity, type ComboboxOption } from '@/components/ui'
import { StreamText } from '@/components/ui/StreamText'
import { Radar } from '@/components/ui/Radar'
import { toast } from '@/stores/toast'
import { useDiagnosisStore } from '@/stores/diagnosis'
import { useClasses } from '@/hooks/useClasses'
import { useWSSubscription } from '@/hooks/useWSSubscription'
import type { DiagnosisTab } from '@/lib/types'
import { BloomDistributionChart } from './BloomDistributionChart'
import { ClassHeatmap, type HeatmapCellClickInfo } from './ClassHeatmap'
import { StudentProfilePanel } from './StudentProfilePanel'
import { LearningPathViz } from './LearningPathViz'
import { PrescriptionCard } from './PrescriptionCard'
import { SuggestionPanel } from './SuggestionPanel'
import './DiagnosisPage.css'

/** Tab 配置 */
const TABS: Array<{ key: DiagnosisTab; label: string; icon: string }> = [
    { key: 'class', label: '班级诊断', icon: 'chart-bar' },
    { key: 'student', label: '学生诊断', icon: 'user' },
    { key: 'learning-path', label: '学习路径', icon: 'graph' },
]

export default function DiagnosisPage() {
    const [searchParams] = useSearchParams()
    const urlClassId = searchParams.get('classId')
    const urlStudentId = searchParams.get('studentId')
    const activeTab = useDiagnosisStore((s) => s.activeTab)
    const selectedClassId = useDiagnosisStore((s) => s.selectedClassId)
    const selectedStudentId = useDiagnosisStore((s) => s.selectedStudentId)
    const bloomDistribution = useDiagnosisStore((s) => s.bloomDistribution)
    const heatmapData = useDiagnosisStore((s) => s.heatmapData)
    const heatmapError = useDiagnosisStore((s) => (s.loading.heatmap ? null : s.error))
    const fetchHeatmap = useDiagnosisStore((s) => s.fetchHeatmap)
    const studentList = useDiagnosisStore((s) => s.studentList)
    const studentProfile = useDiagnosisStore((s) => s.studentProfile)
    const studentGaps = useDiagnosisStore((s) => s.studentGaps)
    const learningPath = useDiagnosisStore((s) => s.learningPath)
    const loading = useDiagnosisStore((s) => s.loading)

    // v5.0 学情诊断 5 组件联动：处方 + AI 建议流式状态
    const prescription = useDiagnosisStore((s) => s.prescription)
    const streamingPrescriptionText = useDiagnosisStore((s) => s.streamingPrescriptionText)
    const streamingSuggestionText = useDiagnosisStore((s) => s.streamingSuggestionText)
    const streamingSuggestionReasoning = useDiagnosisStore((s) => s.streamingSuggestionReasoning)
    const suggestionMessages = useDiagnosisStore((s) => s.suggestionMessages)
    const suggestionError = useDiagnosisStore((s) => s.suggestionError)
    const storeError = useDiagnosisStore((s) => s.error)

    const setActiveTab = useDiagnosisStore((s) => s.setActiveTab)
    const selectClass = useDiagnosisStore((s) => s.selectClass)
    const selectStudent = useDiagnosisStore((s) => s.selectStudent)
    const fetchPrescription = useDiagnosisStore((s) => s.fetchPrescription)
    const streamPrescription = useDiagnosisStore((s) => s.streamPrescription)
    const handleWSEvent = useDiagnosisStore((s) => s.handleWSEvent)
    const setWsStatus = useDiagnosisStore((s) => s.setWsStatus)

    // spec v7 Phase 6：Hero ref —— VariableProximity 鼠标距离驱动字重变化的容器
    const heroRef = useRef<HTMLDivElement>(null)

    // v5.0 Task 3.5：订阅全局 wsDispatcher（连接由 App.tsx 统一管理）
    useWSSubscription({
        onEvent: handleWSEvent,
        onStatusChange: setWsStatus,
    })

    const { classes } = useClasses()

    // 班级列表加载后默认选中（v5.0 Task 4.1：URL 参数 classId 优先，其次选第一个）
    useEffect(() => {
        if (urlClassId) {
            if (selectedClassId !== urlClassId) {
                selectClass(urlClassId)
            }
        } else if (!selectedClassId && classes.length > 0) {
            const first = classes[0]
            if (first) selectClass(first.id)
        }
    }, [urlClassId, selectedClassId, classes, selectClass])

    // URL 参数 studentId 预选学生（v5.0 Task 4.1：从 dashboard 预警跳转时透传）
    useEffect(() => {
        if (urlStudentId && selectedStudentId !== urlStudentId) {
            selectStudent(urlStudentId)
            // 自动切换到学生诊断 Tab，直达学生画像
            if (activeTab === 'class') setActiveTab('student')
        }
    }, [urlStudentId, selectedStudentId, selectStudent, activeTab, setActiveTab])

    /** Tab 切换 */
    const handleTabChange = (tab: DiagnosisTab) => {
        setActiveTab(tab)
        // 切换到学生诊断/学习路径 Tab 时，如果没有选中学生，自动选第一个
        if ((tab === 'student' || tab === 'learning-path') && !selectedStudentId && studentList.length > 0) {
            const first = studentList[0]
            if (first) selectStudent(first.id)
        }
    }

    /**
     * 诊断页三项功能区采用真实 tablist 导航，避免只为视觉添加 role 而遗失
     * 键盘方向、Home/End 和唯一焦点停靠点。
     */
    const handleTabKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        // 方向键必须以实际获焦 Tab 为起点，而非仅以异步 store 快照为起点。
        // 懒加载进入诊断页、URL 预选学生或连续按键时，二者有可能在一次渲染间隙
        // 暂时不同步；从事件目标恢复当前项可保证“状态—面板—焦点”始终同源。
        const focusedTab = event.target instanceof Element
            ? event.target.closest<HTMLButtonElement>('[data-diagnosis-tab]')
            : null
        const focusedKey = focusedTab?.dataset.diagnosisTab as DiagnosisTab | undefined
        const currentIndex = TABS.findIndex((tab) => tab.key === (focusedKey ?? activeTab))
        let nextIndex: number
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                nextIndex = (currentIndex + 1) % TABS.length
                break
            case 'ArrowLeft':
            case 'ArrowUp':
                nextIndex = (currentIndex - 1 + TABS.length) % TABS.length
                break
            case 'Home':
                nextIndex = 0
                break
            case 'End':
                nextIndex = TABS.length - 1
                break
            default:
                return
        }
        event.preventDefault()
        // React 在事件分发结束后会清理 currentTarget；异步焦点移动只能捕获此刻
        // 稳定存在的 DOM 容器，绝不能在 requestAnimationFrame 回调中重新读取 event。
        const tablist = event.currentTarget
        const nextTab = TABS[nextIndex]
        if (!nextTab) return
        handleTabChange(nextTab.key)
        // 等 React/Zustand 已提交 aria-selected 与动态面板后再移动焦点，避免视觉
        // 激活和键盘焦点在快速切换或懒加载后分裂为两个状态。
        requestAnimationFrame(() => {
            tablist
                .querySelector<HTMLButtonElement>(`[data-diagnosis-tab="${nextTab.key}"]`)
                ?.focus()
        })
    }

    /** 班级切换 */
    const handleClassChange = (classId: string) => {
        selectClass(classId)
    }

    /** 学生选择（useCallback 防止传递给 memo 子组件时引用变化导致重渲染） */
    const handleSelectStudent = useCallback(
        (studentId: string) => {
            selectStudent(studentId)
        },
        [selectStudent],
    )

    /**
     * 热力图单元格钻取回调（Task 3.3 —— 点击钻取）
     * 切换到学生诊断 Tab 并选中学生，便于教师从班级维度快速下钻到学生个体画像
     */
    const handleHeatmapCellClick = useCallback((info: HeatmapCellClickInfo) => {
        setActiveTab('student')
        selectStudent(info.studentId)
        const scoreText = info.score !== null ? `${Math.round(info.score)} 分` : '未测'
        toast.info({
            title: '已切换至学生诊断',
            message: `${info.studentName} · ${info.poemTitle} · ${info.bloomLevel} · ${scoreText}`,
        })
    }, [setActiveTab, selectStudent])

    /** 学习路径 Tab 切换到学生诊断 Tab（useCallback 防止传递给 memo 子组件 LearningPathViz 时引用变化导致重渲染） */
    const handleSwitchToStudent = useCallback(() => {
        setActiveTab('student')
    }, [setActiveTab])

    const currentClassName = classes.find((c) => c.id === selectedClassId)?.name ?? ''

    return (
        <div className="pr-diagnosis pr-v5-enter-diagnosis">
            {/* v5.0 Hero：认知热力意象 —— 扫描动画
             * spec v7 Phase 6：集成 VariableProximity（标题字重跟随鼠标）+ StreamText（副标题流式输出） */}
            <section
                className="pr-v5-hero pr-v5-hero--diagnosis"
                ref={heroRef}
                aria-label="认知诊断中心概览"
                data-anchor
                data-anchor-label="认知热力"
            >
                <div className="pr-diagnosis-hero-radar" aria-hidden="true">
                    {/* 独立 CSS 雷达装饰：无 Canvas / WebGL、无脚本动画循环。
                     * 颜色直接跟随设计令牌，主题切换不需要运行时转换；
                     * ringCount=4 / spokeCount=6 呼应六阶认知模型的维度数。 */}
                    <Radar
                        speed={0.8}
                        scale={1.2}
                        ringCount={4}
                        spokeCount={6}
                        color="rgb(var(--c-accent-primary))"
                        backgroundColor="rgb(var(--c-surface-primary))"
                        falloff={0.6}
                        brightness={1.1}
                        enableMouseInteraction={false}
                        className="pr-diagnosis-hero-radar-visual"
                    />
                </div>
                <div className="pr-diagnosis-hero-text">
                    <span className="pr-diagnosis-hero-eyebrow pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '0ms' }}>
                        <Icon name="brain" size={12} />
                        <span>认知热力 · 六阶诊断</span>
                    </span>
                    <h1 className="pr-diagnosis-hero-title pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '80ms' }}>
                        {/* spec v7 Phase 6：VariableProximity 鼠标距离驱动字重变化
                         * 严格移植自《优质前端部件组/7_文本显示粗化.md》
                         * gaussian 衰减营造柔和影响半径，与 DashboardPage 风格一致 */}
                        <VariableProximity
                            label="认知诊断中心"
                            fromFontVariationSettings="'wght' 400, 'opsz' 9"
                            toFontVariationSettings="'wght' 700, 'opsz' 40"
                            containerRef={heroRef}
                            radius={140}
                            falloff="gaussian"
                        />
                    </h1>
                    <div className="pr-diagnosis-hero-subtitle pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '160ms' }}>
                        {/* spec v7 Phase 6：StreamText 逐字流式输出，呼应诊断的渐进式揭示
                         * 使用 div 而非 p —— StreamText 根为 div，HTML 规范禁止 div 嵌套于 p 内 */}
                        <StreamText
                            content="六阶认知模型 + 知识图谱深度查询，精准到个体与共性的认知诊断。从六阶能力分布到学生×诗×阶层热力图，一键钻取每位学生的认知漏洞。"
                            charStagger={20}
                            className="pr-diagnosis-hero-stream-text"
                        />
                    </div>
                    <div className="pr-diagnosis-hero-meta pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '240ms' }}>
                        <span className="pr-diagnosis-hero-meta-item">
                            <span className="pr-diagnosis-hero-meta-label">当前班级</span>
                            <span className="pr-diagnosis-hero-meta-value">{currentClassName || '未选择'}</span>
                        </span>
                        <span className="pr-diagnosis-hero-meta-divider" aria-hidden="true" />
                        <span className="pr-diagnosis-hero-meta-item">
                            <span className="pr-diagnosis-hero-meta-label">诊断维度</span>
                            <span className="pr-diagnosis-hero-meta-value">六阶 × 诗篇 × 学生</span>
                        </span>
                    </div>
                </div>
            </section>

            {/* ── 页头 ── */}
            <header
                className="pr-diagnosis-header"
                data-anchor
                data-anchor-label="诊断中心"
            >
                <div className="pr-diagnosis-header-left">
                    <div className="pr-diagnosis-title-row">
                        <Icon name="brain" size={24} />
                        <h2 className="pr-diagnosis-title">认知诊断中心</h2>
                    </div>
                    <p className="pr-diagnosis-subtitle">
                        六阶认知模型 + 知识图谱深度查询 · 精准到个体与共性的认知诊断
                    </p>
                </div>
                <div className="pr-diagnosis-header-right">
                    <label className="pr-diagnosis-class-select-label">
                        <Icon name="graduation" size={14} />
                        <Combobox
                            className="pr-diagnosis-class-select"
                            value={selectedClassId ?? ''}
                            onChange={(v) => handleClassChange(v as string)}
                            ariaLabel="选择班级"
                            placeholder="请选择班级..."
                            options={[
                                { value: '', label: '请选择班级...' },
                                ...classes.map<ComboboxOption>((c) => ({
                                    value: c.id,
                                    label: c.name,
                                })),
                            ]}
                        />
                    </label>
                    {/* v5.0 学情诊断 5 组件联动：学生选择器（驱动画像/漏洞/路径/处方/AI 建议） */}
                    <label className="pr-diagnosis-student-select-label">
                        <Icon name="user" size={14} />
                        <Combobox
                            className="pr-diagnosis-student-select"
                            value={selectedStudentId ?? ''}
                            onChange={(v) => handleSelectStudent(v as string)}
                            ariaLabel="选择学生"
                            placeholder={studentList.length === 0 ? '暂无学生数据' : '请选择学生...'}
                            disabled={studentList.length === 0}
                            searchable
                            options={[
                                { value: '', label: studentList.length === 0 ? '暂无学生数据' : '请选择学生...' },
                                ...studentList.map<ComboboxOption>((s) => ({
                                    value: s.id,
                                    label: s.anonymousName,
                                })),
                            ]}
                        />
                    </label>
                </div>
            </header>

            {/* ── Tab 栏 ── */}
            <nav
                className="pr-diagnosis-tabs"
                role="tablist"
                aria-label="诊断中心功能切换"
                data-anchor
                data-anchor-label="功能切换"
                onKeyDown={handleTabKeyDown}
            >
                {TABS.map((tab) => (
                    <button
                        key={tab.key}
                        id={`pr-diagnosis-tab-${tab.key}`}
                        data-diagnosis-tab={tab.key}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === tab.key}
                        aria-controls="pr-diagnosis-tab-panel"
                        tabIndex={activeTab === tab.key ? 0 : -1}
                        className={`pr-diagnosis-tab ${activeTab === tab.key ? 'is-active' : ''}`}
                        onClick={() => handleTabChange(tab.key)}
                    >
                        <Icon name={tab.icon} size={16} active={activeTab === tab.key} />
                        <span>{tab.label}</span>
                    </button>
                ))}
            </nav>

            {/* ── 内容区 ── */}
            <main
                id="pr-diagnosis-tab-panel"
                className="pr-diagnosis-content"
                role="tabpanel"
                aria-labelledby={`pr-diagnosis-tab-${activeTab}`}
            >
                {activeTab === 'class' && (
                    <div className="pr-diagnosis-tab-content pr-diagnosis-tab-content--class">
                        <Card className="pr-diagnosis-section-card" padding="md">
                            <div className="pr-diagnosis-section-header">
                                <Icon name="chart-bar" size={16} />
                                <h2 className="pr-diagnosis-section-title">
                                    六阶能力分布
                                    <span className="pr-diagnosis-section-subtitle">
                                        {currentClassName}
                                    </span>
                                </h2>
                            </div>
                            <BloomDistributionChart
                                levels={bloomDistribution.levels}
                                loading={loading.bloomDistribution}
                            />
                        </Card>
                        <Card className="pr-diagnosis-section-card" padding="md">
                            <div className="pr-diagnosis-section-header">
                                <Icon name="chart-bar" size={16} />
                                <h2 className="pr-diagnosis-section-title">
                                    班级掌握度热力图
                                    <span className="pr-diagnosis-section-subtitle">
                                        学生 × 诗 × 六阶
                                    </span>
                                </h2>
                            </div>
                            <ClassHeatmap
                                data={heatmapData}
                                loading={loading.heatmap}
                                error={heatmapError ? new Error(heatmapError) : null}
                                onRetry={() => {
                                    if (selectedClassId) void fetchHeatmap(selectedClassId)
                                }}
                                onCellClick={handleHeatmapCellClick}
                            />
                        </Card>
                    </div>
                )}

                {activeTab === 'student' && (
                    <div className="pr-diagnosis-tab-content pr-diagnosis-tab-content--student">
                        {/* 组件 1：学生画像（含学生列表 + 六阶雷达 + 漏洞 + 路径节点） */}
                        <StudentProfilePanel
                            students={studentList}
                            profile={studentProfile}
                            selectedStudentId={selectedStudentId}
                            gaps={studentGaps}
                            loading={loading.studentProfile}
                            onSelectStudent={handleSelectStudent}
                        />

                        {/* v5.0 学情诊断 5 组件联动：处方 + AI 建议（仅选中学生后渲染） */}
                        {selectedStudentId && (
                            <div className="pr-diagnosis-student-extras">
                                {/* 组件 2：个性化处方（玻璃态卡片，七大模块） */}
                                <PrescriptionCard
                                    prescription={prescription}
                                    streamingText={streamingPrescriptionText}
                                    loading={loading.prescription}
                                    error={!prescription && !loading.prescription ? storeError : null}
                                    onRetry={() => {
                                        if (selectedStudentId) void fetchPrescription(selectedStudentId)
                                    }}
                                    onGenerate={() => {
                                        if (selectedStudentId) streamPrescription(selectedStudentId)
                                    }}
                                />

                                {/* 组件 3：AI 教学建议（流式对话，至少 3 轮上下文记忆） */}
                                <SuggestionPanel
                                    studentId={selectedStudentId}
                                    studentName={studentProfile.anonymousName}
                                    studentProfile={studentProfile}
                                    studentGaps={studentGaps}
                                    prescription={prescription}
                                />

                                {/* 调试信息（DEV 模式下展示流式状态，便于排查） */}
                                {import.meta.env.DEV && (
                                    <details className="pr-diagnosis-debug">
                                        <summary>调试信息（仅 DEV 可见）</summary>
                                        <pre>
                                            {JSON.stringify({
                                                selectedStudentId,
                                                prescriptionLoaded: !!prescription,
                                                streamingPrescriptionTextLen: streamingPrescriptionText.length,
                                                suggestionMessagesCount: suggestionMessages.length,
                                                streamingSuggestionTextLen: streamingSuggestionText.length,
                                                streamingSuggestionReasoningLen: streamingSuggestionReasoning.length,
                                                suggestionError,
                                                loadingAiSuggestion: loading.aiSuggestion,
                                                loadingPrescription: loading.prescription,
                                            }, null, 2)}
                                        </pre>
                                    </details>
                                )}
                            </div>
                        )}

                        {/* 未选中学生时的引导态 */}
                        {!selectedStudentId && (
                            <div className="pr-diagnosis-student-empty">
                                <Icon name="user-circle" size={32} />
                                <p className="pr-diagnosis-student-empty-title">请选择一名学生</p>
                                <p className="pr-diagnosis-student-empty-hint">
                                    选择学生后，系统将并行加载学生画像、知识漏洞、学习路径、个性化处方与 AI 教学建议，5 个组件同步刷新。
                                </p>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'learning-path' && (
                    <div className="pr-diagnosis-tab-content pr-diagnosis-tab-content--learning-path">
                        <Card className="pr-diagnosis-section-card" padding="md">
                            <LearningPathViz
                                path={learningPath}
                                anonymousName={studentProfile.anonymousName}
                                loading={loading.learningPath}
                                onSwitchToStudent={handleSwitchToStudent}
                            />
                        </Card>
                    </div>
                )}
            </main>
        </div>
    )
}
