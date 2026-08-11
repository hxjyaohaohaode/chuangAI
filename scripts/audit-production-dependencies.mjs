#!/usr/bin/env node

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const officialRegistry = 'https://registry.npmjs.org/'
const acceptedConditionalAdvisories = new Map([
    ['GHSA-qwww-vcr4-c8h2', {
        condition: '仅影响 React Router unstable RSC API；本项目为 Vite SPA，且源码不得出现 RSC API 标记。',
        patterns: [
            /unstable_.*RSC/u,
            /RSCRouter/u,
            /RSCStaticRouter/u,
            /createFromReadableStream/u,
            /decodeReply/u,
            /react-server-dom/u,
        ],
    }],
])

function runPnpm(cwd, args) {
    return process.platform === 'win32'
        ? spawnSync(process.execPath, [
            path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js'),
            ...args,
        ], { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
        : spawnSync('corepack', args, { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
}

function runPnpmAudit(area) {
    const result = runPnpm(path.join(root, area), [
        'pnpm', 'audit', '--prod', '--json', `--registry=${officialRegistry}`,
    ])
    let body
    try {
        body = JSON.parse(result.stdout)
    } catch {
        throw new Error(`${area} 依赖审计无法解析：exit=${result.status}; ${result.stderr.trim() || '无错误详情'}`)
    }
    if (body.error) throw new Error(`${area} 依赖审计端点错误：${body.error.code ?? 'UNKNOWN'}`)
    return body
}

/**
 * 安全公告中的 patched_versions 是上游建议，不等于该版本（或满足范围的任意版本）
 * 已经在官方 registry 发布。不能向赛场交付说明中写一个不可安装的“修复方案”。
 *
 * npm/pnpm 自己处理 semver 范围，避免在审计器中重新实现不完整的范围解析；命令参数
 * 以数组传递，不经 shell 拼接。网络失败保持 unknown，而非误判为未发布。
 */
export function resolvePatchedRangeAvailability(moduleName, patchedVersions) {
    if (typeof moduleName !== 'string' || !moduleName.trim() || typeof patchedVersions !== 'string' || !patchedVersions.trim()) {
        return {
            status: 'unknown',
            requestedRange: patchedVersions ?? null,
            resolvedVersion: null,
            rationale: '公告未提供可查询的包名或修复版本范围。',
        }
    }

    const requestedRange = patchedVersions.trim()
    const result = runPnpm(root, [
        'pnpm', 'view', `${moduleName}@${requestedRange}`, 'version', '--json', `--registry=${officialRegistry}`,
    ])
    if (result.status === 0) {
        try {
            const parsed = JSON.parse(result.stdout)
            const resolvedVersion = Array.isArray(parsed) ? parsed.at(-1) : parsed
            if (typeof resolvedVersion === 'string' && resolvedVersion.trim()) {
                return {
                    status: 'available',
                    requestedRange,
                    resolvedVersion,
                    rationale: `官方 registry 可解析满足 ${requestedRange} 的 ${resolvedVersion}。`,
                }
            }
        } catch {
            // 命令成功但响应不符合 pnpm JSON 约定时，保守地留下可复审状态。
        }
        return {
            status: 'unknown',
            requestedRange,
            resolvedVersion: null,
            rationale: '官方 registry 查询成功但未返回可解析版本。',
        }
    }

    const diagnostic = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim()
    if (/ERR_PNPM_PACKAGE_NOT_FOUND|No matching version found|E404/iu.test(diagnostic)) {
        return {
            status: 'not_published',
            requestedRange,
            resolvedVersion: null,
            rationale: `官方 registry 当前没有可解析的 ${moduleName}@${requestedRange}。`,
        }
    }
    return {
        status: 'unknown',
        requestedRange,
        resolvedVersion: null,
        rationale: `官方 registry 修复范围查询失败，保留待人工复审：${diagnostic.slice(0, 240) || `exit=${result.status}`}`,
    }
}

async function collectFrontendSource() {
    const chunks = []
    const walk = async (directory) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name)
            if (entry.isDirectory()) await walk(absolute)
            else if (/\.(ts|tsx|js|jsx|json)$/u.test(entry.name)) chunks.push(await readFile(absolute, 'utf8'))
        }
    }
    await walk(path.join(root, 'frontend', 'src'))
    chunks.push(await readFile(path.join(root, 'frontend', 'package.json'), 'utf8'))
    return chunks.join('\n')
}

function normalizeAdvisories(area, audit, frontendSource) {
    return Object.values(audit.advisories ?? {}).map((advisory) => {
        const accepted = acceptedConditionalAdvisories.get(advisory.github_advisory_id)
        const conditionTriggered = accepted
            ? accepted.patterns.some((pattern) => pattern.test(frontendSource))
            : false
        const disposition = accepted && area === 'frontend' && !conditionTriggered
            ? 'NOT_APPLICABLE_CURRENT_ARCHITECTURE'
            : 'ACTION_REQUIRED'
        const patchAvailability = resolvePatchedRangeAvailability(advisory.module_name, advisory.patched_versions)
        const architectureRationale = disposition === 'NOT_APPLICABLE_CURRENT_ARCHITECTURE'
            ? accepted.condition
            : null
        return {
            area,
            id: advisory.github_advisory_id ?? String(advisory.id),
            title: advisory.title,
            module: advisory.module_name,
            severity: advisory.severity,
            vulnerableVersions: advisory.vulnerable_versions,
            patchedVersions: advisory.patched_versions,
            installedPaths: (advisory.findings ?? []).flatMap((finding) => finding.paths ?? []),
            url: advisory.url,
            disposition,
            rationale: architectureRationale
                ? `${architectureRationale} ${patchAvailability.rationale}`
                : null,
            patchAvailability,
        }
    })
}

function renderMarkdown(report) {
    const lines = [
        '# 生产依赖安全审计',
        '',
        `- 状态：**${report.status}**`,
        `- 查询时间：${report.generatedAt}`,
        `- 公告源：${report.registry}`,
        `- 后端生产漏洞：${report.metadata.backend.totalVulnerabilities}`,
        `- 前端生产漏洞：${report.metadata.frontend.totalVulnerabilities}`,
        `- 需修复：${report.summary.actionRequired}`,
        `- 条件不适用但继续跟踪：${report.summary.conditionallyNotApplicable}`,
        '',
        '> “条件不适用”不是删除公告：只要架构开始使用对应 API、上游发布可用修复版或公告范围变化，门禁应重新判定。审计器会实际查询公告的修复范围是否可由官方 registry 解析，避免把尚未发布的版本写成可执行升级方案。',
        '',
        '## 明细',
        '',
        '| 区域 | 公告 | 严重度 | 包 | 判定 | 修复范围可用性 | 依据 |',
        '|---|---|---|---|---|---|---|',
        ...report.advisories.map((item) => `| ${item.area} | [${item.id}](${item.url}) | ${item.severity} | ${item.module} | ${item.disposition} | ${item.patchAvailability.status}: ${item.patchAvailability.requestedRange ?? '未提供'}${item.patchAvailability.resolvedVersion ? ` → ${item.patchAvailability.resolvedVersion}` : ''} | ${item.rationale ?? item.patchAvailability.rationale ?? '需要升级、移除或隔离'} |`),
        '',
    ]
    if (report.advisories.length === 0) lines.push('当前官方 registry 未返回生产依赖公告。', '')
    return `${lines.join('\n')}\n`
}

async function atomicWrite(target, content) {
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
}

async function main() {
    const frontendSource = await collectFrontendSource()
    const [backendAudit, frontendAudit] = [runPnpmAudit('backend'), runPnpmAudit('frontend')]
    const advisories = [
        ...normalizeAdvisories('backend', backendAudit, frontendSource),
        ...normalizeAdvisories('frontend', frontendAudit, frontendSource),
    ]
    const actionRequired = advisories.filter((item) => item.disposition === 'ACTION_REQUIRED').length
    const conditionallyNotApplicable = advisories.length - actionRequired
    const report = {
        generatedAt: new Date().toISOString(),
        registry: officialRegistry,
        status: actionRequired > 0 ? 'failed' : conditionallyNotApplicable > 0 ? 'passed_with_mitigations' : 'passed',
        summary: { actionRequired, conditionallyNotApplicable, totalAdvisories: advisories.length },
        metadata: {
            backend: {
                totalDependencies: backendAudit.metadata?.totalDependencies ?? null,
                totalVulnerabilities: Object.values(backendAudit.metadata?.vulnerabilities ?? {}).reduce((sum, value) => sum + value, 0),
            },
            frontend: {
                totalDependencies: frontendAudit.metadata?.totalDependencies ?? null,
                totalVulnerabilities: Object.values(frontendAudit.metadata?.vulnerabilities ?? {}).reduce((sum, value) => sum + value, 0),
            },
        },
        advisories,
    }
    await Promise.all([
        atomicWrite(path.join(root, 'docs', 'audit', 'dependency-security-latest.json'), `${JSON.stringify(report, null, 2)}\n`),
        atomicWrite(path.join(root, 'docs', 'audit', 'dependency-security-latest.md'), renderMarkdown(report)),
    ])
    console.log(`Dependency security: ${report.status}; actionRequired=${actionRequired}; mitigated=${conditionallyNotApplicable}`)
    process.exitCode = actionRequired > 0 ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`Dependency security audit failed: ${error.message}`)
        process.exitCode = 1
    })
}
