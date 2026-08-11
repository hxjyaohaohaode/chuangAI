import { describe, expect, it } from 'vitest'
import { redactBearerTokensFromUrl } from './sanitize.js'

describe('logger URL bearer redaction', () => {
    it('redacts report share path capabilities while preserving route shape and query', () => {
        const token = 'a'.repeat(43)
        const redacted = redactBearerTokensFromUrl(
            `/api/report/shared/${token}?utm_source=teacher`,
        )

        expect(redacted).toBe(
            '/api/report/shared/[REDACTED_BEARER]?utm_source=teacher',
        )
        expect(redacted).not.toContain(token)
    })

    it('redacts token query parameters without changing unrelated URLs', () => {
        expect(redactBearerTokensFromUrl('/api/example?token=secret-value&mode=public'))
            .toBe('/api/example?token=[REDACTED_BEARER]&mode=public')
        expect(redactBearerTokensFromUrl('/api/report/shared'))
            .toBe('/api/report/shared')
    })

    it('redacts the bearer from the public SPA page path', () => {
        const token = 'b'.repeat(43)
        const redacted = redactBearerTokensFromUrl(`/shared/report/${token}`)

        expect(redacted).toBe('/shared/report/[REDACTED_BEARER]')
        expect(redacted).not.toContain(token)
    })
})
