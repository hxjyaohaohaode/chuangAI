/**
 * 聊天界面 v6（Task 24.2 + 24.3 全面重做）
 *
 * 职责：
 * 1. 卡片式对话：用户消息右对齐 surface-secondary，助手消息左对齐玻璃态
 * 2. 流式输出：调用 /api/ai/chat SSE 端点，逐字推送 + 脉动光标
 * 3. 中断/继续：AbortController 中断流式，中断后可继续输入新消息
 * 4. Markdown 渲染：react-markdown + remark-gfm + rehype-highlight（通过 Markdown 组件）
 * 5. 长消息折叠：超过 500 字自动折叠，显示"展开全文"按钮
 * 6. 物料插入：监听 pendingInsert，追加 @[类型:ID:标题] 引用到输入框
 * 7. Cmd/Ctrl + Enter 发送，Enter 换行
 *
 * 设计要点（规范第 7、9、11、14 章）：
 * - user 气泡右对齐 surface-secondary，assistant 左对齐 surface-elevated + backdrop-blur
 * - 流式输出：Markdown streaming prop 自动显示脉动光标（规范第 11 章）
 * - staggered 入场：每条新消息 fadeInUp 250ms ease-out
 * - 输入框 focus 时 accent 光晕，无硬边框
 * - 零 emoji，全部使用 Phosphor SVG 图标
 * - content-visibility: auto 优化长列表渲染（>50 条消息）
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/ui'
import { Markdown } from '@/components/ui/Markdown'
import { useCopilotStore } from '@/stores/copilot'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { toast } from '@/stores/toast'
import type { CopilotMessage, AiChatStreamController, AiAutoRouteNotice } from '@/lib/types'
import { useAttachments, MAX_ATTACHMENTS } from './useAttachments'
import { AttachmentTray } from './AttachmentTray'
import { QuickVoiceAssist } from '@/components/ui/QuickVoiceAssist'
import { PlanApprovalPanel } from './PlanApprovalPanel'
import type { CopilotInteractionMode } from './InterventionBar'

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 长消息折叠阈值（字符数） */
const COLLAPSE_THRESHOLD = 500

/** 系统提示词 —— 定义 AI 副驾的角色与回答风格 */
const SYSTEM_PROMPT = {
    role: 'system' as const,
    content:
        '你是诗脉·启明的 AI 副驾，一位深谙古诗教学的教育专家。' +
        '请用温暖、专业、富有诗意的中文回答教师的问题。' +
        '回答时适当使用 Markdown 格式（标题、列表、加粗）以提升可读性。' +
        '当教师引用上下文物料（如 @[学生:ID:姓名]）时，请基于该物料的具体信息作答。',
}

/** 对话上下文窗口（保留最近 N 轮对话） */
const CONTEXT_WINDOW_SIZE = 20

/**
 * v7：空状态快捷指令卡片 —— 点击即填入预设 prompt 到输入框
 *
 * 设计意图：消除"小家子气"观感，提供明确的能力入口
 * 每张卡片包含 icon/title/desc，对应真实业务场景
 */
interface QuickAction {
    icon: 'graduation' | 'chart-bar' | 'feather' | 'heart'
    title: string
    desc: string
    prompt: string
}

const QUICK_ACTIONS: readonly QuickAction[] = [
    {
        icon: 'graduation',
        title: '教学设计',
        desc: '生成包含导入、新授、巩固、作业的完整教学方案',
        prompt: '为三年级生成《静夜思》教学设计，包含导入、新授、巩固、作业四个环节，并给出每环节的师生互动设计。',
    },
    {
        icon: 'chart-bar',
        title: '学情诊断',
        desc: '分析班级最近一次古诗默写情况，找出薄弱学生与共性错误',
        prompt: '请分析班级最近一次古诗默写情况，找出薄弱学生和共性错误，并给出针对性补救建议。',
    },
    {
        icon: 'feather',
        title: '诗词创作',
        desc: '依题创作格律诗，并解释选词与意境构造的思路',
        prompt: "请以「秋日校园」为题，创作一首七言绝句，严格遵守平仄格律，并解释选词与意境构造的思路。",
    },
    {
        icon: 'heart',
        title: '个性化辅导',
        desc: '为学困生定制为期两周的古诗补习计划与每日任务',
        prompt: '请针对学困生小明，制定为期两周的古诗补习计划，包含每日任务、检测方式与激励机制。',
    },
] as const

/** 对话进行中仍然可一键追加的高频追问，避免每轮都重新组织文字。 */
const FOLLOW_UP_ACTIONS = [
    '请讲得更适合小学生',
    '请举一个课堂例子',
    '请整理成可直接使用的步骤',
    '请再精简一些',
] as const

// ─────────────────────────────────────────────────────────────
// 单条消息气泡
// ─────────────────────────────────────────────────────────────

interface MessageBubbleProps {
    message: CopilotMessage
    isStreaming: boolean
}

/**
 * 朗读按钮 —— 语音输出（mimo-v2.5-tts）
 *
 * 只出现在**已完成**的 assistant 消息上：流式还在写的时候朗读，
 * 念到一半内容就变了。
 * TTS 上限 4000 字（后端 schema），超长时截断并明确告知，
 * 而不是静默只念开头。
 */
const SpeakButton = memo(function SpeakButton({ text }: { text: string }) {
    const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle')
    const audioRef = useRef<HTMLAudioElement | null>(null)
    const audioUrlRef = useRef<string | null>(null)

    const stop = useCallback(() => {
        const audio = audioRef.current
        if (audio) {
            audio.onended = null
            audio.onerror = null
            audio.pause()
            audio.removeAttribute('src')
            audio.load()
        }
        audioRef.current = null
        if (audioUrlRef.current?.startsWith('blob:')) URL.revokeObjectURL(audioUrlRef.current)
        audioUrlRef.current = null
        setState('idle')
    }, [])

    useEffect(() => stop, [stop])

    const speak = useCallback(async () => {
        if (state === 'playing') { stop(); return }
        const MAX_TTS = 4000
        const truncated = text.length > MAX_TTS
        const payload = truncated ? text.slice(0, MAX_TTS) : text
        setState('loading')
        try {
            const res = await api.ai.tts({ text: payload })
            if (truncated) {
                toast.info({
                    title: '内容过长，仅朗读前 4000 字',
                    message: 'mimo-v2.5-tts 单次合成上限为 4000 字',
                })
            }
            const audio = new Audio(res.audioUrl)
            audioRef.current = audio
            audioUrlRef.current = res.audioUrl
            audio.onended = stop
            audio.onerror = () => {
                stop()
                toast.error({ title: '朗读失败', message: '音频无法播放' })
            }
            await audio.play()
            setState('playing')
        } catch (err) {
            stop()
            toast.error({
                title: '朗读失败',
                message: err instanceof Error ? err.message : '语音合成调用失败',
            })
        }
    }, [state, stop, text])

    return (
        <button
            type="button"
            className="pr-copilot-chat-speak"
            onClick={() => void speak()}
            disabled={state === 'loading'}
            aria-label={state === 'playing' ? '停止朗读' : '朗读这条回复'}
            title={state === 'playing' ? '停止朗读' : '朗读这条回复（mimo-v2.5-tts）'}
        >
            <Icon
                name={state === 'playing' ? 'stop' : state === 'loading' ? 'spinner' : 'speaker-high'}
                size={13}
            />
            <span>{state === 'playing' ? '停止' : state === 'loading' ? '合成中' : '朗读'}</span>
        </button>
    )
})

const MessageBubble = memo(function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
    const [expanded, setExpanded] = useState(false)
    const isUser = message.role === 'user'
    const isAssistant = message.role === 'assistant'
    const isSystem = message.role === 'system'

    const timeStr = new Date(message.timestamp).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
    })

    // system 消息居中简化展示
    if (isSystem) {
        return (
            <div className="pr-copilot-chat-msg pr-copilot-chat-msg--system">
                <span className="pr-copilot-chat-msg-system-icon">
                    <Icon name="info" size={12} />
                </span>
                <span className="pr-copilot-chat-msg-system-text">{message.content}</span>
                <span className="pr-copilot-chat-msg-time">{timeStr}</span>
            </div>
        )
    }

    // 长消息折叠逻辑（仅非流式的 assistant 消息）
    const shouldCollapse = isAssistant && !isStreaming && message.content.length > COLLAPSE_THRESHOLD
    const displayContent = shouldCollapse && !expanded
        ? message.content.slice(0, COLLAPSE_THRESHOLD) + '\n\n...（已折叠，点击展开全文）'
        : message.content

    return (
        <div
            className={cn('pr-copilot-chat-msg', {
                'pr-copilot-chat-msg--user': isUser,
                'pr-copilot-chat-msg--assistant': isAssistant,
            })}
        >
            {/* 头像 */}
            <div className="pr-copilot-chat-msg-avatar">
                <Icon name={isUser ? 'user' : 'sparkle'} size={16} />
            </div>

            {/* 气泡 */}
            <div className="pr-copilot-chat-msg-bubble">
                {isUser ? (
                    <p className="pr-copilot-chat-msg-text">{message.content}</p>
                ) : (
                    <>
                        {isStreaming && !message.content ? (
                            // v7：流式"思考中"脉动点指示器 —— 替代"（等待模型响应…）"文本
                            <div className="pr-copilot-chat-thinking" aria-label="AI 正在思考">
                                <span className="pr-copilot-chat-thinking-dot" />
                                <span className="pr-copilot-chat-thinking-dot" />
                                <span className="pr-copilot-chat-thinking-dot" />
                            </div>
                        ) : (
                            <Markdown
                                content={displayContent}
                                streaming={isStreaming}
                            />
                        )}
                        <div className="pr-copilot-chat-msg-actions">
                            {shouldCollapse && (
                                <button
                                    type="button"
                                    className="pr-copilot-chat-msg-collapse-btn"
                                    onClick={() => setExpanded(!expanded)}
                                    aria-expanded={expanded}
                                >
                                    <Icon name={expanded ? 'caret-up' : 'caret-down'} size={12} />
                                    <span>{expanded ? '收起' : '展开全文'}</span>
                                </button>
                            )}
                            {/* 语音输出：仅对已写完的回复开放 */}
                            {!isStreaming && message.content.trim() && (
                                <SpeakButton text={message.content} />
                            )}
                        </div>
                    </>
                )}
                <span className="pr-copilot-chat-msg-time">{timeStr}</span>
            </div>
        </div>
    )
})

// ─────────────────────────────────────────────────────────────
// 空状态
// ─────────────────────────────────────────────────────────────

interface EmptyStateProps {
    onPickQuickAction: (prompt: string) => void
    interactionMode: CopilotInteractionMode
}

/**
 * v7：空状态全面重做
 *
 * - 96px 图标 + 脉动光环（视觉锚点）
 * - text-3xl 标题 + 560px 描述宽度（消除局促感）
 * - 4 张快捷指令卡片 grid 2x2（明确能力入口，点击即填入 prompt）
 * - 鼠标跟踪光韵（radial-gradient 跟随 --mx/--my，呼应 MagicBento 设计语言）
 */
function EmptyState({ onPickQuickAction, interactionMode }: EmptyStateProps) {
    // 鼠标跟踪 —— 设置 --mx/--my CSS 变量驱动卡片光韵
    const handleHintMove = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const x = ((e.clientX - rect.left) / rect.width) * 100
        const y = ((e.clientY - rect.top) / rect.height) * 100
        e.currentTarget.style.setProperty('--mx', `${x}%`)
        e.currentTarget.style.setProperty('--my', `${y}%`)
    }, [])

    return (
        <div className="pr-copilot-chat-empty">
            <div className="pr-copilot-chat-empty-icon">
                <Icon name="sparkle" size={48} />
            </div>
            <h3 className="pr-copilot-chat-empty-title">AI 副驾已就绪</h3>
            <p className="pr-copilot-chat-empty-desc">
                {interactionMode === 'agent'
                    ? '描述一个需要多步骤协作的教学任务。AI 会先生成可编辑计划，只有教师批准后才会执行。'
                    : '用自然语言描述您的教学需求，AI 副驾将通过深度思考为您提供专业建议。也可点击下方快捷指令快速开始。'}
            </p>
            <div className="pr-copilot-chat-empty-hints">
                {QUICK_ACTIONS.map((action) => (
                    <button
                        key={action.title}
                        type="button"
                        className="pr-copilot-chat-empty-hint"
                        onMouseMove={handleHintMove}
                        onClick={() => onPickQuickAction(action.prompt)}
                        aria-label={`快捷指令：${action.title}`}
                    >
                        <span className="pr-copilot-chat-empty-hint-icon">
                            <Icon name={action.icon} size={16} />
                        </span>
                        <span className="pr-copilot-chat-empty-hint-title">{action.title}</span>
                        <span className="pr-copilot-chat-empty-hint-desc">{action.desc}</span>
                    </button>
                ))}
            </div>
        </div>
    )
}

// ─────────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────────

export interface ChatInterfaceProps {
    interactionMode: CopilotInteractionMode
    /** 当前选择的模型名称 */
    chatModel: string
    /** 思考模式 */
    chatThinkingMode: 'low' | 'high' | 'max'
    /** 采样温度 */
    chatTemperature: number
    /** 待插入的物料引用（由 QuickActions 触发） */
    pendingInsert: string | null
    /** 物料插入完成回调 */
    onInsertConsumed: () => void
}

export const ChatInterface = memo(function ChatInterface({
    interactionMode,
    chatModel,
    chatThinkingMode,
    chatTemperature,
    pendingInsert,
    onInsertConsumed,
}: ChatInterfaceProps) {
    const messages = useCopilotStore((s) => s.messages)
    const streamingMessageId = useCopilotStore((s) => s.streamingMessageId)
    const appendStreamDelta = useCopilotStore((s) => s.appendStreamDelta)
    const startStreamingAssistant = useCopilotStore((s) => s.startStreamingAssistant)
    const finalizeStreamingMessage = useCopilotStore((s) => s.finalizeStreamingMessage)
    const sendPlannedMessage = useCopilotStore((s) => s.sendMessage)
    const sending = useCopilotStore((s) => s.sending)

    /** 流式控制器（用于中断） */
    const streamControllerRef = useRef<AiChatStreamController | null>(null)
    /** 当前流式消息 id */
    const streamingMsgIdRef = useRef<string | null>(null)
    /** 流式进行中 */
    const [streaming, setStreaming] = useState(false)

    const [input, setInput] = useState('')
    /** 拖拽悬停态（整块对话区都是投放目标，命中率比一个小图标高得多） */
    const [dragOver, setDragOver] = useState(false)
    /**
     * 服务端按能力自动改选模型的提示
     *
     * 带图片时服务端会强制路由到 mimo-v2.5（唯一多模态模型）。
     * 这件事必须显式告诉用户：否则底部仍写着"当前模型 deepseek-v4-pro"，
     * 而真正作答的是另一个模型，界面就在说假话。
     */
    const [autoRoute, setAutoRoute] = useState<AiAutoRouteNotice | null>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)

    const attach = useAttachments((title, message) => toast.error({ title, message }))

    /** v7：物料插入闪烁动画触发器（数据链路可视化反馈） */
    const [isInserted, setIsInserted] = useState(false)
    const insertTimerRef = useRef<number | null>(null)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const bottomRef = useRef<HTMLDivElement>(null)

    // 物料插入 —— 追加到输入框 + 触发闪烁动画（视觉反馈"数据已打通"）
    useEffect(() => {
        if (pendingInsert) {
            setInput((prev) => prev + (prev ? ' ' : '') + pendingInsert)
            onInsertConsumed()
            textareaRef.current?.focus()

            // v7：触发 is-inserted 闪烁动画，600ms 后自动移除（与 CSS keyframes 时长对齐）
            setIsInserted(true)
            if (insertTimerRef.current) {
                window.clearTimeout(insertTimerRef.current)
            }
            insertTimerRef.current = window.setTimeout(() => {
                setIsInserted(false)
                insertTimerRef.current = null
            }, 650)
        }
    }, [pendingInsert, onInsertConsumed])

    // 卸载时清理定时器
    useEffect(() => {
        return () => {
            if (insertTimerRef.current) {
                window.clearTimeout(insertTimerRef.current)
            }
        }
    }, [])

    /**
     * v7：快捷指令点击 —— 填入预设 prompt 到输入框并聚焦
     *
     * 设计意图：将 EmptyState 的 4 张快捷指令卡片与输入框打通，
     * 用户点击后无需手动输入即可开始对话，消除"空状态无入口"的局促感。
     */
    const handlePickQuickAction = useCallback((prompt: string) => {
        setInput(prompt)
        textareaRef.current?.focus()
        // 触发自适应高度重算
        requestAnimationFrame(() => {
            const ta = textareaRef.current
            if (!ta) return
            ta.style.height = 'auto'
            ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`
        })
    }, [])

    const handleAssistedInput = useCallback((content: string) => {
        setInput((previous) => previous.trim()
            ? `${previous.trim()}\n${content}`
            : content)
        requestAnimationFrame(() => textareaRef.current?.focus())
    }, [])

    // 自适应高度（v7：上限 160 → 180，与 CSS max-height 对齐）
    useEffect(() => {
        const ta = textareaRef.current
        if (!ta) return
        ta.style.height = 'auto'
        ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`
    }, [input])

    // 自动滚动到底部
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }, [messages, streamingMessageId])

    // 组件卸载时中止流式请求
    useEffect(() => {
        return () => {
            streamControllerRef.current?.abort()
        }
    }, [])

    /**
     * 发送消息 —— 调用 /api/ai/chat SSE 流式端点
     *
     * 数据流：
     *   1. 乐观追加 user 消息到 store
     *   2. 创建空的 assistant 流式消息（realStream=true）
     *   3. 构造 LLM 对话上下文（system prompt + 最近 20 轮历史 + 当前消息）
     *   4. 调用 api.ai.chatStream 启动 SSE 流式
     *   5. onChunk → appendStreamDelta 实时累加内容
     *   6. onDone → finalizeStreamingMessage 消息定型
     *   7. onError → toast 错误 + 消息定型
     */
    const handleSend = useCallback(() => {
        const trimmed = input.trim()
        const readyAttachments = attach.attachments.filter((a) => a.status === 'ready')
        if (interactionMode === 'agent') {
            if (!trimmed || streaming || sending) return
            if (readyAttachments.length > 0) {
                toast.warning({
                    title: '任务编排暂不读取附件',
                    message: '请把关键内容转成文字；附件仍保留，可切回问答模式发送。',
                })
                return
            }
            setInput('')
            void sendPlannedMessage(trimmed)
            return
        }
        // 只有附件、没有文字也应当可以发送（比如"看看这张图"这种场景，
        // 图本身就是全部内容）。但附件还在处理中时必须拦住：
        // 半成品发出去等于把图悄悄丢了。
        if ((!trimmed && readyAttachments.length === 0) || streaming || attach.processing) return

        const outboundContent = attach.buildContent(trimmed)

        // 1. 乐观追加 user 消息（气泡里存纯文本摘要；图片另存缩略图用于回显）
        const userMessage: CopilotMessage = {
            id: `u-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
            role: 'user',
            content: typeof outboundContent === 'string'
                ? outboundContent
                : outboundContent
                    .map((p) => (p.type === 'text' ? p.text : ''))
                    .filter(Boolean)
                    .join('\n') || '（图片）',
            timestamp: Date.now(),
        }
        useCopilotStore.setState((s) => ({ messages: [...s.messages, userMessage] }))

        // 2. 创建空的 assistant 流式消息
        const assistantId = startStreamingAssistant()
        streamingMsgIdRef.current = assistantId
        setStreaming(true)

        // 3. 构造 LLM 对话上下文
        //
        //    末尾要**同时**去掉两条：刚创建的空 assistant，以及上面刚追加的
        //    本轮 user 消息——后者会在第 4 步以多模态形式重新加入。
        //    只切掉一条（原实现）会让本轮提问在请求里出现两次。
        const recentMessages = useCopilotStore
            .getState()
            .messages.slice(-(CONTEXT_WINDOW_SIZE + 2), -2)
            .map((m) => ({
                role: (m.role === 'system'
                    ? 'system'
                    : m.role === 'user'
                        ? 'user'
                        : 'assistant') as 'system' | 'user' | 'assistant',
                content: m.content,
            }))

        // 4. 启动 SSE 流式
        //    历史消息一律以纯文本进入上下文；只有**本轮**这条带上多模态片段。
        //    把历史图片也重发一遍会让每轮请求体线性膨胀，很快撞上体积上限。
        streamControllerRef.current = api.ai.chatStream(
            {
                messages: [
                    SYSTEM_PROMPT,
                    ...recentMessages,
                    { role: 'user' as const, content: outboundContent },
                ],
                model: chatModel,
                thinking_mode: chatThinkingMode,
                temperature: chatTemperature,
                stream: true,
            },
            {
                onChunk: (chunk) => {
                    // 服务端按能力改选模型时，首帧会带 autoRouted。
                    // 必须原样展示，否则底部还写着用户选的那个模型名，
                    // 而实际作答的是另一个——界面在说假话。
                    if (chunk.autoRouted) setAutoRoute(chunk.autoRouted)
                    const msgId = streamingMsgIdRef.current
                    if (msgId && chunk.content) {
                        appendStreamDelta(msgId, chunk.content)
                    }
                },
                onDone: () => {
                    const msgId = streamingMsgIdRef.current
                    if (msgId) {
                        finalizeStreamingMessage(msgId)
                        streamingMsgIdRef.current = null
                    }
                    setStreaming(false)
                    streamControllerRef.current = null
                },
                onError: (err) => {
                    const msgId = streamingMsgIdRef.current
                    if (msgId) {
                        finalizeStreamingMessage(msgId)
                        streamingMsgIdRef.current = null
                    }
                    setStreaming(false)
                    streamControllerRef.current = null
                    toast.error({ title: '流式输出失败', message: err.message })
                },
            },
        )

        setInput('')
        // 附件只随本轮发出一次，随后清空——留着会在下一轮被重复发送
        attach.clear()
    }, [
        input,
        attach,
        interactionMode,
        sending,
        sendPlannedMessage,
        streaming,
        chatModel,
        chatThinkingMode,
        chatTemperature,
        startStreamingAssistant,
        appendStreamDelta,
        finalizeStreamingMessage,
    ])

    /**
     * 中断流式 —— 保留已生成内容，定型消息
     */
    const handleStopStream = useCallback(() => {
        streamControllerRef.current?.abort()
        const msgId = streamingMsgIdRef.current
        if (msgId) {
            finalizeStreamingMessage(msgId)
            streamingMsgIdRef.current = null
        }
        setStreaming(false)
        streamControllerRef.current = null
        toast.info({ title: '已停止生成', message: '流式输出已中断，可继续输入新消息' })
    }, [finalizeStreamingMessage])

    /**
     * 键盘事件：Cmd/Ctrl + Enter 发送，Enter 换行
     */
    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                handleSend()
            }
        },
        [handleSend],
    )

    const hasMessages = messages.length > 0
    const inputDisabled = streaming || sending
    const hasReadyAttachment = attach.attachments.some((a) => a.status === 'ready')
    // 只带图片、不打字也应能发送；但只要还有附件在压缩/转写，就必须挡住，
    // 否则半成品会被当作"没有附件"悄悄发出去
    const sendButtonDisabled =
        (interactionMode === 'agent'
            ? !input.trim()
            : (!input.trim() && !hasReadyAttachment)) || inputDisabled || attach.processing

    /** 选择文件 */
    const handlePickFiles = useCallback(() => fileInputRef.current?.click(), [])

    /** 粘贴图片：截图后直接 Ctrl+V 是最高频的贴图路径，必须支持 */
    const handlePaste = useCallback(
        (e: React.ClipboardEvent) => {
            const files = Array.from(e.clipboardData?.files ?? [])
            if (files.length === 0) return
            e.preventDefault()
            attach.addFiles(files)
        },
        [attach],
    )

    /** 拖放：整块对话区都是投放目标，比只认一个小图标好命中得多 */
    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault()
            setDragOver(false)
            const files = Array.from(e.dataTransfer?.files ?? [])
            if (files.length > 0) attach.addFiles(files)
        },
        [attach],
    )

    return (
        <section
            className={cn('pr-copilot-chat', {
                'is-drag-over': dragOver,
                'has-empty-state': !hasMessages,
            })}
            aria-label="AI 副驾对话"
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={(e) => {
                // 只有真正离开整个区域才取消高亮；掠过子元素会连发 dragleave
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
            }}
            onDrop={handleDrop}
        >
            {dragOver && (
                <div className="pr-copilot-drop-hint" aria-hidden="true">
                    <Icon name="upload" size={22} />
                    <span>松开即添加附件</span>
                    <small>支持图片、音频与 txt/md/csv/json 文本文件</small>
                </div>
            )}
            {/* 消息流 */}
            <div className="pr-copilot-chat-messages">
                {!hasMessages && (
                    <EmptyState
                        onPickQuickAction={handlePickQuickAction}
                        interactionMode={interactionMode}
                    />
                )}
                {hasMessages && (
                    <>
                        {messages.map((msg) => (
                            <MessageBubble
                                key={msg.id}
                                message={msg}
                                isStreaming={streamingMessageId === msg.id}
                            />
                        ))}
                    </>
                )}
                <PlanApprovalPanel />
                <div ref={bottomRef} className="pr-copilot-chat-bottom-anchor" />
            </div>

            {/* 输入区 */}
            <div className="pr-copilot-chat-input-area">
                {/* 服务端按能力改选模型的提示（仅在确实改选时出现） */}
                {autoRoute && (
                    <div className="pr-copilot-autoroute" role="status">
                        <Icon name="shuffle" size={12} />
                        <span>{autoRoute.reason}</span>
                        <button
                            type="button"
                            className="pr-copilot-autoroute-close"
                            onClick={() => setAutoRoute(null)}
                            aria-label="关闭模型切换提示"
                        >
                            <Icon name="x" size={11} />
                        </button>
                    </div>
                )}

                {interactionMode === 'agent' && attach.attachments.length > 0 && (
                    <div className="pr-copilot-plan-attachment-note" role="status">
                        <Icon name="info" size={12} />附件仅供问答模式使用；切回后仍可发送
                    </div>
                )}
                <AttachmentTray
                    attachments={attach.attachments}
                    onRemove={attach.remove}
                    onImagePreviewFailed={attach.markImagePreviewFailed}
                />

                <QuickVoiceAssist
                    suggestions={FOLLOW_UP_ACTIONS}
                    onPick={handleAssistedInput}
                    onTranscript={handleAssistedInput}
                    label="点选常用要求，或直接对 AI 说"
                    voiceLabel="语音提问"
                    disabled={inputDisabled}
                    compact
                    className="pr-copilot-input-assist"
                />

                <div className={cn('pr-copilot-chat-input-wrapper', { 'is-inserted': isInserted })}>
                    {/* 附件按钮 */}
                    <button
                        type="button"
                        className="pr-copilot-chat-attach"
                        onClick={handlePickFiles}
                        disabled={interactionMode === 'agent' || inputDisabled || attach.attachments.length >= MAX_ATTACHMENTS}
                        aria-label="添加附件"
                        title={`添加附件（图片 / 音频 / 文本文件，最多 ${MAX_ATTACHMENTS} 个）`}
                    >
                        <Icon name="paperclip" size={17} />
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        className="pr-sr-only"
                        aria-label="选择附件文件"
                        tabIndex={-1}
                        // 只列出真正能处理的类型：让文件选择器一开始就挡住视频与
                        // Office 文档，好过用户选完再被拒绝
                        accept="image/*,audio/*,.txt,.md,.markdown,.csv,.json,.log,.yml,.yaml"
                        onChange={(e) => {
                            if (e.target.files) attach.addFiles(e.target.files)
                            // 清空 value，否则连续选同一个文件不会触发 change
                            e.target.value = ''
                        }}
                    />
                    <textarea
                        ref={textareaRef}
                        className="pr-copilot-chat-input"
                        placeholder={
                            sending
                                ? '正在生成可审批计划…'
                                : streaming
                                ? 'AI 正在生成中…可点击中断按钮停止'
                                : interactionMode === 'agent'
                                    ? '描述任务目标与约束，AI 将先生成计划等待审批'
                                    : '输入教学需求，或选择常用要求快速开始'
                        }
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        disabled={inputDisabled}
                        rows={1}
                        aria-label="消息输入框"
                    />
                    {streaming ? (
                        <button
                            type="button"
                            className="pr-copilot-chat-stop"
                            onClick={handleStopStream}
                            aria-label="停止生成"
                        >
                            <Icon name="stop" size={14} />
                            <span>停止</span>
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="pr-copilot-chat-send"
                            onClick={handleSend}
                            disabled={sendButtonDisabled}
                            aria-label={interactionMode === 'agent' ? '生成待审批计划' : '发送消息'}
                        >
                            <Icon name="send" size={18} />
                        </button>
                    )}
                </div>
                <div className="pr-copilot-chat-input-hint">
                    <Icon name="info" size={11} />
                    <span>
                        {interactionMode === 'agent'
                            ? '任务编排：先生成计划，教师批准后执行，可随时暂停或中止'
                            : `当前模型 ${chatModel} · 思考模式 ${chatThinkingMode} · 温度 ${chatTemperature.toFixed(1)}`}
                    </span>
                </div>
            </div>
        </section>
    )
})
