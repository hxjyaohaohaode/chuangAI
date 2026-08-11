/**
 * 思考链仓储（Thinking Palace 用）
 *
 * 记录 DeepSeek reasoning_content 流式拼接后的完整推理过程，
 * 拆分为结构化 ThinkingNode[] 供前端 3D 可视化使用。
 *
 * 设计要点：
 * - nodes 字段以 JSON 字符串持久化，读写自动序列化/反序列化
 * - 按 agentId / sessionId 查询的便捷方法
 * - 限制单条 reasoning 最大长度（防止超长推理撑爆数据库）
 */
import type Database from 'better-sqlite3'
import { BaseRepository, type RowMapper } from './base.repository.js'
import type {
    ThinkingChainEntity,
    CreateThinkingChainInput,
    ThinkingNode,
    ThinkingNodeType,
    ThinkingMode,
} from '../types.js'
import { parseJson, stringifyJson } from '../utils/json.js'

/** 单条 reasoning 最大字符数（防超长） */
const MAX_REASONING_LENGTH = 100_000

/** 单条 question 最大字符数 */
const MAX_QUESTION_LENGTH = 500

/** 单条 answer 最大字符数 */
const MAX_ANSWER_LENGTH = 50_000

export class ThinkingChainRepository extends BaseRepository<ThinkingChainEntity, CreateThinkingChainInput> {
    constructor(db: Database.Database) {
        super(db, 'thinking_chains', 'id')
    }

    protected get mapper(): RowMapper<ThinkingChainEntity, CreateThinkingChainInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                agent_id: input.agentId,
                session_id: input.sessionId,
                question: input.question.slice(0, MAX_QUESTION_LENGTH),
                reasoning: input.reasoning.slice(0, MAX_REASONING_LENGTH),
                answer: input.answer?.slice(0, MAX_ANSWER_LENGTH) ?? null,
                nodes: stringifyJson(input.nodes ?? []),
                thinking_mode: input.thinkingMode,
                duration_ms: input.durationMs ?? 0,
                model: input.model,
                prompt_tokens: input.promptTokens ?? 0,
                completion_tokens: input.completionTokens ?? 0,
                metadata: stringifyJson(input.metadata ?? null),
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.agentId !== undefined) row['agent_id'] = patch.agentId
                if (patch.sessionId !== undefined) row['session_id'] = patch.sessionId
                if (patch.question !== undefined) row['question'] = patch.question.slice(0, MAX_QUESTION_LENGTH)
                if (patch.reasoning !== undefined) row['reasoning'] = patch.reasoning.slice(0, MAX_REASONING_LENGTH)
                if (patch.answer !== undefined) row['answer'] = patch.answer?.slice(0, MAX_ANSWER_LENGTH) ?? null
                if (patch.nodes !== undefined) row['nodes'] = stringifyJson(patch.nodes)
                if (patch.thinkingMode !== undefined) row['thinking_mode'] = patch.thinkingMode
                if (patch.durationMs !== undefined) row['duration_ms'] = patch.durationMs
                if (patch.model !== undefined) row['model'] = patch.model
                if (patch.promptTokens !== undefined) row['prompt_tokens'] = patch.promptTokens
                if (patch.completionTokens !== undefined) row['completion_tokens'] = patch.completionTokens
                if (patch.metadata !== undefined) row['metadata'] = stringifyJson(patch.metadata)
                return row
            },
            fromRow: (row) => ({
                id: row['id'] as string,
                agentId: row['agent_id'] as string,
                sessionId: row['session_id'] as string,
                question: row['question'] as string,
                reasoning: row['reasoning'] as string,
                answer: (row['answer'] as string | null) ?? null,
                nodes: parseJson<ThinkingNode[]>(row['nodes'] as string | null) ?? [],
                thinkingMode: (row['thinking_mode'] as ThinkingMode) ?? 'medium',
                durationMs: (row['duration_ms'] as number) ?? 0,
                model: row['model'] as string,
                promptTokens: (row['prompt_tokens'] as number) ?? 0,
                completionTokens: (row['completion_tokens'] as number) ?? 0,
                createdAt: row['created_at'] as number,
                metadata: parseJson(row['metadata'] as string | null),
            }),
        }
    }

    /** 按 Agent 查询（最近优先） */
    findByAgentId(agentId: string, limit = 50): ThinkingChainEntity[] {
        const stmt = this.db.prepare(
            `SELECT * FROM thinking_chains WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
        )
        const rows = stmt.all(agentId, limit) as Array<Record<string, unknown>>
        return rows.map((row) => this.mapper.fromRow(row))
    }

    /** 按会话查询（最近优先） */
    findBySessionId(sessionId: string, limit = 50): ThinkingChainEntity[] {
        const stmt = this.db.prepare(
            `SELECT * FROM thinking_chains WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
        )
        const rows = stmt.all(sessionId, limit) as Array<Record<string, unknown>>
        return rows.map((row) => this.mapper.fromRow(row))
    }

    /** 查询最近 N 条思考链（跨 Agent，最近优先） */
    findRecent(limit = 50): ThinkingChainEntity[] {
        const stmt = this.db.prepare(
            `SELECT * FROM thinking_chains ORDER BY created_at DESC LIMIT ?`,
        )
        const rows = stmt.all(limit) as Array<Record<string, unknown>>
        return rows.map((row) => this.mapper.fromRow(row))
    }

    /** 按 Agent 统计 */
    countByAgent(agentId: string): number {
        const row = this.db
            .prepare(`SELECT COUNT(*) as cnt FROM thinking_chains WHERE agent_id = ?`)
            .get(agentId) as { cnt: number }
        return row.cnt
    }
}

/**
 * 推理文本拆分器 —— 将连续的 reasoning_content 拼接文本拆分为 ThinkingNode[]
 *
 * 拆分策略（基于关键词启发式）：
 * - "假设"/"假如"/"如果" 开头 → hypothesis
 * - "因为"/"所以"/"因此"/"由此"/"推导"/"推理" → reasoning
 * - "证据"/"根据"/"参考"/"依据"/"数据" → evidence
 * - "为什么"/"是否"/"如何"/"什么"/"疑问" → question
 * - "结论"/"综上"/"最终"/"答案"/"结果" → conclusion
 * - 默认 → reasoning
 *
 * 每个节点按段落（双换行或句号后换行）切分，记录字符偏移供前端高亮。
 */
export function splitReasoningIntoNodes(reasoning: string): ThinkingNode[] {
    if (!reasoning || reasoning.trim().length === 0) return []

    // 按段落切分（双换行、句号+换行、分号+换行）
    const segments = reasoning
        .split(/\n{2,}|(?<=[。；])\s*\n|(?<=[。；])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

    const nodes: ThinkingNode[] = []
    let cursor = 0

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!
        // 在原 reasoning 中查找偏移（从 cursor 开始查找，避免重复匹配）
        const startOffset = reasoning.indexOf(seg, cursor)
        const actualStart = startOffset >= 0 ? startOffset : cursor
        const endOffset = actualStart + seg.length
        cursor = endOffset

        nodes.push({
            index: i,
            type: classifyNodeType(seg),
            content: seg,
            startOffset: actualStart,
            endOffset,
        })
    }

    // 若仅有一个节点且内容较长，尝试按句号切分以提供更细粒度
    if (nodes.length === 1 && nodes[0]!.content.length > 200) {
        return splitLongSegment(nodes[0]!.content, 0)
    }

    return nodes
}

/** 分类节点类型（基于关键词启发式） */
function classifyNodeType(text: string): ThinkingNodeType {
    const lower = text.slice(0, 50).toLowerCase()
    if (/^(假设|假如|如果|假定|设若)/.test(text) || lower.startsWith('hypothesis') || lower.startsWith('suppose')) {
        return 'hypothesis'
    }
    if (/^(为什么|是否|如何|什么|为何|难道|疑问)/.test(text) || lower.startsWith('why') || lower.startsWith('how')) {
        return 'question'
    }
    if (/^(证据|根据|参考|依据|数据|表明|显示)/.test(text) || lower.startsWith('evidence') || lower.startsWith('according')) {
        return 'evidence'
    }
    if (/^(结论|综上|最终|答案|结果|总之)/.test(text) || lower.startsWith('conclusion') || lower.startsWith('therefore')) {
        return 'conclusion'
    }
    return 'reasoning'
}

/** 将过长段落按句号切分为多个节点 */
function splitLongSegment(text: string, startIndex: number): ThinkingNode[] {
    const sentences = text
        .split(/(?<=[。！？；])\s*/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

    if (sentences.length <= 1) {
        return [{
            index: startIndex,
            type: classifyNodeType(text),
            content: text,
            startOffset: 0,
            endOffset: text.length,
        }]
    }

    const nodes: ThinkingNode[] = []
    let cursor = 0
    sentences.forEach((sent, i) => {
        const start = text.indexOf(sent, cursor)
        const actualStart = start >= 0 ? start : cursor
        const end = actualStart + sent.length
        cursor = end
        nodes.push({
            index: startIndex + i,
            type: classifyNodeType(sent),
            content: sent,
            startOffset: actualStart,
            endOffset: end,
        })
    })
    return nodes
}
