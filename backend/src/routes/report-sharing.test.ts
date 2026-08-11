import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    AuthService,
    installAuthBoundary,
    type AuthServiceOptions,
} from '../security/auth.js'
import {
    createShareLink,
    getSharedReport,
    revokeShareLink,
} from '../services/profile/report-exporter.js'
import {
    registerReportSharingRoutes,
    type ShareableReportRecord,
} from './report-sharing.js'

const CORS_ORIGIN = 'http://localhost:5173'
const apps: FastifyInstance[] = []
const sharesToClean = new Map<string, string>()

function authOptions(): AuthServiceOptions {
    return {
        mode: 'demo',
        sessionSecret: 'report-sharing-test-secret-with-at-least-thirty-two-characters',
        sessionTtlSeconds: 480 * 60,
        cookieSecure: 'false',
        teacherId: 'teacher-owner',
        teacherName: '报告所有者',
        passwordScrypt: '',
        corsOrigins: [CORS_ORIGIN],
    }
}

function authenticatedHeaders(service: AuthService, teacherId: string) {
    const issued = service.issue({ id: teacherId, name: teacherId, role: 'teacher' })
    return {
        cookie: `pr_session=${encodeURIComponent(issued.token)}; pr_csrf=${encodeURIComponent(issued.session.csrfToken)}`,
        'x-csrf-token': issued.session.csrfToken,
        origin: CORS_ORIGIN,
    }
}

function trackShare(token: string, teacherId: string): string {
    sharesToClean.set(token, teacherId)
    return token
}

async function buildApp(
    reports = new Map<string, ShareableReportRecord>(),
    overrides: Partial<{
        renderMarkdown: (report: ShareableReportRecord) => string
        getSensitiveTerms: (report: ShareableReportRecord) => readonly string[]
    }> = {},
) {
    const app = Fastify({ logger: false })
    apps.push(app)
    const service = new AuthService(authOptions())
    installAuthBoundary(app, service)
    await app.register(async (reportApp) => {
        registerReportSharingRoutes(reportApp, {
            getReport: (reportId) => reports.get(reportId),
            renderMarkdown: overrides.renderMarkdown
                ?? ((report) => `# ${report.output?.title ?? '教研报告'}\n\n公开快照正文`),
            getSensitiveTerms: overrides.getSensitiveTerms ?? (() => []),
        })
    }, { prefix: '/api/report' })
    await app.ready()
    return { app, service }
}

async function previewFingerprint(
    app: FastifyInstance,
    headers: ReturnType<typeof authenticatedHeaders>,
    reportId: string,
): Promise<string> {
    const response = await app.inject({
        method: 'POST',
        url: '/api/report/share/preview',
        headers,
        payload: { reportId },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { previewFingerprint: string }
    expect(body.previewFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    return body.previewFingerprint
}

beforeEach(() => {
    sharesToClean.clear()
})

afterEach(async () => {
    for (const [token, teacherId] of sharesToClean) {
        revokeShareLink(token, teacherId)
    }
    sharesToClean.clear()
    await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('report public sharing boundary', () => {
    it('allows anonymous access to a valid token and exposes only the public snapshot', async () => {
        const now = Date.now()
        const token = trackShare(createShareLink({
            reportId: 'report-internal-id',
            teacherId: 'teacher-internal-id',
        }, {
            className: '三年二班',
            output: { title: '阶段教研报告（AI 生成）' },
            markdownContent: '# 阶段教研报告\n\n公开快照正文',
        }, now).token, 'teacher-internal-id')
        const { app } = await buildApp()

        const response = await app.inject({
            method: 'GET',
            url: `/api/report/shared/${encodeURIComponent(token)}`,
        })

        expect(response.statusCode).toBe(200)
        expect(response.headers['cache-control']).toContain('no-store')
        expect(response.headers.pragma).toBe('no-cache')
        expect(response.headers['referrer-policy']).toBe('no-referrer')
        expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive')
        const body = response.json() as { shared: Record<string, unknown>; aiGenerated: boolean }
        expect(body.aiGenerated).toBe(true)
        expect(body.shared).toEqual({
            className: '三年二班',
            title: '阶段教研报告（AI 生成）',
            contentHtml: '<h1>阶段教研报告</h1>\n<p>公开快照正文</p>',
            createdAt: now,
            expireAt: now + 7 * 24 * 60 * 60 * 1000,
        })
        expect(body.shared).not.toHaveProperty('token')
        expect(body.shared).not.toHaveProperty('teacherId')
        expect(body.shared).not.toHaveProperty('reportId')
        expect(body.shared).not.toHaveProperty('viewCount')
        expect(body.shared).not.toHaveProperty('lastViewedAt')
    })

    it('keeps every adjacent management path authenticated and mutating paths CSRF-protected', async () => {
        const { app, service } = await buildApp()
        const token = 'a'.repeat(43)

        for (const request of [
            { method: 'GET' as const, url: '/api/report/shared' },
            { method: 'POST' as const, url: '/api/report/share/preview', payload: {} },
            { method: 'POST' as const, url: '/api/report/share', payload: {} },
            { method: 'DELETE' as const, url: `/api/report/shared/${token}` },
        ]) {
            const response = await app.inject(request)
            expect(response.statusCode, `${request.method} ${request.url}`).toBe(401)
            expect(response.json()).toMatchObject({ error: 'AUTHENTICATION_REQUIRED' })
        }

        const ownerHeaders = authenticatedHeaders(service, 'teacher-owner')
        const noCsrf = await app.inject({
            method: 'DELETE',
            url: `/api/report/shared/${token}`,
            headers: { cookie: ownerHeaders.cookie, origin: ownerHeaders.origin },
        })
        expect(noCsrf.statusCode).toBe(403)
        expect(noCsrf.json()).toMatchObject({ error: 'CSRF_REJECTED' })
    })

    it('makes missing, malformed, expired and revoked tokens indistinguishable', async () => {
        const expired = createShareLink({
            reportId: 'report-expired',
            teacherId: 'teacher-owner',
            expireDays: 1,
        }, {
            className: '三年二班',
            markdownContent: '已过期',
        }, Date.now() - 2 * 24 * 60 * 60 * 1000)
        trackShare(expired.token, 'teacher-owner')

        const revoked = createShareLink({
            reportId: 'report-revoked',
            teacherId: 'teacher-owner',
        }, {
            className: '三年二班',
            markdownContent: '已撤销',
        })
        expect(revokeShareLink(revoked.token, 'teacher-owner')).toBe(true)

        const { app } = await buildApp()
        const urls = [
            `/api/report/shared/${'z'.repeat(43)}`,
            '/api/report/shared/too-short',
            `/api/report/shared/${expired.token}`,
            `/api/report/shared/${revoked.token}`,
        ]
        const responses = await Promise.all(urls.map((url) => app.inject({ method: 'GET', url })))

        for (const response of responses) {
            expect(response.statusCode).toBe(404)
            expect(response.headers['cache-control']).toContain('no-store')
            expect(response.json()).toEqual({
                statusCode: 404,
                error: 'Not Found',
                message: '分享链接不存在、已过期或已撤销',
            })
        }
    })

    it('binds create, list and revoke to the authenticated teacher and report owner', async () => {
        const reports = new Map<string, ShareableReportRecord>([
            ['report-owner-001', {
                id: 'report-owner-001',
                teacherId: 'teacher-owner',
                classId: 'class-owner-001',
                className: '三年二班',
                status: 'completed',
                output: { title: '所有者报告（AI 生成）' },
            }],
        ])
        const { app, service } = await buildApp(reports)
        const ownerHeaders = authenticatedHeaders(service, 'teacher-owner')
        const otherHeaders = authenticatedHeaders(service, 'teacher-other')

        const crossBodyScope = await app.inject({
            method: 'POST',
            url: '/api/report/share',
            headers: otherHeaders,
            payload: { reportId: 'report-owner-001', teacherId: 'teacher-owner' },
        })
        expect(crossBodyScope.statusCode).toBe(403)
        expect(crossBodyScope.json()).toMatchObject({ error: 'TEACHER_SCOPE_MISMATCH' })

        const crossReportOwner = await app.inject({
            method: 'POST',
            url: '/api/report/share',
            headers: otherHeaders,
            payload: { reportId: 'report-owner-001', teacherId: 'teacher-other' },
        })
        expect(crossReportOwner.statusCode).toBe(404)

        const fingerprint = await previewFingerprint(app, ownerHeaders, 'report-owner-001')
        const created = await app.inject({
            method: 'POST',
            url: '/api/report/share',
            headers: ownerHeaders,
            payload: {
                reportId: 'report-owner-001',
                previewFingerprint: fingerprint,
            },
        })
        expect(created.statusCode).toBe(200)
        const createdShare = (created.json() as {
            shared: { token: string; shareId: string }
        }).shared
        const createdToken = createdShare.token
        const createdShareId = trackShare(createdShare.shareId, 'teacher-owner')

        const ownerList = await app.inject({
            method: 'GET',
            url: '/api/report/shared',
            headers: { cookie: ownerHeaders.cookie },
        })
        expect(ownerList.statusCode).toBe(200)
        const ownerListBody = ownerList.json() as { shares: Array<Record<string, unknown>> }
        expect(ownerListBody.shares).toContainEqual(expect.objectContaining({ shareId: createdShareId }))
        expect(JSON.stringify(ownerListBody)).not.toContain(createdToken)
        expect(ownerListBody.shares[0]).not.toHaveProperty('token')
        expect(ownerListBody.shares[0]).not.toHaveProperty('teacherId')
        expect(ownerListBody.shares[0]).not.toHaveProperty('contentHtml')

        const crossList = await app.inject({
            method: 'GET',
            url: '/api/report/shared?teacherId=teacher-owner',
            headers: { cookie: otherHeaders.cookie },
        })
        expect(crossList.statusCode).toBe(403)
        expect(crossList.json()).toMatchObject({ error: 'TEACHER_SCOPE_MISMATCH' })

        const otherOwnList = await app.inject({
            method: 'GET',
            url: '/api/report/shared',
            headers: { cookie: otherHeaders.cookie },
        })
        expect(otherOwnList.statusCode).toBe(200)
        expect(otherOwnList.json()).toMatchObject({ shares: [], total: 0 })

        const crossRevoke = await app.inject({
            method: 'DELETE',
            url: `/api/report/shared/${createdShareId}`,
            headers: otherHeaders,
        })
        expect(crossRevoke.statusCode).toBe(404)
        expect(getSharedReport(createdToken)).not.toBeNull()

        const ownerRevoke = await app.inject({
            method: 'DELETE',
            url: `/api/report/shared/${createdShareId}`,
            headers: ownerHeaders,
        })
        expect(ownerRevoke.statusCode).toBe(200)
        expect(ownerRevoke.json()).toEqual({ status: 'ok', revoked: true })
        expect(getSharedReport(createdToken)).toBeNull()
    })

    it('removes the full individualized line using authoritative roster terms and generic PII rules', async () => {
        const reports = new Map<string, ShareableReportRecord>([
            ['report-redaction-001', {
                id: 'report-redaction-001',
                teacherId: 'teacher-owner',
                classId: 'class-owner-001',
                className: '三年二班',
                status: 'completed',
                output: { title: '班级聚合报告（AI 生成）' },
            }],
        ])
        const { app, service } = await buildApp(reports, {
            getSensitiveTerms: () => ['张小明', 'stu-private-001', 'S01', '李家长'],
            renderMarkdown: () => [
                '# 班级聚合报告',
                '',
                '全班平均掌握度提升 8%。',
                '张小明（stu-private-001 / S01）存在个体认知诊断：分析层薄弱。',
                '监护人姓名：李家长，电话 13800138000，邮箱 parent@example.com。',
            ].join('\n'),
        })
        const headers = authenticatedHeaders(service, 'teacher-owner')
        const fingerprint = await previewFingerprint(app, headers, 'report-redaction-001')

        const created = await app.inject({
            method: 'POST',
            url: '/api/report/share',
            headers,
            payload: {
                reportId: 'report-redaction-001',
                teacherId: 'teacher-owner',
                previewFingerprint: fingerprint,
            },
        })
        expect(created.statusCode).toBe(200)
        const token = trackShare(
            (created.json() as { shared: { token: string } }).shared.token,
            'teacher-owner',
        )

        const publicRead = await app.inject({
            method: 'GET',
            url: `/api/report/shared/${token}`,
        })
        const publicPayload = JSON.stringify(publicRead.json())
        expect(publicRead.statusCode).toBe(200)
        expect(publicPayload).toContain('全班平均掌握度提升 8%')
        expect(publicPayload).toContain('个体信息已在公开分享中隐藏')
        expect(publicPayload).not.toContain('张小明')
        expect(publicPayload).not.toContain('stu-private-001')
        expect(publicPayload).not.toContain('S01')
        expect(publicPayload).not.toContain('李家长')
        expect(publicPayload).not.toContain('13800138000')
        expect(publicPayload).not.toContain('parent@example.com')
        expect(publicPayload).not.toContain('分析层薄弱')
    })

    it('fails closed when the authoritative redaction vocabulary cannot be loaded', async () => {
        const reports = new Map<string, ShareableReportRecord>([
            ['report-redaction-failure', {
                id: 'report-redaction-failure',
                teacherId: 'teacher-owner',
                classId: 'class-owner-001',
                className: '三年二班',
                status: 'completed',
                output: { title: '班级聚合报告（AI 生成）' },
            }],
        ])
        const { app, service } = await buildApp(reports, {
            getSensitiveTerms: () => {
                throw new Error('roster unavailable')
            },
        })

        const response = await app.inject({
            method: 'POST',
            url: '/api/report/share',
            headers: authenticatedHeaders(service, 'teacher-owner'),
            payload: { reportId: 'report-redaction-failure', teacherId: 'teacher-owner' },
        })

        expect(response.statusCode).toBe(503)
        expect(response.json()).toEqual({
            statusCode: 503,
            error: 'PUBLIC_SHARE_REDACTION_UNAVAILABLE',
            message: '公开分享隐私保护暂不可用，请稍后重试',
        })
    })

    it('previews without persistence and rejects missing or stale human-confirmation fingerprints', async () => {
        const reports = new Map<string, ShareableReportRecord>([
            ['report-preview-001', {
                id: 'report-preview-001',
                teacherId: 'teacher-owner',
                classId: 'class-owner-001',
                className: '三年二班',
                status: 'completed',
                output: { title: '阶段教研报告（AI 生成）' },
            }],
        ])
        let markdown = '# 阶段教研报告\n\n全班聚合结论。'
        const { app, service } = await buildApp(reports, {
            renderMarkdown: () => markdown,
            getSensitiveTerms: () => [],
        })
        const headers = authenticatedHeaders(service, 'teacher-owner')

        const missingPreview = await app.inject({
            method: 'POST',
            url: '/api/report/share',
            headers,
            payload: { reportId: 'report-preview-001' },
        })
        expect(missingPreview.statusCode).toBe(428)
        expect(missingPreview.json()).toMatchObject({ error: 'PUBLIC_SHARE_PREVIEW_REQUIRED' })

        const preview = await app.inject({
            method: 'POST',
            url: '/api/report/share/preview',
            headers,
            payload: { reportId: 'report-preview-001' },
        })
        expect(preview.statusCode).toBe(200)
        const previewBody = preview.json() as {
            preview: Record<string, unknown>
            previewFingerprint: string
        }
        expect(previewBody.preview).toEqual({
            className: '三年二班',
            title: '阶段教研报告（AI 生成）',
            contentHtml: '<h1>阶段教研报告</h1>\n<p>全班聚合结论。</p>',
        })
        expect(previewBody.preview).not.toHaveProperty('reportId')
        expect(previewBody.preview).not.toHaveProperty('teacherId')

        const afterPreviewList = await app.inject({
            method: 'GET',
            url: '/api/report/shared',
            headers: { cookie: headers.cookie },
        })
        expect(afterPreviewList.json()).toMatchObject({ shares: [], total: 0 })

        markdown = '# 阶段教研报告\n\n报告在确认前已变更。'
        const stale = await app.inject({
            method: 'POST',
            url: '/api/report/share',
            headers,
            payload: {
                reportId: 'report-preview-001',
                previewFingerprint: previewBody.previewFingerprint,
            },
        })
        expect(stale.statusCode).toBe(409)
        expect(stale.json()).toMatchObject({ error: 'PUBLIC_SHARE_PREVIEW_STALE' })

        const afterStaleList = await app.inject({
            method: 'GET',
            url: '/api/report/shared',
            headers: { cookie: headers.cookie },
        })
        expect(afterStaleList.json()).toMatchObject({ shares: [], total: 0 })
    })
})
