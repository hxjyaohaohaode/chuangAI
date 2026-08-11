import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeElementResize } from './resize-observer'

afterEach(() => vi.unstubAllGlobals())

describe('observeElementResize', () => {
    it('uses ResizeObserver and disconnects it', () => {
        const observe = vi.fn()
        const disconnect = vi.fn()
        vi.stubGlobal('ResizeObserver', class {
            observe = observe
            disconnect = disconnect
        })
        const cleanup = observeElementResize({} as Element, vi.fn())
        expect(observe).toHaveBeenCalledTimes(1)
        cleanup()
        expect(disconnect).toHaveBeenCalledTimes(1)
    })

    it('falls back to window resize when a stubbed observer throws', () => {
        const addEventListener = vi.fn()
        const removeEventListener = vi.fn()
        vi.stubGlobal('ResizeObserver', class {
            constructor() { throw new Error('stubbed observer failure') }
        })
        vi.stubGlobal('window', { addEventListener, removeEventListener })
        const callback = vi.fn()
        const cleanup = observeElementResize({} as Element, callback)
        expect(addEventListener).toHaveBeenCalledWith('resize', callback, { passive: true })
        cleanup()
        expect(removeEventListener).toHaveBeenCalledWith('resize', callback)
    })

    it('fails open when neither resize API exists', () => {
        vi.stubGlobal('ResizeObserver', undefined)
        vi.stubGlobal('window', undefined)
        expect(() => observeElementResize({} as Element, vi.fn())()).not.toThrow()
    })
})
