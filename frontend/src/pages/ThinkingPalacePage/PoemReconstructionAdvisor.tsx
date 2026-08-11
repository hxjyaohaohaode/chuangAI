/**
 * 诗篇重构 AI 顾问（v5.0 SubTask 27.4）
 *
 * 职责：
 *  - 调用 POST /api/ai/chat（deepseek-v4-pro，thinking_mode: medium，流式）
 *  - 多版本对比：原诗 vs 学生重构 vs AI 建议版本
 *  - AI 智能点评：流式输出总体评价（StreamText 打字机效果 + 光标脉动 + 中断/继续）
 *  - 改进建议卡片：解析 AI 输出中的建议项，渲染为 3-5 张卡片网格
 *  - 多版本对比表：并排显示三版本，逐字高亮差异（LCS 算法）
 *
 * 设计规范合规（规范第 2、4、6、9、11、14 章）：
 *  - 零硬编码色值：全部使用 rgb(var(--c-xxx) / alpha) 语法
 *  - 无 1px 实色边框：透明度分层 + backdrop-blur + 负空间
 *  - 流体尺寸：clamp() 控制字号/间距/宽度
 *  - 玻璃态面板：surface-elevated + backdrop-blur(20px)
 *  - transform/opacity 动画：不触发 Layout
 *  - prefers-reduced-motion 降级：StreamText 内部已处理
 *  - 流式输出体验：光标 + 打字机 + 中断/继续（规范 11.1）
 *  - 卡片式展示：每条建议一张卡片（规范 14.3 卡片规格）
 *
 * 模型约束（《大模型API文档.md》）：
 *  - 仅使用 deepseek-v4-pro（thinking_mode: medium）
 *  - 1M 上下文 + 384K 输出，足够支持长诗重构
 *  - 支持流式 SSE
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { toast } from '@/stores/toast'
import { logError } from '@/lib/errors'
import { useDemoModeStore, isDemoMode } from '@/lib/demo-mode'
import { Icon } from '@/components/ui/Icon'
import { StreamText } from '@/components/ui/StreamText'
import { Combobox, type ComboboxOption } from '@/components/ui'
import { QuickVoiceAssist } from '@/components/ui/QuickVoiceAssist'
import { useCultureStore } from '@/stores/culture'
import {
    beginAsyncGeneration,
    invalidateAsyncGeneration,
    isAsyncGenerationCurrent,
    type AsyncGenerationToken,
} from '@/lib/async-generation'
import type {
    AiChatStreamController,
    AiChatStreamChunk,
    CulturePoem,
} from '@/lib/types'

/* ============================================================
 * 常量
 * ============================================================ */

/** AI 模型 —— 仅使用 deepseek-v4-pro（规范第 5 章） */
const AI_MODEL = 'deepseek-v4-pro'

/** 思考模式 —— medium 平衡速度与质量 */
const AI_THINKING_MODE = 'medium' as const

/** 流式采样温度 —— 0.7 平衡创造性 vs 稳定性 */
const AI_TEMPERATURE = 0.7

/** 最大输出 tokens —— 8K 足够 3-5 条建议 + 重构版本 */
const AI_MAX_TOKENS = 8192

/** 预设重构风格 */
type RewriteStyle = 'modern' | 'classical' | 'imagist' | 'free'

/** 风格选项 */
const STYLE_OPTIONS: ComboboxOption[] = [
    { value: 'modern', label: '现代白话重构' },
    { value: 'classical', label: '古典雅韵重构' },
    { value: 'imagist', label: '意象派重构' },
    { value: 'free', label: '自由创作重构' },
]

/** 重构角度 */
type RewriteAngle = 'imagery' | 'emotion' | 'structure' | 'rhythm'

/** 角度选项 */
const ANGLE_OPTIONS: ComboboxOption[] = [
    { value: 'imagery', label: '意象替换' },
    { value: 'emotion', label: '情感转化' },
    { value: 'structure', label: '结构重组' },
    { value: 'rhythm', label: '韵律再造' },
]

const CREATIVE_STARTERS = [
    '我眼前仿佛出现……',
    '如果我站在诗人的位置……',
    '风吹过……',
    '月光落在……',
] as const

/* ============================================================
 * 类型
 * ============================================================ */

/** 解析后的 AI 输出结构 */
interface ParsedAdvisorOutput {
    /** 总体点评 */
    critique: string
    /** 改进建议列表 */
    suggestions: Array<{
        title: string
        detail: string
    }>
    /** AI 重构示范 */
    rewrite: string
}

/* ============================================================
 * 工具函数
 * ============================================================ */

/**
 * 构建系统提示词（让 AI 输出可解析的结构化 markdown）
 *
 * 输出格式约定：
 * ```
 * ## 总体点评
 * （一段总体评价，200-400字）
 *
 * ## 改进建议
 * ### 建议 1：标题
 * 具体说明 80-150 字
 *
 * ### 建议 2：标题
 * ...
 *
 * ## 重构示范
 * （AI 给出的完整重构版本，独立成段）
 * ```
 */
function buildSystemPrompt(poem: CulturePoem, style: RewriteStyle, angle: RewriteAngle): string {
    const styleDesc: Record<RewriteStyle, string> = {
        modern: '现代白话文，通俗易懂',
        classical: '古典诗词语言，保持雅致',
        imagist: '意象派风格，重视画面感',
        free: '自由创作，突破格律',
    }
    const angleDesc: Record<RewriteAngle, string> = {
        imagery: '意象替换（保留情感，更换景物）',
        emotion: '情感转化（同一景物，转换情绪）',
        structure: '结构重组（重新组织叙事顺序）',
        rhythm: '韵律再造（调整节奏与音韵）',
    }

    return `你是一位古典诗词教育专家与诗篇重构顾问。请基于学生的重构作品，给出专业点评、改进建议与示范版本。

【原诗信息】
- 诗名：${poem.title}
- 作者：${poem.dynasty} · ${poem.poet}
- 原文：${poem.content}

【学生重构方向】
- 风格：${styleDesc[style]}
- 角度：${angleDesc[angle]}

【你的任务】
请严格按以下结构输出 markdown 内容（不要添加额外标题）：

## 总体点评
（200-400 字的总体评价，从意象运用、情感传达、语言节奏、与原诗对话性四个维度展开，指出亮点与不足）

## 改进建议
### 建议 1：（标题，10 字以内，动词开头）
（80-150 字具体说明，包含"为什么这样改"和"改成什么样"）

### 建议 2：（标题）
...

### 建议 3：（标题）
...

（共 3-5 条建议，每条聚焦一个具体改进点）

## 重构示范
（你作为顾问给出的完整重构版本，独立成段，仅输出重构后的文本，不加额外说明）

【输出要求】
- 全文使用中文
- 严格遵守上述三段式结构，标题使用 ## 和 ###
- 点评需引用学生原句作为论据
- 建议需具体可操作，避免空泛
- 重构示范需体现所给建议的综合应用`
}

/** 解析 AI 输出为结构化对象 */
function parseAdvisorOutput(raw: string): ParsedAdvisorOutput {
    const result: ParsedAdvisorOutput = {
        critique: '',
        suggestions: [],
        rewrite: '',
    }

    if (!raw) return result

    // 切分三段
    const critiqueMatch = raw.match(/##\s*总体点评\s*([\s\S]*?)(?=##\s*改进建议|$)/)
    const suggestionsMatch = raw.match(/##\s*改进建议\s*([\s\S]*?)(?=##\s*重构示范|$)/)
    const rewriteMatch = raw.match(/##\s*重构示范\s*([\s\S]*?)$/)

    if (critiqueMatch?.[1]) {
        result.critique = critiqueMatch[1].trim()
    }
    if (suggestionsMatch?.[1]) {
        // 解析每条建议：### 标题 \n 详情
        const suggRegex = /###\s*(?:建议\s*\d*[：:．.]?\s*)?([^\n]+)\s*([\s\S]*?)(?=###\s*(?:建议|$)|$)/g
        let match: RegExpExecArray | null
        while ((match = suggRegex.exec(suggestionsMatch[1])) !== null) {
            const title = (match[1] ?? '').trim()
            const detail = (match[2] ?? '').trim()
            if (title) {
                result.suggestions.push({ title, detail })
            }
        }
        // 兜底：若未匹配到 ### 格式，按段落拆分
        if (result.suggestions.length === 0) {
            const paras = suggestionsMatch[1].split(/\n\n+/).filter((p) => p.trim())
            paras.forEach((p, i) => {
                const lines = p.trim().split('\n')
                const title = lines[0]?.replace(/^[-*•]\s*/, '').trim() || `建议 ${i + 1}`
                const detail = lines.slice(1).join('\n').trim() || p.trim()
                result.suggestions.push({ title, detail })
            })
        }
    }
    if (rewriteMatch?.[1]) {
        result.rewrite = rewriteMatch[1].trim()
    }

    return result
}

/**
 * 计算两段文本的逐字 diff（LCS 算法）
 * 返回 [{type: 'same'|'add'|'del', char: string}] 数组
 *
 * 用于多版本对比表的高亮显示
 */
interface DiffSegment {
    type: 'same' | 'add' | 'del'
    text: string
}

function diffTexts(a: string, b: string): { left: DiffSegment[]; right: DiffSegment[] } {
    // 将文本拆为字符数组（处理 CJK）
    const aa = Array.from(a)
    const bb = Array.from(b)
    const m = aa.length
    const n = bb.length

    // LCS DP 表（为避免大文本 OOM，限制最大长度）
    const MAX = 800
    if (m > MAX || n > MAX) {
        // 兜底：直接整段对比
        return {
            left: [{ type: 'del', text: a }],
            right: [{ type: 'add', text: b }],
        }
    }

    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (aa[i - 1] === bb[j - 1]) {
                dp[i]![j] = (dp[i - 1]![j - 1] ?? 0) + 1
            } else {
                dp[i]![j] = Math.max(dp[i - 1]![j] ?? 0, dp[i]![j - 1] ?? 0)
            }
        }
    }

    // 回溯生成 diff 段
    const left: DiffSegment[] = []
    const right: DiffSegment[] = []
    let i = m
    let j = n

    const pushLeft = (type: DiffSegment['type'], ch: string) => {
        const last = left[left.length - 1]
        if (last && last.type === type) last.text += ch
        else left.push({ type, text: ch })
    }
    const pushRight = (type: DiffSegment['type'], ch: string) => {
        const last = right[right.length - 1]
        if (last && last.type === type) last.text += ch
        else right.push({ type, text: ch })
    }

    while (i > 0 && j > 0) {
        const aCh = aa[i - 1] ?? ''
        const bCh = bb[j - 1] ?? ''
        if (aCh === bCh) {
            pushLeft('same', aCh)
            pushRight('same', bCh)
            i--
            j--
        } else if ((dp[i - 1]![j] ?? 0) >= (dp[i]![j - 1] ?? 0)) {
            pushLeft('del', aCh)
            i--
        } else {
            pushRight('add', bCh)
            j--
        }
    }
    while (i > 0) {
        pushLeft('del', aa[i - 1] ?? '')
        i--
    }
    while (j > 0) {
        pushRight('add', bb[j - 1] ?? '')
        j--
    }

    // 反转（回溯是从后向前）
    left.reverse()
    right.reverse()
    return { left, right }
}

/* ============================================================
 * DEMO 模式降级数据
 * ============================================================ */

const DEMO_OUTPUT = `## 总体点评
学生的重构作品在保留原诗核心意象的基础上进行了大胆的再创造，体现了对原诗情感的深入理解。然而在意象转换的连贯性上略显生硬，部分句式节奏偏离了原诗的韵律美感。具体而言，开篇起句尚能呼应原诗的情境铺垫，但中段情感转折处理仓促，未能充分展开"景-情-思"的三层递进。语言节奏方面，部分长句破坏了诗歌的呼吸感。

## 改进建议
### 建议 1：强化意象连贯
当前重构中"月色-孤舟-远山"三个意象并列出现，缺乏过渡。建议在月色与孤舟之间增加一个动作性意象（如"月色铺过水面，孤舟才微微摇晃"），让画面有时间流动感。

### 建议 2：延展情感转折
中段从"独坐"到"思乡"的跳跃过于突然，可加入一个具象化的细节作为情感支点。例如引入"夜风掠过书卷"或"灯火忽明忽暗"的瞬间，让情感转折有可触发的物理契机。

### 建议 3：收束节奏韵律
末句"无人共此夜"虽意境到位，但与上句衔接略显仓促。建议在末句前增加一个短促的转折句（如"忽闻雁唳——"），形成节奏顿挫，再落入收束，可强化余韵。

## 重构示范
月色铺过水面，孤舟才微微摇晃。
远山如墨，浸入夜的深处。
独坐舱中，灯火忽明忽暗，
夜风掠过书卷，惊起一缕乡愁。
忽闻雁唳——
无人共此夜，唯余江月相伴。`

/* ============================================================
 * 内部组件 —— 学生重构输入区
 * ============================================================ */

interface StudentInputAreaProps {
    value: string
    onChange: (v: string) => void
    style: RewriteStyle
    angle: RewriteAngle
    onStyleChange: (s: RewriteStyle) => void
    onAngleChange: (a: RewriteAngle) => void
    onSubmit: () => void
    onClear: () => void
    loading: boolean
    disabled: boolean
}

const StudentInputArea = memo(function StudentInputArea({
    value,
    onChange,
    style,
    angle,
    onStyleChange,
    onAngleChange,
    onSubmit,
    onClear,
    loading,
    disabled,
}: StudentInputAreaProps) {
    const charCount = value.length
    const canSubmit = value.trim().length >= 10 && !loading && !disabled
    const insertCreativeText = useCallback((content: string) => {
        onChange(value.trim() ? `${value.trim()}\n${content}` : content)
    }, [onChange, value])

    return (
        <div className="pr-advisor-input">
            <div className="pr-advisor-input__header">
                <div className="pr-advisor-input__title">
                    <Icon name="pen-nib" size={15} weight="duotone" />
                    <span>学生重构作品</span>
                </div>
                <div className="pr-advisor-input__meta">
                    <span className="pr-advisor-input__count">{charCount} 字</span>
                    <button
                        type="button"
                        className="pr-advisor-input__clear"
                        onClick={onClear}
                        disabled={!value || loading}
                        aria-label="清空"
                    >
                        <Icon name="trash" size={13} />
                        清空
                    </button>
                </div>
            </div>

            <div className="pr-advisor-input__controls">
                <label className="pr-advisor-input__field">
                    <span className="pr-advisor-input__label">重构风格</span>
                    <Combobox
                        value={style}
                        onChange={(v) => onStyleChange(v as RewriteStyle)}
                        options={STYLE_OPTIONS}
                        ariaLabel="选择重构风格"
                    />
                </label>
                <label className="pr-advisor-input__field">
                    <span className="pr-advisor-input__label">重构角度</span>
                    <Combobox
                        value={angle}
                        onChange={(v) => onAngleChange(v as RewriteAngle)}
                        options={ANGLE_OPTIONS}
                        ariaLabel="选择重构角度"
                    />
                </label>
            </div>

            <QuickVoiceAssist
                suggestions={CREATIVE_STARTERS}
                onPick={insertCreativeText}
                onTranscript={insertCreativeText}
                label="不会开头？点一个画面，或直接说出你的诗"
                voiceLabel="口述作品"
                disabled={loading || disabled}
                compact
            />

            <textarea
                className="pr-advisor-input__textarea"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder="点上方句子开始，或用语音说出作品；识别后可以继续修改"
                disabled={loading}
                aria-label="学生重构输入框"
                rows={8}
                maxLength={2000}
            />

            <div className="pr-advisor-input__footer">
                <span className="pr-advisor-input__hint">
                    <Icon name="info" size={12} />
                    AI 顾问将基于 deepseek-v4-pro 流式生成点评、建议与示范
                </span>
                <button
                    type="button"
                    className="pr-advisor-input__submit"
                    onClick={onSubmit}
                    disabled={!canSubmit}
                    aria-label="请求 AI 顾问点评"
                >
                    {loading ? (
                        <>
                            <Icon name="spinner-gap" size={14} weight="bold" />
                            <span>正在生成…</span>
                        </>
                    ) : (
                        <>
                            <Icon name="magic-wand" size={14} weight="fill" />
                            <span>请求 AI 顾问</span>
                        </>
                    )}
                </button>
            </div>
        </div>
    )
})

/* ============================================================
 * 内部组件 —— AI 总体点评（流式）
 * ============================================================ */

interface AICritiquePanelProps {
    /** 流式原始内容（未解析） */
    streamingRaw: string
    /** 是否正在流式接收 */
    isStreaming: boolean
    /** 是否已中断 */
    isPaused: boolean
    /** 是否已完成 */
    isDone: boolean
    /** 错误信息 */
    error: string | null
    /** 中断回调 */
    onInterrupt: () => void
    /** 继续回调 */
    onResume: () => void
    /** 重试回调 */
    onRetry: () => void
}

const AICritiquePanel = memo(function AICritiquePanel({
    streamingRaw,
    isStreaming,
    isPaused,
    isDone,
    error,
    onInterrupt,
    onResume,
    onRetry,
}: AICritiquePanelProps) {
    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(streamingRaw)
            toast.success({ title: '已复制', message: 'AI 点评内容已复制到剪贴板' })
        } catch {
            toast.error({ title: '复制失败', message: '请手动选择文本复制' })
        }
    }, [streamingRaw])

    return (
        <div className="pr-advisor-critique">
            <div className="pr-advisor-critique__header">
                <div className="pr-advisor-critique__title">
                    <Icon name="chat-circle" size={15} weight="duotone" />
                    <span>AI 智能点评</span>
                    {isStreaming && (
                        <span className="pr-advisor-critique__badge pr-advisor-critique__badge--streaming">
                            <span className="pr-advisor-critique__dot" />
                            流式中
                        </span>
                    )}
                    {isPaused && (
                        <span className="pr-advisor-critique__badge pr-advisor-critique__badge--paused">
                            <Icon name="stop" size={11} weight="fill" />
                            已中断
                        </span>
                    )}
                    {isDone && !error && (
                        <span className="pr-advisor-critique__badge pr-advisor-critique__badge--done">
                            <Icon name="check-fat" size={11} weight="fill" />
                            完成
                        </span>
                    )}
                </div>
                <div className="pr-advisor-critique__actions">
                    {streamingRaw && (
                        <button
                            type="button"
                            className="pr-advisor-critique__btn"
                            onClick={handleCopy}
                            aria-label="复制点评"
                        >
                            <Icon name="copy" size={12} />
                            复制
                        </button>
                    )}
                    {isStreaming && (
                        <button
                            type="button"
                            className="pr-advisor-critique__btn pr-advisor-critique__btn--warn"
                            onClick={onInterrupt}
                            aria-label="中断流式输出"
                        >
                            <Icon name="stop" size={12} weight="fill" />
                            中断
                        </button>
                    )}
                    {isPaused && (
                        <button
                            type="button"
                            className="pr-advisor-critique__btn pr-advisor-critique__btn--primary"
                            onClick={onResume}
                            aria-label="继续流式输出"
                        >
                            <Icon name="play" size={12} weight="fill" />
                            继续生成
                        </button>
                    )}
                    {error && (
                        <button
                            type="button"
                            className="pr-advisor-critique__btn pr-advisor-critique__btn--primary"
                            onClick={onRetry}
                            aria-label="重试"
                        >
                            <Icon name="repeat" size={12} />
                            重试
                        </button>
                    )}
                </div>
            </div>

            <div className="pr-advisor-critique__body">
                {error ? (
                    <div className="pr-advisor-critique__error" role="alert">
                        <Icon name="warning" size={20} weight="duotone" />
                        <div>
                            <strong>生成失败</strong>
                            <p>{error}</p>
                        </div>
                    </div>
                ) : streamingRaw ? (
                    <StreamText
                        content={streamingRaw}
                        charStagger={12}
                        charDuration={250}
                        showCursor={isStreaming || isPaused}
                        structured={true}
                        onInterrupt={onInterrupt}
                        onResume={onResume}
                    />
                ) : (
                    <div className="pr-advisor-critique__empty">
                        <Icon name="brain" size={42} weight="bold" />
                        <p>请输入你的重构作品并点击「请求 AI 顾问」</p>
                        <span>AI 顾问将基于 deepseek-v4-pro 给出总体点评、3-5 条改进建议与重构示范</span>
                    </div>
                )}
            </div>
        </div>
    )
})

/* ============================================================
 * 内部组件 —— 建议卡片网格
 * ============================================================ */

interface SuggestionCardGridProps {
    suggestions: ParsedAdvisorOutput['suggestions']
    visible: boolean
}

const SuggestionCardGrid = memo(function SuggestionCardGrid({
    suggestions,
    visible,
}: SuggestionCardGridProps) {
    if (!visible || suggestions.length === 0) return null

    return (
        <div className="pr-advisor-suggestions" aria-label="AI 改进建议">
            <div className="pr-advisor-suggestions__header">
                <Icon name="lightning" size={15} weight="fill" />
                <span>改进建议</span>
                <em>{suggestions.length} 条</em>
            </div>
            <div className="pr-advisor-suggestions__grid">
                {suggestions.map((s, idx) => (
                    <article
                        key={`sugg-${idx}`}
                        className="pr-advisor-suggestion-card"
                        style={{ animationDelay: `${idx * 60}ms` }}
                    >
                        <header className="pr-advisor-suggestion-card__header">
                            <span className="pr-advisor-suggestion-card__num">
                                {String(idx + 1).padStart(2, '0')}
                            </span>
                            <h4>{s.title}</h4>
                        </header>
                        <p className="pr-advisor-suggestion-card__detail">{s.detail}</p>
                    </article>
                ))}
            </div>
        </div>
    )
})

/* ============================================================
 * 内部组件 —— 多版本对比表
 * ============================================================ */

interface VersionComparisonTableProps {
    original: string
    student: string
    aiRewrite: string
    poemTitle: string
    visible: boolean
}

const VersionComparisonTable = memo(function VersionComparisonTable({
    original,
    student,
    aiRewrite,
    poemTitle,
    visible,
}: VersionComparisonTableProps) {
    // Hooks 必须在条件 return 之前调用（Rules of Hooks）
    const studentDiff = useMemo(() => {
        if (!visible || !original || !student) return { left: [] as DiffSegment[], right: [] as DiffSegment[] }
        return diffTexts(original, student)
    }, [visible, original, student])

    const aiDiff = useMemo(() => {
        if (!visible || !original || !aiRewrite) return { left: [] as DiffSegment[], right: [] as DiffSegment[] }
        return diffTexts(original, aiRewrite)
    }, [visible, original, aiRewrite])

    const handleExport = useCallback(() => {
        if (!original && !student && !aiRewrite) return
        const md = `# ${poemTitle} 重构对比

## 原诗
${original}

## 学生重构
${student}

## AI 重构示范
${aiRewrite}

---
*由 PoeticRealm AI v5.0 诗篇重构顾问生成*
`
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${poemTitle}-重构对比.md`
        a.click()
        URL.revokeObjectURL(url)
        toast.success({ title: '已导出', message: 'Markdown 文件已下载' })
    }, [poemTitle, original, student, aiRewrite])

    if (!visible || (!original && !student && !aiRewrite)) return null

    return (
        <div className="pr-advisor-compare" aria-label="多版本对比">
            <div className="pr-advisor-compare__header">
                <div className="pr-advisor-compare__title">
                    <Icon name="stack" size={15} weight="duotone" />
                    <span>多版本对比</span>
                </div>
                <button
                    type="button"
                    className="pr-advisor-compare__export"
                    onClick={handleExport}
                    aria-label="导出 Markdown"
                >
                    <Icon name="download" size={12} />
                    导出 Markdown
                </button>
            </div>

            <div className="pr-advisor-compare__grid">
                {/* 原诗 */}
                <article className="pr-advisor-compare__col pr-advisor-compare__col--original">
                    <header>
                        <span className="pr-advisor-compare__tag">原诗</span>
                        <h5>{poemTitle}</h5>
                    </header>
                    <p className="pr-advisor-compare__text">{original}</p>
                </article>

                {/* 学生重构 */}
                <article className="pr-advisor-compare__col pr-advisor-compare__col--student">
                    <header>
                        <span className="pr-advisor-compare__tag pr-advisor-compare__tag--student">学生重构</span>
                        <h5>你的版本</h5>
                    </header>
                    <p className="pr-advisor-compare__text pr-advisor-compare__text--diff">
                        {studentDiff.left.map((seg, i) => (
                            <span
                                key={`s-${i}`}
                                className={
                                    seg.type === 'del'
                                        ? 'pr-advisor-compare__del'
                                        : 'pr-advisor-compare__same'
                                }
                            >
                                {seg.text}
                            </span>
                        ))}
                    </p>
                </article>

                {/* AI 重构 */}
                <article className="pr-advisor-compare__col pr-advisor-compare__col--ai">
                    <header>
                        <span className="pr-advisor-compare__tag pr-advisor-compare__tag--ai">AI 重构</span>
                        <h5>顾问示范</h5>
                    </header>
                    <p className="pr-advisor-compare__text pr-advisor-compare__text--diff">
                        {aiDiff.left.map((seg, i) => (
                            <span
                                key={`a-${i}`}
                                className={
                                    seg.type === 'del'
                                        ? 'pr-advisor-compare__del'
                                        : 'pr-advisor-compare__same'
                                }
                            >
                                {seg.text}
                            </span>
                        ))}
                    </p>
                </article>
            </div>

            <div className="pr-advisor-compare__legend">
                <span className="pr-advisor-compare__legend-item">
                    <i className="pr-advisor-compare__legend-swatch pr-advisor-compare__legend-swatch--same" />
                    保留
                </span>
                <span className="pr-advisor-compare__legend-item">
                    <i className="pr-advisor-compare__legend-swatch pr-advisor-compare__legend-swatch--del" />
                    删除
                </span>
                <span className="pr-advisor-compare__legend-item">
                    <i className="pr-advisor-compare__legend-swatch pr-advisor-compare__legend-swatch--add" />
                    新增
                </span>
            </div>
        </div>
    )
})

/* ============================================================
 * 主组件 —— PoemReconstructionAdvisor
 * ============================================================ */

export interface PoemReconstructionAdvisorProps {
    /** 当前选中的诗篇；若未传则使用 store 中的 selectedPoemId */
    poem?: CulturePoem
    /** 初始学生重构（可选，用于回填） */
    initialStudentText?: string
    /** 受控模式：外部传入 onChange 时启用 */
    onStudentTextChange?: (v: string) => void
}

function PoemReconstructionAdvisorImpl({
    poem: poemProp,
    initialStudentText = '',
    onStudentTextChange,
}: PoemReconstructionAdvisorProps) {
    /* ---------- 数据源 ---------- */
    const storePoems = useCultureStore((s) => s.poems)
    const storeSelectedPoemId = useCultureStore((s) => s.selectedPoemId)
    const isDemo = useDemoModeStore((s) => s.isDemoMode)

    const poem = useMemo<CulturePoem | null>(() => {
        if (poemProp) return poemProp
        if (!storePoems.length) return null
        return storePoems.find((p) => p.id === storeSelectedPoemId) ?? storePoems[0] ?? null
    }, [poemProp, storePoems, storeSelectedPoemId])
    const poemContextKey = useMemo(
        () => poem
            ? [poem.id, poem.title, poem.poet, poem.dynasty, poem.content].join('\u0000')
            : 'poem:none',
        [poem],
    )
    const poemContextKeyRef = useRef(poemContextKey)
    poemContextKeyRef.current = poemContextKey
    const generationRef = useRef(0)
    const mountedRef = useRef(true)

    /* ---------- 学生输入 ---------- */
    const [studentText, setStudentText] = useState(initialStudentText)
    const [style, setStyle] = useState<RewriteStyle>('modern')
    const [angle, setAngle] = useState<RewriteAngle>('imagery')

    const handleStudentChange = useCallback((v: string) => {
        setStudentText(v)
        onStudentTextChange?.(v)
    }, [onStudentTextChange])

    const handleClear = useCallback(() => {
        setStudentText('')
        onStudentTextChange?.('')
    }, [onStudentTextChange])

    /* ---------- 流式状态 ---------- */
    const [streamingRaw, setStreamingRaw] = useState('')
    const [isStreaming, setIsStreaming] = useState(false)
    const [isPaused, setIsPaused] = useState(false)
    const [isDone, setIsDone] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const controllerRef = useRef<AiChatStreamController | null>(null)
    const demoIntervalRef = useRef<number | null>(null)
    const interruptedRef = useRef(false)
    const rawBufferRef = useRef('')

    const clearDemoInterval = useCallback(() => {
        if (demoIntervalRef.current !== null) {
            window.clearInterval(demoIntervalRef.current)
            demoIntervalRef.current = null
        }
    }, [])

    const tokenIsCurrent = useCallback((token: AsyncGenerationToken): boolean => (
        isAsyncGenerationCurrent(
            token,
            generationRef.current,
            poemContextKeyRef.current,
            mountedRef.current,
        )
    ), [])

    /* ---------- 解析后的结构化输出 ---------- */
    const parsed = useMemo<ParsedAdvisorOutput>(() => {
        if (!isDone || !streamingRaw) {
            return { critique: '', suggestions: [], rewrite: '' }
        }
        return parseAdvisorOutput(streamingRaw)
    }, [streamingRaw, isDone])

    /* ---------- 流式回调 ---------- */
    const handleChunk = useCallback((token: AsyncGenerationToken, chunk: AiChatStreamChunk) => {
        if (!tokenIsCurrent(token)) return
        if (chunk.content) {
            rawBufferRef.current += chunk.content
            setStreamingRaw(rawBufferRef.current)
        }
        if (chunk.error) {
            setError(chunk.message ?? chunk.error)
            setIsStreaming(false)
            setIsPaused(false)
        }
    }, [tokenIsCurrent])

    const handleDone = useCallback((token: AsyncGenerationToken) => {
        if (!tokenIsCurrent(token)) return
        clearDemoInterval()
        setIsStreaming(false)
        setIsPaused(false)
        setIsDone(true)
        controllerRef.current = null
    }, [clearDemoInterval, tokenIsCurrent])

    const handleError = useCallback((token: AsyncGenerationToken, err: Error) => {
        if (!tokenIsCurrent(token)) return
        clearDemoInterval()
        logError('PoemReconstructionAdvisor.chatStream', err)
        setError(err.message || '流式生成失败')
        setIsStreaming(false)
        setIsPaused(false)
        controllerRef.current = null
    }, [clearDemoInterval, tokenIsCurrent])

    /* ---------- 启动 AI 顾问 ---------- */
    const startAdvisor = useCallback(async () => {
        if (!poem) {
            toast.warning({ title: '请先选择诗篇', message: '在工具栏选择一首古诗后再请求 AI 顾问' })
            return
        }
        if (studentText.trim().length < 10) {
            toast.warning({ title: '重构内容过短', message: '请至少输入 10 字以上的重构作品' })
            return
        }

        // 重置状态
        rawBufferRef.current = ''
        setStreamingRaw('')
        setError(null)
        setIsDone(false)
        setIsPaused(false)
        interruptedRef.current = false
        invalidateAsyncGeneration(generationRef)
        clearDemoInterval()
        controllerRef.current?.abort()
        controllerRef.current = null
        const token = beginAsyncGeneration(generationRef, poemContextKey)

        // DEMO 模式降级：模拟流式输出
        if (isDemo || isDemoMode()) {
            setIsStreaming(true)
            // 逐字输出 DEMO 内容
            const demoText = DEMO_OUTPUT
            const chars = Array.from(demoText)
            const BATCH = 8 // 每批 8 个字符
            let i = 0
            demoIntervalRef.current = window.setInterval(() => {
                if (!tokenIsCurrent(token)) {
                    clearDemoInterval()
                    return
                }
                if (interruptedRef.current) {
                    setIsStreaming(false)
                    setIsPaused(true)
                    clearDemoInterval()
                    return
                }
                const next = chars.slice(i, i + BATCH).join('')
                rawBufferRef.current += next
                setStreamingRaw(rawBufferRef.current)
                i += BATCH
                if (i >= chars.length) {
                    clearDemoInterval()
                    setIsStreaming(false)
                    setIsDone(true)
                }
            }, 60)
            return
        }

        // 真实 API 调用
        setIsStreaming(true)
        const systemPrompt = buildSystemPrompt(poem, style, angle)
        const userMessage = `【我的重构作品】\n${studentText.trim()}\n\n请按照系统提示词的三段式结构给出点评、建议与示范。`

        try {
            const ctrl = api.ai.chatStream(
                {
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userMessage },
                    ],
                    model: AI_MODEL,
                    thinking_mode: AI_THINKING_MODE,
                    temperature: AI_TEMPERATURE,
                    max_tokens: AI_MAX_TOKENS,
                    stream: true,
                },
                {
                    onChunk: (chunk) => handleChunk(token, chunk),
                    onDone: () => handleDone(token),
                    onError: (err) => handleError(token, err),
                },
            )
            if (tokenIsCurrent(token)) {
                controllerRef.current = ctrl
            } else {
                ctrl.abort()
            }
        } catch (err) {
            handleError(token, err instanceof Error ? err : new Error(String(err)))
        }
    }, [
        poem,
        poemContextKey,
        studentText,
        style,
        angle,
        isDemo,
        clearDemoInterval,
        handleChunk,
        handleDone,
        handleError,
        tokenIsCurrent,
    ])

    /* ---------- 中断 / 继续 / 重试 ---------- */
    const handleInterrupt = useCallback(() => {
        invalidateAsyncGeneration(generationRef)
        clearDemoInterval()
        if (controllerRef.current) {
            controllerRef.current.abort()
            controllerRef.current = null
        }
        interruptedRef.current = true
        setIsStreaming(false)
        setIsPaused(true)
    }, [clearDemoInterval])

    const handleResume = useCallback(() => {
        if (isDemo || isDemoMode()) {
            // DEMO 模式重新启动定时器（沿用原始逻辑过于复杂，简化为提示用户重试）
            interruptedRef.current = false
            clearDemoInterval()
            setIsPaused(false)
            setIsStreaming(true)
            // 继续输出剩余内容
            const demoText = DEMO_OUTPUT
            const remaining = demoText.slice(rawBufferRef.current.length)
            const chars = Array.from(remaining)
            const BATCH = 8
            let i = 0
            const token = beginAsyncGeneration(generationRef, poemContextKey)
            demoIntervalRef.current = window.setInterval(() => {
                if (!tokenIsCurrent(token)) {
                    clearDemoInterval()
                    return
                }
                if (interruptedRef.current) {
                    setIsStreaming(false)
                    setIsPaused(true)
                    clearDemoInterval()
                    return
                }
                const next = chars.slice(i, i + BATCH).join('')
                rawBufferRef.current += next
                setStreamingRaw(rawBufferRef.current)
                i += BATCH
                if (i >= chars.length) {
                    clearDemoInterval()
                    setIsStreaming(false)
                    setIsDone(true)
                }
            }, 60)
            return
        }
        // 真实 API 不支持中断后继续（SSE 已断开），需重新发起请求
        toast.info({
            title: '继续生成',
            message: '由于流式连接已断开，请点击「重试」重新生成',
        })
    }, [clearDemoInterval, isDemo, poemContextKey, tokenIsCurrent])

    const handleRetry = useCallback(() => {
        void startAdvisor()
    }, [startAdvisor])

    /* ---------- 诗篇上下文与卸载清理 ---------- */
    useEffect(() => {
        // 同 ID 内容变更也视为新上下文；旧 SSE/DEMO 分片不能写入新诗界面。
        invalidateAsyncGeneration(generationRef)
        clearDemoInterval()
        controllerRef.current?.abort()
        controllerRef.current = null
        interruptedRef.current = false
        rawBufferRef.current = ''
        setStreamingRaw('')
        setIsStreaming(false)
        setIsPaused(false)
        setIsDone(false)
        setError(null)
        setStudentText(initialStudentText)
    }, [poemContextKey, initialStudentText, clearDemoInterval])

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            invalidateAsyncGeneration(generationRef)
            clearDemoInterval()
            if (controllerRef.current) {
                controllerRef.current.abort()
                controllerRef.current = null
            }
        }
    }, [clearDemoInterval])

    /* ---------- 渲染 ---------- */

    if (!poem) {
        return (
            <div className="pr-advisor-empty">
                <Icon name="book-open" size={48} weight="bold" />
                <h3>请先选择诗篇</h3>
                <p>在工具栏选择一首古诗后，AI 顾问将基于该诗篇对你的重构作品进行点评</p>
            </div>
        )
    }

    return (
        <div className="pr-advisor" role="region" aria-label="诗篇重构 AI 顾问">
            {/* 顶部：原诗预览 + 学生输入区 */}
            <section className="pr-advisor-top" data-anchor data-anchor-label="重构输入">
                <aside className="pr-advisor-original">
                    <header className="pr-advisor-original__header">
                        <Icon name="quotes" size={14} weight="fill" />
                        <span>原诗参考</span>
                    </header>
                    <div className="pr-advisor-original__body">
                        <span className="pr-advisor-original__meta">
                            {poem.dynasty} · {poem.poet}
                        </span>
                        <h4 className="pr-advisor-original__title">{poem.title}</h4>
                        <p className="pr-advisor-original__content">{poem.content}</p>
                    </div>
                </aside>

                <StudentInputArea
                    value={studentText}
                    onChange={handleStudentChange}
                    style={style}
                    angle={angle}
                    onStyleChange={setStyle}
                    onAngleChange={setAngle}
                    onSubmit={startAdvisor}
                    onClear={handleClear}
                    loading={isStreaming}
                    disabled={!poem}
                />
            </section>

            {/* 中部：AI 流式点评 */}
            <section
                className="pr-advisor-mid"
                data-anchor
                data-anchor-label="AI 智能点评"
            >
                <AICritiquePanel
                    streamingRaw={streamingRaw}
                    isStreaming={isStreaming}
                    isPaused={isPaused}
                    isDone={isDone}
                    error={error}
                    onInterrupt={handleInterrupt}
                    onResume={handleResume}
                    onRetry={handleRetry}
                />
            </section>

            {/* 下部：建议卡片 + 多版本对比（流式完成后展示） */}
            {isDone && !error && (
                <>
                    <section
                        className="pr-advisor-suggestions-section"
                        data-anchor
                        data-anchor-label="改进建议"
                    >
                        <SuggestionCardGrid
                            suggestions={parsed.suggestions}
                            visible={parsed.suggestions.length > 0}
                        />
                    </section>

                    <section
                        className="pr-advisor-compare-section"
                        data-anchor
                        data-anchor-label="多版本对比"
                    >
                        <VersionComparisonTable
                            original={poem.content}
                            student={studentText}
                            aiRewrite={parsed.rewrite}
                            poemTitle={poem.title}
                            visible={!!parsed.rewrite}
                        />
                    </section>
                </>
            )}
        </div>
    )
}

export const PoemReconstructionAdvisor = memo(PoemReconstructionAdvisorImpl)
