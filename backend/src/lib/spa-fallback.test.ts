import { describe, expect, it } from 'vitest'
import { isPublicSharedReportPage, shouldServeSpaFallback } from './spa-fallback.js'

describe('shouldServeSpaFallback', () => {
    it('允许浏览器直接访问前端深层路由', () => {
        expect(shouldServeSpaFallback({
            method: 'GET',
            url: '/culture?tab=background',
            accept: 'text/html,application/xhtml+xml',
        })).toBe(true)
    })

    it.each([
        ['/api/health', 'text/html'],
        ['/api/does-not-exist', 'application/json'],
        ['/uploads/missing.png', 'text/html'],
        ['/assets/missing.js', 'application/javascript'],
    ])('不为资源路径 %s 返回 index.html', (url, accept) => {
        expect(shouldServeSpaFallback({ method: 'GET', url, accept })).toBe(false)
    })

    it('不为写请求返回 index.html', () => {
        expect(shouldServeSpaFallback({
            method: 'POST',
            url: '/dashboard',
            accept: 'text/html',
        })).toBe(false)
    })

    it('只识别明确的公开报告页前缀', () => {
        expect(isPublicSharedReportPage('/shared/report/secret-token')).toBe(true)
        expect(isPublicSharedReportPage('/shared/report/secret-token?source=copy')).toBe(true)
        expect(isPublicSharedReportPage('/report/shared/secret-token')).toBe(false)
        expect(isPublicSharedReportPage('/shared/reports/secret-token')).toBe(false)
        expect(isPublicSharedReportPage('/shared/report')).toBe(false)
    })
})
