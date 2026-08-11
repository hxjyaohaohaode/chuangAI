/** 在随机回环端口和临时 SQLite 上执行星图完整性审计，不依赖人工启动服务。 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backendRoot = path.resolve(frontendRoot, '..', 'backend')
const serverEntry = path.join(backendRoot, 'dist', 'server.js')
const auditEntry = path.join(frontendRoot, 'scripts', 'audit-starmap.mjs')

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

async function waitForHealth(baseUrl, server) {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error(`星图隔离服务提前退出：${server.exitCode}`)
        try {
            if ((await fetch(`${baseUrl}/api/health`)).ok) return
        } catch {
            // 服务仍在启动。
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new Error('星图隔离服务健康检查超时')
}

function runAudit(baseUrl) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [auditEntry], {
            cwd: frontendRoot,
            env: {
                ...process.env,
                STARMAP_AUDIT_URL: `${baseUrl}/api/knowledge-graph/full`,
            },
            stdio: 'inherit',
            windowsHide: true,
        })
        child.once('error', reject)
        child.once('exit', (code, signal) => code === 0
            ? resolve()
            : reject(new Error(`星图审计子进程失败：code=${code}, signal=${signal ?? 'none'}`)))
    })
}

function stopChild(child) {
    if (child.exitCode !== null) return Promise.resolve()
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, 5_000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
        child.kill()
    })
}

async function removeOwnedTemp(directory) {
    const resolved = path.resolve(directory)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir())
        || !path.basename(resolved).startsWith('poetic-realm-starmap-')) {
        throw new Error(`拒绝清理边界外目录：${resolved}`)
    }
    const info = await fs.lstat(resolved)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`拒绝清理非普通目录：${resolved}`)
    await fs.rm(resolved, { recursive: true })
}

async function main() {
    await Promise.all([fs.access(serverEntry), fs.access(auditEntry)])
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'poetic-realm-starmap-'))
    const port = await reserveFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    let stderr = ''
    const server = spawn(process.execPath, [serverEntry], {
        cwd: backendRoot,
        env: {
            ...process.env,
            NODE_ENV: 'production',
            HOST: '127.0.0.1',
            PORT: String(port),
            SQLITE_PATH: path.join(temporaryRoot, 'starmap.db'),
            DEMO_MODE: 'true',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    })
    server.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000) })
    try {
        await waitForHealth(baseUrl, server)
        await runAudit(baseUrl)
    } catch (error) {
        if (stderr) console.error(`星图隔离服务错误尾部：\n${stderr}`)
        throw error
    } finally {
        await stopChild(server)
        await removeOwnedTemp(temporaryRoot)
    }
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
