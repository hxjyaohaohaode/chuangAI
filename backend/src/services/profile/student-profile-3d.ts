/**
 * 学生立体画像服务（画像报告 · 能力 1）
 *
 * 聚合 5 维度数据，生成结构化立体画像：
 *   1. 知识维度（knowledge）：按诗 × 六阶的掌握矩阵，覆盖广度与深度
 *   2. 能力维度（ability）：Bloom 六阶雷达，认知层级发展均衡度
 *   3. 行为维度（behavior）：参与度、答题频次、朗读完成率、最近活跃
 *   4. 兴趣维度（interest）：偏好朝代 / 主题 / 修辞，学习路径选择倾向
 *   5. 成长维度（growth）：近 30 天掌握度变化趋势、进步幅度
 *
 * 自动生成 5-8 个画像标签（如"记忆达人""应用薄弱""唐宋爱好者"），
 * 并调用 deepseek-v4-pro 生成自然语言画像描述（约 200 字）。
 *
 * 设计要点：
 * - LLM 使用 deepseek-v4-pro，thinking: medium（画像分析属"分析"层级）
 * - 结果缓存至 SqliteMap（profile_3d 表），强制刷新时跳过缓存
 * - LLM 失败时降级返回算法生成的标签 + 模板描述（不阻塞响应）
 * - 所有数据查询失败静默降级为 0 / 空数组，保证画像可用
 */

import { db, repos, services } from '../../db/index.js'
import { managedLLM } from '../../llm/index.js'
import { SqliteMap } from '../../db/runtime-store.js'
import type { BloomLevel } from '../../agents/base/types.js'
import type { ChatMessage } from '../../llm/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 知识维度：按诗聚合的掌握度 */
export interface KnowledgeDimension {
    /** 已学诗总数 */
    learnedPoemCount: number
    /** 平均掌握度 0-100 */
    avgMastery: number
    /** 已掌握（≥80）诗数 */
    masteredCount: number
    /** 薄弱（<60）诗数 */
    weakCount: number
    /** 知识覆盖广度 0-100（已学诗 / 班级总诗数） */
    coverage: number
}

/** 能力维度：Bloom 六阶 */
export interface AbilityDimension {
    /** 六阶雷达（0-100） */
    radar: Record<BloomLevel, number>
    /** 最强阶层 */
    strongest: BloomLevel
    /** 最弱阶层 */
    weakest: BloomLevel
    /** 六阶均衡度 0-100（标准差越小越均衡） */
    balance: number
}

/** 行为维度 */
export interface BehaviorDimension {
    /** 参与度 0-1（来自 students.engagement_score） */
    engagement: number
    /** 总答题次数 */
    totalAttempts: number
    /** 正确率 0-100 */
    correctRate: number
    /** 朗读完成数 */
    recitationCount: number
    /** 最近活跃时间戳 */
    lastActiveAt: number | null
    /** 活跃等级：active / normal / quiet */
    activityLevel: 'active' | 'normal' | 'quiet'
}

/** 兴趣维度 */
export interface InterestDimension {
    /** 偏好朝代 Top 3 */
    topDynasties: Array<{ dynasty: string; count: number }>
    /** 偏好主题 Top 3 */
    topThemes: Array<{ theme: string; count: number }>
    /** 偏好修辞 Top 3 */
    topRhetoric: Array<{ rhetoric: string; count: number }>
    /** 兴趣集中度 0-100（Top1 占比越高越集中） */
    concentration: number
}

/** 成长维度 */
export interface GrowthDimension {
    /** 近 30 天按自然日聚合的掌握度时间点（仅包含真实作答日期） */
    masteryTrend: Array<{ date: number; mastery: number }>
    /** 近 30 天掌握度变化（末值 - 初值） */
    delta: number
    /** 进步趋势：rising / stable / declining */
    trend: 'rising' | 'stable' | 'declining'
    /** 近 7 天 vs 近 30 天均值差（短期加速度） */
    momentum: number
    /** 班级排名百分位 0-100（越高越靠前） */
    classPercentile: number
}

/** 立体画像完整结构 */
export interface StudentProfile3D {
    studentId: string
    anonymousName: string
    /** 画像生成时间戳 */
    generatedAt: number
    /** 是否 AI 生成描述 */
    aiGenerated: boolean
    /** 5 维度数据 */
    dimensions: {
        knowledge: KnowledgeDimension
        ability: AbilityDimension
        behavior: BehaviorDimension
        interest: InterestDimension
        growth: GrowthDimension
    }
    /** 自动生成的画像标签（5-8 个） */
    tags: string[]
    /** 自然语言画像描述（约 200 字） */
    description: string
    /** 画像可信度 0-1（数据量不足时降低） */
    confidence: number
}

/** 立体画像响应（含缓存标记） */
export interface StudentProfile3DResponse {
    profile: StudentProfile3D
    /** 是否命中缓存 */
    cached: boolean
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const BLOOM_LEVELS: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

/** 掌握度阈值 */
const MASTERY_THRESHOLD = 80
const WEAK_THRESHOLD = 60

/** 活跃度阈值（最近活跃距今天数） */
const ACTIVE_DAYS = 3
const QUIET_DAYS = 14

/** 缓存有效期（1 小时） */
const CACHE_TTL_MS = 60 * 60 * 1000

/** LLM 超时（ms） */
const LLM_TIMEOUT_MS = 30_000

// ─────────────────────────────────────────────────────────────
// 缓存存储
// ─────────────────────────────────────────────────────────────

const profileCache = new SqliteMap<string, StudentProfile3D>({
    table: 'profile_3d_cache',
    indexes: [{ name: 'student_id', extract: (v) => v.studentId }],
})

// ─────────────────────────────────────────────────────────────
// 主服务
// ─────────────────────────────────────────────────────────────

/**
 * 生成学生立体画像
 *
 * @param studentId 学生 ID
 * @param forceRefresh 是否强制刷新（跳过缓存）
 */
export async function generateStudentProfile3D(
    studentId: string,
    forceRefresh = false,
): Promise<StudentProfile3DResponse> {
    // 1. 缓存检查
    if (!forceRefresh) {
        const cached = profileCache.get(studentId)
        if (cached && Date.now() - cached.generatedAt < CACHE_TTL_MS) {
            return { profile: cached, cached: true }
        }
    }

    // 2. 查询学生基本信息
    const student = repos.students.findById(studentId)
    const anonymousName = student?.anonymousName ?? `学生${studentId.slice(-4)}`

    // 3. 并行聚合 5 维度数据
    const [knowledge, ability, behavior, interest, growth] = await Promise.all([
        computeKnowledgeDimension(studentId),
        computeAbilityDimension(studentId),
        computeBehaviorDimension(studentId),
        computeInterestDimension(studentId),
        computeGrowthDimension(studentId),
    ])

    // 4. 计算置信度
    const confidence = computeConfidence(knowledge, behavior)

    // 5. 生成标签
    const tags = generateTags({ knowledge, ability, behavior, interest, growth })

    // 6. 调用 LLM 生成自然语言描述（失败降级）
    let description = ''
    let aiGenerated = false
    try {
        description = await generateDescriptionByLLM(
            studentId,
            anonymousName,
            { knowledge, ability, behavior, interest, growth },
            tags,
            confidence,
        )
        aiGenerated = true
    } catch {
        description = generateFallbackDescription(anonymousName, tags, {
            knowledge,
            ability,
            behavior,
            interest,
            growth,
        })
    }

    // 7. 组装画像
    const profile: StudentProfile3D = {
        studentId,
        anonymousName,
        generatedAt: Date.now(),
        aiGenerated,
        dimensions: {
            knowledge,
            ability,
            behavior,
            interest,
            growth,
        },
        tags,
        description,
        confidence,
    }

    // 8. 写入缓存
    profileCache.set(studentId, profile)

    return { profile, cached: false }
}

// ─────────────────────────────────────────────────────────────
// 维度计算函数
// ─────────────────────────────────────────────────────────────

/** 知识维度：按诗聚合掌握度 */
function computeKnowledgeDimension(studentId: string): KnowledgeDimension {
    try {
        const rows = repos.mastery.findByStudentId(studentId)
        const poemSet = new Set<string>()
        let totalScore = 0
        let scoreCount = 0
        let mastered = 0
        let weak = 0

        // 按诗聚合六阶均值
        const poemScores = new Map<string, number[]>()
        for (const r of rows) {
            poemSet.add(r.poemId)
            const arr = poemScores.get(r.poemId) ?? []
            arr.push(r.score)
            poemScores.set(r.poemId, arr)
        }

        for (const [, scores] of poemScores) {
            const avg = scores.reduce((a, b) => a + b, 0) / scores.length
            totalScore += avg
            scoreCount += 1
            if (avg >= MASTERY_THRESHOLD) mastered += 1
            if (avg < WEAK_THRESHOLD) weak += 1
        }

        // 班级总诗数（用于覆盖广度）
        const student = repos.students.findById(studentId)
        let classTotalPoems = 0
        if (student) {
            const row = db
                .prepare('SELECT COUNT(DISTINCT poem_id) as cnt FROM mastery m JOIN students s ON m.student_id = s.id WHERE s.class_id = ?')
                .get(student.classId) as { cnt: number } | undefined
            classTotalPoems = row?.cnt ?? poemSet.size
        }

        return {
            learnedPoemCount: poemSet.size,
            avgMastery: scoreCount > 0 ? Math.round((totalScore / scoreCount) * 100) / 100 : 0,
            masteredCount: mastered,
            weakCount: weak,
            coverage: classTotalPoems > 0 ? Math.round((poemSet.size / classTotalPoems) * 10000) / 100 : 0,
        }
    } catch {
        return {
            learnedPoemCount: 0,
            avgMastery: 0,
            masteredCount: 0,
            weakCount: 0,
            coverage: 0,
        }
    }
}

/** 能力维度：Bloom 六阶雷达 */
function computeAbilityDimension(studentId: string): AbilityDimension {
    const emptyRadar: Record<BloomLevel, number> = {
        记忆: 0, 理解: 0, 应用: 0, 分析: 0, 评价: 0, 创造: 0,
    }
    try {
        const rows = repos.mastery.getStudentBloomRadarViaView(studentId)
        const radar: Record<BloomLevel, number> = { ...emptyRadar }
        for (const r of rows) {
            const level = r.bloom_level as BloomLevel
            if (BLOOM_LEVELS.includes(level)) {
                radar[level] = Math.round((r.avg_score ?? 0) * 100) / 100
            }
        }

        // 找最强 / 最弱
        let strongest: BloomLevel = '记忆'
        let weakest: BloomLevel = '记忆'
        let maxScore = -1
        let minScore = 101
        for (const lv of BLOOM_LEVELS) {
            const score = radar[lv]
            if (score > maxScore) {
                maxScore = score
                strongest = lv
            }
            if (score < minScore) {
                minScore = score
                weakest = lv
            }
        }

        // 均衡度：标准差越小越均衡，映射到 0-100
        const scores = BLOOM_LEVELS.map((lv) => radar[lv]).filter((s) => s > 0)
        const balance = computeBalance(scores)

        return { radar, strongest, weakest, balance }
    } catch {
        return { radar: emptyRadar, strongest: '记忆', weakest: '记忆', balance: 0 }
    }
}

/** 行为维度：参与度 + 答题 + 朗读 + 活跃 */
function computeBehaviorDimension(studentId: string): BehaviorDimension {
    try {
        const engagement = services.event.calculateEngagement(studentId, 7)

        // 答题统计
        const rows = repos.mastery.findByStudentId(studentId)
        const totalAttempts = rows.reduce((sum, r) => sum + r.attempts, 0)
        const totalCorrect = rows.reduce((sum, r) => sum + r.correctCount, 0)
        const correctRate = totalAttempts > 0 ? Math.round((totalCorrect / totalAttempts) * 10000) / 100 : 0

        // 朗读完成数
        let recitationCount = 0
        try {
            const recitations = repos.recitations.findByStudentId(studentId)
            recitationCount = recitations.length
        } catch {
            // recitations 表可能无数据
        }

        // 最近活跃时间
        let lastActiveAt: number | null = null
        const timestamps: number[] = []
        for (const r of rows) {
            if (r.lastAttemptAt) timestamps.push(r.lastAttemptAt)
        }
        if (timestamps.length > 0) {
            lastActiveAt = Math.max(...timestamps)
        }
        if (recitationCount > 0) {
            try {
                const recitations = repos.recitations.findByStudentId(studentId)
                for (const r of recitations) {
                    if (r.createdAt) timestamps.push(r.createdAt)
                }
                if (timestamps.length > 0) {
                    lastActiveAt = Math.max(...timestamps)
                }
            } catch {
                // ignore
            }
        }

        // 活跃等级
        let activityLevel: 'active' | 'normal' | 'quiet' = 'normal'
        if (lastActiveAt) {
            const daysSince = (Date.now() - lastActiveAt) / (24 * 60 * 60 * 1000)
            if (daysSince <= ACTIVE_DAYS) activityLevel = 'active'
            else if (daysSince > QUIET_DAYS) activityLevel = 'quiet'
        } else {
            activityLevel = 'quiet'
        }

        return {
            engagement: Math.round(engagement * 100) / 100,
            totalAttempts,
            correctRate,
            recitationCount,
            lastActiveAt,
            activityLevel,
        }
    } catch {
        return {
            engagement: 0,
            totalAttempts: 0,
            correctRate: 0,
            recitationCount: 0,
            lastActiveAt: null,
            activityLevel: 'quiet',
        }
    }
}

/** 兴趣维度：偏好朝代 / 主题 / 修辞 */
function computeInterestDimension(studentId: string): InterestDimension {
    try {
        const rows = repos.mastery.findByStudentId(studentId)
        const poemIds = [...new Set(rows.map((r) => r.poemId))]

        // 批量查询诗的朝代 / 主题 / 修辞
        const dynastyCount = new Map<string, number>()
        const themeCount = new Map<string, number>()
        const rhetoricCount = new Map<string, number>()

        for (const poemId of poemIds) {
            const poem = repos.poems.findById(poemId)
            if (!poem) continue
            // 朝代
            dynastyCount.set(poem.dynasty, (dynastyCount.get(poem.dynasty) ?? 0) + 1)
            // 主题（已是 string[] 数组，由 PoemRepository.fromRow 的 parseStringArray 处理）
            if (Array.isArray(poem.theme)) {
                for (const t of poem.theme) {
                    themeCount.set(t, (themeCount.get(t) ?? 0) + 1)
                }
            }
            // 修辞（同上）
            if (Array.isArray(poem.rhetoric)) {
                for (const r of poem.rhetoric) {
                    rhetoricCount.set(r, (rhetoricCount.get(r) ?? 0) + 1)
                }
            }
        }

        const topDynasties = toDynastyItems(sortByCount(dynastyCount)).slice(0, 3)
        const topThemes = toThemeItems(sortByCount(themeCount)).slice(0, 3)
        const topRhetoric = toRhetoricItems(sortByCount(rhetoricCount)).slice(0, 3)

        // 兴趣集中度：Top1 朝代占比
        const totalDynasty = [...dynastyCount.values()].reduce((a, b) => a + b, 0)
        const concentration = totalDynasty > 0 && topDynasties[0]
            ? Math.round((topDynasties[0].count / totalDynasty) * 10000) / 100
            : 0

        return { topDynasties, topThemes, topRhetoric, concentration }
    } catch {
        return {
            topDynasties: [],
            topThemes: [],
            topRhetoric: [],
            concentration: 0,
        }
    }
}

/** 成长维度：掌握度变化趋势 + 班级排名百分位 */
function computeGrowthDimension(studentId: string): GrowthDimension {
    try {
        const now = Date.now()
        const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000
        const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000

        const rows = repos.mastery.findByStudentId(studentId)

        // 近 30 天前半段（15-30 天前）vs 后半段（0-15 天前）的均值
        const earlyScores: number[] = []
        const lateScores: number[] = []
        const recent7Scores: number[] = []
        const recent30Scores: number[] = []
        const dailyScores = new Map<number, number[]>()

        for (const r of rows) {
            const ts = r.lastAttemptAt ?? r.updatedAt
            if (!ts) continue
            const score = r.score
            if (ts < thirtyDaysAgo) continue
            recent30Scores.push(score)
            const date = new Date(ts)
            date.setHours(0, 0, 0, 0)
            const day = date.getTime()
            const values = dailyScores.get(day) ?? []
            values.push(score)
            dailyScores.set(day, values)
            if (ts < sevenDaysAgo) {
                earlyScores.push(score)
            } else {
                lateScores.push(score)
                recent7Scores.push(score)
            }
        }

        const earlyAvg = earlyScores.length > 0 ? earlyScores.reduce((a, b) => a + b, 0) / earlyScores.length : 0
        const lateAvg = lateScores.length > 0 ? lateScores.reduce((a, b) => a + b, 0) / lateScores.length : 0
        const recent7Avg = recent7Scores.length > 0 ? recent7Scores.reduce((a, b) => a + b, 0) / recent7Scores.length : 0
        const recent30Avg = recent30Scores.length > 0 ? recent30Scores.reduce((a, b) => a + b, 0) / recent30Scores.length : 0

        const delta = Math.round((lateAvg - earlyAvg) * 100) / 100
        const momentum = Math.round((recent7Avg - recent30Avg) * 100) / 100
        const masteryTrend = [...dailyScores.entries()]
            .sort(([a], [b]) => a - b)
            .map(([date, scores]) => ({
                date,
                mastery: Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100) / 100,
            }))

        let trend: 'rising' | 'stable' | 'declining' = 'stable'
        if (delta > 5) trend = 'rising'
        else if (delta < -5) trend = 'declining'

        // 班级排名百分位
        const classPercentile = computeClassPercentile(studentId)

        return { masteryTrend, delta, trend, momentum, classPercentile }
    } catch {
        return { masteryTrend: [], delta: 0, trend: 'stable', momentum: 0, classPercentile: 50 }
    }
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

/** 计算均衡度（标准差映射到 0-100，越小越均衡） */
function computeBalance(scores: number[]): number {
    if (scores.length < 2) return 0
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length
    const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length
    const stdDev = Math.sqrt(variance)
    // 标准差 0 → 100 分（完全均衡），标准差 50 → 0 分（极不均衡）
    return Math.max(0, Math.min(100, Math.round((100 - stdDev * 2) * 100) / 100))
}

/** Map 按计数降序排序（通用：返回 name/count 对） */
function sortByCount(map: Map<string, number>): Array<{ name: string; count: number }> {
    return [...map.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
}

/** 将通用 name/count 转为朝代维度 */
function toDynastyItems(list: Array<{ name: string; count: number }>): Array<{ dynasty: string; count: number }> {
    return list.map((i) => ({ dynasty: i.name, count: i.count }))
}

/** 将通用 name/count 转为主题维度 */
function toThemeItems(list: Array<{ name: string; count: number }>): Array<{ theme: string; count: number }> {
    return list.map((i) => ({ theme: i.name, count: i.count }))
}

/** 将通用 name/count 转为修辞维度 */
function toRhetoricItems(list: Array<{ name: string; count: number }>): Array<{ rhetoric: string; count: number }> {
    return list.map((i) => ({ rhetoric: i.name, count: i.count }))
}

/** 计算班级排名百分位 */
function computeClassPercentile(studentId: string): number {
    try {
        const student = repos.students.findById(studentId)
        if (!student) return 50

        // 查询班级所有学生的平均掌握度
        const rows = db
            .prepare(`
                SELECT s.id as student_id, AVG(m.score) as avg_score
                FROM students s
                LEFT JOIN mastery m ON m.student_id = s.id
                WHERE s.class_id = ?
                GROUP BY s.id
                ORDER BY avg_score DESC
            `)
            .all(student.classId) as Array<{ student_id: string; avg_score: number | null }>

        const total = rows.length
        if (total === 0) return 50

        const myRow = rows.find((r) => r.student_id === studentId)
        const myScore = myRow?.avg_score ?? 0
        const rank = rows.filter((r) => (r.avg_score ?? 0) > myScore).length
        return Math.round(((total - rank) / total) * 10000) / 100
    } catch {
        return 50
    }
}

/** 计算画像置信度 */
function computeConfidence(knowledge: KnowledgeDimension, behavior: BehaviorDimension): number {
    let confidence = 0.3
    if (knowledge.learnedPoemCount >= 5) confidence += 0.2
    if (knowledge.learnedPoemCount >= 10) confidence += 0.1
    if (behavior.totalAttempts >= 10) confidence += 0.2
    if (behavior.recitationCount >= 3) confidence += 0.1
    if (behavior.lastActiveAt && Date.now() - behavior.lastActiveAt < 7 * 24 * 60 * 60 * 1000) confidence += 0.1
    return Math.min(1, Math.round(confidence * 100) / 100)
}

/** 基于维度数据生成画像标签 */
function generateTags(dims: {
    knowledge: KnowledgeDimension
    ability: AbilityDimension
    behavior: BehaviorDimension
    interest: InterestDimension
    growth: GrowthDimension
}): string[] {
    const tags: string[] = []

    // 能力维度标签
    if (dims.ability.radar['记忆'] >= 80) tags.push('记忆达人')
    if (dims.ability.radar['创造'] >= 70) tags.push('创意涌现')
    if (dims.ability.radar['分析'] >= 75) tags.push('善析能辨')
    if (dims.ability.weakest === '应用' && dims.ability.radar['应用'] < 60) tags.push('应用待强化')
    if (dims.ability.weakest === '评价' && dims.ability.radar['评价'] < 60) tags.push('评价待提升')
    if (dims.ability.balance >= 75) tags.push('六阶均衡')

    // 知识维度标签
    if (dims.knowledge.coverage >= 70) tags.push('涉猎广泛')
    if (dims.knowledge.masteredCount >= 5) tags.push('稳扎稳打')
    if (dims.knowledge.weakCount >= 3) tags.push('有待补漏')

    // 行为维度标签
    if (dims.behavior.activityLevel === 'active') tags.push('活跃积极')
    else if (dims.behavior.activityLevel === 'quiet') tags.push('需多关注')
    if (dims.behavior.recitationCount >= 5) tags.push('朗读勤勉')
    if (dims.behavior.correctRate >= 80) tags.push('答题精准')

    // 兴趣维度标签
    if (dims.interest.topDynasties[0]) {
        const dynasty = dims.interest.topDynasties[0].dynasty
        if (dynasty === '唐') tags.push('唐诗爱好者')
        else if (dynasty === '宋') tags.push('宋词钟情者')
        else tags.push(`${dynasty}诗偏爱`)
    }

    // 成长维度标签
    if (dims.growth.trend === 'rising' && dims.growth.delta > 10) tags.push('进步显著')
    else if (dims.growth.trend === 'declining' && dims.growth.delta < -10) tags.push('需防下滑')
    if (dims.growth.classPercentile >= 80) tags.push('名列前茅')

    // 去重 + 限制 5-8 个
    const unique = [...new Set(tags)]
    return unique.slice(0, 8).length >= 5 ? unique.slice(0, 8) : unique
}

/** LLM 生成自然语言画像描述 */
async function generateDescriptionByLLM(
    studentId: string,
    anonymousName: string,
    dims: {
        knowledge: KnowledgeDimension
        ability: AbilityDimension
        behavior: BehaviorDimension
        interest: InterestDimension
        growth: GrowthDimension
    },
    tags: string[],
    confidence: number,
): Promise<string> {
    const systemPrompt = `你是诗心·学生画像分析师，专精中国小学古诗词教学与布鲁姆认知分类法。
你的任务是基于学生的 5 维度学情数据，生成一段约 200 字的自然语言画像描述。

要求：
1. 描述应客观、积极、有温度，避免负面标签化表述
2. 覆盖知识掌握、能力特点、学习行为、兴趣偏好、成长趋势 5 个方面
3. 给出 1 条具体可操作的教学建议
4. 学生姓名使用脱敏编号（如 S01），不使用真实姓名
5. 输出纯文本，不使用 Markdown 标记`

    const userPrompt = `请为以下学生生成画像描述：

学生编号：${anonymousName}
画像置信度：${confidence}

【知识维度】
- 已学诗数：${dims.knowledge.learnedPoemCount}
- 平均掌握度：${dims.knowledge.avgMastery}
- 已掌握（≥80）诗数：${dims.knowledge.masteredCount}
- 薄弱（<60）诗数：${dims.knowledge.weakCount}
- 知识覆盖广度：${dims.knowledge.coverage}%

【能力维度 · Bloom 六阶】
- 记忆：${dims.ability.radar['记忆']}
- 理解：${dims.ability.radar['理解']}
- 应用：${dims.ability.radar['应用']}
- 分析：${dims.ability.radar['分析']}
- 评价：${dims.ability.radar['评价']}
- 创造：${dims.ability.radar['创造']}
- 最强阶层：${dims.ability.strongest}
- 最弱阶层：${dims.ability.weakest}
- 六阶均衡度：${dims.ability.balance}%

【行为维度】
- 参与度：${dims.behavior.engagement}
- 总答题次数：${dims.behavior.totalAttempts}
- 正确率：${dims.behavior.correctRate}%
- 朗读完成数：${dims.behavior.recitationCount}
- 活跃等级：${dims.behavior.activityLevel}

【兴趣维度】
- 偏好朝代：${dims.interest.topDynasties.map((d) => `${d.dynasty}(${d.count})`).join('、') || '暂无'}
- 偏好主题：${dims.interest.topThemes.map((t) => `${t.theme}(${t.count})`).join('、') || '暂无'}
- 兴趣集中度：${dims.interest.concentration}%

【成长维度】
- 近 30 天掌握度变化：${dims.growth.delta}
- 进步趋势：${dims.growth.trend}
- 短期加速度：${dims.growth.momentum}
- 班级排名百分位：${dims.growth.classPercentile}%

【画像标签】${tags.join('、')}

请生成约 200 字的画像描述，并在末尾给出 1 条教学建议。`

    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ]

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

    try {
        const result = await managedLLM.chat({
            model: 'deepseek-v4-pro',
            messages,
            thinking: 'medium',
            temperature: 0.7,
            maxTokens: 600,
            signal: controller.signal,
            metadata: {
                agent: 'profile-3d',
                task: `student-profile-${studentId}`,
            },
        })
        return result.content.trim()
    } finally {
        clearTimeout(timeoutId)
    }
}

/** LLM 失败时的降级描述 */
function generateFallbackDescription(
    anonymousName: string,
    tags: string[],
    dims: {
        knowledge: KnowledgeDimension
        ability: AbilityDimension
        behavior: BehaviorDimension
        interest: InterestDimension
        growth: GrowthDimension
    },
): string {
    const parts: string[] = []
    parts.push(`${anonymousName} 已学习 ${dims.knowledge.learnedPoemCount} 首古诗，平均掌握度 ${dims.knowledge.avgMastery}。`)
    parts.push(`六阶能力中，${dims.ability.strongest}层表现最强（${dims.ability.radar[dims.ability.strongest]}），${dims.ability.weakest}层有待加强（${dims.ability.radar[dims.ability.weakest]}）。`)
    if (dims.behavior.activityLevel === 'active') {
        parts.push(`学习状态积极，近期活跃度高。`)
    } else if (dims.behavior.activityLevel === 'quiet') {
        parts.push(`近期活跃度偏低，建议加强关注。`)
    }
    if (dims.growth.trend === 'rising') {
        parts.push(`近 30 天进步明显（+${dims.growth.delta}），班级排名百分位 ${dims.growth.classPercentile}%。`)
    } else if (dims.growth.trend === 'declining') {
        parts.push(`近 30 天掌握度有所下滑（${dims.growth.delta}），需关注学习状态。`)
    }
    parts.push(`教学建议：针对${dims.ability.weakest}层薄弱点，推荐使用六阶沉浸式教学进行专项强化。`)
    if (tags.length > 0) {
        parts.push(`学生标签：${tags.slice(0, 5).join('、')}。`)
    }
    return parts.join('')
}
