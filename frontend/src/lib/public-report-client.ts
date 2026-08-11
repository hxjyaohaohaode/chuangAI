import { parseGetSharedReportResponse, PublicShareAccessError, isValidShareToken } from './report-share-contract'
import type { GetSharedReportResponse } from './types'

const PUBLIC_REPORT_TIMEOUT_MS = 15_000
const MAX_PUBLIC_RESPONSE_BYTES = 400_000

function cancelResponseBody(response: Response): void {
    try {
        void response.body?.cancel().catch(() => undefined)
    } catch {
        // 部分 WebView 的 body/cancel 实现不完整；失败仍由外层安全状态收敛。
    }
}

/**
 * 对 chunked / 缺失 Content-Length 的响应也执行真实字节上限。
 * response.text() 会先把整个正文读入内存，再检查字符串长度；异常网关若持续
 * 推送正文，旧做法会在“失败关闭”之前先耗尽标签页内存。
 */
async function readBoundedResponseText(response: Response): Promise<string> {
    if (!response.body) {
        const text = await response.text()
        if (new TextEncoder().encode(text).byteLength > MAX_PUBLIC_RESPONSE_BYTES) {
            throw new PublicShareAccessError('invalid-response')
        }
        return text
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let byteLength = 0
    let text = ''
    let completed = false
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            byteLength += value.byteLength
            if (byteLength > MAX_PUBLIC_RESPONSE_BYTES) {
                throw new PublicShareAccessError('invalid-response')
            }
            text += decoder.decode(value, { stream: true })
        }
        text += decoder.decode()
        completed = true
        return text
    } finally {
        if (!completed) {
            try {
                await reader.cancel()
            } catch {
                // 原始读取/取消失败均由调用方收敛为不含 URL/token 的安全错误。
            }
        }
        reader.releaseLock()
    }
}

function linkAbortSignal(
    externalSignal: AbortSignal | undefined,
    controller: AbortController,
): () => void {
    if (!externalSignal) return () => undefined
    if (externalSignal.aborted) {
        controller.abort()
        return () => undefined
    }
    const onAbort = () => controller.abort()
    externalSignal.addEventListener('abort', onAbort, { once: true })
    return () => externalSignal.removeEventListener('abort', onAbort)
}

/**
 * 匿名公开页专用客户端。
 *
 * 这里刻意不复用带会话、CSRF、DEV 路径日志和登录跳转的通用 API 客户端，
 * 从模块依赖和请求参数两侧保证 bearer token 不接触认证侧副作用：
 * - 不携带 Cookie；
 * - 不发送 Referer；
 * - 不允许重定向；
 * - 限制响应大小并运行时校验 HTML/DTO；
 * - 所有错误均不包含 token、URL 或后端原始正文。
 */
export async function fetchPublicSharedReport(
    token: string,
    externalSignal?: AbortSignal,
): Promise<GetSharedReportResponse> {
    if (!isValidShareToken(token)) throw new PublicShareAccessError('unavailable')

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), PUBLIC_REPORT_TIMEOUT_MS)
    const unlink = linkAbortSignal(externalSignal, controller)

    try {
        let response: Response
        try {
            response = await globalThis.fetch(
                `/api/report/shared/${encodeURIComponent(token)}`,
                {
                    method: 'GET',
                    headers: { Accept: 'application/json' },
                    credentials: 'omit',
                    cache: 'no-store',
                    redirect: 'error',
                    referrerPolicy: 'no-referrer',
                    mode: 'same-origin',
                    signal: controller.signal,
                },
            )
        } catch {
            throw new PublicShareAccessError('network')
        }

        if (response.status === 404) {
            cancelResponseBody(response)
            throw new PublicShareAccessError('unavailable')
        }
        if (!response.ok) {
            cancelResponseBody(response)
            throw new PublicShareAccessError('network')
        }

        const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
        const declaredLength = Number(response.headers.get('content-length') ?? '0')
        if (!contentType.includes('application/json')
            || (Number.isFinite(declaredLength) && declaredLength > MAX_PUBLIC_RESPONSE_BYTES)) {
            cancelResponseBody(response)
            throw new PublicShareAccessError('invalid-response')
        }

        let raw: unknown
        try {
            const text = await readBoundedResponseText(response)
            if (text.length === 0) {
                throw new PublicShareAccessError('invalid-response')
            }
            raw = JSON.parse(text) as unknown
        } catch (error) {
            if (error instanceof PublicShareAccessError) throw error
            // fetch() may resolve before the body is consumed. If the timeout or
            // caller aborts while response.text() is pending, this is a network
            // failure—not an invalid server payload.
            if (controller.signal.aborted) throw new PublicShareAccessError('network')
            throw new PublicShareAccessError('invalid-response')
        }

        try {
            return parseGetSharedReportResponse(raw)
        } catch {
            throw new PublicShareAccessError('invalid-response')
        }
    } finally {
        window.clearTimeout(timeoutId)
        unlink()
    }
}
