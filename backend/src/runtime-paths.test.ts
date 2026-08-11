import { describe, expect, it } from 'vitest'
import { isAbsolute, relative, resolve } from 'node:path'
import { resolveRuntimePaths } from './runtime-paths.js'

describe('runtime paths', () => {
    it('空 APP_DATA_DIR 保持项目 data 默认并收束全部可变资产', () => {
        const paths = resolveRuntimePaths('', '/srv/poetic-realm')
        expect(paths).toEqual({
            dataDir: resolve('/srv/poetic-realm/data'),
            databaseFile: resolve('/srv/poetic-realm/data/poetic-realm.db'),
            uploadsDir: resolve('/srv/poetic-realm/data/uploads'),
            generatedUploadsDir: resolve('/srv/poetic-realm/data/uploads/generated'),
            audioDir: resolve('/srv/poetic-realm/data/audio'),
            ttsAudioDir: resolve('/srv/poetic-realm/data/audio/tts'),
            recitationsAudioDir: resolve('/srv/poetic-realm/data/audio/recitations'),
        })
    })

    it('显式目录使 SQLite、批改上传、WebP 与音频全部位于同一持久盘下', () => {
        const diskRoot = resolve('var', 'render-data')
        const paths = resolveRuntimePaths(diskRoot, '/ignored')

        expect(paths.dataDir).toBe(diskRoot)
        for (const runtimePath of Object.values(paths)) {
            expect(isAbsolute(runtimePath)).toBe(true)
            const fromDiskRoot = relative(diskRoot, runtimePath)
            expect(fromDiskRoot === '' || (!fromDiskRoot.startsWith('..') && !isAbsolute(fromDiskRoot)))
                .toBe(true)
        }
    })
})
