/**
 * Command Palette 全局命令面板（Task 3 重做）
 *
 * 设计依据：规范第 8.2 / 14.5 章 + Task 3 规格
 *
 * 核心能力：
 * - Cmd+K（macOS）/ Ctrl+K（Windows）全局唤起（由 AppShell 绑定快捷键）
 * - 模糊匹配四类数据源：
 *   1. 页面（从 NAV 路由表生成）
 *   2. 功能（手动维护功能列表，如"创建教案""批改作业"）
 *   3. 诗词（TanStack Query 异步加载 + 5 分钟缓存）
 *   4. 学生（TanStack Query 异步加载 + 5 分钟缓存）
 * - 键盘导航：↑↓ 移动高亮项、Enter 跳转、Esc 关闭
 * - 鼠标交互：hover 高亮、点击跳转
 * - 搜索结果按类型分组显示，每组最多 5 项
 * - 历史搜索记录（最近 5 条，localStorage 持久化）
 * - 250ms spring-soft 入场动画 + backdrop-blur 20px 遮罩
 *
 * 跳转规则：
 * - 页面/功能：navigate(path)
 * - 诗词：navigate(`/culture?id=${poemId}`)
 * - 学生：navigate(`/diagnosis?studentId=${studentId}`)
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Icon, type IconName } from './Icon'
import { NAV } from '@/config/nav'
import { api } from '@/lib/api'
import { getDefaultClassId } from '@/hooks/useClasses'
import { cn } from '@/lib/cn'
import type { WorkbenchPoemOption, GradingStudentOption } from '@/lib/types'
import './CommandPalette.css'

/* ============================================================
 * 类型定义
 * ============================================================ */

export interface CommandPaletteProps {
    /** 受控开关 */
    open: boolean
    /** 关闭回调 */
    onClose: () => void
    /** 跳转回调（页面/功能/诗词/学生均通过此回调跳转） */
    onNavigate?: (path: string) => void
}

type CommandKind = 'page' | 'feature' | 'poem' | 'student'

interface CommandItem {
    id: string
    kind: CommandKind
    /** 主标题 */
    title: string
    /** 副标题（描述/路径/作者等） */
    subtitle?: string
    /** 图标名（Phosphor 图标注册表键） */
    icon: IconName | (string & {})
    /** 类型标签（页面/功能/诗词/学生） */
    tag: string
    /** 跳转路径 */
    path: string
    /** 补充搜索关键词 */
    keywords?: string
}

/* ============================================================
 * 静态数据源
 * ============================================================ */

/** 页面命令：从 NAV 路由表生成 */
const PAGE_COMMANDS: CommandItem[] = NAV.map((item) => ({
    id: `page-${item.key}`,
    kind: 'page',
    title: item.label,
    subtitle: item.to,
    icon: item.icon,
    tag: '页面',
    path: item.to,
}))

/**
 * 功能命令：手动维护的高频教学动作
 * 每项映射到一个具体页面（path 与 NAV 对齐）
 */
const FEATURE_COMMANDS: CommandItem[] = [
    {
        id: 'feature-lesson-create',
        kind: 'feature',
        title: '创建教案',
        subtitle: '在教案工坊中新建教案',
        icon: 'notebook',
        tag: '功能',
        path: '/lesson-plan',
        keywords: 'lesson plan create 教案',
    },
    {
        id: 'feature-workbench',
        kind: 'feature',
        title: '命制题目',
        subtitle: '生成新题目并发布',
        icon: 'feather',
        tag: '功能',
        path: '/workbench',
        keywords: 'workbench generate question 命题',
    },
    {
        id: 'feature-classroom',
        kind: 'feature',
        title: '开始课堂导播',
        subtitle: '进入沉浸式课堂',
        icon: 'book-open',
        tag: '功能',
        path: '/classroom',
        keywords: 'classroom start 课堂',
    },
    {
        id: 'feature-grading',
        kind: 'feature',
        title: '批改作业',
        subtitle: '识别手写答题并批改',
        icon: 'pencil-simple-line',
        tag: '功能',
        path: '/grading',
        keywords: 'grading recognize 批改',
    },
    {
        id: 'feature-copilot',
        kind: 'feature',
        title: '咨询 AI 副驾',
        subtitle: '与 AI 副驾对话',
        icon: 'robot',
        tag: '功能',
        path: '/ai-copilot',
        keywords: 'copilot chat ai 副驾',
    },
    {
        id: 'feature-report',
        kind: 'feature',
        title: '生成教研报告',
        subtitle: '生成班级教研分析报告',
        icon: 'scroll',
        tag: '功能',
        path: '/report',
        keywords: 'report analysis 教研',
    },
    {
        id: 'feature-evolution',
        kind: 'feature',
        title: '查看进化之眼',
        subtitle: '基因谱可视化',
        icon: 'sparkle',
        tag: '功能',
        path: '/evolution-eye',
        keywords: 'evolution gene 进化',
    },
    {
        id: 'feature-palace',
        kind: 'feature',
        title: '进入思考宫殿',
        subtitle: '3D 思维链可视化',
        icon: 'brain',
        tag: '功能',
        path: '/thinking-palace',
        keywords: 'thinking palace 思考',
    },
]

/** 分组顺序与显示标题 */
const GROUP_TITLES: ReadonlyArray<{ kind: CommandKind; label: string }> = [
    { kind: 'page', label: '页面' },
    { kind: 'feature', label: '功能' },
    { kind: 'poem', label: '诗词' },
    { kind: 'student', label: '学生' },
]

/** 每组最多显示的项数（规范 8.2：避免长列表拖慢交互） */
const MAX_ITEMS_PER_GROUP = 5

/** 历史记录最大保存条数 */
const MAX_HISTORY = 5

/** 历史记录 localStorage key */
const HISTORY_STORAGE_KEY = 'poetic-realm.cmd-palette.history'

/* ============================================================
 * 组件
 * ============================================================ */

export const CommandPalette = memo(function CommandPalette({
    open,
    onClose,
    onNavigate,
}: CommandPaletteProps) {
    const [query, setQuery] = useState('')
    const [activeIndex, setActiveIndex] = useState(0)
    const [history, setHistory] = useState<string[]>([])
    const inputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const overlayRef = useRef<HTMLDivElement>(null)
    const lastFocused = useRef<HTMLElement | null>(null)

    /* ---------- 异步数据源：诗词（TanStack Query 缓存 5 分钟） ---------- */
    const poemsQuery = useQuery({
        queryKey: ['cmd-palette', 'poems'],
        queryFn: () => api.workbench.listPoems().then((res) => res.poems),
        staleTime: 5 * 60 * 1000,
        enabled: open,
    })

    /* ---------- 异步数据源：学生（TanStack Query 缓存 5 分钟） ---------- */
    // 学生 API 需要按班级查询，使用默认班级 ID（demo 或后端首个班级）
    const studentsQuery = useQuery({
        queryKey: ['cmd-palette', 'students', getDefaultClassId()],
        queryFn: () =>
            api.grading
                .students(getDefaultClassId())
                .then((res) => res.students)
                .catch(() => [] as GradingStudentOption[]),
        staleTime: 5 * 60 * 1000,
        enabled: open,
    })

    /* ---------- 将诗词/学生数据映射为 CommandItem ---------- */
    const poemCommands = useMemo<CommandItem[]>(() => {
        const poems = poemsQuery.data ?? []
        return poems.map((p: WorkbenchPoemOption) => ({
            id: `poem-${p.id}`,
            kind: 'poem',
            title: p.title,
            subtitle: `${p.poet} · ${p.dynasty}`,
            icon: 'scroll',
            tag: '诗词',
            path: `/culture?id=${encodeURIComponent(p.id)}`,
            keywords: `${p.title} ${p.poet} ${p.dynasty}`,
        }))
    }, [poemsQuery.data])

    const studentCommands = useMemo<CommandItem[]>(() => {
        const students = studentsQuery.data ?? []
        return students.map((s: GradingStudentOption) => ({
            id: `student-${s.id}`,
            kind: 'student',
            title: s.name,
            subtitle: '学生档案',
            icon: 'student',
            tag: '学生',
            path: `/diagnosis?studentId=${encodeURIComponent(s.id)}`,
            keywords: s.name,
        }))
    }, [studentsQuery.data])

    /* ---------- 历史记录：localStorage 持久化 ---------- */
    useEffect(() => {
        if (!open) return
        try {
            const stored = localStorage.getItem(HISTORY_STORAGE_KEY)
            if (stored) {
                const parsed = JSON.parse(stored)
                if (Array.isArray(parsed)) {
                    setHistory(parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX_HISTORY))
                }
            }
        } catch {
            // 忽略 localStorage 异常（隐私模式等）
        }
    }, [open])

    const pushHistory = useCallback((q: string) => {
        const trimmed = q.trim()
        if (!trimmed) return
        setHistory((prev) => {
            const next = [trimmed, ...prev.filter((x) => x !== trimmed)].slice(0, MAX_HISTORY)
            try {
                localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next))
            } catch {
                // 忽略写入异常
            }
            return next
        })
    }, [])

    /* ---------- 焦点管理：打开时聚焦输入框，关闭或直接卸载时还原焦点 ---------- */
    useEffect(() => {
        if (!open) return
        lastFocused.current = document.activeElement as HTMLElement | null
        setQuery('')
        setActiveIndex(0)
        // 延迟聚焦，等待面板入场过渡（规范 14.4 / WCAG 2.4.3）
        const t = window.setTimeout(() => inputRef.current?.focus(), 60)
        return () => {
            window.clearTimeout(t)
            // AppShell 关闭时会条件卸载本组件，而不是把 open 作为 false 传入。
            // 在 effect cleanup 中恢复焦点，覆盖普通关闭和父级直接卸载两条路径。
            const previous = lastFocused.current
            lastFocused.current = null
            if (previous?.isConnected && typeof previous.focus === 'function') {
                window.requestAnimationFrame(() => previous.focus({ preventScroll: true }))
            }
        }
    }, [open])

    /* ---------- 焦点陷阱：Tab/Shift+Tab 循环约束在 overlay 内 ---------- */
    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return
            const overlay = overlayRef.current
            if (!overlay) return
            const focusables = overlay.querySelectorAll<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            )
            if (focusables.length === 0) {
                e.preventDefault()
                return
            }
            const first = focusables[0]
            const last = focusables[focusables.length - 1]
            if (!first || !last) {
                e.preventDefault()
                return
            }
            const active = document.activeElement as HTMLElement | null
            if (e.shiftKey) {
                if (active === first || !overlay.contains(active)) {
                    e.preventDefault()
                    last.focus()
                }
            } else {
                if (active === last || !overlay.contains(active)) {
                    e.preventDefault()
                    first.focus()
                }
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [open])

    /* ---------- 过滤 + 分组 ---------- */
    const allCommands = useMemo<CommandItem[]>(
        () => [...PAGE_COMMANDS, ...FEATURE_COMMANDS, ...poemCommands, ...studentCommands],
        [poemCommands, studentCommands],
    )

    const filtered = useMemo<CommandItem[]>(() => {
        const q = query.trim().toLowerCase()
        if (!q) {
            // 空查询：展示页面 + 功能（避免一打开就拉满诗词学生长列表）
            return [...PAGE_COMMANDS, ...FEATURE_COMMANDS]
        }
        return allCommands.filter((cmd) => {
            const haystack = `${cmd.title} ${cmd.subtitle ?? ''} ${cmd.tag} ${cmd.keywords ?? ''}`.toLowerCase()
            return haystack.includes(q)
        })
    }, [allCommands, query])

    const grouped = useMemo<{ kind: CommandKind; label: string; items: CommandItem[] }[]>(() => {
        const map = new Map<CommandKind, CommandItem[]>()
        for (const cmd of filtered) {
            const arr = map.get(cmd.kind) ?? []
            if (arr.length < MAX_ITEMS_PER_GROUP) {
                arr.push(cmd)
            }
            map.set(cmd.kind, arr)
        }
        return GROUP_TITLES.map(({ kind, label }) => ({
            kind,
            label,
            items: map.get(kind) ?? [],
        })).filter((g) => g.items.length > 0)
    }, [filtered])

    // 扁平化结果（用于键盘导航 activeIndex）
    const flatList = useMemo(() => grouped.flatMap((g) => g.items), [grouped])
    const activeCommand = flatList[activeIndex]
    const activeCommandOptionId = activeCommand ? `pr-cmd-option-${activeCommand.id}` : undefined

    /* ---------- activeIndex 越界保护 ---------- */
    useEffect(() => {
        if (activeIndex >= flatList.length) setActiveIndex(0)
    }, [flatList.length, activeIndex])

    /* ---------- 执行跳转 ---------- */
    const execute = useCallback(
        (cmd?: CommandItem) => {
            if (!cmd) return
            pushHistory(query)
            onNavigate?.(cmd.path)
            onClose()
        },
        [onNavigate, onClose, pushHistory, query],
    )

    /* ---------- 键盘导航 ---------- */
    const onKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
            } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                const nextIndex = Math.min(activeIndex + 1, flatList.length - 1)
                setActiveIndex(nextIndex)
                // 输入框依靠 aria-activedescendant 宣布活动项；选项自身获焦时，
                // 方向键还必须把真实 DOM 焦点同步到新的 roving 停靠点。
                if (document.activeElement instanceof HTMLElement
                    && document.activeElement.matches('[data-cmd-idx]')) {
                    window.requestAnimationFrame(() => {
                        listRef.current?.querySelector<HTMLElement>(`[data-cmd-idx="${nextIndex}"]`)?.focus()
                    })
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                const nextIndex = Math.max(activeIndex - 1, 0)
                setActiveIndex(nextIndex)
                if (document.activeElement instanceof HTMLElement
                    && document.activeElement.matches('[data-cmd-idx]')) {
                    window.requestAnimationFrame(() => {
                        listRef.current?.querySelector<HTMLElement>(`[data-cmd-idx="${nextIndex}"]`)?.focus()
                    })
                }
            } else if (e.key === 'Enter') {
                e.preventDefault()
                execute(flatList[activeIndex])
            }
        },
        [flatList, activeIndex, execute, onClose],
    )

    /* ---------- 滚动 active 项进入可视区 ---------- */
    useEffect(() => {
        if (!open || !listRef.current) return
        const el = listRef.current.querySelector<HTMLElement>(`[data-cmd-idx="${activeIndex}"]`)
        el?.scrollIntoView({ block: 'nearest' })
    }, [activeIndex, open])

    if (!open) return null

    // 全局扁平索引计数器（按分组渲染时同步）
    let flatCounter = -1

    return (
        <div
            ref={overlayRef}
            className={cn('pr-cmd-overlay', open && 'open')}
            role="dialog"
            aria-modal="true"
            aria-label="全局命令面板"
            onClick={onClose}
            onKeyDown={onKeyDown}
        >
            <div
                className="pr-cmd-panel"
                onClick={(e) => e.stopPropagation()}
            >
                {/* 搜索输入 */}
                <div className="pr-cmd-input-wrap">
                    <span className="pr-cmd-input-icon">
                        <Icon name="magnifying-glass" size={18} />
                    </span>
                    <input
                        ref={inputRef}
                        type="text"
                        role="combobox"
                        className="pr-cmd-input"
                        placeholder="搜索页面、功能、诗词或学生…"
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value)
                            setActiveIndex(0)
                        }}
                        aria-label="搜索命令"
                        aria-autocomplete="list"
                        aria-controls="pr-command-results"
                        aria-activedescendant={activeCommandOptionId}
                        aria-expanded={flatList.length > 0}
                        aria-haspopup="listbox"
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <kbd className="pr-cmd-input-kbd">ESC</kbd>
                </div>

                {/* 结果列表 */}
                <div className="pr-cmd-results" ref={listRef}>
                    {flatList.length === 0 ? (
                        <div id="pr-command-results" className="pr-cmd-empty" role="status">
                            <span className="pr-cmd-empty-icon">
                                <Icon name="magnifying-glass" size={24} />
                            </span>
                            <span>{query.trim() ? `无匹配「${query.trim()}」的结果` : '输入关键词以搜索'}</span>
                        </div>
                    ) : (
                        <div id="pr-command-results" role="listbox" aria-label="命令搜索结果">
                            {grouped.map((group) => (
                                <div key={group.kind} className="pr-cmd-group" role="group" aria-label={group.label}>
                                    <div className="pr-cmd-group-title" aria-hidden="true">{group.label}</div>
                                    {group.items.map((cmd) => {
                                        flatCounter += 1
                                        const idx = flatCounter
                                        const isActive = idx === activeIndex
                                        return (
                                            <button
                                                key={cmd.id}
                                                id={`pr-cmd-option-${cmd.id}`}
                                                type="button"
                                                data-cmd-idx={idx}
                                                tabIndex={isActive ? 0 : -1}
                                                className={cn('pr-cmd-item', isActive && 'active')}
                                                onClick={() => execute(cmd)}
                                                onFocus={() => setActiveIndex(idx)}
                                                onMouseEnter={() => setActiveIndex(idx)}
                                                role="option"
                                                aria-selected={isActive}
                                                aria-posinset={idx + 1}
                                                aria-setsize={flatList.length}
                                            >
                                                <span className="pr-cmd-item-icon">
                                                    <Icon name={cmd.icon} size={16} />
                                                </span>
                                                <span className="pr-cmd-item-content">
                                                    <span className="pr-cmd-item-title">
                                                        {highlightMatch(cmd.title, query)}
                                                    </span>
                                                    {cmd.subtitle && (
                                                        <span className="pr-cmd-item-subtitle">
                                                            {cmd.subtitle}
                                                        </span>
                                                    )}
                                                </span>
                                                <span className="pr-cmd-item-tag">{cmd.tag}</span>
                                            </button>
                                        )
                                    })}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* 历史搜索是普通的重新填充动作，不属于可由方向键执行的命令列表。 */}
                    {query.trim() === '' && flatList.length > 0 && history.length > 0 && (
                        <div className="pr-cmd-group" role="group" aria-label="最近搜索">
                            <div className="pr-cmd-group-title">最近搜索</div>
                            {history.map((h) => (
                                <button
                                    key={`history-${h}`}
                                    type="button"
                                    className="pr-cmd-item"
                                    onClick={() => setQuery(h)}
                                >
                                    <span className="pr-cmd-item-icon">
                                        <Icon name="arrows-clockwise" size={16} />
                                    </span>
                                    <span className="pr-cmd-item-content">
                                        <span className="pr-cmd-item-title">{h}</span>
                                    </span>
                                    <span className="pr-cmd-item-tag">历史</span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* 底部键盘提示 */}
                <div className="pr-cmd-footer">
                    <span className="pr-cmd-footer-group">
                        <kbd className="pr-cmd-kbd">↑</kbd>
                        <kbd className="pr-cmd-kbd">↓</kbd>
                        <span>导航</span>
                    </span>
                    <span className="pr-cmd-footer-group">
                        <kbd className="pr-cmd-kbd">Enter</kbd>
                        <span>选择</span>
                    </span>
                    <span className="pr-cmd-footer-group">
                        <kbd className="pr-cmd-kbd">Esc</kbd>
                        <span>关闭</span>
                    </span>
                    <span className="pr-cmd-footer-count">{flatList.length} 项</span>
                </div>
            </div>
        </div>
    )
})

/* ============================================================
 * 辅助：搜索结果高亮
 * ============================================================ */

function highlightMatch(text: string, query: string): ReactNode {
    const q = query.trim()
    if (!q) return text
    const lower = text.toLowerCase()
    const ql = q.toLowerCase()
    const idx = lower.indexOf(ql)
    if (idx === -1) return text
    return (
        <>
            {text.slice(0, idx)}
            <mark className="pr-cmd-mark">{text.slice(idx, idx + q.length)}</mark>
            {text.slice(idx + q.length)}
        </>
    )
}
