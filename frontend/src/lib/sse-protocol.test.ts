import { describe, expect, it } from 'vitest'

import {
    STREAM_TRUNCATED_ERROR_MESSAGE,
    errorFromSseFrame,
    requireExplicitSseTerminal,
} from './sse-protocol'

describe('SSE protocol completion boundary', () => {
    it('accepts an explicit protocol terminal', () => {
        expect(requireExplicitSseTerminal(true, new AbortController().signal)).toBe(true)
    })

    it('rejects a clean EOF before any terminal frame', () => {
        expect(() => requireExplicitSseTerminal(false, new AbortController().signal))
            .toThrow(STREAM_TRUNCATED_ERROR_MESSAGE)
    })

    it('keeps an active user abort silent instead of reporting success or failure', () => {
        const controller = new AbortController()
        controller.abort()
        expect(requireExplicitSseTerminal(false, controller.signal)).toBe(false)
    })

    it('does not silence a non-user abort that reaches a clean EOF', () => {
        const controller = new AbortController()
        controller.abort('stream-idle-timeout')
        expect(() => requireExplicitSseTerminal(false, controller.signal))
            .toThrow(STREAM_TRUNCATED_ERROR_MESSAGE)
    })

    it('maps error codes without exposing a server/provider message', () => {
        const secret = '401 api-key=sk-sensitive provider-host=internal.example system prompt follows'
        const known = errorFromSseFrame({ error: 'CHAT_STREAM_FAILED', message: secret })
        const unknown = errorFromSseFrame({ error: secret, message: secret })

        expect(known.message).toBe('AI 对话生成失败，请稍后重试')
        expect(unknown.message).toBe('流式处理失败，请稍后重试')
        expect(known.message).not.toContain('sk-sensitive')
        expect(unknown.message).not.toContain('internal.example')
    })
})
