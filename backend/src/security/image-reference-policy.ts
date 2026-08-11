const DATA_URL_PATTERN = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/u
export const MAX_MODEL_INLINE_IMAGE_URL_CHARS = 2_000_000
const MAX_TRUSTED_REMOTE_IMAGE_URL_CHARS = 4_096

function hasImageSignature(bytes: Buffer, format: string): boolean {
    if (format === 'jpeg') {
        return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    }
    if (format === 'png') {
        return bytes.length >= 8
            && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    }
    return bytes.length >= 12
        && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
        && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

/** OCR 公共端点只接受格式与魔数一致的内联图片，不把任意 URL 交给模型代取。 */
export function isSupportedInlineImageDataUrl(value: string): boolean {
    if (value.length > MAX_MODEL_INLINE_IMAGE_URL_CHARS) return false
    const match = value.match(DATA_URL_PATTERN)
    if (!match || !match[1] || !match[2] || match[2].length % 4 !== 0) return false
    try {
        const bytes = Buffer.from(match[2], 'base64')
        return bytes.length > 0 && hasImageSignature(bytes, match[1])
    } catch {
        return false
    }
}

/**
 * Wan 生图只允许从 DashScope 返回的阿里云 OSS HTTPS 地址下载。
 * 禁止凭据、非标准端口、IP、localhost、任意外域与协议降级。
 */
export function isTrustedDashscopeImageUrl(value: string): boolean {
    if (value.length > MAX_TRUSTED_REMOTE_IMAGE_URL_CHARS) return false
    try {
        const url = new URL(value)
        if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
            return false
        }
        return /^dashscope-[a-z0-9-]+\.(?:oss-accelerate|oss-cn-[a-z0-9-]+)\.aliyuncs\.com$/u
            .test(url.hostname.toLowerCase())
    } catch {
        return false
    }
}

/**
 * MiMo 底层只允许受控内联图片，或本系统 Wan 生图刚返回的 DashScope OSS 地址。
 * 路由、Agent 或编排器即使遗漏校验，也不得让模型供应商代取任意 URL。
 */
export function isSupportedModelImageReference(value: string): boolean {
    return isSupportedInlineImageDataUrl(value) || isTrustedDashscopeImageUrl(value)
}

/** 可持久化并交给浏览器渲染的作品配图，只能指向系统已落盘的受保护 WebP。 */
export function isProtectedGeneratedImageUrl(value: string): boolean {
    return /^\/uploads\/generated\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.webp$/u.test(value)
}
