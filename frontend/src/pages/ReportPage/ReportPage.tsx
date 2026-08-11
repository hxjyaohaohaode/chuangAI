/**
 * 教研报告自动生成主页面（SubTask 14.7 —— 布局组装）
 *
 * 教师总结教学成果、参与教研活动的关键功能入口，组装全部子组件：
 *
 * 布局（桌面三列 / 平板双列 / 移动单列）：
 * - 顶部 Header：页面标题 + WS 状态 + 多智能体协作标识
 * - 左列（窄）：生成表单 ReportGenerator + 导出面板 ExportPanel
 * - 中列（宽）：报告预览 ReportPreview
 * - 右列（窄）：历史报告 ReportHistory
 *
 * 数据流：
 * - useReportStore 提供表单状态、生成结果、历史列表
 * - useWSSubscription 订阅全局 wsDispatcher（连接由 App.tsx 统一管理），事件回流至 store.handleWSEvent
 * - 挂载时自动拉取模板配置
 *
 * 设计要点（规范第 5、8、12 章）：
 * - 松紧得当：header 紧带，三列间稳带，列内组件间稳带
 * - 实时数据同步：WS 事件 ≤200ms 触发 store 更新
 * - 响应式：1400px / 900px 双断点切换列数
 * - 流体尺寸：列宽用 clamp()，间距用 tokens 变量
 * - 零 emoji，全部使用 Phosphor SVG 图标
 */

import { useEffect } from 'react'
import '@/components/ui/icons-extended'
import { Icon } from '@/components/ui'
import { GradualBlur } from '@/components/ui/GradualBlur'
import { ScrollReveal } from '@/components/ui/ScrollReveal'
import { useReportStore } from '@/stores/report'
import { useWSSubscription } from '@/hooks/useWSSubscription'
import { ReportGenerator } from './ReportGenerator'
import { ReportPreview } from './ReportPreview'
import { ExportPanel } from './ExportPanel'
import { ReportHistory } from './ReportHistory'
import { ReportActionBoard } from './ReportActionBoard'
import { ReportSharePanel } from './ReportSharePanel'
import './ReportPage.css'

/** WS 状态中文标签 */
const WS_STATUS_LABELS: Record<string, string> = {
    idle: '未连接',
    connecting: '连接中',
    connected: '实时同步',
    disconnected: '已断开',
    error: '连接异常',
}

/** 报告能力入口：只做紧凑说明，不抢占生成配置首屏。 */
const REPORT_TEMPLATES: ReadonlyArray<{
    id: string
    name: string
    icon: string
}> = [
        { id: 'classroom', name: '课堂协奏报告', icon: 'chart-bar' },
        { id: 'period', name: '学情周期画像', icon: 'chart-line-up' },
        { id: 'diagnosis', name: '认知诊断书', icon: 'brain' },
        { id: 'review', name: '教研复盘纪要', icon: 'scale' },
    ]

export default function ReportPage() {
    const wsStatus = useReportStore((s) => s.wsStatus)
    const setWsStatus = useReportStore((s) => s.setWsStatus)
    const handleWSEvent = useReportStore((s) => s.handleWSEvent)
    const fetchOptions = useReportStore((s) => s.fetchOptions)
    const generating = useReportStore((s) => s.generating)

    // v5.0 Task 3.4：订阅全局 wsDispatcher
    useWSSubscription({
        onEvent: handleWSEvent,
        onStatusChange: setWsStatus,
    })

    // 挂载时拉取模板配置
    useEffect(() => {
        void fetchOptions()
    }, [fetchOptions])

    return (
        <div className="pr-rpt-page pr-v5-enter-report">
            {/* v5.0 Hero：长卷轴意象 —— 标题横跨全宽 + 模板切换标签 + 卷轴缩略预览
             * spec v7 Phase 6：集成 VariableProximity（标题字重跟随鼠标）+ StreamText（副标题流式输出） */}
            <section
                className="pr-v5-hero pr-v5-hero--report"
                aria-label="教研报告概览"
                data-anchor
                data-anchor-label="长卷轴"
            >
                <div className="pr-rpt-hero-axis" aria-hidden="true">
                    <span className="pr-rpt-hero-axis-spine" />
                    <span className="pr-rpt-hero-axis-knob pr-rpt-hero-axis-knob--top" />
                    <span className="pr-rpt-hero-axis-knob pr-rpt-hero-axis-knob--bottom" />
                </div>
                <div className="pr-rpt-hero-inner">
                    <span className="pr-rpt-hero-eyebrow pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '0ms' }}>
                        <Icon name="scroll" size={12} />
                        <span>长卷轴 · 多智能体协作</span>
                    </span>
                    <h1 className="pr-rpt-hero-title pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '80ms' }}>教研报告</h1>
                    <div className="pr-rpt-hero-subtitle pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '160ms' }}>
                        基于真实课堂、批改与诊断数据生成；自动脱敏、证据可追溯，可导出 Word 兼容文档、PDF 打印版、CSV 与 Markdown。
                    </div>
                    <div className="pr-rpt-hero-templates pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '240ms' }}>
                        {REPORT_TEMPLATES.map((tmpl) => (
                            <span key={tmpl.id} className="pr-rpt-hero-template">
                                <Icon name={tmpl.icon as 'chart-bar'} size={12} />
                                <span>{tmpl.name}</span>
                            </span>
                        ))}
                    </div>
                    <div className="pr-rpt-hero-status pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '320ms' }}>
                        <div className={`pr-rpt-page-ws-status pr-rpt-page-ws-status--${wsStatus}`}>
                            <Icon
                                name={wsStatus === 'connected' ? 'check-circle' : 'arrows-clockwise'}
                                size={12}
                            />
                            <span>{WS_STATUS_LABELS[wsStatus] ?? '未连接'}</span>
                        </div>
                        {generating && (
                            <div className="pr-rpt-page-agent-active">
                                <Icon name="sparkle" size={12} />
                                <span>多智能体协作生成中</span>
                            </div>
                        )}
                    </div>
                </div>
            </section>

            {/* 主体三列布局 */}
            <ScrollReveal>
                <div className="pr-rpt-page-body">
                    {/* 左列：表单 + 导出 */}
                    <aside
                        className="pr-rpt-page-left"
                        data-anchor
                        data-anchor-label="生成配置"
                    >
                        <section className="pr-rpt-page-left-form">
                            <div className="pr-rpt-page-section-head">
                                <Icon name="feather" size={14} />
                                <span>生成配置</span>
                            </div>
                            <ReportGenerator />
                        </section>
                        <section className="pr-rpt-page-left-export">
                            <ExportPanel />
                        </section>
                        <section
                            className="pr-rpt-page-left-share"
                            data-anchor
                            data-anchor-label="隐私分享"
                        >
                            <ReportSharePanel />
                        </section>
                    </aside>

                    {/* 中列：报告预览 + 教学改进行动台 */}
                    <main
                        className="pr-rpt-page-main"
                        data-anchor
                        data-anchor-label="报告预览"
                    >
                        <ReportPreview />
                        {/* GradualBlur 渐进模糊边界遮罩
                         * 仅保留本项目独立实现的产品需求：
                         * 卷轴意象的视觉延伸 —— 底部渐进模糊暗示"卷轴未尽"
                         * 多层 backdrop-filter 叠加 + bezier 曲线分布，营造柔和的边缘渐隐
                         * strength=2 + divCount=6 平衡视觉强度与性能 */}
                        <GradualBlur
                            position="bottom"
                            height="6rem"
                            strength={2}
                            divCount={6}
                            curve="bezier"
                            opacity={0.9}
                        />
                        <section
                            className="pr-rpt-page-action-board"
                            data-anchor
                            data-anchor-label="教学改进行动台"
                        >
                            <ReportActionBoard />
                        </section>
                    </main>

                    {/* 右列：历史报告 */}
                    <aside
                        className="pr-rpt-page-right"
                        data-anchor
                        data-anchor-label="历史报告"
                    >
                        <ReportHistory />
                    </aside>
                </div>
            </ScrollReveal>
        </div>
    )
}
