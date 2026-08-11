/**
 * 同步指示器（规范第 12 章 实时数据同步架构）
 *
 * 组件族：
 * - SyncProgressBar：顶部 2px accent 色进度线（后台保存中，不确定态）
 * - OfflineBanner：离线指示器（暖色通知条，非红色警告）
 *
 * 配套 Hook：
 * - useOnlineStatus：在线/离线状态检测
 *
 * 规范 12.3 乐观更新模式：
 *   1. 用户执行操作
 *   2. UI 立即反映预期结果（≤ 50ms）
 *   3. 后台发送请求到服务端
 *   4. 成功 → 静默确认
 *   5. 失败 → 回滚 UI + 显示 error toast + red-alpha 微闪
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { useDemoModeStore } from '@/lib/demo-mode'

/* ============================================================
 * SyncProgressBar —— 顶部进度线
 * ============================================================ */

export interface SyncProgressBarProps {
    /** 是否显示（后台保存中） */
    active: boolean
}

/**
 * 顶部 2px accent 色极细进度线（不确定态）。
 * 规范 12.4：后台保存中，视口最顶端出现 2px 高度 accent 色进度线，自动消失。
 */
export const SyncProgressBar = memo(function SyncProgressBar({ active }: SyncProgressBarProps) {
    if (!active) return null
    return (
        <div className="pr-sync-bar" aria-hidden="true">
            <div className="pr-sync-bar-fill" />
        </div>
    )
})

/* ============================================================
 * OfflineBanner —— 离线 / DEMO 模式通知条
 * ============================================================ */

export interface OfflineBannerProps {
    /** 强制显示离线（覆盖自动检测） */
    forceOffline?: boolean
    /** 关闭回调（用户手动关闭） */
    onClose?: () => void
}

/** DEMO 模式横幅自动恢复时间（ms）—— 已弃用，v7 参赛修复移除横幅 */
// const DEMO_BANNER_REAPPEAR_MS = 5 * 60_000

/**
 * 离线 / DEMO 模式指示器：页面顶部下滑一个低调的暖色通知条（非红色警告）。
 * 规范 12.4：离线中，2s 入场动画。
 *
 * v5.0 Task 5.8：
 * - 后端不可达时显示"演示模式"横幅（info 蓝色调）
 * - 网络物理离线时显示"离线"横幅（warning 黄色调）
 * - 两者同时存在时，DEMO 模式优先（后端不可达比物理离线更常见）
 */
export const OfflineBanner = memo(function OfflineBanner({
    forceOffline,
    onClose,
}: OfflineBannerProps) {
    const online = useOnlineStatus()
    const offline = forceOffline ?? !online
    const demoMode = useDemoModeStore((state) => state.isDemoMode)

    const [dismissedOffline, setDismissedOffline] = useState(false)

    // 网络恢复时重置 dismissed
    useEffect(() => {
        if (!offline) setDismissedOffline(false)
    }, [offline])

    // 演示数据必须被显式披露。隐藏后端故障并把静态 fallback 当成真实
    // 结果会误导用户，也使评审无法判断哪些功能真正跑通。
    if (demoMode) {
        return (
            <div className="pr-offline-banner pr-offline-banner--demo" role="status" aria-live="polite">
                <span className="pr-offline-banner-icon">
                    <Icon name="info" size={14} weight="bold" />
                </span>
                <span className="pr-offline-banner-text">
                    当前为离线演示模式：页面使用内置示例数据，操作不会写入真实教学记录
                </span>
            </div>
        )
    }

    if (offline && !dismissedOffline) {
        return (
            <div className="pr-offline-banner" role="status" aria-live="polite">
                <span className="pr-offline-banner-icon">
                    <Icon name="wifi-slash" size={14} weight="bold" />
                </span>
                <span className="pr-offline-banner-text">
                    当前网络不可用；未成功提交的修改不会保存，请恢复连接后重新操作
                </span>
                {onClose && (
                    <button
                        type="button"
                        className="pr-offline-banner-close"
                        onClick={() => {
                            setDismissedOffline(true)
                            onClose()
                        }}
                        aria-label="关闭离线提示"
                    >
                        <Icon name="x" size={12} />
                    </button>
                )}
            </div>
        )
    }

    return null
})

/* ============================================================
 * RollbackFlash —— 失败回滚微闪容器
 * ============================================================ */

export interface RollbackFlashProps {
    /** 是否触发微闪 */
    flash: boolean
    /** 闪烁结束回调 */
    onAnimationEnd?: () => void
    children: ReactNode
    className?: string
}

/**
 * 失败回滚微闪容器（规范 12.3 乐观更新失败回滚）
 *
 * 视觉规范：
 * - 被回滚元素微闪 red-alpha 背景后恢复（150ms）
 * - 使用 accent-error 的 10% alpha 背景
 * - 仅 transform/opacity 动画（GPU 加速）
 */
export const RollbackFlash = memo(function RollbackFlash({
    flash,
    onAnimationEnd,
    children,
    className,
}: RollbackFlashProps) {
    return (
        <div
            className={`pr-rollback-flash ${flash ? 'pr-rollback-flash--active' : ''} ${className ?? ''}`}
            onAnimationEnd={onAnimationEnd}
        >
            {children}
        </div>
    )
})

/* ============================================================
 * useOnlineStatus —— 在线状态检测
 * ============================================================ */

export function useOnlineStatus(): boolean {
    const [online, setOnline] = useState(
        typeof navigator === 'undefined' ? true : navigator.onLine,
    )

    useEffect(() => {
        const on = () => setOnline(true)
        const off = () => setOnline(false)
        window.addEventListener('online', on)
        window.addEventListener('offline', off)
        return () => {
            window.removeEventListener('online', on)
            window.removeEventListener('offline', off)
        }
    }, [])

    return online
}

/* ============================================================
 * useOptimisticUpdate —— 乐观更新包装器
 * ============================================================ */

export interface OptimisticUpdateOptions<T> {
    /** 实际请求（后台提交） */
    commit: (current: T) => Promise<unknown>
    /** 失败回滚（恢复 UI 到提交前状态） */
    rollback: (current: T) => T
    /** 开始同步回调（显示进度线） */
    onSyncStart?: () => void
    /** 同步成功回调（静默确认） */
    onSyncEnd?: () => void
    /** 同步失败回调（toast + 微闪） */
    onSyncError?: (err: unknown) => void
}

export interface OptimisticUpdateResult<T> {
    /** 当前值 */
    value: T
    /** 设置值（同步触发乐观更新） */
    set: (next: T) => Promise<boolean>
    /** 是否同步中 */
    syncing: boolean
    /** 是否触发回滚微闪 */
    flash: boolean
    /** 清除微闪态 */
    clearFlash: () => void
}

/**
 * 乐观更新包装器（规范 12.3 乐观更新模式）
 *
 * 流程：
 *   1. 用户执行操作 → set(next)
 *   2. UI 立即反映预期结果（apply，≤ 50ms）
 *   3. 后台发送请求到服务端（commit）
 *   4. 成功 → 静默确认（onSyncEnd）
 *   5. 失败 → 回滚 UI（rollback）+ 显示 error toast（onSyncError）+ red-alpha 微闪
 *
 * 使用方式：
 * ```tsx
 * const { value, set, syncing, flash, clearFlash } = useOptimisticUpdate({
 *     initialValue: data,
 *     commit: (current) => api.save(current),
 *     rollback: (current) => ({ ...current, saved: false }),
 *     onSyncError: (err) => toast.error('保存失败，已回滚'),
 * })
 *
 * // 触发乐观更新
 * set({ ...data, saved: true })
 * ```
 */
export function useOptimisticUpdate<T>(
    options: OptimisticUpdateOptions<T> & { initialValue: T },
): OptimisticUpdateResult<T> {
    const { initialValue, commit, rollback, onSyncStart, onSyncEnd, onSyncError } = options

    const [value, setValue] = useState<T>(initialValue)
    const [syncing, setSyncing] = useState(false)
    const [flash, setFlash] = useState(false)

    // 持有最新的回调，避免 effect 依赖变化
    const commitRef = useRef(commit)
    const rollbackRef = useRef(rollback)
    const onSyncStartRef = useRef(onSyncStart)
    const onSyncEndRef = useRef(onSyncEnd)
    const onSyncErrorRef = useRef(onSyncError)

    commitRef.current = commit
    rollbackRef.current = rollback
    onSyncStartRef.current = onSyncStart
    onSyncEndRef.current = onSyncEnd
    onSyncErrorRef.current = onSyncError

    const set = useCallback(async (next: T): Promise<boolean> => {
        // 1. 乐观更新：立即写入 UI（≤ 50ms）
        setValue(next)
        setSyncing(true)
        onSyncStartRef.current?.()

        try {
            // 2. 后台发送请求
            await commitRef.current(next)
            // 3. 成功：静默确认
            setSyncing(false)
            onSyncEndRef.current?.()
            return true
        } catch (err) {
            // 4. 失败：回滚 UI + 微闪 + toast
            setValue((current) => rollbackRef.current(current))
            setSyncing(false)
            setFlash(true)
            onSyncErrorRef.current?.(err)
            return false
        }
    }, [])

    const clearFlash = useCallback(() => {
        setFlash(false)
    }, [])

    return {
        value,
        set,
        syncing,
        flash,
        clearFlash,
    }
}

