import { describe, expect, it } from 'vitest'
import {
    isSupportedInlineImageDataUrl,
    isSupportedModelImageReference,
    isProtectedGeneratedImageUrl,
    isTrustedDashscopeImageUrl,
    MAX_MODEL_INLINE_IMAGE_URL_CHARS,
} from './image-reference-policy.js'

describe('image reference policy', () => {
    it('只接受魔数匹配的内联图片与 DashScope HTTPS OSS 下载地址', () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64')
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64')
        const webp = Buffer.from('RIFF1234WEBP', 'ascii').toString('base64')
        expect(isSupportedInlineImageDataUrl(`data:image/png;base64,${png}`)).toBe(true)
        expect(isSupportedInlineImageDataUrl(`data:image/jpeg;base64,${jpeg}`)).toBe(true)
        expect(isSupportedInlineImageDataUrl(`data:image/webp;base64,${webp}`)).toBe(true)
        expect(isSupportedModelImageReference(`data:image/png;base64,${png}`)).toBe(true)
        for (const value of [
            'https://example.test/image.png',
            'file:///etc/passwd',
            'data:text/html;base64,PGgxPng8L2gxPg==',
            `data:image/jpeg;base64,${png}`,
            'data:image/png;base64,%%%%',
            `data:image/png;base64,${'A'.repeat(MAX_MODEL_INLINE_IMAGE_URL_CHARS)}`,
        ]) expect(isSupportedInlineImageDataUrl(value)).toBe(false)

        for (const value of [
            'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/path/image.png?Expires=1',
            'https://dashscope-result.oss-accelerate.aliyuncs.com/path/image.png',
        ]) expect(isTrustedDashscopeImageUrl(value)).toBe(true)
        for (const value of [
            'http://dashscope-result.oss-accelerate.aliyuncs.com/image.png',
            'https://127.0.0.1/image.png',
            'https://localhost/image.png',
            'https://dashscope-result.oss-accelerate.aliyuncs.com.evil.test/image.png',
            'https://user@dashscope-result.oss-accelerate.aliyuncs.com/image.png',
            'https://dashscope-result.oss-accelerate.aliyuncs.com:8443/image.png',
        ]) expect(isTrustedDashscopeImageUrl(value)).toBe(false)
        expect(isSupportedModelImageReference('https://dashscope-result.oss-accelerate.aliyuncs.com/image.png')).toBe(true)
        expect(isSupportedModelImageReference('https://example.test/image.png')).toBe(false)
        expect(isProtectedGeneratedImageUrl('/uploads/generated/a1_b-2.webp')).toBe(true)
        expect(isProtectedGeneratedImageUrl('/uploads/generated/starmap/tongbian-003.webp')).toBe(true)
        for (const value of [
            'https://tracker.example.test/pixel.webp',
            '/uploads/generated/../private.webp',
            '/uploads/generated/a.webp?student=1',
            '/uploads/generated/a.png',
            '/uploads/generated/a\\b.webp',
        ]) expect(isProtectedGeneratedImageUrl(value)).toBe(false)
    })
})
