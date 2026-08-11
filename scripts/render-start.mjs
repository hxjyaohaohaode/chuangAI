import { existsSync } from 'node:fs'
import { isAbsolute, parse, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repositoryRoot = resolve(import.meta.dirname, '..')
const serverEntry = resolve(repositoryRoot, 'backend', 'dist', 'server.js')
const frontendEntry = resolve(repositoryRoot, 'frontend', 'dist', 'index.html')

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
if (nodeMajor !== 20 || nodeMinor < 19) {
    throw new Error(`运行时要求 Node >=20.19 <21，当前为 ${process.versions.node}`)
}
if (!existsSync(serverEntry) || !existsSync(frontendEntry)) {
    throw new Error('生产构建产物缺失；请先执行 node scripts/render-build.mjs')
}

if (process.env.RENDER === 'true') {
    if (process.env.HOST !== '0.0.0.0') {
        throw new Error('Render Web Service 必须显式配置 HOST=0.0.0.0')
    }
    if (!/^\d{1,5}$/u.test(process.env.PORT ?? '')) {
        throw new Error('Render 必须提供合法的 PORT 环境变量')
    }
    if (!process.env.APP_DATA_DIR || !isAbsolute(process.env.APP_DATA_DIR)) {
        throw new Error('Render 必须把 APP_DATA_DIR 配置为持久盘的绝对挂载路径')
    }
    if (!process.env.SQLITE_PATH || !isAbsolute(process.env.SQLITE_PATH)) {
        throw new Error('Render 必须把 SQLITE_PATH 配置为持久盘内的绝对文件路径')
    }
    const dataDirectory = resolve(process.env.APP_DATA_DIR)
    const databaseFile = resolve(process.env.SQLITE_PATH)
    if (parse(dataDirectory).root === dataDirectory) {
        throw new Error('Render 的 APP_DATA_DIR 不得直接指向文件系统根目录')
    }
    const databaseRelativePath = relative(dataDirectory, databaseFile)
    if (!databaseRelativePath
        || databaseRelativePath === '..'
        || databaseRelativePath.startsWith('../')
        || databaseRelativePath.startsWith('..\\')
        || isAbsolute(databaseRelativePath)) {
        throw new Error('Render 的 SQLITE_PATH 必须严格位于 APP_DATA_DIR 持久盘之内')
    }
}

// 直接在当前 Node 进程加载后端，使 Render 的 SIGTERM 能抵达 Fastify 的优雅关闭钩子。
await import(pathToFileURL(serverEntry).href)
