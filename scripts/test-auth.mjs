/** Synthetic credentials for isolated regression children only; never use in deployment. */
import { randomBytes, scryptSync } from 'node:crypto'
export function createIsolatedAuth() {
    const phone = '13900000000'
    const password = randomBytes(32).toString('base64url')
    const salt = randomBytes(16)
    const digest = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })
    return {
        login: { phone, password },
        environment: {
            AUTH_MODE: 'password',
            AUTH_TEACHER_ID: 'teacher-001',
            AUTH_TEACHER_NAME: '隔离测试教师',
            AUTH_TEACHER_PHONE: phone,
            AUTH_PASSWORD_SCRYPT: `scrypt$16384$8$1$${salt.toString('base64url')}$${digest.toString('base64url')}`,
            AUTH_SESSION_SECRET: randomBytes(48).toString('base64url'),
            AUTH_COOKIE_SECURE: 'false',
            POETIC_ISOLATED_TEST: 'true',
            POETIC_TEST_PHONE: phone,
            POETIC_TEST_PASSWORD: password,
            DEEPSEEK_API_KEY: '', MIMO_API_KEY: '', DASHSCOPE_API_KEY: '',
            NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_PASSWORD: '',
        },
    }
}
export function isolatedLogin(environment = process.env) {
    if (environment.POETIC_ISOLATED_TEST !== 'true' || !environment.POETIC_TEST_PHONE || !environment.POETIC_TEST_PASSWORD) {
        throw new Error('必须从隔离测试编排器启动；不允许用默认演示身份向现有服务写入测试数据。')
    }
    return { phone: environment.POETIC_TEST_PHONE, password: environment.POETIC_TEST_PASSWORD }
}
