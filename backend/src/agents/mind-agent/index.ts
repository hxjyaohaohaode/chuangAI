/**
 * 诗心 Agent — 认知诊断专家（主 Agent）
 *
 * 协调 4 个子 Agent，构成完整的认知诊断闭环：
 * - profile    ：学情画像（分析层）
 * - diagnose   ：认知诊断（评价层）
 * - recommend  ：路径推荐（应用层）
 * - verify     ：独立验收（评价层）
 *
 * 主模型：deepseek-v4-pro（协调决策），子 Agent 按路由矩阵各自选择最优模型。
 *
 * Loop Engineering 闭环：
 *   profile → diagnose → recommend → verify
 *   每个生成环节的产出可由 verify 子 Agent 独立验收，确保"自己不判自己的卷子"。
 *
 * 本主 Agent 为协调者，不直接调用 LLM，而是组合调用子 Agent。
 */

import { ProfileSubAgent } from './profile.sub-agent.js'
import { DiagnoseSubAgent } from './diagnose.sub-agent.js'
import { RecommendSubAgent } from './recommend.sub-agent.js'
import { VerifySubAgent } from './verify.sub-agent.js'

export class MindAgent {
    readonly id = 'mind'
    readonly name = '诗心Agent'
    readonly description = '认知诊断专家 — 学情画像、认知暗物质识别、路径推荐与独立验收'

    /** 学情画像子 Agent — mind.profile */
    readonly profile = new ProfileSubAgent()

    /** 认知诊断子 Agent — mind.diagnose */
    readonly diagnose = new DiagnoseSubAgent()

    /** 学习路径推荐子 Agent — mind.recommend */
    readonly recommend = new RecommendSubAgent()

    /** 独立验收子 Agent — mind.verify */
    readonly verify = new VerifySubAgent()
}

export { ProfileSubAgent } from './profile.sub-agent.js'
export { DiagnoseSubAgent } from './diagnose.sub-agent.js'
export { RecommendSubAgent } from './recommend.sub-agent.js'
export { VerifySubAgent } from './verify.sub-agent.js'
export type { ProfileInput, ProfileOutput } from './profile.sub-agent.js'
export type { DiagnoseInput } from './diagnose.sub-agent.js'
export type { RecommendInput, RecommendOutput, RecommendPathStep } from './recommend.sub-agent.js'
export type { VerifyInput, VerifyOutput } from './verify.sub-agent.js'
