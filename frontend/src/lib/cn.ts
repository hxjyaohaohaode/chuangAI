import { clsx, type ClassValue } from 'clsx'

/**
 * 类名合并工具 —— 基于 clsx，统一处理条件 className。
 * 所有 UI 组件通过此函数合并外部传入的 className 与内部样式。
 */
export function cn(...inputs: ClassValue[]): string {
    return clsx(inputs)
}
