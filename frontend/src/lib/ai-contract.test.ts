import { describe, expect, it } from 'vitest'
import { parseAiAsrResponse, parseAiImageGenerateResponse } from './ai-contract'

function realImageResponse() {
    return {
        status: 'ok',
        images: [{
            id: 'wan-request-1',
            url: '/uploads/generated/example.webp',
            prompt: '月夜水墨画',
            verse: '床前明月光',
            orientation: 'landscape',
            model: 'wan2.7-image',
            requestedModel: 'wan2.7-image',
            createdAt: 1_700_000_000_000,
            cached: false,
            aiGenerated: true,
            demo: false,
            degraded: false,
        }],
        model: 'wan2.7-image',
        requestedModel: 'wan2.7-image',
        requestId: 'wan-request-1',
        aiGenerated: true,
        demo: false,
        degraded: false,
    }
}

describe('AI image response contract', () => {
    it('accepts a provenance-consistent real Wan2.7 response', () => {
        const parsed = parseAiImageGenerateResponse(realImageResponse())

        expect(parsed.status).toBe('ok')
        expect(parsed.images[0]?.model).toBe('wan2.7-image')
        expect(parsed.aiGenerated).toBe(true)
        expect(parsed.degraded).toBe(false)
    })

    it('rejects a former local demo SVG placeholder instead of treating it as success', () => {
        expect(() => parseAiImageGenerateResponse({
            status: 'degraded',
            images: [{
                id: 'local-1',
                url: 'data:image/svg+xml;base64,PHN2Zy8+',
                prompt: '月夜水墨画',
                orientation: 'portrait',
                model: 'local-placeholder',
                requestedModel: 'wan2.7-image',
                createdAt: 1,
                cached: false,
                aiGenerated: false,
                demo: true,
                degraded: true,
            }],
            model: 'local-placeholder',
            requestedModel: 'wan2.7-image',
            aiGenerated: false,
            demo: true,
            degraded: true,
            degradationReason: 'demo-mode',
        })).toThrow(/只允许真实 wan2.7-image/)
    })

    it('rejects the former backend shape instead of creating a fake frontend success', () => {
        expect(() => parseAiImageGenerateResponse({
            imageUrl: '/uploads/generated/legacy.webp',
            model: 'wan2.7-image',
            demo: false,
        })).toThrow(/images/)
    })

    it('rejects a local SVG that claims to be a real Wan result', () => {
        const forged = realImageResponse()
        forged.images[0]!.url = 'data:image/svg+xml;base64,PHN2Zy8+'

        expect(() => parseAiImageGenerateResponse(forged)).toThrow(/禁止把 SVG/)
    })

    it('rejects an external URL disguised as a local degraded placeholder', () => {
        expect(() => parseAiImageGenerateResponse({
            status: 'degraded',
            images: [{
                id: 'local-1',
                url: 'https://example.test/tracker.svg',
                prompt: '月夜水墨画',
                orientation: 'landscape',
                model: 'local-placeholder',
                requestedModel: 'wan2.7-image',
                createdAt: 1,
                cached: false,
                aiGenerated: false,
                demo: false,
                degraded: true,
            }],
            model: 'local-placeholder',
            requestedModel: 'wan2.7-image',
            aiGenerated: false,
            demo: false,
            degraded: true,
            degradationReason: 'provider-failed',
        })).toThrow(/只允许真实 wan2.7-image/)
    })
})

describe('AI ASR response contract', () => {
    it('accepts a real MiMo transcription with a score derived by the server', () => {
        const parsed = parseAiAsrResponse({
            status: 'ok',
            transcript: '床前明月',
            audioDurationSec: 2.4,
            confidence: 0.82,
            similarityScore: 80,
            model: 'mimo-v2.5-asr',
            requestedModel: 'mimo-v2.5-asr',
            aiGenerated: true,
            demo: false,
            degraded: false,
        })

        expect(parsed.transcript).toBe('床前明月')
        expect(parsed.similarityScore).toBe(80)
    })

    it('accepts a demo response only when it contains no fake transcript or score', () => {
        const parsed = parseAiAsrResponse({
            status: 'degraded',
            transcript: '',
            audioDurationSec: 0,
            model: 'local-placeholder',
            requestedModel: 'mimo-v2.5-asr',
            aiGenerated: false,
            demo: true,
            degraded: true,
            degradationReason: 'demo-mode',
        })

        expect(parsed.transcript).toBe('')
        expect(parsed.similarityScore).toBeUndefined()
        expect(parsed.aiGenerated).toBe(false)
    })

    it('rejects the former demo shortcut that copied referenceText and awarded 100', () => {
        expect(() => parseAiAsrResponse({
            status: 'degraded',
            transcript: '床前明月光',
            audioDurationSec: 1,
            similarityScore: 100,
            model: 'local-placeholder',
            requestedModel: 'mimo-v2.5-asr',
            aiGenerated: false,
            demo: true,
            degraded: true,
            degradationReason: 'demo-mode',
        })).toThrow(/不得携带伪造转写/)
    })

    it('rejects the former backend text/durationSec field names', () => {
        expect(() => parseAiAsrResponse({
            text: '床前明月光',
            durationSec: 2,
            model: 'mimo-v2.5-asr',
            demo: false,
        })).toThrow(/transcript/)
    })
})
