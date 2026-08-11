/**
 * 操作工具栏（SubTask 10.6 + 21.5 增强）
 *
 * v5.0 SubTask 21.5 新增能力：
 * - 新增"导出文档"按钮 + Modal 弹窗
 * - 支持 Word 兼容 .doc / Excel 兼容 .csv / PDF 打印版 .html 三种格式
 * - 参数化：题卡范围（全部/选中）、是否包含答案、是否包含解析、排版样式（A4/B5）
 * - 进度反馈：useMutation + 进度条 + 完成后浏览器自动下载
 * - 保留原有 JSON / CSV 导出 + 打印试卷 + 发布闯关
 *
 * 设计要点（规范第 7、14 章）：
 * - 工具栏吸顶（sticky），背景 surface-glass + backdrop-blur
 * - 按钮分组：选择组 / 操作组，组间用负空间分隔
 * - 导出弹窗：参数表单 + 进度条 + 完成提示
 * - TanStack Query useMutation（避免重复触发 + 自动失败回滚）
 */

import { memo, useCallback, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Badge, Button, Icon, Modal } from '@/components/ui'
import { Combobox, type ComboboxOption } from '@/components/ui'
import { api } from '@/lib/api'
import { getDisplayError } from '@/lib/errors'
import { toast } from '@/stores/toast'
import { useWorkbenchStore } from '@/stores/workbench'
import type { WorkbenchDocExportRequest } from '@/lib/types'

/* ============================================================
 * 常量
 * ============================================================ */

/** 导出格式选项 */
const FORMAT_OPTIONS: ReadonlyArray<{
    value: WorkbenchDocExportRequest['format']
    label: string
    icon: string
    ext: string
    desc: string
}> = [
        { value: 'word', label: 'Word 兼容文档', icon: 'doc', ext: 'doc', desc: '可用 Word 打开并继续编辑' },
        { value: 'excel', label: 'Excel 兼容表格', icon: 'chart-bar', ext: 'csv', desc: '可用 Excel 打开并批量管理' },
        { value: 'pdf', label: 'PDF 打印版', icon: 'scroll', ext: 'html', desc: '浏览器打开后打印或另存为 PDF' },
    ]

/** 排版样式选项 */
const LAYOUT_OPTIONS: ReadonlyArray<ComboboxOption> = [
    { value: 'A4', label: 'A4 标准纸张' },
    { value: 'B5', label: 'B5 试卷纸张' },
]

/** 导出范围选项 */
const SCOPE_OPTIONS: ReadonlyArray<ComboboxOption> = [
    { value: 'all', label: '全部题卡' },
    { value: 'selected', label: '仅选中题卡' },
]

/* ============================================================
 * 主组件
 * ============================================================ */

interface WorkbenchToolbarProps {
    /** 发布闯关回调（由 WorkbenchPage 注入，用于打开班级选择/确认） */
    onPublish?: () => void
}

export const WorkbenchToolbar = memo(function WorkbenchToolbar({ onPublish }: WorkbenchToolbarProps) {
    const questions = useWorkbenchStore((s) => s.questions)
    const selectedIds = useWorkbenchStore((s) => s.selectedIds)
    const selectAll = useWorkbenchStore((s) => s.selectAll)
    const selectNone = useWorkbenchStore((s) => s.selectNone)
    const exportQuestions = useWorkbenchStore((s) => s.exportQuestions)
    const exporting = useWorkbenchStore((s) => s.exporting)
    const publishing = useWorkbenchStore((s) => s.publishing)

    /* ------------------------------------------------------------
     * 导出弹窗状态
     * ---------------------------------------------------------- */
    const [exportModalOpen, setExportModalOpen] = useState(false)
    const [format, setFormat] = useState<WorkbenchDocExportRequest['format']>('word')
    const [scope, setScope] = useState<'all' | 'selected'>('all')
    const [includeAnswer, setIncludeAnswer] = useState(true)
    const [includeAnalysis, setIncludeAnalysis] = useState(true)
    const [layout, setLayout] = useState<'A4' | 'B5'>('A4')
    const [progress, setProgress] = useState<number>(0)

    const hasQuestions = questions.length > 0
    const allSelected = hasQuestions && selectedIds.size === questions.length
    const someSelected = selectedIds.size > 0 && !allSelected
    const selectedCount = selectedIds.size

    /* ------------------------------------------------------------
     * 计算导出题卡 ID 列表
     * ---------------------------------------------------------- */
    const computeQuestionIds = useCallback((): string[] => {
        if (scope === 'selected') {
            const ids = Array.from(selectedIds)
            return ids.length > 0 ? ids : questions.map((q) => q.id)
        }
        return questions.map((q) => q.id)
    }, [scope, selectedIds, questions])

    /** 预计导出题卡数 */
    const estimatedCount = computeQuestionIds().length

    /* ------------------------------------------------------------
     * 导出 Mutation（Word/Excel/PDF）
     * ---------------------------------------------------------- */
    const exportDocMutation = useMutation({
        mutationFn: async (req: WorkbenchDocExportRequest) => {
            return api.workbench.exportDocument(req)
        },
        onMutate: () => {
            setProgress(10)
        },
        onSuccess: async (data) => {
            setProgress(90)
            // 触发浏览器下载
            try {
                const url = URL.createObjectURL(data.blob)
                const a = document.createElement('a')
                a.href = url
                a.download = data.filename
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                // 释放 URL 对象（延迟以避免下载中断）
                setTimeout(() => URL.revokeObjectURL(url), 1000)
                setProgress(100)
                toast.success({
                    title: '导出成功',
                    message: `已生成 ${data.count} 道题卡 · ${data.filename}`,
                })
                // 延迟关闭弹窗，让用户看到完成态
                setTimeout(() => {
                    setExportModalOpen(false)
                    setProgress(0)
                }, 600)
            } catch (err) {
                setProgress(0)
                toast.error({
                    title: '下载失败',
                    message: getDisplayError(err, '浏览器不支持自动下载，请重试'),
                })
            }
        },
        onError: (err) => {
            setProgress(0)
            toast.error({ title: '导出失败', message: getDisplayError(err, '请稍后重试') })
        },
    })

    /* ------------------------------------------------------------
     * 处理器
     * ---------------------------------------------------------- */
    const handleExportDoc = useCallback(() => {
        if (!hasQuestions) {
            toast.warning({ title: '无可导出题卡', message: '请先生成题卡' })
            return
        }
        // 打开弹窗时重置参数
        setFormat('word')
        setScope(selectedCount > 0 ? 'selected' : 'all')
        setIncludeAnswer(true)
        setIncludeAnalysis(true)
        setLayout('A4')
        setProgress(0)
        setExportModalOpen(true)
    }, [hasQuestions, selectedCount])

    const handleConfirmExport = useCallback(() => {
        const questionIds = computeQuestionIds()
        if (questionIds.length === 0) {
            toast.warning({ title: '未选择题卡', message: '请至少选择一道题卡或切换为全部' })
            return
        }
        exportDocMutation.mutate({
            questionIds,
            format,
            includeAnswer,
            includeAnalysis,
            layout,
        })
    }, [computeQuestionIds, format, includeAnswer, includeAnalysis, layout, exportDocMutation])

    const handleExportJson = useCallback(() => {
        void exportQuestions('json')
    }, [exportQuestions])

    const handleExportCsv = useCallback(() => {
        void exportQuestions('csv')
    }, [exportQuestions])

    const handlePrint = useCallback(() => {
        if (!hasQuestions) {
            toast.warning({ title: '无可打印题目', message: '请先生成题目' })
            return
        }
        window.print()
    }, [hasQuestions])

    const handlePublish = useCallback(() => {
        if (!hasQuestions) {
            toast.warning({ title: '无可发布题目', message: '请先生成题目' })
            return
        }
        if (onPublish) {
            onPublish()
        }
    }, [hasQuestions, onPublish])

    const handleSelectToggle = useCallback(() => {
        if (allSelected) {
            selectNone()
        } else {
            selectAll()
        }
    }, [allSelected, selectAll, selectNone])

    /** 当前选中的格式配置 */
    const currentFormat = FORMAT_OPTIONS.find((f) => f.value === format) ?? FORMAT_OPTIONS[0]!
    const isExporting = exportDocMutation.isPending
    const isExportDone = progress >= 100

    return (
        <>
            <div className="pr-wb-toolbar" role="toolbar" aria-label="题目操作工具栏">
                {/* 左侧：选择组 */}
                <div className="pr-wb-toolbar-group pr-wb-toolbar-group--select">
                    <button
                        type="button"
                        className={`pr-wb-toolbar-check${allSelected ? ' is-checked' : ''}${someSelected ? ' is-indeterminate' : ''}`}
                        onClick={handleSelectToggle}
                        disabled={!hasQuestions}
                        aria-label={allSelected ? '取消全选' : '全选'}
                    >
                        <span className="pr-wb-toolbar-check-box" aria-hidden>
                            {(allSelected || someSelected) && (
                                <Icon name={allSelected ? 'check' : 'minus'} size={12} weight="bold" />
                            )}
                        </span>
                    </button>
                    <span className="pr-wb-toolbar-count">
                        {selectedCount > 0
                            ? `已选 ${selectedCount} / ${questions.length}`
                            : `共 ${questions.length} 题`}
                    </span>
                </div>

                {/* 右侧：操作组 */}
                <div className="pr-wb-toolbar-group pr-wb-toolbar-group--actions">
                    <Button
                        variant="primary"
                        size="sm"
                        leftIcon={<Icon name="download" size={14} />}
                        onClick={handleExportDoc}
                        disabled={!hasQuestions}
                    >
                        导出文档
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Icon name="doc" size={14} />}
                        onClick={handleExportJson}
                        loading={exporting}
                        disabled={!hasQuestions}
                    >
                        JSON
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Icon name="chart-bar" size={14} />}
                        onClick={handleExportCsv}
                        loading={exporting}
                        disabled={!hasQuestions}
                    >
                        CSV
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Icon name="scroll" size={14} />}
                        onClick={handlePrint}
                        disabled={!hasQuestions}
                    >
                        打印试卷
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        leftIcon={<Icon name="share" size={14} />}
                        onClick={handlePublish}
                        loading={publishing}
                        disabled={!hasQuestions}
                    >
                        发布闯关
                    </Button>
                </div>

                {/* 选中态提示徽标（浮动） */}
                {selectedCount > 0 && (
                    <Badge variant="primary" className="pr-wb-toolbar-badge">
                        {selectedCount}
                    </Badge>
                )}
            </div>

            {/* 导出文档弹窗 */}
            <Modal
                open={exportModalOpen}
                onClose={() => {
                    if (!isExporting) setExportModalOpen(false)
                }}
                size="md"
                title="导出题卡文档"
                footer={
                    <div className="pr-wb-export-footer">
                        <Button
                            variant="ghost"
                            size="md"
                            onClick={() => setExportModalOpen(false)}
                            disabled={isExporting}
                        >
                            取消
                        </Button>
                        <Button
                            variant="primary"
                            size="md"
                            onClick={handleConfirmExport}
                            loading={isExporting}
                            loadingLabel="生成中…"
                            leftIcon={!isExporting ? <Icon name="download" size={14} /> : undefined}
                            disabled={estimatedCount === 0 || isExportDone}
                        >
                            {isExporting ? '生成中…' : isExportDone ? '已完成' : `导出 ${currentFormat.label}`}
                        </Button>
                    </div>
                }
            >
                <div className="pr-wb-export">
                    {/* 格式选择 */}
                    <section className="pr-wb-export-section">
                        <div className="pr-wb-export-label">
                            <Icon name="doc" size={14} />
                            <span>导出格式</span>
                        </div>
                        <div className="pr-wb-export-formats">
                            {FORMAT_OPTIONS.map((opt) => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    className={`pr-wb-export-format${format === opt.value ? ' is-active' : ''}`}
                                    onClick={() => setFormat(opt.value)}
                                    disabled={isExporting}
                                >
                                    <div className="pr-wb-export-format-icon">
                                        <Icon name={opt.icon as 'doc'} size={20} />
                                    </div>
                                    <div className="pr-wb-export-format-info">
                                        <div className="pr-wb-export-format-name">
                                            {opt.label}
                                            <span className="pr-wb-export-format-ext">.{opt.ext}</span>
                                        </div>
                                        <div className="pr-wb-export-format-desc">{opt.desc}</div>
                                    </div>
                                    {format === opt.value && (
                                        <Icon
                                            name="check-circle"
                                            size={16}
                                            className="pr-wb-export-format-check"
                                        />
                                    )}
                                </button>
                            ))}
                        </div>
                    </section>

                    {/* 范围选择 */}
                    <section className="pr-wb-export-section">
                        <div className="pr-wb-export-label">
                            <Icon name="list" size={14} />
                            <span>题卡范围</span>
                        </div>
                        <Combobox
                            options={SCOPE_OPTIONS as ComboboxOption[]}
                            value={scope}
                            onChange={(v) => setScope(v as 'all' | 'selected')}
                            disabled={isExporting || selectedCount === 0}
                            ariaLabel="题卡范围"
                        />
                        <div className="pr-wb-export-hint">
                            {scope === 'selected'
                                ? `将导出已选中的 ${selectedCount} 道题卡`
                                : `将导出全部 ${questions.length} 道题卡`}
                        </div>
                    </section>

                    {/* 内容参数 */}
                    <section className="pr-wb-export-section">
                        <div className="pr-wb-export-label">
                            <Icon name="lightbulb" size={14} />
                            <span>内容参数</span>
                        </div>
                        <div className="pr-wb-export-toggles">
                            <label className={`pr-wb-export-toggle${includeAnswer ? ' is-on' : ''}`}>
                                <input
                                    type="checkbox"
                                    checked={includeAnswer}
                                    onChange={(e) => setIncludeAnswer(e.target.checked)}
                                    disabled={isExporting}
                                />
                                <Icon name="check-circle" size={14} />
                                <span>包含答案</span>
                            </label>
                            <label className={`pr-wb-export-toggle${includeAnalysis ? ' is-on' : ''}`}>
                                <input
                                    type="checkbox"
                                    checked={includeAnalysis}
                                    onChange={(e) => setIncludeAnalysis(e.target.checked)}
                                    disabled={isExporting}
                                />
                                <Icon name="lightbulb" size={14} />
                                <span>包含解析</span>
                            </label>
                        </div>
                    </section>

                    {/* 排版样式 */}
                    <section className="pr-wb-export-section">
                        <div className="pr-wb-export-label">
                            <Icon name="text-aa" size={14} />
                            <span>排版样式</span>
                        </div>
                        <Combobox
                            options={LAYOUT_OPTIONS as ComboboxOption[]}
                            value={layout}
                            onChange={(v) => setLayout(v as 'A4' | 'B5')}
                            disabled={isExporting}
                            ariaLabel="排版样式"
                        />
                    </section>

                    {/* 导出状态
                        导出是一次性请求，后端不回传进度，因此这里用**不确定态**滑块，
                        不再显示由定时器编造的百分比（原实现每 400ms 随机加 0–8%，
                        与真实进度毫无关系，且卡在 85% 直到请求返回）。
                        完成态才给出确定的结果计数。 */}
                    {(isExporting || isExportDone) && (
                        <section className="pr-wb-export-progress">
                            <div className="pr-wb-export-progress-head">
                                <Icon
                                    name={isExportDone ? 'check-circle' : 'circle-notch'}
                                    size={14}
                                />
                                <span>
                                    {isExportDone
                                        ? `导出完成 · 共 ${estimatedCount} 道题卡`
                                        : `正在生成 ${currentFormat.label}…`}
                                </span>
                            </div>
                            {!isExportDone && (
                                <div
                                    className="pr-wb-export-progress-bar"
                                    role="progressbar"
                                    aria-label={`正在生成 ${currentFormat.label}`}
                                >
                                    <div className="pr-wb-export-progress-fill pr-wb-export-progress-fill--indeterminate" />
                                </div>
                            )}
                            <div className="pr-wb-export-progress-meta">
                                预计导出 {estimatedCount} 道题卡 · 格式 .{currentFormat.ext} · 排版 {layout}
                            </div>
                        </section>
                    )}
                </div>
            </Modal>
        </>
    )
})
