/**
 * db/utils/json.ts 单元测试
 *
 * 覆盖：
 * - stringifyJson：null/undefined → null，其他 → JSON 字符串
 * - parseJson：空值 → null，非法 JSON → null（不抛），合法 → 解析
 * - parseStringArray：非数组 → []，数组过滤非字符串
 *
 * 设计原则：
 * - 不 mock logger，验证 warn 路径不抛错
 * - 边界条件覆盖：null / undefined / '' / 非法 JSON / 嵌套对象
 */

import { describe, expect, it } from 'vitest'
import { parseJson, parseStringArray, stringifyJson } from './json.js'

// ─────────────────────────────────────────────────────────────
// stringifyJson
// ─────────────────────────────────────────────────────────────

describe('stringifyJson', () => {
    it('null → null', () => {
        expect(stringifyJson(null)).toBeNull()
    })

    it('undefined → null', () => {
        expect(stringifyJson(undefined)).toBeNull()
    })

    it('对象 → JSON 字符串', () => {
        expect(stringifyJson({ a: 1 })).toBe('{"a":1}')
    })

    it('数组 → JSON 字符串', () => {
        expect(stringifyJson([1, 2, 3])).toBe('[1,2,3]')
    })

    it('字符串 → 含引号的 JSON 字符串', () => {
        expect(stringifyJson('hello')).toBe('"hello"')
    })

    it('数字 → 数字字面量字符串', () => {
        expect(stringifyJson(42)).toBe('42')
    })

    it('布尔 → true/false 字符串', () => {
        expect(stringifyJson(true)).toBe('true')
        expect(stringifyJson(false)).toBe('false')
    })

    it('空对象 → "{}"', () => {
        expect(stringifyJson({})).toBe('{}')
    })

    it('空数组 → "[]"', () => {
        expect(stringifyJson([])).toBe('[]')
    })

    it('嵌套对象 → JSON 字符串', () => {
        const obj = { a: { b: { c: [1, 2] } } }
        expect(stringifyJson(obj)).toBe('{"a":{"b":{"c":[1,2]}}}')
    })

    it('0 → "0"（falsy 但有效）', () => {
        expect(stringifyJson(0)).toBe('0')
    })

    it('空字符串 → \'""\'（falsy 但有效）', () => {
        expect(stringifyJson('')).toBe('""')
    })
})

// ─────────────────────────────────────────────────────────────
// parseJson
// ─────────────────────────────────────────────────────────────

describe('parseJson', () => {
    it('null → null', () => {
        expect(parseJson(null)).toBeNull()
    })

    it('undefined → null', () => {
        expect(parseJson(undefined)).toBeNull()
    })

    it('空字符串 → null', () => {
        expect(parseJson('')).toBeNull()
    })

    it('合法 JSON 对象 → 解析', () => {
        expect(parseJson('{"a":1}')).toEqual({ a: 1 })
    })

    it('合法 JSON 数组 → 解析', () => {
        expect(parseJson('[1,2,3]')).toEqual([1, 2, 3])
    })

    it('合法 JSON 字符串 → 解析', () => {
        expect(parseJson('"hello"')).toBe('hello')
    })

    it('合法 JSON 数字 → 解析', () => {
        expect(parseJson('42')).toBe(42)
    })

    it('合法 JSON 布尔 → 解析', () => {
        expect(parseJson('true')).toBe(true)
        expect(parseJson('false')).toBe(false)
    })

    it('合法 JSON null 字面量 → null', () => {
        expect(parseJson('null')).toBeNull()
    })

    it('嵌套 JSON → 解析', () => {
        const raw = '{"a":{"b":{"c":[1,2]}}}'
        expect(parseJson(raw)).toEqual({ a: { b: { c: [1, 2] } } })
    })

    it('非法 JSON → null（不抛异常）', () => {
        expect(parseJson('{invalid}')).toBeNull()
    })

    it('残缺 JSON → null', () => {
        expect(parseJson('{"a":')).toBeNull()
    })

    it('纯文本（非 JSON）→ null', () => {
        expect(parseJson('hello world')).toBeNull()
    })

    it('支持泛型类型参数', () => {
        const result = parseJson<{ a: number; b: string }>('{"a":1,"b":"x"}')
        expect(result?.a).toBe(1)
        expect(result?.b).toBe('x')
    })

    it('长字符串非法 JSON → null（不截断日志预览）', () => {
        const long = 'x'.repeat(200)
        expect(parseJson(long)).toBeNull()
    })
})

// ─────────────────────────────────────────────────────────────
// parseStringArray
// ─────────────────────────────────────────────────────────────

describe('parseStringArray', () => {
    it('null → []', () => {
        expect(parseStringArray(null)).toEqual([])
    })

    it('undefined → []', () => {
        expect(parseStringArray(undefined)).toEqual([])
    })

    it('空字符串 → []', () => {
        expect(parseStringArray('')).toEqual([])
    })

    it('字符串数组 → 原样返回', () => {
        expect(parseStringArray('["a","b","c"]')).toEqual(['a', 'b', 'c'])
    })

    it('混合类型数组 → 过滤非字符串', () => {
        expect(parseStringArray('["a",1,true,null,"b"]')).toEqual(['a', 'b'])
    })

    it('全数字数组 → []', () => {
        expect(parseStringArray('[1,2,3]')).toEqual([])
    })

    it('空数组 → []', () => {
        expect(parseStringArray('[]')).toEqual([])
    })

    it('对象数组（非字符串）→ []', () => {
        expect(parseStringArray('[{"a":1}]')).toEqual([])
    })

    it('JSON 对象（非数组）→ []', () => {
        expect(parseStringArray('{"a":1}')).toEqual([])
    })

    it('JSON 字符串（非数组）→ []', () => {
        expect(parseStringArray('"hello"')).toEqual([])
    })

    it('JSON 数字（非数组）→ []', () => {
        expect(parseStringArray('42')).toEqual([])
    })

    it('非法 JSON → []', () => {
        expect(parseStringArray('{invalid}')).toEqual([])
    })

    it('含空字符串的数组 → 保留空字符串', () => {
        // 空字符串 typeof === 'string'，应保留
        expect(parseStringArray('["a","","b"]')).toEqual(['a', '', 'b'])
    })

    it('含中文/Unicode 字符串 → 保留', () => {
        expect(parseStringArray('["诗","词","赋"]')).toEqual(['诗', '词', '赋'])
    })
})
