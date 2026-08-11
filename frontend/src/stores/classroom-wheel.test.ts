import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useClassroomStore } from './classroom'
import { toast } from './toast'

describe('classroom poem wheel timer lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.stubGlobal('window', {
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
        })
        useClassroomStore.getState().resetWheel()
    })

    afterEach(() => {
        useClassroomStore.getState().resetWheel()
        vi.clearAllTimers()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
        vi.useRealTimers()
    })

    it('keeps reset state and emits no toast when reset happens before completion', () => {
        const successSpy = vi.spyOn(toast, 'success').mockReturnValue('toast-wheel')
        vi.spyOn(Math, 'random').mockReturnValue(0.25)

        useClassroomStore.getState().spinWheel()
        vi.advanceTimersByTime(1_999)
        useClassroomStore.getState().resetWheel()
        // StrictMode cleanup may invoke reset twice; cleanup must remain idempotent.
        useClassroomStore.getState().resetWheel()
        vi.advanceTimersByTime(10_000)

        const state = useClassroomStore.getState()
        expect(state.wheelAngle).toBe(0)
        expect(state.wheelSpinning).toBe(false)
        expect(state.wheelSelectedIndex).toBeNull()
        expect(successSpy).not.toHaveBeenCalled()
    })

    it('lets only the latest direct spin invocation complete', () => {
        const successSpy = vi.spyOn(toast, 'success').mockReturnValue('toast-wheel')
        vi.spyOn(Math, 'random')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0.5)

        useClassroomStore.getState().spinWheel()
        vi.advanceTimersByTime(1_000)
        useClassroomStore.getState().spinWheel()
        vi.advanceTimersByTime(1_000)
        expect(successSpy).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1_000)
        const state = useClassroomStore.getState()
        expect(state.wheelSpinning).toBe(false)
        expect(state.wheelSelectedIndex).toBe(4)
        expect(successSpy).toHaveBeenCalledTimes(1)
        expect(successSpy).toHaveBeenCalledWith({
            title: '大转盘停止',
            message: '命中第 5 题',
        })
    })
})
