/**
 * Loop Engineering 工具集
 *
 * 实现 Generator-Verifier-Curator（GVC）三角分工闭环：
 * - Generator（诗笔）：生成内容
 * - Verifier（诗心·verify）：独立验收内容
 * - Curator：从验收问题中提取修正模式，构建反馈
 *
 * 核心能力：
 * - runGvcLoop           — SubTask 8.3.2：带反馈的重生成循环（最多 N 轮）
 * - GeneratorVerifierCurator — 封装 GVC 闭环的执行器
 * - buildCuratorFeedback — SubTask 8.3.1：从验收问题中提炼反馈
 * - classifyErrorLayer   — SubTask 8.3.3：自动错误分层（L1-L5）
 *
 * 设计原则：
 * - 复用现有 VerifySubAgent 作为 Verifier（不重复造轮子）
 * - 复用 BaseAgent.invoke 作为 Generator 入口
 * - 失败时按错误层级自动降级（L4 超时 → flash 降级）
 * - 所有输出携带 aiGenerated: true
 */

import type { ZodError } from 'zod'
import type { BaseAgent } from './Agent.js'
import type {
    AgentContext,
    AgentResult,
    StructuredOutputSchema,
    VerifyIssue,
    VerifyVerdict,
} from './types.js'
import { withRegenerationFeedback } from './prompts.js'

// ─────────────────────────────────────────────────────────────
// SubTask 8.3.3：错误分层
// ─────────────────────────────────────────────────────────────

/**
 * 错误层级（与 error-recovery.ts 的 L1-L5 对齐）
 *
 * - L1: JSON 解析错误 → 重新解析（safeJsonParse 已内置三策略）
 * - L2: Schema 校验失败 → 重新生成（带 schema 提示）
 * - L3: 内容质量问题 → 带反馈重生成（GVC 闭环）
 * - L4: 模型超时/服务不可达 → 降级到 flash（router 自动处理）
 * - L5: 服务完全不可用 → 返回兜底响应（error-recovery 处理）
 */
export type ErrorLayer = 'L1' | 'L2' | 'L3' | 'L4' | 'L5'

/**
 * 根据错误信息分类错误层级
 *
 * 供 GVC 闭环决定采用何种恢复策略。
 */
export function classifyErrorLayer(error: unknown): ErrorLayer {
    if (!(error instanceof Error)) return 'L5'

    const msg = error.message

    // L1: JSON 解析错误
    if (msg.includes('非合法 JSON') || msg.includes('JSON.parse') || msg.includes('无法解析')) {
        return 'L1'
    }

    // L2: Schema 校验失败
    if (msg.includes('校验失败') || msg.includes('zod') || msg.includes('schema') || msg.includes('expected')) {
        return 'L2'
    }

    // L4: 超时 / 网络错误
    if (msg.includes('超时') || msg.includes('timeout') || msg.includes('网络') || msg.includes('AbortError')) {
        return 'L4'
    }

    // L5: 服务不可用
    if (msg.includes('不可用') || msg.includes('unavailable') || msg.includes('5xx')) {
        return 'L5'
    }

    // L3: 内容质量问题（默认）
    return 'L3'
}

/**
 * 格式化 zod 校验错误为简洁字符串（供 GVC schema 失败反馈）
 *
 * 将 ZodError.issues 拼接为 `path: message; path: message` 形式，
 * 便于注入下一轮重生成 prompt，引导模型修正幻觉字段。
 */
function formatZodError(error: ZodError): string {
    const issues = error.issues
    if (issues.length === 0) return '未知 schema 错误'
    return issues
        .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
        .join('; ')
}

// ─────────────────────────────────────────────────────────────
// SubTask 8.3.1：Curator 反馈构建
// ─────────────────────────────────────────────────────────────

/**
 * 从验收问题中提炼 Curator 反馈
 *
 * Curator 的职责：不重新生成内容，而是从 Verifier 的 issues 中
 * 提取"修正模式"（系统性问题模式），形成简洁反馈供 Generator 修正。
 *
 * 反馈结构：
 * - 总体评价（1 句话）
 * - 高优先级问题（severity=high 的问题摘要）
 * - 修正方向（基于 issues 的 suggestion 聚合）
 */
export function buildCuratorFeedback(
    verdict: VerifyVerdict,
    score: number,
    issues: VerifyIssue[],
    attempt: number,
): string {
    if (verdict === 'pass') {
        return `验收通过（得分 ${score}），无需修正。`
    }

    const highIssues = issues.filter((i) => i.severity === 'high')
    const mediumIssues = issues.filter((i) => i.severity === 'medium')
    const lowIssues = issues.filter((i) => i.severity === 'low')

    const parts: string[] = [
        `[第 ${attempt} 轮验收] 裁决：${verdict}，得分：${score}/100`,
    ]

    if (highIssues.length > 0) {
        parts.push(`\n【高优先级问题 - 必须修正】`)
        highIssues.forEach((i, idx) => {
            parts.push(`${idx + 1}. ${i.description}`)
            parts.push(`   → ${i.suggestion}`)
        })
    }

    if (mediumIssues.length > 0) {
        parts.push(`\n【中优先级问题 - 建议修正】`)
        mediumIssues.forEach((i, idx) => {
            parts.push(`${idx + 1}. ${i.description}`)
            parts.push(`   → ${i.suggestion}`)
        })
    }

    if (lowIssues.length > 0) {
        parts.push(`\n【低优先级问题 - 可选优化】`)
        lowIssues.forEach((i) => {
            parts.push(`- ${i.description}`)
        })
    }

    // 修正方向聚合
    const allSuggestions = issues.map((i) => i.suggestion)
    if (allSuggestions.length > 0) {
        parts.push(`\n【修正方向】请针对上述问题逐项修正，重点关注高优先级项。`)
    }

    return parts.join('\n')
}

// ─────────────────────────────────────────────────────────────
// SubTask 8.3.2：Generator-Verifier-Curator 闭环
// ─────────────────────────────────────────────────────────────

/**
 * GVC 闭环单次执行结果
 */
export interface GvcResult<T> {
    /** 最终输出（验收通过或达到最大轮次） */
    output: T
    /** AgentResult 元数据 */
    agentResult: AgentResult<T>
    /** 验收裁决 */
    verdict: VerifyVerdict
    /** 最终得分 */
    finalScore: number
    /** 实际执行轮次（1 开始） */
    attempts: number
    /** 是否验收通过 */
    passed: boolean
    /** 各轮反馈历史（供可观测性） */
    feedbackHistory: string[]
}

/**
 * GVC 闭环选项
 */
export interface GvcOptions<T = unknown> {
    /** 最大重生成轮次，默认 3 */
    maxRounds?: number
    /** 通过分数阈值，默认 80 */
    passScore?: number
    /** 自定义验收维度（覆盖默认六维度） */
    verifyCriteria?: string[]
    /** 自定义反馈构建器（覆盖默认 buildCuratorFeedback） */
    feedbackBuilder?: typeof buildCuratorFeedback
    /**
     * 结构化输出 schema（可选）。
     *
     * 提供时，loop 在 Verifier 前用 `schema.safeParse(output)` 校验
     * Generator 的结构化输出，失败则记录原因并复用现有重试机制重生成
     * （复用 maxRounds 上限，不新造重试逻辑），杜绝幻觉字段。
     *
     * 不提供时走旧路径：仅由 Agent 自身 validateOutput + Verifier 验收
     * （向后兼容，零回归）。
     */
    schema?: StructuredOutputSchema<T>
}

/**
 * Generator-Verifier-Curator 闭环执行器
 *
 * 封装 Generator（生成 Agent）+ Verifier（验收 Agent）+ Curator（反馈构建）
 * 的三角协作流程。
 *
 * 流程：
 * 1. Generator 生成初始输出
 * 2. Verifier 独立验收，输出 verdict + issues
 * 3. 若 pass：返回输出
 * 4. 若 revise/reject：Curator 提炼反馈 → Generator 带反馈重生成 → 回到步骤 2
 * 5. 达到最大轮次仍不通过：返回最后一次输出（标记 warnings）
 */
export class GeneratorVerifierCurator {
    /**
     * 执行 GVC 闭环
     *
     * @param generator 生成 Agent（如 brush.question）
     * @param verifier 验收 Agent（如 mind.verify）
     * @param input 生成 Agent 的输入
     * @param ctx Agent 上下文
     * @param opts 闭环选项
     */
    async run<T>(
        generator: BaseAgent,
        verifier: BaseAgent,
        input: unknown,
        ctx: AgentContext,
        opts: GvcOptions<T> = {},
    ): Promise<GvcResult<T>> {
        const maxRounds = opts.maxRounds ?? 3
        const passScore = opts.passScore ?? 80
        const feedbackBuilder = opts.feedbackBuilder ?? buildCuratorFeedback
        const criteria = opts.verifyCriteria ?? []
        const schema = opts.schema

        const feedbackHistory: string[] = []
        let currentInput = input
        let lastResult: AgentResult<T> | undefined
        let lastVerdict: VerifyVerdict = 'reject'
        let lastScore = 0
        let lastIssues: VerifyIssue[] = []
        let lastOutput: T | undefined

        for (let attempt = 1; attempt <= maxRounds; attempt++) {
            // ── Generator：生成/重生成（schema 模式下捕获校验失败 → 重试） ──
            let schemaFailure: string | undefined

            if (schema) {
                // schema 模式：捕获 Agent 自身 validateOutput 抛出的 L1/L2 错误，
                // 并附加 loop 层 safeParse 校验（更严格的契约，杜绝幻觉字段）。
                try {
                    lastResult = (await generator.invoke(currentInput, ctx)) as AgentResult<T>
                    lastOutput = lastResult.output
                    const parsed = schema.safeParse(lastOutput)
                    if (!parsed.success) {
                        schemaFailure = formatZodError(parsed.error)
                    } else {
                        lastOutput = parsed.data
                    }
                } catch (err) {
                    // L1 JSON 解析 / L2 schema 校验失败 → 转为重试反馈
                    // L4 超时 / L5 服务不可用 → 不重试，向上抛出（交由 error-recovery）
                    const layer = classifyErrorLayer(err)
                    if (layer === 'L1' || layer === 'L2') {
                        schemaFailure = err instanceof Error ? err.message : String(err)
                    } else {
                        throw err
                    }
                }
            } else {
                // 旧路径：不捕获，保持向后兼容
                lastResult = (await generator.invoke(currentInput, ctx)) as AgentResult<T>
                lastOutput = lastResult.output
            }

            // ── schema 校验失败：记录原因并复用现有重试机制重生成 ──
            if (schemaFailure) {
                const schemaIssue: VerifyIssue = {
                    severity: 'high',
                    description: `结构化输出未通过 schema 校验：${schemaFailure}`,
                    suggestion: '请严格按 schema 定义的字段与类型输出，不得包含 schema 未声明的幻觉字段',
                }
                const feedback = `[第 ${attempt} 轮结构校验未通过] ${schemaFailure}\n请按 schema 重新输出，不输出未定义字段。`
                feedbackHistory.push(feedback)

                // 达到最大轮次：返回最后一次结果（带警告），与旧路径 maxRounds 行为一致
                if (attempt >= maxRounds) {
                    const warnResult: AgentResult<T> = {
                        agentId: lastResult?.agentId ?? generator.id,
                        output: lastOutput as T,
                        usage: lastResult?.usage ?? { promptTokens: 0, completionTokens: 0 },
                        latencyMs: lastResult?.latencyMs ?? 0,
                        promptVersion: lastResult?.promptVersion ?? 'unknown',
                        aiGenerated: true,
                        warnings: [
                            ...(lastResult?.warnings ?? []),
                            `GVC schema 校验在 ${maxRounds} 轮内未通过：${schemaFailure}`,
                        ],
                    }
                    return {
                        output: lastOutput as T,
                        agentResult: warnResult,
                        verdict: 'reject',
                        finalScore: 0,
                        attempts: attempt,
                        passed: false,
                        feedbackHistory,
                    }
                }

                // 注入反馈，进入下一轮重生成
                currentInput = this.injectFeedback(input, feedback, [schemaIssue], attempt + 1)
                continue
            }

            // 此处 lastResult 必已赋值（schema 失败已 continue/return，无 schema 路径直接赋值）
            if (!lastResult) {
                throw new Error('GVC 内部错误：Generator 未产出结果')
            }

            // ── Verifier：独立验收 ──
            const verifyInput = {
                targetAgentId: generator.id,
                targetOutput: lastOutput,
                originalInput: input,
                criteria,
            }
            const verifyResult = await verifier.invoke(verifyInput, ctx)
            const verifyOutput = verifyResult.output as {
                verdict: VerifyVerdict
                score: number
                issues: VerifyIssue[]
            }

            lastVerdict = verifyOutput.verdict
            lastScore = verifyOutput.score
            lastIssues = verifyOutput.issues ?? []

            // ── 通过：返回 ──
            if (lastVerdict === 'pass' || lastScore >= passScore) {
                const passedResult: AgentResult<T> = {
                    ...lastResult,
                    warnings: attempt > 1
                        ? [...(lastResult.warnings ?? []), `经 ${attempt} 轮 GVC 闭环验收通过`]
                        : lastResult.warnings,
                }
                return {
                    output: lastOutput as T,
                    agentResult: passedResult,
                    verdict: 'pass',
                    finalScore: lastScore,
                    attempts: attempt,
                    passed: true,
                    feedbackHistory,
                }
            }

            // ── Curator：构建反馈 ──
            const feedback = feedbackBuilder(lastVerdict, lastScore, lastIssues, attempt)
            feedbackHistory.push(feedback)

            // ── 达到最大轮次：返回最后一次输出（带警告） ──
            if (attempt >= maxRounds) {
                const warnResult: AgentResult<T> = {
                    ...lastResult,
                    warnings: [
                        ...(lastResult.warnings ?? []),
                        `GVC 闭环达到最大轮次 ${maxRounds}，最终裁决：${lastVerdict}（得分 ${lastScore}）`,
                    ],
                }
                return {
                    output: lastOutput as T,
                    agentResult: warnResult,
                    verdict: lastVerdict,
                    finalScore: lastScore,
                    attempts: attempt,
                    passed: false,
                    feedbackHistory,
                }
            }

            // ── 构建下一轮输入（带反馈） ──
            currentInput = this.injectFeedback(input, feedback, lastIssues, attempt + 1)
        }

        // 理论上不会到达此处，但 TypeScript 需要兜底
        throw new Error('GVC 闭环异常退出')
    }

    /**
     * 向生成输入注入反馈
     *
     * 策略：若输入为对象且含可注入字段，则附加 _regenerationFeedback；
     * 否则将 feedback 包装为新的输入对象。
     *
     * 子 Agent 的 buildUserPrompt 可识别 _regenerationFeedback 字段，
     * 调用 withRegenerationFeedback 注入反馈块。
     */
    private injectFeedback(
        originalInput: unknown,
        feedback: string,
        issues: VerifyIssue[],
        nextAttempt: number,
    ): unknown {
        if (originalInput && typeof originalInput === 'object') {
            return {
                ...(originalInput as Record<string, unknown>),
                _regenerationFeedback: feedback,
                _regenerationIssues: issues,
                _regenerationAttempt: nextAttempt,
            }
        }
        return {
            _originalInput: originalInput,
            _regenerationFeedback: feedback,
            _regenerationIssues: issues,
            _regenerationAttempt: nextAttempt,
        }
    }
}

/**
 * 便捷函数：执行 GVC 闭环
 *
 * 等同于 `new GeneratorVerifierCurator().run(...)`，
 * 适合一次性调用场景。
 */
export async function runGvcLoop<T>(
    generator: BaseAgent,
    verifier: BaseAgent,
    input: unknown,
    ctx: AgentContext,
    opts?: GvcOptions<T>,
): Promise<GvcResult<T>> {
    const gvc = new GeneratorVerifierCurator()
    return gvc.run<T>(generator, verifier, input, ctx, opts)
}

/**
 * 从 Agent 输入中提取重生成反馈（供子 Agent 的 buildUserPrompt 使用）
 *
 * 子 Agent 在 buildUserPrompt 中调用此函数，判断是否为 GVC 重生成轮次。
 * 若是，返回反馈信息；若否，返回 undefined。
 */
export function extractRegenerationFeedback(input: unknown): {
    feedback: string
    issues: VerifyIssue[]
    attempt: number
} | undefined {
    if (!input || typeof input !== 'object') return undefined
    const obj = input as Record<string, unknown>
    const feedback = obj['_regenerationFeedback']
    const issues = obj['_regenerationIssues']
    const attempt = obj['_regenerationAttempt']
    if (typeof feedback === 'string' && Array.isArray(issues) && typeof attempt === 'number') {
        return {
            feedback,
            issues: issues as VerifyIssue[],
            attempt,
        }
    }
    return undefined
}

/**
 * 构建带反馈的 User Prompt
 *
 * 供子 Agent 在 buildUserPrompt 中调用：若检测到重生成反馈，
 * 使用 withRegenerationFeedback 包装原 prompt。
 */
export function applyRegenerationFeedback(
    basePrompt: string,
    input: unknown,
): string {
    const regen = extractRegenerationFeedback(input)
    if (!regen) return basePrompt
    return withRegenerationFeedback(basePrompt, regen.feedback, regen.issues, regen.attempt)
}
