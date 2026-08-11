import type {
    AiAsrResponse,
    AiDegradationReason,
    AiGeneratedImage,
    AiImageGenerateResponse,
} from './types'

const DEGRADATION_REASONS = new Set<AiDegradationReason>([
    'demo-mode',
    'provider-unavailable',
    'provider-noncompliant',
    'provider-failed',
])
const PROTECTED_GENERATED_IMAGE_URL = /^\/uploads\/generated\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.webp$/u

function asRecord(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${path} 必须是对象`)
    }
    return value as Record<string, unknown>
}

function stringField(record: Record<string, unknown>, key: string, path: string): string {
    const value = record[key]
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${path}.${key} 必须是非空字符串`)
    }
    return value
}

function booleanField(record: Record<string, unknown>, key: string, path: string): boolean {
    const value = record[key]
    if (typeof value !== 'boolean') throw new TypeError(`${path}.${key} 必须是 boolean`)
    return value
}

function finiteNumberField(record: Record<string, unknown>, key: string, path: string): number {
    const value = record[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${path}.${key} 必须是有限数字`)
    }
    return value
}

function optionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
    const value = record[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${path}.${key} 必须是非空字符串或缺省`)
    }
    return value
}

function degradationReason(
    record: Record<string, unknown>,
    degraded: boolean,
    demo: boolean,
    path: string,
): AiDegradationReason | undefined {
    const raw = record.degradationReason
    if (!degraded) {
        if (raw !== undefined) throw new TypeError(`${path}.degradationReason 仅允许出现在降级响应`)
        return undefined
    }
    if (typeof raw !== 'string' || !DEGRADATION_REASONS.has(raw as AiDegradationReason)) {
        throw new TypeError(`${path}.degradationReason 缺失或不受支持`)
    }
    if ((raw === 'demo-mode') !== demo) {
        throw new TypeError(`${path}.demo 与 degradationReason 不一致`)
    }
    return raw as AiDegradationReason
}

function assertProvenance(
    status: unknown,
    model: string,
    requestedModel: string,
    aiGenerated: boolean,
    demo: boolean,
    degraded: boolean,
    expectedModel: 'wan2.7-image' | 'mimo-v2.5-asr',
    path: string,
): void {
    if (requestedModel !== expectedModel) {
        throw new TypeError(`${path}.requestedModel 必须为 ${expectedModel}`)
    }
    if (status !== (degraded ? 'degraded' : 'ok')) {
        throw new TypeError(`${path}.status 与 degraded 不一致`)
    }
    if (aiGenerated === degraded || (demo && !degraded)) {
        throw new TypeError(`${path} 的 aiGenerated/demo/degraded 标记互相矛盾`)
    }
    if (aiGenerated && model !== expectedModel) {
        throw new TypeError(`${path}.model 与真实生成标记不一致`)
    }
    if (!aiGenerated && model !== 'local-placeholder') {
        throw new TypeError(`${path}.model 必须如实标记本地占位处理器`)
    }
}

function parseGeneratedImage(value: unknown, index: number): AiGeneratedImage {
    const path = `imageGenerate.images[${index}]`
    const record = asRecord(value, path)
    const id = stringField(record, 'id', path)
    const url = stringField(record, 'url', path)
    const prompt = stringField(record, 'prompt', path)
    const verse = optionalString(record, 'verse', path)
    const thumbUrl = optionalString(record, 'thumbUrl', path)
    const orientation = record.orientation
    if (orientation !== 'portrait' && orientation !== 'landscape') {
        throw new TypeError(`${path}.orientation 不受支持`)
    }
    const model = stringField(record, 'model', path)
    const requestedModel = stringField(record, 'requestedModel', path)
    const createdAt = finiteNumberField(record, 'createdAt', path)
    if (createdAt < 0) throw new TypeError(`${path}.createdAt 不能为负数`)
    const cached = booleanField(record, 'cached', path)
    const aiGenerated = booleanField(record, 'aiGenerated', path)
    const demo = booleanField(record, 'demo', path)
    const degraded = booleanField(record, 'degraded', path)
    if (model !== 'wan2.7-image' || requestedModel !== 'wan2.7-image'
        || aiGenerated !== true || demo !== false || degraded !== false) {
        throw new TypeError(`${path} 只允许真实 wan2.7-image 成功结果，禁止占位图和伪降级成功`)
    }
    if (!PROTECTED_GENERATED_IMAGE_URL.test(url)) {
        throw new TypeError(`${path}.url 必须是服务端校验并落盘的 WebP，禁止把 SVG 或外链冒充 Wan 产物`)
    }
    if (thumbUrl && !PROTECTED_GENERATED_IMAGE_URL.test(thumbUrl)) {
        throw new TypeError(`${path}.thumbUrl 必须是服务端保护的 WebP 地址`)
    }

    return {
        id,
        url,
        ...(thumbUrl ? { thumbUrl } : {}),
        prompt,
        ...(verse ? { verse } : {}),
        orientation,
        model,
        requestedModel: 'wan2.7-image',
        createdAt,
        cached,
        aiGenerated: true,
        demo: false,
        degraded: false,
    }
}

/** 严格解析生图响应；契约漂移必须失败关闭，不能把空列表当“生成成功”。 */
export function parseAiImageGenerateResponse(value: unknown): AiImageGenerateResponse {
    const path = 'imageGenerate'
    const record = asRecord(value, path)
    if (!Array.isArray(record.images) || record.images.length !== 1) {
        throw new TypeError(`${path}.images 必须且只能包含 1 张图片`)
    }
    const images = record.images.map(parseGeneratedImage)
    const model = stringField(record, 'model', path)
    const requestedModel = stringField(record, 'requestedModel', path)
    const requestId = optionalString(record, 'requestId', path)
    const aiGenerated = booleanField(record, 'aiGenerated', path)
    const demo = booleanField(record, 'demo', path)
    const degraded = booleanField(record, 'degraded', path)
    if (record.status !== 'ok' || model !== 'wan2.7-image' || requestedModel !== 'wan2.7-image'
        || aiGenerated !== true || demo !== false || degraded !== false) {
        throw new TypeError(`${path} 只允许真实 wan2.7-image 成功响应；不可用时必须返回非 2xx 错误`)
    }
    if (record.degradationReason !== undefined) {
        throw new TypeError(`${path}.degradationReason 不允许出现在生图成功响应`)
    }
    const image = images[0]
    if (!image || image.model !== model || image.aiGenerated !== aiGenerated
        || image.demo !== demo || image.degraded !== degraded) {
        throw new TypeError(`${path} 的响应级与图片级来源标记不一致`)
    }

    return {
        status: 'ok',
        images,
        model,
        requestedModel: 'wan2.7-image',
        ...(requestId ? { requestId } : {}),
        aiGenerated: true,
        demo: false,
        degraded: false,
    }
}

/** 严格解析 ASR 响应，尤其禁止降级态携带伪造转写或评分。 */
export function parseAiAsrResponse(value: unknown): AiAsrResponse {
    const path = 'asr'
    const record = asRecord(value, path)
    const transcript = record.transcript
    if (typeof transcript !== 'string') throw new TypeError(`${path}.transcript 必须是字符串`)
    const audioDurationSec = finiteNumberField(record, 'audioDurationSec', path)
    if (audioDurationSec < 0) throw new TypeError(`${path}.audioDurationSec 不能为负数`)
    const model = stringField(record, 'model', path)
    const requestedModel = stringField(record, 'requestedModel', path)
    const aiGenerated = booleanField(record, 'aiGenerated', path)
    const demo = booleanField(record, 'demo', path)
    const degraded = booleanField(record, 'degraded', path)
    assertProvenance(
        record.status,
        model,
        requestedModel,
        aiGenerated,
        demo,
        degraded,
        'mimo-v2.5-asr',
        path,
    )
    const reason = degradationReason(record, degraded, demo, path)
    const confidence = record.confidence === undefined
        ? undefined
        : finiteNumberField(record, 'confidence', path)
    const similarityScore = record.similarityScore === undefined
        ? undefined
        : finiteNumberField(record, 'similarityScore', path)
    if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
        throw new TypeError(`${path}.confidence 必须在 0-1`)
    }
    if (similarityScore !== undefined && (similarityScore < 0 || similarityScore > 100)) {
        throw new TypeError(`${path}.similarityScore 必须在 0-100`)
    }
    if (degraded && (transcript !== '' || confidence !== undefined || similarityScore !== undefined)) {
        throw new TypeError(`${path} 降级态不得携带伪造转写、置信度或评分`)
    }

    return {
        status: degraded ? 'degraded' : 'ok',
        transcript,
        audioDurationSec,
        ...(confidence !== undefined ? { confidence } : {}),
        ...(similarityScore !== undefined ? { similarityScore } : {}),
        model,
        requestedModel: 'mimo-v2.5-asr',
        aiGenerated,
        demo,
        degraded,
        ...(reason ? { degradationReason: reason } : {}),
    }
}
