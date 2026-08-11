import { describe, expect, it } from 'vitest'
import { appendBoundedHistory } from './bounded-history'

describe('appendBoundedHistory', () => {
    it('appends without mutating either input', () => {
        const current = Object.freeze([1, 2])
        const additions = Object.freeze([3, 4])

        expect(appendBoundedHistory(current, additions, 5)).toEqual([1, 2, 3, 4])
        expect(current).toEqual([1, 2])
        expect(additions).toEqual([3, 4])
    })

    it('retains the newest complete window', () => {
        expect(appendBoundedHistory([1, 2, 3], [4, 5], 4)).toEqual([2, 3, 4, 5])
    })

    it('keeps the newest additions when one batch exceeds the limit', () => {
        expect(appendBoundedHistory([1, 2], [3, 4, 5, 6], 3)).toEqual([4, 5, 6])
    })

    it('fails closed for zero, negative, non-finite and fractional limits', () => {
        expect(appendBoundedHistory([1], [2], 0)).toEqual([])
        expect(appendBoundedHistory([1], [2], -3)).toEqual([])
        expect(appendBoundedHistory([1], [2], Number.NaN)).toEqual([])
        expect(appendBoundedHistory([1, 2], [3], 2.9)).toEqual([2, 3])
    })
})
