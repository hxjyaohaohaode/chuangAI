/**
 * 全局导航配置（规范第 8 章 + B3.1 404 兜底路由共享）
 *
 * 纯教师端（v9：移除学生端，专注教师全流程）：
 * - NavItem 保留 role 字段以兼容类型系统，但实际仅渲染 teacher/both
 * - NavItem 新增 group 字段，AppShell 按 group 渲染分组标题
 * - getNavForRole(role) 按角色过滤可见导航项
 * - getDefaultRoute(role) 返回角色默认落地页
 *
 * 导航分组（教师）：
 * - 教学核心：驾驶舱 / 教研报告 / 星图
 * - 备课授课：教案工坊 / 命题工坊 / 课堂导播 / 智能批改 / 创作迭代
 * - AI 协作：AI 副驾 / 进化之眼 / 思考宫殿
 * - 文化沉淀：文化语境
 */

import type { NavItem } from '@/components/layout/AppShell'
import type { AppShellVariant } from '@/components/layout/AppShell'
import type { UserRole } from '@/stores/auth'

// ─────────────────────────────────────────────────────────────
// 导航分组元数据
// ─────────────────────────────────────────────────────────────

export interface NavGroupMeta {
    key: string
    label: string
    role: UserRole | 'both'
}

export const NAV_GROUPS: readonly NavGroupMeta[] = [
    // 教师分组
    { key: 'teach-core', label: '教学核心', role: 'teacher' },
    { key: 'teach-prep', label: '备课授课', role: 'teacher' },
    { key: 'ai', label: 'AI 协作', role: 'teacher' },
    // 共享
    { key: 'culture', label: '文化沉淀', role: 'both' },
] as const

// ─────────────────────────────────────────────────────────────
// 导航项（全量真相源，AppShell 按 role 过滤后渲染）
// ─────────────────────────────────────────────────────────────

export const NAV: readonly (NavItem & { role: UserRole | 'both'; group: string })[] = [
    // ── 教学核心（教师）──
    { key: 'dashboard', label: '教学驾驶舱', icon: 'graduation', to: '/dashboard', role: 'teacher', group: 'teach-core' },
    { key: 'report', label: '教研报告', icon: 'scroll', to: '/report', role: 'teacher', group: 'teach-core' },
    { key: 'starmap', label: '诗脉星图', icon: 'graph', to: '/starmap', role: 'both', group: 'teach-core' },
    // ── 备课授课（教师）──
    { key: 'lesson-plan', label: '教案工坊', icon: 'notebook', to: '/lesson-plan', role: 'teacher', group: 'teach-prep' },
    { key: 'workbench', label: '命题工坊', icon: 'feather', to: '/workbench', role: 'teacher', group: 'teach-prep' },
    { key: 'classroom', label: '课堂导播台', icon: 'book-open', to: '/classroom', role: 'teacher', group: 'teach-prep' },
    { key: 'grading', label: '智能批改台', icon: 'pencil-simple-line', to: '/grading', role: 'teacher', group: 'teach-prep' },
    { key: 'creation-studio', label: '创作迭代台', icon: 'arrows-clockwise', to: '/creation-studio', role: 'teacher', group: 'teach-prep' },
    // ── AI 协作（教师）──
    { key: 'copilot', label: 'AI 副驾', icon: 'robot', to: '/ai-copilot', role: 'teacher', group: 'ai' },
    { key: 'evolution-eye', label: '进化之眼', icon: 'sparkle', to: '/evolution-eye', role: 'teacher', group: 'ai' },
    { key: 'thinking-palace', label: '思考宫殿', icon: 'brain', to: '/thinking-palace', role: 'teacher', group: 'ai' },
    // ── 文化沉淀（共享）──
    { key: 'culture', label: '文化语境', icon: 'globe', to: '/culture', role: 'both', group: 'culture' },
] as const

// ─────────────────────────────────────────────────────────────
// 角色过滤工具
// ─────────────────────────────────────────────────────────────

/** 按角色过滤可见导航项 */
export function getNavForRole(role: UserRole): readonly NavItem[] {
    return NAV.filter((item) => item.role === role || item.role === 'both')
}

/** 按角色过滤可见分组 */
export function getGroupsForRole(role: UserRole): readonly NavGroupMeta[] {
    return NAV_GROUPS.filter((g) => g.role === role || g.role === 'both')
}

/** 获取角色默认落地页 */
export function getDefaultRoute(_role: UserRole): string {
    // v9：纯教师端，统一返回驾驶舱
    return '/dashboard'
}

/** 判断路由是否对当前角色可见（路由守卫用） */
export function isRouteAllowed(pathname: string, role: UserRole): boolean {
    // 公共路由：始终允许
    const publicPaths = ['/login', '/privacy', '/forbidden', '/logout']
    if (publicPaths.includes(pathname)) return true

    // 精确匹配
    const exactMatch = NAV.find((item) => item.to === pathname)
    if (exactMatch) {
        return exactMatch.role === role || exactMatch.role === 'both'
    }

    // 前缀匹配（处理 /classroom/:lessonId 等动态路由）
    const prefixMatch = NAV.find((item) => pathname.startsWith(item.to + '/'))
    if (prefixMatch) {
        return prefixMatch.role === role || prefixMatch.role === 'both'
    }

    // 未知路由（404 等）：允许，由 404 页面处理
    return true
}

// ─────────────────────────────────────────────────────────────
// AppShell variant 选择（v9：沉浸式场景启用 immersive 模式）
// ─────────────────────────────────────────────────────────────

/**
 * 根据路由返回 AppShell 模式（v10：星图沉浸画布，其余页面 classic）
 *
 * v10 变更：课堂页恢复 classic 侧边栏；星图仍使用 immersive 画布模式。
 *
 * - `/starmap`：immersive 模式，由页面提供返回与导航入口
 * - 其余页面：classic 模式，保留全局侧栏 + 面包屑导航
 *
 * 设计理由：用户反馈"主界面都是使用侧边栏的样式"，统一 classic 模式
 * 确保导航上下文不丢失、切换摩擦最低、视觉一致性最强。
 */
export function getVariantForPath(pathname: string): AppShellVariant {
    return pathname === '/starmap' ? 'immersive' : 'classic'
}

// ─────────────────────────────────────────────────────────────
// 404 智能推荐（B3.1）
// ─────────────────────────────────────────────────────────────

/** levenshtein 距离算法（B3.1：404 智能推荐核心） */
function levenshtein(a: string, b: string): number {
    const m = a.length
    const n = b.length
    if (m === 0) return n
    if (n === 0) return m

    let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j)
    let curr: number[] = new Array(n + 1).fill(0)

    for (let i = 1; i <= m; i++) {
        curr[0] = i
        for (let j = 1; j <= n; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
            curr[j] = Math.min(
                prev[j]! + 1,
                curr[j - 1]! + 1,
                prev[j - 1]! + cost,
            )
        }
        const tmp = prev
        prev = curr
        curr = tmp
    }

    return prev[n]!
}

/**
 * 智能推荐：基于错误路径推荐最接近的有效路由
 */
export function recommendRoutes(
    wrongPath: string,
    limit = 3,
): Array<{ item: NavItem; distance: number; similarity: number }> {
    const normalized = wrongPath.toLowerCase().replace(/\/+$/, '')
    const maxLen = Math.max(normalized.length, 12)

    const scored = NAV.map((item) => {
        const target = item.to.toLowerCase()
        const dist = levenshtein(normalized, target)
        const maxPossible = Math.max(normalized.length, target.length)
        const similarity = maxPossible > 0 ? Math.round((1 - dist / maxPossible) * 100) : 0
        return { item, distance: dist, similarity }
    })

    const threshold = Math.ceil(maxLen * 0.7)
    const filtered = scored
        .filter((s) => s.distance < threshold && s.similarity > 30)
        .sort((a, b) => a.distance - b.distance || b.similarity - a.similarity)

    if (filtered.length >= limit) {
        return filtered.slice(0, limit)
    }

    const defaults = ['dashboard', 'starmap', 'workbench', 'report', 'copilot']
    const existing = new Set(filtered.map((f) => f.item.key))
    const fallback: Array<{ item: NavItem; distance: number; similarity: number }> = []
    for (const key of defaults) {
        if (fallback.length + filtered.length >= limit) break
        if (existing.has(key)) continue
        const item = NAV.find((n) => n.key === key)
        if (item) {
            fallback.push({ item, distance: -1, similarity: 0 })
        }
    }

    return [...filtered, ...fallback].slice(0, limit)
}
