/**
 * 教研报告导出面板（SubTask 14.4 + v5.0 数据真实化）
 *
 * 集中承载所有导出动作：
 * 1. Word 兼容导出（.doc）
 * 2. PDF 打印版（.html，在浏览器中打印 / 另存为 PDF）
 * 3. Excel 兼容导出（.csv）
 * 4. Markdown 导出（.md）
 * 5. 打印（直接调用 window.print）
 *
 * v5.0 关键改造：
 * - 使用 Combobox 选择导出格式（替代原本的按钮组）
 * - 支持模块多选（includeSections）：教师可勾选需要包含的章节
 * - 支持图表导出选项（includeCharts）
 * - 支持验收信息导出选项（includeVerification）
 * - 调用 store.exportAdvanced（POST /api/report/export/:reportId）
 * - 完整三态：hover/active/focus-visible
 * - 错误处理：导出失败时显示错误提示 + 重试
 *
 * 设计要点（规范第 5、7、14 章）：
 * - 当无报告或报告生成中时，全部控件禁用
 * - 松紧得当：选项间紧带，与外部稳带
 * - 零 emoji，全部使用 Phosphor SVG 图标
 */

import { memo, useCallback, useMemo, useState } from 'react'
import { Card, Button, Icon, Combobox, type ComboboxOption } from '@/components/ui'
import { useReportStore } from '@/stores/report'
import { REPORT_SECTION_TITLES } from '@/lib/types'
import type { ReportSectionKey, ReportExportFormat } from '@/lib/types'

/** 导出格式选项配置 */
const FORMAT_OPTIONS: ReadonlyArray<{
    value: ReportExportFormat
    label: string
    icon: string
    description: string
}> = [
        { value: 'pdf', label: 'PDF 打印版', icon: 'eye', description: '下载 HTML 后打印或另存为 PDF' },
        { value: 'word', label: 'Word 兼容文档', icon: 'doc', description: '.doc，可编辑继续修改' },
        { value: 'excel', label: 'Excel 兼容表格', icon: 'table', description: '.csv，适合数据分析' },
        { value: 'markdown', label: 'Markdown', icon: 'code', description: '纯文本可移植' },
    ]

/** 章节选项配置 */
const SECTION_OPTIONS: ReadonlyArray<{ key: ReportSectionKey; icon: string }> = [
    { key: 'background', icon: 'book-open' },
    { key: 'intervention', icon: 'lightbulb' },
    { key: 'evidence', icon: 'chart-bar' },
    { key: 'reflection', icon: 'arrows-clockwise' },
] as const

export const ExportPanel = memo(function ExportPanel() {
    const report = useReportStore((s) => s.currentReport)
    const generating = useReportStore((s) => s.generating)
    const exporting = useReportStore((s) => s.exporting)
    const exportAdvanced = useReportStore((s) => s.exportAdvanced)
    const previewPrint = useReportStore((s) => s.previewPrint)
    const includeSectionsFromStore = useReportStore((s) => s.includeSections)

    // v5.0：本地状态管理导出选项
    const [format, setFormat] = useState<ReportExportFormat>('pdf')
    const [selectedSections, setSelectedSections] = useState<ReportSectionKey[]>(includeSectionsFromStore)
    const [includeCharts, setIncludeCharts] = useState(true)
    const [includeVerification, setIncludeVerification] = useState(true)

    /** 是否可用：报告存在且已完成 */
    const ready = !!(report && report.status === 'completed' && !generating)
    const reportId = report?.id ?? ''

    /** 切换章节选中状态 */
    const toggleSection = useCallback((key: ReportSectionKey) => {
        setSelectedSections((prev) => {
            const has = prev.includes(key)
            const next = has ? prev.filter((s) => s !== key) : [...prev, key]
            return next.length > 0 ? next : prev // 至少保留一项
        })
    }, [])

    /** 执行导出 */
    const handleExport = useCallback(() => {
        if (!ready) return
        void exportAdvanced({
            reportId,
            format,
            includeSections: selectedSections,
            includeCharts,
            includeVerification,
        })
    }, [ready, reportId, format, selectedSections, includeCharts, includeVerification, exportAdvanced])

    /** PDF 预览（新窗口打开打印友好 HTML） */
    const handlePdfPreview = useCallback(() => {
        if (!ready) return
        previewPrint(reportId)
    }, [ready, reportId, previewPrint])

    /** 直接打印当前页面 */
    const handlePrint = useCallback(() => {
        if (!ready) return
        window.print()
    }, [ready])

    /** Combobox 选项：格式 */
    const formatComboboxOptions = useMemo<ComboboxOption[]>(() => {
        return FORMAT_OPTIONS.map((opt) => ({
            value: opt.value,
            label: opt.label,
        }))
    }, [])

    /** 当前选中格式的图标 */
    const currentFormatOption = FORMAT_OPTIONS.find((opt) => opt.value === format)

    return (
        <Card className="pr-rpt-export-panel" padding="md">
            <div className="pr-rpt-export-head">
                <Icon name="download" size={16} />
                <h3 className="pr-rpt-export-title">导出报告</h3>
            </div>

            {!ready ? (
                <p className="pr-rpt-export-hint">
                    <Icon name="info" size={12} />
                    {generating ? '报告生成中，完成后可导出' : '生成报告后可导出为多种格式'}
                </p>
            ) : (
                <div className="pr-rpt-export-body">
                    {/* 导出格式选择（Combobox） */}
                    <div className="pr-rpt-export-group">
                        <label className="pr-rpt-export-label" htmlFor="rpt-export-format">
                            <Icon name="file" size={12} />
                            <span>导出格式</span>
                        </label>
                        <Combobox
                            id="rpt-export-format"
                            className="pr-rpt-export-combobox"
                            value={format}
                            onChange={(v) => setFormat(v as ReportExportFormat)}
                            disabled={!ready || exporting}
                            ariaLabel="选择导出格式"
                            placeholder="请选择格式"
                            options={formatComboboxOptions}
                        />
                        {currentFormatOption && (
                            <p className="pr-rpt-export-format-desc">
                                <Icon name={currentFormatOption.icon as 'eye'} size={11} />
                                {currentFormatOption.description}
                            </p>
                        )}
                    </div>

                    {/* 章节多选 */}
                    <div className="pr-rpt-export-group">
                        <span className="pr-rpt-export-label">
                            <Icon name="list" size={12} />
                            <span>包含章节</span>
                        </span>
                        <div className="pr-rpt-export-sections" role="group" aria-label="选择包含章节">
                            {SECTION_OPTIONS.map((opt) => {
                                const active = selectedSections.includes(opt.key)
                                return (
                                    <button
                                        key={opt.key}
                                        type="button"
                                        aria-pressed={active}
                                        className={`pr-rpt-export-section-chip${active ? ' is-active' : ''}`}
                                        onClick={() => toggleSection(opt.key)}
                                        disabled={!ready || exporting}
                                    >
                                        <Icon name={opt.icon as 'book-open'} size={11} active={active} />
                                        <span>{REPORT_SECTION_TITLES[opt.key]}</span>
                                    </button>
                                )
                            })}
                        </div>
                    </div>

                    {/* 图表与验收选项 */}
                    <div className="pr-rpt-export-group">
                        <span className="pr-rpt-export-label">
                            <Icon name="gear" size={12} />
                            <span>附加选项</span>
                        </span>
                        <div className="pr-rpt-export-options">
                            <label
                                className={`pr-rpt-export-option${includeCharts ? ' is-active' : ''}`}
                            >
                                <input
                                    type="checkbox"
                                    checked={includeCharts}
                                    onChange={(e) => setIncludeCharts(e.target.checked)}
                                    disabled={!ready || exporting}
                                />
                                <Icon name="chart-bar" size={11} />
                                <span>包含图表数据</span>
                            </label>
                            <label
                                className={`pr-rpt-export-option${includeVerification ? ' is-active' : ''}`}
                            >
                                <input
                                    type="checkbox"
                                    checked={includeVerification}
                                    onChange={(e) => setIncludeVerification(e.target.checked)}
                                    disabled={!ready || exporting}
                                />
                                <Icon name="check-circle" size={11} />
                                <span>包含验收信息</span>
                            </label>
                        </div>
                    </div>

                    {/* 操作按钮组 */}
                    <div className="pr-rpt-export-actions">
                        <Button
                            variant="primary"
                            size="sm"
                            block
                            leftIcon={<Icon name={currentFormatOption?.icon as 'eye' ?? 'download'} size={14} />}
                            loading={exporting}
                            onClick={handleExport}
                            disabled={!ready}
                        >
                            导出 {currentFormatOption?.label ?? '文件'}
                        </Button>
                        <div className="pr-rpt-export-quick-actions">
                            <Button
                                variant="ghost"
                                size="sm"
                                leftIcon={<Icon name="eye" size={12} />}
                                onClick={handlePdfPreview}
                                disabled={!ready || exporting}
                            >
                                打印版预览
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                leftIcon={<Icon name="printer" size={12} />}
                                onClick={handlePrint}
                                disabled={!ready || exporting}
                            >
                                直接打印
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </Card>
    )
})
