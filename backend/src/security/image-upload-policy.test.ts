import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { inspectImageUpload, sanitizeUploadFilename } from './image-upload-policy.js'

describe('image upload policy', () => {
    it.each([
        ['photo.jpg', 'photo.jpg'],
        ['C:\\fakepath\\answer.png', 'answer.png'],
        ['../../answer.webp', 'answer.webp'],
        ['bad\u0000\nname.png', 'badname.png'],
        ['', 'image'],
    ])('安全化客户端文件名 %#', (input, expected) => {
        expect(sanitizeUploadFilename(input)).toBe(expected)
    })

    it.each([
        ['jpeg', 'image/jpeg', 'jpg'],
        ['png', 'image/png', 'png'],
        ['webp', 'image/webp', 'webp'],
    ] as const)('识别真实 %s 图片', async (format, mime, extension) => {
        const pipeline = sharp({
            create: { width: 32, height: 24, channels: 3, background: '#ffffff' },
        })
        const buffer = await pipeline[format]().toBuffer()
        await expect(inspectImageUpload(buffer, mime)).resolves.toMatchObject({
            format,
            contentType: mime,
            extension,
            width: 32,
            height: 24,
        })
    })

    it('拒绝 MIME 伪装和随机字节', async () => {
        const png = await sharp({
            create: { width: 8, height: 8, channels: 3, background: '#ffffff' },
        }).png().toBuffer()
        await expect(inspectImageUpload(png, 'image/jpeg')).rejects.toThrow(/不一致/)
        await expect(inspectImageUpload(Buffer.from('<script>alert(1)</script>'), 'image/png'))
            .rejects.toThrow(/不是有效/)
    })

    it('拒绝超过边长上限的图片', async () => {
        const tooWide = await sharp({
            create: { width: 8_001, height: 1, channels: 3, background: '#ffffff' },
        }).png().toBuffer()
        await expect(inspectImageUpload(tooWide, 'image/png')).rejects.toThrow(/尺寸/)
    })
})
