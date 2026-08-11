import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { gzipSync } from 'node:zlib'

const BUDGET_BYTES = 120_000
// 以下是教师显式进入能力后才下载的延迟 chunk；它们不能进入首屏 preload，
// 也不能因为“按需加载”而逃逸性能预算。以 gzip 作为跨平台可比口径。
const DEFERRED_CHUNK_BUDGETS = [
    { label: '可选 Three.js 3D 运行时', pattern: /^three-vendor-.*\.js$/u, budgetBytes: 240_000 },
    { label: '富 Markdown 渲染器', pattern: /^Markdown-.*\.js$/u, budgetBytes: 110_000 },
]
const frontendRoot = path.resolve(import.meta.dirname, '..')
const distRoot = path.join(frontendRoot, 'dist')
const indexPath = path.join(distRoot, 'index.html')
const reportRoot = path.resolve(frontendRoot, '..', 'docs', 'audit')

if (!fs.existsSync(indexPath)) {
    throw new Error(`未找到 ${indexPath}；请先执行 npm run build`)
}

const html = fs.readFileSync(indexPath, 'utf8')
const staticJsRefs = [
    ...Array.from(html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+\.js)["'][^>]*>/g), (m) => m[1]),
    ...Array.from(html.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+\.js)["'][^>]*>/g), (m) => m[1]),
]

const uniqueRefs = [...new Set(staticJsRefs)]
if (uniqueRefs.length === 0) throw new Error('index.html 未发现静态 module JS，无法验证首包')

const files = uniqueRefs.map((ref) => {
    const relativePath = ref.replace(/^\//, '')
    const absolutePath = path.join(distRoot, relativePath)
    if (!fs.existsSync(absolutePath)) throw new Error(`index.html 引用的文件不存在：${ref}`)
    const content = fs.readFileSync(absolutePath)
    return {
        ref,
        rawBytes: content.length,
        gzipBytes: gzipSync(content, { level: 9 }).length,
    }
})

const gzipBytes = files.reduce((sum, file) => sum + file.gzipBytes, 0)
const forbiddenPreloads = uniqueRefs.filter((ref) =>
    /(?:query-vendor|icons-extended|three-vendor|gsap-vendor|Markdown)-/.test(ref),
)
// DEV 路由即使在 JSX 中被常量折叠，若动态 import 定义在守卫外仍会生成 chunk。
// 正式产物不得携带开发展厅/剧本矩阵源码，避免隐藏调试面和无谓分发。
const assetRoot = path.join(distRoot, 'assets')
const forbiddenProductionArtifacts = fs.existsSync(assetRoot)
    ? fs.readdirSync(assetRoot).filter((name) => /^(?:VisualShowcase|ScriptsPage)-/u.test(name))
    : []
const deferredChunks = fs.existsSync(assetRoot)
    ? DEFERRED_CHUNK_BUDGETS.flatMap((budget) => fs.readdirSync(assetRoot)
        .filter((name) => budget.pattern.test(name))
        .map((name) => {
            const content = fs.readFileSync(path.join(assetRoot, name))
            const gzipBytes = gzipSync(content, { level: 9 }).length
            return {
                label: budget.label,
                file: name,
                rawBytes: content.length,
                gzipBytes,
                budgetBytes: budget.budgetBytes,
                headroomBytes: budget.budgetBytes - gzipBytes,
                pass: gzipBytes <= budget.budgetBytes,
            }
        }))
    : []
const deferredChunkViolations = deferredChunks.filter((chunk) => !chunk.pass)
const pass = gzipBytes <= BUDGET_BYTES
    && forbiddenPreloads.length === 0
    && forbiddenProductionArtifacts.length === 0
    && deferredChunkViolations.length === 0
const result = {
    generatedAt: new Date().toISOString(),
    measurement: 'dist/index.html 中 module script 与 modulepreload 的真实文件，逐文件 gzip level 9 后求和',
    budgetBytes: BUDGET_BYTES,
    gzipBytes,
    gzipKBDecimal: Number((gzipBytes / 1000).toFixed(3)),
    gzipKiB: Number((gzipBytes / 1024).toFixed(3)),
    headroomBytes: BUDGET_BYTES - gzipBytes,
    forbiddenPreloads,
    forbiddenProductionArtifacts,
    deferredChunks,
    deferredChunkViolations,
    files,
    pass,
}

fs.mkdirSync(reportRoot, { recursive: true })
fs.writeFileSync(
    path.join(reportRoot, 'frontend-bundle-budget-latest.json'),
    `${JSON.stringify(result, null, 2)}\n`,
)

const rows = files
    .map((file) => `| \`${file.ref}\` | ${(file.rawBytes / 1000).toFixed(2)} | ${(file.gzipBytes / 1000).toFixed(2)} |`)
    .join('\n')
const deferredRows = deferredChunks.length
    ? deferredChunks
        .map((chunk) => `| ${chunk.label} | \`${chunk.file}\` | ${(chunk.gzipBytes / 1000).toFixed(3)} | ${(chunk.budgetBytes / 1000).toFixed(3)} | ${chunk.pass ? '通过' : '失败'} |`)
        .join('\n')
    : '| 无匹配的延迟 chunk | — | — | — | 通过 |'
const markdown = `# 前端首包 JS 预算审计\n\n- 结论：**${pass ? '通过' : '失败'}**\n- 预算：${(BUDGET_BYTES / 1000).toFixed(2)} KB gzip（十进制，严格于 120 KiB）\n- 实测：${(gzipBytes / 1000).toFixed(3)} KB gzip\n- 余量：${((BUDGET_BYTES - gzipBytes) / 1000).toFixed(3)} KB\n- 口径：${result.measurement}\n- 禁止首屏预载的重依赖：${forbiddenPreloads.length ? forbiddenPreloads.join('、') : '无'}\n- 禁止进入生产包的开发资源：${forbiddenProductionArtifacts.length ? forbiddenProductionArtifacts.join('、') : '无'}\n\n| 静态 JS | 原始 KB | gzip KB |\n|---|---:|---:|\n${rows}\n`
    + `\n| 延迟能力 | 文件 | gzip KB | 预算 KB | 结论 |\n|---|---|---:|---:|---|\n${deferredRows}\n`
fs.writeFileSync(path.join(reportRoot, 'frontend-bundle-budget-latest.md'), markdown)

console.log(JSON.stringify(result, null, 2))
if (!pass) process.exitCode = 1
