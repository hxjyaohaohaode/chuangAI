/** Agent data is copied and bounded; references never evaluate code or access prototypes. */
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])
export class RuntimeDataError extends Error {
    readonly code = 'INVALID_RUNTIME_DATA'
    constructor(message: string) { super(message); this.name = 'RuntimeDataError' }
}
export function cloneRuntimeData<T>(value: T, maxBytes = 2_000_000): T {
    let bytes = 0
    let entries = 0
    const ancestors = new Set<object>()
    function visit(item: unknown, depth: number): unknown {
        if (++entries > 50_000 || depth > 24) throw new RuntimeDataError('数据结构超过运行时预算')
        if (item === undefined || item === null || typeof item === 'boolean') return item
        if (typeof item === 'number') {
            if (!Number.isFinite(item)) throw new RuntimeDataError('数据包含非有限数字')
            return item
        }
        if (typeof item === 'string') {
            bytes += Buffer.byteLength(item, 'utf8')
            if (bytes > maxBytes) throw new RuntimeDataError('数据超过字节预算')
            return item
        }
        if (typeof item !== 'object') throw new RuntimeDataError('数据包含不可传递的值')
        if (ancestors.has(item)) throw new RuntimeDataError('数据存在循环引用')
        if (item instanceof Uint8Array) {
            bytes += item.byteLength
            if (bytes > maxBytes) throw new RuntimeDataError('二进制数据超过字节预算')
            return Buffer.isBuffer(item) ? Buffer.from(item) : item.slice()
        }
        const proto = Object.getPrototypeOf(item)
        if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) throw new RuntimeDataError('数据必须是普通对象或数组')
        ancestors.add(item)
        try {
            const result: Record<string, unknown> | unknown[] = Array.isArray(item) ? [] : {}
            for (const key of Object.keys(item)) {
                if (FORBIDDEN.has(key)) throw new RuntimeDataError('数据包含禁止的属性名')
                const descriptor = Object.getOwnPropertyDescriptor(item, key)
                if (!descriptor || !('value' in descriptor)) throw new RuntimeDataError('数据不允许包含访问器')
                bytes += Buffer.byteLength(key, 'utf8') + 8
                if (bytes > maxBytes) throw new RuntimeDataError('数据超过字节预算')
                Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true })
            }
            return result
        } finally { ancestors.delete(item) }
    }
    return visit(value, 0) as T
}
interface Binding { taskId: string; path?: string[] }
function binding(value: Record<string, unknown>): Binding | null {
    if (!Object.hasOwn(value, '$from')) return null
    if (Object.keys(value).length !== 1) throw new RuntimeDataError('$from 不能与其他字段混用')
    const ref = value.$from
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new RuntimeDataError('$from 必须是引用对象')
    const obj = ref as Record<string, unknown>
    if (Object.keys(obj).some(key => key !== 'taskId' && key !== 'path') || typeof obj.taskId !== 'string' || !obj.taskId || obj.taskId.length > 128) throw new RuntimeDataError('上游任务引用无效')
    if (obj.path !== undefined && (!Array.isArray(obj.path) || obj.path.length > 16 || obj.path.some(p => typeof p !== 'string' || !p || p.length > 128 || FORBIDDEN.has(p)))) throw new RuntimeDataError('上游数据路径无效')
    return { taskId: obj.taskId, path: obj.path as string[] | undefined }
}
/** Omitting results validates the binding graph without performing model calls. */
export function resolveTaskInput(input: unknown, dependencies: readonly string[], results?: ReadonlyMap<string, unknown>): unknown {
    const allowed = new Set(dependencies)
    const copied = cloneRuntimeData(input)
    function walk(value: unknown): unknown {
        if (Array.isArray(value)) return value.map(walk)
        if (!value || typeof value !== 'object' || value instanceof Uint8Array) return value
        const obj = value as Record<string, unknown>
        const ref = binding(obj)
        if (ref) {
            if (!allowed.has(ref.taskId)) throw new RuntimeDataError('数据引用必须来自显式声明的直接依赖')
            if (!results) return value
            if (!results.has(ref.taskId)) throw new RuntimeDataError('上游任务没有成功产物，拒绝用空值替代')
            let selected: unknown = results.get(ref.taskId)
            for (const key of ref.path ?? []) {
                if (!selected || typeof selected !== 'object' || !Object.hasOwn(selected, key)) throw new RuntimeDataError('上游产物缺少请求字段')
                const descriptor = Object.getOwnPropertyDescriptor(selected, key)
                if (!descriptor || !('value' in descriptor)) throw new RuntimeDataError('上游字段不是可传递的数据')
                selected = descriptor.value
            }
            return cloneRuntimeData(selected)
        }
        return Object.fromEntries(Object.entries(obj).map(([key, item]) => [key, walk(item)]))
    }
    return cloneRuntimeData(walk(copied))
}
