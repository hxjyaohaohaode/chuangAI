import type {
    EvolutionPredictStreamChunk,
    EvolutionPredictionDirection,
    EvolutionPredictionResult,
} from './types'

const MAX_FRAME_BUFFER_CHARS = 128 * 1024
const PROTOCOL_ERROR_MESSAGE = '进化预测流协议异常，请稍后重试'
const TRUNCATED_STREAM_MESSAGE = '进化预测流提前结束，请稍后重试'

type EvolutionStreamReader = ReadableStreamDefaultReader<Uint8Array>

export interface EvolutionPredictionStreamOptions {
    signal: AbortSignal
    readChunk?: (reader: EvolutionStreamReader) => Promise<ReadableStreamReadResult<Uint8Array>>
    onToken?: (token: string) => void
}

export class EvolutionPredictionServerError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
        super(message)
        this.name = 'EvolutionPredictionServerError'
        this.code = code
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value)
    return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isBoundedText(value: unknown, maxLength: number): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function isUnitNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function isEvolutionPredictionDirection(value: unknown): value is EvolutionPredictionDirection {
    if (!isRecord(value) || !hasExactKeys(value, [
        'direction',
        'suggestion',
        'expectedImprovement',
        'confidence',
    ])) return false

    return isBoundedText(value.direction, 120)
        && isBoundedText(value.suggestion, 1_000)
        && isUnitNumber(value.expectedImprovement)
        && isUnitNumber(value.confidence)
}

export function isEvolutionPredictionResult(value: unknown): value is EvolutionPredictionResult {
    if (!isRecord(value) || !hasExactKeys(value, [
        'predictions',
        'confidence',
        'aiGenerated',
        'generatedAt',
    ])) return false

    return Array.isArray(value.predictions)
        && value.predictions.length >= 1
        && value.predictions.length <= 5
        && value.predictions.every(isEvolutionPredictionDirection)
        && isUnitNumber(value.confidence)
        && typeof value.aiGenerated === 'boolean'
        && typeof value.generatedAt === 'number'
        && Number.isSafeInteger(value.generatedAt)
        && value.generatedAt >= 0
}

function protocolError(): Error {
    return new Error(PROTOCOL_ERROR_MESSAGE)
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError')
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortError(signal)
}

/**
 * 严格解析 evolution/predict 的单个 SSE data 载荷。
 * 未知字段、旧版无 type 帧、空预测和越界数值全部按协议错误处理，避免强转伪成功。
 */
export function parseEvolutionPredictionFrame(data: string): EvolutionPredictStreamChunk | '[DONE]' {
    if (data === '[DONE]') return '[DONE]'

    let value: unknown
    try {
        value = JSON.parse(data) as unknown
    } catch {
        throw protocolError()
    }
    if (!isRecord(value) || typeof value.type !== 'string') throw protocolError()

    if (value.type === 'token') {
        if (!hasExactKeys(value, ['type', 'token']) || typeof value.token !== 'string' || value.token.length > 32_000) {
            throw protocolError()
        }
        return { type: 'token', token: value.token }
    }

    if (value.type === 'done') {
        if (!hasExactKeys(value, ['type', 'result']) || !isEvolutionPredictionResult(value.result)) {
            throw protocolError()
        }
        return { type: 'done', result: value.result }
    }

    if (value.type === 'error') {
        if (!hasExactKeys(value, ['type', 'code', 'message'])
            || !isBoundedText(value.code, 128)
            || !isBoundedText(value.message, 500)) {
            throw protocolError()
        }
        return { type: 'error', code: value.code, message: value.message }
    }

    throw protocolError()
}

function extractData(frameText: string): string | null {
    const dataLines: string[] = []
    for (const rawLine of frameText.split(/\r?\n/)) {
        if (rawLine.startsWith(':')) continue
        if (rawLine === 'data') {
            dataLines.push('')
            continue
        }
        if (!rawLine.startsWith('data:')) continue
        const rawValue = rawLine.slice(5)
        dataLines.push(rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue)
    }
    return dataLines.length > 0 ? dataLines.join('\n') : null
}

/**
 * 消费严格的 evolution/predict SSE 协议。
 * 只有先收到合法 done(result)、再收到 [DONE] 才返回成功；自然 EOF 永远不能代替终态。
 */
export async function consumeEvolutionPredictionStream(
    body: ReadableStream<Uint8Array>,
    options: EvolutionPredictionStreamOptions,
): Promise<EvolutionPredictionResult> {
    const reader = body.getReader()
    const decoder = new TextDecoder('utf-8')
    const readChunk = options.readChunk ?? ((streamReader: EvolutionStreamReader) => streamReader.read())
    let buffer = ''
    let finalResult: EvolutionPredictionResult | null = null

    const cancelOnAbort = () => {
        void reader.cancel(options.signal.reason).catch(() => undefined)
    }
    options.signal.addEventListener('abort', cancelOnAbort, { once: true })

    try {
        while (true) {
            throwIfAborted(options.signal)
            const { done, value } = await readChunk(reader)
            throwIfAborted(options.signal)

            if (done) {
                buffer += decoder.decode()
                break
            }

            buffer += decoder.decode(value, { stream: true })
            if (buffer.length > MAX_FRAME_BUFFER_CHARS) throw protocolError()

            let separator: RegExpExecArray | null
            while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
                const frameText = buffer.slice(0, separator.index)
                buffer = buffer.slice(separator.index + separator[0].length)
                const data = extractData(frameText)
                if (data === null) continue

                const frame = parseEvolutionPredictionFrame(data)
                if (frame === '[DONE]') {
                    if (!finalResult) throw protocolError()
                    return finalResult
                }
                if (finalResult) throw protocolError()
                if (frame.type === 'token') {
                    options.onToken?.(frame.token)
                    continue
                }
                if (frame.type === 'error') {
                    throw new EvolutionPredictionServerError(frame.code, frame.message)
                }
                finalResult = frame.result
            }
        }

        throwIfAborted(options.signal)
        // 即使 done(result) 已收到，只要缺少 [DONE]，仍属于被代理/服务端截断。
        throw new Error(TRUNCATED_STREAM_MESSAGE)
    } finally {
        options.signal.removeEventListener('abort', cancelOnAbort)
        try {
            await reader.cancel()
        } catch {
            // 已关闭、已中止或已由浏览器释放的流无需二次处理。
        }
        reader.releaseLock()
    }
}
