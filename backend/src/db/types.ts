/**
 * 学情数据库实体类型定义
 *
 * 与 schema.sql 一一对应。所有 JSON 字段在 TS 层用具体类型表示，
 * 通过 utils/json 的 parse/stringify 工具在仓储层自动转换。
 *
 * 设计原则：
 * - 零 any：所有字段显式类型
 * - 严格区分 nullable 与 optional
 * - snake_case 列名映射为 camelCase 字段（由 Repository 转换）
 */

import type { BloomLevel, BloomWeights, CognitiveStyle, QuestionType } from '../agents/base/types.js'

// ─────────────────────────────────────────────────────────────
// 通用辅助类型
// ─────────────────────────────────────────────────────────────

/** 可选 ID（创建时由调用方提供或自动生成） */
export type OptionalId = { id?: string }

// ─────────────────────────────────────────────────────────────
// 班级
// ─────────────────────────────────────────────────────────────

export interface ClassEntity {
    id: string
    name: string
    grade: string
    teacherId: string
    studentCount: number
    createdAt: number
    updatedAt: number
    metadata: Record<string, unknown> | null
}

export type CreateClassInput = Omit<ClassEntity, 'id' | 'createdAt' | 'updatedAt' | 'studentCount' | 'metadata'> & {
    studentCount?: number
    metadata?: Record<string, unknown> | null
} & OptionalId

// ─────────────────────────────────────────────────────────────
// 学生
// ─────────────────────────────────────────────────────────────

export interface StudentEntity {
    id: string
    classId: string
    name: string
    anonymousName: string
    grade: string
    cognitiveStyle: CognitiveStyle | null
    engagementScore: number
    createdAt: number
    updatedAt: number
    metadata: Record<string, unknown> | null
}

export type CreateStudentInput = Omit<StudentEntity, 'id' | 'createdAt' | 'updatedAt' | 'cognitiveStyle' | 'engagementScore' | 'metadata'> & {
    cognitiveStyle?: CognitiveStyle | null
    engagementScore?: number
    metadata?: Record<string, unknown> | null
} & OptionalId

// ─────────────────────────────────────────────────────────────
// 古诗
// ─────────────────────────────────────────────────────────────

export interface PoemEntity {
    id: string
    title: string
    poet: string
    dynasty: string
    content: string
    annotation: Record<string, string> | null
    theme: string[]
    images: string[]
    rhetoric: string[]
    gradeLevel: string | null
    textbookEdition: string
    difficulty: number
    createdAt: number
    metadata: Record<string, unknown> | null
}

export type CreatePoemInput = Omit<PoemEntity, 'id' | 'createdAt' | 'annotation' | 'theme' | 'images' | 'rhetoric' | 'textbookEdition' | 'difficulty' | 'metadata'> & {
    annotation?: Record<string, string> | null
    theme?: string[]
    images?: string[]
    rhetoric?: string[]
    textbookEdition?: string
    difficulty?: number
    metadata?: Record<string, unknown> | null
} & OptionalId

// ─────────────────────────────────────────────────────────────
// 课程
// ─────────────────────────────────────────────────────────────

export type LessonStatus = 'planned' | 'ongoing' | 'completed' | 'cancelled'
/**
 * 课堂模式的后端单一真相源。
 *
 * 前端已实现 4 个基础模式和 3 个创新模式；路由、发布与持久化类型必须复用
 * 同一只读元组，避免“界面可选、接口 400 拒绝”的跨层断链再次出现。
 */
export const LESSON_MODES = [
    'collective-race',
    'speed-pk',
    'flying-flower',
    'six-level-immersive',
    'poem-wheel',
    'poem-relay',
    'imagery-puzzle',
] as const
export type LessonMode = (typeof LESSON_MODES)[number]

export interface LessonEntity {
    id: string
    classId: string
    poemId: string
    teacherId: string
    scheduledAt: number | null
    startedAt: number | null
    endedAt: number | null
    status: LessonStatus
    mode: LessonMode | null
    metadata: Record<string, unknown> | null
}

export type CreateLessonInput = Omit<LessonEntity, 'id' | 'scheduledAt' | 'startedAt' | 'endedAt' | 'status' | 'mode' | 'metadata'> & {
    scheduledAt?: number | null
    startedAt?: number | null
    endedAt?: number | null
    status?: LessonStatus
    mode?: LessonMode | null
    metadata?: Record<string, unknown> | null
} & OptionalId

// ─────────────────────────────────────────────────────────────
// 题目
// ─────────────────────────────────────────────────────────────

export interface QuestionEntity {
    id: string
    poemId: string
    bloomLevel: BloomLevel
    type: QuestionType
    stem: string
    options: string[] | null
    answer: string
    analysis: string | null
    distractorsAnalysis: string[] | null
    difficulty: number
    estimatedTimeSec: number
    aiGenerated: boolean
    promptVersion: string | null
    createdAt: number
    createdBy: string | null
    metadata: Record<string, unknown> | null
}

export type CreateQuestionInput = Omit<QuestionEntity, 'id' | 'createdAt' | 'options' | 'analysis' | 'distractorsAnalysis' | 'difficulty' | 'estimatedTimeSec' | 'aiGenerated' | 'promptVersion' | 'createdBy' | 'metadata'> & {
    options?: string[] | null
    analysis?: string | null
    distractorsAnalysis?: string[] | null
    difficulty?: number
    estimatedTimeSec?: number
    aiGenerated?: boolean
    promptVersion?: string | null
    createdBy?: string | null
    metadata?: Record<string, unknown> | null
} & OptionalId

// ─────────────────────────────────────────────────────────────
// 作答
// ─────────────────────────────────────────────────────────────

/**
 * 判分来源
 *
 * `rule`：本地规则判分。课堂闯关里客观题（选择/填空/默写/判断）
 * 由确定性规则微秒级判出对错并当场亮灯，随后 AI 讲评回填时会改写为 `ai`。
 * 单列一档而不是混记成 `ai`，是因为这段时间里的判分**确实不是模型给的**，
 * 记成 ai 会让后续的置信度统计与人工复核抽样都建立在错误前提上。
 */
export type GradedBy = 'ai' | 'teacher' | 'both' | 'rule'

export interface AnswerEntity {
    id: string
    studentId: string
    questionId: string
    lessonId: string | null
    answerText: string
    correct: boolean | null
    partialScore: number | null
    cognitiveAttribution: string | null
    feedback: string | null
    teacherHint: string | null
    aiConfidence: number | null
    needsHumanReview: boolean
    gradedBy: GradedBy | null
    gradedAt: number | null
    submittedAt: number
    metadata: Record<string, unknown> | null
}

export type CreateAnswerInput = Omit<AnswerEntity, 'id' | 'lessonId' | 'correct' | 'partialScore' | 'cognitiveAttribution' | 'feedback' | 'teacherHint' | 'aiConfidence' | 'needsHumanReview' | 'gradedBy' | 'gradedAt' | 'metadata'> & {
    lessonId?: string | null
    correct?: boolean | null
    partialScore?: number | null
    cognitiveAttribution?: string | null
    feedback?: string | null
    teacherHint?: string | null
    aiConfidence?: number | null
    needsHumanReview?: boolean
    gradedBy?: GradedBy | null
    gradedAt?: number | null
    metadata?: Record<string, unknown> | null
} & OptionalId

// ─────────────────────────────────────────────────────────────
// 六阶掌握度
// ─────────────────────────────────────────────────────────────

export interface MasteryEntity {
    id: string
    studentId: string
    poemId: string
    bloomLevel: BloomLevel
    score: number
    attempts: number
    correctCount: number
    lastAttemptAt: number | null
    updatedAt: number
}

export type CreateMasteryInput = Omit<MasteryEntity, 'id' | 'score' | 'attempts' | 'correctCount' | 'lastAttemptAt' | 'updatedAt'> & {
    score?: number
    attempts?: number
    correctCount?: number
    lastAttemptAt?: number | null
    updatedAt?: number
} & OptionalId

// ─────────────────────────────────────────────────────────────
// 学情事件
// ─────────────────────────────────────────────────────────────

export type EventType = 'self-study' | 'answer' | 'classroom' | 'recitation' | 'creative' | 'login' | 'other'

export interface EventEntity {
    id: string
    studentId: string | null
    classId: string | null
    lessonId: string | null
    type: EventType
    action: string
    payload: unknown | null
    poemId: string | null
    occurredAt: number
    recordedAt: number
    metadata: Record<string, unknown> | null
}

export type CreateEventInput = Omit<EventEntity, 'id' | 'studentId' | 'classId' | 'lessonId' | 'payload' | 'poemId' | 'occurredAt' | 'recordedAt' | 'metadata'> & {
    studentId?: string | null
    classId?: string | null
    lessonId?: string | null
    payload?: unknown | null
    poemId?: string | null
    occurredAt?: number
    recordedAt?: number
    metadata?: Record<string, unknown> | null
} & OptionalId

// ─────────────────────────────────────────────────────────────
// 朗读评测
// ─────────────────────────────────────────────────────────────

export interface RecitationEntity {
    id: string
    studentId: string
    poemId: string
    audioUrl: string | null
    transcript: string | null
    pronunciationScore: number | null
    rhythmScore: number | null
    emotionScore: number | null
    mistakes: unknown[] | null
    suggestion: string | null
    audioDurationSec: number | null
    aiGenerated: boolean
    createdAt: number
}

export type CreateRecitationInput = Omit<RecitationEntity, 'id' | 'audioUrl' | 'transcript' | 'pronunciationScore' | 'rhythmScore' | 'emotionScore' | 'mistakes' | 'suggestion' | 'audioDurationSec' | 'aiGenerated' | 'createdAt'> & {
    audioUrl?: string | null
    transcript?: string | null
    pronunciationScore?: number | null
    rhythmScore?: number | null
    emotionScore?: number | null
    mistakes?: unknown[] | null
    suggestion?: string | null
    audioDurationSec?: number | null
    aiGenerated?: boolean
    createdAt?: number
} & OptionalId

// ─────────────────────────────────────────────────────────────
// 自我进化引擎记忆
// ─────────────────────────────────────────────────────────────

export type EvolutionMemoryType = 'tactical' | 'strategic'

export interface EvolutionMemoryEntity {
    id: string
    type: EvolutionMemoryType
    agentId: string
    pattern: string
    beforePrompt: string | null
    afterPrompt: string | null
    improvementReward: number | null
    abTestResult: Record<string, unknown> | null
    createdAt: number
    appliedAt: number | null
    metadata: Record<string, unknown> | null
}

export type CreateEvolutionMemoryInput = Omit<EvolutionMemoryEntity, 'id' | 'beforePrompt' | 'afterPrompt' | 'improvementReward' | 'abTestResult' | 'createdAt' | 'appliedAt' | 'metadata'> & {
    beforePrompt?: string | null
    afterPrompt?: string | null
    improvementReward?: number | null
    abTestResult?: Record<string, unknown> | null
    createdAt?: number
    appliedAt?: number | null
    metadata?: Record<string, unknown> | null
} & OptionalId

// ─────────────────────────────────────────────────────────────
// Prompt 版本
// ─────────────────────────────────────────────────────────────

export interface PromptVersionEntity {
    id: string
    agentId: string
    version: string
    systemPrompt: string
    userPromptTemplate: string | null
    changelog: string | null
    isActive: boolean
    createdAt: number
}

export type CreatePromptVersionInput = Omit<PromptVersionEntity, 'id' | 'userPromptTemplate' | 'changelog' | 'isActive' | 'createdAt'> & {
    userPromptTemplate?: string | null
    changelog?: string | null
    isActive?: boolean
    createdAt?: number
} & OptionalId

// ─────────────────────────────────────────────────────────────
// 视图行类型
// ─────────────────────────────────────────────────────────────

export interface VClassPoemMasteryRow {
    class_id: string
    poem_id: string
    bloom_level: string
    avg_score: number
    student_count: number
    mastered_count: number
}

export interface VStudentBloomRadarRow {
    student_id: string
    bloom_level: string
    avg_score: number
    last_updated: number
}

// ─────────────────────────────────────────────────────────────
// 开源集市资源（Task 21）
// ─────────────────────────────────────────────────────────────

/** 资源类型 */
export type MarketplaceResourceType =
    | 'prompt-recipe'
    | 'level-blueprint'
    | 'narrative-script'
    | 'lesson-template'

/** 资源实体（与 marketplace_resources 表对齐） */
export interface MarketplaceResourceEntity {
    id: string
    title: string
    description: string | null
    type: MarketplaceResourceType
    /** 资源正文（Markdown 或 JSON 字符串） */
    content: string
    /** 自动打标：主题/标签数组 */
    tags: string[]
    /** 适用年级 */
    gradeLevel: string | null
    /** 六阶权重（与 BloomWeights 对齐） */
    bloomWeights: BloomWeights | null
    /** 所用模型列表（如 deepseek-v4-pro / mimo-v2.5） */
    modelsUsed: string[]
    /** 作者 ID */
    authorId: string | null
    /** 作者展示名 */
    authorName: string | null
    /** 被复刻次数 */
    forkCount: number
    /** 反馈平均分（0-5） */
    feedbackScore: number
    /** 反馈条数 */
    feedbackCount: number
    createdAt: number
    updatedAt: number
}

export type CreateMarketplaceResourceInput = Omit<
    MarketplaceResourceEntity,
    'id' | 'createdAt' | 'updatedAt' | 'forkCount' | 'feedbackScore' | 'feedbackCount' | 'tags' | 'modelsUsed' | 'bloomWeights' | 'description' | 'gradeLevel' | 'authorId' | 'authorName'
> & {
    description?: string | null
    tags?: string[]
    gradeLevel?: string | null
    bloomWeights?: BloomWeights | null
    modelsUsed?: string[]
    authorId?: string | null
    authorName?: string | null
    forkCount?: number
    feedbackScore?: number
    feedbackCount?: number
} & OptionalId

/** 复刻记录实体 */
export interface MarketplaceForkRecordEntity {
    id: string
    resourceId: string
    sourceAuthor: string | null
    targetClassId: string | null
    targetTeacher: string | null
    /** 适配元信息（如调整后的难度权重、班级 mastery 摘要） */
    adaptationMeta: Record<string, unknown> | null
    forkedAt: number
    createdAt: number
    updatedAt: number
}

export type CreateMarketplaceForkRecordInput = Omit<
    MarketplaceForkRecordEntity,
    'id' | 'createdAt' | 'updatedAt' | 'adaptationMeta' | 'sourceAuthor' | 'targetClassId' | 'targetTeacher'
> & {
    sourceAuthor?: string | null
    targetClassId?: string | null
    targetTeacher?: string | null
    adaptationMeta?: Record<string, unknown> | null
} & OptionalId

/** 反馈实体 */
export interface MarketplaceFeedbackEntity {
    id: string
    resourceId: string
    raterId: string | null
    raterName: string | null
    /** 评分 0-5 */
    score: number
    comment: string | null
    createdAt: number
    updatedAt: number
}

export type CreateMarketplaceFeedbackInput = Omit<
    MarketplaceFeedbackEntity,
    'id' | 'createdAt' | 'updatedAt' | 'raterId' | 'raterName' | 'comment'
> & {
    raterId?: string | null
    raterName?: string | null
    comment?: string | null
} & OptionalId

// ─────────────────────────────────────────────────────────────
// 思考链（Thinking Palace 用）
// ─────────────────────────────────────────────────────────────

/** 思考节点类型 —— 对应 DeepSeek reasoning_content 中的推理步骤分类 */
export type ThinkingNodeType = 'hypothesis' | 'reasoning' | 'evidence' | 'question' | 'conclusion'

/** 思考模式 —— 与 deepseek-client.ts ThinkingMode 对齐 */
export type ThinkingMode = 'low' | 'medium' | 'high' | 'max'

/** 单个思考节点（思考链中的一步） */
export interface ThinkingNode {
    /** 节点序号（从 0 开始） */
    index: number
    /** 节点类型 */
    type: ThinkingNodeType
    /** 节点内容（推理文本片段） */
    content: string
    /** 节点起始字符偏移（在完整 reasoning 中） */
    startOffset: number
    /** 节点结束字符偏移 */
    endOffset: number
    /** 推理耗时（ms，可选） */
    durationMs?: number
}

/** 思考链实体（一次完整的推理过程） */
export interface ThinkingChainEntity {
    id: string
    /** 关联的 Agent id */
    agentId: string
    /** 关联的会话 id（copilot sessionId 或 orchestrator sessionId） */
    sessionId: string
    /** 用户提问/触发文本（截断到 500 字符） */
    question: string
    /** 完整推理内容（reasoning_content 拼接） */
    reasoning: string
    /** 最终回答内容（content 拼接，可选） */
    answer: string | null
    /** 拆分后的思考节点数组（JSON 解析后） */
    nodes: ThinkingNode[]
    /** 思考模式 */
    thinkingMode: ThinkingMode
    /** 推理总耗时（ms） */
    durationMs: number
    /** 使用的模型 */
    model: string
    /** Token 用量（prompt + completion） */
    promptTokens: number
    completionTokens: number
    /** 创建时间 */
    createdAt: number
    /** 元数据（附加标签、来源等） */
    metadata: Record<string, unknown> | null
}

export type CreateThinkingChainInput = Omit<
    ThinkingChainEntity,
    'id' | 'answer' | 'nodes' | 'durationMs' | 'promptTokens' | 'completionTokens' | 'createdAt' | 'metadata'
> & {
    answer?: string | null
    nodes?: ThinkingNode[]
    durationMs?: number
    promptTokens?: number
    completionTokens?: number
    createdAt?: number
    metadata?: Record<string, unknown> | null
} & OptionalId
