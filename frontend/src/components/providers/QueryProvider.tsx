import type { ComponentType, PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/auth'
import type { AuthState } from '@/stores/auth'

/** Shared within one identity/class only. Never reuse a previous teacher's cache. */
export function queryScope(state: Pick<AuthState, 'isAuthenticated' | 'userId' | 'role' | 'classId'>): string {
    return JSON.stringify([state.isAuthenticated, state.userId, state.role, state.classId])
}
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0
    if ([400, 401, 403, 404, 409, 413, 422, 429].includes(status)) return false
    return failureCount < 1
}
function createClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 30_000,
                gcTime: 10 * 60_000,
                retry: shouldRetryQuery,
                refetchOnWindowFocus: true,
                refetchOnReconnect: true,
            },
            mutations: { retry: false },
        },
    })
}
let currentScope = queryScope(useAuthStore.getState())
/** Live ESM binding: existing invalidation call sites always see the active client. */
export let queryClient = createClient()
const unsubscribeAuth = useAuthStore.subscribe((state) => {
    const nextScope = queryScope(state)
    if (nextScope === currentScope) return
    currentScope = nextScope
    const previous = queryClient
    queryClient = createClient()
    // Explicitly capture the retired client: late promises must never clear the new cache.
    void previous.cancelQueries().catch(() => undefined)
    previous.clear()
})
if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        unsubscribeAuth()
        void queryClient.cancelQueries().catch(() => undefined)
        queryClient.clear()
    })
}
export function QueryProvider({ children }: PropsWithChildren) {
    const scope = useAuthStore(queryScope)
    return <QueryClientProvider key={scope} client={queryClient}>{children}</QueryClientProvider>
}
export function withQueryProvider<P extends object>(Component: ComponentType<P>): ComponentType<P> {
    function QueryEnabledComponent(props: P) {
        return <QueryProvider><Component {...props} /></QueryProvider>
    }
    QueryEnabledComponent.displayName = `withQueryProvider(${Component.displayName ?? Component.name ?? 'Page'})`
    return QueryEnabledComponent
}
