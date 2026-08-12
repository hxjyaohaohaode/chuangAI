import { beforeEach, describe, expect, it, vi } from 'vitest'

const sync = vi.hoisted(() => {
    let remoteHandler: ((payload: { type: string; payload: unknown; timestamp: number }) => void) | null = null
    return {
        emit: vi.fn(),
        on: vi.fn((_type: string, handler: typeof remoteHandler) => {
            remoteHandler = handler
            return () => { remoteHandler = null }
        }),
        receive(payload: { type: string; payload: unknown; timestamp: number }) {
            remoteHandler?.(payload)
        },
    }
})

vi.mock('./cross-tab-sync', () => ({ crossTabSync: sync }))

import { businessEvents, installBusinessEventCrossTabBridge } from './business-events'

installBusinessEventCrossTabBridge()

describe('business event cross-tab bridge', () => {
    beforeEach(() => {
        businessEvents.clear()
        sync.emit.mockClear()
        expect(sync.on).toHaveBeenCalledWith('business:event', expect.any(Function))
    })

    it('broadcasts a local event exactly once and dispatches it locally', async () => {
        const handler = vi.fn()
        businessEvents.on('grading:reviewed', handler)

        businessEvents.emit('grading:reviewed', { classId: 'class-a', reviewCount: 1 })

        expect(handler).toHaveBeenCalledOnce()
        await vi.waitFor(() => expect(sync.emit).toHaveBeenCalledOnce())
        expect(sync.emit).toHaveBeenCalledWith('business:event', expect.objectContaining({
            type: 'grading:reviewed',
            payload: { classId: 'class-a', reviewCount: 1 },
        }))
    })

    it('dispatches a remote event without broadcasting it back', () => {
        const handler = vi.fn()
        businessEvents.on('classroom:ended', handler)

        sync.receive({
            type: 'classroom:ended',
            payload: { lessonId: 'lesson-a', classId: 'class-a' },
            timestamp: Date.now(),
        })

        expect(handler).toHaveBeenCalledOnce()
        expect(sync.emit).not.toHaveBeenCalled()
    })

    it('rejects unknown or malformed remote messages', () => {
        const handler = vi.fn()
        businessEvents.on('classroom:ended', handler)

        sync.receive({ type: 'unknown:event', payload: {}, timestamp: Date.now() })
        sync.receive({ type: 'classroom:ended', payload: 'bad', timestamp: Date.now() })
        sync.receive({ type: 'classroom:ended', payload: {}, timestamp: Number.NaN })

        expect(handler).not.toHaveBeenCalled()
        expect(sync.emit).not.toHaveBeenCalled()
    })
})
