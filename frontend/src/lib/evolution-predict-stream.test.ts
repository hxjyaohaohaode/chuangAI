import { describe, expect, it, vi } from 'vitest'

import {
    consumeEvolutionPredictionStream,
    isEvolutionPredictionResult,
    parseEvolutionPredictionFrame,
} from './evolution-predict-stream'
import type { EvolutionPredictionResult } from './types'

const encoder = new TextEncoder()

function validResult(): EvolutionPredictionResult {
    return {
        predictions: [{
            direction: '强化事实核验',
            suggestion: '为诗人生平与典故输出增加出处证据和教师复核门。',
            expectedImprovement: 0.16,
            confidence: 0.86,
        }],
        confidence: 0.84,
        aiGenerated: true,
        generatedAt: 1_788_000_000_000,
    }
}

function sseFrame(data: unknown): string {
    const serialized = typeof data === 'string' ? data : JSON.stringify(data)
    return `data: ${serialized}\r\n\r\n`
}

function streamFromText(text: string, byteChunkSize = Number.MAX_SAFE_INTEGER): ReadableStream<Uint8Array> {
    const bytes = encoder.encode(text)
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (let offset = 0; offset < bytes.length; offset += byteChunkSize) {
                controller.enqueue(bytes.slice(offset, Math.min(bytes.length, offset + byteChunkSize)))
            }
            controller.close()
        },
    })
}

describe('evolution prediction SSE parser', () => {
    it('accepts only done(result) followed by [DONE], including CRLF and split UTF-8 bytes', async () => {
        const result = validResult()
        const payload = [
            sseFrame({ type: 'token', token: '核验诗意与出处' }),
            sseFrame({ type: 'done', result }),
            sseFrame('[DONE]'),
        ].join('')
        const onToken = vi.fn()

        const parsed = await consumeEvolutionPredictionStream(streamFromText(payload, 1), {
            signal: new AbortController().signal,
            onToken,
        })

        expect(parsed).toEqual(result)
        expect(onToken).toHaveBeenCalledTimes(1)
        expect(onToken).toHaveBeenCalledWith('核验诗意与出处')
    })

    it('rejects a clean EOF after tokens instead of manufacturing an empty success', async () => {
        const payload = sseFrame({ type: 'token', token: '尚未完成' })
        await expect(consumeEvolutionPredictionStream(streamFromText(payload), {
            signal: new AbortController().signal,
        })).rejects.toThrow('进化预测流提前结束')
    })

    it('requires both layers of completion in the correct order', async () => {
        const result = validResult()
        await expect(consumeEvolutionPredictionStream(
            streamFromText(sseFrame({ type: 'done', result })),
            { signal: new AbortController().signal },
        )).rejects.toThrow('进化预测流提前结束')

        await expect(consumeEvolutionPredictionStream(
            streamFromText(sseFrame('[DONE]')),
            { signal: new AbortController().signal },
        )).rejects.toThrow('进化预测流协议异常')
    })

    it('rejects malformed, partial, extra-field and out-of-range results', async () => {
        const missingField = {
            ...validResult(),
            predictions: [{
                direction: '缺字段',
                suggestion: '该对象没有 expectedImprovement',
                confidence: 0.8,
            }],
        }
        expect(isEvolutionPredictionResult(missingField)).toBe(false)
        expect(() => parseEvolutionPredictionFrame(JSON.stringify({
            type: 'done',
            result: missingField,
        }))).toThrow('进化预测流协议异常')

        expect(() => parseEvolutionPredictionFrame(JSON.stringify({
            type: 'done',
            result: { ...validResult(), confidence: 1.1 },
        }))).toThrow('进化预测流协议异常')

        expect(() => parseEvolutionPredictionFrame(JSON.stringify({
            type: 'done',
            result: { ...validResult(), unexpected: true },
        }))).toThrow('进化预测流协议异常')

        await expect(consumeEvolutionPredictionStream(
            streamFromText('data: {"type":"done","result":{"predictions":'),
            { signal: new AbortController().signal },
        )).rejects.toThrow('进化预测流提前结束')
    })

    it('surfaces only the stable server error frame', async () => {
        await expect(consumeEvolutionPredictionStream(streamFromText(sseFrame({
            type: 'error',
            code: 'EVOLUTION_PREDICTION_FAILED',
            message: '进化预测暂时不可用，请稍后重试。',
        })), {
            signal: new AbortController().signal,
        })).rejects.toMatchObject({
            name: 'EvolutionPredictionServerError',
            code: 'EVOLUTION_PREDICTION_FAILED',
            message: '进化预测暂时不可用，请稍后重试。',
        })
    })

    it('cancels quietly through AbortSignal without converting user abort into protocol success', async () => {
        let cancelled = false
        let resolveTokenSeen: (() => void) | undefined
        const tokenSeen = new Promise<void>((resolve) => {
            resolveTokenSeen = resolve
        })
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(sseFrame({ type: 'token', token: '部分结果' })))
            },
            cancel() {
                cancelled = true
            },
        })
        const controller = new AbortController()
        const pending = consumeEvolutionPredictionStream(stream, {
            signal: controller.signal,
            onToken: () => resolveTokenSeen?.(),
        })

        await tokenSeen
        controller.abort()

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(cancelled).toBe(true)
    })
})
