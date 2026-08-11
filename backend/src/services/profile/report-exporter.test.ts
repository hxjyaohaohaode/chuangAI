import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { db } from '../../db/index.js'
import {
    createShareLink,
    exportReport,
    filterExportSections,
    getSharedReport,
    listSharedReports,
    neutralizeSpreadsheetFormula,
    redactPublicReportContent,
    revokeShareLink,
} from './report-exporter.js'

const sampleReport = {
    reportId: 'report-audit',
    className: '=HYPERLINK("https://invalid.example")',
    period: { from: 1_700_000_000_000, to: 1_700_086_400_000 },
    output: {
        title: '审计报告',
        sections: [
            { heading: '教学背景', content: '背景正文' },
            { heading: '干预策略', content: '策略正文' },
        ],
        keyFindings: ['+恶意公式'],
        recommendations: ['正常建议'],
    },
}

describe('report exporter contracts', () => {
    it('maps stable section keys to Chinese headings', () => {
        expect(filterExportSections(sampleReport.output.sections, ['background']))
            .toEqual([{ heading: '教学背景', content: '背景正文' }])
        expect(filterExportSections(sampleReport.output.sections, ['干预策略']))
            .toEqual([{ heading: '干预策略', content: '策略正文' }])
    })

    it('returns honest printable HTML for the PDF workflow', async () => {
        const result = await exportReport(
            { reportId: sampleReport.reportId, format: 'pdf', includeSections: ['background'] },
            sampleReport,
        )

        expect(result.success).toBe(true)
        expect(result.mimeType).toBe('text/html')
        expect(result.content).toContain('背景正文')
        expect(result.content).not.toContain('策略正文')
        expect(result.content).toContain('@media print')
    })

    it('neutralizes spreadsheet formulas and labels the payload as CSV', async () => {
        expect(neutralizeSpreadsheetFormula(' =SUM(A1:A2)')).toBe("' =SUM(A1:A2)")
        expect(neutralizeSpreadsheetFormula('ordinary')).toBe('ordinary')

        const result = await exportReport(
            { reportId: sampleReport.reportId, format: 'excel' },
            sampleReport,
        )
        expect(result.mimeType).toBe('text/csv')
        expect(result.content?.startsWith('\uFEFF')).toBe(true)
        expect(result.content).toContain(`"'=HYPERLINK(""https://invalid.example"")"`)
        expect(result.content).toContain(`"'+恶意公式"`)
    })

    it('creates a 256-bit base64url token and returns only the public report snapshot', () => {
        const now = Date.parse('2026-08-10T00:00:00Z')
        const created = createShareLink({
            reportId: 'report-private-id',
            teacherId: 'teacher-private-id',
            expireDays: 7,
        }, {
            className: '三年二班',
            output: { title: '阶段教研报告（AI 生成）' },
            markdownContent: '# 阶段教研报告\n\n已脱敏内容',
        }, now)

        try {
            expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
            expect(Buffer.from(created.token, 'base64url')).toHaveLength(32)

            const expectedLookupKey = createHash('sha256')
                .update(created.token, 'utf8')
                .digest('hex')
            const persisted = db.prepare(
                'SELECT key, value FROM shared_reports WHERE key = ?',
            ).get(expectedLookupKey) as { key: string; value: string } | undefined
            expect(persisted?.key).toBe(expectedLookupKey)
            expect(persisted?.key).not.toBe(created.token)
            expect(persisted?.value).not.toContain(created.token)
            expect(JSON.parse(persisted?.value ?? '{}')).not.toHaveProperty('token')

            const publicSnapshot = getSharedReport(created.token, now + 1)
            expect(publicSnapshot).toEqual({
                className: '三年二班',
                title: '阶段教研报告（AI 生成）',
                contentHtml: '<h1>阶段教研报告</h1>\n<p>已脱敏内容</p>',
                createdAt: now,
                expireAt: now + 7 * 24 * 60 * 60 * 1000,
            })
            expect(publicSnapshot).not.toHaveProperty('token')
            expect(publicSnapshot).not.toHaveProperty('teacherId')
            expect(publicSnapshot).not.toHaveProperty('reportId')
            expect(publicSnapshot).not.toHaveProperty('viewCount')
            expect(publicSnapshot).not.toHaveProperty('lastViewedAt')

            const ownerView = listSharedReports('teacher-private-id', now + 1)
                .find((share) => share.shareId === created.shareId)
            expect(ownerView).toMatchObject({ viewCount: 1, lastViewedAt: now + 1 })
            expect(ownerView).not.toHaveProperty('token')
            expect(ownerView).not.toHaveProperty('teacherId')
            expect(ownerView).not.toHaveProperty('contentHtml')
        } finally {
            revokeShareLink(created.shareId, 'teacher-private-id')
        }
    })

    it('fails closed at expiration and removes expired shares from owner listings', () => {
        const now = Date.parse('2026-08-10T00:00:00Z')
        const created = createShareLink({
            reportId: 'report-expiring',
            teacherId: 'teacher-expiring',
            expireDays: 1,
        }, {
            className: '三年二班',
            markdownContent: '到期测试',
        }, now)

        expect(getSharedReport(created.token, created.expireAt)).toBeNull()
        expect(listSharedReports('teacher-expiring', created.expireAt))
            .not.toContainEqual(expect.objectContaining({ shareId: created.shareId }))
        expect(revokeShareLink(created.shareId, 'teacher-expiring')).toBe(false)
    })

    it('migrates a legacy raw-token row on read without breaking the existing public URL', () => {
        const token = '123e4567-e89b-42d3-a456-426614174000'
        const now = Date.parse('2026-08-10T00:00:00Z')
        const lookupKey = createHash('sha256').update(token, 'utf8').digest('hex')
        const legacy = {
            token,
            reportId: 'legacy-report',
            className: '三年二班',
            title: '旧分享链接',
            contentHtml: '<p>旧链接仍可访问</p>',
            createdAt: now,
            expireAt: now + 24 * 60 * 60 * 1000,
            viewCount: 0,
            lastViewedAt: null,
            teacherId: 'teacher-legacy',
        }
        db.prepare(
            `INSERT OR REPLACE INTO shared_reports
                (key, value, created_at, updated_at, report_id, teacher_id, expire_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            token,
            JSON.stringify(legacy),
            now,
            now,
            legacy.reportId,
            legacy.teacherId,
            String(legacy.expireAt),
        )

        try {
            expect(getSharedReport(token, now + 1)).toMatchObject({ title: '旧分享链接' })
            expect(db.prepare('SELECT 1 FROM shared_reports WHERE key = ?').get(token)).toBeUndefined()
            const migrated = db.prepare(
                'SELECT value FROM shared_reports WHERE key = ?',
            ).get(lookupKey) as { value: string } | undefined
            expect(JSON.parse(migrated?.value ?? '{}').shareId)
                .toMatch(/^shr_[a-f0-9]{32}$/u)
            expect(migrated?.value).not.toContain(token)
            expect(JSON.parse(migrated?.value ?? '{}')).not.toHaveProperty('token')
        } finally {
            revokeShareLink(token, 'teacher-legacy')
            db.prepare('DELETE FROM shared_reports WHERE key = ?').run(token)
        }
    })

    it('allows only the creating teacher to revoke a share', () => {
        const now = Date.parse('2026-08-10T00:00:00Z')
        const created = createShareLink({
            reportId: 'report-owner-boundary',
            teacherId: 'teacher-owner',
        }, {
            className: '三年二班',
            markdownContent: '所有权测试',
        }, now)

        expect(revokeShareLink(created.shareId, 'teacher-other')).toBe(false)
        expect(getSharedReport(created.token, now + 1)).not.toBeNull()
        expect(revokeShareLink(created.shareId, 'teacher-owner')).toBe(true)
        expect(getSharedReport(created.token, now + 2)).toBeNull()
    })

    it('drops individualized diagnosis lines and redacts common identifiers deterministically', () => {
        const redacted = redactPublicReportContent([
            '# 班级聚合结论',
            '全班平均正确率为 82%。',
            '张小明（S01 / student-private-001）分析层薄弱，需要个别干预。',
            '监护人姓名：李家长，手机 138-0013-8000，邮箱 parent@example.com。',
            '证件号 11010519491231002X。',
        ].join('\n'), ['张小明', 'student-private-001', '李家长'])

        expect(redacted).toContain('全班平均正确率为 82%')
        expect(redacted).toContain('个体信息已在公开分享中隐藏')
        expect(redacted).not.toContain('张小明')
        expect(redacted).not.toContain('S01')
        expect(redacted).not.toContain('student-private-001')
        expect(redacted).not.toContain('分析层薄弱')
        expect(redacted).not.toContain('李家长')
        expect(redacted).not.toContain('138-0013-8000')
        expect(redacted).not.toContain('parent@example.com')
        expect(redacted).not.toContain('11010519491231002X')
    })
})
