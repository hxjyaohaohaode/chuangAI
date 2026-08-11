import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    authenticatedFetch: vi.fn(),
}))

vi.mock('./auth-session', () => ({
    authenticatedFetch: mocks.authenticatedFetch,
}))

import { api } from './api'
import { ApiError } from './errors'

describe('model credential management API contract', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubGlobal('window', {
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
        })
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('preserves the authoritative Render read-only management metadata', async () => {
        mocks.authenticatedFetch.mockResolvedValue(new Response(JSON.stringify({
            status: 'ok',
            providers: [{
                provider: 'deepseek',
                label: 'DeepSeek',
                powers: '文本推理',
                console: 'https://platform.deepseek.com/',
                configured: true,
                masked: 'sk-****abcd',
            }],
            management: {
                mutable: false,
                managedBy: 'render-dashboard',
            },
        }), { status: 200 }))

        await expect(api.settings.listCredentials()).resolves.toEqual({
            providers: [{
                provider: 'deepseek',
                label: 'DeepSeek',
                powers: '文本推理',
                console: 'https://platform.deepseek.com/',
                configured: true,
                masked: 'sk-****abcd',
            }],
            management: {
                mutable: false,
                managedBy: 'render-dashboard',
            },
        })
        expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
            '/api/settings/credentials',
            expect.objectContaining({
                headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
            }),
        )
    })

    it('rejects a Render-managed PUT with HTTP 409 instead of resolving as saved', async () => {
        mocks.authenticatedFetch.mockResolvedValue(new Response(JSON.stringify({
            status: 'error',
            error: 'SETTINGS_MANAGED_EXTERNALLY',
            message: 'Model credentials are managed in Render Environment',
            statusCode: 409,
            management: {
                mutable: false,
                managedBy: 'render-dashboard',
            },
        }), { status: 409, statusText: 'Conflict' }))

        let rejected: unknown
        try {
            await api.settings.saveCredential('deepseek', 'never-store-this-value')
        } catch (error) {
            rejected = error
        }

        expect(rejected).toBeInstanceOf(ApiError)
        expect(rejected).toMatchObject({ name: 'ApiError', status: 409 })
        // Vitest 运行在 DEV，统一客户端会保留错误正文用于契约诊断；生产环境不会暴露它。
        expect((rejected as ApiError).devDetail).toContain('SETTINGS_MANAGED_EXTERNALLY')
        expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
            '/api/settings/credentials/deepseek',
            expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({ apiKey: 'never-store-this-value' }),
            }),
        )
    })
})
