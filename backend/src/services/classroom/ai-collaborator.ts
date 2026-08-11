/**
 * AI 协同教学服务（课堂指挥深化 Task 3）
 *
 * 使用 deepseek-v4-pro（high 思考模式）+ SSE 流式输出，提供 4 类协同能力：
 * 1. suggestFeedback 实时反馈：分析学生作答，给出针对性反馈建议
 * 2. supplementBackground 背景补充：补充诗歌创作背景、意象文化内涵
 * 3. generateFollowup 追问生成：基于当前题目生成高阶思维追问
 * 4. detectIntervention 干预建议：检测困难学生并生成干预策略
 *
 * 模型规格（大模型 API 文档）：
 * - deepseek-v4-pro：1M 上下文，384K 输出，500 并发，支持 high 思考模式
 * - base_url: https://api.deepseek.com
 * - 输入 3 元/百万 token（缓存未命中），输出 6 元/百万 token
 *
 * SSE 流式格式：
 * - 每个分片为 JSON: { "delta": "文本增量", "done": false }
 * - 最后一个分片: { "delta": "", "done": true }
 *
 * 降级策略：
 * - DeepSeek 不可用时降级为 deepseek-v4-flash medium 模式
 * - 仍不可用时降级为模板内容（不阻塞课堂）
 */

import { managedLLM } from '../../llm/index.js'
import type { ChatMessage } from '../../llm/types.js'
import type { ClassroomRuntime, StudentResponse } from '../../routes/classroom.js'
import { repos } from '../../db/index.js'
import type { Question } from '../../agents/base/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** AI 建议类别 */
export type AISuggestionCategory = 'feedback' | 'supplement' | 'followup' | 'intervention'

/** AI 建议流式分片 */
export interface AISuggestionStreamChunk {
    /** 文本增量 */
    delta?: string
    /** 是否完成 */
    done?: boolean
    /** 建议类别 */
    category: AISuggestionCategory
}

/** 实时反馈请求 */
export interface FeedbackRequest {
    lessonId: string
    question: Question
    response: StudentResponse
    /** 全班正确率（上下文参考） */
    classAccuracy?: number
}

/** 背景补充请求 */
export interface SupplementRequest {
    lessonId: string
    question: Question
    poemId: string
}

/** 追问生成请求 */
export interface FollowupRequest {
    lessonId: string
    question: Question
    response?: StudentResponse
}

/** 干预建议请求 */
export interface InterventionRequest {
    lessonId: string
    runtime: ClassroomRuntime
}

/** 干预建议结果 */
export interface InterventionResult {
    /** 困难学生列表 */
    strugglingStudents: Array<{
        studentId: string
        studentName: string
        accuracy: number
        suggestion: string
    }>
    /** 全班干预建议 */
    classSuggestion: string
}

// ─────────────────────────────────────────────────────────────
// AI 协同教学服务
// ─────────────────────────────────────────────────────────────

/**
 * 课堂 AI 协同教学引擎
 *
 * 所有方法均使用 deepseek-v4-pro high 思考模式 + SSE 流式输出。
 * 调用失败时降级为 deepseek-v4-flash medium，最终降级为模板内容。
 */
export class AICollaborator {
    /** 主模型：deepseek-v4-pro high 思考模式 */
    private static readonly PRIMARY_MODEL = 'deepseek-v4-pro' as const
    private static readonly PRIMARY_THINKING = 'high' as const

    /** 降级模型：deepseek-v4-flash medium 思考模式 */
    private static readonly FALLBACK_MODEL = 'deepseek-v4-flash' as const
    private static readonly FALLBACK_THINKING = 'medium' as const

    /**
     * 1. 实时反馈：分析学生作答，生成针对性反馈建议
     *
     * 场景：学生提交答案后，AI 分析作答质量，给出教学反馈
     */
    async *suggestFeedback(req: FeedbackRequest, signal?: AbortSignal): AsyncGenerator<AISuggestionStreamChunk> {
        const { question, response, classAccuracy } = req
        const accuracyHint = classAccuracy !== undefined
            ? `全班正确率 ${(classAccuracy * 100).toFixed(0)}%`
            : '全班正确率未知'

        const messages: ChatMessage[] = [
            {
                role: 'system',
                content: `你是古诗教学助手，正在辅助教师进行课堂实时教学。请基于学生作答情况，生成简短、精准、可操作的教学反馈建议。

要求：
- 80-150 字，简洁有力
- 先指出作答亮点或问题，再给出具体教学建议
- 语言亲切，适合教师直接转述给学生
- 避免空泛表扬，聚焦具体知识点`,
            },
            {
                role: 'user',
                content: `题目：${question.stem}
Bloom 层级：${question.bloomLevel}
难度：${question.difficulty}/5
正确答案：${question.answer}
学生答案：${response.answer}
作答结果：${response.correct ? '正确' : '错误'}
${accuracyHint}

请生成教学反馈建议：`,
            },
        ]

        yield* this.streamWithFallback(
            messages,
            'feedback',
            () => this.fallbackFeedback(response, question),
            signal,
        )
    }

    /**
     * 2. 背景补充：补充诗歌创作背景、意象文化内涵
     *
     * 场景：教师讲解诗歌时，AI 自动补充相关背景知识
     */
    async *supplementBackground(req: SupplementRequest, signal?: AbortSignal): AsyncGenerator<AISuggestionStreamChunk> {
        const { question, poemId } = req
        const poem = repos.poems.findById(poemId)

        const messages: ChatMessage[] = [
            {
                role: 'system',
                content: `你是古诗文化解读专家，正在为教师课堂讲解提供背景知识补充。请生成与当前题目相关的诗歌创作背景、意象文化内涵或时代风貌补充。

要求：
- 150-250 字，信息密度高
- 聚焦与题目直接相关的文化背景
- 可直接作为教师讲解素材
- 避免泛泛而谈，提供具体的历史、文化或文学细节`,
            },
            {
                role: 'user',
                content: `诗篇：《${poem?.title ?? ''}》· ${poem?.poet ?? ''}
朝代：${poem?.dynasty ?? ''}
主题：${poem?.theme?.join('、') ?? ''}
意象：${poem?.images?.join('、') ?? ''}
修辞：${poem?.rhetoric?.join('、') ?? ''}

当前题目：${question.stem}
Bloom 层级：${question.bloomLevel}

请生成与该题目相关的背景知识补充：`,
            },
        ]

        yield* this.streamWithFallback(
            messages,
            'supplement',
            () => this.fallbackSupplement(poem?.title ?? '本诗', poem?.poet ?? ''),
            signal,
        )
    }

    /**
     * 3. 追问生成：基于当前题目生成高阶思维追问
     *
     * 场景：学生回答正确后，AI 生成追问以激发高阶思维
     */
    async *generateFollowup(req: FollowupRequest, signal?: AbortSignal): AsyncGenerator<AISuggestionStreamChunk> {
        const { question, response } = req

        const messages: ChatMessage[] = [
            {
                role: 'system',
                content: `你是古诗教学设计专家，正在为课堂生成追问。基于当前题目和学生作答，生成 2-3 个高阶思维追问，引导学生深入思考。

要求：
- 生成 2-3 个追问，每个 20-50 字
- 追问应指向更高 Bloom 层级（分析/评价/创造）
- 追问应激发批判性思维，而非简单回忆
- 格式：每行一个追问，以"追问1:"、"追问2:"开头`,
            },
            {
                role: 'user',
                content: `题目：${question.stem}
Bloom 层级：${question.bloomLevel}
正确答案：${question.answer}
${response ? `学生答案：${response.answer}（${response.correct ? '正确' : '错误'}）` : '（尚无学生作答）'}

请生成高阶思维追问：`,
            },
        ]

        yield* this.streamWithFallback(
            messages,
            'followup',
            () => this.fallbackFollowup(question),
            signal,
        )
    }

    /**
     * 4. 干预建议：检测困难学生并生成干预策略
     *
     * 场景：AI 自动检测正确率低、响应慢的学生，给出干预建议
     * 注意：此方法为非流式（一次性返回），因为需要聚合多个学生数据
     */
    async detectIntervention(req: InterventionRequest): Promise<InterventionResult> {
        const { runtime } = req
        const strugglingStudents: InterventionResult['strugglingStudents'] = []

        // 检测困难学生（正确率 <0.4）
        for (const [studentId, studentName] of runtime.students) {
            const studentResponses: StudentResponse[] = []
            for (const rs of runtime.responses.values()) {
                for (const r of rs) {
                    if (r.studentId === studentId) {
                        studentResponses.push(r)
                    }
                }
            }

            if (studentResponses.length === 0) continue

            const correctCount = studentResponses.filter((r) => r.correct).length
            const accuracy = correctCount / studentResponses.length

            if (accuracy < 0.4) {
                const suggestion = this.generateStrugglingSuggestion(studentName, accuracy, studentResponses)
                strugglingStudents.push({
                    studentId,
                    studentName,
                    accuracy,
                    suggestion,
                })
            }
        }

        // 生成全班干预建议
        const classSuggestion = strugglingStudents.length > 0
            ? `检测到 ${strugglingStudents.length} 名学生存在困难，建议：1) 暂停推进新内容，回顾基础知识点；2) 为困难学生推送脚手架式提示；3) 安排同伴互助，让正确率高的学生协助讲解。`
            : '全班整体表现良好，可继续推进教学内容，适时增加挑战性题目。'

        return {
            strugglingStudents,
            classSuggestion,
        }
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法：流式调用 + 降级
    // ─────────────────────────────────────────────────────────

    /**
     * 流式调用 DeepSeek，主模型失败时降级到 flash
     * 两个模型都失败时使用模板降级
     */
    private async *streamWithFallback(
        messages: ChatMessage[],
        category: AISuggestionCategory,
        fallback: () => string,
        signal?: AbortSignal,
    ): AsyncGenerator<AISuggestionStreamChunk> {
        throwIfAborted(signal)
        // 尝试主模型
        try {
            yield* this.streamCall(
                messages,
                category,
                AICollaborator.PRIMARY_MODEL,
                AICollaborator.PRIMARY_THINKING,
                signal,
            )
            return
        } catch (err) {
            throwIfAborted(signal, err)
            console.warn('[ai-collaborator] 主模型失败，降级到 flash:', err)
        }

        // 尝试降级模型
        try {
            yield* this.streamCall(
                messages,
                category,
                AICollaborator.FALLBACK_MODEL,
                AICollaborator.FALLBACK_THINKING,
                signal,
            )
            return
        } catch (err) {
            throwIfAborted(signal, err)
            console.warn('[ai-collaborator] 降级模型失败，使用模板:', err)
        }

        // 模板降级
        const content = fallback()
        // 模拟流式输出：逐字符 yield
        const chunkSize = 10
        for (let i = 0; i < content.length; i += chunkSize) {
            throwIfAborted(signal)
            yield {
                delta: content.slice(i, i + chunkSize),
                done: false,
                category,
            }
        }
        yield { delta: '', done: true, category }
    }

    /**
     * 调用 DeepSeek 流式接口
     */
    private async *streamCall(
        messages: ChatMessage[],
        category: AISuggestionCategory,
        model: 'deepseek-v4-pro' | 'deepseek-v4-flash',
        thinking: 'low' | 'medium' | 'high' | 'max',
        signal?: AbortSignal,
    ): AsyncGenerator<AISuggestionStreamChunk> {
        throwIfAborted(signal)
        const stream = managedLLM.stream({
            model,
            messages,
            thinking,
            temperature: 0.7,
            maxTokens: 1024,
            signal,
            metadata: {
                agent: 'ai-collaborator',
                task: `${category}-${model}`,
            },
        })

        let hasContent = false
        for await (const chunk of stream) {
            throwIfAborted(signal)
            if (chunk.content) {
                hasContent = true
                yield {
                    delta: chunk.content,
                    done: false,
                    category,
                }
            }
        }

        throwIfAborted(signal)
        if (!hasContent) {
            throw new Error('流式响应无内容')
        }

        yield { delta: '', done: true, category }
    }

    // ─────────────────────────────────────────────────────────
    // 模板降级内容
    // ─────────────────────────────────────────────────────────

    private fallbackFeedback(response: StudentResponse, question: Question): string {
        if (response.correct) {
            return `${response.studentName}回答正确！建议进一步追问：你是如何想到这个答案的？引导学生分享思考过程，巩固${question.bloomLevel}层能力。`
        }
        return `${response.studentName}的回答有偏差。建议：先肯定其思考方向，再引导回顾「${question.answer}」相关知识点，最后通过同类题型强化理解。`
    }

    private fallbackSupplement(poemTitle: string, poet: string): string {
        return `《${poemTitle}》是${poet}的代表作之一。建议讲解时联系诗人生平与创作背景，引导学生体会诗歌中的情感表达与艺术手法，建立文化认知框架。`
    }

    private fallbackFollowup(question: Question): string {
        const stem = question.stem.slice(0, 30)
        return `基于「${stem}…」的追问：
追问1: 你能从不同角度分析这个问题吗？
追问2: 如果改变条件，结果会有什么不同？
追问3: 这个知识点在生活中有哪些应用？`
    }

    private generateStrugglingSuggestion(
        studentName: string,
        accuracy: number,
        responses: StudentResponse[],
    ): string {
        const wrongCount = responses.filter((r) => !r.correct).length
        return `${studentName}近期正确率仅 ${(accuracy * 100).toFixed(0)}%，错误 ${wrongCount} 次。建议：1) 课后针对性辅导基础知识点；2) 课堂推送脚手架式提示降低难度；3) 安排同伴互助学习。`
    }
}

function throwIfAborted(signal?: AbortSignal, cause?: unknown): void {
    if (!signal?.aborted && !(cause instanceof Error && cause.name === 'AbortError')) return
    if (cause instanceof Error && cause.name === 'AbortError') throw cause
    const error = new Error('课堂 AI 流已取消')
    error.name = 'AbortError'
    throw error
}

/** 全局单例 */
export const aiCollaborator = new AICollaborator()
