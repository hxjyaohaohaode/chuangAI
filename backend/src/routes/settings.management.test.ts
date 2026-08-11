import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    config: {
        isRender: false,
        deepseek: { baseUrl: 'https://api.deepseek.com' },
        mimo: { baseUrl: 'https://api.xiaomimimo.com/v1' },
        wanImage: {
            baseUrl: 'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
            model: 'wan2.7-image',
        },
    },
    getKey: vi.fn(() => ''),
    listCredentialStatus: vi.fn(() => [{
        provider: 'deepseek',
        label: 'DeepSeek',
        powers: '命题',
        console: 'https://platform.deepseek.com',
        configured: false,
        masked: '',
    }]),
    maskKey: vi.fn((key: string) => key ? 'sk-****cdef' : ''),
    setKey: vi.fn(),
}))

vi.mock('../config.js', () => ({ config: mocks.config }))
vi.mock('../lib/credentials.js', () => ({
    getKey: mocks.getKey,
    listCredentialStatus: mocks.listCredentialStatus,
    maskKey: mocks.maskKey,
    setKey: mocks.setKey,
    PROVIDER_META: {
        deepseek: { label: 'DeepSeek' },
        mimo: { label: 'MiMo（小米）' },
        dashscope: { label: '阿里云百炼' },
    },
}))

import { settingsRoutes } from './settings.js'

let app: FastifyInstance | undefined

async function buildSettingsApp(externallyManagedCredentials?: boolean): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false })
    await instance.register(settingsRoutes, {
        prefix: '/api/settings',
        ...(externallyManagedCredentials === undefined ? {} : { externallyManagedCredentials }),
    })
    await instance.ready()
    app = instance
    return instance
}

describe('settings credentials management contract', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.config.isRender = false
    })

    afterEach(async () => {
        await app?.close()
        app = undefined
    })

    it('Render GET 显式声明 Dashboard 托管且不可修改', async () => {
        const instance = await buildSettingsApp(true)

        const response = await instance.inject({
            method: 'GET',
            url: '/api/settings/credentials',
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
            status: 'ok',
            providers: expect.any(Array),
            management: {
                mutable: false,
                managedBy: 'render-dashboard',
            },
        })
    })

    it.each([
        { apiKey: 'valid-credential-placeholder' },
        { apiKey: 42 },
        {},
    ])('Render PUT 对任意正文稳定返回 409，且绝不调用写入函数：%j', async (payload) => {
        const instance = await buildSettingsApp(true)

        const response = await instance.inject({
            method: 'PUT',
            url: '/api/settings/credentials/deepseek',
            payload,
        })

        expect(response.statusCode).toBe(409)
        expect(response.json()).toEqual({
            status: 'error',
            error: 'SETTINGS_MANAGED_EXTERNALLY',
            message: expect.stringContaining('Render'),
            statusCode: 409,
            management: {
                mutable: false,
                managedBy: 'render-dashboard',
            },
        })
        expect(mocks.setKey).not.toHaveBeenCalled()
    })

    it('非 Render GET 保持本地可变契约，PUT 仍可更新本地 .env', async () => {
        const instance = await buildSettingsApp()

        const getResponse = await instance.inject({
            method: 'GET',
            url: '/api/settings/credentials',
        })
        expect(getResponse.statusCode).toBe(200)
        expect(getResponse.json().management).toEqual({
            mutable: true,
            managedBy: 'local-env',
        })

        const putResponse = await instance.inject({
            method: 'PUT',
            url: '/api/settings/credentials/deepseek',
            payload: { apiKey: 'valid-credential-placeholder' },
        })
        expect(putResponse.statusCode).toBe(200)
        expect(putResponse.json()).toMatchObject({
            status: 'ok',
            provider: 'deepseek',
            configured: true,
        })
        expect(mocks.setKey).toHaveBeenCalledOnce()
        expect(mocks.setKey).toHaveBeenCalledWith('deepseek', 'valid-credential-placeholder')
    })

    it('未传插件选项时仍按启动期 Render 标志 fail closed', async () => {
        mocks.config.isRender = true
        const instance = await buildSettingsApp()

        const response = await instance.inject({
            method: 'PUT',
            url: '/api/settings/credentials/mimo',
            payload: { apiKey: 'mimo-valid-credential-value' },
        })

        expect(response.statusCode).toBe(409)
        expect(response.json().error).toBe('SETTINGS_MANAGED_EXTERNALLY')
        expect(mocks.setKey).not.toHaveBeenCalled()
    })
})
