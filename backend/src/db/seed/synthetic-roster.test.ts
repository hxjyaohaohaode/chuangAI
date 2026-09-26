import { describe, expect, it } from 'vitest'
import { SEED_CLASS_DEMO } from './seed-class-demo.js'
import { syntheticStudentName } from './synthetic-roster.js'

const CHINESE_NAME = /^[\p{Script=Han}]{2,4}$/u
const LEGACY_CODE = /^S\d{2,3}-[A-Za-z]+$/u

describe('synthetic competition roster', () => {
    it('produces 128 stable, unique and human-readable fictional Chinese names', () => {
        const first = Array.from({ length: 128 }, (_, index) => syntheticStudentName(index))
        const second = Array.from({ length: 128 }, (_, index) => syntheticStudentName(index))

        expect(second).toEqual(first)
        expect(new Set(first).size).toBe(128)
        expect(first.every((name) => CHINESE_NAME.test(name))).toBe(true)
        expect(first.some((name) => LEGACY_CODE.test(name))).toBe(false)
    })

    it('never exports the historical S01-Li code format as a classroom display name', () => {
        expect(SEED_CLASS_DEMO.students).toHaveLength(40)
        expect(SEED_CLASS_DEMO.students.every((student) => (
            CHINESE_NAME.test(student.name)
            && student.anonymousName === student.name
            && !LEGACY_CODE.test(student.name)
        ))).toBe(true)
    })
})
