import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { businessEvents } from '@/lib/business-events'
import type { ReportRecord } from '@/lib/types'
import { useNotificationStore } from './notifications'
import { useReportStore } from './report'
import { toast } from './toast'

interface Deferred<T> {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

function report(id: string, status: ReportRecord['status']): ReportRecord {
    return {
        id,
        teacherId: 'teacher-001',
        classId: 'class-001',
        className: '五年级一班',
        period: { from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 6, 31) },
        template: 'standard',
        includeSections: ['background', 'intervention', 'evidence', 'reflection'],
        status,
        output: status === 'completed'
            ? {
                title: `报告 ${id}`,
                sections: [],
                keyFindings: [],
                recommendations: [],
                dataAnonymized: true,
                aiGenerated: true,
            }
            : undefined,
        progress: status === 'generating' ? 45 : 100,
        createdAt: Date.UTC(2026, 7, 10),
        updatedAt: Date.UTC(2026, 7, 10),
    }
}

function response(id: string, status: ReportRecord['status']) {
    return {
        status: 'ok' as const,
        report: report(id, status),
        aiGenerated: true as const,
    }
}

function createStorage() {
    const values = new Map<string, string>()
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value) },
        removeItem: (key: string) => { values.delete(key) },
        clear: () => values.clear(),
        key: (index: number) => Array.from(values.keys())[index] ?? null,
        get length() { return values.size },
    }
}

function createVisibilityDocument() {
    let visibilityState: 'visible' | 'hidden' = 'visible'
    const listeners = new Set<EventListener>()
    const fakeDocument = {
        get visibilityState() { return visibilityState },
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === 'visibilitychange' && typeof listener === 'function') listeners.add(listener)
        },
        removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === 'visibilitychange' && typeof listener === 'function') listeners.delete(listener)
        },
    }
    return {
        document: fakeDocument,
        setVisibility(next: 'visible' | 'hidden') {
            visibilityState = next
            listeners.forEach((listener) => listener({ type: 'visibilitychange' } as Event))
        },
        listenerCount: () => listeners.size,
    }
}

async function flushPromises(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
}

describe('report polling lifecycle', () => {
    let visibility: ReturnType<typeof createVisibilityDocument>

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'))
        visibility = createVisibilityDocument()
        vi.stubGlobal('document', visibility.document)
        vi.stubGlobal('window', {
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
            localStorage: createStorage(),
            location: { pathname: '/', search: '', href: '' },
        })

        useReportStore.getState().reset()
        useReportStore.setState({
            classId: 'class-001',
            teacherId: 'teacher-001',
            wsStatus: 'disconnected',
            history: [],
            historyTotal: 0,
            historyPage: 0,
            historyKeyword: '',
            historyFilterFrom: '',
            historyFilterTo: '',
            historyFilterTemplate: '',
            historyFilterStatus: '',
        })
        useNotificationStore.setState({ notifications: [] })

        vi.spyOn(toast, 'info').mockReturnValue('toast-info')
        vi.spyOn(toast, 'success').mockReturnValue('toast-success')
        vi.spyOn(toast, 'warning').mockReturnValue('toast-warning')
        vi.spyOn(toast, 'error').mockReturnValue('toast-error')
        vi.spyOn(api.report, 'list').mockResolvedValue({
            status: 'ok',
            total: 0,
            limit: 20,
            offset: 0,
            items: [],
            aiGenerated: true,
        })
    })

    afterEach(() => {
        useReportStore.getState().reset()
        useNotificationStore.setState({ notifications: [] })
        vi.clearAllTimers()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
        vi.useRealTimers()
    })

    async function startGeneratedReport(reportId: string): Promise<void> {
        vi.spyOn(api.report, 'generate').mockResolvedValueOnce({
            reportId,
            sessionId: `session-${reportId}`,
            status: 'generating',
            aiGenerated: true,
        })
        await useReportStore.getState().generate()
        expect(useReportStore.getState().currentReport?.id).toBe(reportId)
        expect(useReportStore.getState().pollTimerId).not.toBeNull()
    }

    it('uses recursive single-flight polling even when one response is slower than many intervals', async () => {
        const first = deferred<ReturnType<typeof response>>()
        let concurrent = 0
        let maxConcurrent = 0
        let calls = 0
        vi.spyOn(api.report, 'getReport').mockImplementation(async (reportId) => {
            calls += 1
            concurrent += 1
            maxConcurrent = Math.max(maxConcurrent, concurrent)
            try {
                if (calls === 1) return await first.promise
                return response(reportId, 'completed')
            } finally {
                concurrent -= 1
            }
        })

        await startGeneratedReport('report-slow')
        await vi.advanceTimersByTimeAsync(2_000)
        expect(calls).toBe(1)

        await vi.advanceTimersByTimeAsync(20_000)
        expect(calls).toBe(1)
        expect(maxConcurrent).toBe(1)

        first.resolve(response('report-slow', 'generating'))
        await flushPromises()
        await vi.advanceTimersByTimeAsync(1_999)
        expect(calls).toBe(1)
        await vi.advanceTimersByTimeAsync(1)
        await flushPromises()

        expect(calls).toBe(2)
        expect(maxConcurrent).toBe(1)
        expect(useReportStore.getState().currentReport?.status).toBe('completed')
        expect(useReportStore.getState().pollTimerId).toBeNull()
    })

    it('stops immediately when WS connects and restores exactly one poll chain after disconnect', async () => {
        let calls = 0
        let firstSignal: AbortSignal | undefined
        vi.spyOn(api.report, 'getReport').mockImplementation((reportId, signal) => {
            calls += 1
            if (calls > 1) return Promise.resolve(response(reportId, 'completed'))
            firstSignal = signal
            return new Promise((_, reject) => {
                signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            })
        })

        await startGeneratedReport('report-ws')
        await vi.advanceTimersByTimeAsync(2_000)
        expect(calls).toBe(1)

        useReportStore.getState().setWsStatus('connected')
        await flushPromises()
        expect(firstSignal?.aborted).toBe(true)
        expect(useReportStore.getState().pollTimerId).toBeNull()
        expect(toast.error).not.toHaveBeenCalled()

        useReportStore.getState().setWsStatus('disconnected')
        const resumedTimer = useReportStore.getState().pollTimerId
        expect(resumedTimer).not.toBeNull()
        useReportStore.getState().setWsStatus('disconnected')
        expect(useReportStore.getState().pollTimerId).toBe(resumedTimer)

        await vi.advanceTimersByTimeAsync(2_000)
        await flushPromises()
        expect(calls).toBe(2)
        expect(useReportStore.getState().currentReport?.status).toBe('completed')
        expect(toast.error).not.toHaveBeenCalled()
    })

    it('pauses and aborts in hidden documents, then visible events resume only one chain', async () => {
        const signals: AbortSignal[] = []
        let calls = 0
        vi.spyOn(api.report, 'getReport').mockImplementation((_reportId, signal) => {
            calls += 1
            if (signal) signals.push(signal)
            return new Promise((_, reject) => {
                signal?.addEventListener('abort', () => reject(new Error('hidden-abort')), { once: true })
            })
        })

        await startGeneratedReport('report-hidden')
        expect(visibility.listenerCount()).toBe(1)

        visibility.setVisibility('hidden')
        expect(useReportStore.getState().pollTimerId).toBeNull()
        await vi.advanceTimersByTimeAsync(10_000)
        expect(calls).toBe(0)

        visibility.setVisibility('visible')
        const resumedTimer = useReportStore.getState().pollTimerId
        expect(resumedTimer).not.toBeNull()
        visibility.setVisibility('visible')
        expect(useReportStore.getState().pollTimerId).toBe(resumedTimer)
        await vi.advanceTimersByTimeAsync(2_000)
        expect(calls).toBe(1)

        visibility.setVisibility('hidden')
        await flushPromises()
        expect(signals[0]?.aborted).toBe(true)
        expect(toast.error).not.toHaveBeenCalled()
        expect(useReportStore.getState().generating).toBe(true)

        visibility.setVisibility('visible')
        const secondTimer = useReportStore.getState().pollTimerId
        visibility.setVisibility('visible')
        expect(useReportStore.getState().pollTimerId).toBe(secondTimer)
        await vi.advanceTimersByTimeAsync(2_000)
        expect(calls).toBe(2)

        useReportStore.getState().reset()
        useReportStore.getState().reset()
        expect(signals[1]?.aborted).toBe(true)
        expect(visibility.listenerCount()).toBe(0)
        expect(toast.error).not.toHaveBeenCalled()
    })

    it('rejects late poll responses after reset, including StrictMode-style duplicate cleanup', async () => {
        const pending = deferred<ReturnType<typeof response>>()
        let capturedSignal: AbortSignal | undefined
        vi.spyOn(api.report, 'getReport').mockImplementation((_reportId, signal) => {
            capturedSignal = signal
            return pending.promise
        })

        await startGeneratedReport('report-reset-stale')
        await vi.advanceTimersByTimeAsync(2_000)
        useReportStore.getState().reset()
        useReportStore.getState().reset()

        expect(capturedSignal?.aborted).toBe(true)
        expect(visibility.listenerCount()).toBe(0)
        pending.resolve(response('report-reset-stale', 'completed'))
        await flushPromises()

        expect(useReportStore.getState().currentReport).toBeNull()
        expect(useReportStore.getState().generating).toBe(false)
        expect(toast.success).not.toHaveBeenCalled()
        expect(toast.error).not.toHaveBeenCalled()
        expect(useNotificationStore.getState().notifications).toHaveLength(0)
    })

    it('rejects a previous report response after the user switches report identity', async () => {
        const previous = deferred<ReturnType<typeof response>>()
        const selected = deferred<ReturnType<typeof response>>()
        vi.spyOn(api.report, 'getReport').mockImplementation((reportId) => (
            reportId === 'report-previous' ? previous.promise : selected.promise
        ))

        await startGeneratedReport('report-previous')
        await vi.advanceTimersByTimeAsync(2_000)
        const selectedPromise = useReportStore.getState().fetchReport('report-selected')

        previous.resolve(response('report-previous', 'completed'))
        await flushPromises()
        expect(useReportStore.getState().currentReport?.id).toBe('report-previous')
        expect(useReportStore.getState().generating).toBe(false)
        expect(toast.success).not.toHaveBeenCalled()

        selected.resolve(response('report-selected', 'completed'))
        await selectedPromise
        expect(useReportStore.getState().currentReport?.id).toBe('report-selected')
        expect(toast.success).not.toHaveBeenCalled()
        expect(useNotificationStore.getState().notifications).toHaveLength(0)
    })

    it('emits completed side effects exactly once across duplicate terminal responses', async () => {
        const emitSpy = vi.spyOn(businessEvents, 'emit')
        const getReportSpy = vi.spyOn(api.report, 'getReport')
            .mockResolvedValue(response('report-completed-once', 'completed'))

        await startGeneratedReport('report-completed-once')
        await useReportStore.getState().fetchReport('report-completed-once')
        await flushPromises()
        await useReportStore.getState().fetchReport('report-completed-once')
        await flushPromises()

        expect(getReportSpy).toHaveBeenCalledTimes(2)
        expect(toast.success).toHaveBeenCalledTimes(1)
        expect(useNotificationStore.getState().notifications).toHaveLength(1)
        expect(api.report.list).toHaveBeenCalledTimes(1)
        expect(emitSpy).toHaveBeenCalledTimes(1)
        expect(emitSpy).toHaveBeenCalledWith('report:generated', {
            classId: 'class-001',
            reportType: 'class-diagnosis',
        })
    })

    it('emits a failed terminal toast exactly once across duplicate responses', async () => {
        vi.spyOn(api.report, 'getReport')
            .mockResolvedValue(response('report-failed-once', 'failed'))

        await startGeneratedReport('report-failed-once')
        await useReportStore.getState().fetchReport('report-failed-once')
        await useReportStore.getState().fetchReport('report-failed-once')

        expect(toast.error).toHaveBeenCalledTimes(1)
        expect(toast.error).toHaveBeenCalledWith({
            title: '生成失败',
            message: '报告生成失败，请稍后重试或联系管理员',
        })
        expect(toast.success).not.toHaveBeenCalled()
        expect(useNotificationStore.getState().notifications).toHaveLength(0)
        expect(api.report.list).not.toHaveBeenCalled()
    })
})
