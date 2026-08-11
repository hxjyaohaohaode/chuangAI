import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    authenticatedFetch: vi.fn(),
}))

vi.mock('./auth-session', () => ({
    authenticatedFetch: mocks.authenticatedFetch,
}))

import { api } from './api'

describe('workbench favorite API request contract', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubGlobal('window', {
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
        })
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('sends the explicit target state and returns the authoritative state', async () => {
        mocks.authenticatedFetch.mockResolvedValue(new Response(JSON.stringify({
            status: 'ok',
            questionId: 'question/001',
            favorited: true,
        }), { status: 200 }))

        const response = await api.workbench.setFavorite('question/001', true)

        expect(response).toEqual({ questionId: 'question/001', favorited: true })
        expect(mocks.authenticatedFetch).toHaveBeenCalledTimes(1)
        expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
            '/api/workbench/questions/question%2F001/favorite',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ favorited: true }),
                headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
            }),
        )
    })

    it('retries with the same target payload instead of issuing an implicit toggle', async () => {
        mocks.authenticatedFetch.mockImplementation(async () => new Response(JSON.stringify({
            status: 'ok',
            questionId: 'question-001',
            favorited: false,
        }), { status: 200 }))

        await api.workbench.setFavorite('question-001', false)
        await api.workbench.setFavorite('question-001', false)

        const requestBodies = mocks.authenticatedFetch.mock.calls.map((call) => (
            JSON.parse(String((call[1] as RequestInit).body)) as unknown
        ))
        expect(requestBodies).toEqual([{ favorited: false }, { favorited: false }])
        expect('toggleFavorite' in api.workbench).toBe(false)
    })
})
