/**
 * 轻量运行时数据契约校验（v5.0 Task C.1.2）
 *
 * 设计目标：
 *  - 不引入 zod 等外部依赖，保持 bundle 体积（≤1KB gzip）
 *  - 为关键 API 响应提供运行时 shape 校验，防止后端返回畸形数据导致前端崩溃
 *  - 校验失败时由调用方提供安全 fallback，降级渲染（撑场 UI 而非白屏）
 *  - DEV 模式输出校验失败日志便于调试；生产环境经 logError 静默上报
 *
 * 设计取舍：
 *  - 不追求 zod 的全量表达力（如 transform / refine / 异步校验）
 *  - 仅覆盖关键 API 响应的 shape 校验（防崩溃），不替代 TypeScript 静态类型
 *  - 校验失败视为"后端契约漂移"，返回 fallback + 日志，不抛错中断流程
 *
 * 使用方式：
 *   const statsValidator = v.object({
 *     classId: v.string(),
 *     className: v.string(),
 *     studentCount: v.number(),
 *     ...
 *   })
 *   const safe = validateOr(raw, statsValidator, fallbackStats, 'api/dashboard/stats')
 *
 * 不变量：
 *  - 所有 Validator 函数在校验失败时抛 TypeError，由 validate() 统一捕获
 *  - validateOr 在任何情况下都不抛错，永远返回 T（成功为校验值，失败为 fallback）
 */

import { logError } from './errors'

/** 校验器函数类型：接收 data + path，返回强类型 T 或抛 TypeError */
export type Validator<T> = (data: unknown, path: string) => T

/** 校验结果：成功 / 失败的代数类型 */
export type ValidationResult<T> =
    | { ok: true; value: T }
    | { ok: false; error: string }

/**
 * 内置校验器构造器（链式 API，类似 zod 的子集）
 *
 * 支持的类型：
 *  - v.string() / v.number() / v.boolean() —— 基础类型
 *  - v.literal(value) —— 字面量（status: 'ok' 等）
 *  - v.optional(inner) —— 可选（undefined / null 视为缺省）
 *  - v.array(item) —— 数组（逐项校验）
 *  - v.object(shape) —— 对象（仅校验 shape 中声明的字段，忽略额外字段）
 *  - v.passthrough(shape) —— 对象（校验声明字段，保留额外字段透传）
 *  - v.record(valueValidator) —— 字符串键 → 值 的字典
 */
export const v = {
    string(): Validator<string> {
        return (data, path) => {
            if (typeof data !== 'string') {
                throw new TypeError(`${path}: 期望 string, 实际 ${typeof data}`)
            }
            return data
        }
    },

    number(): Validator<number> {
        return (data, path) => {
            if (typeof data !== 'number' || !Number.isFinite(data)) {
                throw new TypeError(`${path}: 期望 finite number, 实际 ${typeof data}`)
            }
            return data
        }
    },

    boolean(): Validator<boolean> {
        return (data, path) => {
            if (typeof data !== 'boolean') {
                throw new TypeError(`${path}: 期望 boolean, 实际 ${typeof data}`)
            }
            return data
        }
    },

    literal<T extends string | number | boolean>(value: T): Validator<T> {
        return (data, path) => {
            if (data !== value) {
                throw new TypeError(
                    `${path}: 期望字面量 ${JSON.stringify(value)}, 实际 ${JSON.stringify(data)}`,
                )
            }
            return data as T
        }
    },

    optional<T>(inner: Validator<T>): Validator<T | undefined> {
        return (data, path) => {
            if (data === undefined || data === null) return undefined
            return inner(data, path)
        }
    },

    array<T>(item: Validator<T>): Validator<T[]> {
        return (data, path) => {
            if (!Array.isArray(data)) {
                throw new TypeError(`${path}: 期望 array, 实际 ${typeof data}`)
            }
            return data.map((d, i) => item(d, `${path}[${i}]`))
        }
    },

    object<T extends Record<string, unknown>>(shape: { [K in keyof T]: Validator<T[K]> }): Validator<T> {
        return (data, path) => {
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new TypeError(`${path}: 期望 object, 实际 ${typeof data}`)
            }
            const obj = data as Record<string, unknown>
            const result = {} as T
            for (const key in shape) {
                if (Object.prototype.hasOwnProperty.call(shape, key)) {
                    result[key] = shape[key](obj[key], `${path}.${key}`)
                }
            }
            return result
        }
    },

    /**
     * 透传校验器：校验声明字段，同时保留未声明的额外字段
     *
     * 适用场景：后端响应字段较多，前端只需要校验关键字段，但希望透传全部字段避免丢数据
     */
    passthrough<T extends Record<string, unknown>>(
        shape: { [K in keyof T]: Validator<T[K]> },
    ): Validator<T & Record<string, unknown>> {
        return (data, path) => {
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new TypeError(`${path}: 期望 object, 实际 ${typeof data}`)
            }
            const obj = data as Record<string, unknown>
            const result: Record<string, unknown> = { ...obj }
            for (const key in shape) {
                if (Object.prototype.hasOwnProperty.call(shape, key)) {
                    result[key] = shape[key](obj[key], `${path}.${key}`)
                }
            }
            return result as T & Record<string, unknown>
        }
    },

    record<T>(valueValidator: Validator<T>): Validator<Record<string, T>> {
        return (data, path) => {
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new TypeError(`${path}: 期望 record, 实际 ${typeof data}`)
            }
            const obj = data as Record<string, unknown>
            const result: Record<string, T> = {}
            for (const k of Object.keys(obj)) {
                result[k] = valueValidator(obj[k], `${path}.${k}`)
            }
            return result
        }
    },
}

/**
 * 校验数据，返回代数类型结果
 *
 * 不抛错，永远返回 { ok: true, value } 或 { ok: false, error }
 *
 * @param data 原始数据
 * @param validator 校验器
 * @param scope 校验作用域（用于错误日志，如 'api/dashboard/stats'）
 */
function validate<T>(data: unknown, validator: Validator<T>, scope: string): ValidationResult<T> {
    try {
        return { ok: true, value: validator(data, scope) }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: msg }
    }
}

/**
 * 安全校验：失败时返回 fallback，并 logError 上报（DEV 模式输出 console.error）
 *
 * 永远不抛错，永远返回 T（成功为校验值，失败为 fallback）
 *
 * @param data 原始数据
 * @param validator 校验器
 * @param fallback 校验失败时的安全降级值（由调用方提供）
 * @param scope 校验作用域（如 'api/dashboard/stats'），用于日志上报
 */
export function validateOr<T>(data: unknown, validator: Validator<T>, fallback: T, scope: string): T {
    const result = validate(data, validator, scope)
    if (result.ok) return result.value
    logError(scope, new TypeError(result.error), { rawSample: safeSample(data) })
    return fallback
}

/** 安全地采样原始数据用于日志（避免循环引用 / 超长字符串） */
function safeSample(data: unknown): string {
    try {
        const s = JSON.stringify(data)
        if (typeof s === 'string') {
            return s.length > 200 ? s.slice(0, 200) + '...' : s
        }
    } catch {
        // 循环引用等异常，忽略
    }
    return '<unserializable>'
}
