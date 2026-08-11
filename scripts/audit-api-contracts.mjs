import { createRequire } from 'node:module'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const require = createRequire(import.meta.url)
const ts = require(path.join(projectRoot, 'frontend', 'node_modules', 'typescript', 'lib', 'typescript.js'))

const inventoryPath = path.join(projectRoot, 'docs', 'audit', '2026-08-01-source-inventory.json')
const frontendSourceRoot = path.join(projectRoot, 'frontend', 'src')
const outputJsonPath = path.join(projectRoot, 'docs', 'audit', 'api-contract-latest.json')
const outputMarkdownPath = path.join(projectRoot, 'docs', 'audit', 'api-contract-latest.md')

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function renderPath(node, sourceFile) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = renderPath(node.left, sourceFile)
    const right = renderPath(node.right, sourceFile)
    return left === null || right === null ? null : `${left}${right}`
  }
  if (!ts.isTemplateExpression(node)) return null

  let output = node.head.text
  for (const span of node.templateSpans) {
    const expression = span.expression.getText(sourceFile)
    output += expression === 'API_BASE' ? '/api' : ':param'
    output += span.literal.text
  }
  return output
}

function inferMethod(call) {
  const init = call.arguments[1]
  if (!init || !ts.isObjectLiteralExpression(init)) return 'GET'
  for (const property of init.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = property.name.getText().replaceAll(/["']/g, '')
    if (name !== 'method') continue
    const value = property.initializer
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      return value.text.toUpperCase()
    }
  }
  return 'GET'
}

function normalizeFrontendPath(raw) {
  if (!raw) return null
  let value = raw
  // fetchJSON/fetchBlob 等基础封装内部的 `${API_BASE}${path}` 不是具体端点。
  if (value === '/api:param') return null
  if (/^https?:\/\//.test(value)) {
    try { value = new URL(value).pathname } catch { return null }
  }
  value = value.split('?')[0].split('#')[0]
  // `${basePath}${queryString}` 会被 AST 渲染成 `/path:param`；动态路径段本身
  // 均有前导斜杠，因此只移除紧贴静态段末尾的占位符。
  value = value.replace(/(?<=[A-Za-z0-9_-]):param$/g, '')
  if (value.startsWith('/api/')) return value
  if (value === '/api') return value
  if (value.startsWith('/')) return `/api${value}`
  return null
}

function canonicalPath(value) {
  return value
    .replaceAll(/\$\{[^}]+\}/g, ':param')
    .replaceAll(/:[A-Za-z_$][\w$]*/g, ':param')
    .replaceAll(/\/+$/g, '') || '/'
}

function frontendSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'graphify-out' ? [] : frontendSourceFiles(absolute)
    return /\.tsx?$/.test(entry.name) ? [absolute] : []
  })
}

function extractFrontendCalls() {
  const calls = []
  // fetchStreamResponse 是所有 SSE/ReadableStream 请求的统一传输边界；
  // 它必须和 fetch/fetchJSON 一样进入契约清单，否则流式端点会被静态审计漏算。
  const recognized = new Set(['fetchJSON', 'fetchBlob', 'fetchStreamResponse', 'fetch', 'authenticatedFetch'])

  for (const sourcePath of frontendSourceFiles(frontendSourceRoot)) {
    const source = readFileSync(sourcePath, 'utf8')
    const scriptKind = sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, scriptKind)
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const callName = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : ''
        if (recognized.has(callName) && node.arguments[0]) {
          const rawPath = renderPath(node.arguments[0], sourceFile)
          const fullPath = normalizeFrontendPath(rawPath)
          if (fullPath) {
            calls.push({
              method: inferMethod(node),
              path: fullPath,
              canonicalPath: canonicalPath(fullPath),
              file: path.relative(projectRoot, sourcePath).replaceAll('\\', '/'),
              line: lineOf(sourceFile, node),
              call: callName,
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return calls
}

function correctedBackendEndpoints(inventory) {
  const workbenchSource = readFileSync(
    path.join(projectRoot, 'backend', 'src', 'routes', 'workbench.ts'),
    'utf8',
  )
  const agentLine = workbenchSource.slice(0, workbenchSource.indexOf('export const agentOrchestrateRoutes'))
    .split(/\r?\n/).length

  return inventory.endpoints
    .filter((endpoint) => endpoint.file.startsWith('backend/'))
    .map((endpoint) => {
      let fullPath = endpoint.fullPath
      if (endpoint.file === 'backend/src/routes/workbench.ts') {
        const prefix = endpoint.line >= agentLine ? '/api/agents' : '/api/workbench'
        fullPath = `${prefix}${endpoint.path === '/' ? '' : endpoint.path}`
      }
      return { ...endpoint, fullPath, canonicalPath: canonicalPath(fullPath) }
    })
}

const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'))
const frontendCalls = extractFrontendCalls()
const backendEndpoints = correctedBackendEndpoints(inventory)
const backendByPath = new Map()
for (const endpoint of backendEndpoints) {
  const list = backendByPath.get(endpoint.canonicalPath) ?? []
  list.push(endpoint)
  backendByPath.set(endpoint.canonicalPath, list)
}

const missingPaths = []
const methodMismatches = []
const matched = []
for (const call of frontendCalls) {
  const candidates = backendByPath.get(call.canonicalPath) ?? []
  if (candidates.length === 0) {
    missingPaths.push(call)
    continue
  }
  const exact = candidates.filter((candidate) => candidate.method === call.method)
  if (exact.length === 0) {
    methodMismatches.push({ ...call, backendMethods: [...new Set(candidates.map((item) => item.method))] })
  } else {
    matched.push({ call, endpoint: exact[0] })
  }
}

const calledKeys = new Set(matched.map(({ endpoint }) => `${endpoint.method} ${endpoint.canonicalPath}`))
const backendNotCalled = backendEndpoints.filter(
  (endpoint) => !calledKeys.has(`${endpoint.method} ${endpoint.canonicalPath}`),
)

const report = {
  generatedAt: new Date().toISOString(),
  summary: {
    frontendCalls: frontendCalls.length,
    backendEndpoints: backendEndpoints.length,
    matched: matched.length,
    missingPaths: missingPaths.length,
    methodMismatches: methodMismatches.length,
    backendNotCalled: backendNotCalled.length,
  },
  missingPaths,
  methodMismatches,
  matched,
  backendNotCalled,
}

writeFileSync(outputJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

const row = (item) => `| ${item.method} | \`${item.path}\` | \`${item.file}:${item.line}\` |`
const markdown = `# 前后端 API 静态契约审计\n\n` +
  `> 本报告从 \`frontend/src/**/*.{ts,tsx}\` 的调用表达式与后端 Fastify 路由声明生成。它能发现路径和方法漂移；动态分支、请求/响应字段语义仍需契约测试和运行时验证。\n\n` +
  `生成时间：${report.generatedAt}\n\n` +
  `| 指标 | 数量 |\n|---|---:|\n` +
  Object.entries(report.summary).map(([key, value]) => `| ${key} | ${value} |`).join('\n') +
  `\n\n## 前端调用但后端无对应路径\n\n| 方法 | 路径 | 前端位置 |\n|---|---|---|\n` +
  (missingPaths.map(row).join('\n') || '| - | 无 | - |') +
  `\n\n## 路径存在但方法不一致\n\n| 前端方法 | 路径 | 前端位置 | 后端方法 |\n|---|---|---|---|\n` +
  (methodMismatches.map((item) => `| ${item.method} | \`${item.path}\` | \`${item.file}:${item.line}\` | ${item.backendMethods.join(', ')} |`).join('\n') || '| - | 无 | - | - |') +
  `\n\n## 解释边界\n\n` +
  `- “后端未被 api.ts 调用”不自动等于死代码：它可能供 WebSocket、表单直连、浏览器媒体标签、外部脚本或兼容客户端使用。\n` +
  `- 正则化把所有动态路径段统一成 \`:param\`，因此能比较参数名不同但结构相同的端点。\n` +
  `- 完整匹配与未调用端点明细见同名 JSON。\n`

writeFileSync(outputMarkdownPath, markdown, 'utf8')
console.log(JSON.stringify({ summary: report.summary, outputs: [outputMarkdownPath, outputJsonPath] }, null, 2))
