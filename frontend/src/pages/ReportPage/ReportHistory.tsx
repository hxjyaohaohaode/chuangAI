/**
 * 历史报告列表（SubTask 14.5 + v5.0 数据真实化）
 *
 * 教师回看已生成的教研报告，支持：
 * 1. 关键词搜索（标题/班级名称模糊匹配）
 * 2. v5.0：时间范围筛选（from / to）
 * 3. v5.0：模板筛选（Combobox 选择）
 * 4. v5.0：状态筛选（Combobox 选择）
 * 5. 分页展示（每页 20 条）—— v5.0：从 10 改为 20
 * 6. 通过每行唯一的「查看」原生按钮加载该报告到预览区
 * 7. 删除报告（乐观更新 + 失败回滚）
 * 8. 状态徽标（completed/failed/generating）
 *
 * v5.0 关键改造：
 * - 使用 store.setHistoryFilter 统一管理筛选状态
 * - 使用 Combobox 替代原生 select（模板/状态）
 * - 时间范围使用 date input
 * - 每页 20 条（store.historyPageSize 已调整为 20）
 * - 筛选变化时自动重置到第一页
 * - 数据来源：store.fetchHistory（已扩展支持 advanced filter）
 *
 * 设计要点（规范第 5、7、9、14 章）：
 * - 无边框表格，行间透明度差异分隔
 * - 搜索框带前缀图标，focus 出现 accent 光晕
 * - 分页器极简，仅上一页/下一页 + 页码指示
 * - 完整三态：hover/active/focus-visible
 * - 零 emoji，全部使用 Phosphor SVG 图标
 */

import { memo, useCallback, useEffect, useState } from 'react'
import { Card, Icon, Button, Badge, Table, Input, Skeleton, Combobox, type TableColumn, type ComboboxOption } from '@/components/ui'
import { useReportStore } from '@/stores/report'
import { REPORT_TEMPLATE_LABELS } from '@/lib/types'
import type { ReportSummary, ReportTemplate } from '@/lib/types'

/** 状态徽标渲染 */
function renderStatusBadge(status: ReportSummary['status']): React.ReactNode {
    switch (status) {
        case 'completed':
            return <Badge variant="success" icon={<Icon name="check-circle" size={10} />}>已完成</Badge>
        case 'failed':
            return <Badge variant="error" icon={<Icon name="x-circle" size={10} />}>失败</Badge>
        case 'generating':
            return <Badge variant="warning" icon={<Icon name="arrows-clockwise" size={10} />}>生成中</Badge>
        default:
            return <Badge variant="default">{status}</Badge>
    }
}

function getReportTitle(row: ReportSummary): string {
    return row.title ?? `${row.className} 教研报告`
}

/** 模板 Combobox 选项（含「全部」） */
const TEMPLATE_FILTER_OPTIONS: ComboboxOption[] = [
    { value: '', label: '全部模板' },
    { value: 'standard', label: REPORT_TEMPLATE_LABELS.standard },
    { value: 'data-driven', label: REPORT_TEMPLATE_LABELS['data-driven'] },
    { value: 'narrative', label: REPORT_TEMPLATE_LABELS.narrative },
    { value: 'executive', label: REPORT_TEMPLATE_LABELS.executive },
]

/** 状态 Combobox 选项（含「全部」） */
const STATUS_FILTER_OPTIONS: ComboboxOption[] = [
    { value: '', label: '全部状态' },
    { value: 'completed', label: '已完成' },
    { value: 'failed', label: '失败' },
    { value: 'generating', label: '生成中' },
]

export const ReportHistory = memo(function ReportHistory() {
    const history = useReportStore((s) => s.history)
    const historyTotal = useReportStore((s) => s.historyTotal)
    const historyLoading = useReportStore((s) => s.historyLoading)
    const historyPage = useReportStore((s) => s.historyPage)
    const historyPageSize = useReportStore((s) => s.historyPageSize)
    const historyKeyword = useReportStore((s) => s.historyKeyword)
    const historyFilterFrom = useReportStore((s) => s.historyFilterFrom)
    const historyFilterTo = useReportStore((s) => s.historyFilterTo)
    const historyFilterTemplate = useReportStore((s) => s.historyFilterTemplate)
    const historyFilterStatus = useReportStore((s) => s.historyFilterStatus)
    const currentReport = useReportStore((s) => s.currentReport)

    const fetchHistory = useReportStore((s) => s.fetchHistory)
    const fetchReport = useReportStore((s) => s.fetchReport)
    const deleteReport = useReportStore((s) => s.deleteReport)
    const setHistoryFilter = useReportStore((s) => s.setHistoryFilter)

    // 本地 keyword 输入态（用于防抖）
    const [keyword, setKeyword] = useState(historyKeyword)
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

    /** 首次挂载拉取历史 */
    useEffect(() => {
        void fetchHistory(true)
    }, [fetchHistory])

    /** 搜索（关键词变化后 300ms 防抖） */
    useEffect(() => {
        const timer = window.setTimeout(() => {
            if (keyword !== historyKeyword) {
                setHistoryFilter({ keyword })
                void fetchHistory(true)
            }
        }, 300)
        return () => window.clearTimeout(timer)
    }, [keyword, historyKeyword, setHistoryFilter, fetchHistory])

    /** 时间范围 / 模板 / 状态 变化时自动拉取（已在 setHistoryFilter 中重置 page） */
    useEffect(() => {
        void fetchHistory(true)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [historyFilterFrom, historyFilterTo, historyFilterTemplate, historyFilterStatus])

    /** 查看报告：由唯一原生操作按钮加载到预览区，表格行本身保持原生 row 语义。 */
    const handleViewReport = useCallback((row: ReportSummary) => {
        if (row.status === 'generating') return
        void fetchReport(row.id).then(() => {
            // 查看后当前行的按钮会变为禁用的「当前」状态。不能把键盘焦点留在
            // 不再可操作的控件上；仅在目标报告确实载入成功时，将其交接到报告标题。
            if (useReportStore.getState().currentReport?.id !== row.id) return
            window.requestAnimationFrame(() => {
                document.querySelector<HTMLElement>('.pr-rpt-preview-title')?.focus()
            })
        })
    }, [fetchReport])

    /** 上一页 */
    const handlePrevPage = useCallback(() => {
        if (historyPage <= 0) return
        useReportStore.setState({ historyPage: historyPage - 1 })
        void fetchHistory(false)
    }, [historyPage, fetchHistory])

    /** 下一页 */
    const handleNextPage = useCallback(() => {
        const maxPage = Math.max(0, Math.ceil(historyTotal / historyPageSize) - 1)
        if (historyPage >= maxPage) return
        useReportStore.setState({ historyPage: historyPage + 1 })
        void fetchHistory(false)
    }, [historyPage, historyTotal, historyPageSize, fetchHistory])

    /** 删除报告 */
    const handleDelete = useCallback((id: string) => {
        void deleteReport(id)
        setConfirmDeleteId(null)
    }, [deleteReport])

    /** 清空所有筛选 */
    const handleClearFilters = useCallback(() => {
        setKeyword('')
        setHistoryFilter({
            keyword: '',
            from: '',
            to: '',
            template: '',
            status: '',
        })
        void fetchHistory(true)
    }, [setHistoryFilter, fetchHistory])

    /** 列定义 */
    const columns: TableColumn<ReportSummary>[] = [
        {
            key: 'title',
            title: '报告标题',
            render: (row) => (
                <div className="pr-rpt-history-title-cell">
                    <Icon name="scroll" size={14} />
                    <span className="pr-rpt-history-title-text">
                        {getReportTitle(row)}
                    </span>
                </div>
            ),
        },
        {
            key: 'className',
            title: '班级',
            render: (row) => <span className="pr-rpt-history-class">{row.className || '—'}</span>,
        },
        {
            key: 'template',
            title: '模板',
            render: (row) => (
                <span className="pr-rpt-history-template">
                    {REPORT_TEMPLATE_LABELS[row.template]}
                </span>
            ),
        },
        {
            key: 'status',
            title: '状态',
            render: (row) => renderStatusBadge(row.status),
        },
        {
            key: 'createdAt',
            title: '生成时间',
            render: (row) => (
                <span className="pr-rpt-history-time">
                    {formatDateTime(row.createdAt)}
                </span>
            ),
        },
        {
            key: 'actions',
            title: '操作',
            align: 'right',
            render: (row) => (
                <div className="pr-rpt-history-actions">
                    {row.status !== 'generating' && (
                        <Button
                            variant="ghost"
                            size="sm"
                            leftIcon={<Icon name="eye" size={12} />}
                            onClick={() => handleViewReport(row)}
                            disabled={currentReport?.id === row.id}
                            aria-label={currentReport?.id === row.id
                                ? `当前报告「${getReportTitle(row)}」`
                                : `查看报告「${getReportTitle(row)}」`}
                        >
                            {currentReport?.id === row.id ? '当前' : '查看'}
                        </Button>
                    )}
                    {confirmDeleteId === row.id ? (
                        <>
                            <Button
                                variant="danger"
                                size="sm"
                                onClick={() => handleDelete(row.id)}
                                aria-label={`确认删除报告「${getReportTitle(row)}」`}
                            >
                                确认删除
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setConfirmDeleteId(null)}
                                aria-label={`取消删除报告「${getReportTitle(row)}」`}
                            >
                                取消
                            </Button>
                        </>
                    ) : (
                        <Button
                            variant="ghost"
                            size="sm"
                            leftIcon={<Icon name="trash" size={12} />}
                            onClick={() => setConfirmDeleteId(row.id)}
                            aria-label={`删除报告「${getReportTitle(row)}」`}
                        >
                            删除
                        </Button>
                    )}
                </div>
            ),
        },
    ]

    const totalPages = Math.max(1, Math.ceil(historyTotal / historyPageSize))
    const startIdx = historyTotal === 0 ? 0 : historyPage * historyPageSize + 1
    const endIdx = Math.min(historyTotal, (historyPage + 1) * historyPageSize)

    /** 是否有激活的筛选 */
    const hasActiveFilter = !!keyword || !!historyFilterFrom || !!historyFilterTo ||
        !!historyFilterTemplate || !!historyFilterStatus

    return (
        <Card className="pr-rpt-history" padding="md">
            <div className="pr-rpt-history-head">
                <div className="pr-rpt-history-title-row">
                    <Icon name="clock" size={16} />
                    <h3 className="pr-rpt-history-title">历史报告</h3>
                    {historyTotal > 0 && (
                        <span className="pr-rpt-history-count">共 {historyTotal} 条</span>
                    )}
                </div>
                <div className="pr-rpt-history-search">
                    <Input
                        placeholder="搜索标题或班级…"
                        prefix={<Icon name="magnifying-glass" size={14} />}
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                        aria-label="搜索历史报告"
                    />
                </div>
            </div>

            {/* v5.0：高级筛选区 */}
            <div className="pr-rpt-history-filters">
                <div className="pr-rpt-history-filter-group">
                    <label className="pr-rpt-history-filter-label" htmlFor="rpt-filter-from">
                        <Icon name="calendar" size={11} />
                        <span>开始</span>
                    </label>
                    <input
                        id="rpt-filter-from"
                        type="date"
                        className="pr-rpt-history-filter-date"
                        value={historyFilterFrom}
                        max={historyFilterTo || undefined}
                        onChange={(e) => setHistoryFilter({ from: e.target.value })}
                    />
                </div>
                <div className="pr-rpt-history-filter-group">
                    <label className="pr-rpt-history-filter-label" htmlFor="rpt-filter-to">
                        <Icon name="calendar" size={11} />
                        <span>结束</span>
                    </label>
                    <input
                        id="rpt-filter-to"
                        type="date"
                        className="pr-rpt-history-filter-date"
                        value={historyFilterTo}
                        min={historyFilterFrom || undefined}
                        onChange={(e) => setHistoryFilter({ to: e.target.value })}
                    />
                </div>
                <div className="pr-rpt-history-filter-group">
                    <label className="pr-rpt-history-filter-label">
                        <Icon name="scroll" size={11} />
                        <span>模板</span>
                    </label>
                    <Combobox
                        className="pr-rpt-history-filter-combobox"
                        value={historyFilterTemplate}
                        onChange={(v) => setHistoryFilter({ template: v as ReportTemplate | '' })}
                        ariaLabel="筛选模板"
                        placeholder="全部模板"
                        options={TEMPLATE_FILTER_OPTIONS}
                    />
                </div>
                <div className="pr-rpt-history-filter-group">
                    <label className="pr-rpt-history-filter-label">
                        <Icon name="check-circle" size={11} />
                        <span>状态</span>
                    </label>
                    <Combobox
                        className="pr-rpt-history-filter-combobox"
                        value={historyFilterStatus}
                        onChange={(v) => setHistoryFilter({ status: v as ReportSummary['status'] | '' })}
                        ariaLabel="筛选状态"
                        placeholder="全部状态"
                        options={STATUS_FILTER_OPTIONS}
                    />
                </div>
                {hasActiveFilter && (
                    <button
                        type="button"
                        className="pr-rpt-history-filter-clear"
                        onClick={handleClearFilters}
                        aria-label="清空所有筛选"
                    >
                        <Icon name="x" size={11} />
                        <span>清空</span>
                    </button>
                )}
            </div>

            <Table<ReportSummary>
                columns={columns}
                data={history}
                rowKey={(r) => r.id}
                empty={
                    historyLoading ? (
                        <div
                            className="pr-rpt-history-skeleton"
                            role="status"
                            aria-live="polite"
                            aria-label="正在加载历史报告"
                        >
                            {Array.from({ length: 5 }).map((_, i) => (
                                <div key={i} className="pr-rpt-history-skeleton-row" aria-hidden="true">
                                    {/* 标题列 */}
                                    <Skeleton width="40%" height={13} />
                                    {/* 班级列 */}
                                    <Skeleton width={80} height={13} />
                                    {/* 模板列 */}
                                    <Skeleton width={60} height={18} radius={999} />
                                    {/* 时间列 */}
                                    <Skeleton width={100} height={12} />
                                    {/* 状态列 */}
                                    <Skeleton width={48} height={18} radius={999} />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="pr-rpt-history-empty">
                            <Icon name={hasActiveFilter ? 'magnifying-glass' : 'scroll'} size={28} />
                            <p className="pr-rpt-history-empty-title">
                                {hasActiveFilter ? '未找到匹配的报告' : '暂无历史报告'}
                            </p>
                            <p className="pr-rpt-history-empty-desc">
                                {hasActiveFilter
                                    ? '当前筛选条件下无匹配结果，可调整筛选条件或清空筛选查看全部历史。'
                                    : '尚未生成过教研报告。请在左侧配置班级、时间范围与模板，点击「生成教研报告」后此处将记录历史。'}
                            </p>
                            {hasActiveFilter && (
                                <button
                                    type="button"
                                    className="pr-rpt-history-empty-cta"
                                    onClick={handleClearFilters}
                                >
                                    清空筛选
                                </button>
                            )}
                        </div>
                    )
                }
            />

            {/* 分页器 */}
            {historyTotal > historyPageSize && (
                <div className="pr-rpt-history-pagination">
                    <span className="pr-rpt-history-pagination-info">
                        {startIdx}–{endIdx} / {historyTotal}
                    </span>
                    <div className="pr-rpt-history-pagination-actions">
                        <Button
                            variant="ghost"
                            size="sm"
                            leftIcon={<Icon name="caret-left" size={12} />}
                            onClick={handlePrevPage}
                            disabled={historyPage <= 0}
                        >
                            上一页
                        </Button>
                        <span className="pr-rpt-history-pagination-page">
                            {historyPage + 1} / {totalPages}
                        </span>
                        <Button
                            variant="ghost"
                            size="sm"
                            rightIcon={<Icon name="caret-right" size={12} />}
                            onClick={handleNextPage}
                            disabled={historyPage >= totalPages - 1}
                        >
                            下一页
                        </Button>
                    </div>
                </div>
            )}
        </Card>
    )
})

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────

function formatDateTime(ms: number): string {
    const d = new Date(ms)
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
