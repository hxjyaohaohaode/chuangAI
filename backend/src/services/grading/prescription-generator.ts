/**
 * 个性化处方服务（批改诊断深化能力 5/5）
 *
 * 职责：基于学生诊断全量数据（六阶掌握度 + 错题归因 + 知识漏洞 + 学习路径），
 * 生成完整个性化学习处方，包含画像、优势、劣势、建议、推荐、活动、SMART 目标。
 *
 * 模型：deepseek-v4-pro（thinking: max，最高思考强度）+ JSON Output + 流式输出
 *
 * 设计要点：
 * - 经显式模型托管网关调用，保留 v4-pro/max 并统一限流、usage 与中止
 * - JSON Output 确保结构化输出，Zod 校验保证类型完整
 * - 双模式：generate() 一次性返回完整处方；generateStream() 流式输出（SSE）
 * - 处方融合多维数据：六阶雷达 + 错题归因 + 路径节点 + 画像元数据
 * - SMART 目标：Specific / Measurable / Achievable / Relevant / Time-bound
 * - 教师可编辑：输出为模块化结构，教师可调整建议与活动
 *
 * 与现有 prescription/:patternId 的区别：
 * - prescription/:patternId 返回暗物质模式详情（DarkMatter 类型，单一模式）
 * - prescription-generator 返回完整个性化处方（多模块组合，面向学生个体）
 */

import { z } from 'zod'
import { managedLLM } from '../../llm/index.js'
import type { ChatMessage } from '../../llm/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 处方输入：学生诊断全量数据 */
export interface PrescriptionInput {
    /** 学生 ID */
    studentId: string
    /** 学生脱敏名 */
    anonymousName: string
    /** 年级 */
    grade: string
    /** 六阶掌握度雷达（所有诗的六阶均值） */
    bloomRadar: Record<string, number>
    /** 知识漏洞列表 */
    gaps: Array<{
        poemId: string
        poemTitle: string
        bloomLevel: string
        severity: number
        description: string
    }>
    /** 错题归因摘要（可选） */
    errorAttributions?: Array<{
        questionId: string
        primaryErrorType: string
        primaryErrorLabel: string
        severity: number
        rootCause: string
    }>
    /** 学习路径节点（可选，来自 computeLearningPath 或 AI 路径生成器） */
    learningPath?: Array<{
        poemId: string
        title: string
        poet: string
        currentMastery: number
        reason: string
    }>
    /** 教师意图（可选，如"为期中考试做准备""强化赏析能力"） */
    teacherIntent?: string
}

/** 学生画像模块 */
export interface StudentPortrait {
    /** 一句话画像（30-60 字，概括学生整体特征） */
    summary: string
    /** 认知风格标签（如"视觉型""细节敏感""创造力突出"） */
    cognitiveStyle: string
    /** 学习节奏建议（slow/medium/fast） */
    recommendedPace: 'slow' | 'medium' | 'fast'
    /** 当前阶段定位（如"记忆层已巩固，理解层待突破"） */
    currentStage: string
}

/** 优势项 */
export interface StrengthItem {
    /** 优势描述 */
    description: string
    /** 关联布鲁姆层级 */
    bloomLevel?: string
    /** 支撑证据（如"《静夜思》记忆层得分 92"） */
    evidence: string
}

/** 劣势项 */
export interface WeaknessItem {
    /** 劣势描述 */
    description: string
    /** 关联布鲁姆层级 */
    bloomLevel?: string
    /** 严重度 0-100 */
    severity: number
    /** 根因分析 */
    rootCause: string
}

/** 教学建议项 */
export interface SuggestionItem {
    /** 建议标题（简短） */
    title: string
    /** 建议详细描述 */
    description: string
    /** 建议类别 */
    category: 'reinforce' | 'extend' | 'remediate' | 'enrich' | 'pace'
    /** 优先级 */
    priority: 'high' | 'medium' | 'low'
    /** 关联诗 ID（可选） */
    poemId?: string
    /** 关联布鲁姆层级（可选） */
    bloomLevel?: string
}

/** 资源推荐项 */
export interface RecommendationItem {
    /** 推荐标题 */
    title: string
    /** 推荐类型 */
    type: 'poem' | 'lesson' | 'exercise' | 'material' | 'activity'
    /** 推荐理由 */
    reason: string
    /** 关联诗 ID（可选） */
    poemId?: string
    /** 预估时长（分钟） */
    estimatedMinutes: number
}

/** 学习活动项 */
export interface ActivityItem {
    /** 活动标题 */
    title: string
    /** 活动类型 */
    type: 'recite' | 'translate' | 'analyze' | 'compare' | 'create' | 'discuss' | 'practice' | 'game'
    /** 活动描述（具体可执行步骤） */
    description: string
    /** 活动步骤（分步骤说明） */
    steps: string[]
    /** 预估时长（分钟） */
    estimatedMinutes: number
    /** 关联诗 ID（可选） */
    poemId?: string
    /** 关联布鲁姆层级（可选） */
    bloomLevel?: string
}

/** SMART 目标项 */
export interface SmartGoal {
    /** 目标标题 */
    title: string
    /** Specific：具体描述 */
    specific: string
    /** Measurable：可衡量指标 */
    measurable: string
    /** Achievable：可实现性说明 */
    achievable: string
    /** Relevant：与学情相关性 */
    relevant: string
    /** Time-bound：时间期限（如"两周内"） */
    timeBound: string
    /** 验收方式 */
    verification: string
}

/** 个性化处方输出 */
export interface PrescriptionOutput {
    /** 学生 ID */
    studentId: string
    /** 学生脱敏名 */
    anonymousName: string
    /** 处方生成时间戳 */
    generatedAt: number
    /** 模块 1：学生画像 */
    portrait: StudentPortrait
    /** 模块 2：优势列表（2-5 项） */
    strengths: StrengthItem[]
    /** 模块 3：劣势列表（2-5 项） */
    weaknesses: WeaknessItem[]
    /** 模块 4：教学建议（3-6 项） */
    suggestions: SuggestionItem[]
    /** 模块 5：资源推荐（3-6 项） */
    recommendations: RecommendationItem[]
    /** 模块 6：学习活动（3-5 项） */
    activities: ActivityItem[]
    /** 模块 7：SMART 目标（2-4 个） */
    smartGoals: SmartGoal[]
    /** 处方总体说明（100-200 字，综合阐述处方设计思路） */
    overallRationale: string
    /** 是否由 AI 深度生成；快速数据处方为 false */
    aiGenerated: boolean
    /** 处方置信度 0-1 */
    confidence: number
}

// ─────────────────────────────────────────────────────────────
// Zod 校验 schema
// ─────────────────────────────────────────────────────────────

const portraitSchema = z.object({
    summary: z.string().min(20).max(100),
    cognitiveStyle: z.string(),
    recommendedPace: z.enum(['slow', 'medium', 'fast']),
    currentStage: z.string(),
})

const strengthSchema = z.object({
    description: z.string(),
    bloomLevel: z.string().optional(),
    evidence: z.string(),
})

const weaknessSchema = z.object({
    description: z.string(),
    bloomLevel: z.string().optional(),
    severity: z.number().min(0).max(100),
    rootCause: z.string(),
})

const suggestionSchema = z.object({
    title: z.string(),
    description: z.string(),
    category: z.enum(['reinforce', 'extend', 'remediate', 'enrich', 'pace']),
    priority: z.enum(['high', 'medium', 'low']),
    poemId: z.string().optional(),
    bloomLevel: z.string().optional(),
})

const recommendationSchema = z.object({
    title: z.string(),
    type: z.enum(['poem', 'lesson', 'exercise', 'material', 'activity']),
    reason: z.string(),
    poemId: z.string().optional(),
    estimatedMinutes: z.number().int().min(5).max(120),
})

const activitySchema = z.object({
    title: z.string(),
    type: z.enum(['recite', 'translate', 'analyze', 'compare', 'create', 'discuss', 'practice', 'game']),
    description: z.string(),
    steps: z.array(z.string()).min(2).max(8),
    estimatedMinutes: z.number().int().min(5).max(60),
    poemId: z.string().optional(),
    bloomLevel: z.string().optional(),
})

const smartGoalSchema = z.object({
    title: z.string(),
    specific: z.string(),
    measurable: z.string(),
    achievable: z.string(),
    relevant: z.string(),
    timeBound: z.string(),
    verification: z.string(),
})

const prescriptionOutputSchema = z.object({
    studentId: z.string(),
    anonymousName: z.string(),
    generatedAt: z.number(),
    portrait: portraitSchema,
    strengths: z.array(strengthSchema).min(2).max(5),
    weaknesses: z.array(weaknessSchema).min(2).max(5),
    suggestions: z.array(suggestionSchema).min(3).max(6),
    recommendations: z.array(recommendationSchema).min(3).max(6),
    activities: z.array(activitySchema).min(3).max(5),
    smartGoals: z.array(smartGoalSchema).min(2).max(4),
    overallRationale: z.string().min(100).max(400),
    aiGenerated: z.boolean(),
    confidence: z.number().min(0).max(1),
})

// ─────────────────────────────────────────────────────────────
// PrescriptionGenerator 服务
// ─────────────────────────────────────────────────────────────

/**
 * 个性化处方生成服务
 *
 * 使用 deepseek-v4-pro + max 思考模式（最高推理强度），生成完整个性化处方。
 * 单例模式，全局共享。
 */
export class PrescriptionGenerator {
    private static instance: PrescriptionGenerator | null = null

    static getInstance(): PrescriptionGenerator {
        if (!PrescriptionGenerator.instance) {
            PrescriptionGenerator.instance = new PrescriptionGenerator()
        }
        return PrescriptionGenerator.instance
    }

    /**
     * 生成个性化处方（非流式）
     *
     * @param input 处方输入（学生诊断全量数据）
     * @returns 完整个性化处方（7 大模块）
     */
    async generate(input: PrescriptionInput): Promise<PrescriptionOutput> {
        const messages = this.buildMessages(input)

        const result = await managedLLM.chat({
            model: 'deepseek-v4-pro',
            thinking: 'max',
            jsonOutput: true,
            temperature: 0.4,
            maxTokens: 12288,
            messages,
            metadata: {
                agent: 'prescription-generator',
                task: 'generate-prescription',
                sessionId: `student-${input.studentId}`,
            },
        })

        return this.parseAndValidate(result.content, input.studentId, input.anonymousName)
    }

    /**
     * 流式生成个性化处方（SSE）
     *
     * @param input 处方输入
     * @param signal 可选的客户端取消信号，断连时中止上游模型请求
     * @returns AsyncGenerator，逐分片产出处方文本
     */
    async *generateStream(input: PrescriptionInput, signal?: AbortSignal): AsyncGenerator<string> {
        const messages = this.buildMessages(input)

        const stream = managedLLM.stream({
            model: 'deepseek-v4-pro',
            thinking: 'max',
            temperature: 0.4,
            maxTokens: 12288,
            messages,
            signal,
            metadata: {
                agent: 'prescription-generator',
                task: 'generate-prescription-stream',
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
    private buildMessages(input: PrescriptionInput): ChatMessage[] {
        const systemPrompt = this.buildSystemPrompt()
        const userPrompt = this.buildUserPrompt(input)
        return [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ]
    }

    /** 构建 system prompt */
    private buildSystemPrompt(): string {
        return `你是古诗词教学的个性化处方设计专家，精通因材施教理论与 SMART 目标管理法。

## 你的职责
基于学生诊断全量数据（六阶掌握度 + 错题归因 + 知识漏洞 + 学习路径），生成完整个性化处方，包含 7 大模块：
1. 学生画像（一句话概括 + 认知风格 + 学习节奏 + 当前阶段）
2. 优势列表（2-5 项，含证据支撑）
3. 劣势列表（2-5 项，含根因分析）
4. 教学建议（3-6 项，分类 + 优先级）
5. 资源推荐（3-6 项，含时长）
6. 学习活动（3-5 项，含分步说明）
7. SMART 目标（2-4 个，符合 SMART 原则）

## 处方设计原则
- 因材施教：根据认知风格与学习节奏调整建议
- 数据驱动：每条建议须关联六阶数据或错题归因
- 可执行性：活动须分步骤说明，目标须可衡量可验收
- 螺旋上升：建议从薄弱层切入，逐步过渡到高阶
- 多元化：活动类型多样（背诵/翻译/赏析/对比/仿写/讨论/游戏）
- SMART 目标：每个目标须满足 Specific/Measurable/Achievable/Relevant/Time-bound

## 模块详细要求

### 画像（portrait）
- summary：30-60 字，概括学生整体特征（如"该生记忆层扎实，理解层待突破，创造力突出但表达需规范"）
- cognitiveStyle：从"视觉型/听觉型/动觉型/混合型"中选择，并补充特征描述
- recommendedPace：根据掌握度均值判断（>70 fast，40-70 medium，<40 slow）
- currentStage：定位当前认知阶段（如"记忆层已巩固，理解层待突破"）

### 优势（strengths）
- 必须基于 bloomRadar 中得分 ≥ 70 的层级
- evidence 须引用具体数据（如"《静夜思》记忆层得分 92"）

### 劣势（weaknesses）
- 必须基于 bloomRadar 中得分 < 60 的层级或 gaps 列表
- rootCause 须具体（如"对'月'意象的思乡象征理解不深"），不可泛泛
- severity：60-100（与 bloomRadar 缺口成正比）

### 建议（suggestions）
- category：reinforce（巩固）/ extend（拓展）/ remediate（补漏）/ enrich（ enrichment）/ pace（节奏）
- 优先级：薄弱层补漏为 high，拓展为 medium，节奏调整为 low

### 推荐（recommendations）
- type：poem（诗）/ lesson（课程）/ exercise（练习）/ material（素材）/ activity（活动）
- 优先推荐与薄弱诗有图谱关联的资源
- estimatedMinutes 须合理（5-120 分钟）

### 活动（activities）
- steps 须分 2-8 步说明
- 每步可执行（如"朗读《静夜思》三遍"而非"多读")
- activityType 多样化，不可全部为 practice

### SMART 目标（smartGoals）
- specific：具体描述目标（如"掌握《静夜思》的理解层赏析"）
- measurable：可衡量指标（如"完成 3 道赏析题，正确率 ≥ 80%"）
- achievable：可实现性说明（如"基于当前记忆层 92 分的基础"）
- relevant：与学情相关性（如"补齐理解层短板"）
- timeBound：时间期限（如"两周内"）
- verification：验收方式（如"教师出题检验 + AI 路径推荐复核"）

## 输出格式（严格 JSON）
{
  "studentId": "学生ID",
  "anonymousName": "脱敏名",
  "generatedAt": 1700000000000,
  "portrait": {
    "summary": "该生记忆层扎实，理解层待突破...",
    "cognitiveStyle": "视觉型，对意象画面敏感",
    "recommendedPace": "medium",
    "currentStage": "记忆层已巩固，理解层待突破"
  },
  "strengths": [
    {"description": "记忆层掌握扎实", "bloomLevel": "记忆", "evidence": "六阶均值记忆层 88 分"}
  ],
  "weaknesses": [
    {"description": "理解层薄弱", "bloomLevel": "理解", "severity": 65, "rootCause": "对意象象征理解不深"}
  ],
  "suggestions": [
    {"title": "强化意象理解", "description": "通过对比赏析...", "category": "remediate", "priority": "high", "bloomLevel": "理解"}
  ],
  "recommendations": [
    {"title": "《望月怀远》对比阅读", "type": "poem", "reason": "同意象关联", "estimatedMinutes": 20}
  ],
  "activities": [
    {"title": "意象对比赏析", "type": "compare", "description": "对比《静夜思》与《望月怀远》的月意象", "steps": ["朗读两诗", "标注月意象句子", "对比情感异同"], "estimatedMinutes": 25, "bloomLevel": "理解"}
  ],
  "smartGoals": [
    {"title": "突破理解层赏析", "specific": "掌握《静夜思》的理解层赏析", "measurable": "完成 3 道赏析题正确率≥80%", "achievable": "基于记忆层 88 分基础", "relevant": "补齐理解层短板", "timeBound": "两周内", "verification": "教师出题检验"}
  ],
  "overallRationale": "本处方针对该生理解层薄弱的核心问题，从巩固记忆层基础切入，通过对比赏析活动...",
  "aiGenerated": true,
  "confidence": 0.85
}`
    }

    /** 构建 user prompt */
    private buildUserPrompt(input: PrescriptionInput): string {
        const radarStr = JSON.stringify(input.bloomRadar, null, 2)
        const gapsStr = input.gaps.length > 0
            ? JSON.stringify(input.gaps, null, 2)
            : '（知识漏洞数据未提供）'
        const errorStr = input.errorAttributions && input.errorAttributions.length > 0
            ? JSON.stringify(input.errorAttributions, null, 2)
            : '（错题归因数据未提供）'
        const pathStr = input.learningPath && input.learningPath.length > 0
            ? JSON.stringify(input.learningPath, null, 2)
            : '（学习路径数据未提供）'
        const teacherIntent = input.teacherIntent ?? '（无特殊教师意图）'

        return `请为以下学生生成个性化学习处方。

<student>
${input.anonymousName}（ID: ${input.studentId}，年级: ${input.grade}）
</student>

<bloom_radar>
${radarStr}
</bloom_radar>

<knowledge_gaps>
${gapsStr}
</knowledge_gaps>

<error_attributions>
${errorStr}
</error_attributions>

<learning_path>
${pathStr}
</learning_path>

<teacher_intent>
${teacherIntent}
</teacher_intent>

请输出严格 JSON，包含 portrait / strengths / weaknesses / suggestions / recommendations / activities / smartGoals 七大模块，overallRationale 须 100-200 字综合阐述处方设计思路。`
    }

    /** 解析与校验 LLM 输出 */
    private parseAndValidate(
        raw: string,
        studentId: string,
        anonymousName: string,
    ): PrescriptionOutput {
        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch {
            throw new Error(`个性化处方输出 JSON 解析失败: ${raw.slice(0, 200)}`)
        }

        const result = prescriptionOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(
                `个性化处方输出校验失败: ${result.error.issues
                    .map((i) => `${i.path.join('.')}: ${i.message}`)
                    .join('; ')}`,
            )
        }

        // 强制 studentId / anonymousName 与输入一致
        result.data.studentId = studentId
        result.data.anonymousName = anonymousName
        result.data.generatedAt = Date.now()

        return result.data
    }

    /** 降级输出（LLM 失败时） */
    fallback(input: PrescriptionInput, err?: unknown): PrescriptionOutput {

        // 基于 bloomRadar 推导简易画像
        const radarValues = Object.values(input.bloomRadar)
        const avgScore = radarValues.length > 0
            ? radarValues.reduce((a, b) => a + b, 0) / radarValues.length
            : 0
        const recommendedPace: 'slow' | 'medium' | 'fast' = avgScore >= 70 ? 'fast' : avgScore >= 40 ? 'medium' : 'slow'

        // 找出薄弱层级作为劣势
        const weakLevels = Object.entries(input.bloomRadar)
            .filter(([, v]) => v < 60)
            .sort((a, b) => a[1] - b[1])

        const weaknesses: WeaknessItem[] = weakLevels.length > 0
            ? weakLevels.slice(0, 3).map(([level, score]) => ({
                description: `${level}层掌握度不足`,
                bloomLevel: level,
                severity: Math.round(100 - score),
                rootCause: `该层级掌握度仅 ${score} 分，低于 60 分阈值`,
            }))
            : [{
                description: '整体掌握度待提升',
                severity: 50,
                rootCause: '六阶均值偏低，需综合强化',
            }]

        // 找出优势层级
        const strongLevels = Object.entries(input.bloomRadar)
            .filter(([, v]) => v >= 70)
            .sort((a, b) => b[1] - a[1])

        const strengths: StrengthItem[] = strongLevels.length > 0
            ? strongLevels.slice(0, 3).map(([level, score]) => ({
                description: `${level}层掌握扎实`,
                bloomLevel: level,
                evidence: `六阶${level}层 ${score} 分`,
            }))
            : [{
                description: '学习态度积极',
                evidence: '持续参与学习',
            }]

        const weakestLevel = weakLevels[0]?.[0]
            ?? Object.entries(input.bloomRadar).sort((a, b) => a[1] - b[1])[0]?.[0]
            ?? '理解'
        const strongestLevel = strongLevels[0]?.[0]
            ?? Object.entries(input.bloomRadar).sort((a, b) => b[1] - a[1])[0]?.[0]
            ?? '记忆'
        const focusPoem = input.learningPath?.[0]
        const sourceNote = err
            ? 'AI 深度生成暂时不可用，当前内容已由真实学情数据即时生成。'
            : '当前为真实学情数据即时生成的基础处方，可继续使用 AI 深度生成获得更细化方案。'

        const recommendations: RecommendationItem[] = (input.learningPath ?? []).slice(0, 3).map((node) => ({
            title: `复习《${node.title}》`,
            type: 'poem',
            reason: node.reason,
            poemId: node.poemId,
            estimatedMinutes: 15,
        }))
        const fallbackRecommendations: RecommendationItem[] = [
            {
                title: `${weakestLevel}层专项练习`,
                type: 'exercise',
                reason: `当前最需要优先巩固${weakestLevel}层能力`,
                estimatedMinutes: 15,
            },
            {
                title: '诗歌意象对比卡',
                type: 'material',
                reason: '通过对照同类意象建立稳定的理解线索',
                estimatedMinutes: 10,
            },
            {
                title: '口头讲诗活动',
                type: 'activity',
                reason: '用自己的话讲解能同时检验理解与表达',
                estimatedMinutes: 10,
            },
        ]
        while (recommendations.length < 3) {
            const index = recommendations.length
            const fallback = fallbackRecommendations[index]
            if (!fallback) break
            recommendations.push(fallback)
        }

        const weakestLabel = weakLevels[0]?.[0]

        return {
            studentId: input.studentId,
            anonymousName: input.anonymousName,
            generatedAt: Date.now(),
            portrait: {
                summary: `该生六阶均值 ${avgScore.toFixed(0)} 分，${weakestLabel ? `${weakestLabel}层待突破` : '整体待提升'}。`,
                cognitiveStyle: '混合型',
                recommendedPace,
                currentStage: avgScore >= 70 ? '高阶可拓展' : avgScore >= 40 ? '中阶需巩固' : '基础待夯实',
            },
            strengths,
            weaknesses,
            suggestions: [{
                title: `优先突破${weakestLevel}层`,
                description: `围绕${focusPoem ? `《${focusPoem.title}》` : '当前薄弱诗篇'}安排一次“示范—点选—口述—即时反馈”的短练习。`,
                category: 'remediate',
                priority: 'high',
                bloomLevel: weakestLevel,
                poemId: focusPoem?.poemId,
            }, {
                title: `用${strongestLevel}优势带动迁移`,
                description: `先调用学生已有的${strongestLevel}层优势，再逐步过渡到${weakestLevel}层任务。`,
                category: 'reinforce',
                priority: 'medium',
                bloomLevel: strongestLevel,
            }, {
                title: '控制单次任务负荷',
                description: `按${recommendedPace === 'fast' ? '15' : recommendedPace === 'medium' ? '10' : '8'}分钟一个学习单元推进，每个单元只设一个可观察目标。`,
                category: 'pace',
                priority: 'low',
            }],
            recommendations,
            activities: [{
                title: '薄弱层点选诊断',
                type: 'practice',
                description: `用三道点选题快速确认${weakestLevel}层的具体障碍。`,
                steps: ['完成三道点选题', '查看即时反馈', '口述一条判断依据'],
                estimatedMinutes: 8,
                bloomLevel: weakestLevel,
            }, {
                title: '同主题对比讲解',
                type: 'compare',
                description: '选择两首相关诗篇，对比意象、情感和表达方式。',
                steps: ['圈选相同意象', '点选情感差异', '用一句话说明理由'],
                estimatedMinutes: 12,
            }, {
                title: '一分钟讲诗',
                type: 'discuss',
                description: '让学生用自己的话完成一次短讲，教师按证据反馈。',
                steps: ['选择一句最有画面感的诗句', '口述画面和情感', '根据反馈再讲一次'],
                estimatedMinutes: 8,
                poemId: focusPoem?.poemId,
            }],
            smartGoals: [{
                title: `${weakestLevel}层短期突破`,
                specific: `完成${weakestLevel}层专项练习`,
                measurable: '连续两次练习正确率达到 80%',
                achievable: `基于当前六阶均值 ${avgScore.toFixed(0)} 分设置`,
                relevant: `直接补齐${weakestLevel}层短板`,
                timeBound: '7 天内',
                verification: '课堂作答记录与诊断雷达复核',
            }, {
                title: '形成可表达的理解',
                specific: '独立口述一首诗的画面、情感和依据',
                measurable: '三项要点至少完成两项且依据准确',
                achievable: `可借助${strongestLevel}层优势完成`,
                relevant: '把已有掌握转化为高阶表达',
                timeBound: '两周内',
                verification: '教师观察量表与语音记录复核',
            }],
            overallRationale: `${sourceNote}处方以六阶雷达、知识漏洞与学习路径为证据，先处理${weakestLevel}层短板，再借助${strongestLevel}层优势完成迁移；活动均控制在短时、可点选、可口述、可复核的范围内，避免把未采集到的数据补成结论。`,
            aiGenerated: false,
            confidence: Math.min(0.82, 0.45 + Math.min(0.25, input.gaps.length * 0.02) + Math.min(0.12, radarValues.length * 0.02)),
        }
    }
}

/** 全局单例 */
export const prescriptionGenerator = PrescriptionGenerator.getInstance()
