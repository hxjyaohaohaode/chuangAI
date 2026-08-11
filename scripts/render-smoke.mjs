import { randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

const repositoryRoot = resolve(import.meta.dirname, '..')
const startScript = join(repositoryRoot, 'scripts', 'render-start.mjs')
const smokeRoot = mkdtempSync(join(tmpdir(), 'poetic-realm-render-smoke-'))
const smokePassword = 'render-smoke-password'

function createTestPasswordHash() {
    const salt = randomBytes(16)
    const derived = scryptSync(smokePassword, salt, 32, {
        N: 16_384,
        r: 8,
        p: 1,
        maxmem: 128 * 1024 * 1024,
    })
    return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

async function reservePort() {
    return new Promise((accept, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (!address || typeof address === 'string') {
                server.close()
                reject(new Error('无法分配隔离烟测端口'))
                return
            }
            server.close((error) => error ? reject(error) : accept(address.port))
        })
    })
}

const port = await reservePort()
const baseUrl = `http://127.0.0.1:${port}`
const expectedBindHost = '0.0.0.0'
const childEnvironment = {
    ...process.env,
    RENDER: 'true',
    NODE_ENV: 'production',
    HOST: expectedBindHost,
    PORT: String(port),
    APP_DATA_DIR: smokeRoot,
    SQLITE_PATH: join(smokeRoot, 'poetic-realm.db'),
    RENDER_EXTERNAL_URL: 'https://render-smoke.onrender.com',
    PUBLIC_APP_ORIGINS: 'https://teach.example.cn',
    DEMO_MODE: 'true',
    // 即使调用者 Shell 已配置真实供应商凭据，烟测子进程也必须显式隔离，
    // 防止初始化或未来新增探针意外消费真实额度。
    DEEPSEEK_API_KEY: '',
    MIMO_API_KEY: '',
    DASHSCOPE_API_KEY: '',
    WAN_IMAGE_BASE_URL: '',
    NEO4J_URI: 'bolt://127.0.0.1:1',
    NEO4J_USER: 'neo4j',
    NEO4J_PASSWORD: '',
    ALLOW_UNAUTHENTICATED_NON_LOOPBACK: 'false',
    AUTH_MODE: 'password',
    AUTH_COOKIE_SECURE: 'true',
    AUTH_SESSION_SECRET: randomBytes(32).toString('base64url'),
    AUTH_PASSWORD_SCRYPT: createTestPasswordHash(),
    AUTH_TEACHER_ID: 'teacher-001',
    AUTH_TEACHER_NAME: 'Render Smoke Teacher',
}

function sleep(milliseconds) {
    return new Promise((accept) => setTimeout(accept, milliseconds))
}

function assertRenderConfigurationRejected(overrides, expectedMessage) {
    const rejected = spawnSync(process.execPath, [startScript], {
        cwd: repositoryRoot,
        env: { ...childEnvironment, ...overrides },
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
    })
    const detail = `${rejected.stdout ?? ''}\n${rejected.stderr ?? ''}`
    if (rejected.status === 0 || !detail.includes(expectedMessage)) {
        throw new Error(`危险 Render 配置没有失败关闭：${JSON.stringify(overrides)}`)
    }
}

async function waitForHealth(child, stderr) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (child.exitCode !== null) {
            throw new Error(`服务提前退出（${child.exitCode}）：${stderr.value.slice(-2_000)}`)
        }
        try {
            const response = await fetch(`${baseUrl}/api/health`)
            if (response.ok) return await response.json()
        } catch {
            // 冷启动期间连接拒绝属于预期，继续短间隔探测。
        }
        await sleep(250)
    }
    throw new Error(`健康检查超时：${stderr.value.slice(-2_000)}`)
}

async function stopChild(child) {
    if (child.exitCode !== null) return
    await new Promise((accept) => {
        const forceTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL')
        }, 10_000)
        child.once('exit', () => {
            clearTimeout(forceTimer)
            accept()
        })
        child.kill('SIGTERM')
    })
}

async function startInstance() {
    const child = spawn(process.execPath, [startScript], {
        cwd: repositoryRoot,
        env: childEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    })
    const stderr = { value: '' }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr.value += chunk })
    child.stdout.resume()
    try {
        const health = await waitForHealth(child, stderr)
        return { child, health }
    } catch (error) {
        await stopChild(child)
        throw error
    }
}

let first
let second
try {
    assertRenderConfigurationRejected({ HOST: '127.0.0.1' }, 'HOST=0.0.0.0')
    const filesystemRoot = parse(smokeRoot).root
    assertRenderConfigurationRejected(
        { APP_DATA_DIR: filesystemRoot, SQLITE_PATH: join(filesystemRoot, 'poetic-realm.db') },
        'APP_DATA_DIR 不得直接指向文件系统根目录',
    )
    assertRenderConfigurationRejected(
        { SQLITE_PATH: join(tmpdir(), 'poetic-realm-render-smoke-outside.db') },
        'SQLITE_PATH 必须严格位于 APP_DATA_DIR',
    )

    first = await startInstance()

    const page = await fetch(`${baseUrl}/`)
    const pageHtml = await page.text()
    if (!page.ok || !pageHtml.includes('<div id="root">')) {
        throw new Error('生产前端壳未由后端正确托管')
    }

    const deepLink = await fetch(`${baseUrl}/dashboard`, {
        headers: { Accept: 'text/html' },
    })
    const deepLinkHtml = await deepLink.text()
    if (!deepLink.ok || !deepLinkHtml.includes('<div id="root">')) {
        throw new Error('SPA 深链没有回退到生产前端壳')
    }

    // 匿名能力只能是 GET /api/report/shared/:token 的单一精确路径；相邻的
    // 列表与嵌套路径必须继续要求登录。公开 SPA 页面也必须在首份 HTML 上
    // 禁止缓存和 Referrer 外发，避免 bearer token 被浏览器或代理泄漏。
    const absentShareToken = 'z'.repeat(43)
    const sharedPage = await fetch(`${baseUrl}/shared/report/${absentShareToken}`, {
        headers: { Accept: 'text/html' },
    })
    const sharedPageHtml = await sharedPage.text()
    if (!sharedPage.ok || !sharedPageHtml.includes('<div id="root">')) {
        throw new Error('匿名共享报告 SPA 深链不可达')
    }
    if (!(sharedPage.headers.get('cache-control') ?? '').includes('no-store')
        || sharedPage.headers.get('referrer-policy') !== 'no-referrer') {
        throw new Error('匿名共享报告页面缺少 bearer token 防泄漏响应头')
    }

    const anonymousSharedReport = await fetch(`${baseUrl}/api/report/shared/${absentShareToken}`)
    if (anonymousSharedReport.status !== 404) {
        throw new Error(`匿名共享报告精确路由应越过登录边界并隐藏不存在性（实际 ${anonymousSharedReport.status}）`)
    }
    for (const protectedPath of [
        '/api/report/shared',
        `/api/report/shared/${absentShareToken}/nested`,
    ]) {
        const protectedResponse = await fetch(`${baseUrl}${protectedPath}`)
        if (protectedResponse.status !== 401) {
            throw new Error(`相邻共享报告路径必须保持认证保护：${protectedPath}（实际 ${protectedResponse.status}）`)
        }
    }

    const allowed = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: 'https://render-smoke.onrender.com' },
    })
    if (allowed.headers.get('access-control-allow-origin') !== 'https://render-smoke.onrender.com') {
        throw new Error('RENDER_EXTERNAL_URL 未进入精确 Origin 白名单')
    }
    const hostile = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: 'https://attacker.example' },
    })
    if (hostile.headers.has('access-control-allow-origin')) {
        throw new Error('恶意 Origin 意外获得 CORS 许可')
    }

    const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Origin: 'https://render-smoke.onrender.com',
        },
        body: JSON.stringify({ teacherId: 'teacher-001', password: smokePassword }),
    })
    if (!login.ok) throw new Error(`密码登录烟测失败（${login.status}）`)
    const loginBody = await login.json()
    const setCookie = login.headers.get('set-cookie') ?? ''
    for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict']) {
        if (!setCookie.includes(attribute)) throw new Error(`登录 Cookie 缺少 ${attribute}`)
    }
    const sessionMatch = setCookie.match(/(?:^|,\s*)pr_session=([^;]+)/)
    if (!sessionMatch?.[1] || typeof loginBody?.csrfToken !== 'string' || loginBody.csrfToken.length === 0) {
        throw new Error('密码登录未同时签发会话 Cookie 与 CSRF 令牌')
    }
    const sessionCookie = `pr_session=${sessionMatch[1]}; pr_csrf=${encodeURIComponent(loginBody.csrfToken)}`

    // Render 上凭据必须只由 Dashboard Environment 管理。这里走完整认证路由，
    // 同时放入随机明文探针，证明 PUT 稳定失败且探针没有进入项目根 .env。
    const credentialStatus = await fetch(`${baseUrl}/api/settings/credentials`, {
        headers: { Cookie: sessionCookie },
    })
    const credentialStatusBody = await credentialStatus.json()
    if (!credentialStatus.ok
        || credentialStatusBody?.management?.mutable !== false
        || credentialStatusBody?.management?.managedBy !== 'render-dashboard') {
        throw new Error('Render 凭据 GET 未声明 Dashboard 托管只读策略')
    }
    const credentialWriteProbe = `render-smoke-secret-${randomBytes(24).toString('base64url')}`
    const projectEnvironmentFile = join(repositoryRoot, '.env')
    const environmentBeforeMutation = existsSync(projectEnvironmentFile)
        ? readFileSync(projectEnvironmentFile)
        : null
    const credentialMutation = await fetch(`${baseUrl}/api/settings/credentials/deepseek`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            Cookie: sessionCookie,
            Origin: 'https://render-smoke.onrender.com',
            'X-CSRF-Token': loginBody.csrfToken,
        },
        body: JSON.stringify({ apiKey: credentialWriteProbe }),
    })
    const credentialMutationBody = await credentialMutation.json()
    if (credentialMutation.status !== 409
        || credentialMutationBody?.error !== 'SETTINGS_MANAGED_EXTERNALLY'
        || credentialMutationBody?.management?.mutable !== false) {
        throw new Error(
            'Render 凭据 PUT 未按稳定 409 契约失败关闭'
            + `（实际 ${credentialMutation.status}/${String(credentialMutationBody?.error ?? 'NO_ERROR_CODE')}）`,
        )
    }
    const environmentAfterMutation = existsSync(projectEnvironmentFile)
        ? readFileSync(projectEnvironmentFile)
        : null
    if ((environmentBeforeMutation === null) !== (environmentAfterMutation === null)
        || (environmentBeforeMutation !== null
            && environmentAfterMutation !== null
            && !environmentBeforeMutation.equals(environmentAfterMutation))
        || environmentAfterMutation?.includes(Buffer.from(credentialWriteProbe, 'utf8'))) {
        throw new Error('Render 凭据 PUT 改写了项目根 .env 或泄露明文探针')
    }

    const databaseFile = join(smokeRoot, 'poetic-realm.db')
    const uploadsDirectory = join(smokeRoot, 'uploads')
    const generatedDirectory = join(smokeRoot, 'uploads', 'generated')
    const ttsDirectory = join(smokeRoot, 'audio', 'tts')
    const recitationsDirectory = join(smokeRoot, 'audio', 'recitations')
    if (![databaseFile, uploadsDirectory, generatedDirectory, ttsDirectory, recitationsDirectory]
        .every((path) => existsSync(path))) {
        throw new Error('SQLite、上传、生成图片或音频目录没有全部落在 APP_DATA_DIR')
    }
    const generatedWriteProbe = join(generatedDirectory, 'render-smoke-write-probe.txt')
    const generatedWriteMarker = randomBytes(24).toString('base64url')
    writeFileSync(generatedWriteProbe, generatedWriteMarker, { encoding: 'utf8', flag: 'wx' })
    if (readFileSync(generatedWriteProbe, 'utf8') !== generatedWriteMarker) {
        throw new Error('生成图片目录写入后无法读回探针')
    }

    await stopChild(first.child)
    first = undefined

    // 使用同一 APP_DATA_DIR 再启动，验证冷启动不会重建到仓库或因既有 SQLite 失败。
    second = await startInstance()
    if (second.health.status !== 'ok' || !existsSync(databaseFile)) {
        throw new Error('使用同一持久目录重启失败')
    }
    if (!existsSync(generatedWriteProbe)
        || readFileSync(generatedWriteProbe, 'utf8') !== generatedWriteMarker) {
        throw new Error('生成目录写入探针没有跨同一 APP_DATA_DIR 重启保留')
    }

    process.stdout.write(`${JSON.stringify({
        status: 'passed',
        bindHost: expectedBindHost,
        portFromEnvironment: port,
        unsafeBindRejected: true,
        filesystemRootDataDirectoryRejected: true,
        outOfDiskDatabaseRejected: true,
        health: second.health.status,
        service: second.health.service,
        frontendStatus: page.status,
        spaDeepLinkStatus: deepLink.status,
        anonymousSharedPageStatus: sharedPage.status,
        anonymousSharedApiStatus: anonymousSharedReport.status,
        adjacentSharedRoutesProtected: true,
        renderOriginAllowed: true,
        hostileOriginAllowed: false,
        securePasswordCookie: true,
        credentialsManagedByRender: true,
        credentialMutationRejected: true,
        projectEnvironmentUnchanged: true,
        plaintextCredentialProbeAbsentFromProjectEnv: true,
        databaseUnderAppData: true,
        allRuntimeDirectoriesUnderAppData: true,
        generatedDirectoryUnderAppData: true,
        generatedDirectoryWritable: true,
        generatedWritePersistedAcrossRestart: true,
        restartWithSameDataDirectory: true,
        temporaryEvidenceDirectory: smokeRoot,
    })}\n`)
} finally {
    if (first?.child) await stopChild(first.child)
    if (second?.child) await stopChild(second.child)
}
