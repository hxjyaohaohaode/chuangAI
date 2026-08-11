import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/**
 * 三家供应商当前使用的 Key 均为不含空白的可打印 ASCII token。
 * 收紧字符集既防 CRLF/.env 注入，也避免 dotenv 对空格、引号和注释符的歧义解析。
 */
const CREDENTIAL_KEY_PATTERN = /^[A-Za-z0-9._~+/=-]+$/

export function normalizeCredentialKey(input: string): string {
    const value = input.trim()
    if (value.length === 0) return ''
    if (value.length > 256 || !CREDENTIAL_KEY_PATTERN.test(value)) {
        throw new Error('密钥格式无效：仅允许 1-256 位字母、数字及 . _ ~ + / = -')
    }
    return value
}

/** 生成去重后的 .env 内容：同名变量无论出现几次，最终都只保留一行。 */
export function updateCredentialEnvContent(content: string, variable: string, key: string): string {
    const assignment = `${variable}=${key}`
    const matcher = new RegExp(`^\\s*${variable}\\s*=`, 'u')
    const sourceLines = content.length > 0 ? content.split(/\r?\n/u) : []
    const output: string[] = []
    let inserted = false

    for (const line of sourceLines) {
        if (!matcher.test(line)) {
            output.push(line)
            continue
        }
        if (!inserted) {
            output.push(assignment)
            inserted = true
        }
    }

    if (!inserted) {
        if (output.length > 0 && output.at(-1) !== '') output.push('')
        output.push(assignment)
    }
    return output.join('\n')
}

/**
 * 同目录临时文件 + fsync + rename，避免进程中断留下半截 .env。
 * 临时文件固定为仅当前用户可读写；失败时尽力删除临时文件，原文件保持不变。
 */
export function persistCredentialAtomically(file: string, variable: string, key: string): void {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const next = updateCredentialEnvContent(current, variable, key)
    const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
    let descriptor: number | undefined

    try {
        descriptor = openSync(temp, 'wx', 0o600)
        writeFileSync(descriptor, next, 'utf8')
        fsyncSync(descriptor)
        closeSync(descriptor)
        descriptor = undefined
        chmodSync(temp, 0o600)
        renameSync(temp, file)
    } catch (error) {
        if (descriptor !== undefined) {
            try { closeSync(descriptor) } catch { /* 已关闭或句柄无效 */ }
        }
        if (existsSync(temp)) {
            try { unlinkSync(temp) } catch { /* 保留原错误 */ }
        }
        throw error
    }

    // 防御性确认：重命名后的目标必须仍是普通文件，不能静默落到目录或特殊对象。
    if (!statSync(file).isFile()) {
        throw new Error('凭据文件落盘失败：目标不是普通文件')
    }
}
