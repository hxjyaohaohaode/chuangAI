import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveProtectedUploadReference } from './protected-upload-reference.js'

describe('protected grading upload reference', () => {
    it('只接受根目录下两级、服务端 ID 命名且扩展名与 MIME 一致的图片', () => {
        const root = path.resolve('data', 'uploads')
        const valid = path.join(root, 'batch_01', 'file-02.jpg')
        expect(resolveProtectedUploadReference(root, valid, 'image/jpeg')).toBe(path.resolve(valid))

        const invalid = [
            [path.resolve(root, '..', 'private.txt'), 'image/jpeg'],
            [path.join(root, '..', 'escape', 'file.jpg'), 'image/jpeg'],
            [path.join(root, 'batch_01', '..', 'file.jpg'), 'image/jpeg'],
            [path.join(root, 'batch_01', 'nested', 'file.jpg'), 'image/jpeg'],
            [path.join(root, 'batch/escape', 'file.jpg'), 'image/jpeg'],
            [path.join(root, 'batch_01', 'file.svg'), 'image/svg+xml'],
            [path.join(root, 'batch_01', 'file.jpg'), 'text/html'],
            [path.join(root, 'batch_01', 'file.png'), 'image/jpeg'],
        ] as const
        for (const [candidate, contentType] of invalid) {
            expect(resolveProtectedUploadReference(root, candidate, contentType)).toBeNull()
        }
    })
})
