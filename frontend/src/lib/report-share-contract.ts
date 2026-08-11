import type {
    CreateShareResponse,
    CreatedSharedReport,
    GetSharedReportResponse,
    ListSharedReportsResponse,
    PreviewShareResponse,
    PublicSharePreview,
    PublicSharedReport,
    SharedReport,
} from './types'

const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/u
const SHARE_ID_PATTERN = /^shr_[a-f0-9]{32}$/u
const PREVIEW_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u
const MAX_PUBLIC_HTML_LENGTH = 250_000
const MAX_TITLE_LENGTH = 500
const MAX_CLASS_NAME_LENGTH = 120
const MAX_PUBLIC_SHARE_TTL_MS = 90 * 24 * 60 * 60 * 1000

const CONTAINER_TAGS = new Set([
    'h1',
    'h2',
    'p',
    'blockquote',
    'ul',
    'li',
    'pre',
    'code',
    'strong',
    'em',
])
const VOID_TAGS = new Set(['hr', 'br'])

export type PublicShareAccessFailure = 'unavailable' | 'network' | 'invalid-response'

/** 不携带 URL、token 或后端原始正文的公开页安全错误。 */
export class PublicShareAccessError extends Error {
    constructor(public readonly reason: PublicShareAccessFailure) {
        super(reason === 'unavailable'
            ? '分享链接不可用'
            : reason === 'network'
                ? '网络连接失败'
                : '分享内容校验失败')
        this.name = 'PublicShareAccessError'
    }
}

export function isValidShareToken(token: string): boolean {
    return SHARE_TOKEN_PATTERN.test(token)
}

export function isValidPreviewFingerprint(value: string): boolean {
    return PREVIEW_FINGERPRINT_PATTERN.test(value)
}

/**
 * 公开报告 HTML 是服务端简化 Markdown 转换器的产物。客户端仍然失败关闭：
 * 仅允许无属性的排版标签，禁止 img/link/style/form/script 以及任何事件属性。
 * 返回值可放入同时受 sandbox 和 CSP 约束的 srcDoc，不能用于主 DOM innerHTML。
 */
export function sanitizePublicReportHtml(input: string): string {
    if (input.length === 0 || input.length > MAX_PUBLIC_HTML_LENGTH || input.includes('\0')) {
        throw new TypeError('公开报告 HTML 长度非法')
    }

    const stack: string[] = []
    const output: string[] = []
    const tagPattern = /<[^>]*>/gu
    let cursor = 0

    for (const match of input.matchAll(tagPattern)) {
        const index = match.index
        const rawTag = match[0]
        const text = input.slice(cursor, index)
        if (/[<>]/u.test(text)) throw new TypeError('公开报告含未转义尖括号')
        output.push(text)

        const container = rawTag.match(/^<(\/)?(h1|h2|p|blockquote|ul|li|pre|code|strong|em)>$/u)
        if (container) {
            const closing = container[1] === '/'
            const name = container[2]!
            if (!CONTAINER_TAGS.has(name)) throw new TypeError('公开报告标签非法')
            if (closing) {
                if (stack.pop() !== name) throw new TypeError('公开报告标签嵌套非法')
            } else {
                stack.push(name)
            }
            output.push(rawTag)
            cursor = index + rawTag.length
            continue
        }

        const voidTag = rawTag.match(/^<(hr|br)\s*\/?>$/u)
        if (!voidTag || !VOID_TAGS.has(voidTag[1]!)) {
            throw new TypeError('公开报告包含不允许的 HTML')
        }
        output.push(`<${voidTag[1]}>`)
        cursor = index + rawTag.length
    }

    const tail = input.slice(cursor)
    if (/[<>]/u.test(tail) || stack.length > 0) {
        throw new TypeError('公开报告 HTML 不完整')
    }
    output.push(tail)
    return output.join('')
}

function asObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label}必须是对象`)
    }
    return value as Record<string, unknown>
}

function requireOkEnvelope(record: Record<string, unknown>, label: string): void {
    if (record.status !== 'ok') {
        throw new TypeError(`${label}.status 必须为 ok`)
    }
}

function boundedString(
    value: unknown,
    label: string,
    maximum: number,
    minimum = 1,
): string {
    if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
        throw new TypeError(`${label}长度非法`)
    }
    return value
}

function timestamp(value: unknown, label: string): number {
    if (typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value <= 0
        || Number.isNaN(new Date(value).getTime())) {
        throw new TypeError(`${label}必须是有效时间戳`)
    }
    return value
}

function requireValidShareWindow(createdAt: number, expireAt: number, label: string): void {
    const ttl = expireAt - createdAt
    if (ttl <= 0 || ttl > MAX_PUBLIC_SHARE_TTL_MS) {
        throw new TypeError(`${label}.expireAt 必须晚于 createdAt 且有效期不超过 90 天`)
    }
}

function nonNegativeInteger(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label}必须是非负整数`)
    }
    return value
}

function parsePreview(value: unknown, label: string): PublicSharePreview {
    const record = asObject(value, label)
    for (const forbidden of ['token', 'teacherId', 'reportId', 'shareId', 'viewCount', 'lastViewedAt']) {
        if (forbidden in record) throw new TypeError(`${label}泄漏管理面字段`)
    }
    return {
        className: boundedString(record.className, `${label}.className`, MAX_CLASS_NAME_LENGTH),
        title: boundedString(record.title, `${label}.title`, MAX_TITLE_LENGTH),
        contentHtml: sanitizePublicReportHtml(
            boundedString(record.contentHtml, `${label}.contentHtml`, MAX_PUBLIC_HTML_LENGTH),
        ),
    }
}

function parsePublicReport(value: unknown): PublicSharedReport {
    const record = asObject(value, 'shared')
    const preview = parsePreview(record, 'shared')
    const createdAt = timestamp(record.createdAt, 'shared.createdAt')
    const expireAt = timestamp(record.expireAt, 'shared.expireAt')
    requireValidShareWindow(createdAt, expireAt, 'shared')
    return { ...preview, createdAt, expireAt }
}

function parseManagedShare(value: unknown, label: string, withToken: boolean): SharedReport | CreatedSharedReport {
    const record = asObject(value, label)
    if ('teacherId' in record || 'contentHtml' in record || (!withToken && 'token' in record)) {
        throw new TypeError(`${label}泄漏私密字段`)
    }
    const createdAt = timestamp(record.createdAt, `${label}.createdAt`)
    const expireAt = timestamp(record.expireAt, `${label}.expireAt`)
    requireValidShareWindow(createdAt, expireAt, label)
    const shareId = boundedString(record.shareId, `${label}.shareId`, 64)
    if (!SHARE_ID_PATTERN.test(shareId)) throw new TypeError(`${label}.shareId 格式非法`)

    const base: SharedReport = {
        shareId,
        reportId: boundedString(record.reportId, `${label}.reportId`, 128),
        className: boundedString(record.className, `${label}.className`, MAX_CLASS_NAME_LENGTH),
        title: boundedString(record.title, `${label}.title`, MAX_TITLE_LENGTH),
        createdAt,
        expireAt,
        viewCount: nonNegativeInteger(record.viewCount, `${label}.viewCount`),
        lastViewedAt: record.lastViewedAt === null
            ? null
            : timestamp(record.lastViewedAt, `${label}.lastViewedAt`),
    }
    if (base.lastViewedAt !== null
        && (base.lastViewedAt < createdAt || base.lastViewedAt > expireAt)) {
        throw new TypeError(`${label}.lastViewedAt 必须位于分享有效期内`)
    }
    if (!withToken) return base
    const token = boundedString(record.token, `${label}.token`, 128, 20)
    if (!isValidShareToken(token)) throw new TypeError(`${label}.token 格式非法`)
    return { ...base, token }
}

function requireAiGenerated(record: Record<string, unknown>, label: string): true {
    if (record.aiGenerated !== true) throw new TypeError(`${label}.aiGenerated 必须为 true`)
    return true
}

export function parsePreviewShareResponse(value: unknown): PreviewShareResponse {
    const record = asObject(value, 'previewResponse')
    requireOkEnvelope(record, 'previewResponse')
    const previewFingerprint = boundedString(
        record.previewFingerprint,
        'previewResponse.previewFingerprint',
        64,
        64,
    )
    if (!isValidPreviewFingerprint(previewFingerprint)) {
        throw new TypeError('previewResponse.previewFingerprint 格式非法')
    }
    return {
        preview: parsePreview(record.preview, 'previewResponse.preview'),
        previewFingerprint,
        aiGenerated: requireAiGenerated(record, 'previewResponse'),
    }
}

export function parseCreateShareResponse(value: unknown): CreateShareResponse {
    const record = asObject(value, 'createResponse')
    requireOkEnvelope(record, 'createResponse')
    return {
        shared: parseManagedShare(record.shared, 'createResponse.shared', true) as CreatedSharedReport,
        aiGenerated: requireAiGenerated(record, 'createResponse'),
    }
}

export function parseGetSharedReportResponse(value: unknown): GetSharedReportResponse {
    const record = asObject(value, 'publicResponse')
    requireOkEnvelope(record, 'publicResponse')
    return {
        shared: parsePublicReport(record.shared),
        aiGenerated: requireAiGenerated(record, 'publicResponse'),
    }
}

export function parseListSharedReportsResponse(value: unknown): ListSharedReportsResponse {
    const record = asObject(value, 'listResponse')
    requireOkEnvelope(record, 'listResponse')
    if (!Array.isArray(record.shares) || record.shares.length > 500) {
        throw new TypeError('listResponse.shares 格式非法')
    }
    const shares = record.shares.map((share, index) => (
        parseManagedShare(share, `listResponse.shares[${index}]`, false) as SharedReport
    ))
    const total = nonNegativeInteger(record.total, 'listResponse.total')
    if (total !== shares.length) throw new TypeError('listResponse.total 与 shares 不一致')
    return { shares, total }
}

function escapeDocumentText(value: string): string {
    return value
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&#39;')
}

/** 构造无脚本、无网络、无表单能力的 iframe 独立文档。 */
export function buildSandboxedReportDocument(preview: PublicSharePreview): string {
    const safeHtml = sanitizePublicReportHtml(preview.contentHtml)
    const safeTitle = escapeDocumentText(preview.title)
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; style-src 'unsafe-inline'">
<title>${safeTitle}</title>
<style>
:root{color-scheme:light;--ink:#2c241a;--muted:#6b6258;--paper:#fffdf9;--wash:#f5f1ec;--accent:#986227;--line:rgba(44,36,26,.12)}
*{box-sizing:border-box}html{background:var(--paper)}body{margin:0;padding:clamp(20px,5vw,56px);background:var(--paper);color:var(--ink);font-family:"Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;font-size:16px;line-height:1.82;overflow-wrap:anywhere}
main{max-width:820px;margin:0 auto}h1,h2{font-family:"Noto Serif SC",STSong,serif;text-wrap:balance}h1{margin:0 0 32px;font-size:clamp(28px,5vw,40px);line-height:1.25;letter-spacing:.06em}h2{margin:40px 0 14px;font-size:clamp(20px,3vw,25px);line-height:1.4;color:var(--accent)}p{margin:0 0 16px}blockquote{margin:20px 0;padding:14px 18px;border-left:4px solid var(--accent);background:var(--wash);color:var(--muted)}ul{padding-inline-start:1.4em;margin:0 0 20px}li+li{margin-top:8px}hr{border:0;border-top:1px solid var(--line);margin:36px 0}pre{max-width:100%;overflow:auto;padding:16px;background:var(--wash);border-radius:10px}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em}strong{font-weight:700}::selection{background:rgba(152,98,39,.2)}
@media(max-width:520px){body{padding:24px 18px;font-size:15px}h1{margin-bottom:24px}h2{margin-top:30px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
@media(forced-colors:active){body{background:Canvas;color:CanvasText}blockquote,pre{background:Canvas;border:1px solid CanvasText}h2{color:CanvasText}hr{border-color:CanvasText}}
@media print{@page{margin:16mm}body{padding:0;background:#fff;color:#000;font-size:11pt}main{max-width:none}blockquote,pre{break-inside:avoid}h1,h2{break-after:avoid}h2{color:#000}}
</style>
</head>
<body><main>${safeHtml}</main></body>
</html>`
}

export function buildPublicShareUrl(token: string, origin: string): string {
    if (!isValidShareToken(token)) throw new TypeError('分享 token 格式非法')
    const base = new URL(origin)
    if ((base.protocol !== 'https:' && base.protocol !== 'http:')
        || base.username || base.password || base.search || base.hash) {
        throw new TypeError('分享站点 origin 非法')
    }
    const target = new URL(`/shared/report/${encodeURIComponent(token)}`, base.origin)
    return target.toString()
}

/** localhost 允许 HTTP 做本机演示；非本机链接必须 HTTPS 才能对外发送。 */
export function isSecurePublicShareOrigin(origin: string): boolean {
    try {
        const url = new URL(origin)
        if (url.protocol === 'https:') return true
        return url.protocol === 'http:'
            && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    } catch {
        return false
    }
}
