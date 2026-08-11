/**
 * 全局认证状态（P1-B：消除 4 处写死 teacherId + v9 纯教师端）
 *
 * 职责：
 * 1. 持有当前登录用户身份（userId / userName / role）
 * 2. role 类型保留 'teacher' | 'student' 以兼容类型系统，v9 起仅渲染教师端
 * 3. 持有当前选中班级（classId）—— 教师视角
 * 4. localStorage 持久化（刷新后恢复）
 *
 * 设计要点：
 * - 单一来源：所有 store 通过 useAuthStore.getState() 读取身份
 * - 认证守卫：isAuthenticated 控制路由访问（未登录 → /login）
 * - 默认落地页统一为 /dashboard（纯教师端）
 * - 无循环依赖：auth.ts 不依赖任何业务 store
 */

import { create } from 'zustand'

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const STORAGE_KEY = 'pr-auth-state'

/** 未建立服务器会话前的本地演示占位；不能作为在线身份凭证。 */
export const DEFAULT_TEACHER_ID = 'teacher-001'
export const DEFAULT_TEACHER_NAME = '王雅琴'
export const DEFAULT_STUDENT_ID = 'student-default'
export const DEFAULT_STUDENT_NAME = '默认学生'

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export type UserRole = 'teacher' | 'student'

export interface AuthState {
    /** 当前用户 ID（教师工号或学生学号） */
    userId: string
    /** 当前用户显示名 */
    userName: string
    /** 当前角色 —— 决定可见导航与默认落地页 */
    role: UserRole
    /** 当前选中班级 ID（教师视角，空字符串表示未选） */
    classId: string
    /** 是否已认证（未认证时路由守卫重定向到 /login） */
    isAuthenticated: boolean
    /** 是否已 hydrate（从 localStorage 恢复） */
    hydrated: boolean

    /** 登录：设置身份 + 角色 + 标记已认证 */
    login: (params: { id: string; name: string; role: UserRole }) => void
    /** 登出：重置身份 + 取消认证 */
    logout: () => void
    /** 切换用户身份（登录后切换账号） */
    setUser: (id: string, name?: string) => void
    /** 切换班级（AppShell 班级选择器调用，仅教师可用） */
    setClass: (id: string) => void
    /** @deprecated 使用 setUser（向后兼容别名） */
    setTeacher: (id: string, name?: string) => void
    /** 显式 hydrate（App 初始化时调用一次） */
    hydrate: () => void
    /** 重置为默认值（内部方法，logout 调用） */
    reset: () => void

    // ── 向后兼容别名（v7 历史代码引用 teacherId/teacherName） ──
    /** @deprecated 使用 userId */
    teacherId: string
    /** @deprecated 使用 userName */
    teacherName: string
}

// ─────────────────────────────────────────────────────────────
// localStorage 持久化
// ─────────────────────────────────────────────────────────────

interface PersistedAuth {
    userId: string
    userName: string
    role: UserRole
    classId: string
    isAuthenticated: boolean
}

function readPersisted(): PersistedAuth {
    const fallback: PersistedAuth = {
        userId: DEFAULT_TEACHER_ID,
        userName: DEFAULT_TEACHER_NAME,
        role: 'teacher',
        classId: '',
        isAuthenticated: false,
    }
    if (typeof window === 'undefined') return fallback
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return fallback
        const parsed = JSON.parse(raw) as Partial<PersistedAuth>
        // v8 兼容：旧版持久化数据用 teacherId/teacherName，新版用 userId/userName
        const userId = parsed.userId ?? (parsed as unknown as { teacherId?: string }).teacherId ?? DEFAULT_TEACHER_ID
        const userName = parsed.userName ?? (parsed as unknown as { teacherName?: string }).teacherName ?? DEFAULT_TEACHER_NAME
        return {
            userId,
            userName,
            role: parsed.role ?? (userId.startsWith('student') ? 'student' : 'teacher'),
            classId: parsed.classId ?? '',
            isAuthenticated: parsed.isAuthenticated ?? false,
        }
    } catch {
        return fallback
    }
}

function writePersisted(state: PersistedAuth): void {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
        // localStorage 满或被禁用，静默降级
    }
}

// ─────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────

const initial = readPersisted()

export const useAuthStore = create<AuthState>((set, get) => ({
    userId: initial.userId,
    userName: initial.userName,
    role: initial.role,
    classId: initial.classId,
    isAuthenticated: initial.isAuthenticated,
    hydrated: true,

    // 向后兼容别名
    teacherId: initial.userId,
    teacherName: initial.userName,

    login: ({ id, name, role }) => {
        set({
            userId: id,
            userName: name,
            role,
            isAuthenticated: true,
            teacherId: id,
            teacherName: name,
        })
        writePersisted({
            userId: id,
            userName: name,
            role,
            classId: get().classId,
            isAuthenticated: true,
        })
    },

    logout: () => {
        set({
            userId: DEFAULT_TEACHER_ID,
            userName: DEFAULT_TEACHER_NAME,
            role: 'teacher',
            classId: '',
            isAuthenticated: false,
            teacherId: DEFAULT_TEACHER_ID,
            teacherName: DEFAULT_TEACHER_NAME,
        })
        writePersisted({
            userId: DEFAULT_TEACHER_ID,
            userName: DEFAULT_TEACHER_NAME,
            role: 'teacher',
            classId: '',
            isAuthenticated: false,
        })
    },

    setUser: (id, name) => {
        const userName = name ?? id
        set({ userId: id, userName, teacherId: id, teacherName: userName })
        writePersisted({
            userId: id,
            userName,
            role: get().role,
            classId: get().classId,
            isAuthenticated: get().isAuthenticated,
        })
    },

    setClass: (id) => {
        set({ classId: id })
        writePersisted({
            userId: get().userId,
            userName: get().userName,
            role: get().role,
            classId: id,
            isAuthenticated: get().isAuthenticated,
        })
    },

    // 向后兼容别名
    setTeacher: (id, name) => {
        get().setUser(id, name)
    },

    hydrate: () => {
        const persisted = readPersisted()
        set({
            userId: persisted.userId,
            userName: persisted.userName,
            role: persisted.role,
            classId: persisted.classId,
            isAuthenticated: persisted.isAuthenticated,
            hydrated: true,
            teacherId: persisted.userId,
            teacherName: persisted.userName,
        })
    },

    reset: () => {
        set({
            userId: DEFAULT_TEACHER_ID,
            userName: DEFAULT_TEACHER_NAME,
            role: 'teacher',
            classId: '',
            isAuthenticated: false,
            teacherId: DEFAULT_TEACHER_ID,
            teacherName: DEFAULT_TEACHER_NAME,
        })
        writePersisted({
            userId: DEFAULT_TEACHER_ID,
            userName: DEFAULT_TEACHER_NAME,
            role: 'teacher',
            classId: '',
            isAuthenticated: false,
        })
    },
}))
