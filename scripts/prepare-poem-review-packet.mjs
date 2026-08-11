#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseCsv } from './analyze-pilot-evidence.mjs'
import { REVIEW_HEADERS, inspectReviewRegister } from './audit-poem-provenance.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

function inline(value) {
    return String(value ?? '').replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ').trim() || '待填写'
}

function quotePoem(content) {
    const lines = String(content ?? '')
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
    return lines.length > 0 ? lines.map((line) => `> ${line}`).join('\n>\n') : '> （正文为空：停止复核并报告数据错误）'
}

function reviewRows(csvText) {
    const matrix = parseCsv(csvText)
    const headers = matrix[0]?.map((header) => header.trim()) ?? []
    if (headers.length !== REVIEW_HEADERS.length
        || headers.some((header, index) => header !== REVIEW_HEADERS[index])) {
        throw new Error('复核工作表表头与受控模板不一致')
    }
    return new Map(matrix.slice(1).map((values) => {
        const row = Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? '']))
        return [row.poem_id, row]
    }))
}

export function renderPoemReviewPacket(poems, csvText, generatedAt = new Date().toISOString()) {
    const inspection = inspectReviewRegister(csvText, poems.map((poem) => ({
        ...poem,
        verification: { contentSha256: poem.contentSha256 },
    })))
    if (!inspection.ok) throw new Error(`复核工作表身份校验失败：${inspection.errors.join('；')}`)
    const rows = reviewRows(csvText)
    const sourceReady = [...rows.values()].filter((row) => row.source_1_url && row.source_2_url).length
    const teacherReady = [...rows.values()].filter((row) => row.teacher_decision && row.teacher_reviewer_id && row.teacher_reviewed_at).length
    const lines = [
        '# 148 首诗逐首内容审核包',
        '',
        `- 生成时间：${generatedAt}`,
        `- 当前运行时收录：${poems.length} 首`,
        `- 已填写双信源：${sourceReady}/${poems.length}`,
        `- 已填写教师结论：${teacherReady}/${poems.length}`,
        '- 受控登记表：`evidence/content/poem-review-register-latest.csv`',
        '',
        '> 本文件只为语文教师提供便于打印和逐首核对的工作视图。唯一可编译的结构化输入仍是受控 CSV；本文件中的“待填写”绝不等同于已验证，也不能替代线下签字、访问日期、双信源页面留档或学校授权。',
        '',
        '## 复核操作',
        '',
        '1. 逐字核对诗题、作者、朝代和正文；正文任何一字、标点或篇幅有误，教师结论必须填 `REJECT`，并先修复代码后重新生成哈希和工作表。',
        '2. 为每首诗记录两个不同机构的 HTTPS 信源，至少一个为 L1；网页标题、访问日期和离线截图/PDF 必须可回溯。',
        '3. 明确 `TEXTBOOK_CORE` 或 `EXTENDED`。收录量不能自动等同于教材核心篇目数量。',
        '4. 由真实语文教师使用匿名编号（格式如 `T-01`）填写 `PASS/REJECT`、复核日期和 `offline-vault/...` 证据位置。',
        '5. 完成后运行 `node scripts/compile-poem-provenance.mjs --input evidence/content/poem-review-register-latest.csv --out backend/src/data/poem-provenance.json --replace`，随后重建并执行溯源审计。',
        '',
    ]

    poems.forEach((poem, index) => {
        const row = rows.get(poem.id)
        if (!row) throw new Error(`复核工作表缺少 ${poem.id}`)
        lines.push(
            `## ${String(index + 1).padStart(3, '0')} · ${inline(poem.title)}`,
            '',
            `- ID：\`${poem.id}\``,
            `- 作者 / 朝代：${inline(poem.poet)} / ${inline(poem.dynasty)}`,
            `- 年级 / 难度：${inline(poem.gradeLevel)} / ${inline(poem.difficulty)}`,
            `- 主题：${Array.isArray(poem.themes) && poem.themes.length > 0 ? poem.themes.map(inline).join('、') : '待核对'}`,
            `- 当前范围：${inline(row.catalog_scope)}`,
            `- 内容 SHA-256：\`${poem.contentSha256}\``,
            '',
            '### 当前运行时正文',
            '',
            quotePoem(poem.content),
            '',
            '### 双信源与教师结论',
            '',
            '| 字段 | 当前登记值 |',
            '|---|---|',
            `| 信源 1 | ${inline(row.source_1_title)} · ${inline(row.source_1_url)} · ${inline(row.source_1_level)} · ${inline(row.source_1_accessed_at)} |`,
            `| 信源 2 | ${inline(row.source_2_title)} · ${inline(row.source_2_url)} · ${inline(row.source_2_level)} · ${inline(row.source_2_accessed_at)} |`,
            `| 教师结论 | ${inline(row.teacher_decision)} · ${inline(row.teacher_reviewer_id)} · ${inline(row.teacher_reviewed_at)} |`,
            `| 线下证据 | ${inline(row.evidence_location)} |`,
            '',
        )
    })
    return `${lines.join('\n')}\n`
}

async function atomicWrite(target, content) {
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
}

export async function runCli() {
    const seedPath = path.join(ROOT, 'backend', 'dist', 'services', 'knowledge-graph', 'seed-poems-full.js')
    const verificationPath = path.join(ROOT, 'backend', 'dist', 'services', 'content-verification', 'poem-provenance.js')
    const [{ SEED_POEMS_FULL }, { computePoemContentSha256 }] = await Promise.all([
        import(pathToFileURL(seedPath).href),
        import(pathToFileURL(verificationPath).href),
    ])
    const poems = SEED_POEMS_FULL.map((poem) => ({
        ...poem,
        contentSha256: computePoemContentSha256(poem),
    }))
    const registerPath = path.join(ROOT, 'evidence', 'content', 'poem-review-register-latest.csv')
    const outputPath = path.join(ROOT, 'evidence', 'content', 'poem-review-packet-latest.md')
    const output = renderPoemReviewPacket(poems, await readFile(registerPath, 'utf8'))
    await atomicWrite(outputPath, output)
    process.stdout.write(`Prepared poem review packet: ${poems.length} poems -> ${path.relative(ROOT, outputPath)}\n`)
}

const invokedDirectly = process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
    runCli().catch((error) => {
        process.stderr.write(`Poem review packet failed: ${error.message}\n`)
        process.exitCode = 1
    })
}
