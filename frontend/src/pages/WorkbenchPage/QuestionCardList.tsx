/**
 * 题目卡片列表（SubTask 21.2 —— 全链路打通版）
 *
 * 对接 GET /api/workbench/questions，支持：
 * 1. 真实题卡数据拉取（WorkbenchQuestionMeta：含知识点/分值/收藏/时间戳）
 * 2. 排序：按难度/创建时间/分值（asc/desc）
 * 3. 筛选：按题型/难度/知识点
 * 4. 分页：每页 20 条
 * 5. 虚拟滚动：VirtualList 固定 200px 卡片高度
 * 6. CRUD：编辑（弹出 RefineModal）/ 删除（确认弹窗）/ 复制 / 收藏
 *
 * 数据流：
 * - TanStack Query 主导（useQuery + useMutation）
 * - store.questions 作为会话生成结果缓存（兼容旧流程）
 * - 当 sessionId 存在时，自动附加 sessionId 筛选
 * - SSE 完成后通过 queryClient.invalidateQueries 触发重新拉取
 *
 * 设计要点（规范第 6、10、14 章）：
 * - 卡片左侧 3px 竖线（按 Bloom 层级着色）
 * - hover 时微升 + 透明微边框
 * - 数字列 Tabular Numbers
 * - 加载态：骨架屏；错误态：重试按钮；空态：引导文案
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Combobox, Icon, Modal, VirtualList, type ComboboxOption } from '@/components/ui'
import { Markdown } from '@/components/ui/Markdown'
import { api } from '@/lib/api'
import { useWorkbenchStore } from '@/stores/workbench'
import { toast } from '@/stores/toast'
import { getDisplayError } from '@/lib/errors'
import { isDemoMode } from '@/lib/demo-mode'
import { WORKBENCH_BLOOM_COLORS } from '@/lib/types'
import {
    beginFavoriteOptimisticUpdate,
    reconcileFavoriteResponse,
    rollbackFavoriteOptimisticUpdate,
    type FavoriteTarget,
} from './question-favorite-state'
import type {
    BloomLevel,
    WorkbenchQuestion,
    WorkbenchQuestionListResponse,
    WorkbenchQuestionMeta,
    WorkbenchQuestionQuery,
    WorkbenchQuestionType,
} from '@/lib/types'

/** 每页条数（任务规定 20） */
const PAGE_SIZE = 20

/** 虚拟列表单卡高度（px） */
const CARD_HEIGHT = 200

/** 虚拟列表容器高度（CSS 字符串） */
const LIST_CONTAINER_HEIGHT = 'calc(100vh - 360px)'

/** 难度等级标签 */
const DIFFICULTY_LABELS: Record<number, { label: string; variant: 'default' | 'info' | 'warning' | 'error' }> = {
    1: { label: '入门', variant: 'default' },
    2: { label: '基础', variant: 'info' },
    3: { label: '进阶', variant: 'info' },
    4: { label: '挑战', variant: 'warning' },
    5: { label: '拓展', variant: 'error' },
}

/** 筛选/排序选项 */
/**
 * 「全部」用 'all' 哨兵值而非空串。
 *
 * Combobox 把空串视为「未选择」，于是筛选器明明默认是「全部题型」，
 * 界面上却显示占位符「请选择…」——教师以为自己还没选，实际已在生效。
 * 用显式哨兵值可让选中态如实回显。
 */
const ALL = 'all'

const TYPE_OPTIONS: ComboboxOption[] = [
    { value: ALL, label: '全部题型' },
    { value: '选择', label: '选择' },
    { value: '填空', label: '填空' },
    { value: '配对', label: '配对' },
    { value: '简答', label: '简答' },
    { value: '创作', label: '创作' },
    { value: '应用', label: '应用' },
]

const DIFFICULTY_OPTIONS: ComboboxOption[] = [
    { value: ALL, label: '全部难度' },
    { value: '1', label: '入门' },
    { value: '2', label: '基础' },
    { value: '3', label: '进阶' },
    { value: '4', label: '挑战' },
    { value: '5', label: '拓展' },
]

const SORT_OPTIONS: ComboboxOption[] = [
    { value: 'createdAt', label: '按创建时间' },
    { value: 'difficulty', label: '按难度' },
    { value: 'score', label: '按分值' },
]

/** DEMO 模式占位题卡（保证评委预览体验） */
const DEMO_QUESTIONS: WorkbenchQuestionMeta[] = [
    {
        id: 'demo-q-1',
        poemId: 'poem-jingyesi',
        bloomLevel: '记忆',
        type: '选择',
        stem: '《静夜思》中"床前明月光"的"床"指的是什么？',
        options: ['A. 卧具', 'B. 井栏', 'C. 坐具', 'D. 桌椅'],
        answer: 'B',
        analysis: '"床"在古汉语中可指井栏（即"井床"），李白此诗描述的是室外井边望月思乡之景。',
        distractorsAnalysis: ['A 选项是现代常见理解，但不符合古诗语境', 'C/D 干扰项无文本依据'],
        difficulty: 3,
        estimatedTimeSec: 60,
        aiGenerated: true,
        knowledgePoints: ['古诗意境', '词义辨析'],
        score: 5,
        favorited: false,
        createdAt: Date.now() - 86400_000,
        updatedAt: Date.now() - 86400_000,
    },
    {
        id: 'demo-q-2',
        poemId: 'poem-jingyesi',
        bloomLevel: '理解',
        type: '简答',
        stem: '请简要分析《静夜思》中"疑是地上霜"中"疑"字的表达效果。',
        answer: '"疑"字生动地表现了月光皎洁如霜的视觉效果，同时暗示诗人恍惚、迷离的心境，为下文思乡之情埋下伏笔。',
        analysis: '此题考查学生对诗歌炼字的理解，需结合意境与情感双层面分析。',
        difficulty: 4,
        estimatedTimeSec: 180,
        aiGenerated: true,
        knowledgePoints: ['炼字', '诗歌意境'],
        score: 8,
        favorited: true,
        createdAt: Date.now() - 172800_000,
        updatedAt: Date.now() - 172800_000,
    },
    {
        id: 'demo-q-3',
        poemId: 'poem-wanglushanpubu',
        bloomLevel: '创造',
        type: '创作',
        stem: '请模仿《望庐山瀑布》的夸张手法，以现代城市夜景为题材创作一首四句短诗。',
        answer: '（开放性作答，参考：霓虹飞流三千尺，疑是星河落九天。城市不眠人未倦，月光如水照江烟。）',
        analysis: '本题考查学生对夸张手法的迁移运用，评分维度：1) 是否使用夸张 2) 意境是否连贯 3) 语言是否凝练。',
        difficulty: 5,
        estimatedTimeSec: 600,
        aiGenerated: true,
        knowledgePoints: ['夸张手法', '诗歌创作'],
        score: 15,
        favorited: false,
        createdAt: Date.now() - 259200_000,
        updatedAt: Date.now() - 259200_000,
    },
]

interface QuestionCardListProps {
    /** 点击"微调"按钮时回调，传入目标题目 */
    onRefine: (question: WorkbenchQuestion) => void
}

export const QuestionCardList = memo(function QuestionCardList({ onRefine }: QuestionCardListProps) {
    const queryClient = useQueryClient()
    const generating = useWorkbenchStore((s) => s.generating)
    const sessionId = useWorkbenchStore((s) => s.sessionId)
    const sessionQuestions = useWorkbenchStore((s) => s.questions)
    const selectedIds = useWorkbenchStore((s) => s.selectedIds)
    const toggleSelect = useWorkbenchStore((s) => s.toggleSelect)

    // 筛选/排序/分页状态
    const [page, setPage] = useState(1)
    const [typeFilter, setTypeFilter] = useState<string>(ALL)
    const [difficultyFilter, setDifficultyFilter] = useState<string>(ALL)
    const [knowledgePointFilter, setKnowledgePointFilter] = useState<string>(ALL)
    const [sortBy, setSortBy] = useState<'difficulty' | 'createdAt' | 'score'>('createdAt')
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')

    // 详情弹窗 + 删除确认弹窗
    const [detailQuestion, setDetailQuestion] = useState<WorkbenchQuestionMeta | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<WorkbenchQuestionMeta | null>(null)

    // 构造查询参数
    const query: WorkbenchQuestionQuery = useMemo(() => ({
        page,
        pageSize: PAGE_SIZE,
        // 哨兵值不进请求：'all' 只是 UI 上的「不筛选」，不是一个真实的筛选条件
        type: (typeFilter && typeFilter !== ALL ? typeFilter : undefined) as WorkbenchQuestionType | undefined,
        difficulty: (difficultyFilter && difficultyFilter !== ALL
            ? Number(difficultyFilter)
            : undefined) as 1 | 2 | 3 | 4 | 5 | undefined,
        knowledgePoint: knowledgePointFilter && knowledgePointFilter !== ALL
            ? knowledgePointFilter
            : undefined,
        sortBy,
        sortOrder,
        sessionId: sessionId ?? undefined,
    }), [page, typeFilter, difficultyFilter, knowledgePointFilter, sortBy, sortOrder, sessionId])

    // 主数据查询
    const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
        queryKey: ['workbench', 'questions', query],
        queryFn: () => api.workbench.listQuestions(query),
        placeholderData: (prev) => prev, // 翻页/筛选时保留旧数据，避免闪烁
        staleTime: 30_000, // 30s 内不重复请求
    })

    // 筛选条件变化时回到第一页
    useEffect(() => {
        setPage(1)
    }, [typeFilter, difficultyFilter, knowledgePointFilter, sortBy, sortOrder, sessionId])

    // SSE 生成完成后自动刷新列表
    useEffect(() => {
        if (!generating && sessionId) {
            void queryClient.invalidateQueries({ queryKey: ['workbench', 'questions'] })
        }
    }, [generating, sessionId, queryClient])

    // 收藏 mutation
    const favoriteMutation = useMutation({
        mutationFn: ({ questionId, favorited }: FavoriteTarget) => (
            api.workbench.setFavorite(questionId, favorited)
        ),
        onMutate: async (target) => {
            // 所有题库缓存都写入同一显式目标态，避免切页后看到旧收藏状态。
            await queryClient.cancelQueries({ queryKey: ['workbench', 'questions'] })
            const transitions = queryClient
                .getQueriesData<WorkbenchQuestionListResponse>({ queryKey: ['workbench', 'questions'] })
                .map(([queryKey, previous]) => ({
                    queryKey,
                    transaction: beginFavoriteOptimisticUpdate(previous, target),
                }))

            for (const { queryKey, transaction } of transitions) {
                queryClient.setQueryData(queryKey, transaction.optimistic)
            }
            return { transitions }
        },
        onError: (_err, _target, ctx) => {
            // 每个缓存键恢复到 mutation 开始前的精确快照。
            for (const { queryKey, transaction } of ctx?.transitions ?? []) {
                queryClient.setQueryData(queryKey, rollbackFavoriteOptimisticUpdate(transaction))
            }
            toast.error({ title: '操作失败', message: getDisplayError(_err, '收藏切换失败') })
        },
        onSuccess: (res) => {
            // 乐观值不是事实来源：始终用服务端持久化后的权威状态再次校准。
            queryClient.setQueriesData<WorkbenchQuestionListResponse>(
                { queryKey: ['workbench', 'questions'] },
                (old) => reconcileFavoriteResponse(old, res),
            )
            toast.success({
                title: res.favorited ? '已收藏' : '已取消收藏',
                message: res.favorited ? '该题卡已加入收藏夹' : '该题卡已移出收藏夹',
            })
        },
    })

    // 复制 mutation
    const duplicateMutation = useMutation({
        mutationFn: (questionId: string) => api.workbench.duplicateQuestion(questionId),
        onSuccess: () => {
            toast.success({ title: '复制成功', message: '已创建一道相同题卡' })
            void queryClient.invalidateQueries({ queryKey: ['workbench', 'questions'] })
        },
        onError: (err) => {
            toast.error({ title: '复制失败', message: getDisplayError(err, '未知错误') })
        },
    })

    // 删除 mutation
    const deleteMutation = useMutation({
        mutationFn: (questionId: string) => api.workbench.deleteQuestion(questionId),
        onSuccess: () => {
            toast.success({ title: '已删除', message: '题卡已从题库移除' })
            setDeleteTarget(null)
            void queryClient.invalidateQueries({ queryKey: ['workbench', 'questions'] })
        },
        onError: (err) => {
            toast.error({ title: '删除失败', message: getDisplayError(err, '未知错误') })
        },
    })

    // 收集所有题卡中的知识点（用于知识点筛选 Combobox）
    const knowledgePointOptions: ComboboxOption[] = useMemo(() => {
        const set = new Set<string>()
        // 从 session 题卡中收集
        for (const q of sessionQuestions) {
            const meta = q as WorkbenchQuestionMeta
            if (meta.knowledgePoints) {
                for (const kp of meta.knowledgePoints) set.add(kp)
            }
        }
        // 从查询结果中收集
        if (data?.questions) {
            for (const q of data.questions) {
                if (q.knowledgePoints) {
                    for (const kp of q.knowledgePoints) set.add(kp)
                }
            }
        }
        // 从 DEMO 题卡中收集
        if (isDemoMode()) {
            for (const q of DEMO_QUESTIONS) {
                for (const kp of q.knowledgePoints) set.add(kp)
            }
        }
        return [
            { value: ALL, label: '全部知识点' },
            ...Array.from(set).map((kp) => ({ value: kp, label: kp })),
        ]
    }, [sessionQuestions, data])

    // DEMO 模式降级：使用演示题卡
    const effectiveData = useMemo(() => {
        if (isDemoMode() && !data) {
            // 简单分页
            const start = (page - 1) * PAGE_SIZE
            const sliced = DEMO_QUESTIONS.slice(start, start + PAGE_SIZE)
            return {
                questions: sliced,
                total: DEMO_QUESTIONS.length,
                page,
                pageSize: PAGE_SIZE,
            }
        }
        return data
    }, [data, page])

    // 合并显示：会话题卡（新生成的）+ 题库查询结果
    // 优先显示题库查询结果；若题库为空但有会话题卡，则显示会话题卡
    const displayQuestions: WorkbenchQuestionMeta[] = useMemo(() => {
        if (effectiveData?.questions && effectiveData.questions.length > 0) {
            return effectiveData.questions
        }
        // 会话题卡降级（无 sessionId 或 API 不可用时）
        if (sessionQuestions.length > 0 && (!effectiveData || effectiveData.questions.length === 0)) {
            return sessionQuestions.map((q) => ({
                ...q,
                knowledgePoints: [],
                score: 5,
                favorited: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            })) as WorkbenchQuestionMeta[]
        }
        return []
    }, [effectiveData, sessionQuestions])

    const total = effectiveData?.total ?? displayQuestions.length
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

    /** 翻页 */
    const handlePrevPage = useCallback(() => {
        setPage((p) => Math.max(1, p - 1))
    }, [])
    const handleNextPage = useCallback(() => {
        setPage((p) => Math.min(totalPages, p + 1))
    }, [totalPages])

    /** 切换排序顺序 */
    const handleToggleSortOrder = useCallback(() => {
        setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
    }, [])

    /** 点击收藏 */
    const handleFavorite = useCallback((questionId: string, favorited: boolean) => {
        if (favoriteMutation.isPending) return
        void favoriteMutation.mutate({ questionId, favorited })
    }, [favoriteMutation])

    /** 点击复制 */
    const handleDuplicate = useCallback((questionId: string) => {
        if (duplicateMutation.isPending) return
        void duplicateMutation.mutate(questionId)
    }, [duplicateMutation])

    /** 确认删除 */
    const handleConfirmDelete = useCallback(() => {
        if (!deleteTarget || deleteMutation.isPending) return
        void deleteMutation.mutate(deleteTarget.id)
    }, [deleteTarget, deleteMutation])

    /** 查看详情 */
    const handleViewDetail = useCallback((q: WorkbenchQuestionMeta) => {
        setDetailQuestion(q)
    }, [])

    /** 渲染单张题卡（VirtualList 调用） */
    const renderCard = useCallback((question: WorkbenchQuestionMeta, index: number) => {
        const linearIndex = (page - 1) * PAGE_SIZE + index + 1
        return (
            <QuestionCard
                question={question}
                index={linearIndex}
                selected={selectedIds.has(question.id)}
                onToggleSelect={() => toggleSelect(question.id)}
                onRefine={() => onRefine(question)}
                onViewDetail={() => handleViewDetail(question)}
                onFavorite={() => handleFavorite(question.id, !question.favorited)}
                onDuplicate={() => handleDuplicate(question.id)}
                onDelete={() => setDeleteTarget(question)}
                favoritePending={favoriteMutation.isPending && favoriteMutation.variables?.questionId === question.id}
                duplicatePending={duplicateMutation.isPending && duplicateMutation.variables === question.id}
            />
        )
    }, [page, selectedIds, toggleSelect, onRefine, handleViewDetail, handleFavorite, handleDuplicate,
        favoriteMutation.isPending, favoriteMutation.variables,
        duplicateMutation.isPending, duplicateMutation.variables,
    ])

    // 加载态：骨架屏
    if (isLoading && !effectiveData) {
        return (
            <div className="pr-wb-q-list pr-wb-q-list--loading" aria-busy="true">
                {Array.from({ length: 3 }).map((_, i) => (
                    <QuestionSkeleton key={i} />
                ))}
            </div>
        )
    }

    // 错误态（非 DEMO 模式）
    if (isError && !isDemoMode() && displayQuestions.length === 0) {
        return (
            <div className="pr-wb-q-list pr-wb-q-list--error" role="alert">
                <div className="pr-wb-q-empty-icon">
                    <Icon name="warning-circle" size={28} weight="bold" />
                </div>
                <div className="pr-wb-q-empty-title">题卡暂时没有加载出来</div>
                <div className="pr-wb-q-empty-desc">
                    可能是网络波动或服务暂时繁忙。请稍后重试，或先前往「智能推荐」快速命题。
                </div>
                {import.meta.env.DEV && (
                    <div className="pr-wb-q-empty-tech">{getDisplayError(error, '')}</div>
                )}
                <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<Icon name="arrows-clockwise" size={14} />}
                    onClick={() => void refetch()}
                >
                    重新加载
                </Button>
            </div>
        )
    }

    // 是否处于筛选态（任一条件不是「全部」）
    const hasActiveFilter =
        (typeFilter !== ALL && typeFilter !== '') ||
        (difficultyFilter !== ALL && difficultyFilter !== '') ||
        (knowledgePointFilter !== ALL && knowledgePointFilter !== '')

    /** 一键清除全部筛选条件 */
    const handleClearFilters = () => {
        setTypeFilter(ALL)
        setDifficultyFilter(ALL)
        setKnowledgePointFilter(ALL)
    }

    // 真空态：题库里一条题卡都没有 —— 此时才该引导去命题
    if (displayQuestions.length === 0 && !hasActiveFilter) {
        return (
            <div className="pr-wb-q-list pr-wb-q-list--empty">
                <div className="pr-wb-q-empty-icon">
                    <Icon name="feather" size={28} weight="bold" />
                </div>
                <div className="pr-wb-q-empty-title">题库暂无题卡</div>
                <div className="pr-wb-q-empty-desc">
                    在左侧表单选择诗篇与六阶权重，启动多智能体命题生成
                </div>
            </div>
        )
    }

    return (
        <div className="pr-wb-q-list pr-wb-q-list--bank">
            {/* 筛选/排序工具条 */}
            <div className="pr-wb-q-filters" role="toolbar" aria-label="题卡筛选与排序">
                <div className="pr-wb-q-filter-group">
                    <Combobox
                        className="pr-wb-q-filter-select"
                        value={typeFilter}
                        onChange={(v) => setTypeFilter(v as string)}
                        ariaLabel="按题型筛选"
                        options={TYPE_OPTIONS}
                    />
                    <Combobox
                        className="pr-wb-q-filter-select"
                        value={difficultyFilter}
                        onChange={(v) => setDifficultyFilter(v as string)}
                        ariaLabel="按难度筛选"
                        options={DIFFICULTY_OPTIONS}
                    />
                    <Combobox
                        className="pr-wb-q-filter-select pr-wb-q-filter-select--kp"
                        value={knowledgePointFilter}
                        onChange={(v) => setKnowledgePointFilter(v as string)}
                        ariaLabel="按知识点筛选"
                        options={knowledgePointOptions}
                    />
                </div>
                <div className="pr-wb-q-filter-group">
                    <Combobox
                        className="pr-wb-q-filter-select"
                        value={sortBy}
                        onChange={(v) => setSortBy(v as 'difficulty' | 'createdAt' | 'score')}
                        ariaLabel="排序字段"
                        options={SORT_OPTIONS}
                    />
                    <button
                        type="button"
                        className="pr-wb-q-sort-order"
                        onClick={handleToggleSortOrder}
                        aria-label={sortOrder === 'asc' ? '当前升序，切换为降序' : '当前降序，切换为升序'}
                        title={sortOrder === 'asc' ? '升序' : '降序'}
                    >
                        <Icon name={sortOrder === 'asc' ? 'caret-up' : 'caret-down'} size={14} />
                        <span>{sortOrder === 'asc' ? '升序' : '降序'}</span>
                    </button>
                </div>
            </div>

            {/* 筛选无结果：与「题库真空」是两回事。
                题库有 899 条却筛不出来时，若沿用「题库暂无题卡」的文案并隐藏工具条，
                教师既被误导、又没有清除筛选的出口——只能刷新页面。
                这里保留工具条，并明确告知是筛选条件过窄。 */}
            {displayQuestions.length === 0 ? (
                <div className="pr-wb-q-filtered-empty" role="status">
                    <Icon name="magnifying-glass" size={24} weight="bold" />
                    <p className="pr-wb-q-filtered-empty-title">没有符合当前筛选条件的题卡</p>
                    <p className="pr-wb-q-filtered-empty-desc">
                        {/* 这里不能写「题库共 N 条」：total 是**筛选后**的计数，
                            筛不到结果时它恒为 0，写出来就是「题库共 0 条」这种
                            与事实相反的话。改为只陈述可操作的建议。 */}
                        试试放宽题型、难度或知识点条件
                    </p>
                    <button
                        type="button"
                        className="pr-wb-q-filtered-empty-clear"
                        onClick={handleClearFilters}
                    >
                        <Icon name="arrows-clockwise" size={13} />
                        <span>清除全部筛选</span>
                    </button>
                </div>
            ) : (
            <VirtualList<WorkbenchQuestionMeta>
                items={displayQuestions}
                itemHeight={CARD_HEIGHT}
                containerHeight={LIST_CONTAINER_HEIGHT}
                renderItem={renderCard}
                getKey={(item) => item.id}
                loading={isFetching && !isLoading}
                renderLoading={() => (
                    <div className="pr-wb-q-list-loading-overlay" aria-live="polite">
                        <span className="pr-wb-agent-spinner" aria-hidden />
                        <span>正在同步题卡…</span>
                    </div>
                )}
                className="pr-wb-q-virtual-list"
            />
            )}

            {/* 分页栏 */}
            <div className="pr-wb-q-pagination" role="navigation" aria-label="题卡分页">
                <span className="pr-wb-q-pagination-info">
                    共 <strong className="pr-wb-q-pagination-total">{total}</strong> 条 · 第 {page} / {totalPages} 页
                </span>
                <div className="pr-wb-q-pagination-actions">
                    <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Icon name="caret-left" size={12} />}
                        onClick={handlePrevPage}
                        disabled={page <= 1}
                    >
                        上一页
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        rightIcon={<Icon name="caret-right" size={12} />}
                        onClick={handleNextPage}
                        disabled={page >= totalPages}
                    >
                        下一页
                    </Button>
                </div>
            </div>

            {/* 详情弹窗 */}
            <QuestionDetailModal
                question={detailQuestion}
                onClose={() => setDetailQuestion(null)}
                onRefine={(q) => {
                    setDetailQuestion(null)
                    onRefine(q)
                }}
            />

            {/* 删除确认弹窗 */}
            <Modal
                open={!!deleteTarget}
                onClose={() => setDeleteTarget(null)}
                size="sm"
                title="确认删除题卡"
                footer={
                    <>
                        <Button variant="ghost" size="md" onClick={() => setDeleteTarget(null)}>取消</Button>
                        <Button
                            variant="primary"
                            size="md"
                            leftIcon={<Icon name="trash" size={14} />}
                            loading={deleteMutation.isPending}
                            onClick={handleConfirmDelete}
                        >
                            确认删除
                        </Button>
                    </>
                }
            >
                <div className="pr-wb-q-delete-confirm">
                    <div className="pr-wb-q-delete-confirm-icon">
                        <Icon name="warning-circle" size={28} weight="bold" />
                    </div>
                    <p>删除后不可恢复，确认删除以下题卡？</p>
                    {deleteTarget && (
                        <div className="pr-wb-q-delete-confirm-stem">
                            {deleteTarget.stem.slice(0, 80)}
                            {deleteTarget.stem.length > 80 ? '…' : ''}
                        </div>
                    )}
                </div>
            </Modal>
        </div>
    )
})

/* ============================================================
 * 子组件：单张题目卡片（虚拟列表固定 200px 高）
 * ============================================================ */

interface QuestionCardProps {
    question: WorkbenchQuestionMeta
    index: number
    selected: boolean
    onToggleSelect: () => void
    onRefine: () => void
    onViewDetail: () => void
    onFavorite: () => void
    onDuplicate: () => void
    onDelete: () => void
    favoritePending: boolean
    duplicatePending: boolean
}

const QuestionCard = memo(function QuestionCard({
    question,
    index,
    selected,
    onToggleSelect,
    onRefine,
    onViewDetail,
    onFavorite,
    onDuplicate,
    onDelete,
    favoritePending,
    duplicatePending,
}: QuestionCardProps) {
    const bloomColor = WORKBENCH_BLOOM_COLORS[question.bloomLevel as BloomLevel]
    const diff = DIFFICULTY_LABELS[question.difficulty] ?? { label: '进阶', variant: 'info' as const }
    const isChoice = question.type === '选择' && question.options && question.options.length > 0

    return (
        <article
            className={`pr-wb-q-card${selected ? ' is-selected' : ''}`}
            style={{ '--pr-q-color': bloomColor, height: `${CARD_HEIGHT - 12}px` } as React.CSSProperties}
        >
            {/* 卡片头部 */}
            <header className="pr-wb-q-card-head">
                <label className="pr-wb-q-check">
                    <input
                        type="checkbox"
                        checked={selected}
                        onChange={onToggleSelect}
                        aria-label={`选择第 ${index} 题`}
                    />
                    <span className="pr-wb-q-check-box" aria-hidden>
                        {selected && <Icon name="check" size={12} weight="bold" />}
                    </span>
                </label>

                <span className="pr-wb-q-index">第 {index} 题</span>

                <Badge variant="primary">{question.type}</Badge>
                <Badge variant="default" icon={<span className="pr-wb-q-bloom-dot" style={{ backgroundColor: bloomColor }} />}>
                    {question.bloomLevel}
                </Badge>
                <Badge variant={diff.variant}>{diff.label}</Badge>

                <span className="pr-wb-q-score">
                    <Icon name="star" size={11} />
                    <span>{question.score}分</span>
                </span>

                <button
                    type="button"
                    className={`pr-wb-q-fav${question.favorited ? ' is-favorited' : ''}`}
                    onClick={onFavorite}
                    disabled={favoritePending}
                    aria-label={question.favorited ? '取消收藏' : '收藏题卡'}
                    title={question.favorited ? '已收藏，点击取消' : '点击收藏'}
                >
                    <Icon name={question.favorited ? 'star' : 'star'} size={14} weight={question.favorited ? 'fill' : 'regular'} />
                </button>

                <div className="pr-wb-q-card-actions">
                    <button
                        type="button"
                        className="pr-wb-q-action"
                        onClick={onViewDetail}
                        aria-label={`查看第 ${index} 题完整详情`}
                        aria-haspopup="dialog"
                        title="查看完整详情"
                    >
                        <Icon name="arrow-square-out" size={13} />
                    </button>
                    <button
                        type="button"
                        className="pr-wb-q-action"
                        onClick={onRefine}
                        aria-label="微调此题"
                        title="微调"
                    >
                        <Icon name="edit" size={13} />
                    </button>
                    <button
                        type="button"
                        className="pr-wb-q-action"
                        onClick={onDuplicate}
                        disabled={duplicatePending}
                        aria-label="复制此题"
                        title="复制"
                    >
                        <Icon name="copy" size={13} />
                    </button>
                    <button
                        type="button"
                        className="pr-wb-q-action pr-wb-q-action--danger"
                        onClick={onDelete}
                        aria-label="删除此题"
                        title="删除"
                    >
                        <Icon name="trash" size={13} />
                    </button>
                </div>
            </header>

            {/*
             * 题干是富 Markdown，可合法包含链接、图片或代码复制按钮；不能再把它的
             * 外层伪装成 button，否则会产生交互元素嵌套。详情入口放在操作栏的原生
             * 按钮中，题干内的每一个真实交互元素保留自己的语义和键盘路径。
             */}
            <div className="pr-wb-q-stem">
                <div className="pr-wb-q-stem-content">
                    <Markdown content={question.stem} />
                </div>
                {isChoice && (
                    <ol className="pr-wb-q-options pr-wb-q-options--compact">
                        {(question.options ?? []).slice(0, 4).map((opt, i) => {
                            const label = String.fromCharCode(65 + i)
                            return (
                                <li key={i} className="pr-wb-q-option">
                                    <span className="pr-wb-q-option-label">{label}</span>
                                    <span className="pr-wb-q-option-text">{opt}</span>
                                </li>
                            )
                        })}
                    </ol>
                )}
            </div>

            {/* 底部：知识点 + 元信息 */}
            <footer className="pr-wb-q-card-foot">
                <div className="pr-wb-q-kp-list">
                    {question.knowledgePoints.slice(0, 3).map((kp) => (
                        <span key={kp} className="pr-wb-q-kp-chip">{kp}</span>
                    ))}
                    {question.knowledgePoints.length > 3 && (
                        <span className="pr-wb-q-kp-more">+{question.knowledgePoints.length - 3}</span>
                    )}
                </div>
                <span className="pr-wb-q-meta">
                    <Icon name="clock" size={11} />
                    <span>{question.estimatedTimeSec}s</span>
                </span>
            </footer>
        </article>
    )
})

/* ============================================================
 * 子组件：题卡详情弹窗
 * ============================================================ */

interface QuestionDetailModalProps {
    question: WorkbenchQuestionMeta | null
    onClose: () => void
    onRefine: (q: WorkbenchQuestion) => void
}

function QuestionDetailModal({ question, onClose, onRefine }: QuestionDetailModalProps) {
    if (!question) return null
    const bloomColor = WORKBENCH_BLOOM_COLORS[question.bloomLevel as BloomLevel]
    const diff = DIFFICULTY_LABELS[question.difficulty] ?? { label: '进阶', variant: 'info' as const }
    const isChoice = question.type === '选择' && question.options && question.options.length > 0

    return (
        <Modal
            open={!!question}
            onClose={onClose}
            size="lg"
            title="题卡详情"
            footer={
                <>
                    <Button variant="ghost" size="md" onClick={onClose}>关闭</Button>
                    <Button
                        variant="primary"
                        size="md"
                        leftIcon={<Icon name="edit" size={14} />}
                        onClick={() => onRefine(question)}
                    >
                        微调此题
                    </Button>
                </>
            }
        >
            <div className="pr-wb-q-detail-modal">
                <section className="pr-wb-q-detail-section">
                    <div className="pr-wb-q-detail-head">
                        <Badge variant="primary">{question.type}</Badge>
                        <Badge variant="default" icon={<span className="pr-wb-q-bloom-dot" style={{ backgroundColor: bloomColor }} />}>
                            {question.bloomLevel}
                        </Badge>
                        <Badge variant={diff.variant}>{diff.label}</Badge>
                        <span className="pr-wb-q-detail-meta">
                            分值 {question.score} · 预计 {question.estimatedTimeSec}s
                        </span>
                    </div>
                    <div className="pr-wb-q-detail-stem">
                        <Markdown content={question.stem} />
                    </div>
                </section>

                {isChoice && (
                    <section className="pr-wb-q-detail-section">
                        <div className="pr-wb-q-detail-label">
                            <Icon name="list" size={14} />
                            <span>选项</span>
                        </div>
                        <ol className="pr-wb-q-options pr-wb-q-options--detail">
                            {(question.options ?? []).map((opt, i) => {
                                const label = String.fromCharCode(65 + i)
                                const isAnswer = opt === question.answer || opt.startsWith(question.answer)
                                return (
                                    <li
                                        key={i}
                                        className={`pr-wb-q-option${isAnswer ? ' is-answer' : ''}`}
                                    >
                                        <span className="pr-wb-q-option-label">{label}</span>
                                        <span className="pr-wb-q-option-text">{opt}</span>
                                        {isAnswer && (
                                            <Icon name="check-circle" size={14} weight="bold" />
                                        )}
                                    </li>
                                )
                            })}
                        </ol>
                    </section>
                )}

                <section className="pr-wb-q-detail-section">
                    <div className="pr-wb-q-detail-label">
                        <Icon name="check-circle" size={14} />
                        <span>参考答案</span>
                    </div>
                    <div className="pr-wb-q-detail-content">
                        <Markdown content={question.answer} />
                    </div>
                </section>

                <section className="pr-wb-q-detail-section">
                    <div className="pr-wb-q-detail-label">
                        <Icon name="lightbulb" size={14} />
                        <span>解析</span>
                    </div>
                    <div className="pr-wb-q-detail-content">
                        <Markdown content={question.analysis} />
                    </div>
                </section>

                {question.distractorsAnalysis && question.distractorsAnalysis.length > 0 && (
                    <section className="pr-wb-q-detail-section">
                        <div className="pr-wb-q-detail-label">
                            <Icon name="warning-circle" size={14} />
                            <span>干扰项分析</span>
                        </div>
                        <ul className="pr-wb-q-distractors">
                            {question.distractorsAnalysis.map((d, i) => (
                                <li key={i}>{d}</li>
                            ))}
                        </ul>
                    </section>
                )}

                {question.knowledgePoints.length > 0 && (
                    <section className="pr-wb-q-detail-section">
                        <div className="pr-wb-q-detail-label">
                            <Icon name="tag" size={14} />
                            <span>知识点</span>
                        </div>
                        <div className="pr-wb-q-kp-list">
                            {question.knowledgePoints.map((kp) => (
                                <span key={kp} className="pr-wb-q-kp-chip">{kp}</span>
                            ))}
                        </div>
                    </section>
                )}
            </div>
        </Modal>
    )
}

/* ============================================================
 * 子组件：骨架屏
 * ============================================================ */

function QuestionSkeleton() {
    return (
        <div className="pr-wb-q-card pr-wb-q-card--skeleton" style={{ height: `${CARD_HEIGHT - 12}px` }}>
            <div className="pr-wb-q-card-head">
                <div className="pr-skeleton pr-wb-skeleton-check" />
                <div className="pr-skeleton pr-wb-skeleton-badge" />
                <div className="pr-skeleton pr-wb-skeleton-badge" />
                <div className="pr-skeleton pr-wb-skeleton-badge" />
            </div>
            <div className="pr-wb-q-stem">
                <div className="pr-skeleton pr-skeleton-line" style={{ width: '90%' }} />
                <div className="pr-skeleton pr-skeleton-line" style={{ width: '75%' }} />
                <div className="pr-skeleton pr-skeleton-line" style={{ width: '60%' }} />
            </div>
            <div className="pr-wb-q-card-foot">
                <div className="pr-skeleton pr-wb-skeleton-chip" />
                <div className="pr-skeleton pr-wb-skeleton-chip" />
            </div>
        </div>
    )
}

/** BloomLevel 别名导出，便于其他模块引用 */
export type { BloomLevel }
