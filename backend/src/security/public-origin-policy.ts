import { isLoopbackHost } from './network-boundary.js'

/**
 * 将一个配置值收敛为浏览器 Origin（scheme + host + optional port）。
 *
 * 公网来源必须使用 HTTPS；HTTP 只允许明确的回环主机，供本地开发使用。
 * 路径、查询、片段、凭据和通配符全部失败关闭，避免把看似相近但语义更宽的
 * URL 误当作 CORS/CSRF/WebSocket 白名单。
 */
export function normalizeTrustedAppOrigin(value: string): string {
    const candidate = value.trim()
    if (!candidate || candidate.includes('*')) {
        throw new Error('来源必须是非空且不含通配符的绝对 Origin')
    }

    let parsed: URL
    try {
        parsed = new URL(candidate)
    } catch {
        throw new Error('来源必须是合法的绝对 URL')
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('来源只允许 https；本地回环开发可使用 http')
    }
    if (parsed.username || parsed.password) {
        throw new Error('来源不得包含用户名或密码')
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error('来源不得包含路径、查询参数或片段')
    }
    if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
        throw new Error('非回环来源必须使用 https')
    }

    return parsed.origin
}

/** 解析逗号分隔的 PUBLIC_APP_ORIGINS；空字符串表示没有额外自定义域名。 */
export function parsePublicAppOrigins(value: string): readonly string[] {
    if (value.trim() === '') return []

    const entries = value.split(',')
    if (entries.some((entry) => entry.trim() === '')) {
        throw new Error('PUBLIC_APP_ORIGINS 不得包含空条目')
    }

    return [...new Set(entries.map(normalizeTrustedAppOrigin))]
}

/** Render 提供的外部地址只能是单一 HTTPS Origin。 */
export function parseRenderExternalOrigin(value: string): readonly string[] {
    if (value.trim() === '') return []
    const origin = normalizeTrustedAppOrigin(value)
    if (!origin.startsWith('https://')) {
        throw new Error('RENDER_EXTERNAL_URL 必须是 HTTPS Origin')
    }
    return [origin]
}

export function parseTrustedDeploymentOrigins(
    publicAppOrigins: string,
    renderExternalUrl: string,
): readonly string[] {
    return [...new Set([
        ...parsePublicAppOrigins(publicAppOrigins),
        ...parseRenderExternalOrigin(renderExternalUrl),
    ])]
}
