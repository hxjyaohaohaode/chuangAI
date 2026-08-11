/**
 * 学习路径生成服务（批改诊断深化能力 4/5）
 *
 * 职责：基于学生诊断数据（六阶掌握度 + 错题归因 + 知识漏洞），
 * 生成完整的学习路径，包含起点测试、薄弱点识别、学习序列、检查点。
 *
 * 模型：deepseek-v4-pro（thinking: high）+ JSON Output
 *
 * 与现有 computeLearningPath 的区别：
 * - computeLearningPath 基于规则（SQL 聚合 + 图谱关联），输出 LearningPathNode[]
 * - learning-path-generator 基于 AI 深度推理，输出完整学习路径（起点测试 + 序列 + 检查点）
 * - AI 路径考虑认知递进、活动多样性、时间分配、里程碑验收
 * - AI 路径可结合错题归因结果，针对性补漏
 *
 * 设计要点：
 * - 起点测试：路径开始前快速诊断学生当前水平（3-5 题）
 * - 薄弱点识别：基于 mastery 数据 + 错题归因，精确定位
 * - 学习序列：螺旋上升，从低认知层到高认知层
 * - 检查点：每 2-3 步设置里程碑，验收学习效果
 */

import { z } from 'zod'
import { managedLLM } from '../../llm/index.js'
import type { ChatMessage } from '../../llm/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 学习路径节点状态 */
export type PathNodeStatus = 'completed' | 'in-progress' | 'pending' | 'locked'

/** 学习路径输入 */
export interface LearningPathInput {
    /** 学生 ID */
    studentId: string
    /** 学生脱敏名 */
    anonymousName: string
    /** 六阶掌握度雷达（所有诗的六阶均值） */
    bloomRadar: Record<string, number>
    /** 薄弱诗篇列表（score < 60） */
    weakPoems: Array<{
        poemId: string
        title: string
        poet: string
        dynasty: string
        difficulty: number
        weakBloomLevels: string[]
        currentMastery: number
    }>
    /** 错题归因摘要（可选） */
    errorAttributions?: Array<{
        questionId: string
        primaryErrorType: string
        rootCause: string
    }>
    /** 知识图谱候选节点（可选，从图谱查询的关联诗） */
    graphCandidates?: Array<{
        poemId: string
        title: string
        poet: string
        dynasty: string
        difficulty: number
        relationType?: string
        strength?: number
    }>
    /** 教师意图（可选） */
    teacherIntent?: string
}

/** 起点测试题 */
export interface DiagnosticTest {
    /** 测试题 ID（前端可按序生成） */
    id: string
    /** 关联诗 ID */
    poemId: string
    /** 布鲁姆认知层级 */
    bloomLevel: string
    /** 题型 */
    type: 'choice' | 'fill' | 'short-answer'
    /** 题干 */
    stem: string
    /** 预估答题时长（秒） */
    estimatedTimeSec: number
}

/** 学习路径节点 */
export interface LearningPathStep {
    /** 步骤序号（从 1 开始） */
    step: number
    /** 关联诗 ID */
    poemId: string
    /** 诗标题 */
    title: string
    /** 诗人 */
    poet: string
    /** 朝代 */
    dynasty: string
    /** 难度 1-5 */
    difficulty: number
    /** 布鲁姆认知层级 */
    bloomLevel: string
    /** 学习活动描述（具体可执行） */
    activity: string
    /** 活动类型 */
    activityType: 'recite' | 'translate' | 'analyze' | 'compare' | 'create' | 'discuss' | 'practice'
    /** 预估时长（分钟） */
    estimatedMinutes: number
    /** 推荐理由（关联薄弱点或错题归因） */
    rationale: string
    /** 当前掌握度 0-100 */
    currentMastery: number
    /** 节点状态 */
    status: PathNodeStatus
    /** 关联的薄弱诗 ID（如有） */
    relatedWeakPoemId?: string
    /** 关联类型（如有） */
    relationType?: string
}

/** 检查点 */
export interface Checkpoint {
    /** 检查点序号 */
    order: number
    /** 在第几步之后 */
    afterStep: number
    /** 检查点标题 */
    title: string
    /** 验收方式描述 */
    assessment: string
    /** 通过标准 */
    passingCriteria: string
    /** 未通过时的调整建议 */
    fallbackAction: string
}

/** 学习路径输出 */
export interface LearningPathOutput {
    /** 学生 ID */
    studentId: string
    /** 学生脱敏名 */
    anonymousName: string
    /** 起点测试题（3-5 题） */
    diagnosticTests: DiagnosticTest[]
    /** 薄弱点识别（基于 mastery + 归因） */
    identifiedWeaknesses: Array<{
        bloomLevel: string
        description: string
        severity: number
        relatedPoemIds: string[]
    }>
    /** 学习序列（5-10 步） */
    path: LearningPathStep[]
    /** 检查点（2-4 个） */
    checkpoints: Checkpoint[]
    /** 总预估时长（分钟） */
    totalEstimatedMinutes: number
    /** 路径设计说明（100-200 字） */
    designRationale: string
    /** AI 生成标记 */
    aiGenerated: true
    /** 生成时间戳 */
    generatedAt: number
}

// ─────────────────────────────────────────────────────────────
// Zod 校验 schema
// ─────────────────────────────────────────────────────────────

const diagnosticTestSchema = z.object({
    id: z.string(),
    poemId: z.string(),
    bloomLevel: z.string(),
    type: z.enum(['choice', 'fill', 'short-answer']),
    stem: z.string(),
    estimatedTimeSec: z.number().int().min(30).max(300),
})

const pathStepSchema = z.object({
    step: z.number().int().min(1),
    poemId: z.string(),
    title: z.string(),
    poet: z.string(),
    dynasty: z.string(),
    difficulty: z.number().min(1).max(5),
    bloomLevel: z.string(),
    activity: z.string(),
    activityType: z.enum(['recite', 'translate', 'analyze', 'compare', 'create', 'discuss', 'practice']),
    estimatedMinutes: z.number().int().min(5).max(45),
    rationale: z.string(),
    currentMastery: z.number().min(0).max(100),
    status: z.enum(['completed', 'in-progress', 'pending', 'locked']),
    relatedWeakPoemId: z.string().optional(),
    relationType: z.string().optional(),
})

const checkpointSchema = z.object({
    order: z.number().int().min(1),
    afterStep: z.number().int().min(1),
    title: z.string(),
    assessment: z.string(),
    passingCriteria: z.string(),
    fallbackAction: z.string(),
})

const weaknessSchema = z.object({
    bloomLevel: z.string(),
    description: z.string(),
    severity: z.number().min(0).max(100),
    relatedPoemIds: z.array(z.string()),
})

const pathOutputSchema = z.object({
    studentId: z.string(),
    anonymousName: z.string(),
    diagnosticTests: z.array(diagnosticTestSchema).min(3).max(5),
    identifiedWeaknesses: z.array(weaknessSchema).min(1),
    path: z.array(pathStepSchema).min(5).max(10),
    checkpoints: z.array(checkpointSchema).min(2).max(4),
    totalEstimatedMinutes: z.number().int().min(30).max(300),
    designRationale: z.string().min(100).max(400),
    aiGenerated: z.literal(true),
    generatedAt: z.number(),
})

// ─────────────────────────────────────────────────────────────
// LearningPathGenerator 服务
// ─────────────────────────────────────────────────────────────

/**
 * 学习路径生成服务
 *
 * 使用 deepseek-v4-pro + high 思考模式，生成完整学习路径。
 * 单例模式，全局共享。
 */
export class LearningPathGenerator {
    private static instance: LearningPathGenerator | null = null

    static getInstance(): LearningPathGenerator {
        if (!LearningPathGenerator.instance) {
            LearningPathGenerator.instance = new LearningPathGenerator()
        }
        return LearningPathGenerator.instance
    }

    /**
     * 生成个性化学习路径
     *
     * @param input 学习路径输入
     * @returns 完整学习路径（起点测试 + 薄弱点 + 序列 + 检查点）
     */
    async generate(input: LearningPathInput): Promise<LearningPathOutput> {
        const messages = this.buildMessages(input)

        const result = await managedLLM.chat({
            model: 'deepseek-v4-pro',
            thinking: 'high',
            jsonOutput: true,
            temperature: 0.4,
            maxTokens: 8192,
            messages,
            metadata: {
                agent: 'learning-path-generator',
                task: 'generate-learning-path',
                sessionId: `student-${input.studentId}`,
            },
        })

        return this.parseAndValidate(result.content, input.studentId, input.anonymousName)
    }

    /**
     * 流式生成学习路径（SSE）
     *
     * @param input 学习路径输入
     * @param signal 可选的客户端取消信号，断连时中止上游模型请求
     * @returns AsyncGenerator，逐分片产出路径文本
     */
    async *generateStream(input: LearningPathInput, signal?: AbortSignal): AsyncGenerator<string> {
        const messages = this.buildMessages(input)

        const stream = managedLLM.stream({
            model: 'deepseek-v4-pro',
            thinking: 'high',
            temperature: 0.4,
            maxTokens: 8192,
            messages,
            signal,
            metadata: {
                agent: 'learning-path-generator',
                task: 'generate-learning-path-stream',
                sessionId: `student-${input.studentId}`,
            },
        })

        for await (const chunk of stream) {
            if (chunk.content) {
                yield chunk.content
            }
        }
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    /** 构建对话消息 */
    private buildMessages(input: LearningPathInput): ChatMessage[] {
        const systemPrompt = this.buildSystemPrompt()
        const userPrompt = this.buildUserPrompt(input)
        return [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ]
    }

    /** 构建 system prompt */
    private buildSystemPrompt(): string {
        return `你是古诗词学习的个性化路径规划专家，精通布鲁姆认知层级理论与知识图谱驱动的路径推荐。

## 你的职责
基于学生诊断数据（六阶掌握度 + 薄弱诗 + 错题归因），生成完整学习路径：
1. 起点测试（3-5 题，快速诊断当前水平）
2. 薄弱点识别（基于 mastery + 归因，精确定位）
3. 学习序列（5-10 步，螺旋上升）
4. 检查点（2-4 个，里程碑验收）

## 路径设计原则
- 螺旋上升：同一首诗可在不同步骤覆盖不同认知层
- 难度递进：从低认知层（记忆/理解）逐步过渡到高认知层（分析/评价/创造）
- 先补漏后提升：从最薄弱认知层切入，先巩固基础再挑战高阶
- 活动多样：背诵、翻译、赏析、对比、仿写、讨论等多种形式交替
- 时间可控：单次学习 10-30 分钟，总时长 60-180 分钟
- 关联图谱：优先推荐与薄弱诗有图谱关联的诗（同意象/同主题/同修辞）

## 起点测试设计
- 3-5 题，覆盖六阶中的 2-3 个层级
- 题型多样：选择、填空、简答
- 每题预估 1-3 分钟
- 题目须基于学生已学诗篇（从 weakPoems 中选取）

## 检查点设计
- 每 2-3 步设置一个检查点
- 验收方式具体（如"完成 3 道填空题，正确率 ≥ 80%"）
- 通过标准量化
- 未通过时给出调整建议（如"返回第 2 步重新学习"）

## rationale 撰写要求
- 必须关联 identifiedWeaknesses 或 errorAttributions
- 必须说明为何选择该诗词该认知层
- 不可为空话（如"为了提升能力"）

## 输出格式（严格 JSON）
{
  "studentId": "学生ID",
  "anonymousName": "脱敏名",
  "diagnosticTests": [
    {"id": "dt-1", "poemId": "poem-001", "bloomLevel": "记忆", "type": "fill", "stem": "默写《静夜思》前两句", "estimatedTimeSec": 120}
  ],
  "identifiedWeaknesses": [
    {"bloomLevel": "理解", "description": "对'月'意象的思乡象征理解不深", "severity": 65, "relatedPoemIds": ["poem-001"]}
  ],
  "path": [
    {"step": 1, "poemId": "poem-001", "title": "静夜思", "poet": "李白", "dynasty": "唐", "difficulty": 2, "bloomLevel": "记忆", "activity": "朗读并背诵全诗", "activityType": "recite", "estimatedMinutes": 15, "rationale": "巩固基础记忆，为后续理解层铺垫", "currentMastery": 45, "status": "pending"}
  ],
  "checkpoints": [
    {"order": 1, "afterStep": 3, "title": "记忆层验收", "assessment": "默写三首诗的关键句", "passingCriteria": "正确率 ≥ 80%", "fallbackAction": "返回第 1 步重新背诵"}
  ],
  "totalEstimatedMinutes": 120,
  "designRationale": "本路径针对学生在'理解'层的薄弱，从记忆层切入巩固基础，逐步过渡到理解与赏析...",
  "aiGenerated": true,
  "generatedAt": 1700000000000
}`
    }

    /** 构建 user prompt */
    private buildUserPrompt(input: LearningPathInput): string {
        const radarStr = JSON.stringify(input.bloomRadar, null, 2)
        const weakPoemsStr = JSON.stringify(input.weakPoems, null, 2)
        const errorStr = input.errorAttributions && input.errorAttributions.length > 0
            ? JSON.stringify(input.errorAttributions, null, 2)
            : '（错题归因数据未提供）'
        const graphStr = input.graphCandidates && input.graphCandidates.length > 0
            ? JSON.stringify(input.graphCandidates, null, 2)
            : '（图谱候选节点未提供）'
        const teacherIntent = input.teacherIntent ?? '（无特殊教师意图）'

        return `请为以下学生生成个性化学习路径。

<student>
${input.anonymousName}（ID: ${input.studentId}）
</student>

<bloom_radar>
${radarStr}
</bloom_radar>

<weak_poems>
${weakPoemsStr}
</weak_poems>

<error_attributions>
${errorStr}
</error_attributions>

<graph_candidates>
${graphStr}
</graph_candidates>

<teacher_intent>
${teacherIntent}
</teacher_intent>

请输出严格 JSON，path 须 5-10 步，step 从 1 连续递增，status 默认为 "pending"（已掌握度 ≥ 80 的步骤可为 "completed"）。`
    }

    /** 解析与校验 LLM 输出 */
    private parseAndValidate(
        raw: string,
        studentId: string,
        anonymousName: string,
    ): LearningPathOutput {
        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch {
            throw new Error(`学习路径输出 JSON 解析失败: ${raw.slice(0, 200)}`)
        }

        const result = pathOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(
                `学习路径输出校验失败: ${result.error.issues
                    .map((i) => `${i.path.join('.')}: ${i.message}`)
                    .join('; ')}`,
            )
        }

        // 强制 studentId / anonymousName 与输入一致
        result.data.studentId = studentId
        result.data.anonymousName = anonymousName
        result.data.generatedAt = Date.now()

        // 重算总时长
        result.data.totalEstimatedMinutes = result.data.path.reduce(
            (sum, step) => sum + step.estimatedMinutes,
            0,
        )

        // 确保 step 连续递增
        result.data.path = result.data.path.map((step, idx) => ({
            ...step,
            step: idx + 1,
        }))

        return result.data
    }
}

/** 全局单例 */
export const learningPathGenerator = LearningPathGenerator.getInstance()
