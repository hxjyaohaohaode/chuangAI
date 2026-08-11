/**
 * Agent 共享类型定义
 *
 * 本文件定义所有 Agent 共用的领域类型与上下文类型。
 * 部分类型为宽松占位（标注 "Task 6/7 收紧"），待学情画像与
 * 知识图谱模块完成后替换为严格版本。
 *
 * 设计原则：
 * - 零 any：所有类型显式标注
 * - 适配 noUncheckedIndexedAccess：Record 访问返回 T | undefined
 * - 适配 strictNullChecks：可选字段显式 ?
 */

import type { ChatMessage } from '../../llm/types.js'
import type { ZodType } from 'zod'

// ─────────────────────────────────────────────────────────────
// 布鲁姆认知分类
// ─────────────────────────────────────────────────────────────

/**
 * 布鲁姆认知六阶层级
 * 记忆 → 理解 → 应用 → 分析 → 评价 → 创造（由低到高）
 */
export type BloomLevel = '记忆' | '理解' | '应用' | '分析' | '评价' | '创造'

/** 布鲁姆六阶掌握度（每阶 0-100） */
export interface BloomMastery {
    记忆: number
    理解: number
    应用: number
    分析: number
    评价: number
    创造: number
}

/** 布鲁姆六阶权重（总和应为 100） */
export type BloomWeights = BloomMastery

// ─────────────────────────────────────────────────────────────
// 学情画像（Task 6 收紧）
// ─────────────────────────────────────────────────────────────

/** 认知风格 */
export type CognitiveStyle = 'visual' | 'auditory' | 'kinesthetic' | 'mixed'

/** 推荐学习节奏 */
export type LearningPace = 'slow' | 'medium' | 'fast'

/**
 * 学情画像
 * Task 6 完成后将补充完整字段，此处为 Agent 层所需的最小集合
 */
export interface StudentProfile {
    id: string
    name: string
    grade: string
    /** 按诗词 ID 索引的六阶掌握度 */
    mastery: Record<string, BloomMastery>
    cognitiveStyle?: CognitiveStyle
    engagementScore?: number
    recommendedPace?: LearningPace
    strengths?: string[]
    weaknesses?: string[]
    /** 班级排名（可选） */
    classRank?: number
    /** 上次更新时间戳 */
    updatedAt?: number
    aiGenerated?: true
    confidence?: number
}

// ─────────────────────────────────────────────────────────────
// 知识图谱节点（Task 7 收紧）
// ─────────────────────────────────────────────────────────────

/**
 * 诗词知识图谱节点
 * Task 7 完成后将补充图谱关系字段，此处为 Agent 层所需的最小集合
 */
export interface PoemNode {
    id: string
    title: string
    poet: string
    dynasty: string
    theme: string[]
    images: string[]
    /** 诗词原文 */
    content?: string
    /** 适用年级 */
    gradeLevel?: string
    /** 难度 1-5 */
    difficulty?: number
    /** 前置诗词 ID（知识图谱依赖关系） */
    prerequisites?: string[]
    /** 教学要点 */
    teachingPoints?: string[]
}

// ─────────────────────────────────────────────────────────────
// 班级上下文
// ─────────────────────────────────────────────────────────────

export interface ClassContext {
    id: string
    name: string
    grade: string
    studentCount: number
    /** 班级平均六阶掌握度 */
    averageMastery?: BloomMastery
    /** 班级整体参与度 */
    engagementScore?: number
}

// ─────────────────────────────────────────────────────────────
// 学习事件
// ─────────────────────────────────────────────────────────────

/**
 * 单次学习事件（答题、朗读、自学等）
 * 用于学情画像 Agent 的输入
 */
export interface LearningEvent {
    type: 'answer' | 'recite' | 'browse' | 'practice' | 'review'
    timestamp: number
    poemId?: string
    bloomLevel?: BloomLevel
    correct?: boolean
    /** 0-1 得分 */
    score?: number
    durationSec?: number
    detail?: string
}

// ─────────────────────────────────────────────────────────────
// 诊断结果
// ─────────────────────────────────────────────────────────────

/** 认知暗物质条目 */
export interface DarkMatterEntry {
    poemId: string
    bloomLevel: BloomLevel
    /** 错误模式描述（如"反复将'拟人'误判为'比喻'"） */
    pattern: string
    severity: 'low' | 'medium' | 'high'
    /** 根因分析 */
    rootCause: string
    /** 靶向处方 */
    prescription: string
}

/** 诊断结果 */
export interface DiagnosisResult {
    scope: 'class' | 'student'
    targetId: string
    darkMatter: DarkMatterEntry[]
    knowledgeGaps: Array<{ poemId: string; gap: string; priority: number }>
    bloomImbalance: { dominant: string; weakest: string; suggestion: string }
    aiGenerated: true
    confidence: number
}

// ─────────────────────────────────────────────────────────────
// 题目
// ─────────────────────────────────────────────────────────────

export type QuestionType = '选择' | '填空' | '配对' | '简答' | '创作' | '应用'

export interface Question {
    id: string
    poemId: string
    bloomLevel: BloomLevel
    type: QuestionType
    stem: string
    options?: string[]
    answer: string
    analysis: string
    distractorsAnalysis?: string[]
    difficulty: 1 | 2 | 3 | 4 | 5
    estimatedTimeSec: number
    aiGenerated: true
}

// ─────────────────────────────────────────────────────────────
// Agent 上下文与结果
// ─────────────────────────────────────────────────────────────

/**
 * Agent 调用上下文
 *
 * 封装 Context Engineering 5 策略的注入入口：
 * - Offload：studentProfile / classContext（外部记忆）
 * - Retrieve：knowledgeGraphNodes（知识图谱检索）
 * - Isolate：history（历史对话隔离注入）
 * - Cache：promptOverride（Prompt 版本缓存，Task 22 用）
 * - Reduce：teacherIntent（教师意图裁剪）
 */
export interface AgentContext {
    taskId: string
    sessionId?: string
    /** 中断信号 */
    signal?: AbortSignal
    /** 学情画像（来自 Task 6） */
    studentProfile?: StudentProfile
    /** 知识图谱节点（来自 Task 7） */
    knowledgeGraphNodes?: PoemNode[]
    /** 历史对话（Isolate 策略） */
    history?: ChatMessage[]
    /** 班级整体上下文 */
    classContext?: ClassContext
    /** 教师意图（来自编排官） */
    teacherIntent?: string
    /** 自我进化引擎的 Prompt 版本覆盖（Task 22 用） */
    promptOverride?: { version: string; systemPrompt?: string }
}

/**
 * Agent 调用结果
 * 所有 AI 生成内容必须携带 aiGenerated: true 元数据
 */
export interface AgentResult<T> {
    agentId: string
    output: T
    usage: { promptTokens: number; completionTokens: number; cachedTokens?: number }
    latencyMs: number
    promptVersion: string
    aiGenerated: true
    warnings?: string[]
}

// ─────────────────────────────────────────────────────────────
// 验收相关类型
// ─────────────────────────────────────────────────────────────

export type VerifyVerdict = 'pass' | 'revise' | 'reject'

export interface VerifyIssue {
    severity: 'low' | 'medium' | 'high'
    description: string
    suggestion: string
}

/** 验收维度 */
export const VERIFY_DIMENSIONS = [
    '准确性',
    '完整性',
    '一致性',
    '教育适宜性',
    '文化敏感性',
    'AI 安全合规',
] as const

export type VerifyDimension = (typeof VERIFY_DIMENSIONS)[number]

// ─────────────────────────────────────────────────────────────
// 结构化输出 Schema（spec A1：Zod 校验 LLM 输出，杜绝幻觉字段）
// ─────────────────────────────────────────────────────────────

/**
 * 结构化输出 Schema
 *
 * 任意 zod schema，其输出类型为 T。供 GVC 闭环在 Verifier 分支
 * 用 `schema.safeParse(output)` 校验 LLM 结构化输出，失败则触发重生成。
 *
 * 移植自 AI SDK `generateObject` 的模式（不引入 `ai` 包）：
 * 调用方提供 schema，loop 层负责校验 + 失败重试。
 *
 * 不提供 schema 时，GVC 走旧路径（向后兼容）。
 */
export type StructuredOutputSchema<T> = ZodType<T>

/**
 * 工具调用轻量类型（移植自 AI SDK `UIToolInvocation` 模式）
 *
 * 仅保留必要字段，作为可复用的类型契约，供未来 Agent 表达
 * "工具调用型"结构化输出。本 spec 不强制使用，仅提供模式。
 */
export interface ToolInvocation<T = unknown> {
    /** 工具调用唯一 ID（与 LLM 返回的 tool_call.id 对齐） */
    toolCallId: string
    /** 工具名称（与 Tool.function.name 对齐） */
    toolName: string
    /** 已解析的工具参数（经 schema 校验的结构化对象） */
    args: T
    /** 工具执行结果（可选，未执行时缺省） */
    result?: unknown
}
