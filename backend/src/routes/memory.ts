/**
 * 教师可治理的长期记忆接口。
 *
 * 这是本机竞赛原型的显式数据治理面：只开放 student / teacher 两类记忆，
 * 不开放 agent 内部经验，也不接受前端传入 ownerId。服务端签名会话是身份真相源，
 * 全局边界会拒绝与会话不一致的 teacherId；学生记忆还会额外校验教师—班级—学生归属。
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { repos } from '../db/index.js'
import { validateBody, validateParams, validateQuery, schemas } from '../lib/validation.js'
import {
    memoryStore,
    type MemoryItem,
    type MemoryKind,
} from '../agents/base/long-term-memory.js'
import { handleRouteError } from './_helpers.js'

const publicKindSchema = z.enum(['student', 'teacher'])

const listQuerySchema = z.object({
    teacherId: schemas.teacherId,
    kind: publicKindSchema.optional(),
    classId: schemas.classId.optional(),
    studentId: schemas.studentId.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
})

const addBodySchema = z.object({
    teacherId: schemas.teacherId,
    kind: publicKindSchema,
    studentId: schemas.studentId.optional(),
    classId: schemas.classId.optional(),
    content: schemas.sanitizedString(4_000),
    tags: z.array(schemas.sanitizedString(32)).max(10).optional(),
    retentionDays: z.coerce.number().int().min(1).max(365).optional(),
}).superRefine((body, ctx) => {
    if (body.kind === 'student' && !body.studentId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['studentId'], message: '学生记忆必须提供 studentId' })
    }
    if (body.kind === 'student' && !body.classId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classId'], message: '学生记忆必须提供 classId' })
    }
    if (body.kind === 'teacher' && (body.studentId || body.classId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: '教师偏好不应携带学生或班级字段' })
    }
})

const idParamsSchema = z.object({ id: schemas.id })

const updateBodySchema = z.object({
    teacherId: schemas.teacherId,
    content: schemas.sanitizedString(4_000),
})

function publicMemory(item: MemoryItem) {
    return {
        id: item.id,
        kind: item.kind,
        userId: item.userId,
        classId: item.classId,
        content: item.content,
        tags: item.tags,
        createdAt: item.createdAt,
        lastAccessedAt: item.lastAccessedAt,
        accessCount: item.accessCount,
        expiresAt: item.expiresAt,
    }
}

function teacherOwnsClass(teacherId: string, classId: string): boolean {
    return repos.classes.findByTeacherId(teacherId).some((item) => item.id === classId)
}

function studentBelongsToClass(studentId: string, classId: string): boolean {
    return repos.students.findById(studentId)?.classId === classId
}

function assertStudentAccess(teacherId: string, studentId: string, classId: string): string | undefined {
    if (!teacherOwnsClass(teacherId, classId)) return '教师无权访问该班级记忆'
    if (!studentBelongsToClass(studentId, classId)) return '学生不属于指定班级'
    return undefined
}

function sendMemoryValidationError(req: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown): void {
    const message = error instanceof Error ? error.message : '记忆参数无效'
    req.log.warn({ message }, '[memory] 记忆请求校验失败')
    reply.code(400).send({ status: 'error', error: 'MEMORY_VALIDATION_ERROR', message })
}

export const memoryRoutes: FastifyPluginAsync = async (app) => {
    /** GET / —— 仅列出当前 teacherId 所有的、未过期的可治理记忆。 */
    app.get('/', async (req: FastifyRequest, reply) => {
        const query = validateQuery(listQuerySchema, req, reply)
        if (!query) return
        try {
            if (query.studentId && query.kind !== 'student') {
                return reply.code(400).send({ status: 'error', error: 'MEMORY_SCOPE_REQUIRED', message: 'studentId 只能与 kind=student 且明确班级一起使用' })
            }
            if (query.kind === 'student' && !query.classId) {
                return reply.code(400).send({ status: 'error', error: 'MEMORY_SCOPE_REQUIRED', message: '筛选学生记忆必须提供 classId' })
            }
            if (query.classId && !teacherOwnsClass(query.teacherId, query.classId)) {
                return reply.code(403).send({ status: 'error', error: 'FORBIDDEN', message: '教师无权访问该班级记忆' })
            }
            if (query.studentId && query.classId) {
                const accessError = assertStudentAccess(query.teacherId, query.studentId, query.classId)
                if (accessError) return reply.code(403).send({ status: 'error', error: 'FORBIDDEN', message: accessError })
            }
            const items = memoryStore.getAll({
                ownerId: query.teacherId,
                kind: query.kind as MemoryKind | undefined,
                classId: query.classId,
                userId: query.studentId,
            }).slice(0, query.limit)
            return reply.send({
                status: 'ok',
                memories: items.map(publicMemory),
                total: items.length,
                governance: {
                    authenticated: req.auth !== undefined,
                    policy: req.auth
                        ? 'server-signed session; single-teacher local tenant; class and student ownership checked'
                        : 'route-only test harness; production registration requires the global authentication boundary',
                },
            })
        } catch (error) {
            handleRouteError(error, req, reply, '记忆列表加载失败')
            return
        }
    })

    /** POST / —— 教师显式新增一条可治理记忆。 */
    app.post('/', async (req: FastifyRequest, reply) => {
        const body = validateBody(addBodySchema, req, reply)
        if (!body) return
        try {
            if (body.kind === 'student') {
                const accessError = assertStudentAccess(body.teacherId, body.studentId as string, body.classId as string)
                if (accessError) return reply.code(403).send({ status: 'error', error: 'FORBIDDEN', message: accessError })
            }
            const item = await memoryStore.add({
                scope: 'user',
                ownerId: body.teacherId,
                kind: body.kind,
                userId: body.kind === 'student' ? body.studentId as string : body.teacherId,
                classId: body.classId,
                content: body.content,
                tags: body.tags,
                retentionDays: body.retentionDays,
            })
            return reply.code(201).send({ status: 'ok', memory: publicMemory(item) })
        } catch (error) {
            if (error instanceof Error && /记忆|所有者|主体|班级|标签/.test(error.message)) {
                sendMemoryValidationError(req, reply, error)
                return
            }
            handleRouteError(error, req, reply, '记忆保存失败')
            return
        }
    })

    /** PATCH /:id —— 只能修改自己的记忆正文，所有权从 URL 外的 teacherId 再次确认。 */
    app.patch('/:id', async (req: FastifyRequest, reply) => {
        const params = validateParams(idParamsSchema, req, reply)
        if (!params) return
        const body = validateBody(updateBodySchema, req, reply)
        if (!body) return
        try {
            const existing = memoryStore.get(body.teacherId, params.id)
            if (!existing) return reply.code(404).send({ status: 'error', error: 'NOT_FOUND', message: '记忆不存在' })
            if (existing.kind === 'student' && existing.classId) {
                const accessError = assertStudentAccess(body.teacherId, existing.userId, existing.classId)
                if (accessError) return reply.code(403).send({ status: 'error', error: 'FORBIDDEN', message: accessError })
            }
            const item = await memoryStore.update(body.teacherId, params.id, body.content)
            if (!item) return reply.code(404).send({ status: 'error', error: 'NOT_FOUND', message: '记忆不存在或已过期' })
            return reply.send({ status: 'ok', memory: publicMemory(item) })
        } catch (error) {
            if (error instanceof Error && /记忆|所有者|主体|班级|标签/.test(error.message)) {
                sendMemoryValidationError(req, reply, error)
                return
            }
            handleRouteError(error, req, reply, '记忆更新失败')
            return
        }
    })

    /** DELETE /:id —— 单条删除。 */
    app.delete('/:id', async (req: FastifyRequest, reply) => {
        const params = validateParams(idParamsSchema, req, reply)
        if (!params) return
        const query = validateQuery(z.object({ teacherId: schemas.teacherId }), req, reply)
        if (!query) return
        const deleted = memoryStore.delete(query.teacherId, params.id)
        if (!deleted) return reply.code(404).send({ status: 'error', error: 'NOT_FOUND', message: '记忆不存在' })
        return reply.send({ status: 'ok', deleted: 1 })
    })

    /** DELETE / —— 按教师边界批量删除；没有 teacherId 时 schema 直接拒绝。 */
    app.delete('/', async (req: FastifyRequest, reply) => {
        const query = validateQuery(listQuerySchema, req, reply)
        if (!query) return
        try {
            if (query.studentId && query.kind !== 'student') {
                return reply.code(400).send({ status: 'error', error: 'MEMORY_SCOPE_REQUIRED', message: 'studentId 只能与 kind=student 且明确班级一起使用' })
            }
            if (query.kind === 'student' && !query.classId) {
                return reply.code(400).send({ status: 'error', error: 'MEMORY_SCOPE_REQUIRED', message: '批量删除学生记忆必须提供 classId' })
            }
            if (query.classId && !teacherOwnsClass(query.teacherId, query.classId)) {
                return reply.code(403).send({ status: 'error', error: 'FORBIDDEN', message: '教师无权删除该班级记忆' })
            }
            const deleted = memoryStore.deleteAll({
                ownerId: query.teacherId,
                kind: query.kind as MemoryKind | undefined,
                classId: query.classId,
                userId: query.studentId,
            })
            return reply.send({ status: 'ok', deleted })
        } catch (error) {
            handleRouteError(error, req, reply, '记忆删除失败')
            return
        }
    })
}

export default memoryRoutes
