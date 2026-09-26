/**
 * 全路由破坏性冒烟
 *
 * 从源码提取 Fastify 静态路由声明，在隔离数据库服务上发送缺参数、空请求体
 * 和不存在资源 ID。目标不是要求业务成功，而是证明所有失败都被收敛为受控
 * 4xx/明确降级，不能出现 5xx、超时或服务端栈泄露。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const BASE_URL = process.env.ROUTE_SMOKE_BASE_URL ?? 'http://127.0.0.1:3002'
const ROOT = path.resolve('src', 'routes')
const OUTPUT = path.resolve('..', 'docs', 'audit', 'route-smoke-latest.json')
const TIMEOUT_MS = Number(process.env.ROUTE_SMOKE_TIMEOUT_MS ?? 20_000)
const AUTH_COOKIE = process.env.ROUTE_SMOKE_AUTH_COOKIE ?? ''
const CSRF_TOKEN = process.env.ROUTE_SMOKE_CSRF_TOKEN ?? ''
const ROUTE_PATTERN = /app\.(get|post|put|patch|delete)(?:<[^\n]+>)?\s*\(\s*(['"])([^'"]+)\2/g

const MODULE_PREFIXES = {
    'health.ts': '/api',
    'dashboard.ts': '/api/dashboard',
    'classroom.ts': '/api/classroom',
    'grading.ts': '/api/grading',
    'workbench.ts': '/api/workbench',
    'copilot.ts': '/api/copilot',
    'report.ts': '/api/report',
    'report-sharing.ts': '/api/report',
    'recitation.ts': '/api/recitation',
    'diagnosis.ts': '/api/diagnosis',
    'creation.ts': '/api/creation',
    'culture.ts': '/api/culture',
    'knowledge-graph.ts': '/api/knowledge-graph',
    'appreciation.ts': '/api/appreciation',
    'lesson-plan.ts': '/api/lesson-plan',
    'illustration.ts': '/api/illustration',
    'settings.ts': '/api/settings',
    'poem-content.ts': '/api/poem-content',
    'students.ts': '/api/students',
    'lesson-plan-templates.ts': '/api/lesson-plans',
    'error-notebook.ts': '/api/error-notebook',
    'evolution.ts': '/api/evolution',
    'ai.ts': '/api/ai',
}

const PARAM_VALUES = {
    joinCode: 'AUD1T0',
    providerId: 'audit-invalid-provider',
    id: 'audit-invalid-id',
}

function joinUrl(prefix, routePath) {
    const joined = `${prefix}/${routePath}`.replaceAll(/\/+/g, '/')
    return joined === '' ? '/' : joined
}

function materialize(routePath) {
    return routePath.replaceAll(/:([A-Za-z0-9_]+)/g, (_match, name) => (
        encodeURIComponent(PARAM_VALUES[name] ?? `audit-invalid-${name}`)
    ))
}

async function extractRoutes() {
    const routes = []
    for (const [fileName, prefix] of Object.entries(MODULE_PREFIXES)) {
        const source = await fs.readFile(path.join(ROOT, fileName), 'utf8')
        for (const match of source.matchAll(ROUTE_PATTERN)) {
            routes.push({
                file: fileName,
                method: match[1].toUpperCase(),
                declaredPath: match[3],
                path: joinUrl(prefix, materialize(match[3])),
            })
        }
    }

    // 同一 workbench.ts 还以 /api/agents 注册 agentOrchestrateRoutes。
    // 该声明在源码中会被上面的模块级提取归到 /api/workbench，显式补正。
    const workbenchSource = await fs.readFile(path.join(ROOT, 'workbench.ts'), 'utf8')
    const agentExportAt = workbenchSource.indexOf('export const agentOrchestrateRoutes')
    if (agentExportAt >= 0) {
        const agentSource = workbenchSource.slice(agentExportAt)
        for (const match of agentSource.matchAll(ROUTE_PATTERN)) {
            routes.push({
                file: 'workbench.ts#agentOrchestrateRoutes',
                method: match[1].toUpperCase(),
                declaredPath: match[3],
                path: joinUrl('/api/agents', materialize(match[3])),
            })
        }
    }

    // 编排官 REST 路由位于 src/orchestrator，而非 src/routes；同样纳入全量 HTTP 冒烟。
    const orchestratorSource = await fs.readFile(path.resolve('src', 'orchestrator', 'routes.ts'), 'utf8')
    for (const match of orchestratorSource.matchAll(ROUTE_PATTERN)) {
        routes.push({
            file: 'orchestrator/routes.ts',
            method: match[1].toUpperCase(),
            declaredPath: match[3],
            path: joinUrl('/api/orchestrator', materialize(match[3])),
        })
    }

    const unique = new Map()
    for (const route of routes) {
        // agentOrchestrateRoutes 的声明先被误归入 /api/workbench，剔除该重复错误路径。
        if (
            route.file === 'workbench.ts' &&
            agentExportAt >= 0 &&
            route.declaredPath === '/orchestrate'
        ) continue
        unique.set(`${route.method} ${route.path}`, route)
    }
    return [...unique.values()].sort((a, b) => (
        a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
    ))
}

async function probe(route) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const startedAt = Date.now()
    try {
        const mutating = route.method !== 'GET'
        const headers = {
            accept: 'application/json',
            cookie: AUTH_COOKIE,
            ...(mutating ? {
                'content-type': 'application/json',
                'x-csrf-token': CSRF_TOKEN,
            } : {}),
        }
        const response = await fetch(`${BASE_URL}${route.path}`, {
            method: route.method,
            headers,
            body: mutating ? '{}' : undefined,
            signal: controller.signal,
        })
        const text = await response.text()
        const leakedStack = /\n\s+at\s+.+\(.+:\d+:\d+\)/.test(text) ||
            text.includes('node_modules') ||
            text.includes('SqliteError:')
        return {
            ...route,
            status: response.status,
            durationMs: Date.now() - startedAt,
            leakedStack,
            failed: response.status >= 500 || leakedStack,
            responsePreview: text.slice(0, 240),
        }
    } catch (error) {
        return {
            ...route,
            status: null,
            durationMs: Date.now() - startedAt,
            leakedStack: false,
            failed: true,
            error: error instanceof Error ? error.message : String(error),
        }
    } finally {
        clearTimeout(timer)
    }
}

async function main() {
    if (!AUTH_COOKIE || !CSRF_TOKEN) {
        throw new Error('路由冒烟缺少真实认证会话，拒绝用统一 401 掩盖业务路由语义')
    }
    const routes = await extractRoutes()
    const results = []
    // 有意串行：避免 AI/SQLite 路由并发导致资源竞争，从而把压测噪声混入契约冒烟。
    for (const route of routes) {
        results.push(await probe(route))
    }
    const failures = results.filter((result) => result.failed)
    const evidence = {
        generatedAt: new Date().toISOString(),
        baseUrl: BASE_URL,
        authentication: 'signed-session-with-csrf',
        timeoutMs: TIMEOUT_MS,
        routeCount: routes.length,
        passedCount: results.length - failures.length,
        failedCount: failures.length,
        failures,
        results,
    }
    await fs.mkdir(path.dirname(OUTPUT), { recursive: true })
    await fs.writeFile(OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    console.log(`破坏性路由冒烟：${routes.length} 条；失败：${failures.length}`)
    console.log(`证据：${OUTPUT}`)
    if (failures.length > 0) {
        for (const failure of failures) {
            console.error(`- ${failure.method} ${failure.path}: ${failure.status ?? failure.error}`)
        }
        process.exitCode = 1
    }
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
