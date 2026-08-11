/**
 * useClasses —— 班级列表共享 Hook
 *
 * 从后端 GET /api/classroom/classes 动态加载班级列表，
 * 供所有页面的班级下拉框使用，替代原先各页面硬编码的 CLASS_OPTIONS。
 *
 * v5.0 Task 5.8 改造：
 * - 全局缓存：成功加载后缓存结果，避免 10 个页面重复请求（消除 270+ 个 500 错误雪崩）
 * - DEMO 模式降级：后端不可达时自动降级到 DEMO_CLASSES 演示数据
 * - 失败节流：失败后 60s 内不再重试，避免无效请求
 * - 响应式 DEMO 模式：进入/退出 DEMO 模式时自动切换数据源
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useDemoModeStore } from '@/lib/demo-mode'
import { DEMO_CLASSES, DEMO_DEFAULT_CLASS_ID } from '@/lib/demo-data'

export interface ClassOption {
    id: string
    name: string
}

/* ============================================================
 * 全局缓存（模块级，跨组件共享）
 * ============================================================ */

/** 缓存的班级列表（成功加载后持久化，避免重复请求） */
let cachedClasses: ClassOption[] | null = null
/** 上次请求失败的时间戳（ms），用于节流重试 */
let lastFailureTime = 0
/** 失败后重试间隔（ms）—— 60s 内不重试 */
const FAILURE_RETRY_INTERVAL_MS = 60_000

/** 清理后端历史种子数据中的重复班级，避免下拉框出现多个同名项 */
function normalizeClasses(list: ClassOption[]): ClassOption[] {
    const seenIds = new Set<string>()
    const seenNames = new Set<string>()
    return list.filter((item) => {
        const id = item.id.trim()
        const name = item.name.replace(/\s+/g, '').trim()
        if (!id || !name || seenIds.has(id) || seenNames.has(name)) return false
        seenIds.add(id)
        seenNames.add(name)
        return true
    })
}

/* ============================================================
 * Hook 实现
 * ============================================================ */

export function useClasses() {
    const [classes, setClasses] = useState<ClassOption[]>(cachedClasses ?? [])
    const [loading, setLoading] = useState(cachedClasses === null)
    // 订阅 DEMO 模式状态（响应式）
    const isDemoMode = useDemoModeStore((s) => s.isDemoMode)

    useEffect(() => {
        // DEMO 模式 → 直接使用演示班级数据
        if (isDemoMode) {
            const demoClasses = normalizeClasses(DEMO_CLASSES.map((c) => ({ id: c.id, name: c.name })))
            setClasses(demoClasses)
            setLoading(false)
            return
        }

        // 已有缓存 → 直接使用，不重复请求
        if (cachedClasses !== null) {
            setClasses(cachedClasses)
            setLoading(false)
            return
        }

        // 失败节流：60s 内不重试
        if (Date.now() - lastFailureTime < FAILURE_RETRY_INTERVAL_MS) {
            setClasses([])
            setLoading(false)
            return
        }

        let cancelled = false
        setLoading(true)
        api.classroom
            .listClasses()
            .then((data) => {
                if (cancelled) return
                const list = normalizeClasses(data.classes ?? [])
                // 写入全局缓存
                cachedClasses = list
                setClasses(list)
            })
            .catch((err) => {
                if (cancelled) return
                if (import.meta.env.DEV) console.error('[useClasses] 加载班级列表失败', err)
                lastFailureTime = Date.now()
                setClasses([])
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [isDemoMode])

    return { classes, loading }
}

/* ============================================================
 * 辅助 API
 * ============================================================ */

/**
 * 获取默认班级 ID（供页面初始化时使用）
 *
 * - 后端可用且有缓存：返回缓存中的第一个班级 ID
 * - DEMO 模式或无缓存：返回 DEMO_DEFAULT_CLASS_ID
 */
export function getDefaultClassId(): string {
    return cachedClasses?.[0]?.id ?? DEMO_DEFAULT_CLASS_ID
}

/** 清除全局缓存（供"刷新班级列表"按钮调用） */
export function invalidateClassesCache(): void {
    cachedClasses = null
    lastFailureTime = 0
}
