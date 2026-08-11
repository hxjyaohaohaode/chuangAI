import { describe, expect, it } from 'vitest'
import { normalizeProtectedAudioUrl } from './protected-audio-reference.js'

describe('protected audio reference', () => {
    it.each([
        ['/audio/tts/tts_tongbian-001_alloy.mp3', '/api/recitation/audio/tts/tts_tongbian-001_alloy.mp3'],
        ['/api/recitation/audio/tts/tts_tongbian-001_voice_2.wav', '/api/recitation/audio/tts/tts_tongbian-001_voice_2.wav'],
        ['/audio/recitations/rec_student-001_abc_DEF-123.webm', '/api/recitation/audio/recitations/rec_student-001_abc_DEF-123.webm'],
        ['/api/recitation/audio/recitations/rec_anon_abc123.aac', '/api/recitation/audio/recitations/rec_anon_abc123.aac'],
    ])('标准化受控媒体路径 %s', (input, expected) => {
        expect(normalizeProtectedAudioUrl(input)).toBe(expected)
    })

    it.each([
        null,
        '',
        'https://127.0.0.1/internal.wav',
        '//example.test/audio.wav',
        '/api/recitation/audio/recitations/../tts/escape.wav',
        '/api/recitation/audio/recitations/rec_student_id.wav?download=1',
        '/api/recitation/audio/recitations/rec_student_id.wav#fragment',
        '/api/recitation/audio/recitations/rec_student\\escape.wav',
        '/api/recitation/audio/recitations/%2e%2e%2fescape.wav',
        '/api/recitation/audio/recitations/.env',
        '/api/recitation/audio/recitations/rec_student_id.exe',
        '/api/recitation/audio/tts/rec_student_id.wav',
        '/api/recitation/audio/recitations/tts_poem_alloy.wav',
    ])('拒绝非系统生成的媒体引用 %s', (input) => {
        expect(normalizeProtectedAudioUrl(input)).toBeNull()
    })
})
