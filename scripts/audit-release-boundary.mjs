#!/usr/bin/env node

import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const excludedDirectoryNames = new Set(['.git', 'node_modules', 'coverage', 'audit-artifacts', 'graphify-out'])
const excludedRelativeDirectories = [
    'data',
    'backend/data',
    'docs/audit/runtime-temp',
    'e2e-screenshots',
    'frontend/e2e-screenshots',
    'static/audio',
]
const binaryExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.wav', '.mp3', '.mp4', '.woff', '.woff2',
    '.ttf', '.otf', '.db', '.sqlite', '.sqlite3', '.zip', '.gz', '.pdf', '.docx', '.pptx', '.exe', '.dll',
])
const secretDetectors = [
    { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu },
    { id: 'provider-api-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
    { id: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~-]{24,}\b/gu },
    { id: 'jwt-token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu },
    { id: 'cloud-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
]

function relative(absolute) {
    return path.relative(root, absolute).replaceAll('\\', '/')
}

function isUnderExcludedDirectory(relativePath) {
    const segments = relativePath.split('/')
    return segments.some((segment) => excludedDirectoryNames.has(segment))
        || excludedRelativeDirectories.some((directory) => relativePath === directory || relativePath.startsWith(`${directory}/`))
}

function classifyPrivateFile(relativePath) {
    const name = path.basename(relativePath)
    if ((name === '.env' || /^\.env\..+/u.test(name)) && name !== '.env.example') return 'environment-secret-file'
    if (/\.log$/iu.test(name)) return 'runtime-log'
    if (/\.(db|db-journal|db-shm|db-wal|sqlite|sqlite3)$/iu.test(name)) return 'runtime-database'
    if (/\.(pem|key|p12|pfx)$/iu.test(name)) return 'private-key-material'
    return null
}

function scanText(text, relativePath, scope) {
    const findings = []
    for (const detector of secretDetectors) {
        detector.pattern.lastIndex = 0
        for (const match of text.matchAll(detector.pattern)) {
            const line = text.slice(0, match.index).split('\n').length
            findings.push({ path: relativePath, line, detector: detector.id, scope })
        }
    }
    return findings
}

async function walk() {
    const releaseCandidates = []
    const privateFiles = []
    const links = []
    const releaseFindings = []
    const localSensitiveFindings = []
    const visit = async (directory) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name)
            const relativePath = relative(absolute)
            if (isUnderExcludedDirectory(relativePath)) continue
            const info = await lstat(absolute)
            if (info.isSymbolicLink()) {
                links.push(relativePath)
                continue
            }
            if (info.isDirectory()) {
                await visit(absolute)
                continue
            }
            if (!info.isFile()) continue
            const privateReason = classifyPrivateFile(relativePath)
            const extension = path.extname(entry.name).toLowerCase()
            if (privateReason) privateFiles.push({ path: relativePath, reason: privateReason, bytes: info.size })
            else releaseCandidates.push({ path: relativePath, bytes: info.size })
            if (binaryExtensions.has(extension) || info.size > 5 * 1024 * 1024) continue
            const text = await readFile(absolute, 'utf8')
            const findings = scanText(text, relativePath, privateReason ? 'LOCAL_EXCLUDED' : 'RELEASE_CANDIDATE')
            if (privateReason) localSensitiveFindings.push(...findings)
            else releaseFindings.push(...findings)
        }
    }
    await visit(root)
    return { releaseCandidates, privateFiles, links, releaseFindings, localSensitiveFindings }
}

function renderMarkdown(report) {
    const lines = [
        '# 发布边界与敏感文件审计',
        '',
        `- 状态：**${report.status}**`,
        `- 可进入发布候选：${report.summary.releaseCandidateFiles} 个文件`,
        `- 必须排除：${report.summary.privateFiles} 个文件`,
        `- 发布候选密钥命中：${report.summary.releaseSecretFindings}`,
        `- 本地排除文件中的敏感命中：${report.summary.localSensitiveFindings}`,
        `- 符号链接/重解析链接：${report.summary.links}`,
        '',
        '> 本报告只记录文件路径、行号和检测器名称，绝不写出密钥值。被排除的本地 `.env`、日志和数据库可以用于开发，但不得复制进参赛包或开源包。',
        '',
        '## 发布候选命中',
        '',
        ...(report.releaseSecretFindings.length > 0
            ? report.releaseSecretFindings.map((item) => `- ${item.path}:${item.line} — ${item.detector}`)
            : ['- 无']),
        '',
        '## 必须排除的本地文件',
        '',
        ...report.privateFiles.map((item) => `- ${item.path} — ${item.reason} — ${item.bytes}B`),
        '',
    ]
    return `${lines.join('\n')}\n`
}

async function atomicWrite(target, content) {
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
}

async function main() {
    const data = await walk()
    const status = data.releaseFindings.length > 0 || data.links.length > 0
        ? 'failed'
        : data.localSensitiveFindings.length > 0 ? 'passed_with_local_sensitive_exclusions' : 'passed'
    const report = {
        generatedAt: new Date().toISOString(),
        status,
        summary: {
            releaseCandidateFiles: data.releaseCandidates.length,
            privateFiles: data.privateFiles.length,
            releaseSecretFindings: data.releaseFindings.length,
            localSensitiveFindings: data.localSensitiveFindings.length,
            links: data.links.length,
        },
        excludedDirectories: [...excludedDirectoryNames, ...excludedRelativeDirectories],
        releaseSecretFindings: data.releaseFindings,
        localSensitiveFindings: data.localSensitiveFindings,
        privateFiles: data.privateFiles,
        links: data.links,
    }
    await Promise.all([
        atomicWrite(path.join(root, 'docs', 'audit', 'release-boundary-latest.json'), `${JSON.stringify(report, null, 2)}\n`),
        atomicWrite(path.join(root, 'docs', 'audit', 'release-boundary-latest.md'), renderMarkdown(report)),
    ])
    console.log(`Release boundary: ${status}; candidateSecrets=${data.releaseFindings.length}; localSensitive=${data.localSensitiveFindings.length}; privateFiles=${data.privateFiles.length}; links=${data.links.length}`)
    process.exitCode = status === 'failed' ? 1 : 0
}

main().catch((error) => {
    console.error(`Release boundary audit failed: ${error.message}`)
    process.exitCode = 1
})
