import { lstatSync, rmSync } from 'node:fs'
import { dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const backendRoot = resolve(scriptDirectory, '..')
const distDirectory = resolve(backendRoot, 'dist')

if (dirname(distDirectory) !== backendRoot || basename(distDirectory) !== 'dist') {
    throw new Error(`拒绝清理意外路径：${distDirectory}`)
}

try {
    const stat = lstatSync(distDirectory)
    if (stat.isSymbolicLink()) {
        throw new Error(`拒绝递归清理符号链接：${distDirectory}`)
    }
} catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        process.exit(0)
    }
    throw error
}

rmSync(distDirectory, { recursive: true, force: false })
