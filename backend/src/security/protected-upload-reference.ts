import path from 'node:path'

const CONTENT_TYPE_BY_EXTENSION = {
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
} as const

/**
 * 校验 SQLite 中持久化的批改图片引用，避免旧数据或本地数据库污染把任意文件
 * 交给浏览器或多模态模型。这里只做确定性的词法约束；调用方还必须用 realpath
 * 复核现存文件没有经符号链接/目录联接逃出根目录。
 */
export function resolveProtectedUploadReference(
    uploadDirectory: string,
    candidate: string,
    contentType: string,
): string | null {
    const root = path.resolve(uploadDirectory)
    const resolved = path.resolve(candidate)
    const relative = path.relative(root, resolved)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return null
    }

    const segments = relative.split(path.sep)
    if (segments.length !== 2) return null
    const [batchId, fileName] = segments
    if (!batchId || !/^[A-Za-z0-9_-]+$/u.test(batchId) || !fileName) return null
    const fileMatch = fileName.match(/^[A-Za-z0-9_-]+\.(jpg|png|webp)$/u)
    if (!fileMatch) return null
    const extension = fileMatch[1] as keyof typeof CONTENT_TYPE_BY_EXTENSION
    if (CONTENT_TYPE_BY_EXTENSION[extension] !== contentType) return null
    return resolved
}
