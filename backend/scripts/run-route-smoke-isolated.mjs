/**
 * 一键隔离路由冒烟编排器
 *
 * 自动选择空闲端口、创建临时 SQLite 数据库、启动生产构建、等待健康检查，
 * 执行全部 HTTP 破坏性冒烟及编排官 WebSocket 握手/心跳，最后关闭子进程并清理临时目录。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import WebSocket from 'ws'

const backendRoot = process.cwd()
const serverEntry = path.join(backendRoot, 'dist', 'server.js')
const routeScript = path.join(backendRoot, 'scripts', 'route-destructive-smoke.mjs')
const websocketEvidencePath = path.resolve(backendRoot, '..', 'docs', 'audit', 'websocket-smoke-latest.json')
const memoryEvidencePath = path.resolve(backendRoot, '..', 'docs', 'audit', 'memory-governance-smoke-latest.json')
const runtimeEndpointEvidencePath = path.resolve(backendRoot, '..', 'docs', 'audit', 'runtime-endpoint-verification-latest.json')

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

async function waitForHealth(baseUrl, server, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    let lastError = '服务尚未响应'
    while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error(`隔离服务提前退出，exitCode=${server.exitCode}`)
        try {
            const response = await fetch(`${baseUrl}/api/health`)
            if (response.ok) return
            lastError = `health status=${response.status}`
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new Error(`隔离服务健康检查超时：${lastError}`)
}

async function acquireSession(baseUrl) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '13177091153', password: 'Chy101713' }),
    })
    if (response.status !== 200) throw new Error(`认证会话建立失败：status=${response.status}`)
    const body = await response.json()
    const rawSetCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie') ?? '']
    const cookiePairs = rawSetCookies
        .flatMap((value) => [...value.matchAll(/\b(pr_(?:session|csrf)=[^;,]+)/gu)].map((match) => match[1]))
        .filter(Boolean)
    if (cookiePairs.length !== 2 || typeof body?.csrfToken !== 'string' || typeof body?.user?.id !== 'string') {
        throw new Error('认证响应缺少完整 Cookie、CSRF 或教师主体')
    }
    return { cookie: cookiePairs.join('; '), csrfToken: body.csrfToken, teacherId: body.user.id }
}

async function verifyAuthLifecycle(baseUrl) {
    const publicStatus = await fetch(`${baseUrl}/api/auth/status`)
    const publicBody = await publicStatus.json()
    if (publicStatus.status !== 200 || publicBody?.authenticated !== false) {
        throw new Error('未登录认证状态端点没有返回失败关闭状态')
    }

    const invalidLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '13900000000', password: 'invalid-demo-password' }),
    })
    if (invalidLogin.status !== 401) throw new Error(`非白名单演示账号未被拒绝：${invalidLogin.status}`)

    const session = await acquireSession(baseUrl)
    const authenticatedStatus = await fetch(`${baseUrl}/api/auth/status`, {
        headers: authHeaders(session),
    })
    if (authenticatedStatus.status !== 200 || (await authenticatedStatus.json())?.authenticated !== true) {
        throw new Error('有效签名会话未被认证状态端点识别')
    }

    const csrfRejected = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: authHeaders(session),
    })
    if (csrfRejected.status !== 403) throw new Error(`缺失 CSRF 的注销未被拒绝：${csrfRejected.status}`)

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: authHeaders(session, true),
    })
    if (logout.status !== 200) throw new Error(`认证注销失败：${logout.status}`)
    const revokedStatus = await fetch(`${baseUrl}/api/auth/status`, {
        headers: authHeaders(session),
    })
    if (revokedStatus.status !== 200 || (await revokedStatus.json())?.authenticated !== false) {
        throw new Error('注销后的旧会话仍然有效')
    }
    return {
        status: 'passed',
        publicStatus: true,
        invalidAccountRejected: true,
        signedSessionRecognized: true,
        csrfRejected: true,
        logoutRevoked: true,
    }
}

function authHeaders(session, mutating = false, extra = {}) {
    return {
        cookie: session.cookie,
        ...(mutating ? { 'x-csrf-token': session.csrfToken } : {}),
        ...extra,
    }
}

/**
 * Exercise an actual production SSE response instead of only treating its
 * invalid-input boundary as a normal JSON route. The normal read proves that
 * headers, progressive frames and the terminal frame survive Fastify's raw
 * response path. The second request deliberately aborts after its first frame
 * and then rechecks health, proving an abandoned viewer does not kill the
 * isolated process or leave the route unable to serve subsequent requests.
 */
async function verifyDemoChatSse(baseUrl, session) {
    const payload = JSON.stringify({
        messages: [{ role: 'user', content: '请确认 SSE 生命周期审计。' }],
        stream: true,
    })
    const headers = authHeaders(session, true, {
        accept: 'text/event-stream',
        'content-type': 'application/json',
    })
    const response = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST', headers, body: payload,
    })
    const contentType = response.headers.get('content-type') ?? ''
    if (response.status !== 200 || !contentType.includes('text/event-stream') || response.headers.get('x-demo-mode') !== 'true') {
        throw new Error(`DEMO SSE 正常请求响应异常：status=${response.status} content-type=${contentType}`)
    }
    if (!response.body) throw new Error('DEMO SSE 正常请求缺少可读响应体')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let received = ''
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += decoder.decode(value, { stream: true })
        if (received.length > 128_000) throw new Error('DEMO SSE 响应超过审计上限')
    }
    received += decoder.decode()
    const frames = received.split('\n\n').filter(Boolean)
    if (frames.length < 3 || !frames.some((frame) => frame.startsWith('data: {')) || frames.at(-1) !== 'data: [DONE]') {
        throw new Error(`DEMO SSE 正常帧不完整：frames=${frames.length}`)
    }

    const cancellation = new AbortController()
    const cancelledResponse = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST', headers, body: payload, signal: cancellation.signal,
    })
    if (cancelledResponse.status !== 200 || !cancelledResponse.body) {
        throw new Error(`DEMO SSE 取消请求未建立：status=${cancelledResponse.status}`)
    }
    const cancelledReader = cancelledResponse.body.getReader()
    const firstChunk = await cancelledReader.read()
    if (firstChunk.done || !firstChunk.value || firstChunk.value.byteLength === 0) {
        throw new Error('DEMO SSE 取消请求在首帧前结束')
    }
    cancellation.abort()
    try {
        await cancelledReader.read()
    } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
            throw error
        }
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
    const health = await fetch(`${baseUrl}/api/health`)
    if (!health.ok) throw new Error(`DEMO SSE 取消后服务健康检查失败：status=${health.status}`)

    return {
        status: 'passed',
        normalFrames: frames.length,
        terminalFrame: true,
        cancelledAfterFirstFrame: true,
        serverHealthyAfterCancellation: true,
    }
}

function runRouteAudit(baseUrl, session) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [routeScript], {
            cwd: backendRoot,
            env: {
                ...process.env,
                ROUTE_SMOKE_BASE_URL: baseUrl,
                ROUTE_SMOKE_AUTH_COOKIE: session.cookie,
                ROUTE_SMOKE_CSRF_TOKEN: session.csrfToken,
            },
            stdio: 'inherit',
            windowsHide: true,
        })
        child.once('error', reject)
        child.once('exit', (code, signal) => {
            if (code === 0) resolve()
            else reject(new Error(`HTTP 路由冒烟失败：code=${code}, signal=${signal ?? 'none'}`))
        })
    })
}

async function runMemoryGovernanceAudit(baseUrl, session) {
    const teacherId = session.teacherId
    const createResponse = await fetch(`${baseUrl}/api/memory`, {
        method: 'POST',
        headers: authHeaders(session, true, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ teacherId, kind: 'teacher', content: 'runtime smoke memory' }),
    })
    if (createResponse.status !== 201) throw new Error(`记忆创建冒烟失败：status=${createResponse.status}`)
    const created = await createResponse.json()
    const memoryId = created?.memory?.id
    if (typeof memoryId !== 'string' || memoryId.length === 0) throw new Error('记忆创建响应缺少 id')

    const listResponse = await fetch(`${baseUrl}/api/memory?teacherId=${encodeURIComponent(teacherId)}&kind=teacher`, {
        headers: authHeaders(session),
    })
    if (listResponse.status !== 200) throw new Error(`记忆列表冒烟失败：status=${listResponse.status}`)
    const listed = await listResponse.json()
    if (listed?.total !== 1 || listed?.memories?.[0]?.id !== memoryId) throw new Error('记忆列表响应不一致')

    const updateResponse = await fetch(`${baseUrl}/api/memory/${encodeURIComponent(memoryId)}`, {
        method: 'PATCH',
        headers: authHeaders(session, true, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ teacherId, content: 'runtime smoke memory updated' }),
    })
    if (updateResponse.status !== 200) throw new Error(`记忆更新冒烟失败：status=${updateResponse.status}`)

    const missingOwnerResponse = await fetch(`${baseUrl}/api/memory`, { headers: authHeaders(session) })
    if (missingOwnerResponse.status !== 400) throw new Error(`记忆缺少所有者未拒绝：status=${missingOwnerResponse.status}`)

    const sensitiveResponse = await fetch(`${baseUrl}/api/memory`, {
        method: 'POST',
        headers: authHeaders(session, true, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ teacherId, kind: 'teacher', content: '邮箱 test@example.com' }),
    })
    if (sensitiveResponse.status !== 400) throw new Error(`敏感记忆未拒绝：status=${sensitiveResponse.status}`)

    const ambiguousStudentListResponse = await fetch(
        `${baseUrl}/api/memory?teacherId=${encodeURIComponent(teacherId)}&studentId=student-a`,
        { headers: authHeaders(session) },
    )
    if (ambiguousStudentListResponse.status !== 400) {
        throw new Error(`无班级学生记忆列举未失败关闭：status=${ambiguousStudentListResponse.status}`)
    }
    const ambiguousStudentDeleteResponse = await fetch(
        `${baseUrl}/api/memory?teacherId=${encodeURIComponent(teacherId)}&studentId=student-a`,
        { method: 'DELETE', headers: authHeaders(session, true) },
    )
    if (ambiguousStudentDeleteResponse.status !== 400) {
        throw new Error(`无班级学生记忆批量删除未失败关闭：status=${ambiguousStudentDeleteResponse.status}`)
    }

    const deleteResponse = await fetch(`${baseUrl}/api/memory/${encodeURIComponent(memoryId)}?teacherId=${encodeURIComponent(teacherId)}`, {
        method: 'DELETE',
        headers: authHeaders(session, true),
    })
    if (deleteResponse.status !== 200) throw new Error(`记忆删除冒烟失败：status=${deleteResponse.status}`)
    return {
        status: 'passed',
        created: true,
        listed: true,
        updated: true,
        missingOwnerRejected: true,
        sensitiveRejected: true,
        ambiguousStudentListRejected: true,
        ambiguousStudentDeleteRejected: true,
        deleted: true,
    }
}

function verifyWebSocket(baseUrl, session) {
    return new Promise((resolve, reject) => {
        const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws/orchestrator'
        const socket = new WebSocket(wsUrl, {
            headers: { Cookie: session.cookie, Origin: baseUrl },
        })
        let connected = false
        let sessionStart = false
        let pong = false
        const timer = setTimeout(() => {
            socket.close()
            reject(new Error('WebSocket 握手/心跳超时'))
        }, 10_000)

        socket.addEventListener('open', () => {
            connected = true
            socket.send(JSON.stringify({ type: 'ping' }))
        })
        socket.addEventListener('message', (event) => {
            try {
                const message = JSON.parse(String(event.data))
                if (message.type === 'orch:session:start') sessionStart = true
                if (message.type === 'pong') pong = true
                if (connected && sessionStart && pong) {
                    clearTimeout(timer)
                    socket.close()
                    resolve({ wsUrl, connected, sessionStart, pong })
                }
            } catch (error) {
                clearTimeout(timer)
                socket.close()
                reject(new Error(`WebSocket 返回非 JSON：${error instanceof Error ? error.message : String(error)}`))
            }
        })
        socket.addEventListener('error', () => {
            clearTimeout(timer)
            reject(new Error('WebSocket 连接错误'))
        })
    })
}

function verifyCrossOriginWebSocketRejected(baseUrl, session) {
    return new Promise((resolve, reject) => {
        const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws/orchestrator'
        const socket = new WebSocket(wsUrl, {
            headers: {
                Cookie: session.cookie,
                Origin: 'http://localhost:6666',
            },
        })
        let settled = false
        const finish = (error, value) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            socket.removeAllListeners()
            if (error) reject(error)
            else resolve(value)
        }
        const timer = setTimeout(() => finish(new Error('跨来源 WebSocket 拒绝检查超时')), 10_000)
        socket.once('open', () => {
            socket.close()
            finish(new Error('跨来源 WebSocket 被错误接受'))
        })
        socket.once('unexpected-response', (_request, response) => {
            response.resume()
            if (response.statusCode === 403) finish(null, { rejected: true, statusCode: 403 })
            else finish(new Error(`跨来源 WebSocket 返回意外状态：${response.statusCode}`))
        })
        socket.once('error', (error) => {
            if (!settled) finish(new Error(`跨来源 WebSocket 检查失败：${error.message}`))
        })
    })
}

function verifyUnauthorizedWebSocketRejected(baseUrl) {
    return new Promise((resolve, reject) => {
        const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws/orchestrator'
        const socket = new WebSocket(wsUrl)
        let settled = false
        const finish = (error, value) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            socket.removeAllListeners()
            if (error) reject(error)
            else resolve(value)
        }
        const timer = setTimeout(() => finish(new Error('未认证 WebSocket 拒绝检查超时')), 10_000)
        socket.once('open', () => {
            socket.close()
            finish(new Error('未认证 WebSocket 被错误接受'))
        })
        socket.once('unexpected-response', (_request, response) => {
            response.resume()
            if (response.statusCode === 401) finish(null, { rejected: true, statusCode: 401 })
            else finish(new Error(`未认证 WebSocket 返回意外状态：${response.statusCode}`))
        })
        socket.once('error', (error) => {
            if (!settled) finish(new Error(`未认证 WebSocket 检查失败：${error.message}`))
        })
    })
}

function stopChild(child) {
    if (child.exitCode !== null || child.killed) return Promise.resolve()
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, 5_000)
        child.once('exit', () => {
            clearTimeout(timer)
            resolve()
        })
        child.kill()
    })
}

async function main() {
    await fs.access(serverEntry)
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'poetic-realm-route-smoke-'))
    const databasePath = path.join(temporaryRoot, 'route-smoke.db')
    const port = await reserveFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    let serverOutput = ''
    let serverError = ''
    const server = spawn(process.execPath, [serverEntry], {
        cwd: backendRoot,
        env: {
            ...process.env,
            NODE_ENV: 'production',
            HOST: '127.0.0.1',
            PORT: String(port),
            SQLITE_PATH: databasePath,
            DEMO_MODE: 'true',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-8_000) })
    server.stderr.on('data', (chunk) => { serverError = `${serverError}${chunk}`.slice(-8_000) })

    try {
        await waitForHealth(baseUrl, server)
        const unauthenticatedWebSocket = await verifyUnauthorizedWebSocketRejected(baseUrl)
        const authenticationLifecycle = await verifyAuthLifecycle(baseUrl)
        const session = await acquireSession(baseUrl)
        const crossOriginWebSocket = await verifyCrossOriginWebSocketRejected(baseUrl, session)
        await runRouteAudit(baseUrl, session)
        const sseLifecycle = await verifyDemoChatSse(baseUrl, session)
        console.log('DEMO SSE 冒烟：正常逐帧/结束帧、首帧后主动取消及取消后健康检查全部通过')
        const memoryGovernance = await runMemoryGovernanceAudit(baseUrl, session)
        await fs.mkdir(path.dirname(memoryEvidencePath), { recursive: true })
        await fs.writeFile(memoryEvidencePath, `${JSON.stringify({
            generatedAt: new Date().toISOString(),
            baseUrl,
            ...memoryGovernance,
        }, null, 2)}\n`, 'utf8')
        console.log('长期记忆治理冒烟：创建、列表、更新、缺少所有者/敏感标识/无班级学生范围拒绝、删除全部通过')
        console.log(`证据：${memoryEvidencePath}`)
        const websocket = await verifyWebSocket(baseUrl, session)
        await fs.mkdir(path.dirname(websocketEvidencePath), { recursive: true })
        await fs.writeFile(websocketEvidencePath, `${JSON.stringify({
            generatedAt: new Date().toISOString(),
            baseUrl,
            status: 'passed',
            unauthenticatedWebSocket,
            crossOriginWebSocket,
            ...websocket,
        }, null, 2)}\n`, 'utf8')
        console.log('WebSocket 冒烟：握手、session:start、ping/pong 全部通过')
        console.log(`证据：${websocketEvidencePath}`)

        const mainRouteEvidence = JSON.parse(await fs.readFile(
            path.resolve(backendRoot, '..', 'docs', 'audit', 'route-smoke-latest.json'),
            'utf8',
        ))
        const countDeclarations = async (sourcePath) => {
            const source = await fs.readFile(sourcePath, 'utf8')
            return [...source.matchAll(/app\.(?:get|post|put|patch|delete)(?:<[^\n]+>)?\s*\(/gu)].length
        }
        const [memoryRouteCount, authRouteCount, websocketRouteCount] = await Promise.all([
            countDeclarations(path.resolve(backendRoot, 'src', 'routes', 'memory.ts')),
            countDeclarations(path.resolve(backendRoot, 'src', 'security', 'auth.ts')),
            countDeclarations(path.resolve(backendRoot, 'src', 'orchestrator', 'websocket', 'handlers.ts')),
        ])
        const mainRouteCount = Number(mainRouteEvidence.routeCount)
        const verifiedHttpRoutes = mainRouteCount + memoryRouteCount + authRouteCount
        await fs.writeFile(runtimeEndpointEvidencePath, `${JSON.stringify({
            generatedAt: new Date().toISOString(),
            baseUrl,
            status: 'passed',
            http: {
                verifiedDeclarations: verifiedHttpRoutes,
                mainDestructiveRoutes: mainRouteCount,
                memoryGovernanceRoutes: memoryRouteCount,
                authenticationRoutes: authRouteCount,
                failures: Number(mainRouteEvidence.failedCount),
            },
            websocket: {
                verifiedDeclarations: websocketRouteCount,
                unauthenticatedRejected: unauthenticatedWebSocket.rejected,
                crossOriginRejected: crossOriginWebSocket.rejected,
                authenticatedHandshake: websocket.connected,
                sessionStart: websocket.sessionStart,
                pingPong: websocket.pong,
            },
            sse: sseLifecycle,
            authenticationLifecycle,
        }, null, 2)}\n`, 'utf8')
        console.log(`运行时端点总证据：${verifiedHttpRoutes} 条 HTTP + ${websocketRouteCount} 条 WebSocket 全部通过`)
        console.log(`证据：${runtimeEndpointEvidencePath}`)
    } catch (error) {
        if (server.exitCode !== null || serverError) {
            console.error(`隔离服务输出尾部：\n${serverOutput}\n${serverError}`)
        }
        throw error
    } finally {
        await stopChild(server)
        const resolvedTemp = path.resolve(temporaryRoot)
        const expectedPrefix = path.resolve(os.tmpdir()) + path.sep
        if (resolvedTemp.startsWith(expectedPrefix) && path.basename(resolvedTemp).startsWith('poetic-realm-route-smoke-')) {
            await fs.rm(resolvedTemp, { recursive: true, force: true })
        }
    }
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
