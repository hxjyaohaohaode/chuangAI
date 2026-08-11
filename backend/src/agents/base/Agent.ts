/**
 * Agent 抽象基类
 *
 * 所有子 Agent 的统一基类，实现模板方法模式：
 * - invoke<T>() 为模板方法，封装完整的调用生命周期
 * - buildSystemPrompt / buildUserPrompt / validateOutput 为抽象方法，由子类实现
 *
 * 生命周期：
 * 1. 发射 agent:call:start 事件
 * 2. 构建 system + user prompt（支持 promptOverride 覆盖）
 * 3. 通过 router.execute 调用 LLM（路由矩阵自动选择最优模型）
 * 4. validateOutput 解析 + zod 校验
 * 5. 发射 agent:call:success 事件
 * 6. 失败时发射 agent:call:error，由 errorRecovery 处理
 * 7. 返回 AgentResult<T>（含 aiGenerated: true 元数据）
 *
 * 对于多阶段流程（如 Tri-MARF 视觉标注、ASR 评分），子类可 override invoke，
 * 并复用 emitStart / emitSuccess / emitError 辅助方法保持事件一致性。
 */

import { router } from '../../llm/index.js'
import type { Domain, Function, ChatMessage } from '../../llm/types.js'
import { agentEvents, AGENT_EVENTS } from './events.js'
import type { AgentContext, AgentResult, BloomLevel } from './types.js'

// ─────────────────────────────────────────────────────────────
// BaseAgent 抽象基类
// ─────────────────────────────────────────────────────────────

export abstract class BaseAgent {
    // ── 元数据（子类必须声明） ──
    abstract readonly id: string
    abstract readonly name: string
    abstract readonly domain: Domain
    abstract readonly fn: Function
    abstract readonly bloomLevel: BloomLevel
    abstract readonly promptVersion: string

    // ── 抽象方法（子类实现单次调用逻辑） ──

    /**
     * 构建 System Prompt
     * 定义 Agent 角色、能力边界、知识背景与输出约束。
     * 支持 ctx.promptOverride.systemPrompt 覆盖（Task 22 自我进化用）。
     */
    protected abstract buildSystemPrompt(ctx: AgentContext): string

    /**
     * 构建 User Prompt
     * 将输入数据与上下文（学情、知识图谱、历史）组装为用户消息。
     */
    protected abstract buildUserPrompt(input: unknown, ctx: AgentContext): string

    /**
     * 解析并校验 LLM 原始输出
     * 实现 JSON 解析 + zod schema 校验，失败时抛出明确错误。
     */
    protected abstract validateOutput(raw: string): unknown

    // ── 可覆盖钩子 ──

    /**
     * 是否启用 JSON Output 模式（DeepSeek 特有）
     * 默认 true，TTS 等非 JSON 输出 Agent 覆盖为 false
     */
    protected useJsonOutput(): boolean {
        return true
    }

    // ── 模板方法 ──

    /**
     * Agent 调用入口（模板方法）
     *
     * 子类通常直接使用此方法。对于多阶段流程（Tri-MARF / ASR / TTS），
     * 子类可 override 此方法，但应复用 emitStart / emitSuccess / emitError
     * 以保持事件追踪的一致性。
     *
     * 返回 AgentResult<unknown>，子类 override 时可收窄为具体类型（协变合法）。
     * 子类内部调用 super.invoke 时需 as 断言为具体类型。
     */
    async invoke(input: unknown, ctx: AgentContext): Promise<AgentResult<unknown>> {
        const startedAt = Date.now()
        const inputPreview = this.previewInput(input)
        this.emitStart(inputPreview, ctx)

        try {
            const systemPrompt = ctx.promptOverride?.systemPrompt ?? this.buildSystemPrompt(ctx)
            const userPrompt = this.buildUserPrompt(input, ctx)

            const messages: ChatMessage[] = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ]

            const result = await router.execute(this.domain, this.fn, {
                messages,
                jsonOutput: this.useJsonOutput(),
                metadata: {
                    agent: this.id,
                    task: ctx.taskId,
                    sessionId: ctx.sessionId,
                },
                signal: ctx.signal,
            })

            const output = this.validateOutput(result.content)

            const agentResult: AgentResult<unknown> = {
                agentId: this.id,
                output,
                usage: {
                    promptTokens: result.usage.promptTokens,
                    completionTokens: result.usage.completionTokens,
                    cachedTokens: result.usage.cachedTokens,
                },
                latencyMs: Date.now() - startedAt,
                promptVersion: ctx.promptOverride?.version ?? this.promptVersion,
                aiGenerated: true,
                ...(result.fallback ? { warnings: ['本次输出为降级模式，质量可能受限'] } : {}),
            }

            this.emitSuccess(agentResult, ctx)
            return agentResult
        } catch (err) {
            this.emitError(err, ctx)
            throw err
        }
    }

    // ── 受保护的辅助方法（供 override invoke 的子类复用） ──

    /**
     * 发射调用开始事件
     */
    protected emitStart(inputPreview: string, ctx: AgentContext): void {
        agentEvents.emit(AGENT_EVENTS.CALL_START, {
            agentId: this.id,
            domain: this.domain,
            function: this.fn,
            bloomLevel: this.bloomLevel,
            promptVersion: this.promptVersion,
            taskId: ctx.taskId,
            sessionId: ctx.sessionId,
            inputPreview,
            timestamp: Date.now(),
        })
    }

    /**
     * 发射调用成功事件
     */
    protected emitSuccess(result: AgentResult<unknown>, ctx: AgentContext): void {
        agentEvents.emit(AGENT_EVENTS.CALL_SUCCESS, {
            agentId: this.id,
            taskId: ctx.taskId,
            sessionId: ctx.sessionId,
            output: result.output,
            usage: result.usage,
            latencyMs: result.latencyMs,
            promptVersion: result.promptVersion,
            timestamp: Date.now(),
        })
    }

    /**
     * 发射调用错误事件
     */
    protected emitError(err: unknown, ctx: AgentContext): void {
        agentEvents.emit(AGENT_EVENTS.CALL_ERROR, {
            agentId: this.id,
            taskId: ctx.taskId,
            sessionId: ctx.sessionId,
            error: err instanceof Error ? err.message : String(err),
            errorName: err instanceof Error ? err.name : 'Unknown',
            timestamp: Date.now(),
        })
    }

    /**
     * 发射降级事件
     */
    protected emitFallback(reason: string, ctx: AgentContext): void {
        agentEvents.emit(AGENT_EVENTS.FALLBACK, {
            agentId: this.id,
            taskId: ctx.taskId,
            sessionId: ctx.sessionId,
            reason,
            timestamp: Date.now(),
        })
    }

    /**
     * 生成输入预览（截断，避免事件载荷过大）
     */
    protected previewInput(input: unknown): string {
        if (typeof input === 'string') return input.slice(0, 200)
        try {
            return JSON.stringify(input).slice(0, 200)
        } catch {
            return '[unserializable input]'
        }
    }

    /**
     * 构建 AgentResult（供 override invoke 的子类复用）
     */
    protected buildResult<T>(
        output: T,
        usage: { promptTokens: number; completionTokens: number; cachedTokens?: number },
        startedAt: number,
        ctx: AgentContext,
        warnings?: string[],
    ): AgentResult<T> {
        return {
            agentId: this.id,
            output,
            usage,
            latencyMs: Date.now() - startedAt,
            promptVersion: ctx.promptOverride?.version ?? this.promptVersion,
            aiGenerated: true,
            ...(warnings && warnings.length > 0 ? { warnings } : {}),
        }
    }
}
