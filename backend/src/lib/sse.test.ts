import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import {
    bindSseDisconnectAbort,
    createPublicSseError,
    formatSseFrame,
    writeSseFrame,
    type SseRequestLike,
    type SseResponseLike,
} from './sse.js'

class FakeRequest extends EventEmitter implements SseRequestLike {
    aborted = false
}

class FakeResponse extends EventEmitter implements SseResponseLike {
    destroyed = false
    writableEnded = false
    nextWriteResult = true
    readonly writes: string[] = []

    write(chunk: string): boolean {
        this.writes.push(chunk)
        return this.nextWriteResult
    }
}

describe('SSE lifecycle primitives', () => {
    it('serializes normal and completion frames without allowing raw newlines', () => {
        expect(formatSseFrame({ delta: '春晓' })).toBe('data: {"delta":"春晓"}\n\n')
        expect(formatSseFrame('[DONE]')).toBe('data: [DONE]\n\n')
    })

    it('declassifies provider failures before serializing a hijacked response', () => {
        const secretCause = new Error('401 api-key=sk-sensitive provider-host=internal.example')
        const publicError = createPublicSseError('CHAT_STREAM_FAILED', secretCause)
        const serialized = formatSseFrame(publicError)

        expect(publicError).toEqual({
            error: 'CHAT_STREAM_FAILED',
            message: 'AI 对话生成失败，请稍后重试',
        })
        expect(serialized).not.toContain('sk-sensitive')
        expect(serialized).not.toContain('internal.example')
        expect(serialized).not.toContain(secretCause.message)
    })

    it('never serializes provider chain-of-thought or nested reasoning fields', () => {
        const sensitiveReasoning = 'system prompt: secret rubric; api-key=sk-private'

        expect(formatSseFrame({ reasoning: sensitiveReasoning, content: '可公开答案' }))
            .toBe('data: {"content":"可公开答案"}\n\n')
        expect(formatSseFrame({
            content: '可公开答案',
            metadata: { reasoning_content: sensitiveReasoning, model: 'deepseek-v4-pro' },
        })).toBe('data: {"content":"可公开答案","metadata":{"model":"deepseek-v4-pro"}}\n\n')
        expect(formatSseFrame({ type: 'reasoning', content: sensitiveReasoning }))
            .toBe(': private-reasoning-redacted\n\n')
    })

    it('writes immediately when the response accepts the frame', async () => {
        const response = new FakeResponse()
        const result = await writeSseFrame(response, { delta: '春' }, new AbortController().signal)
        expect(result).toBe(true)
        expect(response.writes).toEqual(['data: {"delta":"春"}\n\n'])
    })

    it('waits for drain before allowing an upstream iterator to continue', async () => {
        const response = new FakeResponse()
        response.nextWriteResult = false
        const pending = writeSseFrame(response, { delta: '晓' }, new AbortController().signal)
        let settled = false
        void pending.then(() => { settled = true })
        await Promise.resolve()
        expect(settled).toBe(false)
        response.emit('drain')
        await expect(pending).resolves.toBe(true)
    })

    it('fails closed when a backpressured peer closes or the request is aborted', async () => {
        const closeResponse = new FakeResponse()
        closeResponse.nextWriteResult = false
        const onClose = writeSseFrame(closeResponse, { delta: '夜' }, new AbortController().signal)
        closeResponse.destroyed = true
        closeResponse.emit('close')
        await expect(onClose).resolves.toBe(false)

        const abortResponse = new FakeResponse()
        abortResponse.nextWriteResult = false
        const controller = new AbortController()
        const onAbort = writeSseFrame(abortResponse, { delta: '思' }, controller.signal)
        controller.abort()
        await expect(onAbort).resolves.toBe(false)
    })

    it('bounds a permanently backpressured stream', async () => {
        const response = new FakeResponse()
        response.nextWriteResult = false
        await expect(writeSseFrame(response, { delta: '明' }, new AbortController().signal, {
            backpressureTimeoutMs: 5,
        })).resolves.toBe(false)
    })

    it('aborts on either connection half closing and removes both listeners', () => {
        const request = new FakeRequest()
        const response = new FakeResponse()
        const controller = new AbortController()
        const cleanup = bindSseDisconnectAbort(request, response, controller)
        expect(request.listenerCount('aborted')).toBe(1)
        expect(response.listenerCount('close')).toBe(1)
        request.aborted = true
        request.emit('aborted')
        expect(controller.signal.aborted).toBe(true)
        cleanup()
        expect(request.listenerCount('aborted')).toBe(0)
        expect(response.listenerCount('close')).toBe(0)
    })
})
