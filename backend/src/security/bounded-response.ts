export interface BoundedResponseOptions {
    maxBytes: number
    label: string
    /** 错误响应也需要受限读取时可关闭；默认要求 2xx。 */
    requireOk?: boolean
    /** 供应商错误响应可能合法地没有正文；媒体响应默认不允许空体。 */
    allowEmpty?: boolean
}

/**
 * 读取外部二进制响应时同时约束声明长度和实际流式累计长度。
 * Content-Length 只能作为快速拒绝依据；chunked 或伪造长度仍由逐块累计兜底。
 */
export async function readBoundedResponseBody(
    response: Response,
    options: BoundedResponseOptions,
): Promise<Buffer> {
    const { maxBytes, label, requireOk = true, allowEmpty = false } = options
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new Error(`${label}字节上限配置无效`)
    }
    if (requireOk && !response.ok) {
        throw new Error(`${label}请求失败：HTTP ${response.status}`)
    }

    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null) {
        if (!/^\d+$/u.test(declaredLength)) {
            throw new Error(`${label}响应长度无效`)
        }
        const parsedLength = Number(declaredLength)
        if (!Number.isSafeInteger(parsedLength)
            || parsedLength < 0
            || (!allowEmpty && parsedLength === 0)
            || parsedLength > maxBytes) {
            throw new Error(`${label}响应超过字节上限`)
        }
    }

    if (!response.body) {
        if (allowEmpty) return Buffer.alloc(0)
        throw new Error(`${label}响应体为空`)
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value || value.byteLength === 0) continue
            totalBytes += value.byteLength
            if (totalBytes > maxBytes) {
                await reader.cancel(`${label} exceeds byte limit`)
                throw new Error(`${label}响应超过字节上限`)
            }
            chunks.push(value)
        }
    } finally {
        reader.releaseLock()
    }

    if (totalBytes === 0) {
        if (allowEmpty) return Buffer.alloc(0)
        throw new Error(`${label}响应体为空`)
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes)
}
