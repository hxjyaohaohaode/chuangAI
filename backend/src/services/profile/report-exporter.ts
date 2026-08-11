/**
 * 报告多格式导出服务（画像报告 · 能力 4）
 *
 * 支持 4 种导出格式 + 分享链接：
 *   1. PDF 工作流：生成打印版 HTML，由浏览器“打印 / 另存为 PDF”产出真实 PDF
 *   2. 图片 PNG 导出：Canvas 截图 / SVG 转 PNG（服务端生成 HTML 引导客户端截图）
 *   3. Excel 工作流：CSV 兼容格式 + UTF-8 BOM（Excel 可直接打开）
 *   4. 分享链接：生成带 token 的公开访问 URL，支持过期与访问统计
 *
 * 设计要点：
 * - 分享链接使用 SqliteMap 持久化，进程重启后链接仍有效
 * - 分享 token 使用 node:crypto randomBytes(32)（256-bit，不可猜测）
 * - 持久层仅保存 SHA-256(token) 查找键；bearer token 只在创建响应出现一次
 * - 默认有效期 7 天，可通过 expireDays 参数调整
 * - LLM 不参与导出（纯算法生成，降低延迟与成本）
 * - Excel 使用 CSV + BOM 方案，避免引入 xlsx 依赖
 */

import { createHash, randomBytes } from 'node:crypto'
import { db, repos } from '../../db/index.js'
import { SqliteMap } from '../../db/runtime-store.js'
import type { BloomLevel } from '../../agents/base/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 导出格式 */
export type ExportFormat = 'pdf' | 'image' | 'excel' | 'markdown' | 'word'

/** 导出请求 */
export interface ExportRequest {
    /** 报告 ID */
    reportId: string
    /** 导出格式 */
    format: ExportFormat
    /** 内容范围：包含的章节 */
    includeSections?: string[]
    /** 是否包含数据图表 */
    includeCharts?: boolean
    /** 是否包含验收信息 */
    includeVerification?: boolean
}

/** 导出响应 */
export interface ExportResponse {
    /** 导出 ID */
    exportId: string
    /** 报告 ID */
    reportId: string
    /** 格式 */
    format: ExportFormat
    /** 文件名（不含扩展名） */
    fileName: string
    /** MIME 类型 */
    mimeType: string
    /** 内容（文本类格式：HTML / CSV / Markdown） */
    content?: string
    /** 生成时间戳 */
    generatedAt: number
    /** 是否成功 */
    success: boolean
    /** 错误信息 */
    error?: string
}

/** 所有者管理面可见的分享元数据（不含 bearer token、教师主体和报告正文）。 */
export interface SharedReport {
    /** 非秘密管理 ID，用于列表与撤销。 */
    shareId: string
    /** 报告 ID */
    reportId: string
    /** 班级名称 */
    className: string
    /** 报告标题 */
    title: string
    /** 创建时间 */
    createdAt: number
    /** 过期时间 */
    expireAt: number
    /** 访问次数 */
    viewCount: number
    /** 最后访问时间 */
    lastViewedAt: number | null
}

/** bearer token 仅在创建成功响应出现一次。 */
export interface CreatedSharedReport extends SharedReport {
    token: string
}

interface StoredSharedReport extends SharedReport {
    contentHtml: string
    teacherId: string
}

interface LegacySharedReport extends Omit<StoredSharedReport, 'shareId'> {
    token: string
    shareId?: string
}

/**
 * 匿名访问者可见的分享快照。
 *
 * bearer token、内部报告主键、教师主体、访问统计均属于管理面元数据，绝不能
 * 随公开读取接口返回。把公开 DTO 固化在服务层，可避免路由未来直接展开
 * SharedReport 时重新引入越权披露。
 */
export interface PublicSharePreview {
    className: string
    title: string
    contentHtml: string
}

export interface PublicSharedReport extends PublicSharePreview {
    createdAt: number
    expireAt: number
}

/** 创建分享链接请求 */
export interface CreateShareRequest {
    reportId: string
    teacherId: string
    /** 过期天数（默认 7） */
    expireDays?: number
}

export interface PublicShareSource {
    className: string
    output?: { title: string }
    markdownContent: string
    /** 来自权威班级花名册与报告主键的内容级隐私词表。 */
    sensitiveTerms?: readonly string[]
}

const PUBLIC_REDACTION_NOTICE = '【个体信息已在公开分享中隐藏】'

/**
 * 可识别个体的通用模式。真实姓名由调用方根据报告所属班级花名册作为
 * sensitiveTerms 注入；这里补齐即使不在花名册中也能确定识别的联系方式、
 * 证件号、内部/匿名学生编号和家长姓名标签。
 */
const PUBLIC_PII_DETECTORS: readonly RegExp[] = [
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
    /(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}/u,
    /\b\d{17}[\dXx]\b/u,
    /\b\d{15}\b/u,
    /\b[A-F0-9]{8}-[A-F0-9]{4}-[1-5][A-F0-9]{3}-[89AB][A-F0-9]{3}-[A-F0-9]{12}\b/iu,
    /(?:学生(?:编号|ID|id|学号)|学号)\s*[：:=#-]?\s*[A-Za-z0-9_-]{2,}/iu,
    /(?<![A-Za-z0-9_-])stu(?:dent)?[-_:]?[A-Za-z0-9][A-Za-z0-9_-]{2,}(?![A-Za-z0-9_-])/iu,
    /(?<![A-Za-z0-9])S\d{2,4}(?![A-Za-z0-9])/iu,
    /(?:家长|监护人)(?:姓名|称呼)?\s*[：:]\s*[\p{Script=Han}·]{2,12}/u,
]

const PUBLIC_PII_REPLACERS: readonly RegExp[] = [
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
    /(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}/gu,
    /\b\d{17}[\dXx]\b/gu,
    /\b\d{15}\b/gu,
    /\b[A-F0-9]{8}-[A-F0-9]{4}-[1-5][A-F0-9]{3}-[89AB][A-F0-9]{3}-[A-F0-9]{12}\b/giu,
    /(?:学生(?:编号|ID|id|学号)|学号)\s*[：:=#-]?\s*[A-Za-z0-9_-]{2,}/giu,
    /(?<![A-Za-z0-9_-])stu(?:dent)?[-_:]?[A-Za-z0-9][A-Za-z0-9_-]{2,}(?![A-Za-z0-9_-])/giu,
    /(?<![A-Za-z0-9])S\d{2,4}(?![A-Za-z0-9])/gu,
    /(?:家长|监护人)(?:姓名|称呼)?\s*[：:]\s*[\p{Script=Han}·]{2,12}/gu,
]

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const BLOOM_LEVELS: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

/** 默认分享链接有效期（天） */
const DEFAULT_EXPIRE_DAYS = 7

/** 最大有效期（天）—— 防止永久链接 */
const MAX_EXPIRE_DAYS = 90

// ─────────────────────────────────────────────────────────────
// 分享链接存储
// ─────────────────────────────────────────────────────────────

const shareStore = new SqliteMap<string, StoredSharedReport>({
    table: 'shared_reports',
    indexes: [
        { name: 'report_id', extract: (v) => v.reportId },
        { name: 'teacher_id', extract: (v) => v.teacherId },
        { name: 'expire_at', extract: (v) => String(v.expireAt) },
    ],
})

// 升级前表以原始 bearer token 为 key 且 value 内也保存 token。启动时同步迁移，
// 使既有链接继续有效，同时尽快消除静态数据库泄漏即可直接访问分享内容的风险。
migrateLegacyShares()

// ─────────────────────────────────────────────────────────────
// 主服务
// ─────────────────────────────────────────────────────────────

/**
 * 导出报告为指定格式
 */
export async function exportReport(
    request: ExportRequest,
    reportData: {
        reportId: string
        className: string
        period: { from: number; to: number }
        output?: {
            title: string
            sections: Array<{ heading: string; content: string }>
            keyFindings: string[]
            recommendations: string[]
        }
        verification?: {
            verdict: string
            score: number
            confidence: number
            strengths: string[]
            issues: Array<{ severity: string; description: string; suggestion: string }>
        }
        exportedData?: {
            anonymizedStudents: Array<{ id: string; name: string }>
            classBloomRadar: Record<string, number>
            events: Array<{ studentId: string; type: string; occurredAt: number; action: string }>
        }
    },
): Promise<ExportResponse> {
    const now = Date.now()
    const exportId = `exp-${now}-${Math.random().toString(36).slice(2, 8)}`
    const fileName = `${reportData.className}-教研报告-${formatDate(now)}`

    try {
        switch (request.format) {
            case 'pdf':
                return {
                    exportId,
                    reportId: request.reportId,
                    format: 'pdf',
                    fileName,
                    mimeType: 'text/html',
                    content: renderPdfHtml(reportData, request),
                    generatedAt: now,
                    success: true,
                }

            case 'image':
                return {
                    exportId,
                    reportId: request.reportId,
                    format: 'image',
                    fileName,
                    mimeType: 'text/html',
                    content: renderImageHtml(reportData, request),
                    generatedAt: now,
                    success: true,
                }

            case 'excel':
                return {
                    exportId,
                    reportId: request.reportId,
                    format: 'excel',
                    fileName,
                    mimeType: 'text/csv',
                    content: renderExcelCsv(reportData, request),
                    generatedAt: now,
                    success: true,
                }

            case 'markdown':
                return {
                    exportId,
                    reportId: request.reportId,
                    format: 'markdown',
                    fileName,
                    mimeType: 'text/markdown',
                    content: renderMarkdown(reportData, request),
                    generatedAt: now,
                    success: true,
                }

            case 'word':
                return {
                    exportId,
                    reportId: request.reportId,
                    format: 'word',
                    fileName,
                    mimeType: 'application/msword',
                    content: renderWordHtml(reportData, request),
                    generatedAt: now,
                    success: true,
                }

            default:
                return {
                    exportId,
                    reportId: request.reportId,
                    format: request.format,
                    fileName,
                    mimeType: 'text/plain',
                    generatedAt: now,
                    success: false,
                    error: `不支持的导出格式: ${request.format}`,
                }
        }
    } catch (err) {
        return {
            exportId,
            reportId: request.reportId,
            format: request.format,
            fileName,
            mimeType: 'text/plain',
            generatedAt: now,
            success: false,
            error: err instanceof Error ? err.message : '导出失败',
        }
    }
}

/**
 * 创建分享链接
 */
export function createShareLink(
    request: CreateShareRequest,
    reportData: PublicShareSource,
    now = Date.now(),
): CreatedSharedReport {
    const expireDays = Math.min(Math.max(request.expireDays ?? DEFAULT_EXPIRE_DAYS, 1), MAX_EXPIRE_DAYS)
    const token = generateToken()
    const lookupKey = shareLookupKey(token)
    const shareId = shareIdFromLookupKey(lookupKey)
    // 创建阶段必须重新执行完整脱敏，不接受前端回传的 HTML，
    // 也不复用客户端手里的预览副本。这样即使前端状态被篡改，
    // 持久化的仍是服务端当下重新生成的隐私快照。
    const preview = buildPublicSharePreview(request, reportData)

    const shared: StoredSharedReport = {
        shareId,
        reportId: request.reportId,
        ...preview,
        createdAt: now,
        expireAt: now + expireDays * 24 * 60 * 60 * 1000,
        viewCount: 0,
        lastViewedAt: null,
        teacherId: request.teacherId,
    }

    shareStore.set(lookupKey, shared)
    return { ...toManagedSharedReport(shared), token }
}

/**
 * 生成与真实公开链接完全同源的脱敏预览。
 *
 * 这是预览端点与 createShareLink 的唯一脱敏真相源：预览不落库，
 * 创建时会再调用一次。任何一侧都不得自行复制或弱化这条规则。
 */
export function buildPublicSharePreview(
    request: Pick<CreateShareRequest, 'reportId' | 'teacherId'>,
    reportData: PublicShareSource,
): PublicSharePreview {
    const sensitiveTerms = [
        request.reportId,
        request.teacherId,
        ...(reportData.sensitiveTerms ?? []),
    ]
    const className = redactPublicReportContent(reportData.className, sensitiveTerms)
    const title = redactPublicReportContent(
        reportData.output?.title ?? `${reportData.className}-教研报告`,
        sensitiveTerms,
    )
    const contentHtml = markdownToHtml(redactPublicReportContent(
        reportData.markdownContent,
        sensitiveTerms,
    ))

    return {
        className,
        title,
        contentHtml,
    }
}

/**
 * 预览指纹不是 bearer 凭据，只用于证明教师确认的预览与创建时
 * 服务端重新脱敏的内容一致。把报告和教师主体纳入指纹，防止
 * 一份报告的预览被移用到另一份报告。
 */
export function fingerprintPublicSharePreview(
    request: Pick<CreateShareRequest, 'reportId' | 'teacherId'>,
    preview: PublicSharePreview,
): string {
    return createHash('sha256')
        .update(JSON.stringify([
            'public-share-preview-v1',
            request.reportId,
            request.teacherId,
            preview.className,
            preview.title,
            preview.contentHtml,
        ]), 'utf8')
        .digest('hex')
}

/**
 * 获取分享的报告内容（同时增加访问计数）
 */
export function getSharedReport(token: string, now = Date.now()): PublicSharedReport | null {
    const lookupKey = shareLookupKey(token)
    const shared = shareStore.get(lookupKey) ?? migrateLegacyTokenOnRead(token, lookupKey)
    if (!shared) return null

    // 缺失/损坏的过期时间一律失败关闭；达到 expireAt 的瞬间即失效。
    if (!Number.isFinite(shared.expireAt) || now >= shared.expireAt) {
        shareStore.delete(lookupKey)
        return null
    }

    // 增加访问计数
    const updated: StoredSharedReport = {
        ...shared,
        viewCount: Number.isSafeInteger(shared.viewCount) && shared.viewCount >= 0
            ? shared.viewCount + 1
            : 1,
        lastViewedAt: now,
    }
    shareStore.set(lookupKey, updated)

    return toPublicSharedReport(updated)
}

/**
 * 查询教师创建的所有分享链接
 */
export function listSharedReports(teacherId: string, now = Date.now()): SharedReport[] {
    const result: SharedReport[] = []
    for (const [lookupKey, shared] of shareStore) {
        if (!Number.isFinite(shared.expireAt) || now >= shared.expireAt) {
            shareStore.delete(lookupKey)
            continue
        }
        if (shared.teacherId === teacherId) {
            result.push(toManagedSharedReport(shared))
        }
    }
    result.sort((a, b) => b.createdAt - a.createdAt)
    return result
}

/**
 * 撤销分享链接
 */
export function revokeShareLink(identifier: string, teacherId: string): boolean {
    for (const [lookupKey, shared] of shareStore) {
        if (shared.shareId === identifier && shared.teacherId === teacherId) {
            return shareStore.delete(lookupKey)
        }
    }

    // 兼容已经复制到旧客户端中的 bearer-token 撤销请求；管理列表不再返回它。
    const lookupKey = shareLookupKey(identifier)
    const byToken = shareStore.get(lookupKey) ?? migrateLegacyTokenOnRead(identifier, lookupKey)
    if (!byToken || byToken.teacherId !== teacherId) return false
    return shareStore.delete(lookupKey)
}

// ─────────────────────────────────────────────────────────────
// 渲染函数
// ─────────────────────────────────────────────────────────────

const SECTION_KEY_TO_HEADING: Readonly<Record<string, string>> = {
    background: '教学背景',
    intervention: '干预策略',
    evidence: '数据实证',
    reflection: '反思展望',
}

/**
 * 前端传稳定章节 key，历史调用方可能传中文 heading；两种形式都支持。
 * 旧实现直接拿 key 与中文 heading 比较，勾选任一章节都会导出空正文。
 */
export function filterExportSections<T extends { heading: string }>(
    sections: T[],
    includeSections?: string[],
): T[] {
    if (!includeSections || includeSections.length === 0) return sections
    const headings = new Set(includeSections.map((value) => SECTION_KEY_TO_HEADING[value] ?? value))
    return sections.filter((section) => headings.has(section.heading))
}

/** 渲染 PDF 打印版 HTML（不是伪造的 PDF 字节） */
function renderPdfHtml(data: {
    className: string
    period: { from: number; to: number }
    output?: { title: string; sections: Array<{ heading: string; content: string }>; keyFindings: string[]; recommendations: string[] }
    verification?: { verdict: string; score: number; confidence: number; strengths: string[]; issues: Array<{ severity: string; description: string; suggestion: string }> }
}, request: ExportRequest): string {
    if (!data.output) return '<html><body><p>报告内容为空</p></body></html>'
    const sections = filterExportSections(data.output.sections, request.includeSections)

    const sectionsHtml = sections.map((s) => `
        <section class="report-section">
            <h2>${escapeHtml(s.heading)}</h2>
            <div class="section-content">${escapeHtml(s.content).replace(/\n/g, '<br/>')}</div>
        </section>
    `).join('')

    const findingsHtml = request.includeCharts !== false && data.output.keyFindings.length > 0
        ? `<section><h2>关键发现</h2><ul>${data.output.keyFindings.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul></section>`
        : ''

    const recommendationsHtml = data.output.recommendations.length > 0
        ? `<section><h2>教学建议</h2><ul>${data.output.recommendations.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul></section>`
        : ''

    const verificationHtml = request.includeVerification !== false && data.verification
        ? renderVerificationHtml(data.verification)
        : ''

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(data.output.title)}</title>
<style>
${getPdfCss()}
</style>
</head>
<body>
<div class="report-container">
<div class="report-header">
<h1>${escapeHtml(data.output.title)}</h1>
<div class="meta">班级：${escapeHtml(data.className)} ｜ 时间：${formatDate(data.period.from)} 至 ${formatDate(data.period.to)}</div>
<div class="badge">AI 生成 · 数据已脱敏</div>
</div>
${sectionsHtml}
${findingsHtml}
${recommendationsHtml}
${verificationHtml}
<div class="watermark">AI 生成 · 已脱敏</div>
</div>
</body>
</html>`
}

/** 渲染图片导出 HTML（引导客户端截图） */
function renderImageHtml(data: {
    className: string
    period: { from: number; to: number }
    output?: { title: string; sections: Array<{ heading: string; content: string }>; keyFindings: string[]; recommendations: string[] }
}, _request: ExportRequest): string {
    if (!data.output) return '<html><body><p>报告内容为空</p></body></html>'

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(data.output.title)} - 图片版</title>
<style>
${getImageCss()}
</style>
</head>
<body>
<div class="image-card" id="capture-target">
<div class="card-header">
<h1>${escapeHtml(data.output.title)}</h1>
<div class="meta">${escapeHtml(data.className)} · ${formatDate(data.period.from)} - ${formatDate(data.period.to)}</div>
</div>
<div class="card-body">
${data.output.sections.slice(0, 3).map((s) => `
<div class="card-section">
<h2>${escapeHtml(s.heading)}</h2>
<p>${escapeHtml(s.content.slice(0, 200))}${s.content.length > 200 ? '...' : ''}</p>
</div>
`).join('')}
${data.output.keyFindings.length > 0 ? `
<div class="card-section">
<h2>关键发现</h2>
<ul>${data.output.keyFindings.slice(0, 5).map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
</div>
` : ''}
</div>
<div class="card-footer">
<span class="badge">AI 生成 · 已脱敏</span>
<span class="timestamp">${formatDate(Date.now())}</span>
</div>
</div>
</body>
</html>`
}

/** 渲染 Excel CSV（含 BOM，Excel 可直接打开） */
function renderExcelCsv(data: {
    className: string
    period: { from: number; to: number }
    output?: { title: string; sections: Array<{ heading: string; content: string }>; keyFindings: string[]; recommendations: string[] }
    exportedData?: {
        anonymizedStudents: Array<{ id: string; name: string }>
        classBloomRadar: Record<string, number>
        events: Array<{ studentId: string; type: string; occurredAt: number; action: string }>
    }
}, _request: ExportRequest): string {
    const rows: string[][] = []

    // 标题行
    rows.push(['教研报告数据导出'])
    rows.push(['班级', data.className])
    rows.push(['时间范围', `${formatDate(data.period.from)} 至 ${formatDate(data.period.to)}`])
    rows.push(['报告标题', data.output?.title ?? ''])
    rows.push([])

    // 班级六阶雷达
    if (data.exportedData) {
        rows.push(['班级六阶能力雷达'])
        rows.push(['认知层级', '平均掌握度'])
        for (const level of BLOOM_LEVELS) {
            const score = data.exportedData.classBloomRadar[level] ?? 0
            rows.push([level, String(Math.round(score * 100) / 100)])
        }
        rows.push([])

        // 学生列表
        rows.push(['学生列表（脱敏）'])
        rows.push(['序号', '脱敏名', '学生 ID'])
        data.exportedData.anonymizedStudents.forEach((s, i) => {
            rows.push([String(i + 1), s.name, s.id])
        })
        rows.push([])

        // 学习事件流
        rows.push(['学习事件流'])
        rows.push(['时间', '学生 ID', '事件类型', '动作'])
        for (const e of data.exportedData.events.slice(0, 500)) {
            rows.push([
                new Date(e.occurredAt).toISOString(),
                e.studentId,
                e.type,
                e.action,
            ])
        }
        rows.push([])
    }

    // 关键发现
    if (data.output && data.output.keyFindings.length > 0) {
        rows.push(['关键发现'])
        rows.push(['序号', '发现内容'])
        data.output.keyFindings.forEach((f, i) => {
            rows.push([String(i + 1), f])
        })
        rows.push([])
    }

    // 教学建议
    if (data.output && data.output.recommendations.length > 0) {
        rows.push(['教学建议'])
        rows.push(['序号', '建议内容'])
        data.output.recommendations.forEach((r, i) => {
            rows.push([String(i + 1), r])
        })
    }

    // 转 CSV（UTF-8 BOM）
    const csvContent = rows.map((row) =>
        row.map((cell) => {
            const escaped = neutralizeSpreadsheetFormula(String(cell)).replace(/"/g, '""')
            return `"${escaped}"`
        }).join(','),
    ).join('\r\n')

    return '\uFEFF' + csvContent
}

/** 渲染 Markdown */
function renderMarkdown(data: {
    className: string
    period: { from: number; to: number }
    output?: { title: string; sections: Array<{ heading: string; content: string }>; keyFindings: string[]; recommendations: string[] }
    verification?: { verdict: string; score: number; confidence: number; strengths: string[]; issues: Array<{ severity: string; description: string; suggestion: string }> }
}, request: ExportRequest): string {
    if (!data.output) return '# 报告内容为空'
    const lines: string[] = []
    lines.push(`# ${data.output.title}`)
    lines.push('')
    lines.push(`> **班级**：${data.className}  |  **时间范围**：${formatDate(data.period.from)} 至 ${formatDate(data.period.to)}`)
    lines.push('')
    lines.push('> 本报告由诗脉·启明 PoeticRealm AI 系统自动生成，数据已脱敏。')
    lines.push('')

    const sections = filterExportSections(data.output.sections, request.includeSections)

    for (const section of sections) {
        lines.push(`## ${section.heading}`)
        lines.push('')
        lines.push(section.content)
        lines.push('')
    }

    if (data.output.keyFindings.length > 0) {
        lines.push('## 关键发现')
        lines.push('')
        for (const f of data.output.keyFindings) {
            lines.push(`- ${f}`)
        }
        lines.push('')
    }

    if (data.output.recommendations.length > 0) {
        lines.push('## 教学建议')
        lines.push('')
        for (const r of data.output.recommendations) {
            lines.push(`- ${r}`)
        }
        lines.push('')
    }

    if (request.includeVerification !== false && data.verification) {
        lines.push('---')
        lines.push('')
        lines.push('## AI 验收报告')
        lines.push('')
        lines.push(`- **验收结论**：${data.verification.verdict}`)
        lines.push(`- **综合评分**：${data.verification.score} / 100`)
        lines.push(`- **置信度**：${Math.round(data.verification.confidence * 100)}%`)
        if (data.verification.strengths.length > 0) {
            lines.push('- **亮点**：')
            for (const s of data.verification.strengths) {
                lines.push(`  - ${s}`)
            }
        }
        lines.push('')
    }

    return lines.join('\n')
}

/** 渲染 Word HTML（兼容 .doc） */
function renderWordHtml(data: {
    className: string
    period: { from: number; to: number }
    output?: { title: string; sections: Array<{ heading: string; content: string }>; keyFindings: string[]; recommendations: string[] }
}, request: ExportRequest): string {
    if (!data.output) return '<html><body><p>报告内容为空</p></body></html>'
    const sections = filterExportSections(data.output.sections, request.includeSections)

    const sectionsHtml = sections.map((s) => `
        <h2>${escapeHtml(s.heading)}</h2>
        <p>${escapeHtml(s.content).replace(/\n/g, '<br/>')}</p>
    `).join('')

    return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(data.output.title)}</title>
<style>
body { font-family: "Noto Sans SC", "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.8; color: #2C241A; }
h1 { font-size: 24px; color: #2C241A; border-bottom: 2px solid #C5853B; padding-bottom: 8px; }
h2 { font-size: 18px; color: #2C241A; margin-top: 24px; }
.meta { color: #6B6258; font-size: 12px; }
.badge { display: inline-block; padding: 2px 8px; background: #F5ECE0; color: #C5853B; font-size: 11px; }
</style>
</head>
<body>
<h1>${escapeHtml(data.output.title)}</h1>
<div class="meta">班级：${escapeHtml(data.className)} ｜ 时间：${formatDate(data.period.from)} 至 ${formatDate(data.period.to)}</div>
<div class="badge">AI 生成 · 数据已脱敏</div>
${sectionsHtml}
${data.output.keyFindings.length > 0 ? `<h2>关键发现</h2><ul>${data.output.keyFindings.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : ''}
${data.output.recommendations.length > 0 ? `<h2>教学建议</h2><ul>${data.output.recommendations.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
</body>
</html>`
}

/** 渲染验收信息 HTML */
function renderVerificationHtml(verification: {
    verdict: string
    score: number
    confidence: number
    strengths: string[]
    issues: Array<{ severity: string; description: string; suggestion: string }>
}): string {
    const strengthsHtml = verification.strengths.length > 0
        ? `<div class="verification-section"><h3>亮点</h3><ul>${verification.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>`
        : ''
    const issuesHtml = verification.issues.length > 0
        ? `<div class="verification-section"><h3>待改进</h3><ul>${verification.issues.map((i) => `<li><span class="severity-${escapeHtml(i.severity)}">[${escapeHtml(i.severity)}]</span> ${escapeHtml(i.description)}（建议：${escapeHtml(i.suggestion)}）</li>`).join('')}</ul></div>`
        : ''
    return `
<section class="verification">
<h2>AI 验收报告</h2>
<div class="verification-summary">
<span>验收结论：<strong>${escapeHtml(verification.verdict)}</strong></span>
<span>综合评分：<strong>${verification.score} / 100</strong></span>
<span>置信度：<strong>${Math.round(verification.confidence * 100)}%</strong></span>
</div>
${strengthsHtml}
${issuesHtml}
</section>`
}

// ─────────────────────────────────────────────────────────────
// CSS 样式
// ─────────────────────────────────────────────────────────────

function getPdfCss(): string {
    return `
body { font-family: "Noto Sans SC", "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.8; color: #2C241A; background: #FAF8F5; margin: 0; padding: 40px; }
.report-container { max-width: 800px; margin: 0 auto; background: #FFFCF8; padding: 48px; border-radius: 12px; box-shadow: 0 4px 24px rgba(44, 36, 26, 0.08); position: relative; }
.report-header { border-bottom: 2px solid #C5853B; padding-bottom: 24px; margin-bottom: 32px; }
.report-header h1 { font-size: 28px; color: #2C241A; margin: 0 0 12px 0; font-weight: 700; }
.meta { color: #6B6258; font-size: 13px; }
.badge { display: inline-block; margin-top: 12px; padding: 4px 12px; background: rgba(197, 133, 59, 0.12); color: #C5853B; border-radius: 4px; font-size: 12px; font-weight: 500; }
.report-section { margin-bottom: 32px; }
.report-section h2 { color: #2C241A; font-size: 20px; margin: 0 0 16px 0; padding-bottom: 8px; border-bottom: 1px solid rgba(44, 36, 26, 0.08); }
.section-content { color: #2C241A; }
.verification { background: rgba(197, 133, 59, 0.04); padding: 24px; border-radius: 8px; margin-top: 32px; }
.verification-summary { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 16px; }
.verification-section h3 { font-size: 15px; color: #6B6258; margin: 16px 0 8px 0; }
.watermark { position: fixed; bottom: 20px; right: 20px; color: rgba(197, 133, 59, 0.3); font-size: 11px; pointer-events: none; }
@media print { body { padding: 0; background: white; } .report-container { box-shadow: none; max-width: 100%; padding: 20px; } }
`
}

function getImageCss(): string {
    return `
body { font-family: "Noto Sans SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; background: #FAF8F5; }
.image-card { max-width: 800px; margin: 0 auto; background: linear-gradient(135deg, #FFFCF8 0%, #F5F1EC 100%); border-radius: 16px; overflow: hidden; box-shadow: 0 8px 32px rgba(44, 36, 26, 0.12); }
.card-header { padding: 32px 32px 24px; background: rgba(197, 133, 59, 0.08); border-bottom: 1px solid rgba(197, 133, 59, 0.2); }
.card-header h1 { font-size: 24px; color: #2C241A; margin: 0 0 8px 0; font-weight: 700; }
.meta { color: #6B6258; font-size: 13px; }
.card-body { padding: 32px; }
.card-section { margin-bottom: 24px; }
.card-section h2 { font-size: 17px; color: #C5853B; margin: 0 0 12px 0; font-weight: 600; }
.card-section p { color: #2C241A; font-size: 13px; line-height: 1.7; margin: 0; }
.card-section ul { color: #2C241A; font-size: 13px; line-height: 1.8; padding-left: 20px; }
.card-footer { padding: 16px 32px; background: rgba(44, 36, 26, 0.04); display: flex; justify-content: space-between; align-items: center; }
.badge { padding: 4px 12px; background: rgba(197, 133, 59, 0.12); color: #C5853B; border-radius: 4px; font-size: 11px; font-weight: 500; }
.timestamp { color: #9E968C; font-size: 11px; }
`
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

/** 生成 256-bit CSPRNG bearer token；熵源不可用时失败关闭，绝不降级到 Math.random。 */
function generateToken(): string {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const token = randomBytes(32).toString('base64url')
        if (!shareStore.has(shareLookupKey(token)) && !shareStore.has(token)) return token
    }
    throw new Error('无法生成唯一的安全分享令牌')
}

function shareLookupKey(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex')
}

function shareIdFromLookupKey(lookupKey: string): string {
    return `shr_${lookupKey.slice(0, 32)}`
}

function toManagedSharedReport(shared: StoredSharedReport): SharedReport {
    return {
        shareId: shared.shareId,
        reportId: shared.reportId,
        className: shared.className,
        title: shared.title,
        createdAt: shared.createdAt,
        expireAt: shared.expireAt,
        viewCount: shared.viewCount,
        lastViewedAt: shared.lastViewedAt,
    }
}

function toPublicSharedReport(shared: StoredSharedReport): PublicSharedReport {
    return {
        className: shared.className,
        title: shared.title,
        contentHtml: shared.contentHtml,
        createdAt: shared.createdAt,
        expireAt: shared.expireAt,
    }
}

function legacyToStored(legacy: LegacySharedReport, lookupKey: string): StoredSharedReport {
    return {
        shareId: legacy.shareId ?? shareIdFromLookupKey(lookupKey),
        reportId: legacy.reportId,
        className: legacy.className,
        title: legacy.title,
        contentHtml: legacy.contentHtml,
        createdAt: legacy.createdAt,
        expireAt: legacy.expireAt,
        viewCount: legacy.viewCount,
        lastViewedAt: legacy.lastViewedAt,
        teacherId: legacy.teacherId,
    }
}

function migrateLegacyTokenOnRead(token: string, lookupKey: string): StoredSharedReport | undefined {
    const legacy = shareStore.get(token) as unknown as LegacySharedReport | undefined
    if (!legacy) return undefined
    const stored = legacyToStored(legacy, lookupKey)
    shareStore.set(lookupKey, stored)
    if (token !== lookupKey) shareStore.delete(token)
    return stored
}

function migrateLegacyShares(): void {
    const hashedKeyPattern = /^[a-f0-9]{64}$/u
    for (const [storedKey, raw] of shareStore) {
        const legacy = raw as unknown as LegacySharedReport
        const embeddedToken = typeof legacy.token === 'string' && legacy.token.length > 0
            ? legacy.token
            : undefined
        const bearerToken = embeddedToken ?? (!hashedKeyPattern.test(storedKey) ? storedKey : undefined)
        if (!bearerToken) continue

        const lookupKey = shareLookupKey(bearerToken)
        shareStore.set(lookupKey, legacyToStored(legacy, lookupKey))
        if (storedKey !== lookupKey) shareStore.delete(storedKey)
    }
}

/**
 * 公开分享专用的确定性内容脱敏。
 *
 * 发现可识别个体的行时删除整行，而不是只遮住姓名后继续公开该生的诊断；
 * 随后再做一次逐词与通用模式替换，兜住跨行或非常规排版。原始私有报告不变。
 */
export function redactPublicReportContent(
    content: string,
    sensitiveTerms: readonly string[] = [],
): string {
    const terms = [...new Set(sensitiveTerms
        .map((value) => value.trim())
        .filter((value) => value.length >= 2))]
        .sort((left, right) => right.length - left.length)

    const containsPii = (line: string): boolean => (
        terms.some((term) => line.includes(term))
        || PUBLIC_PII_DETECTORS.some((pattern) => pattern.test(line))
    )

    const redactedLines: string[] = []
    let previousWasRedacted = false
    for (const line of content.split(/\r?\n/u)) {
        if (containsPii(line)) {
            if (!previousWasRedacted) redactedLines.push(PUBLIC_REDACTION_NOTICE)
            previousWasRedacted = true
            continue
        }
        redactedLines.push(line)
        previousWasRedacted = false
    }

    let result = redactedLines.join('\n')
    for (const term of terms) result = result.split(term).join(PUBLIC_REDACTION_NOTICE)
    for (const pattern of PUBLIC_PII_REPLACERS) {
        result = result.replace(pattern, PUBLIC_REDACTION_NOTICE)
    }
    return result
}

/** HTML 转义 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

/** 阻断 CSV/Excel 公式注入；加引号本身并不会阻止 Excel 执行 =、+、-、@ 开头的单元格。 */
export function neutralizeSpreadsheetFormula(value: string): string {
    return /^\s*[=+@-]/.test(value) ? `'${value}` : value
}

/** 格式化日期 */
function formatDate(ms: number): string {
    const d = new Date(ms)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

/** 简易 Markdown → HTML 转换（用于分享链接内容） */
function markdownToHtml(md: string): string {
    const lines = md.split('\n')
    const html: string[] = []
    let inList = false
    let inCodeBlock = false
    let codeLines: string[] = []

    for (const line of lines) {
        if (line.startsWith('```')) {
            if (inCodeBlock) {
                html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
                codeLines = []
                inCodeBlock = false
            } else {
                inCodeBlock = true
            }
            continue
        }
        if (inCodeBlock) {
            codeLines.push(line)
            continue
        }
        if (inList && !line.match(/^\s*[-*]\s/) && !line.match(/^\s*\d+\.\s/)) {
            html.push('</ul>')
            inList = false
        }
        const h1 = line.match(/^# (.+)$/)
        if (h1) { html.push(`<h1>${escapeHtml(h1[1]!)}</h1>`); continue }
        const h2 = line.match(/^## (.+)$/)
        if (h2) { html.push(`<h2>${escapeHtml(h2[1]!)}</h2>`); continue }
        const bq = line.match(/^> (.+)$/)
        if (bq) { html.push(`<blockquote>${escapeHtml(bq[1]!)}</blockquote>`); continue }
        if (line.match(/^---+$/)) { html.push('<hr/>'); continue }
        const ul = line.match(/^\s*[-*]\s(.+)$/)
        if (ul) {
            if (!inList) { html.push('<ul>'); inList = true }
            html.push(`<li>${escapeHtml(ul[1]!)}</li>`)
            continue
        }
        if (line.trim() === '') continue
        html.push(`<p>${escapeHtml(line)}</p>`)
    }
    if (inList) html.push('</ul>')
    if (inCodeBlock && codeLines.length > 0) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
    }
    return html.join('\n')
}

// 显式引用 db / repos 防止未使用警告（若未来需要查询 DB 可启用）
void db
void repos
