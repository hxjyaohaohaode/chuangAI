/** 在本机交互式生成 AUTH_PASSWORD_SCRYPT；密码不进入参数、历史或输出。 */
import { randomBytes, scryptSync } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import process from 'node:process'

class MutedOutput extends Writable {
    muted = false

    _write(chunk, encoding, callback) {
        if (!this.muted) process.stdout.write(chunk, encoding)
        callback()
    }
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('为避免密码进入管道日志，本脚本只接受交互式终端输入。')
}

const output = new MutedOutput()
const readline = createInterface({ input: process.stdin, output, terminal: true })
process.stdout.write('请输入教师密码（输入不会显示）: ')
output.muted = true
const password = await readline.question('')
output.muted = false
readline.close()
process.stdout.write('\n')

if (password.length < 12) {
    throw new Error('密码至少 12 个字符；建议使用 4 个以上随机词组成的长口令。')
}

const salt = randomBytes(16)
const N = 16_384
const r = 8
const p = 1
const derived = scryptSync(password, salt, 32, {
    N,
    r,
    p,
    maxmem: 128 * 1024 * 1024,
})

console.log(`AUTH_PASSWORD_SCRYPT=scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${derived.toString('base64url')}`)
console.log('请把摘要写入部署环境的密钥存储；不要提交包含真实摘要的 .env。')
