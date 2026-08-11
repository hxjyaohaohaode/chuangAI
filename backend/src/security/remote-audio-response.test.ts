import { describe, expect, it } from 'vitest'
import { readBoundedResponseBody } from './bounded-response.js'
import { readBoundedTtsAudioResponse, TTS_AUDIO_BYTE_LIMITS } from './remote-audio-response.js'

const WAV_BYTES = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45,
])

describe('bounded TTS audio response', () => {
    it('accepts matching WAV, MP3 and Opus response contracts', async () => {
        const wav = new Response(WAV_BYTES, { headers: { 'content-type': 'audio/wav' } })
        const mp3 = new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
            headers: { 'content-type': 'audio/mpeg' },
        })
        const opus = new Response(Buffer.from('OggS0000OpusHead'), {
            headers: { 'content-type': 'audio/ogg' },
        })
        await expect(readBoundedTtsAudioResponse(wav, 'wav')).resolves.toEqual(Buffer.from(WAV_BYTES))
        await expect(readBoundedTtsAudioResponse(mp3, 'mp3')).resolves.toEqual(Buffer.from([0x49, 0x44, 0x33, 0x04]))
        await expect(readBoundedTtsAudioResponse(opus, 'opus')).resolves.toEqual(Buffer.from('OggS0000OpusHead'))
    })

    it('rejects MIME/format mismatch, fake magic and declared overflow', async () => {
        await expect(readBoundedTtsAudioResponse(new Response(WAV_BYTES, {
            headers: { 'content-type': 'text/html' },
        }), 'wav')).rejects.toThrow('响应类型')
        await expect(readBoundedTtsAudioResponse(new Response(Buffer.from('<html>error</html>'), {
            headers: { 'content-type': 'audio/mpeg' },
        }), 'mp3')).rejects.toThrow('响应魔数')
        await expect(readBoundedTtsAudioResponse(new Response(WAV_BYTES, {
            headers: {
                'content-type': 'audio/wav',
                'content-length': String(TTS_AUDIO_BYTE_LIMITS.wav + 1),
            },
        }), 'wav')).rejects.toThrow('超过字节上限')
    })

    it('uses the shared streaming limit when Content-Length is absent', async () => {
        const streamed = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(WAV_BYTES)
                controller.enqueue(new Uint8Array(2))
                controller.close()
            },
        }), { headers: { 'content-type': 'audio/wav' } })
        await expect(readBoundedResponseBody(streamed, {
            maxBytes: WAV_BYTES.byteLength + 1,
            label: 'TTS 音频',
        })).rejects.toThrow('超过字节上限')
    })
})
