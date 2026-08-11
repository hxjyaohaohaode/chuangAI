/**
 * JSON 字段序列化/反序列化工具
 *
 * SQLite 存储 JSON 字段为 TEXT，本工具负责在 TS 对象与字符串间转换。
 * 安全处理 null/undefined，避免运行时异常。
 */

import { dbLogger } from '../../lib/logger/index.js'

const log = dbLogger()

/**
 * 将对象序列化为 JSON 字符串。
 * - null / undefined → null（存入 SQLite NULL）
 * - 其他对象 → JSON.stringify
 */
export function stringifyJson(value: unknown): string | null {
    if (value === null || value === undefined) return null
    return JSON.stringify(value)
}

/**
 * 将 JSON 字符串解析为对象。
 * - 空字符串 / null / undefined → null
 * - 非法 JSON → null（不抛异常，记录到 logger）
 */
export function parseJson<T = unknown>(raw: string | null | undefined): T | null {
    if (raw === null || raw === undefined || raw === '') return null
    try {
        return JSON.parse(raw) as T
    } catch (err) {
        log.warn(
            {
                err,
                rawPreview: raw.slice(0, 100),
            },
            'JSON 解析失败',
        )
        return null
    }
}

/**
 * 解析为字符串数组（theme/images/rhetoric 等字段用）
 */
export function parseStringArray(raw: string | null | undefined): string[] {
    const parsed = parseJson<unknown[]>(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
}
