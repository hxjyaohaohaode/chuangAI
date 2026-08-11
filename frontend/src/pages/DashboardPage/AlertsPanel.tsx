/**
 * 实时告警面板（v5.0 Dashboard 数据真实化）
 *
 * 对接 GET /api/dashboard/alerts，TanStack Query 直接消费：
 * - staleTime: 30s
 * - retry: 1
 * - 数据联动：classId 变化触发 refetch
 *
 * 告警类型：
 * - 学情异常学生（连续 3 天未学习 / 成绩下滑 > 15 分）
 * - 落后知识点（班级掌握度 < 60%）
 * - 系统告警（AI 调用失败率高等）
 *
 * 每条告警：等级（warning/error/info）+ 标题 + 详情 + 时间 + 操作按钮
 * 点击告警跳转到对应详情页（使用 useNavigate 路由到 actionUrl）
 *
 * 设计要点（规范第 7、14 章）：
 * - 左侧 3px 严重程度竖线（error=error / warning=warning / info=info）
 * - 卡片式列表项，hover 背景色变 + 微位移
 * - 空态：success 色图标 + "暂无告警" 文案
 * - 加载态：骨架屏
 * - 时间戳相对格式化（刚刚 / N 分钟前 / N 小时前 / N 天前）
 * - 完整三态：hover/active/focus-visible
 * - 零硬编码色值：所有颜色从 CSS 变量派生
 *
 * 实时同步（规范第 12 章）：
 * - staleTime 30s 内不重复请求
 * - 用户可点击刷新按钮强制 refetch
 */

import { memo, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Icon, Button } from '@/components/ui'
import { api } from '@/lib/api'
import { useStaggeredEntry } from '@/hooks/useStaggeredEntry'
import type { DashboardAlertV2, DashboardAlertLevel } from '@/lib/types'

interface AlertsPanelProps {
    /** 班级 ID（可选，用于数据联动） */
    classId?: string
}

/** 告警等级中文标签 */
const LEVEL_LABELS: Record<DashboardAlertLevel, string> = {
    info: '提示',
    warning: '预警',
    error: '紧急',
}

/** 告警等级排序权重（error > warning > info） */
const LEVEL_WEIGHT: Record<DashboardAlertLevel, number> = {
    error: 3,
    warning: 2,
    info: 1,
}

/** 查询 staleTime：30 秒 */
const ALERTS_STALE_TIME = 30_000

export const AlertsPanel = memo(function AlertsPanel({
    classId,
}: AlertsPanelProps) {
    const navigate = useNavigate()
    const query = useQuery<DashboardAlertV2[]>({
        queryKey: ['dashboard-v2', 'alerts', classId ?? 'global'],
        queryFn: () => api.dashboardV2.alerts(classId),
        staleTime: ALERTS_STALE_TIME,
        retry: 1,
        // classId 就绪前不发请求：
        // bloom-radar / alerts / weekly-progress 三个端点强制要求 classId，
        // 未就绪就发会先收 3 个 400，随后再用真实 classId 重发一轮，
        // 既产生无效错误噪音，也让面板内容闪烁一次。
        enabled: Boolean(classId),
    })

    /** 告警点击：跳转到 actionUrl 或详情页 */
    const handleAlertClick = useCallback(
        (alert: DashboardAlertV2) => {
            if (alert.actionUrl) {
                navigate(alert.actionUrl)
            }
        },
        [navigate],
    )

    /** 强制刷新 */
    const handleRefresh = useCallback(() => {
        void query.refetch()
    }, [query])

    /** 按等级排序（error 优先，同级按时间倒序） */
    const sortedAlerts = useMemo(() => {
        const list = query.data ?? []
        return [...list].sort((a, b) => {
            const wDiff = LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level]
            if (wDiff !== 0) return wDiff
            const ta = typeof a.timestamp === 'number' ? a.timestamp : Date.parse(a.timestamp)
            const tb = typeof b.timestamp === 'number' ? b.timestamp : Date.parse(b.timestamp)
            return (tb ?? 0) - (ta ?? 0)
        })
    }, [query.data])

    /** staggered 入场动画（规范 7.2 / 6.3）：逐项 50ms 延迟 + spring-snappy */
    const { ref, itemStyle } = useStaggeredEntry<HTMLDivElement>(sortedAlerts.length)

    /** 等级统计 */
    const levelCounts = useMemo(() => {
        const counts: Record<DashboardAlertLevel, number> = { info: 0, warning: 0, error: 0 }
        for (const a of sortedAlerts) counts[a.level]++
        return counts
    }, [sortedAlerts])

    return (
        <div className="pr-alerts-panel">
            <div className="pr-alerts-header">
                <div className="pr-alerts-title-row">
                    <h2 className="pr-alerts-title">实时告警</h2>
                    {sortedAlerts.length > 0 && (
                        <span className="pr-alerts-count">{sortedAlerts.length}</span>
                    )}
                </div>
                <div className="pr-alerts-actions">
                    <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Icon name="arrows-clockwise" size={12} />}
                        loading={query.isFetching && !query.isLoading}
                        onClick={handleRefresh}
                        aria-label="刷新告警列表"
                    >
                        刷新
                    </Button>
                </div>
            </div>

            {/* 等级统计条 */}
            {sortedAlerts.length > 0 && (
                <div className="pr-alerts-summary">
                    {levelCounts.error > 0 && (
                        <span className="pr-alerts-summary-chip pr-alerts-summary-chip--error">
                            <span className="pr-alerts-summary-dot" />
                            紧急 {levelCounts.error}
                        </span>
                    )}
                    {levelCounts.warning > 0 && (
                        <span className="pr-alerts-summary-chip pr-alerts-summary-chip--warning">
                            <span className="pr-alerts-summary-dot" />
                            预警 {levelCounts.warning}
                        </span>
                    )}
                    {levelCounts.info > 0 && (
                        <span className="pr-alerts-summary-chip pr-alerts-summary-chip--info">
                            <span className="pr-alerts-summary-dot" />
                            提示 {levelCounts.info}
                        </span>
                    )}
                </div>
            )}

            {query.isPending ? (
                <AlertsSkeleton />
            ) : query.isError ? (
                <AlertsError
                    message={query.error instanceof Error ? query.error.message : '加载告警列表失败'}
                    onRetry={() => void query.refetch()}
                />
            ) : sortedAlerts.length === 0 ? (
                <AlertsEmpty />
            ) : (
                <div className="pr-alerts-list" role="list" ref={ref}>
                    {sortedAlerts.map((alert, index) => (
                        <AlertItem
                            key={alert.id}
                            alert={alert}
                            onAction={handleAlertClick}
                            style={itemStyle(index)}
                        />
                    ))}
                </div>
            )}
        </div>
    )
})

/** 单条告警 */
function AlertItem({
    alert,
    onAction,
    style,
}: {
    alert: DashboardAlertV2
    onAction?: (alert: DashboardAlertV2) => void
    style?: React.CSSProperties
}) {
    const hasAction = Boolean(alert.actionUrl)
    const actionLabel = alert.actionLabel ?? '查看详情'

    return (
        <article
            className={`pr-alert-item pr-alert-item--${alert.level} ${hasAction ? 'is-actionable' : ''}`.trim()}
            role="listitem"
            style={style}
        >
            <div className="pr-alert-item-content">
                <div className="pr-alert-item-header">
                    <span className="pr-alert-item-title">{alert.title}</span>
                    <span className={`pr-alert-item-severity pr-alert-item-severity--${alert.level}`}>
                        {LEVEL_LABELS[alert.level]}
                    </span>
                </div>
                <p className="pr-alert-item-desc">{alert.detail}</p>
                <div className="pr-alert-item-meta">
                    <span className="pr-alert-item-time">{formatTimestamp(alert.timestamp)}</span>
                    {hasAction && (
                        <button
                            type="button"
                            className="pr-alert-item-action-btn"
                            onClick={() => onAction?.(alert)}
                            aria-label={`${actionLabel}：${alert.title}`}
                        >
                            {actionLabel}
                            <Icon name="arrow-right" size={11} />
                        </button>
                    )}
                </div>
            </div>
        </article>
    )
}

/** 格式化时间戳：支持 number（ms）或 string（ISO 8601） */
function formatTimestamp(ts: string | number): string {
    const t = typeof ts === 'number' ? ts : Date.parse(ts)
    if (Number.isNaN(t)) return ''
    const diff = Date.now() - t
    if (diff < 0) return '刚刚'
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
    const d = new Date(t)
    return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 告警空态 */
function AlertsEmpty() {
    return (
        <div className="pr-alerts-empty">
            <span className="pr-alerts-empty-icon">
                <Icon name="check-circle" size={24} weight="bold" />
            </span>
            <p className="pr-alerts-empty-text">暂无告警，系统运行良好</p>
        </div>
    )
}

/** 加载骨架 */
function AlertsSkeleton() {
    return (
        <div className="pr-alerts-list">
            {[0, 1, 2].map((i) => (
                <div key={i} className="pr-alert-item" style={{ cursor: 'default' }}>
                    <div className="pr-skeleton pr-skeleton-line" style={{ height: 14, width: '70%' }} />
                    <div className="pr-skeleton pr-skeleton-line" style={{ height: 10, width: '100%' }} />
                    <div className="pr-skeleton pr-skeleton-line" style={{ height: 10, width: '90%' }} />
                </div>
            ))}
        </div>
    )
}

/** 错误态：友好提示 + 重试按钮 */
function AlertsError({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="pr-alerts-empty">
            <span className="pr-alerts-empty-icon">
                <Icon name="warning-circle" size={24} weight="bold" />
            </span>
            <p className="pr-alerts-empty-text">告警加载失败</p>
            <p className="pr-alerts-empty-message">{message}</p>
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
