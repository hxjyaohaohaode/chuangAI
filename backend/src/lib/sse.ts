/**
 * Small, dependency-free primitives for Fastify routes that hijack an HTTP
 * response for SSE. They deliberately model only the Node events we need so
 * they can be deterministically tested without a socket or an LLM provider.
 */
export interface SseRequestLike {
    aborted?: boolean
    once(event: 'aborted', listener: () => void): unknown
    removeListener(event: 'aborted', listener: () => void): unknown
}

export interface SseResponseLike {
    destroyed: boolean
    writableEnded: boolean
    write(chunk: string): boolean
    once(event: 'drain' | 'close', listener: () => void): unknown
    removeListener(event: 'drain' | 'close', listener: () => void): unknown
}

export const DEFAULT_SSE_BACKPRESSURE_TIMEOUT_MS = 15_000

const PUBLIC_SSE_ERROR_MESSAGES = {
    CHAT_STREAM_FAILED: 'AI 对话生成失败，请稍后重试',
    LLM_STREAM_FAILED: 'AI 副驾响应失败，请稍后重试',
    LEARNING_PATH_GENERATE_FAILED: '学习路径生成失败，请稍后重试',
    PRESCRIPTION_GENERATE_FAILED: '个性化处方生成失败，请稍后重试',
    AI_STREAM_FAILED: '课堂 AI 内容生成失败，请稍后重试',
    COMMENT_STREAM_FAILED: '课堂点评生成失败，请稍后重试',
    LESSON_GENERATE_FAILED: '教案生成失败，请稍后重试',
    LESSON_REFINE_FAILED: '教案精修失败，请稍后重试',
    AGENT_ORCHESTRATION_FAILED: '多智能体编排失败，请稍后重试',
} as const

export type PublicSseErrorCode = keyof typeof PUBLIC_SSE_ERROR_MESSAGES

/**
 * Turn an internal/provider failure into the only error shape allowed after an
 * SSE response has been hijacked. The cause is accepted so callers cannot be
 * tempted to interpolate it into the payload; it is intentionally discarded.
 * Routes must log the cause server-side before calling this boundary.
 */
export function createPublicSseError(
    code: PublicSseErrorCode,
    _cause?: unknown,
): { error: PublicSseErrorCode; message: string } {
    return { error: code, message: PUBLIC_SSE_ERROR_MESSAGES[code] }
}

const PRIVATE_REASONING_FIELD_NAMES = new Set(['reasoning', 'reasoningcontent'])
const PRIVATE_REASONING_REDACTED_COMMENT = ': private-reasoning-redacted\n\n'

function removePrivateReasoning(value: unknown, seen: WeakSet<object>): unknown {
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return undefined
    seen.add(value)
    if (Array.isArray(value)) {
        return value
            .map((item) => removePrivateReasoning(item, seen))
            .filter((item) => item !== undefined)
    }

    const source = value as Record<string, unknown>
    // Lesson-plan streams historically encoded provider chain-of-thought as a
    // whole `{ type: 'reasoning', content }` frame. Dropping the whole frame is
    // safer than relabelling secret text as ordinary content.
    if (source.type === 'reasoning') return undefined

    const safe: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(source)) {
        const normalizedKey = key.replace(/[-_]/gu, '').toLowerCase()
        if (PRIVATE_REASONING_FIELD_NAMES.has(normalizedKey)) continue
        const sanitized = removePrivateReasoning(item, seen)
        if (sanitized !== undefined) safe[key] = sanitized
    }
    return Object.keys(safe).length > 0 ? safe : undefined
}

/**
 * Serialize one SSE frame while enforcing the server's no-chain-of-thought
 * boundary. Provider `reasoning`/`reasoning_content` is never client data; a
 * reasoning-only frame becomes an SSE comment, which browsers intentionally
 * ignore while the normal loading state remains visible.
 */
export function formatSseFrame(payload: unknown): string {
    if (payload === '[DONE]') return 'data: [DONE]\n\n'
    const safePayload = removePrivateReasoning(payload, new WeakSet())
    return safePayload === undefined
        ? PRIVATE_REASONING_REDACTED_COMMENT
        : `data: ${JSON.stringify(safePayload)}\n\n`
}

function isUnavailable(response: SseResponseLike, signal: AbortSignal): boolean {
    return signal.aborted || response.destroyed || response.writableEnded
}

/**
 * Abort exactly once for either half of an HTTP connection disappearing. An
 * outgoing ServerResponse emits `close`; an IncomingMessage emits `aborted`.
 * Both listeners are removed by the returned cleanup function on normal,
 * failed and cancellation paths.
 */
export function bindSseDisconnectAbort(
    request: SseRequestLike,
    response: SseResponseLike,
    controller: AbortController,
): () => void {
    const abort = () => {
        if (!controller.signal.aborted) controller.abort()
    }
    request.once('aborted', abort)
    response.once('close', abort)
    if (request.aborted || response.destroyed || response.writableEnded) abort()
    return () => {
        request.removeListener('aborted', abort)
        response.removeListener('close', abort)
    }
}

/**
 * Wait for drain rather than treating a full kernel/userland buffer as a
 * successful SSE delivery. If the peer closes, the parent signal aborts, or a
 * bounded wait expires, return false so the caller can abort the upstream LLM
 * iterator instead of keeping a hidden, unbounded stream alive.
 */
export async function writeSseFrame(
    response: SseResponseLike,
    payload: unknown,
    signal: AbortSignal,
    options: { backpressureTimeoutMs?: number } = {},
): Promise<boolean> {
    if (isUnavailable(response, signal)) return false
    let accepted: boolean
    try {
        accepted = response.write(formatSseFrame(payload))
    } catch {
        return false
    }
    if (accepted) return !isUnavailable(response, signal)

    const timeoutMs = options.backpressureTimeoutMs ?? DEFAULT_SSE_BACKPRESSURE_TIMEOUT_MS
    return new Promise((resolve) => {
        let settled = false
        const finish = (result: boolean) => {
            if (settled) return
            settled = true
            response.removeListener('drain', onDrain)
            response.removeListener('close', onClose)
            signal.removeEventListener('abort', onAbort)
            clearTimeout(timer)
            resolve(result && !isUnavailable(response, signal))
        }
        const onDrain = () => finish(true)
        const onClose = () => finish(false)
        const onAbort = () => finish(false)
        const timer = setTimeout(() => finish(false), timeoutMs)
        // A timer waiting on a peer must not keep a competition process alive.
        timer.unref?.()
        response.once('drain', onDrain)
        response.once('close', onClose)
        signal.addEventListener('abort', onAbort, { once: true })
        if (isUnavailable(response, signal)) finish(false)
    })
}
