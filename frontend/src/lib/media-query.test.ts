import { afterEach, describe, expect, it, vi } from 'vitest'
import { matchesMediaQuery, subscribeMediaQuery } from './media-query'

afterEach(() => vi.unstubAllGlobals())

describe('media query compatibility', () => {
    it('reads a valid preference and fails open for missing or throwing APIs', () => {
        vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
        expect(matchesMediaQuery('(prefers-reduced-motion: reduce)')).toBe(true)
        vi.stubGlobal('window', { matchMedia: () => { throw new Error('stub failure') } })
        expect(matchesMediaQuery('(prefers-reduced-motion: reduce)')).toBe(false)
        expect(matchesMediaQuery('(prefers-reduced-motion: reduce)', true)).toBe(true)
        vi.stubGlobal('window', {})
        expect(matchesMediaQuery('(pointer: coarse)')).toBe(false)
    })

    it('uses the modern listener API and removes the same handler', () => {
        const addEventListener = vi.fn()
        const removeEventListener = vi.fn()
        const query = { addEventListener, removeEventListener } as unknown as MediaQueryList
        const handler = vi.fn()
        const unsubscribe = subscribeMediaQuery(query, handler)
        expect(addEventListener).toHaveBeenCalledWith('change', handler)
        unsubscribe()
        expect(removeEventListener).toHaveBeenCalledWith('change', handler)
    })

    it('falls back to legacy Safari/WebView listeners', () => {
        const addListener = vi.fn()
        const removeListener = vi.fn()
        const query = { addListener, removeListener } as unknown as MediaQueryList
        const handler = vi.fn()
        const unsubscribe = subscribeMediaQuery(query, handler)
        expect(addListener).toHaveBeenCalledWith(handler)
        unsubscribe()
        expect(removeListener).toHaveBeenCalledWith(handler)
    })

    it('keeps a static preference when no listener API exists', () => {
        const query = {} as MediaQueryList
        const unsubscribe = subscribeMediaQuery(query, vi.fn())
        expect(() => unsubscribe()).not.toThrow()
    })
})
