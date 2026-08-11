import { randomUUID } from 'node:crypto'
import {
    closeSync,
    existsSync,
    fsyncSync,
    openSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export interface AtomicWriteOptions {
    encoding?: BufferEncoding
    mode?: number
}

/**
 * 在目标同目录创建独占临时文件，写完并 fsync 后原子替换目标。
 * 同目录保证 rename 不跨卷；任何失败只清理本次 UUID 临时文件，不触碰旧目标。
 */
export function atomicWriteFileSync(
    targetPath: string,
    data: string | NodeJS.ArrayBufferView,
    options: AtomicWriteOptions = {},
): void {
    const target = resolve(targetPath)
    const temporary = join(
        dirname(target),
        `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
    )
    let descriptor: number | undefined
    try {
        descriptor = openSync(temporary, 'wx', options.mode ?? 0o600)
        if (typeof data === 'string') {
            writeFileSync(descriptor, data, { encoding: options.encoding ?? 'utf8' })
        } else {
            writeFileSync(descriptor, data)
        }
        fsyncSync(descriptor)
        closeSync(descriptor)
        descriptor = undefined
        renameSync(temporary, target)
    } finally {
        if (descriptor !== undefined) closeSync(descriptor)
        if (existsSync(temporary)) unlinkSync(temporary)
    }
}
