import { describe, expect, it } from 'vitest'
import { assertSafeNetworkBoundary, isLoopbackHost } from './network-boundary.js'

describe('network boundary', () => {
    it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.18.20.30', '::1', '[::1]'])(
        '识别回环地址 %s',
        (host) => expect(isLoopbackHost(host)).toBe(true),
    )

    it.each(['0.0.0.0', '::', '192.168.1.20', '10.0.0.8', 'example.test', '']) (
        '不把可外部访问地址 %s 误判为回环',
        (host) => expect(isLoopbackHost(host)).toBe(false),
    )

    it('默认拒绝未认证的非回环监听', () => {
        expect(() => assertSafeNetworkBoundary({
            host: '0.0.0.0',
            allowUnauthenticatedNonLoopback: false,
        })).toThrow(/拒绝监听非回环地址/)
    })

    it('只在部署者显式确认边界时允许容器内部监听', () => {
        expect(() => assertSafeNetworkBoundary({
            host: '0.0.0.0',
            allowUnauthenticatedNonLoopback: true,
        })).not.toThrow()
    })

    it('允许密码认证且强制 Secure Cookie 的非回环监听', () => {
        expect(() => assertSafeNetworkBoundary({
            host: '0.0.0.0',
            allowUnauthenticatedNonLoopback: false,
            passwordAuthenticationEnabled: true,
            secureCookieConfigured: true,
        })).not.toThrow()
    })

    it('密码认证但 Cookie 不安全时仍拒绝非回环监听', () => {
        expect(() => assertSafeNetworkBoundary({
            host: '0.0.0.0',
            allowUnauthenticatedNonLoopback: false,
            passwordAuthenticationEnabled: true,
            secureCookieConfigured: false,
        })).toThrow(/AUTH_COOKIE_SECURE=true/)
    })
})
