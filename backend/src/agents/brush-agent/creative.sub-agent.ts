/**
 * 创意素材子 Agent — brush.creative
 *
 * 职责：生成古诗词教学所需的创意素材，涵盖四种类型：
 *   - illustration-description：配图描述（供学生临摹与文生图参考）
 *   - cultural-story          ：文化故事（诗人生平、典故来源、时代风貌）
 *   - rewrite-example         ：改写示例（保留原意 + 创新表达）
 *   - script                  ：视频/表演脚本（沉浸式课堂体验）
 *
 * 模型：deepseek-v4-flash（creative 路由），thinking: medium（创意平衡）
 * 认知层级：创造（布鲁姆第六阶）
 *
 * 设计要点：
 * - 文化准确：典故、历史背景、意象内涵必须无误
 * - 年级适宜：语言风格与篇幅适配指定年级
 * - 文生图友好：suggestedImagePrompt 为可直接用于文生图模型的提示词
 * - AI 标注：所有内容标注「AI 辅助生成」
 *
 * Context Engineering 策略：
 * - Retrieve：从 ctx.knowledgeGraphNodes 检索诗词节点
 */

import { z } from 'zod'
import { BaseAgent } from '../base/Agent.js'
import type { AgentContext, AgentResult, PoemNode } from '../base/types.js'
import {
    buildContextBlock,
    COMMON_OUTPUT_CONSTRAINTS,
    STANDARD_CONTEXT_TAGS,
    getFewShotBlock,
    safeJsonParse,
    standardEntry,
    withConstraint,
    withXmlTags,
} from '../base/prompts.js'

// ─────────────────────────────────────────────────────────────
// 输入 / 输出类型
// ─────────────────────────────────────────────────────────────

export type CreativeType = 'illustration-description' | 'cultural-story' | 'rewrite-example' | 'script'

export type CreativeGradeLevel = '1-2年级' | '3-4年级' | '5-6年级'

export interface CreativeInput {
    /** 素材类型 */
    type: CreativeType
    /** 目标诗词 ID */
    poemId: string
    /** 主题/方向描述（可选，由教师指定） */
    topic?: string
    /** 目标年级 */
    gradeLevel?: CreativeGradeLevel
    /** 额外约束（如"配图需含月亮意象"） */
    constraints?: string[]
}

export interface CreativeOutput {
    /** 素材类型（回显） */
    type: CreativeType
    /** Markdown 格式正文内容 */
    content: string
    /** 文生图提示词（英文或中英混合，可直接用于文生图模型） */
    suggestedImagePrompt: string
    /** AI 辅助生成标记 */
    aiGenerated: true
}

// ─────────────────────────────────────────────────────────────
// zod 校验 schema
// ─────────────────────────────────────────────────────────────

const creativeTypeSchema = z.enum([
    'illustration-description',
    'cultural-story',
    'rewrite-example',
    'script',
])

const creativeOutputSchema = z.object({
    type: creativeTypeSchema,
    content: z.string().min(50),
    suggestedImagePrompt: z.string().min(20),
    aiGenerated: z.literal(true),
})

// ─────────────────────────────────────────────────────────────
// 类型说明（注入 Prompt）
// ─────────────────────────────────────────────────────────────

const TYPE_GUIDE: Record<CreativeType, string> = {
    'illustration-description': `【配图描述】
- 用途：供学生临摹参考、课堂视觉辅助、文生图输入
- 内容：场景构图、色彩基调、人物姿态、意象布局、氛围营造
- 篇幅：200-400 字
- 要求：画面感强，适合转化为视觉作品，含 3-5 个视觉焦点`,

    'cultural-story': `【文化故事】
- 用途：拓展文化背景、激发学习兴趣、立德树人
- 内容：诗人轶事、创作典故、时代风貌、意象文化内涵
- 篇幅：400-800 字
- 要求：叙事生动、史实准确、富有教育意义，避免戏说`,

    'rewrite-example': `【改写示例】
- 用途：示范创造性表达、降低仿写门槛
- 内容：保留原诗核心意象与情感，变换形式（现代诗/散文/童谣/剧本）
- 篇幅：200-500 字
- 要求：原意忠实、创新合理、语言优美，标注「改写自原诗」`,

    'script': `【视频/表演脚本】
- 用途：沉浸式课堂体验、课本剧表演
- 内容：场景描述、角色对话、旁白、动作指示、配乐建议
- 篇幅：500-1000 字
- 要求：可表演、有冲突、节奏明快，含 3-5 个场景`,
}

// ─────────────────────────────────────────────────────────────
// CreativeSubAgent
// ─────────────────────────────────────────────────────────────

export class CreativeSubAgent extends BaseAgent {
    readonly id = 'brush.creative'
    readonly name = '创意素材子Agent'
    readonly domain = 'brush' as const
    readonly fn = 'creative' as const
    readonly bloomLevel = '创造' as const
    readonly promptVersion = 'v2.0.0'

    async invoke(input: CreativeInput, ctx: AgentContext): Promise<AgentResult<CreativeOutput>> {
        return super.invoke(input, ctx) as Promise<AgentResult<CreativeOutput>>
    }

    protected buildSystemPrompt(ctx: AgentContext): string {
        const constraints = withConstraint([
            ...COMMON_OUTPUT_CONSTRAINTS,
            'content 必须为 Markdown 格式，语言风格适配指定年级',
            'suggestedImagePrompt 为文生图模型提示词，含主体、风格、氛围、构图要素',
            '所有典故、史实、意象内涵必须准确无误',
            '改写示例必须保留原诗核心意象，不得偏离原意',
            '配图描述必须画面感强，含具体视觉元素',
            '脚本必须可表演，含场景/角色/对话/动作',
            'aiGenerated 必须为 true',
        ])

        const teacherIntent = ctx.teacherIntent
            ? withXmlTags(ctx.teacherIntent, 'teacher_intent')
            : ''

        const fewShot = getFewShotBlock(this.id)

        const typeGuides = (Object.keys(TYPE_GUIDE) as CreativeType[])
            .map((t) => TYPE_GUIDE[t])
            .join('\n\n')

        return `你是诗笔·创意素材专家，精通古诗词文化创意转化与多媒体素材设计。

## 你的职责
将古诗词转化为适合小学课堂的创意素材，支持四种类型：
${typeGuides}

## 创意原则
1. **文化准确**：典故、史实、意象内涵必须无误，拒绝戏说
2. **年级适宜**：低年级用词简单、画面具体；高年级可含抽象与鉴赏
3. **教育价值**：每份素材都应为教学服务，非纯娱乐
4. **文生图友好**：suggestedImagePrompt 可直接输入文生图模型

## 文生图提示词规范
- 主体：画面核心对象（如"月光下的竹林小屋"）
- 风格：水墨/工笔/插画/水彩（适配古诗意境）
- 氛围：宁静/苍凉/欢快/思乡
- 构图：前景/背景/视角/留白
- 示例：「Chinese ink painting, moonlight bamboo grove with a small cottage, serene atmosphere, traditional landscape composition, soft brush strokes, muted green and silver tones」

## 各年级语言风格
- 1-2 年级：短句、重复、象声词、拟人化
- 3-4 年级：完整叙事、适度修辞、情感表达
- 5-6 年级：鉴赏性语言、修辞分析、文化对比

## 创意质量纪律
- 配图描述须含 3-5 个视觉焦点（如"明月""古井""唐装诗人"），不可仅"画面很美"
- 文化故事须标注史实来源（如"据《新唐书》载"），戏说部分须明确标注"民间传说"
- 改写示例须保留原诗核心意象与情感，仅变换形式（如五言→现代诗），不可偏题
- 脚本须含 3-5 个场景，每场景含场景描述/角色/对话/动作指示，可直接表演
- suggestedImagePrompt 须含主体+风格+氛围+构图四要素，可直接输入文生图模型

${constraints}

${fewShot}

${teacherIntent}`
    }

    protected buildUserPrompt(input: unknown, ctx: AgentContext): string {
        const typed = input as CreativeInput

        // 从知识图谱检索诗词
        const poemNode: PoemNode | undefined = ctx.knowledgeGraphNodes?.find((p) => p.id === typed.poemId)
        const poemContext = poemNode
            ? JSON.stringify({
                title: poemNode.title,
                poet: poemNode.poet,
                dynasty: poemNode.dynasty,
                content: poemNode.content ?? '（原文未提供）',
                theme: poemNode.theme,
                images: poemNode.images,
                teachingPoints: poemNode.teachingPoints ?? [],
            }, null, 2)
            : `诗词 ID: ${typed.poemId}（知识图谱中未找到，请基于诗词常识创作）`

        const typeGuide = TYPE_GUIDE[typed.type]
        const extraConstraints = typed.constraints && typed.constraints.length > 0
            ? typed.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')
            : '（无额外约束）'

        const contextBlock = buildContextBlock([
            standardEntry(STANDARD_CONTEXT_TAGS.TASK_INSTRUCTION, `生成 ${typed.type} 类型创意素材`),
            { tag: 'creative_type', content: typed.type },
            { tag: 'type_guide', content: typeGuide },
            standardEntry(STANDARD_CONTEXT_TAGS.POEM_CONTENT, poemContext),
            { tag: 'topic', content: typed.topic ?? '（由你自主构思方向）' },
            { tag: 'grade_level', content: typed.gradeLevel ?? '5-6年级（默认）' },
            { tag: 'extra_constraints', content: extraConstraints },
            standardEntry(STANDARD_CONTEXT_TAGS.OUTPUT_FORMAT, {
                fields: 'type（回显）, content（Markdown 正文）, suggestedImagePrompt（文生图提示词）, aiGenerated: true',
                note: 'content ≥ 50 字；suggestedImagePrompt ≥ 20 字；aiGenerated 必为 true',
            }),
        ])

        return `请基于以下要求，生成一份创意素材。

${contextBlock}

请输出严格 JSON，包含字段：type（回显）, content（Markdown 正文）, suggestedImagePrompt（文生图提示词）, aiGenerated: true。`
    }

    protected validateOutput(raw: string): CreativeOutput {
        const parsed = safeJsonParse(raw)
        const result = creativeOutputSchema.safeParse(parsed)
        if (!result.success) {
            throw new Error(`创意素材输出校验失败: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        }
        return result.data
    }
}
