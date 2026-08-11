import { describe, expect, it } from 'vitest'
import {
    MAX_PROVIDER_ERROR_RESPONSE_BYTES,
    MAX_PROVIDER_JSON_RESPONSE_BYTES,
    readBoundedProviderErrorText,
    readBoundedProviderJson,
    sanitizeProviderDetail,
} from './provider-response.js'

describe('bounded provider response', () => {
    it('reads bounded JSON and bounded non-2xx error text', async () => {
        await expect(readBoundedProviderJson<{ ok: boolean }>(new Response('{"ok":true}', {
            headers: { 'content-type': 'application/json; charset=utf-8' },
        }), 'Wan')).resolves.toEqual({ ok: true })
        await expect(readBoundedProviderErrorText(new Response('余额不足', {
            status: 402,
            headers: { 'content-type': 'text/plain' },
        }), '连通性检测')).resolves.toBe('余额不足')
        await expect(readBoundedProviderErrorText(new Response(null, { status: 503 }), '连通性检测'))
            .resolves.toBe('')
        const exactKey = ['sk', 'exact', 'secret', '123456'].join('-')
        expect(sanitizeProviderDetail(
            `invalid ${exactKey} for 13812345678 / teacher@example.com`,
            exactKey,
        )).toBe('invalid [REDACTED] for 138****5678 / t***@example.com')
    })

    it('rejects non-JSON MIME, invalid JSON and declared response overflow', async () => {
        await expect(readBoundedProviderJson(new Response('<html>bad gateway</html>', {
            headers: { 'content-type': 'text/html' },
        }), 'Wan')).rejects.toThrow('响应类型不是 JSON')
        await expect(readBoundedProviderJson(new Response('{broken', {
            headers: { 'content-type': 'application/json' },
        }), 'Wan')).rejects.toThrow('不是有效 JSON')
        await expect(readBoundedProviderJson(new Response('{}', {
            headers: {
                'content-type': 'application/json',
                'content-length': String(MAX_PROVIDER_JSON_RESPONSE_BYTES + 1),
            },
        }), 'Wan')).rejects.toThrow('超过字节上限')
        await expect(readBoundedProviderErrorText(new Response('error', {
            status: 500,
            headers: { 'content-length': String(MAX_PROVIDER_ERROR_RESPONSE_BYTES + 1) },
        }), '连通性检测')).rejects.toThrow('超过字节上限')
    })
})
