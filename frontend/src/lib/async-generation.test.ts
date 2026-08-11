import { describe, expect, it } from 'vitest'
import {
    beginAsyncGeneration,
    invalidateAsyncGeneration,
    isAsyncGenerationCurrent,
} from './async-generation'

describe('async generation guard', () => {
    it('accepts only the latest request for the same mounted context', () => {
        const generation = { current: 0 }
        const first = beginAsyncGeneration(generation, 'poem:a')
        const second = beginAsyncGeneration(generation, 'poem:a')

        expect(isAsyncGenerationCurrent(first, generation.current, 'poem:a', true)).toBe(false)
        expect(isAsyncGenerationCurrent(second, generation.current, 'poem:a', true)).toBe(true)
    })

    it('rejects a result when the entity context changed even with the same number', () => {
        const generation = { current: 0 }
        const token = beginAsyncGeneration(generation, 'lesson:a/question:1')

        expect(isAsyncGenerationCurrent(
            token,
            generation.current,
            'lesson:a/question:2',
            true,
        )).toBe(false)
    })

    it('rejects every pending result after explicit invalidation or unmount', () => {
        const generation = { current: 0 }
        const token = beginAsyncGeneration(generation, 'poem:a')
        invalidateAsyncGeneration(generation)

        expect(isAsyncGenerationCurrent(token, generation.current, 'poem:a', true)).toBe(false)
        const current = beginAsyncGeneration(generation, 'poem:a')
        expect(isAsyncGenerationCurrent(current, generation.current, 'poem:a', false)).toBe(false)
    })
})
