import { describe, expect, it } from 'vitest'

import {
    computePoemContentSha256,
    evaluatePoemVerification,
    type PoemProvenanceRecord,
} from './poem-provenance.js'

const poem = {
    id: 'tongbian-test',
    title: '测试诗',
    poet: '测试作者',
    dynasty: '唐',
    content: '第一句，第二句。',
}

function verifiedRecord(overrides: Partial<PoemProvenanceRecord> = {}): PoemProvenanceRecord {
    return {
        poemId: poem.id,
        contentSha256: computePoemContentSha256(poem),
        catalogScope: 'TEXTBOOK_CORE',
        sources: [
            { title: '教材出版方', url: 'https://example.edu/source-a', authorityLevel: 'L1', accessedAt: '2026-08-01' },
            { title: '官方教育平台', url: 'https://example.gov/source-b', authorityLevel: 'L2', accessedAt: '2026-08-01' },
        ],
        teacherReview: {
            decision: 'PASS',
            reviewerId: 'T-ANON-01',
            reviewedAt: '2026-08-01',
            evidenceLocation: 'offline-vault/review-001',
        },
        ...overrides,
    }
}

describe('poem provenance', () => {
    it('fails closed when no per-poem record exists', () => {
        expect(evaluatePoemVerification(poem, [])).toMatchObject({
            status: 'UNVERIFIED',
            catalogScope: 'UNCLASSIFIED',
        })
    })

    it('accepts two-source teacher-reviewed evidence', () => {
        expect(evaluatePoemVerification(poem, [verifiedRecord()])).toMatchObject({
            status: 'VERIFIED',
            catalogScope: 'TEXTBOOK_CORE',
        })
    })

    it('invalidates review when any identity or content field changes', () => {
        const changed = { ...poem, content: '第一句，已修改。' }
        expect(evaluatePoemVerification(changed, [verifiedRecord()]).status).toBe('STALE')
    })

    it('rejects one-source and unsigned records as incomplete', () => {
        const record = verifiedRecord({
            sources: [{ title: '单一来源', url: 'https://example.edu/only', authorityLevel: 'L1', accessedAt: '2026-08-01' }],
            teacherReview: { decision: 'REJECT', reviewerId: '', reviewedAt: '2026-08-01', evidenceLocation: '' },
        })
        expect(evaluatePoemVerification(poem, [record]).status).toBe('INCOMPLETE')
    })

    it('does not treat two pages on one domain as independent sources', () => {
        const record = verifiedRecord({
            sources: [
                { title: '同站页面一', url: 'https://example.edu/a', authorityLevel: 'L1', accessedAt: '2026-08-01' },
                { title: '同站页面二', url: 'https://example.edu/b', authorityLevel: 'L2', accessedAt: '2026-08-01' },
            ],
        })
        expect(evaluatePoemVerification(poem, [record]).status).toBe('INCOMPLETE')
    })

    it('does not treat two subdomains of one organization as independent sources', () => {
        const record = verifiedRecord({
            sources: [
                { title: '出版方资料库', url: 'https://archive.publisher.edu.cn/a', authorityLevel: 'L1', accessedAt: '2026-08-01' },
                { title: '出版方公开页', url: 'https://www.publisher.edu.cn/b', authorityLevel: 'L2', accessedAt: '2026-08-01' },
            ],
        })
        expect(evaluatePoemVerification(poem, [record]).status).toBe('INCOMPLETE')
    })

    it('rejects impossible dates, non-public source URLs, and reviews preceding source access', () => {
        const invalidDate = verifiedRecord({
            sources: [
                { title: '教材出版方', url: 'https://publisher.example.edu/source-a', authorityLevel: 'L1', accessedAt: '2026-02-30' },
                { title: '官方教育平台', url: 'https://platform.example.gov/source-b', authorityLevel: 'L2', accessedAt: '2026-08-01' },
            ],
        })
        expect(evaluatePoemVerification(poem, [invalidDate]).status).toBe('INCOMPLETE')

        const credentialUrl = verifiedRecord({
            sources: [
                { title: '教材出版方', url: 'https://user:secret@publisher.example.edu/source-a', authorityLevel: 'L1', accessedAt: '2026-08-01' },
                { title: '官方教育平台', url: 'https://platform.example.gov/source-b', authorityLevel: 'L2', accessedAt: '2026-08-01' },
            ],
        })
        expect(evaluatePoemVerification(poem, [credentialUrl]).status).toBe('INCOMPLETE')

        const earlyReview = verifiedRecord({
            sources: [
                { title: '教材出版方', url: 'https://publisher.example.edu/source-a', authorityLevel: 'L1', accessedAt: '2026-08-02' },
                { title: '官方教育平台', url: 'https://platform.example.gov/source-b', authorityLevel: 'L2', accessedAt: '2026-08-02' },
            ],
            teacherReview: { decision: 'PASS', reviewerId: 'T-ANON-01', reviewedAt: '2026-08-01', evidenceLocation: 'offline-vault/review-001' },
        })
        expect(evaluatePoemVerification(poem, [earlyReview]).status).toBe('INCOMPLETE')
    })

    it('requires at least one L1 source and fails closed on duplicate runtime records', () => {
        const l2Only = verifiedRecord({
            sources: [
                { title: '教育平台 A', url: 'https://platform-a.example.edu/source-a', authorityLevel: 'L2', accessedAt: '2026-08-01' },
                { title: '教育平台 B', url: 'https://platform-b.example.gov/source-b', authorityLevel: 'L2', accessedAt: '2026-08-01' },
            ],
        })
        expect(evaluatePoemVerification(poem, [l2Only]).status).toBe('INCOMPLETE')
        expect(evaluatePoemVerification(poem, [verifiedRecord(), verifiedRecord()]).status).toBe('INCOMPLETE')
    })

    it('requires an anonymous reviewer code rather than a free-form name', () => {
        const record = verifiedRecord({
            teacherReview: {
                decision: 'PASS',
                reviewerId: '张老师',
                reviewedAt: '2026-08-01',
                evidenceLocation: 'offline-vault/review-001',
            },
        })
        expect(evaluatePoemVerification(poem, [record]).status).toBe('INCOMPLETE')
    })
})
