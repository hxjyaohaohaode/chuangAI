/**
 * 敏感信息脱敏工具
 *
 * 提供两层防护：
 * 1. 静态 redact paths —— 用于 Pino logger 配置，对已知字段路径自动打码
 * 2. 运行时 sanitize() —— 用于任意对象的递归脱敏（如 LLM prompt 内容、错误上下文）
 *
 * 覆盖的 PII 类别：
 * - API 密钥（apiKey / api_key / x-api-key / authorization）
 * - 密码（password / passwd / pwd / secret / token）
 * - 手机号（11 位中国大陆手机号）
 * - 身份证号（18 位）
 * - 邮箱地址
 * - 银行卡号（16-19 位）
 */

// ─────────────────────────────────────────────────────────────
// 敏感字段名识别
// ─────────────────────────────────────────────────────────────

/**
 * 敏感字段名列表（小写匹配）
 * 命中任一即视为敏感字段，值替换为 [REDACTED]
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
    /^api[-_]?key$/i,
    /^api[-_]?secret$/i,
    /^secret[-_]?key$/i,
    /^access[-_]?token$/i,
    /^refresh[-_]?token$/i,
    /^auth[-_]?token$/i,
    /^bearer$/i,
    /^authorization$/i,
    /^password$/i,
    /^passwd$/i,
    /^pwd$/i,
    /^secret$/i,
    /^token$/i,
    /^private[-_]?key$/i,
    /^client[-_]?secret$/i,
    /^session[-_]?id$/i,
    /^cookie$/i,
    /^set[-_]?cookie$/i,
]

/**
 * 判断字段名是否敏感
 */
export function isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key))
}

// ─────────────────────────────────────────────────────────────
// PII 正则模式
// ─────────────────────────────────────────────────────────────

/** 中国大陆手机号：1 开头 11 位 */
const PHONE_REGEX = /1[3-9]\d{9}/g

/** 18 位身份证号（含末位 X） */
const ID_CARD_REGEX = /\d{17}[\dXx]/g

/** 邮箱地址 */
const EMAIL_REGEX = /[\w.+-]+@[\w-]+\.[\w.-]+/g

/** 银行卡号：16-19 位连续数字 */
const BANK_CARD_REGEX = /\b\d{16,19}\b/g

/**
 * 对字符串内容进行 PII 脱敏
 * - 手机号：保留前 3 位 + 后 4 位，中间 4 位用 * 替换
 * - 身份证号：保留前 6 位 + 后 4 位，中间 8 位用 * 替换
 * - 邮箱：用户名保留首字符 + ***@域名
 * - 银行卡号：保留前 4 位 + 后 4 位
 */
export function maskString(input: string): string {
    return input
        .replace(PHONE_REGEX, (m) => `${m.slice(0, 3)}****${m.slice(-4)}`)
        .replace(ID_CARD_REGEX, (m) => `${m.slice(0, 6)}********${m.slice(-4)}`)
        .replace(EMAIL_REGEX, (m) => {
            const atIdx = m.indexOf('@')
            if (atIdx <= 1) return m
            const user = m.slice(0, atIdx)
            const domain = m.slice(atIdx)
            return `${user[0]}***${domain}`
        })
        .replace(BANK_CARD_REGEX, (m) => `${m.slice(0, 4)}********${m.slice(-4)}`)
}

/**
 * URL 中的公开分享 token 是 bearer capability，不能进入应用访问日志。
 * 同时处理常见 token 查询参数；保留路由形状，便于监控按端点聚合。
 */
export function redactBearerTokensFromUrl(input: string): string {
    return input
        .replace(
            /(\/api\/report\/shared\/)[^/?#]+/giu,
            '$1[REDACTED_BEARER]',
        )
        .replace(
            /(\/shared\/report\/)[^/?#]+/giu,
            '$1[REDACTED_BEARER]',
        )
        .replace(
            /([?&](?:token|shareToken)=)[^&#]*/giu,
            '$1[REDACTED_BEARER]',
        )
}

// ─────────────────────────────────────────────────────────────
// Pino redact paths
// ─────────────────────────────────────────────────────────────

/**
 * Pino 内置 redact 配置路径
 *
 * 覆盖常见敏感字段路径（包含 req.headers / err.config 等嵌套场景）。
 * 命中字段值会被替换为 '[REDACTED]'，避免日志泄露密钥。
 */
export const REDACT_PATHS: readonly string[] = [
    // HTTP 请求头
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'req.headers["x-authorization"]',
    'req.headers["x-auth-token"]',
    'req.headers["x-session-id"]',
    'req.headers.apiKey',
    'req.headers.apikey',
    'req.headers.password',
    'req.headers.token',

    // 请求体常见字段
    'req.body.password',
    'req.body.passwd',
    'req.body.pwd',
    'req.body.apiKey',
    'req.body.api_key',
    'req.body.token',
    'req.body.secret',
    'req.body.phoneNumber',
    'req.body.phone',
    'req.body.mobile',
    'req.body.idCard',
    'req.body.idNumber',

    // 响应体
    'res.headers["set-cookie"]',
    'res.headers.authorization',

    // 错误对象（OpenAI SDK 错误含 config.headers）
    'err.config.headers',
    'err.config.apiKey',
    'err.headers.authorization',
    'err.options.apiKey',
    'err.options.headers.authorization',

    // LLM 调用参数中的密钥
    'apiKey',
    'api_key',
    'metadata.apiKey',
    'config.apiKey',
    'config.headers',
]

/** redact 替换标记 */
export const REDACT_CENSOR = '[REDACTED]'

// ─────────────────────────────────────────────────────────────
// 递归脱敏
// ─────────────────────────────────────────────────────────────

/**
 * 递归脱敏任意对象
 *
 * 用于将对象在日志输出前进行深度清理：
 * 1. 敏感字段名 → [REDACTED]
 * 2. 字符串值中的 PII（手机号 / 身份证 / 邮箱 / 银行卡）→ mask
 *
 * 处理对象、数组、字符串；number / boolean / null / undefined 原样返回。
 * 循环引用安全（通过 WeakSet 记录已访问对象）。
 *
 * @param value 待脱敏的任意值
 * @param maxDepth 最大递归深度，默认 10，防止极端嵌套
 */
export function sanitize<T>(value: T, maxDepth = 10): T {
    const seen = new WeakSet<object>()
    return walk(value, 0, maxDepth, seen) as T
}

function walk(
    value: unknown,
    depth: number,
    maxDepth: number,
    seen: WeakSet<object>,
): unknown {
    if (value === null || value === undefined) return value

    // 字符串：执行 PII 掩码
    if (typeof value === 'string') {
        return maskString(value)
    }

    // 数字 / 布尔 / 函数 / Symbol：原样返回
    if (typeof value !== 'object') return value

    // 防止循环引用与超出深度
    if (depth >= maxDepth) return '[MaxDepth]'
    if (seen.has(value as object)) return '[Circular]'
    seen.add(value as object)

    // 数组
    if (Array.isArray(value)) {
        return value.map((item) => walk(item, depth + 1, maxDepth, seen))
    }

    // 普通对象
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (isSensitiveKey(key)) {
            result[key] = REDACT_CENSOR
        } else {
            result[key] = walk(val, depth + 1, maxDepth, seen)
        }
    }
    return result
}
