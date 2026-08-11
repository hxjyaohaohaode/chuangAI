/**
 * 主动智能（P7 阶段实现）
 *
 * 实现四大主动智能场景，不依赖教师指令，基于学情/反思/错误率
 * 主动触发诊断、推荐、建议与进化。
 *
 * 四大场景：
 * 1. checkMasteryDarkMatter  — 学情暗物质预警
 *    触发：学生某布鲁姆层掌握度 < 40
 *    动作：推送 proactive:alert:mastery 事件，建议教师介入诊断
 *
 * 2. checkClassBlindSpot     — 知识图谱盲区
 *    触发：班级某诗篇平均掌握度 < 50
 *    动作：推送 proactive:alert:blindspot 事件，建议补充练习
 *
 * 3. checkReflectionSuggestions — 教学节奏建议
 *    触发：编排官反思置信度 > 0.7 且 suggestions 非空
 *    动作：推送 proactive:suggestion 事件，主动展示教学建议
 *
 * 4. checkAgentFailureRate   — Agent 自我修正
 *    触发：某 Agent 滑动窗口内失败率 > 30%
 *    动作：调用 evolutionEngine.evolvePrompt 触发 Prompt 进化
 *    推送 proactive:evolution 事件，通知前端展示进化状态
 *
 * 设计原则：
 * - 被动响应式：由外部调用 check* 方法，不自行轮询（避免资源浪费）
 * - 容错隔离：任何检测失败不阻塞调用方
 * - 幂等安全：同一警报重复推送不冲突（前端去重）
 * - 严格 TypeScript：零 any，适配 noUncheckedIndexedAccess
 */

import type { WSBroadcaster } from '../../orchestrator/websocket/broadcaster.js'
import type { WSEvent } from '../../orchestrator/types.js'
import type { StudentProfile, ClassContext, BloomLevel } from './types.js'
import { evolutionEngine } from './evolution-engine.js'

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 学情暗物质阈值：掌握度低于此值视为暗物质 */
const MASTERY_DARK_MATTER_THRESHOLD = 40

/** 班级盲区阈值：班级平均掌握度低于此值视为盲区 */
const CLASS_BLINDSPOT_THRESHOLD = 50

/** 反思置信度阈值：高于此值才推送建议 */
const REFLECTION_CONFIDENCE_THRESHOLD = 0.7

/** Agent 失败率阈值：滑动窗口内失败率高于此值触发进化 */
const AGENT_FAILURE_RATE_THRESHOLD = 0.3

/** 滑动窗口大小：最近 N 次 Agent 调用 */
const AGENT_WINDOW_SIZE = 10

/** 布鲁姆六阶 */
const BLOOM_LEVELS: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造']

// ─────────────────────────────────────────────────────────────
// 主动智能事件类型
// ─────────────────────────────────────────────────────────────

export const PROACTIVE_EVENTS = {
    MASTERY_ALERT: 'proactive:alert:mastery',
    BLINDSPOT_ALERT: 'proactive:alert:blindspot',
    SUGGESTION: 'proactive:suggestion',
    EVOLUTION: 'proactive:evolution',
} as const

// ─────────────────────────────────────────────────────────────
// 主动警报类型
// ─────────────────────────────────────────────────────────────

/** 主动警报基类 */
export interface ProactiveAlert {
    /** 警报类型 */
    type: typeof PROACTIVE_EVENTS[keyof typeof PROACTIVE_EVENTS]
    /** 严重程度 */
    severity: 'info' | 'warning' | 'critical'
    /** 标题 */
    title: string
    /** 描述 */
    description: string
    /** 建议动作 */
    recommendedAction: string
    /** 关联实体 ID（学生 ID / 班级 ID / Agent ID） */
    targetId: string
    /** 关联实体类型 */
    targetType: 'student' | 'class' | 'agent'
    /** 时间戳 */
    timestamp: number
    /** 附加数据 */
    metadata?: Record<string, unknown>
}

// ─────────────────────────────────────────────────────────────
// Agent 调用追踪器（场景4用）
// ─────────────────────────────────────────────────────────────

/**
 * Agent 调用结果追踪
 *
 * 维护每个 Agent 最近 N 次调用的成功/失败状态，
 * 用于计算滑动窗口失败率。
 */
class AgentCallTracker {
    /** agentId → 最近 N 次调用结果（true=成功, false=失败） */
    private readonly records = new Map<string, boolean[]>()

    /** 记录一次调用结果 */
    record(agentId: string, success: boolean): void {
        let arr = this.records.get(agentId)
        if (!arr) {
            arr = []
            this.records.set(agentId, arr)
        }
        arr.push(success)
        if (arr.length > AGENT_WINDOW_SIZE) {
            arr.shift()
        }
    }

    /** 计算失败率（0-1），无数据返回 0 */
    getFailureRate(agentId: string): number {
        const arr = this.records.get(agentId)
        if (!arr || arr.length < 3) return 0
        const failures = arr.filter((s) => !s).length
        return failures / arr.length
    }

    /** 清空某 Agent 的记录 */
    clear(agentId: string): void {
        this.records.delete(agentId)
    }
}

// ─────────────────────────────────────────────────────────────
// 主动智能引擎
// ─────────────────────────────────────────────────────────────

/**
 * 主动智能引擎
 *
 * 全局单例，由编排官或路由层在关键业务节点调用 check* 方法。
 * 所有检测均为纯函数式（不修改输入），通过 broadcaster 推送事件。
 */
export class ProactiveIntelligence {
    /** Agent 调用追踪器 */
    private readonly tracker = new AgentCallTracker()
    /** 已推送的警报去重键（避免短时间内重复推送） */
    private readonly pushedAlerts = new Map<string, number>()
    /** 去重窗口：同一 targetId+type 的警报 5 分钟内不重复推送 */
    private readonly DEDUP_WINDOW_MS = 5 * 60 * 1000

    /**
     * @param broadcaster WebSocket 广播器（可选，无则仅返回警报不推送）
     */
    constructor(private broadcaster?: WSBroadcaster) { }

    /**
     * 注入 WebSocket 广播器（供全局单例在 initOrchestrator 时绑定）
     */
    attachBroadcaster(broadcaster: WSBroadcaster): void {
        this.broadcaster = broadcaster
    }

    /** 服务关闭/热重载时解除旧广播器，避免继续向已关闭 socket 推送。 */
    detachBroadcaster(): void {
        this.broadcaster = undefined
    }

    // ─────────────────────────────────────────────────────────
    // 场景1：学情暗物质预警
    // ─────────────────────────────────────────────────────────

    /**
     * 检查学生学情暗物质
     *
     * 遍历学生 mastery 中所有诗篇的六阶掌握度，任一低于阈值即生成警报。
     * 多个暗物质点合并为单个警报（避免轰炸教师）。
     *
     * @returns 警报（若有），否则 null
     */
    checkMasteryDarkMatter(student: StudentProfile): ProactiveAlert | null {
        const darkSpots: Array<{ poemId: string; level: BloomLevel; value: number }> = []

        for (const [poemId, mastery] of Object.entries(student.mastery)) {
            for (const level of BLOOM_LEVELS) {
                const value = mastery[level]
                if (typeof value === 'number' && value < MASTERY_DARK_MATTER_THRESHOLD) {
                    darkSpots.push({ poemId, level, value })
                }
            }
        }

        if (darkSpots.length === 0) return null

        const dedupKey = `mastery:${student.id}`
        if (this.isRecentlyPushed(dedupKey)) return null

        const alert: ProactiveAlert = {
            type: PROACTIVE_EVENTS.MASTERY_ALERT,
            severity: darkSpots.length > 5 ? 'critical' : 'warning',
            title: `学情暗物质预警：${student.name}`,
            description: `检测到 ${darkSpots.length} 个掌握度低于 ${MASTERY_DARK_MATTER_THRESHOLD} 的认知暗点，涉及 ${new Set(darkSpots.map((d) => d.poemId)).size} 首诗篇。`,
            recommendedAction: '建议调用 mind.diagnose 进行深度认知诊断，识别暗物质根因',
            targetId: student.id,
            targetType: 'student',
            timestamp: Date.now(),
            metadata: {
                darkSpots: darkSpots.slice(0, 10),
                totalCount: darkSpots.length,
            },
        }

        this.pushAlert(dedupKey, alert)
        return alert
    }

    // ─────────────────────────────────────────────────────────
    // 场景2：知识图谱盲区
    // ─────────────────────────────────────────────────────────

    /**
     * 检查班级知识图谱盲区
     *
     * 检查班级平均六阶掌握度，任一阶层低于阈值即生成盲区警报。
     *
     * @returns 警报（若有），否则 null
     */
    checkClassBlindSpot(classCtx: ClassContext, poemTitle?: string): ProactiveAlert | null {
        if (!classCtx.averageMastery) return null

        const weakLevels: Array<{ level: BloomLevel; value: number }> = []
        for (const level of BLOOM_LEVELS) {
            const value = classCtx.averageMastery[level]
            if (typeof value === 'number' && value < CLASS_BLINDSPOT_THRESHOLD) {
                weakLevels.push({ level, value })
            }
        }

        if (weakLevels.length === 0) return null

        const dedupKey = `blindspot:${classCtx.id}`
        if (this.isRecentlyPushed(dedupKey)) return null

        const firstWeakLevel = weakLevels[0]
        if (!firstWeakLevel) return null
        const weakest = weakLevels.reduce((min, cur) => cur.value < min.value ? cur : min, firstWeakLevel)
        const poemLabel = poemTitle ? `《${poemTitle}》` : '当前教学诗篇'

        const alert: ProactiveAlert = {
            type: PROACTIVE_EVENTS.BLINDSPOT_ALERT,
            severity: weakest.value < 30 ? 'critical' : 'warning',
            title: `知识图谱盲区：${classCtx.name}`,
            description: `${poemLabel}在 ${weakLevels.map((w) => w.level).join('、')} 等阶层掌握度低于 ${CLASS_BLINDSPOT_THRESHOLD}，最薄弱层为${weakest.level}（${weakest.value}）。`,
            recommendedAction: `建议调用 brush.question 生成${weakest.level}层补充练习，强化班级薄弱环节`,
            targetId: classCtx.id,
            targetType: 'class',
            timestamp: Date.now(),
            metadata: {
                weakLevels,
                weakest,
                studentCount: classCtx.studentCount,
            },
        }

        this.pushAlert(dedupKey, alert)
        return alert
    }

    // ─────────────────────────────────────────────────────────
    // 场景3：教学节奏建议
    // ─────────────────────────────────────────────────────────

    /**
     * 检查编排官反思建议
     *
     * 当反思置信度 > 0.7 且 suggestions 非空时，主动推送教学建议。
     *
     * @param reflection 编排官反思产物
     * @returns 建议（若有），否则 null
     */
    checkReflectionSuggestions(reflection: {
        sessionId: string
        strongAgents: string[]
        weakAgents: string[]
        suggestions: string[]
        confidence: number
        timestamp: number
    }): ProactiveAlert | null {
        if (reflection.confidence < REFLECTION_CONFIDENCE_THRESHOLD) return null
        if (reflection.suggestions.length === 0) return null

        const dedupKey = `suggestion:${reflection.sessionId}`
        if (this.isRecentlyPushed(dedupKey)) return null

        const alert: ProactiveAlert = {
            type: PROACTIVE_EVENTS.SUGGESTION,
            severity: 'info',
            title: '教学节奏智能建议',
            description: `基于本轮编排反思（置信度 ${(reflection.confidence * 100).toFixed(0)}%），系统为下次教学提供 ${reflection.suggestions.length} 条优化建议。`,
            recommendedAction: reflection.suggestions[0] ?? '查看完整建议列表',
            targetId: reflection.sessionId,
            targetType: 'class',
            timestamp: Date.now(),
            metadata: {
                strongAgents: reflection.strongAgents,
                weakAgents: reflection.weakAgents,
                allSuggestions: reflection.suggestions,
                confidence: reflection.confidence,
            },
        }

        this.pushAlert(dedupKey, alert)
        return alert
    }

    // ─────────────────────────────────────────────────────────
    // 场景4：Agent 自我修正
    // ─────────────────────────────────────────────────────────

    /**
     * 记录 Agent 调用结果（供场景4统计失败率）
     *
     * 应在 agentEvents.CALL_SUCCESS / CALL_ERROR 事件回调中调用。
     */
    recordAgentCall(agentId: string, success: boolean): void {
        this.tracker.record(agentId, success)
    }

    /**
     * 检查 Agent 失败率并触发自我修正
     *
     * 当某 Agent 滑动窗口内失败率 > 30% 时，调用 evolutionEngine
     * 触发 Prompt 进化，并推送进化通知。
     *
     * @returns 进化警报（若触发），否则 null
     */
    async checkAgentFailureRate(agentId: string): Promise<ProactiveAlert | null> {
        const failureRate = this.tracker.getFailureRate(agentId)
        if (failureRate < AGENT_FAILURE_RATE_THRESHOLD) return null

        const dedupKey = `evolution:${agentId}`
        if (this.isRecentlyPushed(dedupKey)) return null

        // 触发 Prompt 进化
        const triggerPattern = `连续失败率 ${(failureRate * 100).toFixed(0)}% 超过阈值，主动触发 Prompt 进化`
        const evolved = await evolutionEngine.evolvePrompt(agentId, triggerPattern)

        // 清空该 Agent 的调用记录（进化后重新统计）
        this.tracker.clear(agentId)

        const alert: ProactiveAlert = {
            type: PROACTIVE_EVENTS.EVOLUTION,
            severity: evolved ? 'info' : 'warning',
            title: `Agent 自我进化：${agentId}`,
            description: evolved
                ? `检测到 ${agentId} 失败率达 ${(failureRate * 100).toFixed(0)}%，已自动触发 Prompt 进化并应用新版本。`
                : `检测到 ${agentId} 失败率达 ${(failureRate * 100).toFixed(0)}%，Prompt 进化未成功，建议人工排查。`,
            recommendedAction: evolved
                ? '下次调用将自动使用进化后的 Prompt 版本'
                : '建议检查该 Agent 的错误日志，手动优化 Prompt',
            targetId: agentId,
            targetType: 'agent',
            timestamp: Date.now(),
            metadata: {
                failureRate,
                evolved,
                threshold: AGENT_FAILURE_RATE_THRESHOLD,
            },
        }

        this.pushAlert(dedupKey, alert)
        return alert
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    /**
     * 检查某警报是否在去重窗口内已推送
     */
    private isRecentlyPushed(dedupKey: string): boolean {
        const lastPushed = this.pushedAlerts.get(dedupKey)
        if (!lastPushed) return false
        return Date.now() - lastPushed < this.DEDUP_WINDOW_MS
    }

    /**
     * 推送警报：记录去重时间戳 + 通过 broadcaster 广播
     */
    private pushAlert(dedupKey: string, alert: ProactiveAlert): void {
        this.pushedAlerts.set(dedupKey, Date.now())

        // 清理过期的去重记录（避免内存泄漏）
        if (this.pushedAlerts.size > 100) {
            const now = Date.now()
            for (const [key, ts] of this.pushedAlerts) {
                if (now - ts > this.DEDUP_WINDOW_MS) {
                    this.pushedAlerts.delete(key)
                }
            }
        }

        // 通过 broadcaster 推送（若有）
        if (this.broadcaster) {
            const event: WSEvent = {
                type: alert.type,
                timestamp: alert.timestamp,
                sessionId: '',
                payload: alert,
            }
            this.broadcaster.broadcast(event)
        }
    }
}

// ─────────────────────────────────────────────────────────────
// 全局单例
// ─────────────────────────────────────────────────────────────

/**
 * 主动智能引擎全局单例
 *
 * 在 orchestrator/index.ts initOrchestrator 时创建（注入 broadcaster）。
 * 默认无 broadcaster（仅返回警报，不推送），供路由层手动调用。
 */
export const proactiveIntelligence = new ProactiveIntelligence()
