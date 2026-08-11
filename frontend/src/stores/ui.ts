import { create } from 'zustand'

/**
 * UI 全局状态（规范 8.4 状态保持策略）
 *
 * 侧边栏折叠态：默认展开（桌面 22vw），可手动折叠为 56px 图标条。
 * 字号偏好：小/标准/大 三档，调整 --text-base CSS 变量实现全页字阶缩放。
 * 减少动画：无障碍开关，启用后禁用非必要过渡动画（规范 6.6 prefers-reduced-motion 降级）。
 * 状态持久化至 localStorage，刷新后恢复。
 *
 * v5.0 变更（Task 2.5）：
 * - 删除 floatingNavPosition 状态（FloatingNav 已在 Task 2.2 删除）
 * - 旧 localStorage 数据中的 floatingNavPosition 字段会被自然忽略（Partial 解析容错）
 */

export type FontSizePref = 'small' | 'standard' | 'large'

interface UiState {
    sidebarCollapsed: boolean
    toggleSidebar: () => void
    setSidebarCollapsed: (collapsed: boolean) => void
    fontSize: FontSizePref
    setFontSize: (size: FontSizePref) => void
    reduceMotion: boolean
    setReduceMotion: (reduce: boolean) => void
}

const STORAGE_KEY = 'pr-ui-state'

interface PersistedUiState {
    sidebarCollapsed: boolean
    fontSize: FontSizePref
    reduceMotion: boolean
}

function readInitial(): PersistedUiState {
    const fallback: PersistedUiState = {
        // v7 审计修复 P0-C2：侧边栏默认折叠（用户偏好硬约束）
        sidebarCollapsed: true,
        fontSize: 'standard',
        reduceMotion: false,
    }
    if (typeof window === 'undefined') return fallback
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return fallback
        const parsed = JSON.parse(raw) as Partial<PersistedUiState>
        // 旧版本 localStorage 可能含 floatingNavPosition 字段，已被 PersistedUiState 类型排除，
        // 解析为 Partial 后仅读取需要的字段，多余字段自然忽略（向后兼容）
        return {
            // v7 审计修复 P0-C2：未持久化时默认折叠
            sidebarCollapsed: parsed.sidebarCollapsed ?? true,
            fontSize: parsed.fontSize ?? 'standard',
            reduceMotion: parsed.reduceMotion ?? false,
        }
    } catch {
        return fallback
    }
}

function persist(state: PersistedUiState): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
        /* localStorage 不可用时静默降级 */
    }
}

/** 字号偏好 → --text-base 像素值（规范 5.2.1 流体字号） */
const FONT_SIZE_MAP: Record<FontSizePref, string> = {
    small: '14px',
    standard: '15px',
    large: '17px',
}

/** 应用字号到 document 根元素 */
export function applyFontSize(size: FontSizePref): void {
    if (typeof document === 'undefined') return
    document.documentElement.style.setProperty('--text-base', FONT_SIZE_MAP[size])
}

/** 应用减少动画到 document 根元素 */
export function applyReduceMotion(reduce: boolean): void {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.reduceMotion = reduce ? '1' : '0'
}

const initial = readInitial()

export const useUiStore = create<UiState>((set, get) => ({
    sidebarCollapsed: initial.sidebarCollapsed,
    fontSize: initial.fontSize,
    reduceMotion: initial.reduceMotion,

    toggleSidebar: () => {
        const next = !get().sidebarCollapsed
        set({ sidebarCollapsed: next })
        persist({ ...get(), sidebarCollapsed: next })
    },

    setSidebarCollapsed: (collapsed) => {
        set({ sidebarCollapsed: collapsed })
        persist({ ...get(), sidebarCollapsed: collapsed })
    },

    setFontSize: (size) => {
        set({ fontSize: size })
        applyFontSize(size)
        persist({ ...get(), fontSize: size })
    },

    setReduceMotion: (reduce) => {
        set({ reduceMotion: reduce })
        applyReduceMotion(reduce)
        persist({ ...get(), reduceMotion: reduce })
    },
}))

// 初始化时立即应用字号和动画偏好（确保刷新后 CSS 变量一致）
applyFontSize(initial.fontSize)
applyReduceMotion(initial.reduceMotion)
