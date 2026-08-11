/**
 * 班级热点画像服务（画像报告 · 能力 2）
 *
 * 聚合班级维度的共性特征，识别 5 类热点：
 *   1. 共性优势（common-strength）：班级整体表现突出的 Bloom 层级
 *   2. 共性薄弱（common-weakness）：班级整体偏弱的 Bloom 层级 / 诗篇
 *   3. 异常关注（anomaly）：偏离班级均值较大的学生（异常高 / 异常低）
 *   4. 兴趣趋势（interest-trend）：班级偏好朝代 / 主题分布
 *   5. 互动热点（engagement-hotspot）：高互动学生 + 低互动学生群体
 *
 * 调用 deepseek-v4-pro 生成班级画像自然语言描述（约 300 字）。
 *
 * 设计要点：
 * - LLM 使用 deepseek-v4-pro，thinking: medium
 * - 结果缓存至 SqliteMap（class_hotspot_cache 表），1 小时有效期
 * - LLM 失败时降级返回算法生成的结构化数据 + 模板描述
 * - 数据查询失败静默降级为空数组
 */

import { db, repos, services } from '../../db/index.js'
import { managedLLM } from '../../llm/index.js'
import { SqliteMap } from '../../db/runtime-store.js'
import type { BloomLevel } from '../../agents/base/types.js'
import type { ChatMessage } from '../../llm/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 热点类型 */
export type HotspotType =
    | 'common-strength'
    | 'common-weakness'
    | 'anomaly'
    | 'interest-trend'
    | 'engagement-hotspot'

/** 共性优势 */
export interface CommonStrength {
    type: 'common-strength'
    /** 优势维度：bloom 层级 / 诗篇 / 主题 */
    dimension: string
    /** 优势描述 */
    description: string
    /** 班级均值 0-100 */
    avgScore: number
    /** 达到优秀（≥80）的学生占比 0-100 */
    excellentRatio: number
}

/** 共性薄弱 */
export interface CommonWeakness {
    type: 'common-weakness'
    dimension: string
    description: string
    avgScore: number
    /** 低于 60 的学生占比 0-100 */
    weakRatio: number
    /** 受影响学生数 */
    affectedCount: number
}

/** 异常关注 */
export interface AnomalyItem {
    type: 'anomaly'
    /** 学生 ID */
    studentId: string
    /** 脱敏名 */
    anonymousName: string
    /** 异常类型：outperform（异常优秀）/ underperform（异常薄弱） */
    anomalyType: 'outperform' | 'underperform'
    /** 异常维度 */
    dimension: string
    /** 学生得分 */
    studentScore: number
    /** 班级均值 */
    classAvg: number
    /** 偏离幅度 */
    deviation: number
}

/** 兴趣趋势 */
export interface InterestTrend {
    type: 'interest-trend'
    /** 班级偏好朝代分布 */
    dynastyDistribution: Array<{ dynasty: string; count: number; ratio: number }>
    /** 班级偏好主题分布 */
    themeDistribution: Array<{ theme: string; count: number }>
    /** 热门诗篇 Top 5 */
    hotPoems: Array<{ poemId: string; title: string; poet: string; learnedCount: number }>
}

/** 互动热点 */
export interface EngagementHotspot {
    type: 'engagement-hotspot'
    /** 是否存在可追溯的近 7 天学习事件；false 时不得输出活跃度结论 */
    hasObservedData: boolean
    /** 高互动学生（engagement ≥ 0.7） */
    highEngagement: Array<{ studentId: string; anonymousName: string; engagement: number }>
    /** 低互动学生（engagement < 0.4） */
    lowEngagement: Array<{ studentId: string; anonymousName: string; engagement: number }>
    /** 班级平均参与度 */
    classAvgEngagement: number
    /** 班级活跃度等级 */
    activityLevel: 'high' | 'medium' | 'low'
}

/** 班级热点画像完整结构 */
export interface ClassHotspot {
    classId: string
    className: string
    generatedAt: number
    aiGenerated: boolean
    hotspots: {
        strengths: CommonStrength[]
        weaknesses: CommonWeakness[]
        anomalies: AnomalyItem[]
        interestTrend: InterestTrend
        engagement: EngagementHotspot
    }
    /** 班级画像描述（约 300 字） */
    description: string
}

export interface ClassHotspotResponse {
    hotspot: ClassHotspot
    cached: boolean
}

/**
 * 班级热点只允许为真实存在的班级生成。
 *
 * 使用独立错误类型，避免路由把“资源不存在”误降级为一个看似成功的空画像，
 * 同时让未来的非 HTTP 调用方也能可靠地区分 404 语义与基础设施故障。
 */
export class ClassHotspotClassNotFoundError extends Error {
    readonly code = 'CLASS_NOT_FOUND'
    readonly statusCode = 404

    constructor(readonly classId: string) {
        super('班级不存在')
        this.name = 'ClassHotspotClassNotFoundError'
    }
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const BLOOM_LEVELS: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_KEY_VERSION = 'v2'
const LLM_TIMEOUT_MS = 30_000

const EXCELLENT_THRESHOLD = 80
const WEAK_THRESHOLD = 60
const HIGH_ENGAGEMENT = 0.7
const LOW_ENGAGEMENT = 0.4
const ANOMALY_THRESHOLD = 20

// ─────────────────────────────────────────────────────────────
// 缓存
// ─────────────────────────────────────────────────────────────

const hotspotCache = new SqliteMap<string, ClassHotspot>({
    table: 'class_hotspot_cache',
    indexes: [{ name: 'class_id', extract: (v) => v.classId }],
})

/** 学情事件写入后使对应班级画像失效，避免 1 小时内继续展示旧结论。 */
export function invalidateClassHotspot(classId: string): boolean {
    return hotspotCache.delete(`${CACHE_KEY_VERSION}:${classId}`)
}

// ─────────────────────────────────────────────────────────────
// 主服务
// ─────────────────────────────────────────────────────────────

export async function generateClassHotspot(
    classId: string,
    forceRefresh = false,
    enrichWithAi = forceRefresh,
): Promise<ClassHotspotResponse> {
    const cacheKey = `${CACHE_KEY_VERSION}:${classId}`

    // 必须先验证真相源，再读取缓存。旧实现先读缓存且把不存在的班级命名为
    // “未知班级”继续计算，导致无效 ID 被持久化成一个长期返回 200 的伪资源。
    const classEntity = repos.classes.findById(classId)
    if (!classEntity) {
        // 清除升级前可能已经写入的毒化缓存；delete 对不存在的 key 是幂等的。
        hotspotCache.delete(cacheKey)
        throw new ClassHotspotClassNotFoundError(classId)
    }

    // 缓存检查
    if (!forceRefresh) {
        const cached = hotspotCache.get(cacheKey)
        if (cached && Date.now() - cached.generatedAt < CACHE_TTL_MS) {
            return { hotspot: cached, cached: true }
        }
    }

    const className = classEntity.name

    // 并行聚合 5 类热点
    const [strengths, weaknesses, anomalies, interestTrend, engagement] = await Promise.all([
        computeStrengths(classId),
        computeWeaknesses(classId),
        computeAnomalies(classId),
        computeInterestTrend(classId),
        computeEngagement(classId),
    ])

    // 普通 GET 必须在前端 15 秒超时之前稳定返回。旧实现每次缓存未命中都
    // 等待最长 30 秒的 LLM 描述，导致本地聚合已经完成、页面却先行超时。
    // 只有教师显式“刷新热点”时才等待 AI 润色；普通读取使用可解释的本地描述。
    let description = generateFallbackDescription(className, {
        strengths, weaknesses, anomalies, interestTrend, engagement,
    })
    let aiGenerated = false
    if (enrichWithAi && engagement.hasObservedData) {
        try {
            description = await generateDescriptionByLLM(classId, className, {
                strengths, weaknesses, anomalies, interestTrend, engagement,
            })
            aiGenerated = true
        } catch {
            // 保留已经生成的本地描述，显式以 aiGenerated=false 对外披露。
        }
    }

    const hotspot: ClassHotspot = {
        classId,
        className,
        generatedAt: Date.now(),
        aiGenerated,
        hotspots: {
            strengths,
            weaknesses,
            anomalies,
            interestTrend,
            engagement,
        },
        description,
    }

    // AI 润色最长可持续 30 秒；此期间班级可能被另一请求删除。写缓存前再次
    // 对真相源做同步校验，避免删除竞态重新制造孤儿画像。
    if (!repos.classes.findById(classId)) {
        hotspotCache.delete(cacheKey)
        throw new ClassHotspotClassNotFoundError(classId)
    }

    hotspotCache.set(cacheKey, hotspot)
    return { hotspot, cached: false }
}

// ─────────────────────────────────────────────────────────────
// 热点计算函数
// ─────────────────────────────────────────────────────────────

/** 共性优势 */
function computeStrengths(classId: string): CommonStrength[] {
    try {
        const radar = repos.mastery.getClassBloomRadar(classId)
        const strengths: CommonStrength[] = []

        for (const r of radar) {
            const level = r.bloom_level as BloomLevel
            if (!BLOOM_LEVELS.includes(level)) continue
            const avg = r.avg_score ?? 0
            if (avg >= EXCELLENT_THRESHOLD) {
                // 计算优秀率
                const excellentCount = db
                    .prepare(`
                        SELECT COUNT(DISTINCT m.student_id) as cnt
                        FROM mastery m
                        JOIN students s ON m.student_id = s.id
                        WHERE s.class_id = ? AND m.bloom_level = ? AND m.score >= ?
                    `)
                    .get(classId, level, EXCELLENT_THRESHOLD) as { cnt: number }
                const totalStudents = db
                    .prepare('SELECT COUNT(*) as cnt FROM students WHERE class_id = ?')
                    .get(classId) as { cnt: number }
                const excellentRatio = totalStudents.cnt > 0
                    ? Math.round((excellentCount.cnt / totalStudents.cnt) * 10000) / 100
                    : 0

                strengths.push({
                    type: 'common-strength',
                    dimension: level,
                    description: `班级在"${level}"层级表现突出，均值 ${Math.round(avg * 100) / 100}，优秀率达 ${excellentRatio}%。`,
                    avgScore: Math.round(avg * 100) / 100,
                    excellentRatio,
                })
            }
        }
        return strengths
    } catch {
        return []
    }
}

/** 共性薄弱 */
function computeWeaknesses(classId: string): CommonWeakness[] {
    try {
        const radar = repos.mastery.getClassBloomRadar(classId)
        const weaknesses: CommonWeakness[] = []

        for (const r of radar) {
            const level = r.bloom_level as BloomLevel
            if (!BLOOM_LEVELS.includes(level)) continue
            const avg = r.avg_score ?? 0
            if (avg < WEAK_THRESHOLD && avg > 0) {
                const weakCount = db
                    .prepare(`
                        SELECT COUNT(DISTINCT m.student_id) as cnt
                        FROM mastery m
                        JOIN students s ON m.student_id = s.id
                        WHERE s.class_id = ? AND m.bloom_level = ? AND m.score < ?
                    `)
                    .get(classId, level, WEAK_THRESHOLD) as { cnt: number }
                const totalStudents = db
                    .prepare('SELECT COUNT(*) as cnt FROM students WHERE class_id = ?')
                    .get(classId) as { cnt: number }
                const weakRatio = totalStudents.cnt > 0
                    ? Math.round((weakCount.cnt / totalStudents.cnt) * 10000) / 100
                    : 0

                weaknesses.push({
                    type: 'common-weakness',
                    dimension: level,
                    description: `班级在"${level}"层级普遍薄弱，均值 ${Math.round(avg * 100) / 100}，${weakRatio}% 学生低于 60 分。`,
                    avgScore: Math.round(avg * 100) / 100,
                    weakRatio,
                    affectedCount: weakCount.cnt,
                })
            }
        }
        return weaknesses
    } catch {
        return []
    }
}

/** 异常关注 */
function computeAnomalies(classId: string): AnomalyItem[] {
    try {
        const students = repos.students.findByClassId(classId)
        const classRadar = repos.mastery.getClassBloomRadar(classId)
        const classAvgMap = new Map<string, number>()
        for (const r of classRadar) {
            classAvgMap.set(r.bloom_level, r.avg_score ?? 0)
        }

        const anomalies: AnomalyItem[] = []
        for (const student of students) {
            const studentRadar = repos.mastery.getStudentBloomRadarViaView(student.id)
            for (const sr of studentRadar) {
                const classAvg = classAvgMap.get(sr.bloom_level) ?? 0
                const studentScore = sr.avg_score ?? 0
                const deviation = Math.round((studentScore - classAvg) * 100) / 100

                if (Math.abs(deviation) >= ANOMALY_THRESHOLD) {
                    anomalies.push({
                        type: 'anomaly',
                        studentId: student.id,
                        anonymousName: student.anonymousName,
                        anomalyType: deviation > 0 ? 'outperform' : 'underperform',
                        dimension: sr.bloom_level,
                        studentScore: Math.round(studentScore * 100) / 100,
                        classAvg: Math.round(classAvg * 100) / 100,
                        deviation,
                    })
                }
            }
        }

        // 按偏离幅度排序，取 Top 20
        anomalies.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation))
        return anomalies.slice(0, 20)
    } catch {
        return []
    }
}

/** 兴趣趋势 */
function computeInterestTrend(classId: string): InterestTrend {
    try {
        const students = repos.students.findByClassId(classId)
        const dynastyCount = new Map<string, number>()
        const themeCount = new Map<string, number>()
        const poemLearnedCount = new Map<string, number>()

        for (const student of students) {
            const masteryRows = repos.mastery.findByStudentId(student.id)
            const poemSet = new Set<string>()
            for (const m of masteryRows) {
                poemSet.add(m.poemId)
            }
            for (const poemId of poemSet) {
                poemLearnedCount.set(poemId, (poemLearnedCount.get(poemId) ?? 0) + 1)
                const poem = repos.poems.findById(poemId)
                if (!poem) continue
                dynastyCount.set(poem.dynasty, (dynastyCount.get(poem.dynasty) ?? 0) + 1)
                if (Array.isArray(poem.theme)) {
                    for (const t of poem.theme) {
                        themeCount.set(t, (themeCount.get(t) ?? 0) + 1)
                    }
                }
            }
        }

        const totalLearned = [...dynastyCount.values()].reduce((a, b) => a + b, 0)
        const dynastyDistribution = [...dynastyCount.entries()]
            .map(([dynasty, count]) => ({
                dynasty,
                count,
                ratio: totalLearned > 0 ? Math.round((count / totalLearned) * 10000) / 100 : 0,
            }))
            .sort((a, b) => b.count - a.count)

        const themeDistribution = [...themeCount.entries()]
            .map(([theme, count]) => ({ theme, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5)

        const hotPoems = [...poemLearnedCount.entries()]
            .map(([poemId, learnedCount]) => {
                const poem = repos.poems.findById(poemId)
                return {
                    poemId,
                    title: poem?.title ?? '未知诗篇',
                    poet: poem?.poet ?? '佚名',
                    learnedCount,
                }
            })
            .sort((a, b) => b.learnedCount - a.learnedCount)
            .slice(0, 5)

        return {
            type: 'interest-trend',
            dynastyDistribution,
            themeDistribution,
            hotPoems,
        }
    } catch {
        return {
            type: 'interest-trend',
            dynastyDistribution: [],
            themeDistribution: [],
            hotPoems: [],
        }
    }
}

/**
 * 参与度归一化到 0-1
 *
 * students.engagement_score 历史上按 0-100 分写入（实测区间 30–99），
 * 但阈值常量按 0-1 定义。此处统一收敛：>1 视为百分制并除以 100，
 * ≤1 视为已是比例值直接返回，两种历史数据都能正确判定。
 */
function normalizeEngagement(raw: number): number {
    if (!Number.isFinite(raw) || raw <= 0) return 0
    return raw > 1 ? Math.min(1, raw / 100) : raw
}

/** 互动热点 */
function computeEngagement(classId: string): EngagementHotspot {
    try {
        const students = repos.students.findByClassId(classId)
        const windowStart = Date.now() - 7 * 24 * 60 * 60 * 1000
        const observedEvents = repos.events.findByClassAndTimeRange(
            classId,
            windowStart,
            Date.now(),
        )
        if (observedEvents.length === 0) {
            return {
                type: 'engagement-hotspot',
                hasObservedData: false,
                highEngagement: [],
                lowEngagement: [],
                classAvgEngagement: 0,
                activityLevel: 'low',
            }
        }
        const highEngagement: Array<{ studentId: string; anonymousName: string; engagement: number }> = []
        const lowEngagement: Array<{ studentId: string; anonymousName: string; engagement: number }> = []
        let totalEngagement = 0

        for (const s of students) {
            // 量纲对齐：students.engagement_score 实际存的是 0-100 分，
            // 而下面的 HIGH_ENGAGEMENT(0.7) / LOW_ENGAGEMENT(0.4) 阈值是 0-1 口径。
            // 不做归一化的话所有学生都 ≥0.7，活跃度恒为 high、低互动名单恒为空，
            // 「班级热点画像」的互动结论完全失效。
            const eng = normalizeEngagement(services.event.calculateEngagement(s.id, 7))
            totalEngagement += eng
            const item = { studentId: s.id, anonymousName: s.anonymousName, engagement: Math.round(eng * 100) / 100 }
            if (eng >= HIGH_ENGAGEMENT) {
                highEngagement.push(item)
            } else if (eng < LOW_ENGAGEMENT) {
                lowEngagement.push(item)
            }
        }

        const classAvgEngagement = students.length > 0
            ? Math.round((totalEngagement / students.length) * 100) / 100
            : 0

        let activityLevel: 'high' | 'medium' | 'low' = 'medium'
        if (classAvgEngagement >= HIGH_ENGAGEMENT) activityLevel = 'high'
        else if (classAvgEngagement < LOW_ENGAGEMENT) activityLevel = 'low'

        // 按参与度排序
        highEngagement.sort((a, b) => b.engagement - a.engagement)
        lowEngagement.sort((a, b) => a.engagement - b.engagement)

        return {
            type: 'engagement-hotspot',
            hasObservedData: true,
            highEngagement: highEngagement.slice(0, 10),
            lowEngagement: lowEngagement.slice(0, 10),
            classAvgEngagement,
            activityLevel,
        }
    } catch {
        return {
            type: 'engagement-hotspot',
            hasObservedData: false,
            highEngagement: [],
            lowEngagement: [],
            classAvgEngagement: 0,
            activityLevel: 'low',
        }
    }
}

// ─────────────────────────────────────────────────────────────
// LLM 描述生成
// ─────────────────────────────────────────────────────────────

async function generateDescriptionByLLM(
    classId: string,
    className: string,
    data: {
        strengths: CommonStrength[]
        weaknesses: CommonWeakness[]
        anomalies: AnomalyItem[]
        interestTrend: InterestTrend
        engagement: EngagementHotspot
    },
): Promise<string> {
    const systemPrompt = `你是诗心·班级画像分析师，专精中国小学古诗词教学与班级学情分析。
你的任务是基于班级 5 类热点数据，生成一段约 300 字的班级画像描述。

要求：
1. 描述应客观、积极，指出优势与不足
2. 覆盖共性优势、共性薄弱、异常关注、兴趣趋势、互动热点 5 个方面
3. 给出 2-3 条具体可操作的教学建议
4. 学生使用脱敏编号（如 S01），不使用真实姓名
5. 输出纯文本，不使用 Markdown 标记`

    const strengthsText = data.strengths.length > 0
        ? data.strengths.map((s) => `${s.dimension}（均值${s.avgScore}，优秀率${s.excellentRatio}%）`).join('、')
        : '暂无显著优势'

    const weaknessesText = data.weaknesses.length > 0
        ? data.weaknesses.map((w) => `${w.dimension}（均值${w.avgScore}，薄弱率${w.weakRatio}%）`).join('、')
        : '暂无显著薄弱'

    const anomaliesText = data.anomalies.length > 0
        ? data.anomalies.slice(0, 5).map((a) => `${a.anonymousName}在${a.dimension}${a.anomalyType === 'outperform' ? '异常优秀' : '异常薄弱'}（偏离${a.deviation}）`).join('；')
        : '暂无明显异常'

    const interestText = data.interestTrend.dynastyDistribution.length > 0
        ? data.interestTrend.dynastyDistribution.slice(0, 3).map((d) => `${d.dynasty}（${d.ratio}%）`).join('、')
        : '暂无兴趣数据'

    const engagementText = `班级平均参与度${data.engagement.classAvgEngagement}（${data.engagement.activityLevel}），高互动${data.engagement.highEngagement.length}人，低互动${data.engagement.lowEngagement.length}人`

    const userPrompt = `请为以下班级生成画像描述：

班级：${className}（${classId}）

【共性优势】${strengthsText}
【共性薄弱】${weaknessesText}
【异常关注】${anomaliesText}
【兴趣趋势】偏好朝代：${interestText}
【互动热点】${engagementText}

请生成约 300 字的班级画像描述，并给出 2-3 条教学建议。`

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
            maxTokens: 800,
            signal: controller.signal,
            metadata: {
                agent: 'class-hotspot',
                task: `class-hotspot-${classId}`,
            },
        })
        return result.content.trim()
    } finally {
        clearTimeout(timeoutId)
    }
}

function generateFallbackDescription(
    className: string,
    data: {
        strengths: CommonStrength[]
        weaknesses: CommonWeakness[]
        anomalies: AnomalyItem[]
        interestTrend: InterestTrend
        engagement: EngagementHotspot
    },
): string {
    const parts: string[] = []
    parts.push(`${className} 班级画像如下。`)
    if (data.strengths.length > 0) {
        parts.push(`共性优势：${data.strengths.map((s) => s.dimension).join('、')}。`)
    }
    if (data.weaknesses.length > 0) {
        parts.push(`共性薄弱：${data.weaknesses.map((w) => `${w.dimension}（${w.weakRatio}% 学生薄弱）`).join('、')}。`)
    }
    if (data.anomalies.length > 0) {
        parts.push(`发现 ${data.anomalies.length} 名学生存在异常表现，需重点关注。`)
    }
    if (data.interestTrend.dynastyDistribution.length > 0) {
        parts.push(`班级偏好：${data.interestTrend.dynastyDistribution.slice(0, 2).map((d) => d.dynasty).join('、')}。`)
    }
    if (data.engagement.hasObservedData) {
        parts.push(`班级平均参与度 ${data.engagement.classAvgEngagement}，活跃等级 ${data.engagement.activityLevel}。`)
    } else {
        parts.push('近 7 天暂无可追溯的课堂或学习事件，暂不判断班级活跃度。')
    }
    parts.push(`教学建议：针对薄弱点设计分层教学，对异常学生安排个性化辅导。`)
    return parts.join('')
}
