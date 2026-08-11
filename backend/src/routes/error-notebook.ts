/**
 * 错题本路由（Phase 4.1）—— 学生错题收集 + SM-2 间隔重复算法
 *
 * 4 个端点：
 * - GET  /list           错题本列表
 * - GET  /:id            错题详情
 * - POST /review         复习错题（SM-2 算法更新间隔重复状态）
 * - GET  /stats          错题统计（按诗篇/布鲁姆层级/错误类型分组）
 *
 * 设计要点：
 * - 错题数据从 answers 表筛选（correct = 0 或 correct IS NULL）
 * - 关联 questions 表获取题干、正确答案、Bloom 层级
 * - 关联 poems 表获取诗篇标题、诗人
 * - SM-2 算法实现间隔重复：EF 调整 + 间隔天数计算 + 掌握判定
 * - 统计接口返回多维分组数据
 * - 所有响应包含 aiGenerated 标记（算法计算结果为 false）
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { generateId } from '../db/utils/id.js'
import { SqliteMap } from '../db/runtime-store.js'
import { handleRouteError } from './_helpers.js'
import { z } from 'zod'
import { validateBody, validateParams, schemas } from '../lib/validation.js'
import type { BloomLevel } from '../agents/base/types.js'
// 闭环2补全：引入 WSBroadcaster，复习完成后推送 WS 事件
import type { WSBroadcaster } from '../orchestrator/websocket/broadcaster.js'
import type { WSEvent } from '../orchestrator/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义（与前端 types.ts 对齐）
// ─────────────────────────────────────────────────────────────

export type ErrorSourceType = 'diagnose' | 'quest' | 'dictation' | 'recitation'

export interface SpacedRepetitionState {
    easeFactor: number
    intervalDays: number
    repetitions: number
    nextReviewDate: number
    lastReviewDate: number | null
}

export type ReviewQuality = 0 | 1 | 2 | 3 | 4 | 5

export interface ErrorNotebookItem {
    id: string
    studentId: string
    poemId: string
    poemTitle: string
    poet: string
    bloomLevel: BloomLevel
    source: ErrorSourceType
    questionStem: string
    studentAnswer: string
    correctAnswer: string
    analysis: string
    errorCount: number
    firstErrorAt: number
    lastErrorAt: number
    repetition: SpacedRepetitionState
    mastered: boolean
    aiGenerated: boolean
}

export interface ErrorNotebookListItem {
    id: string
    poemId: string
    poemTitle: string
    poet: string
    bloomLevel: BloomLevel
    source: ErrorSourceType
    errorCount: number
    lastErrorAt: number
    nextReviewDate: number
    dueToday: boolean
    mastered: boolean
}

export interface ErrorNotebookListResponse {
    items: ErrorNotebookListItem[]
    total: number
    dueToday: number
    masteredCount: number
}

export interface ReviewSubmitRequest {
    itemId: string
    quality: ReviewQuality
}

export interface ReviewSubmitResponse {
    item: ErrorNotebookItem
    updatedRepetition: SpacedRepetitionState
    newlyMastered: boolean
    aiGenerated: boolean
}

export interface ReviewRecord {
    errorNotebookItemId: string
    reviewedAt: number
    quality: ReviewQuality
    previousInterval: number
    newInterval: number
    correct: boolean
}

export interface ReviewStatsResponse {
    totalItems: number
    dueToday: number
    masteredCount: number
    averageMastery: number
    reviewCurve: Array<{ date: string; count: number; correctCount: number }>
    byBloomLevel: Partial<Record<BloomLevel, number>>
    bySource: Partial<Record<ErrorSourceType, number>>
    aiGenerated: false
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const BLOOM_LEVELS: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

/** SM-2 算法初始易度因子 */
const INITIAL_EASE_FACTOR = 2.5

/** SM-2 算法最小易度因子 */
const MIN_EASE_FACTOR = 1.3

/** 连续答对达到此次数后标记为已掌握 */
const MASTERY_REPETITIONS = 3

/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000

// ─────────────────────────────────────────────────────────────
// 持久化存储
// ─────────────────────────────────────────────────────────────

/** 错题条目持久化存储 —— SQLite error_notebook_items 表 */
const errorNotebookStore = new SqliteMap<string, ErrorNotebookItem>({
    table: 'error_notebook_items',
    indexes: [
        { name: 'student_id', extract: (v) => v.studentId },
        { name: 'poem_id', extract: (v) => v.poemId },
        { name: 'bloom_level', extract: (v) => v.bloomLevel },
    ],
})

/** 复习记录持久化存储 —— SQLite error_notebook_reviews 表 */
const reviewRecordStore = new SqliteMap<string, ReviewRecord>({
    table: 'error_notebook_reviews',
    indexes: [
        { name: 'item_id', extract: (v) => v.errorNotebookItemId },
    ],
})

// ─────────────────────────────────────────────────────────────
// Zod schemas（输入校验）
// ─────────────────────────────────────────────────────────────

const qualitySchema = z.union([
    z.literal(0), z.literal(1), z.literal(2),
    z.literal(3), z.literal(4), z.literal(5),
])

/** POST /review 请求体 */
const reviewSchema = z.object({
    itemId: schemas.id,
    quality: qualitySchema,
})

/** GET /:id 路径参数 */
const itemIdParamsSchema = z.object({ id: schemas.id })

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

/** 错题本路由选项（闭环2补全：broadcaster 用于推送复习完成事件） */
export interface ErrorNotebookRoutesOptions {
    broadcaster?: WSBroadcaster
}

export const errorNotebookRoutes: FastifyPluginAsync<ErrorNotebookRoutesOptions> = async (
    app: FastifyInstance,
    opts,
) => {
    const broadcaster = opts.broadcaster
    // 初始化：从 answers 表同步错题数据到 error_notebook_items
    // 首次访问时自动同步，后续直接读取 error_notebook_items 表
    let initialized = false

    /** 惰性初始化：从 answers 表同步错题 */
    function ensureInitialized(): void {
        if (initialized) return
        initialized = true
        try {
            syncErrorsFromAnswers()
        } catch {
            // 静默降级，不影响请求处理
        }
    }

    // ── GET /list — 错题本列表 ──
    app.get('/list', async (req: FastifyRequest, reply) => {
        try {
            ensureInitialized()

            const todayStart = new Date()
            todayStart.setHours(0, 0, 0, 0)
            const todayEnd = todayStart.getTime() + DAY_MS

            const items: ErrorNotebookListItem[] = []
            let dueTodayCount = 0
            let masteredCount = 0

            for (const [, item] of errorNotebookStore) {
                const dueToday = !item.mastered && item.repetition.nextReviewDate <= todayEnd
                if (dueToday) dueTodayCount++
                if (item.mastered) masteredCount++

                items.push({
                    id: item.id,
                    poemId: item.poemId,
                    poemTitle: item.poemTitle,
                    poet: item.poet,
                    bloomLevel: item.bloomLevel,
                    source: item.source,
                    errorCount: item.errorCount,
                    lastErrorAt: item.lastErrorAt,
                    nextReviewDate: item.repetition.nextReviewDate,
                    dueToday,
                    mastered: item.mastered,
                })
            }

            // 按到期时间排序（已掌握的在最后）
            items.sort((a, b) => {
                if (a.mastered !== b.mastered) return a.mastered ? 1 : -1
                return a.nextReviewDate - b.nextReviewDate
            })

            return reply.send({
                items,
                total: items.length,
                dueToday: dueTodayCount,
                masteredCount,
            })
        } catch (err) {
            handleRouteError(err, req, reply, '错题本列表查询失败')
            return
        }
    })

    // ── GET /:id — 错题详情 ──
    app.get('/:id', async (req: FastifyRequest, reply) => {
        const params = validateParams(itemIdParamsSchema, req, reply)
        if (!params) return
        const { id } = params

        try {
            ensureInitialized()
            const item = errorNotebookStore.get(id)
            if (!item) {
                return reply.status(404).send({ status: 'error', message: '错题条目不存在' })
            }
            return reply.send(item)
        } catch (err) {
            handleRouteError(err, req, reply, '错题详情查询失败')
            return
        }
    })

    // ── POST /review — 复习错题（SM-2 算法） ──
    app.post('/review', async (req: FastifyRequest, reply) => {
        const body = validateBody(reviewSchema, req, reply)
        if (!body) return

        try {
            ensureInitialized()
            const { itemId, quality } = body

            const item = errorNotebookStore.get(itemId)
            if (!item) {
                return reply.status(404).send({ status: 'error', message: '错题条目不存在' })
            }

            const previousInterval = item.repetition.intervalDays
            const wasMastered = item.mastered

            // SM-2 算法更新间隔重复状态
            const updatedRepetition = applySM2(item.repetition, quality)
            const now = Date.now()

            // 判断是否新掌握（连续答对达到阈值且之前未掌握）
            const newlyMastered = !wasMastered && updatedRepetition.repetitions >= MASTERY_REPETITIONS

            // 更新错题条目
            const updatedItem: ErrorNotebookItem = {
                ...item,
                repetition: updatedRepetition,
                mastered: wasMastered || newlyMastered,
                lastErrorAt: quality < 3 ? now : item.lastErrorAt,
                errorCount: quality < 3 ? item.errorCount + 1 : item.errorCount,
            }
            errorNotebookStore.set(itemId, updatedItem)

            // 记录复习历史
            const recordId = `review-${generateId()}`
            const record: ReviewRecord = {
                errorNotebookItemId: itemId,
                reviewedAt: now,
                quality,
                previousInterval,
                newInterval: updatedRepetition.intervalDays,
                correct: quality >= 3,
            }
            reviewRecordStore.set(recordId, record)

            // 闭环2补全：复习完成后推送 WS 事件，通知前端 diagnosis/dashboard 刷新
            // 事件载荷与前端 businessEvents['error-notebook:review-completed'] 对齐
            if (broadcaster) {
                try {
                    const wsEvent: WSEvent = {
                        type: 'business:event',
                        timestamp: now,
                        sessionId: '',
                        payload: {
                            businessEventType: 'error-notebook:review-completed',
                            businessEventPayload: {
                                studentId: updatedItem.studentId,
                                itemId: updatedItem.id,
                                poemId: updatedItem.poemId,
                                bloomLevel: updatedItem.bloomLevel,
                                quality,
                                newlyMastered,
                                reviewedAt: now,
                            },
                        },
                    }
                    broadcaster.broadcast(wsEvent)
                } catch {
                    // WS 推送失败不影响主响应
                }
            }

            return reply.send({
                item: updatedItem,
                updatedRepetition,
                newlyMastered,
                aiGenerated: false,
            })
        } catch (err) {
            handleRouteError(err, req, reply, '错题复习提交失败')
            return
        }
    })

    // ── GET /stats — 错题统计 ──
    app.get('/stats', async (req: FastifyRequest, reply) => {
        try {
            ensureInitialized()

            const now = Date.now()
            const todayEnd = new Date()
            todayEnd.setHours(23, 59, 59, 999)
            const todayEndMs = todayEnd.getTime()

            let totalItems = 0
            let dueToday = 0
            let masteredCount = 0
            const byBloomLevel: Partial<Record<BloomLevel, number>> = {}
            const bySource: Partial<Record<ErrorSourceType, number>> = {}

            // 近7天复习曲线
            const reviewCurve: Array<{ date: string; count: number; correctCount: number }> = []
            for (let i = 6; i >= 0; i--) {
                const date = new Date(now - i * DAY_MS)
                const dateStr = date.toISOString().slice(0, 10)
                reviewCurve.push({ date: dateStr, count: 0, correctCount: 0 })
            }
            const curveMap = new Map(reviewCurve.map((r) => [r.date, r]))

            for (const [, item] of errorNotebookStore) {
                totalItems++
                if (!item.mastered && item.repetition.nextReviewDate <= todayEndMs) dueToday++
                if (item.mastered) masteredCount++

                byBloomLevel[item.bloomLevel] = (byBloomLevel[item.bloomLevel] ?? 0) + 1
                bySource[item.source] = (bySource[item.source] ?? 0) + 1
            }

            // 统计复习记录
            for (const [, record] of reviewRecordStore) {
                const dateStr = new Date(record.reviewedAt).toISOString().slice(0, 10)
                const entry = curveMap.get(dateStr)
                if (entry) {
                    entry.count++
                    if (record.correct) entry.correctCount++
                }
            }

            const averageMastery = totalItems > 0
                ? Math.round((masteredCount / totalItems) * 100)
                : 0

            return reply.send({
                totalItems,
                dueToday,
                masteredCount,
                averageMastery,
                reviewCurve,
                byBloomLevel,
                bySource,
                aiGenerated: false as const,
            })
        } catch (err) {
            handleRouteError(err, req, reply, '错题统计查询失败')
            return
        }
    })
}

// ─────────────────────────────────────────────────────────────
// 业务计算函数
// ─────────────────────────────────────────────────────────────

/**
 * SM-2 间隔重复算法
 *
 * 核心公式：
 * - quality >= 3: repetitions++, interval = 1/6/EF^repetitions
 * - quality < 3:  repetitions = 0, interval = 1
 * - EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)), 下限 1.3
 */
function applySM2(
    state: SpacedRepetitionState,
    quality: ReviewQuality,
): SpacedRepetitionState {
    const now = Date.now()

    // 更新易度因子
    const q = quality
    let newEF = state.easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
    newEF = Math.max(MIN_EASE_FACTOR, newEF)

    let newRepetitions: number
    let newInterval: number

    if (quality >= 3) {
        // 答对：增加重复次数，计算新间隔
        newRepetitions = state.repetitions + 1
        if (newRepetitions === 1) {
            newInterval = 1
        } else if (newRepetitions === 2) {
            newInterval = 6
        } else {
            newInterval = Math.round(state.intervalDays * newEF)
        }
    } else {
        // 答错：重置重复次数，间隔为1天
        newRepetitions = 0
        newInterval = 1
    }

    // 确保间隔至少为1天
    newInterval = Math.max(1, newInterval)

    return {
        easeFactor: Math.round(newEF * 100) / 100,
        intervalDays: newInterval,
        repetitions: newRepetitions,
        nextReviewDate: now + newInterval * DAY_MS,
        lastReviewDate: now,
    }
}

/**
 * 从 answers 表同步错题数据到 error_notebook_items
 *
 * 筛选条件：correct = 0（错误答案）
 * 去重逻辑：同一 studentId + questionId 合并为一条记录，errorCount 累加
 *
 * 闭环2补全：导出此函数，供 grading 路由在批改完成后主动触发同步，
 * 避免错题本仅在 /list 惰性初始化时才同步的数据延迟。
 */
export function syncErrorsFromAnswers(): void {
    try {
        // 查询所有错误答案（correct = 0），关联题目和诗篇
        const rows = db
            .prepare(
                `SELECT a.id AS answer_id,
                        a.student_id,
                        a.question_id,
                        a.answer_text,
                        a.submitted_at,
                        a.feedback,
                        a.cognitive_attribution,
                        q.poem_id,
                        q.bloom_level,
                        q.stem,
                        q.answer AS correct_answer,
                        q.analysis,
                        q.type AS question_type,
                        p.title AS poem_title,
                        p.poet
                 FROM answers a
                 JOIN questions q ON a.question_id = q.id
                 JOIN poems p ON q.poem_id = p.id
                 WHERE a.correct = 0
                 ORDER BY a.submitted_at DESC`,
            )
            .all() as Array<{
                answer_id: string
                student_id: string
                question_id: string
                answer_text: string
                submitted_at: number
                feedback: string | null
                cognitive_attribution: string | null
                poem_id: string
                bloom_level: string
                stem: string
                correct_answer: string
                analysis: string | null
                question_type: string
                poem_title: string
                poet: string
            }>

        const now = Date.now()
        const existingKeys = new Set<string>()
        for (const [key] of errorNotebookStore) {
            existingKeys.add(key)
        }

        // 按 studentId + questionId 分组，合并同知识点的错题
        const grouped = new Map<string, typeof rows>()
        for (const row of rows) {
            const groupKey = `${row.student_id}:${row.question_id}`
            const existing = grouped.get(groupKey)
            if (existing) {
                existing.push(row)
            } else {
                grouped.set(groupKey, [row])
            }
        }

        for (const [groupKey, groupRows] of grouped) {
            // 使用 groupKey 作为 itemId（确保幂等）
            const itemId = `err-${groupKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`
            if (existingKeys.has(itemId)) continue // 已存在则跳过

            const first = groupRows[0]
            if (!first) continue

            const bloomLevel = BLOOM_LEVELS.find((l) => l === first.bloom_level) ?? '记忆'
            const source = inferSourceType(first.question_type)

            const firstErrorAt = groupRows[groupRows.length - 1]?.submitted_at ?? now
            const lastErrorAt = first.submitted_at

            const item: ErrorNotebookItem = {
                id: itemId,
                studentId: first.student_id,
                poemId: first.poem_id,
                poemTitle: first.poem_title,
                poet: first.poet,
                bloomLevel,
                source,
                questionStem: first.stem,
                studentAnswer: first.answer_text,
                correctAnswer: first.correct_answer,
                analysis: first.analysis ?? first.feedback ?? first.cognitive_attribution ?? '暂无解析',
                errorCount: groupRows.length,
                firstErrorAt,
                lastErrorAt,
                repetition: {
                    easeFactor: INITIAL_EASE_FACTOR,
                    intervalDays: 1,
                    repetitions: 0,
                    nextReviewDate: now + DAY_MS,
                    lastReviewDate: null,
                },
                mastered: false,
                aiGenerated: false,
            }

            errorNotebookStore.set(itemId, item)
        }
    } catch {
        // 静默降级：answers 表可能为空或不存在
    }
}

/**
 * 根据题目类型推断错题来源
 */
function inferSourceType(questionType: string): ErrorSourceType {
    const typeMap: Record<string, ErrorSourceType> = {
        '选择': 'diagnose',
        '填空': 'quest',
        '配对': 'quest',
        '简答': 'diagnose',
        '创作': 'recitation',
        '应用': 'quest',
    }
    return typeMap[questionType] ?? 'diagnose'
}
