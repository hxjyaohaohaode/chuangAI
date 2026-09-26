/**
 * 隔离式生产 E2E：由 Fastify 生产服务器同源托管 frontend/dist 与 /api、/ws，
 * 使用随机回环端口和临时 SQLite，执行完严格关闭服务并清理临时目录。
 */
import { spawn } from 'node:child_process'
import { randomBytes, scryptSync } from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = path.resolve(frontendRoot, '..')
const backendRoot = path.join(projectRoot, 'backend')
const serverEntry = path.join(backendRoot, 'dist', 'server.js')
const e2eEntry = path.join(frontendRoot, 'e2e-regression.mjs')
const e2eResults = path.join(frontendRoot, 'e2e-screenshots', 'regression', 'results.json')
const productionEvidence = path.join(projectRoot, 'docs', 'audit', 'production-e2e-latest.json')

// NTFS 提供亚秒级时间戳，但复制到较粗粒度文件系统时可能只保留整秒。
// 仅当构建输入至少比 dist/index.html 新 2 秒才判陈旧，在严格拦截与低误报间取边界。
const PRODUCTION_BUILD_FRESHNESS_TOLERANCE_MS = 2_000
const PRODUCTION_BUILD_FRESHNESS_REPORT_LIMIT = 8
const NON_PRODUCTION_SOURCE_DIRECTORIES = new Set([
    'graphify-out',
    'components/dev',
    'pages/_dev',
    '__tests__',
    '__snapshots__',
    'test',
    'tests',
    'coverage',
    'screenshots',
    'e2e-screenshots',
])
const ROOT_BUILD_INPUT_PATTERN = /^(?:\.env(?:\.local|\.production(?:\.local)?)?|\.npmrc|index\.html|package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|tsconfig(?:\.[^.]+)*\.json|(?:vite|postcss|tailwind)\.config\.[cm]?[jt]s)$/u

function normalizedRelativePath(root, target) {
    return path.relative(root, target).split(path.sep).join('/')
}

function isExcludedSourceDirectory(relativeDirectory) {
    const normalized = relativeDirectory.split(path.sep).join('/')
    const segments = normalized.split('/')
    return [...NON_PRODUCTION_SOURCE_DIRECTORIES].some((excluded) => (
        excluded.includes('/')
            ? normalized === excluded || normalized.startsWith(`${excluded}/`)
            : segments.includes(excluded)
    ))
}

async function collectRegularBuildInputs(directory, frontendDirectory, shouldExcludeDirectory = () => false) {
    const inputs = []
    const rootInfo = await fs.lstat(directory)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new Error(`生产构建输入目录不是普通目录：${normalizedRelativePath(frontendDirectory, directory)}`)
    }

    async function walk(currentDirectory) {
        const entries = await fs.readdir(currentDirectory, { withFileTypes: true })
        entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
        for (const entry of entries) {
            const absolute = path.join(currentDirectory, entry.name)
            const relative = normalizedRelativePath(frontendDirectory, absolute)
            if (entry.isDirectory()) {
                if (!shouldExcludeDirectory(relative)) await walk(absolute)
                continue
            }
            // 不跟随符号链接/联接点，避免把工作区外文件误算为本次生产输入。
            if (!entry.isFile() || entry.isSymbolicLink()) continue
            const info = await fs.lstat(absolute)
            if (!info.isFile() || info.isSymbolicLink()) continue
            inputs.push({ absolute, relative, mtimeMs: info.mtimeMs })
        }
    }

    await walk(directory)
    return inputs
}

async function collectProductionBuildInputs(frontendDirectory) {
    const inputs = await collectRegularBuildInputs(
        path.join(frontendDirectory, 'src'),
        frontendDirectory,
        (relativeDirectory) => isExcludedSourceDirectory(relativeDirectory.replace(/^src\//u, '')),
    )

    const publicDirectory = path.join(frontendDirectory, 'public')
    try {
        inputs.push(...await collectRegularBuildInputs(publicDirectory, frontendDirectory))
    } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error
    }

    const rootEntries = await fs.readdir(frontendDirectory, { withFileTypes: true })
    for (const entry of rootEntries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !ROOT_BUILD_INPUT_PATTERN.test(entry.name)) continue
        const absolute = path.join(frontendDirectory, entry.name)
        const info = await fs.lstat(absolute)
        if (!info.isFile() || info.isSymbolicLink()) continue
        inputs.push({ absolute, relative: entry.name, mtimeMs: info.mtimeMs })
    }

    return inputs.sort((left, right) => (
        right.mtimeMs - left.mtimeMs || left.relative.localeCompare(right.relative, 'en')
    ))
}

/**
 * 在任何服务、端口或临时数据库创建前，证明 E2E 将读取的 dist 不明显落后于
 * 当前生产构建输入。该门禁有意不把 runner、E2E 脚本、截图和审计文档算进 dist。
 */
export async function assertProductionBuildFreshness({
    frontendDirectory = frontendRoot,
    distIndexPath = path.join(frontendDirectory, 'dist', 'index.html'),
    toleranceMs = PRODUCTION_BUILD_FRESHNESS_TOLERANCE_MS,
    reportLimit = PRODUCTION_BUILD_FRESHNESS_REPORT_LIMIT,
} = {}) {
    if (!Number.isFinite(toleranceMs) || toleranceMs < 0) throw new Error('生产构建新鲜度容差必须是非负有限数值')
    if (!Number.isInteger(reportLimit) || reportLimit < 1) throw new Error('生产构建新鲜度报告条数必须是正整数')

    let distInfo
    try {
        distInfo = await fs.lstat(distIndexPath)
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            throw new Error('生产 E2E 拒绝启动：缺少 frontend/dist/index.html。请先在 frontend 运行生产构建 `pnpm build`。')
        }
        throw error
    }
    if (!distInfo.isFile() || distInfo.isSymbolicLink()) {
        throw new Error('生产 E2E 拒绝启动：frontend/dist/index.html 不是普通文件。请先重新运行生产构建 `pnpm build`。')
    }

    const inputs = await collectProductionBuildInputs(frontendDirectory)
    if (inputs.length === 0) throw new Error('生产 E2E 拒绝启动：没有找到可核验的前端生产构建输入。')
    const staleInputs = inputs.filter((input) => input.mtimeMs - distInfo.mtimeMs > toleranceMs)
    if (staleInputs.length > 0) {
        const latest = staleInputs[0]
        const listed = staleInputs.slice(0, reportLimit).map((input) => {
            const deltaSeconds = ((input.mtimeMs - distInfo.mtimeMs) / 1_000).toFixed(3)
            return `- ${input.relative}（${new Date(input.mtimeMs).toISOString()}，比产物新 ${deltaSeconds}s）`
        }).join('\n')
        const omitted = staleInputs.length > reportLimit
            ? `\n- ……另有 ${staleInputs.length - reportLimit} 个明显较新的构建输入未展开`
            : ''
        throw new Error(
            '生产 E2E 拒绝启动：frontend/dist/index.html 已陈旧，继续测试会生成与当前源码不一致的假证据。\n'
            + `产物时间：${new Date(distInfo.mtimeMs).toISOString()}\n`
            + `最新输入：${latest.relative}；判定容差：${toleranceMs}ms\n`
            + `${listed}${omitted}\n`
            + '请先在 frontend 运行生产构建 `pnpm build`，构建成功后再运行 `pnpm e2e:isolated`。',
        )
    }

    return {
        checked: true,
        inputCount: inputs.length,
        latestInput: inputs[0].relative,
        latestInputMtime: new Date(inputs[0].mtimeMs).toISOString(),
        distIndexMtime: new Date(distInfo.mtimeMs).toISOString(),
        toleranceMs,
    }
}

function assertCompetitionNodeRuntime() {
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major !== 24 || minor < 11) {
        throw new Error(
            `生产同源 E2E 必须由锁定的 Node.js >=24.11 <25 启动；当前为 ${process.versions.node}。` +
            '请先切换到比赛运行时后再运行，避免子进程与 better-sqlite3 原生模块发生 ABI 不匹配。',
        )
    }
}

assertCompetitionNodeRuntime()

const authModeArgument = process.argv.includes('--auth-mode')
    ? process.argv[process.argv.indexOf('--auth-mode') + 1]
    : 'demo'
if (!['demo', 'password'].includes(authModeArgument)) {
    throw new Error('用法：node scripts/run-e2e-isolated.mjs [--auth-mode demo|password]')
}
const authMode = authModeArgument

function createEphemeralPasswordConfiguration() {
    const password = randomBytes(24).toString('base64url')
    const salt = randomBytes(16)
    const N = 16_384
    const r = 8
    const p = 1
    const derived = scryptSync(password, salt, 32, { N, r, p, maxmem: 128 * 1024 * 1024 })
    return {
        password,
        hash: `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${derived.toString('base64url')}`,
        sessionSecret: randomBytes(32).toString('base64url'),
    }
}

function reserveFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : 0
            server.close((error) => error ? reject(error) : resolve(port))
        })
    })
}

async function waitForHealth(baseUrl, server, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    let lastError = '服务尚未响应'
    while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error(`生产 E2E 服务提前退出：${server.exitCode}`)
        try {
            const response = await fetch(`${baseUrl}/api/health`)
            if (response.ok) return
            lastError = `health status=${response.status}`
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new Error(`生产 E2E 健康检查超时：${lastError}`)
}

async function acquireSession(baseUrl, password) {
    const phone = password ? '13900000000' : '13177091153'
    const effectivePassword = password || 'Chy101713'
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            phone,
            password: effectivePassword,
        }),
    })
    if (response.status !== 200) throw new Error(`生产 E2E 认证会话建立失败：HTTP ${response.status}`)
    const body = await response.json()
    const rawSetCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie') ?? '']
    const cookiePairs = rawSetCookies
        .flatMap((value) => [...value.matchAll(/\b(pr_(?:session|csrf)=[^;,]+)/gu)].map((match) => match[1]))
        .filter(Boolean)
    if (cookiePairs.length !== 2 || typeof body?.csrfToken !== 'string') {
        throw new Error('生产 E2E 认证响应缺少 Cookie 或 CSRF')
    }
    return { cookie: cookiePairs.join('; '), csrfToken: body.csrfToken }
}

async function verifyTruthBoundaries(baseUrl, session) {
    const response = await fetch(`${baseUrl}/api/poem-content/tongbian-001`, {
        headers: { cookie: session.cookie },
        signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`诗内容真实性字段检查失败：HTTP ${response.status}`)
    const body = await response.json()
    const verification = body?.sourceVerification
    const allowedStatuses = new Set(['VERIFIED', 'UNVERIFIED', 'INCOMPLETE', 'STALE'])
    const allowedTeachingStatuses = new Set(['NOT_GENERATED', 'AI_UNVERIFIED'])
    if (body?.status !== 'ok'
        || !verification
        || !allowedStatuses.has(verification.status)
        || !allowedTeachingStatuses.has(body.teachingContentReviewStatus)
        || typeof verification.message !== 'string'
        || !/^[a-f0-9]{64}$/u.test(verification.contentSha256)) {
        throw new Error('诗内容接口缺少可核验的来源/AI 教学内容复核边界')
    }
    if (verification.status !== 'VERIFIED' && verification.reviewedAt !== null) {
        throw new Error('未放行诗篇不得携带已验收日期')
    }
    return true
}

async function verifySecurityHeaders(baseUrl, session) {
    const shellResponse = await fetch(`${baseUrl}/`)
    if (!shellResponse.ok) throw new Error(`生产页面安全响应头检查失败：HTTP ${shellResponse.status}`)
    const shellHeaders = {
        contentSecurityPolicy: shellResponse.headers.get('content-security-policy') ?? '',
        xFrameOptions: shellResponse.headers.get('x-frame-options') ?? '',
        xContentTypeOptions: shellResponse.headers.get('x-content-type-options') ?? '',
        referrerPolicy: shellResponse.headers.get('referrer-policy') ?? '',
        strictTransportSecurity: shellResponse.headers.get('strict-transport-security') ?? '',
        permissionsPolicy: shellResponse.headers.get('permissions-policy') ?? '',
    }
    if (!shellHeaders.contentSecurityPolicy.includes("default-src 'self'")) {
        throw new Error('生产页面缺少限制同源默认资源的 CSP')
    }
    if (!shellHeaders.contentSecurityPolicy.includes("object-src 'none'")) {
        throw new Error('生产页面 CSP 未禁用插件对象')
    }
    if (!shellHeaders.contentSecurityPolicy.includes("media-src 'self' blob: data:")) {
        throw new Error('生产页面 CSP 未放行受控同源/Blob/Data 音频')
    }
    if (shellHeaders.xFrameOptions.toUpperCase() !== 'SAMEORIGIN') {
        throw new Error(`生产页面点击劫持防护异常：${shellHeaders.xFrameOptions || 'missing'}`)
    }
    if (shellHeaders.xContentTypeOptions.toLowerCase() !== 'nosniff') {
        throw new Error(`生产页面 MIME 嗅探防护异常：${shellHeaders.xContentTypeOptions || 'missing'}`)
    }
    if (!shellHeaders.referrerPolicy) throw new Error('生产页面缺少 Referrer-Policy')
    if (!shellHeaders.strictTransportSecurity.includes('max-age=')) {
        throw new Error('生产页面缺少 HSTS 响应头')
    }
    if (!shellHeaders.permissionsPolicy.includes('microphone=(self)')
        || !shellHeaders.permissionsPolicy.includes('camera=()')
        || !shellHeaders.permissionsPolicy.includes('geolocation=()')
        || !shellHeaders.permissionsPolicy.includes('payment=()')
        || !shellHeaders.permissionsPolicy.includes('usb=()')) {
        throw new Error(`生产页面 Permissions-Policy 未按最小权限收敛：${shellHeaders.permissionsPolicy || 'missing'}`)
    }

    const apiResponse = await fetch(`${baseUrl}/api/poem-content/tongbian-001`, {
        headers: { cookie: session.cookie },
    })
    if (!apiResponse.ok) throw new Error(`教学 API 缓存策略检查失败：HTTP ${apiResponse.status}`)
    const apiCacheControl = (apiResponse.headers.get('cache-control') ?? '').toLowerCase()
    if (!apiCacheControl.includes('private') || !apiCacheControl.includes('no-store')) {
        throw new Error(`教学 API 未禁止客户端/共享代理存储：${apiCacheControl || 'missing'}`)
    }
    if ((apiResponse.headers.get('pragma') ?? '').toLowerCase() !== 'no-cache') {
        throw new Error('教学 API 缺少兼容旧缓存代理的 Pragma: no-cache')
    }

    return {
        shell: shellHeaders,
        api: { cacheControl: apiCacheControl, pragma: 'no-cache' },
    }
}

async function verifyGeneratedMediaBoundary(baseUrl, session, runtimeRoot) {
    const sourceDirectory = path.join(projectRoot, 'data', 'uploads', 'generated')
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true })
    const mediaFile = entries
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.webp'))
        .map((entry) => entry.name)
        .sort()[0]
    if (!mediaFile) throw new Error('生成媒体认证边界 E2E 缺少可验证的 WebP 夹具')
    const generatedDirectory = path.join(runtimeRoot, 'uploads', 'generated')
    await fs.mkdir(generatedDirectory, { recursive: true })
    await fs.copyFile(path.join(sourceDirectory, mediaFile), path.join(generatedDirectory, mediaFile))

    const mediaUrl = `${baseUrl}/uploads/generated/${encodeURIComponent(mediaFile)}`
    const unauthenticated = await fetch(mediaUrl)
    if (unauthenticated.status !== 401) {
        throw new Error(`未认证生成媒体未失败关闭：HTTP ${unauthenticated.status}`)
    }
    const authenticated = await fetch(mediaUrl, { headers: { cookie: session.cookie } })
    if (!authenticated.ok) throw new Error(`已认证生成媒体读取失败：HTTP ${authenticated.status}`)
    if (!(authenticated.headers.get('content-type') ?? '').includes('image/webp')) {
        throw new Error('生成媒体 Content-Type 不是 image/webp')
    }
    const cacheControl = (authenticated.headers.get('cache-control') ?? '').toLowerCase()
    if (!cacheControl.includes('private')
        || !cacheControl.includes('no-store')
        || cacheControl.includes('public')
        || cacheControl.includes('max-age')) {
        throw new Error(`生成媒体缓存策略未收敛：${cacheControl || 'missing'}`)
    }
    return { checked: true, unauthenticatedRejected: true, authenticatedRead: true, cacheControl }
}

/**
 * DEMO 的文化图库必须是可离线复现的当前诗篇专属 WebP，而非首次读取时再赌外部
 * 文生图、借用其他诗篇缓存或回退 SVG。这里使用与浏览器回归相同的临时生产服务
 * 和认证会话，验证图库响应、来源标记与单图详情索引三者的一致性。
 */
async function verifyCultureDemoGalleryFallback(baseUrl, session) {
    const headers = { cookie: session.cookie }
    const response = await fetch(`${baseUrl}/api/culture/poems/tongbian-001/images`, {
        headers,
        signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`DEMO 文化图库读取失败：HTTP ${response.status}`)
    const body = await response.json()
    const images = Array.isArray(body?.images) ? body.images : []
    const ids = new Set(images.map((image) => image?.id))
    const invalidImage = images.find((image) => (
        !image
        || image.poemId !== 'tongbian-001'
        || image.source !== 'wan2.7-packaged'
        || image.aiGenerated !== true
        || typeof image.imageUrl !== 'string'
        || !/^\/images\/generated\/starmap\/tongbian-001\.webp$/u.test(image.imageUrl)
    ))
    if (body?.status !== 'ok'
        || body?.poemId !== 'tongbian-001'
        || body?.aiGenerated !== true
        || body?.source !== 'packaged-demo'
        || images.length !== 1
        || ids.size !== 1
        || invalidImage) {
        throw new Error(`DEMO 文化图库未收敛为当前诗篇专属 WebP：${JSON.stringify({
            status: body?.status,
            poemId: body?.poemId,
            source: body?.source,
            aiGenerated: body?.aiGenerated,
            imageCount: images.length,
            uniqueIds: ids.size,
            invalidImage: invalidImage?.id ?? null,
        })}`)
    }
    const first = images[0]
    const detail = await fetch(`${baseUrl}/api/culture/images/${encodeURIComponent(first.id)}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
    })
    if (!detail.ok) throw new Error(`DEMO 文化图库首张详情读取失败：HTTP ${detail.status}`)
    const detailBody = await detail.json()
    if (detailBody?.status !== 'ok'
        || detailBody?.image?.id !== first.id
        || detailBody?.image?.poemId !== 'tongbian-001'
        || detailBody?.image?.source !== 'wan2.7-packaged'
        || detailBody?.image?.aiGenerated !== true) {
        throw new Error('DEMO 文化图库卡片与详情索引来源不一致')
    }
    return {
        checked: true,
        poemBound: true,
        packagedWanWebpOnly: true,
        aiGeneratedTrue: true,
        noSvgFallback: true,
        detailIndexReadable: true,
    }
}

async function verifyTtsBinaryContract(baseUrl, session) {
    const url = `${baseUrl}/api/ai/tts`
    const body = JSON.stringify({ text: '床前明月光', voice: 'alloy', speed: 1, responseFormat: 'wav' })
    const unauthenticated = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'audio/*' },
        body,
    })
    if (unauthenticated.status !== 401) {
        throw new Error(`未认证 TTS 未失败关闭：HTTP ${unauthenticated.status}`)
    }

    const authenticated = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'audio/*',
            cookie: session.cookie,
            origin: baseUrl,
            'x-csrf-token': session.csrfToken,
        },
        body,
        signal: AbortSignal.timeout(15_000),
    })
    if (!authenticated.ok) throw new Error(`已认证 TTS 调用失败：HTTP ${authenticated.status}`)
    const contentType = (authenticated.headers.get('content-type') ?? '').toLowerCase()
    if (!contentType.startsWith('audio/')) throw new Error(`TTS Content-Type 异常：${contentType || 'missing'}`)
    const cacheControl = (authenticated.headers.get('cache-control') ?? '').toLowerCase()
    if (!cacheControl.includes('private') || !cacheControl.includes('no-store')) {
        throw new Error(`TTS 响应未禁止共享缓存：${cacheControl || 'missing'}`)
    }
    const bytes = new Uint8Array(await authenticated.arrayBuffer())
    const signature = String.fromCharCode(...bytes.slice(0, 4))
    if (bytes.length <= 44 || signature !== 'RIFF') {
        throw new Error(`DEMO TTS 未返回合法非空 WAV：bytes=${bytes.length}, signature=${signature}`)
    }
    return {
        checked: true,
        unauthenticatedRejected: true,
        authenticatedBinaryAudio: true,
        browserBlobPlayback: true,
        contentType,
        cacheControl,
        bytes: bytes.length,
        signature,
    }
}

async function verifyRecitationAudioReferenceBoundary(baseUrl, session) {
    const headers = {
        'Content-Type': 'application/json',
        cookie: session.cookie,
        origin: baseUrl,
        'x-csrf-token': session.csrfToken,
    }
    const invalidReferences = new Map([
        ['external-url', 'https://127.0.0.1:9/internal-probe.wav'],
        ['path-traversal', '/api/recitation/audio/recitations/../tts/escape.wav'],
        ['query-string', '/api/recitation/audio/recitations/rec_student_id.wav?download=1'],
        ['backslash', '/api/recitation/audio/recitations/rec_student\\escape.wav'],
        ['wrong-kind', '/api/recitation/audio/tts/tts_tongbian-001_alloy.wav'],
    ])
    const rejected = new Set()
    for (const [kind, audioUrl] of invalidReferences) {
        const response = await fetch(`${baseUrl}/api/recitation/evaluate`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                studentId: 'student-001',
                poemId: 'tongbian-001',
                audioUrl,
                transcript: '床前明月光',
            }),
            signal: AbortSignal.timeout(15_000),
        })
        const payload = await response.json().catch(() => null)
        if (response.status !== 400 || payload?.error !== 'INVALID_AUDIO_REFERENCE') {
            throw new Error(`朗读评估未拒绝非受控音频引用：${audioUrl} -> HTTP ${response.status}`)
        }
        rejected.add(kind)
    }

    const unsafeVoiceResponse = await fetch(`${baseUrl}/api/recitation/tts/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            poemId: 'tongbian-001',
            voice: '../../escape',
            format: 'wav',
        }),
        signal: AbortSignal.timeout(15_000),
    })
    if (unsafeVoiceResponse.status !== 400) {
        throw new Error(`TTS 未拒绝路径不安全的音色名：HTTP ${unsafeVoiceResponse.status}`)
    }
    return {
        checked: true,
        arbitraryExternalUrlRejected: rejected.has('external-url'),
        pathTraversalRejected: rejected.has('path-traversal'),
        queryStringRejected: rejected.has('query-string'),
        backslashRejected: rejected.has('backslash'),
        ttsReferenceRejectedForEvaluation: rejected.has('wrong-kind'),
        unsafeTtsVoiceRejected: true,
        modelReceivesControlledBufferOnly: true,
    }
}

async function verifyGradingImageReferenceBoundary(baseUrl, session) {
    const response = await fetch(`${baseUrl}/api/grading/ocr`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            cookie: session.cookie,
            origin: baseUrl,
            'x-csrf-token': session.csrfToken,
        },
        body: JSON.stringify({ imageUrl: 'http://127.0.0.1:9/internal-probe.png' }),
        signal: AbortSignal.timeout(15_000),
    })
    const payload = await response.json().catch(() => null)
    if (response.status !== 400 || payload?.error !== 'VALIDATION_ERROR') {
        throw new Error(`OCR 未拒绝任意外部图片引用：HTTP ${response.status}`)
    }
    return {
        checked: true,
        arbitraryExternalUrlRejected: true,
        inlineImageMagicRequired: true,
        dashscopeDownloadAllowlisted: true,
    }
}

async function verifyAiChatImageReferenceBoundary(baseUrl, session) {
    const headers = {
        'Content-Type': 'application/json',
        cookie: session.cookie,
        origin: baseUrl,
        'x-csrf-token': session.csrfToken,
    }
    const oversizedAggregateDataUrl = `data:image/png;base64,${Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(1_199_992),
    ]).toString('base64')}`
    const invalidMessages = new Map([
        ['external-url', [{
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1:9/internal-probe.png' } }],
        }]],
        ['magic-mismatch', [{
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
        }]],
        ['non-user-image', [{
            role: 'system',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoA' } }],
        }]],
        ['aggregate-limit', [{
            role: 'user',
            content: Array.from({ length: 4 }, () => ({
                type: 'image_url',
                image_url: { url: oversizedAggregateDataUrl },
            })),
        }]],
    ])
    const rejected = new Set()
    for (const [kind, messages] of invalidMessages) {
        const response = await fetch(`${baseUrl}/api/ai/chat`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: 'mimo-v2.5', messages, stream: false }),
            signal: AbortSignal.timeout(15_000),
        })
        const payload = await response.json().catch(() => null)
        if (response.status !== 400 || payload?.error !== 'VALIDATION_ERROR') {
            throw new Error(`AI 对话未拒绝非受控图片输入 ${kind}：HTTP ${response.status}`)
        }
        rejected.add(kind)
    }
    return {
        checked: true,
        arbitraryExternalUrlRejected: rejected.has('external-url'),
        inlineImageMagicRequired: rejected.has('magic-mismatch'),
        imagePartsRestrictedToUserMessages: rejected.has('non-user-image'),
        requestBodyAndAggregateLimitsConfigured: rejected.has('aggregate-limit'),
    }
}

async function verifyPersistentImageReferenceBoundary(baseUrl, session) {
    const response = await fetch(`${baseUrl}/api/creation/works/submit`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            cookie: session.cookie,
            origin: baseUrl,
            'x-csrf-token': session.csrfToken,
        },
        body: JSON.stringify({
            taskId: 'task-image-reference-probe',
            studentId: 'student-image-reference-probe',
            title: '配图边界探针',
            content: '该请求必须在写入前被拒绝。',
            imageUrl: 'https://tracker.example.test/pixel.webp?student=probe',
        }),
        signal: AbortSignal.timeout(15_000),
    })
    const payload = await response.json().catch(() => null)
    if (response.status !== 400 || payload?.error !== 'VALIDATION_ERROR') {
        throw new Error(`创作作品未拒绝外部持久化图片引用：HTTP ${response.status}`)
    }
    return {
        checked: true,
        externalTrackerUrlRejectedBeforePersistence: true,
        generatedWebpPathAllowlisted: true,
    }
}

function runE2E(baseUrl, password) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [e2eEntry], {
            cwd: frontendRoot,
            env: {
                ...process.env,
                E2E_BASE_URL: baseUrl,
                E2E_AUTH_MODE: authMode,
                E2E_AUTH_PHONE: password ? '13900000000' : '13177091153',
                E2E_AUTH_PASSWORD: password || 'Chy101713',
            },
            stdio: 'inherit',
            windowsHide: true,
        })
        child.once('error', reject)
        child.once('exit', (code, signal) => {
            if (code === 0) resolve()
            else reject(new Error(`生产 E2E 失败：code=${code}, signal=${signal ?? 'none'}`))
        })
    })
}

function stopChild(child) {
    if (child.exitCode !== null) return Promise.resolve()
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`后端 PID ${child.pid} 在 SIGTERM 后 5 秒仍未退出`)), 5_000)
        child.once('exit', () => {
            clearTimeout(timer)
            resolve()
        })
        if (!child.kill('SIGTERM')) {
            clearTimeout(timer)
            reject(new Error(`无法向后端 PID ${child.pid} 发送 SIGTERM`))
        }
    })
}

async function removeOwnedTemp(temporaryRoot) {
    const resolved = path.resolve(temporaryRoot)
    const expectedParent = path.resolve(os.tmpdir())
    if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith('poetic-realm-e2e-')) {
        throw new Error(`拒绝清理未通过边界校验的目录：${resolved}`)
    }
    const info = await fs.lstat(resolved)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`拒绝清理非普通临时目录：${resolved}`)
    await fs.rm(resolved, { recursive: true })
}

async function main() {
    await Promise.all([fs.access(serverEntry), fs.access(e2eEntry)])
    const buildFreshness = await assertProductionBuildFreshness()
    console.log(
        `生产构建输入新鲜度通过：${buildFreshness.inputCount} 个输入；`
        + `最新 ${buildFreshness.latestInput}；容差 ${buildFreshness.toleranceMs}ms。`,
    )
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'poetic-realm-e2e-'))
    const port = await reserveFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const passwordConfiguration = authMode === 'password' ? createEphemeralPasswordConfiguration() : null
    let serverOutput = ''
    let serverError = ''
    let serverExit = null
    const server = spawn(process.execPath, [serverEntry], {
        cwd: backendRoot,
        env: {
            ...process.env,
            NODE_ENV: 'production',
            HOST: '127.0.0.1',
            PORT: String(port),
            APP_DATA_DIR: temporaryRoot,
            SQLITE_PATH: path.join(temporaryRoot, 'production-e2e.db'),
            DEMO_MODE: 'true',
            // 比赛演示部署必须带有可追溯、可清理的合成学情；浏览器回归也在同一
            // 数据条件下运行，避免空库页面通过测试而真实演示什么都没有。
            SEED_LEARNING_DEMO: 'true',
            // 隔离回归只验证受控 UI/API 契约，绝不继承开发机的真实供应商密钥。
            // 显式空值会覆盖 dotenv 的本地 .env，避免测试产生付费调用、外部数据
            // 漂移或把真实 provider 可用性误记为可重复的比赛证据。
            DEEPSEEK_API_KEY: '',
            MIMO_API_KEY: '',
            DASHSCOPE_API_KEY: '',
            WAN_IMAGE_BASE_URL: '',
            NEO4J_URI: 'bolt://127.0.0.1:1',
            NEO4J_USER: 'e2e-disabled',
            NEO4J_PASSWORD: '',
            AUTH_MODE: authMode,
            AUTH_SESSION_SECRET: passwordConfiguration?.sessionSecret ?? '',
            AUTH_PASSWORD_SCRYPT: passwordConfiguration?.hash ?? '',
            AUTH_TEACHER_PHONE: '13900000000',
            AUTH_COOKIE_SECURE: 'false',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-64_000) })
    server.stderr.on('data', (chunk) => { serverError = `${serverError}${chunk}`.slice(-64_000) })
    server.once('exit', (code, signal) => { serverExit = { code, signal } })

    let primaryError
    try {
        await waitForHealth(baseUrl, server)
        const unauthenticatedBoundary = await fetch(`${baseUrl}/api/poem-content/tongbian-001`)
        if (unauthenticatedBoundary.status !== 401) {
            throw new Error(`未认证业务 API 未失败关闭：HTTP ${unauthenticatedBoundary.status}`)
        }
        const session = await acquireSession(baseUrl, passwordConfiguration?.password)
        const generatedMediaBoundary = await verifyGeneratedMediaBoundary(baseUrl, session, temporaryRoot)
        const cultureDemoGalleryFallback = await verifyCultureDemoGalleryFallback(baseUrl, session)
        const ttsBinaryContract = await verifyTtsBinaryContract(baseUrl, session)
        const recitationAudioReferenceBoundary = await verifyRecitationAudioReferenceBoundary(baseUrl, session)
        const gradingImageReferenceBoundary = await verifyGradingImageReferenceBoundary(baseUrl, session)
        const aiChatImageReferenceBoundary = await verifyAiChatImageReferenceBoundary(baseUrl, session)
        const persistentImageReferenceBoundary = await verifyPersistentImageReferenceBoundary(baseUrl, session)
        const poemContentTruthBoundary = await verifyTruthBoundaries(baseUrl, session)
        const securityHeaders = await verifySecurityHeaders(baseUrl, session)
        await runE2E(baseUrl, passwordConfiguration?.password)
        const results = JSON.parse(await fs.readFile(e2eResults, 'utf8'))
        if (results.memoryGovernanceChecked !== true) {
            throw new Error('长期记忆治理面板未完成浏览器级创建、修改、删除、确认与脱敏写入回归')
        }
        if (results.offlineDisclosureChecked !== true) {
            throw new Error('断网提示未完成浏览器级真实性披露回归')
        }
        if (results.keyboardNavigationChecked !== true) {
            throw new Error('跳到主内容链接未完成浏览器级键盘焦点回归')
        }
        if (results.authFailureClosedChecked !== true) {
            throw new Error('认证状态接口不可用时未完成浏览器级失败关闭回归')
        }
        if (results.modalFocusManagementChecked !== true) {
            throw new Error('系统设置对话框未完成浏览器级焦点陷阱、Esc 关闭与焦点恢复回归')
        }
        if (results.notificationEmptyDialogFocusChecked !== true) {
            throw new Error('空通知对话框未完成面板初始焦点、Tab 边界、Esc 回焦与移动端几何回归')
        }
        if (results.commandPaletteMobileChecked !== true) {
            throw new Error('命令面板未完成 Ctrl/Cmd+K 唤起、移动端几何、焦点边界与 Esc 回焦回归')
        }
        if (results.sidebarResizerKeyboardChecked !== true) {
            throw new Error('桌面侧边栏宽度调节器未完成键盘范围、值语义与移动断点拖拽清理回归')
        }
        if (results.ttsBinaryPlaybackChecked !== true) {
            throw new Error('TTS 二进制响应未完成浏览器级 Blob 播放契约回归')
        }
        if (results.voiceInputLifecycleChecked !== true) {
            throw new Error('跟读录音未完成正常收尾、迟到授权取消与模块卸载媒体回收回归')
        }
        if (results.quickVoiceCaptureLifecycleChecked !== true) {
            throw new Error('快捷语音未完成正常收尾、显式授权取消、页面卸载媒体回收与移动端操作区回归')
        }
        if (results.lessonPlanStartChecked !== true) {
            throw new Error('教案工坊起始页未完成浏览器级路径呈现与模板详情跳转回归')
        }
        if (results.toastOverflowChecked !== true) {
            throw new Error('通知折叠未完成浏览器级展开、收起与可访问状态回归')
        }
        if (results.gradingInitialActionChecked !== true) {
            throw new Error('智能批改初始页未完成主任务首屏、顺序与归档前置条件回归')
        }
        if (results.gradingResultTableKeyboardChecked !== true) {
            throw new Error('智能批改未完成键盘上传、诚实进度、不可变批次/重置与结果表语义回归')
        }
        if (results.gradingProgressTransitionKeyboardChecked !== true) {
            throw new Error('智能批改进度切换器未完成命名、状态披露与 Enter/Space 键盘回归')
        }
        if (results.gradingCardSwapMotionControlChecked !== true) {
            throw new Error('智能批改前后对比轮播未完成显式暂停、减弱动态静止、无伪交互与移动端几何回归')
        }
        if (results.gradingStackGalleryAccessibilityChecked !== true) {
            throw new Error('答题图片堆未完成原生按钮、键盘预览、焦点闭环、资源失败终态与移动端几何回归')
        }
        if (results.copilotAttachmentPreviewRecoveryChecked !== true) {
            throw new Error('AI 副驾附件未完成缩略图失败关闭、附件排除与纯文字发送回归')
        }
        if (results.immersiveDrawerAccessibilityChecked !== true) {
            throw new Error('沉浸导航抽屉未完成关闭态隔离、焦点边界、遮罩回焦与移动端几何回归')
        }
        if (results.classroomMobileLaunchChecked !== true) {
            throw new Error('课堂导播移动端未完成模式折叠、展开/收起与开课配置首屏回归')
        }
        if (results.classroomLaunchBriefFullTextChecked !== true) {
            throw new Error('课堂导播桌面摘要未完成关键课堂组织信息的完整呈现与无裁切回归')
        }
        if (results.classroomTextSwitchContractChecked !== true) {
            throw new Error('课堂导播模式文字切换未完成七模式、键盘、暂停恢复、减弱动态、离屏与原子播报回归')
        }
        if (results.electricBorderDecorationChecked !== true) {
            throw new Error('课堂导播选中态装饰未完成无 Canvas、非交互与减少动态静态降级回归')
        }
        if (results.classroomStartFailureClosureChecked !== true) {
            throw new Error('课堂导播未完成启动持久化 503 的页面失败关闭、无伪跳转与安全重试回归')
        }
        if (results.reducedMotionComplianceChecked !== true) {
            throw new Error('全路由减少动态偏好未完成浏览器级 CSS/WAAPI 动效时长回归')
        }
        if (results.mobileBrandHierarchyChecked !== true) {
            throw new Error('移动端顶栏未完成完整中文主品牌、完整辅助技术名称与无裁切回归')
        }
        if (results.dashboardMagicBentoContractChecked !== true) {
            throw new Error('教学闭环入口未完成六张随包 WebP、原生链接、减弱动态、触控、高对比与打印回归')
        }
        if (results.chapterNavigationRemovedChecked !== true) {
            throw new Error('右侧章节导航未完成全量卸载、持久化残留清理、无横向溢出与吸顶页头回归')
        }
        if (results.dashboardAsyncContentVisibilityChecked !== true) {
            throw new Error('教学驾驶舱异步列表未完成 pending 后挂载可见性与减少动态回归')
        }
        if (results.dashboardTabKeyboardChecked !== true) {
            throw new Error('教学驾驶舱未完成方向键、Home/End、动态面板关联与焦点同步回归')
        }
        if (results.dashboardAlertActionSemanticsChecked !== true) {
            throw new Error('教学驾驶舱告警未完成单一操作入口、明确命名与键盘导航回归')
        }
        if (results.reportHistoryActionSemanticsChecked !== true) {
            throw new Error('教研报告历史未完成原生表格行、具名单一操作与键盘查看回归')
        }
        if (results.publicReportSharingChecked !== true) {
            throw new Error('匿名报告分享未完成精确直达、无认证副作用、token 零持久化、sandbox、响应状态与媒体兜底回归')
        }
        if (results.reportShareManagementChecked !== true) {
            throw new Error('报告分享管理未完成服务端预览、人工确认、1-90 天、一次性复制/手动兜底、无 token 摘要与撤销回归')
        }
        if (results.diagnosisStudentListKeyboardChecked !== true) {
            throw new Error('诊断学生选择器未完成单一 roving 焦点、箭头/Home/End 与选择同步回归')
        }
        if (results.radarDecorationContractChecked !== true) {
            throw new Error('诊断雷达未完成无 Canvas/WebGL、装饰语义、减弱动态与移动端几何回归')
        }
        if (results.aiCopilotMobileInitialActionChecked !== true) {
            throw new Error('AI 副驾移动端未完成首次输入优先、首屏可达与次级设置后置回归')
        }
        if (results.creationTaskPublishingChecked !== true) {
            throw new Error('创作迭代台未完成真实诗篇加载、认证任务发布与任务看板回显回归')
        }
        if (results.creationTaskMobileComposerChecked !== true) {
            throw new Error('创作迭代台移动端未完成发布面板首屏、表单边界与触控目标回归')
        }
        if (results.workbenchPoemFallbackTruthChecked !== true) {
            throw new Error('命题工坊未完成诗库局部降级披露、真实命题阻断与恢复重试回归')
        }
        if (results.workbenchPrimaryStartPathChecked !== true) {
            throw new Error('命题工坊未完成首屏主行动可见、唯一真实诗篇控件聚焦与展开回归')
        }
        if (results.workbenchRefineModalKeyboardChecked !== true) {
            throw new Error('命题精修弹窗未完成真实模式切换、手动差异、可逆退出与焦点归还回归')
        }
        if (results.workbenchRefineModalMobileChecked !== true) {
            throw new Error('命题精修弹窗未完成移动端动态视口、独立滚动、决策区与焦点归还回归')
        }
        if (results.workbenchRichMarkdownDetailAccessibilityChecked !== true) {
            throw new Error('命题题卡未完成富 Markdown 语义隔离、原生详情入口与 Escape 焦点归还回归')
        }
        if (results.copilotMaterialTruthBoundaryChecked !== true) {
            throw new Error('AI 副驾未完成学生/诗库局部降级披露、演示数据隔离与真实脱敏物料恢复回归')
        }
        if (results.copilotMarkdownImageRecoveryChecked !== true) {
            throw new Error('AI 副驾富 Markdown 图片未完成资源失败披露、无误导终态与真实重试请求回归')
        }
        if (results.classroomPoemTruthAndInnovativeModeChecked !== true) {
            throw new Error('课堂导播未完成诗库局部降级披露、创新模式开课、讲解/共舞内嵌键盘模式与接龙真实诗库恢复回归')
        }
        if (results.culturePoemVerificationDisclosureChecked !== true) {
            throw new Error('文化语境未完成逐首内容验收披露、原生详情键盘开合与移动端无溢出回归')
        }
        if (results.pixelSnowDecorationContractChecked !== true) {
            throw new Error('冬景雪境未完成受控触发、无 Three/WebGL、减弱动态、真实触控与媒体兜底回归')
        }
        if (results.fallingTextTitleContractChecked !== true) {
            throw new Error('文化语境诗题未完成 React 静态内容、无 Canvas 与减少动态回归')
        }
        if (results.masonryGridContractChecked !== true) {
            throw new Error('文化卡片瀑布流未完成桌面三列、移动单列、语义列表、无运行时样式注入与减少动态回归')
        }
        if (results.thinkingPalaceLightweightAuditChecked !== true) {
            throw new Error('思考宫殿未完成减少动态下的轻量二维审计、Three.js 延迟加载与教师主动开启回归')
        }
        if (results.poemImageCardAccessibilityChecked !== true) {
            throw new Error('思考宫殿未完成诗境图片控件、资源恢复、大图 Portal 全视口、焦点陷阱与滚动恢复回归')
        }
        if (results.starMapLightweightViewChecked !== true) {
            throw new Error('诗脉星图未完成33号受控OGL画廊默认展示、减少动态静态化、目录往返、单Canvas与零Three资源回归')
        }
        if (results.evolutionEmptyEvidenceChecked !== true) {
            throw new Error('进化之眼未完成空谱系真实边界、证据刷新、模式说明与无意义 Three.js 延迟加载回归')
        }
        if (results.evolutionPatternLinkedNavigationChecked !== true) {
            throw new Error('进化之眼未完成模式真实关联版本定位、原生操作、陈旧边失败关闭与焦点交接回归')
        }
        if (results.lessonPlanImageGalleryContractChecked !== true) {
            throw new Error('教案模板图片画廊未完成唯一图片映射、原生键盘漫游、预览焦点、图片失败、触控、减弱动态、强制配色与打印回归')
        }
        if (results.starMapPoetryGalleryContractChecked !== true) {
            throw new Error('诗脉33号旋转画廊未完成同诗位图映射、键盘/触控选择、详情关闭回焦、无SVG与无虚化回归')
        }
        if (results.sphereGalleryLightweightResourceBoundaryChecked !== true) {
            throw new Error('教案轻量图片画廊未完成零 Three.js、零 WebGL、零 Canvas、零 RAF 与无持续后台动画资源门禁')
        }
        if (results.starfieldBackgroundFallbackChecked !== true) {
            throw new Error('403/404 星空背景未完成无 Canvas/OGL、非交互、减弱动态静止与桌面/移动覆盖回归')
        }
        if (results.magicRingsDecorationChecked !== true) {
            throw new Error('创新卡片光韵未完成零测量 SVG rect、装饰语义与减少动态静态轮廓回归')
        }
        const evidence = {
            generatedAt: new Date().toISOString(),
            hosting: 'fastify-production-same-origin',
            nodeEnv: 'production',
            authMode,
            passwordAuthentication: authMode === 'password'
                ? { checked: true, credentialSource: 'ephemeral-random-runtime-only' }
                : { checked: false, credentialSource: null },
            authStatusFailureClosed: {
                checked: true,
                demoShortcutHidden: true,
                submitDisabled: true,
            },
            notificationEmptyDialogFocus: {
                checked: true,
                viewport: '1440x900;390x844',
                testDataBoundary: 'isolated-empty-local-notification-store with a non-dispatching BroadcastChannel test double; verifies frontend dialog focus, keyboard boundary and mobile geometry only, not classroom events, notification delivery or teaching outcomes',
                verifies: [
                    'empty-modal-dialog-has-programmatic-focus-target-and-receives-initial-focus',
                    'empty-modal-dialog-retains-focus-on-tab-and-shift-tab',
                    'escape-closes-empty-notification-dialog-and-restores-trigger-focus',
                    'mobile-empty-notification-dialog-remains-unclipped-without-page-horizontal-overflow',
                ],
            },
            commandPaletteMobile: {
                checked: true,
                viewport: '390x844',
                testDataBoundary: 'authenticated-production-E2E-command-palette-ui; verifies keyboard focus, responsive geometry and close restoration only, not search relevance, student data or teaching outcomes',
                verifies: [
                    'ctrl-or-command-k-opens-the-lazy-command-palette-and-focuses-search-input',
                    'search-input-exposes-combobox-listbox-active-descendant-contract',
                    'arrow-navigation-updates-active-descendant-and-single-roving-option-tab-stop',
                    'mobile-command-palette-remains-within-viewport-without-page-horizontal-overflow',
                    'tab-from-search-input-remains-within-command-dialog',
                    'escape-closes-command-palette-and-restores-source-trigger-focus-after-parent-unmount',
                ],
            },
            sidebarResizerKeyboard: {
                checked: true,
                viewport: '1440x900;390x844',
                testDataBoundary: 'authenticated-production-AppShell preference control; verifies keyboard range operations, ARIA value semantics and breakpoint cleanup only, not teaching data or outcomes',
                verifies: [
                    'focusable-vertical-separator-exposes-current-minimum-and-maximum-width-values',
                    'home-end-arrow-and-page-keys-update-sidebar-width-with-focus-retained',
                    'desktop-drag-entering-mobile-breakpoint-releases-global-resize-state-and-keeps-page-without-horizontal-overflow',
                ],
            },
            generatedMediaBoundary,
            cultureDemoGalleryFallback,
            ttsBinaryContract,
            voiceInputLifecycle: {
                checked: true,
                viewport: '1440x900',
                testDataBoundary: 'isolated-controlled-browser-media-device-and-ASR response; verifies frontend recorder lifecycle and request boundary only, not real microphone capture, student speech, ASR quality or teaching outcomes',
                verifies: [
                    'normal-stop-waits-for-final-dataavailable-and-submits-exactly-one-multipart-asr-request',
                    'second-click-during-pending-permission-cancels-late-stream-without-starting-recorder-or-submitting-asr',
                    'late-media-permission-resolution-after-module-unmount-stops-the-stream-without-starting-recorder-or-submitting-asr',
                    'active-recorder-module-unmount-stops-the-device-and-cancels-final-asr-delivery',
                ],
            },
            quickVoiceCaptureLifecycle: {
                checked: true,
                viewport: '1440x900;390x844',
                testDataBoundary: 'isolated-controlled-browser-media-device-and-ASR response through the production AI-copilot quick-voice entry; verifies frontend recorder lifecycle, cancellation and mobile action geometry only, not real microphone capture, teacher speech, ASR quality or teaching outcomes',
                verifies: [
                    'normal-stop-waits-for-final-dataavailable-and-refills-editable-ai-copilot-input-with-one-multipart-asr-request',
                    'pending-permission-keeps-an-explicit-cancel-control-and-late-stream-never-starts-recorder-or-submits-asr',
                    'late-media-permission-after-ai-copilot-unmount-stops-the-stream-without-starting-recorder-or-submitting-asr',
                    'active-quick-voice-recorder-unmount-stops-the-device-and-cancels-final-asr-delivery',
                    'mobile-quick-voice-action-remains-unclipped-with-at-least-44px-touch-height',
                ],
            },
            recitationAudioReferenceBoundary,
            gradingImageReferenceBoundary,
            aiChatImageReferenceBoundary,
            persistentImageReferenceBoundary,
            baseUrl,
            routeViewportCombinations: Array.isArray(results.routeResults) ? results.routeResults.length : 0,
            warnings: Array.isArray(results.warnings) ? results.warnings.length : -1,
            failures: Array.isArray(results.failures) ? results.failures.length : -1,
            memoryGovernance: {
                checked: true,
                operations: ['list', 'update', 'delete', 'deidentified-create', 'class-clear-confirmation'],
            },
            offlineDisclosure: {
                checked: true,
                unsavedChangesAreNotClaimedAsQueued: true,
            },
            keyboardNavigation: {
                checked: true,
                firstFocusIsSkipLink: true,
                skipLinkMovesFocusToMain: true,
            },
            modalFocusManagement: {
                checked: true,
                forwardAndReverseTrap: true,
                escapeCloses: true,
                focusReturnsToTrigger: true,
            },
            lessonPlanStartExperience: {
                checked: true,
                verifies: [
                    'path-disclosure',
                    'template-detail-navigation',
                    'tablist-controls-unique-panels-and-supports-arrow-home-end-navigation',
                ],
            },
            toastOverflow: {
                checked: true,
                maxCollapsedVisible: 2,
                verifies: ['expand-hidden-feedback', 'collapse-back-to-compact-state', 'aria-expanded'],
            },
            gradingInitialAction: {
                checked: true,
                workspaceFollowsStepper: true,
                desktopUploadZoneVisibleInInitialViewport: true,
                uploadRemainsDisabledBeforeContextSelection: true,
            },
            gradingResultTableKeyboard: {
                checked: true,
                testDataBoundary: 'isolated-controlled-api-responses; not student-or-model-outcome-evidence',
                verifies: [
                    'teacher-ui-path-selects-class-and-question-then-uploads-recognizes-and-grades',
                    'visually-hidden-file-input-remains-keyboard-focusable-and-enter-opens-the-native-file-chooser',
                    'pending-multi-file-upload-uses-an-indeterminate-aria-progress-contract-without-fake-percentages-or-per-file-timers',
                    'established-batch-locks-class-and-upload-entry-points-and-does-not-expose-a-local-only-delete-control',
                    'new-batch-clears-local-previews-before-a-separate-reupload',
                    'multi-file-recognition-tablist-controls-panel-and-supports-arrow-home-end-navigation',
                    'result-table-uses-table-rowgroup-row-cell-semantics',
                    'result-row-focus-and-enter-expand-details',
                    'animation-wrapper-does-not-double-handle-row-selection',
                ],
            },
            gradingProgressTransitionKeyboard: {
                checked: true,
                testDataBoundary: 'isolated-controlled-grading-flow-state; not student-or-model-outcome-evidence',
                verifies: [
                    'pixel-transition-exposes-a-named-button-role-and-pressed-state',
                    'space-and-enter-toggle-progress-view-while-focus-remains-on-the-control',
                    'pointer-hover-remains-a-progressive-enhancement-not-the-only-interaction-path',
                ],
            },
            gradingCardSwapMotionControl: {
                checked: true,
                viewport: '1440x900;390x844',
                testDataBoundary: 'isolated-controlled-grading-flow; verifies frontend motion, semantics and geometry only, not student work, teaching quality or model-outcome evidence',
                verifies: [
                    'non-actionable-comparison-cards-do-not-fake-button-semantics-or-pointer-cursor',
                    'native-named-control-explicitly-pauses-and-keyboard-space-resumes-automatic-comparison-rotation',
                    'paused-state-freezes-card-transforms-rather-than-only-changing-a-label',
                    'hover-pauses-as-progressive-enhancement-without-replacing-explicit-control',
                    'prefers-reduced-motion-stops-timer-and-card-motion-with-a-truthful-static-disclosure',
                    'mobile-motion-control-remains-visible-at-least-24px-and-without-page-horizontal-overflow',
                ],
            },
            gradingStackGalleryAccessibility: {
                checked: true,
                viewport: '1440x900;390x844',
                testDataBoundary: 'isolated-controlled-grading-flow-and-image-responses; verifies frontend semantic controls, keyboard focus and mobile geometry only, not student work, teaching quality or model-outcome evidence',
                verifies: [
                    'visible-stack-cards-use-native-buttons-without-faux-button-role',
                    'all-visible-cards-are-tab-reachable-and-autoplay-pauses-while-gallery-has-focus',
                    'keyboard-enter-opens-labelled-lightbox-and-focuses-explicit-close-control',
                    'lightbox-traps-tab-and-shift-tab-within-available-controls',
                    'escape-closes-lightbox-and-restores-source-card-focus',
                    'aborted-student-image-replaces-stack-card-and-lightbox-with-readable-nonblank-fallbacks',
                    'mobile-stack-gallery-action-remains-unclipped-without-page-horizontal-overflow',
                ],
            },
            copilotAttachmentPreviewRecovery: {
                checked: true,
                viewport: '1440x900;390x844',
                testDataBoundary: 'isolated-controlled-browser-image-error-after-real-local-file-selection-and-compression; verifies frontend preview recovery and outgoing-request exclusion only, not image content, student data or model outcomes',
                verifies: [
                    'preview-decode-error-replaces-thumbnail-with-a-named-polite-failure-state',
                    'failed-preview-is-excluded-from-the-next-ai-request-payload',
                    'teacher-can-still-send-a-pure-text-message-after-the-failed-attachment-is-fail-closed',
                    'mobile-failure-card-wraps-without-page-horizontal-overflow-and-keeps-a-24px-remove-target',
                ],
            },
            immersiveDrawerAccessibility: {
                checked: true,
                viewport: '1440x900;390x844',
                testDataBoundary: 'authenticated-production-starmap-route; verifies frontend navigation-drawer semantics, keyboard focus and mobile geometry only, not star-map learning data, teaching quality or model-outcome evidence',
                verifies: [
                    'closed-offscreen-drawer-has-no-dialog-modal-semantics-and-is-aria-hidden',
                    'keyboard-open-focuses-explicit-close-control',
                    'drawer-traps-tab-and-shift-tab-within-navigation-controls',
                    'overlay-close-removes-dialog-semantics-and-restores-menu-trigger-focus',
                    'mobile-drawer-stays-within-eighty-percent-viewport-with-40px-close-target-and-no-page-overflow',
                ],
            },
            classroomMobileLaunch: {
                checked: true,
                initialVisibleModes: 1,
                canExpandAllSevenModes: true,
                canCollapseBackToCurrentMode: true,
                selectedModeReordersToFeatureCard: true,
                featureCardDisclosesSelectedModeScenarioAndDuration: true,
                launchConfigurationVisibleInInitialViewport: true,
            },
            classroomLaunchBriefFullText: {
                checked: true,
                viewport: '1440x900',
                verifies: [
                    'classroom-scenario-and-duration-use-natural-wrap-instead-of-ellipsis',
                    'critical-launch-summary-has-no-horizontal-or-vertical-text-clipping',
                ],
            },
            classroomTextSwitchContract: {
                checked: true,
                viewport: '1440x900; prefers-reduced-motion: no-preference/reduce',
                testDataBoundary: 'authenticated production classroom start page; verifies the seven frontend mode labels, native controls, timer pause/resume and DOM-observable media fallbacks only, not screen-reader vendor speech, real classroom outcomes or all browser background scheduling policies',
                verifies: [
                    'seven-real-classroom-mode-labels-use-one-native-roving-button-group',
                    'arrow-home-end-selection-synchronizes-focus-visible-text-and-one-atomic-live-region',
                    'focus-hover-and-explicit-manual-pause-each-stop-auto-rotation-for-longer-than-the-production-interval',
                    'manual-resume-restores-a-real-auto-rotation-step',
                    'reduced-motion-stops-auto-rotation-while-preserving-immediate-manual-selection',
                    'offscreen-content-stops-auto-rotation-and-resumes-from-a-full-interval-when-visible',
                    'the-component-has-no-character-split-dom-canvas-svg-or-gsap-runtime-resource',
                ],
            },
            electricBorderDecoration: {
                checked: true,
                viewport: '1440x900; prefers-reduced-motion: reduce',
                testDataBoundary: 'authenticated-production-E2E DOM/CSS contract only; verifies the decorative layer, not teaching outcomes, hardware performance or browser support beyond the test browser',
                verifies: [
                    'selected-mode-decoration-is-aria-hidden-and-does-not-create-an-interactive-descendant',
                    'selected-mode-decoration-has-no-canvas-or-rendered-child-elements',
                    'selected-mode-decoration-is-absolute-and-non-blocking',
                    'reduced-motion-disables-both-border-and-glow-animations',
                ],
            },
            classroomStartFailureClosure: {
                checked: true,
                viewport: '1440x900;390x844',
                testDataBoundary: 'isolated-controlled-first POST /api/classroom/start response only; verifies failure presentation, no-navigation and retry behavior, not an actual school database failure, teaching data or teaching outcome',
                verifies: [
                    'controlled-503-keeps-the-teacher-on-the-unstarted-classroom-route',
                    'failure-alert-states-that-no-join-code-or-realtime-channel-was-created',
                    'the-single-primary-action-remains-enabled-and-is-renamed-for-safe-retry',
                    'inline-failure-feedback-suppresses-a-duplicate-generic-start-toast',
                    'mobile-failure-alert-and-retry-action-stay-visible-without-horizontal-overflow',
                    'the-second-attempt-uses-the-production-start-contract-and-navigates-only-after-success',
                ],
            },
            reducedMotionCompliance: {
                checked: true,
                viewport: '1440x900;390x844',
                testDataBoundary: 'authenticated-production-E2E reduced-motion browser preference; verifies DOM-observable CSS and Web Animations API behavior only. Three/WebGL paths are verified by their dedicated lightweight-view regressions.',
                verifies: [
                    'prefers-reduced-motion-media-query-is-active-for-every-route-and-viewport',
                    'visible-CSS-animations-and-transitions-are-no-longer-than-20ms',
                    'settled-pages-have-no-long-running-DOM-Web-Animations',
                    'custom-interactive-ARIA-roles-share-the-runtime-accessible-name-audit',
                ],
            },
            mobileBrandHierarchy: {
                checked: true,
                viewport: '390x844',
                testDataBoundary: 'authenticated-production-E2E header presentation and accessibility-name contract only; does not measure brand recognition or classroom outcomes.',
                verifies: [
                    'mobile-header-displays-the-complete-Chinese-primary-brand-without-an-ellipsis-truncated-English-suffix',
                    'visual-brand-text-is-aria-hidden-to-avoid-duplicate-screen-reader-output',
                    'screen-reader-only-text-preserves-the-complete-product-name',
                    'brand-container-has-no-horizontal-text-clipping',
                ],
            },
            dashboardMagicBentoContract: {
                checked: true,
                viewport: '1440x900; 390x844 touch; forced-colors active; print',
                testDataBoundary: 'production dashboard with six packaged route-specific WebP assets; verifies exact local resource mapping, semantics and media fallbacks only, not teaching quality or competition outcome',
                verifies: [
                    'six-native-links-preserve-keyboard-spa-and-modifier-or-middle-click-browser-behavior',
                    'six-route-specific-1280x720-webp-images-load-without-svg-or-runtime-illustration-api',
                    'css-renderer-creates-no-legacy-particle-ripple-global-spotlight-or-runtime-style',
                    'reduced-motion-and-real-coarse-pointer-context-remain-static-and-operable',
                    'desktop-three-column-and-mobile-single-column-layouts-have-no-horizontal-overflow',
                    'forced-colors-and-print-media-preserve-boundaries-focus-text-and-page-break-safety',
                    'source-gate-excludes-gsap-raf-timers-global-listeners-randomness-canvas-and-webgl',
                ],
            },
            chapterNavigationRemoved: {
                checked: true,
                viewport: '1440x900; prefers-reduced-motion: reduce',
                testDataBoundary: 'authenticated production Dashboard; verifies obsolete right-side chapter navigation removal and header geometry only',
                verifies: [
                    'right-side-chapter-navigation-root-and-trigger-are-absent',
                    'obsolete-navigation-local-storage-state-is-absent',
                    'page-retains-no-horizontal-overflow-after-removal',
                    'header-remains-computed-sticky-at-top-after-real-scroll',
                ],
            },
            dashboardAsyncContentVisibility: {
                checked: true,
                viewport: '1440x900; prefers-reduced-motion: reduce',
                testDataBoundary: 'one delayed controlled dashboard-alert response; verifies conditional-ref mount visibility and motion fallback only, not real student risk, alert correctness or teaching outcomes',
                verifies: [
                    'loading-skeleton-exists-before-the-delayed-query-is-released',
                    'late-mounted-list-item-reaches-full-opacity-instead-of-staying-hidden',
                    'reduced-motion-removes-transform-and-transition-from-the-revealed-item',
                ],
            },
            dashboardTabKeyboard: {
                checked: true,
                viewport: '1440x900',
                verifies: [
                    'top-level-tablist-controls-dynamic-panel',
                    'arrow-keys-home-and-end-update-selection-and-focus',
                    'lazy-loaded-diagnosis-tablist-preserves-the-same-keyboard-contract',
                ],
            },
            dashboardAlertActionSemantics: {
                checked: true,
                testDataBoundary: 'isolated-controlled-dashboard-alert; not student-risk-or-teaching-outcome evidence',
                verifies: [
                    'alert-list-item-has-one-focusable-action-instead-of-a-clickable-card-plus-nested-button',
                    'action-has-a-disambiguated-accessible-name',
                    'keyboard-enter-navigates-to-the-declared-dashboard-diagnosis-route',
                    'level-badge-and-detail-use-the-rendered-style-contract',
                ],
            },
            reportHistoryActionSemantics: {
                checked: true,
                viewport: '1440x900;390x844',
                testDataBoundary: 'isolated-controlled-report-history-list-detail-and-chart-responses; verifies frontend native-table semantics, explicit actions, keyboard activation and mobile geometry only, not report content, teaching quality or model-outcome evidence',
                verifies: [
                    'native-table-row-has-no-button-role-tab-stop-or-row-level-navigation',
                    'completed-and-failed-reports-expose-disambiguated-native-view-and-delete-actions',
                    'generating-report-keeps-view-unavailable-while-preserving-a-named-delete-action',
                    'neutral-title-cell-does-not-trigger-report-detail-fetch',
                    'keyboard-enter-on-view-button-fetches-only-the-declared-report-and-transfers-focus-to-loaded-title',
                    'mobile-history-prioritizes-title-status-time-and-actions-without-table-or-page-horizontal-overflow',
                ],
            },
            publicReportSharing: {
                checked: true,
                viewport: '1440x900;390x844; prefers-reduced-motion: reduce; forced-colors: active; print',
                testDataBoundary: 'isolated controlled public-share JSON response rendered through the production same-origin SPA entry; verifies anonymous routing, request privacy, runtime DTO/HTML validation, sandbox/CSP, failure states and responsive/media contracts only, not public DNS, TLS certificate deployment, report truth or deidentification completeness',
                verifies: [
                    'exact-shared-report-path-bypasses-auth-without-auth-status-health-cookie-csrf-or-referer-side-effects',
                    'direct-html-response-and-document-meta-declare-no-store-no-referrer-and-noindex',
                    'bearer-token-never-enters-query-hash-console-local-storage-or-session-storage',
                    'controlled-report-body-exists-only-in-a-no-script-no-form-no-network-sandbox-srcdoc-with-deny-by-default-csp',
                    'loading-unavailable-expired-invalid-response-network-and-keyboard-retry-states-fail-closed-without-demo-content',
                    'desktop-mobile-44px-reduced-motion-forced-colors-and-print-contracts-remain-readable-without-horizontal-overflow',
                ],
            },
            reportShareManagement: {
                checked: true,
                viewport: '1440x900;390x844; prefers-reduced-motion: reduce',
                testDataBoundary: 'isolated controlled completed-report, protected-preview, create, tokenless-summary and revoke responses; verifies frontend consent, DTO, one-time bearer handling, clipboard recovery, accessibility and responsive behavior only, not live recipient access, external distribution, backend redaction quality or public TLS',
                verifies: [
                    'protected-server-preview-creates-no-share-record-and-renders-only-in-sandbox-srcdoc',
                    'create-remains-disabled-until-human-confirmation-and-an-arbitrary-integer-expiry-within-1-through-90-days',
                    'create-request-binds-the-confirmed-preview-fingerprint-and-sends-no-html-or-token',
                    'one-time-path-only-link-cannot-be-dismissed-with-escape-before-explicit-save-confirmation',
                    'clipboard-success-and-permission-denial-manual-selection-fallback-are-both-operable',
                    'token-never-enters-local-or-session-storage-and-is-removed-from-visible-dom-after-dedicated-close',
                    'owner-list-exposes-tokenless-summary-and-keyboard-revocation-with-visible-result-feedback',
                    'mobile-modal-remains-contained-with-44px-controls-reduced-motion-and-focus-restoration',
                ],
            },
            diagnosisStudentListKeyboard: {
                checked: true,
                testDataBoundary: 'isolated-production-E2E-temporary-SQLite-student-fixture; verifies frontend selection mechanics only, not student-learning evidence',
                verifies: [
                    'student-group-has-no-extra-focusable-container',
                    'exactly-one-selected-button-is-the-roving-tab-stop',
                    'home-arrow-down-end-and-home-sync-selection-and-dom-focus',
                    'student-actions-remain-native-buttons-without-listbox-option-role-conflict',
                ],
            },
            radarDecoration: {
                checked: true,
                viewport: '1440x900;390x844',
                testDataBoundary: 'production diagnosis page with isolated temporary student fixtures; verifies decorative rendering only, not diagnosis accuracy or teaching outcomes',
                verifies: [
                    'single-css-renderer-with-no-canvas-svg-runtime-style-or-ogl-vendor-resource',
                    'decorative-layer-is-hidden-from-assistive-technology-and-does-not-capture-pointer-events',
                    'reduced-motion-keeps-the-sweep-static-in-the-real-browser-runtime',
                    'desktop-and-mobile-radar-remain-contained-without-page-horizontal-overflow',
                ],
            },
            aiCopilotMobileInitialAction: {
                checked: true,
                firstVisitUsesAnEmptyConversationState: true,
                primaryTextInputVisibleInInitialViewport: true,
                primaryConversationPrecedesSecondaryConfiguration: true,
            },
            creationTaskPublishing: {
                checked: true,
                verifies: ['authenticated-poem-load', 'authenticated-task-create', 'published-task-board-receipt'],
            },
            creationTaskMobileComposer: {
                checked: true,
                viewport: '390x844',
                verifies: ['poem-select-visible-in-initial-viewport', 'form-controls-no-horizontal-clipping', 'submit-target-minimum-size'],
            },
            workbenchPoemFallbackTruth: {
                checked: true,
                verifies: ['persistent-demo-poem-disclosure', 'live-generation-blocked', 'manual-live-poem-retry-restores-state'],
            },
            workbenchPrimaryStartPath: {
                checked: true,
                viewport: '1440x900',
                verifies: [
                    'primary-poem-start-action-visible-in-initial-review-viewport',
                    'action-focuses-and-expands-the-single-real-poem-combobox',
                    'image-layout-cannot-push-primary-configuration-below-the-hero',
                ],
            },
            workbenchRefineModalKeyboard: {
                checked: true,
                viewport: '1440x1200',
                testDataBoundary: 'isolated-controlled-workbench-question-response; not student, pedagogical-quality, or model-outcome evidence',
                verifies: [
                    'teacher-refine-entry-opens-a-labelled-modal',
                    'mode-tablist-controls-panel-and-supports-arrow-home-end-navigation',
                    'manual-edit-produces-a-visible-diff-and-enables-selected-adoption',
                    'long-form-manual-edit-keeps-the-decision-footer-visible',
                    'leaving-modal-retains-focus-until-the-dialog-unmounts',
                    'escape-closes-the-modal-and-restores-trigger-focus',
                    'unsaved-manual-edits-are-discarded-before-the-next-refine-session',
                ],
            },
            workbenchRefineModalMobile: {
                checked: true,
                viewport: '390x844',
                testDataBoundary: 'isolated-controlled-workbench-question-response; verifies frontend modal geometry, scroll containment, decision controls and focus restoration only, not student, pedagogical-quality, or model-outcome evidence',
                verifies: [
                    'visible-title-labels-the-modal-without-a-duplicate-aria-label',
                    'dynamic-viewport-modal-panel-remains-inside-mobile-viewport-without-page-horizontal-overflow',
                    'long-form-body-keeps-an-independent-scroll-container',
                    'all-three-decision-actions-remain-visible-and-unclipped',
                    'escape-closes-mobile-refine-modal-and-restores-source-trigger-focus',
                ],
            },
            workbenchRichMarkdownDetailAccessibility: {
                checked: true,
                viewport: '1440x1200',
                testDataBoundary: 'isolated-controlled-workbench-question-response; verifies frontend rich-content semantics and focus restoration only, not student, pedagogical-quality, or model-outcome evidence',
                verifies: [
                    'rich-markdown-stem-remains-non-button-and-keeps-source-link',
                    'single-native-detail-button-is-named-from-card-index',
                    'keyboard-enter-opens-detail-and-escape-returns-focus-to-source-control',
                ],
            },
            copilotMaterialTruthBoundary: {
                checked: true,
                verifies: [
                    'student-outage-disclosure-without-demo-substitution',
                    'poem-outage-disclosure-without-demo-substitution',
                    'material-category-tablist-controls-panel-and-supports-arrow-home-end-navigation',
                    'manual-retry-restores-live-anonymized-material-references',
                ],
            },
            copilotMarkdownImageRecovery: {
                checked: true,
                viewport: '1440x900',
                testDataBoundary: 'isolated-controlled-AI-chat SSE response plus an intentionally aborted HTTP(S) image request; verifies shared Markdown resource-failure recovery only, not AI reply quality, image-model quality or provider availability',
                verifies: [
                    'failed-markdown-image-replaces-loading-affordance-with-an-announced-readable-status',
                    'failure-status-keeps-image-alt-context-and-removes-the-broken-image-element',
                    'failed-http-markdown-image-retry-issues-a-fresh-cache-busted-request',
                ],
            },
            classroomPoemTruthAndInnovativeMode: {
                checked: true,
                testDataBoundary: 'launch and poem-source recovery use production endpoints; embedded explain UI uses an explicitly-labelled controlled response solely for front-end state, source-verification disclosure, accessibility and keyboard-contract verification, not for textbook, student, pedagogical-quality or model-outcome evidence',
                verifies: [
                    'classroom-launch-poem-outage-disclosure-without-local-substitution',
                    'hero-text-switch-uses-roving-button-group-and-pauses-auto-rotation-while-focused',
                    'manual-retry-restores-live-launch-poem-selection',
                    'poem-relay-mode-starts-through-frontend-backend-contract',
                    'relay-poem-outage-blocks-unknown-source-start-and-retries-live-source',
                    'relay-start-poem-combobox-has-explicit-name-and-recovers-live-source',
                    'runtime-classroom-view-tablist-controls-panel-and-supports-arrow-home-end-navigation',
                    'explain-view-tablist-controls-panel-and-supports-arrow-home-end-navigation',
                    'classroom-explain-panel-defaults-to-full-source-verification-disclosure-not-only-a-compact-badge',
                    'dance-directive-tablist-controls-panel-and-keeps-pre-session-input-protected',
                    'deterministic-intervention-content-and-persisted-adoption',
                ],
            },
            culturePoemVerificationDisclosure: {
                checked: true,
                viewport: '1440x900;390x844',
                testDataBoundary: 'isolated-controlled-poem-content response; verifies frontend source-verification disclosure, native details keyboard behavior and responsive geometry only, not textbook, student, pedagogical-quality or model-outcome evidence',
                verifies: [
                    'unverified-or-incomplete-source-status-is-expanded-by-default-and-not-hidden-in-hover-only-content',
                    'disclosure-separates-poem-scope-review-date-source-registration-and-ai-teaching-content-boundary',
                    'native-summary-supports-enter-and-space-to-collapse-and-reopen-the-disclosure',
                    'mobile-disclosure-remains-within-the-viewport-without-page-horizontal-overflow',
                ],
            },
            pixelSnowDecorationContract: {
                checked: true,
                viewport: '1440x900 reduced/no-preference/forced-colors/print; 390x844 touch',
                testDataBoundary: 'two explicitly synthetic E2E poems routed through the production Culture page and store; verifies frontend trigger, rendering and fallback mechanics only, not poem provenance, textbook classification, seasonal accuracy, teaching quality or device-wide performance',
                verifies: [
                    'non-winter-to-winter-to-non-winter-production-selection-chain-mounts-and-unmounts-decoration',
                    'deterministic-bounded-span-field-has-no-canvas-svg-controls-runtime-style-or-three-resource',
                    'reduced-motion-keeps-visible-static-snow-with-stable-geometry',
                    'normal-fine-pointer-enables-css-only-enhancement-when-cqh-is-supported',
                    'real-touch-coarse-pointer-context-remains-static-nonblocking-and-overflow-free',
                    'forced-colors-and-print-hide-the-purely-decorative-layer',
                    'source-gate-excludes-three-webgl-raf-observers-listeners-randomness-canvas-and-react-effects',
                ],
            },
            fallingTextTitleContract: {
                checked: true,
                viewport: '1440x900; prefers-reduced-motion: reduce',
                testDataBoundary: 'controlled poem metadata and production frontend DOM/CSS contract only; does not establish poem provenance, teaching quality, device performance or animation support outside the test browser',
                verifies: [
                    'title-is-rendered-as-react-word-level-text-before-enhancement',
                    'auto-title-entrance-has-no-canvas-or-image-surface',
                    'reduced-motion-keeps-the-complete-title-static-and-within-its-container',
                    'automatic-decoration-does-not-add-button-or-tab-stop-semantics',
                ],
            },
            masonryGridContract: {
                checked: true,
                viewport: '1440x900;390x844; prefers-reduced-motion: reduce',
                testDataBoundary: 'controlled culture-background response and production frontend DOM/CSS contract only; verifies card layout, semantics and fallback behavior, not cultural-content provenance or teaching outcomes',
                verifies: [
                    'desktop-card-grid-renders-four-controlled-cards-in-three-real-visual-columns',
                    'mobile-card-grid-reflows-to-one-full-width-column-without-horizontal-overflow',
                    'container-and-cards-expose-native-list-and-listitem-semantics',
                    'layout-does-not-inject-runtime-style-elements-or-inline-motion-properties',
                    'reduced-motion-keeps-every-card-static-and-readable',
                ],
            },
            starfieldBackgroundFallback: {
                checked: true,
                viewport: '403/404 at 1440x900 and 390x844; prefers-reduced-motion: reduce',
                testDataBoundary: 'production fallback-page DOM/CSS and resource-timing contract only; verifies decorative reliability and page-root coverage, not GPU support outside the test browser',
                verifies: [
                    'fallback-pages-render-one-aria-hidden-pointer-transparent-starfield',
                    'starfield-contains-no-canvas-and-loads-no-ogl-vendor-resource',
                    'two-css-layers-and-one-glow-cover-the-owning-fallback-page',
                    'reduced-motion-stops-all-starfield-layer-animations',
                ],
            },
            magicRingsDecoration: {
                checked: true,
                viewport: '1440x900; prefers-reduced-motion: reduce',
                testDataBoundary: 'authenticated production dashboard DOM/CSS contract only; verifies decorative structure, attribute forwarding and motion fallback, not perceived innovation or teaching outcomes',
                verifies: [
                    'caller-aria-hidden-is-forwarded-to-the-decoration-root',
                    'decoration-uses-one-non-interactive-svg-with-two-percentage-rect-tracks',
                    'decoration-contains-no-runtime-path-or-canvas-surface',
                    'reduced-motion-converts-every-track-to-a-static-complete-outline',
                ],
            },
            thinkingPalaceLightweightAudit: {
                checked: true,
                verifies: [
                    'reduced-motion-defaults-to-clickable-two-dimensional-audit',
                    'three-vendor-is-not-downloaded-before-teacher-opt-in',
                    'teacher-can-explicitly-enable-immersive-three-dimensional-view',
                    'thinking-chain-button-preserves-full-bounded-question-as-accessible-name',
                ],
            },
            poemImageCardAccessibility: {
                checked: true,
                testDataBoundary: 'isolated-controlled-image-api-response plus an intentionally aborted HTTP(S) image request; verifies frontend resource-failure recovery only, not generated-image-model quality or provider availability',
                verifies: [
                    'poem-module-tablist-controls-panel-and-supports-arrow-home-end-navigation',
                    'image-card-exposes-sibling-native-open-button-and-download-link',
                    'image-lightbox-focuses-close-control-and-keeps-tab-boundary',
                    'image-lightbox-is-portaled-to-body-covers-the-full-viewport-blocks-shell-chrome-and-locks-background-scroll',
                    'escape-closes-image-lightbox-and-restores-the-source-button-focus',
                    'lightbox-close-restores-background-scroll',
                    'aborted-image-resource-ends-loading-state-and-hides-misleading-open-and-download-controls',
                    'failed-http-image-reload-issues-a-fresh-cache-busted-request',
                    'reduced-motion-image-cards-remain-visually-opaque',
                ],
            },
            starMapLightweightView: {
                checked: true,
                testDataBoundary: 'authenticated production route, navigation-drawer DOM and browser resource timing; verifies the default reference-33 OGL view, optional directory and resource boundaries only, not graph truth, image provenance or learning outcomes',
                verifies: [
                    'reference-33-ogl-gallery-is-the-default-view-even-under-reduced-motion',
                    'reduced-motion-stops-animation-without-replacing-layout-or-images',
                    'closed-observatory-drawer-is-aria-hidden-and-inert-open-focuses-search-and-close-restores-trigger',
                    'directory-category-tablist-controls-panel-and-supports-arrow-home-end-navigation',
                    'optional-directory-round-trip-restores-reference-33-gallery',
                    'three-vendor-is-not-downloaded-before-or-after-directory-round-trip',
                    'reference-33-bounded-ogl-gallery-uses-exactly-one-canvas',
                ],
            },
            evolutionEmptyEvidence: {
                checked: true,
                viewport: '1440x900',
                verifies: [
                    'top-level-student-ai-tablist-controls-panel-and-supports-arrow-home-end-navigation',
                    'ai-sidebar-tablist-controls-panel-and-supports-arrow-home-end-navigation',
                    'empty-genealogy-discloses-that-no-version-evidence-exists',
                    'empty-state-does-not-load-three-vendor-or-genealogy-renderer',
                    'teacher-can-refresh-persisted-evidence-and-open-pattern-collection-conditions',
                    'pattern-empty-state-discloses-signal-sources-and-opens-live-ai-run-evidence',
                ],
            },
            evolutionPatternLinkedNavigation: {
                checked: true,
                viewport: '1440x900;390x844',
                testDataBoundary: 'isolated-controlled-evolution-pattern-edge-and-node; verifies frontend semantic list, evidence-linked navigation, selection and focus transfer only, not agent performance or real evolution outcome evidence',
                verifies: [
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
                ],
            },
            lessonPlanImageGallery: {
                checked: true,
                viewport: '1440x900;390x844 touch;forced-colors;print',
                testDataBoundary: 'isolated controlled lesson-plan templates and local image responses, including one intentionally aborted image request; verifies frontend gallery semantics, geometry, focus, media fallbacks and resource recovery only, not template pedagogical quality, image provenance, backend persistence or teaching outcomes',
                verifies: [
                    'each-controlled-template-image-renders-once-with-visible-caption-and-native-button-semantics',
                    'roving-arrow-home-end-navigation-changes-focus-without-premature-activation',
                    'enter-and-space-open-a-viewport-covering-labelled-preview-dialog',
                    'tab-shift-tab-escape-backdrop-close-and-explicit-close-restore-the-exact-trigger',
                    'aborted-image-request-becomes-a-nonblank-stable-readable-failure-state-without-disabling-preview',
                    'touch-horizontal-scroll-does-not-block-page-scrolling-or-create-page-overflow',
                    'reduced-motion-forced-colors-and-print-preserve-an-explicit-usable-fallback',
                ],
            },
            starMapPoetryGallery: {
                checked: true,
                viewport: '1440x900;390x844 touch',
                testDataBoundary: 'isolated controlled three-poem graph with explicitly synthetic E2E relation edges and three same-poem packaged WebP responses; verifies reference-33 OGL node-index mapping, selection, focus transfer and responsive interaction only, not knowledge-graph truth, image provenance, student mastery or learning outcomes',
                verifies: [
                    'gallery-uses-one-bounded-ogl-canvas-and-three-native-controls-for-three-same-poem-webp-items',
                    'arrow-navigation-updates-the-foreground-poem-and-enter-opens-the-exact-detail',
                    'closing-detail-restores-the-single-canvas-focus',
                    'no-three-vendor-svg-placeholder-edge-blur-backdrop-blur-or-idle-auto-advance',
                    'mobile-controls-remain-at-least-44px-without-horizontal-overflow',
                    'reduced-motion-keeps-the-gallery-static-without-running-css-animation',
                ],
            },
            sphereGalleryLightweightResourceBoundary: {
                checked: true,
                viewport: '1440x900;390x844',
                testDataBoundary: 'production-build source and browser resource-timing boundary for the lesson-plan gallery consumer; verifies that route does not use Three.js, WebGL, Canvas, RAF, automatic timers or infinite gallery animations, not GPU behavior on untested browsers or long-duration device memory characteristics',
                verifies: [
                    'lesson-plan-gallery-source-contains-no-three-webgl-canvas-or-raf-path',
                    'lesson-plan-gallery-loads-no-three-vendor-resource',
                    'lesson-plan-gallery-renders-zero-canvas-elements',
                    'gallery-is-manual-only-and-runs-no-infinite-web-animation',
                    'gallery-registers-no-window-level-pointer-drag-listeners',
                ],
            },
            truthBoundaryChecks: {
                poemContent: poemContentTruthBoundary,
                unauthenticatedApiRejected: true,
            },
            securityHeaders,
        }
        await fs.mkdir(path.dirname(productionEvidence), { recursive: true })
        const temporaryEvidence = `${productionEvidence}.${process.pid}.tmp`
        await fs.writeFile(temporaryEvidence, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
        await fs.rename(temporaryEvidence, productionEvidence)
        console.log(`生产同源 E2E 通过：${baseUrl}（临时端口已在清理阶段释放）`)
        console.log(`证据：${productionEvidence}`)
    } catch (error) {
        primaryError = error
        console.error(`生产 E2E 后端子进程状态：${JSON.stringify(serverExit ?? {
            code: server.exitCode,
            signal: server.signalCode,
            running: server.exitCode === null,
        })}`)
        console.error(`生产服务输出尾部：\n${serverOutput}\n${serverError}`)
    }

    try {
        await stopChild(server)
        await removeOwnedTemp(temporaryRoot)
    } catch (cleanupError) {
        if (!primaryError) throw cleanupError
        console.error(cleanupError)
    }
    if (primaryError) throw primaryError
}

const isDirectExecution = Boolean(process.argv[1])
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isDirectExecution) {
    main().catch((error) => {
        console.error(error)
        process.exitCode = 1
    })
}
