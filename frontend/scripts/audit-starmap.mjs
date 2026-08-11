const endpoint = process.env.STARMAP_AUDIT_URL
    ?? 'http://localhost:3001/api/knowledge-graph/full'
const timeoutMs = Number.parseInt(process.env.STARMAP_AUDIT_TIMEOUT_MS ?? '10000', 10)

async function acquireAuditCookie() {
    if (process.env.STARMAP_AUDIT_AUTH_COOKIE) return process.env.STARMAP_AUDIT_AUTH_COOKIE
    const origin = new URL(endpoint).origin
    const login = await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacherId: 'teacher-001', name: '王雅琴' }),
        signal: AbortSignal.timeout(Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : 10_000),
    })
    if (login.status !== 200) {
        throw new Error(`无法为星图审计建立演示会话：HTTP ${login.status}；密码部署请传入 STARMAP_AUDIT_AUTH_COOKIE`)
    }
    const setCookies = typeof login.headers.getSetCookie === 'function'
        ? login.headers.getSetCookie()
        : [login.headers.get('set-cookie') ?? '']
    const pairs = setCookies
        .flatMap((value) => [...value.matchAll(/\b(pr_(?:session|csrf)=[^;,]+)/gu)].map((match) => match[1]))
        .filter(Boolean)
    if (pairs.length !== 2) throw new Error('星图审计登录响应缺少完整会话 Cookie')
    return pairs.join('; ')
}

let response
try {
    const cookie = await acquireAuditCookie()
    response = await fetch(endpoint, {
        headers: { cookie },
        signal: AbortSignal.timeout(Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : 10_000),
    })
} catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`星图接口审计无法连接 ${endpoint}：请先启动回环后端，或设置 STARMAP_AUDIT_URL；详情：${detail}`)
}
if (!response.ok) {
    throw new Error(`星图接口审计失败：HTTP ${response.status} ${response.statusText}`)
}

const graph = await response.json()
const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
const edges = Array.isArray(graph.edges) ? graph.edges : []
const ids = new Set(nodes.map((node) => node.id))
const duplicateNodeIds = [...nodes.reduce((counts, node) => {
    counts.set(node.id, (counts.get(node.id) ?? 0) + 1)
    return counts
}, new Map())].filter(([, count]) => count > 1)
const duplicateEdges = [...edges.reduce((counts, edge) => {
    const key = `${edge.source}|${edge.target}|${edge.type}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return counts
}, new Map())].filter(([, count]) => count > 1)
const danglingEdges = edges.filter((edge) => !ids.has(edge.source) || !ids.has(edge.target))
const countsByType = Object.fromEntries(
    [...nodes.reduce((counts, node) => {
        counts.set(node.type, (counts.get(node.type) ?? 0) + 1)
        return counts
    }, new Map())].sort(([a], [b]) => String(a).localeCompare(String(b))),
)

const failures = []
if (countsByType.Poem !== 148) failures.push(`诗篇应为 148，实际 ${countsByType.Poem ?? 0}`)
if (countsByType.Poet !== 63) failures.push(`诗人应为 63，实际 ${countsByType.Poet ?? 0}`)
if (duplicateNodeIds.length) failures.push(`存在 ${duplicateNodeIds.length} 组重复节点 ID`)
if (duplicateEdges.length) failures.push(`存在 ${duplicateEdges.length} 组重复关系`)
if (danglingEdges.length) failures.push(`存在 ${danglingEdges.length} 条悬空关系`)

console.log(JSON.stringify({
    endpoint,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    countsByType,
    duplicateNodeIds: duplicateNodeIds.length,
    duplicateEdges: duplicateEdges.length,
    danglingEdges: danglingEdges.length,
}, null, 2))

if (failures.length) {
    throw new Error(`星图数据未对齐：\n- ${failures.join('\n- ')}`)
}

console.log('PASS 诗脉星图数据完整性审计通过')
