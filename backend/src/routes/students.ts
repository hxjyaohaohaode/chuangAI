/**
 * 学生资源路由 —— GET /api/students、GET /api/students/:id/weak-points
 *
 * 背景（v5.1 接口打通）：
 * 命题工坊「智能题卡推荐」面板需要先选学生、再按该生薄弱知识点推荐题卡。
 * 前端 `api.students.list()` / `api.students.weakPoints()` 早已按此契约实现，
 * 但后端从未提供对应端点，导致学生下拉框恒为空、薄弱点推荐整条链路死链。
 *
 * 数据来源全部为真实学情表，不做任何推测填充：
 * - 学生列表：students 表（按班级过滤）
 * - 薄弱知识点：mastery 表聚合，只统计有真实作答记录的 (poem, bloom) 组合
 *
 * 关键取舍：
 * 没有作答记录的学生返回空 weakPoints 数组，而不是编造一份"看起来合理"的薄弱点。
 * 教师看到空列表时，前端会引导其先完成一次课堂或批改——这比拿假数据做教学决策安全得多。
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db, repos } from '../db/index.js'
import { validateQuery, validateParams, schemas } from '../lib/validation.js'
import { handleRouteError } from './_helpers.js'

/** 掌握度低于此阈值视为「薄弱」 */
const WEAK_THRESHOLD = 70

/** 单个学生最多返回的薄弱知识点数量（避免推荐面板被淹没） */
const MAX_WEAK_POINTS = 12

const listQuerySchema = z.object({
    classId: schemas.optionalSanitizedString(64),
    /** 关键词（按姓名/匿名名模糊匹配，供 Combobox 远程搜索用） */
    keyword: schemas.optionalSanitizedString(64),
    limit: z.coerce.number().int().min(1).max(500).optional(),
})

const studentIdParamsSchema = z.object({ id: schemas.studentId })

export const studentRoutes: FastifyPluginAsync = async (app) => {
    /**
     * GET / —— 学生列表
     *
     * Query: classId（可选，缺省返回全部班级）/ keyword / limit
     * 返回 `{ status, students: StudentOption[] }`
     *
     * 该路由受教师会话保护，选择器显示名册姓名，避免课堂与诊断界面退化为编号。
     * 学生 ID 仍是唯一关联键；公开分享、模型提示和外发报告继续走各自脱敏投影。
     */
    app.get('/', async (req: FastifyRequest, reply) => {
        const query = validateQuery(listQuerySchema, req, reply)
        if (!query) return

        try {
            const classNameById = new Map(
                repos.classes.findAll().map((c) => [c.id, c.name] as const),
            )

            // findAll 默认只取 100 条，这里显式放大上限以覆盖全校学生
            let students = query.classId
                ? repos.students.findByClassId(query.classId)
                : repos.students.findAll(2000)

            if (query.keyword) {
                const q = query.keyword.toLowerCase()
                students = students.filter((s) =>
                    s.name.toLowerCase().includes(q) || s.anonymousName.toLowerCase().includes(q),
                )
            }

            students.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))

            const limited = query.limit ? students.slice(0, query.limit) : students

            return reply.send({
                status: 'ok',
                students: limited.map((s) => ({
                    id: s.id,
                    name: s.name,
                    classId: s.classId,
                    className: classNameById.get(s.classId),
                })),
                total: students.length,
            })
        } catch (err) {
            handleRouteError(err, req, reply, '学生列表加载失败')
            return
        }
    })

    /**
     * GET /:id/weak-points —— 学生薄弱知识点
     *
     * 聚合口径：
     *   对该生每一条 mastery 记录取 (poemId, bloomLevel) 维度的最新分数，
     *   低于 WEAK_THRESHOLD 的进入薄弱清单，按分数升序（越薄弱越靠前）。
     *   knowledge 字段拼为「《诗题》· 认知层级」，教师一眼可读。
     */
    app.get('/:id/weak-points', async (req: FastifyRequest, reply) => {
        const params = validateParams(studentIdParamsSchema, req, reply)
        if (!params) return

        try {
            const student = repos.students.findById(params.id)
            if (!student) {
                return reply.code(404).send({
                    status: 'error',
                    error: 'NOT_FOUND',
                    message: '学生不存在',
                })
            }

            // mastery 表对 (student_id, poem_id, bloom_level) 有 UNIQUE 约束，
            // 每个组合只有一行、且由 upsertScore 持续更新为当前掌握度，直接读即可。
            const rows = db
                .prepare(
                    `SELECT m.poem_id       AS poemId,
                            m.bloom_level   AS bloomLevel,
                            m.score         AS score,
                            m.attempts      AS attempts,
                            p.title         AS poemTitle
                       FROM mastery m
                       LEFT JOIN poems p ON p.id = m.poem_id
                      WHERE m.student_id = ?
                      ORDER BY m.score ASC`,
                )
                .all(params.id) as Array<{
                    poemId: string
                    bloomLevel: string
                    score: number
                    attempts: number
                    poemTitle: string | null
                }>

            const weakPoints = rows
                .filter((r) => typeof r.score === 'number' && r.score < WEAK_THRESHOLD)
                .slice(0, MAX_WEAK_POINTS)
                .map((r) => ({
                    knowledge: `《${r.poemTitle ?? r.poemId}》· ${r.bloomLevel}`,
                    level: Math.round(r.score),
                    poemId: r.poemId,
                    bloomLevel: r.bloomLevel,
                }))

            return reply.send({
                status: 'ok',
                studentId: student.id,
                studentName: student.name,
                weakPoints,
                /** 该生总作答记录数：前端据此区分「学得很好」与「还没数据」两种空态 */
                masteryRecordCount: rows.length,
            })
        } catch (err) {
            handleRouteError(err, req, reply, '学生薄弱点分析失败')
            return
        }
    })
}

export default studentRoutes
