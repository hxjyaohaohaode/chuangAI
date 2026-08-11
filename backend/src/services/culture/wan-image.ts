import { config } from '../../config.js'
import { getKey } from '../../lib/credentials.js'
import { isTrustedDashscopeImageUrl } from '../../security/image-reference-policy.js'
import { isTrustedProviderEndpoint } from '../../security/provider-endpoint-policy.js'
import {
    readBoundedProviderJson,
    sanitizeProviderDetail,
} from '../../security/provider-response.js'

export interface WanImageRequest {
    prompt: string
    orientation: 'landscape' | 'portrait'
}

export interface WanImageResult {
    imageUrl: string
    model: string
    requestId?: string
}

interface WanResponse {
    request_id?: string
    output?: {
        finished?: boolean
        choices?: Array<{
            finish_reason?: string
            message?: {
                role?: string
                content?: Array<{
                    image?: string
                    type?: string
                }>
            }
        }>
    }
    usage?: {
        image_count?: number
    }
    code?: string
    message?: string
}

export const WAN_IMAGE_MODEL = 'wan2.7-image' as const
export const WAN_IMAGE_REQUEST_TIMEOUT_MS = 90_000

function parseSuccessfulWanResponse(payload: WanResponse): WanImageResult {
    const requestId = payload.request_id?.trim()
    if (!requestId || requestId.length > 256 || /[\u0000-\u001f\u007f]/u.test(requestId)) {
        throw new Error('Wan2.7 成功响应缺少合法 request_id')
    }
    if (payload.code || payload.message) {
        throw new Error('Wan2.7 成功响应意外包含错误字段')
    }
    if (payload.output?.finished !== true) {
        throw new Error('Wan2.7 响应未标记任务完成')
    }
    if (payload.usage?.image_count !== 1) {
        throw new Error('Wan2.7 响应图片计数与单图请求不一致')
    }

    const choices = payload.output.choices
    if (!Array.isArray(choices) || choices.length !== 1) {
        throw new Error('Wan2.7 响应 choices 数量与单图请求不一致')
    }
    const choice = choices[0]
    if (choice?.finish_reason !== 'stop' || choice.message?.role !== 'assistant') {
        throw new Error('Wan2.7 响应结束状态或消息角色无效')
    }
    const content = choice.message.content
    if (!Array.isArray(content) || content.length !== 1) {
        throw new Error('Wan2.7 响应图片内容数量与单图请求不一致')
    }
    const item = content[0]
    if (item?.type !== 'image' || typeof item.image !== 'string') {
        throw new Error('Wan2.7 响应未包含官方 image 内容')
    }
    if (!isTrustedDashscopeImageUrl(item.image)) {
        throw new Error('Wan2.7 响应图片地址不在受信任的 DashScope OSS 白名单')
    }

    return { imageUrl: item.image, model: WAN_IMAGE_MODEL, requestId }
}

/**
 * 调用阿里云百炼 Wan2.7 同步文生图。
 * 未配置 DashScope Key 时返回 null，由上层明确降级为“本地教学插画”。
 */
export async function generateWanImage(
    input: WanImageRequest,
    options?: { signal?: AbortSignal },
): Promise<WanImageResult | null> {
    if (!input.prompt.trim() || input.prompt.length > 5_000) {
        throw new Error('Wan2.7 提示词长度必须为 1-5000 字符')
    }
    if (input.orientation !== 'landscape' && input.orientation !== 'portrait') {
        throw new Error('Wan2.7 图片方向无效')
    }

    // 密钥从 credentials 现取而非 config 快照：教师在设置面板换了阿里云密钥后，
    // 下一次生图立即使用新密钥，不必重启服务。
    const apiKey = getKey('dashscope')
    if (!apiKey) return null

    if (config.wanImage.model !== WAN_IMAGE_MODEL) {
        throw new Error(`Wan2.7 配置模型必须为 ${WAN_IMAGE_MODEL}`)
    }
    if (!isTrustedProviderEndpoint('wan-image', config.wanImage.baseUrl)) {
        throw new Error('Wan2.7 配置必须使用官方北京 Workspace MaaS 同步端点')
    }

    const timeoutController = new AbortController()
    const timeout = setTimeout(() => timeoutController.abort(), WAN_IMAGE_REQUEST_TIMEOUT_MS)
    const signal = options?.signal
        ? AbortSignal.any([options.signal, timeoutController.signal])
        : timeoutController.signal

    try {
        const size = input.orientation === 'portrait' ? '1152*2048' : '2048*1152'
        const response = await fetch(config.wanImage.baseUrl, {
            method: 'POST',
            redirect: 'error',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({
                model: WAN_IMAGE_MODEL,
                input: {
                    messages: [
                        {
                            role: 'user',
                            content: [{ text: input.prompt }],
                        },
                    ],
                },
                parameters: {
                    size,
                    n: 1,
                    // 星图图片直接作为产品内容展示，供应商水印会破坏沉浸体验。
                    // 生成来源由产品元数据明确记录，不把标识烙进画面像素。
                    watermark: false,
                    // 官方默认开启；竞赛展示优先图像质量，接受相应生成耗时。
                    thinking_mode: true,
                },
            }),
            signal,
        })

        const rawPayload = await readBoundedProviderJson<unknown>(response, 'Wan2.7')
        if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
            throw new Error('Wan2.7 响应根节点不是对象')
        }
        const payload = rawPayload as WanResponse
        if (!response.ok) {
            const detail = sanitizeProviderDetail(payload.message ?? payload.code ?? '未知错误', apiKey)
            throw new Error(
                `Wan2.7 请求失败（${response.status}）：${detail || '未知错误'}`,
            )
        }
        return parseSuccessfulWanResponse(payload)
    } finally {
        clearTimeout(timeout)
    }
}
