/**
 * 判断生产静态托管的未命中请求是否应回退到 SPA index.html。
 *
 * 只允许浏览器页面导航回退；API、上传资源、写请求和非 HTML 资源必须保留 404。
 */
export function shouldServeSpaFallback(params: {
    method: string
    url: string
    accept?: string
}): boolean {
    const method = params.method.toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return false

    const pathname = params.url.split('?', 1)[0] ?? '/'
    if (
        pathname === '/api'
        || pathname.startsWith('/api/')
        || pathname === '/uploads'
        || pathname.startsWith('/uploads/')
    ) {
        return false
    }

    return (params.accept ?? '').toLowerCase().includes('text/html')
}

/**
 * 公开报告页的 URL 自身携带 bearer capability，首份 SPA HTML 响应
 * 必须在 React 运行之前就禁止缓存、索引和 Referrer 外发。这里只判断
 * 产品定义的唯一公开页前缀，不会扩大其他 SPA 路由的公开语义。
 */
export function isPublicSharedReportPage(url: string): boolean {
    const pathname = url.split(/[?#]/u, 1)[0] ?? ''
    return pathname.startsWith('/shared/report/')
}
