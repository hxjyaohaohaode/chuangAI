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
