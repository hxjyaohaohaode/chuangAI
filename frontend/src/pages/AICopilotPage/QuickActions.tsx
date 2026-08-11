/**
 * 可拖拽上下文物料库 v6（Task 24.4 全面重做）
 *
 * 职责：
 * 1. 4 Tab：学生 / 诗词 / 班级 / 知识点
 * 2. HTML5 Drag API：每个物料项 draggable，onDragStart 设置 dataTransfer
 * 3. 拖到对话区插入 `@[类型:ID:标题]` 引用
 * 4. 点击物料项亦可插入引用（兼容触屏与无拖拽场景）
 * 5. TanStack Query 缓存数据，staleTime 5min
 *
 * 数据源策略：
 * - 班级：useClasses hook（已含 DEMO 降级 + 全局缓存）
 * - 诗词：useQuery + api.workbench.listPoems()；单接口失败明确披露，不冒充诗库
 * - 学生：useQuery + api.students.list()；生产环境只使用后端返回的脱敏学生标识
 * - 知识点：本地预置常见诗词知识点（意象/主题/修辞三类），明确标为内置参考
 *
 * 设计要点（规范第 7、14 章）：
 * - Tab 切换 200ms spring-soft，物料项 staggered 50ms 入场
 * - 拖拽时物料项半透明 + 拖拽 ghost
 * - 物料项 hover 时 surface-tertiary + 微边框
 * - 零 emoji，全部使用 Phosphor SVG 图标
 */

import { memo, useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Icon, type IconName } from '@/components/ui'
import { api } from '@/lib/api'
import { useClasses } from '@/hooks/useClasses'
import { useDemoModeStore } from '@/lib/demo-mode'
import { DEMO_POEMS } from '@/lib/demo-data'
import { cn } from '@/lib/cn'
import { toast } from '@/stores/toast'
import type { StudentOption, WorkbenchPoemOption } from '@/lib/types'

// ─────────────────────────────────────────────────────────────
// 类型与常量
// ─────────────────────────────────────────────────────────────

/** 物料类型 */
type MaterialKind = 'student' | 'poem' | 'class' | 'knowledge'

/** 物料项 */
interface MaterialItem {
    id: string
    title: string
    subtitle?: string
    kind: MaterialKind
}

/** 远端物料的来源状态；禁用“请求失败后静默伪装成真实数据”的降级路径。 */
type RemoteMaterialSource = 'live' | 'demo-mode' | 'stale-live' | 'unavailable'

interface MaterialSourceNotice {
    source: RemoteMaterialSource | 'preset'
    title: string
    description: string
    actionLabel?: string
    onRetry?: () => void
}

/** Tab 配置 */
interface TabConfig {
    key: MaterialKind
    label: string
    icon: IconName
}

const TABS: ReadonlyArray<TabConfig> = [
    { key: 'student', label: '学生', icon: 'user' as IconName },
    { key: 'poem', label: '诗词', icon: 'book-open' as IconName },
    { key: 'class', label: '班级', icon: 'users' as IconName },
    { key: 'knowledge', label: '知识点', icon: 'lightbulb' as IconName },
]

/** TanStack Query 缓存时间 */
const STALE_TIME_MS = 5 * 60 * 1000

// ─────────────────────────────────────────────────────────────
// 本地示例数据（学生 + 知识点）
// ─────────────────────────────────────────────────────────────

/**
 * 离线演示学生列表。
 *
 * 不使用可被误认为真实学生的姓名；生产模式改由 /api/students 返回匿名名。
 */
const DEMO_STUDENTS: ReadonlyArray<MaterialItem> = [
    { id: 'demo-stu-001', title: '演示学生 01', subtitle: '三年级（1）班 · 离线演示', kind: 'student' },
    { id: 'demo-stu-002', title: '演示学生 02', subtitle: '三年级（1）班 · 离线演示', kind: 'student' },
    { id: 'demo-stu-003', title: '演示学生 03', subtitle: '三年级（1）班 · 离线演示', kind: 'student' },
    { id: 'demo-stu-004', title: '演示学生 04', subtitle: '四年级（2）班 · 离线演示', kind: 'student' },
    { id: 'demo-stu-005', title: '演示学生 05', subtitle: '四年级（2）班 · 离线演示', kind: 'student' },
    { id: 'demo-stu-006', title: '演示学生 06', subtitle: '五年级（1）班 · 离线演示', kind: 'student' },
    { id: 'demo-stu-007', title: '演示学生 07', subtitle: '五年级（1）班 · 离线演示', kind: 'student' },
    { id: 'demo-stu-008', title: '演示学生 08', subtitle: '五年级（1）班 · 离线演示', kind: 'student' },
]

/** 知识点列表（按意象/主题/修辞分类） */
const DEMO_KNOWLEDGE: ReadonlyArray<MaterialItem> = [
    { id: 'kp-yixiang-moon', title: '月亮意象', subtitle: '意象 · 思乡怀人', kind: 'knowledge' },
    { id: 'kp-yixiang-snow', title: '雪意象', subtitle: '意象 · 高洁孤傲', kind: 'knowledge' },
    { id: 'kp-yixiang-willow', title: '柳意象', subtitle: '意象 · 离别赠友', kind: 'knowledge' },
    { id: 'kp-theme-homesick', title: '思乡主题', subtitle: '主题 · 故园情结', kind: 'knowledge' },
    { id: 'kp-theme-farewell', title: '送别主题', subtitle: '主题 · 离情别绪', kind: 'knowledge' },
    { id: 'kp-theme-landscape', title: '山水主题', subtitle: '主题 · 寄情山水', kind: 'knowledge' },
    { id: 'kp-rhetoric-metaphor', title: '比喻修辞', subtitle: '修辞 · 以彼物喻此物', kind: 'knowledge' },
    { id: 'kp-rhetoric-personification', title: '拟人修辞', subtitle: '修辞 · 物我交融', kind: 'knowledge' },
    { id: 'kp-rhetoric-exaggeration', title: '夸张修辞', subtitle: '修辞 · 极言其情', kind: 'knowledge' },
    { id: 'kp-form-jueju', title: '绝句体裁', subtitle: '体裁 · 四句定格', kind: 'knowledge' },
    { id: 'kp-form-lushi', title: '律诗体裁', subtitle: '体裁 · 八句对仗', kind: 'knowledge' },
    { id: 'kp-form-cipai', title: '词牌格律', subtitle: '体裁 · 长短句式', kind: 'knowledge' },
]

// ─────────────────────────────────────────────────────────────
// 物料引用格式化
// ─────────────────────────────────────────────────────────────

/** 中文类型映射（用于 @[类型:ID:标题] 引用） */
const KIND_LABEL_MAP: Record<MaterialKind, string> = {
    student: '学生',
    poem: '诗词',
    class: '班级',
    knowledge: '知识点',
}

/**
 * 生成物料引用字符串
 * 格式：@[类型:ID:标题]
 */
function formatReference(item: MaterialItem): string {
    return `@[${KIND_LABEL_MAP[item.kind]}:${item.id}:${item.title}]`
}

// ─────────────────────────────────────────────────────────────
// 单个物料项
// ─────────────────────────────────────────────────────────────

interface MaterialRowProps {
    item: MaterialItem
    index: number
    onInsert: (reference: string) => void
}

const MaterialRow = memo(function MaterialRow({ item, index, onInsert }: MaterialRowProps) {
    const [isDragging, setIsDragging] = useState(false)

    const handleDragStart = useCallback(
        (e: React.DragEvent<HTMLButtonElement>) => {
            const reference = formatReference(item)
            e.dataTransfer.setData('text/plain', reference)
            e.dataTransfer.setData('application/x-copilot-material', JSON.stringify(item))
            e.dataTransfer.effectAllowed = 'copy'
            setIsDragging(true)
        },
        [item],
    )

    const handleDragEnd = useCallback(() => {
        setIsDragging(false)
    }, [])

    const handleClick = useCallback(() => {
        onInsert(formatReference(item))
    }, [item, onInsert])

    const iconForKind: Record<MaterialKind, IconName> = {
        student: 'user' as IconName,
        poem: 'book-open' as IconName,
        class: 'users' as IconName,
        knowledge: 'lightbulb' as IconName,
    }

    return (
        <button
            type="button"
            className={cn('pr-copilot-material-row', {
                'is-dragging': isDragging,
            })}
            draggable
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onClick={handleClick}
            style={{ animationDelay: `${Math.min(index, 10) * 50}ms` }}
            aria-label={`插入${KIND_LABEL_MAP[item.kind]}引用：${item.title}${item.subtitle ? `（${item.subtitle}）` : ''}`}
            title={`点击插入或拖拽到对话区：${item.title}`}
        >
            <span className="pr-copilot-material-row-icon">
                <Icon name={iconForKind[item.kind]} size={14} />
            </span>
            <span className="pr-copilot-material-row-text">
                <span className="pr-copilot-material-row-title">{item.title}</span>
                {item.subtitle && (
                    <span className="pr-copilot-material-row-subtitle">{item.subtitle}</span>
                )}
            </span>
            <span className="pr-copilot-material-row-grip" aria-hidden="true">
                <Icon name="dots-six-vertical" size={12} />
            </span>
        </button>
    )
})

// ─────────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────────

export interface QuickActionsProps {
    /** 物料插入回调 —— 传入 @[类型:ID:标题] 引用字符串 */
    onInsertContext: (reference: string) => void
}

export const QuickActions = memo(function QuickActions({ onInsertContext }: QuickActionsProps) {
    const [activeTab, setActiveTab] = useState<MaterialKind>('student')
    const [query, setQuery] = useState('')

    const selectMaterialTab = useCallback((tab: MaterialKind) => {
        setActiveTab(tab)
        setQuery('')
    }, [])

    const handleMaterialTabKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        const currentIndex = TABS.findIndex((tab) => tab.key === activeTab)
        let nextIndex: number
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                nextIndex = (currentIndex + 1) % TABS.length
                break
            case 'ArrowLeft':
            case 'ArrowUp':
                nextIndex = (currentIndex - 1 + TABS.length) % TABS.length
                break
            case 'Home':
                nextIndex = 0
                break
            case 'End':
                nextIndex = TABS.length - 1
                break
            default:
                return
        }
        event.preventDefault()
        const nextTab = TABS[nextIndex]
        if (!nextTab) return
        selectMaterialTab(nextTab.key)
        event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-copilot-material-tab="${nextTab.key}"]`)
            ?.focus()
    }, [activeTab, selectMaterialTab])

    // 班级数据 —— 使用 useClasses hook（已含全局缓存 + DEMO 降级）
    const { classes, loading: classesLoading } = useClasses()
    const isDemoMode = useDemoModeStore((s) => s.isDemoMode)

    // 诗词数据 —— 正式模式只接受真实诗库响应；失败交给 UI 显式披露和重试。
    const {
        data: poems,
        isLoading: poemsLoading,
        isError: poemsFailed,
        refetch: refetchPoems,
    } = useQuery<WorkbenchPoemOption[], Error>({
        queryKey: ['copilot', 'poems', isDemoMode ? 'demo' : 'live'],
        queryFn: async () => {
            if (isDemoMode) return DEMO_POEMS
            const result = await api.workbench.listPoems()
            return result.poems ?? []
        },
        staleTime: STALE_TIME_MS,
        gcTime: STALE_TIME_MS * 2,
    })

    // 学生数据 —— 正式模式由后端提供匿名名，绝不把本地演示姓名冒充成班级学生。
    const {
        data: liveStudents,
        isLoading: studentsLoading,
        isError: studentsFailed,
        refetch: refetchStudents,
    } = useQuery<StudentOption[], Error>({
        queryKey: ['copilot', 'students', isDemoMode ? 'demo' : 'live'],
        queryFn: async () => {
            if (isDemoMode) return []
            const result = await api.students.list()
            return result.students ?? []
        },
        staleTime: STALE_TIME_MS,
        gcTime: STALE_TIME_MS * 2,
    })

    const students = useMemo<readonly MaterialItem[]>(() => {
        if (isDemoMode) return DEMO_STUDENTS
        return (liveStudents ?? []).map((student) => ({
            id: student.id,
            title: student.name,
            subtitle: student.className ? `${student.className} · 已脱敏` : '已脱敏学生标识',
            kind: 'student' as const,
        }))
    }, [isDemoMode, liveStudents])

    // 知识点数据 —— 本地示例
    const knowledgePoints = useMemo(() => DEMO_KNOWLEDGE, [])

    // 当前 Tab 的物料列表
    const currentItems: readonly MaterialItem[] = useMemo(() => {
        let items: MaterialItem[] = []
        switch (activeTab) {
            case 'student':
                items = [...students]
                break
            case 'poem':
                items = (poems ?? []).map((p) => ({
                    id: p.id,
                    title: p.title,
                    subtitle: `${p.dynasty} · ${p.poet}`,
                    kind: 'poem' as const,
                }))
                break
            case 'class':
                items = classes.map((c) => ({
                    id: c.id,
                    title: c.name,
                    subtitle: undefined,
                    kind: 'class' as const,
                }))
                break
            case 'knowledge':
                items = [...knowledgePoints]
                break
        }
        // 应用搜索过滤
        const trimmed = query.trim().toLowerCase()
        if (!trimmed) return items
        return items.filter(
            (it) =>
                it.title.toLowerCase().includes(trimmed) ||
                (it.subtitle?.toLowerCase().includes(trimmed) ?? false),
        )
    }, [activeTab, students, poems, classes, knowledgePoints, query])

    const handleInsert = useCallback(
        (reference: string) => {
            onInsertContext(reference)
            toast.info({ title: '已插入物料引用', message: reference })
        },
        [onInsertContext],
    )

    const poemSource: RemoteMaterialSource = isDemoMode
        ? 'demo-mode'
        : poemsFailed
            ? (poems && poems.length > 0 ? 'stale-live' : 'unavailable')
            : 'live'
    const studentSource: RemoteMaterialSource = isDemoMode
        ? 'demo-mode'
        : studentsFailed
            ? (liveStudents && liveStudents.length > 0 ? 'stale-live' : 'unavailable')
            : 'live'

    const sourceNotice = useMemo<MaterialSourceNotice | null>(() => {
        if (activeTab === 'knowledge') {
            return {
                source: 'preset',
                title: '内置参考知识点',
                description: '用于组织提示词，不是联网检索结果或学生学习记录。',
            }
        }
        if (activeTab === 'class' && isDemoMode) {
            return {
                source: 'demo-mode',
                title: '当前班级来自离线演示数据',
                description: '仅用于展示界面；恢复服务后会重新加载真实班级。',
            }
        }
        if (activeTab === 'poem') {
            if (poemSource === 'demo-mode') {
                return {
                    source: 'demo-mode',
                    title: '当前诗篇来自离线演示数据',
                    description: '仅用于演示提示词组织，不能作为真实教学任务的依据。',
                }
            }
            if (poemSource === 'unavailable') {
                return {
                    source: 'unavailable',
                    title: '真实诗库暂不可用',
                    description: '暂时无法连接真实诗库；未显示内置诗篇，避免把演示数据误当作当前诗库。',
                    actionLabel: '重试真实诗库',
                    onRetry: () => void refetchPoems(),
                }
            }
            if (poemSource === 'stale-live') {
                return {
                    source: 'stale-live',
                    title: '正在使用已加载的真实诗篇',
                    description: '最新同步未完成；当前列表可能不是最新状态。',
                    actionLabel: '重新同步',
                    onRetry: () => void refetchPoems(),
                }
            }
        }
        if (activeTab === 'student') {
            if (studentSource === 'demo-mode') {
                return {
                    source: 'demo-mode',
                    title: '当前学生来自离线演示数据',
                    description: '演示学生不对应任何真实学生或学习档案。',
                }
            }
            if (studentSource === 'unavailable') {
                return {
                    source: 'unavailable',
                    title: '真实学生名册暂不可用',
                    description: '暂时无法连接真实学生名册；未显示任何示例学生，请恢复服务后重试。',
                    actionLabel: '重试学生名册',
                    onRetry: () => void refetchStudents(),
                }
            }
            if (studentSource === 'stale-live') {
                return {
                    source: 'stale-live',
                    title: '正在使用已加载的脱敏学生标识',
                    description: '最新同步未完成；当前名册可能不是最新状态。',
                    actionLabel: '重新同步',
                    onRetry: () => void refetchStudents(),
                }
            }
        }
        return null
    }, [
        activeTab,
        isDemoMode,
        poemSource,
        refetchPoems,
        refetchStudents,
        studentSource,
    ])

    const isLoading = (activeTab === 'poem' && poemsLoading)
        || (activeTab === 'student' && studentsLoading)
        || (activeTab === 'class' && classesLoading)
    const isEmpty = !isLoading && currentItems.length === 0

    return (
        <section className="pr-copilot-materials" aria-label="上下文物料库">
            <header className="pr-copilot-materials-header">
                <div className="pr-copilot-materials-header-title">
                    <Icon name="stack" size={16} />
                    <h3>上下文物料库</h3>
                </div>
                <span className="pr-copilot-materials-header-hint" title="点击或拖拽物料到对话区">
                    <Icon name="hand-pointing" size={12} />
                    <span>可拖拽</span>
                </span>
            </header>

            {/* Tab 切换 */}
            <div
                className="pr-copilot-materials-tabs"
                role="tablist"
                aria-label="上下文物料分类"
                onKeyDown={handleMaterialTabKeyDown}
            >
                {TABS.map((tab) => (
                    <button
                        key={tab.key}
                        id={`pr-copilot-material-tab-${tab.key}`}
                        data-copilot-material-tab={tab.key}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === tab.key}
                        aria-controls="pr-copilot-material-panel"
                        tabIndex={activeTab === tab.key ? 0 : -1}
                        className={cn('pr-copilot-materials-tab', {
                            'is-active': activeTab === tab.key,
                        })}
                        onClick={() => selectMaterialTab(tab.key)}
                    >
                        <Icon name={tab.icon} size={12} />
                        <span>{tab.label}</span>
                    </button>
                ))}
            </div>

            {sourceNotice && (
                <div
                    className={cn('pr-copilot-materials-source', `is-${sourceNotice.source}`)}
                    role={sourceNotice.source === 'unavailable' ? 'alert' : 'status'}
                >
                    <Icon
                        name={sourceNotice.source === 'unavailable' ? 'warning-circle' : 'info'}
                        size={14}
                        weight="bold"
                        aria-hidden
                    />
                    <div className="pr-copilot-materials-source-copy">
                        <strong>{sourceNotice.title}</strong>
                        <span>{sourceNotice.description}</span>
                    </div>
                    {sourceNotice.actionLabel && sourceNotice.onRetry && (
                        <button type="button" onClick={sourceNotice.onRetry} disabled={isLoading}>
                            {isLoading ? '正在重试' : sourceNotice.actionLabel}
                        </button>
                    )}
                </div>
            )}

            {/* 搜索框（仅在物料项大于 5 时显示） */}
            {currentItems.length > 5 || query ? (
                <div className="pr-copilot-materials-search">
                    <Icon name="magnifying-glass" size={12} className="pr-copilot-materials-search-icon" />
                    <input
                        type="search"
                        className="pr-copilot-materials-search-input"
                        placeholder={`搜索${KIND_LABEL_MAP[activeTab]}…`}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        aria-label={`搜索${KIND_LABEL_MAP[activeTab]}`}
                    />
                    {query && (
                        <button
                            type="button"
                            className="pr-copilot-materials-search-clear"
                            onClick={() => setQuery('')}
                            aria-label="清除搜索"
                        >
                            <Icon name="x" size={10} />
                        </button>
                    )}
                </div>
            ) : null}

            {/* 物料列表 */}
            <div
                id="pr-copilot-material-panel"
                className="pr-copilot-materials-list-wrapper"
                role="tabpanel"
                aria-labelledby={`pr-copilot-material-tab-${activeTab}`}
            >
                {isLoading && (
                    <ul className="pr-copilot-materials-list" aria-busy="true">
                        {[0, 1, 2, 3].map((i) => (
                            <li key={i} className="pr-copilot-materials-skeleton" aria-hidden="true">
                                <span className="pr-copilot-materials-skeleton-icon" />
                                <span className="pr-copilot-materials-skeleton-text">
                                    <span className="pr-copilot-materials-skeleton-title" />
                                    <span className="pr-copilot-materials-skeleton-subtitle" />
                                </span>
                            </li>
                        ))}
                    </ul>
                )}

                {!isLoading && isEmpty && (
                    <div className="pr-copilot-materials-empty">
                        <Icon name="magnifying-glass" size={28} className="pr-copilot-materials-empty-icon" />
                        <p className="pr-copilot-materials-empty-title">
                            {query ? '未匹配到物料' : '暂无物料'}
                        </p>
                        <p className="pr-copilot-materials-empty-desc">
                            {query
                                ? '尝试更换关键词或清除搜索'
                                : activeTab === 'poem' && poemSource === 'unavailable'
                                    ? '真实诗库连接失败；请先重试后再引用诗篇'
                                    : activeTab === 'student' && studentSource === 'unavailable'
                                        ? '真实学生名册连接失败；未展示任何示例学生'
                                : activeTab === 'class'
                                    ? '班级数据加载中或后端不可达'
                                    : activeTab === 'student'
                                        ? '暂无已同步的脱敏学生标识'
                                        : activeTab === 'poem'
                                            ? '当前真实诗库尚无可用诗篇'
                                            : '请稍后重试'}
                        </p>
                        {query && (
                            <button
                                type="button"
                                className="pr-copilot-materials-empty-reset"
                                onClick={() => setQuery('')}
                            >
                                清除搜索
                            </button>
                        )}
                    </div>
                )}

                {!isLoading && !isEmpty && (
                    <ul className="pr-copilot-materials-list">
                        {currentItems.map((item, idx) => (
                            <li key={`${item.kind}-${item.id}`}>
                                <MaterialRow item={item} index={idx} onInsert={handleInsert} />
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* 底部提示 */}
            <footer className="pr-copilot-materials-footer">
                <Icon name="info" size={10} />
                <span>物料将作为 AI 上下文，引用格式 @{`[类型:ID:标题]`}</span>
            </footer>
        </section>
    )
})
