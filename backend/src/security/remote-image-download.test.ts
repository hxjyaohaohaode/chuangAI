import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    downloadTrustedDashscopeImage,
    GENERATED_IMAGE_DOWNLOAD_TIMEOUT_MS,
    MAX_GENERATED_IMAGE_DOWNLOAD_BYTES,
    readBoundedImageResponse,
} from './remote-image-download.js'

const TRUSTED_URL = 'https://dashscope-a.oss-cn-beijing.aliyuncs.com/generated/result.png'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('trusted generated image download boundary', () => {
    it('accepts a bounded response whose MIME and magic bytes agree', async () => {
        const response = new Response(PNG_BYTES, {
            headers: {
                'content-type': 'image/png; charset=binary',
                'content-length': String(PNG_BYTES.byteLength),
            },
        })
        await expect(readBoundedImageResponse(response)).resolves.toEqual(Buffer.from(PNG_BYTES))
    })

    it('rejects unsupported MIME, invalid declared length and fake magic bytes', async () => {
        await expect(readBoundedImageResponse(new Response(PNG_BYTES, {
            headers: { 'content-type': 'application/octet-stream' },
        }))).rejects.toThrow('类型不受支持')
        await expect(readBoundedImageResponse(new Response(PNG_BYTES, {
            headers: { 'content-type': 'image/png', 'content-length': '1e9' },
        }))).rejects.toThrow('长度无效')
        await expect(readBoundedImageResponse(new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { 'content-type': 'image/png' },
        }))).rejects.toThrow('魔数不一致')
    })

    it('rejects declared and streamed bodies above the byte limit', async () => {
        await expect(readBoundedImageResponse(new Response(PNG_BYTES, {
            headers: {
                'content-type': 'image/png',
                'content-length': String(MAX_GENERATED_IMAGE_DOWNLOAD_BYTES + 1),
            },
        }))).rejects.toThrow('超过字节上限')

        const streamed = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(PNG_BYTES)
                controller.enqueue(new Uint8Array(5))
                controller.close()
            },
        }), { headers: { 'content-type': 'image/png' } })
        await expect(readBoundedImageResponse(streamed, PNG_BYTES.byteLength + 4))
            .rejects.toThrow('超过字节上限')
    })

    it('rejects an untrusted URL before fetch and disables redirect following', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
            status: 302,
            headers: { location: 'http://127.0.0.1/private' },
        }))
        vi.stubGlobal('fetch', fetchMock)

        await expect(downloadTrustedDashscopeImage('https://example.com/tracker.png'))
            .rejects.toThrow('非 DashScope')
        expect(fetchMock).not.toHaveBeenCalled()

        await expect(downloadTrustedDashscopeImage(TRUSTED_URL)).rejects.toThrow('HTTP 302')
        expect(fetchMock).toHaveBeenCalledWith(TRUSTED_URL, expect.objectContaining({ redirect: 'manual' }))
    })

    it('passes the bounded response through the trusted fetch path', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(PNG_BYTES, {
            headers: { 'content-type': 'image/png' },
        }))
        vi.stubGlobal('fetch', fetchMock)

        await expect(downloadTrustedDashscopeImage(TRUSTED_URL)).resolves.toEqual(Buffer.from(PNG_BYTES))
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            method: 'GET',
            redirect: 'manual',
            signal: expect.any(AbortSignal),
        }))
    })

    it('aborts a stalled provider download at the independent timeout', async () => {
        vi.useFakeTimers()
        const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('download aborted', 'AbortError'))
            }, { once: true })
        }))
        vi.stubGlobal('fetch', fetchMock)

        const rejection = expect(downloadTrustedDashscopeImage(TRUSTED_URL)).rejects.toThrow('download aborted')
        await vi.advanceTimersByTimeAsync(GENERATED_IMAGE_DOWNLOAD_TIMEOUT_MS)
        await rejection
    })
})
