import { describe, expect, it } from 'vitest'
import {
    normalizeTrustedAppOrigin,
    parsePublicAppOrigins,
    parseRenderExternalOrigin,
    parseTrustedDeploymentOrigins,
} from './public-origin-policy.js'

describe('public application origin policy', () => {
    it('接受 HTTPS 公网 Origin 与 HTTP 回环 Origin，并做确定性去重', () => {
        expect(parseTrustedDeploymentOrigins(
            'https://teach.example.cn/, http://127.0.0.1:5173,https://teach.example.cn',
            'https://poetic-realm.onrender.com',
        )).toEqual([
            'https://teach.example.cn',
            'http://127.0.0.1:5173',
            'https://poetic-realm.onrender.com',
        ])
        expect(normalizeTrustedAppOrigin('http://[::1]:3001')).toBe('http://[::1]:3001')
    })

    it.each([
        'http://teach.example.cn',
        'https://*.example.cn',
        'https://user@example.cn',
        'https://user:password@example.cn',
        'https://example.cn/app',
        'https://example.cn/?next=evil',
        'https://example.cn/#fragment',
        'ws://example.cn',
        'example.cn',
    ])('拒绝非精确或不安全来源 %s', (origin) => {
        expect(() => normalizeTrustedAppOrigin(origin)).toThrow()
    })

    it('拒绝列表中的空条目，避免配置拼写错误被静默忽略', () => {
        expect(() => parsePublicAppOrigins('https://a.example,,https://b.example')).toThrow(/空条目/)
        expect(() => parsePublicAppOrigins('https://a.example,')).toThrow(/空条目/)
    })

    it('Render 自动外部地址必须为 HTTPS 且不接受路径', () => {
        expect(parseRenderExternalOrigin('')).toEqual([])
        expect(() => parseRenderExternalOrigin('http://localhost:3001')).toThrow(/HTTPS/)
        expect(() => parseRenderExternalOrigin('https://app.onrender.com/login')).toThrow(/路径/)
    })
})
