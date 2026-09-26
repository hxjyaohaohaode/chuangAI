import { randomBytes, scryptSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEMO_TEACHERS } from './security/auth.js'
import {
    assertValidAuthConfiguration,
    buildCorsOrigins,
    buildLoopbackCorsOrigins,
} from './config.js'

function validPasswordHash(): string {
    const salt = randomBytes(16)
    const expected = scryptSync('test-password', salt, 32, {
        N: 16_384,
        r: 8,
        p: 1,
        maxmem: 128 * 1024 * 1024,
    })
    return `scrypt$16384$8$1$${salt.toString('base64url')}$${expected.toString('base64url')}`
}

describe('authentication startup configuration', () => {
    it('将开发端与同源回环端显式写入 Origin 白名单，不从请求 Host 推导', () => {
        expect(buildLoopbackCorsOrigins(3001)).toEqual([
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'http://localhost:3001',
            'http://127.0.0.1:3001',
        ])
        expect(buildLoopbackCorsOrigins(5173)).toEqual([
            'http://localhost:5173',
            'http://127.0.0.1:5173',
        ])
    })

    it('把 Render 自动域名与显式自定义域名加入固定 Origin 白名单', () => {
        expect(buildCorsOrigins(
            3001,
            'https://teach.example.cn,https://teach.example.cn/',
            'https://poetic-realm.onrender.com',
            'development',
        )).toEqual([
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'http://localhost:3001',
            'http://127.0.0.1:3001',
            'https://teach.example.cn',
            'https://poetic-realm.onrender.com',
        ])
    })

    it('公网生产配置移除开发回环来源，仅保留精确 HTTPS Origin', () => {
        expect(buildCorsOrigins(
            10_000,
            'https://teach.example.cn',
            'https://poetic-realm.onrender.com',
            'production',
        )).toEqual([
            'https://teach.example.cn',
            'https://poetic-realm.onrender.com',
        ])
        expect(buildCorsOrigins(3001, '', '', 'production')).toEqual([
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'http://localhost:3001',
            'http://127.0.0.1:3001',
        ])
    })

    it('演示模式允许临时密钥，但拒绝弱显式密钥', () => {
        expect(() => assertValidAuthConfiguration({
            mode: 'demo', sessionSecret: '', passwordScrypt: '',
        })).not.toThrow()
        expect(() => assertValidAuthConfiguration({
            mode: 'demo', sessionSecret: 'weak', passwordScrypt: '',
        })).toThrow(/32 字节/)
    })

    it('密码模式要求持久强密钥和可执行的 scrypt 摘要', () => {
        expect(() => assertValidAuthConfiguration({
            mode: 'password', teacherPhone: '13900000000', sessionSecret: '', passwordScrypt: validPasswordHash(),
        })).toThrow(/必须配置/)
        expect(() => assertValidAuthConfiguration({
            mode: 'password', teacherPhone: '13900000000', sessionSecret: 'x'.repeat(32), passwordScrypt: 'scrypt$1048576$32$1$AA$AA',
        })).toThrow(/可执行/)
        expect(() => assertValidAuthConfiguration({
            mode: 'password', teacherPhone: '13900000000', sessionSecret: '密'.repeat(11), passwordScrypt: validPasswordHash(),
        })).not.toThrow()
        expect(() => assertValidAuthConfiguration({
            mode: 'password', sessionSecret: 'x'.repeat(32), passwordScrypt: validPasswordHash(),
        })).toThrow(/AUTH_TEACHER_PHONE/)
        expect(() => assertValidAuthConfiguration({
            mode: 'password', teacherPhone: '13900000000', sessionSecret: 'x'.repeat(32), passwordScrypt: DEMO_TEACHERS[0]!.passwordScrypt,
        })).toThrow(/必须轮换/)
    })
})
