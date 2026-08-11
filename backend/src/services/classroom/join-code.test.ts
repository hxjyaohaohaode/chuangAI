import { describe, expect, it } from 'vitest'
import {
    CLASSROOM_JOIN_CODE_ALPHABET,
    CLASSROOM_JOIN_CODE_LENGTH,
    ClassroomJoinCodeExhaustedError,
    generateUniqueClassroomJoinCode,
} from './join-code.js'

describe('generateUniqueClassroomJoinCode', () => {
    it('uses the ambiguity-free alphabet and fixed production length', () => {
        const code = generateUniqueClassroomJoinCode(() => false)

        expect(code).toHaveLength(CLASSROOM_JOIN_CODE_LENGTH)
        expect([...code].every((char) => CLASSROOM_JOIN_CODE_ALPHABET.includes(char))).toBe(true)
        expect(code).not.toMatch(/[01IO]/u)
    })

    it('checks the persisted uniqueness source and retries a collision', () => {
        const indexes = [0, 0, 0, 1, 1, 1]
        const seen: string[] = []
        const code = generateUniqueClassroomJoinCode(
            (candidate) => {
                seen.push(candidate)
                return candidate === 'AAA'
            },
            {
                alphabet: 'AB',
                length: 3,
                maxAttempts: 2,
                randomIndex: () => indexes.shift() ?? 0,
            },
        )

        expect(code).toBe('BBB')
        expect(seen).toEqual(['AAA', 'BBB'])
    })

    it('fails closed after the configured collision budget instead of recursing forever', () => {
        expect(() => generateUniqueClassroomJoinCode(
            () => true,
            { alphabet: 'AB', length: 2, maxAttempts: 3, randomIndex: () => 0 },
        )).toThrow(ClassroomJoinCodeExhaustedError)
    })

    it.each([-1, 2, 0.5, Number.NaN])('rejects an invalid random index %s', (index) => {
        expect(() => generateUniqueClassroomJoinCode(
            () => false,
            { alphabet: 'AB', length: 1, randomIndex: () => index },
        )).toThrow('随机源返回了越界索引')
    })

    it('rejects unsafe generator configuration', () => {
        expect(() => generateUniqueClassroomJoinCode(() => false, { alphabet: 'A' }))
            .toThrow('课堂加入码配置无效')
        expect(() => generateUniqueClassroomJoinCode(() => false, { maxAttempts: 0 }))
            .toThrow('课堂加入码重试上限无效')
    })
})
