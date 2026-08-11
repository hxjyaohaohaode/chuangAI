/**
 * 一键隔离生产闭环回归编排器
 *
 * 自动选择空闲端口、创建临时 SQLite、启动 DEMO 生产后端，执行闭环脚本，
 * 最后关闭子进程并清理临时目录。测试不依赖开发者预先启动 3001 服务。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const backendRoot = process.cwd()
const serverEntry = path.join(backendRoot, 'dist', 'server.js')
const regressionScript = path.join(backendRoot, 'scripts', 'closed-loop-regression.mjs')

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

function runRegression(baseUrl) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [regressionScript], {
            cwd: backendRoot,
            env: { ...process.env, CLOSED_LOOP_BASE_URL: baseUrl },
            stdio: 'inherit',
            windowsHide: true,
        })
        child.once('error', reject)
        child.once('exit', (code, signal) => {
            if (code === 0) resolve()
            else reject(new Error(`闭环回归子进程失败：code=${code}, signal=${signal ?? 'none'}`))
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

async function removeOwnedTemporary(temporaryRoot) {
    const resolved = path.resolve(temporaryRoot)
    const expectedPrefix = path.resolve(os.tmpdir()) + path.sep
    if (!resolved.startsWith(expectedPrefix) || !path.basename(resolved).startsWith('poetic-realm-closed-loop-')) {
        throw new Error(`拒绝清理非本测试临时目录：${resolved}`)
    }
    const info = await fs.lstat(resolved)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`拒绝清理非普通临时目录：${resolved}`)
    await fs.rm(resolved, { recursive: true })
}

async function main() {
    await fs.access(serverEntry)
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'poetic-realm-closed-loop-'))
    const databasePath = path.join(temporaryRoot, 'closed-loop.db')
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
        await runRegression(baseUrl)
    } catch (error) {
        if (server.exitCode !== null || serverError) {
            console.error(`隔离服务输出尾部：\n${serverOutput}\n${serverError}`)
        }
        throw error
    } finally {
        await stopChild(server)
        await removeOwnedTemporary(temporaryRoot)
    }
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
