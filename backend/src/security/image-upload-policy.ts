import sharp, { type Metadata } from 'sharp'

const FORMAT_TO_MIME = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
} as const

export type AcceptedImageFormat = keyof typeof FORMAT_TO_MIME

export interface InspectedImage {
    format: AcceptedImageFormat
    contentType: (typeof FORMAT_TO_MIME)[AcceptedImageFormat]
    extension: 'jpg' | 'png' | 'webp'
    width: number
    height: number
}

const MAX_INPUT_PIXELS = 40_000_000
const MAX_DIMENSION = 8_000

/** 只保留用于教师识别的安全显示名；磁盘文件名始终由服务端 ID 生成。 */
export function sanitizeUploadFilename(input: string): string {
    const leaf = input.replace(/\\/gu, '/').split('/').at(-1) ?? 'image'
    const cleaned = leaf.replace(/[\u0000-\u001F\u007F]/gu, '').trim()
    return (cleaned || 'image').slice(0, 180)
}

/**
 * 用解码器识别真实格式，而不是信任 multipart MIME 或扩展名。
 * 同时限制像素数、边长与动画页数，阻断伪装文件和图片解压炸弹。
 */
export async function inspectImageUpload(
    buffer: Buffer,
    declaredContentType: string,
): Promise<InspectedImage> {
    if (buffer.length === 0) throw new Error('图片内容为空')

    let metadata: Metadata
    try {
        metadata = await sharp(buffer, {
            failOn: 'warning',
            limitInputPixels: MAX_INPUT_PIXELS,
            animated: true,
        }).metadata()
    } catch {
        throw new Error('文件不是有效的 jpg/png/webp 图片，或图片像素规模超过限制')
    }

    const format = metadata.format
    if (format !== 'jpeg' && format !== 'png' && format !== 'webp') {
        throw new Error('图片真实格式不受支持，仅允许 jpg/png/webp')
    }
    const expectedContentType = FORMAT_TO_MIME[format]
    if (declaredContentType !== expectedContentType) {
        throw new Error(`文件声明类型与真实格式不一致（声明 ${declaredContentType}，实际 ${expectedContentType}）`)
    }

    const width = metadata.width ?? 0
    const height = metadata.height ?? 0
    if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new Error(`图片尺寸无效或超过 ${MAX_DIMENSION}×${MAX_DIMENSION} 限制`)
    }
    if ((metadata.pages ?? 1) > 1) {
        throw new Error('不支持动画或多页图片，请上传单帧答题图片')
    }

    return {
        format,
        contentType: expectedContentType,
        extension: format === 'jpeg' ? 'jpg' : format,
        width,
        height,
    }
}
