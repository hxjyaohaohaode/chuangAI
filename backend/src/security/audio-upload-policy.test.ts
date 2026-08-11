import { describe, expect, it } from 'vitest'
import { detectAudioFormat, inspectAudioBytes, inspectAudioUpload } from './audio-upload-policy.js'

const samples = {
    webm: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]),
    wav: Buffer.from('RIFF0000WAVEfmt ', 'ascii'),
    ogg: Buffer.from('OggS0000', 'ascii'),
    mp3: Buffer.from('ID30000', 'ascii'),
    aac: Buffer.from([0xff, 0xf1, 0x50, 0x80]),
} as const

describe('audio upload policy', () => {
    it.each(Object.entries(samples))('识别 %s 魔数', (format, buffer) => {
        expect(detectAudioFormat(buffer)).toBe(format)
    })

    it('规范化 MIME 别名', () => {
        expect(inspectAudioUpload(samples.wav, 'audio/x-wav')).toMatchObject({
            format: 'wav', contentType: 'audio/wav', extension: 'wav',
        })
        expect(inspectAudioUpload(samples.mp3, 'audio/mp3')).toMatchObject({
            format: 'mp3', contentType: 'audio/mpeg', extension: 'mp3',
        })
        expect(inspectAudioUpload(samples.webm, 'Audio/WebM; codecs=opus')).toMatchObject({
            format: 'webm', contentType: 'audio/webm', extension: 'webm',
        })
    })

    it('无 MIME 的受控 Buffer 仍只按魔数推断，不按调用方扩展名猜测', () => {
        expect(inspectAudioBytes(samples.ogg)).toEqual({
            format: 'ogg', contentType: 'audio/ogg', extension: 'ogg',
        })
    })

    it('拒绝伪装 MIME、随机字节和空文件', () => {
        expect(() => inspectAudioUpload(samples.webm, 'audio/mpeg')).toThrow(/不一致/)
        expect(() => inspectAudioUpload(Buffer.from('not audio'), 'audio/wav')).toThrow(/不是可识别/)
        expect(() => inspectAudioUpload(Buffer.alloc(0), 'audio/wav')).toThrow(/不是可识别/)
    })
})
