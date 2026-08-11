export type ProtectedAudioKind = 'tts' | 'recitations'

const FILE_NAME_PATTERNS: Record<ProtectedAudioKind, RegExp> = {
    tts: /^tts_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+\.(?:mp3|wav|opus)$/u,
    recitations: /^rec_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+\.(?:webm|wav|mp3|ogg|aac)$/u,
}

/**
 * 将升级前保存的 /audio/... 惰性迁移为当前受会话保护的 API URL。
 *
 * 只接受系统自身生成的单层文件名。外部 URL、查询串、反斜杠、路径跳转、
 * 未知目录和伪造扩展名全部失败关闭；调用方不能借媒体引用影响服务端文件路径。
 */
export function normalizeProtectedAudioUrl(value: string | null | undefined): string | null {
    if (!value) return null
    const match = value.match(/^\/(?:api\/recitation\/)?audio\/(tts|recitations)\/([^/]+)$/u)
    if (!match) return null
    const kind = match[1] as ProtectedAudioKind
    const fileName = match[2]
    if (!fileName || !FILE_NAME_PATTERNS[kind].test(fileName)) return null
    return `/api/recitation/audio/${kind}/${fileName}`
}
