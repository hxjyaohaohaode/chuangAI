/**
 * 统一错误处理工具（P0-A 修复核心）
 *
 * 设计目标：
 * - 防止后端响应体（可能含 stack trace / sqlMessage / 内部错误详情）泄漏到终端用户
 * - 生产环境只暴露静态中文文案 + status code
 * - DEV 模式保留完整 err.message 供调试
 * - 统一所有 toast.error / JSX 渲染 / store state.error 的错误展示出口
 *
 * 使用方式：
 *   import { getDisplayError, logError } from '@/lib/errors'
 *   catch (err) {
 *     const msg = getDisplayError(err, '加载失败')
 *     toast.error({ title: '错误', message: msg })
 *     logError('stores/dashboard/loadDashboard', err)
 *   }
 *
 * 不变量：
 * - getDisplayError 在生产环境永远不返回 err.message（防止后端响应体 / stack 泄漏）
 * - getDisplayError 在 DEV 模式优先返回 ApiError.safeMessage（若存在），否则返回 err.message
 * - logError 在生产环境为 noop，避免污染浏览器 console
 */

/** API 错误（携带 HTTP status + 安全的 statusText） */
export class ApiError extends Error {
    public readonly status: number
    public readonly statusText: string
    /** DEV 模式才填充的原始响应体（生产环境永远为 undefined） */
    public readonly devDetail?: string

    constructor(status: number, statusText: string, devDetail?: string) {
        const safeText = statusText || `HTTP ${status}`
        super(`API ${status}: ${safeText}`)
        this.name = 'ApiError'
        this.status = status
        this.statusText = safeText
        this.devDetail = devDetail
    }
}

/**
 * 获取面向用户展示的错误文案
 *
 * - 生产环境：永远返回 fallback，绝不返回 err.message（防止后端响应体 / stack 泄漏）
 * - DEV 模式：返回 err.message（含 ApiError 的 status/statusText，便于调试）
 *
 * @param err catch 块中的 unknown 错误对象
 * @param fallback 生产环境展示的静态中文文案（必填，禁止传空字符串）
 */
export function getDisplayError(err: unknown, fallback: string): string {
    if (!fallback) {
        fallback = '操作失败，请稍后重试'
    }
    if (import.meta.env.DEV) {
        if (err instanceof Error) {
            return err.message || fallback
        }
        if (typeof err === 'string') {
            return err || fallback
        }
        try {
            return String(err) || fallback
        } catch {
            return fallback
        }
    }
    return fallback
}

/**
 * 安全地记录错误到 console（仅 DEV 模式）
 *
 * 生产环境为 noop，避免污染浏览器 console（且避免泄漏内部错误到 DevTools）
 *
 * @param scope 错误发生的作用域，如 'stores/dashboard/loadDashboard'
 * @param err catch 块中的 unknown 错误对象
 * @param context 可选的上下文信息（如请求参数）
 */
export function logError(scope: string, err: unknown, context?: Record<string, unknown>): void {
    if (!import.meta.env.DEV) return
    if (context) {
        // eslint-disable-next-line no-console
        console.error(`[${scope}]`, err, context)
    } else {
        // eslint-disable-next-line no-console
        console.error(`[${scope}]`, err)
    }
}