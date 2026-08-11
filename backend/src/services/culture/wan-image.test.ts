import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    config: {
        wanImage: {
            model: 'wan2.7-image',
            baseUrl: 'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        },
    },
    getKey: vi.fn<() => string | undefined>(),
    getWanImageBaseUrl: vi.fn(() => ''),
}))

vi.mock('../../config.js', () => ({ config: mocks.config }))
vi.mock('../../lib/credentials.js', () => ({
    getKey: mocks.getKey,
    getWanImageBaseUrl: mocks.getWanImageBaseUrl,
}))

import {
    generateWanImage,
    WAN_IMAGE_REQUEST_TIMEOUT_MS,
} from './wan-image.js'

const TRUSTED_IMAGE_URL =
    'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/generated/result.png?Expires=1&Signature=x'

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

function officialSuccess(): unknown {
    return {
        output: {
            choices: [{
                finish_reason: 'stop',
                message: {
                    content: [{ image: TRUSTED_IMAGE_URL, type: 'image' }],
                    role: 'assistant',
                },
            }],
            finished: true,
        },
        usage: { image_count: 1, size: '1152*2048' },
        request_id: 'wan-request-123',
    }
}

beforeEach(() => {
    mocks.config.wanImage.model = 'wan2.7-image'
    mocks.config.wanImage.baseUrl =
        'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
    mocks.getKey.mockReset()
    mocks.getKey.mockReturnValue('dashscope-test-key')
    mocks.getWanImageBaseUrl.mockImplementation(() => mocks.config.wanImage.baseUrl)
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('Wan2.7 official Workspace provider', () => {
    it('returns null without a key and never attempts an external request', async () => {
        mocks.getKey.mockReturnValue(undefined)
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)

        await expect(generateWanImage({ prompt: '月夜水墨画', orientation: 'landscape' }))
            .resolves.toBeNull()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('sends the documented synchronous request and accepts the exact official response', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(officialSuccess()))
        vi.stubGlobal('fetch', fetchMock)

        await expect(generateWanImage({ prompt: '月夜水墨画', orientation: 'portrait' }))
            .resolves.toEqual({
                imageUrl: TRUSTED_IMAGE_URL,
                model: 'wan2.7-image',
                requestId: 'wan-request-123',
            })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe(mocks.config.wanImage.baseUrl)
        expect(init).toEqual(expect.objectContaining({
            method: 'POST',
            redirect: 'error',
            signal: expect.any(AbortSignal),
        }))
        expect(init.headers).toEqual(expect.objectContaining({
            Authorization: 'Bearer dashscope-test-key',
            'Content-Type': 'application/json',
            Accept: 'application/json',
        }))
        expect(JSON.parse(String(init.body))).toEqual({
            model: 'wan2.7-image',
            input: {
                messages: [{ role: 'user', content: [{ text: '月夜水墨画' }] }],
            },
            parameters: {
                size: '1152*2048',
                n: 1,
                watermark: false,
                thinking_mode: true,
            },
        })
    })

    it('rejects legacy/global endpoints and model substitutions before fetch', async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)

        mocks.config.wanImage.baseUrl =
            'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
        await expect(generateWanImage({ prompt: '月夜', orientation: 'landscape' }))
            .rejects.toThrow(/Workspace MaaS/)

        mocks.config.wanImage.baseUrl =
            'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
        mocks.config.wanImage.model = 'wan2.7-image-pro'
        await expect(generateWanImage({ prompt: '月夜', orientation: 'landscape' }))
            .rejects.toThrow(/模型必须/)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each([
        ['missing request id', (() => {
            const value = officialSuccess() as Record<string, unknown>
            delete value.request_id
            return value
        })()],
        ['unfinished task', {
            ...(officialSuccess() as Record<string, unknown>),
            output: { ...((officialSuccess() as { output: object }).output), finished: false },
        }],
        ['untrusted image URL', {
            output: {
                choices: [{
                    finish_reason: 'stop',
                    message: {
                        content: [{ image: 'https://evil.test/result.png', type: 'image' }],
                        role: 'assistant',
                    },
                }],
                finished: true,
            },
            usage: { image_count: 1 },
            request_id: 'wan-request-123',
        }],
        ['wrong count', {
            ...(officialSuccess() as Record<string, unknown>),
            usage: { image_count: 2 },
        }],
    ])('rejects malformed or unsafe success payload: %s', async (_label, payload) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)))
        await expect(generateWanImage({ prompt: '月夜', orientation: 'landscape' })).rejects.toThrow()
    })

    it('bounds and redacts provider error details', async () => {
        const apiKey = 'dashscope-test-key'
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            code: 'InvalidParameter',
            message: `provider echoed ${apiKey}`,
        }, 400)))

        const error = await generateWanImage({ prompt: '月夜', orientation: 'landscape' })
            .catch((cause: unknown) => cause)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('400')
        expect((error as Error).message).not.toContain(apiKey)
        expect((error as Error).message).toContain('[REDACTED]')
    })

    it('aborts a stalled Workspace request at the independent timeout', async () => {
        vi.useFakeTimers()
        const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('wan request aborted', 'AbortError'))
            }, { once: true })
        }))
        vi.stubGlobal('fetch', fetchMock)

        const rejection = expect(generateWanImage({ prompt: '月夜', orientation: 'landscape' }))
            .rejects.toThrow('wan request aborted')
        await vi.advanceTimersByTimeAsync(WAN_IMAGE_REQUEST_TIMEOUT_MS)
        await rejection
    })
})
