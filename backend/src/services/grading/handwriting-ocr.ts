/**
 * 手写识别服务（批改诊断深化能力 2/5）
 *
 * 职责：使用 mimo-v2.5 多模态模型识别学生手写答题图片，
 * 输出识别文本 + 整体置信度 + 逐字置信度 + 可疑字标记。
 *
 * 模型：mimo-v2.5（多模态，支持图片输入）+ thinking: high
 *
 * 设计要点：
 * - 经显式模型托管网关调用，传入 images 触发多模态识别并统一限流/计费
 * - JSON Output 模式确保结构化输出（mimo 通过 prompt 约束，非 response_format）
 * - 可疑字标记：置信度 < 0.6 的字符标记为 suspicious，供前端高亮
 * - 批量识别：支持多图并行识别，控制并发避免限流
 * - 失败降级：返回空文本 + 低置信度 + 全文标记可疑
 *
 * 与现有 eyeAgent.visionAnnotate 的区别：
 * - visionAnnotate 侧重"视觉描述"（场景、物体、氛围）
 * - handwriting-ocr 侧重"文字转录"（逐字识别 + 置信度 + 可疑标记）
 * - 本服务输出更适合批改流程的精确文本需求
 */

import { z } from 'zod'
import { managedLLM } from '../../llm/index.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 单字识别结果（含置信度） */
export interface CharRecognition {
    /** 识别出的字符 */
    char: string
    /** 该字符的识别置信度 0-1 */
    confidence: number
    /** 是否为可疑字（confidence < SUSPICIOUS_THRESHOLD） */
    suspicious: boolean
    /** 可疑原因（如"字形模糊""与上下文不符""疑似错别字"） */
    reason?: string
}

/** 手写识别输入 */
export interface HandwritingOcrInput {
    /** 受控图片引用：公开路由只接受魔数匹配的内联 JPEG/PNG/WebP。 */
    imageUrl: string
    /** 图片 detail 级别（默认 high） */
    detail?: 'auto' | 'low' | 'high'
    /** 题目上下文（可选，提升识别精度，如"这是关于《静夜思》的默写题"） */
    context?: string
    /** 预期答案范围（可选，如"5-7 个字的诗句"） */
    expectedRange?: string
}

/** 手写识别输出 */
export interface HandwritingOcrOutput {
    /** 完整识别文本 */
    text: string
    /** 整体置信度 0-1 */
    confidence: number
    /** 逐字识别结果 */
    chars: CharRecognition[]
    /** 可疑字数量 */
    suspiciousCount: number
    /** 可疑字索引列表（在 chars 数组中的位置） */
    suspiciousIndices: number[]
    /** 识别备注（如"图片模糊""存在涂改"） */
    notes: string
    /** 是否需要人工核对 */
    needsManualCheck: boolean
    /** AI 生成标记 */
    aiGenerated: true
}

/** 批量识别输入 */
export interface BatchOcrInput {
    /** 多张图片 */
    items: HandwritingOcrInput[]
    /** 并发数（默认 2，mimo-v2.5 限流较严） */
    concurrency?: number
}

/** 批量识别输出 */
export interface BatchOcrOutput {
    results: HandwritingOcrOutput[]
    totalCount: number
    successCount: number
    failedCount: number
    aiGenerated: true
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 可疑字置信度阈值 */
const SUSPICIOUS_THRESHOLD = 0.6

/** 需人工核对的置信度阈值 */
const MANUAL_CHECK_THRESHOLD = 0.5

// ─────────────────────────────────────────────────────────────
// Zod 校验 schema
// ─────────────────────────────────────────────────────────────

const charSchema = z.object({
    char: z.string(),
    confidence: z.number().min(0).max(1),
    suspicious: z.boolean(),
    reason: z.string().optional(),
})

const ocrOutputSchema = z.object({
    text: z.string(),
    confidence: z.number().min(0).max(1),
    chars: z.array(charSchema),
    suspiciousCount: z.number().int().min(0),
    suspiciousIndices: z.array(z.number().int().min(0)),
    notes: z.string(),
    needsManualCheck: z.boolean(),
    aiGenerated: z.literal(true),
})

// ─────────────────────────────────────────────────────────────
// HandwritingOcrService 服务
// ─────────────────────────────────────────────────────────────

/**
 * 手写识别服务
 *
 * 使用 mimo-v2.5 多模态模型识别手写答题图片。
 * 单例模式，全局共享。
 */
export class HandwritingOcrService {
    private static instance: HandwritingOcrService | null = null

    static getInstance(): HandwritingOcrService {
        if (!HandwritingOcrService.instance) {
            HandwritingOcrService.instance = new HandwritingOcrService()
        }
        return HandwritingOcrService.instance
    }

    /**
     * 识别单张手写图片
     *
     * @param input 识别输入（图片 URL + 可选上下文）
     * @returns 识别结果（含逐字置信度与可疑字标记）
     */
    async recognize(input: HandwritingOcrInput): Promise<HandwritingOcrOutput> {
        const messages = this.buildMessages(input)

        const result = await managedLLM.chat({
            model: 'mimo-v2.5',
            thinking: 'high',
            temperature: 0.2,
            maxTokens: 4096,
            messages,
            images: [{
                url: input.imageUrl,
                detail: input.detail ?? 'high',
            }],
            metadata: {
                agent: 'handwriting-ocr',
                task: 'ocr',
            },
        })

        return this.parseAndValidate(result.content)
    }

    /**
     * 批量识别多张手写图片
     *
     * @param input 批量识别输入
     * @returns 批量识别结果
     */
    async batchRecognize(input: BatchOcrInput): Promise<BatchOcrOutput> {
        const concurrency = Math.max(1, Math.min(5, input.concurrency ?? 2))
        const results: HandwritingOcrOutput[] = []
        let successCount = 0
        let failedCount = 0

        for (let i = 0; i < input.items.length; i += concurrency) {
            const batch = input.items.slice(i, i + concurrency)
            const batchResults = await Promise.all(
                batch.map((item) =>
                    this.recognize(item)
                        .then((res) => {
                            successCount++
                            return res
                        })
                        .catch((err) => {
                            failedCount++
                            return this.fallback(item, err)
                        }),
                ),
            )
            results.push(...batchResults)
        }

        return {
            results,
            totalCount: results.length,
            successCount,
            failedCount,
            aiGenerated: true,
        }
    }

    // ─────────────────────────────────────────────────────────
    // 内部方法
    // ─────────────────────────────────────────────────────────

    /** 构建对话消息 */
    private buildMessages(input: HandwritingOcrInput): { role: 'system' | 'user'; content: string }[] {
        const systemPrompt = this.buildSystemPrompt()
        const userPrompt = this.buildUserPrompt(input)
        return [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ]
    }

    /** 构建 system prompt */
    private buildSystemPrompt(): string {
        return `你是古诗词手写识别专家，精通小学生手写体识别与中文 OCR 校对。

## 你的职责
识别图片中学生手写的古诗词答题内容，输出：
1. 完整识别文本（保持原文顺序，含标点）
2. 整体置信度（0-1）
3. 逐字识别结果（每个字的置信度）
4. 可疑字标记（置信度 < 0.6 的字）
5. 识别备注（如"图片模糊""存在涂改""字迹倾斜"）

## 识别纪律
- 保持原文顺序，不自动纠正错别字（错别字也需如实识别）
- 标点符号纳入识别范围（如句号、逗号、顿号）
- 涂改处识别最终版本（若可辨认），否则标记为可疑
- 模糊字基于上下文推测时，confidence 应 ≤ 0.7
- 完全无法辨认的字用"□"占位，confidence = 0，suspicious = true
- 整体 confidence < 0.5 时 needsManualCheck = true

## 输出格式（严格 JSON）
{
  "text": "完整识别文本",
  "confidence": 0.85,
  "chars": [
    {"char": "静", "confidence": 0.95, "suspicious": false},
    {"char": "夜", "confidence": 0.6, "suspicious": true, "reason": "字形模糊"},
    {"char": "思", "confidence": 0.9, "suspicious": false}
  ],
  "suspiciousCount": 1,
  "suspiciousIndices": [1],
  "notes": "字迹清晰，无涂改",
  "needsManualCheck": false,
  "aiGenerated": true
}`
    }

    /** 构建 user prompt */
    private buildUserPrompt(input: HandwritingOcrInput): string {
        const context = input.context ? `\n<context>${input.context}</context>` : ''
        const expected = input.expectedRange
            ? `\n<expected_range>${input.expectedRange}</expected_range>`
            : ''

        return `请识别图片中学生手写的答题内容。${context}${expected}

请输出严格 JSON，包含 text、confidence、chars、suspiciousCount、suspiciousIndices、notes、needsManualCheck、aiGenerated 字段。`
    }

    /** 解析与校验 LLM 输出 */
    private parseAndValidate(raw: string): HandwritingOcrOutput {
        let parsed: unknown
        try {
            // mimo 可能返回带 ```json 包裹的内容，尝试提取
            const jsonStr = this.extractJson(raw)
            parsed = JSON.parse(jsonStr)
        } catch {
            throw new Error(`手写识别输出 JSON 解析失败: ${raw.slice(0, 200)}`)
        }

        const result = ocrOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(
                `手写识别输出校验失败: ${result.error.issues
                    .map((i) => `${i.path.join('.')}: ${i.message}`)
                    .join('; ')}`,
            )
        }

        // 二次校验：置信度低于阈值的字符强制标记为 suspicious（修正 LLM 漏标）
        for (const c of result.data.chars) {
            if (c.confidence < SUSPICIOUS_THRESHOLD && !c.suspicious) {
                c.suspicious = true
                if (!c.reason) {
                    c.reason = `置信度 ${c.confidence.toFixed(2)} 低于阈值 ${SUSPICIOUS_THRESHOLD}，自动标记可疑`
                }
            }
        }

        // 二次校验：suspiciousCount 与 chars 中 suspicious=true 的数量一致
        const suspiciousChars = result.data.chars.filter((c) => c.suspicious)
        if (suspiciousChars.length !== result.data.suspiciousCount) {
            result.data.suspiciousCount = suspiciousChars.length
        }
        // 重建 suspiciousIndices
        result.data.suspiciousIndices = result.data.chars
            .map((c, idx) => (c.suspicious ? idx : -1))
            .filter((idx) => idx >= 0)

        // 二次校验：needsManualCheck 与整体置信度一致
        if (result.data.confidence < MANUAL_CHECK_THRESHOLD) {
            result.data.needsManualCheck = true
        }

        return result.data
    }

    /** 从可能含 markdown 代码块的文本中提取 JSON */
    private extractJson(raw: string): string {
        const trimmed = raw.trim()
        // 尝试提取 ```json ... ``` 代码块
        const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
        if (codeBlockMatch && codeBlockMatch[1]) {
            return codeBlockMatch[1].trim()
        }
        // 尝试提取第一个 { ... } 块
        const startIdx = trimmed.indexOf('{')
        const endIdx = trimmed.lastIndexOf('}')
        if (startIdx >= 0 && endIdx > startIdx) {
            return trimmed.slice(startIdx, endIdx + 1)
        }
        return trimmed
    }

    /** 降级输出（LLM 失败时） */
    private fallback(input: HandwritingOcrInput, err: unknown): HandwritingOcrOutput {
        const errMsg = err instanceof Error ? err.message : String(err)
        return {
            text: '',
            confidence: 0,
            chars: [],
            suspiciousCount: 0,
            suspiciousIndices: [],
            notes: `识别失败：${errMsg.slice(0, 80)}。请人工查看图片：${input.imageUrl.slice(0, 50)}...`,
            needsManualCheck: true,
            aiGenerated: true,
        }
    }
}

/** 全局单例 */
export const handwritingOcr = HandwritingOcrService.getInstance()
