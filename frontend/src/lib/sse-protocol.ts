export const STREAM_TRUNCATED_ERROR_MESSAGE = '流式响应意外中断，结果可能不完整，请重试'

const PUBLIC_STREAM_ERROR_MESSAGES: Readonly<Record<string, string>> = {
    CHAT_STREAM_FAILED: 'AI 对话生成失败，请稍后重试',
    LLM_STREAM_FAILED: 'AI 副驾响应失败，请稍后重试',
    LEARNING_PATH_GENERATE_FAILED: '学习路径生成失败，请稍后重试',
    PRESCRIPTION_GENERATE_FAILED: '个性化处方生成失败，请稍后重试',
    AI_STREAM_FAILED: '课堂 AI 内容生成失败，请稍后重试',
    COMMENT_STREAM_FAILED: '课堂点评生成失败，请稍后重试',
    LESSON_GENERATE_FAILED: '教案生成失败，请稍后重试',
    LESSON_REFINE_FAILED: '教案精修失败，请稍后重试',
    AGENT_ORCHESTRATION_FAILED: '多智能体编排失败，请稍后重试',
}

/**
 * Convert an SSE error frame into a user-safe error. `message` is deliberately
 * ignored: older/misconfigured servers may put provider URLs, credentials or
 * prompt fragments there after the HTTP response has already been hijacked.
 */
export function errorFromSseFrame(frame: { error?: unknown; message?: unknown }): Error {
    const code = typeof frame.error === 'string' ? frame.error : ''
    return new Error(PUBLIC_STREAM_ERROR_MESSAGES[code] ?? '流式处理失败，请稍后重试')
}

/**
 * A clean TCP/ReadableStream EOF is not an application-level success. Return
 * false only for a user-initiated abort; otherwise require the protocol's
 * explicit terminal frame (`[DONE]`, `session:end`, or a validated done payload).
 */
export function requireExplicitSseTerminal(
    terminalSeen: boolean,
    signal: AbortSignal,
): boolean {
    if (terminalSeen) return true
    if (signal.aborted) {
        const reason = signal.reason as { name?: unknown } | undefined
        // AbortController.abort() uses the standard AbortError reason. Any
        // explicit reason (idle/header timeout, policy cancellation, etc.) is
        // a non-user failure and must not be silently reclassified as success.
        if (reason === undefined || (
            typeof reason === 'object'
            && reason !== null
            && reason.name === 'AbortError'
        )) return false
    }
    throw new Error(STREAM_TRUNCATED_ERROR_MESSAGE)
}
