import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCredentialVault, writeCredentialVault } from './credential-vault.js'

const temporaryDirectories: string[] = []
const masterKey = 'test-only-vault-master-key-with-more-than-32-bytes'

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true })
    }
})

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'poetic-realm-vault-'))
    temporaryDirectories.push(directory)
    return directory
}

describe('credential vault', () => {
    it('AES-GCM 往返成功且落盘文件不含任何凭据明文', () => {
        const directory = temporaryDirectory()
        const values = {
            deepseek: 'deepseek-private-value',
            mimo: 'mimo-private-value',
            wanBaseUrl: 'https://workspace.example.invalid/provider',
        }
        writeCredentialVault(directory, masterKey, values)
        const raw = readFileSync(join(directory, 'provider-credentials.v1.json'), 'utf8')
        expect(raw).not.toContain(values.deepseek)
        expect(raw).not.toContain(values.mimo)
        expect(raw).not.toContain(values.wanBaseUrl)
        expect(readCredentialVault(directory, masterKey)).toEqual(values)
    })

    it('错误主密钥或任何密文篡改都失败关闭', () => {
        const directory = temporaryDirectory()
        writeCredentialVault(directory, masterKey, { deepseek: 'private-value' })
        expect(() => readCredentialVault(directory, `${masterKey}-wrong`)).toThrow(/无法解密|完整性/u)

        const target = join(directory, 'provider-credentials.v1.json')
        const envelope = JSON.parse(readFileSync(target, 'utf8')) as { ciphertext: string }
        envelope.ciphertext = `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`
        writeFileSync(target, JSON.stringify(envelope), 'utf8')
        expect(() => readCredentialVault(directory, masterKey)).toThrow(/无法解密|完整性/u)
    })

    it('拒绝弱主密钥，空保险柜则返回空对象', () => {
        const directory = temporaryDirectory()
        expect(readCredentialVault(directory, masterKey)).toEqual({})
        expect(() => writeCredentialVault(directory, 'short', { deepseek: 'value' })).toThrow(/32 字节/u)
    })
})
