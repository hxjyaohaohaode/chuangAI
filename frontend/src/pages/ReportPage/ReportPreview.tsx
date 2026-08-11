/**
 * 教研报告预览（SubTask 14.2 + SubTask 14.6 + v5.0 数据真实化）
 *
 * 渲染生成的教研报告，包含：
 * - 标题（含「（AI 生成）」后缀 —— 后端 brush.report 已添加）
 * - AI 生成徽标 + 脱敏标识
 * - 左侧目录（章节导航，点击滚动定位）
 * - Markdown 渲染章节内容
 * - 关键发现列表
 * - 教学建议列表
 * - v5.0：图表区（ReportChartsContainer 通过 useQuery 拉取 /api/report/:id/charts）
 * - v5.0：SSE 流式生成中的实时 Markdown 渲染（脉动光标）
 * - v5.0：打印按钮（@media print 友好）
 * - 右下角 AI 生成水印（SubTask 14.6）
 *
 * v5.0 关键改造：
 * - 生成中状态：从 store.streamMarkdown 实时渲染 Markdown，配合脉动光标
 * - 已完成状态：从 store.currentReport.output 渲染结构化章节
 * - 图表区：使用 ReportChartsContainer（TanStack Query 驱动）
 * - 打印：提供顶部打印按钮，配合 @media print 样式
 *
 * 设计要点（规范第 9、14 章）：
 * - Markdown 排版级别渲染，对标 GitHub + Notion
 * - 左侧目录吸顶，点击平滑滚动到对应章节
 * - AI 生成水印固定在右下角，半透明不干扰阅读
 * - 脱敏元数据以徽标形式展示在标题区域
 * - 零 emoji，所有图标使用 Phosphor SVG
 */

import { memo, useState, useCallback, useEffect, useRef } from 'react'
import { Card, Icon, Badge, Button } from '@/components/ui'
import { Markdown } from '@/components/ui/Markdown'
import { useReportStore } from '@/stores/report'
import {
    BloomRadarChartReport,
    WeeklyActivityChart,
    DarkMatterChart,
    EngagementChart,
    ReportChartsContainer,
} from './ReportCharts'

import { getDisplayError } from '@/lib/errors'

/** 章节锚点 ID 前缀 */
const SECTION_ANCHOR_PREFIX = 'rpt-section-'

export const ReportPreview = memo(function ReportPreview() {
    const report = useReportStore((s) => s.currentReport)
    const generating = useReportStore((s) => s.generating)
    const streamGenerate = useReportStore((s) => s.streamGenerate)
    const streamMarkdown = useReportStore((s) => s.streamMarkdown)
    const streamActive = useReportStore((s) => s.streamActive)
    const streamMessage = useReportStore((s) => s.streamMessage)
    const abortStream = useReportStore((s) => s.abortStream)
    const [activeSection, setActiveSection] = useState<string>('')

    const contentRef = useRef<HTMLDivElement | null>(null)

    /** 点击目录项，平滑滚动到对应章节 */
    const handleTocClick = useCallback((key: string) => {
        const el = document.getElementById(`${SECTION_ANCHOR_PREFIX}${key}`)
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' })
            setActiveSection(key)
        }
    }, [])

    /** 滚动时高亮当前章节 */
    useEffect(() => {
        if (!report || report.status !== 'completed' || !report.output) return
        const container = contentRef.current
        if (!container) return
        // 提取到局部 const，避免 handler 闭包内类型窄化丢失（TS 限制）
        const output = report.output

        const handler = () => {
            const sections = output.sections
            for (const s of sections) {
                const el = document.getElementById(`${SECTION_ANCHOR_PREFIX}${s.key}`)
                if (el) {
                    const rect = el.getBoundingClientRect()
                    if (rect.top <= 120 && rect.bottom > 120) {
                        setActiveSection(s.key)
                        return
                    }
                }
            }
        }
        container.addEventListener('scroll', handler, { passive: true })
        return () => container.removeEventListener('scroll', handler)
    }, [report])

    /** 打印当前报告 */
    const handlePrint = useCallback(() => {
        window.print()
    }, [])

    // ── v5.0：SSE 流式生成中 —— 实时 Markdown 渲染 ──
    if (generating && streamActive) {
        return (
            <Card className="pr-rpt-preview pr-rpt-preview--streaming" padding="lg">
                <header className="pr-rpt-preview-header">
                    <div className="pr-rpt-preview-title-row">
                        <h2 className="pr-rpt-preview-title">
                            多智能体协作生成中
                        </h2>
                        <div className="pr-rpt-preview-badges">
                            <Badge variant="primary" icon={<Icon name="sparkle" size={10} />}>AI 生成</Badge>
                            <Badge variant="info" icon={<Icon name="arrows-clockwise" size={10} />}>流式输出</Badge>
                        </div>
                    </div>
                    {streamMessage && (
                        <div className="pr-rpt-preview-stream-message" aria-live="polite">
                            <Icon name="arrows-clockwise" size={12} />
                            <span>{streamMessage}</span>
                        </div>
                    )}
                    <div className="pr-rpt-preview-stream-actions">
                        <Button
                            variant="ghost"
                            size="sm"
                            leftIcon={<Icon name="stop" size={14} />}
                            onClick={abortStream}
                        >
                            中断生成
                        </Button>
                    </div>
                </header>
                <div className="pr-rpt-preview-stream-body">
                    {streamMarkdown ? (
                        <Markdown content={streamMarkdown} streaming />
                    ) : (
                        <div className="pr-rpt-preview-stream-waiting">
                            <Icon name="hourglass" size={20} />
                            <p>等待首个智能体输出内容…</p>
                        </div>
                    )}
                </div>
                <div className="pr-rpt-watermark" aria-hidden>
                    <Icon name="sparkle" size={10} />
                    <span>本报告由诗脉·启明 AI 多智能体协作生成</span>
                </div>
            </Card>
        )
    }

    // ── 生成中（非流式，WS 推送或轮询）：骨架屏 ──
    if (generating || (report && report.status === 'generating')) {
        return (
            <Card className="pr-rpt-preview pr-rpt-preview--loading" padding="lg">
                <div className="pr-rpt-skeleton-header">
                    <div className="pr-skeleton pr-rpt-skeleton-title" />
                    <div className="pr-skeleton pr-rpt-skeleton-badge" />
                </div>
                <div className="pr-rpt-skeleton-toc">
                    <div className="pr-skeleton pr-rpt-skeleton-toc-item" />
                    <div className="pr-skeleton pr-rpt-skeleton-toc-item" />
                    <div className="pr-skeleton pr-rpt-skeleton-toc-item" />
                    <div className="pr-skeleton pr-rpt-skeleton-toc-item" />
                </div>
                <div className="pr-rpt-skeleton-body">
                    <div className="pr-skeleton pr-rpt-skeleton-line" />
                    <div className="pr-skeleton pr-rpt-skeleton-line" />
                    <div className="pr-skeleton pr-rpt-skeleton-line pr-rpt-skeleton-line--short" />
                    <div className="pr-skeleton pr-rpt-skeleton-line" />
                    <div className="pr-skeleton pr-rpt-skeleton-line" />
                </div>
                <p className="pr-rpt-preview-loading-text">
                    <Icon name="arrows-clockwise" size={14} />
                    多智能体正在协作生成报告…
                </p>
            </Card>
        )
    }

    // ── 生成失败：错误提示（v5.0 Task 5.4：增加重试按钮，避免死路） ──
    if (report && report.status === 'failed') {
        return (
            <Card className="pr-rpt-preview pr-rpt-preview--error" padding="lg">
                <div className="pr-rpt-preview-error">
                    <Icon name="x-circle" size={32} />
                    <h3 className="pr-rpt-preview-error-title">报告生成失败</h3>
                    <p className="pr-rpt-preview-error-msg">{getDisplayError(report.error, '未知错误')}</p>
                    <div className="pr-rpt-preview-error-actions">
                        <Button
                            variant="primary"
                            size="sm"
                            leftIcon={<Icon name="arrows-clockwise" size={14} />}
                            onClick={() => void streamGenerate()}
                        >
                            重新生成
                        </Button>
                    </div>
                </div>
            </Card>
        )
    }

    // ── 无报告：空状态 ──
    if (!report || !report.output) {
        return (
            <Card className="pr-rpt-preview pr-rpt-preview--empty" padding="lg">
                <div className="pr-rpt-preview-empty">
                    <Icon name="scroll" size={32} />
                    <h3 className="pr-rpt-preview-empty-title">尚未生成报告</h3>
                    <p className="pr-rpt-preview-empty-desc">
                        请在左侧配置班级、时间范围与模板，然后点击「生成教研报告」启动多智能体协作生成流程。
                    </p>
                    <div className="pr-rpt-preview-empty-actions">
                        <Button
                            variant="primary"
                            size="sm"
                            leftIcon={<Icon name="sparkle" size={14} />}
                            onClick={() => void streamGenerate()}
                        >
                            生成教研报告
                        </Button>
                    </div>
                </div>
            </Card>
        )
    }

    const { output, exportedData, darkMatterReport, verification } = report
    const period = report.period

    return (
        <div className="pr-rpt-preview-wrapper">
            {/* 主预览区 */}
            <Card className="pr-rpt-preview" padding="lg">
                {/* 标题区域 + AI 徽标 + 脱敏标识 + 打印按钮 */}
                <header className="pr-rpt-preview-header">
                    <div className="pr-rpt-preview-title-row">
                        <h2 className="pr-rpt-preview-title" tabIndex={-1}>{output.title}</h2>
                        <div className="pr-rpt-preview-badges">
                            <Badge variant="primary" icon={<Icon name="sparkle" size={10} />}>AI 生成</Badge>
                            <Badge variant="success" icon={<Icon name="check-circle" size={10} />}>已脱敏</Badge>
                        </div>
                    </div>
                    <div className="pr-rpt-preview-meta">
                        <span className="pr-rpt-preview-meta-item">
                            <Icon name="graduation" size={12} />
                            {report.className}
                        </span>
                        <span className="pr-rpt-preview-meta-item">
                            <Icon name="calendar" size={12} />
                            {formatDate(period.from)} — {formatDate(period.to)}
                        </span>
                        <span className="pr-rpt-preview-meta-item">
                            <Icon name="clock" size={12} />
                            {formatDateTime(report.createdAt)}
                        </span>
                        {exportedData && (
                            <span className="pr-rpt-preview-meta-item">
                                <Icon name="user" size={12} />
                                {exportedData.anonymizedStudents.length} 名学生
                            </span>
                        )}
                    </div>
                    {/* 打印按钮 */}
                    <div className="pr-rpt-preview-print-actions no-print">
                        <Button
                            variant="ghost"
                            size="sm"
                            leftIcon={<Icon name="printer" size={14} />}
                            onClick={handlePrint}
                            aria-label="打印报告"
                        >
                            打印
                        </Button>
                    </div>
                </header>

                {/* 主体：左侧目录 + 右侧内容 */}
                <div className="pr-rpt-preview-body">
                    {/* 左侧目录 */}
                    <aside className="pr-rpt-preview-toc no-print">
                        <div className="pr-rpt-preview-toc-head">
                            <Icon name="list" size={14} />
                            <span>目录</span>
                        </div>
                        <nav className="pr-rpt-preview-toc-nav">
                            {output.sections.map((s) => (
                                <button
                                    key={s.key}
                                    type="button"
                                    className={`pr-rpt-preview-toc-item${activeSection === s.key ? ' is-active' : ''}`}
                                    onClick={() => handleTocClick(s.key)}
                                >
                                    {s.title}
                                </button>
                            ))}
                        </nav>
                        {/* 验收结果摘要 */}
                        {verification && (
                            <div className="pr-rpt-preview-verify">
                                <div className="pr-rpt-preview-verify-head">
                                    <Icon name="check-circle" size={14} />
                                    <span>验收结果</span>
                                </div>
                                <Badge variant={verification.verdict === 'pass' ? 'success' : verification.verdict === 'revise' ? 'warning' : 'error'}>
                                    {verification.verdict === 'pass' ? '通过' : verification.verdict === 'revise' ? '需修订' : '拒绝'}
                                    {' · '}{verification.score}分
                                </Badge>
                            </div>
                        )}
                    </aside>

                    {/* 右侧内容 */}
                    <div className="pr-rpt-preview-content" ref={contentRef}>
                        {/* v5.0：图表区 —— 8 张图表分两组渲染
                         * 1. ReportChartsContainer：通过 useQuery 拉取 /api/report/:id/charts（4 张新图表）
                         * 2. 原 4 张图表：基于 ReportRecord.exportedData（保留向后兼容） */}
                        <ReportChartsContainer reportId={report.id} />
                        {exportedData && (
                            <div className="pr-rpt-preview-charts">
                                <BloomRadarChartReport radar={exportedData.classBloomRadar} />
                                <WeeklyActivityChart events={exportedData.events} period={period} />
                                <DarkMatterChart report={darkMatterReport ?? null} />
                                <EngagementChart events={exportedData.events} period={period} />
                            </div>
                        )}

                        {/* 章节内容 */}
                        {output.sections.map((s) => (
                            <section
                                key={s.key}
                                id={`${SECTION_ANCHOR_PREFIX}${s.key}`}
                                className="pr-rpt-preview-section"
                            >
                                <h2 className="pr-rpt-preview-section-title">{s.title}</h2>
                                <Markdown content={s.content} />
                            </section>
                        ))}

                        {/* 关键发现 */}
                        {output.keyFindings.length > 0 && (
                            <section className="pr-rpt-preview-findings">
                                <h2 className="pr-rpt-preview-section-title">
                                    <Icon name="lightbulb" size={18} />
                                    关键发现
                                </h2>
                                <ul className="pr-rpt-preview-findings-list">
                                    {output.keyFindings.map((f, i) => (
                                        <li key={i} className="pr-rpt-preview-finding-item">{f}</li>
                                    ))}
                                </ul>
                            </section>
                        )}

                        {/* 教学建议 */}
                        {output.recommendations.length > 0 && (
                            <section className="pr-rpt-preview-recommendations">
                                <h2 className="pr-rpt-preview-section-title">
                                    <Icon name="arrows-clockwise" size={18} />
                                    教学建议
                                </h2>
                                <ol className="pr-rpt-preview-recommendations-list">
                                    {output.recommendations.map((r, i) => (
                                        <li key={i} className="pr-rpt-preview-recommendation-item">{r}</li>
                                    ))}
                                </ol>
                            </section>
                        )}
                    </div>
                </div>

                {/* AI 生成水印（SubTask 14.6） */}
                <div className="pr-rpt-watermark" aria-hidden>
                    <Icon name="sparkle" size={10} />
                    <span>本报告由诗脉·启明 AI 多智能体协作生成</span>
                </div>
            </Card>
        </div>
    )
})

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────

function formatDate(ms: number): string {
    const d = new Date(ms)
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function formatDateTime(ms: number): string {
    const d = new Date(ms)
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
