import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useDiagnosisStore } from './diagnosis'
import type { BloomDistributionResponse } from '@/lib/types'

function bloomResponse(classId: string, avg: number): BloomDistributionResponse {
    return {
        classId,
        levels: [
            { level: '记忆', avg, stdDev: 0, studentCount: 1 },
            { level: '理解', avg, stdDev: 0, studentCount: 1 },
            { level: '应用', avg, stdDev: 0, studentCount: 1 },
            { level: '分析', avg, stdDev: 0, studentCount: 1 },
            { level: '评价', avg, stdDev: 0, studentCount: 1 },
            { level: '创造', avg, stdDev: 0, studentCount: 1 },
        ],
        aiGenerated: false,
    }
}

function never<T>(): Promise<T> {
    return new Promise<T>(() => undefined)
}

afterEach(() => {
    vi.restoreAllMocks()
    useDiagnosisStore.getState().reset()
})

describe('diagnosis entity context boundary', () => {
    it('rejects a stale class response after the selected class changed', async () => {
        let resolveRequest!: (value: BloomDistributionResponse) => void
        const request = new Promise<BloomDistributionResponse>((resolve) => {
            resolveRequest = resolve
        })
        vi.spyOn(api.diagnosis, 'bloomDistribution').mockReturnValue(request)

        const current = bloomResponse('class-b', 82)
        useDiagnosisStore.setState({
            selectedClassId: 'class-a',
            bloomDistribution: current,
        })

        const pending = useDiagnosisStore.getState().fetchBloomDistribution('class-a')
        useDiagnosisStore.setState({ selectedClassId: 'class-b' })
        resolveRequest(bloomResponse('class-a', 12))
        await pending

        expect(useDiagnosisStore.getState().bloomDistribution).toEqual(current)
    })

    it('clears prior class and student presentation state before loading a new class', () => {
        vi.spyOn(api.diagnosis, 'bloomDistribution').mockReturnValue(never())
        vi.spyOn(api.diagnosis, 'heatmap').mockReturnValue(never())
        vi.spyOn(api.diagnosis, 'darkMatter').mockReturnValue(never())
        vi.spyOn(api.diagnosis, 'darkMatterReport').mockReturnValue(never())

        useDiagnosisStore.setState({
            selectedClassId: 'class-a',
            selectedStudentId: 'student-a',
            bloomDistribution: bloomResponse('class-a', 91),
            streamingPathText: '旧班级学习路径',
            streamingPrescriptionText: '旧学生处方',
            suggestionMessages: [
                { role: 'user', content: '旧学生问题' },
                { role: 'assistant', content: '旧学生建议' },
            ],
            error: '旧错误',
        })

        useDiagnosisStore.getState().selectClass('class-b')
        const state = useDiagnosisStore.getState()

        expect(state.selectedClassId).toBe('class-b')
        expect(state.selectedStudentId).toBeNull()
        expect(state.bloomDistribution.classId).toBe('')
        expect(state.streamingPathText).toBe('')
        expect(state.streamingPrescriptionText).toBe('')
        expect(state.suggestionMessages).toEqual([])
        expect(state.error).toBeNull()
    })
})
