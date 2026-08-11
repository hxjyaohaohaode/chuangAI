import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { schemas, validateBody, validateQuery } from '../lib/validation.js'
import {
    buildPublicSharePreview,
    createShareLink,
    fingerprintPublicSharePreview,
    getSharedReport,
    listSharedReports,
    revokeShareLink,
    type CreateShareRequest,
} from '../services/profile/report-exporter.js'

type ShareableReportStatus = 'generating' | 'completed' | 'failed'

/** 分享子路由所需的最小报告视图，避免该安全边界耦合整份 ReportRecord。 */
export interface ShareableReportRecord {
    id: string
    teacherId: string
    classId: string
    className: string
    status: ShareableReportStatus
    output?: { title: string }
}

export interface ReportSharingRoutesOptions<T extends ShareableReportRecord> {
    getReport: (reportId: string) => T | undefined
    renderMarkdown: (report: T) => string
    /** 从权威花名册读取姓名、学生 ID、匿名编号及家长元数据。读取失败必须阻断分享。 */
    getSensitiveTerms: (report: T) => readonly string[]
}

const previewShareSchema = z.object({
    reportId: schemas.id,
})

const createShareSchema = previewShareSchema.extend({
    expireDays: z.number().int().min(1).max(90).optional(),
    // 兼容旧客户端仅限于给出可操作的 428；缺失时绝不创建链接。
    previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
})

// 新 token 为 43 位 base64url；继续读取既有 UUID/早期 shr-* 链接，避免升级直接失效。
// 任意不符合格式的单段路径也统一返回 404，不向匿名方暴露校验细节。
const sharedTokenParamsSchema = z.object({
    token: z.string().min(20).max(128).regex(/^[A-Za-z0-9_-]+$/u),
})

// 教师主体只来自 HttpOnly 会话；旧客户端若仍携带 teacherId，会被全局
// 边界校验后由 Zod 丢弃，新的最小 DTO 不再把身份写进 body/query/URL 日志。
const listSharedQuerySchema = z.object({})

function hiddenShareNotFound(reply: FastifyReply) {
    return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: '分享链接不存在、已过期或已撤销',
    })
}

function authenticatedTeacherId(request: FastifyRequest, reply: FastifyReply): string | null {
    const teacherId = request.auth?.id
    if (teacherId) return teacherId
    reply.status(401).send({
        status: 'error',
        error: 'AUTHENTICATION_REQUIRED',
        message: '登录会话不存在、已过期或无效',
        statusCode: 401,
    })
    return null
}

/**
 * 注册教研报告分享边界。
 *
 * 唯一匿名能力是 GET /shared/:token；创建、列表和撤销均从服务端认证会话
 * 获取教师主体，不能由请求体或查询参数替换。token 不存在、失效和非所有者
 * 撤销使用同一 404，避免把 bearer capability 变成枚举 oracle。
 */
export function registerReportSharingRoutes<T extends ShareableReportRecord>(
    app: FastifyInstance,
    options: ReportSharingRoutesOptions<T>,
): void {
    app.post('/share/preview', async (request: FastifyRequest, reply) => {
        const body = validateBody(previewShareSchema, request, reply)
        if (!body) return
        const teacherId = authenticatedTeacherId(request, reply)
        if (!teacherId) return

        const record = options.getReport(body.reportId)
        if (!record || record.teacherId !== teacherId) return hiddenShareNotFound(reply)
        if (record.status !== 'completed' || !record.output) {
            return reply.status(409).send({
                statusCode: 409,
                error: 'Conflict',
                message: '报告尚未生成完成，无法预览公开版',
            })
        }

        let sensitiveTerms: readonly string[]
        try {
            sensitiveTerms = options.getSensitiveTerms(record)
            if (!Array.isArray(sensitiveTerms)) throw new Error('隐私词表格式无效')
        } catch (error) {
            request.log.error({ error, reportId: record.id }, '公开分享脱敏词表读取失败')
            return reply.status(503).send({
                statusCode: 503,
                error: 'PUBLIC_SHARE_REDACTION_UNAVAILABLE',
                message: '公开分享隐私保护暂不可用，请稍后重试',
            })
        }

        const previewRequest = { reportId: record.id, teacherId }
        const preview = buildPublicSharePreview(previewRequest, {
            className: record.className,
            output: { title: record.output.title },
            markdownContent: options.renderMarkdown(record),
            sensitiveTerms,
        })
        const previewFingerprint = fingerprintPublicSharePreview(previewRequest, preview)

        return reply.send({
            status: 'ok',
            preview,
            previewFingerprint,
            aiGenerated: true,
        })
    })

    app.post('/share', async (request: FastifyRequest, reply) => {
        const body = validateBody(createShareSchema, request, reply)
        if (!body) return
        const teacherId = authenticatedTeacherId(request, reply)
        if (!teacherId) return

        const record = options.getReport(body.reportId)
        // 不区分“报告不存在”和“报告属于其他教师”，避免跨主体枚举。
        if (!record || record.teacherId !== teacherId) return hiddenShareNotFound(reply)
        if (record.status !== 'completed' || !record.output) {
            return reply.status(409).send({
                statusCode: 409,
                error: 'Conflict',
                message: '报告尚未生成完成，无法分享',
            })
        }

        let sensitiveTerms: readonly string[]
        try {
            sensitiveTerms = options.getSensitiveTerms(record)
            if (!Array.isArray(sensitiveTerms)) throw new Error('隐私词表格式无效')
        } catch (error) {
            request.log.error({ error, reportId: record.id }, '公开分享脱敏词表读取失败')
            return reply.status(503).send({
                statusCode: 503,
                error: 'PUBLIC_SHARE_REDACTION_UNAVAILABLE',
                message: '公开分享隐私保护暂不可用，请稍后重试',
            })
        }

        const shareRequest: CreateShareRequest = {
            reportId: record.id,
            teacherId,
            expireDays: body.expireDays,
        }
        const shareSource = {
            className: record.className,
            output: { title: record.output.title },
            markdownContent: options.renderMarkdown(record),
            sensitiveTerms,
        }
        // 服务端重新生成脱敏快照并与教师确认过的预览指纹比对。
        // 指纹缺失或内容已变化都必须失败关闭，且不得先生成 token。
        const currentPreview = buildPublicSharePreview(shareRequest, shareSource)
        const currentFingerprint = fingerprintPublicSharePreview(shareRequest, currentPreview)
        if (!body.previewFingerprint) {
            return reply.status(428).send({
                statusCode: 428,
                error: 'PUBLIC_SHARE_PREVIEW_REQUIRED',
                message: '请先预览脱敏后的公开版并人工确认',
            })
        }
        if (body.previewFingerprint !== currentFingerprint) {
            return reply.status(409).send({
                statusCode: 409,
                error: 'PUBLIC_SHARE_PREVIEW_STALE',
                message: '报告或脱敏结果已变化，请重新预览并确认',
            })
        }

        // createShareLink 会再次调用同一脱敏函数，创建不依赖上方预览对象。
        const shared = createShareLink(shareRequest, shareSource)
        return reply.send({ status: 'ok', shared, aiGenerated: true })
    })

    app.get('/shared/:token', async (request: FastifyRequest, reply) => {
        // bearer token 出现在 URL，成功与失败均不得进入浏览器/代理缓存。
        reply.header('Cache-Control', 'no-store')
        reply.header('Pragma', 'no-cache')
        reply.header('Referrer-Policy', 'no-referrer')
        reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive')

        const parsed = sharedTokenParamsSchema.safeParse(request.params)
        if (!parsed.success) return hiddenShareNotFound(reply)
        const shared = getSharedReport(parsed.data.token)
        if (!shared) return hiddenShareNotFound(reply)

        // getSharedReport 返回服务层固定的公开 DTO，不含 token、teacherId、
        // reportId、访问次数或最后访问时间。
        return reply.send({ status: 'ok', shared, aiGenerated: true })
    })

    app.get('/shared', async (request: FastifyRequest, reply) => {
        const query = validateQuery(listSharedQuerySchema, request, reply)
        if (!query) return
        const teacherId = authenticatedTeacherId(request, reply)
        if (!teacherId) return

        // 新客户端不再发送 teacherId；若旧客户端仍发送，全局 preValidation
        // 会拒绝与会话不一致的值。这里始终只使用权威会话主体。
        const shares = listSharedReports(teacherId)
        return reply.send({ status: 'ok', shares, total: shares.length })
    })

    app.delete('/shared/:token', async (request: FastifyRequest, reply) => {
        const parsed = sharedTokenParamsSchema.safeParse(request.params)
        if (!parsed.success) return hiddenShareNotFound(reply)
        const teacherId = authenticatedTeacherId(request, reply)
        if (!teacherId) return

        if (!revokeShareLink(parsed.data.token, teacherId)) return hiddenShareNotFound(reply)
        return reply.send({ status: 'ok', revoked: true })
    })
}
