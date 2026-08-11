/**
 * Dashboard 顶部操作栏（SubTask 9.5）
 *
 * 包含：
 * 1. 页面标题 + 班级名称副标题
 * 2. 班级切换器（下拉选择）
 * 3. WebSocket 实时连接状态指示器
 * 4. 同步数据按钮（手动刷新）
 * 5. AI 副驾按钮（唤起编排官）
 *
 * 设计要点（规范第 7、8、14 章）：
 * - 标题使用 display 字体 + text-2xl + 半紧字距
 * - WS 状态指示器：圆点脉动 + 文字标签，颜色语义化
 * - 按钮：primary / ghost / secondary 三种变体搭配
 * - 响应式：移动端 header 折叠为垂直布局
 */

import { memo } from 'react'
import { Button, Combobox, Icon, type ComboboxOption } from '@/components/ui'
import type { WSStatus } from '@/lib/types'

interface DashboardHeaderProps {
    /** 班级名称 */
    className: string
    /** WebSocket 连接状态 */
    wsStatus: WSStatus
    /** 最后同步时间戳（ms），null 表示从未同步 */
    lastSyncedAt: number | null
    /** 是否正在加载 */
    loading: boolean
    /** 同步按钮点击回调 */
    onSync: () => void
    /** AI 副驾按钮点击回调 */
    onOpenCopilot: () => void
    /** 班级切换回调 */
    onClassChange?: (classId: string) => void
    /** 可选班级列表 */
    classOptions?: Array<{ id: string; name: string }>
    /** 当前班级 ID */
    currentClassId?: string
}

/** WS 状态中文标签 */
const WS_STATUS_LABELS: Record<WSStatus, string> = {
    idle: '未连接',
    connecting: '连接中',
    connected: '实时同步',
    disconnected: '已断开',
    error: '连接异常',
}

/** 格式化最后同步时间 */
function formatSyncTime(ts: number | null): string {
    if (ts === null) return '尚未同步'
    const diff = Date.now() - ts
    if (diff < 5000) return '刚刚同步'
    if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前同步`
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前同步`
    const date = new Date(ts)
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')} 同步`
}

export const DashboardHeader = memo(function DashboardHeader({
    className,
    wsStatus,
    lastSyncedAt,
    loading,
    onSync,
    onOpenCopilot,
    onClassChange,
    classOptions,
    currentClassId,
}: DashboardHeaderProps) {
    const wsStatusClass = wsStatus === 'connected' || wsStatus === 'connecting' || wsStatus === 'error' || wsStatus === 'disconnected'
        ? `pr-ws-status--${wsStatus}`
        : ''

    return (
        <header className="pr-dashboard-header">
            <div className="pr-dashboard-header-left">
                <p className="pr-dashboard-header-context">
                    {className || '请选择班级'}
                </p>
                <p className="pr-dashboard-header-subtitle">
                    {formatSyncTime(lastSyncedAt)}
                </p>
            </div>

            <div className="pr-dashboard-header-actions">
                {/* WebSocket 状态指示器 */}
                <span className={`pr-ws-status ${wsStatusClass}`.trim()} title={`WebSocket: ${WS_STATUS_LABELS[wsStatus]}`}>
                    <span className="pr-ws-status-dot" />
                    {WS_STATUS_LABELS[wsStatus]}
                </span>

                {/* 班级切换器 */}
                {classOptions && classOptions.length > 0 && onClassChange && (
                    <Combobox
                        className="pr-class-selector"
                        value={currentClassId ?? ''}
                        onChange={(v) => onClassChange(v as string)}
                        ariaLabel="切换班级"
                        placeholder="请选择班级"
                        options={classOptions.map<ComboboxOption>((opt) => ({
                            value: opt.id,
                            label: opt.name,
                        }))}
                    />
                )}

                {/* 同步数据按钮 */}
                <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<Icon name="arrows-clockwise" size={16} />}
                    loading={loading}
                    onClick={onSync}
                >
                    同步数据
                </Button>

                {/* AI 副驾按钮 */}
                <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<Icon name="sparkle" size={16} />}
                    onClick={onOpenCopilot}
                >
                    AI 副驾
                </Button>
            </div>
        </header>
    )
})
