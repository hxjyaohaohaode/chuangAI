import { describe, expect, it } from 'vitest'
import { parseEnvironment } from './environment.js'

describe('parseEnvironment', () => {
    it('空输入使用安全默认值', () => {
        const env = parseEnvironment({})
        expect(env.PORT).toBe(3001)
        expect(env.HOST).toBe('127.0.0.1')
        expect(env.DEMO_MODE).toBe('false')
        expect(env.ALLOW_UNAUTHENTICATED_NON_LOOPBACK).toBe('false')
        expect(env.AUTH_MODE).toBe('demo')
        expect(env.AUTH_SESSION_TTL_MINUTES).toBe(480)
        expect(env.AUTH_COOKIE_SECURE).toBe('auto')
        expect(env.WAN_IMAGE_MODEL).toBe('wan2.7-image')
        expect(env.WAN_IMAGE_BASE_URL).toBe('')
        expect(env.APP_DATA_DIR).toBe('')
        expect(env.PUBLIC_APP_ORIGINS).toBe('')
        expect(env.RENDER_EXTERNAL_URL).toBe('')
        expect(env.RENDER).toBe('false')
    })

    it('保留同一次解析中的全部有效显式配置', () => {
        const env = parseEnvironment({
            NODE_ENV: 'production',
            PORT: '4310',
            HOST: '0.0.0.0',
            SQLITE_PATH: 'var/data/lesson.db',
            APP_DATA_DIR: '/var/data',
            PUBLIC_APP_ORIGINS: 'https://teach.example.cn',
            RENDER_EXTERNAL_URL: 'https://poetic-realm.onrender.com',
            RENDER: 'true',
            DEMO_MODE: 'true',
            ALLOW_UNAUTHENTICATED_NON_LOOPBACK: 'true',
            AUTH_MODE: 'password',
            AUTH_SESSION_TTL_MINUTES: '60',
            AUTH_COOKIE_SECURE: 'true',
        })
        expect(env).toMatchObject({
            NODE_ENV: 'production',
            PORT: 4310,
            HOST: '0.0.0.0',
            SQLITE_PATH: 'var/data/lesson.db',
            APP_DATA_DIR: '/var/data',
            PUBLIC_APP_ORIGINS: 'https://teach.example.cn',
            RENDER_EXTERNAL_URL: 'https://poetic-realm.onrender.com',
            RENDER: 'true',
            DEMO_MODE: 'true',
            ALLOW_UNAUTHENTICATED_NON_LOOPBACK: 'true',
            AUTH_MODE: 'password',
            AUTH_SESSION_TTL_MINUTES: 60,
            AUTH_COOKIE_SECURE: 'true',
        })
    })

    it.each(['0', '65536', 'not-a-port'])('拒绝非法端口 %s', (port) => {
        expect(() => parseEnvironment({ PORT: port })).toThrow(/PORT/)
    })

    it('拒绝拼写错误的演示模式，而不是静默切换为 false', () => {
        expect(() => parseEnvironment({ DEMO_MODE: 'treu' })).toThrow(/DEMO_MODE/)
    })

    it('只接受 Render 官方布尔标志的精确值', () => {
        expect(parseEnvironment({ RENDER: 'true' }).RENDER).toBe('true')
        expect(() => parseEnvironment({ RENDER: 'yes' })).toThrow(/RENDER/)
        expect(() => parseEnvironment({ RENDER: 'TRUE' })).toThrow(/RENDER/)
    })

    it('拒绝含糊的非回环例外值', () => {
        expect(() => parseEnvironment({
            ALLOW_UNAUTHENTICATED_NON_LOOPBACK: 'yes',
        })).toThrow(/ALLOW_UNAUTHENTICATED_NON_LOOPBACK/)
    })

    it('拒绝非法认证模式、会话时长与 Cookie 策略', () => {
        expect(() => parseEnvironment({ AUTH_MODE: 'anonymous' })).toThrow(/AUTH_MODE/)
        expect(() => parseEnvironment({ AUTH_SESSION_TTL_MINUTES: '2' })).toThrow(/AUTH_SESSION_TTL_MINUTES/)
        expect(() => parseEnvironment({ AUTH_COOKIE_SECURE: 'sometimes' })).toThrow(/AUTH_COOKIE_SECURE/)
    })

    it('严格拒绝可扩大公网 Origin 白名单的配置', () => {
        for (const value of [
            'http://school.example.cn',
            'https://*.example.cn',
            'https://teacher:secret@example.cn',
            'https://example.cn/app',
            'https://example.cn,',
        ]) {
            expect(() => parseEnvironment({ PUBLIC_APP_ORIGINS: value }))
                .toThrow(/PUBLIC_APP_ORIGINS/)
        }
        expect(() => parseEnvironment({ RENDER_EXTERNAL_URL: 'http://localhost:3001' }))
            .toThrow(/RENDER_EXTERNAL_URL/)
    })

    it('拒绝 APP_DATA_DIR 中的空字节', () => {
        expect(() => parseEnvironment({ APP_DATA_DIR: '/var/data\0escape' }))
            .toThrow(/APP_DATA_DIR/)
    })

    it('错误消息不回显敏感字段值', () => {
        const secret = 'super-secret-value'
        expect(() => parseEnvironment({
            DEEPSEEK_API_KEY: secret,
            DEEPSEEK_BASE_URL: 'not-a-url',
        })).toThrowError(expect.not.stringContaining(secret))
    })

    it('只允许项目官方模型端点，Wan 必须使用北京 Workspace 同步端点', () => {
        expect(() => parseEnvironment({
            DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1/',
            MIMO_BASE_URL: 'https://api.xiaomimimo.com/v1/',
            WAN_IMAGE_BASE_URL: 'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation/',
        })).not.toThrow()
        for (const [field, value] of [
            ['DEEPSEEK_BASE_URL', 'http://api.deepseek.com'],
            ['DEEPSEEK_BASE_URL', 'https://api.deepseek.com.evil.test'],
            ['DEEPSEEK_BASE_URL', 'https://user@api.deepseek.com/v1'],
            ['MIMO_BASE_URL', 'https://api.xiaomimimo.com:8443/v1'],
            ['MIMO_BASE_URL', 'https://api.xiaomimimo.com/v1?target=evil'],
            ['WAN_IMAGE_BASE_URL', 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'],
            ['WAN_IMAGE_BASE_URL', 'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/other'],
            ['WAN_IMAGE_BASE_URL', 'https://workspace-123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'],
        ] as const) {
            expect(() => parseEnvironment({ [field]: value })).toThrow(new RegExp(field))
        }
    })

    it('拒绝用 pro 变体替换项目官方文件指定的 wan2.7-image', () => {
        expect(() => parseEnvironment({ WAN_IMAGE_MODEL: 'wan2.7-image-pro' }))
            .toThrow(/WAN_IMAGE_MODEL/)
    })
})
