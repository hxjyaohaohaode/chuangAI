/**
 * 思考宫殿 3D 链主页面（规范第 2、5、8、14 章）
 *
 * 职责：
 *  - 数据加载：api.thinkingChains.list() 拉取思考链列表
 *  - 状态托管：selectedChainId / selectedNodeIndex / playback 三个核心 state
 *  - 布局：Hero（标题 + 概览统计）+ Body（左列表 + 中 3D + 右详情）
 *  - 联动：选中节点 → 3D 高亮 + 详情面板同步
 *  - 播放：自动播放按钮，按节点逐个推进
 *  - 降级：DEMO 模式或 API 不可达时显示空态，不阻塞页面
 *
 * 设计要点（规范第 2、5、8 章）：
 *  - 松紧得当：Hero 与 Body 之间使用松带
 *  - 流体尺寸：clamp() 控制最小/最大尺寸
 *  - 零硬编码色值
 *  - 无障碍：完整 ARIA 标签，键盘可达
 *  - 性能：3D 组件懒加载（React.lazy）
 */

import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import '@/components/ui/icons-extended'
import type { ThinkingChain, ThinkingNodeType } from '@/lib/types'
import { api } from '@/lib/api'
import { toast } from '@/stores/toast'
import { logError } from '@/lib/errors'
import { splitPoemClauses } from '@/lib/poem-lines'
import { subscribeMediaQuery } from '@/lib/media-query'
import { Icon } from '@/components/ui/Icon'
import { Combobox, type ComboboxOption } from '@/components/ui'
import { ThinkingChainList } from './ThinkingChainList'
import { ThinkingNodeDetail } from './ThinkingNodeDetail'
import { PoemImageGenerator } from './PoemImageGenerator'
import { PoemRecitationPlayer } from './PoemRecitationPlayer'
import { PoemReconstructionAdvisor } from './PoemReconstructionAdvisor'
import { useCultureStore } from '@/stores/culture'
import './ThinkingPalacePage.css'

/* ============================================================
 * 3D 组件懒加载（Three.js ~600KB 仅按需加载）
 * ============================================================ */

const ThinkingPalace3D = lazy(() =>
    import('./ThinkingPalace3D').then((m) => ({ default: m.ThinkingPalace3D })),
)

/* ============================================================
 * 低性能与无障碍视觉策略
 *
 * 3D 不是思考审计的唯一入口。减少动态、窄屏、节省流量、低内存或无 WebGL
 * 的环境先展示可选择、可播放的二维审计路径；这样不会为了“沉浸感”而在
 * 教师尚未确认需要 3D 时下载重型渲染库。支持 WebGL 的教师仍可主动切回 3D。
 * ============================================================ */

type LightVisualReason =
    | 'reduced-motion'
    | 'narrow-viewport'
    | 'save-data'
    | 'low-memory'
    | 'webgl-unavailable'

interface ThinkingPalaceVisualMode {
    preferLightView: boolean
    reason: LightVisualReason | null
    canEnable3D: boolean
}

function detectThinkingPalaceVisualMode(): ThinkingPalaceVisualMode {
    if (typeof window === 'undefined') {
        return { preferLightView: false, reason: null, canEnable3D: true }
    }

    let webglAvailable = false
    try {
        const canvas = document.createElement('canvas')
        webglAvailable = Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
    } catch {
        webglAvailable = false
    }
    if (!webglAvailable) {
        return { preferLightView: true, reason: 'webgl-unavailable', canEnable3D: false }
    }

    const navigatorWithHints = navigator as Navigator & {
        connection?: { saveData?: boolean }
        deviceMemory?: number
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        return { preferLightView: true, reason: 'reduced-motion', canEnable3D: true }
    }
    if (window.matchMedia?.('(max-width: 767px)').matches) {
        return { preferLightView: true, reason: 'narrow-viewport', canEnable3D: true }
    }
    if (navigatorWithHints.connection?.saveData === true) {
        return { preferLightView: true, reason: 'save-data', canEnable3D: true }
    }
    if (typeof navigatorWithHints.deviceMemory === 'number' && navigatorWithHints.deviceMemory <= 4) {
        return { preferLightView: true, reason: 'low-memory', canEnable3D: true }
    }
    return { preferLightView: false, reason: null, canEnable3D: true }
}

function useThinkingPalaceVisualMode(): ThinkingPalaceVisualMode {
    const [mode, setMode] = useState<ThinkingPalaceVisualMode>(detectThinkingPalaceVisualMode)

    useEffect(() => {
        const update = () => setMode(detectThinkingPalaceVisualMode())
        const queries = [
            window.matchMedia?.('(prefers-reduced-motion: reduce)'),
            window.matchMedia?.('(max-width: 767px)'),
        ].filter((query): query is MediaQueryList => Boolean(query))
        const unsubscribeQueries = queries.map((query) => subscribeMediaQuery(query, update))
        window.addEventListener('resize', update)
        return () => {
            unsubscribeQueries.forEach((unsubscribe) => unsubscribe())
            window.removeEventListener('resize', update)
        }
    }, [])

    return mode
}

const THINKING_NODE_TYPE_LABELS: Record<ThinkingNodeType, string> = {
    hypothesis: '假设',
    reasoning: '推理',
    evidence: '证据',
    question: '质疑',
    conclusion: '结论',
}

const LIGHT_VISUAL_REASON_TEXT: Record<LightVisualReason, string> = {
    'reduced-motion': '已尊重“减少动态效果”设置，先使用无持续动画的二维审计视图。',
    'narrow-viewport': '当前为窄屏设备，先使用便于阅读与点选的二维审计视图。',
    'save-data': '浏览器已开启节省流量，先不下载沉浸式 3D 资源。',
    'low-memory': '设备报告可用内存较低，先使用轻量审计视图以保护课堂稳定性。',
    'webgl-unavailable': '浏览器当前不支持 WebGL，已切换为完整可操作的二维审计视图。',
}

interface ThinkingChainStaticViewProps {
    chain: ThinkingChain | null
    selectedNodeIndex: number | null
    onSelect: (index: number) => void
    reason: LightVisualReason
    canEnable3D: boolean
    onEnable3D: () => void
}

function ThinkingChainStaticView({
    chain,
    selectedNodeIndex,
    onSelect,
    reason,
    canEnable3D,
    onEnable3D,
}: ThinkingChainStaticViewProps) {
    return (
        <section
            className="thinking-palace-static-view"
            data-testid="thinking-palace-static-view"
            aria-labelledby="thinking-palace-static-title"
        >
            <header className="thinking-palace-static-view__header">
                <div>
                    <span className="thinking-palace-static-view__eyebrow">轻量二维审计</span>
                    <h2 id="thinking-palace-static-title">思考步骤总览</h2>
                    <p>{LIGHT_VISUAL_REASON_TEXT[reason]}</p>
                </div>
                {canEnable3D && (
                    <button
                        type="button"
                        className="thinking-palace-static-view__enable"
                        data-testid="thinking-palace-enable-3d"
                        onClick={onEnable3D}
                    >
                        开启沉浸 3D
                    </button>
                )}
            </header>

            {!chain || chain.nodes.length === 0 ? (
                <div className="thinking-palace-static-view__empty" role="status">
                    暂无思考链数据；选择或生成思考链后，会在此按步骤呈现审计路径。
                </div>
            ) : (
                <ol className="thinking-palace-static-view__steps" aria-label="可选择的思考步骤">
                    {chain.nodes.map((node, index) => {
                        const selected = selectedNodeIndex === index
                        return (
                            <li key={`${node.index}-${node.startOffset}-${index}`}>
                                <button
                                    type="button"
                                    className={selected ? 'is-selected' : ''}
                                    aria-pressed={selected}
                                    onClick={() => onSelect(index)}
                                >
                                    <span className="thinking-palace-static-view__index" aria-hidden="true">
                                        {index + 1}
                                    </span>
                                    <span className="thinking-palace-static-view__copy">
                                        <strong>{THINKING_NODE_TYPE_LABELS[node.type]}</strong>
                                        <span>{node.content}</span>
                                    </span>
                                </button>
                            </li>
                        )
                    })}
                </ol>
            )}
        </section>
    )
}

/* ============================================================
 * 加载状态机
 * ============================================================ */

type LoadStatus = 'loading' | 'loaded' | 'error'

/* ============================================================
 * 骨架屏
 * ============================================================ */

function ThinkingPalaceSkeleton() {
    return (
        <div className="thinking-palace-skeleton" aria-busy="true" aria-live="polite">
            <div className="thinking-palace-skeleton__bar" />
            <div className="thinking-palace-skeleton__bar" />
            <div className="thinking-palace-skeleton__bar" />
        </div>
    )
}

function PoemThoughtPalace() {
    const poems = useCultureStore((state) => state.poems)
    const selectedPoemId = useCultureStore((state) => state.selectedPoemId)
    const background = useCultureStore((state) => state.background)
    const images = useCultureStore((state) => state.images)
    const loading = useCultureStore((state) => state.backgroundLoading)
    const loadPoems = useCultureStore((state) => state.loadPoems)
    const selectPoem = useCultureStore((state) => state.selectPoem)
    const [activeIndex, setActiveIndex] = useState(0)

    useEffect(() => {
        if (poems.length === 0) void loadPoems()
    }, [loadPoems, poems.length])

    const poem = poems.find((item) => item.id === selectedPoemId) ?? poems[0] ?? null
    const verses = useMemo(() => splitPoemClauses(poem?.content), [poem])

    /**
     * 横幅优先的配图序列
     *
     * 主视觉框是 16:12 左右的横向大图（min-height 520px，object-fit: cover）。
     * 而图库是按 idx 奇偶交替生成 landscape / portrait 的，直接按下标取图
     * 有一半概率拿到竖幅——竖幅塞进横框，上下会被裁掉近六成，
     * 实测《咏鹅》那张会正好把鹅头切在画框外沿，画面主体丢失。
     * 因此这里把横幅排在前面，竖幅仅在横幅不够用时兜底。
     */
    const framedImages = useMemo(() => {
        const landscape = images.filter((im) => im.orientation !== 'portrait')
        const portrait = images.filter((im) => im.orientation === 'portrait')
        return [...landscape, ...portrait]
    }, [images])

    const steps = useMemo(() => {
        if (!poem) return []
        const images = framedImages
        const firstImage = images[0]
        return [
            {
                title: '时代与身世',
                label: '进入语境',
                text: background?.historical || `${poem.dynasty}的社会生活与诗人处境，等待文化背景包生成后补全。`,
                image: images[1]?.imageUrl,
                evidence: background ? '文化背景包' : '基础诗篇信息',
            },
            {
                title: '眼前之景',
                label: '触景',
                text: firstImage?.description || `从「${verses[0] ?? poem.title}」出发，观察诗人选择写入作品的景物与空间。`,
                image: firstImage?.imageUrl,
                evidence: firstImage ? '诗境图片与描述' : '诗句文本',
            },
            {
                title: '意象联结',
                label: '生情',
                text: verses.slice(0, 2).map((line) => `「${line}」`).join('与') || poem.content,
                image: images[2]?.imageUrl,
                evidence: '原诗逐句',
            },
            {
                title: '情感转折',
                label: '推演',
                text: background?.creation || '结合创作处境，推演景物如何引发情绪变化；此处是教学性重构，不等同于史实心理记录。',
                image: images[3]?.imageUrl,
                evidence: background ? '创作语境' : '待生成',
            },
            ...verses.map((line, index) => ({
                title: `落笔 · 第${index + 1}句`,
                label: '成诗',
                text: line,
                image: images[index % Math.max(1, images.length)]?.imageUrl,
                evidence: '原诗文本',
            })),
            {
                title: '文化余韵',
                label: '流传',
                text: background?.cultural || '作品的文化内涵与后世影响，等待文化背景包生成后补全。',
                image: images.at(-1)?.imageUrl,
                evidence: background ? '文化内涵' : '待生成',
            },
        ]
    }, [background, framedImages, poem, verses])

    useEffect(() => setActiveIndex(0), [selectedPoemId])
    const active = steps[activeIndex] ?? null
    // 图片加载失败时回退到暖调留白构图（避免灰底"破图"区域破坏版面）
    const [imgFailed, setImgFailed] = useState(false)
    useEffect(() => setImgFailed(false), [activeIndex, selectedPoemId])

    return (
        <section className="poem-palace">
            <header className="poem-palace__toolbar">
                <div>
                    <span>诗人视角 · 教学性重构</span>
                    <strong>一首诗的完整思考宫殿</strong>
                </div>
                <Combobox
                    value={poem?.id ?? ''}
                    onChange={(v) => selectPoem(v as string)}
                    ariaLabel="选择古诗"
                    placeholder="请选择古诗"
                    options={poems.map<ComboboxOption>((item) => ({
                        value: item.id,
                        label: `${item.title} · ${item.poet}`,
                    }))}
                />
            </header>
            {loading && !background ? <ThinkingPalaceSkeleton /> : !poem || !active ? (
                <div className="poem-palace__empty">暂无可构建的诗篇，请先检查诗库数据。</div>
            ) : (
                <div
                    className="poem-palace__scene"
                    data-anchor
                    data-anchor-label="诗篇场景"
                >
                    <div className="poem-palace__visual">
                        {active.image && !imgFailed ? (
                            <>
                                {/* 竖幅衬底：图库按奇偶交替产出横/竖两种画幅，而这个
                                    主视觉框是横向的。竖幅若按 cover 铺满会被上下裁掉近六成
                                    （实测《咏鹅》那张的鹅头会被切在框外）。
                                    因此竖幅改为 contain 完整呈现，两侧空白由同一张图
                                    放大模糊填充——既不丢主体，也不留死板的空白边。 */}
                                <img
                                    className="poem-palace__visual-backdrop"
                                    src={active.image}
                                    alt=""
                                    aria-hidden="true"
                                />
                                <img
                                    className="poem-palace__visual-main"
                                    src={active.image}
                                    alt={`${active.title}教学场景`}
                                    onLoad={(e) => {
                                        const el = e.currentTarget
                                        // 用真实解码尺寸判定画幅，而不是猜文件名或依赖后端字段
                                        el.dataset['fit'] =
                                            el.naturalWidth >= el.naturalHeight ? 'cover' : 'contain'
                                    }}
                                    onError={() => setImgFailed(true)}
                                />
                            </>
                        ) : (
                            <div className="poem-palace__visual-empty"><Icon name="mountains" size={42} /></div>
                        )}
                        <div className="poem-palace__shade" />
                        <div className="poem-palace__poem">
                            <span>{poem.dynasty} · {poem.poet}</span>
                            <h2>{poem.title}</h2>
                            <p>{poem.content}</p>
                        </div>
                        <div className="poem-palace__active-card" key={activeIndex}>
                            <em>{String(activeIndex + 1).padStart(2, '0')} / {String(steps.length).padStart(2, '0')}</em>
                            <span>{active.label}</span>
                            <h3>{active.title}</h3>
                            <p>{active.text.replace(/^#{1,6}\s*/gm, '').replace(/\*\*/g, '')}</p>
                            <small>依据：{active.evidence}</small>
                        </div>
                    </div>
                    <ol className="poem-palace__route" aria-label="诗篇思考路线">
                        {steps.map((step, index) => (
                            <li key={`${step.title}-${index}`}>
                                <button
                                    type="button"
                                    className={index === activeIndex ? 'is-active' : ''}
                                    onClick={() => setActiveIndex(index)}
                                    aria-pressed={index === activeIndex}
                                >
                                    <i>{index + 1}</i>
                                    <span><small>{step.label}</small><strong>{step.title}</strong></span>
                                </button>
                            </li>
                        ))}
                    </ol>
                    <p className="poem-palace__disclaimer">
                        <Icon name="info" size={13} />
                        本路线依据原诗、文化背景包与诗境素材进行教学性重构；对诗人内心活动的描述属于可审阅推演，不冒充历史事实。
                    </p>
                </div>
            )}
        </section>
    )
}

/* ============================================================
 * 诗篇重构模块容器（SubTask 27.5：侧边栏 + 主区 + 浮动详情）
 *
 * 4 个 AI 模块通过左侧栏切换：
 *  - route       诗篇思考路线（PoemThoughtPalace 原组件）
 *  - advisor     AI 重构顾问（PoemReconstructionAdvisor）
 *  - image       AI 诗境生图（PoemImageGenerator）
 *  - recitation  AI 朗诵评分（PoemRecitationPlayer）
 *
 * 设计要点（规范第 5、8、14 章）：
 *  - 左侧栏 280px 固定宽度（响应式：移动端折叠为顶部 chip 组）
 *  - 主区域占据剩余空间
 *  - 模块切换 350ms 过渡（ease-in-out，规范 6.3）
 *  - 选中态：左侧 3px accent 竖线 + surface-tertiary 背景（规范 14.6）
 * ============================================================ */

type PoemModule = 'route' | 'advisor' | 'image' | 'recitation'

interface PoemModuleOption {
    value: PoemModule
    label: string
    desc: string
    icon: string
}

const POEM_MODULE_OPTIONS: PoemModuleOption[] = [
    {
        value: 'route',
        label: '诗篇思考路线',
        desc: '从时代到落笔的完整重构',
        icon: 'compass',
    },
    {
        value: 'advisor',
        label: 'AI 重构顾问',
        desc: 'deepseek-v4-pro 流式点评',
        icon: 'chat-circle',
    },
    {
        value: 'image',
        label: 'AI 诗境生图',
        desc: 'wan2.7-image 文生图',
        icon: 'mountains',
    },
    {
        value: 'recitation',
        label: 'AI 朗诵评分',
        desc: 'mimo-v2.5 TTS + ASR 闭环',
        icon: 'music-note',
    },
]

function PoemModuleContainer() {
    const [activeModule, setActiveModule] = useState<PoemModule>('route')
    const moduleId = useId()
    const poems = useCultureStore((state) => state.poems)
    const selectedPoemId = useCultureStore((state) => state.selectedPoemId)
    const poem = useMemo(
        () => poems.find((p) => p.id === selectedPoemId) ?? poems[0] ?? null,
        [poems, selectedPoemId],
    )
    const handleModuleTabKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        const currentIndex = POEM_MODULE_OPTIONS.findIndex((option) => option.value === activeModule)
        let nextIndex = currentIndex
        switch (event.key) {
            case 'ArrowDown':
            case 'ArrowRight':
                nextIndex = (currentIndex + 1) % POEM_MODULE_OPTIONS.length
                break
            case 'ArrowUp':
            case 'ArrowLeft':
                nextIndex = (currentIndex - 1 + POEM_MODULE_OPTIONS.length) % POEM_MODULE_OPTIONS.length
                break
            case 'Home':
                nextIndex = 0
                break
            case 'End':
                nextIndex = POEM_MODULE_OPTIONS.length - 1
                break
            default:
                return
        }
        event.preventDefault()
        const nextModule = POEM_MODULE_OPTIONS[nextIndex]
        if (!nextModule) return
        setActiveModule(nextModule.value)
        event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-poem-module-tab="${nextModule.value}"]`)
            ?.focus()
    }, [activeModule])

    return (
        <div className="poem-module-container">
            {/* 左侧栏：模块切换 */}
            <aside
                className="poem-module-sidebar"
                data-anchor
                data-anchor-label="AI 模块导航"
            >
                <div className="poem-module-sidebar__header">
                    <Icon name="brain" size={14} weight="bold" />
                    <span>AI 能力矩阵</span>
                </div>
                <nav
                    className="poem-module-sidebar__nav"
                    role="tablist"
                    aria-label="诗篇重构 AI 模块"
                    aria-orientation="vertical"
                    onKeyDown={handleModuleTabKeyDown}
                >
                    {POEM_MODULE_OPTIONS.map((opt) => (
                        <button
                            key={opt.value}
                            type="button"
                            role="tab"
                            id={`${moduleId}-tab-${opt.value}`}
                            data-poem-module-tab={opt.value}
                            aria-controls={`${moduleId}-panel`}
                            aria-selected={activeModule === opt.value}
                            tabIndex={activeModule === opt.value ? 0 : -1}
                            className={`poem-module-sidebar__item${activeModule === opt.value ? ' is-active' : ''}`}
                            onClick={() => setActiveModule(opt.value)}
                        >
                            <span className="poem-module-sidebar__icon">
                                <Icon name={opt.icon as 'compass'} size={16} weight={activeModule === opt.value ? 'fill' : 'regular'} />
                            </span>
                            <span className="poem-module-sidebar__text">
                                <strong>{opt.label}</strong>
                                <small>{opt.desc}</small>
                            </span>
                        </button>
                    ))}
                </nav>
                <div className="poem-module-sidebar__footer">
                    <Icon name="info" size={11} />
                    <span>4 大 AI 模块深度集成，全链路覆盖诗篇重构</span>
                </div>
            </aside>

            {/* 主区域：根据选中模块渲染 */}
            <main
                id={`${moduleId}-panel`}
                className="poem-module-main"
                role="tabpanel"
                aria-labelledby={`${moduleId}-tab-${activeModule}`}
            >
                {activeModule === 'route' && <PoemThoughtPalace />}
                {activeModule === 'advisor' && <PoemReconstructionAdvisor poem={poem ?? undefined} />}
                {activeModule === 'image' && poem && <PoemImageGenerator poem={poem} />}
                {activeModule === 'image' && !poem && (
                    <div className="poem-module-empty">
                        <Icon name="book-open" size={42} weight="bold" />
                        <p>请先选择诗篇</p>
                    </div>
                )}
                {activeModule === 'recitation' && poem && <PoemRecitationPlayer poem={poem} />}
                {activeModule === 'recitation' && !poem && (
                    <div className="poem-module-empty">
                        <Icon name="book-open" size={42} weight="bold" />
                        <p>请先选择诗篇</p>
                    </div>
                )}
            </main>
        </div>
    )
}

/* ============================================================
 * 主页面组件
 * ============================================================ */

export default function ThinkingPalacePage() {
    const [view, setView] = useState<'poem' | 'ai'>('poem')
    const viewTabsId = useId()
    const visualMode = useThinkingPalaceVisualMode()
    const [force3D, setForce3D] = useState(false)
    /* ---------- 数据状态 ---------- */
    const [chains, setChains] = useState<ThinkingChain[]>([])
    const [status, setStatus] = useState<LoadStatus>('loading')
    const fetchIdRef = useRef(0)
    const hasNotifiedRef = useRef(false)

    /* ---------- 选中状态 ---------- */
    const [selectedChainId, setSelectedChainId] = useState<string | null>(null)
    const [selectedNodeIndex, setSelectedNodeIndex] = useState<number | null>(null)

    /* ---------- 播放状态 ---------- */
    const [isPlaying, setIsPlaying] = useState(false)
    const playTimerRef = useRef<number | null>(null)

    /* ---------- 数据加载 ---------- */
    const fetchChains = useCallback(async () => {
        const id = ++fetchIdRef.current
        setStatus('loading')
        try {
            const res = await api.thinkingChains.list({ limit: 50 })
            if (fetchIdRef.current !== id) return
            setChains(res.chains)
            setStatus('loaded')
            // 自动选中第一条
            if (res.chains.length > 0 && !selectedChainId) {
                const firstChain = res.chains[0]
                if (firstChain) setSelectedChainId(firstChain.id)
            }
        } catch (err) {
            if (fetchIdRef.current !== id) return
            logError('ThinkingPalacePage.fetchChains', err)
            setStatus('error')
            if (!hasNotifiedRef.current) {
                hasNotifiedRef.current = true
                toast.error({
                    title: '加载失败',
                    message: '思考链列表加载失败，请稍后重试',
                })
            }
        }
    }, [selectedChainId])

    useEffect(() => {
        void fetchChains()
    }, [fetchChains])

    /* ---------- 选中链 ---------- */
    const selectedChain = chains.find((c) => c.id === selectedChainId) ?? null
    const useLightAuditView = visualMode.preferLightView && (!force3D || !visualMode.canEnable3D)

    /* ---------- 选中链回调 ---------- */
    const handleSelectChain = useCallback((chain: ThinkingChain) => {
        setSelectedChainId(chain.id)
        setSelectedNodeIndex(null)
        setIsPlaying(false)
    }, [])

    /* ---------- 选中节点回调 ---------- */
    const handleSelectNode = useCallback((index: number) => {
        setSelectedNodeIndex(index)
        setIsPlaying(false)
    }, [])

    const handleHoverNode = useCallback((_index: number | null) => {
        // hover 仅用于视觉反馈，不影响 state
    }, [])

    /* ---------- 播放控制 ---------- */
    const handleTogglePlay = useCallback(() => {
        if (!selectedChain || selectedChain.nodes.length === 0) return
        setIsPlaying((prev) => !prev)
    }, [selectedChain])

    // 自动播放 effect：每 1.2s 推进一个节点
    useEffect(() => {
        if (!isPlaying || !selectedChain) return
        if (selectedChain.nodes.length === 0) {
            setIsPlaying(false)
            return
        }
        const startIdx = selectedNodeIndex ?? -1
        const nextIdx = startIdx + 1
        if (nextIdx >= selectedChain.nodes.length) {
            // 播放完毕，重置
            setIsPlaying(false)
            setSelectedNodeIndex(null)
            return
        }
        playTimerRef.current = window.setTimeout(() => {
            setSelectedNodeIndex(nextIdx)
        }, 1200)
        return () => {
            if (playTimerRef.current !== null) {
                window.clearTimeout(playTimerRef.current)
                playTimerRef.current = null
            }
        }
    }, [isPlaying, selectedChain, selectedNodeIndex])

    /* ---------- 重试 ---------- */
    const handleRetry = useCallback(() => {
        hasNotifiedRef.current = false
        void fetchChains()
    }, [fetchChains])

    /* ---------- 派生：Hero 统计 ---------- */
    const stats = useRef({ total: 0, totalNodes: 0, avgDuration: 0 })
    if (chains.length > 0) {
        const totalNodes = chains.reduce((sum, c) => sum + c.nodes.length, 0)
        const totalDuration = chains.reduce((sum, c) => sum + c.durationMs, 0)
        stats.current = {
            total: chains.length,
            totalNodes,
            avgDuration: chains.length > 0 ? totalDuration / chains.length : 0,
        }
    }

    const handleViewTabKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        let nextView: 'poem' | 'ai'
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                nextView = 'ai'
                break
            case 'ArrowLeft':
            case 'ArrowUp':
            case 'Home':
                nextView = 'poem'
                break
            case 'End':
                nextView = 'ai'
                break
            default:
                return
        }
        event.preventDefault()
        setView(nextView)
        event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-thinking-palace-view-tab="${nextView}"]`)
            ?.focus()
    }, [])

    return (
        <div className="thinking-palace-container" role="region" aria-label="思考宫殿 3D 链">
            {/* v5.0 Task 4：右侧悬浮锚点迷你地图
             * key={view} —— view 切换时强制重挂载，触发 IntersectionObserver 重扫描
             * 因为 poem/ai 两个 view 的 data-anchor 元素完全不同（poem-palace vs thinking-palace-body） */}
            {/* Hero 标题区 */}
            <header
                className="thinking-palace-hero"
                data-anchor
                data-anchor-label="思考宫殿"
            >
                <div className="thinking-palace-hero__text">
                    <span className="thinking-palace-hero__eyebrow">
                        <Icon name="brain" size={12} weight="bold" />
                        <span style={{ marginLeft: 4 }}>深度思考可视化</span>
                    </span>
                    <h1 className="thinking-palace-hero__title">思考宫殿</h1>
                    <p className="thinking-palace-hero__subtitle">
                        从诗人所处时代、眼前之景、意象联结到逐句落笔，构建可播放、可讨论的完整诗篇思考路线；同时保留 AI 推理审计视图。
                    </p>
                </div>
                <div
                    className="thinking-palace-view-switch"
                    role="tablist"
                    aria-label="思考宫殿视图"
                    data-anchor
                    data-anchor-label="视图切换"
                    onKeyDown={handleViewTabKeyDown}
                >
                    <button
                        id={`${viewTabsId}-tab-poem`}
                        data-thinking-palace-view-tab="poem"
                        type="button"
                        className={view === 'poem' ? 'is-active' : ''}
                        onClick={() => setView('poem')}
                        role="tab"
                        aria-controls={`${viewTabsId}-panel`}
                        aria-selected={view === 'poem'}
                        tabIndex={view === 'poem' ? 0 : -1}
                    >
                        <Icon name="book-open" size={15} />诗篇重构
                    </button>
                    <button
                        id={`${viewTabsId}-tab-ai`}
                        data-thinking-palace-view-tab="ai"
                        type="button"
                        className={view === 'ai' ? 'is-active' : ''}
                        onClick={() => setView('ai')}
                        role="tab"
                        aria-controls={`${viewTabsId}-panel`}
                        aria-selected={view === 'ai'}
                        tabIndex={view === 'ai' ? 0 : -1}
                    >
                        <Icon name="brain" size={15} />AI 推理审计
                    </button>
                </div>
            </header>

            <div
                id={`${viewTabsId}-panel`}
                role="tabpanel"
                aria-labelledby={`${viewTabsId}-tab-${view}`}
            >
                {view === 'poem' ? <PoemModuleContainer /> : status === 'loading' && chains.length === 0 ? (
                    <ThinkingPalaceSkeleton />
                ) : status === 'error' && chains.length === 0 ? (
                    <div className="thinking-palace-canvas-error" style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 'var(--text-base)' }}>
                            数据加载失败
                        </div>
                        <div style={{ fontSize: 'var(--text-sm)', color: 'rgb(var(--c-text-tertiary))' }}>
                            思考宫殿服务暂不可用
                        </div>
                        <button
                            type="button"
                            onClick={handleRetry}
                            style={{
                                marginTop: 'var(--space-md)',
                                padding: '8px 16px',
                                background: 'rgb(var(--c-accent-primary) / 0.12)',
                                color: 'rgb(var(--c-accent-primary))',
                                border: 'none',
                                borderRadius: '8px',
                                cursor: 'pointer',
                                fontSize: 'var(--text-sm)',
                                fontWeight: 500,
                            }}
                        >
                            重试
                        </button>
                    </div>
                ) : <div className="thinking-palace-body">
                {/* 左栏：思考链列表 */}
                <div
                    className="thinking-palace-list-wrap"
                    data-anchor
                    data-anchor-label="思考链列表"
                >
                    <ThinkingChainList
                        chains={chains}
                        selectedId={selectedChainId}
                        loading={status === 'loading'}
                        onSelect={handleSelectChain}
                    />
                </div>

                {/* 中栏：3D 可视化 */}
                <div
                    className="thinking-palace-canvas-wrap"
                    data-anchor
                    data-anchor-label={useLightAuditView ? '二维审计视图' : '3D 可视化'}
                >
                    {useLightAuditView && visualMode.reason ? (
                        <ThinkingChainStaticView
                            chain={selectedChain}
                            selectedNodeIndex={selectedNodeIndex}
                            onSelect={handleSelectNode}
                            reason={visualMode.reason}
                            canEnable3D={visualMode.canEnable3D}
                            onEnable3D={() => setForce3D(true)}
                        />
                    ) : (
                        <Suspense fallback={<ThinkingPalaceSkeleton />}>
                            <ThinkingPalace3D
                                chain={selectedChain}
                                selectedNodeIndex={selectedNodeIndex}
                                onSelect={handleSelectNode}
                                onHover={handleHoverNode}
                            />
                        </Suspense>
                    )}

                    {/* 播放控制条 */}
                    {selectedChain && selectedChain.nodes.length > 0 && (
                        <div className="thinking-palace-playback">
                            <button
                                className={`thinking-palace-playback__btn${isPlaying ? ' is-active' : ''}`}
                                onClick={handleTogglePlay}
                                aria-label={isPlaying ? '暂停' : '播放'}
                                title={isPlaying ? '暂停播放' : '自动播放思考链'}
                            >
                                <Icon
                                    name={isPlaying ? 'stop' : 'play'}
                                    size={14}
                                    weight={isPlaying ? 'bold' : 'regular'}
                                />
                            </button>
                            <span className="thinking-palace-playback__progress">
                                {selectedNodeIndex !== null
                                    ? `${selectedNodeIndex + 1} / ${selectedChain.nodes.length}`
                                    : `0 / ${selectedChain.nodes.length}`}
                            </span>
                        </div>
                    )}
                </div>

                {/* 右栏：节点详情 */}
                <div
                    className="thinking-palace-detail-wrap"
                    data-anchor
                    data-anchor-label="节点详情"
                >
                    <ThinkingNodeDetail
                        chain={selectedChain}
                        selectedNodeIndex={selectedNodeIndex}
                        onSelectNode={handleSelectNode}
                    />
                </div>
                </div>}
            </div>
        </div>
    )
}
