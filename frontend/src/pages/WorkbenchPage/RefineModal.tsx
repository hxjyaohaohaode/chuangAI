/**
 * 微调弹窗 RefineModal（SubTask 10.5 + 21.4 增强）
 *
 * v5.0 SubTask 21.4 新增能力：
 * 1. AI 精修模式：调用 `POST /api/ai/chat` deepseek-v4-pro thinking_mode=medium 流式输出
 *    - 流式过程中可中断（AbortController）
 *    - 输出 JSON 格式（stem/answer/analysis/options/distractorsAnalysis/difficulty）
 *    - 完成后自动解析并填充到对比视图右侧
 * 2. 手动编辑模式：直接编辑题干/答案/解析/难度/选项
 *    - 实时同步到对比视图右侧
 * 3. 对比视图：左右双栏（原始 vs 当前编辑/AI 生成）
 *    - 字段级勾选框：决定哪些字段最终被采纳
 * 4. 接受/拒绝/部分采纳：
 *    - 全部接受：保存所有字段到后端（PATCH /api/workbench/questions/:id）
 *    - 部分采纳：仅保存勾选的字段
 *    - 拒绝：放弃所有修改，关闭弹窗
 *
 * 设计依据：
 * - 规范第 11 章：流式输出（光标 + 渐进渲染 + 中断恢复）
 * - 规范第 14 章：Modal lg + 双栏对比 + spring-soft 入场
 * - 透明度驱动暖调色板 + 玻璃态面板
 * - TanStack Query useMutation（保存到后端 + 失败回滚）
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Icon, Input, Modal } from '@/components/ui'
import { Markdown } from '@/components/ui/Markdown'
import { api } from '@/lib/api'
import { getDisplayError } from '@/lib/errors'
import { toast } from '@/stores/toast'
import { useWorkbenchStore } from '@/stores/workbench'
import {
    WORKBENCH_BLOOM_COLORS,
    type AiChatStreamChunk,
    type AiChatStreamController,
    type WorkbenchQuestion,
    type WorkbenchQuestionMeta,
} from '@/lib/types'
import './RefineModal.css'

/* ============================================================
 * 常量与类型
 * ============================================================ */

/** 微调模式 */
type RefineMode = 'ai' | 'manual'
const REFINE_MODES: readonly RefineMode[] = ['ai', 'manual']

/** AI 精修输出字段（可勾选采纳） */
type RefineField = 'stem' | 'answer' | 'analysis' | 'options' | 'distractorsAnalysis' | 'difficulty'

/** AI 精修解析后的题目片段 */
interface RefinedPatch {
    stem?: string
    answer?: string
    analysis?: string
    options?: string[]
    distractorsAnalysis?: string[]
    difficulty?: 1 | 2 | 3 | 4 | 5
}

/** 微调模板快捷按钮 */
const REFINE_TEMPLATES: ReadonlyArray<{ key: string; label: string; icon: string; prompt: string }> = [
    {
        key: 'harder',
        label: '增加难度',
        icon: 'caret-up',
        prompt: '请将本题难度提升一档，保持知识点不变，增加思维深度，并在解析中说明提升难度的具体维度。',
    },
    {
        key: 'analysis',
        label: '补充解析',
        icon: 'lightbulb',
        prompt: '请扩展答案解析，补充相关的文化背景、典故来源与教学建议，使解析字数增加 50% 以上。',
    },
    {
        key: 'options',
        label: '调整选项',
        icon: 'list',
        prompt: '请优化选择题的干扰项，使其更具迷惑性且符合学生常见错误认知，并补充每个干扰项的错因分析。',
    },
    {
        key: 'bloom',
        label: '变换层级',
        icon: 'chart-bar',
        prompt: '请将本题迁移到更高的布鲁姆认知阶层（从识记型转为分析/评价/创造型），重写题干与解析。',
    },
]

/** 可采纳字段配置（用于勾选框渲染） */
const ADOPTABLE_FIELDS: ReadonlyArray<{
    key: RefineField
    label: string
    icon: string
}> = [
    { key: 'stem', label: '题干', icon: 'pen-nib' },
    { key: 'answer', label: '答案', icon: 'check' },
    { key: 'analysis', label: '解析', icon: 'lightbulb' },
    { key: 'options', label: '选项', icon: 'list' },
    { key: 'distractorsAnalysis', label: '干扰项分析', icon: 'quotes' },
    { key: 'difficulty', label: '难度', icon: 'chart-bar' },
]

/** AI 流式状态 */
type StreamState = 'idle' | 'streaming' | 'done' | 'error'

/* ============================================================
 * 工具函数
 * ============================================================ */

/**
 * 构建 AI 精修 system + user prompt
 *
 * 要求 AI 严格输出 JSON 格式（不带 markdown 代码块），
 * 字段对齐 RefinedPatch。
 */
function buildAiMessages(question: WorkbenchQuestion, instruction: string) {
    const system = `你是诗脉·启明系统的命题精修专家。请根据教师的微调指令对题目进行精修。

【输出要求】
1. 严格输出 JSON 格式，不要使用 \`\`\`json 代码块包裹，不要任何说明文字或前后缀。
2. JSON 字段：
   - stem (string)：修改后的题干（保留 Markdown 格式）
   - answer (string)：修改后的答案
   - analysis (string)：修改后的解析（保留 Markdown 格式）
   - options (string[])：选择题选项数组（非选择题可省略此字段）
   - distractorsAnalysis (string[])：每个干扰项的错因分析（可选）
   - difficulty (number, 1-5)：调整后的难度
3. 仅输出需要修改的字段；但若某字段未变化，可省略该字段以减少输出长度。
4. 保持内容专业、准确、连贯，符合中学语文教学规范。`

    const user = `【当前题目】
- 题型：${question.type}
- 布鲁姆层级：${question.bloomLevel}
- 难度：${question.difficulty}/5
- 题干：${question.stem}
${question.options && question.options.length > 0 ? `- 选项：${question.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('  ')}` : ''}
- 答案：${question.answer}
- 解析：${question.analysis}
${question.distractorsAnalysis && question.distractorsAnalysis.length > 0 ? `- 干扰项分析：${question.distractorsAnalysis.join(' | ')}` : ''}

【教师指令】
${instruction}

请输出精修后的 JSON：`

    return {
        messages: [
            { role: 'system' as const, content: system },
            { role: 'user' as const, content: user },
        ],
    }
}

/**
 * 从 AI 流式累积的文本中解析 JSON
 *
 * 容错策略：
 * 1. 去除 ```json 和 ``` 代码块包裹
 * 2. 提取首个 { 到末尾 } 之间的内容
 * 3. JSON.parse 解析
 *
 * 失败时返回 null，调用方降级处理（把全文作为 stem）。
 */
function parseRefinedJson(raw: string): RefinedPatch | null {
    if (!raw.trim()) return null
    let text = raw.trim()
    // 去除 markdown 代码块
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    // 提取首个 { 到末尾 }
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return null
    const jsonStr = text.slice(start, end + 1)
    try {
        const obj = JSON.parse(jsonStr) as Record<string, unknown>
        const patch: RefinedPatch = {}
        if (typeof obj.stem === 'string' && obj.stem.trim()) patch.stem = obj.stem
        if (typeof obj.answer === 'string' && obj.answer.trim()) patch.answer = obj.answer
        if (typeof obj.analysis === 'string' && obj.analysis.trim()) patch.analysis = obj.analysis
        if (Array.isArray(obj.options) && obj.options.every((o) => typeof o === 'string')) {
            patch.options = obj.options as string[]
        }
        if (
            Array.isArray(obj.distractorsAnalysis) &&
            obj.distractorsAnalysis.every((o) => typeof o === 'string')
        ) {
            patch.distractorsAnalysis = obj.distractorsAnalysis as string[]
        }
        if (
            typeof obj.difficulty === 'number' &&
            obj.difficulty >= 1 &&
            obj.difficulty <= 5 &&
            Number.isInteger(obj.difficulty)
        ) {
            patch.difficulty = obj.difficulty as 1 | 2 | 3 | 4 | 5
        }
        return patch
    } catch {
        return null
    }
}

/* ============================================================
 * 主组件
 * ============================================================ */

interface RefineModalProps {
    open: boolean
    onClose: () => void
    /** 目标题目（null 表示关闭态） */
    question: WorkbenchQuestion | null
}

export const RefineModal = memo(function RefineModal({ open, onClose, question }: RefineModalProps) {
    const queryClient = useQueryClient()
    const refining = useWorkbenchStore((s) => s.refining)
    const setRefining = useWorkbenchStore((s) => s.setRefining)

    /* ------------------------------------------------------------
     * 本地状态
     * ---------------------------------------------------------- */
    const [mode, setMode] = useState<RefineMode>('ai')
    const [instruction, setInstruction] = useState('')

    // AI 流式状态
    const [streamState, setStreamState] = useState<StreamState>('idle')
    const [streamingText, setStreamingText] = useState('')
    const [streamError, setStreamError] = useState<string | null>(null)
    const streamControllerRef = useRef<AiChatStreamController | null>(null)

    // 解析后的 AI 精修 patch（streaming 完成后填充）
    const [aiPatch, setAiPatch] = useState<RefinedPatch | null>(null)

    // 手动编辑 patch
    const [manualPatch, setManualPatch] = useState<RefinedPatch>({})

    // 字段采纳勾选（key → 是否采纳）
    const [adopted, setAdopted] = useState<Record<RefineField, boolean>>({
        stem: true,
        answer: true,
        analysis: true,
        options: true,
        distractorsAnalysis: true,
        difficulty: true,
    })

    /* ------------------------------------------------------------
     * 弹窗开启/关闭时重置状态
     * ---------------------------------------------------------- */
    useEffect(() => {
        if (open && question) {
            setMode('ai')
            setInstruction('')
            setStreamState('idle')
            setStreamingText('')
            setStreamError(null)
            setAiPatch(null)
            setManualPatch({})
            setAdopted({
                stem: true,
                answer: true,
                analysis: true,
                options: true,
                distractorsAnalysis: true,
                difficulty: true,
            })
            // 同步 store 的 refining 状态（兼容旧 store 流程）
            if (refining) setRefining(false)
        }
        // 弹窗关闭时中断进行中的流
        if (!open && streamControllerRef.current?.streaming) {
            streamControllerRef.current.abort()
            streamControllerRef.current = null
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, question])

    /* ------------------------------------------------------------
     * 当前生效的 patch（取决于 mode）
     * ---------------------------------------------------------- */
    const currentPatch: RefinedPatch | null = useMemo(() => {
        if (mode === 'ai') return aiPatch
        // manual 模式：只取有值的字段
        const manual: RefinedPatch = {}
        if (manualPatch.stem !== undefined && manualPatch.stem !== question?.stem) {
            manual.stem = manualPatch.stem
        }
        if (manualPatch.answer !== undefined && manualPatch.answer !== question?.answer) {
            manual.answer = manualPatch.answer
        }
        if (manualPatch.analysis !== undefined && manualPatch.analysis !== question?.analysis) {
            manual.analysis = manualPatch.analysis
        }
        if (manualPatch.options !== undefined) {
            manual.options = manualPatch.options
        }
        if (manualPatch.distractorsAnalysis !== undefined) {
            manual.distractorsAnalysis = manualPatch.distractorsAnalysis
        }
        if (manualPatch.difficulty !== undefined && manualPatch.difficulty !== question?.difficulty) {
            manual.difficulty = manualPatch.difficulty
        }
        return Object.keys(manual).length > 0 ? manual : null
    }, [mode, aiPatch, manualPatch, question])

    /** 是否有可采纳的修改 */
    const hasRefinement = currentPatch !== null

    /** 已勾选采纳的字段数量 */
    const adoptedCount = useMemo(() => {
        if (!currentPatch) return 0
        return ADOPTABLE_FIELDS.filter((f) => {
            const value = currentPatch[f.key]
            return value !== undefined && adopted[f.key]
        }).length
    }, [currentPatch, adopted])

    /* ------------------------------------------------------------
     * AI 流式调用
     * ---------------------------------------------------------- */
    const startAiStream = useCallback(() => {
        if (!question || !instruction.trim()) return

        // 中断已有流
        if (streamControllerRef.current?.streaming) {
            streamControllerRef.current.abort()
        }

        setStreamState('streaming')
        setStreamingText('')
        setStreamError(null)
        setAiPatch(null)
        setRefining(true)

        const { messages } = buildAiMessages(question, instruction.trim())

        const controller = api.ai.chatStream(
            {
                messages,
                model: 'deepseek-v4-pro',
                thinking_mode: 'medium',
                stream: true,
                temperature: 0.7,
                max_tokens: 4096,
            },
            {
                onChunk: (chunk: AiChatStreamChunk) => {
                    if (chunk.content) {
                        setStreamingText((prev) => prev + chunk.content)
                    }
                    if (chunk.error) {
                        setStreamError(chunk.message ?? chunk.error)
                        setStreamState('error')
                        setRefining(false)
                    }
                },
                onDone: () => {
                    // 流式完成，解析 JSON
                    setStreamingText((prev) => {
                        const patch = parseRefinedJson(prev)
                        if (patch && Object.keys(patch).length > 0) {
                            setAiPatch(patch)
                            setStreamState('done')
                            // 自动勾选 AI 提供的字段
                            setAdopted({
                                stem: patch.stem !== undefined,
                                answer: patch.answer !== undefined,
                                analysis: patch.analysis !== undefined,
                                options: patch.options !== undefined,
                                distractorsAnalysis: patch.distractorsAnalysis !== undefined,
                                difficulty: patch.difficulty !== undefined,
                            })
                            toast.success({ title: 'AI 精修完成', message: '请查看对比视图并选择采纳字段' })
                        } else {
                            setStreamState('error')
                            setStreamError('AI 输出无法解析为有效 JSON，请重试或切换到手动编辑模式')
                            toast.error({ title: '解析失败', message: 'AI 输出格式异常，已切换为错误态' })
                        }
                        return prev
                    })
                    setRefining(false)
                    streamControllerRef.current = null
                },
                onError: (err: Error) => {
                    setStreamError(err.message)
                    setStreamState('error')
                    setRefining(false)
                    streamControllerRef.current = null
                    toast.error({ title: 'AI 精修失败', message: getDisplayError(err, '网络或模型异常') })
                },
            },
        )

        streamControllerRef.current = controller
    }, [question, instruction, setRefining])

    /** 中断流式 */
    const abortStream = useCallback(() => {
        if (streamControllerRef.current?.streaming) {
            streamControllerRef.current.abort()
            streamControllerRef.current = null
        }
        setStreamState('idle')
        setRefining(false)
        toast.info({ title: '已中断', message: 'AI 精修流已停止' })
    }, [setRefining])

    /* ------------------------------------------------------------
     * 卸载时清理
     * ---------------------------------------------------------- */
    useEffect(() => {
        return () => {
            if (streamControllerRef.current?.streaming) {
                streamControllerRef.current.abort()
                streamControllerRef.current = null
            }
        }
    }, [])

    /* ------------------------------------------------------------
     * 保存到后端（PATCH /api/workbench/questions/:id）
     * ---------------------------------------------------------- */
    const saveMutation = useMutation({
        mutationFn: async (params: { questionId: string; patch: Partial<WorkbenchQuestionMeta> }) => {
            return api.workbench.updateQuestion(params.questionId, params.patch)
        },
        onSuccess: () => {
            toast.success({ title: '微调已应用', message: '题卡内容已保存到题库' })
            void queryClient.invalidateQueries({ queryKey: ['workbench', 'questions'] })
            void queryClient.invalidateQueries({ queryKey: ['workbench', 'question-verification'] })
            onClose()
        },
        onError: (err) => {
            toast.error({ title: '保存失败', message: getDisplayError(err, '请稍后重试') })
        },
    })

    /** 全部接受：保存所有 currentPatch 字段 */
    const handleAcceptAll = useCallback(() => {
        if (!question || !currentPatch) return
        const patch: Partial<WorkbenchQuestionMeta> = {}
        if (currentPatch.stem !== undefined) patch.stem = currentPatch.stem
        if (currentPatch.answer !== undefined) patch.answer = currentPatch.answer
        if (currentPatch.analysis !== undefined) patch.analysis = currentPatch.analysis
        if (currentPatch.options !== undefined) patch.options = currentPatch.options
        if (currentPatch.distractorsAnalysis !== undefined) {
            patch.distractorsAnalysis = currentPatch.distractorsAnalysis
        }
        if (currentPatch.difficulty !== undefined) patch.difficulty = currentPatch.difficulty
        saveMutation.mutate({ questionId: question.id, patch })
    }, [question, currentPatch, saveMutation])

    /** 部分采纳：仅保存勾选的字段 */
    const handleAdoptSelected = useCallback(() => {
        if (!question || !currentPatch) return
        const patch: Partial<WorkbenchQuestionMeta> = {}
        if (currentPatch.stem !== undefined && adopted.stem) patch.stem = currentPatch.stem
        if (currentPatch.answer !== undefined && adopted.answer) patch.answer = currentPatch.answer
        if (currentPatch.analysis !== undefined && adopted.analysis) {
            patch.analysis = currentPatch.analysis
        }
        if (currentPatch.options !== undefined && adopted.options) patch.options = currentPatch.options
        if (currentPatch.distractorsAnalysis !== undefined && adopted.distractorsAnalysis) {
            patch.distractorsAnalysis = currentPatch.distractorsAnalysis
        }
        if (currentPatch.difficulty !== undefined && adopted.difficulty) {
            patch.difficulty = currentPatch.difficulty
        }
        if (Object.keys(patch).length === 0) {
            toast.warning({ title: '未选择字段', message: '请至少勾选一个要采纳的字段' })
            return
        }
        saveMutation.mutate({ questionId: question.id, patch })
    }, [question, currentPatch, adopted, saveMutation])

    /** 拒绝：放弃所有修改 */
    const handleReject = useCallback(() => {
        if (streamControllerRef.current?.streaming) {
            streamControllerRef.current.abort()
            streamControllerRef.current = null
        }
        setRefining(false)
        toast.info({ title: '已放弃修改', message: '题卡内容保持原状' })
        onClose()
    }, [setRefining, onClose])

    /** 切换字段勾选 */
    const toggleAdopted = useCallback((field: RefineField) => {
        setAdopted((prev) => ({ ...prev, [field]: !prev[field] }))
    }, [])

    /** 应用模板 */
    const handleTemplate = useCallback((prompt: string) => {
        setInstruction(prompt)
    }, [])

    /* ------------------------------------------------------------
     * 手动编辑：字段值 setter
     * ---------------------------------------------------------- */
    const updateManualField = useCallback(
        <K extends keyof RefinedPatch,>(key: K, value: RefinedPatch[K]) => {
            setManualPatch((prev) => ({ ...prev, [key]: value }))
        },
        [],
    )

    /* ------------------------------------------------------------
     * 渲染
     * ---------------------------------------------------------- */
    const isStreaming = streamState === 'streaming'
    const isSaving = saveMutation.isPending
    const canAccept = hasRefinement && adoptedCount > 0 && !isStreaming && !isSaving

    const selectRefineMode = useCallback((nextMode: RefineMode) => {
        if (isStreaming || isSaving) return
        setMode(nextMode)
    }, [isSaving, isStreaming])

    const handleModeTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
        if (isStreaming || isSaving) return
        const currentIndex = REFINE_MODES.indexOf(mode)
        let nextIndex: number
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                nextIndex = (currentIndex + 1) % REFINE_MODES.length
                break
            case 'ArrowLeft':
            case 'ArrowUp':
                nextIndex = (currentIndex - 1 + REFINE_MODES.length) % REFINE_MODES.length
                break
            case 'Home':
                nextIndex = 0
                break
            case 'End':
                nextIndex = REFINE_MODES.length - 1
                break
            default:
                return
        }
        event.preventDefault()
        const nextMode = REFINE_MODES[nextIndex]
        if (!nextMode) return
        setMode(nextMode)
        event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-refine-mode-tab="${nextMode}"]`)
            ?.focus()
    }, [isSaving, isStreaming, mode])

    if (!question) return null

    const bloomColor = WORKBENCH_BLOOM_COLORS[question.bloomLevel]

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="lg"
            title="诗笔·微调"
            className="pr-wb-refine-modal"
            footer={
                <div className="pr-wb-refine-footer">
                    <Button
                        variant="ghost"
                        size="md"
                        onClick={handleReject}
                        disabled={isSaving}
                        leftIcon={<Icon name="x-circle" size={14} />}
                    >
                        拒绝
                    </Button>
                    <Button
                        variant="secondary"
                        size="md"
                        onClick={handleAdoptSelected}
                        disabled={!canAccept}
                        leftIcon={<Icon name="check" size={14} />}
                    >
                        部分采纳 ({adoptedCount})
                    </Button>
                    <Button
                        variant="primary"
                        size="md"
                        onClick={handleAcceptAll}
                        disabled={!hasRefinement || isStreaming || isSaving}
                        loading={isSaving}
                        loadingLabel="保存中…"
                        leftIcon={!isSaving ? <Icon name="check-circle" size={14} /> : undefined}
                    >
                        全部接受
                    </Button>
                </div>
            }
        >
            <div className="pr-wb-refine">
                {/* 当前题目摘要 */}
                <section className="pr-wb-refine-current">
                    <div className="pr-wb-refine-current-head">
                        <Badge variant="primary">{question.type}</Badge>
                        <Badge
                            variant="default"
                            icon={
                                <span
                                    className="pr-wb-q-bloom-dot"
                                    style={{ backgroundColor: bloomColor }}
                                />
                            }
                        >
                            {question.bloomLevel}
                        </Badge>
                        <span className="pr-wb-refine-current-meta">
                            难度 {question.difficulty} · 预计 {question.estimatedTimeSec}s
                        </span>
                    </div>
                    <div className="pr-wb-refine-current-stem">
                        <Markdown content={question.stem} />
                    </div>
                </section>

                {/* 模式切换 Tab */}
                <section
                    className="pr-wb-refine-tabs"
                    role="tablist"
                    aria-label="微调模式"
                    onKeyDown={handleModeTabKeyDown}
                >
                    <button
                        id="wb-refine-mode-tab-ai"
                        data-refine-mode-tab="ai"
                        type="button"
                        role="tab"
                        aria-selected={mode === 'ai'}
                        aria-controls="wb-refine-mode-panel"
                        tabIndex={mode === 'ai' ? 0 : -1}
                        className={`pr-wb-refine-tab ${mode === 'ai' ? 'is-active' : ''}`}
                        onClick={() => selectRefineMode('ai')}
                        disabled={isStreaming || isSaving}
                    >
                        <Icon name="sparkle" size={14} />
                        <span>AI 精修</span>
                        {streamState === 'done' && (
                            <Badge variant="success">已生成</Badge>
                        )}
                        {streamState === 'error' && (
                            <Badge variant="error">失败</Badge>
                        )}
                    </button>
                    <button
                        id="wb-refine-mode-tab-manual"
                        data-refine-mode-tab="manual"
                        type="button"
                        role="tab"
                        aria-selected={mode === 'manual'}
                        aria-controls="wb-refine-mode-panel"
                        tabIndex={mode === 'manual' ? 0 : -1}
                        className={`pr-wb-refine-tab ${mode === 'manual' ? 'is-active' : ''}`}
                        onClick={() => selectRefineMode('manual')}
                        disabled={isStreaming || isSaving}
                    >
                        <Icon name="pencil-simple-line" size={14} />
                        <span>手动编辑</span>
                    </button>
                </section>

                <div
                    id="wb-refine-mode-panel"
                    role="tabpanel"
                    aria-labelledby={`wb-refine-mode-tab-${mode}`}
                    aria-busy={isStreaming || isSaving}
                >
                {/* AI 精修模式 */}
                {mode === 'ai' && (
                    <div className="pr-wb-refine-ai">
                        {/* 模板快捷 */}
                        <section className="pr-wb-refine-templates">
                            <div className="pr-wb-refine-templates-label">
                                <Icon name="lightbulb" size={14} />
                                <span>快捷模板</span>
                            </div>
                            <div className="pr-wb-refine-templates-grid">
                                {REFINE_TEMPLATES.map((tpl) => (
                                    <button
                                        key={tpl.key}
                                        type="button"
                                        className="pr-wb-refine-template"
                                        onClick={() => handleTemplate(tpl.prompt)}
                                        disabled={isStreaming || isSaving}
                                    >
                                        <Icon name={tpl.icon as 'list'} size={14} />
                                        <span>{tpl.label}</span>
                                    </button>
                                ))}
                            </div>
                        </section>

                        {/* 自然语言输入 */}
                        <section className="pr-wb-refine-input-section">
                            <label
                                className="pr-wb-refine-input-label"
                                htmlFor="wb-refine-input"
                            >
                                <Icon name="pen-nib" size={14} />
                                <span>修改意见</span>
                            </label>
                            <div className="pr-wb-refine-input-wrap">
                                <Input
                                    id="wb-refine-input"
                                    multiline
                                    rows={4}
                                    placeholder="例如：将本题的选项 B 改为更具迷惑性的表述，结合学生常见误解……"
                                    value={instruction}
                                    onChange={(e) =>
                                        setInstruction(
                                            (e.target as HTMLTextAreaElement).value,
                                        )
                                    }
                                    disabled={isStreaming || isSaving}
                                />
                            </div>
                            <div className="pr-wb-refine-ai-actions">
                                {!isStreaming ? (
                                    <Button
                                        variant="primary"
                                        size="sm"
                                        onClick={startAiStream}
                                        disabled={!instruction.trim() || isSaving}
                                        leftIcon={<Icon name="sparkle" size={14} />}
                                    >
                                        开始 AI 精修
                                    </Button>
                                ) : (
                                    <Button
                                        variant="danger"
                                        size="sm"
                                        onClick={abortStream}
                                        leftIcon={<Icon name="stop" size={14} />}
                                    >
                                        中断生成
                                    </Button>
                                )}
                                <span className="pr-wb-refine-ai-meta">
                                    deepseek-v4-pro · thinking: medium · 流式
                                </span>
                            </div>
                        </section>

                        {/* 流式输出区域 */}
                        {isStreaming && (
                            <section className="pr-wb-refine-stream-output">
                                <div className="pr-wb-refine-stream-head">
                                    <Icon name="circle-notch" size={14} />
                                    <span>AI 正在生成精修方案…</span>
                                    <span className="pr-wb-refine-cursor" aria-hidden />
                                </div>
                                <pre className="pr-wb-refine-stream-body" aria-live="polite">
                                    {streamingText || '等待模型响应…'}
                                </pre>
                            </section>
                        )}

                        {/* 流式错误提示 */}
                        {streamState === 'error' && streamError && (
                            <section className="pr-wb-refine-stream-error">
                                <Icon name="warning-circle" size={14} />
                                <span>{streamError}</span>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={startAiStream}
                                    disabled={!instruction.trim()}
                                    leftIcon={<Icon name="arrows-clockwise" size={14} />}
                                >
                                    重试
                                </Button>
                            </section>
                        )}
                    </div>
                )}

                {/* 手动编辑模式 */}
                {mode === 'manual' && (
                    <div className="pr-wb-refine-manual">
                        <div className="pr-wb-refine-manual-grid">
                            <label className="pr-wb-refine-manual-field" htmlFor="wb-refine-stem">
                                <span className="pr-wb-refine-manual-label">
                                    <Icon name="pen-nib" size={12} />
                                    题干（Markdown）
                                </span>
                                <Input
                                    id="wb-refine-stem"
                                    multiline
                                    rows={5}
                                    value={manualPatch.stem ?? question.stem}
                                    onChange={(e) =>
                                        updateManualField(
                                            'stem',
                                            (e.target as HTMLTextAreaElement).value,
                                        )
                                    }
                                    disabled={isSaving}
                                />
                            </label>

                            <label
                                className="pr-wb-refine-manual-field"
                                htmlFor="wb-refine-answer"
                            >
                                <span className="pr-wb-refine-manual-label">
                                    <Icon name="check" size={12} />
                                    答案
                                </span>
                                <Input
                                    id="wb-refine-answer"
                                    multiline
                                    rows={2}
                                    value={manualPatch.answer ?? question.answer}
                                    onChange={(e) =>
                                        updateManualField(
                                            'answer',
                                            (e.target as HTMLTextAreaElement).value,
                                        )
                                    }
                                    disabled={isSaving}
                                />
                            </label>

                            <label
                                className="pr-wb-refine-manual-field"
                                htmlFor="wb-refine-analysis"
                            >
                                <span className="pr-wb-refine-manual-label">
                                    <Icon name="lightbulb" size={12} />
                                    解析（Markdown）
                                </span>
                                <Input
                                    id="wb-refine-analysis"
                                    multiline
                                    rows={6}
                                    value={manualPatch.analysis ?? question.analysis}
                                    onChange={(e) =>
                                        updateManualField(
                                            'analysis',
                                            (e.target as HTMLTextAreaElement).value,
                                        )
                                    }
                                    disabled={isSaving}
                                />
                            </label>

                            <label
                                className="pr-wb-refine-manual-field"
                                htmlFor="wb-refine-difficulty"
                            >
                                <span className="pr-wb-refine-manual-label">
                                    <Icon name="chart-bar" size={12} />
                                    难度 (1-5)
                                </span>
                                <Input
                                    id="wb-refine-difficulty"
                                    type="number"
                                    min={1}
                                    max={5}
                                    step={1}
                                    value={String(manualPatch.difficulty ?? question.difficulty)}
                                    onChange={(e) => {
                                        const v = Number((e.target as HTMLInputElement).value)
                                        if (
                                            Number.isInteger(v) &&
                                            v >= 1 &&
                                            v <= 5
                                        ) {
                                            updateManualField(
                                                'difficulty',
                                                v as 1 | 2 | 3 | 4 | 5,
                                            )
                                        }
                                    }}
                                    disabled={isSaving}
                                />
                            </label>

                            {question.options && question.options.length > 0 && (
                                <label
                                    className="pr-wb-refine-manual-field"
                                    htmlFor="wb-refine-options"
                                >
                                    <span className="pr-wb-refine-manual-label">
                                        <Icon name="list" size={12} />
                                        选项（每行一项）
                                    </span>
                                    <Input
                                        id="wb-refine-options"
                                        multiline
                                        rows={4}
                                        value={(manualPatch.options ?? question.options).join('\n')}
                                        onChange={(e) => {
                                            const arr = (e.target as HTMLTextAreaElement).value
                                                .split('\n')
                                                .filter((l) => l.trim())
                                            updateManualField('options', arr)
                                        }}
                                        disabled={isSaving}
                                    />
                                </label>
                            )}
                        </div>
                    </div>
                )}
                </div>

                {/* 前后对比 */}
                {hasRefinement && currentPatch && (
                    <section className="pr-wb-refine-compare">
                        <div className="pr-wb-refine-compare-header">
                            <div className="pr-wb-refine-compare-title">
                                <Icon name="scale" size={14} />
                                <span>前后对比</span>
                                <Badge variant="primary">
                                    {mode === 'ai' ? 'AI 生成' : '手动编辑'}
                                </Badge>
                            </div>
                            {/* 字段勾选 */}
                            <div className="pr-wb-refine-adopt">
                                {ADOPTABLE_FIELDS.map((f) => {
                                    const value = currentPatch[f.key]
                                    if (value === undefined) return null
                                    return (
                                        <label
                                            key={f.key}
                                            className="pr-wb-refine-adopt-item"
                                            title={`采纳 ${f.label}`}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={adopted[f.key]}
                                                onChange={() => toggleAdopted(f.key)}
                                                disabled={isSaving}
                                            />
                                            <Icon name={f.icon as 'list'} size={12} />
                                            <span>{f.label}</span>
                                        </label>
                                    )
                                })}
                            </div>
                        </div>

                        <div className="pr-wb-refine-compare-grid">
                            {/* 左：原始 */}
                            <div className="pr-wb-refine-compare-col pr-wb-refine-compare-col--before">
                                <div className="pr-wb-refine-compare-col-label">
                                    <Icon name="clock" size={12} />
                                    <span>微调前</span>
                                </div>
                                <div className="pr-wb-refine-compare-fields">
                                    <CompareField label="题干">
                                        <Markdown content={question.stem} />
                                    </CompareField>
                                    <CompareField label="答案">
                                        <span className="pr-wb-refine-compare-text">
                                            {question.answer}
                                        </span>
                                    </CompareField>
                                    <CompareField label="解析">
                                        <Markdown content={question.analysis} />
                                    </CompareField>
                                    <CompareField label="难度">
                                        <span className="pr-wb-refine-compare-text">
                                            {question.difficulty}/5
                                        </span>
                                    </CompareField>
                                    {question.options && question.options.length > 0 && (
                                        <CompareField label="选项">
                                            <ol className="pr-wb-refine-compare-list">
                                                {question.options.map((opt, i) => (
                                                    <li key={i}>{opt}</li>
                                                ))}
                                            </ol>
                                        </CompareField>
                                    )}
                                </div>
                            </div>

                            {/* 箭头 */}
                            <div className="pr-wb-refine-compare-arrow" aria-hidden>
                                <Icon name="arrow-right" size={16} />
                            </div>

                            {/* 右：精修后 */}
                            <div className="pr-wb-refine-compare-col pr-wb-refine-compare-col--after">
                                <div className="pr-wb-refine-compare-col-label">
                                    <Icon name="sparkle" size={12} />
                                    <span>微调后</span>
                                    {adoptedCount > 0 && (
                                        <Badge variant="success">
                                            采纳 {adoptedCount} 项
                                        </Badge>
                                    )}
                                </div>
                                <div className="pr-wb-refine-compare-fields">
                                    {currentPatch.stem !== undefined ? (
                                        <CompareField
                                            label="题干"
                                            highlighted={adopted.stem}
                                        >
                                            <Markdown
                                                content={currentPatch.stem}
                                                streaming={mode === 'ai' && isStreaming}
                                            />
                                        </CompareField>
                                    ) : null}
                                    {currentPatch.answer !== undefined && (
                                        <CompareField
                                            label="答案"
                                            highlighted={adopted.answer}
                                        >
                                            <span className="pr-wb-refine-compare-text">
                                                {currentPatch.answer}
                                            </span>
                                        </CompareField>
                                    )}
                                    {currentPatch.analysis !== undefined && (
                                        <CompareField
                                            label="解析"
                                            highlighted={adopted.analysis}
                                        >
                                            <Markdown
                                                content={currentPatch.analysis}
                                                streaming={mode === 'ai' && isStreaming}
                                            />
                                        </CompareField>
                                    )}
                                    {currentPatch.difficulty !== undefined && (
                                        <CompareField
                                            label="难度"
                                            highlighted={adopted.difficulty}
                                        >
                                            <span className="pr-wb-refine-compare-text">
                                                {currentPatch.difficulty}/5
                                            </span>
                                        </CompareField>
                                    )}
                                    {currentPatch.options !== undefined &&
                                        currentPatch.options.length > 0 && (
                                            <CompareField
                                                label="选项"
                                                highlighted={adopted.options}
                                            >
                                                <ol className="pr-wb-refine-compare-list">
                                                    {currentPatch.options.map((opt, i) => (
                                                        <li key={i}>{opt}</li>
                                                    ))}
                                                </ol>
                                            </CompareField>
                                        )}
                                    {currentPatch.distractorsAnalysis !== undefined &&
                                        currentPatch.distractorsAnalysis.length > 0 && (
                                            <CompareField
                                                label="干扰项分析"
                                                highlighted={adopted.distractorsAnalysis}
                                            >
                                                <ul className="pr-wb-refine-compare-list">
                                                    {currentPatch.distractorsAnalysis.map(
                                                        (d, i) => (
                                                            <li key={i}>{d}</li>
                                                        ),
                                                    )}
                                                </ul>
                                            </CompareField>
                                        )}
                                </div>
                            </div>
                        </div>
                    </section>
                )}
            </div>
        </Modal>
    )
})

/* ============================================================
 * 子组件：对比字段
 * ============================================================ */

interface CompareFieldProps {
    label: string
    /** 是否高亮（已勾选采纳） */
    highlighted?: boolean
    children: React.ReactNode
}

const CompareField = memo(function CompareField({ label, highlighted, children }: CompareFieldProps) {
    return (
        <div className={`pr-wb-refine-compare-field ${highlighted ? 'is-highlighted' : ''}`}>
            <div className="pr-wb-refine-compare-field-label">{label}</div>
            <div className="pr-wb-refine-compare-field-body">{children}</div>
        </div>
    )
})
