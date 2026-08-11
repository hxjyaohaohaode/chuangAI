/**
 * 教研报告生成表单（SubTask 14.1 + v5.0 数据真实化）
 *
 * 教师生成教研报告的配置入口，包含：
 * 1. 班级选择（Combobox）
 * 2. 时间范围选择器（开始日期、结束日期）
 * 3. 模板选择（4 选 1：标准/数据驱动/叙事/摘要）
 * 4. 章节多选（4 个 chip：教学背景/干预策略/数据实证/反思展望）
 * 5. 生成按钮（对接 SSE 流式生成 api.report.streamGenerate）
 * 6. 中断按钮（流式生成中可随时中止）
 * 7. 进度条（SSE onProgress 回调实时推送，0-100%）
 * 8. 多智能体协作徽标（onProgress 中的 agentId 实时显示）
 *
 * v5.0 关键改造：
 * - 生成动作改为 streamGenerate（SSE 流式），Markdown 增量直接推送到 store.streamMarkdown
 * - 进度数据来自 SSE onProgress 回调，无需依赖 WS 推送
 * - 新增「中断生成」按钮，调用 abortStream 中止 SSE 流
 *
 * 设计要点（规范第 5、7、14 章）：
 * - 松紧得当：表单项内紧带，分组间稳带
 * - 完整三态：所有可交互元素具备 hover/active/focus-visible
 * - 流体尺寸：日期输入框、模板卡片随容器宽度自适应
 * - 零硬编码：所有色值/尺寸引用 tokens.css 变量
 * - 零 emoji：全部使用 Phosphor SVG 图标
 */

import { memo, useCallback, useEffect } from 'react'
import { Button, Combobox, Icon, type ComboboxOption } from '@/components/ui'
import { useReportStore } from '@/stores/report'
import { useClasses } from '@/hooks/useClasses'
import {
    REPORT_TEMPLATE_LABELS,
    REPORT_TEMPLATE_DESCRIPTIONS,
    REPORT_SECTION_TITLES,
    REPORT_SECTION_DESCRIPTIONS,
    AGENT_LABELS,
} from '@/lib/types'
import type { ReportTemplate, ReportSectionKey } from '@/lib/types'

/** 将 agentId 转换为用户可读的中文标签，找不到映射时回退为通用占位 */
function getAgentLabel(agentId: string): string {
    return AGENT_LABELS[agentId] ?? '智能体'
}

/** 模板选项配置 */
const TEMPLATE_OPTIONS: ReadonlyArray<{ key: ReportTemplate; icon: string }> = [
    { key: 'standard', icon: 'scroll' },
    { key: 'data-driven', icon: 'chart-bar' },
    { key: 'narrative', icon: 'book-open' },
    { key: 'executive', icon: 'list' },
] as const

/** 章节选项配置 */
const SECTION_OPTIONS: ReadonlyArray<{ key: ReportSectionKey; icon: string }> = [
    { key: 'background', icon: 'book-open' },
    { key: 'intervention', icon: 'lightbulb' },
    { key: 'evidence', icon: 'chart-bar' },
    { key: 'reflection', icon: 'arrows-clockwise' },
] as const

export const ReportGenerator = memo(function ReportGenerator() {
    const classId = useReportStore((s) => s.classId)
    const period = useReportStore((s) => s.period)
    const template = useReportStore((s) => s.template)
    const includeSections = useReportStore((s) => s.includeSections)
    const generating = useReportStore((s) => s.generating)
    const currentReport = useReportStore((s) => s.currentReport)
    const agentTasks = useReportStore((s) => s.agentTasks)
    const streamMessage = useReportStore((s) => s.streamMessage)
    const streamActive = useReportStore((s) => s.streamActive)

    const setClassId = useReportStore((s) => s.setClassId)
    const setPeriod = useReportStore((s) => s.setPeriod)
    const setTemplate = useReportStore((s) => s.setTemplate)
    const toggleSection = useReportStore((s) => s.toggleSection)
    const streamGenerate = useReportStore((s) => s.streamGenerate)
    const abortStream = useReportStore((s) => s.abortStream)

    const { classes } = useClasses()

    /**
     * 班级列表到达后默认选中第一个
     *
     * 此前整页初始 classId 为空串，于是报告生成、家校联系本、历史筛选
     * 全部停在"请先选择班级"。教师绝大多数时候只带一两个班，
     * 让他每次进页面先手动选一次，是纯粹的空转。
     * 驾驶舱早已是"默认选中第一个班"的行为，这里与之对齐。
     * 只在当前确实为空时写入，绝不覆盖用户已做的选择。
     */
    useEffect(() => {
        const firstClass = classes[0]
        if (!classId && firstClass) setClassId(firstClass.id)
    }, [classId, classes, setClassId])

    /** 提交生成 —— v5.0：使用 SSE 流式生成 */
    const handleSubmit = useCallback(() => {
        void streamGenerate()
    }, [streamGenerate])

    /** 中断生成 */
    const handleAbort = useCallback(() => {
        abortStream()
    }, [abortStream])

    /** 当前进度（优先用 currentReport.progress，fallback 计算 agentTasks 完成比例） */
    const progress = currentReport?.progress ?? (
        agentTasks.length > 0
            ? Math.round((agentTasks.filter((t) => t.status === 'success').length / agentTasks.length) * 100)
            : 0
    )

    // 当 generating 且 progress > 0 时显示进度条
    const showProgress = generating && progress > 0

    return (
        <div className="pr-rpt-form">
            {/* 班级选择 */}
            <div className="pr-rpt-form-group">
                <label className="pr-rpt-form-label" htmlFor="rpt-class-select">
                    <Icon name="graduation" size={14} />
                    <span>目标班级</span>
                </label>
                <div className="pr-rpt-select-wrapper">
                    <Combobox
                        id="rpt-class-select"
                        className="pr-rpt-select"
                        value={classId}
                        onChange={(v) => setClassId(v as string)}
                        disabled={generating}
                        ariaLabel="选择目标班级"
                        placeholder="请选择班级"
                        options={[
                            { value: '', label: '请选择班级' },
                            ...classes.map<ComboboxOption>((opt) => ({
                                value: opt.id,
                                label: opt.name,
                            })),
                        ]}
                    />
                </div>
            </div>

            {/* 时间范围 */}
            <div className="pr-rpt-form-group">
                <span className="pr-rpt-form-label">
                    <Icon name="calendar" size={14} />
                    <span>时间范围</span>
                </span>
                <div className="pr-rpt-date-row">
                    <div className="pr-rpt-date-field">
                        <label className="pr-rpt-date-label" htmlFor="rpt-date-from">开始日期</label>
                        <input
                            id="rpt-date-from"
                            type="date"
                            className="pr-rpt-date-input"
                            value={period.from}
                            max={period.to}
                            onChange={(e) => setPeriod({ ...period, from: e.target.value })}
                            disabled={generating}
                        />
                    </div>
                    <span className="pr-rpt-date-sep" aria-hidden>
                        <Icon name="arrow-right" size={14} />
                    </span>
                    <div className="pr-rpt-date-field">
                        <label className="pr-rpt-date-label" htmlFor="rpt-date-to">结束日期</label>
                        <input
                            id="rpt-date-to"
                            type="date"
                            className="pr-rpt-date-input"
                            value={period.to}
                            min={period.from}
                            onChange={(e) => setPeriod({ ...period, to: e.target.value })}
                            disabled={generating}
                        />
                    </div>
                </div>
            </div>

            {/* 模板选择 */}
            <div className="pr-rpt-form-group">
                <span className="pr-rpt-form-label">
                    <Icon name="scroll" size={14} />
                    <span>报告模板</span>
                </span>
                <div className="pr-rpt-template-grid" role="radiogroup" aria-label="报告模板">
                    {TEMPLATE_OPTIONS.map((opt) => {
                        const active = template === opt.key
                        return (
                            <button
                                key={opt.key}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                className={`pr-rpt-template-card${active ? ' is-active' : ''}`}
                                onClick={() => setTemplate(opt.key)}
                                disabled={generating}
                            >
                                <span className="pr-rpt-template-icon">
                                    <Icon name={opt.icon as 'scroll'} size={18} active={active} />
                                </span>
                                <span className="pr-rpt-template-label">{REPORT_TEMPLATE_LABELS[opt.key]}</span>
                                <span className="pr-rpt-template-desc">{REPORT_TEMPLATE_DESCRIPTIONS[opt.key]}</span>
                            </button>
                        )
                    })}
                </div>
            </div>

            {/* 章节多选 */}
            <div className="pr-rpt-form-group">
                <span className="pr-rpt-form-label">
                    <Icon name="list" size={14} />
                    <span>包含章节（可多选）</span>
                </span>
                <div className="pr-rpt-section-chips" role="group" aria-label="章节选择">
                    {SECTION_OPTIONS.map((opt) => {
                        const active = includeSections.includes(opt.key)
                        return (
                            <button
                                key={opt.key}
                                type="button"
                                aria-pressed={active}
                                className={`pr-rpt-section-chip${active ? ' is-active' : ''}`}
                                onClick={() => toggleSection(opt.key)}
                                disabled={generating}
                            >
                                <Icon name={opt.icon as 'list'} size={14} active={active} />
                                <span className="pr-rpt-section-chip-label">{REPORT_SECTION_TITLES[opt.key]}</span>
                                <span className="pr-rpt-section-chip-desc">{REPORT_SECTION_DESCRIPTIONS[opt.key]}</span>
                            </button>
                        )
                    })}
                </div>
            </div>

            {/* 生成按钮 + 中断按钮 */}
            <div className="pr-rpt-form-actions">
                {generating ? (
                    <div className="pr-rpt-form-action-row">
                        <Button
                            variant="primary"
                            size="lg"
                            block
                            leftIcon={<Icon name="sparkle" size={18} />}
                            loading
                            disabled
                        >
                            多智能体协作中…
                        </Button>
                        <Button
                            variant="ghost"
                            size="lg"
                            leftIcon={<Icon name="stop" size={16} />}
                            onClick={handleAbort}
                            aria-label="中断生成"
                        >
                            中断
                        </Button>
                    </div>
                ) : (
                    <Button
                        variant="primary"
                        size="lg"
                        block
                        leftIcon={<Icon name="sparkle" size={18} />}
                        onClick={handleSubmit}
                        disabled={!classId}
                    >
                        生成教研报告
                    </Button>
                )}
                {!classId && !generating && (
                    <p className="pr-rpt-form-hint">请先选择目标班级</p>
                )}
            </div>

            {/* 进度条 */}
            {showProgress && (
                <div className="pr-rpt-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                    <div className="pr-rpt-progress-head">
                        <span className="pr-rpt-progress-label">生成进度</span>
                        <span className="pr-rpt-progress-value">{progress}%</span>
                    </div>
                    <div className="pr-rpt-progress-track">
                        <div className="pr-rpt-progress-fill" style={{ transform: `scaleX(${progress / 100})` }} />
                    </div>
                    {streamMessage && (
                        <div className="pr-rpt-progress-message" aria-live="polite">
                            <Icon name="arrows-clockwise" size={12} />
                            <span>{streamMessage}</span>
                        </div>
                    )}
                    {agentTasks.length > 0 && (
                        <div className="pr-rpt-progress-agents">
                            {agentTasks.map((t) => (
                                <span
                                    key={t.taskId}
                                    className={`pr-rpt-progress-agent pr-rpt-progress-agent--${t.status}`}
                                    title={`${getAgentLabel(t.agentId)}：${t.status === 'success' ? '已完成' : t.status === 'failed' ? '已失败' : '执行中'}`}
                                >
                                    <Icon
                                        name={t.status === 'success' ? 'check-circle' : t.status === 'failed' ? 'x-circle' : 'arrows-clockwise'}
                                        size={12}
                                    />
                                    {getAgentLabel(t.agentId)}
                                </span>
                            ))}
                        </div>
                    )}
                    {streamActive && (
                        <div className="pr-rpt-progress-stream-hint">
                            <Icon name="text-aa" size={12} />
                            <span>SSE 流式输出中，预览区实时更新</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
})
