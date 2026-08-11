export type ModelProviderEndpoint = 'deepseek' | 'mimo' | 'wan-image'

const WAN_IMAGE_SYNC_PATH = '/api/v1/services/aigc/multimodal-generation/generation'
const WAN_BEIJING_WORKSPACE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com$/u

const ALLOWED_ENDPOINTS: Record<Exclude<ModelProviderEndpoint, 'wan-image'>, {
    hostname: string
    paths: ReadonlySet<string>
}> = {
    deepseek: {
        hostname: 'api.deepseek.com',
        paths: new Set(['/', '/v1']),
    },
    mimo: {
        hostname: 'api.xiaomimimo.com',
        paths: new Set(['/v1']),
    },
}

/**
 * 防止被篡改的 `*_BASE_URL` 把教师配置的 API Key 发送到攻击者主机。
 * 竞赛交付只使用官方端点；任意代理/镜像需要单独安全设计，不能靠放宽这里实现。
 */
export function isTrustedProviderEndpoint(provider: ModelProviderEndpoint, value: string): boolean {
    try {
        const url = new URL(value)
        const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, '') : '/'
        const commonBoundary = url.protocol === 'https:'
            && !url.username
            && !url.password
            && (!url.port || url.port === '443')
            && !url.search
            && !url.hash
        if (!commonBoundary) return false

        if (provider === 'wan-image') {
            return WAN_BEIJING_WORKSPACE_HOST.test(url.hostname.toLowerCase())
                && path === WAN_IMAGE_SYNC_PATH
        }

        const rule = ALLOWED_ENDPOINTS[provider]
        return url.hostname.toLowerCase() === rule.hostname && rule.paths.has(path)
    } catch {
        return false
    }
}
