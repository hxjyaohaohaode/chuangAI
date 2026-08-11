import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const require = createRequire(import.meta.url)
const ts = require(path.join(projectRoot, 'frontend', 'node_modules', 'typescript', 'lib', 'typescript.js'))

const sourceRoots = [
  path.join(projectRoot, 'frontend', 'src'),
  path.join(projectRoot, 'backend', 'src'),
]
const acceptedExtensions = new Set(['.ts', '.tsx', '.css', '.sql'])
const excludedSegments = new Set(['graphify-out', 'dist', 'coverage', 'node_modules'])

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function relative(file) {
  return toPosix(path.relative(projectRoot, file))
}

function walk(directory, results = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedSegments.has(entry.name)) continue
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(target, results)
    else if (acceptedExtensions.has(path.extname(entry.name).toLowerCase())) results.push(target)
  }
  return results
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function endLineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
}

function literalText(node) {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text
    for (const span of node.templateSpans) value += ':param' + span.literal.text
    return value
  }
  return null
}

function propertyName(node) {
  if (!node) return null
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return null
}

function nodeName(node, sourceFile) {
  if (node.name) {
    if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) return node.name.text
    return node.name.getText(sourceFile)
  }
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isPropertyAssignment(parent)) return propertyName(parent.name) ?? '<property>'
  if (ts.isCallExpression(parent)) return '<callback>'
  return '<anonymous>'
}

function isExported(node) {
  const target = ts.isArrowFunction(node) || ts.isFunctionExpression(node) ? node.parent?.parent : node
  return Boolean(target?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
}

function complexityOf(node) {
  let complexity = 1
  function visit(child) {
    if (
      ts.isIfStatement(child) ||
      ts.isForStatement(child) ||
      ts.isForInStatement(child) ||
      ts.isForOfStatement(child) ||
      ts.isWhileStatement(child) ||
      ts.isDoStatement(child) ||
      ts.isCaseClause(child) ||
      ts.isCatchClause(child) ||
      ts.isConditionalExpression(child)
    ) complexity += 1
    if (ts.isBinaryExpression(child)) {
      const operator = child.operatorToken.kind
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      ) complexity += 1
    }
    ts.forEachChild(child, visit)
  }
  if (node.body) ts.forEachChild(node.body, visit)
  return complexity
}

function parseSource(file, text) {
  const extension = path.extname(file).toLowerCase()
  if (extension !== '.ts' && extension !== '.tsx') {
    return { functions: [], endpoints: [], frontendApiReferences: [], routes: [], tests: [], imports: [], syntaxFindings: [] }
  }

  const kind = extension === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const functions = []
  const endpoints = []
  const frontendApiReferences = []
  const routes = []
  const tests = []
  const imports = []
  const syntaxFindings = []

  function visit(node) {
    // 类型安全标记必须使用 AST；正则会漏掉 `items[index]!`，也会把注释中的
    // “any” 误报为显式 any。
    if (ts.isNonNullExpression(node)) {
      syntaxFindings.push({ kind: 'non-null-assertion', line: lineOf(sourceFile, node), sample: node.getText(sourceFile).slice(0, 120) })
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      syntaxFindings.push({ kind: 'explicit-any', line: lineOf(sourceFile, node), sample: 'any' })
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = []
      const clause = node.importClause
      if (clause?.name) names.push(clause.name.text)
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) names.push(element.name.text)
      }
      imports.push({ source: node.moduleSpecifier.text, names, line: lineOf(sourceFile, node) })
    }

    const isFunction =
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)

    if (isFunction) {
      const startLine = lineOf(sourceFile, node)
      const endLine = endLineOf(sourceFile, node)
      functions.push({
        name: nodeName(node, sourceFile),
        kind: ts.SyntaxKind[node.kind],
        line: startLine,
        endLine,
        lines: endLine - startLine + 1,
        async: Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)),
        exported: isExported(node),
        parameters: node.parameters?.length ?? 0,
        complexity: complexityOf(node),
      })
    }

    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(sourceFile) === 'path' &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      const opening = node.parent?.parent
      if (
        opening &&
        (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
        opening.tagName.getText(sourceFile) === 'Route'
      ) {
        routes.push({ path: node.initializer.text, line: lineOf(sourceFile, node) })
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const callName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null

      if (['describe', 'it', 'test'].includes(callName ?? '')) {
        const title = literalText(node.arguments[0])
        tests.push({ kind: callName, title: title ?? '<dynamic>', line: lineOf(sourceFile, node) })
      }

      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text.toUpperCase()
        if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method)) {
          const routePath = literalText(node.arguments[0])
          if (routePath?.startsWith('/')) {
            endpoints.push({ method, path: routePath, line: lineOf(sourceFile, node) })
          }
        }
      }

      const firstArgument = node.arguments[0]
      const apiCandidate = literalText(firstArgument)
      const isFrontendApiModule = toPosix(file).endsWith('/frontend/src/lib/api.ts')
      if (apiCandidate?.includes('/api/') || (isFrontendApiModule && apiCandidate?.startsWith('/'))) {
        frontendApiReferences.push({ value: apiCandidate, call: callName ?? '<call>', line: lineOf(sourceFile, node) })
      }
    }

    if (ts.isStringLiteralLike(node) && node.text.includes('/api/')) {
      const alreadyCaptured = frontendApiReferences.some(
        (item) => item.value === node.text && item.line === lineOf(sourceFile, node),
      )
      if (!alreadyCaptured) {
        frontendApiReferences.push({ value: node.text, call: '<literal>', line: lineOf(sourceFile, node) })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { functions, endpoints, frontendApiReferences, routes, tests, imports, syntaxFindings }
}

function scanText(relativePath, text) {
  const rules = [
    ['todo', /\b(?:TODO|FIXME|HACK|XXX)\b/g],
    ['ts-ignore', /@ts-(?:ignore|nocheck)/g],
    ['dangerous-html', /dangerouslySetInnerHTML/g],
    ['dynamic-code', /\b(?:eval|Function)\s*\(/g],
    ['console', /\bconsole\.(?:log|warn|error|debug)\b/g],
    ['css-important', /!important/g],
    ['hardcoded-localhost', /(?:localhost|127\.0\.0\.1):\d+/g],
    ['possible-secret', /(?:sk-[A-Za-z0-9_-]{16,}|api[_-]?key\s*[:=]\s*['\"][^'\"]{12,}['\"])/gi],
  ]
  const findings = []
  for (const [kind, regex] of rules) {
    for (const match of text.matchAll(regex)) {
      const before = text.slice(0, match.index)
      const line = before.split(/\r?\n/).length
      findings.push({ kind, line, sample: match[0].slice(0, 120) })
    }
  }
  return findings.map((finding) => ({ file: relativePath, ...finding }))
}

function resolveServerPrefixes(records) {
  const server = records.find((record) => record.file === 'backend/src/server.ts')
  if (!server) return new Map()
  const importByName = new Map()
  for (const item of server.imports) {
    if (!item.source.startsWith('./')) continue
    let resolved = path.posix.normalize(path.posix.join('backend/src', item.source.replace(/\.js$/, '.ts')))
    for (const name of item.names) importByName.set(name, resolved)
  }

  const source = readFileSync(path.join(projectRoot, 'backend', 'src', 'server.ts'), 'utf8')
  const prefixByFile = new Map()
  const registerPattern = /app\.register\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{[\s\S]*?prefix\s*:\s*['\"]([^'\"]+)['\"]/g
  for (const match of source.matchAll(registerPattern)) {
    const importedFile = importByName.get(match[1])
    if (importedFile) prefixByFile.set(importedFile, match[2])
  }
  // 编排器通过 barrel (`orchestrator/index.ts`) 重新导出，端点声明位于子文件；
  // 静态导入名无法直接回溯到子文件，因此在此登记经 server.ts 明确注册的两个前缀。
  prefixByFile.set('backend/src/orchestrator/routes.ts', '/api/orchestrator')
  prefixByFile.set('backend/src/orchestrator/websocket/handlers.ts', '/ws')
  // 认证路由与服务/钩子共处 security/auth.ts；显式登记，避免跨 register 正则把
  // 前一个无 options 的插件和后一个 prefix 对误配。
  prefixByFile.set('backend/src/security/auth.ts', '/api/auth')
  return prefixByFile
}

function joinRoute(prefix, route) {
  const left = prefix?.endsWith('/') ? prefix.slice(0, -1) : prefix ?? ''
  const right = route === '/' ? '' : route
  return `${left}${right}` || '/'
}

const files = sourceRoots.flatMap((root) => walk(root)).sort()
const records = files.map((file) => {
  const text = readFileSync(file, 'utf8')
  const rel = relative(file)
  const lines = text.split(/\r?\n/)
  const { syntaxFindings, ...parsed } = parseSource(file, text)
  return {
    file: rel,
    sha256: sha256(text),
    extension: path.extname(file).toLowerCase(),
    lines: lines.length,
    nonBlankLines: lines.filter((line) => line.trim().length > 0).length,
    findings: [
      ...scanText(rel, text),
      ...syntaxFindings.map((finding) => ({ file: rel, ...finding })),
    ],
    ...parsed,
  }
})

const prefixByFile = resolveServerPrefixes(records)
// 测试夹具中的 app.get/app.post 不是生产端点；纳入会把覆盖率样例误计为 API。
const endpointInventory = records
  .filter((record) => !/\.test\.[cm]?tsx?$/.test(record.file))
  .flatMap((record) => record.endpoints.map((endpoint) => ({
    file: record.file,
    ...endpoint,
    prefix: prefixByFile.get(record.file) ?? '',
    fullPath: joinRoute(prefixByFile.get(record.file) ?? '', endpoint.path),
  })))

const functionInventory = records.flatMap((record) =>
  record.functions.map((fn) => ({ file: record.file, ...fn })),
)
const developmentOnlyFrontendRoutes = new Set(['/dev/visual', '/dev/scripts'])
const routeInventory = records.flatMap((record) => record.routes.map((route) => ({
  file: record.file,
  ...route,
  scope: developmentOnlyFrontendRoutes.has(route.path) ? 'development' : 'production',
})))
const productionRouteInventory = routeInventory.filter((route) => route.scope === 'production')
const developmentRouteInventory = routeInventory.filter((route) => route.scope === 'development')
const frontendApiInventory = records
  .filter((record) => record.file.startsWith('frontend/'))
  .flatMap((record) => record.frontendApiReferences.map((item) => ({ file: record.file, ...item })))
const testInventory = records.flatMap((record) => record.tests.map((test) => ({ file: record.file, ...test })))
const findings = records.flatMap((record) => record.findings)

const summary = {
  generatedAt: new Date().toISOString(),
  sourceFiles: records.length,
  totalLines: records.reduce((sum, record) => sum + record.lines, 0),
  totalNonBlankLines: records.reduce((sum, record) => sum + record.nonBlankLines, 0),
  typescriptFiles: records.filter((record) => ['.ts', '.tsx'].includes(record.extension)).length,
  cssFiles: records.filter((record) => record.extension === '.css').length,
  sqlFiles: records.filter((record) => record.extension === '.sql').length,
  functions: functionInventory.length,
  backendEndpoints: endpointInventory.length,
  frontendRoutes: routeInventory.length,
  frontendProductionRoutes: productionRouteInventory.length,
  frontendDevelopmentRoutes: developmentRouteInventory.length,
  frontendApiReferences: frontendApiInventory.length,
  testDeclarations: testInventory.filter((test) => test.kind === 'it' || test.kind === 'test').length,
  findings: findings.length,
}

const report = {
  summary,
  files: records.map(({ imports, endpoints, routes, frontendApiReferences, tests, functions, ...record }) => ({
    ...record,
    functionCount: functions.length,
    endpointCount: endpoints.length,
    routeCount: routes.length,
    frontendApiReferenceCount: frontendApiReferences.length,
    testDeclarationCount: tests.filter((test) => test.kind === 'it' || test.kind === 'test').length,
  })),
  functions: functionInventory,
  endpoints: endpointInventory,
  frontendRoutes: routeInventory,
  frontendApiReferences: frontendApiInventory,
  tests: testInventory,
  findings,
}

const outputDirectory = path.join(projectRoot, 'docs', 'audit')
mkdirSync(outputDirectory, { recursive: true })
const jsonPath = path.join(outputDirectory, '2026-08-01-source-inventory.json')
const markdownPath = path.join(outputDirectory, '2026-08-01-source-inventory.md')
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

const byKind = Object.entries(
  findings.reduce((acc, finding) => {
    acc[finding.kind] = (acc[finding.kind] ?? 0) + 1
    return acc
  }, {}),
).sort((a, b) => b[1] - a[1])

const largestFiles = [...records].sort((a, b) => b.lines - a.lines).slice(0, 30)
const complexFunctions = [...functionInventory]
  .sort((a, b) => b.complexity - a.complexity || b.lines - a.lines)
  .slice(0, 50)

const markdown = `# 2026-08-01 全量源码资产台账\n\n` +
  `> 本文件由 \`scripts/audit-source-inventory.mjs\` 从当前工作区生成。JSON 明细包含每个文件的 SHA-256、行数、每个函数位置、每个后端端点、前端路由、API 字符串与静态风险标记。\n\n` +
  `## 汇总\n\n` +
  `| 指标 | 数量 |\n|---|---:|\n` +
  Object.entries(summary).filter(([key]) => key !== 'generatedAt').map(([key, value]) => `| ${key} | ${value} |`).join('\n') +
  `\n\n生成时间：${summary.generatedAt}\n\n` +
  `## 后端端点（完整）\n\n| 方法 | 完整路径 | 文件 | 行 |\n|---|---|---|---:|\n` +
  endpointInventory.map((endpoint) => `| ${endpoint.method} | \`${endpoint.fullPath}\` | \`${endpoint.file}\` | ${endpoint.line} |`).join('\n') +
  `\n\n## 前端路由（完整）\n\n> 静态声明总数保留开发路由；生产口径排除仅在 \`import.meta.env.DEV\` 下注册的 \`/dev/visual\` 与 \`/dev/scripts\`。\n\n| 路由 | 范围 | 文件 | 行 |\n|---|---|---|---:|\n` +
  routeInventory.map((route) => `| \`${route.path}\` | ${route.scope === 'production' ? '生产' : '仅开发'} | \`${route.file}\` | ${route.line} |`).join('\n') +
  `\n\n## 最大文件\n\n| 行数 | 函数 | 端点 | 文件 |\n|---:|---:|---:|---|\n` +
  largestFiles.map((record) => `| ${record.lines} | ${record.functions.length} | ${record.endpoints.length} | \`${record.file}\` |`).join('\n') +
  `\n\n## 高复杂度函数候选\n\n> complexity 为静态分支计数启发式，只用于排序人工审查优先级，不等同于正式圈复杂度结论。\n\n| 复杂度 | 行数 | 函数 | 文件:行 |\n|---:|---:|---|---|\n` +
  complexFunctions.map((fn) => `| ${fn.complexity} | ${fn.lines} | \`${fn.name}\` | \`${fn.file}:${fn.line}\` |`).join('\n') +
  `\n\n## 静态风险标记汇总\n\n| 类型 | 命中 |\n|---|---:|\n` +
  byKind.map(([kind, count]) => `| ${kind} | ${count} |`).join('\n') +
  `\n\n## 解释边界\n\n` +
  `- 文件哈希与 AST 台账证明当前版本的每个产品源文件均被机器读取和登记，不证明每一行都不存在语义缺陷。\n` +
  `- 端点解析覆盖 Fastify 常见的 \`app.get/post/put/patch/delete/options/head\` 声明；动态注册、运行时拼接与 WebSocket 事件需另行审查。\n` +
  `- 静态标记是审查入口，不是漏洞定论；每个高风险命中仍需结合数据流、可达性与测试证据判断。\n` +
  `- 完整函数、文件、API 引用与风险明细见同名 JSON。\n`

writeFileSync(markdownPath, markdown, 'utf8')

console.log(JSON.stringify({ summary, outputs: [relative(markdownPath), relative(jsonPath)] }, null, 2))
