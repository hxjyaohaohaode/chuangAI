/**
 * 诗笔 Agent — 内容生成专家（主 Agent）
 *
 * 协调 4 个子 Agent，覆盖教学内容的生成闭环：
 * - question ：六阶命题（创造层，deepseek-v4-pro max 思考）
 * - grade    ：智能批改（评价层，deepseek-v4-flash low 思考）
 * - report   ：教研报告（创造层，deepseek-v4-pro high 思考）
 * - creative ：创意素材（创造层，deepseek-v4-flash medium 思考）
 *
 * 主模型：deepseek-v4-pro（协调决策），子 Agent 按路由矩阵各自选择最优模型。
 *
 * Loop Engineering 闭环：
 *   question → grade → report
 *   命题产出由 grade 批改验证，report 汇总数据反思，creative 提供素材支撑。
 *   验收环节由 mind.verify 独立完成（"自己不判自己的卷子"）。
 *
 * 本主 Agent 为协调者，不直接调用 LLM，而是组合调用子 Agent。
 */

import { QuestionSubAgent } from './question.sub-agent.js'
import { GradeSubAgent } from './grade.sub-agent.js'
import { ReportSubAgent } from './report.sub-agent.js'
import { CreativeSubAgent } from './creative.sub-agent.js'

export class BrushAgent {
    readonly id = 'brush'
    readonly name = '诗笔Agent'
    readonly description = '内容生成专家 — 六阶命题、智能批改、教研报告、创意素材'

    /** 六阶命题子 Agent — brush.question */
    readonly question = new QuestionSubAgent()

    /** 智能批改子 Agent — brush.grade */
    readonly grade = new GradeSubAgent()

    /** 教研报告子 Agent — brush.report */
    readonly report = new ReportSubAgent()

    /** 创意素材子 Agent — brush.creative */
    readonly creative = new CreativeSubAgent()
}

export { QuestionSubAgent } from './question.sub-agent.js'
export { GradeSubAgent, gradeOutputSchema } from './grade.sub-agent.js'
export { ReportSubAgent } from './report.sub-agent.js'
export { CreativeSubAgent } from './creative.sub-agent.js'
export type { QuestionInput, QuestionOutput, GradeLevel } from './question.sub-agent.js'
export type { GradeInput, GradeOutput } from './grade.sub-agent.js'
export type { ReportInput, ReportOutput, ReportSection } from './report.sub-agent.js'
export type { CreativeInput, CreativeOutput, CreativeType, CreativeGradeLevel } from './creative.sub-agent.js'
