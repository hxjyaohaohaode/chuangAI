import { readBoundedResponseBody } from './bounded-response.js'
import { maskString } from '../lib/logger/sanitize.js'

export const MAX_PROVIDER_ERROR_RESPONSE_BYTES = 64 * 1024
export const MAX_PROVIDER_JSON_RESPONSE_BYTES = 1024 * 1024
const PROVIDER_TOKEN_PATTERN = /\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/giu

/** 供应商错误可能回显当前密钥；先移除秘密和 PII，再做 300 字符展示截断。 */
export function sanitizeProviderDetail(value: string, currentApiKey: string): string {
    const withoutExactKey = currentApiKey
        ? value.split(currentApiKey).join('[REDACTED]')
        : value
    return maskString(withoutExactKey.replace(PROVIDER_TOKEN_PATTERN, '[REDACTED]')).slice(0, 300)
}

/** 连通性检测只保留受限错误文本；允许错误状态和空正文。 */
export async function readBoundedProviderErrorText(response: Response, label: string): Promise<string> {
    const bytes = await readBoundedResponseBody(response, {
        maxBytes: MAX_PROVIDER_ERROR_RESPONSE_BYTES,
        label,
        requireOk: false,
        allowEmpty: true,
    })
    return bytes.toString('utf8')
}

/** Wan 等供应商 JSON 响应必须是 JSON MIME，且声明/实际正文均不超过 1MiB。 */
export async function readBoundedProviderJson<T>(response: Response, label: string): Promise<T> {
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
    if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
        throw new Error(`${label}响应类型不是 JSON`)
    }
    const bytes = await readBoundedResponseBody(response, {
        maxBytes: MAX_PROVIDER_JSON_RESPONSE_BYTES,
        label,
        requireOk: false,
    })
    try {
        return JSON.parse(bytes.toString('utf8')) as T
    } catch {
        throw new Error(`${label}响应不是有效 JSON`)
    }
}
