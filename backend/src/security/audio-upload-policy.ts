export type AcceptedAudioFormat = 'webm' | 'wav' | 'mp3' | 'ogg' | 'aac'

export interface InspectedAudio {
    format: AcceptedAudioFormat
    extension: AcceptedAudioFormat
    contentType: 'audio/webm' | 'audio/wav' | 'audio/mpeg' | 'audio/ogg' | 'audio/aac'
}

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
    return bytes.every((byte, index) => buffer[index] === byte)
}

/** 通过容器/帧魔数识别格式，避免把任意字节仅凭 multipart MIME 发送给模型。 */
export function detectAudioFormat(buffer: Buffer): AcceptedAudioFormat | null {
    if (buffer.length < 4) return null
    if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm'
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.length >= 12
        && buffer.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav'
    if (buffer.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg'
    if (buffer.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3'
    if (buffer[0] === 0xff && buffer[1] !== undefined) {
        if ((buffer[1] & 0xf6) === 0xf0) return 'aac' // ADTS sync word
        if ((buffer[1] & 0xe0) === 0xe0) return 'mp3' // MPEG audio frame sync
    }
    return null
}

const FORMAT_MIME: Record<AcceptedAudioFormat, InspectedAudio['contentType']> = {
    webm: 'audio/webm',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    aac: 'audio/aac',
}

const MIME_ALIASES: Record<string, InspectedAudio['contentType']> = {
    'audio/webm': 'audio/webm',
    'audio/wav': 'audio/wav',
    'audio/x-wav': 'audio/wav',
    'audio/wave': 'audio/wav',
    'audio/mpeg': 'audio/mpeg',
    'audio/mp3': 'audio/mpeg',
    'audio/ogg': 'audio/ogg',
    'audio/aac': 'audio/aac',
}

function normalizeMime(value: string): string {
    return value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

/**
 * 以魔数为真源解析音频；声明 MIME 仅作为可选的一致性断言，绝不用于猜格式。
 * LLM 客户端可在没有上传头的 Buffer/base64 场景安全推断文件名与 Content-Type。
 */
export function inspectAudioBytes(buffer: Buffer, declaredContentType?: string): InspectedAudio {
    const format = detectAudioFormat(buffer)
    if (!format) throw new Error('文件不是可识别的 webm/wav/mp3/ogg/aac 音频')
    const expected = FORMAT_MIME[format]
    if (declaredContentType !== undefined) {
        const normalized = normalizeMime(declaredContentType)
        const declared = MIME_ALIASES[normalized]
        if (!declared || declared !== expected) {
            throw new Error(`文件声明类型与真实音频格式不一致（声明 ${normalized || '空'}，实际 ${expected}）`)
        }
    }
    return { format, extension: format, contentType: expected }
}

export function inspectAudioUpload(buffer: Buffer, declaredContentType: string): InspectedAudio {
    return inspectAudioBytes(buffer, declaredContentType)
}
