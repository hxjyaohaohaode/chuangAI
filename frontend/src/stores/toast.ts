import { create } from 'zustand'

/**
 * Toast 全局状态（规范 14.x）
 *
 * 类型：info | success | warning | error
 * 位置：右上固定，多个堆叠
 * 自动消失（默认 3000ms）
 */

export type ToastType = 'info' | 'success' | 'warning' | 'error'

export interface ToastItem {
    id: string
    type: ToastType
    title?: string
    message?: string
    /** 自动消失时长（ms），0 表示不自动消失 */
    duration: number
}

export interface ToastInput {
    type?: ToastType
    title?: string
    message?: string
    duration?: number
}

interface ToastStore {
    toasts: ToastItem[]
    push: (input: ToastInput) => string
    dismiss: (id: string) => void
    clear: () => void
}

let counter = 0
function genId(): string {
    counter += 1
    return `toast-${Date.now()}-${counter}`
}

export const useToastStore = create<ToastStore>((set, get) => ({
    toasts: [],

    push: (input) => {
        // v5.0 Task 5.8：去重逻辑，避免相同消息的 toast 雪崩
        // DEMO 模式下多个 store 可能同时失败，message 含"演示模式"时只按 message 去重
        const isDemoMsg = typeof input.message === 'string' && input.message.includes('演示模式')
        const existing = get().toasts.find((t) => {
            if (isDemoMsg) {
                // DEMO 模式消息：只按 message 去重（不同 store 的 title 可能不同但 message 相同）
                return t.message === input.message
            }
            // 常规消息：按 title + message 去重
            return t.title === input.title && t.message === input.message
        })
        if (existing) {
            return existing.id
        }
        const id = genId()
        const item: ToastItem = {
            id,
            type: input.type ?? 'info',
            title: input.title,
            message: input.message,
            duration: input.duration ?? 3000,
        }
        set((s) => ({ toasts: [...s.toasts, item] }))

        if (item.duration > 0) {
            window.setTimeout(() => {
                get().dismiss(id)
            }, item.duration)
        }
        return id
    },

    dismiss: (id) => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    },

    clear: () => set({ toasts: [] }),
}))

/**
 * 便捷 API —— 在非组件场景或命令式调用时使用
 */
export const toast = {
    info: (input: Omit<ToastInput, 'type'>) => useToastStore.getState().push({ ...input, type: 'info' }),
    success: (input: Omit<ToastInput, 'type'>) => useToastStore.getState().push({ ...input, type: 'success' }),
    warning: (input: Omit<ToastInput, 'type'>) => useToastStore.getState().push({ ...input, type: 'warning' }),
    error: (input: Omit<ToastInput, 'type'>) => useToastStore.getState().push({ ...input, type: 'error' }),
    dismiss: (id: string) => useToastStore.getState().dismiss(id),
    clear: () => useToastStore.getState().clear(),
}
