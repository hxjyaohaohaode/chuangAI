/**
 * ID 生成工具
 *
 * 使用 Node.js crypto.randomUUID() 生成符合 RFC 4122 v4 的 UUID。
 * 无外部依赖，性能足够（单次 ~1μs）。
 */
import { randomUUID } from 'node:crypto'

export function generateId(): string {
    return randomUUID()
}
