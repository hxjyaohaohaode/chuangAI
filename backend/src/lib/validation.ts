/**
 * 通用输入校验工具（B6.3 API 输入校验加固）
 *
 * 设计目标：
 * 1. 统一 Zod schema 校验入口，避免每个路由重复手写校验逻辑
 * 2. 校验失败返回 400 + 字段级错误详情（用户友好）
 * 3. 提供通用消毒 schema：字符串 trim、长度限制、XSS 基础过滤
 * 4. 提供常用 ID schema：poemId / classId / teacherId / sessionId / taskId
 *
 * 使用方式：
 * ```ts
 * import { validateBody, schemas } from '../lib/validation.js'
 *
 * app.post('/chat', async (req, reply) => {
 *     const body = validateBody(chatSchema, req, reply)
 *     if (!body) return // validateBody 已发送 400 响应
 *     // 使用 body.message 等...
 * })
 * ```
 *
 * 安全说明：
 * - 所有字符串输入默认 trim + 长度限制，防止缓冲区溢出
 * - XSS 基础过滤：移除 <script> 标签等危险内容（不依赖此层做完整 XSS 防御，前端/CSP 仍需配合）
 * - 不信任任何客户端输入，所有外部输入必须经过校验
 */

import { z } from 'zod'
import type { FastifyRequest, FastifyReply } from 'fastify'

// ─────────────────────────────────────────────────────────────
// 通用消毒 schema
// ─────────────────────────────────────────────────────────────

/**
 * XSS 基础过滤：移除 <script> 标签与 on* 事件属性
 *
 * 注意：此函数仅做基础过滤，不替代前端 CSP 与输出转义。
 * 它是防御纵深的一环，而非唯一防线。
 */
function filterXss(input: string): string {
    return input
        // 移除 <script>...</script>（含变种）
        .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
        // 移除独立 <script> 标签
        .replace(/<\s*script[^>]*>/gi, '')
        .replace(/<\s*\/\s*script\s*>/gi, '')
        // 移除 on* 事件属性（onerror, onclick, onload 等）
        .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        // 移除 javascript: 协议
        .replace(/javascript\s*:/gi, '')
}

/**
 * 消毒字符串 schema（B6.3 通用）
 *
 * - trim 首尾空白
 * - 可选 maxLength 限制（默认 10000）
 * - XSS 基础过滤
 * - 可选 allowEmpty（默认 false，空字符串视为 undefined）
 */
export function sanitizedString(maxLength = 10000, allowEmpty = false) {
    return z
        .string()
        .trim()
        .max(maxLength, `长度不能超过 ${maxLength} 字符`)
        .transform((val) => filterXss(val))
        .refine(
            (val) => allowEmpty || val.length > 0,
            { message: '不能为空字符串' },
        )
}

/**
 * 可选消毒字符串 schema
 */
export function optionalSanitizedString(maxLength = 10000) {
    return sanitizedString(maxLength, true).optional()
}

// ─────────────────────────────────────────────────────────────
// 常用 ID schema
// ─────────────────────────────────────────────────────────────

/** 通用 ID schema：非空字符串，1-128 字符，仅允许字母数字 _ - */
export const idSchema = z
    .string()
    .trim()
    .min(1, 'ID 不能为空')
    .max(128, 'ID 长度不能超过 128 字符')
    .regex(/^[a-zA-Z0-9_-]+$/, 'ID 仅允许字母、数字、下划线、连字符')

/** poemId：通用 ID 或数据库数字 ID */
export const poemIdSchema = z
    .string()
    .trim()
    .min(1, '古诗 ID 不能为空')
    .max(128, '古诗 ID 长度不能超过 128 字符')
    .regex(/^[a-zA-Z0-9_-]+$/, '古诗 ID 格式无效')

/** classId */
export const classIdSchema = idSchema

/** teacherId */
export const teacherIdSchema = idSchema

/** studentId */
export const studentIdSchema = idSchema

/** sessionId */
export const sessionIdSchema = idSchema

/** taskId */
export const taskIdSchema = idSchema

/** agentId */
export const agentIdSchema = idSchema

/** 正整数（分页 limit 等） */
export const positiveIntSchema = z
    .number()
    .int('必须为整数')
    .positive('必须为正数')
    .max(1000, '不能超过 1000')

/** 分页参数 */
export const paginationSchema = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
})

// ─────────────────────────────────────────────────────────────
// 常用 schema 集合
// ─────────────────────────────────────────────────────────────

export const schemas = {
    id: idSchema,
    poemId: poemIdSchema,
    classId: classIdSchema,
    teacherId: teacherIdSchema,
    studentId: studentIdSchema,
    sessionId: sessionIdSchema,
    taskId: taskIdSchema,
    agentId: agentIdSchema,
    positiveInt: positiveIntSchema,
    pagination: paginationSchema,
    sanitizedString,
    optionalSanitizedString,
}

// ─────────────────────────────────────────────────────────────
// 校验函数
// ─────────────────────────────────────────────────────────────

/**
 * 校验请求体
 *
 * @param schema Zod schema
 * @param req Fastify 请求
 * @param reply Fastify 响应
 * @returns 校验后的数据（成功）或 null（失败，已发送 400 响应）
 */
export function validateBody<T>(
    schema: z.ZodType<T>,
    req: FastifyRequest,
    reply: FastifyReply,
): T | null {
    const result = schema.safeParse(req.body)
    if (!result.success) {
        reply.code(400).send({
            status: 'error',
            error: 'VALIDATION_ERROR',
            message: '请求体校验失败',
            details: formatZodErrors(result.error),
        })
        return null
    }
    return result.data
}

/**
 * 校验路径参数
 *
 * @param schema Zod schema
 * @param req Fastify 请求
 * @param reply Fastify 响应
 * @returns 校验后的数据（成功）或 null（失败，已发送 400 响应）
 */
export function validateParams<T>(
    schema: z.ZodType<T>,
    req: FastifyRequest,
    reply: FastifyReply,
): T | null {
    const result = schema.safeParse(req.params)
    if (!result.success) {
        reply.code(400).send({
            status: 'error',
            error: 'VALIDATION_ERROR',
            message: '路径参数校验失败',
            details: formatZodErrors(result.error),
        })
        return null
    }
    return result.data
}

/**
 * 校验查询参数
 *
 * @param schema Zod schema
 * @param req Fastify 请求
 * @param reply Fastify 响应
 * @returns 校验后的数据（成功）或 null（失败，已发送 400 响应）
 */
export function validateQuery<T>(
    schema: z.ZodType<T>,
    req: FastifyRequest,
    reply: FastifyReply,
): T | null {
    const result = schema.safeParse(req.query)
    if (!result.success) {
        reply.code(400).send({
            status: 'error',
            error: 'VALIDATION_ERROR',
            message: '查询参数校验失败',
            details: formatZodErrors(result.error),
        })
        return null
    }
    return result.data
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

/**
 * 格式化 Zod 错误为用户友好的字段级详情
 */
function formatZodErrors(error: z.ZodError): Array<{ field: string; message: string }> {
    return error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
    }))
}
