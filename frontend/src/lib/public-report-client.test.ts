import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchPublicSharedReport } from './public-report-client'
import { PublicShareAccessError } from './report-share-contract'

const token = 's'.repeat(43)
const validPayload = {
    status: 'ok',
    shared: {
        className: '三年二班',
        title: '脱敏教研报告',
        contentHtml: '<h1>公开报告</h1><p>班级聚合结论</p>',
        createdAt: 1_700_000_000_000,
        expireAt: 1_700_604_800_000,
    },
    aiGenerated: true,
}

describe('anonymous public report client', () => {
    beforeEach(() => {
        vi.stubGlobal('window', {
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
        })
    })

    afterEach(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    it('uses the isolated credential-free, no-referrer request contract', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(
            JSON.stringify(validPayload),
            { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
        ))
        vi.stubGlobal('fetch', fetchMock)

        await expect(fetchPublicSharedReport(token)).resolves.toMatchObject({
            shared: { title: '脱敏教研报告' },
        })
        expect(fetchMock).toHaveBeenCalledWith(
            `/api/report/shared/${token}`,
            expect.objectContaining({
                method: 'GET',
                credentials: 'omit',
                cache: 'no-store',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
                mode: 'same-origin',
            }),
        )
        const request = fetchMock.mock.calls[0]?.[1] as RequestInit
        expect(request.headers).toEqual({ Accept: 'application/json' })
    })

    it('cancels a chunked response as soon as the decoded body exceeds the byte budget', async () => {
        let cancelled = false
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(400_001))
            },
            cancel() {
                cancelled = true
            },
        })
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })))

        await expect(fetchPublicSharedReport(token)).rejects.toMatchObject({
            reason: 'invalid-response',
        })
        expect(cancelled).toBe(true)
    })

    it('collapses unavailable and network failures into safe errors without echoing the bearer', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
            status: 404,
            headers: { 'content-type': 'application/json' },
        })))
        const unavailable = await fetchPublicSharedReport(token).catch((error: unknown) => error)
        expect(unavailable).toBeInstanceOf(PublicShareAccessError)
        expect(unavailable).toMatchObject({ reason: 'unavailable' })
        expect(String(unavailable)).not.toContain(token)

        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`failed ${token}`)))
        const network = await fetchPublicSharedReport(token).catch((error: unknown) => error)
        expect(network).toBeInstanceOf(PublicShareAccessError)
        expect(network).toMatchObject({ reason: 'network' })
        expect(String(network)).not.toContain(token)
    })
})
