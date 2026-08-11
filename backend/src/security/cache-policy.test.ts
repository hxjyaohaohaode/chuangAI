import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const routesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../routes')

describe('API cache policy', () => {
    it('所有绕过 Fastify onSend 的原始流都显式禁止私密内容落盘缓存', async () => {
        const routeFiles = (await readdir(routesDirectory))
            .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
            .sort()
        const policies: Array<{ file: string; value: string }> = []

        for (const file of routeFiles) {
            const source = await readFile(path.join(routesDirectory, file), 'utf8')
            expect(source).not.toContain("'Cache-Control': 'no-cache, no-transform'")
            for (const match of source.matchAll(/['"]Cache-Control['"]\s*:\s*['"]([^'"]*no-transform[^'"]*)['"]/gu)) {
                policies.push({ file, value: match[1] ?? '' })
            }
        }

        expect(policies.length).toBeGreaterThan(0)
        for (const policy of policies) {
            expect(policy.value, `${policy.file} 缺少 private`).toContain('private')
            expect(policy.value, `${policy.file} 缺少 no-store`).toContain('no-store')
        }

        // ASR 中间音频是学生原音。禁止把 SqliteMap 的纯元数据 LRU 当作文件
        // 生命周期管理；清理顺序必须先删磁盘文件，再删可重试的 SQLite 元数据。
        const recitation = await readFile(path.join(routesDirectory, 'recitation.ts'), 'utf8')
        expect(recitation).not.toMatch(/recitation_asr_intermediate[\s\S]{0,240}maxSize\s*:/u)
        const unlinkIndex = recitation.indexOf('if (existsSync(val.audioFilePath)) await unlink(val.audioFilePath)')
        const metadataDeleteIndex = recitation.indexOf('asrIntermediate.delete(key)', unlinkIndex)
        expect(unlinkIndex).toBeGreaterThan(0)
        expect(metadataDeleteIndex).toBeGreaterThan(unlinkIndex)
        expect(recitation).toContain('元数据已保留供后续重试')
        expect(recitation).toContain('isPathInside(RECITATIONS_DIR, val.audioFilePath)')
        expect(recitation).toContain('isPathInside(TTS_DIR, entry.filePath)')
        expect(recitation).toContain('`/api/recitation/audio/tts/${fileName}`')
        expect(recitation).toContain('`/api/recitation/audio/recitations/${savedFilename}`')
        expect(recitation).toContain('normalizeProtectedAudioUrl')
        expect(recitation).toContain("error: 'INVALID_AUDIO_REFERENCE'")
        expect(recitation).toContain("error: 'AUDIO_FILE_UNAVAILABLE'")
        expect(recitation).not.toContain('audio: audioBuffer ?? audioUrl')
        expect(recitation).toContain('audio: audioBuffer,')

        // 批改图片路径来自持久化 SQLite，读取、模型转换和删除都必须重新验证
        // 词法路径、文件名/MIME 契约与 realpath，不能信任历史元数据。
        const grading = await readFile(path.join(routesDirectory, 'grading.ts'), 'utf8')
        expect(grading).toContain('resolveProtectedUploadReference(UPLOAD_DIR, filePath, contentType)')
        expect(grading).toContain('resolveExistingPathInsideUploadDirectory')
        expect(grading).toContain('realpath(candidate)')
        expect(grading).not.toContain('const buffer = await readFile(target.filePath)')
        expect(grading).toContain("error: 'UPLOAD_FILE_UNAVAILABLE'")

        // /api/ai/tts 返回二进制音频。前端不得再用 fetchJSON 解析，同时必须
        // 校验 audio MIME、拒绝空音频并为 Blob URL 建立释放责任。
        const frontendRoot = path.resolve(routesDirectory, '../../../frontend/src')
        const apiClient = await readFile(path.join(frontendRoot, 'lib/api.ts'), 'utf8')
        const chatInterface = await readFile(path.join(frontendRoot, 'pages/AICopilotPage/ChatInterface.tsx'), 'utf8')
        const recitationPlayer = await readFile(path.join(frontendRoot, 'pages/ThinkingPalacePage/PoemRecitationPlayer.tsx'), 'utf8')
        expect(apiClient).not.toMatch(/fetchJSON[^\n]*['"]\/ai\/tts/u)
        expect(apiClient).toContain("contentType.startsWith('audio/')")
        expect(apiClient).toContain('if (blob.size === 0)')
        expect(chatInterface).toContain('URL.revokeObjectURL(audioUrlRef.current)')
        expect(recitationPlayer).toContain('URL.revokeObjectURL(audioUrl)')
    })
})
