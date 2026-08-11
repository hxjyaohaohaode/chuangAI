/**
 * db/utils/id.ts 单元测试
 *
 * 覆盖：
 * - generateId：返回字符串、UUID v4 格式、唯一性、多次调用
 *
 * 设计原则：
 * - 使用正则表达式验证 UUID v4 格式
 * - 通过多次调用验证唯一性
 */

import { describe, expect, it } from 'vitest'
import { generateId } from './id.js'

// UUID v4 正则（小写十六进制，第三组以 4 开头，第四组以 8/9/a/b 开头）
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('generateId', () => {
    it('返回字符串', () => {
        const id = generateId()
        expect(typeof id).toBe('string')
    })

    it('符合 UUID v4 格式', () => {
        const id = generateId()
        expect(id).toMatch(UUID_V4_REGEX)
    })

    it('长度为 36 字符（含 4 个连字符）', () => {
        const id = generateId()
        expect(id.length).toBe(36)
    })

    it('多次调用结果唯一', () => {
        const ids = new Set<string>()
        for (let i = 0; i < 1000; i++) {
            ids.add(generateId())
        }
        expect(ids.size).toBe(1000)
    })

    it('连续两次调用返回不同值', () => {
        const id1 = generateId()
        const id2 = generateId()
        expect(id1).not.toBe(id2)
    })

    it('第三段以 4 开头（v4 标识）', () => {
        // 多次验证：v4 UUID 的第三段以 4 开头
        for (let i = 0; i < 10; i++) {
            const id = generateId()
            const segments = id.split('-')
            expect(segments[2]!.startsWith('4')).toBe(true)
        }
    })

    it('第四段以 8/9/a/b 开头（variant 标识）', () => {
        for (let i = 0; i < 10; i++) {
            const id = generateId()
            const segments = id.split('-')
            const variantChar = segments[3]!.charAt(0).toLowerCase()
            expect(['8', '9', 'a', 'b']).toContain(variantChar)
        }
    })

    it('所有字符为十六进制 + 连字符', () => {
        const id = generateId()
        // 移除连字符后应全部为十六进制字符
        const hex = id.replace(/-/g, '')
        expect(hex).toMatch(/^[0-9a-f]{32}$/i)
        expect(hex.length).toBe(32)
    })
})
