/**
 * CultureContextPage 文化语境还原主页面（Task 20 + Task 28 Tab 重构）
 *
 * 文化语境还原是诗脉·启明 PoeticRealm AI v5.0 的文化深度创新模块，组装全部子组件：
 * - 顶部：标题 + 模块说明 + AI 协作标注
 * - 主体三栏网格：
 *   - 左侧栏：PoemList（古诗选择列表，含朝代/体裁 Combobox 筛选）
 *   - 中主区：Tab 分区（译文/背景/意象/图集）—— 切换不重新渲染（CSS display:none）
 *   - 右侧栏：ImmersiveProjector（沉浸式投屏控制，随文档流）
 *
 * 文化核心流程：
 *   选诗 → 背景包生成(brush.creative) → 逐句译文(poemContent) → 图片库生成(eye.vision-annotate + 文生图)
 *         → 意象解读(seed-data + brush.creative) → 沉浸式投屏
 *
 * Task 28 重构要点（文化语境页面固定定位问题修复 + Tab 分区）：
 * - 移除所有 position: fixed（ CultureContextPage 已无 fixed 定位，Task 9 已清理）
 * - ImmersiveProjector 随文档流（position: relative，已在 CSS 中落实）
 * - 主区域改为 Tab 分区布局（译文/背景/意象/图集）
 * - Tab 切换使用 CSS display:none，不重新渲染已加载组件（保留状态/滚动位置）
 * - 每个 Tab 面板保留稳定 ID，便于标签与面板语义关联
 * - Tab 切换动画：200ms opacity + translateY 8px（规范 6.3）
 *
 * 设计要点：
 * - 顶部 header 滚动 48px 后由 AppShell 切换玻璃态
 * - 主体网格桌面三栏，平板双栏，移动单列
 * - 流体尺寸 clamp() 响应 600-2400px
 * - 无 emoji：所有图标由 Icon 承载
 * - AI 生成内容均标注 aiGenerated
 * - 禁止 position: fixed（除 Modal/Toast/Popover 等弹层组件）
 */

import { useMemo, useState } from 'react'
import { Icon } from '@/components/ui'
import { FallingText } from '@/components/ui/FallingText'
import { MasonryGrid } from '@/components/ui/MasonryGrid'
import { PixelSnow } from '@/components/ui/PixelSnow'
import { StreamText } from '@/components/ui/StreamText'
// Task 28：注册扩展图标（compass/mountains 用于 Tab 配置），按需加载共享 chunk
import '@/components/ui/icons-extended'
import { useCultureStore } from '@/stores/culture'
import { useWSSubscription } from '@/hooks/useWSSubscription'
import { PoemList } from './PoemList'
import { BackgroundPanel } from './BackgroundPanel'
import { TranslationPanel } from './TranslationPanel'
import { ImageGallery } from './ImageGallery'
import { ImageryPanel } from './ImageryPanel'
import { ImmersiveProjector } from './ImmersiveProjector'
import { cn } from '@/lib/cn'
import './CultureContextPage.css'

/* ============================================================
 * Task 28：Tab 分区配置
 * ------------------------------------------------------------
 * 中主区四个 Tab：译文 / 背景 / 意象 / 图集
 * - 每个 Tab 对应一个稳定面板
 * - 切换使用 CSS display:none，保留组件状态与已加载内容
 * - Tab 按钮使用 Phosphor 图标（规范 13.1 无 emoji）
 * ============================================================ */

type CultureTabKey = 'translation' | 'background' | 'imagery' | 'gallery'

interface CultureTabConfig {
    key: CultureTabKey
    label: string
    icon: 'book-open' | 'scroll' | 'compass' | 'mountains'
    anchor: string
}

const CULTURE_TABS: readonly CultureTabConfig[] = [
    { key: 'translation', label: '译文', icon: 'book-open', anchor: 'translation' },
    { key: 'background', label: '背景', icon: 'scroll', anchor: 'background' },
    { key: 'imagery', label: '意象', icon: 'compass', anchor: 'imagery' },
    { key: 'gallery', label: '图集', icon: 'mountains', anchor: 'gallery' },
] as const

export default function CultureContextPage() {
    const poems = useCultureStore((s) => s.poems)
    const selectedPoemId = useCultureStore((s) => s.selectedPoemId)
    const background = useCultureStore((s) => s.background)
    const backgroundLoading = useCultureStore((s) => s.backgroundLoading)
    const handleWSEvent = useCultureStore((s) => s.handleWSEvent)
    const setWsStatus = useCultureStore((s) => s.setWsStatus)

    // Task 28：Tab 当前激活页签（默认译文）
    const [activeTab, setActiveTab] = useState<CultureTabKey>('translation')

    // 冬季诗篇检测 —— 触发轻量、确定性的 PixelSnow CSS 氛围层
    // 依据：诗题/正文含 雪/冬/寒/冰/霜 等冬季意象字符
    const selectedPoem = useMemo(
        () => poems.find((p) => p.id === selectedPoemId) ?? null,
        [poems, selectedPoemId],
    )
    const isWinterPoem = useMemo(() => {
        if (!selectedPoem) return false
        const text = `${selectedPoem.title}${selectedPoem.content}`
        return /雪|冬|寒|冰|霜/.test(text)
    }, [selectedPoem])

    // 当前诗篇的词级标题入场文本；它始终先以完整静态标题呈现，再渐进增强为短暂动效。
    const poemEntranceText = useMemo(() => {
        if (!selectedPoem) return ''
        return `${selectedPoem.title} · ${selectedPoem.poet} · ${selectedPoem.dynasty}`
    }, [selectedPoem])

    // v5.0 Task 3.5：订阅全局 wsDispatcher（连接由 App.tsx 统一管理）
    useWSSubscription({
        onEvent: handleWSEvent,
        onStatusChange: setWsStatus,
    })

    // 注：诗列表加载由 PoemList 组件通过 TanStack Query 处理（Task 28.5），
    // query onSuccess 调用 store.setPoemsFromQuery 同步数据，
    // 保留 CultureContextPage 对 winter poem 的检测能力。

    /**
     * 文化卡片：从真实 background 数据派生
     * - 选诗且 background 已加载：展示 4 维 AI 生成文化语境（历史/人物/创作/文化）
     * - 未选诗或 background 尚未生成：不展示通用预填内容（仅展示与当前诗相关的真实数据）
     */
     const cultureCards = useMemo<Array<{ title: string; desc: string; tag: string; aiGenerated: boolean }>>(() => {
        if (background) {
            return [
                { title: '历史背景', desc: background.historical, tag: '历史', aiGenerated: background.aiGenerated },
                { title: '诗人小传', desc: background.poet, tag: '人物', aiGenerated: background.aiGenerated },
                { title: '创作语境', desc: background.creation, tag: '创作', aiGenerated: background.aiGenerated },
                { title: '文化内涵', desc: background.cultural, tag: '文化', aiGenerated: background.aiGenerated },
            ]
        }
        return []
    }, [background])

    /** Tab 切换键盘导航：←/→ 切换，Home/End 跳首/末 */
    const handleTabKeyDown = (e: React.KeyboardEvent, currentKey: CultureTabKey) => {
        const idx = CULTURE_TABS.findIndex((t) => t.key === currentKey)
        if (idx < 0) return
        let nextIdx = idx
        if (e.key === 'ArrowRight') nextIdx = (idx + 1) % CULTURE_TABS.length
        else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + CULTURE_TABS.length) % CULTURE_TABS.length
        else if (e.key === 'Home') nextIdx = 0
        else if (e.key === 'End') nextIdx = CULTURE_TABS.length - 1
        else return
        e.preventDefault()
        const next = CULTURE_TABS[nextIdx]
        if (next) {
            setActiveTab(next.key)
            // 将焦点移至新激活的 Tab 按钮，符合 WAI-ARIA Tab 模式
            const btnId = `pr-culture-tab-${next.key}`
            document.getElementById(btnId)?.focus()
        }
    }

    return (
        <div className="pr-culture pr-v5-enter-culture">
            {/* v5.0 Hero 区 —— 卷轴铺展意象（Task A.4）
             * 左侧文字区（eyebrow + 巨型标题 + 副标题 + AI 协作标注）+
             * 右侧装饰性文化场景图，
             * 呼应 pr-v5-enter-culture 的"卷轴铺展"入场动效。
             * 非对称 1fr : 1.5fr，避免容器对容器对称。 */}
            <section
                className="pr-v5-hero pr-v5-hero--culture"
                aria-label="文化语境还原概览"
                data-anchor
                data-anchor-label="卷轴铺展"
            >
                <div
                    className="pr-v5-hero-main pr-v5-stagger-item"
                    style={{ ['--v5-stagger-delay' as string]: '0ms' }}
                >
                    <span className="pr-culture-hero-eyebrow">
                        <span className="pr-culture-hero-eyebrow-dot" aria-hidden />
                        文化语境还原
                    </span>
                    <h1 className="pr-culture-hero-title">卷轴铺展</h1>
                    <StreamText
                        content="以真实诗篇与可追溯史料为底稿，生成时代背景、逐句译释、意象图景与沉浸式课堂素材。"
                        charStagger={20}
                        className="pr-culture-hero-subtitle"
                    />
                    <div className="pr-culture-hero-badge">
                        <Icon name="sparkle" size={12} />
                        <span>AI 多智能体协作生成</span>
                    </div>
                </div>
                <aside
                    className="pr-v5-hero-stat pr-v5-stagger-item"
                    style={{ ['--v5-stagger-delay' as string]: '80ms' }}
                    aria-label="古典诗词文化语境图景"
                >
                    <img
                        className="pr-culture-hero-image"
                        src="/images/generated/culture-context-hero-v1.png"
                        alt=""
                        aria-hidden
                        decoding="async"
                    />
                </aside>
            </section>

            <div
                className="pr-culture-body pr-v5-fade-in-up"
                data-anchor
                data-anchor-label="文化探索"
            >
                {/* 左侧栏：诗列表（含朝代/体裁 Combobox 筛选） */}
                <PoemList />

                {/* 中主区：Tab 分区（译文/背景/意象/图集） */}
                <main className={`pr-culture-main ${selectedPoemId ? 'is-active' : ''}`}>
                    {/* 冬季诗篇的 PixelSnow 氛围层。文化页本身已按路由懒加载，
                     * 因而直接路径导入可避免二次 Suspense 分支；组件仅渲染确定性 DOM 雪片，
                     * 占据 main 区域作为底层装饰，pointer-events:none 不阻断交互。 */}
                    {selectedPoemId && isWinterPoem && (
                        <div className="pr-culture-main-snow" aria-hidden>
                            <PixelSnow
                                variant="snowflake"
                                speed={0.4}
                                density={0.6}
                                depthFade={0.7}
                                brightness={0.85}
                                pixelResolution={64}
                                className="pr-culture-snow-field"
                            />
                        </div>
                    )}

                    {selectedPoemId && poemEntranceText ? (
                        <>
                            {/* 诗篇标题以短暂、可降级的词级入场强化“卷轴铺展”的仪式感；
                             * 标题本身不依赖动效，触屏、减弱动态与不支持增强时均保持完整可读。 */}
                            <div className="pr-culture-falling-title-wrap">
                                <FallingText
                                    key={selectedPoemId}
                                    text={poemEntranceText}
                                    trigger="auto"
                                    gravity={0.35}
                                    mouseConstraintStiffness={0.08}
                                    fontSize="var(--text-lg)"
                                    wordSpacing="6px"
                                    className="pr-culture-falling-title"
                                />
                            </div>

                            {/* Task 28 Tab navigation */}
                            <nav
                                className="pr-culture-tabs"
                                role="tablist"
                                aria-label="文化语境内容分区"
                            >
                                {CULTURE_TABS.map((tab) => {
                                    const isActive = tab.key === activeTab
                                    return (
                                        <button
                                            key={tab.key}
                                            id={`pr-culture-tab-${tab.key}`}
                                            type="button"
                                            role="tab"
                                            aria-selected={isActive}
                                            aria-controls={`pr-culture-panel-${tab.key}`}
                                            tabIndex={isActive ? 0 : -1}
                                            className={cn(
                                                'pr-culture-tab',
                                                isActive && 'is-active',
                                            )}
                                            onClick={() => setActiveTab(tab.key)}
                                            onKeyDown={(e) => handleTabKeyDown(e, tab.key)}
                                        >
                                            <Icon name={tab.icon} size={14} />
                                            <span className="pr-culture-tab-label">{tab.label}</span>
                                            {isActive && (
                                                <span
                                                    className="pr-culture-tab-indicator"
                                                    aria-hidden="true"
                                                />
                                            )}
                                        </button>
                                    )
                                })}
                            </nav>

                            {/* Task 28：Tab 面板容器
                             * - 所有面板始终挂载，仅通过 CSS display 切换可见性
                             * - 保留组件状态（如 TranslationPanel 已加载的内容、ImageGallery 已选图片）
                             * - 每个面板带稳定 ID，供标签语义关联
                             * - 激活面板使用 pr-culture-tab-panel--active 触发淡入动画（200ms） */}
                            <div className="pr-culture-tab-panels">
                                <div
                                    id="pr-culture-panel-translation"
                                    role="tabpanel"
                                    aria-labelledby="pr-culture-tab-translation"
                                    data-anchor
                                    data-anchor-label="译文"
                                    className={cn(
                                        'pr-culture-tab-panel',
                                        activeTab === 'translation' && 'pr-culture-tab-panel--active',
                                    )}
                                    hidden={activeTab !== 'translation'}
                                >
                                    <TranslationPanel />
                                </div>
                                <div
                                    id="pr-culture-panel-background"
                                    role="tabpanel"
                                    aria-labelledby="pr-culture-tab-background"
                                    data-anchor
                                    data-anchor-label="背景"
                                    className={cn(
                                        'pr-culture-tab-panel',
                                        activeTab === 'background' && 'pr-culture-tab-panel--active',
                                    )}
                                    hidden={activeTab !== 'background'}
                                >
                                    <BackgroundPanel />
                                </div>
                                <div
                                    id="pr-culture-panel-imagery"
                                    role="tabpanel"
                                    aria-labelledby="pr-culture-tab-imagery"
                                    data-anchor
                                    data-anchor-label="意象"
                                    className={cn(
                                        'pr-culture-tab-panel',
                                        activeTab === 'imagery' && 'pr-culture-tab-panel--active',
                                    )}
                                    hidden={activeTab !== 'imagery'}
                                >
                                    <ImageryPanel />
                                </div>
                                <div
                                    id="pr-culture-panel-gallery"
                                    role="tabpanel"
                                    aria-labelledby="pr-culture-tab-gallery"
                                    data-anchor
                                    data-anchor-label="图集"
                                    className={cn(
                                        'pr-culture-tab-panel',
                                        activeTab === 'gallery' && 'pr-culture-tab-panel--active',
                                    )}
                                    hidden={activeTab !== 'gallery'}
                                >
                                    <ImageGallery />
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="pr-culture-empty">
                            <div className="pr-culture-empty-icon">
                                <Icon name="book-open" size={28} />
                            </div>
                            <p className="pr-culture-empty-text">
                                请从左侧选择一首古诗，开始文化语境探索
                            </p>
                        </div>
                    )}
                </main>

                {/* 右侧栏：沉浸式投屏（随文档流，position: relative） */}
                <aside className="pr-culture-side">
                    <ImmersiveProjector />
                </aside>
            </div>

            {/* 保留 MasonryGrid API，实际采用确定性响应式文化卡片网格。 */}
            {background && (
                <section
                    className="pr-culture-cards-section"
                    aria-label="文化知识卡片"
                    data-anchor
                    data-anchor-label="文化知识图谱"
                >
                    <div className="pr-culture-cards-header">
                        <h2 className="pr-culture-cards-title">文化知识图谱</h2>
                        <span className="pr-culture-cards-meta">
                            AI 生成 · 当前诗篇专属文化语境
                        </span>
                    </div>
                    <MasonryGrid columns={3} gap="var(--space-lg)">
                        {backgroundLoading ? (
                            <MasonryGrid.Item fadeIn delay={0}>
                                <div className="pr-culture-card pr-culture-card--loading">
                                    <span className="pr-culture-card-tag">生成中</span>
                                    <h3 className="pr-culture-card-title">AI 正在生成文化背景</h3>
                                    <p className="pr-culture-card-desc">诗心 Agent 正在为选定古诗生成专属文化语境，请稍候……</p>
                                </div>
                            </MasonryGrid.Item>
                        ) : (
                            cultureCards.map((card) => (
                                <MasonryGrid.Item key={card.title} fadeIn delay={0}>
                                    <div className="pr-culture-card">
                                        <div className="pr-culture-card-header">
                                            <span className="pr-culture-card-tag">{card.tag}</span>
                                            {card.aiGenerated && (
                                                <span className="pr-culture-card-ai">
                                                    <Icon name="sparkle" size={10} />
                                                    <span>AI 生成</span>
                                                </span>
                                            )}
                                        </div>
                                        <h3 className="pr-culture-card-title">{card.title}</h3>
                                        <p className="pr-culture-card-desc">{card.desc}</p>
                                    </div>
                                </MasonryGrid.Item>
                            ))
                        )}
                    </MasonryGrid>
                </section>
            )}
        </div>
    )
}
