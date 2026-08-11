import { describe, expect, it } from 'vitest'
import {
    toDashboardAlertResponse,
    type AlertSeverity,
    type DashboardAlert,
} from './dashboard.js'

function makeAlert(severity: AlertSeverity): DashboardAlert {
    return {
        id: `alert-${severity}`,
        type: 'mastery-warning',
        severity,
        title: '测试告警',
        description: '这是可操作的告警详情',
        suggestedAction: '进入诊断页复核',
        createdAt: 1_785_220_000_000,
    }
}

describe('dashboard alert response contract', () => {
    it.each([
        ['low', 'info'],
        ['medium', 'warning'],
        ['high', 'error'],
    ] as const)('maps severity %s to frontend level %s', (severity, expectedLevel) => {
        const result = toDashboardAlertResponse(makeAlert(severity))

        expect(result.level).toBe(expectedLevel)
        expect(result.detail).toBe('这是可操作的告警详情')
        expect(result.timestamp).toBe(1_785_220_000_000)
        expect(result.actionUrl).toBe('/dashboard?tab=diagnosis')
        expect(result.actionLabel).toBe('查看诊断')
        // 旧契约仍保留，避免现有 Zustand store 回归。
        expect(result.severity).toBe(severity)
        expect(result.description).toBe('这是可操作的告警详情')
        expect(result.createdAt).toBe(1_785_220_000_000)
    })
})
