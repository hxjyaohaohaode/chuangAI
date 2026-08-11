import { describe, expect, it } from 'vitest'
import { isTrustedProviderEndpoint } from './provider-endpoint-policy.js'

describe('provider endpoint credential boundary', () => {
    const officialWanEndpoint =
        'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'

    it('accepts only the documented Beijing Workspace synchronous Wan endpoint', () => {
        expect(isTrustedProviderEndpoint('wan-image', officialWanEndpoint)).toBe(true)
        expect(isTrustedProviderEndpoint('wan-image', `${officialWanEndpoint}/`)).toBe(true)
        expect(isTrustedProviderEndpoint(
            'wan-image',
            officialWanEndpoint.replace('aliyuncs.com/', 'aliyuncs.com:443/'),
        )).toBe(true)

        for (const value of [
            'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
            'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/image-generation/generation',
            'https://workspace-123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
            'http://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
            'https://user@workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
            'https://workspace-123.cn-beijing.maas.aliyuncs.com:8443/api/v1/services/aigc/multimodal-generation/generation',
            `${officialWanEndpoint}?redirect=https://evil.test`,
            `${officialWanEndpoint}#token`,
            'https://workspace-123.cn-beijing.maas.aliyuncs.com.evil.test/api/v1/services/aigc/multimodal-generation/generation',
        ]) {
            expect(isTrustedProviderEndpoint('wan-image', value), value).toBe(false)
        }
    })

    it('keeps DeepSeek and MiMo on their exact official HTTPS API roots', () => {
        expect(isTrustedProviderEndpoint('deepseek', 'https://api.deepseek.com/v1')).toBe(true)
        expect(isTrustedProviderEndpoint('mimo', 'https://api.xiaomimimo.com/v1')).toBe(true)
        expect(isTrustedProviderEndpoint('deepseek', 'https://api.deepseek.com.evil.test/v1')).toBe(false)
        expect(isTrustedProviderEndpoint('mimo', 'https://api.xiaomimimo.com/v1?x=1')).toBe(false)
    })
})
