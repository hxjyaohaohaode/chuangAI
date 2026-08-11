import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    config: {
        isRender: false,
        deepseek: { baseUrl: 'https://api.deepseek.com' },
        mimo: { baseUrl: 'https://api.xiaomimimo.com/v1' },
        wanImage: { model: 'wan2.7-image' },
    },
    getKey: vi.fn(() => ''),
    getWanImageBaseUrl: vi.fn(() => 'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'),
    listCredentialStatus: vi.fn(() => [{
        provider: 'deepseek', label: 'DeepSeek', powers: '命题',
        console: 'https://platform.deepseek.com', configured: true,
        masked: 'dee****alue', inputKind: 'secret',
    }]),
    maskKey: vi.fn((key: string) => key ? 'dee****alue' : ''),
    setKey: vi.fn(),
}))

vi.mock('../config.js', () => ({ config: mocks.config }))
vi.mock('../lib/credentials.js', () => ({
    getKey: mocks.getKey,
    getWanImageBaseUrl: mocks.getWanImageBaseUrl,
    listCredentialStatus: mocks.listCredentialStatus,
    maskKey: mocks.maskKey,
    setKey: mocks.setKey,
    PROVIDER_META: {
        deepseek: { label: 'DeepSeek' }, mimo: { label: 'MiMo（小米）' },
        dashscope: { label: '阿里云百炼' }, wanBaseUrl: { label: 'Wan 地址' },
    },
}))

import { settingsRoutes } from './settings.js'

let app: FastifyInstance | undefined

async function buildSettingsApp(accountType: 'owner' | 'demo' = 'owner'): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false })
    instance.addHook('onRequest', async (request) => {
        request.auth = {
            id: 'teacher-001', name: '测试教师', role: 'teacher', accountType,
            issuedAt: 1, expiresAt: 9_999_999_999, csrfToken: 'csrf', sessionId: 'session',
        }
    })
    await instance.register(settingsRoutes, { prefix: '/api/settings' })
    await instance.ready()
    app = instance
    return instance
}

describe('settings credentials management contract', () => {
    beforeEach(() => { vi.clearAllMocks(); mocks.config.isRender = false })
    afterEach(async () => { await app?.close(); app = undefined })

    it('Render 所有者使用持久盘加密保险柜并可热更新', async () => {
        mocks.config.isRender = true
        const instance = await buildSettingsApp('owner')
        const status = await instance.inject({ url: '/api/settings/credentials' })
        expect(status.json().management).toEqual({ mutable: true, managedBy: 'encrypted-vault' })

        const saved = await instance.inject({
            method: 'PUT', url: '/api/settings/credentials/deepseek',
            payload: { apiKey: 'valid-credential-placeholder' },
        })
        expect(saved.statusCode).toBe(200)
        expect(mocks.setKey).toHaveBeenCalledWith('deepseek', 'valid-credential-placeholder')
    })

    it('演示账户不接收掩码，也不能保存或测试付费供应商凭据', async () => {
        mocks.config.isRender = true
        const instance = await buildSettingsApp('demo')
        const status = await instance.inject({ url: '/api/settings/credentials' })
        expect(status.json()).toMatchObject({
            management: { mutable: false, managedBy: 'encrypted-vault' },
            providers: [{ masked: '' }],
        })
        const saved = await instance.inject({
            method: 'PUT', url: '/api/settings/credentials/deepseek',
            payload: { apiKey: 'valid-credential-placeholder' },
        })
        expect(saved.statusCode).toBe(403)
        expect(saved.json().error).toBe('DEMO_ACCOUNT_READ_ONLY')
        expect(mocks.setKey).not.toHaveBeenCalled()
        const tested = await instance.inject({ method: 'POST', url: '/api/settings/credentials/deepseek/test' })
        expect(tested.statusCode).toBe(403)
        expect(mocks.getKey).not.toHaveBeenCalled()
    })

    it('本地所有者仍使用 .env 可变契约', async () => {
        const instance = await buildSettingsApp('owner')
        const response = await instance.inject({ url: '/api/settings/credentials' })
        expect(response.json().management).toEqual({ mutable: true, managedBy: 'local-env' })
    })
})
