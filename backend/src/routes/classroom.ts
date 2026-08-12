/**
 * 课堂导播台 REST API 路由（Task 11）
 *
 * 8 个端点：
 * - POST /api/classroom/start             开始一堂课（生成 joinCode）
 * - GET  /api/classroom/:lessonId/status  课堂实时状态（含 phase 生命周期字段）
 * - GET  /api/classroom/:lessonId/report  拉取课堂协奏报告（幂等，支持历史课堂）
 * - POST /api/classroom/:lessonId/next    进入下一题
 * - POST /api/classroom/:lessonId/submit  学生提交答案（实时批改）
 * - POST /api/classroom/:lessonId/hint    诗心 Agent 推送启发提示
 * - POST /api/classroom/:lessonId/discuss 诗笔 Agent 实时生成讨论题
 * - POST /api/classroom/:lessonId/end     结束课堂，生成协奏报告（幂等，持久化到 lessons.metadata）
 *
 * 设计要点：
 * - 课堂运行时状态保存在内存 Map（lessonId -> ClassroomRuntime），适合短生命周期实时场景
 * - 所有 AI 生成内容标注 aiGenerated: true，调用失败时降级返回占位内容，不阻塞课堂
 * - 通过 WSBroadcaster 广播课堂事件（classroom:response / classroom:hint / classroom:discuss）
 * - 认知负荷由答题正确率与响应速度实时估算，绿(<40)/黄(40-70)/红(>70)
 * - 课堂氛围基于答题速度与正确率推断（focused/excited/bored/confused）
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db, repos, services } from '../db/index.js'
import { generateId } from '../db/utils/id.js'
import { agents } from '../agents/index.js'
import { proactiveIntelligence } from '../agents/base/proactive-intelligence.js'
import type { AgentContext, BloomMastery, ClassContext, Question } from '../agents/base/types.js'
import type { GradeInput, GradeOutput } from '../agents/brush-agent/grade.sub-agent.js'
import type { CreativeInput, CreativeOutput } from '../agents/brush-agent/creative.sub-agent.js'
import type { WSBroadcaster } from '../orchestrator/websocket/broadcaster.js'
import type { WSEvent } from '../orchestrator/types.js'
import {
    DanceStageError,
    initDanceStage,
    type DanceActor,
    type DanceEventName,
    type DanceEventSubType,
    type DanceSession,
} from '../orchestrator/dance-stage.js'
import { LESSON_MODES, type LessonMode, type PoemEntity } from '../db/types.js'
// 持久化存储：原 Map<string, ClassroomRuntime> → SQLite classroom_sessions 表
// 嵌套 Map（students / responses / flyingFlowerLeaderboard / speedPkScores）通过
// serialize/deserialize 钩子转换为 [entries] 数组后落盘
import { SqliteMap } from '../db/runtime-store.js'
import { validateBody, validateParams, validateQuery, schemas } from '../lib/validation.js'
import {
    QUEST_LEVELS,
    LEVEL_META,
    createQuestState,
    applyAnswer,
    localJudge,
    buildLeaderboard,
    type QuestState,
} from '../services/classroom/quest-engine.js'
import { classroomScheduler } from '../services/classroom/scheduler.js'
import {
    aiCollaborator,
    type InterventionRequest,
    type InterventionResult,
} from '../services/classroom/ai-collaborator.js'
import {
    afterActionReportGenerator,
    aiSuggestionTracker,
} from '../services/classroom/after-action-report.js'
import { config } from '../config.js'
import { invalidateClassHotspot } from '../services/profile/class-hotspot.js'
// AI 智能赋分（飞花令/意象拼图/诗篇接龙玩法即时判分）
import { multiDimensionScorer } from '../services/grading/multi-dimension-scorer.js'
// 古诗拆句共享口径（与 /api/poem-content 保持 lineIndex 一致）
import { splitPoemClauses } from '../lib/poem-lines.js'
import { bindSseDisconnectAbort, createPublicSseError, writeSseFrame } from '../lib/sse.js'
import { resolveSmartScoreParticipant } from '../services/classroom/smart-score-boundary.js'
import { persistLessonStartOrRollback } from '../services/classroom/lesson-start-persistence.js'
import { generateUniqueClassroomJoinCode } from '../services/classroom/join-code.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 课堂模式 */
export type ClassroomMode = LessonMode

/** 课堂氛围 */
export type ClassMood = 'focused' | 'excited' | 'bored' | 'confused'

/** 学生答题记录 */
export interface StudentResponse {
    studentId: string
    studentName: string
    answer: string
    correct?: boolean
    /** 提交时间戳 */
    at: number
    /** 响应耗时（ms） */
    latencyMs?: number
    /** 获得分数（速答 PK 模式） */
    score?: number
}

/** 启发提示历史 */
export interface HintRecord {
    id: string
    questionId: string
    type: 'nudge' | 'scaffold' | 'reframe'
    hint: string
    deliveredAt: number
    aiGenerated: true
}

/** 讨论题记录 */
export interface DiscussionRecord {
    id: string
    questionId: string
    angle: 'cultural' | 'comparative' | 'creative'
    topic: string
    followUp: string[]
    generatedAt: number
    aiGenerated: true
}

/** 课堂协奏报告 payload（generateClassroomReport 的返回类型，亦持久化到 lessons.metadata.classroomReport） */
export interface ClassroomReportPayload {
    summary: string
    participation: number
    masteryChange: { before: number; after: number }
    highlights: string[]
    improvements: string[]
    aiGenerated: boolean
}

/** 课堂运行时状态（内存） */
export interface ClassroomRuntime {
    lessonId: string
    classId: string
    poemId: string
    mode: ClassroomMode
    /** 6 位加入码 */
    joinCode: string
    startedAt: number
    endedAt?: number
    /** 题目序列（按顺序播放） */
    questions: Question[]
    /** 当前题目索引（0-based） */
    currentIndex: number
    /** 已加入学生（studentId -> 显示名） */
    students: Map<string, string>
    /** 每题的学生答题记录（questionId -> responses） */
    responses: Map<string, StudentResponse[]>
    /** 启发提示历史 */
    hints: HintRecord[]
    /** 讨论题历史 */
    discussions: DiscussionRecord[]
    /** 已推送提示数 */
    hintsDelivered: number
    /** 课堂氛围 */
    classMood: ClassMood
    /** 认知负荷 0-100 */
    cognitiveLoad: number
    /** 课堂活跃度 0-100 */
    engagement: number
    /** 飞花令关键字（仅 flying-flower 模式） */
    flyingFlowerKeyword?: string
    /** 飞花令擂主榜（studentId -> 连续成功数） */
    flyingFlowerLeaderboard?: Map<string, number>
    /** 速答 PK 积分榜（studentId -> 总分） */
    speedPkScores?: Map<string, number>
    /** 课前掌握度基线 */
    masteryBefore: number
    /** 课堂协奏报告缓存（结束后写入，供幂等 end 与 GET /report 复用） */
    report?: ClassroomReportPayload
    /**
     * 闯关状态（关卡 / 诗力值 / 四类积分）
     *
     * 所有模式共用同一份：切模式不清零，积分与关卡进度贯穿整节课。
     * 旧课堂（本字段缺失）在读取时按题目分布懒补，不需要数据迁移。
     */
    quest?: QuestState
    /** 学生 -> 小组 id 的映射（无分组时为空） */
    teamOf?: Map<string, string>
}

// ─────────────────────────────────────────────────────────────
// 课堂讲解工具类型（Phase 4.3：逐句讲解 + 正音）
// ─────────────────────────────────────────────────────────────

/** 正音要点 */
export interface PronunciationNote {
    /** 需要注意的字 */
    char: string
    /** 正确拼音（含声调） */
    correctPinyin: string
    /** 常见错误读音 */
    commonError: string
    /** 正音说明 */
    note: string
}

/** 单句讲解数据 */
export interface ExplainLine {
    /** 行号（从 0 开始） */
    lineIndex: number
    /** 教学要点 */
    teachingPoints: string[]
    /** 正音要点 */
    pronunciationNotes: PronunciationNote[]
    /** 讨论提示 */
    discussionPrompts: string[]
    /** 意象分析 */
    imageryAnalysis?: string
}

/** 课堂讲解响应 */
export interface ExplainResponse {
    poemId: string
    poemTitle: string
    poet: string
    /** 逐句讲解数据 */
    lines: ExplainLine[]
    /** 全诗教学建议 */
    overallTeachingAdvice: string
    /** 建议讲解时长（分钟） */
    suggestedDurationMin: number
    /** AI 生成标记 */
    aiGenerated: boolean
}

// ─────────────────────────────────────────────────────────────
// 持久化运行时存储（SQLite 替代内存 Map，重启后课堂状态完整恢复）
// ─────────────────────────────────────────────────────────────

/**
 * 序列化 ClassroomRuntime：嵌套 Map → [entries] 数组（JSON 友好）
 * 原内存 Map 直接存对象引用，mutation 即可见；
 * SqliteMap 需显式序列化，Map 字段必须转为数组才能 JSON.stringify。
 */
function serializeRuntime(rt: ClassroomRuntime): string {
    return JSON.stringify({
        ...rt,
        students: Array.from(rt.students.entries()),
        responses: Array.from(rt.responses.entries()),
        flyingFlowerLeaderboard: rt.flyingFlowerLeaderboard
            ? Array.from(rt.flyingFlowerLeaderboard.entries())
            : undefined,
        speedPkScores: rt.speedPkScores ? Array.from(rt.speedPkScores.entries()) : undefined,
        // teamOf 同样是 Map：JSON.stringify 会把 Map 变成 {}，
        // 反序列化回来就不再有 .get()，运行时直接 500。
        // 凡是加到 runtime 上的 Map 字段，这里和 deserializeRuntime 必须成对补。
        teamOf: rt.teamOf ? Array.from(rt.teamOf.entries()) : undefined,
    })
}

/** 反序列化 ClassroomRuntime：[entries] 数组 → 嵌套 Map */
function deserializeRuntime(raw: string): ClassroomRuntime {
    const obj = JSON.parse(raw)
    return {
        ...obj,
        students: new Map<string, string>(obj.students ?? []),
        responses: new Map<string, StudentResponse[]>(obj.responses ?? []),
        flyingFlowerLeaderboard: obj.flyingFlowerLeaderboard
            ? new Map<string, number>(obj.flyingFlowerLeaderboard)
            : undefined,
        speedPkScores: obj.speedPkScores ? new Map<string, number>(obj.speedPkScores) : undefined,
        teamOf: obj.teamOf ? new Map<string, string>(obj.teamOf) : undefined,
    }
}

/**
 * 从 lessons.metadata.classroomReport 恢复历史课堂报告
 * 用于 runtime 已清除（结束超 5 分钟）后，GET /report 与幂等 /end 的回退查询。
 * @returns 报告 payload 或 null（lesson 不存在 / 无报告 / 字段无效）
 */
function loadReportFromLesson(lessonId: string): ClassroomReportPayload | null {
    try {
        const lesson = repos.lessons.findById(lessonId)
        if (!lesson?.metadata) return null
        const raw = (lesson.metadata as Record<string, unknown>).classroomReport
        if (!raw || typeof raw !== 'object') return null
        const r = raw as Record<string, unknown>
        // 基本字段校验，防止脏数据导致前端崩溃
        if (typeof r.summary !== 'string' || typeof r.participation !== 'number') return null
        return raw as unknown as ClassroomReportPayload
    } catch {
        return null
    }
}

/** 课堂运行时表：lessonId -> ClassroomRuntime（SQLite 持久化） */
const runtimes = new SqliteMap<string, ClassroomRuntime>({
    table: 'classroom_sessions',
    indexes: [
        { name: 'class_id', extract: (v) => v.classId },
        { name: 'poem_id', extract: (v) => v.poemId },
        { name: 'join_code', extract: (v) => v.joinCode },
    ],
    serialize: serializeRuntime,
    deserialize: deserializeRuntime,
})

/** joinCode 反查：直接用 classroom_sessions.join_code 索引，无需独立 Map */

/** 认知负荷监测定时器：lessonId -> timer
 *  NodeJS.Timeout 不可持久化，保留为内存 Map（重启后定时器丢失可接受） */
const cognitiveTimers = new Map<string, NodeJS.Timeout>()
/** 课堂结束后的短期报告保留定时器；服务关闭时必须一并取消。 */
const classroomCleanupTimers = new Map<string, NodeJS.Timeout>()

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 认知负荷监测间隔（ms） */
const COGNITIVE_MONITOR_INTERVAL_MS = 15000

/** 飞花令默认关键字库 */
const FLYING_FLOWER_KEYWORDS = ['月', '花', '风', '雨', '春', '秋', '山', '水', '夜', '酒']

// ─────────────────────────────────────────────────────────────
// Zod schemas（B6.3 输入校验）
// ─────────────────────────────────────────────────────────────

/** POST /start 请求体 */
const startClassroomSchema = z.object({
    classId: schemas.classId,
    poemId: schemas.poemId,
    mode: z.enum(LESSON_MODES),
    questionIds: z.array(schemas.id).max(50).optional(),
})

const classroomReadinessSchema = z.object({
    poemId: schemas.poemId,
    mode: z.enum(LESSON_MODES),
})

const switchClassroomModeSchema = z.object({
    mode: z.enum(LESSON_MODES),
})

/** :lessonId 路径参数 */
const lessonIdParamsSchema = z.object({ lessonId: schemas.id })

/** POST /:lessonId/submit 请求体 */
const submitAnswerSchema = z.object({
    studentId: schemas.studentId,
    answer: schemas.sanitizedString(5000),
    questionId: schemas.id,
    studentName: schemas.optionalSanitizedString(100),
    latencyMs: z.number().int().min(0).max(3600000).optional(),
})

/** POST /:lessonId/hint 请求体 */
const hintSchema = z.object({
    questionId: schemas.id,
    type: z.enum(['nudge', 'scaffold', 'reframe']).optional(),
})

/** POST /:lessonId/discuss 请求体 */
const discussSchema = z.object({
    questionId: schemas.id,
    angle: z.enum(['cultural', 'comparative', 'creative']).optional(),
})

/** POST /:lessonId/quest/teams 请求体 */
const questTeamsSchema = z.object({
    teams: z.array(z.object({
        id: z.string().trim().max(40).optional(),
        name: schemas.sanitizedString(40),
        members: z.array(schemas.id).max(60),
    })).min(1, '至少需要一个小组').max(12, '小组数量不能超过 12'),
})

/** POST /:lessonId/quest/ai-turn 请求体 */
const aiTurnSchema = z.object({
    /** AI 对手本轮命中率 0-1（由前端按关卡难度给，越难越低） */
    accuracy: z.number().min(0).max(1).default(0.6),
    /** 命中时获得的诗力值 */
    power: z.number().int().min(1).max(50).default(10),
})

/** POST /:lessonId/question/flag 请求体 */
const flagQuestionSchema = z.object({
    questionId: schemas.id,
    reason: z.enum(['too-hard', 'too-easy', 'ambiguous', 'wrong-answer', 'off-topic', 'other']),
    note: schemas.optionalSanitizedString(500),
})

/** GET /join/:joinCode 路径参数 */
const joinCodeParamsSchema = z.object({
    joinCode: z.string().trim().min(4).max(8).regex(/^[A-Z0-9]+$/, 'joinCode invalid'),
})

/** GET /explain/:poemId 路径参数 */
const explainPoemIdParamsSchema = z.object({ poemId: schemas.poemId })

// ─────────────────────────────────────────────────────────────
// 课堂指挥深化 Zod schemas（Task 2/3/5）
// ─────────────────────────────────────────────────────────────

/** POST /:lessonId/schedule/next 请求体 */
const scheduleNextSchema = z.object({
    /** 期望调度策略（可选，调度器会自适应调整） */
    preferredStrategy: z.enum(['round-robin', 'random-draw', 'pk', 'tiered']).optional(),
    /** 时间进度 0-1（可选，由前端根据课堂时长计算） */
    timeProgress: z.number().min(0).max(1).optional(),
})

/** POST /:lessonId/schedule/override 请求体 */
const scheduleOverrideSchema = z.object({
    studentId: schemas.studentId,
    studentName: schemas.optionalSanitizedString(100),
})

/** POST /:lessonId/ai/suggest 请求体（实时反馈） */
const aiSuggestSchema = z.object({
    questionId: schemas.id,
    studentId: schemas.studentId,
    /** 全班正确率（可选，上下文参考） */
    classAccuracy: z.number().min(0).max(1).optional(),
})

/** POST /:lessonId/ai/supplement 请求体（背景补充） */
const aiSupplementSchema = z.object({
    questionId: schemas.id,
})

/** POST /:lessonId/ai/followup 请求体（追问生成） */
const aiFollowupSchema = z.object({
    questionId: schemas.id,
    studentId: schemas.studentId.optional(),
})

// ─────────────────────────────────────────────────────────────
// 共舞舞台 Zod schemas（Task: AI 诗教共舞舞台）
// ─────────────────────────────────────────────────────────────

/** POST /:lessonId/dance/event 请求体 */
const danceEventSchema = z.object({
    actor: z.enum(['teacher', 'ai', 'student']),
    subType: z.enum(['assign', 'guide', 'feedback', 'suggest', 'supplement', 'question', 'answer', 'ask', 'react']),
    actorId: schemas.optionalSanitizedString(128),
    actorLabel: schemas.optionalSanitizedString(100),
    content: schemas.sanitizedString(5000),
    questionId: schemas.optionalSanitizedString(128),
    targetStudentId: schemas.optionalSanitizedString(128),
    aiGenerated: z.boolean().optional(),
})

// ─────────────────────────────────────────────────────────────
// SubTask 14.4：会话管理 Zod schemas（sessions/score/comment/virtual-opponent）
// ─────────────────────────────────────────────────────────────

/** POST /sessions 请求体 —— 创建简化会话（轻量入口，返回 sessionId） */
const createSessionSchema = z.object({
    classId: schemas.classId,
    poemId: schemas.poemId,
    mode: z.enum(LESSON_MODES).optional(),
    /** 期望题目数（可选，默认由 mode 决定） */
    questionCount: z.number().int().min(1).max(20).optional(),
})

/** :sessionId 路径参数 */
const sessionIdParamsSchema = z.object({ sessionId: schemas.id })

/** POST /sessions/:sessionId/score 请求体 —— 教师直接评分（不走答题流程） */
const scoreSessionSchema = z.object({
    studentId: schemas.studentId,
    /** 分数 0-100 */
    score: z.number().min(0).max(100),
    /** 评分维度（可选，默认 'overall'） */
    dimension: z.enum(['accuracy', 'fluency', 'understanding', 'creation', 'overall']).optional(),
    /** 教师评语（可选） */
    comment: schemas.optionalSanitizedString(500),
    /** 关联的诗ID（可选，用于持久化到 mastery） */
    poemId: schemas.optionalSanitizedString(64),
    /** 关联的 Bloom 层级（可选） */
    bloomLevel: z.enum(['记忆', '理解', '应用', '分析', '评价', '创造']).optional(),
})

/**
 * POST /sessions/:sessionId/smart-score 请求体 —— AI 智能赋分
 *
 * 与 `/score`（教师手动打分，score 由调用方给出）的关键区别：
 * 本端点由 AI 依据作答文本计算分数，调用方**不**提供 score。
 * 飞花令 / 意象拼图 / 诗篇接龙三种课堂玩法均依赖此端点即时判分。
 */
const smartScoreSchema = z.object({
    studentId: schemas.studentId,
    studentName: schemas.optionalSanitizedString(64),
    questionId: schemas.optionalSanitizedString(64),
    /** 学生作答文本 */
    answer: schemas.sanitizedString(1000),
    /** 标准答案（可选；飞花令等无标准答案玩法由 AI 主观赋分） */
    referenceAnswer: schemas.optionalSanitizedString(500),
    /** 题目类型（影响赋分维度权重） */
    questionType: schemas.optionalSanitizedString(32),
    mode: z.enum(LESSON_MODES).optional(),
    /** 作答时延（ms），速答 PK 用于加分 */
    latencyMs: z.number().int().min(0).max(600_000).optional(),
})

/** POST /sessions/:sessionId/comment 请求体 —— SSE 流式评论 */
const commentSessionSchema = z.object({
    /** 评论主题（可选，默认基于课堂实时状态推断） */
    topic: schemas.optionalSanitizedString(200),
    /** 评论角度（可选） */
    angle: z.enum(['summary', 'guidance', 'reflection', 'encouragement']).optional(),
    /** 目标学生ID（可选，用于个性化评论） */
    studentId: schemas.optionalSanitizedString(64),
})

/**
 * POST /sessions/:sessionId/virtual-opponent 请求体 —— 虚拟对手
 *
 * 兼容两套调用约定：
 *  - 后端原生：`difficulty` / `persona` / `timeLimitSec`
 *  - 前端课堂导播台（AIOpponentAnswerRequest）：`level` / `mode` / `questionStem`
 *    / `options` / `flyingFlowerKeyword` / `relayPrevious` / `poemId`
 * 两者语义等价（level 是 difficulty 的三档子集），此处统一接收后在处理时归一化，
 * 避免前端为了一个字段名去做无谓的适配层。
 */
const virtualOpponentSchema = z.object({
    /** 虚拟对手难度（可选，默认 adaptive） */
    difficulty: z.enum(['easy', 'medium', 'hard', 'adaptive']).optional(),
    /** 前端难度档位别名（easy/medium/hard），difficulty 缺省时生效 */
    level: z.enum(['easy', 'medium', 'hard']).optional(),
    /** 对手人设（可选） */
    persona: z.enum(['classic-scholar', 'modern-student', 'peer-helper', 'challenger']).optional(),
    /** 关联题目ID（可选） */
    questionId: schemas.optionalSanitizedString(64),
    /** 对手作答时间限制（秒，可选，默认 15） */
    timeLimitSec: z.number().int().min(5).max(120).optional(),
    /** 当前课堂模式（可选，用于飞花令/接龙等特殊玩法的作答约束） */
    mode: z.enum(LESSON_MODES).optional(),
    /** 题干（可选，前端已有题面时直接透传，省去一次题库查找） */
    questionStem: schemas.optionalSanitizedString(500),
    /** 选项（可选） */
    options: z.array(schemas.sanitizedString(200)).max(8).optional(),
    /** 飞花令关键字（flying-flower 模式） */
    flyingFlowerKeyword: schemas.optionalSanitizedString(8),
    /** 接龙上句（poem-relay 模式） */
    relayPrevious: schemas.optionalSanitizedString(200),
    /** 课堂诗篇 ID（可选，限定 AI 作答范围） */
    poemId: schemas.optionalSanitizedString(64),
})

// ─────────────────────────────────────────────────────────────
// 路由插件选项
// ─────────────────────────────────────────────────────────────

export interface ClassroomRouteServices {
    detectIntervention?: (request: InterventionRequest) => Promise<InterventionResult>
    startDanceSession?: (params: {
        lessonId: string
        classId: string
        poemId: string
        teacherLabel: string
    }) => DanceSession
}

export interface ClassroomRoutesOptions {
    broadcaster: WSBroadcaster
    /** 显式服务注入点：生产使用真实实现，测试可验证异常边界而无需篡改模块单例。 */
    services?: ClassroomRouteServices
}

interface DanceStartPublicError {
    statusCode: 500 | 503
    error: 'DANCE_STAGE_UNAVAILABLE' | 'DANCE_STAGE_BUSY' | 'DANCE_SESSION_START_FAILED'
    message: string
}

/** 仅按受控错误类型和稳定 code 分类；未知异常一律失败关闭，不读取 message。 */
function toDanceStartPublicError(err: unknown): DanceStartPublicError {
    if (err instanceof DanceStageError) {
        if (err.code === 'STAGE_CLOSED') {
            return {
                statusCode: 503,
                error: 'DANCE_STAGE_UNAVAILABLE',
                message: '共舞服务暂不可用，请稍后重试',
            }
        }
        if (err.code === 'SESSION_LIMIT_REACHED') {
            return {
                statusCode: 503,
                error: 'DANCE_STAGE_BUSY',
                message: '共舞服务当前繁忙，请稍后重试',
            }
        }
    }

    return {
        statusCode: 500,
        error: 'DANCE_SESSION_START_FAILED',
        message: '共舞会话启动失败，请稍后重试',
    }
}

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

export const classroomRoutes: FastifyPluginAsync<ClassroomRoutesOptions> = async (
    app: FastifyInstance,
    opts,
) => {
    const { broadcaster } = opts

    // 初始化共舞舞台单例（幂等，复用 broadcaster）
    const danceStage = initDanceStage(broadcaster, app.log)
    const detectIntervention = opts.services?.detectIntervention
        ?? ((request: InterventionRequest) => aiCollaborator.detectIntervention(request))
    const startDanceSession = opts.services?.startDanceSession
        ?? ((params: Parameters<typeof danceStage.startSession>[0]) => danceStage.startSession(params))

    // Fastify 关闭时清理所有仍在运行的课堂定时器。定时器本身会 unref，
    // 但显式清理可以避免测试/热重载/优雅关闭后继续写入 SQLite。
    app.addHook('onClose', async () => {
        stopAllClassroomTimers()
        // 共舞舞台另有课堂回看保留定时器；必须与认知监测定时器一起关闭，
        // 否则旧 broadcaster 会被热重载实例继续持有。
        danceStage.closeAll()
    })

    // ── GET /classes — 班级列表（供前端下拉框动态加载） ──
    app.get('/classes', async () => {
        const list = repos.classes.findAll(200, 0)
        return {
            status: 'ok' as const,
            classes: list.map((c) => ({ id: c.id, name: c.name })),
        }
    })

    // ── GET /readiness — 开课前真实性校验：题量与六阶覆盖 ──
    app.get('/readiness', async (req: FastifyRequest, reply) => {
        const query = validateQuery(classroomReadinessSchema, req, reply)
        if (!query) return
        const poem = repos.poems.findById(query.poemId)
        if (!poem) {
            return reply.status(404).send({ status: 'error', message: '古诗不存在' })
        }
        const questions = loadQuestions(query.poemId, undefined, query.mode)
        const bloomCoverage = Object.fromEntries(
            ['记忆', '理解', '应用', '分析', '评价', '创造'].map((level) => [
                level,
                questions.filter((question) => question.bloomLevel === level).length,
            ]),
        )
        return reply.send({
            status: 'ok',
            poemId: query.poemId,
            questionCount: questions.length,
            bloomCoverage,
            ready: questions.length > 0,
            source: 'question-bank',
        })
    })

    // ── POST /start — 开始一堂课 ──
    app.post('/start', async (req: FastifyRequest, reply) => {
        const body = validateBody(startClassroomSchema, req, reply)
        if (!body) return

        const { classId, poemId, mode, questionIds } = body

        // 校验班级与古诗存在
        const classEntity = repos.classes.findById(classId)
        const poem = repos.poems.findById(poemId)
        if (!classEntity) {
            return reply.status(404).send({ status: 'error', message: '班级不存在' })
        }
        if (!poem) {
            return reply.status(404).send({ status: 'error', message: '古诗不存在' })
        }

        // 加载题目序列
        const questions = loadQuestions(poemId, questionIds, mode)
        if (questions.length === 0) {
            return reply.status(400).send({
                status: 'error',
                message: '未找到可用题目，请先在命题工坊生成题目',
            })
        }

        // 生成课堂 ID 与加入码
        const lessonId = `lesson-${generateId()}`
        const joinCode = generateJoinCode()
        const startedAt = Date.now()

        // 课前掌握度基线
        const masteryBefore = computeClassPoemMasteryAvg(classId, poemId)

        // 飞花令模式：随机选择关键字
        const flyingFlowerKeyword = mode === 'flying-flower'
            ? FLYING_FLOWER_KEYWORDS[Math.floor(Math.random() * FLYING_FLOWER_KEYWORDS.length)]
            : undefined

        const runtime: ClassroomRuntime = {
            lessonId,
            classId,
            poemId,
            mode,
            joinCode,
            startedAt,
            questions,
            currentIndex: 0,
            students: new Map(),
            responses: new Map(),
            hints: [],
            discussions: [],
            hintsDelivered: 0,
            classMood: 'focused',
            cognitiveLoad: 20,
            engagement: 50,
            flyingFlowerKeyword,
            flyingFlowerLeaderboard: mode === 'flying-flower' ? new Map() : undefined,
            speedPkScores: mode === 'speed-pk' ? new Map() : undefined,
            masteryBefore,
        }

        // 短期 runtime 与长期 lessons 缺一不可：前者失败要明确告诉前端可重试，
        // 后者失败则补偿删除已写入的 runtime，绝不能把半完成状态伪装为开课成功。
        const persistence = persistLessonStartOrRollback({
            id: lessonId,
            classId,
            poemId,
            teacherId: classEntity.teacherId,
            startedAt,
            status: 'ongoing',
            mode,
            metadata: { joinCode, classroomVersion: 'v3', masteryBefore },
        }, {
            createRuntime: () => runtimes.set(lessonId, runtime),
            createLesson: (lesson) => repos.lessons.create(lesson),
            rollbackRuntime: (id) => runtimes.delete(id),
            log: req.log,
        })
        if (!persistence.ok) {
            return reply.status(503).send({
                status: 'error',
                error: persistence.failure === 'runtime'
                    ? 'CLASSROOM_RUNTIME_UNAVAILABLE'
                    : 'LESSON_ARCHIVE_UNAVAILABLE',
                message: persistence.failure === 'runtime'
                    ? '课堂未启动：课堂实时状态暂时无法安全保存，请稍后重试'
                    : '课堂未启动：课堂记录暂时无法安全保存，请稍后重试',
            })
        }

        // joinCode 反查通过 classroom_sessions.join_code 索引，无需独立 Map

        // 启动认知负荷监测
        startCognitiveMonitor(lessonId, broadcaster)

        // 广播课堂开始事件
        broadcastClassroomEvent(broadcaster, lessonId, 'classroom:start', {
            lessonId,
            classId,
            poemId,
            mode,
            joinCode,
            startedAt,
            totalQuestions: questions.length,
        })

        req.log.info(
            { lessonId, classId, poemId, mode, joinCode },
            '[classroom] 课堂已开始',
        )

        return reply.send({
            status: 'ok',
            lessonId,
            joinCode,
            joinUrl: `/classroom/${lessonId}`,
            startedAt,
        })
    })

    // ── GET /:lessonId/status — 课堂实时状态 ──
    app.get('/:lessonId/status', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const runtime = runtimes.get(lessonId)

        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }

        const currentQuestion = runtime.questions[runtime.currentIndex]
        const responses = currentQuestion
            ? (runtime.responses.get(currentQuestion.id) ?? [])
            : []

        return reply.send({
            status: 'ok',
            lessonId,
            classId: runtime.classId,
            mode: runtime.mode,
            phase: runtime.endedAt ? 'ended' : 'ongoing',
            currentQuestionIndex: runtime.currentIndex,
            totalQuestions: runtime.questions.length,
            currentQuestion: currentQuestion ? sanitizeQuestion(currentQuestion) : undefined,
            activeStudents: runtime.students.size,
            responses: responses.map((r) => ({
                studentId: r.studentId,
                answer: r.answer,
                correct: r.correct,
                at: r.at,
            })),
            classMood: runtime.classMood,
            cognitiveLoad: runtime.cognitiveLoad,
            engagement: runtime.engagement,
            hintsDelivered: runtime.hintsDelivered,
            joinCode: runtime.joinCode,
            flyingFlowerKeyword: runtime.flyingFlowerKeyword,
            // 闯关状态随 status 一并返回：七个模式共用同一份，
            // 切模式时不需要各自再拉一次，也不会出现两处进度打架
            quest: questSnapshot(runtime),
            hasReport: !!runtime.report,
            aiGenerated: true,
        })
    })

    // ── PATCH /:lessonId/mode — 将导播台模式切换真实写入课堂运行时 ──
    app.patch('/:lessonId/mode', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const body = validateBody(switchClassroomModeSchema, req, reply)
        if (!body) return
        const runtime = runtimes.get(params.lessonId)
        if (!runtime || runtime.endedAt) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }
        const previousMode = runtime.mode
        runtime.mode = body.mode
        if (body.mode === 'flying-flower' && !runtime.flyingFlowerKeyword) {
            runtime.flyingFlowerKeyword =
                FLYING_FLOWER_KEYWORDS[Math.floor(Math.random() * FLYING_FLOWER_KEYWORDS.length)]
        }
        if (body.mode === 'speed-pk' && !runtime.speedPkScores) {
            runtime.speedPkScores = new Map()
        }
        if (body.mode === 'flying-flower' && !runtime.flyingFlowerLeaderboard) {
            runtime.flyingFlowerLeaderboard = new Map()
        }
        runtimes.set(params.lessonId, runtime)
        broadcastClassroomEvent(broadcaster, params.lessonId, 'classroom:mode', {
            lessonId: params.lessonId,
            fromMode: previousMode,
            toMode: body.mode,
        })
        return reply.send({
            status: 'ok',
            lessonId: params.lessonId,
            previousMode,
            mode: body.mode,
            flyingFlowerKeyword: runtime.flyingFlowerKeyword,
        })
    })

    // ── POST /:lessonId/next — 进入下一题 ──
    app.post('/:lessonId/next', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const runtime = runtimes.get(lessonId)

        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }

        const nextIndex = runtime.currentIndex + 1
        if (nextIndex >= runtime.questions.length) {
            return reply.status(400).send({ status: 'error', message: '已是最后一题，请结束课堂' })
        }

        runtime.currentIndex = nextIndex
        // 重置认知负荷（新题开始）
        runtime.cognitiveLoad = 25
        // SqliteMap：mutation 后必须显式 set() 落盘
        runtimes.set(lessonId, runtime)

        const currentQuestion = runtime.questions[nextIndex]
        if (!currentQuestion) {
            return reply.status(400).send({ status: 'error', message: '题目加载失败' })
        }

        broadcastClassroomEvent(broadcaster, lessonId, 'classroom:next', {
            lessonId,
            currentIndex: nextIndex,
            totalQuestions: runtime.questions.length,
            questionId: currentQuestion.id,
        })

        return reply.send({
            status: 'ok',
            currentQuestionIndex: nextIndex,
            currentQuestion: sanitizeQuestion(currentQuestion),
        })
    })

    // ── POST /:lessonId/submit — 学生提交答案（实时批改） ──
    app.post('/:lessonId/submit', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const body = validateBody(submitAnswerSchema, req, reply)
        if (!body) return
        const { studentId, answer, questionId, latencyMs } = body
        const runtime = runtimes.get(lessonId)

        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }

        // 每次提交都回查学生—班级关系，防止把同一教师名下另一个班的学生写入本课堂。
        // 同时只使用脱敏名，不信任前端传来的 studentName，避免真实姓名经 WS 广播。
        const studentEntity = repos.students.findById(studentId)
        if (!studentEntity || studentEntity.classId !== runtime.classId) {
            return reply.status(404).send({
                status: 'error',
                message: '学生不存在或不属于该课堂班级',
            })
        }
        if (!runtime.students.has(studentId)) {
            runtime.students.set(studentId, studentEntity.name)
        }
        const displayName = runtime.students.get(studentId) ?? studentId

        const question = runtime.questions.find((q) => q.id === questionId)
        if (!question) {
            return reply.status(404).send({ status: 'error', message: '题目不存在' })
        }

        // 检查是否已提交（同题不允许重复提交，除飞花令模式）
        const existingResponses = runtime.responses.get(questionId) ?? []
        if (runtime.mode !== 'flying-flower' && existingResponses.some((r) => r.studentId === studentId)) {
            return reply.status(409).send({ status: 'error', message: '已提交过答案' })
        }

        // ── 判分：本地即时 + AI 异步补讲评 ──
        //
        // 原实现在这里同步 await brush.grade Agent，实测单次 7955ms。
        // 教室里只有一块大屏、全班一起盯着，教师点一下要等近 8 秒才知道对错，
        // 一节课二十道题就是两分半的冷场——统一授课下这是致命的。
        //
        // 现在：客观题（选择/填空/默写/判断）由本地规则微秒级判定，
        // 当场亮对错、当场加诗力值；AI 只负责随后补一段讲评，
        // 通过 WebSocket 回填到同一条作答记录上。
        // 对错对客观题本就是确定的，不需要大模型；大模型的价值在
        // "为什么错、怎么改"，那部分晚一两秒毫无损失。
        //
        // 本地判不了的题型（简答/赏析/仿写）localJudge 返回 null，
        // 此时**不猜**——标记为待评，完全交给 AI，避免先亮一个错误结论再被推翻。
        const localVerdict = localJudge(question, answer)
        const gradedLocally = localVerdict !== null
        const correct = localVerdict ?? false
        const feedback = gradedLocally
            ? (correct ? '答对了' : `正确答案是「${question.answer}」`)
            : '已提交，AI 正在评阅…'

        const response: StudentResponse = {
            studentId,
            studentName: displayName,
            answer,
            correct,
            at: Date.now(),
            latencyMs,
        }

        // 速答 PK 模式：计算得分（第一个正确且响应快得分高）
        if (runtime.mode === 'speed-pk' && runtime.speedPkScores && correct) {
            const correctCount = existingResponses.filter((r) => r.correct).length
            const rank = correctCount // 0-based
            const baseScore = 100
            const speedBonus = latencyMs !== undefined ? Math.max(0, 50 - Math.floor(latencyMs / 1000)) : 0
            const score = Math.max(10, baseScore + speedBonus - rank * 20)
            response.score = score
            const prevScore = runtime.speedPkScores.get(studentId) ?? 0
            runtime.speedPkScores.set(studentId, prevScore + score)
        }

        // 飞花令模式：验证诗句含关键字
        if (runtime.mode === 'flying-flower' && runtime.flyingFlowerKeyword) {
            const containsKeyword = answer.includes(runtime.flyingFlowerKeyword)
            response.correct = containsKeyword
            if (containsKeyword && runtime.flyingFlowerLeaderboard) {
                const prev = runtime.flyingFlowerLeaderboard.get(studentId) ?? 0
                runtime.flyingFlowerLeaderboard.set(studentId, prev + 1)
            }
        }

        existingResponses.push(response)
        runtime.responses.set(questionId, existingResponses)

        // 更新课堂氛围与认知负荷
        updateClassroomMood(runtime)
        // SqliteMap：mutation 后必须显式 set() 落盘（students / responses /
        // speedPkScores / flyingFlowerLeaderboard / classMood / engagement 变更）
        runtimes.set(lessonId, runtime)

        // 持久化作答记录
        const answerId = generateId()
        try {
            repos.answers.create({
                id: answerId,
                studentId,
                questionId,
                lessonId,
                answerText: answer,
                // 本地判不了的题先不写对错，等 AI 评完回填——
                // 写一个猜出来的 false 会立刻污染掌握度与雷达图
                correct: gradedLocally ? correct : null,
                feedback,
                aiConfidence: gradedLocally ? 1 : null,
                needsHumanReview: !gradedLocally,
                gradedBy: gradedLocally ? 'rule' : null,
                gradedAt: gradedLocally ? Date.now() : null,
                submittedAt: Date.now(),
            })

            // 课堂提交后同步写入 mastery 表
            // 驾驶舱雷达图、学情诊断、暗物质检测、推荐引擎均依赖此数据。
            // 仅在本地已判定时写入；待评的等 AI 回填时再补，避免脏数据。
            if (gradedLocally) {
                repos.mastery.upsertScore(
                    studentId,
                    runtime.poemId,
                    question.bloomLevel,
                    correct ? 100 : 0,
                    correct,
                )
            }
        } catch (err) {
            req.log.warn({ err }, '[classroom] answer 持久化失败')
        }

        // 事件溯源闭环：参与度、热点画像和趋势预警都以 events 为事实来源。
        // 旧实现只写 answers/mastery，导致这些下游能力永远看不到真实课堂行为。
        try {
            services.event.record({
                studentId,
                classId: runtime.classId,
                lessonId,
                poemId: runtime.poemId,
                type: 'answer',
                action: 'classroom-answer-submitted',
                payload: {
                    questionId,
                    correct: gradedLocally ? correct : null,
                    latencyMs: latencyMs ?? null,
                },
                metadata: {
                    source: 'classroom',
                    gradedLocally,
                },
            })
            invalidateClassHotspot(runtime.classId)
        } catch (err) {
            req.log.warn({ err }, '[classroom] 学情事件写入失败')
        }

        // ── 闯关结算 ──
        const questionsByLevel = countQuestionsByLevel(runtime.questions)
        if (!runtime.quest) runtime.quest = createQuestState(questionsByLevel)
        const questDelta = applyAnswer(runtime.quest, {
            studentId,
            correct: gradedLocally ? correct : false,
            latencyMs,
            teamId: runtime.teamOf?.get(studentId),
            questionsByLevel,
        })
        runtimes.set(lessonId, runtime)

        // 广播答题事件
        broadcastClassroomEvent(broadcaster, lessonId, 'classroom:response', {
            lessonId,
            questionId,
            studentId,
            studentName: displayName,
            answer,
            correct,
            feedback,
            pendingAiReview: !gradedLocally,
            quest: questSnapshot(runtime),
            delta: questDelta,
        })

        // 通关：单独广播一帧，前端据此播放通关动画
        if (questDelta.levelCleared) {
            broadcastClassroomEvent(broadcaster, lessonId, 'classroom:level-cleared', {
                lessonId,
                clearedLevel: runtime.quest.clearedLevels[runtime.quest.clearedLevels.length - 1],
                nextLevel: questDelta.nextLevel,
                allCleared: questDelta.allCleared,
                quest: questSnapshot(runtime),
            })
        }

        // ── AI 讲评：不阻塞本次响应，算完再回填 ──
        // 这里刻意不 await：教师和全班已经拿到对错并看到加分动画了，
        // 讲评是"锦上添花"，让它排在响应之后。
        void (async () => {
            try {
                // 模型侧只接收脱敏名；教师课堂与榜单使用真实名册姓名。
                const g = await gradeAnswer(question, answer, studentEntity.anonymousName)
                const finalCorrect = gradedLocally ? correct : g.correct

                repos.answers.update(answerId, {
                    correct: finalCorrect,
                    feedback: g.feedback,
                    aiConfidence: g.confidence,
                    needsHumanReview: g.needsHumanReview,
                    gradedBy: 'ai',
                    gradedAt: Date.now(),
                })

                // 本地判不了的题，对错在此刻才确定，掌握度也在此刻才补写
                if (!gradedLocally) {
                    repos.mastery.upsertScore(
                        studentId,
                        runtime.poemId,
                        question.bloomLevel,
                        finalCorrect ? 100 : 0,
                        finalCorrect,
                    )
                    const rt = runtimes.get(lessonId)
                    if (rt?.quest) {
                        applyAnswer(rt.quest, {
                            studentId,
                            correct: finalCorrect,
                            latencyMs,
                            teamId: rt.teamOf?.get(studentId),
                            questionsByLevel: countQuestionsByLevel(rt.questions),
                        })
                        runtimes.set(lessonId, rt)
                    }
                }

                broadcastClassroomEvent(broadcaster, lessonId, 'classroom:ai-feedback', {
                    lessonId,
                    questionId,
                    studentId,
                    correct: finalCorrect,
                    feedback: g.feedback,
                    quest: questSnapshot(runtimes.get(lessonId)),
                })
            } catch (err) {
                req.log.warn({ err, answerId }, '[classroom] AI 讲评回填失败（不影响已给出的判分）')
            }
        })()

        return reply.send({
            status: 'ok',
            correct,
            feedback,
            // 明确告诉前端"对错还没定"，界面才能显示"评阅中"而不是一个假的错号
            pendingAiReview: !gradedLocally,
            gradedBy: gradedLocally ? 'rule' : 'pending',
            quest: questSnapshot(runtime),
            delta: questDelta,
            aiGenerated: !gradedLocally,
        })
    })

    // ── POST /:lessonId/hint — 请求启发提示 ──
    app.post('/:lessonId/hint', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const body = validateBody(hintSchema, req, reply)
        if (!body) return
        const { questionId, type = 'nudge' } = body
        const runtime = runtimes.get(lessonId)

        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }

        const question = runtime.questions.find((q) => q.id === questionId)
        if (!question) {
            return reply.status(404).send({ status: 'error', message: '题目不存在' })
        }

        // 调用 brush.creative 生成启发提示（带降级）
        const hint = await generateHint(question, type)

        const record: HintRecord = {
            id: generateId(),
            questionId,
            type,
            hint,
            deliveredAt: Date.now(),
            aiGenerated: true,
        }
        runtime.hints.push(record)
        runtime.hintsDelivered += 1
        // SqliteMap：mutation 后必须显式 set() 落盘
        runtimes.set(lessonId, runtime)

        broadcastClassroomEvent(broadcaster, lessonId, 'classroom:hint', {
            lessonId,
            questionId,
            type,
            hint,
            deliveredAt: record.deliveredAt,
        })

        return reply.send({
            status: 'ok',
            hint,
            aiGenerated: true,
        })
    })

    // ── POST /:lessonId/discuss — 生成讨论题 ──
    app.post('/:lessonId/discuss', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const body = validateBody(discussSchema, req, reply)
        if (!body) return
        const { questionId, angle = 'cultural' } = body
        const runtime = runtimes.get(lessonId)

        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }

        const question = runtime.questions.find((q) => q.id === questionId)
        if (!question) {
            return reply.status(404).send({ status: 'error', message: '题目不存在' })
        }

        // 调用 brush.creative 生成讨论题（带降级）
        const discussion = await generateDiscussion(question, angle, runtime)

        const record: DiscussionRecord = {
            id: generateId(),
            questionId,
            angle,
            topic: discussion.topic,
            followUp: discussion.followUp,
            generatedAt: Date.now(),
            aiGenerated: true,
        }
        runtime.discussions.push(record)
        // SqliteMap：mutation 后必须显式 set() 落盘
        runtimes.set(lessonId, runtime)

        broadcastClassroomEvent(broadcaster, lessonId, 'classroom:discuss', {
            lessonId,
            questionId,
            angle,
            topic: discussion.topic,
            followUp: discussion.followUp,
        })

        return reply.send({
            status: 'ok',
            discussionTopic: discussion.topic,
            followUp: discussion.followUp,
            aiGenerated: true,
        })
    })

    // ── POST /:lessonId/end — 结束课堂，生成协奏报告（幂等） ──
    // 幂等策略：若 runtime.endedAt 已设置且 report 已缓存，直接返回缓存报告；
    // 否则生成新报告、缓存到 runtime.report 并持久化到 lessons.metadata.classroomReport。
    // runtime 5 分钟后清除，但 lessons.metadata.classroomReport 永久保留，供 GET /report 拉取。
    // ── GET /:lessonId/quest — 闯关状态 ──
    //
    // 大屏 HUD 与各模式共用。单独开一条而不是只靠 /status，
    // 是因为 HUD 的刷新频率远高于整体状态（每次作答都要动），
    // 拉一个轻量端点比反复拉整份 status 便宜得多。
    app.get('/:lessonId/quest', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const runtime = runtimes.get(params.lessonId)
        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在' })
        }
        return reply.send({ status: 'ok', lessonId: params.lessonId, quest: questSnapshot(runtime) })
    })

    // ── POST /:lessonId/quest/teams — 设置小组 ──
    //
    // 统一授课下按座位分组最常见，因此接受"组名 + 成员"的朴素结构，
    // 不强求先在系统里建好组织架构——课堂上没时间做这个。
    app.post('/:lessonId/quest/teams', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const body = validateBody(questTeamsSchema, req, reply)
        if (!body) return
        const runtime = runtimes.get(params.lessonId)
        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在' })
        }

        const questionsByLevel = countQuestionsByLevel(runtime.questions)
        if (!runtime.quest) runtime.quest = createQuestState(questionsByLevel)

        // 保留已有积分：课中途重新分组不应把大家攒的分清零
        const prevScore = new Map(runtime.quest.teams.map((t) => [t.id, t.score]))
        runtime.quest.teams = body.teams.map((t, i) => ({
            id: t.id ?? `team-${i + 1}`,
            name: t.name,
            members: t.members,
            score: prevScore.get(t.id ?? `team-${i + 1}`) ?? 0,
        }))

        runtime.teamOf = new Map()
        for (const t of runtime.quest.teams) {
            for (const m of t.members) runtime.teamOf.set(m, t.id)
        }
        runtimes.set(params.lessonId, runtime)

        broadcastClassroomEvent(broadcaster, params.lessonId, 'classroom:quest', {
            lessonId: params.lessonId,
            quest: questSnapshot(runtime),
        })
        return reply.send({ status: 'ok', quest: questSnapshot(runtime) })
    })

    // ── POST /:lessonId/quest/ai-turn — AI 虚拟对手作答一轮 ──
    //
    // AI 对手的意义是给全班一个"看得见的追赶目标"，所以它必须会答错：
    // 一个全对的对手只会让学生放弃。命中率交由调用方按关卡难度给出。
    app.post('/:lessonId/quest/ai-turn', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const body = validateBody(aiTurnSchema, req, reply)
        if (!body) return
        const runtime = runtimes.get(params.lessonId)
        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在' })
        }
        const questionsByLevel = countQuestionsByLevel(runtime.questions)
        if (!runtime.quest) runtime.quest = createQuestState(questionsByLevel)

        // zod 的 .default() 在推导类型时仍标记为可选，这里显式兜底
        const accuracy = body.accuracy ?? 0.6
        const power = body.power ?? 10
        const hit = Math.random() < accuracy
        const gained = hit ? power : 0
        runtime.quest.aiOpponentScore += gained
        runtimes.set(params.lessonId, runtime)

        broadcastClassroomEvent(broadcaster, params.lessonId, 'classroom:quest', {
            lessonId: params.lessonId,
            quest: questSnapshot(runtime),
        })
        return reply.send({
            status: 'ok',
            correct: hit,
            gained,
            aiOpponentScore: runtime.quest.aiOpponentScore,
            quest: questSnapshot(runtime),
        })
    })


    // ── POST /:lessonId/question/flag — 教师标记题目质量 ──
    //
    // 出处：教师是唯一在真实课堂上见过这道题落地效果的人。
    // 标记写回 questions.metadata，命题工坊据此改进——
    // 让"这题出得不好"这句话有地方可去，而不是只能在课堂上抱怨一句。
    app.post('/:lessonId/question/flag', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const body = validateBody(flagQuestionSchema, req, reply)
        if (!body) return

        const question = repos.questions.findById(body.questionId)
        if (!question) {
            return reply.status(404).send({ status: 'error', message: '题目不存在' })
        }

        const meta = (question.metadata ?? {}) as Record<string, unknown>
        const flags = Array.isArray(meta.teacherFlags) ? meta.teacherFlags as unknown[] : []
        flags.push({
            reason: body.reason,
            note: body.note ?? '',
            lessonId: params.lessonId,
            flaggedAt: Date.now(),
        })
        repos.questions.update(body.questionId, {
            metadata: { ...meta, teacherFlags: flags },
        })

        return reply.send({ status: 'ok', questionId: body.questionId, flagCount: flags.length })
    })

    // ── POST /:lessonId/question/replace — 当场换一道同层级的题 ──
    //
    // 教师觉得当前题不合适时，从题库里换一道**同一布鲁姆层级**的题。
    // 优先从题库直接取而不是现场调大模型：课堂上多等十几秒是不可接受的，
    // 题库里同层级题目通常够用；确实没有时才如实返回"无可替换"。
    app.post('/:lessonId/question/replace', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const runtime = runtimes.get(params.lessonId)
        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在' })
        }
        const current = runtime.questions[runtime.currentIndex]
        if (!current) {
            return reply.status(400).send({ status: 'error', message: '当前没有题目' })
        }

        const usedIds = new Set(runtime.questions.map((q) => q.id))
        const candidates = repos.questions
            .findByPoemId(runtime.poemId)
            .filter((q) => q.bloomLevel === current.bloomLevel && !usedIds.has(q.id))

        if (candidates.length === 0) {
            return reply.status(409).send({
                status: 'error',
                message: `题库中没有其他「${current.bloomLevel}」层级的题可替换，可到命题工坊为本诗补题`,
            })
        }

        // 走 entityToQuestion 而不是直接塞实体：DB 实体的可空字段
        // （options: string[] | null）与运行时 Question 的可选字段语义不同
        const pickedEntity = candidates[Math.floor(Math.random() * candidates.length)]
        if (!pickedEntity) {
            return reply.status(409).send({ status: 'error', message: '候选题状态已变化，请重新发起换题' })
        }
        const picked = entityToQuestion(pickedEntity)
        runtime.questions[runtime.currentIndex] = picked
        // 换题即清空该题已有作答：旧题的作答记在新题上会让统计彻底错乱
        runtime.responses.delete(current.id)
        runtimes.set(params.lessonId, runtime)

        broadcastClassroomEvent(broadcaster, params.lessonId, 'classroom:question-replaced', {
            lessonId: params.lessonId,
            questionId: picked.id,
        })

        return reply.send({
            status: 'ok',
            question: sanitizeQuestion(picked),
            replacedFrom: current.id,
            remainingCandidates: candidates.length - 1,
        })
    })


    app.post('/:lessonId/end', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const runtime = runtimes.get(lessonId)

        if (!runtime) {
            // runtime 已清除（结束超 5 分钟）：尝试从 lessons.metadata 恢复历史报告
            const historical = loadReportFromLesson(lessonId)
            if (historical) {
                return reply.send({
                    status: 'ok',
                    lessonId,
                    report: historical,
                })
            }
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }

        // 幂等：已结束且报告已缓存 → 直接返回，不重复生成
        if (runtime.endedAt && runtime.report) {
            req.log.info({ lessonId }, '[classroom] 课堂已结束（幂等返回缓存报告）')
            return reply.send({
                status: 'ok',
                lessonId,
                report: runtime.report,
            })
        }

        runtime.endedAt = Date.now()
        // SqliteMap：mutation 后必须显式 set() 落盘（endedAt 变更）
        runtimes.set(lessonId, runtime)

        // 停止认知监测
        stopCognitiveMonitor(lessonId)

        // 清理调度器状态（调度状态不持久化，课堂结束后释放）
        classroomScheduler.cleanup(lessonId)

        // 计算课后掌握度
        const masteryAfter = computeClassPoemMasteryAvg(runtime.classId, runtime.poemId)

        // 生成课堂协奏报告（带降级）
        const report = await generateClassroomReport(runtime, masteryAfter)

        // 缓存报告到 runtime（供后续幂等 end / GET /report 复用）
        runtime.report = report
        runtimes.set(lessonId, runtime)

        // 更新 lesson 状态 + 持久化报告到 metadata.classroomReport
        try {
            const existingLesson = repos.lessons.findById(lessonId)
            const existingMetadata = (existingLesson?.metadata as Record<string, unknown> | null) ?? {}
            repos.lessons.update(lessonId, {
                status: 'completed',
                endedAt: runtime.endedAt,
                metadata: { ...existingMetadata, classroomReport: report },
            })
        } catch (err) {
            req.log.warn({ err }, '[classroom] lesson 状态/报告持久化失败')
        }

        // 广播课堂结束事件
        broadcastClassroomEvent(broadcaster, lessonId, 'classroom:end', {
            lessonId,
            endedAt: runtime.endedAt,
            report,
        })

        // P0-3: 课堂结束后触发班级盲区检测（容错：失败不影响主响应）
        triggerClassBlindSpotCheck(runtime.classId, runtime.poemId)

        // 清理持久化数据（保留 5 分钟供前端拉取最终状态，含 joinCode 反查）
        const cleanupTimer = setTimeout(() => {
            runtimes.delete(lessonId)
            aiSuggestionTracker.cleanup(lessonId)
            classroomCleanupTimers.delete(lessonId)
        }, 5 * 60 * 1000)
        cleanupTimer.unref?.()
        classroomCleanupTimers.set(lessonId, cleanupTimer)

        req.log.info({ lessonId }, '[classroom] 课堂已结束')

        return reply.send({
            status: 'ok',
            lessonId,
            report,
        })
    })

    // ── GET /:lessonId/report — 拉取课堂协奏报告（支持历史课堂） ──
    // 查询顺序：runtime.report 缓存 → lessons.metadata.classroomReport 持久化
    app.get('/:lessonId/report', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const runtime = runtimes.get(lessonId)

        // 1. runtime 存在且已缓存报告
        if (runtime?.report) {
            return reply.send({
                status: 'ok',
                lessonId,
                report: runtime.report,
            })
        }

        // 2. 从 lessons.metadata.classroomReport 恢复历史报告
        const historical = loadReportFromLesson(lessonId)
        if (historical) {
            return reply.send({
                status: 'ok',
                lessonId,
                report: historical,
            })
        }

        // 3. 课堂尚未结束或报告不存在
        if (runtime && !runtime.endedAt) {
            return reply.status(409).send({
                status: 'error',
                message: '课堂尚未结束，暂无报告',
            })
        }
        return reply.status(404).send({
            status: 'error',
            message: '课堂报告不存在',
        })
    })

    // ── GET /join/:joinCode — 通过加入码查找课堂（学生端用） ──
    app.get('/join/:joinCode', async (req: FastifyRequest, reply) => {
        const params = validateParams(joinCodeParamsSchema, req, reply)
        if (!params) return
        const { joinCode } = params
        // joinCode 反查：通过 classroom_sessions.join_code 索引查询
        const matches = runtimes.findByIndex('join_code', joinCode.toUpperCase())
        const firstMatch = matches[0]
        const lessonId = firstMatch ? firstMatch.key : undefined

        if (!lessonId) {
            return reply.status(404).send({ status: 'error', message: '加入码无效或课堂已结束' })
        }

        const runtime = runtimes.get(lessonId)
        if (!runtime || runtime.endedAt) {
            return reply.status(404).send({ status: 'error', message: '课堂已结束' })
        }

        return reply.send({
            status: 'ok',
            lessonId,
            mode: runtime.mode,
            poemId: runtime.poemId,
        })
    })

    // ── GET /explain/:poemId — 课堂讲解工具（逐句讲解 + 正音） ──
    // 返回诗篇的讲解内容：逐句教学要点、正音提示、讨论引导、意象分析
    // 整体教学建议由 brush.creative 生成（带降级），逐句数据从诗篇元数据派生
    app.get('/explain/:poemId', async (req: FastifyRequest, reply) => {
        const params = validateParams(explainPoemIdParamsSchema, req, reply)
        if (!params) return
        const { poemId } = params

        const poem = repos.poems.findById(poemId)
        if (!poem) {
            return reply.status(404).send({ status: 'error', message: '诗篇不存在' })
        }

        // 拆分诗句为行
        const poemLines = splitPoemLines(poem.content)

        // 调用 AI 生成整体教学建议（带降级到模板）
        let overallTeachingAdvice: string
        let aiGenerated: boolean
        try {
            const ctx = buildAgentContext(`explain-${poemId}`, 'classroom')
            const input: CreativeInput = {
                type: 'cultural-story',
                poemId,
                topic: `为教师课堂讲解《${poem.title}》生成整体教学建议：讲解重点、节奏把控、互动设计`,
                gradeLevel: '3-4年级',
                constraints: [
                    '200-400 字',
                    '聚焦教学策略而非内容复述',
                    '包含 2-3 条具体可执行的教学建议',
                ],
            }
            const result = await agents.brush.creative.invoke(input, ctx)
            const output = result.output as CreativeOutput
            overallTeachingAdvice = output.content
            aiGenerated = true
        } catch (err) {
            req.log.warn({ err, poemId }, '[classroom] explain AI 生成降级到模板')
            overallTeachingAdvice = buildFallbackAdvice(poem)
            aiGenerated = false
        }

        // 构建逐句讲解
        const lines: ExplainLine[] = poemLines.map((line, idx) =>
            buildExplainLine(idx, line, poem),
        )

        return reply.send({
            poemId,
            poemTitle: poem.title,
            poet: poem.poet,
            lines,
            overallTeachingAdvice,
            suggestedDurationMin: Math.max(15, Math.min(45, poemLines.length * 5 + 10)),
            aiGenerated,
        })
    })

    // ═══════════════════════════════════════════════════════════
    // 课堂指挥深化端点（Task 2/3/5）
    // ═══════════════════════════════════════════════════════════

    // ── POST /:lessonId/schedule/next — 实时调度：选取下一学生 ──
    // 支持轮询/抽签/PK/分层 4 种策略，根据全班正确率与时间进度自适应
    app.post('/:lessonId/schedule/next', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const body = validateBody(scheduleNextSchema, req, reply)
        if (!body) return
        const runtime = runtimes.get(lessonId)

        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }

        const timeProgress = body.timeProgress ?? computeTimeProgress(runtime)
        const result = classroomScheduler.selectNext(
            runtime,
            body.preferredStrategy,
            timeProgress,
        )

        // 广播调度事件
        broadcastClassroomEvent(broadcaster, lessonId, 'classroom:schedule-next', {
            lessonId,
            studentId: result.studentId,
            studentName: result.studentName,
            strategy: result.strategy,
            isOverride: result.isOverride,
        })

        return reply.send({
            status: 'ok',
            lessonId,
            ...result,
        })
    })

    // ── POST /:lessonId/schedule/override — 教师手动覆盖调度 ──
    app.post('/:lessonId/schedule/override', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const body = validateBody(scheduleOverrideSchema, req, reply)
        if (!body) return
        const runtime = runtimes.get(lessonId)

        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }

        // 从 runtime 中获取学生显示名（隐私合规）
        const studentName = body.studentName ?? runtime.students.get(body.studentId) ?? `学生${body.studentId}`
        classroomScheduler.override(lessonId, body.studentId, studentName)

        // 广播覆盖事件
        broadcastClassroomEvent(broadcaster, lessonId, 'classroom:schedule-override', {
            lessonId,
            studentId: body.studentId,
            studentName,
        })

        return reply.send({
            status: 'ok',
            lessonId,
            studentId: body.studentId,
            studentName,
            message: '已设置教师覆盖，下一次 next() 时生效',
        })
    })

    // ── GET /:lessonId/schedule/status — 获取调度状态 ──
    app.get('/:lessonId/schedule/status', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const runtime = runtimes.get(lessonId)

        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }

        const timeProgress = computeTimeProgress(runtime)
        const status = classroomScheduler.getStatus(lessonId, runtime, timeProgress)

        return reply.send({
            status: 'ok',
            lessonId,
            ...status,
        })
    })

    // ── POST /:lessonId/ai/suggest — AI 实时反馈（SSE 流式） ──
    // 分析学生作答，给出针对性反馈建议
    app.post('/:lessonId/ai/suggest', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const body = validateBody(aiSuggestSchema, req, reply)
        if (!body) return
        const runtime = runtimes.get(lessonId)

        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }

        const question = runtime.questions.find((q) => q.id === body.questionId)
        if (!question) {
            return reply.status(404).send({ status: 'error', message: '题目不存在' })
        }

        // 获取该学生在当前题目的最新作答
        const responses = runtime.responses.get(body.questionId) ?? []
        const response = responses.find((r) => r.studentId === body.studentId)
        if (!response) {
            return reply.status(404).send({ status: 'error', message: '学生尚未作答，无法生成反馈' })
        }

        // 计算全班正确率
        const classAccuracy = body.classAccuracy ?? computeClassAccuracy(runtime)

        // 接管响应，SSE 流式输出
        reply.hijack()
        const raw = reply.raw
        raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, private, no-store, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        })

        const abortController = new AbortController()
        const removeDisconnectHandlers = bindSseDisconnectAbort(req.raw, raw, abortController)
        const writeSSE = (payload: unknown) => writeSseFrame(raw, payload, abortController.signal)

        try {
            for await (const chunk of aiCollaborator.suggestFeedback({
                lessonId,
                question,
                response,
                classAccuracy,
            }, abortController.signal)) {
                if (abortController.signal.aborted || !await writeSSE(chunk)) {
                    abortController.abort()
                    break
                }
            }
            const completedForClient = !abortController.signal.aborted && await writeSSE('[DONE]')
            if (completedForClient) {
                aiSuggestionTracker.record(lessonId, 'feedback')
                // 广播 AI 建议事件
                broadcastClassroomEvent(broadcaster, lessonId, 'classroom:ai-suggested', {
                    lessonId,
                    category: 'feedback',
                    summary: `针对「${question.stem.slice(0, 20)}…」的实时反馈`,
                    questionId: question.id,
                    studentId: body.studentId,
                    suggestedAt: Date.now(),
                })
                req.log.info({ lessonId, questionId: body.questionId }, '[classroom] AI 实时反馈流式输出完成')
            } else if (!abortController.signal.aborted) {
                abortController.abort()
            }
        } catch (err) {
            if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
                req.log.debug({ lessonId }, '[classroom] AI 反馈流被客户端中止')
            } else {
                req.log.error({ err, lessonId }, '[classroom] AI 实时反馈流式输出失败')
                await writeSSE(createPublicSseError('AI_STREAM_FAILED', err))
            }
        } finally {
            removeDisconnectHandlers()
            if (!raw.writableEnded) {
                raw.end()
            }
        }
    })

    // ── POST /:lessonId/ai/supplement — AI 背景补充（SSE 流式） ──
    // 补充诗歌创作背景、意象文化内涵
    app.post('/:lessonId/ai/supplement', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const body = validateBody(aiSupplementSchema, req, reply)
        if (!body) return
        const runtime = runtimes.get(lessonId)

        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }

        const question = runtime.questions.find((q) => q.id === body.questionId)
        if (!question) {
            return reply.status(404).send({ status: 'error', message: '题目不存在' })
        }

        reply.hijack()
        const raw = reply.raw
        raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, private, no-store, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        })

        const abortController = new AbortController()
        const removeDisconnectHandlers = bindSseDisconnectAbort(req.raw, raw, abortController)
        const writeSSE = (payload: unknown) => writeSseFrame(raw, payload, abortController.signal)

        try {
            for await (const chunk of aiCollaborator.supplementBackground({
                lessonId,
                question,
                poemId: runtime.poemId,
            }, abortController.signal)) {
                if (abortController.signal.aborted || !await writeSSE(chunk)) {
                    abortController.abort()
                    break
                }
            }
            const completedForClient = !abortController.signal.aborted && await writeSSE('[DONE]')
            if (completedForClient) {
                aiSuggestionTracker.record(lessonId, 'supplement')
                broadcastClassroomEvent(broadcaster, lessonId, 'classroom:ai-suggested', {
                    lessonId,
                    category: 'supplement',
                    summary: `「${question.stem.slice(0, 20)}…」背景补充`,
                    questionId: question.id,
                    suggestedAt: Date.now(),
                })
                req.log.info({ lessonId, questionId: body.questionId }, '[classroom] AI 背景补充流式输出完成')
            } else if (!abortController.signal.aborted) {
                abortController.abort()
            }
        } catch (err) {
            if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
                req.log.debug({ lessonId }, '[classroom] AI 背景补充流被客户端中止')
            } else {
                req.log.error({ err, lessonId }, '[classroom] AI 背景补充流式输出失败')
                await writeSSE(createPublicSseError('AI_STREAM_FAILED', err))
            }
        } finally {
            removeDisconnectHandlers()
            if (!raw.writableEnded) {
                raw.end()
            }
        }
    })

    // ── POST /:lessonId/ai/followup — AI 追问生成（SSE 流式） ──
    // 基于当前题目和学生作答，生成高阶思维追问
    app.post('/:lessonId/ai/followup', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const body = validateBody(aiFollowupSchema, req, reply)
        if (!body) return
        const runtime = runtimes.get(lessonId)

        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }

        const question = runtime.questions.find((q) => q.id === body.questionId)
        if (!question) {
            return reply.status(404).send({ status: 'error', message: '题目不存在' })
        }

        // 获取学生作答（可选）
        let response: StudentResponse | undefined
        if (body.studentId) {
            const responses = runtime.responses.get(body.questionId) ?? []
            response = responses.find((r) => r.studentId === body.studentId)
        }

        reply.hijack()
        const raw = reply.raw
        raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, private, no-store, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        })

        const abortController = new AbortController()
        const removeDisconnectHandlers = bindSseDisconnectAbort(req.raw, raw, abortController)
        const writeSSE = (payload: unknown) => writeSseFrame(raw, payload, abortController.signal)

        try {
            for await (const chunk of aiCollaborator.generateFollowup({
                lessonId,
                question,
                response,
            }, abortController.signal)) {
                if (abortController.signal.aborted || !await writeSSE(chunk)) {
                    abortController.abort()
                    break
                }
            }
            const completedForClient = !abortController.signal.aborted && await writeSSE('[DONE]')
            if (completedForClient) {
                aiSuggestionTracker.record(lessonId, 'followup')
                broadcastClassroomEvent(broadcaster, lessonId, 'classroom:ai-suggested', {
                    lessonId,
                    category: 'followup',
                    summary: `「${question.stem.slice(0, 20)}…」追问生成`,
                    questionId: question.id,
                    studentId: body.studentId,
                    suggestedAt: Date.now(),
                })
                req.log.info({ lessonId, questionId: body.questionId }, '[classroom] AI 追问生成流式输出完成')
            } else if (!abortController.signal.aborted) {
                abortController.abort()
            }
        } catch (err) {
            if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
                req.log.debug({ lessonId }, '[classroom] AI 追问流被客户端中止')
            } else {
                req.log.error({ err, lessonId }, '[classroom] AI 追问生成流式输出失败')
                await writeSSE(createPublicSseError('AI_STREAM_FAILED', err))
            }
        } finally {
            removeDisconnectHandlers()
            if (!raw.writableEnded) {
                raw.end()
            }
        }
    })

    // ── POST /:lessonId/ai/intervention — 困难学生与全班干预建议（确定性聚合） ──
    // 与需要逐 token 呈现的前三类建议不同，干预建议需要先聚合课堂中的全部作答，
    // 因此一次性返回可核对的学生范围、正确率和课堂策略；不能用“追问生成”冒充它。
    app.post('/:lessonId/ai/intervention', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const runtime = runtimes.get(lessonId)

        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }

        try {
            const intervention = await detectIntervention({ lessonId, runtime })
            aiSuggestionTracker.record(lessonId, 'intervention')

            broadcastClassroomEvent(broadcaster, lessonId, 'classroom:ai-suggested', {
                lessonId,
                category: 'intervention',
                summary: intervention.strugglingStudents.length > 0
                    ? `已识别 ${intervention.strugglingStudents.length} 名需重点支持的学生`
                    : '当前未识别出需重点支持的学生',
                suggestedAt: Date.now(),
            })

            return reply.send({
                status: 'ok',
                lessonId,
                category: 'intervention',
                intervention,
            })
        } catch (err) {
            req.log.error({ err, lessonId }, '[classroom] 干预建议生成失败')
            return reply.status(500).send({
                status: 'error',
                error: 'CLASSROOM_INTERVENTION_FAILED',
                message: '干预建议生成失败，请稍后重试',
            })
        }
    })

    // ── POST /:lessonId/after-action-report/generate — 生成复盘报告 ──
    // 课堂结束后自动生成或教师手动触发生成
    app.post('/:lessonId/after-action-report/generate', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const runtime = runtimes.get(lessonId)

        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }

        // 幂等：已生成则返回缓存
        const existingReport = (runtime as ClassroomRuntime & { afterActionReport?: unknown }).afterActionReport
        if (existingReport) {
            return reply.send({
                status: 'ok',
                lessonId,
                report: existingReport,
            })
        }

        try {
            const report = await afterActionReportGenerator.generateReport(runtime)

                // 缓存到 runtime（通过 metadata 扩展字段）
                ; (runtime as ClassroomRuntime & { afterActionReport?: unknown }).afterActionReport = report
            runtimes.set(lessonId, runtime)

            // 持久化到 lessons.metadata
            try {
                const existingLesson = repos.lessons.findById(lessonId)
                const existingMetadata = (existingLesson?.metadata as Record<string, unknown> | null) ?? {}
                repos.lessons.update(lessonId, {
                    metadata: { ...existingMetadata, afterActionReport: report },
                })
            } catch (err) {
                req.log.warn({ err }, '[classroom] 复盘报告持久化失败')
            }

            // 广播报告生成事件
            broadcastClassroomEvent(broadcaster, lessonId, 'classroom:report-generated', {
                lessonId,
                classId: runtime.classId,
                participation: report.participation.rate,
                generatedAt: Date.now(),
            })

            req.log.info({ lessonId }, '[classroom] 复盘报告生成完成')

            return reply.send({
                status: 'ok',
                lessonId,
                report,
            })
        } catch (err) {
            req.log.error({ err, lessonId }, '[classroom] 复盘报告生成失败')
            return reply.status(500).send({
                status: 'error',
                message: '复盘报告生成失败，请稍后重试',
            })
        }
    })

    // ── GET /:lessonId/after-action-report — 获取复盘报告 ──
    // 查询顺序：runtime 缓存 → lessons.metadata 持久化
    app.get('/:lessonId/after-action-report', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const runtime = runtimes.get(lessonId)

        // 1. runtime 缓存
        if (runtime) {
            const cached = (runtime as ClassroomRuntime & { afterActionReport?: unknown }).afterActionReport
            if (cached) {
                return reply.send({
                    status: 'ok',
                    lessonId,
                    report: cached,
                })
            }
        }

        // 2. 从 lessons.metadata 恢复
        try {
            const lesson = repos.lessons.findById(lessonId)
            if (lesson?.metadata) {
                const raw = (lesson.metadata as Record<string, unknown>).afterActionReport
                if (raw && typeof raw === 'object') {
                    return reply.send({
                        status: 'ok',
                        lessonId,
                        report: raw,
                    })
                }
            }
        } catch {
            // 持久化查询失败，继续返回 404
        }

        return reply.status(404).send({
            status: 'error',
            message: '复盘报告尚未生成，请先调用 POST /:lessonId/after-action-report/generate',
        })
    })

    // ── POST /:lessonId/ai/mark-adopted — 标记 AI 建议被采纳 ──
    // 教师采纳 AI 建议时调用，用于统计采纳率
    app.post('/:lessonId/ai/mark-adopted', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params
        const body = validateBody(
            z.object({
                category: z.enum(['feedback', 'supplement', 'followup', 'intervention']),
            }),
            req,
            reply,
        )
        if (!body) return

        aiSuggestionTracker.markAdopted(lessonId, body.category)

        return reply.send({
            status: 'ok',
            lessonId,
            category: body.category,
            message: '已标记建议为已采纳',
        })
    })

    // ─────────────────────────────────────────────────────────────
    // 共舞舞台路由（v5.0 创新点：AI 诗教共舞舞台）
    // 三方实时协作事件总线：教师 / AI / 学生
    // ─────────────────────────────────────────────────────────────

    // ── POST /:lessonId/dance/start — 启动共舞会话 ──
    app.post('/:lessonId/dance/start', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params

        // 从 runtime 获取课堂基础信息
        const runtime = runtimes.get(lessonId)
        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '课堂不存在或已结束' })
        }
        if (runtime.endedAt) {
            return reply.status(400).send({ status: 'error', message: '课堂已结束，无法启动共舞会话' })
        }

        try {
            const session = startDanceSession({
                lessonId,
                classId: runtime.classId,
                poemId: runtime.poemId,
                teacherLabel: '教师',
            })
            return reply.send({ status: 'ok', session })
        } catch (err) {
            req.log.error({ err, lessonId }, '[classroom] 共舞会话启动失败')
            const publicError = toDanceStartPublicError(err)
            return reply.status(publicError.statusCode).send({
                status: 'error',
                error: publicError.error,
                message: publicError.message,
            })
        }
    })

    // ── GET /:lessonId/dance/timeline — 获取共舞时间轴 ──
    app.get('/:lessonId/dance/timeline', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params

        const query = req.query as { from?: string; limit?: string }
        const from = query.from ? Math.max(0, parseInt(query.from, 10) || 0) : 0
        const limit = query.limit ? Math.max(1, parseInt(query.limit, 10) || 500) : 500

        const session = danceStage.getSession(lessonId)
        if (!session) {
            return reply.send({ status: 'ok', timeline: [], total: 0 })
        }

        const timeline = danceStage.getTimeline(lessonId, from, limit)
        return reply.send({
            status: 'ok',
            timeline,
            total: session.timeline.length,
        })
    })

    // ── POST /:lessonId/dance/event — 提交共舞事件 ──
    app.post('/:lessonId/dance/event', async (req: FastifyRequest, reply) => {
        const params = validateParams(lessonIdParamsSchema, req, reply)
        if (!params) return
        const { lessonId } = params

        const body = validateBody(danceEventSchema, req, reply)
        if (!body) return

        // 校验会话存在且活跃
        const session = danceStage.getSession(lessonId)
        if (!session) {
            return reply.status(404).send({ status: 'error', message: '共舞会话未启动，请先调用 POST /:lessonId/dance/start' })
        }
        if (session.endedAt) {
            return reply.status(400).send({ status: 'error', message: '共舞会话已结束' })
        }

        // 构建 DanceEventName（actor:subType）
        const eventName = `${body.actor}:${body.subType}` as DanceEventName

        const event = danceStage.submitEvent(lessonId, {
            name: eventName,
            actor: body.actor as DanceActor,
            subType: body.subType as DanceEventSubType,
            actorId: body.actorId ?? body.actor,
            actorLabel: body.actorLabel ?? (body.actor === 'teacher' ? '教师' : body.actor === 'ai' ? 'AI 共舞者' : '学生'),
            content: body.content,
            questionId: body.questionId,
            targetStudentId: body.targetStudentId,
            aiGenerated: body.aiGenerated ?? false,
        })

        if (!event) {
            return reply.status(500).send({ status: 'error', message: '事件提交失败' })
        }

        return reply.send({ status: 'ok', event })
    })

    // ═══════════════════════════════════════════════════════════
    // SubTask 14.4：会话管理端点（sessions/score/comment/virtual-opponent）
    // 轻量会话入口，与 /:lessonId/* 端点共用 ClassroomRuntime 存储
    // ═══════════════════════════════════════════════════════════

    // ── POST /sessions — 创建轻量会话（返回 sessionId，等价于简化版 /start） ──
    app.post('/sessions', async (req: FastifyRequest, reply) => {
        const body = validateBody(createSessionSchema, req, reply)
        if (!body) return

        const { classId, poemId, mode = 'collective-race', questionCount } = body

        const classEntity = repos.classes.findById(classId)
        const poem = repos.poems.findById(poemId)
        if (!classEntity) {
            return reply.status(404).send({ status: 'error', message: '班级不存在' })
        }
        if (!poem) {
            return reply.status(404).send({ status: 'error', message: '古诗不存在' })
        }

        const questions = loadQuestions(poemId, undefined, mode)
        const slicedQuestions = questionCount ? questions.slice(0, questionCount) : questions
        if (slicedQuestions.length === 0) {
            return reply.status(400).send({
                status: 'error',
                message: '未找到可用题目，请先在命题工坊生成题目',
            })
        }

        const sessionId = `sess-${generateId()}`
        const joinCode = generateJoinCode()
        const startedAt = Date.now()
        const masteryBefore = computeClassPoemMasteryAvg(classId, poemId)
        const flyingFlowerKeyword = mode === 'flying-flower'
            ? FLYING_FLOWER_KEYWORDS[Math.floor(Math.random() * FLYING_FLOWER_KEYWORDS.length)]
            : undefined

        const runtime: ClassroomRuntime = {
            lessonId: sessionId,
            classId,
            poemId,
            mode,
            joinCode,
            startedAt,
            questions: slicedQuestions,
            currentIndex: 0,
            students: new Map(),
            responses: new Map(),
            hints: [],
            discussions: [],
            hintsDelivered: 0,
            classMood: 'focused',
            cognitiveLoad: 20,
            engagement: 50,
            flyingFlowerKeyword,
            flyingFlowerLeaderboard: mode === 'flying-flower' ? new Map() : undefined,
            speedPkScores: mode === 'speed-pk' ? new Map() : undefined,
            masteryBefore,
        }

        // 轻量会话同样必须同时具备短期 runtime 与长期课堂归档，不能静默降级。
        const persistence = persistLessonStartOrRollback({
            id: sessionId,
            classId,
            poemId,
            teacherId: classEntity.teacherId,
            startedAt,
            status: 'ongoing',
            mode,
            metadata: { joinCode, classroomVersion: 'v3-session', masteryBefore },
        }, {
            createRuntime: () => runtimes.set(sessionId, runtime),
            createLesson: (lesson) => repos.lessons.create(lesson),
            rollbackRuntime: (id) => runtimes.delete(id),
            log: req.log,
        })
        if (!persistence.ok) {
            return reply.status(503).send({
                status: 'error',
                error: persistence.failure === 'runtime'
                    ? 'CLASSROOM_RUNTIME_UNAVAILABLE'
                    : 'LESSON_ARCHIVE_UNAVAILABLE',
                message: persistence.failure === 'runtime'
                    ? '会话未创建：课堂实时状态暂时无法安全保存，请稍后重试'
                    : '会话未创建：课堂记录暂时无法安全保存，请稍后重试',
            })
        }

        startCognitiveMonitor(sessionId, broadcaster)

        broadcastClassroomEvent(broadcaster, sessionId, 'classroom:session-started', {
            sessionId,
            classId,
            poemId,
            mode,
            joinCode,
            startedAt,
            totalQuestions: slicedQuestions.length,
        })

        req.log.info(
            { sessionId, classId, poemId, mode, joinCode },
            '[classroom-sessions] 会话已创建',
        )

        return reply.send({
            status: 'ok',
            sessionId,
            joinCode,
            joinUrl: `/classroom/${sessionId}`,
            startedAt,
            mode,
            totalQuestions: slicedQuestions.length,
            aiGenerated: false as const,
        })
    })

    // ── GET /sessions/:sessionId — 获取会话状态 ──
    app.get('/sessions/:sessionId', async (req: FastifyRequest, reply) => {
        const params = validateParams(sessionIdParamsSchema, req, reply)
        if (!params) return
        const { sessionId } = params
        const runtime = runtimes.get(sessionId)

        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '会话不存在或已结束' })
        }

        const currentQuestion = runtime.questions[runtime.currentIndex]
        const responses = currentQuestion
            ? (runtime.responses.get(currentQuestion.id) ?? [])
            : []

        return reply.send({
            status: 'ok',
            sessionId,
            mode: runtime.mode,
            phase: runtime.endedAt ? 'ended' : 'ongoing',
            currentQuestionIndex: runtime.currentIndex,
            totalQuestions: runtime.questions.length,
            currentQuestion: currentQuestion ? sanitizeQuestion(currentQuestion) : undefined,
            activeStudents: runtime.students.size,
            responses: responses.map((r) => ({
                studentId: r.studentId,
                answer: r.answer,
                correct: r.correct,
                at: r.at,
            })),
            classMood: runtime.classMood,
            cognitiveLoad: runtime.cognitiveLoad,
            engagement: runtime.engagement,
            hintsDelivered: runtime.hintsDelivered,
            joinCode: runtime.joinCode,
            flyingFlowerKeyword: runtime.flyingFlowerKeyword,
            hasReport: !!runtime.report,
            aiGenerated: true as const,
        })
    })

    // ── POST /sessions/:sessionId/score — 教师直接评分（不走答题流程） ──
    app.post('/sessions/:sessionId/score', async (req: FastifyRequest, reply) => {
        const params = validateParams(sessionIdParamsSchema, req, reply)
        if (!params) return
        const { sessionId } = params
        const body = validateBody(scoreSessionSchema, req, reply)
        if (!body) return

        const runtime = runtimes.get(sessionId)
        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '会话不存在或已结束' })
        }

        const { studentId, score, dimension = 'overall', comment, poemId, bloomLevel } = body

        // 校验学生属于该班级
        const student = repos.students.findById(studentId)
        if (!student || student.classId !== runtime.classId) {
            return reply.status(404).send({
                status: 'error',
                message: '学生不存在或不属于该班级',
            })
        }

        // 注册学生到 runtime
        if (!runtime.students.has(studentId)) {
            runtime.students.set(studentId, student.name)
        }
        const displayName = runtime.students.get(studentId) ?? studentId

        // 持久化评分到 mastery 表（如提供 poemId 与 bloomLevel）
        const effectivePoemId = poemId ?? runtime.poemId
        const effectiveBloom = bloomLevel ?? '理解'
        try {
            repos.mastery.upsertScore(
                studentId,
                effectivePoemId,
                effectiveBloom,
                score,
                score >= 60,
            )
        } catch (err) {
            req.log.warn({ err, studentId }, '[classroom-score] mastery 持久化失败')
        }

        // 广播评分事件
        broadcastClassroomEvent(broadcaster, sessionId, 'classroom:scored', {
            sessionId,
            studentId,
            studentName: displayName,
            score,
            dimension,
            comment: comment ?? '',
            poemId: effectivePoemId,
            bloomLevel: effectiveBloom,
            scoredAt: Date.now(),
        })

        // 更新课堂氛围（评分入账后重新计算）
        updateClassroomMood(runtime)
        runtimes.set(sessionId, runtime)

        return reply.send({
            status: 'ok',
            sessionId,
            studentId,
            studentName: displayName,
            score,
            dimension,
            comment: comment ?? '',
            recorded: true,
            aiGenerated: false as const,
        })
    })

    // ── POST /sessions/:sessionId/smart-score — AI 智能赋分 ──
    // 飞花令 / 意象拼图 / 诗篇接龙三种玩法没有"教师先算好分数"的环节，
    // 需要后端依据作答文本即时判分。与 /score（教师手动赋分）互补。
    app.post('/sessions/:sessionId/smart-score', async (req: FastifyRequest, reply) => {
        const params = validateParams(sessionIdParamsSchema, req, reply)
        if (!params) return
        const { sessionId } = params
        const body = validateBody(smartScoreSchema, req, reply)
        if (!body) return

        const runtime = runtimes.get(sessionId)
        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '会话不存在或已结束' })
        }

        // 定位题目：优先按 questionId，其次当前题；都没有则按作答场景合成一道等价题面。
        // 飞花令 / 接龙 / 拼图常常没有题库题目，此处不能因此拒绝赋分。
        const matched = body.questionId
            ? runtime.questions.find((q) => q.id === body.questionId)
            : runtime.questions[runtime.currentIndex]

        const question: Question = matched ?? {
            id: body.questionId ?? `adhoc-${generateId()}`,
            poemId: runtime.poemId,
            bloomLevel: body.mode === 'poem-relay' ? '创造' : '理解',
            type: body.mode === 'poem-relay' || body.mode === 'flying-flower' ? '创作' : '简答',
            stem:
                body.mode === 'flying-flower'
                    ? '飞花令作答'
                    : body.mode === 'poem-relay'
                        ? '诗篇接龙作答'
                        : body.mode === 'imagery-puzzle'
                            ? '意象拼图作答'
                            : '课堂作答',
            answer: body.referenceAnswer ?? '',
            analysis: '',
            difficulty: 3,
            estimatedTimeSec: 60,
            aiGenerated: true,
        }

        // 数据库真实学生必须属于当前课堂班级；玩法内合成 ID 可以参与临时赋分，
        // 但后续绝不写入 mastery。真实学生展示名只取服务端名册真相源，
        // 不接受客户端伪造；模型与外发材料仍使用 anonymousName。
        const knownStudent = repos.students.findById(body.studentId)
        const participant = resolveSmartScoreParticipant(
            runtime.classId,
            body.studentId,
            knownStudent,
            runtime.students.get(body.studentId),
            body.studentName,
        )
        if (!participant.accepted) {
            return reply.status(409).send({
                status: 'error',
                error: participant.reason,
                message: '学生不属于当前课堂班级',
            })
        }
        const displayName = participant.displayName
        runtime.students.set(body.studentId, displayName)

        /**
         * 本地确定性兜底赋分
         *
         * AI 不可用时不能让课堂卡住，也不能返回随机分数糊弄教师。
         * 这里给出可解释的规则分：命中标准答案关键信息 + 作答充实度 + 速答加分，
         * 并在 model 字段标记 local-fallback，前端据此可提示"AI 暂不可用，规则赋分"。
         */
        const localScore = (): {
            score: number
            correct: boolean
            feedback: string
            dimensions: Array<{ name: string; score: number; maxScore: number; comment: string }>
        } => {
            const answer = body.answer.trim()
            const ref = (body.referenceAnswer ?? '').trim()
            // 关键字命中：飞花令的 referenceAnswer 形如「含「月」字的诗句」，取书名号内的字
            const keywordMatch = ref.match(/「(.+?)」/)
            const keyword = keywordMatch?.[1]
            const hit = keyword
                ? answer.includes(keyword)
                : ref
                    ? answer.includes(ref.slice(0, Math.min(6, ref.length)))
                    : answer.length > 0

            const richness = Math.min(100, Math.round(answer.length * 4))
            const speedBonus =
                body.latencyMs !== undefined && body.latencyMs < 8000 && hit ? 5 : 0
            const accuracy = hit ? 85 : 40
            const score = Math.max(
                0,
                Math.min(100, Math.round(accuracy * 0.7 + richness * 0.3) + speedBonus),
            )
            return {
                score,
                correct: score >= 60,
                feedback: hit
                    ? `作答命中要点${keyword ? `（含「${keyword}」）` : ''}，共 ${answer.length} 字。建议进一步补充画面感与情感层次。`
                    : `作答未命中关键信息${keyword ? `（应含「${keyword}」）` : ''}，建议对照原诗再试一次。`,
                dimensions: [
                    { name: '准确性', score: accuracy, maxScore: 100, comment: hit ? '命中核心' : '偏离要点' },
                    { name: '完整性', score: richness, maxScore: 100, comment: answer.length >= 20 ? '充分' : '偏简略' },
                    {
                        name: '响应速度',
                        score: body.latencyMs === undefined ? 60 : Math.max(0, 100 - Math.floor(body.latencyMs / 200)),
                        maxScore: 100,
                        comment: body.latencyMs === undefined ? '未记录' : `${(body.latencyMs / 1000).toFixed(1)}s`,
                    },
                ],
            }
        }

        let score: number
        let correct: boolean
        let feedback: string
        let dimensions: Array<{ name: string; score: number; maxScore: number; comment: string }>
        let model: string
        let aiGenerated: boolean

        // 客观题先做标准答案精确校准。让大模型用“创造性”等主观维度扣一条
        // 完全正确的填空题，会产生 75/100 这类失真的课堂反馈。
        // 需要语义判断的开放题仍进入真实模型；可确定的事实题则使用可复核规则。
        const normalizeObjectiveAnswer = (value: string): string =>
            value.normalize('NFKC').replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()《》〈〉【】\[\]]+/g, '').toLocaleLowerCase('zh-CN')
        const objectiveTypes = new Set(['填空', '选择', '判断'])
        const objectiveReference = (body.referenceAnswer ?? question.answer ?? '').trim()
        const normalizedStudentAnswer = normalizeObjectiveAnswer(body.answer)
        const normalizedObjectiveReference = normalizeObjectiveAnswer(objectiveReference)
        const isObjectiveExact =
            objectiveTypes.has(question.type) &&
            normalizedObjectiveReference.length > 0 &&
            (
                normalizedStudentAnswer === normalizedObjectiveReference ||
                normalizedStudentAnswer.includes(normalizedObjectiveReference)
            )

        if (isObjectiveExact) {
            score = 100
            correct = true
            feedback = `作答与标准答案完全一致，${displayName}对这处诗句掌握准确。可以继续说一说诗句描绘的动作或画面，把记忆转化为理解。`
            dimensions = [
                { name: '准确性', score: 100, maxScore: 100, comment: '与标准答案完全一致' },
                { name: '完整性', score: 100, maxScore: 100, comment: '关键内容完整' },
                { name: '规范性', score: 100, maxScore: 100, comment: '表达清晰规范' },
            ]
            model = 'deterministic-exact'
            aiGenerated = false
        } else if (config.demoMode) {
            const local = localScore()
            score = local.score
            correct = local.correct
            feedback = local.feedback
            dimensions = local.dimensions
            model = 'local-fallback'
            aiGenerated = false
        } else {
            try {
                const output = await multiDimensionScorer.score({
                    question,
                    studentAnswer: body.answer,
                })
                score = Math.round(output.weightedTotal)
                correct = score >= 60
                feedback = output.overallComment
                dimensions = output.dimensions.map((d) => ({
                    name: d.label,
                    score: Math.round(d.score),
                    maxScore: 100,
                    comment: d.comment,
                }))
                model = 'deepseek-v4-pro'
                aiGenerated = true
            } catch (err) {
                req.log.warn({ err, sessionId }, '[classroom-smart-score] AI 赋分降级为本地规则赋分')
                const local = localScore()
                score = local.score
                correct = local.correct
                feedback = local.feedback
                dimensions = local.dimensions
                model = 'local-fallback'
                aiGenerated = false
            }
        }

        // 持久化到 mastery（真实学生才写库，合成 ID 不污染学情数据）
        if (participant.persistent) {
            try {
                repos.mastery.upsertScore(
                    body.studentId,
                    runtime.poemId,
                    question.bloomLevel,
                    score,
                    correct,
                )
            } catch (err) {
                req.log.warn({ err, studentId: body.studentId }, '[classroom-smart-score] mastery 持久化失败')
            }
        }

        const scoredAt = Date.now()

        broadcastClassroomEvent(broadcaster, sessionId, 'classroom:scored', {
            sessionId,
            studentId: body.studentId,
            studentName: displayName,
            score,
            dimension: 'overall',
            comment: feedback,
            poemId: runtime.poemId,
            bloomLevel: question.bloomLevel,
            scoredAt,
        })

        updateClassroomMood(runtime)
        runtimes.set(sessionId, runtime)

        return reply.send({
            status: 'ok',
            lessonId: sessionId,
            studentId: body.studentId,
            questionId: question.id,
            score,
            correct,
            feedback,
            dimensions,
            model,
            scoredAt,
            aiGenerated,
        })
    })

    // ── POST /sessions/:sessionId/comment — SSE 流式评论 ──
    // 基于课堂实时状态（氛围、认知负荷、参与度、当前题目）生成 AI 评论
    app.post('/sessions/:sessionId/comment', async (req: FastifyRequest, reply) => {
        const params = validateParams(sessionIdParamsSchema, req, reply)
        if (!params) return
        const { sessionId } = params
        const body = validateBody(commentSessionSchema, req, reply)
        if (!body) return

        const runtime = runtimes.get(sessionId)
        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '会话不存在或已结束' })
        }

        const poem = repos.poems.findById(runtime.poemId)
        const poemTitle = poem?.title ?? '本诗'
        const topic = body.topic ?? inferCommentTopic(runtime, body.angle)
        const angle = body.angle ?? 'summary'
        const studentName = body.studentId
            ? (runtime.students.get(body.studentId) ?? '指定学生')
            : '全班'

        // 接管响应，SSE 流式输出
        reply.hijack()
        const raw = reply.raw
        raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, private, no-store, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        })

        const abortController = new AbortController()
        const removeDisconnectHandlers = bindSseDisconnectAbort(req.raw, raw, abortController)
        const writeSSE = (payload: unknown) => writeSseFrame(raw, payload, abortController.signal)

        try {
            // DEMO 模式：模拟逐字流式输出
            if (config.demoMode) {
                const demoComment = buildDemoSessionComment(runtime, poemTitle, studentName, angle, topic)
                for (const char of demoComment) {
                    if (abortController.signal.aborted) break
                    if (!await writeSSE({ delta: char })) {
                        abortController.abort()
                        break
                    }
                    await new Promise((resolve) => setTimeout(resolve, 30))
                }
                const completedForClient = !abortController.signal.aborted && await writeSSE('[DONE]')
                if (completedForClient) {
                    req.log.info({ sessionId }, '[classroom-comment] DEMO 评论流式输出完成')
                } else if (!abortController.signal.aborted) {
                    abortController.abort()
                }
                return
            }

            // 调用 brush.creative 流式生成评论
            const ctx: AgentContext = {
                ...buildAgentContext(`comment-${sessionId}`, 'classroom-session'),
                signal: abortController.signal,
            }
            const input: CreativeInput = {
                type: 'cultural-story',
                poemId: runtime.poemId,
                topic: buildCommentPrompt(runtime, poemTitle, studentName, angle, topic),
                gradeLevel: '3-4年级',
                constraints: [
                    '150-300 字',
                    angle === 'summary' ? '概括课堂当前状态与亮点' : '',
                    angle === 'guidance' ? '给出下一步教学引导建议' : '',
                    angle === 'reflection' ? '引导学生进行课堂反思' : '',
                    angle === 'encouragement' ? '鼓励学生，增强学习信心' : '',
                    '语言亲切自然，符合小学古诗课堂场景',
                ].filter(Boolean),
            }

            const result = await agents.brush.creative.invoke(input, ctx)
            const output = result.output as CreativeOutput
            const content = output.content

            // 逐字流式推送（按字符切片）
            for (const char of content) {
                if (abortController.signal.aborted) break
                if (!await writeSSE({ delta: char })) {
                    abortController.abort()
                    break
                }
                await new Promise((resolve) => setTimeout(resolve, 30))
            }
            const completedForClient = !abortController.signal.aborted && await writeSSE('[DONE]')
            if (completedForClient) {
                broadcastClassroomEvent(broadcaster, sessionId, 'classroom:commented', {
                    sessionId,
                    angle,
                    topic,
                    studentName,
                    commentedAt: Date.now(),
                })
                req.log.info({ sessionId, angle }, '[classroom-comment] AI 评论流式输出完成')
            } else if (!abortController.signal.aborted) {
                abortController.abort()
            }
        } catch (err) {
            if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
                req.log.debug({ sessionId }, '[classroom-comment] 评论流被客户端中止')
            } else {
                req.log.error({ err, sessionId }, '[classroom-comment] AI 评论流式输出失败')
                await writeSSE(createPublicSseError('COMMENT_STREAM_FAILED', err))
            }
        } finally {
            removeDisconnectHandlers()
            if (!raw.writableEnded) {
                raw.end()
            }
        }
    })

    // ── POST /sessions/:sessionId/virtual-opponent — 虚拟对手 ──
    // 生成 AI 虚拟学生参与课堂（PK 模式或示范作答）
    app.post('/sessions/:sessionId/virtual-opponent', async (req: FastifyRequest, reply) => {
        const params = validateParams(sessionIdParamsSchema, req, reply)
        if (!params) return
        const { sessionId } = params
        const body = validateBody(virtualOpponentSchema, req, reply)
        if (!body) return

        const runtime = runtimes.get(sessionId)
        if (!runtime) {
            return reply.status(404).send({ status: 'error', message: '会话不存在或已结束' })
        }

        // 难度归一化：显式 difficulty 优先，其次前端的 level 别名，最后兜底 adaptive
        const difficulty = body.difficulty ?? body.level ?? 'adaptive'
        const persona = body.persona ?? 'peer-helper'
        const timeLimitSec = body.timeLimitSec ?? 15
        const questionId = body.questionId

        // 选取题目
        // 飞花令 / 诗篇接龙等玩法没有题库题目，前端会直接把题面（questionStem）
        // 或关键字/上句传过来，此时不能 404，而应合成一道等价题面继续作答。
        const matchedQuestion = questionId
            ? runtime.questions.find((q) => q.id === questionId)
            : runtime.questions[runtime.currentIndex]

        const syntheticStem =
            body.questionStem ??
            (body.flyingFlowerKeyword ? `飞花令：说出一句含「${body.flyingFlowerKeyword}」字的诗句` : undefined) ??
            (body.relayPrevious ? `诗篇接龙：承接上句「${body.relayPrevious}」，吟出下一句` : undefined)

        const question = matchedQuestion ?? (syntheticStem
            ? {
                ...(runtime.questions[0] ?? {}),
                id: questionId ?? `adhoc-${generateId()}`,
                stem: syntheticStem,
                answer: body.flyingFlowerKeyword ?? body.relayPrevious ?? '',
                options: body.options,
            } as typeof runtime.questions[number]
            : undefined)

        if (!question) {
            return reply.status(404).send({ status: 'error', message: '题目不存在' })
        }

        // 生成虚拟对手 ID 与显示名
        const opponentId = `ai-opp-${generateId()}`
        const personaLabel = buildPersonaLabel(persona)

        // 根据难度决定虚拟对手的作答策略
        const opponentStrategy = resolveOpponentStrategy(difficulty, runtime)

        // 生成 AI 作答内容（DEMO 模式直接返回模板答案）
        let opponentAnswer: string
        let isCorrect: boolean
        let aiGenerated: boolean

        if (config.demoMode) {
            // DEMO 模式：根据难度返回半正确/全正确/错误的答案
            const demoResult = buildDemoOpponentAnswer(question, difficulty, opponentStrategy)
            opponentAnswer = demoResult.answer
            isCorrect = demoResult.correct
            aiGenerated = false
        } else {
            try {
                const ctx = buildAgentContext(`opp-${sessionId}-${opponentId}`, 'classroom-opponent')
                const input: CreativeInput = {
                    type: 'cultural-story',
                    poemId: runtime.poemId,
                    topic: `作为虚拟对手（人设：${personaLabel}，难度：${difficulty}），请为题目「${question.stem}」生成作答。\n` +
                        `要求：\n` +
                        `- ${difficulty === 'easy' ? '答案明显正确，适合示范' : ''}\n` +
                        `- ${difficulty === 'medium' ? '答案部分正确，包含小错误' : ''}\n` +
                        `- ${difficulty === 'hard' ? '答案偏难，挑战学生思维' : ''}\n` +
                        `- ${difficulty === 'adaptive' ? '根据课堂氛围自适应调整答案风格' : ''}\n` +
                        `作答字数 30-100 字，符合小学古诗课堂风格。`,
                    gradeLevel: '3-4年级',
                    constraints: [
                        `作答时间不超过 ${timeLimitSec} 秒`,
                        `符合「${personaLabel}」人设的语言风格`,
                        difficulty === 'easy' ? '答案必须正确' : '',
                        difficulty === 'medium' ? '答案大体正确但允许小瑕疵' : '',
                        difficulty === 'hard' ? '答案可以更有挑战性或反常规' : '',
                    ].filter(Boolean),
                }
                const result = await agents.brush.creative.invoke(input, ctx)
                const output = result.output as CreativeOutput
                opponentAnswer = output.content.replace(/^#+\s*/, '').slice(0, 500)
                // 简单匹配判断是否包含正确答案关键字
                isCorrect = opponentAnswer.includes(question.answer.slice(0, Math.min(20, question.answer.length)))
                aiGenerated = true
            } catch (err) {
                req.log.warn({ err, sessionId }, '[classroom-opp] AI 虚拟对手生成降级')
                const fallback = buildDemoOpponentAnswer(question, difficulty, opponentStrategy)
                opponentAnswer = fallback.answer
                isCorrect = fallback.correct
                aiGenerated = false
            }
        }

        // 注册虚拟对手到 runtime.students
        runtime.students.set(opponentId, personaLabel)

        // 推送答题事件
        const response: StudentResponse = {
            studentId: opponentId,
            studentName: personaLabel,
            answer: opponentAnswer,
            correct: isCorrect,
            at: Date.now(),
            latencyMs: Math.floor(timeLimitSec * 1000 * (0.5 + Math.random() * 0.4)),
            score: runtime.mode === 'speed-pk' && isCorrect ? 80 : undefined,
        }

        // 记录到 runtime.responses
        const existingResponses = runtime.responses.get(question.id) ?? []
        existingResponses.push(response)
        runtime.responses.set(question.id, existingResponses)
        runtimes.set(sessionId, runtime)

        // 广播虚拟对手作答事件
        broadcastClassroomEvent(broadcaster, sessionId, 'classroom:virtual-opponent-answered', {
            sessionId,
            opponentId,
            opponentName: personaLabel,
            questionId: question.id,
            answer: opponentAnswer,
            correct: isCorrect,
            difficulty,
            persona,
            aiGenerated,
        })

        // 赋分：与前端 AIOpponentAnswerResult 契约对齐（难度越高、答对得分越高）
        // 答错统一 30 分，体现「参与但未达成」，而非 0 分打击式反馈。
        const opponentScore = isCorrect
            ? difficulty === 'hard'
                ? 95
                : difficulty === 'easy'
                    ? 70
                    : 85
            : 30

        return reply.send({
            status: 'ok',
            sessionId,
            // lessonId 与 sessionId 在课堂 runtime 中是同一 ID 空间，
            // 前端 AIOpponentAnswerResult 按 lessonId 取值，这里一并回传。
            lessonId: sessionId,
            opponentId,
            opponentName: personaLabel,
            questionId: question.id,
            answer: opponentAnswer,
            correct: isCorrect,
            score: opponentScore,
            // 复用上面写入 runtime 的真实延迟，避免前后端各算一份对不上
            latencyMs: response.latencyMs,
            reasoning: isCorrect
                ? `依据题干「${question.stem.slice(0, 24)}」与诗篇语境作答`
                : '作答与标准答案存在偏差，未命中关键信息',
            model: aiGenerated ? 'deepseek-v4-pro' : 'local-fallback',
            answeredAt: response.at,
            difficulty,
            persona,
            aiGenerated,
        })
    })
}

// ─────────────────────────────────────────────────────────────
// SubTask 14.4：会话管理辅助函数
// ─────────────────────────────────────────────────────────────

/** 根据课堂实时状态推断评论主题 */
function inferCommentTopic(
    runtime: ClassroomRuntime,
    angle?: 'summary' | 'guidance' | 'reflection' | 'encouragement',
): string {
    const accuracy = computeClassAccuracy(runtime)
    const mood = runtime.classMood
    const moodLabel: Record<ClassMood, string> = {
        focused: '专注',
        excited: '活跃',
        bored: '疲倦',
        confused: '困惑',
    }
    const baseTopic = `课堂氛围：${moodLabel[mood]}，正确率 ${(accuracy * 100).toFixed(0)}%，参与度 ${runtime.engagement}%`

    if (angle === 'guidance') {
        return `${baseTopic}。请针对当前状态给出下一步教学引导建议。`
    }
    if (angle === 'reflection') {
        return `${baseTopic}。请引导学生反思本节课的收获与困惑。`
    }
    if (angle === 'encouragement') {
        return `${baseTopic}。请鼓励学生，增强学习信心。`
    }
    return `${baseTopic}。请概括当前课堂状态与亮点。`
}

/** 构建 AI 评论生成 prompt */
function buildCommentPrompt(
    runtime: ClassroomRuntime,
    poemTitle: string,
    studentName: string,
    angle: 'summary' | 'guidance' | 'reflection' | 'encouragement',
    topic: string,
): string {
    const accuracy = computeClassAccuracy(runtime)
    const angleLabel: Record<typeof angle, string> = {
        summary: '课堂总结',
        guidance: '教学引导',
        reflection: '课堂反思',
        encouragement: '鼓励激励',
    }
    return `课堂《${poemTitle}》${angleLabel[angle]}。\n` +
        `对象：${studentName}\n` +
        `状态：${topic}\n` +
        `认知负荷：${runtime.cognitiveLoad}/100，正确率 ${(accuracy * 100).toFixed(0)}%\n` +
        `请基于以上状态生成自然亲切的课堂评论。`
}

/** 构建 DEMO 模式评论内容 */
function buildDemoSessionComment(
    runtime: ClassroomRuntime,
    poemTitle: string,
    studentName: string,
    angle: 'summary' | 'guidance' | 'reflection' | 'encouragement',
    _topic: string,
): string {
    const accuracy = computeClassAccuracy(runtime)
    const moodLabel: Record<ClassMood, string> = {
        focused: '专注',
        excited: '活跃',
        bored: '疲倦',
        confused: '困惑',
    }
    const mood = moodLabel[runtime.classMood]

    if (angle === 'guidance') {
        return `同学们，我们在学习《${poemTitle}》时，课堂氛围${mood}，正确率达到${(accuracy * 100).toFixed(0)}%。` +
            `${accuracy < 0.6 ? '建议放慢节奏，重点回顾关键字词的含义。' : '可以适当提高难度，引入更高阶层的问题。'}` +
            `针对${studentName}，建议多关注意象与情感的联系，提升理解层次。`
    }
    if (angle === 'reflection') {
        return `回顾本节课，我们围绕《${poemTitle}》展开了${mood}的讨论。` +
            `同学们${accuracy > 0.7 ? '表现出色，掌握扎实' : '仍需巩固基础，重点理解意象'}。` +
            `${studentName}的思考很有深度，值得大家学习。希望大家课后能继续品味诗歌之美。`
    }
    if (angle === 'encouragement') {
        return `${studentName}，你今天的表现很棒！《${poemTitle}》的学习需要耐心与感悟，` +
            `同学们${mood === '活跃' ? '充满活力' : '认真专注'}的样子让老师很欣慰。` +
            `正确率${(accuracy * 100).toFixed(0)}%已经很不错，继续保持，相信你会越来越棒！`
    }
    // summary
    return `本节课学习《${poemTitle}》，课堂氛围${mood}，参与度${runtime.engagement}%。` +
        `${studentName}积极参与，正确率${(accuracy * 100).toFixed(0)}%。` +
        `${accuracy > 0.8 ? '整体掌握良好，可适当拓展延伸。' : accuracy > 0.6 ? '掌握情况尚可，建议针对性强化。' : '基础较弱，需重点复习关键字词。'}`
}

/** 构建虚拟对手人设标签 */
function buildPersonaLabel(persona: 'classic-scholar' | 'modern-student' | 'peer-helper' | 'challenger'): string {
    const labelMap = {
        'classic-scholar': '古代诗友',
        'modern-student': '现代学伴',
        'peer-helper': '互助同桌',
        'challenger': '挑战者',
    } as const
    return labelMap[persona]
}

/** 解析虚拟对手策略 */
function resolveOpponentStrategy(
    difficulty: 'easy' | 'medium' | 'hard' | 'adaptive',
    runtime: ClassroomRuntime,
): 'correct' | 'partial' | 'wrong' | 'adaptive' {
    if (difficulty !== 'adaptive') {
        if (difficulty === 'easy') return 'correct'
        if (difficulty === 'medium') return 'partial'
        return 'wrong'
    }
    // adaptive：基于课堂正确率自适应
    const accuracy = computeClassAccuracy(runtime)
    if (accuracy < 0.4) return 'correct' // 课堂表现差，对手作答正确示范
    if (accuracy > 0.8) return 'partial' // 课堂表现好，对手作答部分正确挑战
    return 'correct'
}

/** DEMO 模式构建虚拟对手作答 */
function buildDemoOpponentAnswer(
    question: Question,
    _difficulty: 'easy' | 'medium' | 'hard' | 'adaptive',
    strategy: 'correct' | 'partial' | 'wrong' | 'adaptive',
): { answer: string; correct: boolean } {
    if (strategy === 'correct') {
        return {
            answer: `我认为答案是「${question.answer}」。${question.analysis ?? '依据诗意推断。'}`,
            correct: true,
        }
    }
    if (strategy === 'partial') {
        return {
            answer: `大概是「${question.answer.slice(0, Math.min(5, question.answer.length))}...」吧，但我也不太确定。`,
            correct: true,
        }
    }
    if (strategy === 'wrong') {
        return {
            answer: `我猜是「${question.answer === 'A' ? 'B' : 'A'}」，但这只是我的直觉。`,
            correct: false,
        }
    }
    // adaptive 兜底
    return {
        answer: `根据诗意理解，答案应该是「${question.answer}」。`,
        correct: true,
    }
}

// ─────────────────────────────────────────────────────────────
// 课堂指挥深化辅助函数
// ─────────────────────────────────────────────────────────────

/** 计算课堂时间进度 0-1 */
function computeTimeProgress(runtime: ClassroomRuntime): number {
    const now = Date.now()
    const elapsed = now - runtime.startedAt
    // 默认课堂时长 40 分钟（2400 秒）
    const estimatedDuration = 40 * 60 * 1000
    return Math.min(1, Math.max(0, elapsed / estimatedDuration))
}

/** 计算全班正确率 0-1 */
function computeClassAccuracy(runtime: ClassroomRuntime): number {
    let total = 0
    let correct = 0
    for (const responses of runtime.responses.values()) {
        for (const r of responses) {
            total++
            if (r.correct) correct++
        }
    }
    return total > 0 ? correct / total : 0
}

// ─────────────────────────────────────────────────────────────
// 题目加载
// ─────────────────────────────────────────────────────────────

/**
 * 加载题目序列
 * 优先使用 questionIds，否则按古诗 + 模式自动选取
 */
function loadQuestions(poemId: string, questionIds: string[] | undefined, mode: ClassroomMode): Question[] {
    const questions: Question[] = []

    if (questionIds && questionIds.length > 0) {
        for (const qid of questionIds) {
            const q = repos.questions.findById(qid)
            if (q && q.poemId === poemId) {
                questions.push(entityToQuestion(q))
            }
        }
    } else {
        // 自动选取该诗的题目
        const entities = repos.questions.findByPoemId(poemId)
        for (const e of entities) {
            questions.push(entityToQuestion(e))
        }

        // 六阶沉浸模式：按阶层排序
        if (mode === 'six-level-immersive') {
            const order = ['记忆', '理解', '应用', '分析', '评价', '创造']
            questions.sort((a, b) => order.indexOf(a.bloomLevel) - order.indexOf(b.bloomLevel))
        }
    }

    return questions.slice(0, 20) // 上限 20 题
}

/** QuestionEntity -> Question（Agent 层类型） */
function entityToQuestion(e: import('../db/types.js').QuestionEntity): Question {
    return {
        id: e.id,
        poemId: e.poemId,
        bloomLevel: e.bloomLevel,
        type: e.type,
        stem: e.stem,
        options: e.options ?? undefined,
        answer: e.answer,
        analysis: e.analysis ?? '',
        distractorsAnalysis: e.distractorsAnalysis ?? undefined,
        difficulty: Math.max(1, Math.min(5, Math.round(e.difficulty * 5))) as Question['difficulty'],
        estimatedTimeSec: e.estimatedTimeSec,
        // 课堂题目均经 AI 出题流程生成（含人工审核），统一标记 aiGenerated: true
        aiGenerated: true as const,
    }
}

// ─────────────────────────────────────────────────────────────
// AI 调用（带降级）
// ─────────────────────────────────────────────────────────────

/** 构建 Agent 调用上下文 */
function buildAgentContext(taskId: string, sessionId: string): AgentContext {
    return {
        taskId,
        sessionId,
    }
}

/**
 * 调用 brush.grade 批改答案
 * 失败时降级为关键字匹配判定
 */
async function gradeAnswer(
    question: Question,
    studentAnswer: string,
    studentName: string,
): Promise<{ correct: boolean; feedback: string; confidence: number; needsHumanReview: boolean }> {
    const ctx = buildAgentContext(`grade-${question.id}`, 'classroom')
    const input: GradeInput = { question, studentAnswer }

    try {
        const result = await agents.brush.grade.invoke(input, ctx)
        const output = result.output as GradeOutput
        return {
            correct: output.correct,
            feedback: output.feedback,
            confidence: output.confidence,
            needsHumanReview: output.needsHumanReview,
        }
    } catch {
        // 降级：简单匹配
        const correct = studentAnswer.trim() === question.answer.trim()
        return {
            correct,
            feedback: correct
                ? `${studentName}回答正确，继续保持！`
                : `答案有误，正确答案是「${question.answer}」。${question.analysis ?? ''}`,
            confidence: 0.5,
            needsHumanReview: !correct,
        }
    }
}

/**
 * 调用 brush.creative 生成启发提示
 * 失败时降级为模板提示
 */
async function generateHint(
    question: Question,
    type: 'nudge' | 'scaffold' | 'reframe',
): Promise<string> {
    const ctx = buildAgentContext(`hint-${question.id}`, 'classroom')
    const input: CreativeInput = {
        type: 'cultural-story',
        poemId: question.poemId,
        topic: `为题目「${question.stem}」生成${type === 'nudge' ? '轻推式' : type === 'scaffold' ? '脚手架式' : '重构式'}启发提示，引导学生思考而非直接给答案`,
        gradeLevel: '3-4年级',
        constraints: [
            '提示长度 50-100 字',
            '不得直接给出答案',
            type === 'nudge' ? '用反问句引导学生回忆相关知识' : '',
            type === 'scaffold' ? '提供思考步骤的脚手架' : '',
            type === 'reframe' ? '从不同角度重新表述问题' : '',
        ].filter(Boolean),
    }

    try {
        const result = await agents.brush.creative.invoke(input, ctx)
        const output = result.output as CreativeOutput
        return output.content.replace(/^#+\s*/, '').slice(0, 200)
    } catch {
        // 降级：模板提示
        const templates: Record<typeof type, string> = {
            nudge: `想一想这首诗的创作背景，诗人想表达什么情感？这与题目有什么关联？`,
            scaffold: `第一步：理解题干关键词；第二步：回忆相关知识点；第三步：排除明显错误选项。`,
            reframe: `如果换个角度问：这首诗的「${question.bloomLevel}」层能力要求是什么？`,
        }
        return templates[type]
    }
}

/**
 * 调用 brush.creative 生成讨论题
 * 失败时降级为模板讨论题
 */
async function generateDiscussion(
    question: Question,
    angle: 'cultural' | 'comparative' | 'creative',
    runtime: ClassroomRuntime,
): Promise<{ topic: string; followUp: string[] }> {
    const ctx = buildAgentContext(`discuss-${question.id}`, 'classroom')
    const poem = repos.poems.findById(runtime.poemId)
    const poemTitle = poem?.title ?? '本诗'

    const angleMap: Record<typeof angle, string> = {
        cultural: '文化内涵角度（诗人背景、时代风貌、意象文化）',
        comparative: '比较阅读角度（与其他同主题诗作对比）',
        creative: '创意表达角度（改写、仿写、跨媒介转化）',
    }

    const input: CreativeInput = {
        type: 'cultural-story',
        poemId: runtime.poemId,
        topic: `为古诗「${poemTitle}」的题目「${question.stem}」生成${angleMap[angle]}的课堂讨论题`,
        gradeLevel: '5-6年级',
        constraints: [
            '讨论题 1 个，30-60 字',
            'followUp 为 2-3 个追问，每个 20-40 字',
            '讨论题应激发学生高阶思维',
        ],
    }

    try {
        const result = await agents.brush.creative.invoke(input, ctx)
        const output = result.output as CreativeOutput
        // 解析 content 提取讨论题与追问
        const lines = output.content.split('\n').map((l) => l.trim()).filter(Boolean)
        const topic = lines[0]?.replace(/^#+\s*/, '').slice(0, 100) ?? ''
        const followUp = lines.slice(1, 4).map((l) => l.replace(/^[-*]\s*/, '').slice(0, 80))
        return { topic, followUp: followUp.length > 0 ? followUp : ['你能举例说明吗？'] }
    } catch {
        // 降级：模板讨论题
        const templates: Record<typeof angle, { topic: string; followUp: string[] }> = {
            cultural: {
                topic: `「${poemTitle}」中的核心意象在诗人的其他作品中如何呈现？`,
                followUp: ['你能找到哪些共同意象？', '这些意象承载了怎样的情感？'],
            },
            comparative: {
                topic: `将「${poemTitle}」与同主题的其他诗作对比，有何异同？`,
                followUp: ['主题表达上有何差异？', '艺术手法各有什么特色？'],
            },
            creative: {
                topic: `如果将「${poemTitle}」改写为现代诗或散文，你会如何表达？`,
                followUp: ['保留哪些核心意象？', '如何转化古典意境为现代感受？'],
            },
        }
        return templates[angle]
    }
}

/**
 * 即时生成课堂协奏报告。
 *
 * 结束课堂属于强实时控制动作，不能被大模型推理阻塞。这里严格使用本堂课的
 * 作答、参与、掌握度与认知负荷数据生成可复核报告；更深入的 AI 复盘由
 * /after-action-report/generate 显式触发。
 */
async function generateClassroomReport(
    runtime: ClassroomRuntime,
    masteryAfter: number,
): Promise<ClassroomReportPayload> {
    // 汇总答题数据
    const totalResponses: StudentResponse[] = []
    for (const rs of runtime.responses.values()) {
        totalResponses.push(...rs)
    }
    const correctCount = totalResponses.filter((r) => r.correct).length
    const participation = runtime.students.size
    const accuracy = totalResponses.length > 0 ? correctCount / totalResponses.length : 0

    const moodLabel: Record<ClassMood, string> = {
        focused: '专注', excited: '活跃', bored: '疲倦', confused: '困惑',
    }
    return {
        summary: `本堂课共 ${runtime.questions.length} 题，${participation} 名学生参与，`
            + `提交答题 ${totalResponses.length} 次，正确率 ${(accuracy * 100).toFixed(0)}%。`
            + `课堂氛围：${moodLabel[runtime.classMood]}，`
            + `认知负荷 ${runtime.cognitiveLoad}，推送启发提示 ${runtime.hintsDelivered} 次。`,
        participation,
        masteryChange: { before: runtime.masteryBefore, after: masteryAfter },
        highlights: [
            `共 ${participation} 名学生参与`,
            `正确率 ${(accuracy * 100).toFixed(0)}%`,
            `推送 ${runtime.hintsDelivered} 次启发提示`,
        ],
        improvements: accuracy < 0.6
            ? ['针对错误率高的题目进行专项讲解', '增加同类题型的短练习']
            : ['适当提高题目难度', '引入更高阶层的教学内容'],
        aiGenerated: false,
    }
}

// ─────────────────────────────────────────────────────────────
// 课堂氛围与认知负荷
// ─────────────────────────────────────────────────────────────

/**
 * 更新课堂氛围与认知负荷
 * 基于答题正确率与响应速度推断
 */
function updateClassroomMood(runtime: ClassroomRuntime): void {
    const currentQuestion = runtime.questions[runtime.currentIndex]
    if (!currentQuestion) return

    const responses = runtime.responses.get(currentQuestion.id) ?? []
    if (responses.length === 0) return

    const correctRate = responses.filter((r) => r.correct).length / responses.length
    const avgLatency = responses
        .filter((r) => r.latencyMs !== undefined)
        .reduce((sum, r, _i, arr) => sum + (r.latencyMs ?? 0) / arr.length, 0)

    // 认知负荷：正确率越低、响应越慢，负荷越高
    const accuracyLoad = (1 - correctRate) * 60
    const latencyLoad = avgLatency > 0 ? Math.min(30, avgLatency / 1000) : 20
    runtime.cognitiveLoad = Math.min(100, Math.round(accuracyLoad + latencyLoad))

    // 课堂氛围
    if (correctRate > 0.8 && avgLatency < 15000) {
        runtime.classMood = 'excited'
    } else if (correctRate < 0.4) {
        runtime.classMood = 'confused'
    } else if (avgLatency > 30000) {
        runtime.classMood = 'bored'
    } else {
        runtime.classMood = 'focused'
    }

    // 活跃度
    runtime.engagement = Math.min(100, Math.round(
        correctRate * 50 + (responses.length / Math.max(1, runtime.students.size)) * 50,
    ))
}

/**
 * 启动认知负荷监测定时器
 * 周期性广播认知负荷与课堂氛围
 */
function startCognitiveMonitor(lessonId: string, broadcaster: WSBroadcaster): void {
    // /start 与 /sessions/:sessionId 都可能在重试/热重载路径中触发；
    // 同一课堂只能有一个监测循环，否则会重复广播并放大 SQLite 写入。
    if (cognitiveTimers.has(lessonId)) return

    const timer = setInterval(() => {
        const runtime = runtimes.get(lessonId)
        if (!runtime || runtime.endedAt) {
            stopCognitiveMonitor(lessonId)
            return
        }

        // 模拟认知负荷自然衰减（无答题时）
        if (runtime.cognitiveLoad > 30) {
            runtime.cognitiveLoad = Math.max(20, runtime.cognitiveLoad - 2)
            // SqliteMap：cognitiveLoad 变更后落盘（每 15s 一次，开销可接受）
            runtimes.set(lessonId, runtime)
        }

        broadcastClassroomEvent(broadcaster, lessonId, 'classroom:cognitive', {
            lessonId,
            cognitiveLoad: runtime.cognitiveLoad,
            classMood: runtime.classMood,
            engagement: runtime.engagement,
        })
    }, COGNITIVE_MONITOR_INTERVAL_MS)

    timer.unref?.()
    cognitiveTimers.set(lessonId, timer)
}

/** 停止认知负荷监测 */
function stopCognitiveMonitor(lessonId: string): void {
    const timer = cognitiveTimers.get(lessonId)
    if (timer) {
        clearInterval(timer)
        cognitiveTimers.delete(lessonId)
    }
}

/** 关闭服务/热重载时释放所有课堂级定时器。 */
function stopAllClassroomTimers(): void {
    for (const timer of cognitiveTimers.values()) {
        clearInterval(timer)
    }
    cognitiveTimers.clear()

    for (const timer of classroomCleanupTimers.values()) {
        clearTimeout(timer)
    }
    classroomCleanupTimers.clear()
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

/** 生成 6 位加入码 */
function generateJoinCode(): string {
    return generateUniqueClassroomJoinCode(
        (code) => runtimes.findByIndex('join_code', code).length > 0,
    )
}

/** 计算班级对某诗的掌握度均值 */
function computeClassPoemMasteryAvg(classId: string, poemId: string): number {
    try {
        const row = db
            .prepare(`
                SELECT AVG(m.score) as avg_score
                FROM mastery m
                JOIN students s ON m.student_id = s.id
                WHERE s.class_id = ? AND m.poem_id = ?
            `)
            .get(classId, poemId) as { avg_score: number | null } | undefined
        const avg = row?.avg_score
        if (avg === null || avg === undefined || Number.isNaN(avg)) return 0
        return Math.round(avg * 100) / 100
    } catch {
        return 0
    }
}

/** 脱敏题目（移除答案，发送给学生端时用） */
function sanitizeQuestion(q: Question): Omit<Question, 'answer' | 'analysis' | 'distractorsAnalysis'> & {
    answer?: string
    analysis?: string
} {
    return {
        id: q.id,
        poemId: q.poemId,
        bloomLevel: q.bloomLevel,
        type: q.type,
        stem: q.stem,
        options: q.options,
        estimatedTimeSec: q.estimatedTimeSec,
        difficulty: q.difficulty,
        aiGenerated: q.aiGenerated,
    }
}

/** 广播课堂事件 */
function broadcastClassroomEvent(
    broadcaster: WSBroadcaster,
    lessonId: string,
    type: string,
    payload: unknown,
): void {
    const event: WSEvent = {
        type,
        timestamp: Date.now(),
        sessionId: lessonId,
        payload,
    }
    broadcaster.broadcast(event)
}

// ─────────────────────────────────────────────────────────────
// P0-3 主动智能：班级盲区检测
// ─────────────────────────────────────────────────────────────

/**
 * 课堂结束后触发班级盲区检测
 *
 * 基于 classes + mastery 表构建 ClassContext，调用 proactiveIntelligence.checkClassBlindSpot
 * 主动推送盲区预警。容错：失败不影响主响应。
 */
function triggerClassBlindSpotCheck(classId: string, poemId: string): void {
    try {
        const classCtx = buildClassContextForProactive(classId)
        if (!classCtx) return
        const poem = repos.poems.findById(poemId)
        const poemTitle = poem?.title
        proactiveIntelligence.checkClassBlindSpot(classCtx, poemTitle)
    } catch {
        // 容错：失败不影响主响应
    }
}

/**
 * 基于 classes + mastery 表构建 ClassContext（供 checkClassBlindSpot 使用）
 * 失败时返回 null，不影响主流程
 */
function buildClassContextForProactive(classId: string): ClassContext | null {
    try {
        const cls = repos.classes.findById(classId)
        if (!cls) return null
        const bloomRadar = repos.mastery.getClassBloomRadar(classId)
        const averageMastery: BloomMastery = {
            记忆: 0, 理解: 0, 应用: 0, 分析: 0, 评价: 0, 创造: 0,
        }
        for (const r of bloomRadar) {
            const level = r.bloom_level
            // 类型守卫：仅接受合法的布鲁姆六阶
            if (level === '记忆' || level === '理解' || level === '应用'
                || level === '分析' || level === '评价' || level === '创造') {
                averageMastery[level] = r.avg_score
            }
        }
        return {
            id: cls.id,
            name: cls.name,
            grade: cls.grade,
            studentCount: cls.studentCount,
            averageMastery,
        }
    } catch {
        return null
    }
}

// ─────────────────────────────────────────────────────────────
// 课堂讲解工具辅助函数（Phase 4.3）
// ─────────────────────────────────────────────────────────────

/** 古诗常见多音字 / 易错读音字典（覆盖小学阶段高频字） */
const COMMON_MISPRONUNCIATIONS: Record<string, { correct: string; error: string; note: string }> = {
    '衰': { correct: 'cuī', error: 'shuāi', note: '此处读 cuī，意为减少、稀疏，不读 shuāi（衰老）' },
    '骑': { correct: 'jì', error: 'qí', note: '名词"骑兵"义读 jì，动词"骑乘"读 qí' },
    '斜': { correct: 'xiá', error: 'xié', note: '古诗押韵需要读 xiá，与现代汉语读音不同' },
    '还': { correct: 'huán', error: 'hái', note: '古诗中读 huán，意为返回、回还' },
    '见': { correct: 'xiàn', error: 'jiàn', note: '通"现"，读 xiàn，意为出现、显露' },
    '将': { correct: 'qiāng', error: 'jiāng', note: '请、愿之意读 qiāng' },
    '胜': { correct: 'shēng', error: 'shèng', note: '承受之意读 shēng，如"不胜枚举"' },
    '思': { correct: 'sì', error: 'sī', note: '作名词"思绪"时读 sì' },
    '长': { correct: 'cháng', error: 'zhǎng', note: '表示长度读 cháng，表示生长读 zhǎng' },
    '重': { correct: 'chóng', error: 'zhòng', note: '表示重复读 chóng，表示重量读 zhòng' },
    '朝': { correct: 'zhāo', error: 'cháo', note: '表示早晨读 zhāo，表示朝代读 cháo' },
    '行': { correct: 'háng', error: 'xíng', note: '表示行列读 háng，表示行走读 xíng' },
    '落': { correct: 'luò', error: 'là', note: '读 luò，意为落下、飘落' },
    '更': { correct: 'gēng', error: 'gèng', note: '表示更替读 gēng，表示更加读 gèng' },
    '度': { correct: 'duó', error: 'dù', note: '表示揣度读 duó，表示程度读 dù' },
}

/**
 * 将诗篇内容拆分为逐句
 *
 * 统一走 lib/poem-lines 的共享实现：GET /api/poem-content/:poemId 用同一份口径，
 * 两个接口的 lineIndex 必须严格对应，否则「逐句讲解」面板会把教学要点
 * 挂到错误的诗句上。切勿在此处另写一份切分规则。
 */
function splitPoemLines(content: string): string[] {
    return splitPoemClauses(content)
}

/** 为单行诗句构建讲解数据 */
function buildExplainLine(idx: number, line: string, poem: PoemEntity): ExplainLine {
    // 教学要点：从注释中提取与该行相关的字词
    const teachingPoints: string[] = []
    if (poem.annotation) {
        for (const [word, meaning] of Object.entries(poem.annotation)) {
            if (line.includes(word)) {
                teachingPoints.push(`「${word}」：${meaning}`)
            }
        }
    }
    // 从主题补充教学要点
    if (poem.theme.length > 0 && idx === 0) {
        teachingPoints.push(`本诗主题：${poem.theme.join('、')}`)
    }
    if (teachingPoints.length === 0) {
        teachingPoints.push('引导学生朗读体会该句的节奏与情感')
    }

    // 正音要点：检测该行中的多音字
    const pronunciationNotes: PronunciationNote[] = []
    for (const char of line) {
        const entry = COMMON_MISPRONUNCIATIONS[char]
        if (entry) {
            pronunciationNotes.push({
                char,
                correctPinyin: entry.correct,
                commonError: entry.error,
                note: entry.note,
            })
        }
    }

    // 讨论提示
    const discussionPrompts: string[] = []
    if (idx === 0) {
        discussionPrompts.push('这首诗开篇营造了怎样的氛围？')
    } else if (idx === 1) {
        discussionPrompts.push('这一句与上一句在情感上有什么变化？')
    } else {
        discussionPrompts.push('这一句在全诗中起什么作用？')
    }

    // 意象分析：检测该行中的意象
    const imageryAnalysis = buildImageryAnalysis(line, poem)

    return {
        lineIndex: idx,
        teachingPoints,
        pronunciationNotes,
        discussionPrompts,
        imageryAnalysis,
    }
}

/** 从诗篇意象列表中匹配该行出现的意象，生成意象分析 */
function buildImageryAnalysis(line: string, poem: PoemEntity): string | undefined {
    if (poem.images.length === 0) return undefined
    const matched = poem.images.filter((img) => line.includes(img))
    if (matched.length === 0) return undefined
    return `本句中的意象「${matched.join('、')}」承载了诗人的核心情感，需引导学生体会其文化内涵与象征意义。`
}

/** 降级模板：整体教学建议（AI 不可用时使用） */
function buildFallbackAdvice(poem: PoemEntity): string {
    const themes = poem.theme.length > 0 ? poem.theme.join('、') : '思乡与自然'
    const images = poem.images.length > 0 ? poem.images.join('、') : '核心意象'
    const rhetoric = poem.rhetoric.length > 0 ? poem.rhetoric.join('、') : '比喻与对偶'

    return `【教学建议——《${poem.title}》】

1. 讲解重点：本诗为${poem.dynasty}诗人${poem.poet}所作，主题为${themes}。讲解时应围绕「${images}」等核心意象展开，引导学生体会诗人情感。

2. 节奏把控：建议先朗读全诗（2-3 分钟），再逐句讲解（每句 3-5 分钟），最后总结升华（5 分钟）。注意正音环节，特别是多音字与古今异读。

3. 互动设计：可设置「意象探寻」活动，让学生找出诗中的关键意象并讨论其象征意义。亦可结合「${rhetoric}」等修辞手法设计仿写练习。

4. 拓展延伸：可联系诗人生平与其他同主题作品，帮助学生建立文化认知框架。`
}

// ─────────────────────────────────────────────────────────────
// 闯关辅助
// ─────────────────────────────────────────────────────────────

/** 统计题目在六阶上的分布，用于推算每关的通关目标 */
function countQuestionsByLevel(questions: Question[]): Record<string, number> {
    const out: Record<string, number> = {}
    for (const q of questions) {
        out[q.bloomLevel] = (out[q.bloomLevel] ?? 0) + 1
    }
    return out
}

/**
 * 给大屏用的闯关快照
 *
 * 排行榜在服务端排好再送出：七个模式都要显示同一份榜，
 * 让每个模式各排一遍既重复又容易排出不一致的结果。
 */
function questSnapshot(runtime: ClassroomRuntime | undefined): unknown {
    if (!runtime) return null
    const questionsByLevel = countQuestionsByLevel(runtime.questions)
    if (!runtime.quest) runtime.quest = createQuestState(questionsByLevel)
    const q = runtime.quest

    return {
        currentLevel: q.currentLevel,
        levelTitle: LEVEL_META[q.currentLevel]?.title ?? q.currentLevel,
        levelGoal: LEVEL_META[q.currentLevel]?.goal ?? '',
        clearedLevels: q.clearedLevels,
        // 全部六关都列出来（含本堂课没有题目的关），大屏才能画出完整的关卡链路
        levels: QUEST_LEVELS.map((lv) => ({
            level: lv,
            title: LEVEL_META[lv]?.title ?? lv,
            goal: LEVEL_META[lv]?.goal ?? '',
            questionCount: questionsByLevel[lv] ?? 0,
            cleared: q.clearedLevels.includes(lv),
            current: q.currentLevel === lv,
        })),
        classPower: q.classPower,
        levelPower: q.levelPower,
        levelTarget: q.levelTarget,
        levelProgress: q.levelTarget > 0
            ? Math.min(100, Math.round((q.levelPower / q.levelTarget) * 100))
            : 0,
        combo: q.combo,
        maxCombo: q.maxCombo,
        aiOpponentScore: q.aiOpponentScore,
        leaderboard: buildLeaderboard(q, runtime.students),
        hasTeams: q.teams.length > 0,
    }
}
