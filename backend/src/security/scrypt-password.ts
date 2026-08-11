import { scrypt, timingSafeEqual } from 'node:crypto'

const SCRYPT_MAX_MEMORY = 128 * 1024 * 1024

export interface SupportedScryptHash {
    N: number
    r: number
    p: number
    salt: Buffer
    expected: Buffer
}

/**
 * 解析本项目唯一接受的密码摘要格式，并在启动期排除不可执行或资源失控的参数。
 * 返回 null 而不是抛错，避免认证失败泄露具体配置细节。
 */
export function parseSupportedScryptHash(encodedHash: string): SupportedScryptHash | null {
    const [algorithm, nText, rText, pText, saltText, expectedText, extra] = encodedHash.split('$')
    if (algorithm !== 'scrypt'
        || extra !== undefined
        || !nText
        || !rText
        || !pText
        || !saltText
        || !expectedText
        || !/^[A-Za-z0-9_-]+$/u.test(saltText)
        || !/^[A-Za-z0-9_-]+$/u.test(expectedText)) {
        return null
    }

    const N = Number(nText)
    const r = Number(rText)
    const p = Number(pText)
    if (!Number.isInteger(N) || N < 16_384 || N > 1_048_576 || (N & (N - 1)) !== 0) return null
    if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null

    // Node.js scrypt 在近似内存 128 * N * r 超过 maxmem 时必然失败；启动期直接拒绝。
    const estimatedMemory = 128 * N * r + 128 * r * p + 1_024
    if (!Number.isSafeInteger(estimatedMemory) || estimatedMemory >= SCRYPT_MAX_MEMORY) return null

    const salt = Buffer.from(saltText, 'base64url')
    const expected = Buffer.from(expectedText, 'base64url')
    // 强制规范 Base64URL，避免多种文本编码映射到同一字节串。
    if (salt.toString('base64url') !== saltText || expected.toString('base64url') !== expectedText) return null
    if (salt.length < 16 || salt.length > 128 || expected.length < 32 || expected.length > 128) return null

    return { N, r, p, salt, expected }
}

export function isSupportedScryptHash(encodedHash: string): boolean {
    return parseSupportedScryptHash(encodedHash) !== null
}

export async function verifyScryptPassword(password: string, encodedHash: string): Promise<boolean> {
    const parsed = parseSupportedScryptHash(encodedHash)
    if (!parsed) return false

    const derived = await new Promise<Buffer>((resolve, reject) => {
        scrypt(
            password,
            parsed.salt,
            parsed.expected.length,
            { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: SCRYPT_MAX_MEMORY },
            (error, key) => {
                if (error) reject(error)
                else resolve(key as Buffer)
            },
        )
    }).catch(() => null)

    return derived !== null
        && derived.length === parsed.expected.length
        && timingSafeEqual(derived, parsed.expected)
}
