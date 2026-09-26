import { afterEach, describe, expect, it } from 'vitest'
import { useAuthStore } from '@/stores/auth'
import * as scope from './QueryProvider'
const original = useAuthStore.getState()
afterEach(() => { useAuthStore.setState(original); scope.queryClient.clear() })
function login(userId = 'teacher-a', classId = 'class-a') {
    useAuthStore.setState({ userId, classId, role: 'teacher', isAuthenticated: true })
}
describe('query data ownership', () => {
    it('does not share cached data between two authenticated teachers', () => {
        login(); const previous = scope.queryClient
        previous.setQueryData(['students'], [{ name: 'private student' }])
        login('teacher-b')
        expect(scope.queryClient).not.toBe(previous)
        expect(scope.queryClient.getQueryData(['students'])).toBeUndefined()
        expect(previous.getQueryData(['students'])).toBeUndefined()
    })
    it('isolates classes even when old pages omitted classId from a query key', () => {
        login(); scope.queryClient.setQueryData(['grades'], [7])
        useAuthStore.getState().setClass('class-b')
        expect(scope.queryClient.getQueryData(['grades'])).toBeUndefined()
    })
    it('revokes query and mutation caches on logout', () => {
        login(); const old = scope.queryClient
        old.setQueryData(['report'], { confidential: true })
        old.getMutationCache().build(old, { mutationKey: ['write'] })
        useAuthStore.getState().logout()
        expect(old.getQueryCache().getAll()).toHaveLength(0)
        expect(old.getMutationCache().getAll()).toHaveLength(0)
        expect(scope.queryClient).not.toBe(old)
    })
    it('retains the current cache for display-name-only changes', () => {
        login(); const current = scope.queryClient; current.setQueryData(['poems'], [1])
        useAuthStore.setState({ userName: 'New display name' })
        expect(scope.queryClient).toBe(current); expect(current.getQueryData(['poems'])).toEqual([1])
    })
    it('cannot repopulate a new identity cache with an old delayed response', async () => {
        login(); const old = scope.queryClient
        let complete!: (value: string) => void
        const request = old.fetchQuery({ queryKey: ['private'], queryFn: () => new Promise<string>(resolve => { complete = resolve }) }).catch(() => undefined)
        login('teacher-b'); const next = scope.queryClient
        complete('old account data'); await request
        expect(next.getQueryData(['private'])).toBeUndefined()
        expect(old.getQueryData(['private'])).toBeUndefined()
    })
    it('does not confuse delimiter-containing identifiers', () => {
        const base = { isAuthenticated: true, role: 'teacher' as const }
        expect(scope.queryScope({ ...base, userId: 'a:b', classId: 'c' })).not.toBe(scope.queryScope({ ...base, userId: 'a', classId: 'b:c' }))
    })
    it.each([400, 401, 403, 404, 409, 413, 422, 429])('does not automatically retry HTTP %i', status => {
        expect(scope.shouldRetryQuery(0, { status })).toBe(false)
    })
    it('limits transient read retries and never enables automatic mutation retries', () => {
        expect(scope.shouldRetryQuery(0, { status: 503 })).toBe(true)
        expect(scope.shouldRetryQuery(1, { status: 503 })).toBe(false)
        expect(scope.queryClient.getDefaultOptions().mutations?.retry).toBe(false)
    })
})
