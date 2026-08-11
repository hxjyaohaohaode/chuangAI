import { describe, expect, it } from 'vitest'
import {
    buildPublicShareUrl,
    buildSandboxedReportDocument,
    isSecurePublicShareOrigin,
    isValidShareToken,
    parseGetSharedReportResponse,
    parseListSharedReportsResponse,
    parsePreviewShareResponse,
    sanitizePublicReportHtml,
} from './report-share-contract'

const preview = {
    className: '三年二班',
    title: '阶段教研报告（AI 生成）',
    contentHtml: '<h1>阶段报告</h1>\n<blockquote>已脱敏</blockquote>\n<ul><li>聚合结论</li></ul><hr/>',
}

describe('report share privacy contract', () => {
    it('accepts only bounded path tokens and builds a path-only URL', () => {
        const token = 'a'.repeat(43)
        expect(isValidShareToken(token)).toBe(true)
        expect(isValidShareToken('too-short')).toBe(false)
        expect(buildPublicShareUrl(token, 'https://poetry.example')).toBe(
            `https://poetry.example/shared/report/${token}`,
        )
        expect(buildPublicShareUrl(token, 'https://poetry.example')).not.toContain('?')
    })

    it('permits only inert attribute-free report markup', () => {
        expect(sanitizePublicReportHtml(preview.contentHtml)).toContain('<hr>')
        for (const unsafe of [
            '<script>alert(1)</script>',
            '<img src="https://tracker.example/pixel">',
            '<p onclick="alert(1)">正文</p>',
            '<a href="https://example.com">链接</a>',
            '<h1>未闭合',
            '文本 < 未转义',
        ]) {
            expect(() => sanitizePublicReportHtml(unsafe), unsafe).toThrow()
        }
    })

    it('creates a sandbox document with deny-by-default CSP and no remote capability', () => {
        const document = buildSandboxedReportDocument(preview)
        expect(document).toContain("default-src 'none'")
        expect(document).toContain("connect-src 'none'")
        expect(document).toContain('name="referrer" content="no-referrer"')
        expect(document).toContain('<main><h1>阶段报告</h1>')
        expect(document).not.toContain('<script')
    })

    it('validates public and preview response fields at runtime', () => {
        expect(parsePreviewShareResponse({
            status: 'ok',
            preview,
            previewFingerprint: 'f'.repeat(64),
            aiGenerated: true,
        })).toMatchObject({ previewFingerprint: 'f'.repeat(64) })

        expect(parseGetSharedReportResponse({
            status: 'ok',
            shared: { ...preview, createdAt: 1_700_000_000_000, expireAt: 1_700_604_800_000 },
            aiGenerated: true,
        }).shared.title).toBe(preview.title)

        expect(() => parseGetSharedReportResponse({
            status: 'ok',
            shared: { ...preview, contentHtml: '<img src=x>', createdAt: 2, expireAt: 3 },
            aiGenerated: true,
        })).toThrow()
        expect(() => parseGetSharedReportResponse({
            status: 'ok',
            shared: { ...preview, createdAt: 3, expireAt: 2 },
            aiGenerated: true,
        })).toThrow()
        expect(() => parseGetSharedReportResponse({
            status: 'ok',
            shared: { ...preview, createdAt: 1_700_000_000_000, expireAt: Number.MAX_SAFE_INTEGER },
            aiGenerated: true,
        })).toThrow()
        expect(() => parseGetSharedReportResponse({
            status: 'ok',
            shared: {
                ...preview,
                createdAt: 1_700_000_000_000,
                expireAt: 1_700_000_000_000 + 91 * 24 * 60 * 60 * 1000,
            },
            aiGenerated: true,
        })).toThrow()
    })

    it('rejects bearer tokens and HTML leaking into the owner summary list', () => {
        const valid = {
            shareId: `shr_${'a'.repeat(32)}`,
            reportId: 'report-001',
            className: '三年二班',
            title: '教研报告',
            createdAt: 1_700_000_000_000,
            expireAt: 1_700_604_800_000,
            viewCount: 0,
            lastViewedAt: null,
        }
        expect(parseListSharedReportsResponse({ status: 'ok', shares: [valid], total: 1 }).shares).toHaveLength(1)
        expect(() => parseListSharedReportsResponse({
            status: 'ok',
            shares: [{ ...valid, shareId: 'bad-share-id' }],
            total: 1,
        })).toThrow()
        expect(() => parseListSharedReportsResponse({
            status: 'ok',
            shares: [{ ...valid, token: 'x'.repeat(43) }],
            total: 1,
        })).toThrow()
        expect(() => parseListSharedReportsResponse({ status: 'ok', shares: [valid], total: 2 })).toThrow()
        expect(() => parseListSharedReportsResponse({ shares: [valid], total: 1 })).toThrow()
    })

    it('allows HTTP only for explicit local demonstration origins', () => {
        expect(isSecurePublicShareOrigin('https://poetry.example')).toBe(true)
        expect(isSecurePublicShareOrigin('http://localhost:5173')).toBe(true)
        expect(isSecurePublicShareOrigin('http://127.0.0.1:5173')).toBe(true)
        expect(isSecurePublicShareOrigin('http://poetry.example')).toBe(false)
    })
})
