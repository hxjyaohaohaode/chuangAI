import { isTrustedDashscopeImageUrl } from './image-reference-policy.js'
import { readBoundedResponseBody } from './bounded-response.js'

export const MAX_GENERATED_IMAGE_DOWNLOAD_BYTES = 20 * 1024 * 1024
export const GENERATED_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000

const ALLOWED_IMAGE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

function normalizedContentType(response: Response): string {
    return (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function hasMatchingImageSignature(bytes: Buffer, contentType: string): boolean {
    if (contentType === 'image/jpeg') {
        return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    }
    if (contentType === 'image/png') {
        return bytes.length >= 8
            && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    }
    return bytes.length >= 12
        && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
        && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

/**
 * 流式读取响应并在累积字节超过上限时立即取消，避免 chunked 响应绕过
 * Content-Length 检查后耗尽服务端内存。
 */
export async function readBoundedImageResponse(
    response: Response,
    maxBytes = MAX_GENERATED_IMAGE_DOWNLOAD_BYTES,
): Promise<Buffer> {
    if (!response.ok) {
        throw new Error(`下载生成图片失败：HTTP ${response.status}`)
    }
    const contentType = normalizedContentType(response)
    if (!ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
        throw new Error('生成图片响应类型不受支持')
    }
    const bytes = await readBoundedResponseBody(response, { maxBytes, label: '生成图片' })
    if (!hasMatchingImageSignature(bytes, contentType)) {
        throw new Error('生成图片响应类型与文件魔数不一致')
    }
    return bytes
}

/**
 * 只下载当前系统认可的 DashScope OSS 图片；禁止自动重定向，避免白名单 URL
 * 经 30x 跳转后把后端变成任意地址代理。下载超时与调用方取消信号同时生效。
 */
export async function downloadTrustedDashscopeImage(
    remoteUrl: string,
    options?: { signal?: AbortSignal },
): Promise<Buffer> {
    if (!isTrustedDashscopeImageUrl(remoteUrl)) {
        throw new Error('供应商返回了非 DashScope HTTPS OSS 图片地址')
    }

    const timeoutController = new AbortController()
    const timeout = setTimeout(() => timeoutController.abort(), GENERATED_IMAGE_DOWNLOAD_TIMEOUT_MS)
    const signal = options?.signal
        ? AbortSignal.any([options.signal, timeoutController.signal])
        : timeoutController.signal
    try {
        const response = await fetch(remoteUrl, {
            method: 'GET',
            redirect: 'manual',
            signal,
            headers: { Accept: 'image/png,image/jpeg,image/webp' },
        })
        return await readBoundedImageResponse(response)
    } finally {
        clearTimeout(timeout)
    }
}
