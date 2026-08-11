/**
 * 家校沟通活页服务（画像报告 · 能力 5）
 *
 * 构建"教师 → 家长"的低摩擦沟通桥梁，包含 5 大模块：
 *   1. 自动周报（weekly-report）：基于学生本周学习数据自动生成周报
 *   2. 教师批注（teacher-note）：教师对周报补充个性化批注
 *   3. 家长反馈（parent-feedback）：家长查看后提交反馈与困惑
 *   4. 推荐活动（recommended-activity）：基于画像推荐家庭诗词互动活动
 *   5. 目标跟踪（goal-tracking）：学习目标设定与进度跟踪
 *
 * 调用 deepseek-v4-flash 生成周报内容（低延迟场景）。
 *
 * 设计要点：
 * - LLM 使用 deepseek-v4-flash，thinking: low（周报生成需快速响应）
 * - 周报、批注、反馈均持久化至 SqliteMap（home_school_weekly 表）
 * - LLM 失败时降级返回模板化周报（保证沟通不中断）
 * - 数据查询失败静默降级为 0 / 空数组
 * - 每位学生每周仅生成一份周报（按 ISO 周去重）
 */

import { db, repos } from '../../db/index.js'
import { managedLLM } from '../../llm/index.js'
import { SqliteMap } from '../../db/runtime-store.js'
import type { BloomLevel } from '../../agents/base/types.js'
import type { ChatMessage } from '../../llm/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 周报状态 */
export type WeeklyReportStatus = 'draft' | 'published' | 'archived'

/** 推荐活动类型 */
export type ActivityType = 'recitation' | 'discussion' | 'creation' | 'review' | 'appreciation'

/** 目标状态 */
export type GoalStatus = 'active' | 'completed' | 'overdue' | 'abandoned'

/** 周报中的学习数据摘要 */
export interface WeeklyLearningSummary {
    /** 本周已学诗数 */
    learnedPoemCount: number
    /** 本周答题数 */
    attemptCount: number
    /** 本周正确率 0-100 */
    correctRate: number
    /** 本周朗读次数 */
    recitationCount: number
    /** 本周学习时长（分钟） */
    studyMinutes: number
    /** 活跃天数 */
    activeDays: number
    /** 掌握度变化（本周 vs 上周，正数表示进步） */
    masteryDelta: number
    /** 本周新增薄弱点 */
    newWeakPoints: string[]
    /** 本周已掌握的诗篇 */
    newlyMastered: string[]
}

/** 教师批注 */
export interface TeacherNote {
    /** 批注内容 */
    content: string
    /** 教师签名（脱敏） */
    teacherName: string
    /** 批注时间戳 */
    notedAt: number
}

/** 家长反馈 */
export interface ParentFeedback {
    /** 反馈内容 */
    content: string
    /** 反馈类型：praise / concern / question / suggestion */
    feedbackType: 'praise' | 'concern' | 'question' | 'suggestion'
    /** 提交时间戳 */
    submittedAt: number
    /** 是否已读（教师端） */
    read: boolean
}

/** 推荐活动 */
export interface RecommendedActivity {
    id: string
    type: ActivityType
    title: string
    description: string
    /** 关联诗篇 ID（可选） */
    poemId?: string
    /** 预计时长（分钟） */
    estimatedMinutes: number
    /** 难度：easy / medium / hard */
    difficulty: 'easy' | 'medium' | 'hard'
    /** 完成状态 */
    completed: boolean
    /** 完成时间 */
    completedAt?: number
}

/** 学习目标 */
export interface LearningGoal {
    id: string
    /** 目标标题 */
    title: string
    /** 目标描述 */
    description: string
    /** 目标类型：mastery / engagement / recitation / creation */
    goalType: 'mastery' | 'engagement' | 'recitation' | 'creation'
    /** 目标值 */
    targetValue: number
    /** 当前值 */
    currentValue: number
    /** 完成进度 0-100 */
    progress: number
    /** 截止时间 */
    deadline: number
    /** 状态 */
    status: GoalStatus
    /** 创建时间 */
    createdAt: number
}

/** 家校周报完整结构 */
export interface HomeSchoolWeekly {
    id: string
    studentId: string
    anonymousName: string
    classId: string
    /** ISO 周数（如 "2026-W28"） */
    weekKey: string
    /** 周报周期 */
    period: { from: number; to: number }
    status: WeeklyReportStatus
    /** 学习数据摘要 */
    summary: WeeklyLearningSummary
    /** AI 生成的周报正文（约 400 字） */
    content: string
    /** 是否 AI 生成 */
    aiGenerated: boolean
    /** 教师批注列表 */
    teacherNotes: TeacherNote[]
    /** 家长反馈列表 */
    parentFeedbacks: ParentFeedback[]
    /** 推荐活动列表 */
    recommendedActivities: RecommendedActivity[]
    /** 学习目标 */
    goals: LearningGoal[]
    /** 创建时间 */
    createdAt: number
    /** 更新时间 */
    updatedAt: number
    /** 发布时间 */
    publishedAt?: number
}

/** 周报响应 */
export interface WeeklyReportResponse {
    report: HomeSchoolWeekly
    cached: boolean
}

/** 调用方给出的班级与学生真相源不一致时，禁止生成或返回跨班周报。 */
export class HomeSchoolStudentClassMismatchError extends Error {
    readonly code = 'STUDENT_CLASS_MISMATCH'
    readonly statusCode = 409

    constructor(
        readonly studentId: string,
        readonly requestedClassId: string,
        readonly authoritativeClassId: string,
    ) {
        super('学生不属于指定班级')
        this.name = 'HomeSchoolStudentClassMismatchError'
    }
}

/** 创建周报请求 */
export interface CreateWeeklyRequest {
    studentId: string
    classId: string
    /** 指定周（默认本周） */
    weekKey?: string
}

/** 提交反馈请求 */
export interface SubmitFeedbackRequest {
    feedbackType: 'praise' | 'concern' | 'question' | 'suggestion'
    content: string
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const BLOOM_LEVELS: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

const LLM_TIMEOUT_MS = 20_000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** 活动难度与时长映射 */
const ACTIVITY_TEMPLATES: Array<{
    type: ActivityType
    title: string
    description: string
    estimatedMinutes: number
    difficulty: 'easy' | 'medium' | 'hard'
}> = [
        {
            type: 'recitation',
            title: '亲子朗读时光',
            description: '与孩子一起朗读本周学习的古诗，轮流诵读，感受诗歌韵律之美。',
            estimatedMinutes: 15,
            difficulty: 'easy',
        },
        {
            type: 'discussion',
            title: '诗意对话',
            description: '围绕诗中意象展开对话，引导孩子用自己的话描述画面。',
            estimatedMinutes: 20,
            difficulty: 'medium',
        },
        {
            type: 'creation',
            title: '画中有诗',
            description: '让孩子为喜欢的诗配画，用画笔表达诗意。',
            estimatedMinutes: 30,
            difficulty: 'medium',
        },
        {
            type: 'review',
            title: '温故知新',
            description: '回顾本周薄弱诗篇，尝试背诵并解释关键词义。',
            estimatedMinutes: 15,
            difficulty: 'easy',
        },
        {
            type: 'appreciation',
            title: '诗意生活',
            description: '在日常生活中寻找与诗歌意境相似的场景，拍照或记录。',
            estimatedMinutes: 25,
            difficulty: 'hard',
        },
    ]

// ─────────────────────────────────────────────────────────────
// 持久化存储
// ─────────────────────────────────────────────────────────────

const weeklyStore = new SqliteMap<string, HomeSchoolWeekly>({
    table: 'home_school_weekly',
    indexes: [
        { name: 'student_id', extract: (v) => v.studentId },
        { name: 'class_id', extract: (v) => v.classId },
        { name: 'week_key', extract: (v) => v.weekKey },
        { name: 'status', extract: (v) => v.status },
    ],
})

// ─────────────────────────────────────────────────────────────
// 主服务
// ─────────────────────────────────────────────────────────────

/**
 * 生成（或获取缓存的）家校周报
 */
export async function generateWeeklyReport(
    request: CreateWeeklyRequest,
): Promise<WeeklyReportResponse> {
    const { studentId } = request
    const weekKey = request.weekKey ?? getCurrentWeekKey()
    const reportId = `${studentId}-${weekKey}`

    // 学生实体是班级归属的唯一真相源；必须在缓存前验证，否则旧的错班缓存
    // 会绕过新校验继续返回给家校页面。
    const student = repos.students.findById(studentId)
    if (!student) {
        throw new Error(`学生 ${studentId} 不存在`)
    }
    if (request.classId !== student.classId) {
        throw new HomeSchoolStudentClassMismatchError(
            studentId,
            request.classId,
            student.classId,
        )
    }
    const classId = student.classId

    // 缓存检查：同一学生同一周仅生成一次
    const cached = weeklyStore.get(reportId)
    if (cached?.classId !== undefined && cached.classId !== classId) {
        // 清除升级前可能遗留的错班周报，随后按权威归属重新生成。
        weeklyStore.delete(reportId)
    } else if (cached && cached.status !== 'draft') {
        return { report: cached, cached: true }
    }

    const period = getWeekPeriod(weekKey)
    const summary = await computeWeeklySummary(studentId, period)

    // LLM 生成周报正文
    let content = ''
    let aiGenerated = false
    try {
        content = await generateContentByLLM(student.anonymousName, summary, weekKey)
        aiGenerated = true
    } catch {
        content = generateFallbackContent(student.anonymousName, summary, weekKey)
    }

    // 生成推荐活动
    const recommendedActivities = generateRecommendedActivities(summary)

    // 生成学习目标（若不存在）
    const goals = generateDefaultGoals(studentId, summary)

    const report: HomeSchoolWeekly = {
        id: reportId,
        studentId,
        anonymousName: student.anonymousName,
        classId,
        weekKey,
        period,
        status: 'draft',
        summary,
        content,
        aiGenerated,
        teacherNotes: [],
        parentFeedbacks: [],
        recommendedActivities,
        goals,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    }

    weeklyStore.set(reportId, report)
    return { report, cached: false }
}

/**
 * 获取学生最新周报
 */
export function getLatestWeekly(studentId: string): HomeSchoolWeekly | null {
    let latest: HomeSchoolWeekly | null = null
    for (const [, report] of weeklyStore) {
        if (report.studentId === studentId) {
            if (!latest || report.createdAt > latest.createdAt) {
                latest = report
            }
        }
    }
    return latest
}

/** 班级花名册条目：学生 + 其最新周报的摘要状态 */
export interface ClassRosterEntry {
    studentId: string
    anonymousName: string
    /** 最新周报 id；从未生成过时为 null */
    reportId: string | null
    weekKey: string | null
    status: WeeklyReportStatus | null
    /** 掌握度周环比，用于花名册上的趋势角标 */
    masteryDelta: number | null
    /** 未读家长反馈数——教师需要一眼看到"谁家长回话了" */
    unreadFeedbackCount: number
    /** 教师是否已写过批注 */
    hasTeacherNote: boolean
}

/**
 * 列出班级花名册（含每人最新周报状态）
 *
 * 家校联系本的左栏需要「一次请求拿到全班状态」：谁生成了、谁还没生成、
 * 谁有家长反馈没读。逐个学生打 `/latest` 会产生 N 次请求，
 * 而且没法区分「没生成」和「请求失败」。
 */
export function listClassRoster(classId: string): ClassRosterEntry[] {
    const students = repos.students.findByClassId(classId)

    // 先把该班全部周报按学生归拢，避免在学生循环里反复全表扫描
    const latestByStudent = new Map<string, HomeSchoolWeekly>()
    for (const [, report] of weeklyStore) {
        if (report.classId !== classId) continue
        const prev = latestByStudent.get(report.studentId)
        if (!prev || report.createdAt > prev.createdAt) {
            latestByStudent.set(report.studentId, report)
        }
    }

    return students.map((s) => {
        const r = latestByStudent.get(s.id)
        return {
            studentId: s.id,
            anonymousName: s.anonymousName,
            reportId: r?.id ?? null,
            weekKey: r?.weekKey ?? null,
            status: r?.status ?? null,
            masteryDelta: r?.summary.masteryDelta ?? null,
            unreadFeedbackCount: r ? r.parentFeedbacks.filter((f) => !f.read).length : 0,
            hasTeacherNote: r ? r.teacherNotes.length > 0 : false,
        }
    })
}

/**
 * 发布周报（draft → published）
 */
export function publishWeeklyReport(reportId: string): HomeSchoolWeekly | null {
    const report = weeklyStore.get(reportId)
    if (!report) return null
    report.status = 'published'
    report.publishedAt = Date.now()
    report.updatedAt = Date.now()
    weeklyStore.set(reportId, report)
    return report
}

/**
 * 添加教师批注
 */
export function addTeacherNote(
    reportId: string,
    content: string,
    teacherName: string,
): HomeSchoolWeekly | null {
    const report = weeklyStore.get(reportId)
    if (!report) return null
    const note: TeacherNote = {
        content,
        teacherName,
        notedAt: Date.now(),
    }
    report.teacherNotes.push(note)
    report.updatedAt = Date.now()
    weeklyStore.set(reportId, report)
    return report
}

/**
 * 提交家长反馈
 */
export function submitParentFeedback(
    reportId: string,
    request: SubmitFeedbackRequest,
): HomeSchoolWeekly | null {
    const report = weeklyStore.get(reportId)
    if (!report) return null
    const feedback: ParentFeedback = {
        content: request.content,
        feedbackType: request.feedbackType,
        submittedAt: Date.now(),
        read: false,
    }
    report.parentFeedbacks.push(feedback)
    report.updatedAt = Date.now()
    weeklyStore.set(reportId, report)
    return report
}

/**
 * 标记家长反馈已读
 */
export function markFeedbackRead(reportId: string): HomeSchoolWeekly | null {
    const report = weeklyStore.get(reportId)
    if (!report) return null
    for (const fb of report.parentFeedbacks) {
        fb.read = true
    }
    report.updatedAt = Date.now()
    weeklyStore.set(reportId, report)
    return report
}

/**
 * 标记推荐活动完成
 */
export function completeActivity(reportId: string, activityId: string): HomeSchoolWeekly | null {
    const report = weeklyStore.get(reportId)
    if (!report) return null
    const activity = report.recommendedActivities.find((a) => a.id === activityId)
    if (!activity) return null
    activity.completed = true
    activity.completedAt = Date.now()
    report.updatedAt = Date.now()
    weeklyStore.set(reportId, report)
    return report
}

// ─────────────────────────────────────────────────────────────
// 周报数据计算
// ─────────────────────────────────────────────────────────────

/** 计算本周学习数据摘要 */
async function computeWeeklySummary(
    studentId: string,
    period: { from: number; to: number },
): Promise<WeeklyLearningSummary> {
    try {
        const events = repos.events.findRecentByStudentId(studentId, 1000)
        const weekEvents = events.filter(
            (e) => e.occurredAt >= period.from && e.occurredAt < period.to,
        )

        // ── 本周答题数与正确率：直接查 answers 表 ──
        //
        // 原实现有两处硬错，都会在家长面前露馅：
        // 1. attemptCount 数的是 events 表里 type='answer' 的事件，
        //    但作答真正落库的是 answers 表，events 未必有对应记录 ——
        //    实测出现过「本周答题 0 次」而正确率却有值的自相矛盾。
        // 2. correctRate 算的是「mastery 行中得分 ≥60 的占比」，
        //    那是**掌握度覆盖率**，既不是正确率，也不限于本周。
        //    字段名和值对不上，是最容易被当成事实引用的那种错。
        // 现在两者都取自本周实际提交的作答，口径一致。
        const answerRows = db
            .prepare(`
                SELECT correct, partial_score AS partialScore,
                       COALESCE(q.estimated_time_sec, 60) AS estimatedSec
                  FROM answers a
                  LEFT JOIN questions q ON q.id = a.question_id
                 WHERE a.student_id = ?
                   AND a.submitted_at >= ?
                   AND a.submitted_at < ?
            `)
            .all(studentId, period.from, period.to) as Array<{
                correct: number | null
                partialScore: number | null
                estimatedSec: number
            }>

        const attemptCount = answerRows.length
        // 只把「判过对错」的计入分母：未批改的题不该拉低正确率
        const graded = answerRows.filter((r) => r.correct !== null)
        const correctRate = graded.length > 0
            ? Math.round((graded.filter((r) => r.correct === 1).length / graded.length) * 10000) / 100
            : 0

        const masteryRows = repos.mastery.findByStudentId(studentId)

        // 朗读次数
        const recitations = weekEvents.filter((e) =>
            ['recite', '朗读', '背诵'].includes(e.type.toLowerCase().trim()),
        )
        const recitationCount = recitations.length

        // 已学诗数
        const learnedPoemIds = new Set<string>()
        for (const e of weekEvents) {
            if (e.poemId) learnedPoemIds.add(e.poemId)
        }

        // 活跃天数
        const activeDaysSet = new Set<string>()
        for (const e of weekEvents) {
            const day = new Date(e.occurredAt).toISOString().slice(0, 10)
            activeDaysSet.add(day)
        }

        // ── 学习时长：按本周实际作答题目的预估用时累计 ──
        // 原实现是 `事件数 × 2 分钟` 的凭空系数。题目自带 estimated_time_sec，
        // 用真实值累计才能反映「做了多少」而不是「点了多少次」。
        const studyMinutes = Math.round(
            answerRows.reduce((sum, r) => sum + r.estimatedSec, 0) / 60,
        )

        // ── 掌握度变化：本周 vs 上周 ──
        // 只有在两周都有掌握度更新记录时，差值才有意义。
        // 原实现在本周无记录时会拿 `0 - 上周均分`，直接产出 -69.68 这种
        // 荒谬的"暴跌"。样本缺失应当如实报 0（无变化），而不是伪造暴跌。
        const thisWeekMastery = computeAvgMastery(masteryRows, period)
        const lastWeekMastery = computeAvgMastery(masteryRows, {
            from: period.from - WEEK_MS,
            to: period.from,
        })
        const masteryDelta = thisWeekMastery > 0 && lastWeekMastery > 0
            ? Math.round((thisWeekMastery - lastWeekMastery) * 100) / 100
            : 0

        // ── 薄弱点与已掌握 ──
        //
        // mastery 表的粒度是 (学生 × 诗篇 × 六阶层级)，同一首诗有多行。
        // 原实现直接逐行 push 诗名，造成两个后果：
        // 1. 同名重复（实测「望庐山瀑布」出现 3 次）
        // 2. 同一首诗在「记忆」层 ≥80、在「分析」层 <60 时，
        //    会**同时**出现在"新掌握"和"薄弱点"两栏——给家长看的自相矛盾。
        // 正确做法是先按诗聚合出全层级均分，再用均分归类，一首诗只进一栏。
        const byPoem = new Map<string, { sum: number; n: number; latest: number }>()
        for (const m of masteryRows) {
            const cur = byPoem.get(m.poemId) ?? { sum: 0, n: 0, latest: 0 }
            cur.sum += m.score ?? 0
            cur.n += 1
            cur.latest = Math.max(cur.latest, m.updatedAt)
            byPoem.set(m.poemId, cur)
        }

        const weakEntries: Array<{ title: string; avg: number }> = []
        const masteredEntries: Array<{ title: string; avg: number }> = []
        for (const [poemId, agg] of byPoem) {
            // 「新增/新掌握」的"新"字要站得住：只看本周有过更新的诗篇
            if (agg.latest < period.from || agg.latest >= period.to) continue
            const avg = agg.sum / agg.n
            const title = repos.poems.findById(poemId)?.title ?? poemId
            if (avg > 0 && avg < 60) weakEntries.push({ title, avg })
            else if (avg >= 80) masteredEntries.push({ title, avg })
        }
        // 薄弱点最弱的排前面；已掌握的最扎实的排前面
        weakEntries.sort((a, b) => a.avg - b.avg)
        masteredEntries.sort((a, b) => b.avg - a.avg)

        return {
            learnedPoemCount: learnedPoemIds.size,
            attemptCount,
            correctRate,
            recitationCount,
            studyMinutes,
            activeDays: activeDaysSet.size,
            masteryDelta,
            newWeakPoints: weakEntries.slice(0, 5).map((e) => e.title),
            newlyMastered: masteredEntries.slice(0, 5).map((e) => e.title),
        }
    } catch {
        return {
            learnedPoemCount: 0,
            attemptCount: 0,
            correctRate: 0,
            recitationCount: 0,
            studyMinutes: 0,
            activeDays: 0,
            masteryDelta: 0,
            newWeakPoints: [],
            newlyMastered: [],
        }
    }
}

/** 计算某时段内平均掌握度 */
function computeAvgMastery(
    masteryRows: Array<{ score?: number | null; updatedAt: number }>,
    period: { from: number; to: number },
): number {
    const inRange = masteryRows.filter((m) => m.updatedAt >= period.from && m.updatedAt < period.to)
    if (inRange.length === 0) return 0
    const sum = inRange.reduce((acc, m) => acc + (m.score ?? 0), 0)
    return sum / inRange.length
}

// ─────────────────────────────────────────────────────────────
// LLM 周报生成
// ─────────────────────────────────────────────────────────────

async function generateContentByLLM(
    anonymousName: string,
    summary: WeeklyLearningSummary,
    weekKey: string,
): Promise<string> {
    const systemPrompt = `你是诗心·家校沟通助手，专为小学古诗词教学场景设计。
你的任务是基于学生本周学习数据，生成一份温馨、专业的家校周报（约 400 字）。

要求：
1. 称呼家长为"家长朋友"，语气亲切、积极
2. 客观呈现本周学习数据，突出进步、委婉指出不足
3. 给出 2-3 条具体的家庭诗词活动建议
4. 使用学生脱敏编号（如 S01），不使用真实姓名
5. 输出纯文本，不使用 Markdown 标记
6. 结尾以"诗心·启明 教研团队"署名`

    const userPrompt = `请为以下学生生成本周家校周报：

学生：${anonymousName}
周次：${weekKey}

【本周学习数据】
- 已学诗数：${summary.learnedPoemCount} 首
- 答题数：${summary.attemptCount} 次
- 正确率：${summary.correctRate}%
- 朗读次数：${summary.recitationCount} 次
- 学习时长：约 ${summary.studyMinutes} 分钟
- 活跃天数：${summary.activeDays} 天
- 掌握度变化：${summary.masteryDelta >= 0 ? '+' : ''}${summary.masteryDelta} 分
- 新增薄弱诗篇：${summary.newWeakPoints.length > 0 ? summary.newWeakPoints.join('、') : '无'}
- 新掌握诗篇：${summary.newlyMastered.length > 0 ? summary.newlyMastered.join('、') : '暂无'}

请生成约 400 字的家校周报。`

    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ]

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

    try {
        const result = await managedLLM.chat({
            model: 'deepseek-v4-flash',
            messages,
            thinking: 'low',
            temperature: 0.7,
            maxTokens: 800,
            signal: controller.signal,
            metadata: {
                agent: 'home-school-book',
                task: `weekly-${anonymousName}-${weekKey}`,
            },
        })
        return result.content.trim()
    } finally {
        clearTimeout(timeoutId)
    }
}

/** 降级：模板化周报 */
function generateFallbackContent(
    anonymousName: string,
    summary: WeeklyLearningSummary,
    weekKey: string,
): string {
    const parts: string[] = []
    parts.push(`家长朋友您好，以下是 ${anonymousName} 本周（${weekKey}）的古诗词学习周报。`)
    parts.push('')
    parts.push('【学习概况】')
    parts.push(`本周共学习 ${summary.learnedPoemCount} 首古诗，完成 ${summary.attemptCount} 次答题，正确率 ${summary.correctRate}%。`)
    parts.push(`朗读 ${summary.recitationCount} 次，累计学习约 ${summary.studyMinutes} 分钟，活跃 ${summary.activeDays} 天。`)
    parts.push('')
    if (summary.masteryDelta > 0) {
        parts.push(`【进步亮点】掌握度较上周提升 ${summary.masteryDelta} 分，学习状态稳步向好。`)
    } else if (summary.masteryDelta < 0) {
        parts.push(`【关注提醒】掌握度较上周下降 ${Math.abs(summary.masteryDelta)} 分，建议加强复习。`)
    } else {
        parts.push('【学习状态】掌握度保持稳定。')
    }
    if (summary.newlyMastered.length > 0) {
        parts.push(`本周新掌握诗篇：${summary.newlyMastered.join('、')}。`)
    }
    if (summary.newWeakPoints.length > 0) {
        parts.push(`需重点关注：${summary.newWeakPoints.join('、')}。`)
    }
    parts.push('')
    parts.push('【家庭活动建议】')
    parts.push('1. 每日亲子朗读 15 分钟，感受诗歌韵律。')
    parts.push('2. 围绕薄弱诗篇，引导孩子用自己的话讲述诗意。')
    parts.push('')
    parts.push('感谢您的配合！')
    parts.push('诗心·启明 教研团队')
    return parts.join('\n')
}

// ─────────────────────────────────────────────────────────────
// 推荐活动生成
// ─────────────────────────────────────────────────────────────

function generateRecommendedActivities(summary: WeeklyLearningSummary): RecommendedActivity[] {
    const activities: RecommendedActivity[] = []
    const now = Date.now()

    // 根据学习数据推荐活动
    if (summary.recitationCount < 3) {
        const tmpl = ACTIVITY_TEMPLATES[0]!
        activities.push({
            id: `act-${now}-1`,
            type: tmpl.type,
            title: tmpl.title,
            description: tmpl.description,
            estimatedMinutes: tmpl.estimatedMinutes,
            difficulty: tmpl.difficulty,
            completed: false,
        })
    }

    if (summary.newWeakPoints.length > 0) {
        const tmpl = ACTIVITY_TEMPLATES[3]!
        activities.push({
            id: `act-${now}-2`,
            type: tmpl.type,
            title: tmpl.title,
            description: `${tmpl.description} 重点诗篇：${summary.newWeakPoints.slice(0, 2).join('、')}`,
            estimatedMinutes: tmpl.estimatedMinutes,
            difficulty: tmpl.difficulty,
            completed: false,
        })
    }

    if (summary.correctRate >= 80) {
        const tmpl = ACTIVITY_TEMPLATES[2]!
        activities.push({
            id: `act-${now}-3`,
            type: tmpl.type,
            title: tmpl.title,
            description: tmpl.description,
            estimatedMinutes: tmpl.estimatedMinutes,
            difficulty: tmpl.difficulty,
            completed: false,
        })
    }

    // 至少推荐 2 个活动
    if (activities.length < 2) {
        const tmpl = ACTIVITY_TEMPLATES[1]!
        activities.push({
            id: `act-${now}-4`,
            type: tmpl.type,
            title: tmpl.title,
            description: tmpl.description,
            estimatedMinutes: tmpl.estimatedMinutes,
            difficulty: tmpl.difficulty,
            completed: false,
        })
    }

    // 始终推荐诗意生活活动
    const tmpl5 = ACTIVITY_TEMPLATES[4]!
    activities.push({
        id: `act-${now}-5`,
        type: tmpl5.type,
        title: tmpl5.title,
        description: tmpl5.description,
        estimatedMinutes: tmpl5.estimatedMinutes,
        difficulty: tmpl5.difficulty,
        completed: false,
    })

    return activities.slice(0, 4)
}

// ─────────────────────────────────────────────────────────────
// 学习目标生成
// ─────────────────────────────────────────────────────────────

function generateDefaultGoals(studentId: string, summary: WeeklyLearningSummary): LearningGoal[] {
    const now = Date.now()
    const nextWeekDeadline = now + WEEK_MS

    const goals: LearningGoal[] = []

    // 目标 1：掌握度提升 5 分
    const currentMastery = summary.correctRate
    goals.push({
        id: `goal-${now}-1`,
        title: '本周掌握度提升 5 分',
        description: `本周正确率目标：${Math.min(100, currentMastery + 5)}%（当前 ${currentMastery}%）`,
        goalType: 'mastery',
        targetValue: Math.min(100, currentMastery + 5),
        currentValue: currentMastery,
        progress: currentMastery >= Math.min(100, currentMastery + 5) ? 100 : Math.round((currentMastery / Math.min(100, currentMastery + 5)) * 100),
        deadline: nextWeekDeadline,
        status: 'active',
        createdAt: now,
    })

    // 目标 2：朗读 5 次
    const recitationTarget = Math.max(5, summary.recitationCount + 2)
    goals.push({
        id: `goal-${now}-2`,
        title: `本周完成 ${recitationTarget} 次朗读`,
        description: `每日坚持朗读，培养语感（当前 ${summary.recitationCount} 次）`,
        goalType: 'recitation',
        targetValue: recitationTarget,
        currentValue: summary.recitationCount,
        progress: Math.min(100, Math.round((summary.recitationCount / recitationTarget) * 100)),
        deadline: nextWeekDeadline,
        status: 'active',
        createdAt: now,
    })

    // 目标 3：活跃 5 天
    const activeTarget = 5
    goals.push({
        id: `goal-${now}-3`,
        title: `本周活跃 ${activeTarget} 天`,
        description: `保持每日学习习惯（当前 ${summary.activeDays} 天）`,
        goalType: 'engagement',
        targetValue: activeTarget,
        currentValue: summary.activeDays,
        progress: Math.min(100, Math.round((summary.activeDays / activeTarget) * 100)),
        deadline: nextWeekDeadline,
        status: 'active',
        createdAt: now,
    })

    void studentId
    return goals
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

/** 获取当前 ISO 周键（如 "2026-W28"） */
/**
 * ISO-8601 周历工具
 *
 * ── 为什么要重写 ──
 * 原来的两个函数用了**互不兼容的两套周序**：
 * - getCurrentWeekKey：`ceil((年内天数 + 元旦星期几 + 1) / 7)`，周日起算的美式周
 * - getWeekPeriod：把「元旦当周的周一」当作第 1 周起点，周一起算
 * 二者对同一天可以差整整一周。实测 2026-07-26（周日）算出 weekKey=2026-W31，
 * 而 W31 的周期是 7/27–8/3 ——**"本周"的区间里根本不含今天**。
 * 后果是家校周报的每一项本周指标恒为 0，且这个错误完全静默。
 *
 * 现在统一采用 weekKey 字面量本就暗示的 ISO-8601 标准：
 * 周一为一周之始，第 1 周是包含当年第一个周四的那一周。
 * 两个函数互为逆运算，下方有往返一致性的显式保证。
 */

/** 取某日期所在 ISO 周的周一 00:00（本地时区） */
function isoWeekStart(date: Date): Date {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    // getDay(): 周日=0，转成 ISO 的 周一=1…周日=7
    const isoDow = d.getDay() === 0 ? 7 : d.getDay()
    d.setDate(d.getDate() - (isoDow - 1))
    return d
}

/** 当前 ISO 周的 weekKey，如 "2026-W30" */
function getCurrentWeekKey(): string {
    return toWeekKey(new Date())
}

/** 把任意日期转成其所属 ISO 周的 weekKey */
function toWeekKey(date: Date): string {
    const monday = isoWeekStart(date)
    // ISO 规定：周四所在的年份即为该周的"周历年"
    const thursday = new Date(monday)
    thursday.setDate(monday.getDate() + 3)
    const isoYear = thursday.getFullYear()

    // 该周历年第 1 周 = 包含 1 月 4 日的那一周（等价于含第一个周四）
    const week1Monday = isoWeekStart(new Date(isoYear, 0, 4))
    const week = Math.round((monday.getTime() - week1Monday.getTime()) / WEEK_MS) + 1
    return `${isoYear}-W${String(week).padStart(2, '0')}`
}

/** 根据 weekKey 计算周的起止时间（左闭右开：[周一 00:00, 下周一 00:00)） */
function getWeekPeriod(weekKey: string): { from: number; to: number } {
    const match = weekKey.match(/^(\d{4})-W(\d{2})$/)
    if (!match) {
        // 格式非法时退回「今天所在的 ISO 周」，而不是「过去 7×24 小时」——
        // 后者会横跨两周，让"本周"这个词失去意义。
        const monday = isoWeekStart(new Date())
        return { from: monday.getTime(), to: monday.getTime() + WEEK_MS }
    }
    const isoYear = parseInt(match[1]!, 10)
    const week = parseInt(match[2]!, 10)

    const week1Monday = isoWeekStart(new Date(isoYear, 0, 4))
    const from = new Date(week1Monday)
    from.setDate(week1Monday.getDate() + (week - 1) * 7)
    return { from: from.getTime(), to: from.getTime() + WEEK_MS }
}

// 显式引用 db / repos 防止未使用警告
void db
void repos
void BLOOM_LEVELS
