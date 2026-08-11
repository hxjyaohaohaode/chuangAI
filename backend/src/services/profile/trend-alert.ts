/**
 * 趋势预警服务（画像报告 · 能力 3）
 *
 * 5 类预警规则引擎 + LLM 个性化分析：
 *   1. 学业下滑（academic-decline）：近 30 天掌握度持续下降
 *   2. 参与度下降（engagement-drop）：参与度低于阈值或持续走低
 *   3. 知识缺口（knowledge-gap）：某 Bloom 层级存在显著缺口
 *   4. 异常行为（behavior-anomaly）：答题频次骤降 / 正确率骤降
 *   5. 个性化预警（personalized）：基于学生画像的定制化提醒
 *
 * 预警分级：info / warning / critical
 * 调用 deepseek-v4-flash 进行快速分析（低延迟）。
 *
 * 设计要点：
 * - LLM 使用 deepseek-v4-flash，thinking: low（快速预警场景）
 * - 预警支持标记为已解决（SqliteMap 持久化 resolved 状态）
 * - LLM 失败时降级返回规则引擎结果（不阻塞预警生成）
 * - 5 分钟内同类型同目标预警去重（避免预警风暴）
 */

import { repos, services } from '../../db/index.js'
import { managedLLM } from '../../llm/index.js'
import { SqliteMap } from '../../db/runtime-store.js'
import type { BloomLevel } from '../../agents/base/types.js'
import type { ChatMessage } from '../../llm/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 预警规则类型 */
export type TrendAlertRule =
    | 'academic-decline'
    | 'engagement-drop'
    | 'knowledge-gap'
    | 'behavior-anomaly'
    | 'personalized'

/** 预警严重程度（扩展为 info / warning / critical） */
export type TrendAlertSeverity = 'info' | 'warning' | 'critical'

/** 趋势预警 */
export interface TrendAlert {
    id: string
    /** 预警规则 */
    rule: TrendAlertRule
    severity: TrendAlertSeverity
    title: string
    description: string
    /** 关联学生 ID（个性化预警必填） */
    studentId?: string
    anonymousName?: string
    /** 关联班级 ID */
    classId: string
    /** 关联 Bloom 层级（知识缺口预警） */
    bloomLevel?: BloomLevel
    /** 关联诗篇 ID */
    poemId?: string
    /** 建议操作 */
    suggestedAction: string
    /** 是否已解决 */
    resolved: boolean
    /** 解决时间 */
    resolvedAt?: number
    /** 预警生成时间 */
    createdAt: number
    /** 是否 AI 增强分析 */
    aiAnalyzed: boolean
}

export interface TrendAlertsResponse {
    alerts: TrendAlert[]
    total: number
    /** 各严重程度统计 */
    severityStats: {
        critical: number
        warning: number
        info: number
    }
}

/** 预警筛选参数 */
export interface TrendAlertFilter {
    classId: string
    severity?: TrendAlertSeverity
    rule?: TrendAlertRule
    resolved?: boolean
    limit?: number
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const BLOOM_LEVELS: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

/** 学业下滑阈值：近 30 天掌握度下降超过 10 分 */
const DECLINE_THRESHOLD = 10
/** 参与度下降阈值 */
const ENGAGEMENT_DROP = 0.4
/** 知识缺口阈值 */
const GAP_THRESHOLD = 50
/** 去重时间窗口（5 分钟） */
const DEDUP_WINDOW_MS = 5 * 60 * 1000
const LLM_TIMEOUT_MS = 15_000

// ─────────────────────────────────────────────────────────────
// 预警存储（SQLite 持久化）
// ─────────────────────────────────────────────────────────────

const alertStore = new SqliteMap<string, TrendAlert>({
    table: 'trend_alerts',
    indexes: [
        { name: 'class_id', extract: (v) => v.classId },
        { name: 'student_id', extract: (v) => v.studentId ?? '' },
        { name: 'rule', extract: (v) => v.rule },
        { name: 'severity', extract: (v) => v.severity },
        { name: 'resolved', extract: (v) => String(v.resolved) },
    ],
})

// ─────────────────────────────────────────────────────────────
// 主服务
// ─────────────────────────────────────────────────────────────

/**
 * 生成趋势预警
 *
 * 扫描班级所有学生，按 5 类规则检测，生成预警。
 * 5 分钟内同类型同目标预警去重。
 */
export async function generateTrendAlerts(classId: string): Promise<TrendAlertsResponse> {
    const now = Date.now()
    const alerts: TrendAlert[] = []

    // 获取班级学生
    const students = repos.students.findByClassId(classId)
    if (students.length === 0) {
        return emptyResponse()
    }

    // 并行执行 5 类规则检测
    const [declineAlerts, engagementAlerts, gapAlerts, anomalyAlerts, personalizedAlerts] = await Promise.all([
        detectAcademicDecline(classId, students, now),
        detectEngagementDrop(classId, students, now),
        detectKnowledgeGap(classId, students, now),
        detectBehaviorAnomaly(classId, students, now),
        detectPersonalized(classId, students, now),
    ])

    alerts.push(...declineAlerts, ...engagementAlerts, ...gapAlerts, ...anomalyAlerts, ...personalizedAlerts)

    // 去重：5 分钟内同 rule + 同 studentId 的预警不重复生成
    const dedupedAlerts = dedupAlerts(alerts, now)

    // 持久化新预警
    for (const alert of dedupedAlerts) {
        alertStore.set(alert.id, alert)
    }

    // 合并历史未解决预警
    const historicalUnresolved = getUnresolvedAlerts(classId, now)
    const allAlerts = [...dedupedAlerts, ...historicalUnresolved.filter(
        (a) => !dedupedAlerts.some((d) => d.id === a.id),
    )]

    // 按严重程度 + 时间排序
    const severityWeight: Record<TrendAlertSeverity, number> = { critical: 3, warning: 2, info: 1 }
    allAlerts.sort((a, b) => {
        const w = severityWeight[b.severity] - severityWeight[a.severity]
        if (w !== 0) return w
        return b.createdAt - a.createdAt
    })

    const severityStats = {
        critical: allAlerts.filter((a) => a.severity === 'critical').length,
        warning: allAlerts.filter((a) => a.severity === 'warning').length,
        info: allAlerts.filter((a) => a.severity === 'info').length,
    }

    return {
        alerts: allAlerts,
        total: allAlerts.length,
        severityStats,
    }
}

/**
 * 查询预警（支持筛选）
 */
export function queryTrendAlerts(filter: TrendAlertFilter): TrendAlertsResponse {
    const allAlerts: TrendAlert[] = []
    for (const [, alert] of alertStore) {
        if (alert.classId !== filter.classId) continue
        allAlerts.push(alert)
    }

    let filtered = allAlerts
    if (filter.severity) {
        filtered = filtered.filter((a) => a.severity === filter.severity)
    }
    if (filter.rule) {
        filtered = filtered.filter((a) => a.rule === filter.rule)
    }
    if (filter.resolved !== undefined) {
        filtered = filtered.filter((a) => a.resolved === filter.resolved)
    }

    const severityWeight: Record<TrendAlertSeverity, number> = { critical: 3, warning: 2, info: 1 }
    filtered.sort((a, b) => {
        const w = severityWeight[b.severity] - severityWeight[a.severity]
        if (w !== 0) return w
        return b.createdAt - a.createdAt
    })

    const limit = filter.limit ?? 50
    const limited = filtered.slice(0, limit)

    const severityStats = {
        critical: filtered.filter((a) => a.severity === 'critical').length,
        warning: filtered.filter((a) => a.severity === 'warning').length,
        info: filtered.filter((a) => a.severity === 'info').length,
    }

    return { alerts: limited, total: filtered.length, severityStats }
}

/**
 * 标记预警为已解决
 */
export function resolveAlert(alertId: string): boolean {
    const alert = alertStore.get(alertId)
    if (!alert) return false
    alert.resolved = true
    alert.resolvedAt = Date.now()
    alertStore.set(alertId, alert)
    return true
}

/**
 * 批量标记预警为已解决
 */
export function resolveAlerts(alertIds: string[]): number {
    let count = 0
    for (const id of alertIds) {
        if (resolveAlert(id)) count += 1
    }
    return count
}

// ─────────────────────────────────────────────────────────────
// 5 类规则检测
// ─────────────────────────────────────────────────────────────

/** 规则 1：学业下滑 */
async function detectAcademicDecline(
    classId: string,
    students: ReturnType<typeof repos.students.findByClassId>,
    now: number,
): Promise<TrendAlert[]> {
    const alerts: TrendAlert[] = []
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000
    const fifteenDaysAgo = now - 15 * 24 * 60 * 60 * 1000

    for (const student of students) {
        try {
            const rows = repos.mastery.findByStudentId(student.id)
            const earlyScores: number[] = []
            const lateScores: number[] = []

            for (const r of rows) {
                const ts = r.lastAttemptAt ?? r.updatedAt
                if (!ts || ts < thirtyDaysAgo) continue
                if (ts < fifteenDaysAgo) {
                    earlyScores.push(r.score)
                } else {
                    lateScores.push(r.score)
                }
            }

            if (earlyScores.length < 3 || lateScores.length < 3) continue

            const earlyAvg = earlyScores.reduce((a, b) => a + b, 0) / earlyScores.length
            const lateAvg = lateScores.reduce((a, b) => a + b, 0) / lateScores.length
            const delta = lateAvg - earlyAvg

            if (delta < -DECLINE_THRESHOLD) {
                const severity: TrendAlertSeverity = delta < -20 ? 'critical' : delta < -15 ? 'warning' : 'info'
                alerts.push({
                    id: `academic-decline-${student.id}-${now}`,
                    rule: 'academic-decline',
                    severity,
                    title: `${student.anonymousName} 学业下滑`,
                    description: `近 15 天掌握度较前 15 天下降 ${Math.abs(Math.round(delta * 100) / 100)} 分（${Math.round(earlyAvg)} → ${Math.round(lateAvg)}），需关注学习状态。`,
                    studentId: student.id,
                    anonymousName: student.anonymousName,
                    classId,
                    suggestedAction: '建议与学生沟通了解困难，安排针对性辅导。可查看立体画像了解薄弱点。',
                    resolved: false,
                    createdAt: now,
                    aiAnalyzed: false,
                })
            }
        } catch {
            // 单个学生检测失败跳过
        }
    }
    return alerts
}

/** 规则 2：参与度下降 */
async function detectEngagementDrop(
    classId: string,
    students: ReturnType<typeof repos.students.findByClassId>,
    now: number,
): Promise<TrendAlert[]> {
    const alerts: TrendAlert[] = []
    const droppedStudents: Array<{ id: string; anonymousName: string; engagement: number }> = []
    const recentEvents = repos.events.findByClassAndTimeRange(
        classId,
        now - 7 * 24 * 60 * 60 * 1000,
        now,
    )
    if (recentEvents.length === 0) return alerts

    for (const student of students) {
        const engagement = services.event.calculateEngagement(student.id, 7) / 100
        if (engagement < ENGAGEMENT_DROP) {
            droppedStudents.push({
                id: student.id,
                anonymousName: student.anonymousName,
                engagement,
            })
        }
    }

    if (droppedStudents.length > 0) {
        const severity: TrendAlertSeverity = droppedStudents.length >= 5 ? 'critical' : droppedStudents.length >= 2 ? 'warning' : 'info'
        alerts.push({
            id: `engagement-drop-${classId}-${now}`,
            rule: 'engagement-drop',
            severity,
            title: `${droppedStudents.length} 名学生近期参与度偏低`,
            description: `依据近 7 天可追溯学习事件，${droppedStudents.length} 名学生参与度低于 ${(ENGAGEMENT_DROP * 100).toFixed(0)}%：${droppedStudents.slice(0, 5).map((s) => s.anonymousName).join('、')}${droppedStudents.length > 5 ? ' 等' : ''}。建议结合出勤和课堂情况复核。`,
            classId,
            suggestedAction: '建议安排一对一谈话，了解学习困难并提供针对性辅导资源。',
            resolved: false,
            createdAt: now,
            aiAnalyzed: false,
        })
    }
    return alerts
}

/** 规则 3：知识缺口 */
async function detectKnowledgeGap(
    classId: string,
    _students: ReturnType<typeof repos.students.findByClassId>,
    now: number,
): Promise<TrendAlert[]> {
    const alerts: TrendAlert[] = []
    try {
        const radar = repos.mastery.getClassBloomRadar(classId)
        for (const r of radar) {
            const level = r.bloom_level as BloomLevel
            if (!BLOOM_LEVELS.includes(level)) continue
            const avg = r.avg_score ?? 0
            if (avg > 0 && avg < GAP_THRESHOLD) {
                const severity: TrendAlertSeverity = avg < 30 ? 'critical' : avg < 40 ? 'warning' : 'info'
                alerts.push({
                    id: `knowledge-gap-${classId}-${level}-${now}`,
                    rule: 'knowledge-gap',
                    severity,
                    title: `班级"${level}"层知识缺口`,
                    description: `班级在布鲁姆"${level}"层级平均掌握度仅 ${Math.round(avg * 100) / 100}，低于 ${GAP_THRESHOLD} 阈值，存在显著知识缺口。`,
                    classId,
                    bloomLevel: level,
                    suggestedAction: `推荐使用六阶沉浸式教学模式的"${level}"专项训练，配合错题本进行强化复习。`,
                    resolved: false,
                    createdAt: now,
                    aiAnalyzed: false,
                })
            }
        }
    } catch {
        // 静默
    }
    return alerts
}

/** 规则 4：异常行为 */
async function detectBehaviorAnomaly(
    classId: string,
    students: ReturnType<typeof repos.students.findByClassId>,
    now: number,
): Promise<TrendAlert[]> {
    const alerts: TrendAlert[] = []
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
    const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000

    for (const student of students) {
        try {
            const rows = repos.mastery.findByStudentId(student.id)
            const recentAttempts: number[] = []
            const previousAttempts: number[] = []

            for (const r of rows) {
                const ts = r.lastAttemptAt ?? r.updatedAt
                if (!ts) continue
                if (ts >= sevenDaysAgo) {
                    recentAttempts.push(r.attempts)
                } else if (ts >= fourteenDaysAgo) {
                    previousAttempts.push(r.attempts)
                }
            }

            if (recentAttempts.length === 0 && previousAttempts.length > 0) {
                // 近 7 天无任何答题记录
                alerts.push({
                    id: `behavior-anomaly-${student.id}-inactive-${now}`,
                    rule: 'behavior-anomaly',
                    severity: 'warning',
                    title: `${student.anonymousName} 近 7 天无学习活动`,
                    description: `${student.anonymousName} 近 7 天未有任何答题或学习记录，可能存在学习中断。`,
                    studentId: student.id,
                    anonymousName: student.anonymousName,
                    classId,
                    suggestedAction: '建议联系学生或家长了解情况，确认是否存在技术或学习障碍。',
                    resolved: false,
                    createdAt: now,
                    aiAnalyzed: false,
                })
            }
        } catch {
            // 单个学生检测失败跳过
        }
    }
    return alerts
}

/** 规则 5：个性化预警（LLM 增强） */
async function detectPersonalized(
    classId: string,
    students: ReturnType<typeof repos.students.findByClassId>,
    now: number,
): Promise<TrendAlert[]> {
    const alerts: TrendAlert[] = []

    // 筛选需要个性化分析的学生：参与度中等 + 有足够数据
    const candidates = students.filter((s) => {
        const rows = repos.mastery.findByStudentId(s.id)
        const engagement = services.event.calculateEngagement(s.id, 7) / 100
        return rows.length >= 5 && engagement >= ENGAGEMENT_DROP && engagement < HIGH_ENGAGEMENT_THRESHOLD
    })

    // 仅取前 3 名学生进行 LLM 分析（控制成本）
    const sample = candidates.slice(0, 3)

    for (const student of sample) {
        try {
            const analysis = await analyzeStudentByLLM(student.id, student.anonymousName, classId)
            if (analysis) {
                alerts.push({
                    id: `personalized-${student.id}-${now}`,
                    rule: 'personalized',
                    severity: analysis.severity,
                    title: analysis.title,
                    description: analysis.description,
                    studentId: student.id,
                    anonymousName: student.anonymousName,
                    classId,
                    suggestedAction: analysis.suggestedAction,
                    resolved: false,
                    createdAt: now,
                    aiAnalyzed: true,
                })
            }
        } catch {
            // LLM 分析失败跳过
        }
    }
    return alerts
}

const HIGH_ENGAGEMENT_THRESHOLD = 0.8

// ─────────────────────────────────────────────────────────────
// LLM 个性化分析
// ─────────────────────────────────────────────────────────────

async function analyzeStudentByLLM(
    studentId: string,
    anonymousName: string,
    classId: string,
): Promise<{
    severity: TrendAlertSeverity
    title: string
    description: string
    suggestedAction: string
} | null> {
    const rows = repos.mastery.findByStudentId(studentId)

    // 构建数据摘要
    const bloomRadar = repos.mastery.getStudentBloomRadarViaView(studentId)
    const radarSummary = BLOOM_LEVELS.map((lv) => {
        const r = bloomRadar.find((br) => br.bloom_level === lv)
        return `${lv}: ${r ? Math.round(r.avg_score) : 0}`
    }).join(' / ')

    const totalAttempts = rows.reduce((s, r) => s + r.attempts, 0)
    const totalCorrect = rows.reduce((s, r) => s + r.correctCount, 0)
    const correctRate = totalAttempts > 0 ? Math.round((totalCorrect / totalAttempts) * 10000) / 100 : 0

    const systemPrompt = `你是诗心·预警分析师，专精中国小学古诗词教学预警分析。
基于学生学情数据，快速识别需要关注的学习风险，并给出个性化建议。

要求：
1. 仅在确实存在风险时返回预警，无明显风险时返回 null
2. 预警描述具体、可操作，避免泛泛而谈
3. 学生使用脱敏编号
4. JSON 输出格式：{"needAlert": true/false, "severity": "info/warning/critical", "title": "...", "description": "...", "suggestedAction": "..."}`

    const userPrompt = `学生：${anonymousName}（${studentId}）
班级：${classId}
近 7 天事件参与度：${services.event.calculateEngagement(studentId, 7)}
总答题：${totalAttempts} 次，正确率：${correctRate}%
六阶雷达：${radarSummary}

请分析该学生是否存在需要关注的学情风险。`

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
            temperature: 0.3,
            maxTokens: 400,
            jsonOutput: true,
            signal: controller.signal,
            metadata: {
                agent: 'trend-alert',
                task: `personalized-${studentId}`,
            },
        })

        const parsed = JSON.parse(result.content) as {
            needAlert: boolean
            severity: TrendAlertSeverity
            title: string
            description: string
            suggestedAction: string
        }

        if (!parsed.needAlert) return null
        return {
            severity: parsed.severity,
            title: parsed.title,
            description: parsed.description,
            suggestedAction: parsed.suggestedAction,
        }
    } finally {
        clearTimeout(timeoutId)
    }
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

/** 去重：5 分钟内同 rule + 同 studentId 的预警不重复生成 */
function dedupAlerts(alerts: TrendAlert[], now: number): TrendAlert[] {
    const result: TrendAlert[] = []
    const seen = new Set<string>()

    for (const alert of alerts) {
        const key = `${alert.rule}-${alert.studentId ?? 'class'}-${alert.classId}`
        // 检查是否 5 分钟内已存在同类型预警
        const existing = getExistingAlerts(alert.classId, alert.rule)
        const hasRecent = existing.some(
            (e) => e.studentId === alert.studentId && now - e.createdAt < DEDUP_WINDOW_MS,
        )
        if (hasRecent) continue
        if (seen.has(key)) continue
        seen.add(key)
        result.push(alert)
    }
    return result
}

/** 从存储中获取指定班级 + 规则的已有预警 */
function getExistingAlerts(classId: string, rule: string): TrendAlert[] {
    const result: TrendAlert[] = []
    for (const [, alert] of alertStore) {
        if (alert.classId === classId && alert.rule === rule) {
            result.push(alert)
        }
    }
    return result
}

/** 获取未解决预警 */
function getUnresolvedAlerts(classId: string, _now: number): TrendAlert[] {
    const result: TrendAlert[] = []
    for (const [, alert] of alertStore) {
        if (alert.classId === classId && !alert.resolved) {
            result.push(alert)
        }
    }
    return result
}

function emptyResponse(): TrendAlertsResponse {
    return {
        alerts: [],
        total: 0,
        severityStats: { critical: 0, warning: 0, info: 0 },
    }
}
