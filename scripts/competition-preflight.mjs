#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argValue = (name, fallback) => {
    const index = argv.indexOf(name)
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const mode = argValue('--mode', 'live')
const deployment = argValue('--deployment', 'local')
const writeReport = argv.includes('--write')
if (!['live', 'demo'].includes(mode) || !['local', 'docker'].includes(deployment)) {
    console.error('用法：node scripts/competition-preflight.mjs [--mode live|demo] [--deployment local|docker] [--write]')
    process.exit(2)
}

const checks = []
const record = (id, status, message) => checks.push({ id, status, message })
const exists = async (file) => {
    try { await access(file); return true } catch { return false }
}
const readJson = async (relativePath) => {
    try { return JSON.parse(await readFile(path.join(rootDir, relativePath), 'utf8')) } catch { return null }
}
const readEnv = async (relativePath) => {
    const result = {}
    const file = path.join(rootDir, relativePath)
    if (!(await exists(file))) return result
    for (const rawLine of (await readFile(file, 'utf8')).split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
        if (!match) continue
        let value = match[2].trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        result[match[1]] = value
    }
    return result
}
const configuredSecret = (value) => {
    if (!value) return false
    const normalized = value.trim().toLowerCase()
    return !normalized.startsWith('your_')
        && !normalized.includes('change_me')
        && !normalized.includes('placeholder')
        && normalized !== 'poeticrealm'
}
const portIsFree = async (port) => await new Promise((resolve) => {
    const server = net.createServer().unref()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)))
})
const latestMtime = async (directory, accept) => {
    let latest = 0
    const walk = async (current) => {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            if (['node_modules', 'dist', 'coverage'].includes(entry.name)) continue
            const absolute = path.join(current, entry.name)
            if (entry.isDirectory()) await walk(absolute)
            else if (accept(absolute)) latest = Math.max(latest, (await stat(absolute)).mtimeMs)
        }
    }
    await walk(directory)
    return latest
}
const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex')
const serviceBlock = (compose, serviceName) => {
    const match = compose.match(new RegExp(`^  ${serviceName}:\\r?\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\r?$|^volumes:\\r?$|^networks:\\r?$)`, 'mu'))
    return match?.[1] ?? ''
}
const nginxExactLocationBlock = (source, routePath) => {
    const marker = `location = ${routePath}`
    const markerIndex = source.indexOf(marker)
    if (markerIndex < 0) return ''
    const openingBrace = source.indexOf('{', markerIndex + marker.length)
    if (openingBrace < 0) return ''
    let depth = 0
    for (let index = openingBrace; index < source.length; index++) {
        if (source[index] === '{') depth++
        if (source[index] === '}') {
            depth--
            if (depth === 0) return source.slice(openingBrace + 1, index)
        }
    }
    return ''
}

const nodeVersion = process.versions.node
const [nodeMajor, nodeMinor] = nodeVersion.split('.').map(Number)
if (nodeMajor === 20 && nodeMinor >= 19) {
    record('runtime.node', 'PASS', `Node.js ${nodeVersion} 符合锁定的比赛机运行时 >=20.19 <21`)
} else if (deployment === 'local' && mode === 'live') {
    record('runtime.node', 'FAIL', `本地 LIVE 放行必须锁定 Node.js >=20.19 <21；当前为 ${nodeVersion}`)
} else if (nodeMajor > 20 && nodeMajor < 25) {
    record('runtime.node', 'WARN', `Node.js ${nodeVersion} 可用于带警告审查；比赛机须锁定 Node >=20.19 <21`)
} else {
    record('runtime.node', 'FAIL', `Node.js ${nodeVersion} 不在可审查范围 20.19 <= version < 25`)
}

const corepackEntry = process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js')
    : 'corepack'
const pnpm = process.platform === 'win32'
    // 预检在仓库根目录执行，而 packageManager 声明位于 frontend/backend。
    // 显式指定受管版本，避免 Corepack 退回机器缓存的默认 pnpm（它可能不支持 Node 20）。
    ? spawnSync(process.execPath, [corepackEntry, 'pnpm@10.34.5', '--version'], { encoding: 'utf8' })
    : spawnSync(corepackEntry, ['pnpm@10.34.5', '--version'], { encoding: 'utf8' })
const pnpmVersion = pnpm.status === 0 ? pnpm.stdout.trim() : ''
record('runtime.pnpm', pnpmVersion === '10.34.5' ? 'PASS' : 'FAIL', pnpmVersion
    ? `Corepack pnpm ${pnpmVersion}，要求 10.34.5（该版本支持 Node 20）`
    : '无法通过 Corepack 获取 pnpm 版本')

for (const area of ['backend', 'frontend']) {
    const packageJson = await readJson(`${area}/package.json`)
    const lockExists = await exists(path.join(rootDir, area, 'pnpm-lock.yaml'))
    const managerOk = packageJson?.packageManager === 'pnpm@10.34.5'
    const engineOk = packageJson?.engines?.node === '>=20.19 <21'
    record(`dependencies.${area}`, lockExists && managerOk && engineOk ? 'PASS' : 'FAIL',
        `${area} 锁文件${lockExists ? '存在' : '缺失'}，包管理器${managerOk ? '已锁定 Node 20 兼容版本' : '未锁定'}，Node 引擎${engineOk ? '已锁定 >=20.19 <21' : '未锁定'}`)
}

for (const port of [3001, 5173]) {
    const free = await portIsFree(port)
    record(`port.${port}`, free ? 'PASS' : 'FAIL', free ? `端口 ${port} 可用` : `端口 ${port} 已被占用`)
}

const backendEnv = await readEnv('backend/.env')
const rootEnv = await readEnv('.env')
const configuredProviderEndpoints = {
    deepseek: backendEnv.DEEPSEEK_BASE_URL || rootEnv.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    mimo: backendEnv.MIMO_BASE_URL || rootEnv.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1',
    wanImage: backendEnv.WAN_IMAGE_BASE_URL || rootEnv.WAN_IMAGE_BASE_URL || '',
}
const providerEndpointRules = {
    deepseek: { hostname: 'api.deepseek.com', paths: new Set(['/', '/v1']) },
    mimo: { hostname: 'api.xiaomimimo.com', paths: new Set(['/v1']) },
}
const trustedProviderEndpoint = (provider, value) => {
    try {
        const url = new URL(value)
        const normalizedPath = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, '') : '/'
        const commonBoundary = url.protocol === 'https:'
            && !url.username && !url.password && (!url.port || url.port === '443')
            && !url.search && !url.hash
        if (!commonBoundary) return false
        if (provider === 'wanImage') {
            return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com$/u
                .test(url.hostname.toLowerCase())
                && normalizedPath === '/api/v1/services/aigc/multimodal-generation/generation'
        }
        const rule = providerEndpointRules[provider]
        return url.hostname.toLowerCase() === rule.hostname && rule.paths.has(normalizedPath)
    } catch {
        return false
    }
}
const invalidProviderEndpoints = Object.entries(configuredProviderEndpoints)
    .filter(([, value]) => Boolean(value))
    .filter(([provider, value]) => !trustedProviderEndpoint(provider, value))
    .map(([provider]) => provider)
const wanEndpointMissing = !configuredProviderEndpoints.wanImage
const configuredWanModel = backendEnv.WAN_IMAGE_MODEL || rootEnv.WAN_IMAGE_MODEL || 'wan2.7-image'
const wanModelCompliant = configuredWanModel === 'wan2.7-image'
const providerBoundaryStatus = invalidProviderEndpoints.length > 0 || !wanModelCompliant
    ? 'FAIL'
    : wanEndpointMissing ? 'WARN' : 'PASS'
record(
    'security.provider-endpoints',
    providerBoundaryStatus,
    invalidProviderEndpoints.length > 0
        ? `非官方模型端点：${invalidProviderEndpoints.join(', ')}；禁止向未授权主机发送 API Key`
        : !wanModelCompliant
            ? 'WAN_IMAGE_MODEL 必须固定为项目官方文件指定的 wan2.7-image'
            : wanEndpointMissing
                ? 'DeepSeek、MiMo 端点合规；Wan Workspace 端点未配置，生图将诚实降级'
                : 'DeepSeek、MiMo 与 Wan 北京 Workspace 同步端点均锁定官方 HTTPS 主机、标准端口与路径',
)
try {
    const [downloadBoundary, boundedResponse, imageCache] = await Promise.all([
        readFile(path.join(rootDir, 'backend', 'src', 'security', 'remote-image-download.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'security', 'bounded-response.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'services', 'culture', 'image-cache.ts'), 'utf8'),
    ])
    const generatedImageDownloadOk = downloadBoundary.includes('MAX_GENERATED_IMAGE_DOWNLOAD_BYTES = 20 * 1024 * 1024')
        && downloadBoundary.includes('GENERATED_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000')
        && downloadBoundary.includes("redirect: 'manual'")
        && downloadBoundary.includes("new Set(['image/jpeg', 'image/png', 'image/webp'])")
        && downloadBoundary.includes('hasMatchingImageSignature(bytes, contentType)')
        && boundedResponse.includes("response.headers.get('content-length')")
        && boundedResponse.includes('totalBytes > maxBytes')
        && boundedResponse.includes('await reader.cancel')
        && imageCache.includes('downloadTrustedDashscopeImage(remoteUrl, options)')
        && imageCache.includes("limitInputPixels: 25_000_000")
        && !imageCache.includes('fetch(remoteUrl')
        && !imageCache.includes('res.arrayBuffer()')
    record('security.generated-image-download', generatedImageDownloadOk ? 'PASS' : 'FAIL', generatedImageDownloadOk
        ? '生图下载拒绝重定向，限制 30 秒/20MiB/MIME/魔数/解码像素并流式超限取消'
        : '生图下载缺少重定向、超时、字节、类型、魔数或解码像素边界')
} catch {
    record('security.generated-image-download', 'FAIL', '缺少生图下载边界实现文件')
}
try {
    const [audioBoundary, boundedResponse, mimoClient] = await Promise.all([
        readFile(path.join(rootDir, 'backend', 'src', 'security', 'remote-audio-response.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'security', 'bounded-response.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'llm', 'mimo-client.ts'), 'utf8'),
    ])
    const ttsResponseOk = audioBoundary.includes('mp3: 24 * 1024 * 1024')
        && audioBoundary.includes('wav: 64 * 1024 * 1024')
        && audioBoundary.includes('opus: 24 * 1024 * 1024')
        && audioBoundary.includes("new Set(['audio/mpeg', 'audio/mp3'])")
        && audioBoundary.includes("bytes.subarray(0, 4).toString('ascii') === 'RIFF'")
        && audioBoundary.includes("Buffer.from('OpusHead')")
        && boundedResponse.includes("response.headers.get('content-length')")
        && boundedResponse.includes('totalBytes > maxBytes')
        && boundedResponse.includes('await reader.cancel')
        && mimoClient.includes('readBoundedTtsAudioResponse(response, format)')
        && !mimoClient.includes('response.arrayBuffer()')
    record('security.tts-response', ttsResponseOk ? 'PASS' : 'FAIL', ttsResponseOk
        ? 'TTS 响应按 MP3/WAV/Opus 限制 MIME、魔数、声明/流式字节并取消超限读取'
        : 'TTS 响应缺少格式、魔数或声明/流式字节边界')
} catch {
    record('security.tts-response', 'FAIL', '缺少 TTS 二进制响应边界实现文件')
}
try {
    const [providerResponse, boundedResponse, settingsRoutes, wanImage] = await Promise.all([
        readFile(path.join(rootDir, 'backend', 'src', 'security', 'provider-response.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'security', 'bounded-response.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'routes', 'settings.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'services', 'culture', 'wan-image.ts'), 'utf8'),
    ])
    const providerResponsesOk = providerResponse.includes('MAX_PROVIDER_ERROR_RESPONSE_BYTES = 64 * 1024')
        && providerResponse.includes('MAX_PROVIDER_JSON_RESPONSE_BYTES = 1024 * 1024')
        && providerResponse.includes("value.split(currentApiKey).join('[REDACTED]')")
        && providerResponse.includes("maskString(withoutExactKey.replace(PROVIDER_TOKEN_PATTERN, '[REDACTED]'))")
        && providerResponse.includes("contentType !== 'application/json'")
        && boundedResponse.includes('totalBytes > maxBytes')
        && settingsRoutes.includes("redirect: 'error'")
        && settingsRoutes.includes('return await consume(response)')
        && settingsRoutes.includes('readBoundedProviderErrorText')
        && settingsRoutes.includes('sanitizeProviderDetail(detail, apiKey)')
        && !settingsRoutes.includes('res.text()')
        && wanImage.includes("redirect: 'error'")
        && wanImage.includes("readBoundedProviderJson<unknown>(response, 'Wan2.7')")
        && wanImage.includes("typeof rawPayload !== 'object' || Array.isArray(rawPayload)")
        && wanImage.includes('return parseSuccessfulWanResponse(payload)')
        && !wanImage.includes('response.json()')
    record('security.provider-responses', providerResponsesOk ? 'PASS' : 'FAIL', providerResponsesOk
        ? '供应商错误文本/JSON 响应限制 64KiB/1MiB，超时覆盖正文消费且接口拒绝重定向'
        : '供应商响应缺少体积、完整生命周期超时、JSON MIME 或重定向边界')
} catch {
    record('security.provider-responses', 'FAIL', '缺少供应商响应边界实现文件')
}
try {
    const [atomicFile, singleFlight, imageCache] = await Promise.all([
        readFile(path.join(rootDir, 'backend', 'src', 'lib', 'atomic-file.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'lib', 'single-flight.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'services', 'culture', 'image-cache.ts'), 'utf8'),
    ])
    const imageCacheDurabilityOk = atomicFile.includes("openSync(temporary, 'wx'")
        && atomicFile.includes('fsyncSync(descriptor)')
        && atomicFile.includes('renameSync(temporary, target)')
        && singleFlight.includes('this.active.get(key)')
        && singleFlight.includes('operation.finally')
        && imageCache.includes('imageFlights.run(key')
        && imageCache.includes('atomicWriteFileSync(indexPath()')
        && imageCache.includes('atomicWriteFileSync(join(cacheDir()')
        && imageCache.includes('const latestIndex = readIndex()')
        && !imageCache.includes('writeFileSync(')
    record('security.image-cache-durability', imageCacheDurabilityOk ? 'PASS' : 'FAIL', imageCacheDurabilityOk
        ? '生图同键并发单航班合并，WebP/索引同目录刷盘原子替换且完成时合并最新索引'
        : '生图缓存缺少并发合并、原子刷盘或最新索引合并边界')
} catch {
    record('security.image-cache-durability', 'FAIL', '缺少生图缓存可靠性实现文件')
}
try {
    const [runtimeStore, dbIndex, memoryStore] = await Promise.all([
        readFile(path.join(rootDir, 'backend', 'src', 'db', 'runtime-store.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'db', 'index.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'agents', 'base', 'long-term-memory.ts'), 'utf8'),
    ])
    const sqliteRuntimeOk = runtimeStore.includes('private readonly indexNames')
        && runtimeStore.includes('Number.isSafeInteger(opts.maxSize)')
        && runtimeStore.includes('const write = db.transaction')
        && runtimeStore.includes('}).immediate')
        && runtimeStore.includes('Unknown SqliteMap index column')
        && dbIndex.includes("db.pragma('busy_timeout = 5000')")
        && memoryStore.includes('Number.isSafeInteger(requestedMaxSize)')
    record('reliability.sqlite-runtime', sqliteRuntimeOk ? 'PASS' : 'FAIL', sqliteRuntimeOk
        ? '运行时 SQLite 校验索引白名单/容量上限；写入与淘汰同一 BEGIN IMMEDIATE 事务，并在短暂写锁竞争中等待'
        : '运行时 SQLite 缺少索引白名单、容量校验、BEGIN IMMEDIATE 事务淘汰或写锁等待边界')
} catch {
    record('reliability.sqlite-runtime', 'FAIL', '缺少 SQLite 运行时可靠性实现文件')
}
try {
    const [classroom, persistence, persistenceTests] = await Promise.all([
        readFile(path.join(rootDir, 'backend', 'src', 'routes', 'classroom.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'services', 'classroom', 'lesson-start-persistence.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'services', 'classroom', 'lesson-start-persistence.test.ts'), 'utf8'),
    ])
    const classroomStartAtomicityOk = classroom.includes('persistLessonStartOrRollback')
        && classroom.includes('CLASSROOM_RUNTIME_UNAVAILABLE')
        && classroom.includes('LESSON_ARCHIVE_UNAVAILABLE')
        && persistence.includes("failure: 'runtime'")
        && persistence.includes("failure: 'archive'")
        && persistence.includes('dependencies.rollbackRuntime(lessonId)')
        && persistenceTests.includes('fails closed before archive creation when runtime persistence fails')
        && persistenceTests.includes('fails closed and removes the runtime when the long-term archive cannot be created')
    record('reliability.classroom-start-atomicity', classroomStartAtomicityOk ? 'PASS' : 'FAIL', classroomStartAtomicityOk
        ? '课堂短期 runtime 与长期 lessons 均失败关闭：runtime 写失败不归档，归档失败补偿回滚；两类 503 均可由前端重试'
        : '课堂启动缺少短期运行时/长期归档的失败关闭、补偿回滚或定向回归门禁')
} catch {
    record('reliability.classroom-start-atomicity', 'FAIL', '缺少课堂启动一致性实现或定向回归文件')
}
try {
    const [classroom, danceStage, orchestrator, orchestratorNode, server, rateLimiter, dashboard, diagnosis, knowledgeGraph, report, lessonPlan, frontendAdvisor, frontendApi, frontendAuth] = await Promise.all([
        readFile(path.join(rootDir, 'backend', 'src', 'routes', 'classroom.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'orchestrator', 'dance-stage.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'orchestrator', 'index.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'orchestrator', 'Orchestrator.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'server.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'llm', 'rate-limiter.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'routes', 'dashboard.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'routes', 'diagnosis.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'routes', 'knowledge-graph.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'routes', 'report.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'routes', 'lesson-plan.ts'), 'utf8'),
        readFile(path.join(rootDir, 'frontend', 'src', 'pages', 'ThinkingPalacePage', 'PoemReconstructionAdvisor.tsx'), 'utf8'),
        readFile(path.join(rootDir, 'frontend', 'src', 'lib', 'api.ts'), 'utf8'),
        readFile(path.join(rootDir, 'frontend', 'src', 'lib', 'auth-session.ts'), 'utf8'),
    ])
    const timeoutCleanupOk = [dashboard, diagnosis, knowledgeGraph, report].every((source) =>
        source.includes('finally') && source.includes('clearTimeout(timer)'))
        && lessonPlan.includes('clearTimeout(timeoutTimer)')
    const lifecycleOk = classroom.includes("app.addHook('onClose'")
        && classroom.includes('stopAllClassroomTimers()')
        && classroom.includes('classroomCleanupTimers')
        && classroom.includes('danceStage.closeAll()')
        && danceStage.includes('private closed = false')
        && danceStage.includes('if (danceStageInstance && !danceStageInstance.isClosed)')
        && danceStage.includes('this.closed = true')
        && frontendAdvisor.includes('const demoIntervalRef = useRef<number | null>(null)')
        && frontendAdvisor.includes('const clearDemoInterval = useCallback')
        && frontendAdvisor.includes('demoIntervalRef.current = window.setInterval')
        && frontendAdvisor.includes('clearDemoInterval()')
        && frontendApi.includes('function linkAbortSignal')
        && frontendApi.includes('const unlinkExternalSignal = linkAbortSignal')
        && frontendApi.includes('const STREAM_IDLE_TIMEOUT_MS = 120_000')
        && frontendApi.includes('const STREAM_HEADER_TIMEOUT_MS = 30_000')
        && frontendApi.includes('async function fetchStreamResponse')
        && frontendApi.includes('async function readStreamChunk')
        && frontendApi.includes('controller.signal.reason === STREAM_IDLE_TIMEOUT_REASON')
        && (frontendApi.match(/await reader\.read\(\)/g) ?? []).length === 1
        && frontendApi.includes('批改图片上传超时')
        && frontendApi.includes('朗读转写超时')
        && frontendApi.includes('超时必须覆盖正文消费')
        && frontendApi.includes('超时保持到 Blob 正文完整读取结束')
        && frontendApi.includes('超时保持到音频 Blob 正文读取完成')
        && frontendAuth.includes('const AUTH_REQUEST_TIMEOUT_MS = 10_000')
        && frontendAuth.includes('const AUTH_TIMEOUT_REASON =')
        && frontendAuth.includes('async function withAuthTimeout')
        && frontendAuth.includes('parseAuthResponse<T>(response: Response, signal: AbortSignal)')
        && classroom.includes('cleanupTimer.unref?.()')
        && classroom.includes('timer.unref?.()')
        && orchestrator.includes('agentEvents.off')
        && orchestrator.includes('evolutionEngine.stop()')
        && orchestrator.includes('broadcaster.closeAll()')
        && orchestratorNode.includes("controller.abort('node-timeout')")
        && rateLimiter.includes("timeoutController.abort('rate-limit-timeout')")
        && rateLimiter.includes('semaphore.acquire(timeoutController.signal)')
        && rateLimiter.includes('cancelled: boolean')
        && server.includes('detachLlmEventLoggers()')
        && server.includes('detachAgentEventLoggers()')
        && dashboard.includes('await kgService?.close()')
        && lessonPlan.includes('await kgService.close()')
        && report.includes('await kgService.close()')
        && diagnosis.includes('closeKnowledgeGraphService')
        && knowledgeGraph.includes('closeKnowledgeGraphService')
    const timerLifecycleOk = timeoutCleanupOk && lifecycleOk
    record('reliability.timer-lifecycle', timerLifecycleOk ? 'PASS' : 'FAIL', timerLifecycleOk
        ? '超时竞争、认证/业务正文/Signal/SSE、课堂监测/DanceStage、前端 DEMO 流式定时器和编排事件监听器均具备完成态清理与服务关闭兜底'
        : '存在 Promise.race 定时器、课堂定时器或全局事件监听器未清理路径')
} catch {
    record('reliability.timer-lifecycle', 'FAIL', '缺少定时器/生命周期实现文件')
}
const effectiveEnv = { ...backendEnv, ...process.env }
const host = effectiveEnv.HOST || '127.0.0.1'
const safeHost = ['127.0.0.1', 'localhost', '::1'].includes(host)
const authMode = effectiveEnv.AUTH_MODE || 'demo'
const secureCookie = effectiveEnv.AUTH_COOKIE_SECURE === 'true'
const authenticatedNonLoopback = authMode === 'password' && secureCookie
record('security.loopback', safeHost || authenticatedNonLoopback ? 'PASS' : 'FAIL', safeHost
    ? `后端监听边界为 ${host}`
    : authenticatedNonLoopback
        ? `后端 HOST=${host}，密码认证且强制 Secure Cookie`
        : `后端 HOST=${host}；非回环监听必须启用密码认证与 Secure Cookie`)
const explicitSessionSecret = effectiveEnv.AUTH_SESSION_SECRET || ''
const demoAuthOk = authMode === 'demo'
    && (safeHost || (deployment === 'docker' && effectiveEnv.ALLOW_UNAUTHENTICATED_NON_LOOPBACK === 'true'))
const passwordAuthOk = authMode === 'password'
    && explicitSessionSecret.length >= 32
    && /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/u.test(effectiveEnv.AUTH_PASSWORD_SCRYPT || '')
    && (safeHost || secureCookie)
// 当前 Compose 在容器内显式写死 AUTH_MODE=demo；宿主机恰好存在的密码环境变量
// 不能作为容器实际鉴权证据。LIVE Docker 必须先提供并审计独立生产编排，再允许放行。
const dockerLiveUnsupported = deployment === 'docker' && mode === 'live'
const authConfigOk = !dockerLiveUnsupported && (mode === 'live' ? passwordAuthOk : demoAuthOk || passwordAuthOk)
record('security.server-auth', authConfigOk ? 'PASS' : 'FAIL', authConfigOk
    ? authMode === 'demo'
        ? `AUTH_MODE=demo；${safeHost ? '仅回环公开演示档案' : '受控 Docker 内网例外'}，会话由服务器签名`
        : 'AUTH_MODE=password；scrypt 摘要、长会话密钥与 Cookie 边界已配置（值未输出）'
    : dockerLiveUnsupported
        ? '当前 docker-compose.yml 固定 AUTH_MODE=demo，仅支持回环 DEMO；宿主机密码变量不代表容器配置，LIVE Docker 禁止放行'
        : mode === 'live' && authMode === 'demo'
        ? 'LIVE 禁止公开演示档案；须配置 AUTH_MODE=password、scrypt 摘要和至少 32 字符持久会话密钥'
        : '认证配置缺少安全监听边界、scrypt 摘要、至少 32 字符会话密钥或非回环 Secure Cookie')

// 部署文档必须与 Compose 的真实网络/降级契约一致。这里用精确文本不变量做
// 无 Docker 守护进程依赖的门禁；正式发包前仍另跑 `docker compose config` 解析校验。
try {
    const [compose, envExample, installGuide] = await Promise.all([
        readFile(path.join(rootDir, 'docker-compose.yml'), 'utf8'),
        readFile(path.join(rootDir, '.env.example'), 'utf8'),
        readFile(path.join(rootDir, 'INSTALL.md'), 'utf8'),
    ])
    const frontend = serviceBlock(compose, 'frontend')
    const backend = serviceBlock(compose, 'backend')
    const neo4j = serviceBlock(compose, 'neo4j')
    const composeInvariants = {
        loopbackFrontend: /^\s*- ['"]127\.0\.0\.1:5173:5173['"]\s*$/mu.test(frontend),
        backendNotPublished: !/^\s{4}ports:\s*$/mu.test(backend),
        neo4jNotPublished: !/^\s{4}ports:\s*$/mu.test(neo4j),
        demoAuth: /^\s*- AUTH_MODE=demo\s*$/mu.test(backend),
        demoFallback: /^\s*- DEMO_MODE=\$\{DEMO_MODE:-true\}\s*$/mu.test(backend),
        backendPasswordRequired: /NEO4J_PASSWORD=\$\{NEO4J_PASSWORD:\?/.test(backend),
        neo4jPasswordRequired: /NEO4J_AUTH=neo4j\/\$\{NEO4J_PASSWORD:\?/.test(neo4j),
    }
    const composeOk = Object.values(composeInvariants).every(Boolean)
    const examplesOk = /^HOST=127\.0\.0\.1\s*$/mu.test(envExample)
        && /^DEMO_MODE=true\s*$/mu.test(envExample)
        && /^NEO4J_PASSWORD=\s*$/mu.test(envExample)
    const guideOk = installGuide.includes('curl http://localhost:5173/api/health')
        && !installGuide.includes('NEO4J_PASSWORD=poeticrealm')
        && !installGuide.includes('完全兼容')
    const deploymentContractOk = composeOk && examplesOk && guideOk && !dockerLiveUnsupported
    record('security.deployment-contract', deploymentContractOk ? 'PASS' : 'FAIL',
        deploymentContractOk
            ? 'Compose 仅发布回环 5173；后端/Neo4j 内网隔离；无 Key DEMO 与安装说明一致'
            : dockerLiveUnsupported && composeOk && examplesOk && guideOk
                ? '当前 Compose 契约经验证仅适用于回环 DEMO（AUTH_MODE=demo）；不存在经审计的 LIVE Docker 编排，禁止把 DEMO 契约外推为 LIVE'
            : `部署契约漂移：compose=${JSON.stringify(composeInvariants)} envExample=${examplesOk} installGuide=${guideOk}`)
} catch (error) {
    record('security.deployment-contract', 'FAIL', `无法读取部署契约：${error instanceof Error ? error.message : String(error)}`)
}

// 仓库目前没有可直接安装的 Nginx 配置，INSTALL.md 中的参考块是唯一代理契约。
// 这里同时锁定产品源码中的真实边界与该参考块，避免文档退回 15MiB 全站上限、
// 全站盲目放宽，或由默认 60s proxy_read_timeout 提前截断 Wan 生图。
try {
    const [installGuide, backendGrading, frontendUpload, frontendApi, wanImage, imageDownload] = await Promise.all([
        readFile(path.join(rootDir, 'INSTALL.md'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'routes', 'grading.ts'), 'utf8'),
        readFile(path.join(rootDir, 'frontend', 'src', 'pages', 'GradingPage', 'UploadZone.tsx'), 'utf8'),
        readFile(path.join(rootDir, 'frontend', 'src', 'lib', 'api.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'services', 'culture', 'wan-image.ts'), 'utf8'),
        readFile(path.join(rootDir, 'backend', 'src', 'security', 'remote-image-download.ts'), 'utf8'),
    ])
    const nginxExample = installGuide.match(/```nginx\s*\r?\n([\s\S]*?)\r?\n```/u)?.[1] ?? ''
    const uploadLocation = nginxExactLocationBlock(nginxExample, '/api/grading/upload')
    const imageLocation = nginxExactLocationBlock(nginxExample, '/api/ai/image-generate')
    const bodyLimits = [...nginxExample.matchAll(/client_max_body_size\s+([^;\s]+)\s*;/gu)].map((match) => match[1])
    const proxyReadTimeouts = [...nginxExample.matchAll(/proxy_read_timeout\s+([^;\s]+)\s*;/gu)].map((match) => match[1])
    const requestBufferingModes = [...nginxExample.matchAll(/proxy_request_buffering\s+([^;\s]+)\s*;/gu)].map((match) => match[1])
    const responseBufferingModes = [...nginxExample.matchAll(/(?<!request_)proxy_buffering\s+([^;\s]+)\s*;/gu)].map((match) => match[1])
    const proxyInvariants = {
        referenceOnlyDisclosure: installGuide.includes('只是仓库内的参考示例')
            && installGuide.includes('目标机实际 Nginx 配置必须执行 `nginx -t`'),
        onlyRouteScopedExceptions: JSON.stringify(bodyLimits) === JSON.stringify(['15m', '90m'])
            && JSON.stringify(proxyReadTimeouts) === JSON.stringify(['65s', '130s', '86400'])
            && JSON.stringify(requestBufferingModes) === JSON.stringify(['off'])
            && JSON.stringify(responseBufferingModes) === JSON.stringify(['on']),
        generalBodyLimitRemainsSmall: /server\s*\{[\s\S]*?client_max_body_size\s+15m\s*;[\s\S]*?location\s*=/u.test(nginxExample),
        uploadIsExact: uploadLocation.length > 0,
        uploadHasMultipartHeadroom: /client_max_body_size\s+90m\s*;/u.test(uploadLocation),
        uploadTimeoutAfterClient: /client_body_timeout\s+65s\s*;/u.test(uploadLocation)
            && /proxy_read_timeout\s+65s\s*;/u.test(uploadLocation),
        uploadStreamsToParser: /proxy_http_version\s+1\.1\s*;/u.test(uploadLocation)
            && /proxy_request_buffering\s+off\s*;/u.test(uploadLocation),
        imageIsExact: imageLocation.length > 0,
        imageProxyOutlivesClient: /proxy_read_timeout\s+130s\s*;/u.test(imageLocation),
        imageKeepsTerminalJsonBuffering: /proxy_buffering\s+on\s*;/u.test(imageLocation),
    }
    const sourceInvariants = {
        backendUploadTotal80MiB: backendGrading.includes('MAX_TOTAL_UPLOAD_SIZE = 80 * 1024 * 1024'),
        frontendUploadTotal80MiB: frontendUpload.includes('MAX_TOTAL_UPLOAD_SIZE = 80 * 1024 * 1024'),
        frontendUploadTimeout60s: /window\.setTimeout\(\(\) => timeoutController\.abort\(\), 60_000\)[\s\S]{0,600}\/grading\/upload/u.test(frontendApi),
        frontendImageTimeout125s: /window\.setTimeout\(\(\) => timeoutController\.abort\(\), 125_000\)[\s\S]{0,600}\/ai\/image-generate/u.test(frontendApi),
        wanRequestTimeout90s: wanImage.includes('WAN_IMAGE_REQUEST_TIMEOUT_MS = 90_000'),
        imageDownloadTimeout30s: imageDownload.includes('GENERATED_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000'),
    }
    const reverseProxyContractOk = [...Object.values(proxyInvariants), ...Object.values(sourceInvariants)].every(Boolean)
    record('security.reverse-proxy-contract', reverseProxyContractOk ? 'PASS' : 'FAIL', reverseProxyContractOk
        ? 'Nginx 参考契约仅对批改上传精确放宽至 90m 并关闭请求缓冲；60s 上传、125s 前端生图、90s Wan 与 30s 下载预算均有代理余量'
        : `反向代理契约漂移：proxy=${JSON.stringify(proxyInvariants)} source=${JSON.stringify(sourceInvariants)}`)
} catch (error) {
    record('security.reverse-proxy-contract', 'FAIL', `无法读取反向代理静态契约：${error instanceof Error ? error.message : String(error)}`)
}

for (const [name, required] of [
    ['DEEPSEEK_API_KEY', mode === 'live'],
    ['MIMO_API_KEY', mode === 'live'],
    ['DASHSCOPE_API_KEY', false],
]) {
    const present = configuredSecret(effectiveEnv[name])
    record(`credential.${name.toLowerCase()}`, present ? 'PASS' : required ? 'FAIL' : 'WARN',
        `${name} ${present ? '已配置（值未输出）' : required ? '缺失或仍为占位值' : '未配置，可按既有降级运行'}`)
}
if (mode === 'live') {
    const rotated = effectiveEnv.CREDENTIALS_ROTATED_AFTER_AUDIT === 'true'
    record('credential.rotation-attestation', rotated ? 'PASS' : 'FAIL', rotated
        ? '已声明审查后完成模型凭据轮换'
        : '轮换曾暴露的凭据后，须在 backend/.env 设置 CREDENTIALS_ROTATED_AFTER_AUDIT=true')
}
if (deployment === 'docker') {
    const password = rootEnv.NEO4J_PASSWORD
    const strong = configuredSecret(password) && password.length >= 16
    record('credential.neo4j', strong ? 'PASS' : 'FAIL', strong
        ? 'Docker Neo4j 已配置至少 16 位非占位密码（值未输出）'
        : '根目录 .env 缺少至少 16 位随机 NEO4J_PASSWORD')
}

for (const [outputRelative, sourceRelative, accept, buildInputs] of [
    ['backend/dist/server.js', 'backend/src', (file) => file.endsWith('.ts') || file.endsWith('.json'), [
        'backend/package.json', 'backend/pnpm-lock.yaml', 'backend/tsconfig.json', 'backend/vitest.config.ts',
    ]],
    ['frontend/dist/index.html', 'frontend/src', (file) => /\.(ts|tsx|css)$/.test(file), [
        'frontend/package.json', 'frontend/pnpm-lock.yaml', 'frontend/tsconfig.json', 'frontend/tsconfig.node.json',
        'frontend/vite.config.ts', 'frontend/index.html',
    ]],
]) {
    const output = path.join(rootDir, outputRelative)
    if (!(await exists(output))) {
        record(`build.${sourceRelative.split('/')[0]}`, 'FAIL', `缺少构建产物 ${outputRelative}`)
        continue
    }
    const outputMtime = (await stat(output)).mtimeMs
    let sourceMtime = await latestMtime(path.join(rootDir, sourceRelative), accept)
    for (const input of buildInputs) {
        const absoluteInput = path.join(rootDir, input)
        if (await exists(absoluteInput)) sourceMtime = Math.max(sourceMtime, (await stat(absoluteInput)).mtimeMs)
    }
    record(`build.${sourceRelative.split('/')[0]}`, outputMtime >= sourceMtime ? 'PASS' : 'FAIL', outputMtime >= sourceMtime
        ? `${outputRelative} 不早于源码`
        : `${outputRelative} 已过期，必须重新构建`)
}

const bundle = await readJson('docs/audit/frontend-bundle-budget-latest.json')
record('evidence.bundle', bundle?.pass === true && bundle.gzipBytes <= 120000 ? 'PASS' : 'FAIL', bundle
    ? `初始 JS gzip ${bundle.gzipBytes}B / 120000B`
    : '缺少首屏包体证据')
const api = await readJson('docs/audit/api-contract-latest.json')
const apiOk = api?.summary?.frontendCalls === 210
    && api?.summary?.backendEndpoints === 219
    && api?.summary?.matched === 210
    && api?.summary?.missingPaths === 0
    && api?.summary?.methodMismatches === 0
record('evidence.api-contract', apiOk ? 'PASS' : 'FAIL', api
    ? `前端调用 ${api.summary.frontendCalls}/210，后端端点 ${api.summary.backendEndpoints}/219，匹配 ${api.summary.matched}，路径缺失 ${api.summary.missingPaths}，方法错配 ${api.summary.methodMismatches}`
    : '缺少 API 契约证据')
const route = await readJson('docs/audit/route-smoke-latest.json')
const routeFailures = route?.summary?.failed ?? route?.failed ?? route?.failedCount
record('evidence.routes', routeFailures === 0 ? 'PASS' : 'FAIL', route
    ? `HTTP 路由失败数 ${routeFailures ?? '未知'}`
    : '缺少路由冒烟证据')
const runtimeEndpoints = await readJson('docs/audit/runtime-endpoint-verification-latest.json')
const runtimeEndpointsOk = runtimeEndpoints?.status === 'passed'
    && runtimeEndpoints?.http?.verifiedDeclarations === 214
    && runtimeEndpoints?.http?.failures === 0
    && runtimeEndpoints?.websocket?.verifiedDeclarations === 1
    && runtimeEndpoints?.websocket?.unauthenticatedRejected === true
    && runtimeEndpoints?.websocket?.crossOriginRejected === true
    && runtimeEndpoints?.websocket?.authenticatedHandshake === true
record('evidence.runtime-endpoints', runtimeEndpointsOk ? 'PASS' : 'FAIL', runtimeEndpoints
    ? `运行时覆盖 ${runtimeEndpoints.http?.verifiedDeclarations ?? '未知'} 条 HTTP + ${runtimeEndpoints.websocket?.verifiedDeclarations ?? '未知'} 条 WebSocket；未认证拒绝 ${runtimeEndpoints.websocket?.unauthenticatedRejected === true ? '通过' : '缺失'}`
    : '缺少 HTTP/认证/WebSocket 聚合运行时证据')
const websocket = await readJson('docs/audit/websocket-smoke-latest.json')
const websocketOk = websocket?.status === 'passed'
    && websocket?.unauthenticatedWebSocket?.rejected === true
    && websocket?.crossOriginWebSocket?.rejected === true
    && websocket.connected && websocket.sessionStart && websocket.pong
record('evidence.websocket', websocketOk ? 'PASS' : 'FAIL', websocket
    ? `WebSocket 状态 ${websocket.status}`
    : '缺少 WebSocket 冒烟证据')
const productionE2E = await readJson('docs/audit/production-e2e-latest.json')
const productionAuthE2EOk = productionE2E?.authStatusFailureClosed?.checked === true
    && productionE2E?.authStatusFailureClosed?.demoShortcutHidden === true
    && productionE2E?.authStatusFailureClosed?.submitDisabled === true
    && (mode !== 'live'
        || (productionE2E?.authMode === 'password'
            && productionE2E?.passwordAuthentication?.checked === true
            && productionE2E?.passwordAuthentication?.credentialSource === 'ephemeral-random-runtime-only'))
const productionE2EOk = productionE2E?.hosting === 'fastify-production-same-origin'
    && productionE2E?.nodeEnv === 'production'
    && productionE2E?.routeViewportCombinations === 32
    && productionE2E?.warnings === 0
    && productionE2E?.failures === 0
    && productionE2E?.dashboardAlertActionSemantics?.checked === true
    && productionE2E?.reportHistoryActionSemantics?.checked === true
    && productionE2E?.diagnosisStudentListKeyboard?.checked === true
    && productionE2E?.gradingProgressTransitionKeyboard?.checked === true
    && productionE2E?.gradingCardSwapMotionControl?.checked === true
    && productionE2E?.gradingStackGalleryAccessibility?.checked === true
    && productionE2E?.immersiveDrawerAccessibility?.checked === true
    && productionE2E?.workbenchRichMarkdownDetailAccessibility?.checked === true
    && productionE2E?.copilotMarkdownImageRecovery?.checked === true
    && productionE2E?.copilotAttachmentPreviewRecovery?.checked === true
    && productionE2E?.lessonPlanImageGallery?.checked === true
    && productionE2E?.starMapPoetryGallery?.checked === true
    && productionE2E?.sphereGalleryLightweightResourceBoundary?.checked === true
    && productionE2E?.evolutionEmptyEvidence?.checked === true
    && productionE2E?.evolutionPatternLinkedNavigation?.checked === true
    && productionE2E?.truthBoundaryChecks?.poemContent === true
    && productionE2E?.truthBoundaryChecks?.unauthenticatedApiRejected === true
    && productionE2E?.offlineDisclosure?.checked === true
    && productionE2E?.offlineDisclosure?.unsavedChangesAreNotClaimedAsQueued === true
    && productionE2E?.keyboardNavigation?.checked === true
    && productionE2E?.keyboardNavigation?.firstFocusIsSkipLink === true
    && productionE2E?.keyboardNavigation?.skipLinkMovesFocusToMain === true
    && productionE2E?.modalFocusManagement?.checked === true
    && productionE2E?.modalFocusManagement?.forwardAndReverseTrap === true
    && productionE2E?.modalFocusManagement?.escapeCloses === true
    && productionE2E?.modalFocusManagement?.focusReturnsToTrigger === true
    && productionE2E?.notificationEmptyDialogFocus?.checked === true
    && Array.isArray(productionE2E?.notificationEmptyDialogFocus?.verifies)
    && [
        'empty-modal-dialog-has-programmatic-focus-target-and-receives-initial-focus',
        'empty-modal-dialog-retains-focus-on-tab-and-shift-tab',
        'escape-closes-empty-notification-dialog-and-restores-trigger-focus',
        'mobile-empty-notification-dialog-remains-unclipped-without-page-horizontal-overflow',
    ].every((verification) => productionE2E.notificationEmptyDialogFocus.verifies.includes(verification))
    && productionE2E?.commandPaletteMobile?.checked === true
    && Array.isArray(productionE2E?.commandPaletteMobile?.verifies)
    && [
        'ctrl-or-command-k-opens-the-lazy-command-palette-and-focuses-search-input',
        'search-input-exposes-combobox-listbox-active-descendant-contract',
        'arrow-navigation-updates-active-descendant-and-single-roving-option-tab-stop',
        'mobile-command-palette-remains-within-viewport-without-page-horizontal-overflow',
        'tab-from-search-input-remains-within-command-dialog',
        'escape-closes-command-palette-and-restores-source-trigger-focus-after-parent-unmount',
    ].every((verification) => productionE2E.commandPaletteMobile.verifies.includes(verification))
    && productionE2E?.sidebarResizerKeyboard?.checked === true
    && productionE2E?.sidebarResizerKeyboard?.viewport === '1440x900;390x844'
    && Array.isArray(productionE2E?.sidebarResizerKeyboard?.verifies)
    && [
        'focusable-vertical-separator-exposes-current-minimum-and-maximum-width-values',
        'home-end-arrow-and-page-keys-update-sidebar-width-with-focus-retained',
        'desktop-drag-entering-mobile-breakpoint-releases-global-resize-state-and-keeps-page-without-horizontal-overflow',
    ].every((verification) => productionE2E.sidebarResizerKeyboard.verifies.includes(verification))
    && productionE2E?.poemImageCardAccessibility?.checked === true
    && Array.isArray(productionE2E?.poemImageCardAccessibility?.verifies)
    && [
        'image-card-exposes-sibling-native-open-button-and-download-link',
        'image-lightbox-focuses-close-control-and-keeps-tab-boundary',
        'escape-closes-image-lightbox-and-restores-the-source-button-focus',
        'aborted-image-resource-ends-loading-state-and-hides-misleading-open-and-download-controls',
        'failed-http-image-reload-issues-a-fresh-cache-busted-request',
        'reduced-motion-image-cards-remain-visually-opaque',
    ].every((verification) => productionE2E.poemImageCardAccessibility.verifies.includes(verification))
    && Array.isArray(productionE2E?.copilotMarkdownImageRecovery?.verifies)
    && [
        'failed-markdown-image-replaces-loading-affordance-with-an-announced-readable-status',
        'failure-status-keeps-image-alt-context-and-removes-the-broken-image-element',
        'failed-http-markdown-image-retry-issues-a-fresh-cache-busted-request',
    ].every((verification) => productionE2E.copilotMarkdownImageRecovery.verifies.includes(verification))
    && Array.isArray(productionE2E?.lessonPlanImageGallery?.verifies)
    && [
        'aborted-image-request-becomes-a-nonblank-stable-readable-failure-state-without-disabling-preview',
        'reduced-motion-forced-colors-and-print-preserve-an-explicit-usable-fallback',
    ].every((verification) => productionE2E.lessonPlanImageGallery.verifies.includes(verification))
    && Array.isArray(productionE2E?.starMapPoetryGallery?.verifies)
    && [
        'failed-poem-image-preserves-the-poem-selection-business-action',
        'closing-detail-with-button-or-escape-restores-the-originating-poem-card-focus',
        'mobile-detail-sheet-is-opaque-settled-topmost-touch-blocking-and-reduced-motion-safe',
    ].every((verification) => productionE2E.starMapPoetryGallery.verifies.includes(verification))
    && Array.isArray(productionE2E?.sphereGalleryLightweightResourceBoundary?.verifies)
    && [
        'gallery-and-starmap-dome-source-contain-no-three-webgl-canvas-or-raf-path',
        'lesson-plan-and-opted-in-starmap-gallery-load-no-three-vendor-resource',
        'both-consumers-render-zero-canvas-elements',
    ].every((verification) => productionE2E.sphereGalleryLightweightResourceBoundary.verifies.includes(verification))
    && productionE2E?.securityHeaders?.shell?.contentSecurityPolicy?.includes("default-src 'self'")
    && productionE2E?.securityHeaders?.shell?.contentSecurityPolicy?.includes("media-src 'self' blob: data:")
    && productionE2E?.securityHeaders?.shell?.xFrameOptions === 'SAMEORIGIN'
    && productionE2E?.securityHeaders?.shell?.xContentTypeOptions === 'nosniff'
    && Boolean(productionE2E?.securityHeaders?.shell?.referrerPolicy)
    && productionE2E?.securityHeaders?.shell?.strictTransportSecurity?.includes('max-age=')
    && productionE2E?.securityHeaders?.shell?.permissionsPolicy?.includes('microphone=(self)')
    && productionE2E?.securityHeaders?.shell?.permissionsPolicy?.includes('camera=()')
    && productionE2E?.securityHeaders?.shell?.permissionsPolicy?.includes('geolocation=()')
    && productionE2E?.securityHeaders?.shell?.permissionsPolicy?.includes('payment=()')
    && productionE2E?.securityHeaders?.shell?.permissionsPolicy?.includes('usb=()')
    && productionE2E?.securityHeaders?.api?.cacheControl?.includes('private')
    && productionE2E?.securityHeaders?.api?.cacheControl?.includes('no-store')
    && productionE2E?.securityHeaders?.api?.pragma === 'no-cache'
    && productionE2E?.generatedMediaBoundary?.checked === true
    && productionE2E?.generatedMediaBoundary?.unauthenticatedRejected === true
    && productionE2E?.generatedMediaBoundary?.authenticatedRead === true
    && productionE2E?.generatedMediaBoundary?.cacheControl?.includes('private')
    && productionE2E?.generatedMediaBoundary?.cacheControl?.includes('no-store')
    && productionE2E?.cultureDemoGalleryFallback?.checked === true
    && productionE2E?.cultureDemoGalleryFallback?.poemBound === true
    && productionE2E?.cultureDemoGalleryFallback?.localIllustrationOnly === true
    && productionE2E?.cultureDemoGalleryFallback?.aiGeneratedFalse === true
    && productionE2E?.cultureDemoGalleryFallback?.fourUniqueSvgScenes === true
    && productionE2E?.cultureDemoGalleryFallback?.detailIndexReadable === true
    && productionE2E?.ttsBinaryContract?.checked === true
    && productionE2E?.ttsBinaryContract?.unauthenticatedRejected === true
    && productionE2E?.ttsBinaryContract?.authenticatedBinaryAudio === true
    && productionE2E?.ttsBinaryContract?.browserBlobPlayback === true
    && productionE2E?.ttsBinaryContract?.contentType?.startsWith('audio/')
    && productionE2E?.ttsBinaryContract?.cacheControl?.includes('private')
    && productionE2E?.ttsBinaryContract?.cacheControl?.includes('no-store')
    && productionE2E?.ttsBinaryContract?.signature === 'RIFF'
    && productionE2E?.voiceInputLifecycle?.checked === true
    && Array.isArray(productionE2E?.voiceInputLifecycle?.verifies)
    && [
        'normal-stop-waits-for-final-dataavailable-and-submits-exactly-one-multipart-asr-request',
        'second-click-during-pending-permission-cancels-late-stream-without-starting-recorder-or-submitting-asr',
        'late-media-permission-resolution-after-module-unmount-stops-the-stream-without-starting-recorder-or-submitting-asr',
        'active-recorder-module-unmount-stops-the-device-and-cancels-final-asr-delivery',
    ].every((verification) => productionE2E.voiceInputLifecycle.verifies.includes(verification))
    && productionE2E?.quickVoiceCaptureLifecycle?.checked === true
    && productionE2E?.quickVoiceCaptureLifecycle?.viewport === '1440x900;390x844'
    && Array.isArray(productionE2E?.quickVoiceCaptureLifecycle?.verifies)
    && [
        'normal-stop-waits-for-final-dataavailable-and-refills-editable-ai-copilot-input-with-one-multipart-asr-request',
        'pending-permission-keeps-an-explicit-cancel-control-and-late-stream-never-starts-recorder-or-submits-asr',
        'late-media-permission-after-ai-copilot-unmount-stops-the-stream-without-starting-recorder-or-submitting-asr',
        'active-quick-voice-recorder-unmount-stops-the-device-and-cancels-final-asr-delivery',
        'mobile-quick-voice-action-remains-unclipped-with-at-least-44px-touch-height',
    ].every((verification) => productionE2E.quickVoiceCaptureLifecycle.verifies.includes(verification))
    && productionE2E?.recitationAudioReferenceBoundary?.checked === true
    && productionE2E?.recitationAudioReferenceBoundary?.arbitraryExternalUrlRejected === true
    && productionE2E?.recitationAudioReferenceBoundary?.pathTraversalRejected === true
    && productionE2E?.recitationAudioReferenceBoundary?.queryStringRejected === true
    && productionE2E?.recitationAudioReferenceBoundary?.backslashRejected === true
    && productionE2E?.recitationAudioReferenceBoundary?.ttsReferenceRejectedForEvaluation === true
    && productionE2E?.recitationAudioReferenceBoundary?.unsafeTtsVoiceRejected === true
    && productionE2E?.recitationAudioReferenceBoundary?.modelReceivesControlledBufferOnly === true
    && productionE2E?.gradingImageReferenceBoundary?.checked === true
    && productionE2E?.gradingImageReferenceBoundary?.arbitraryExternalUrlRejected === true
    && productionE2E?.gradingImageReferenceBoundary?.inlineImageMagicRequired === true
    && productionE2E?.gradingImageReferenceBoundary?.dashscopeDownloadAllowlisted === true
    && productionE2E?.aiChatImageReferenceBoundary?.checked === true
    && productionE2E?.aiChatImageReferenceBoundary?.arbitraryExternalUrlRejected === true
    && productionE2E?.aiChatImageReferenceBoundary?.inlineImageMagicRequired === true
    && productionE2E?.aiChatImageReferenceBoundary?.imagePartsRestrictedToUserMessages === true
    && productionE2E?.aiChatImageReferenceBoundary?.requestBodyAndAggregateLimitsConfigured === true
    && productionE2E?.persistentImageReferenceBoundary?.checked === true
    && productionE2E?.persistentImageReferenceBoundary?.externalTrackerUrlRejectedBeforePersistence === true
    && productionE2E?.persistentImageReferenceBoundary?.generatedWebpPathAllowlisted === true
    && productionE2E?.creationTaskPublishing?.checked === true
    && Array.isArray(productionE2E?.creationTaskPublishing?.verifies)
    && ['authenticated-poem-load', 'authenticated-task-create', 'published-task-board-receipt']
        .every((verification) => productionE2E.creationTaskPublishing.verifies.includes(verification))
    && Array.isArray(productionE2E?.reportHistoryActionSemantics?.verifies)
    && [
        'native-table-row-has-no-button-role-tab-stop-or-row-level-navigation',
        'completed-and-failed-reports-expose-disambiguated-native-view-and-delete-actions',
        'generating-report-keeps-view-unavailable-while-preserving-a-named-delete-action',
        'neutral-title-cell-does-not-trigger-report-detail-fetch',
        'keyboard-enter-on-view-button-fetches-only-the-declared-report-and-transfers-focus-to-loaded-title',
        'mobile-history-prioritizes-title-status-time-and-actions-without-table-or-page-horizontal-overflow',
    ].every((verification) => productionE2E.reportHistoryActionSemantics.verifies.includes(verification))
    && Array.isArray(productionE2E?.gradingCardSwapMotionControl?.verifies)
    && [
        'non-actionable-comparison-cards-do-not-fake-button-semantics-or-pointer-cursor',
        'native-named-control-explicitly-pauses-and-keyboard-space-resumes-automatic-comparison-rotation',
        'paused-state-freezes-card-transforms-rather-than-only-changing-a-label',
        'hover-pauses-as-progressive-enhancement-without-replacing-explicit-control',
        'prefers-reduced-motion-stops-timer-and-card-motion-with-a-truthful-static-disclosure',
        'mobile-motion-control-remains-visible-at-least-24px-and-without-page-horizontal-overflow',
    ].every((verification) => productionE2E.gradingCardSwapMotionControl.verifies.includes(verification))
    && Array.isArray(productionE2E?.gradingStackGalleryAccessibility?.verifies)
    && [
        'visible-stack-cards-use-native-buttons-without-faux-button-role',
        'all-visible-cards-are-tab-reachable-and-autoplay-pauses-while-gallery-has-focus',
        'keyboard-enter-opens-labelled-lightbox-and-focuses-explicit-close-control',
        'lightbox-traps-tab-and-shift-tab-within-available-controls',
        'escape-closes-lightbox-and-restores-source-card-focus',
        'aborted-student-image-replaces-stack-card-and-lightbox-with-readable-nonblank-fallbacks',
        'mobile-stack-gallery-action-remains-unclipped-without-page-horizontal-overflow',
    ].every((verification) => productionE2E.gradingStackGalleryAccessibility.verifies.includes(verification))
    && Array.isArray(productionE2E?.copilotAttachmentPreviewRecovery?.verifies)
    && [
        'preview-decode-error-replaces-thumbnail-with-a-named-polite-failure-state',
        'failed-preview-is-excluded-from-the-next-ai-request-payload',
        'teacher-can-still-send-a-pure-text-message-after-the-failed-attachment-is-fail-closed',
    ].every((verification) => productionE2E.copilotAttachmentPreviewRecovery.verifies.includes(verification))
    && Array.isArray(productionE2E?.immersiveDrawerAccessibility?.verifies)
    && [
        'closed-offscreen-drawer-has-no-dialog-modal-semantics-and-is-aria-hidden',
        'keyboard-open-focuses-explicit-close-control',
        'drawer-traps-tab-and-shift-tab-within-navigation-controls',
        'overlay-close-removes-dialog-semantics-and-restores-menu-trigger-focus',
        'mobile-drawer-stays-within-eighty-percent-viewport-with-40px-close-target-and-no-page-overflow',
    ].every((verification) => productionE2E.immersiveDrawerAccessibility.verifies.includes(verification))
    && productionE2E?.creationTaskMobileComposer?.checked === true
    && productionE2E?.creationTaskMobileComposer?.viewport === '390x844'
    && Array.isArray(productionE2E?.creationTaskMobileComposer?.verifies)
    && ['poem-select-visible-in-initial-viewport', 'form-controls-no-horizontal-clipping', 'submit-target-minimum-size']
        .every((verification) => productionE2E.creationTaskMobileComposer.verifies.includes(verification))
    && productionE2E?.workbenchPoemFallbackTruth?.checked === true
    && Array.isArray(productionE2E?.workbenchPoemFallbackTruth?.verifies)
    && ['persistent-demo-poem-disclosure', 'live-generation-blocked', 'manual-live-poem-retry-restores-state']
        .every((verification) => productionE2E.workbenchPoemFallbackTruth.verifies.includes(verification))
    && productionE2E?.workbenchRefineModalMobile?.checked === true
    && productionE2E?.workbenchRefineModalMobile?.viewport === '390x844'
    && Array.isArray(productionE2E?.workbenchRefineModalMobile?.verifies)
    && [
        'visible-title-labels-the-modal-without-a-duplicate-aria-label',
        'dynamic-viewport-modal-panel-remains-inside-mobile-viewport-without-page-horizontal-overflow',
        'long-form-body-keeps-an-independent-scroll-container',
        'all-three-decision-actions-remain-visible-and-unclipped',
        'escape-closes-mobile-refine-modal-and-restores-source-trigger-focus',
    ].every((verification) => productionE2E.workbenchRefineModalMobile.verifies.includes(verification))
    && productionE2E?.workbenchRefineModalKeyboard?.checked === true
    && productionE2E?.workbenchRefineModalKeyboard?.viewport === '1440x1200'
    && Array.isArray(productionE2E?.workbenchRefineModalKeyboard?.verifies)
    && [
        'teacher-refine-entry-opens-a-labelled-modal',
        'mode-tablist-controls-panel-and-supports-arrow-home-end-navigation',
        'manual-edit-produces-a-visible-diff-and-enables-selected-adoption',
        'long-form-manual-edit-keeps-the-decision-footer-visible',
        'leaving-modal-retains-focus-until-the-dialog-unmounts',
        'escape-closes-the-modal-and-restores-trigger-focus',
        'unsaved-manual-edits-are-discarded-before-the-next-refine-session',
    ].every((verification) => productionE2E.workbenchRefineModalKeyboard.verifies.includes(verification))
    && Array.isArray(productionE2E?.workbenchRichMarkdownDetailAccessibility?.verifies)
    && [
        'rich-markdown-stem-remains-non-button-and-keeps-source-link',
        'single-native-detail-button-is-named-from-card-index',
        'keyboard-enter-opens-detail-and-escape-returns-focus-to-source-control',
    ].every((verification) => productionE2E.workbenchRichMarkdownDetailAccessibility.verifies.includes(verification))
    && Array.isArray(productionE2E?.evolutionEmptyEvidence?.verifies)
    && [
        'top-level-student-ai-tablist-controls-panel-and-supports-arrow-home-end-navigation',
        'ai-sidebar-tablist-controls-panel-and-supports-arrow-home-end-navigation',
        'empty-genealogy-discloses-that-no-version-evidence-exists',
        'empty-state-does-not-load-three-vendor-or-genealogy-renderer',
        'teacher-can-refresh-persisted-evidence-and-open-pattern-collection-conditions',
        'pattern-empty-state-discloses-signal-sources-and-opens-live-ai-run-evidence',
    ].every((verification) => productionE2E.evolutionEmptyEvidence.verifies.includes(verification))
    && Array.isArray(productionE2E?.evolutionPatternLinkedNavigation?.verifies)
    && [
        'pattern-list-uses-list-and-listitem-without-clickable-card-role',
        'only-patterns-with-persisted-edge-and-node-expose-native-related-version-action',
        'same-pattern-different-agent-remains-independent-and-cannot-borrow-edge',
        'related-version-chips-use-distinct-node-version-labels',
        'enter-selects-the-latest-matching-target-node-switches-to-genealogy-and-transfers-focus-to-tabpanel',
        'unlinked-stale-or-cross-agent-pattern-remains-informational-without-a-fabricated-navigation-action',
        'stale-edge-is-explicitly-disclosed-without-fabricated-navigation',
        'selected-node-detail-keeps-full-agent-id-when-it-fits-without-silent-slicing',
        'compact-agent-id-labels-use-explicit-ellipsis-and-preserve-full-title',
        'related-version-action-preserves-full-long-pattern-as-accessible-name',
        'pattern-source-multi-combobox-supports-home-end-filters-live-items-and-chip-removal-is-keyboard-reachable-at-least-24px-without-mobile-overflow',
        'mobile-pattern-action-remains-unclipped-at-least-32px-high-and-without-horizontal-overflow',
    ].every((verification) => productionE2E.evolutionPatternLinkedNavigation.verifies.includes(verification))
    && productionE2E?.copilotMaterialTruthBoundary?.checked === true
    && Array.isArray(productionE2E?.copilotMaterialTruthBoundary?.verifies)
    && [
        'student-outage-disclosure-without-demo-substitution',
        'poem-outage-disclosure-without-demo-substitution',
        'manual-retry-restores-live-anonymized-material-references',
    ].every((verification) => productionE2E.copilotMaterialTruthBoundary.verifies.includes(verification))
    && productionE2E?.classroomPoemTruthAndInnovativeMode?.checked === true
    && Array.isArray(productionE2E?.classroomPoemTruthAndInnovativeMode?.verifies)
    && [
        'classroom-launch-poem-outage-disclosure-without-local-substitution',
        'manual-retry-restores-live-launch-poem-selection',
        'poem-relay-mode-starts-through-frontend-backend-contract',
        'relay-poem-outage-blocks-unknown-source-start-and-retries-live-source',
        'relay-start-poem-combobox-has-explicit-name-and-recovers-live-source',
        'classroom-explain-panel-defaults-to-full-source-verification-disclosure-not-only-a-compact-badge',
        'deterministic-intervention-content-and-persisted-adoption',
    ].every((verification) => productionE2E.classroomPoemTruthAndInnovativeMode.verifies.includes(verification))
    && productionE2E?.culturePoemVerificationDisclosure?.checked === true
    && productionE2E?.culturePoemVerificationDisclosure?.viewport === '1440x900;390x844'
    && Array.isArray(productionE2E?.culturePoemVerificationDisclosure?.verifies)
    && [
        'unverified-or-incomplete-source-status-is-expanded-by-default-and-not-hidden-in-hover-only-content',
        'disclosure-separates-poem-scope-review-date-source-registration-and-ai-teaching-content-boundary',
        'native-summary-supports-enter-and-space-to-collapse-and-reopen-the-disclosure',
        'mobile-disclosure-remains-within-the-viewport-without-page-horizontal-overflow',
    ].every((verification) => productionE2E.culturePoemVerificationDisclosure.verifies.includes(verification))
    && productionE2E?.thinkingPalaceLightweightAudit?.checked === true
    && Array.isArray(productionE2E?.thinkingPalaceLightweightAudit?.verifies)
    && [
        'reduced-motion-defaults-to-clickable-two-dimensional-audit',
        'three-vendor-is-not-downloaded-before-teacher-opt-in',
        'teacher-can-explicitly-enable-immersive-three-dimensional-view',
        'thinking-chain-button-preserves-full-bounded-question-as-accessible-name',
    ].every((verification) => productionE2E.thinkingPalaceLightweightAudit.verifies.includes(verification))
    && productionE2E?.starMapLightweightView?.checked === true
    && Array.isArray(productionE2E?.starMapLightweightView?.verifies)
    && [
        'reduced-motion-defaults-to-accessible-starmap-directory',
        'three-vendor-is-not-downloaded-before-or-after-starmap-teacher-opt-in',
        'teacher-opt-in-renders-a-lightweight-native-poetry-gallery-with-zero-canvas',
    ].every((verification) => productionE2E.starMapLightweightView.verifies.includes(verification))
    && productionAuthE2EOk
record('evidence.production-e2e', productionE2EOk ? 'PASS' : 'FAIL', productionE2E
    ? `生产同源 E2E ${productionE2E.routeViewportCombinations} 组，${productionE2E.warnings} 警告，${productionE2E.failures} 失败；认证=${productionE2E.authMode ?? '缺失'}，认证故障失败关闭、告警单操作入口、报告历史原生表格/具名查看删除/键盘查看、答题图片堆原生按钮/大图焦点闭环/资源失败非空终态、沉浸导航关闭态语义/遮罩回焦、空通知对话框焦点兜底/窄屏视口几何、命令面板 Ctrl/Cmd+K/组合框 roving/窄屏几何/卸载回焦、命题精修模态框可见标题命名/动态视口/独立滚动/决策区、诊断学生 roving 焦点、批改进度 Space/Enter 状态切换、命题富 Markdown 题干语义隔离/详情入口/焦点归还、进化模式真实关联版本定位/陈旧边失败关闭/焦点交接、文化语境原文验收默认披露/原生详情键盘开合/窄屏几何、生成媒体会话边界、DEMO 文化图库同诗 SVG 来源与详情索引、TTS/跟读录音收尾、迟到授权取消、组件卸载设备回收与 OCR/生图/AI 对话图片引用边界、内容真实性、未认证 API、断网披露、创造任务认证发布/看板回执、命题/课堂/副驾的诗库局部降级披露、演示隔离、创新模式契约与恢复、受限环境中的二维/目录优先与 Three.js 主动加载边界、生产安全头 ${productionE2EOk ? '通过' : '缺失'}`
    : '缺少生产同源 E2E 证据')

const dependencySecurity = await readJson('docs/audit/dependency-security-latest.json')
const dependencyAuditAgeMs = dependencySecurity?.generatedAt
    ? Date.now() - Date.parse(dependencySecurity.generatedAt)
    : Number.POSITIVE_INFINITY
const dependencyAuditFresh = dependencyAuditAgeMs >= 0 && dependencyAuditAgeMs <= 7 * 86_400_000
const dependencyStatus = dependencySecurity?.status
const dependencyGate = !dependencyAuditFresh || dependencyStatus === 'failed' || !dependencyStatus
    ? 'FAIL'
    : dependencyStatus === 'passed_with_mitigations' ? 'WARN' : 'PASS'
record('evidence.dependency-security', dependencyGate, dependencySecurity
    ? `生产依赖审计 ${dependencyStatus}，需修复 ${dependencySecurity.summary?.actionRequired ?? '未知'}，条件缓解 ${dependencySecurity.summary?.conditionallyNotApplicable ?? '未知'}，${dependencyAuditFresh ? '7 天内' : '已过期'}`
    : '缺少生产依赖安全审计证据')

const productionLicenses = await readJson('docs/audit/production-licenses-latest.json')
const licenseAuditAgeMs = productionLicenses?.generatedAt
    ? Date.now() - Date.parse(productionLicenses.generatedAt)
    : Number.POSITIVE_INFINITY
const licenseAuditFresh = licenseAuditAgeMs >= 0 && licenseAuditAgeMs <= 7 * 86_400_000
const licenseFilesPresent = await exists(path.join(rootDir, 'LICENSE'))
    && await exists(path.join(rootDir, 'THIRD_PARTY_NOTICES.md'))
const sourceReviewRecord = typeof productionLicenses?.sourceReviewGuidance?.evidenceRecord === 'string'
    ? productionLicenses.sourceReviewGuidance.evidenceRecord
    : null
const sourceReviewEvidencePresent = sourceReviewRecord
    ? await exists(path.join(rootDir, sourceReviewRecord))
    : false
const licenseGate = !licenseAuditFresh || !licenseFilesPresent
    || !sourceReviewEvidencePresent
    || productionLicenses?.status === 'failed'
    || productionLicenses?.summary?.forbiddenCopyleft !== 0
    ? 'FAIL'
    : productionLicenses?.status === 'passed_with_review' ? 'WARN' : 'PASS'
record('evidence.production-licenses', licenseGate, productionLicenses
    ? `生产包 ${productionLicenses.summary?.uniquePackages ?? '未知'}，GPL/AGPL ${productionLicenses.summary?.forbiddenCopyleft ?? '未知'}，人工复核 ${productionLicenses.summary?.reviewRequired ?? '未知'}，npm 元数据未声明许可证 ${productionLicenses.summary?.packagesWithoutDeclaredLicense ?? '未知'}，包根目录文本未发现 ${productionLicenses.summary?.packageRootLicenseFilesAbsent ?? '未知'}（不等同于无许可证）；LICENSE/NOTICE ${licenseFilesPresent ? '存在' : '缺失'}，来源复核记录 ${sourceReviewEvidencePresent ? '存在' : '缺失'}，${licenseAuditFresh ? '7 天内' : '已过期'}`
    : '缺少生产许可证清单')

const releaseBoundary = await readJson('docs/audit/release-boundary-latest.json')
const releaseAuditAgeMs = releaseBoundary?.generatedAt
    ? Date.now() - Date.parse(releaseBoundary.generatedAt)
    : Number.POSITIVE_INFINITY
const releaseAuditFresh = releaseAuditAgeMs >= 0 && releaseAuditAgeMs <= 7 * 86_400_000
const releaseBoundaryOk = releaseAuditFresh
    && ['passed', 'passed_with_local_sensitive_exclusions'].includes(releaseBoundary?.status)
    && releaseBoundary?.summary?.releaseSecretFindings === 0
    && releaseBoundary?.summary?.links === 0
record('evidence.release-boundary', releaseBoundaryOk ? 'PASS' : 'FAIL', releaseBoundary
    ? `发布候选密钥命中 ${releaseBoundary.summary?.releaseSecretFindings ?? '未知'}，排除本地私密文件 ${releaseBoundary.summary?.privateFiles ?? '未知'}，链接 ${releaseBoundary.summary?.links ?? '未知'}，${releaseAuditFresh ? '7 天内' : '已过期'}`
    : '缺少发布边界与敏感文件审计证据')

const imageAssets = await readJson('docs/audit/image-assets-latest.json')
const imageAuditAgeMs = imageAssets?.generatedAt
    ? Date.now() - Date.parse(imageAssets.generatedAt)
    : Number.POSITIVE_INFINITY
const imageAuditFresh = imageAuditAgeMs >= 0 && imageAuditAgeMs <= 7 * 86_400_000
let imageTrackedInputsCurrent = Array.isArray(imageAssets?.trackedInputFiles)
    && imageAssets.trackedInputFiles.length >= 40
if (imageTrackedInputsCurrent) {
    const inputResults = await Promise.all(imageAssets.trackedInputFiles.map(async (input) => {
        if (typeof input?.path !== 'string' || !/^[a-f0-9]{64}$/u.test(input?.sha256 ?? '')) return false
        const file = path.resolve(rootDir, input.path)
        const relative = path.relative(rootDir, file)
        if (path.isAbsolute(input.path) || relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false
        return await exists(file) && await sha256(file) === input.sha256
    }))
    imageTrackedInputsCurrent = inputResults.every(Boolean)
}
const imageAssetsOk = imageAuditFresh
    && imageTrackedInputsCurrent
    && imageAssets?.gate === 'PASS'
    && imageAssets?.summary?.blockers === 0
    && imageAssets?.summary?.curatedReleaseWebp === 22
    && imageAssets?.summary?.productionRuntimeStarmapReferences === 0
    && imageAssets?.summary?.productionSvgReferences === 0
    && imageAssets?.summary?.releaseContamination === 0
    && imageAssets?.releaseMapping?.entries?.length === 22
    && imageAssets?.distParity?.status === 'passed'
record('evidence.image-assets', imageAssetsOk ? 'PASS' : 'FAIL', imageAssets
    ? `图像门 ${imageAssets.gate}；随包精选 WebP ${imageAssets.summary?.curatedReleaseWebp ?? '未知'}/22；正式内容 SVG 引用 0；运行时缓存生产映射 ${imageAssets.summary?.productionRuntimeStarmapReferences ?? '未知'}；发布污染 ${imageAssets.summary?.releaseContamination ?? '未知'}；dist 同源 ${imageAssets.distParity?.status ?? '未知'}；输入哈希${imageTrackedInputsCurrent ? '当前' : '已变化'}；${imageAuditFresh ? '7 天内' : '已过期'}`
    : '缺少逐图解码、来源、引用与发布包边界审计证据')

const provenance = await readJson('docs/audit/poem-provenance-latest.json')
const provenanceOk = provenance?.gate === 'PASS'
    && provenance?.totalPoems > 0
    && provenance?.statusCounts?.VERIFIED === provenance?.totalPoems
    && provenance?.integrityErrors?.length === 0
record('evidence.poem-provenance', provenanceOk ? 'PASS' : mode === 'demo' ? 'WARN' : 'FAIL', provenance
    ? `逐首内容复核 ${provenance.statusCounts?.VERIFIED ?? 0}/${provenance.totalPoems ?? 0} 通过；结构错误 ${provenance.integrityErrors?.length ?? '未知'}`
    : '缺少逐首双信源与语文教师复核证据')

const pilotEvidence = await readJson('docs/audit/pilot-evidence-latest.json')
const pilotOk = pilotEvidence?.gate === 'PASS'
    && pilotEvidence?.manifest?.dataKind === 'REAL'
    && pilotEvidence?.manifest?.consentAndAuthorizationConfirmed === true
    && pilotEvidence?.manifest?.piiRemoved === true
    && pilotEvidence?.dataset?.students > 0
    && pilotEvidence?.dataset?.schemaVersion === 2
    && pilotEvidence?.dataset?.measurementWindow?.pairedRecordsWithVerifiedDates > 0
    && Array.isArray(pilotEvidence?.metrics)
    && pilotEvidence.metrics.length > 0
    && pilotEvidence.metrics.every((metric) => metric.paired > 0)
record('evidence.real-pilot', pilotOk ? 'PASS' : mode === 'demo' ? 'WARN' : 'FAIL', pilotEvidence
    ? `真实试点门 ${pilotEvidence.gate}，匿名学生 ${pilotEvidence.dataset?.students ?? 0}，日期已验证的配对记录 ${pilotEvidence.dataset?.measurementWindow?.pairedRecordsWithVerifiedDates ?? 0}`
    : '缺少通过隐私、授权、最小化字段、日期窗口、缺失值和配对口径校验的真实试点报告')

const manifest = path.join(rootDir, '提交材料', '00-提交物清单与SHA256.md')
if (await exists(manifest)) {
    const content = await readFile(manifest, 'utf8')
    const entries = [...content.matchAll(/^\| `([^`]+)` \| [^|]+ \| `([a-f0-9]{64})` \|$/gmi)]
    let mismatch = 0
    for (const [, name, expected] of entries) {
        const file = path.join(rootDir, '提交材料', name)
        if (!(await exists(file)) || await sha256(file) !== expected.toLowerCase()) mismatch++
    }
    record('submission.integrity', entries.length >= 8 && mismatch === 0 ? 'PASS' : 'FAIL',
        `提交物哈希校验 ${entries.length - mismatch}/${entries.length} 通过`)
} else record('submission.integrity', 'FAIL', '缺少提交物 SHA-256 清单')

const sqlitePath = effectiveEnv.SQLITE_PATH
    ? path.resolve(path.join(rootDir, 'backend'), effectiveEnv.SQLITE_PATH)
    : path.join(rootDir, 'backend', 'data', 'poetic-realm.db')
try {
    await access(path.dirname(sqlitePath), fsConstants.R_OK | fsConstants.W_OK)
    record('storage.sqlite', 'PASS', 'SQLite 目录可读写（未修改数据）')
} catch {
    record('storage.sqlite', 'FAIL', 'SQLite 目录不存在或不可读写')
}

const failures = checks.filter((item) => item.status === 'FAIL').length
const warnings = checks.filter((item) => item.status === 'WARN').length
const report = {
    generatedAt: new Date().toISOString(), mode, deployment,
    status: failures === 0 ? 'passed' : 'failed',
    summary: { passed: checks.length - failures - warnings, warnings, failures, total: checks.length },
    checks,
}
for (const item of checks) console.log(`[${item.status}] ${item.id}: ${item.message}`)
console.log(`SUMMARY: ${report.summary.passed} PASS / ${warnings} WARN / ${failures} FAIL`)
if (writeReport) {
    const reportDir = path.join(rootDir, 'docs', 'audit')
    await mkdir(reportDir, { recursive: true })
    const destinations = [
        path.join(reportDir, `competition-preflight-${mode}-${deployment}-latest.json`),
        path.join(reportDir, 'competition-preflight-latest.json'),
    ]
    for (const destination of destinations) {
        const temporary = `${destination}.${process.pid}.tmp`
        await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, destination)
        console.log(`REPORT: ${destination}`)
    }
}
process.exitCode = failures === 0 ? 0 : 1
