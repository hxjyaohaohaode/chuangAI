import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function assertSupportedNode() {
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major !== 20 || minor < 19) {
        throw new Error(`Render 构建要求 Node >=20.19 <21，当前为 ${process.versions.node}`)
    }
}

function runPnpm(directory, ...args) {
    // 本地机器可能同时装有多个 Node。若只按 PATH 查找 corepack，顶层虽由
    // Node 20 启动，pnpm 与 package scripts 仍可能悄悄落到 Node 22/24。
    // 优先使用当前 process.execPath 的同目录 Corepack，并把该目录置于 PATH
    // 首位；这也与 Render 选定 NODE_VERSION 后的运行时布局保持一致。
    const nodeDirectory = dirname(process.execPath)
    const siblingCorepack = join(nodeDirectory, process.platform === 'win32' ? 'corepack.cmd' : 'corepack')
    const executable = existsSync(siblingCorepack)
        ? siblingCorepack
        : process.platform === 'win32' ? 'corepack.cmd' : 'corepack'
    const inheritedPath = process.env.PATH ?? process.env.Path ?? ''
    const childEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
    )
    childEnvironment.PATH = [nodeDirectory, inheritedPath].filter(Boolean).join(delimiter)
    childEnvironment.NODE_ENV = 'production'
    const result = spawnSync(
        executable,
        ['pnpm', ...args],
        {
            // Corepack 在启动 pnpm 前解析当前目录的 packageManager；不能依赖
            // pnpm 自己的 --dir，因为那时 Corepack 已可能选中机器全局版本。
            cwd: join(repositoryRoot, directory),
            env: childEnvironment,
            stdio: 'inherit',
            shell: process.platform === 'win32',
        },
    )
    if (result.error) throw result.error
    if (result.status !== 0) {
        throw new Error(`pnpm ${args.join(' ')} 在 ${directory} 中失败（退出码 ${result.status ?? 'unknown'}）`)
    }
}

function requireArtifact(relativePath) {
    const artifact = join(repositoryRoot, relativePath)
    if (!existsSync(artifact)) throw new Error(`构建产物缺失：${relativePath}`)
}

assertSupportedNode()
process.stdout.write(`[render-build] 使用 Node ${process.versions.node}，前后端分别使用各自冻结锁文件。\n`)

// 前后端保留各自的 pnpm-lock.yaml。NODE_ENV=production 会影响安装选择，
// 因此显式 --prod=false，确保 TypeScript/Vite 等构建期依赖存在。
for (const directory of ['frontend', 'backend']) {
    runPnpm(directory, 'install', '--frozen-lockfile', '--prod=false')
    runPnpm(directory, 'build')
}

requireArtifact(join('frontend', 'dist', 'index.html'))
requireArtifact(join('backend', 'dist', 'server.js'))
process.stdout.write('[render-build] 前端与后端生产构建完成，锁文件均保持冻结。\n')
