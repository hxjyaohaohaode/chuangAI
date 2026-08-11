import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { DashboardStats } from '@/lib/types'
import { useDashboardStore } from './dashboard'

function stats(classId: string, className: string, studentCount: number): DashboardStats {
    return {
        classId,
        className,
        studentCount,
        weekLearnedPoems: 0,
        classMasteryAvg: 0,
        masteryRecordCount: 0,
        pendingAlerts: 0,
        weekProgress: { learned: 0, total: 0 },
    }
}

afterEach(() => {
    vi.restoreAllMocks()
    useDashboardStore.getState().reset()
})

describe('dashboard class context boundary', () => {
    it('rejects a stale stats refresh after the selected class changed', async () => {
        let resolveRequest!: (value: DashboardStats) => void
        const request = new Promise<DashboardStats>((resolve) => {
            resolveRequest = resolve
        })
        vi.spyOn(api.dashboard, 'stats').mockReturnValue(request)

        const classB = stats('class-b', '乙班', 31)
        useDashboardStore.setState({
            classId: 'class-a',
            className: '甲班',
            stats: classB,
        })

        const pending = useDashboardStore.getState().refreshStats()
        useDashboardStore.setState({ classId: 'class-b', className: '乙班' })
        resolveRequest(stats('class-a', '甲班', 28))
        await pending

        expect(useDashboardStore.getState().stats).toEqual(classB)
        expect(useDashboardStore.getState().className).toBe('乙班')
    })

    it('clears the previous class presentation synchronously on switch', () => {
        vi.spyOn(useDashboardStore.getState(), 'fetchAll').mockResolvedValue()
        useDashboardStore.setState({
            classId: 'class-a',
            className: '甲班',
            stats: stats('class-a', '甲班', 28),
            alerts: [{
                id: 'alert-a',
                type: 'mastery-warning',
                severity: 'medium',
                title: '旧班预警',
                description: '旧班数据',
                suggestedAction: '查看旧班数据',
                createdAt: Date.now(),
            }],
            weeklyProgress: [{
                date: '2026-08-11',
                lessons: [],
            }],
            lastSyncedAt: Date.now(),
            error: '旧错误',
        })

        useDashboardStore.getState().setClassId('class-b')
        const state = useDashboardStore.getState()

        expect(state.classId).toBe('class-b')
        expect(state.className).toBe('')
        expect(state.stats.classId).toBe('')
        expect(state.alerts).toEqual([])
        expect(state.weeklyProgress).toEqual([])
        expect(state.lastSyncedAt).toBeNull()
        expect(state.error).toBeNull()
        expect(state.loading).toBe(true)
    })
})
