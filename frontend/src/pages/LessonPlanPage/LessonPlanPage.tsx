/**
 * 教案工坊主页面（v5.0 SubTask 25 —— 全面重做）
 *
 * 设计依据：
 * - 用户痛点1："教案供方界面非常卡顿" → VirtualList + React.memo + 防抖/节流
 * - 用户痛点2："div div div div div 这些这些做的好丑啊" → 4 Tab 简洁分区
 * - 用户痛点3："img 动态交互能力太差" → 可访问的轻量图片画廊
 *
 * 4 Tab 结构（SubTask 25.1）：
 * 1. 模板：VirtualList 虚拟列表 + Combobox 筛选 + 原生图片画廊预览
 * 2. 生成：AI 流式生成（deepseek-v4-pro）+ 光标脉动 + 中断/继续
 * 3. 预览：AnchorMiniMap + 教案详情完整渲染
 * 4. 导出：PDF / Word / Markdown 三种格式
 *
 * Tab 切换：200ms opacity + translateY 8px 过渡，CSS display:none 不重新渲染
 *
 * 性能优化（SubTask 25.4）：
 * - React.memo 阻断不必要重渲染
 * - useMemo 缓存计算结果
 * - useCallback 稳定回调引用
 * - 防抖搜索 300ms
 * - 节流滚动 100ms（VirtualList 内部）
 * - 懒加载图片
 * - 避免内联对象
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useLessonPlanStore } from '@/stores/lesson-plan'
import { api } from '@/lib/api'
import { toast } from '@/stores/toast'
import { getDisplayError } from '@/lib/errors'
import { useAuthStore } from '@/stores/auth'
import {
    Icon,
    Skeleton,
    Combobox,
    type ComboboxOption,
} from '@/components/ui'
import { StreamText } from '@/components/ui/StreamText'
import { VirtualList } from '@/components/ui/VirtualList'
import { AnchorMiniMap } from '@/components/ui/AnchorMiniMap'
import { QuickVoiceAssist } from '@/components/ui/QuickVoiceAssist'
import { SphereGallery, type SphereGalleryImage } from '@/components/ui/SphereGallery'
import '@/components/ui/icons-extended'
import type {
    LessonPlan,
    LessonPlanTemplate,
    LessonPlanTemplateFilter,
    LessonPlanTemplateSort,
    LessonPlanTemplateGrade,
    LessonPlanTemplateType,
    LessonPlanTemplateDifficulty,
    LessonPlanAIGenerateRequest,
    TeachingGoalCategory,
} from '@/lib/types'
import {
    LESSON_TEMPLATE_GRADE_LABEL,
    LESSON_TEMPLATE_TYPE_LABEL,
    LESSON_TEMPLATE_DIFFICULTY_LABEL,
    TEACHING_GOAL_CATEGORY_LABEL,
} from '@/lib/types'
import './LessonPlanPage.css'

/* ============================================================
 * 常量定义
 * ============================================================ */

/** 4 Tab 类型 */
type LessonPlanTab = 'templates' | 'generate' | 'preview' | 'export'

/** Tab 元数据 */
const TABS: ReadonlyArray<{ id: LessonPlanTab; label: string; icon: string; anchor: string }> = [
    { id: 'templates', label: '模板', icon: 'stack', anchor: 'templates' },
    { id: 'generate', label: '生成', icon: 'sparkles', anchor: 'generate' },
    { id: 'preview', label: '预览', icon: 'eye', anchor: 'preview' },
    { id: 'export', label: '导出', icon: 'download', anchor: 'export' },
]

const KEY_POINT_SUGGESTIONS = [
    '字词理解',
    '有感情朗读',
    '诗句背诵',
    '意象与画面',
    '诗人情感',
    '语言赏析',
] as const

const DURATION_OPTIONS = [30, 35, 40, 45] as const

/** 学段选项 */
const GRADE_OPTIONS: ReadonlyArray<ComboboxOption> = [
    { value: 'low', label: LESSON_TEMPLATE_GRADE_LABEL.low },
    { value: 'middle', label: LESSON_TEMPLATE_GRADE_LABEL.middle },
    { value: 'high', label: LESSON_TEMPLATE_GRADE_LABEL.high },
]

/** 课型选项 */
const TYPE_OPTIONS: ReadonlyArray<ComboboxOption> = [
    { value: 'new', label: LESSON_TEMPLATE_TYPE_LABEL.new },
    { value: 'review', label: LESSON_TEMPLATE_TYPE_LABEL.review },
    { value: 'extension', label: LESSON_TEMPLATE_TYPE_LABEL.extension },
]

/** 难度选项 */
const DIFFICULTY_OPTIONS: ReadonlyArray<ComboboxOption> = [
    { value: 'basic', label: LESSON_TEMPLATE_DIFFICULTY_LABEL.basic },
    { value: 'advanced', label: LESSON_TEMPLATE_DIFFICULTY_LABEL.advanced },
    { value: 'challenge', label: LESSON_TEMPLATE_DIFFICULTY_LABEL.challenge },
]

/** 排序选项 */
const SORT_OPTIONS: ReadonlyArray<ComboboxOption> = [
    { value: 'newest', label: '最新' },
    { value: 'popular', label: '热门' },
    { value: 'duration-asc', label: '时长升序' },
    { value: 'duration-desc', label: '时长降序' },
]

/** 诗篇选项（DEMO 模式可选） */
const POEM_OPTIONS: ReadonlyArray<ComboboxOption> = [
    { value: 'jingyesi', label: '静夜思 · 李白' },
    { value: 'chunxiao', label: '春晓 · 孟浩然' },
    { value: 'denguanguilou', label: '登鹳雀楼 · 王之涣' },
]

/** 防抖延迟（ms） */
const SEARCH_DEBOUNCE_MS = 300

/* ============================================================
 * 主组件
 * ============================================================ */

export function LessonPlanPage() {
    // ── Store 状态 ──
    const lessonPlanList = useLessonPlanStore((s) => s.lessonPlanList)
    const currentLessonPlan = useLessonPlanStore((s) => s.currentLessonPlan)
    const fetchList = useLessonPlanStore((s) => s.fetchList)

    // 模板状态
    const lessonPlanTemplates = useLessonPlanStore((s) => s.lessonPlanTemplates)
    const templateTotal = useLessonPlanStore((s) => s.templateTotal)
    const templateFilter = useLessonPlanStore((s) => s.templateFilter)
    const templateSort = useLessonPlanStore((s) => s.templateSort)
    const currentTemplate = useLessonPlanStore((s) => s.currentTemplate)
    const currentTemplateId = useLessonPlanStore((s) => s.currentTemplateId)
    const loading = useLessonPlanStore((s) => s.loading)
    const fetchTemplates = useLessonPlanStore((s) => s.fetchTemplates)
    const selectTemplate = useLessonPlanStore((s) => s.selectTemplate)
    const setTemplateFilter = useLessonPlanStore((s) => s.setTemplateFilter)
    const setTemplateSort = useLessonPlanStore((s) => s.setTemplateSort)

    // AI 生成状态
    const aiStreamingContent = useLessonPlanStore((s) => s.aiStreamingContent)
    const aiStreamingReasoning = useLessonPlanStore((s) => s.aiStreamingReasoning)
    const isAIGenerating = useLessonPlanStore((s) => s.isAIGenerating)
    const aiGeneratedLessonPlan = useLessonPlanStore((s) => s.aiGeneratedLessonPlan)
    const aiGenerateLessonPlan = useLessonPlanStore((s) => s.aiGenerateLessonPlan)
    const abortAIGenerate = useLessonPlanStore((s) => s.abortAIGenerate)
    const clearAIGenerate = useLessonPlanStore((s) => s.clearAIGenerate)

    // 保存
    const saveLessonPlan = useLessonPlanStore((s) => s.saveLessonPlan)

    const teacherName = useAuthStore((s) => s.teacherName) ?? '王老师'

    // ── URL 参数 ──
    const [searchParams, setSearchParams] = useSearchParams()

    // ── 本地 UI 状态 ──
    const [activeTab, setActiveTab] = useState<LessonPlanTab>(() => {
        const tab = searchParams.get('tab') as LessonPlanTab | null
        return tab && TABS.some((t) => t.id === tab) ? tab : 'templates'
    })

    /** 标准 tablist 键盘模型：选中态、焦点和 URL 状态始终指向同一功能区。 */
    const handleTabKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
        const currentIndex = TABS.findIndex((tab) => tab.id === activeTab)
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
        const nextTab = TABS[nextIndex]
        if (!nextTab) return
        setActiveTab(nextTab.id)
        event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-lesson-plan-tab="${nextTab.id}"]`)
            ?.focus()
    }, [activeTab])

    // 搜索关键词（受控，用于防抖）
    const [searchInput, setSearchInput] = useState<string>(templateFilter.keyword ?? '')
    // AI 生成表单
    const [aiForm, setAIForm] = useState<LessonPlanAIGenerateRequest>({
        poemId: 'jingyesi',
        grade: 'low',
        type: 'new',
        duration: 40,
        keyPoints: [],
        stream: true,
    })
    // 自定义重点知识点输入
    const [keyPointInput, setKeyPointInput] = useState<string>('')
    // 导出格式
    const [exportFormat, setExportFormat] = useState<'pdf' | 'word' | 'markdown'>('pdf')

    // 防抖搜索 ref
    const debounceTimerRef = useRef<number | null>(null)

    // ── 初始化拉取 ──
    useEffect(() => {
        void fetchList()
        void fetchTemplates()
    }, [fetchList, fetchTemplates])

    // ── 同步 activeTab 到 URL ──
    useEffect(() => {
        const next = new URLSearchParams(searchParams)
        next.set('tab', activeTab)
        setSearchParams(next, { replace: true })
    }, [activeTab]) // eslint-disable-line react-hooks/exhaustive-deps

    // ── 防抖搜索 ──
    const handleSearchChange = useCallback(
        (value: string) => {
            setSearchInput(value)
            if (debounceTimerRef.current !== null) {
                window.clearTimeout(debounceTimerRef.current)
            }
            debounceTimerRef.current = window.setTimeout(() => {
                const nextFilter: LessonPlanTemplateFilter = { ...templateFilter, keyword: value || undefined }
                void fetchTemplates(nextFilter)
            }, SEARCH_DEBOUNCE_MS)
        },
        [templateFilter, fetchTemplates],
    )

    // ── 筛选变更 ──
    const handleGradeChange = useCallback(
        (value: string | string[]) => {
            const v = Array.isArray(value) ? value[0] : value
            const nextFilter: LessonPlanTemplateFilter = {
                ...templateFilter,
                grade: (v as LessonPlanTemplateGrade) || undefined,
            }
            setTemplateFilter(nextFilter)
            void fetchTemplates(nextFilter)
        },
        [templateFilter, setTemplateFilter, fetchTemplates],
    )

    const handleTypeChange = useCallback(
        (value: string | string[]) => {
            const v = Array.isArray(value) ? value[0] : value
            const nextFilter: LessonPlanTemplateFilter = {
                ...templateFilter,
                type: (v as LessonPlanTemplateType) || undefined,
            }
            setTemplateFilter(nextFilter)
            void fetchTemplates(nextFilter)
        },
        [templateFilter, setTemplateFilter, fetchTemplates],
    )

    const handleDifficultyChange = useCallback(
        (value: string | string[]) => {
            const v = Array.isArray(value) ? value[0] : value
            const nextFilter: LessonPlanTemplateFilter = {
                ...templateFilter,
                difficulty: (v as LessonPlanTemplateDifficulty) || undefined,
            }
            setTemplateFilter(nextFilter)
            void fetchTemplates(nextFilter)
        },
        [templateFilter, setTemplateFilter, fetchTemplates],
    )

    const handleSortChange = useCallback(
        (value: string | string[]) => {
            const v = Array.isArray(value) ? value[0] : value
            const nextSort = (v as LessonPlanTemplateSort) || 'newest'
            setTemplateSort(nextSort)
            void fetchTemplates(undefined, nextSort)
        },
        [setTemplateSort, fetchTemplates],
    )

    // ── 模板选择 ──
    const handleSelectTemplate = useCallback(
        (templateId: string) => {
            void selectTemplate(templateId)
        },
        [selectTemplate],
    )

    // ── 套用模板（跳转到生成 Tab 并预填） ──
    const handleApplyTemplate = useCallback(
        (template: LessonPlanTemplate) => {
            setAIForm((prev) => ({
                ...prev,
                grade: template.grade,
                type: template.type,
                duration: template.duration,
                templateId: template.id,
                keyPoints: [],
            }))
            setActiveTab('generate')
        },
        [],
    )

    // ── AI 生成 ──
    const handleAIGenerate = useCallback(async () => {
        const success = await aiGenerateLessonPlan(aiForm)
        if (success) {
            // 完成后跳转预览 Tab
            setActiveTab('preview')
        }
    }, [aiGenerateLessonPlan, aiForm])

    const handleAbortAI = useCallback(() => {
        abortAIGenerate()
    }, [abortAIGenerate])

    const handleClearAI = useCallback(() => {
        clearAIGenerate()
    }, [clearAIGenerate])

    // ── AI 表单变更 ──
    const handleAIFormChange = useCallback(<K extends keyof LessonPlanAIGenerateRequest>(
        key: K,
        value: LessonPlanAIGenerateRequest[K],
    ) => {
        setAIForm((prev) => ({ ...prev, [key]: value }))
    }, [])

    const handleAddKeyPoint = useCallback(() => {
        const trimmed = keyPointInput.trim()
        if (!trimmed) return
        setAIForm((prev) => ({
            ...prev,
            keyPoints: [...(prev.keyPoints ?? []), trimmed],
        }))
        setKeyPointInput('')
    }, [keyPointInput])

    const handleRemoveKeyPoint = useCallback((idx: number) => {
        setAIForm((prev) => ({
            ...prev,
            keyPoints: (prev.keyPoints ?? []).filter((_, i) => i !== idx),
        }))
    }, [])

    // ── 导出 ──
    /**
     * 导出教案
     *
     * 走后端 POST /api/lesson-plan/:id/export，由后端渲染完整教案正文
     * （教学目标、分层设计、教学过程、板书、作业、反思）。
     *
     * 三种格式的落地方式：
     * - markdown → 直接下载 .md
     * - word     → 下载 Word 兼容 HTML（.doc，Word 可直接打开并编辑）
     * - pdf      → 取后端 html 渲染结果，在新窗口调起浏览器打印对话框另存为 PDF
     *              （不引入前端 PDF 库；浏览器打印是保真度最高且零体积成本的路径）
     */
    const handleExport = useCallback(async () => {
        if (!currentLessonPlan) return

        // UI 的 pdf 选项映射到后端的 html 渲染
        const backendFormat = exportFormat === 'pdf' ? 'html' : exportFormat

        try {
            const res = await api.lessonPlan.exportPlan(currentLessonPlan.id, backendFormat)
            if (!res.success || !res.content) {
                toast.error({ title: '导出失败', message: '后端未返回教案内容，请稍后重试' })
                return
            }

            if (exportFormat === 'pdf') {
                const win = window.open('', '_blank')
                if (!win) {
                    toast.warning({ title: '弹窗被拦截', message: '请允许本站弹窗后重试，或改用 Word / Markdown 导出' })
                    return
                }
                win.document.write(res.content)
                win.document.close()
                // 等排版稳定后再唤起打印，避免打印出半渲染的页面
                win.addEventListener('load', () => win.print(), { once: true })
                toast.success({ title: '已生成打印视图', message: '在打印对话框中选择「另存为 PDF」即可' })
                return
            }

            const ext = exportFormat === 'word' ? 'doc' : 'md'
            const blob = new Blob([res.content], { type: `${res.mimeType};charset=utf-8` })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `${res.fileName || currentLessonPlan.title}.${ext}`
            a.click()
            URL.revokeObjectURL(url)
            toast.success({ title: '导出完成', message: `已下载 ${a.download}` })
        } catch (err) {
            toast.error({ title: '导出失败', message: getDisplayError(err, '请稍后重试') })
        }
    }, [currentLessonPlan, exportFormat])

    // ── 模板图片画廊：保留模板身份和可读名称，缺图时仍可预览与套用 ──
    const templatePreviewImages = useMemo<SphereGalleryImage[]>(() => {
        return lessonPlanTemplates.map((template) => ({
            id: template.id,
            src: template.thumbnail ?? null,
            alt: template.title,
            caption: `${LESSON_TEMPLATE_GRADE_LABEL[template.grade]} · ${LESSON_TEMPLATE_TYPE_LABEL[template.type]} · ${template.duration} 分钟`,
        }))
    }, [lessonPlanTemplates])

    // ── 渲染 ──
    return (
        <div className="pr-lp">
            {/* ── Header ── */}
            <header className="pr-lp-header" data-anchor="lesson-plan-header" data-anchor-label="工坊总览">
                <div className="pr-lp-header-left">
                    <span className="pr-lp-header-eyebrow">
                        <Icon name="sparkles" size={12} />
                        <span>教师备课 · 教案工坊</span>
                    </span>
                    <h1 className="pr-lp-header-title">教案工坊</h1>
                    <p className="pr-lp-header-subtitle">
                        从模板选择到 AI 生成，从预览到导出，一站式完成备课
                    </p>
                </div>
                <div className="pr-lp-header-right">
                    <span className="pr-lp-header-stat">
                        <span className="pr-lp-header-stat-num">{templateTotal}</span>
                        <span className="pr-lp-header-stat-label">模板</span>
                    </span>
                    <span className="pr-lp-header-stat">
                        <span className="pr-lp-header-stat-num">{lessonPlanList.length}</span>
                        <span className="pr-lp-header-stat-label">已备教案</span>
                    </span>
                </div>
            </header>

            {/* ── Tab 导航 ── */}
            <nav
                className="pr-lp-tabs"
                role="tablist"
                aria-label="教案工坊功能区"
                onKeyDown={handleTabKeyDown}
            >
                {TABS.map((tab) => {
                    const isActive = activeTab === tab.id
                    return (
                        <button
                            key={tab.id}
                            data-lesson-plan-tab={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            aria-controls={`pr-lp-panel-${tab.id}`}
                            id={`pr-lp-tab-${tab.id}`}
                            tabIndex={isActive ? 0 : -1}
                            className={`pr-lp-tab ${isActive ? 'pr-lp-tab--active' : ''}`}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            <Icon name={tab.icon} size={14} />
                            <span>{tab.label}</span>
                        </button>
                    )
                })}
            </nav>

            {/* ── Tab 面板（display:none 切换，不重新渲染） ── */}
            <div className="pr-lp-panels">
                {/* Tab 1: 模板 */}
                <section
                    id="pr-lp-panel-templates"
                    role="tabpanel"
                    aria-labelledby="pr-lp-tab-templates"
                    data-anchor="templates"
                    data-anchor-label="模板库"
                    className={`pr-lp-panel ${activeTab === 'templates' ? 'pr-lp-panel--active' : ''}`}
                >
                    <TemplatesPanel
                        // 数据
                        templates={lessonPlanTemplates}
                        total={templateTotal}
                        loading={!!loading.templates}
                        filter={templateFilter}
                        sort={templateSort}
                        searchInput={searchInput}
                        currentTemplateId={currentTemplateId}
                        currentTemplate={currentTemplate}
                        templatePreviewImages={templatePreviewImages}
                        // 回调
                        onSearchChange={handleSearchChange}
                        onGradeChange={handleGradeChange}
                        onTypeChange={handleTypeChange}
                        onDifficultyChange={handleDifficultyChange}
                        onSortChange={handleSortChange}
                        onSelectTemplate={handleSelectTemplate}
                        onApplyTemplate={handleApplyTemplate}
                    />
                </section>

                {/* Tab 2: 生成 */}
                <section
                    id="pr-lp-panel-generate"
                    role="tabpanel"
                    aria-labelledby="pr-lp-tab-generate"
                    data-anchor="generate"
                    data-anchor-label="AI 生成"
                    className={`pr-lp-panel ${activeTab === 'generate' ? 'pr-lp-panel--active' : ''}`}
                >
                    <GeneratePanel
                        // 表单
                        form={aiForm}
                        keyPointInput={keyPointInput}
                        // 流式状态
                        streamingContent={aiStreamingContent}
                        streamingReasoning={aiStreamingReasoning}
                        isGenerating={isAIGenerating}
                        generatedPlan={aiGeneratedLessonPlan}
                        // 回调
                        onFormChange={handleAIFormChange}
                        onKeyPointInputChange={setKeyPointInput}
                        onAddKeyPoint={handleAddKeyPoint}
                        onRemoveKeyPoint={handleRemoveKeyPoint}
                        onGenerate={handleAIGenerate}
                        onAbort={handleAbortAI}
                        onClear={handleClearAI}
                    />
                </section>

                {/* Tab 3: 预览 */}
                <section
                    id="pr-lp-panel-preview"
                    role="tabpanel"
                    aria-labelledby="pr-lp-tab-preview"
                    data-anchor="preview"
                    data-anchor-label="教案预览"
                    className={`pr-lp-panel ${activeTab === 'preview' ? 'pr-lp-panel--active' : ''}`}
                >
                    <PreviewPanel
                        plan={currentLessonPlan}
                        teacherName={teacherName}
                        isSaving={!!loading.save}
                        onSave={saveLessonPlan}
                    />
                </section>

                {/* Tab 4: 导出 */}
                <section
                    id="pr-lp-panel-export"
                    role="tabpanel"
                    aria-labelledby="pr-lp-tab-export"
                    data-anchor="export"
                    data-anchor-label="导出教案"
                    className={`pr-lp-panel ${activeTab === 'export' ? 'pr-lp-panel--active' : ''}`}
                >
                    <ExportPanel
                        plan={currentLessonPlan}
                        format={exportFormat}
                        onFormatChange={setExportFormat}
                        onExport={handleExport}
                    />
                </section>
            </div>

            {/* ── AnchorMiniMap（章节导航） ── */}
            <AnchorMiniMap containerSelector=".pr-lp" />
        </div>
    )
}

/* ============================================================
 * Tab 1: 模板面板
 * ============================================================ */

interface TemplatesPanelProps {
    templates: LessonPlanTemplate[]
    total: number
    loading: boolean
    filter: LessonPlanTemplateFilter
    sort: LessonPlanTemplateSort
    searchInput: string
    currentTemplateId: string | null
    currentTemplate: LessonPlanTemplate | null
    templatePreviewImages: SphereGalleryImage[]
    onSearchChange: (value: string) => void
    onGradeChange: (value: string | string[]) => void
    onTypeChange: (value: string | string[]) => void
    onDifficultyChange: (value: string | string[]) => void
    onSortChange: (value: string | string[]) => void
    onSelectTemplate: (templateId: string) => void
    onApplyTemplate: (template: LessonPlanTemplate) => void
}

const TemplatesPanel = memo(function TemplatesPanel({
    templates,
    total,
    loading,
    filter,
    sort,
    searchInput,
    currentTemplateId,
    currentTemplate,
    templatePreviewImages,
    onSearchChange,
    onGradeChange,
    onTypeChange,
    onDifficultyChange,
    onSortChange,
    onSelectTemplate,
    onApplyTemplate,
}: TemplatesPanelProps) {
    // 渲染单个模板项（80px 高度）
    const renderItem = useCallback(
        (item: LessonPlanTemplate, index: number) => {
            const isActive = item.id === currentTemplateId
            return (
                <button
                    type="button"
                    className={`pr-lp-tpl-item ${isActive ? 'pr-lp-tpl-item--active' : ''}`}
                    onClick={() => onSelectTemplate(item.id)}
                    aria-pressed={isActive}
                >
                    <div className="pr-lp-tpl-item-rank">#{index + 1}</div>
                    <div className="pr-lp-tpl-item-body">
                        <div className="pr-lp-tpl-item-title">{item.title}</div>
                        <div className="pr-lp-tpl-item-meta">
                            <span>{LESSON_TEMPLATE_GRADE_LABEL[item.grade]}</span>
                            <span className="pr-lp-tpl-item-dot" />
                            <span>{LESSON_TEMPLATE_TYPE_LABEL[item.type]}</span>
                            <span className="pr-lp-tpl-item-dot" />
                            <span>{LESSON_TEMPLATE_DIFFICULTY_LABEL[item.difficulty]}</span>
                            <span className="pr-lp-tpl-item-dot" />
                            <span>{item.duration} 分钟</span>
                        </div>
                    </div>
                    <Icon name="chevron-right" size={14} className="pr-lp-tpl-item-arrow" />
                </button>
            )
        },
        [currentTemplateId, onSelectTemplate],
    )

    // getKey 用于 React diff
    const getKey = useCallback((item: LessonPlanTemplate) => item.id, [])

    // 空状态
    const renderEmpty = useCallback(
        () => (
            <div className="pr-lp-tpl-empty">
                <Icon name="stack" size={32} />
                <span>暂无匹配模板</span>
                <span className="pr-lp-tpl-empty-hint">尝试调整筛选条件或搜索关键词</span>
            </div>
        ),
        [],
    )

    // 加载态
    const renderLoading = useCallback(
        () => (
            <div className="pr-lp-tpl-loading">
                {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} width="100%" height={80} style={{ marginBottom: 8 }} />
                ))}
            </div>
        ),
        [],
    )

    const currentTemplatePreviewIndex = currentTemplate
        ? templatePreviewImages.findIndex((image) => image.id === currentTemplate.id)
        : -1

    return (
        <div className="pr-lp-tpl-panel">
            {/* 左侧：筛选 + VirtualList */}
            <div className="pr-lp-tpl-left">
                {/* 搜索框 */}
                <div className="pr-lp-tpl-search">
                    <Icon name="search" size={14} className="pr-lp-tpl-search-icon" />
                    <input
                        type="search"
                        className="pr-lp-tpl-search-input"
                        placeholder="搜索模板标题、描述、关键词..."
                        value={searchInput}
                        onChange={(e) => onSearchChange(e.target.value)}
                        aria-label="搜索模板"
                    />
                </div>

                {/* 筛选行 */}
                <div className="pr-lp-tpl-filters">
                    <Combobox
                        options={[...GRADE_OPTIONS]}
                        value={filter.grade ?? ''}
                        onChange={onGradeChange}
                        placeholder="学段"
                        className="pr-lp-tpl-filter"
                        ariaLabel="按学段筛选"
                    />
                    <Combobox
                        options={[...TYPE_OPTIONS]}
                        value={filter.type ?? ''}
                        onChange={onTypeChange}
                        placeholder="课型"
                        className="pr-lp-tpl-filter"
                        ariaLabel="按课型筛选"
                    />
                    <Combobox
                        options={[...DIFFICULTY_OPTIONS]}
                        value={filter.difficulty ?? ''}
                        onChange={onDifficultyChange}
                        placeholder="难度"
                        className="pr-lp-tpl-filter"
                        ariaLabel="按难度筛选"
                    />
                    <Combobox
                        options={[...SORT_OPTIONS]}
                        value={sort}
                        onChange={onSortChange}
                        placeholder="排序"
                        className="pr-lp-tpl-filter"
                        ariaLabel="排序方式"
                    />
                </div>

                {/* 统计 */}
                <div className="pr-lp-tpl-stat">
                    <span>共 {total} 个模板</span>
                </div>

                {/* VirtualList */}
                <VirtualList<LessonPlanTemplate>
                    items={templates}
                    itemHeight={80}
                    buffer={5}
                    containerHeight="calc(100vh - 320px)"
                    renderItem={renderItem}
                    getKey={getKey}
                    renderEmpty={renderEmpty}
                    renderLoading={renderLoading}
                    loading={loading}
                />
            </div>

            {/* 右侧：模板详情 + 轻量图片预览 */}
            <div className="pr-lp-tpl-right">
                {currentTemplate ? (
                    <div className="pr-lp-tpl-detail">
                        <div className="pr-lp-tpl-detail-header">
                            <h3 className="pr-lp-tpl-detail-title">{currentTemplate.title}</h3>
                            <button
                                type="button"
                                className="pr-lp-tpl-detail-apply"
                                onClick={() => onApplyTemplate(currentTemplate)}
                            >
                                <Icon name="sparkles" size={12} />
                                <span>套用此模板</span>
                            </button>
                        </div>
                        <div className="pr-lp-tpl-detail-meta">
                            <span>{LESSON_TEMPLATE_GRADE_LABEL[currentTemplate.grade]}</span>
                            <span>{LESSON_TEMPLATE_TYPE_LABEL[currentTemplate.type]}</span>
                            <span>{LESSON_TEMPLATE_DIFFICULTY_LABEL[currentTemplate.difficulty]}</span>
                            <span>{currentTemplate.duration} 分钟</span>
                        </div>
                        <p className="pr-lp-tpl-detail-desc">{currentTemplate.description}</p>

                        {/* 原生 scroll-snap 画廊：可键盘、触控与失败降级 */}
                        {templatePreviewImages.length > 0 && (
                            <div className="pr-lp-tpl-sphere">
                                <SphereGallery
                                    images={templatePreviewImages}
                                    activation="preview"
                                    ariaLabel="教案模板图片预览"
                                    selectedIndex={currentTemplatePreviewIndex >= 0 ? currentTemplatePreviewIndex : null}
                                    focusIndex={currentTemplatePreviewIndex >= 0 ? currentTemplatePreviewIndex : null}
                                    className="pr-lp-tpl-gallery"
                                />
                            </div>
                        )}

                        {/* 章节预览 */}
                        <div className="pr-lp-tpl-sections">
                            <h4 className="pr-lp-tpl-sections-title">教学环节</h4>
                            <ol className="pr-lp-tpl-sections-list">
                                {currentTemplate.sections.map((section, idx) => (
                                    <li key={idx} className="pr-lp-tpl-section">
                                        <div className="pr-lp-tpl-section-num">{idx + 1}</div>
                                        <div className="pr-lp-tpl-section-body">
                                            <div className="pr-lp-tpl-section-title">{section.title}</div>
                                            <div className="pr-lp-tpl-section-content">{section.content}</div>
                                        </div>
                                    </li>
                                ))}
                            </ol>
                        </div>

                        {/* 适用关键词 */}
                        {currentTemplate.applicableKeywords && currentTemplate.applicableKeywords.length > 0 && (
                            <div className="pr-lp-tpl-keywords">
                                <span className="pr-lp-tpl-keywords-label">适用：</span>
                                {currentTemplate.applicableKeywords.map((kw) => (
                                    <span key={kw} className="pr-lp-tpl-keyword">{kw}</span>
                                ))}
                            </div>
                        )}
                    </div>
                ) : (
                    <TemplateStartPanel
                        templates={templates}
                        total={total}
                        onSelectTemplate={onSelectTemplate}
                    />
                )}
            </div>
        </div>
    )
})

/**
 * 未选模板时的工作台引导。
 *
 * 这是一个真实的起始状态而不是装饰性空白：明确展示“选择→生成→预览→导出”的
 * 现有功能路径，并只在有真实模板数据时提供“查看第一个模板”的安全入口。
 */
function TemplateStartPanel({
    templates,
    total,
    onSelectTemplate,
}: {
    templates: LessonPlanTemplate[]
    total: number
    onSelectTemplate: (templateId: string) => void
}) {
    const firstTemplate = templates[0]
    const steps: ReadonlyArray<{ icon: string; label: string; detail: string }> = [
        { icon: 'stack', label: '选择模板', detail: '按学段、课型与难度筛选' },
        { icon: 'sparkles', label: '生成教案', detail: '预填备课参数后再由教师确认' },
        { icon: 'eye', label: '审阅内容', detail: '逐段核对目标、活动与评价' },
        { icon: 'download', label: '按需导出', detail: '提供 PDF、Word 与 Markdown' },
    ]

    return (
        <section className="pr-lp-tpl-start" aria-label="教案工坊起始引导">
            <div className="pr-lp-tpl-start-head">
                <span className="pr-lp-tpl-start-eyebrow">
                    <Icon name="compass" size={14} />
                    <span>备课起始页</span>
                </span>
                <h3>先选一份教学骨架，再把课堂经验写进去</h3>
                <p>
                    左侧每一份模板都可先查看教学环节与适用范围；套用后才进入生成，
                    全程保留教师的审阅与修改权。
                </p>
            </div>

            <ol className="pr-lp-tpl-start-steps">
                {steps.map((step, index) => (
                    <li key={step.label} className="pr-lp-tpl-start-step">
                        <span className="pr-lp-tpl-start-step-index">0{index + 1}</span>
                        <span className="pr-lp-tpl-start-step-icon"><Icon name={step.icon} size={16} /></span>
                        <span className="pr-lp-tpl-start-step-body">
                            <strong>{step.label}</strong>
                            <span>{step.detail}</span>
                        </span>
                    </li>
                ))}
            </ol>

            <div className="pr-lp-tpl-start-footer">
                <span className="pr-lp-tpl-start-count">
                    <Icon name="stack" size={14} />
                    <span>当前可浏览 {total} 份模板</span>
                </span>
                {firstTemplate ? (
                    <button
                        type="button"
                        className="pr-lp-tpl-start-action"
                        onClick={() => onSelectTemplate(firstTemplate.id)}
                    >
                        <span>查看「{firstTemplate.title}」</span>
                        <Icon name="arrow-right" size={14} />
                    </button>
                ) : (
                    <span className="pr-lp-tpl-start-wait" role="status">模板加载后可在此预览</span>
                )}
            </div>
        </section>
    )
}

/* ============================================================
 * Tab 2: 生成面板
 * ============================================================ */

interface GeneratePanelProps {
    form: LessonPlanAIGenerateRequest
    keyPointInput: string
    streamingContent: string
    streamingReasoning: string
    isGenerating: boolean
    generatedPlan: LessonPlan | null
    onFormChange: <K extends keyof LessonPlanAIGenerateRequest>(key: K, value: LessonPlanAIGenerateRequest[K]) => void
    onKeyPointInputChange: (value: string) => void
    onAddKeyPoint: () => void
    onRemoveKeyPoint: (idx: number) => void
    onGenerate: () => void
    onAbort: () => void
    onClear: () => void
}

const GeneratePanel = memo(function GeneratePanel({
    form,
    keyPointInput,
    streamingContent,
    streamingReasoning,
    isGenerating,
    generatedPlan,
    onFormChange,
    onKeyPointInputChange,
    onAddKeyPoint,
    onRemoveKeyPoint,
    onGenerate,
    onAbort,
    onClear,
}: GeneratePanelProps) {
    // 思考过程是否可见（默认可见，流式输出时折叠）
    const [showReasoning, setShowReasoning] = useState(true)

    const addKeyPointDirectly = useCallback((keyPoint: string) => {
        const normalized = keyPoint.trim()
        if (!normalized) return
        const current = form.keyPoints ?? []
        if (current.includes(normalized)) {
            toast.info({ title: '知识点已添加', message: normalized })
            return
        }
        onFormChange('keyPoints', [...current, normalized])
    }, [form.keyPoints, onFormChange])

    return (
        <div className="pr-lp-gen-panel">
            {/* 左侧：表单 */}
            <div className="pr-lp-gen-form">
                <h3 className="pr-lp-gen-form-title">
                    <Icon name="sparkles" size={14} />
                    <span>AI 教案生成</span>
                </h3>
                <p className="pr-lp-gen-form-desc">
                    基于 deepseek-v4-pro 模型，支持流式输出与思考过程展示
                </p>

                {/* 诗篇选择 */}
                <div className="pr-lp-gen-field">
                    <label className="pr-lp-gen-label">诗篇</label>
                    <Combobox
                        options={[...POEM_OPTIONS]}
                        value={form.poemId ?? ''}
                        onChange={(v) => onFormChange('poemId', Array.isArray(v) ? v[0] : v)}
                        placeholder="选择诗篇"
                        ariaLabel="选择诗篇"
                    />
                </div>

                {/* 学段 */}
                <div className="pr-lp-gen-field">
                    <label className="pr-lp-gen-label">学段</label>
                    <Combobox
                        options={[...GRADE_OPTIONS]}
                        value={form.grade}
                        onChange={(v) => onFormChange('grade', (Array.isArray(v) ? v[0] : v) as LessonPlanTemplateGrade)}
                        placeholder="选择学段"
                        ariaLabel="选择学段"
                    />
                </div>

                {/* 课型 */}
                <div className="pr-lp-gen-field">
                    <label className="pr-lp-gen-label">课型</label>
                    <Combobox
                        options={[...TYPE_OPTIONS]}
                        value={form.type}
                        onChange={(v) => onFormChange('type', (Array.isArray(v) ? v[0] : v) as LessonPlanTemplateType)}
                        placeholder="选择课型"
                        ariaLabel="选择课型"
                    />
                </div>

                {/* 时长 */}
                <div className="pr-lp-gen-field">
                    <label className="pr-lp-gen-label">时长（分钟）</label>
                    <div className="pr-lp-duration-options" role="group" aria-label="选择课时长度">
                        {DURATION_OPTIONS.map((duration) => (
                            <button
                                key={duration}
                                type="button"
                                className={form.duration === duration
                                    ? 'pr-lp-duration-option is-selected'
                                    : 'pr-lp-duration-option'}
                                onClick={() => onFormChange('duration', duration)}
                                aria-pressed={form.duration === duration}
                            >
                                {duration} 分钟
                            </button>
                        ))}
                    </div>
                </div>

                {/* 重点知识点 */}
                <div className="pr-lp-gen-field">
                    <label className="pr-lp-gen-label">重点知识点（可选）</label>
                    <QuickVoiceAssist
                        suggestions={KEY_POINT_SUGGESTIONS}
                        onPick={addKeyPointDirectly}
                        onTranscript={addKeyPointDirectly}
                        label="直接点选常用知识点，或说出自定义内容"
                        voiceLabel="说知识点"
                        disabled={isGenerating}
                        compact
                    />
                    <div className="pr-lp-gen-keypoints">
                        <input
                            type="text"
                            className="pr-lp-gen-input"
                            placeholder="没有合适选项时，再输入其他知识点"
                            value={keyPointInput}
                            onChange={(e) => onKeyPointInputChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault()
                                    onAddKeyPoint()
                                }
                            }}
                        />
                        <button
                            type="button"
                            className="pr-lp-gen-keypoints-add"
                            onClick={onAddKeyPoint}
                            disabled={!keyPointInput.trim()}
                        >
                            <Icon name="plus" size={12} />
                            <span>添加</span>
                        </button>
                    </div>
                    {form.keyPoints && form.keyPoints.length > 0 && (
                        <ul className="pr-lp-gen-keypoints-list">
                            {form.keyPoints.map((kp, idx) => (
                                <li key={idx} className="pr-lp-gen-keypoint">
                                    <span>{kp}</span>
                                    <button
                                        type="button"
                                        className="pr-lp-gen-keypoint-remove"
                                        onClick={() => onRemoveKeyPoint(idx)}
                                        aria-label={`移除 ${kp}`}
                                    >
                                        <Icon name="x" size={10} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                {/* 套用的模板（如有） */}
                {form.templateId && (
                    <div className="pr-lp-gen-applied-template">
                        <Icon name="check" size={12} />
                        <span>已套用模板：{form.templateId}</span>
                    </div>
                )}

                {/* 操作按钮 */}
                <div className="pr-lp-gen-actions">
                    {!isGenerating ? (
                        <button
                            type="button"
                            className="pr-lp-gen-btn pr-lp-gen-btn--primary"
                            onClick={onGenerate}
                        >
                            <Icon name="sparkles" size={14} />
                            <span>开始生成</span>
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="pr-lp-gen-btn pr-lp-gen-btn--abort"
                            onClick={onAbort}
                        >
                            <Icon name="stop" size={12} />
                            <span>中止生成</span>
                        </button>
                    )}
                    {(streamingContent || streamingReasoning) && !isGenerating && (
                        <button
                            type="button"
                            className="pr-lp-gen-btn pr-lp-gen-btn--ghost"
                            onClick={onClear}
                        >
                            <Icon name="trash" size={12} />
                            <span>清空</span>
                        </button>
                    )}
                </div>
            </div>

            {/* 右侧：流式输出 */}
            <div className="pr-lp-gen-output">
                {/* 思考过程 */}
                {streamingReasoning && (
                    <div className="pr-lp-gen-reasoning">
                        <button
                            type="button"
                            className="pr-lp-gen-reasoning-toggle"
                            onClick={() => setShowReasoning((v) => !v)}
                            aria-expanded={showReasoning}
                        >
                            <Icon name={showReasoning ? 'chevron-down' : 'chevron-right'} size={12} />
                            <span>思考过程</span>
                            <span className="pr-lp-gen-reasoning-badge">deepseek-v4-pro</span>
                        </button>
                        {showReasoning && (
                            <pre className="pr-lp-gen-reasoning-content">
                                {streamingReasoning}
                                {isGenerating && <span className="pr-lp-gen-cursor" aria-hidden />}
                            </pre>
                        )}
                    </div>
                )}

                {/* 教案内容 */}
                <div className="pr-lp-gen-content">
                    <div className="pr-lp-gen-content-header">
                        <h3 className="pr-lp-gen-content-title">教案内容</h3>
                        {isGenerating && (
                            <span className="pr-lp-gen-status">
                                <span className="pr-lp-gen-status-dot" />
                                <span>生成中...</span>
                            </span>
                        )}
                    </div>
                    <div className="pr-lp-gen-content-body">
                        {streamingContent ? (
                            <StreamText
                                content={streamingContent}
                                showCursor={isGenerating}
                                className="pr-lp-gen-stream"
                            />
                        ) : !isGenerating ? (
                            <div className="pr-lp-gen-content-empty">
                                <Icon name="sparkles" size={32} />
                                <span>配置参数后点击"开始生成"</span>
                                <span className="pr-lp-gen-content-empty-hint">
                                    AI 将基于 deepseek-v4-pro 流式生成教案
                                </span>
                            </div>
                        ) : null}
                    </div>
                </div>

                {/* 生成完成提示 */}
                {generatedPlan && !isGenerating && (
                    <div className="pr-lp-gen-done">
                        <Icon name="check-circle" size={14} />
                        <span>生成完成，已自动跳转到预览</span>
                    </div>
                )}
            </div>
        </div>
    )
})

/* ============================================================
 * Tab 3: 预览面板
 * ============================================================ */

interface PreviewPanelProps {
    plan: LessonPlan | null
    teacherName: string
    isSaving: boolean
    onSave: () => Promise<boolean>
}

const PreviewPanel = memo(function PreviewPanel({
    plan,
    teacherName,
    isSaving,
    onSave,
}: PreviewPanelProps) {
    const [saved, setSaved] = useState(false)

    const handleSave = useCallback(async () => {
        const ok = await onSave()
        if (ok) setSaved(true)
    }, [onSave])

    if (!plan) {
        return (
            <div className="pr-lp-preview-empty">
                <Icon name="eye" size={32} />
                <span>暂无可预览的教案</span>
                <span className="pr-lp-preview-empty-hint">
                    请前往"生成" Tab 使用 AI 生成，或从"模板" Tab 套用模板
                </span>
            </div>
        )
    }

    return (
        <div className="pr-lp-preview">
            <div className="pr-lp-preview-header">
                <div>
                    <h2 className="pr-lp-preview-title">{plan.title}</h2>
                    <div className="pr-lp-preview-meta">
                        <span><Icon name="user" size={11} /> {teacherName}</span>
                        <span><Icon name="book" size={11} /> {plan.poemTitle} · {plan.poet}（{plan.dynasty}）</span>
                        <span><Icon name="clock" size={11} /> {plan.gradeLevel}</span>
                        {plan.aiGenerated && (
                            <span className="pr-lp-preview-ai-badge">
                                <Icon name="sparkles" size={10} />
                                <span>AI 生成</span>
                            </span>
                        )}
                    </div>
                </div>
                <div className="pr-lp-preview-actions">
                    <button
                        type="button"
                        className="pr-lp-preview-btn pr-lp-preview-btn--primary"
                        onClick={handleSave}
                        disabled={isSaving || saved}
                    >
                        <Icon name={saved ? 'check' : 'save'} size={12} />
                        <span>{saved ? '已保存' : isSaving ? '保存中...' : '保存'}</span>
                    </button>
                </div>
            </div>

            <div className="pr-lp-preview-body">
                {/* 教学目标 */}
                <section className="pr-lp-preview-section">
                    <h3 className="pr-lp-preview-section-title">
                        <Icon name="target" size={14} />
                        <span>教学目标</span>
                    </h3>
                    <ul className="pr-lp-preview-goals">
                        {plan.goals.map((goal, idx) => (
                            <li key={idx} className="pr-lp-preview-goal">
                                <div className="pr-lp-preview-goal-header">
                                    <span className={`pr-lp-preview-goal-cat pr-lp-preview-goal-cat--${goal.category}`}>
                                        {TEACHING_GOAL_CATEGORY_LABEL[goal.category as TeachingGoalCategory] ?? goal.category}
                                    </span>
                                    <span className="pr-lp-preview-goal-bloom">{goal.bloomLevel}</span>
                                </div>
                                <div className="pr-lp-preview-goal-desc">{goal.description}</div>
                                <div className="pr-lp-preview-goal-assess">
                                    <Icon name="check-circle" size={10} />
                                    <span>{goal.assessment}</span>
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>

                {/* 教学重难点 */}
                <section className="pr-lp-preview-section">
                    <h3 className="pr-lp-preview-section-title">
                        <Icon name="star" size={14} />
                        <span>教学重难点</span>
                    </h3>
                    <div className="pr-lp-preview-keypoints">
                        <div className="pr-lp-preview-keypoints-col">
                            <h4 className="pr-lp-preview-keypoints-h">重点</h4>
                            <ul>
                                {plan.keyPoints.map((p, idx) => (
                                    <li key={idx}>{p}</li>
                                ))}
                            </ul>
                        </div>
                        <div className="pr-lp-preview-keypoints-col">
                            <h4 className="pr-lp-preview-keypoints-h">难点</h4>
                            <ul>
                                {plan.difficultPoints.map((p, idx) => (
                                    <li key={idx}>{p}</li>
                                ))}
                            </ul>
                        </div>
                    </div>
                </section>

                {/* 教学过程 */}
                <section className="pr-lp-preview-section">
                    <h3 className="pr-lp-preview-section-title">
                        <Icon name="list" size={14} />
                        <span>教学过程</span>
                    </h3>
                    <ol className="pr-lp-preview-process">
                        {plan.teachingProcess.map((phase, idx) => (
                            <li key={idx} className="pr-lp-preview-phase">
                                <div className="pr-lp-preview-phase-header">
                                    <span className="pr-lp-preview-phase-num">{idx + 1}</span>
                                    <span className="pr-lp-preview-phase-title">{phase.title}</span>
                                    <span className="pr-lp-preview-phase-duration">{phase.durationMin} 分钟</span>
                                </div>
                                <div className="pr-lp-preview-phase-body">
                                    <div className="pr-lp-preview-phase-row">
                                        <span className="pr-lp-preview-phase-label">教师活动</span>
                                        <p className="pr-lp-preview-phase-content">{phase.teacherActivity}</p>
                                    </div>
                                    <div className="pr-lp-preview-phase-row">
                                        <span className="pr-lp-preview-phase-label">学生活动</span>
                                        <p className="pr-lp-preview-phase-content">{phase.studentActivity}</p>
                                    </div>
                                    <div className="pr-lp-preview-phase-row">
                                        <span className="pr-lp-preview-phase-label">设计意图</span>
                                        <p className="pr-lp-preview-phase-content">{phase.designIntent}</p>
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ol>
                </section>

                {/* 板书设计 */}
                {plan.boardDesign && (
                    <section className="pr-lp-preview-section">
                        <h3 className="pr-lp-preview-section-title">
                            <Icon name="grid" size={14} />
                            <span>板书设计</span>
                        </h3>
                        <pre className="pr-lp-preview-board">{plan.boardDesign.content}</pre>
                        <p className="pr-lp-preview-board-intent">{plan.boardDesign.intent}</p>
                    </section>
                )}

                {/* 作业布置 */}
                {plan.homework.length > 0 && (
                    <section className="pr-lp-preview-section">
                        <h3 className="pr-lp-preview-section-title">
                            <Icon name="edit" size={14} />
                            <span>作业布置</span>
                        </h3>
                        <ul className="pr-lp-preview-homework">
                            {plan.homework.map((hw, idx) => (
                                <li key={idx} className="pr-lp-preview-hw">
                                    <div className="pr-lp-preview-hw-header">
                                        <span className="pr-lp-preview-hw-type">{hw.type}</span>
                                        {hw.optional && <span className="pr-lp-preview-hw-optional">选做</span>}
                                        <span className="pr-lp-preview-hw-duration">{hw.estimatedMin} 分钟</span>
                                        <span className="pr-lp-preview-hw-bloom">{hw.bloomLevel}</span>
                                    </div>
                                    <div className="pr-lp-preview-hw-desc">{hw.description}</div>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {/* 教学反思 */}
                {plan.reflection && (
                    <section className="pr-lp-preview-section">
                        <h3 className="pr-lp-preview-section-title">
                            <Icon name="lightbulb" size={14} />
                            <span>教学反思建议</span>
                        </h3>
                        <div className="pr-lp-preview-reflection">
                            <p className="pr-lp-preview-reflection-overview">{plan.reflection.classOverview}</p>
                            <div className="pr-lp-preview-reflection-grid">
                                <div>
                                    <h4 className="pr-lp-preview-reflection-h">亮点</h4>
                                    <ul>
                                        {plan.reflection.highlights.map((h, idx) => (
                                            <li key={idx}>{h}</li>
                                        ))}
                                    </ul>
                                </div>
                                <div>
                                    <h4 className="pr-lp-preview-reflection-h">改进</h4>
                                    <ul>
                                        {plan.reflection.improvements.map((h, idx) => (
                                            <li key={idx}>{h}</li>
                                        ))}
                                    </ul>
                                </div>
                            </div>
                        </div>
                    </section>
                )}
            </div>
        </div>
    )
})

/* ============================================================
 * Tab 4: 导出面板
 * ============================================================ */

interface ExportPanelProps {
    plan: LessonPlan | null
    format: 'pdf' | 'word' | 'markdown'
    onFormatChange: (format: 'pdf' | 'word' | 'markdown') => void
    onExport: () => void
}

const ExportPanel = memo(function ExportPanel({
    plan,
    format,
    onFormatChange,
    onExport,
}: ExportPanelProps) {
    const formats: ReadonlyArray<{ id: 'pdf' | 'word' | 'markdown'; label: string; desc: string; icon: string }> = [
        // desc 如实描述各格式的落地方式，尤其 PDF 走的是浏览器打印而非服务端渲染，
        // 教师点下去会看到打印对话框——预先说明，避免以为出了 bug。
        { id: 'pdf', label: 'PDF 文档', desc: '打开打印视图，选择「另存为 PDF」', icon: 'file' },
        { id: 'word', label: 'Word 文档', desc: '下载 .doc，Word 可直接打开编辑', icon: 'edit' },
        { id: 'markdown', label: 'Markdown', desc: '下载 .md 纯文本，适合版本管理', icon: 'code' },
    ]

    if (!plan) {
        return (
            <div className="pr-lp-export-empty">
                <Icon name="download" size={32} />
                <span>暂无可导出的教案</span>
                <span className="pr-lp-export-empty-hint">
                    请先生成或选择一份教案
                </span>
            </div>
        )
    }

    return (
        <div className="pr-lp-export">
            <div className="pr-lp-export-info">
                <h3 className="pr-lp-export-title">导出教案</h3>
                <p className="pr-lp-export-desc">
                    将《{plan.title}》导出为指定格式，便于打印、归档或分享
                </p>
                <div className="pr-lp-export-meta">
                    <span><Icon name="book" size={11} /> {plan.poemTitle}</span>
                    <span><Icon name="user" size={11} /> {plan.teacherName}</span>
                    <span><Icon name="clock" size={11} /> {plan.gradeLevel}</span>
                </div>
            </div>

            <div className="pr-lp-export-formats">
                {formats.map((f) => (
                    <button
                        key={f.id}
                        type="button"
                        className={`pr-lp-export-format ${format === f.id ? 'pr-lp-export-format--active' : ''}`}
                        onClick={() => onFormatChange(f.id)}
                        aria-pressed={format === f.id}
                    >
                        <Icon name={f.icon} size={20} />
                        <div className="pr-lp-export-format-body">
                            <div className="pr-lp-export-format-label">{f.label}</div>
                            <div className="pr-lp-export-format-desc">{f.desc}</div>
                        </div>
                        {format === f.id && <Icon name="check-circle" size={16} className="pr-lp-export-format-check" />}
                    </button>
                ))}
            </div>

            <div className="pr-lp-export-actions">
                <button
                    type="button"
                    className="pr-lp-export-btn pr-lp-export-btn--primary"
                    onClick={onExport}
                >
                    <Icon name="download" size={14} />
                    <span>导出为 {formats.find((f) => f.id === format)?.label}</span>
                </button>
            </div>

            <div className="pr-lp-export-tips">
                <Icon name="info" size={12} />
                <span>导出内容包含：教学目标、重难点、教学过程、板书设计、作业布置、教学反思</span>
            </div>
        </div>
    )
})
