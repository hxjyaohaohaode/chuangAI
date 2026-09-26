import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
} from 'node:crypto'
import {
    chmodSync,
    existsSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

const VAULT_FILE = 'provider-credentials.v1.json'
const VAULT_AAD = Buffer.from('poetic-realm/provider-credentials/v1', 'utf8')
const MAX_VAULT_BYTES = 64 * 1024

export type VaultValues = Readonly<{
    deepseek?: string
    mimo?: string
    dashscope?: string
    wanBaseUrl?: string
}>

interface VaultEnvelope {
    v: 1
    iv: string
    tag: string
    ciphertext: string
}

function deriveKey(masterKey: string): Buffer {
    if (Buffer.byteLength(masterKey, 'utf8') < 32) {
        throw new Error('CREDENTIAL_VAULT_MASTER_KEY 必须至少 32 字节')
    }
    return createHash('sha256')
        .update('poetic-realm-credential-vault\0', 'utf8')
        .update(masterKey, 'utf8')
        .digest()
}

function vaultPath(dataDir: string): string {
    const root = resolve(dataDir)
    const target = resolve(root, VAULT_FILE)
    if (dirname(target) !== root) throw new Error('凭据保险柜路径越界')
    return target
}

function parseEnvelope(raw: string): VaultEnvelope {
    const parsed = JSON.parse(raw) as Partial<VaultEnvelope>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.keys(parsed).some((key) => !['v', 'iv', 'tag', 'ciphertext'].includes(key))
        || parsed.v !== 1
        || typeof parsed.iv !== 'string'
        || typeof parsed.tag !== 'string'
        || typeof parsed.ciphertext !== 'string') {
        throw new Error('凭据保险柜格式无效')
    }
    return parsed as VaultEnvelope
}

function decodeCanonicalBase64Url(value: string): Buffer {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('凭据保险柜格式无效')
    const decoded = Buffer.from(value, 'base64url')
    // Node 的解码器容忍非规范尾位；这种文本篡改可能解成同一字节串。
    if (decoded.toString('base64url') !== value) throw new Error('凭据保险柜完整性校验失败')
    return decoded
}

function parseValues(raw: string): VaultValues {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('凭据保险柜内容无效')
    }
    const allowed = new Set(['deepseek', 'mimo', 'dashscope', 'wanBaseUrl'])
    for (const [key, value] of Object.entries(parsed)) {
        if (!allowed.has(key) || typeof value !== 'string' || value.length > 16_384) {
            throw new Error('凭据保险柜内容无效')
        }
    }
    return parsed
}

export function readCredentialVault(dataDir: string, masterKey: string): VaultValues {
    const target = vaultPath(dataDir)
    if (!existsSync(target)) return {}
    const raw = readFileSync(target, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_VAULT_BYTES) throw new Error('凭据保险柜异常过大')
    const envelope = parseEnvelope(raw)
    const iv = decodeCanonicalBase64Url(envelope.iv)
    const tag = decodeCanonicalBase64Url(envelope.tag)
    const ciphertext = decodeCanonicalBase64Url(envelope.ciphertext)
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
        throw new Error('凭据保险柜格式无效')
    }
    try {
        const decipher = createDecipheriv('aes-256-gcm', deriveKey(masterKey), iv)
        decipher.setAAD(VAULT_AAD)
        decipher.setAuthTag(tag)
        return parseValues(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'))
    } catch {
        throw new Error('凭据保险柜无法解密或完整性校验失败')
    }
}

export function writeCredentialVault(dataDir: string, masterKey: string, values: VaultValues): void {
    const payload = JSON.stringify(values)
    parseValues(payload)
    const target = vaultPath(dataDir)
    mkdirSync(dirname(target), { recursive: true })
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', deriveKey(masterKey), iv)
    cipher.setAAD(VAULT_AAD)
    const ciphertext = Buffer.concat([
        cipher.update(payload, 'utf8'),
        cipher.final(),
    ])
    const envelope: VaultEnvelope = {
        v: 1,
        iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
    }
    const serialized = `${JSON.stringify(envelope)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_VAULT_BYTES) throw new Error('凭据保险柜异常过大')
    const temporary = join(dirname(target), `.${VAULT_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    try {
        writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        chmodSync(temporary, 0o600)
        renameSync(temporary, target)
        chmodSync(target, 0o600)
    } catch (error) {
        try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* best effort */ }
        throw error
    }
}
