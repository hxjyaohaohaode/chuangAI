/**
 * 本周学习进度矩阵（v5.0 Dashboard 数据真实化）
 *
 * 对接 GET /api/dashboard/weekly-progress，TanStack Query 直接消费：
 * - staleTime: 30s
 * - retry: 1
 * - 数据联动：classId 变化触发 refetch
 *
 * 数据形状：学生 × 天 矩阵
 * - students: 学生列表（前 20）
 * - days: 本周 7 天日期（ISO 字符串）
 * - matrix[studentIndex][dayIndex]: 学习时长（分钟）
 *
 * 排序：使用 Combobox 提供多种排序方式
 * - 总时长降序（默认）：本周学习总时长最高的学生排在前面
 * - 总时长升序：发现学习不足的学生
 * - 姓名升序：按姓名字典序
 * - 姓名降序：按姓名字典序倒序
 *
 * 设计要点（规范第 9.2、14.6、5、6、10 章）：
 * - 无边框表格：行间使用透明度差异 + 间距分隔
 * - 热力图着色：根据学习时长相对最大值，使用 accent-primary alpha 渐变
 * - Tabular Numbers：数值等宽对齐（规范 10.6 / 3.2）
 * - 移动端：单列卡片化展示，桌面端：完整矩阵
 * - hover：单元格高亮 + tooltip 显示具体时长
 * - 零硬编码色值：所有颜色从 chartPalette 派生
 *
 * 加载态：骨架屏（与 surface-secondary 同色系，无边框）
 * 错误态：友好提示 + 重试按钮
 * 空数据态：引导文案 + CTA 按钮
 */

import { memo, useMemo, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Card, Icon, Button, Combobox, type ComboboxOption } from '@/components/ui'
import { api } from '@/lib/api'
import { scoreToSequentialAlpha } from '@/lib/chartPalette'
import type { WeeklyProgressData } from '@/lib/types'

interface WeeklyProgressTableProps {
    /** 班级 ID（可选，用于数据联动） */
    classId?: string
}

/** 查询 staleTime：30 秒 */
const WEEKLY_STALE_TIME = 30_000

/** 排序方式类型 */
type SortMode = 'total-desc' | 'total-asc' | 'name-asc' | 'name-desc'

/** Combobox 排序选项 */
const SORT_OPTIONS: ComboboxOption[] = [
    { value: 'total-desc', label: '总时长 · 由高到低' },
    { value: 'total-asc', label: '总时长 · 由低到高' },
    { value: 'name-asc', label: '姓名 · A → Z' },
    { value: 'name-desc', label: '姓名 · Z → A' },
]

/** 格式化日期为周几 + 简短日期 */
function formatDayHeader(isoDate: string): { weekday: string; date: string } {
    const d = new Date(isoDate)
    if (Number.isNaN(d.getTime())) return { weekday: '', date: isoDate }
    const weekdays = ['日', '一', '二', '三', '四', '五', '六']
    return {
        weekday: `周${weekdays[d.getDay()] ?? ''}`,
        date: `${d.getMonth() + 1}/${d.getDate()}`,
    }
}

/** 格式化分钟为可读时长（如 "1h23m" 或 "45m"） */
function formatMinutes(min: number): string {
    if (min <= 0) return '—'
    if (min < 60) return `${Math.round(min)}m`
    const h = Math.floor(min / 60)
    const m = Math.round(min % 60)
    return m > 0 ? `${h}h${m}m` : `${h}h`
}

export const WeeklyProgressTable = memo(function WeeklyProgressTable({
    classId,
}: WeeklyProgressTableProps) {
    const navigate = useNavigate()
    const query = useQuery<WeeklyProgressData>({
        queryKey: ['dashboard-v2', 'weekly-progress', classId ?? 'global'],
        queryFn: () => api.dashboardV2.weeklyProgress(classId),
        staleTime: WEEKLY_STALE_TIME,
        retry: 1,
        // classId 就绪前不发请求：
        // bloom-radar / alerts / weekly-progress 三个端点强制要求 classId，
        // 未就绪就发会先收 3 个 400，随后再用真实 classId 重发一轮，
        // 既产生无效错误噪音，也让面板内容闪烁一次。
        enabled: Boolean(classId),
    })

    const [sortMode, setSortMode] = useState<SortMode>('total-desc')

    /** 强制刷新 */
    const handleRefresh = useCallback(() => {
        void query.refetch()
    }, [query])

    /** 跳转到课堂导播台 */
    const handleGoToClassroom = useCallback(() => {
        const params = new URLSearchParams()
        if (classId) params.set('classId', classId)
        navigate(`/classroom?${params.toString()}`)
    }, [classId, navigate])

    /** 计算每个学生的总学习时长 */
    const studentTotals = useMemo(() => {
        const data = query.data
        if (!data || !data.students || !data.matrix) return []
        return data.students.map((stu, idx) => {
            const row = data.matrix[idx] ?? []
            const total = row.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0)
            return { ...stu, total, rowIndex: idx }
        })
    }, [query.data])

    /** 最大学习时长（用于热力图着色） */
    const maxMinutes = useMemo(() => {
        const data = query.data
        if (!data || !data.matrix) return 0
        let max = 0
        for (const row of data.matrix) {
            if (!row) continue
            for (const v of row) {
                if (Number.isFinite(v) && v > max) max = v
            }
        }
        return max
    }, [query.data])

    /** 按排序模式排序后的学生列表 */
    const sortedStudents = useMemo(() => {
        const list = [...studentTotals]
        switch (sortMode) {
            case 'total-desc':
                list.sort((a, b) => b.total - a.total)
                break
            case 'total-asc':
                list.sort((a, b) => a.total - b.total)
                break
            case 'name-asc':
                list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
                break
            case 'name-desc':
                list.sort((a, b) => b.name.localeCompare(a.name, 'zh-CN'))
                break
        }
        return list
    }, [studentTotals, sortMode])

    const data = query.data
    const hasData = Boolean(
        data && data.students && data.students.length > 0 && data.matrixDays && data.matrixDays.length > 0,
    )

    return (
        <Card className="pr-weekly-card">
            <div className="pr-weekly-header">
                <div className="pr-weekly-header-text">
                    <h2 className="pr-weekly-title">本周学习进度</h2>
                    <p className="pr-weekly-subtitle">
                        学生 × 天 有效学习时长 · 按实际作答题目预估用时累计
                    </p>
                </div>
                <div className="pr-weekly-header-actions">
                    {hasData && (
                        <Combobox
                            className="pr-weekly-sort"
                            value={sortMode}
                            onChange={(v) => setSortMode(v as SortMode)}
                            ariaLabel="排序方式"
                            options={SORT_OPTIONS}
                            searchable={false}
                        />
                    )}
                    <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Icon name="arrows-clockwise" size={12} />}
                        loading={query.isFetching && !query.isLoading}
                        onClick={handleRefresh}
                        aria-label="刷新进度数据"
                    >
                        刷新
                    </Button>
                </div>
            </div>

            {/* 图例 */}
            {hasData && (
                <div className="pr-weekly-legend" aria-hidden="true">
                    <span className="pr-weekly-legend-label">时长</span>
                    <span className="pr-weekly-legend-gradient" />
                    <span className="pr-weekly-legend-min">少</span>
                    <span className="pr-weekly-legend-max">多</span>
                </div>
            )}

            {query.isPending ? (
                <WeeklySkeleton />
            ) : query.isError ? (
                <WeeklyError
                    message={query.error instanceof Error ? query.error.message : '加载进度数据失败'}
                    onRetry={() => void query.refetch()}
                />
            ) : !hasData || !data ? (
                <WeeklyEmpty onGoToClassroom={handleGoToClassroom} />
            ) : (
                <WeeklyMatrix
                    data={data}
                    sortedStudents={sortedStudents}
                    maxMinutes={maxMinutes}
                />
            )}
        </Card>
    )
})

/* ============================================================
 * 矩阵主体
 * ============================================================ */

interface WeeklyMatrixProps {
    data: WeeklyProgressData
    sortedStudents: Array<{ id: string; name: string; total: number; rowIndex: number }>
    maxMinutes: number
}

function WeeklyMatrix({ data, sortedStudents, maxMinutes }: WeeklyMatrixProps) {
    const days = data.matrixDays
    return (
        <div className="pr-weekly-matrix-wrapper" role="region" aria-label="本周学习进度矩阵">
            <table className="pr-weekly-matrix">
                <thead>
                    <tr>
                        <th className="pr-weekly-matrix-corner" scope="col">
                            <span className="pr-weekly-matrix-corner-label">学生</span>
                            <span className="pr-weekly-matrix-corner-meta">/ 日期</span>
                        </th>
                        {days.map((day, i) => {
                            const { weekday, date } = formatDayHeader(day)
                            const isWeekend = i === 0 || i === 6
                            return (
                                <th
                                    key={`day-${i}-${day}`}
                                    scope="col"
                                    className={`pr-weekly-matrix-day ${isWeekend ? 'is-weekend' : ''}`.trim()}
                                >
                                    <span className="pr-weekly-matrix-day-weekday">{weekday}</span>
                                    <span className="pr-weekly-matrix-day-date">{date}</span>
                                </th>
                            )
                        })}
                        <th className="pr-weekly-matrix-total-header" scope="col">
                            总计
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {sortedStudents.map((stu, displayIdx) => {
                        const row = data.matrix[stu.rowIndex] ?? []
                        return (
                            <tr
                                key={stu.id}
                                className={`pr-weekly-matrix-row ${displayIdx % 2 === 1 ? 'is-alt' : ''}`.trim()}
                            >
                                <th className="pr-weekly-matrix-student" scope="row">
                                    <span className="pr-weekly-matrix-student-rank">{displayIdx + 1}</span>
                                    <span className="pr-weekly-matrix-student-name">{stu.name}</span>
                                </th>
                                {days.map((_, dayIdx) => {
                                    const minutes = row[dayIdx] ?? 0
                                    const intensityPct = maxMinutes > 0
                                        ? (minutes / maxMinutes) * 100
                                        : 0
                                    const alpha = scoreToSequentialAlpha(intensityPct)
                                    return (
                                        <td
                                            key={`cell-${stu.id}-${dayIdx}`}
                                            className="pr-weekly-matrix-cell"
                                            style={{
                                                ['--cell-alpha' as string]: alpha,
                                            }}
                                            // 空格子不参与悬浮抬升：没有记录就没有可指认的内容，
                                            // 给它 hover 反馈只会诱导教师去点一个什么都没有的格子
                                            data-has-value={minutes > 0}
                                            title={
                                                minutes > 0
                                                    ? `${stu.name} · ${formatDayHeader(days[dayIdx] ?? '').weekday} ${formatDayHeader(days[dayIdx] ?? '').date}
有效学习 ${formatMinutes(minutes)}（按当日实际作答题目的预估用时累计）`
                                                    : `${stu.name} · ${formatDayHeader(days[dayIdx] ?? '').weekday} ${formatDayHeader(days[dayIdx] ?? '').date}
当日无作答记录`
                                            }
                                        >
                                            {minutes > 0 ? (
                                                <span className="pr-weekly-matrix-cell-value">
                                                    {formatMinutes(minutes)}
                                                </span>
                                            ) : (
                                                <span className="pr-weekly-matrix-cell-empty">·</span>
                                            )}
                                        </td>
                                    )
                                })}
                                <td className="pr-weekly-matrix-total">
                                    <span className="pr-weekly-matrix-total-value">
                                        {stu.total > 0 ? formatMinutes(stu.total) : '—'}
                                    </span>
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}

/* ============================================================
 * 三态组件：Skeleton / Error / Empty
 * ============================================================ */

/** 加载骨架（规范 14.3 / 6.4：与 surface-secondary 同色系，无边框） */
function WeeklySkeleton() {
    return (
        <div className="pr-weekly-matrix-wrapper">
            <div className="pr-weekly-skeleton">
                <div className="pr-weekly-skeleton-header">
                    <div
                        className="pr-skeleton"
                        style={{ height: 32, width: '100%', borderRadius: 'var(--radius-sm)' }}
                    />
                </div>
                {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="pr-weekly-skeleton-row">
                        <div
                            className="pr-skeleton"
                            style={{ height: 14, width: 80, borderRadius: 'var(--radius-xs)' }}
                        />
                        {[0, 1, 2, 3, 4, 5, 6].map((j) => (
                            <div
                                key={j}
                                className="pr-skeleton"
                                style={{ height: 28, flex: 1, borderRadius: 'var(--radius-xs)' }}
                            />
                        ))}
                        <div
                            className="pr-skeleton"
                            style={{ height: 14, width: 40, borderRadius: 'var(--radius-xs)' }}
                        />
                    </div>
                ))}
            </div>
        </div>
    )
}

/** 错误态：友好提示 + 重试按钮 */
function WeeklyError({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="pr-weekly-empty pr-weekly-empty--error" role="alert">
            <span className="pr-weekly-empty-icon">
                <Icon name="warning-circle" size={28} weight="bold" />
            </span>
            <p className="pr-weekly-empty-title">进度数据加载失败</p>
            <p className="pr-weekly-empty-desc">{message}</p>
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
function WeeklyEmpty({ onGoToClassroom }: { onGoToClassroom: () => void }) {
    return (
        <div className="pr-weekly-empty" role="status" aria-live="polite">
            <span className="pr-weekly-empty-icon">
                <Icon name="calendar" size={28} weight="bold" />
            </span>
            <p className="pr-weekly-empty-title">本周暂无学习记录</p>
            <p className="pr-weekly-empty-desc">
                可前往课堂导播台排课，开启一次班级闯关或六阶沉浸教学。
            </p>
            <Button
                variant="secondary"
                size="sm"
                leftIcon={<Icon name="book-open" size={14} />}
                onClick={onGoToClassroom}
            >
                去课堂导播台
            </Button>
        </div>
    )
}
