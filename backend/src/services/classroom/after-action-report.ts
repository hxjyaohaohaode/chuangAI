/**
 * 课堂复盘报告服务（课堂指挥深化 Task 5）
 *
 * 课堂结束时自动生成复盘报告，包含：
 * 1. classInfo 课堂基本信息
 * 2. participation 参与度统计（含热力图）
 * 3. bloomCoverage Bloom 覆盖雷达
 * 4. difficultyAnalysis 难度分析
 * 5. aiSuggestionStats AI 建议采纳统计
 * 6. timeAllocation 时间分配
 * 7. improvementSuggestions 改进建议（deepseek-v4-pro 流式生成）
 *
 * 模型规格（大模型 API 文档）：
 * - deepseek-v4-pro：high 思考模式，生成改进建议
 * - 统计数据由本地计算，不依赖 LLM
 *
 * 数据来源：
 * - ClassroomRuntime：学生、作答、提示、讨论
 * - repos.lessons：课堂基本信息
 * - repos.poems：诗篇信息
 * - repos.classes：班级信息
 * - AISuggestionTracker：AI 建议采纳记录
 */

import { managedLLM } from '../../llm/index.js'
import type { ChatMessage } from '../../llm/types.js'
import { repos } from '../../db/index.js'
import type { ClassroomRuntime, StudentResponse } from '../../routes/classroom.js'
import type { Question } from '../../agents/base/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** Bloom 层级 */
type BloomLevel = '记忆' | '理解' | '应用' | '分析' | '评价' | '创造'

/** 难度分析项 */
export interface DifficultyAnalysisItem {
    questionId: string
    stemSummary: string
    bloomLevel: BloomLevel
    difficulty: number
    accuracy: number
    avgResponseSec: number
    needsReview: boolean
}

/** AI 建议采纳统计 */
export interface AISuggestionStats {
    feedbackCount: number
    supplementCount: number
    followupCount: number
    interventionCount: number
    adoptedCount: number
    adoptionRate: number
}

/** 时间分配项 */
export interface TimeAllocationItem {
    mode: string
    modeLabel: string
    durationSec: number
    ratio: number
}

/** 复盘报告数据 */
export interface AfterActionReportData {
    lessonId: string
    classInfo: {
        classId: string
        className: string
        poemId: string
        poemTitle: string
        poet: string
        startedAt: number
        endedAt: number
        durationSec: number
        mode: string
    }
    participation: {
        expectedCount: number
        actualCount: number
        rate: number
        heatmap: Array<{
            studentId: string
            studentName: string
            cells: number[]
        }>
    }
    bloomCoverage: Record<BloomLevel, number>
    difficultyAnalysis: DifficultyAnalysisItem[]
    aiSuggestionStats: AISuggestionStats
    timeAllocation: TimeAllocationItem[]
    improvementSuggestions: string
    aiGenerated: true
}

/** AI 建议记录（用于采纳统计） */
interface AISuggestionRecord {
    category: 'feedback' | 'supplement' | 'followup' | 'intervention'
    adopted: boolean
    createdAt: number
}

// ─────────────────────────────────────────────────────────────
// AI 建议采纳追踪器
// ─────────────────────────────────────────────────────────────

/**
 * 追踪每堂课的 AI 建议生成与采纳情况
 * lessonId -> AISuggestionRecord[]
 */
class AISuggestionTracker {
    private records = new Map<string, AISuggestionRecord[]>()

    /** 记录一条 AI 建议（默认未采纳） */
    record(lessonId: string, category: AISuggestionRecord['category']): void {
        const list = this.records.get(lessonId) ?? []
        list.push({ category, adopted: false, createdAt: Date.now() })
        this.records.set(lessonId, list)
    }

    /** 标记建议被采纳 */
    markAdopted(lessonId: string, category: AISuggestionRecord['category']): void {
        const list = this.records.get(lessonId)
        if (!list) return
        // 标记该类别最近一条未采纳的建议为已采纳
        for (let i = list.length - 1; i >= 0; i--) {
            const record = list[i]
            if (record && record.category === category && !record.adopted) {
                record.adopted = true
                break
            }
        }
    }

    /** 获取统计 */
    getStats(lessonId: string): AISuggestionStats {
        const list = this.records.get(lessonId) ?? []
        const feedbackCount = list.filter((r) => r.category === 'feedback').length
        const supplementCount = list.filter((r) => r.category === 'supplement').length
        const followupCount = list.filter((r) => r.category === 'followup').length
        const interventionCount = list.filter((r) => r.category === 'intervention').length
        const adoptedCount = list.filter((r) => r.adopted).length
        const total = list.length
        return {
            feedbackCount,
            supplementCount,
            followupCount,
            interventionCount,
            adoptedCount,
            adoptionRate: total > 0 ? adoptedCount / total : 0,
        }
    }

    /** 清理 */
    cleanup(lessonId: string): void {
        this.records.delete(lessonId)
    }
}

/** 全局 AI 建议追踪器单例 */
export const aiSuggestionTracker = new AISuggestionTracker()

// ─────────────────────────────────────────────────────────────
// 复盘报告生成器
// ─────────────────────────────────────────────────────────────

/**
 * 课堂复盘报告生成器
 *
 * generateReport：一次性生成完整报告（统计数据 + AI 改进建议）
 * streamImprovementSuggestions：流式生成改进建议（SSE）
 */
export class AfterActionReportGenerator {
    /** Bloom 六阶顺序 */
    private static readonly BLOOM_ORDER: BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造']

    /** Bloom 中文标签 */
    private static readonly BLOOM_LABELS: Record<string, string> = {
        'collective-race': '集体闯关',
        'speed-pk': '速答 PK',
        'flying-flower': '飞花令擂台',
        'six-level-immersive': '六阶沉浸课',
        'poem-wheel': '诗词大转盘',
        'poem-relay': '诗词接龙',
        'imagery-puzzle': '意境拼图',
    }

    /**
     * 生成完整复盘报告
     */
    async generateReport(runtime: ClassroomRuntime): Promise<AfterActionReportData> {
        const lessonId = runtime.lessonId
        const endedAt = runtime.endedAt ?? Date.now()
        const durationSec = Math.round((endedAt - runtime.startedAt) / 1000)

        // 课堂基本信息
        const classEntity = repos.classes.findById(runtime.classId)
        const poem = repos.poems.findById(runtime.poemId)

        // 汇总所有作答
        const allResponses: Array<StudentResponse & { questionId: string }> = []
        for (const [questionId, rs] of runtime.responses) {
            for (const r of rs) {
                allResponses.push({ ...r, questionId })
            }
        }

        // 参与度统计
        const expectedCount = classEntity?.studentCount ?? 0
        const actualCount = runtime.students.size
        const participationRate = expectedCount > 0 ? actualCount / expectedCount : 0

        // 参与度热力图
        const heatmap = this.buildHeatmap(runtime)

        // Bloom 覆盖
        const bloomCoverage = this.computeBloomCoverage(runtime.questions, allResponses)

        // 难度分析
        const difficultyAnalysis = this.computeDifficultyAnalysis(runtime, allResponses)

        // AI 建议统计
        const aiSuggestionStats = aiSuggestionTracker.getStats(lessonId)

        // 时间分配（简化：按模式分配总时长）
        const timeAllocation = this.computeTimeAllocation(runtime, durationSec)

        // 改进建议
        const improvementSuggestions = await this.generateImprovementSuggestions(
            runtime,
            allResponses,
            participationRate,
            bloomCoverage,
            difficultyAnalysis,
        )

        return {
            lessonId,
            classInfo: {
                classId: runtime.classId,
                className: classEntity?.name ?? '未知班级',
                poemId: runtime.poemId,
                poemTitle: poem?.title ?? '未知诗篇',
                poet: poem?.poet ?? '未知诗人',
                startedAt: runtime.startedAt,
                endedAt,
                durationSec,
                mode: runtime.mode,
            },
            participation: {
                expectedCount,
                actualCount,
                rate: participationRate,
                heatmap,
            },
            bloomCoverage,
            difficultyAnalysis,
            aiSuggestionStats,
            timeAllocation,
            improvementSuggestions,
            aiGenerated: true,
        }
    }

    /**
     * 非流式生成改进建议（供 generateReport 内部调用）
     * 收集 streamImprovementSuggestions 的全部分片后返回完整文本
     */
    private async generateImprovementSuggestions(
        runtime: ClassroomRuntime,
        allResponses: Array<StudentResponse & { questionId: string }>,
        participationRate: number,
        bloomCoverage: Record<BloomLevel, number>,
        difficultyAnalysis: DifficultyAnalysisItem[],
    ): Promise<string> {
        const messages = this.buildImprovementPrompt(
            runtime,
            allResponses,
            participationRate,
            bloomCoverage,
            difficultyAnalysis,
        )

        // 主模型
        try {
            let result = ''
            for await (const chunk of this.streamDeepseek(messages, 'deepseek-v4-pro', 'high')) {
                if (chunk.delta) result += chunk.delta
            }
            if (result) return result
        } catch (err) {
            console.warn('[after-action-report] 主模型失败，降级到 flash:', err)
        }

        // 降级模型
        try {
            let result = ''
            for await (const chunk of this.streamDeepseek(messages, 'deepseek-v4-flash', 'medium')) {
                if (chunk.delta) result += chunk.delta
            }
            if (result) return result
        } catch (err) {
            console.warn('[after-action-report] 降级模型失败，使用模板:', err)
        }

        // 模板降级
        return this.fallbackImprovement(runtime, allResponses, participationRate)
    }

    /**
     * 流式生成改进建议（SSE）
     */
    async *streamImprovementSuggestions(
        runtime: ClassroomRuntime,
    ): AsyncGenerator<{ delta?: string; done?: boolean }> {
        const allResponses: Array<StudentResponse & { questionId: string }> = []
        for (const [questionId, rs] of runtime.responses) {
            for (const r of rs) {
                allResponses.push({ ...r, questionId })
            }
        }

        const expectedCount = repos.classes.findById(runtime.classId)?.studentCount ?? 0
        const participationRate = expectedCount > 0 ? runtime.students.size / expectedCount : 0
        const bloomCoverage = this.computeBloomCoverage(runtime.questions, allResponses)
        const difficultyAnalysis = this.computeDifficultyAnalysis(runtime, allResponses)

        const messages = this.buildImprovementPrompt(
            runtime,
            allResponses,
            participationRate,
            bloomCoverage,
            difficultyAnalysis,
        )

        // 主模型
        try {
            yield* this.streamDeepseek(messages, 'deepseek-v4-pro', 'high')
            return
        } catch (err) {
            console.warn('[after-action-report] 主模型失败，降级到 flash:', err)
        }

        // 降级模型
        try {
            yield* this.streamDeepseek(messages, 'deepseek-v4-flash', 'medium')
            return
        } catch (err) {
            console.warn('[after-action-report] 降级模型失败，使用模板:', err)
        }

        // 模板降级
        const content = this.fallbackImprovement(runtime, allResponses, participationRate)
        const chunkSize = 20
        for (let i = 0; i < content.length; i += chunkSize) {
            yield { delta: content.slice(i, i + chunkSize), done: false }
        }
        yield { delta: '', done: true }
    }

    // ─────────────────────────────────────────────────────────
    // 统计计算方法
    // ─────────────────────────────────────────────────────────

    /**
     * 构建参与度热力图
     * 学生 × 题目，值为参与强度 0-1
     */
    private buildHeatmap(runtime: ClassroomRuntime): Array<{
        studentId: string
        studentName: string
        cells: number[]
    }> {
        const heatmap: Array<{ studentId: string; studentName: string; cells: number[] }> = []
        const questionCount = runtime.questions.length

        for (const [studentId, studentName] of runtime.students) {
            const cells: number[] = new Array(questionCount).fill(0)
            for (let qIdx = 0; qIdx < runtime.questions.length; qIdx++) {
                const question = runtime.questions[qIdx]
                if (!question) continue
                const responses = runtime.responses.get(question.id) ?? []
                const hasResponse = responses.some((r) => r.studentId === studentId)
                cells[qIdx] = hasResponse ? 1 : 0
            }
            heatmap.push({ studentId, studentName, cells })
        }

        return heatmap
    }

    /**
     * 计算 Bloom 覆盖
     * 返回每个 Bloom 层级的平均掌握度 0-100
     */
    private computeBloomCoverage(
        questions: Question[],
        allResponses: Array<StudentResponse & { questionId: string }>,
    ): Record<BloomLevel, number> {
        const coverage: Record<BloomLevel, number> = {
            记忆: 0, 理解: 0, 应用: 0, 分析: 0, 评价: 0, 创造: 0,
        }

        // 按题目 Bloom 层级统计正确率
        for (const question of questions) {
            const level = question.bloomLevel as BloomLevel
            if (!AfterActionReportGenerator.BLOOM_ORDER.includes(level)) continue

            const responses = allResponses.filter((r) => r.questionId === question.id)
            if (responses.length === 0) continue

            const correctCount = responses.filter((r) => r.correct).length
            const accuracy = correctCount / responses.length
            // 转为 0-100 分制
            coverage[level] = Math.round(accuracy * 100)
        }

        return coverage
    }

    /**
     * 计算难度分析
     */
    private computeDifficultyAnalysis(
        runtime: ClassroomRuntime,
        allResponses: Array<StudentResponse & { questionId: string }>,
    ): DifficultyAnalysisItem[] {
        const items: DifficultyAnalysisItem[] = []

        for (const question of runtime.questions) {
            const responses = allResponses.filter((r) => r.questionId === question.id)
            if (responses.length === 0) continue

            const correctCount = responses.filter((r) => r.correct).length
            const accuracy = responses.length > 0 ? correctCount / responses.length : 0

            // 平均响应时长
            const latencies = responses
                .map((r) => r.latencyMs)
                .filter((l): l is number => l !== undefined)
            const avgLatencyMs = latencies.length > 0
                ? latencies.reduce((sum, l) => sum + l, 0) / latencies.length
                : 0
            const avgResponseSec = Math.round(avgLatencyMs / 1000)

            items.push({
                questionId: question.id,
                stemSummary: question.stem.slice(0, 40) + (question.stem.length > 40 ? '...' : ''),
                bloomLevel: question.bloomLevel as BloomLevel,
                difficulty: question.difficulty,
                accuracy: Math.round(accuracy * 100) / 100,
                avgResponseSec,
                needsReview: accuracy < 0.5,
            })
        }

        // 按正确率升序（最难的在前）
        items.sort((a, b) => a.accuracy - b.accuracy)
        return items
    }

    /**
     * 计算时间分配
     * 简化版：按模式分配总时长（目前只支持单模式，未来支持多模式切换时扩展）
     */
    private computeTimeAllocation(runtime: ClassroomRuntime, durationSec: number): TimeAllocationItem[] {
        const modeLabel = AfterActionReportGenerator.BLOOM_LABELS[runtime.mode] ?? runtime.mode
        return [{
            mode: runtime.mode,
            modeLabel,
            durationSec,
            ratio: 1.0,
        }]
    }

    // ─────────────────────────────────────────────────────────
    // AI 改进建议生成
    // ─────────────────────────────────────────────────────────

    /**
     * 构建改进建议 prompt
     */
    private buildImprovementPrompt(
        runtime: ClassroomRuntime,
        allResponses: Array<StudentResponse & { questionId: string }>,
        participationRate: number,
        bloomCoverage: Record<BloomLevel, number>,
        difficultyAnalysis: DifficultyAnalysisItem[],
    ): ChatMessage[] {
        const correctCount = allResponses.filter((r) => r.correct).length
        const accuracy = allResponses.length > 0 ? correctCount / allResponses.length : 0

        const bloomSummary = AfterActionReportGenerator.BLOOM_ORDER
            .map((level) => `${level}: ${bloomCoverage[level]}%`)
            .join('、')

        const difficultySummary = difficultyAnalysis
            .slice(0, 5)
            .map((d) => `「${d.stemSummary}」正确率 ${(d.accuracy * 100).toFixed(0)}%`)
            .join('、')

        const poem = repos.poems.findById(runtime.poemId)

        return [
            {
                role: 'system',
                content: `你是古诗教学复盘专家，正在为教师生成课堂改进建议。基于课堂数据，给出具体、可操作的改进策略。

要求：
- 200-400 字
- 分 2-3 条具体建议
- 每条建议包含：问题诊断 + 改进策略 + 预期效果
- 聚焦教学策略优化，而非技术操作
- 语言专业但不晦涩，可直接用于教研讨论`,
            },
            {
                role: 'user',
                content: `课堂：《${poem?.title ?? ''}》· ${poem?.poet ?? ''}
模式：${AfterActionReportGenerator.BLOOM_LABELS[runtime.mode] ?? runtime.mode}
时长：${Math.round((runtime.endedAt ?? Date.now() - runtime.startedAt) / 60000)} 分钟
参与度：${runtime.students.size} 人参与，参与率 ${(participationRate * 100).toFixed(0)}%
正确率：${(accuracy * 100).toFixed(0)}%（${correctCount}/${allResponses.length}）
Bloom 覆盖：${bloomSummary}
难点题目：${difficultySummary}
认知负荷峰值：${runtime.cognitiveLoad}
启发提示推送：${runtime.hintsDelivered} 次

请生成课堂改进建议：`,
            },
        ]
    }

    /**
     * 调用 DeepSeek 流式接口
     */
    private async *streamDeepseek(
        messages: ChatMessage[],
        model: 'deepseek-v4-pro' | 'deepseek-v4-flash',
        thinking: 'low' | 'medium' | 'high' | 'max',
    ): AsyncGenerator<{ delta?: string; done?: boolean }> {
        const stream = managedLLM.stream({
            model,
            messages,
            thinking,
            temperature: 0.6,
            maxTokens: 2048,
            metadata: {
                agent: 'after-action-report',
                task: `improvement-suggestions-${model}`,
            },
        })

        let hasContent = false
        for await (const chunk of stream) {
            if (chunk.content) {
                hasContent = true
                yield { delta: chunk.content, done: false }
            }
        }

        if (!hasContent) {
            throw new Error('流式响应无内容')
        }

        yield { delta: '', done: true }
    }

    /**
     * 模板降级：改进建议
     */
    private fallbackImprovement(
        runtime: ClassroomRuntime,
        allResponses: Array<StudentResponse & { questionId: string }>,
        participationRate: number,
    ): string {
        const correctCount = allResponses.filter((r) => r.correct).length
        const accuracy = allResponses.length > 0 ? correctCount / allResponses.length : 0

        const suggestions: string[] = []

        if (participationRate < 0.7) {
            suggestions.push(`1. 参与度偏低（${(participationRate * 100).toFixed(0)}%），建议优化课堂互动机制，增加抽签与 PK 环节激发参与。`)
        }
        if (accuracy < 0.6) {
            suggestions.push(`2. 正确率仅 ${(accuracy * 100).toFixed(0)}%，建议针对错误率高的题目进行专项讲解，并推送脚手架式提示降低难度。`)
        }
        if (runtime.cognitiveLoad > 70) {
            suggestions.push(`3. 认知负荷峰值较高（${runtime.cognitiveLoad}），建议放缓教学节奏，增加朗读与讨论环节缓解负荷。`)
        }
        if (suggestions.length === 0) {
            suggestions.push('1. 课堂整体表现良好，建议继续保持当前节奏，适时引入更高阶层的教学内容挑战学生。')
            suggestions.push('2. 可尝试引入飞花令或速答 PK 模式，进一步激发课堂活跃度。')
        }

        return suggestions.join('\n')
    }
}

/** 全局单例 */
export const afterActionReportGenerator = new AfterActionReportGenerator()
