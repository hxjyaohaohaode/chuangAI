/**
 * 班级热点画像（v5.0 Dashboard 数据真实化）
 *
 * 对接 GET /api/dashboard/class-hotspot，TanStack Query 直接消费：
 * - staleTime: 30s
 * - retry: 1
 * - 数据联动：classId 变化触发 refetch
 *
 * 双横向条形图：
 * 1. 班级活跃度排行（前 5）—— accent-primary 单色 alpha 渐变（scoreToSequentialAlpha）
 * 2. 薄弱知识点排行（前 5）—— accent-error / warning 双色梯度
 *
 * 设计要点（规范第 2、5、6、10、14 章）：
 * - 浅色暖调基底 + 透明度分层，无硬边框
 * - 横向条形图：宽度按 max 归一化，避免长名挤压
 * - Tabular Numbers：数值等宽对齐（规范 10.6 / 3.2）
 * - staggered 入场动画：50ms × N，spring-snappy
 * - hover：背景微变 + 数值高亮
 * - 完整三态：hover/active/focus-visible
 * - 零硬编码色值：所有颜色从 CSS 变量派生
 *
 * 加载态：骨架屏（与 surface-secondary 同色系，无边框）
 * 错误态：友好提示 + 重试按钮
 * 空数据态：引导文案 + CTA 按钮
 */

import { memo, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Card, Icon, Button } from '@/components/ui'
import { api } from '@/lib/api'
import { useStaggeredEntry } from '@/hooks/useStaggeredEntry'
import { scoreToSequentialAlpha } from '@/lib/chartPalette'
import type { ClassHotspotDataV2 } from '@/lib/types'

interface ClassHotspotProps {
    /** 班级 ID（可选，用于数据联动） */
    classId?: string
}

/** 查询 staleTime：30 秒 */
const HOTSPOT_STALE_TIME = 30_000

/** 单条活跃度排行最大显示数量 */
const MAX_ACTIVITY_ITEMS = 5
/** 单条薄弱知识点排行最大显示数量 */
const MAX_WEAKNESS_ITEMS = 5

export const ClassHotspot = memo(function ClassHotspot({
    classId,
}: ClassHotspotProps) {
    const navigate = useNavigate()
    const query = useQuery<ClassHotspotDataV2>({
        queryKey: ['dashboard-v2', 'class-hotspot', classId ?? 'global'],
        queryFn: () => api.dashboardV2.classHotspot(classId),
        staleTime: HOTSPOT_STALE_TIME,
        retry: 1,
        // classId 就绪前不发请求：
        // bloom-radar / alerts / weekly-progress 三个端点强制要求 classId，
        // 未就绪就发会先收 3 个 400，随后再用真实 classId 重发一轮，
        // 既产生无效错误噪音，也让面板内容闪烁一次。
        enabled: Boolean(classId),
    })

    /** 强制刷新 */
    const handleRefresh = useCallback(() => {
        void query.refetch()
    }, [query])

    /** 跳转到诊断中心查看详细薄弱知识点 */
    const handleViewDiagnosis = useCallback(() => {
        const params = new URLSearchParams()
        if (classId) params.set('classId', classId)
        params.set('tab', 'diagnosis')
        navigate(`/dashboard?${params.toString()}`)
    }, [classId, navigate])

    const activityItems = useMemo(() => {
        const list = query.data?.activityRanking ?? []
        return list.slice(0, MAX_ACTIVITY_ITEMS)
    }, [query.data])

    const weaknessItems = useMemo(() => {
        const list = query.data?.weakKnowledgeRanking ?? []
        return list.slice(0, MAX_WEAKNESS_ITEMS)
    }, [query.data])

    const maxActivity = useMemo(
        () => activityItems.reduce((m, it) => Math.max(m, it.activityScore), 0),
        [activityItems],
    )
    const maxWeakness = useMemo(
        () => weaknessItems.reduce((m, it) => Math.max(m, it.weaknessScore), 0),
        [weaknessItems],
    )

    const totalItems = activityItems.length + weaknessItems.length
    const { ref, itemStyle } = useStaggeredEntry<HTMLDivElement>(totalItems)

    return (
        <Card className="pr-class-hotspot" padding="lg">
            <div className="pr-hotspot-header">
                <div className="pr-hotspot-title-row">
                    <Icon name="chart-bar" size={16} />
                    <h3 className="pr-hotspot-title">班级热点画像</h3>
                </div>
                <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={<Icon name="arrows-clockwise" size={12} />}
                    loading={query.isFetching && !query.isLoading}
                    onClick={handleRefresh}
                    aria-label="刷新热点画像"
                >
                    刷新
                </Button>
            </div>

            {query.isPending ? (
                <HotspotSkeleton />
            ) : query.isError ? (
                <HotspotError
                    message={query.error instanceof Error ? query.error.message : '加载热点画像失败'}
                    onRetry={() => void query.refetch()}
                />
            ) : totalItems === 0 ? (
                <HotspotEmpty onViewDiagnosis={handleViewDiagnosis} />
            ) : (
                <div className="pr-hotspot-content" ref={ref}>
                    {/* 班级活跃度排行 */}
                    <section className="pr-hotspot-section pr-hotspot-section--activity">
                        <div className="pr-hotspot-section-header">
                            <Icon name="gauge" size={14} />
                            <span className="pr-hotspot-section-title">班级活跃度排行</span>
                            <span className="pr-hotspot-section-count">{activityItems.length}</span>
                        </div>
                        {activityItems.length === 0 ? (
                            <p className="pr-hotspot-section-empty">暂无活跃度数据</p>
                        ) : (
                            <ul className="pr-hotspot-bars" role="list">
                                {activityItems.map((item, idx) => {
                                    const widthPct = maxActivity > 0
                                        ? (item.activityScore / maxActivity) * 100
                                        : 0
                                    const alpha = scoreToSequentialAlpha(
                                        maxActivity > 0
                                            ? (item.activityScore / maxActivity) * 100
                                            : 0,
                                    )
                                    return (
                                        <li
                                            key={`activity-${idx}-${item.className}`}
                                            className="pr-hotspot-bar-item pr-hotspot-bar-item--activity"
                                            style={itemStyle(idx)}
                                            title={`${item.className}：活跃度 ${item.activityScore}`}
                                        >
                                            <span className="pr-hotspot-bar-rank">{idx + 1}</span>
                                            <span className="pr-hotspot-bar-name">{item.className}</span>
                                            <div
                                                className="pr-hotspot-bar-track"
                                                aria-hidden="true"
                                            >
                                                <div
                                                    className="pr-hotspot-bar-fill pr-hotspot-bar-fill--activity"
                                                    style={{
                                                        transform: `scaleX(${widthPct / 100})`,
                                                        ['--bar-alpha' as string]: alpha,
                                                    }}
                                                />
                                            </div>
                                            <span className="pr-hotspot-bar-value">
                                                {item.activityScore}
                                            </span>
                                        </li>
                                    )
                                })}
                            </ul>
                        )}
                    </section>

                    {/* 薄弱知识点排行 */}
                    <section className="pr-hotspot-section pr-hotspot-section--weakness">
                        <div className="pr-hotspot-section-header">
                            <Icon name="warning" size={14} />
                            <span className="pr-hotspot-section-title">薄弱知识点排行</span>
                            <span className="pr-hotspot-section-count">{weaknessItems.length}</span>
                        </div>
                        {weaknessItems.length === 0 ? (
                            <p className="pr-hotspot-section-empty">暂无薄弱知识点</p>
                        ) : (
                            <ul className="pr-hotspot-bars" role="list">
                                {weaknessItems.map((item, idx) => {
                                    const widthPct = maxWeakness > 0
                                        ? (item.weaknessScore / maxWeakness) * 100
                                        : 0
                                    // 严重度等级：1-2 项最严重（error），3-4 项中等（warning），其余 info
                                    const severity = idx < 2 ? 'error' : idx < 4 ? 'warning' : 'info'
                                    return (
                                        <li
                                            key={`weak-${idx}-${item.knowledge}`}
                                            className={`pr-hotspot-bar-item pr-hotspot-bar-item--weakness pr-hotspot-bar-item--${severity}`}
                                            style={itemStyle(activityItems.length + idx)}
                                            title={`${item.knowledge}：薄弱度 ${item.weaknessScore}`}
                                        >
                                            <span className="pr-hotspot-bar-rank">{idx + 1}</span>
                                            <span className="pr-hotspot-bar-name">{item.knowledge}</span>
                                            <div
                                                className="pr-hotspot-bar-track"
                                                aria-hidden="true"
                                            >
                                                <div
                                                    className={`pr-hotspot-bar-fill pr-hotspot-bar-fill--${severity}`}
                                                    style={{ transform: `scaleX(${widthPct / 100})` }}
                                                />
                                            </div>
                                            <span className="pr-hotspot-bar-value">
                                                {item.weaknessScore}
                                            </span>
                                        </li>
                                    )
                                })}
                            </ul>
                        )}
                    </section>

                    {/* 底部操作条：查看诊断详情 */}
                    {weaknessItems.length > 0 && (
                        <div className="pr-hotspot-footer">
                            <button
                                type="button"
                                className="pr-hotspot-footer-btn"
                                onClick={handleViewDiagnosis}
                            >
                                查看诊断详情
                                <Icon name="arrow-right" size={11} />
                            </button>
                        </div>
                    )}
                </div>
            )}
        </Card>
    )
})

/* ============================================================
 * 三态组件：Skeleton / Error / Empty
 * ============================================================ */

/** 加载骨架（规范 14.3 / 6.4：与 surface-secondary 同色系，无边框） */
function HotspotSkeleton() {
    return (
        <div className="pr-hotspot-content">
            {[0, 1].map((section) => (
                <div key={section} className="pr-hotspot-section">
                    <div className="pr-hotspot-section-header">
                        <div
                            className="pr-skeleton"
                            style={{ height: 14, width: 120, borderRadius: 'var(--radius-sm)' }}
                        />
                    </div>
                    <div className="pr-hotspot-bars">
                        {[0, 1, 2, 3, 4].map((i) => (
                            <div key={i} className="pr-hotspot-bar-item">
                                <div
                                    className="pr-skeleton"
                                    style={{ height: 10, width: 60, borderRadius: 'var(--radius-xs)' }}
                                />
                                <div
                                    className="pr-skeleton pr-hotspot-bar-track"
                                    style={{ height: 8, flex: 1 }}
                                />
                                <div
                                    className="pr-skeleton"
                                    style={{ height: 10, width: 28, borderRadius: 'var(--radius-xs)' }}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    )
}

/** 错误态：友好提示 + 重试按钮 */
function HotspotError({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="pr-hotspot-empty pr-hotspot-empty--error" role="alert">
            <span className="pr-hotspot-empty-icon">
                <Icon name="warning-circle" size={24} weight="bold" />
            </span>
            <p className="pr-hotspot-empty-title">热点画像加载失败</p>
            <p className="pr-hotspot-empty-message">{message}</p>
            <Button
                variant="secondary"
                size="sm"
                leftIcon={<Icon name="arrows-clockwise" size={12} />}
                onClick={onRetry}
            >
                重试
            </Button>
        </div>
    )
}

/** 空数据态：引导文案 + CTA 按钮 */
function HotspotEmpty({ onViewDiagnosis }: { onViewDiagnosis: () => void }) {
    return (
        <div className="pr-hotspot-empty">
            <span className="pr-hotspot-empty-icon">
                <Icon name="chart-bar" size={24} weight="bold" />
            </span>
            <p className="pr-hotspot-empty-title">暂无热点数据</p>
            <p className="pr-hotspot-empty-message">
                完成课堂作答与批改后，系统将自动聚合班级活跃度与薄弱知识点。
            </p>
            <Button
                variant="primary"
                size="sm"
                leftIcon={<Icon name="brain" size={12} />}
                onClick={onViewDiagnosis}
            >
                前往诊断中心
            </Button>
        </div>
    )
}
