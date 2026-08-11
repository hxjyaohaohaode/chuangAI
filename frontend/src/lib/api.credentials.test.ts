import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    authenticatedFetch: vi.fn(),
}))

vi.mock('./auth-session', () => ({
    authenticatedFetch: mocks.authenticatedFetch,
}))

import { api } from './api'

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

    it('preserves the authoritative Render encrypted-vault management metadata', async () => {
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
                mutable: true,
                managedBy: 'encrypted-vault',
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
                mutable: true,
                managedBy: 'encrypted-vault',
            },
        })
        expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
            '/api/settings/credentials',
            expect.objectContaining({
                headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
            }),
        )
    })

    it('saves a credential through the authenticated encrypted-vault endpoint', async () => {
        mocks.authenticatedFetch.mockResolvedValue(new Response(JSON.stringify({
            status: 'ok', provider: 'deepseek', label: 'DeepSeek', configured: true, masked: 'sk-****abcd',
        }), { status: 200 }))

        await expect(api.settings.saveCredential('deepseek', 'never-store-this-value')).resolves.toMatchObject({
            provider: 'deepseek', configured: true, masked: 'sk-****abcd',
        })
        expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
            '/api/settings/credentials/deepseek',
            expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({ apiKey: 'never-store-this-value' }),
            }),
        )
    })
})
