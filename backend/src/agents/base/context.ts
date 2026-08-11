/**
 * Context Engineering 工具集
 *
 * 实现 Context Engineering 的核心策略：
 * - RAGRetriever               — SubTask 8.1.2：基于知识图谱的简单 RAG（Top-K 检索 + 重排序）
 * - LongConversationSummarizer — SubTask 8.1.3：长对话自动摘要（超阈值时摘要旧轮次）
 * - buildIsolatedContext       — SubTask 8.1.4：子智能体独立上下文构建（避免互相污染）
 * - trimHistoryWithSummary     — SubTask 8.1.3：历史轮次裁剪（保留最近 N 轮 + 摘要）
 *
 * 设计原则：
 * - 不引入新依赖（仅用现有 LLM 路由层）
 * - 所有摘要调用走 orchestrator:summarize 路由（deepseek-v4-flash，性价比最优）
 * - RAG 检索基于关键词 + 主题/意象/修辞多维匹配，无需向量数据库
 */

import { router } from '../../llm/index.js'
import type { ChatMessage } from '../../llm/types.js'
import type { PoemNode } from './types.js'
import {
    STANDARD_CONTEXT_TAGS,
    safeJsonParse,
    withXmlTags,
} from './prompts.js'
import {
    recallStudentMemory,
    recallTeacherPreference,
    recallAgentExperience,
} from './long-term-memory.js'

// ─────────────────────────────────────────────────────────────
// SubTask 8.1.2：RAG 检索 + 重排序
// ─────────────────────────────────────────────────────────────

/**
 * RAG 检索结果条目
 */
export interface RAGResult {
    /** 诗词节点 */
    poem: PoemNode
    /** 综合相关性得分（0-1，越高越相关） */
    score: number
    /** 命中维度（用于可观测性） */
    matchedDimensions: string[]
}

/**
 * 简单 RAG 检索器（基于知识图谱）
 *
 * 实现策略：
 * 1. 关键词提取：从 query 中提取主题词、意象词、修辞手法词
 * 2. 多维匹配：对知识图谱中每个 PoemNode，按主题/意象/教学要点三维匹配
 * 3. 重排序（Re-ranking）：按综合得分降序，取 Top-K
 *
 * 不依赖向量数据库，适合当前知识图谱规模（百首级）。
 * 若未来扩展至千首级，可接入向量索引。
 */
export class RAGRetriever {
    /** 默认 Top-K */
    private static readonly DEFAULT_TOP_K = 5

    /**
     * 检索与 query 最相关的 Top-K 诗词节点
     *
     * @param query 查询字符串（如"思乡主题的唐诗"）
     * @param knowledgeGraph 知识图谱节点集合
     * @param topK 返回数量，默认 5
     */
    retrieve(query: string, knowledgeGraph: PoemNode[], topK: number = RAGRetriever.DEFAULT_TOP_K): RAGResult[] {
        if (knowledgeGraph.length === 0) return []

        const keywords = this.extractKeywords(query)
        const scored = knowledgeGraph.map((poem) => this.scorePoem(poem, keywords))

        // 重排序：按综合得分降序
        scored.sort((a, b) => b.score - a.score)

        return scored.slice(0, Math.max(topK, 0)).filter((r) => r.score > 0)
    }

    /**
     * 提取查询关键词
     *
     * 简单分词：按空格、标点切分 + 中文常见停用词过滤。
     * 识别三类关键词：主题词（思乡/送别）、意象词（明月/柳枝）、修辞词（拟人/比喻）。
     */
    private extractKeywords(query: string): string[] {
        const stopWords = new Set(['的', '了', '是', '在', '有', '和', '与', '及', '或', '一首', '关于', '相关'])
        const raw = query.split(/[\s,，。；;、！!?？]+/).filter((s) => s.length > 0)
        return raw.filter((w) => !stopWords.has(w))
    }

    /**
     * 对单个诗词节点评分
     *
     * 评分维度：
     * - 主题匹配（权重 0.4）：query 关键词命中 poem.theme
     * - 意象匹配（权重 0.3）：query 关键词命中 poem.images
     * - 教学要点匹配（权重 0.2）：query 关键词命中 poem.teachingPoints
     * - 标题/诗人匹配（权重 0.1）：query 关键词命中 poem.title 或 poem.poet
     */
    private scorePoem(poem: PoemNode, keywords: string[]): RAGResult {
        const matchedDimensions: string[] = []
        let score = 0

        if (keywords.length === 0) {
            return { poem, score: 0, matchedDimensions }
        }

        // 主题匹配
        const themeHits = keywords.filter((k) =>
            poem.theme.some((t) => t.includes(k) || k.includes(t)),
        )
        if (themeHits.length > 0) {
            score += 0.4 * Math.min(themeHits.length / keywords.length, 1)
            matchedDimensions.push(`theme:${themeHits.join(',')}`)
        }

        // 意象匹配
        const imageHits = keywords.filter((k) =>
            poem.images.some((img) => img.includes(k) || k.includes(img)),
        )
        if (imageHits.length > 0) {
            score += 0.3 * Math.min(imageHits.length / keywords.length, 1)
            matchedDimensions.push(`images:${imageHits.join(',')}`)
        }

        // 教学要点匹配
        const teachingHits = keywords.filter((k) =>
            poem.teachingPoints?.some((tp) => tp.includes(k) || k.includes(tp)) ?? false,
        )
        if (teachingHits.length > 0) {
            score += 0.2 * Math.min(teachingHits.length / keywords.length, 1)
            matchedDimensions.push(`teaching:${teachingHits.join(',')}`)
        }

        // 标题/诗人匹配
        const titleHits = keywords.filter((k) =>
            poem.title.includes(k) || poem.poet.includes(k),
        )
        if (titleHits.length > 0) {
            score += 0.1 * Math.min(titleHits.length / keywords.length, 1)
            matchedDimensions.push(`title:${titleHits.join(',')}`)
        }

        return {
            poem,
            score: Math.min(score, 1),
            matchedDimensions,
        }
    }

    /**
     * 将检索结果格式化为 XML 上下文块
     *
     * 供 Agent 的 buildUserPrompt 直接注入 <knowledge_graph> 标签。
     */
    formatAsContext(results: RAGResult[]): string {
        if (results.length === 0) return ''
        const text = results.map((r, i) => {
            const parts = [
                `[${i + 1}] ${r.poem.title}（${r.poem.dynasty}·${r.poem.poet}）`,
                `  相关度: ${(r.score * 100).toFixed(0)}% | 命中: ${r.matchedDimensions.join('/')}`,
            ]
            if (r.poem.theme.length > 0) parts.push(`  主题: ${r.poem.theme.join('/')}`)
            if (r.poem.images.length > 0) parts.push(`  意象: ${r.poem.images.join('/')}`)
            if (r.poem.teachingPoints && r.poem.teachingPoints.length > 0) {
                parts.push(`  教学要点: ${r.poem.teachingPoints.join('/')}`)
            }
            if (r.poem.content) parts.push(`  原文: ${r.poem.content}`)
            return parts.join('\n')
        }).join('\n\n')
        return withXmlTags(text, STANDARD_CONTEXT_TAGS.KNOWLEDGE_GRAPH)
    }
}

// ─────────────────────────────────────────────────────────────
// SubTask 8.1.3：长对话自动摘要
// ─────────────────────────────────────────────────────────────

/**
 * 摘要后的历史结构
 */
export interface SummarizedHistory {
    /** 旧轮次的摘要文本 */
    summary: string
    /** 保留的最近 N 轮原始消息 */
    recentMessages: ChatMessage[]
    /** 是否触发了摘要（未触发时 summary 为空） */
    summarized: boolean
}

/**
 * 长对话自动摘要器
 *
 * 当对话历史超过阈值时，调用 orchestrator:summarize 路由
 * 将旧轮次压缩为摘要，保留最近 N 轮原始消息。
 *
 * 策略：
 * - 阈值检测：消息数超过 maxMessages 时触发
 * - 摘要生成：将旧消息（除最近 keepRecent 条）发送给 LLM 生成摘要
 * - 历史裁剪：保留最近 keepRecent 条原始消息 + 摘要作为 system 注入
 */
export class LongConversationSummarizer {
    /**
     * @param maxMessages 触发摘要的消息数阈值，默认 20
     * @param keepRecent 保留的最近原始消息数，默认 6
     */
    constructor(
        private readonly maxMessages: number = 20,
        private readonly keepRecent: number = 6,
    ) {}

    /**
     * 按需摘要历史对话
     *
     * 若历史未超过阈值，原样返回（summarized: false）。
     * 若超过阈值，摘要旧消息 + 保留最近 N 条。
     */
    async summarize(history: ChatMessage[]): Promise<SummarizedHistory> {
        if (history.length <= this.maxMessages) {
            return { summary: '', recentMessages: history, summarized: false }
        }

        // 切分：旧消息（待摘要）+ 最近消息（保留）
        const toSummarize = history.slice(0, history.length - this.keepRecent)
        const recent = history.slice(history.length - this.keepRecent)

        const summary = await this.generateSummary(toSummarize)

        return {
            summary,
            recentMessages: recent,
            summarized: true,
        }
    }

    /**
     * 调用 LLM 生成对话摘要
     *
     * 走 orchestrator:summarize 路由（deepseek-v4-flash，低成本）。
     * 摘要聚焦：关键决策、已确定的事实、待解决的问题。
     */
    private async generateSummary(messages: ChatMessage[]): Promise<string> {
        const conversationText = messages
            .map((m) => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
            .join('\n')

        const systemPrompt = `你是诗脉·启明的对话摘要引擎。请将以下多轮对话压缩为简洁摘要，聚焦：
1. 已确定的关键事实与决策
2. 待解决的核心问题
3. 涉及的诗词、学生、班级等关键实体

输出严格 JSON：{"summary": "摘要文本，200 字以内"}
不输出任何解释文字或代码块包裹。`

        const userPrompt = withXmlTags(conversationText, 'conversation_to_summarize')

        const result = await router.execute('orchestrator', 'summarize', {
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            jsonOutput: true,
            metadata: { agent: 'context-summarizer', task: 'long-conversation-summary' },
        })

        try {
            const parsed = safeJsonParse(result.content) as { summary?: string }
            return parsed.summary ?? ''
        } catch {
            // 摘要失败不阻塞流程，返回空摘要
            return ''
        }
    }
}

/**
 * 裁剪历史对话并附带摘要
 *
 * 便捷封装：若已生成摘要，返回 [摘要消息, ...最近消息]；
 * 否则返回原历史。
 */
export function trimHistoryWithSummary(summarized: SummarizedHistory): ChatMessage[] {
    if (!summarized.summarized || !summarized.summary) {
        return summarized.recentMessages
    }
    const summaryMessage: ChatMessage = {
        role: 'system',
        content: withXmlTags(
            `之前的对话已摘要如下，供你参考上下文：\n${summarized.summary}`,
            STANDARD_CONTEXT_TAGS.HISTORY_SUMMARY,
        ),
    }
    return [summaryMessage, ...summarized.recentMessages]
}

// ─────────────────────────────────────────────────────────────
// SubTask 8.1.4：子智能体独立上下文构建
// ─────────────────────────────────────────────────────────────

/**
 * 构建子智能体独立上下文
 *
 * 编排官汇总各子智能体结果时，每个子智能体应拥有独立上下文，
 * 避免不同子智能体的中间状态互相污染。
 *
 * 本函数从全局 AgentContext 中提取与该子智能体相关的部分，
 * 过滤掉其他子智能体的中间结果。
 *
 * @param baseCtx 编排官下发的全局上下文
 * @param agentId 当前子智能体 ID（如 'brush.question'）
 * @param ragResults 可选的 RAG 检索结果（已为该智能体检索）
 */
export function buildIsolatedContext(
    baseCtx: import('./types.js').AgentContext,
    _agentId: string,
    ragResults?: RAGResult[],
): import('./types.js').AgentContext {
    // 子智能体独立上下文：复用 taskId / sessionId / signal / teacherIntent，
    // 但隔离 history（避免其他子智能体的对话污染）与 knowledgeGraphNodes
    // （改用 ragResults 精准注入）
    const ragPoems = ragResults && ragResults.length > 0
        ? ragResults.map((r) => r.poem)
        : baseCtx.knowledgeGraphNodes

    return {
        taskId: baseCtx.taskId,
        sessionId: baseCtx.sessionId,
        signal: baseCtx.signal,
        // 不继承全局 history，子智能体从干净状态开始
        history: undefined,
        // 保留学情画像与班级上下文（这些是共享只读数据，不构成污染）
        studentProfile: baseCtx.studentProfile,
        classContext: baseCtx.classContext,
        // 使用 RAG 精准检索的诗词节点，而非全量图谱
        knowledgeGraphNodes: ragPoems,
        teacherIntent: baseCtx.teacherIntent,
        promptOverride: baseCtx.promptOverride,
    }
}

/**
 * 构建 RAG 增强的上下文块
 *
 * 供子智能体在 buildUserPrompt 中调用，将 RAG 检索结果注入 <knowledge_graph> 标签。
 * 若无 RAG 结果，回退到基础知识图谱节点。
 */
export function buildRagContextBlock(
    ragResults: RAGResult[] | undefined,
    fallbackNodes: import('./types.js').PoemNode[] | undefined,
): string {
    if (ragResults && ragResults.length > 0) {
        const retriever = new RAGRetriever()
        return retriever.formatAsContext(ragResults)
    }
    if (fallbackNodes && fallbackNodes.length > 0) {
        const text = fallbackNodes.map((p) => {
            const parts = [`${p.title}（${p.dynasty}·${p.poet}）`]
            if (p.theme.length > 0) parts.push(`主题: ${p.theme.join('/')}`)
            if (p.images.length > 0) parts.push(`意象: ${p.images.join('/')}`)
            if (p.teachingPoints && p.teachingPoints.length > 0) {
                parts.push(`教学要点: ${p.teachingPoints.join('/')}`)
            }
            return parts.join(' | ')
        }).join('\n')
        return withXmlTags(text, STANDARD_CONTEXT_TAGS.KNOWLEDGE_GRAPH)
    }
    return ''
}

// ─────────────────────────────────────────────────────────────
// Task 6.2.2：长期记忆集成（mem0-main SKILL）
// ─────────────────────────────────────────────────────────────

/**
 * 记忆检索参数
 *
 * 所有字段可选 —— 仅检索提供了 ID 的记忆作用域。
 * 至少提供 studentId / teacherId / agentId 之一，否则返回空串。
 */
export interface MemoryContextParams {
    /** 学生 ID（用于检索跨会话学情记忆） */
    studentId?: string
    /** 学生记忆必须绑定班级，且由教师所有者授权。 */
    classId?: string
    /** 教师 ID（用于检索教师偏好记忆） */
    teacherId?: string
    /** 智能体 ID（用于检索智能体执行经验） */
    agentId?: string
    /** 检索查询（如"该学生在修辞手法的掌握情况"） */
    query: string
    /** 每类记忆返回的 Top-K，默认 3 */
    topK?: number
}

/**
 * 构建长期记忆上下文块
 *
 * 将三大主智能体（诗心/诗眼/诗笔）所需的长期记忆并行检索并格式化为 XML 上下文。
 *
 * 检索策略（对标 mem0 多级记忆）：
 * - 学生学情记忆（scope=user）：跨会话的认知诊断结论、暗物质记录、掌握度变化
 * - 教师偏好记忆（scope=user）：教师的命题风格、批改偏好、介入修正历史
 * - 智能体经验记忆（scope=agent）：智能体在类似场景下的成功策略与失败教训
 *
 * 容错策略：
 * - 使用 Promise.allSettled，任一记忆检索失败不阻塞其他
 * - 全部失败时返回空串（记忆是增强项，非必需项）
 *
 * @returns 拼接后的 XML 上下文块（可能包含 <long_term_memory> 多段），无记忆时返回空串
 */
export async function buildMemoryContextBlock(params: MemoryContextParams): Promise<string> {
    const { studentId, classId, teacherId, agentId, query, topK = 3 } = params

    if (!studentId && !teacherId && !agentId) return ''
    if (!query.trim()) return ''

    // 并行检索三类记忆，任一失败不影响其他
    const tasks: Array<Promise<string>> = []

    // 学生长期记忆没有教师所有者或班级边界时默认失败关闭，避免跨租户串读。
    if (studentId && teacherId && classId) {
        tasks.push(
            recallStudentMemory(teacherId, studentId, classId, query, topK).catch(() => ''),
        )
    }
    if (teacherId) {
        tasks.push(
            recallTeacherPreference(teacherId, query, topK).catch(() => ''),
        )
    }
    if (agentId) {
        tasks.push(
            recallAgentExperience(agentId, query, topK).catch(() => ''),
        )
    }

    const settled = await Promise.allSettled(tasks)
    const blocks = settled
        .filter((s): s is PromiseFulfilledResult<string> => s.status === 'fulfilled')
        .map((s) => s.value)
        .filter((text) => text.length > 0)

    if (blocks.length === 0) return ''
    return blocks.join('\n\n')
}

/**
 * 从 AgentContext 提取记忆检索参数
 *
 * 便捷工具：根据 AgentContext 中的 studentProfile.id 与 agentId 自动组装记忆检索参数。
 * teacherId 通常来自编排官下发（若无则不检索教师偏好）。
 *
 * @param ctx Agent 上下文
 * @param agentId 当前智能体 ID
 * @param query 检索查询
 * @param teacherId 可选教师 ID
 */
export function extractMemoryParams(
    ctx: import('./types.js').AgentContext,
    agentId: string,
    query: string,
    teacherId?: string,
): MemoryContextParams {
    return {
        studentId: ctx.studentProfile?.id,
        classId: ctx.classContext?.id,
        teacherId,
        agentId,
        query,
    }
}

/**
 * 构建 RAG + 记忆增强的完整上下文块
 *
 * 一步到位封装：将知识图谱 RAG 检索结果 + 长期记忆拼接为单一上下文字符串。
 * 供子智能体 buildUserPrompt 一次性注入，避免多次调用。
 *
 * @param ragResults RAG 检索结果（可选）
 * @param fallbackNodes RAG 回退的图谱节点（可选）
 * @param memoryParams 记忆检索参数（可选，不提供则跳过记忆）
 * @returns 拼接后的上下文块，无内容时返回空串
 */
export async function buildEnhancedContextBlock(
    ragResults: RAGResult[] | undefined,
    fallbackNodes: import('./types.js').PoemNode[] | undefined,
    memoryParams?: MemoryContextParams,
): Promise<string> {
    const ragBlock = buildRagContextBlock(ragResults, fallbackNodes)
    const memoryBlock = memoryParams
        ? await buildMemoryContextBlock(memoryParams)
        : ''

    const parts = [ragBlock, memoryBlock].filter((s) => s.length > 0)
    return parts.length > 0 ? parts.join('\n\n') : ''
}
