export interface NetworkBoundaryOptions {
    host: string
    allowUnauthenticatedNonLoopback: boolean
    passwordAuthenticationEnabled?: boolean
    secureCookieConfigured?: boolean
}

/**
 * 仅判定明确的回环监听地址。空字符串、通配地址和局域网地址都不视为安全。
 * `127.0.0.0/8` 均为 IPv4 loopback；IPv6 只接受 `::1`。
 */
export function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
    return normalized === 'localhost'
        || normalized === '::1'
        || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

/**
 * 裸机服务默认只能监听回环地址。非回环部署只有两条可接受路径：密码认证并强制
 * Secure Cookie，或显式声明其只是受控容器内网且外层入口仍绑定回环地址。
 */
export function assertSafeNetworkBoundary(options: NetworkBoundaryOptions): void {
    if (isLoopbackHost(options.host)) return
    if (options.passwordAuthenticationEnabled && options.secureCookieConfigured) return
    if (options.allowUnauthenticatedNonLoopback) return

    throw new Error(
        `拒绝监听非回环地址 ${options.host}：必须启用密码认证并设置 AUTH_COOKIE_SECURE=true。`
        + '请改用 HOST=127.0.0.1；仅当容器端口已被严格限制在可信边界内时，'
        + '才可显式设置 ALLOW_UNAUTHENTICATED_NON_LOOPBACK=true。',
    )
}
