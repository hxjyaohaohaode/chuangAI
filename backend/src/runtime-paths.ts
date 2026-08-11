import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))

/** 源码与编译产物中，本文件都位于 backend/{src|dist}，上两级即仓库根。 */
export const PROJECT_ROOT = resolve(moduleDirectory, '..', '..')

export interface RuntimePaths {
    dataDir: string
    databaseFile: string
    uploadsDir: string
    generatedUploadsDir: string
    audioDir: string
    ttsAudioDir: string
    recitationsAudioDir: string
}

/**
 * 所有运行时可变资产的唯一目录契约。
 * APP_DATA_DIR 为空时保持本地 ./data 默认；Render 将其设为持久盘 /var/data。
 */
export function resolveRuntimePaths(
    configuredDataDirectory: string,
    projectRoot: string = PROJECT_ROOT,
): RuntimePaths {
    const trimmed = configuredDataDirectory.trim()
    const dataDir = trimmed ? resolve(trimmed) : join(resolve(projectRoot), 'data')
    const uploadsDir = join(dataDir, 'uploads')
    const audioDir = join(dataDir, 'audio')

    return Object.freeze({
        dataDir,
        databaseFile: join(dataDir, 'poetic-realm.db'),
        uploadsDir,
        generatedUploadsDir: join(uploadsDir, 'generated'),
        audioDir,
        ttsAudioDir: join(audioDir, 'tts'),
        recitationsAudioDir: join(audioDir, 'recitations'),
    })
}
