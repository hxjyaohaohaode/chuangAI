#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { access, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootFiles = [
    '.env.example', '.gitignore', '.nvmrc', '.node-version', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'INSTALL.md',
    'USAGE.md', 'DEVELOPMENT.md', 'PROMPTS.md', 'CHANGELOG.md', 'DEPLOY_RENDER.md', 'docker-compose.yml', 'render.yaml',
]
const treeEntries = [
    'backend/src', 'backend/scripts', 'backend/dist',
    'frontend/src', 'frontend/public', 'frontend/scripts', 'frontend/dist',
    'scripts', '提交材料', 'evidence', 'docs/plans', 'docs/audit',
]
const componentFiles = [
    'backend/package.json', 'backend/pnpm-lock.yaml', 'backend/pnpm-workspace.yaml', 'backend/tsconfig.json',
    'backend/vitest.config.ts', 'backend/nodemon.json',
    'frontend/package.json', 'frontend/pnpm-lock.yaml', 'frontend/pnpm-workspace.yaml', 'frontend/tsconfig.json',
    'frontend/tsconfig.node.json', 'frontend/vite.config.ts', 'frontend/postcss.config.js',
    'frontend/tailwind.config.ts', 'frontend/index.html', 'frontend/e2e-regression.mjs', 'frontend/.npmrc',
]
// graphify-out 是本地代码知识图谱审计产物，不是运行时源码。它可能包含完整
// 内部文件/符号关系且体积很大；发布边界审计同样排除此目录，两道门必须一致。
const excludedDirectorySegments = new Set(['node_modules', 'coverage', 'runtime-temp', 'graphify-out', '__pycache__'])
const forbiddenFile = (name) => name === '.env'
    || (/^\.env\..+/u.test(name) && name !== '.env.example')
    || /\.log$/iu.test(name)
    || /\.(db|db-journal|db-shm|db-wal|sqlite|sqlite3|pem|key|p12|pfx)$/iu.test(name)
    || /\.py[cod]$/iu.test(name)
    || name === 'tsconfig.tsbuildinfo'
const binaryExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.wav', '.mp3', '.mp4', '.woff', '.woff2',
    '.ttf', '.otf', '.pdf', '.docx', '.pptx', '.zip', '.gz',
])
const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\bsk-[A-Za-z0-9_-]{20,}\b/u,
    /\bBearer\s+[A-Za-z0-9._~-]{24,}\b/u,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
]

async function exists(target) {
    try { await access(target); return true } catch { return false }
}

function assertSafeOutput(target) {
    const resolved = path.resolve(target)
    const relativeToRoot = path.relative(root, resolved)
    if (relativeToRoot === '' || (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot))) {
        throw new Error('发布目录必须位于项目目录之外，避免递归复制或污染源码')
    }
    if (!path.basename(resolved).startsWith('poetic-realm-release-')) {
        throw new Error('发布目录名称必须以 poetic-realm-release- 开头')
    }
    return resolved
}

async function validateGates() {
    const [boundary, demoPreflight, imageAssets] = await Promise.all([
        readFile(path.join(root, 'docs/audit/release-boundary-latest.json'), 'utf8').then(JSON.parse),
        readFile(path.join(root, 'docs/audit/competition-preflight-demo-local-latest.json'), 'utf8').then(JSON.parse),
        readFile(path.join(root, 'docs/audit/image-assets-latest.json'), 'utf8').then(JSON.parse),
    ])
    if (!['passed', 'passed_with_local_sensitive_exclusions'].includes(boundary.status)
        || boundary.summary?.releaseSecretFindings !== 0
        || boundary.summary?.links !== 0) {
        throw new Error('发布边界审计未通过，拒绝打包')
    }
    if (demoPreflight.status !== 'passed' || demoPreflight.summary?.failures !== 0) {
        throw new Error('DEMO 赛前预检未通过，拒绝打包')
    }
    const imageAuditAgeMs = imageAssets?.generatedAt
        ? Date.now() - Date.parse(imageAssets.generatedAt)
        : Number.POSITIVE_INFINITY
    if (imageAuditAgeMs < 0 || imageAuditAgeMs > 7 * 86_400_000
        || imageAssets?.gate !== 'PASS'
        || imageAssets?.summary?.blockers !== 0
        || imageAssets?.summary?.curatedReleaseWebp !== 22
        || imageAssets?.summary?.releasedStarmapWebp !== 148
        || imageAssets?.summary?.productionRuntimeStarmapReferences !== 0
        || imageAssets?.summary?.productionSvgReferences !== 0
        || imageAssets?.summary?.releaseContamination !== 0
        || imageAssets?.releaseMapping?.entries?.length !== 148
        || imageAssets?.distParity?.status !== 'passed') {
        throw new Error('图像资产、引用或 dist 发布真实性审计未通过，拒绝打包')
    }
    if (!Array.isArray(imageAssets.trackedInputFiles) || imageAssets.trackedInputFiles.length < 40) {
        throw new Error('图像审计缺少完整输入哈希，拒绝打包')
    }
    for (const input of imageAssets.trackedInputFiles) {
        const source = path.resolve(root, input.path ?? '')
        const relative = path.relative(root, source)
        if (typeof input.path !== 'string'
            || !/^[a-f0-9]{64}$/u.test(input.sha256 ?? '')
            || path.isAbsolute(input.path)
            || relative === ''
            || relative.startsWith('..')
            || path.isAbsolute(relative)
            || !(await exists(source))
            || createHash('sha256').update(await readFile(source)).digest('hex') !== input.sha256) {
            throw new Error(`图像审计后输入已变化，必须重跑审计：${input.path ?? '未知文件'}`)
        }
    }
}

function validatePackagedImages(target) {
    const audit = spawnSync(process.execPath, [
        path.join(root, 'scripts', 'audit-image-assets.mjs'),
        '--root', target,
        '--release-package',
        '--no-write',
    ], { cwd: root, encoding: 'utf8', timeout: 120_000 })
    if (audit.status !== 0) {
        const detail = [audit.stdout, audit.stderr].filter(Boolean).join('\n').trim()
        throw new Error(`发布候选逐图复验失败${detail ? `：\n${detail}` : ''}`)
    }
    if (audit.stdout) process.stdout.write(audit.stdout)
}

async function copyFileChecked(source, destination, manifest) {
    const info = await lstat(source)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`拒绝复制非普通文件：${source}`)
    const name = path.basename(source)
    if (forbiddenFile(name)) return
    const content = await readFile(source)
    if (!binaryExtensions.has(path.extname(name).toLowerCase()) && content.length <= 5 * 1024 * 1024) {
        const text = content.toString('utf8')
        if (secretPatterns.some((pattern) => pattern.test(text))) {
            throw new Error(`发布候选出现疑似密钥：${path.relative(root, source)}`)
        }
    }
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, content, { mode: 0o600 })
    manifest.push({
        path: path.relative(path.dirname(destination), destination),
        sourcePath: path.relative(root, source).replaceAll('\\', '/'),
        bytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
    })
}

async function copyTree(sourceRoot, destinationRoot, manifest) {
    const visit = async (sourceDirectory, destinationDirectory) => {
        const directoryInfo = await lstat(sourceDirectory)
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error(`拒绝遍历链接目录：${sourceDirectory}`)
        await mkdir(destinationDirectory, { recursive: true })
        for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
            if (excludedDirectorySegments.has(entry.name) || forbiddenFile(entry.name)) continue
            const source = path.join(sourceDirectory, entry.name)
            const destination = path.join(destinationDirectory, entry.name)
            const info = await lstat(source)
            if (info.isSymbolicLink()) throw new Error(`发布树存在链接：${source}`)
            if (info.isDirectory()) await visit(source, destination)
            else if (info.isFile()) await copyFileChecked(source, destination, manifest)
        }
    }
    await visit(sourceRoot, destinationRoot)
}

async function removeOwnedTemporary(target) {
    const resolved = path.resolve(target)
    const name = path.basename(resolved)
    if (!name.startsWith('poetic-realm-release-verify-') && !name.includes('.partial-')) {
        throw new Error(`拒绝清理非本工具临时目录：${resolved}`)
    }
    const info = await lstat(resolved)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`拒绝清理非普通目录：${resolved}`)
    await rm(resolved, { recursive: true })
}

async function assemble(target) {
    const manifest = []
    await mkdir(target, { recursive: false, mode: 0o700 })
    for (const relativePath of [...rootFiles, ...componentFiles]) {
        const source = path.join(root, relativePath)
        if (!(await exists(source))) throw new Error(`发布必需文件缺失：${relativePath}`)
        await copyFileChecked(source, path.join(target, relativePath), manifest)
    }
    for (const relativePath of treeEntries) {
        const source = path.join(root, relativePath)
        if (!(await exists(source))) throw new Error(`发布必需目录缺失：${relativePath}`)
        await copyTree(source, path.join(target, relativePath), manifest)
    }
    validatePackagedImages(target)
    const normalizedManifest = manifest
        .map(({ sourcePath, bytes, sha256 }) => ({ path: sourcePath, bytes, sha256 }))
        .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
    const forbiddenManifestEntry = normalizedManifest.find(({ path: manifestPath }) =>
        manifestPath.split('/').some((segment) => excludedDirectorySegments.has(segment))
        || forbiddenFile(path.basename(manifestPath)),
    )
    if (forbiddenManifestEntry) {
        throw new Error(`发布清单包含禁止路径：${forbiddenManifestEntry.path}`)
    }
    await writeFile(path.join(target, 'RELEASE-MANIFEST.sha256.json'), `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        fileCount: normalizedManifest.length,
        files: normalizedManifest,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return normalizedManifest.length
}

async function main() {
    const verifyOnly = process.argv.includes('--verify-only')
    const outIndex = process.argv.indexOf('--out')
    if (!verifyOnly && (outIndex < 0 || !process.argv[outIndex + 1])) {
        throw new Error('用法：node scripts/prepare-competition-release.mjs --out <poetic-realm-release-...> 或 --verify-only')
    }
    await validateGates()
    if (verifyOnly) {
        const temporary = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), 'poetic-realm-release-verify-')))
        try {
            const fileCount = await assemble(path.join(temporary, 'poetic-realm-release-verify-package'))
            console.log(`Release verification passed: ${fileCount} files; temporary package will be removed`)
        } finally {
            await removeOwnedTemporary(temporary)
        }
        return
    }
    const output = assertSafeOutput(process.argv[outIndex + 1])
    if (await exists(output)) throw new Error('目标发布目录已存在，拒绝覆盖')
    const partial = `${output}.partial-${process.pid}`
    if (await exists(partial)) throw new Error('临时发布目录已存在，拒绝继续')
    try {
        const fileCount = await assemble(partial)
        await rename(partial, output)
        console.log(`Competition release prepared: ${output}; files=${fileCount}`)
    } catch (error) {
        let cleanupError = null
        if (await exists(partial)) {
            try {
                await removeOwnedTemporary(partial)
            } catch (caughtCleanupError) {
                cleanupError = caughtCleanupError
            }
        }
        if (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                `发布失败且临时目录清理失败：primary=${error instanceof Error ? error.message : String(error)}；cleanup=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            )
        }
        throw error
    }
}

main().catch((error) => {
    console.error(`Competition release failed: ${error.message}`)
    process.exitCode = 1
})
