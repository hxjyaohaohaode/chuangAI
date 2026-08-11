/**
 * 顶部统计卡片（v5.0 Dashboard 数据真实化）
 *
 * 对接 GET /api/dashboard/stats，TanStack Query 直接消费：
 * - staleTime: 30s
 * - retry: 1
 * - 数据联动：classId 变化触发 refetch
 *
 * 4 个核心统计卡片：
 * 1. 学生总数（含本周新增）
 * 2. 班级总数
 * 3. 诗词库存数（含本周新增）
 * 4. 今日学习总时长（小时）
 *
 * 设计要点（规范第 14.3、5.3、2 章）：
 * - 卡片 surface-secondary + 噪点纹理 + 12px 圆角
 * - hover translateY(-2px) + 阴影扩散
 * - 数字使用 Tabular Numbers 等宽对齐
 * - 同比/环比变化：绿色↑（正增长）/ 红色↓（负增长）
 * - 流体响应式：auto-fit minmax，600-2400px 无断裂
 * - 零硬编码色值：所有颜色从 CSS 变量派生
 *
 * 加载态：骨架屏（与 surface-secondary 同色系，无边框）
 * 错误态：友好提示 + 重试按钮
 * 空数据态：引导文案 + CTA 按钮
 */

import { memo, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Icon, Button } from '@/components/ui'
import { Counter } from '@/components/ui/Counter'
import { api } from '@/lib/api'
import type { DashboardStatsV2 } from '@/lib/types'

/** 单个统计卡片配置 */
interface StatCardConfig {
    key: string
    label: string
    icon: React.ReactNode
    value: React.ReactNode
    suffix?: string
    /** 副文案（如"本周新增 N"） */
    subtext?: React.ReactNode
    /** 同比/环比变化百分比（正数为增长，负数为下降） */
    changePercent?: number
    /** 变化文案标签（如"周环比"） */
    changeLabel?: string
    variant?: 'default' | 'success' | 'warning' | 'info'
}

interface DashboardStatsProps {
    /** 班级 ID（可选，用于数据联动） */
    classId?: string
}

/** 查询 staleTime：30 秒 */
const STATS_STALE_TIME = 30_000

export const DashboardStatsCard = memo(function DashboardStatsCard({
    classId,
}: DashboardStatsProps) {
    const query = useQuery<DashboardStatsV2>({
        queryKey: ['dashboard-v2', 'stats', classId ?? 'global'],
        queryFn: () => api.dashboardV2.stats(classId),
        staleTime: STATS_STALE_TIME,
        retry: 1,
        // classId 就绪前不发请求：
        // bloom-radar / alerts / weekly-progress 三个端点强制要求 classId，
        // 未就绪就发会先收 3 个 400，随后再用真实 classId 重发一轮，
        // 既产生无效错误噪音，也让面板内容闪烁一次。
        enabled: Boolean(classId),
    })

    // classId 未就绪时 useQuery 处于 disabled 状态（isLoading 为 false），
    // 用 isPending 统一覆盖「等待班级选定」与「正在请求」两种情况，
    // 使面板在这两种状态下都显示骨架屏，而不是错误地落到空状态分支。
    if (query.isPending) {
        return <StatsSkeleton />
    }

    if (query.isError) {
        return (
            <StatsError
                message={query.error instanceof Error ? query.error.message : '加载统计数据失败'}
                onRetry={() => void query.refetch()}
            />
        )
    }

    const data = query.data
    // 走到这里 data 必然存在（isPending / isError 已提前返回）。
    // 空态判据改为「后端确实没有任何班级与学生」，而不是 data 为空——
    // 后者在类型上已不可能发生，写了也永远不会触发，反而掩盖真实的空数据场景。
    const hasNoRoster = (data.totalClasses ?? 0) === 0 && (data.totalStudents ?? 0) === 0
    if (hasNoRoster) {
        return <StatsEmpty onRetry={() => void query.refetch()} />
    }

    // v5.0 防御性解构：后端可能返回旧版字段（studentCount/weekProgress），
    // 此处做兼容映射，避免 weekOverWeekChange 为 undefined 时崩溃
    const wowChange = data.weekOverWeekChange ?? { students: 0, studyTime: 0 }
    const totalStudents = data.totalStudents ?? (data as { studentCount?: number }).studentCount ?? 0

    const cards: StatCardConfig[] = [
        {
            key: 'students',
            label: '学生总数',
            icon: <Icon name="user" size={20} />,
            value: <Counter value={totalStudents} />,
            subtext: `本周新增 ${data.newStudentsThisWeek ?? 0} 人`,
            changePercent: wowChange.students,
            changeLabel: '周环比',
            variant: 'info',
        },
        {
            key: 'classes',
            label: '班级总数',
            icon: <Icon name="graduation" size={20} />,
            value: <Counter value={data.totalClasses ?? 0} />,
            variant: 'default',
        },
        {
            key: 'poems',
            label: '诗词库存数',
            icon: <Icon name="book-open" size={20} />,
            value: <Counter value={data.totalPoems ?? 0} />,
            subtext: `本周新增 ${data.newPoemsThisWeek ?? 0} 首`,
            variant: 'default',
        },
        {
            key: 'study-time',
            label: '今日学习总时长',
            icon: <Icon name="clock" size={20} />,
            value: <Counter value={data.todayStudyTimeHours ?? 0} precision={1} />,
            suffix: '小时',
            changePercent: wowChange.studyTime,
            changeLabel: '周环比',
            variant: (data.todayStudyTimeHours ?? 0) > 0 ? 'success' : 'default',
        },
    ]

    return (
        <div className="pr-stats-grid">
            {cards.map((card) => (
                <StatCard key={card.key} config={card} />
            ))}
        </div>
    )
})

/** 单个统计卡片 */
function StatCard({ config }: { config: StatCardConfig }) {
    const variantClass = config.variant && config.variant !== 'default'
        ? `pr-stat-card--${config.variant}`
        : ''

    const hasChange = typeof config.changePercent === 'number'
    const isPositive = hasChange && (config.changePercent ?? 0) > 0
    const isNegative = hasChange && (config.changePercent ?? 0) < 0
    const changeClass = isPositive
        ? 'pr-stat-card-change--up'
        : isNegative
            ? 'pr-stat-card-change--down'
            : 'pr-stat-card-change--flat'

    /** 光标聚光灯：更新 CSS 变量驱动 ::after 光韵（规范 7.4） */
    const handleSpotlight = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const el = e.currentTarget
        const rect = el.getBoundingClientRect()
        el.style.setProperty('--spot-x', `${(((e.clientX - rect.left) / rect.width) * 100).toFixed(2)}%`)
        el.style.setProperty('--spot-y', `${(((e.clientY - rect.top) / rect.height) * 100).toFixed(2)}%`)
    }, [])

    return (
        <div className={`pr-stat-card ${variantClass}`.trim()} onMouseMove={handleSpotlight}>
            <div className="pr-stat-card-header">
                <span className="pr-stat-card-icon">{config.icon}</span>
                {hasChange && (
                    <span
                        className={`pr-stat-card-change ${changeClass}`}
                        aria-label={`${config.changeLabel} ${isPositive ? '上升' : isNegative ? '下降' : '持平'} ${Math.abs(config.changePercent ?? 0)}%`}
                    >
                        <Icon
                            name={isPositive ? 'arrow-up' : isNegative ? 'arrow-down' : 'minus'}
                            size={11}
                        />
                        <span className="pr-stat-card-change-value">
                            {Math.abs(config.changePercent ?? 0).toFixed(1)}%
                        </span>
                        {config.changeLabel && (
                            <span className="pr-stat-card-change-label">{config.changeLabel}</span>
                        )}
                    </span>
                )}
            </div>
            <div>
                <span className="pr-stat-card-value">
                    {config.value}
                    {config.suffix && (
                        <span className="pr-stat-card-value-suffix">{config.suffix}</span>
                    )}
                </span>
            </div>
            <div className="pr-stat-card-label">{config.label}</div>
            {config.subtext && (
                <div className="pr-stat-card-subtext">{config.subtext}</div>
            )}
        </div>
    )
}

/** 加载骨架（规范 14.3 / 6.4：与 surface-secondary 同色系，无边框） */
function StatsSkeleton() {
    return (
        <div className="pr-stats-grid">
            {[0, 1, 2, 3].map((i) => (
                <div key={i} className="pr-stat-card">
                    <div className="pr-stat-card-header">
                        <div
                            className="pr-skeleton pr-stat-card-icon"
                            style={{ borderRadius: 'var(--radius-sm)' }}
                        />
                    </div>
                    <div className="pr-skeleton pr-skeleton-line" style={{ height: 28, width: '60%' }} />
                    <div className="pr-skeleton pr-skeleton-line" style={{ height: 12, width: '80%' }} />
                </div>
            ))}
        </div>
    )
}

/** 错误态：友好提示 + 重试按钮 */
function StatsError({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="pr-stats-grid">
            <div className="pr-stat-card pr-stat-card--error" style={{ gridColumn: '1 / -1' }}>
                <div className="pr-stat-card-header">
                    <span className="pr-stat-card-icon">
                        <Icon name="warning-circle" size={20} />
                    </span>
                </div>
                <p className="pr-stat-card-error-title">统计卡片加载失败</p>
                <p className="pr-stat-card-error-message">{message}</p>
                <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<Icon name="arrows-clockwise" size={12} />}
                    onClick={onRetry}
                >
                    重试
                </Button>
            </div>
        </div>
    )
}

/** 空数据态：引导文案 + CTA 按钮 */
function StatsEmpty({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="pr-stats-grid">
            <div className="pr-stat-card pr-stat-card--empty" style={{ gridColumn: '1 / -1' }}>
                <div className="pr-stat-card-header">
                    <span className="pr-stat-card-icon">
                        <Icon name="chart-bar" size={20} />
                    </span>
                </div>
                <p className="pr-stat-card-empty-title">暂无统计数据</p>
                <p className="pr-stat-card-empty-message">
                    请先完成班级导入与学生注册，统计数据将在数据采集后自动呈现。
                </p>
                <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<Icon name="arrows-clockwise" size={12} />}
                    onClick={onRetry}
                >
                    重新加载
                </Button>
            </div>
        </div>
    )
}
