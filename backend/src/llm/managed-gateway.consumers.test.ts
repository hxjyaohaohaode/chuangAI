import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

function typescriptFiles(root: string): string[] {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const path = join(root, entry.name)
        if (entry.isDirectory()) return typescriptFiles(path)
        return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
    })
}

const SOURCE_ROOT = join(process.cwd(), 'src')
const RAW_CLIENT_CALL = /\b(?:deepseek|mimo)\.(?:chat|stream|streamChat|tts|asr)\s*\(/u
const MANAGED_CALL = /\bmanagedLLM\.(?:chat|stream|tts|asr)\s*\(/gu

describe('managed gateway consumer boundary', () => {
    it('services 层不存在绕过托管网关的 DeepSeek/MiMo 原始调用', () => {
        const serviceRoot = join(SOURCE_ROOT, 'services')
        const offenders = typescriptFiles(serviceRoot)
            .filter((file) => !file.endsWith('.test.ts'))
            .filter((file) => RAW_CLIENT_CALL.test(readFileSync(file, 'utf8')))
            .map((file) => relative(SOURCE_ROOT, file).replaceAll('\\', '/'))

        expect(offenders).toEqual([])
    })

    it('21 个既有服务调用均显式经过 managedLLM，迁移数量可审计', () => {
        const serviceRoot = join(SOURCE_ROOT, 'services')
        const managedCallCount = typescriptFiles(serviceRoot)
            .filter((file) => !file.endsWith('.test.ts'))
            .reduce((count, file) => {
                const matches = readFileSync(file, 'utf8').match(MANAGED_CALL)
                return count + (matches?.length ?? 0)
            }, 0)

        expect(managedCallCount).toBe(21)
    })

    it('全部业务源码均不存在绕过托管网关的 DeepSeek/MiMo 原始调用', () => {
        const offenders = typescriptFiles(SOURCE_ROOT)
            .filter((file) => !file.includes(`${join(SOURCE_ROOT, 'llm')}`))
            .filter((file) => !file.endsWith('.test.ts'))
            .filter((file) => RAW_CLIENT_CALL.test(readFileSync(file, 'utf8')))
            .map((file) => relative(SOURCE_ROOT, file).replaceAll('\\', '/'))

        expect(offenders).toEqual([])
    })
})
