/**
 * 系统设置路由 —— 模型凭据配置与连通性检测
 *
 * 端点：
 *   GET  /api/settings/credentials        列出三家供应商的配置状态（仅掩码）
 *   PUT  /api/settings/credentials/:id    保存某供应商密钥（明文入、掩码出）
 *   POST /api/settings/credentials/:id/test  用当前密钥发一次最小请求验证连通性
 *
 * 安全约定：
 * - 任何响应都不回传密钥明文，只回传 `sk-****3f2a` 形式的掩码；
 * - Render 部署由 Dashboard Environment 托管密钥，路由严格只读且不会写 `.env`；
 * - 连通性检测发的是**最小代价**请求（deepseek/mimo 各 1 token，
 *   百炼只校验密钥格式与鉴权），不产生实质费用；
 * - 检测失败时把供应商返回的原始 message 透传给前端——
 *   「余额不足」「密钥无效」「区域不支持」是三种完全不同的处置方式，
 *   笼统报一句「连接失败」等于让教师去猜。
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { validateBody, validateParams } from '../lib/validation.js'
import { handleRouteError } from './_helpers.js'
import {
    getKey,
    listCredentialStatus,
    maskKey,
    setKey,
    PROVIDER_META,
    type CredentialProvider,
} from '../lib/credentials.js'
import { config } from '../config.js'
import { normalizeCredentialKey } from '../security/credential-file.js'
import { readBoundedProviderErrorText, sanitizeProviderDetail } from '../security/provider-response.js'

const providerParamsSchema = z.object({
    id: z.enum(['deepseek', 'mimo', 'dashscope']),
})

const saveBodySchema = z.object({
    /** 密钥明文；传空串表示清除该供应商配置 */
    apiKey: z.string().transform((value, ctx) => {
        try {
            return normalizeCredentialKey(value)
        } catch (error) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: error instanceof Error ? error.message : '密钥格式无效',
            })
            return z.NEVER
        }
    }),
})

/** 单次连通性检测的超时（ms）——不能让设置面板长时间卡住 */
const TEST_TIMEOUT_MS = 15_000

interface TestResult {
    ok: boolean
    /** 面向教师的结论 */
    message: string
    /** 供应商返回的原始错误（便于排查，可能为空） */
    detail?: string
    latencyMs: number
}

/** 超时覆盖 DNS/连接、响应头和受限响应体消费的完整 fetch 生命周期。 */
async function fetchWithTimeout<T>(
    url: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS)
    try {
        const response = await fetch(url, { ...init, redirect: 'error', signal: ctrl.signal })
        return await consume(response)
    } finally {
        clearTimeout(timer)
    }
}

/**
 * 探测 OpenAI 兼容端点（deepseek / mimo 共用）
 *
 * 发一条 max_tokens=1 的最小对话。之所以不用 /models 列表接口，
 * 是因为部分供应商的 /models 不校验鉴权，能列出模型不代表密钥可用。
 */
async function testOpenAICompatible(
    baseUrl: string,
    apiKey: string,
    model: string,
): Promise<TestResult> {
    const started = Date.now()
    try {
        const result = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
            }),
        }, async (res) => {
            const text = res.ok ? '' : await readBoundedProviderErrorText(res, '模型连通性检测')
            if (res.ok) await res.body?.cancel()
            return { ok: res.ok, status: res.status, text }
        })
        const latencyMs = Date.now() - started
        if (result.ok) {
            return { ok: true, message: `连通正常（${model}）`, latencyMs }
        }
        const text = result.text
        let detail = text
        try {
            const j = JSON.parse(text) as { error?: { message?: string }; message?: string }
            detail = j.error?.message ?? j.message ?? detail
        } catch {
            // 非 JSON 响应，保留原始文本
        }
        detail = sanitizeProviderDetail(detail, apiKey)
        const message =
            result.status === 401 || result.status === 403
                ? '密钥无效或无权限'
                : result.status === 402
                    ? '账户余额不足'
                    : result.status === 429
                        ? '触发限流，密钥有效但当前不可用'
                        : `供应商返回 ${result.status}`
        return { ok: false, message, detail, latencyMs }
    } catch (err) {
        const latencyMs = Date.now() - started
        const reason = err instanceof Error ? err.message : String(err)
        return {
            ok: false,
            message: reason.toLowerCase().includes('abort') ? `连接超时（>${TEST_TIMEOUT_MS / 1000}s）` : '网络不可达',
            detail: sanitizeProviderDetail(reason, apiKey),
            latencyMs,
        }
    }
}

/** 探测阿里云百炼文生图 */
async function testDashscope(apiKey: string): Promise<TestResult> {
    const started = Date.now()
    try {
        const result = await fetchWithTimeout(config.wanImage.baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: config.wanImage.model,
                input: { messages: [{ role: 'user', content: [{ text: 'ping' }] }] },
            }),
        }, async (res) => {
            const text = res.ok ? '' : await readBoundedProviderErrorText(res, '百炼连通性检测')
            if (res.ok) await res.body?.cancel()
            return { ok: res.ok, status: res.status, text }
        })
        const latencyMs = Date.now() - started
        const text = result.text
        if (result.ok) {
            return { ok: true, message: `连通正常（${config.wanImage.model}）`, latencyMs }
        }
        let detail = text
        try {
            const j = JSON.parse(text) as { message?: string; code?: string }
            detail = j.message ?? detail
        } catch {
            // 保留原始文本
        }
        detail = sanitizeProviderDetail(detail, apiKey)
        // 百炼欠费返回 400 + "account is in good standing" 文案，
        // 单看状态码会误判成参数错误，这里按文案精确识别。
        const overdue = /good standing|overdue|arrears|欠费/i.test(detail)
        return {
            ok: false,
            message: overdue
                ? '账户欠费或已停服，需前往阿里云百炼控制台充值'
                : result.status === 401 || result.status === 403
                    ? '密钥无效或无权限'
                    : `供应商返回 ${result.status}`,
            detail,
            latencyMs,
        }
    } catch (err) {
        const latencyMs = Date.now() - started
        const reason = err instanceof Error ? err.message : String(err)
        return {
            ok: false,
            message: reason.toLowerCase().includes('abort') ? `连接超时（>${TEST_TIMEOUT_MS / 1000}s）` : '网络不可达',
            detail: sanitizeProviderDetail(reason, apiKey),
            latencyMs,
        }
    }
}

async function runTest(provider: CredentialProvider): Promise<TestResult> {
    const key = getKey(provider)
    if (!key) {
        return { ok: false, message: '尚未配置密钥', latencyMs: 0 }
    }
    if (provider === 'deepseek') {
        return testOpenAICompatible(config.deepseek.baseUrl, key, 'deepseek-v4-flash')
    }
    if (provider === 'mimo') {
        return testOpenAICompatible(config.mimo.baseUrl, key, 'mimo-v2.5')
    }
    return testDashscope(key)
}

export interface SettingsRoutesOptions {
    /**
     * 公有云部署必须显式禁止通过 HTTP 修改凭据。未传时仍以启动期解析的
     * Render 标志为准，避免未来新增注册点时意外恢复写权限。
     */
    externallyManagedCredentials?: boolean
}

export type CredentialManagement = Readonly<{
    mutable: boolean
    managedBy: 'render-dashboard' | 'local-env'
}>

const RENDER_MANAGEMENT: CredentialManagement = Object.freeze({
    mutable: false,
    managedBy: 'render-dashboard',
})

const LOCAL_MANAGEMENT: CredentialManagement = Object.freeze({
    mutable: true,
    managedBy: 'local-env',
})

export const settingsRoutes: FastifyPluginAsync<SettingsRoutesOptions> = async (app, options) => {
    const management = (options.externallyManagedCredentials ?? config.isRender)
        ? RENDER_MANAGEMENT
        : LOCAL_MANAGEMENT

    /** GET /credentials —— 三家供应商配置状态 */
    app.get('/credentials', async (_req, reply) => {
        return reply.send({
            status: 'ok',
            providers: listCredentialStatus(),
            management,
        })
    })

    /** PUT /credentials/:id —— 保存密钥 */
    app.put('/credentials/:id', async (req: FastifyRequest, reply) => {
        // 必须在参数/正文解析和 setKey 之前 fail closed：Render 上无论提交何种
        // 请求体都不会触达文件写入逻辑，并返回可供前端稳定识别的 409 契约。
        if (!management.mutable) {
            return reply.code(409).send({
                status: 'error',
                error: 'SETTINGS_MANAGED_EXTERNALLY',
                message: 'Render 部署的模型凭据由 Dashboard Environment 管理，请在 Render 控制台更新后重新部署。',
                statusCode: 409,
                management,
            })
        }

        const params = validateParams(providerParamsSchema, req, reply)
        if (!params) return
        const body = validateBody(saveBodySchema, req, reply)
        if (!body) return

        try {
            setKey(params.id, body.apiKey)
            // 日志绝不打印明文，只记录是哪家、以及是否被清空
            req.log.info(
                { provider: params.id, cleared: body.apiKey.length === 0 },
                '[settings] 模型密钥已更新',
            )
            return reply.send({
                status: 'ok',
                provider: params.id,
                label: PROVIDER_META[params.id].label,
                configured: body.apiKey.length > 0,
                masked: maskKey(body.apiKey),
            })
        } catch (err) {
            handleRouteError(err, req, reply, '密钥保存失败')
            return
        }
    })

    /** POST /credentials/:id/test —— 连通性检测 */
    app.post('/credentials/:id/test', async (req: FastifyRequest, reply) => {
        const params = validateParams(providerParamsSchema, req, reply)
        if (!params) return
        try {
            const result = await runTest(params.id)
            return reply.send({ status: 'ok', provider: params.id, ...result })
        } catch (err) {
            handleRouteError(err, req, reply, '连通性检测失败')
            return
        }
    })
}

export default settingsRoutes
