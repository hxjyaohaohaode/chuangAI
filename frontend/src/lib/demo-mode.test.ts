import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDemoModeStore } from './demo-mode'

interface MutableVisibilityDocument extends EventTarget {
    visibilityState: DocumentVisibilityState
}

let fakeDocument: MutableVisibilityDocument

function installBrowserTimers(): void {
    fakeDocument = new EventTarget() as MutableVisibilityDocument
    Object.defineProperty(fakeDocument, 'visibilityState', {
        configurable: true,
        writable: true,
        value: 'visible',
    })
    vi.stubGlobal('document', fakeDocument)
    vi.stubGlobal('window', {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
    })
}

function setVisibility(value: DocumentVisibilityState): void {
    fakeDocument.visibilityState = value
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
}

async function flushPromises(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
}

describe('demo mode heartbeat lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        installBrowserTimers()
        useDemoModeStore.getState().stopHeartbeat()
        useDemoModeStore.setState({
            isDemoMode: false,
            backendAvailable: true,
            lastError: null,
            lastCheckTime: null,
            consecutiveFailures: 0,
            started: false,
        })
    })

    afterEach(() => {
        useDemoModeStore.getState().stopHeartbeat()
        vi.clearAllTimers()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
        vi.useRealTimers()
    })

    it('aborts an in-flight request and never re-arms after stop', async () => {
        let resolveFetch: ((value: { ok: boolean; status: number }) => void) | undefined
        let requestSignal: AbortSignal | undefined
        const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
            requestSignal = init?.signal ?? undefined
            return new Promise<{ ok: boolean; status: number }>((resolve) => {
                resolveFetch = resolve
            })
        })
        vi.stubGlobal('fetch', fetchMock)

        useDemoModeStore.getState().startHeartbeat()
        vi.advanceTimersByTime(3_000)
        expect(fetchMock).toHaveBeenCalledTimes(1)

        useDemoModeStore.getState().stopHeartbeat()
        expect(requestSignal?.aborted).toBe(true)
        resolveFetch?.({ ok: true, status: 200 })
        await flushPromises()
        vi.advanceTimersByTime(120_000)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(useDemoModeStore.getState().consecutiveFailures).toBe(0)
    })

    it('keeps exactly one loop across a StrictMode-style start-stop-start sequence', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        useDemoModeStore.getState().startHeartbeat()
        useDemoModeStore.getState().stopHeartbeat()
        useDemoModeStore.getState().startHeartbeat()

        vi.advanceTimersByTime(3_000)
        await flushPromises()
        expect(fetchMock).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(29_999)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(1)
        await flushPromises()
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('pauses while hidden and resumes with one immediate heartbeat', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        fakeDocument.visibilityState = 'hidden'

        useDemoModeStore.getState().startHeartbeat()
        vi.advanceTimersByTime(60_000)
        expect(fetchMock).not.toHaveBeenCalled()

        setVisibility('visible')
        vi.advanceTimersByTime(0)
        await flushPromises()
        expect(fetchMock).toHaveBeenCalledTimes(1)

        setVisibility('hidden')
        vi.advanceTimersByTime(120_000)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(useDemoModeStore.getState().consecutiveFailures).toBe(0)

        setVisibility('visible')
        vi.advanceTimersByTime(0)
        await flushPromises()
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('still records a genuine active-request timeout exactly once', async () => {
        const fetchMock = vi.fn((_url: string, init?: RequestInit) => (
            new Promise<never>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    const error = new Error('aborted')
                    error.name = 'AbortError'
                    reject(error)
                }, { once: true })
            })
        ))
        vi.stubGlobal('fetch', fetchMock)

        useDemoModeStore.getState().startHeartbeat()
        vi.advanceTimersByTime(3_000)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(3_000)
        await flushPromises()

        expect(useDemoModeStore.getState().consecutiveFailures).toBe(1)
        expect(useDemoModeStore.getState().lastError).toBe('心跳超时')
    })
})
