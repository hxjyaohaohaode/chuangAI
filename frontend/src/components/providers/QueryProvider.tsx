import type { ComponentType, PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * 查询客户端只创建一次，路由切换时复用缓存；Provider 本身下沉到真正使用
 * TanStack Query 的懒加载边界，避免 11KB+ gzip 查询运行时污染登录页与应用外壳。
 */
export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 5 * 60 * 1000,
            retry: 1,
            refetchOnWindowFocus: false,
        },
    },
})

export function QueryProvider({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

export function withQueryProvider<P extends object>(Component: ComponentType<P>): ComponentType<P> {
    function QueryEnabledComponent(props: P) {
        return (
            <QueryProvider>
                <Component {...props} />
            </QueryProvider>
        )
    }

    QueryEnabledComponent.displayName = `withQueryProvider(${Component.displayName ?? Component.name ?? 'Page'})`
    return QueryEnabledComponent
}
