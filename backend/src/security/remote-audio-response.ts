import { readBoundedResponseBody } from './bounded-response.js'

export type TtsAudioFormat = 'mp3' | 'wav' | 'opus'

export const TTS_AUDIO_BYTE_LIMITS: Readonly<Record<TtsAudioFormat, number>> = {
    mp3: 24 * 1024 * 1024,
    wav: 64 * 1024 * 1024,
    opus: 24 * 1024 * 1024,
}

const CONTENT_TYPES: Readonly<Record<TtsAudioFormat, ReadonlySet<string>>> = {
    mp3: new Set(['audio/mpeg', 'audio/mp3']),
    wav: new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']),
    opus: new Set(['audio/ogg', 'audio/opus', 'application/ogg']),
}

function normalizedContentType(response: Response): string {
    return (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function hasExpectedAudioSignature(bytes: Buffer, format: TtsAudioFormat): boolean {
    if (format === 'wav') {
        return bytes.length >= 12
            && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
            && bytes.subarray(8, 12).toString('ascii') === 'WAVE'
    }
    if (format === 'opus') {
        return bytes.length >= 4
            && bytes.subarray(0, 4).toString('ascii') === 'OggS'
            && bytes.subarray(0, Math.min(bytes.length, 128)).includes(Buffer.from('OpusHead'))
    }
    return bytes.length >= 3 && (
        bytes.subarray(0, 3).toString('ascii') === 'ID3'
        || (bytes.readUInt8(0) === 0xff && (bytes.readUInt8(1) & 0xe0) === 0xe0)
    )
}

/**
 * MiMo 的官方 TTS Chat Completion 响应把音频放在
 * choices[0].message.audio.data（base64）中，而不是返回二进制 Response。
 * 这里对 base64 语法、解码后字节上限和文件魔数同时失败关闭。
 */
export function decodeBoundedTtsAudioData(
    data: string,
    format: TtsAudioFormat,
): Buffer {
    const normalized = data.trim()
    const maxBytes = TTS_AUDIO_BYTE_LIMITS[format]
    const maxBase64Characters = Math.ceil(maxBytes / 3) * 4
    if (
        normalized.length === 0
        || normalized.length > maxBase64Characters
        || normalized.length % 4 !== 0
        || !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)
    ) {
        throw new Error('TTS 音频响应不是合法且受限的 base64')
    }

    const bytes = Buffer.from(normalized, 'base64')
    const canonicalInput = normalized.replace(/=+$/u, '')
    const canonicalDecoded = bytes.toString('base64').replace(/=+$/u, '')
    if (
        bytes.length === 0
        || bytes.length > maxBytes
        || canonicalDecoded !== canonicalInput
    ) {
        throw new Error('TTS 音频响应 base64 解码失败或超过字节上限')
    }
    if (!hasExpectedAudioSignature(bytes, format)) {
        throw new Error(`TTS 音频响应魔数与请求格式 ${format} 不一致`)
    }
    return bytes
}

/** MiMo TTS 响应只允许请求格式对应的 MIME、字节上限与文件魔数。 */
export async function readBoundedTtsAudioResponse(
    response: Response,
    format: TtsAudioFormat,
): Promise<Buffer> {
    if (!response.ok) {
        throw new Error(`TTS 音频请求失败：HTTP ${response.status}`)
    }
    const contentType = normalizedContentType(response)
    if (!CONTENT_TYPES[format].has(contentType)) {
        throw new Error(`TTS 音频响应类型与请求格式 ${format} 不一致`)
    }
    const bytes = await readBoundedResponseBody(response, {
        maxBytes: TTS_AUDIO_BYTE_LIMITS[format],
        label: 'TTS 音频',
    })
    if (!hasExpectedAudioSignature(bytes, format)) {
        throw new Error(`TTS 音频响应魔数与请求格式 ${format} 不一致`)
    }
    return bytes
}
