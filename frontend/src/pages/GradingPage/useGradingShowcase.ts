/**
 * GradingPage 三卡片 Showcase TanStack Query Hooks（SubTask 23.1-23.3）
 *
 * 设计目标：
 * - 为 CardSwap / StackGallery / PixelTransition 三张卡片提供数据
 * - 优先对接后端：GET /api/grading/sessions、GET /api/grading/results/:id
 * - 后端无对应接口时降级到本地 Zustand store；两者都没有数据时返回空集，
 *   由 ShowcaseCards 渲染空状态。**任何情况下都不填充演示数据**——
 *   批改进度、评分、答题卡张数是教师据以决策的数字，编造出来的数字
 *   与真实数字在界面上无法区分，风险远大于「空着不好看」。
 * - 统一 staleTime 60s、retry 1，避免频繁重发
 *
 * 数据流：
 * - useGradingShowcaseQuery：聚合当前批次的"批改前后对比"数据（CardSwap 用）
 * - useGradingStackGalleryQuery：聚合学生答题图片堆（StackGallery 用）
 * - useGradingProgressQuery：聚合批改进度状态（PixelTransition 用）
 *
 * 设计要点（规范第 6、10、15 章）：
 * - 零硬编码：所有 queryKey 通过参数动态生成
 * - 失败优雅：retry 1 后透传 error 给调用方决定回退策略
 * - 缓存隔离：60s staleTime，避免焦点切换频繁重发
 * - 与 Zustand store 并存：本地状态由 store 管理，远程聚合数据由 Query 管理
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useGradingStore } from '@/stores/grading'
import type { GradingBatchHistoryItem } from '@/lib/types'

/** Showcase 查询统一配置：60s staleTime、retry 1、切换数据时保留旧数据避免闪烁 */
const SHOWCASE_QUERY_CONFIG = {
    staleTime: 60 * 1000,
    retry: 1,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
} as const

// ============================================================
// 类型定义
// ============================================================

/** CardSwap 单张卡片数据（批改前后对比） */
export interface CardSwapItem {
    id: string
    /** 卡片标签：'原答题' | '识别结果' | '批改结果' */
    label: string
    /** 卡片主标题 */
    title: string
    /** 卡片副标题 */
    subtitle: string
    /** 图片 URL（如有） */
    imageUrl?: string
    /** 识别/批改文本（如有） */
    text?: string
    /** 状态色：accent-primary / accent-success / accent-warning / accent-info */
    tone: 'primary' | 'success' | 'warning' | 'info'
}

/** StackGallery 单张图片数据 */
export interface StackGalleryItem {
    id: string
    imageUrl: string
    caption: string
}

/** PixelTransition 单个进度状态数据 */
export interface ProgressStateItem {
    id: 'pending' | 'grading' | 'completed' | 'reviewed'
    label: string
    /** 0-100 进度百分比 */
    percentage: number
    /** 该状态的作业数量 */
    count: number
    /** 状态色 */
    tone: 'primary' | 'success' | 'warning' | 'info'
    /** Phosphor 图标名 */
    icon: string
}

/** CardSwap 数据集 */
export interface CardSwapData {
    items: CardSwapItem[]
    /** 数据来源：'live' 后端实时 / 'store' 本地 store / 'empty' 尚无数据 */
    source: 'live' | 'store' | 'empty'
}

/** StackGallery 数据集 */
export interface StackGalleryData {
    items: StackGalleryItem[]
    source: 'live' | 'store' | 'empty'
}

/** PixelTransition 数据集 */
export interface ProgressStateData {
    items: ProgressStateItem[]
    source: 'live' | 'store' | 'empty'
}

// ============================================================
// 辅助：从 store 派生数据
// ============================================================

/**
 * 从 Zustand store 派生 CardSwap 数据
 *
 * v7：按 fileId 配对 files / recognized / results，生成"原答题 → 识别 → 批改"
 * 三段式对比卡片组。最多保留 3 组（共 9 张），避免 CardSwap 过载。
 *
 * 数据链路：
 * - 优先按 fileId 关联三段数据，确保每张卡片是同一份作业的不同处理阶段
 * - 若某阶段缺失，单独展示已有阶段（避免"虚假对应"）
 * - 完全无数据时返回空集（source='empty'），由调用方渲染空状态
 */
function deriveCardSwapFromStore(): CardSwapData {
    const state = useGradingStore.getState()
    const { files, recognized, results } = state

    if (files.length === 0 && recognized.length === 0 && results.length === 0) {
        return { items: [], source: 'empty' }
    }

    const items: CardSwapItem[] = []

    // 收集所有出现过的 fileId（按上传 → 识别 → 批改顺序去重）
    const seenFileIds = new Set<string>()
    const orderedFileIds: string[] = []
    for (const f of files) {
        if (!seenFileIds.has(f.id)) {
            seenFileIds.add(f.id)
            orderedFileIds.push(f.id)
        }
    }
    for (const r of recognized) {
        if (!seenFileIds.has(r.fileId)) {
            seenFileIds.add(r.fileId)
            orderedFileIds.push(r.fileId)
        }
    }
    for (const r of results) {
        if (!seenFileIds.has(r.fileId)) {
            seenFileIds.add(r.fileId)
            orderedFileIds.push(r.fileId)
        }
    }

    // 索引化以加速查找
    const filesMap = new Map(files.map((f) => [f.id, f]))
    const recognizedMap = new Map(recognized.map((r) => [r.fileId, r]))
    const resultsMap = new Map(results.map((r) => [r.fileId, r]))

    // 按 fileId 生成三段对比卡片，最多 3 组（9 张）
    const MAX_GROUPS = 3
    let groupCount = 0

    for (const fileId of orderedFileIds) {
        if (groupCount >= MAX_GROUPS) break

        const f = filesMap.get(fileId)
        const rec = recognizedMap.get(fileId)
        const res = resultsMap.get(fileId)

        // 至少要有 2 个阶段才生成对比组（避免单张孤立卡片）
        const stagesPresent = [f, rec, res].filter(Boolean).length
        if (stagesPresent < 2) continue

        // 卡片 1：原答题（如有）
        if (f) {
            items.push({
                id: `before-${f.id}`,
                label: `原答题 · 第 ${groupCount + 1} 组`,
                title: f.fileName ?? `学生答题卡 #${groupCount + 1}`,
                subtitle: '手写答题卡原图',
                imageUrl: f.url,
                tone: 'info',
            })
        }

        // 卡片 2：识别结果（如有）
        if (rec) {
            items.push({
                id: `recognize-${rec.fileId}`,
                label: `识别结果 · 第 ${groupCount + 1} 组`,
                title: '诗眼 Agent 识别',
                subtitle: `置信度 ${Math.round(rec.confidence * 100)}%`,
                text: rec.studentAnswer,
                tone: 'primary',
            })
        }

        // 卡片 3：批改结果（如有）
        if (res) {
            const isPartial = res.partialScore !== undefined && res.partialScore > 0 && !res.correct
            const statusLabel = res.correct ? '正确' : isPartial ? '部分正确' : '错误'
            items.push({
                id: `grade-${res.fileId}`,
                label: `批改结果 · 第 ${groupCount + 1} 组`,
                title: '诗笔 Agent 批改',
                subtitle: `${statusLabel} · 置信度 ${Math.round(res.confidence * 100)}%`,
                text: res.teacherFeedback || res.cognitiveAttribution || '批改完成',
                tone: res.correct ? 'success' : isPartial ? 'warning' : 'warning',
            })
        }

        groupCount += 1
    }

    // 真实配对组不足时不再用演示卡片补齐——
    // 那会让教师看到一半真实、一半虚构的对比卡，且二者外观完全一致。
    // 宁可少展示几张，也不能把真假混在同一个视图里。
    return { items, source: items.length > 0 ? 'store' : 'empty' }
}

/** 从 Zustand store 派生 StackGallery 数据 */
function deriveStackFromStore(): StackGalleryData {
    const state = useGradingStore.getState()
    const { files } = state

    if (files.length === 0) return { items: [], source: 'empty' }

    return {
        items: files.map((f, i) => ({
            id: f.id,
            imageUrl: f.url,
            caption: f.fileName ?? `第 ${i + 1} 张答题卡`,
        })),
        source: 'store',
    }
}

/** 从 Zustand store 派生 ProgressState 数据 */
function deriveProgressFromStore(): ProgressStateData {
    const state = useGradingStore.getState()
    const { files, recognized, results, summary, stage } = state

    if (files.length === 0 && recognized.length === 0 && results.length === 0) {
        return { items: [], source: 'empty' }
    }

    // 总数依次回退到各阶段的真实计数；全部为 0 时返回空集而不是硬编 20，
    // 否则进度百分比会以一个不存在的分母算出来。
    const total = summary.total || files.length || recognized.length || results.length
    if (total === 0) return { items: [], source: 'empty' }
    const reviewed = results.filter((r) => r.reviewed).length
    const completed = results.length
    const grading = stage === 'grading' || stage === 'recognizing' ? Math.max(1, total - completed) : 0
    const pending = Math.max(0, total - completed - grading)

    const items: ProgressStateItem[] = [
        {
            id: 'pending',
            label: '待批改',
            percentage: total > 0 ? Math.round((pending / total) * 100) : 0,
            count: pending,
            tone: 'warning',
            icon: 'hourglass',
        },
        {
            id: 'grading',
            label: '批改中',
            percentage: total > 0 ? Math.round((grading / total) * 100) : 0,
            count: grading,
            tone: 'primary',
            icon: 'spinner-gap',
        },
        {
            id: 'completed',
            label: '已完成',
            percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
            count: completed,
            tone: 'info',
            icon: 'check-circle',
        },
        {
            id: 'reviewed',
            label: '已复核',
            percentage: total > 0 ? Math.round((reviewed / total) * 100) : 0,
            count: reviewed,
            tone: 'success',
            icon: 'check-fat',
        },
    ]

    return { items, source: 'store' }
}

// ============================================================
// 三个 Query Hooks
// ============================================================

/**
 * CardSwap 数据查询（批改前后对比）
 *
 * 数据源优先级：
 * 1. 后端 GET /api/grading/sessions（如存在）—— 当前接口未实现，跳过
 * 2. 本地 Zustand store —— 主要数据源
 * 3. 空集 —— 无法建立同一份作业的真实阶段配对时，诚实显示空态
 *
 * @param batchId 当前批次 id（可选）
 * @param revision 当前展示状态的本地指纹；只进入 query key，不含学生原文
 */
export function useCardSwapQuery(batchId: string | null, revision: string) {
    return useQuery<CardSwapData, Error>({
        // batchId 在“上传 → 识别 → 批改 → 复核”全过程不变；若只以它做 key，
        // 第一次上传时缓存的空对比会遮蔽后续真实识别/批改结果。revision 仅由
        // 当前批次可展示状态的本地指纹组成，确保派生视图与 Zustand 真相源同步；
        // 指纹不会把学生原文或教师反馈暴露为 React Query key。
        queryKey: ['grading', 'showcase', 'card-swap', batchId ?? '', revision],
        queryFn: async (): Promise<CardSwapData> => {
            // 优先尝试后端 sessions 接口（任务规范要求对接，但当前未实现）
            // 若 future 后端实现 GET /api/grading/sessions，可在此处调用
            // try {
            //     const sessions = await api.grading.sessions()
            //     if (sessions.items?.length) return { items: sessions.items, source: 'live' }
            // } catch { /* 降级 */ }

            // 降级到 store 派生
            return deriveCardSwapFromStore()
        },
        ...SHOWCASE_QUERY_CONFIG,
    })
}

/**
 * StackGallery 数据查询（学生答题图片堆）。revision 保证同一批次上传新文件
 * 后立即重派生，而不等待 60 秒 staleTime。
 */
export function useStackGalleryQuery(batchId: string | null, revision: string) {
    return useQuery<StackGalleryData, Error>({
        queryKey: ['grading', 'showcase', 'stack-gallery', batchId ?? '', revision],
        queryFn: async (): Promise<StackGalleryData> => {
            return deriveStackFromStore()
        },
        ...SHOWCASE_QUERY_CONFIG,
    })
}

/**
 * PixelTransition 数据查询（批改进度状态）
 *
 * @param batchId 当前批次 id
 * @param classId 班级 id（可选，用于拉取 history 聚合跨批次进度）
 */
export function useProgressStateQuery(
    batchId: string | null,
    classId?: string,
    revision = '',
) {
    return useQuery<ProgressStateData, Error>({
        queryKey: ['grading', 'showcase', 'progress', batchId ?? '', classId ?? '', revision],
        queryFn: async (): Promise<ProgressStateData> => {
            // 尝试用 history 接口聚合跨批次进度（如 classId 提供）
            if (classId) {
                try {
                    const historyResp = await api.grading.history(classId)
                    const batches: GradingBatchHistoryItem[] = historyResp.batches ?? []
                    if (batches.length > 0) {
                        const totalFiles = batches.reduce((s, b) => s + (b.fileCount ?? 0), 0)
                        const totalResults = batches.reduce((s, b) => s + (b.resultCount ?? 0), 0)
                        const totalReviewed = batches.reduce((s, b) => s + (b.reviewedCount ?? 0), 0)
                        const pending = Math.max(0, totalFiles - totalResults)
                        const grading = 0 // 跨批次无"批改中"概念
                        return {
                            items: [
                                {
                                    id: 'pending',
                                    label: '待批改',
                                    percentage: totalFiles > 0 ? Math.round((pending / totalFiles) * 100) : 0,
                                    count: pending,
                                    tone: 'warning',
                                    icon: 'hourglass',
                                },
                                {
                                    id: 'grading',
                                    label: '批改中',
                                    percentage: totalFiles > 0 ? Math.round((grading / totalFiles) * 100) : 0,
                                    count: grading,
                                    tone: 'primary',
                                    icon: 'spinner-gap',
                                },
                                {
                                    id: 'completed',
                                    label: '已完成',
                                    percentage: totalFiles > 0 ? Math.round((totalResults / totalFiles) * 100) : 0,
                                    count: totalResults,
                                    tone: 'info',
                                    icon: 'check-circle',
                                },
                                {
                                    id: 'reviewed',
                                    label: '已复核',
                                    percentage: totalFiles > 0 ? Math.round((totalReviewed / totalFiles) * 100) : 0,
                                    count: totalReviewed,
                                    tone: 'success',
                                    icon: 'check-fat',
                                },
                            ],
                            source: 'live',
                        }
                    }
                } catch {
                    // 降级到 store
                }
            }
            return deriveProgressFromStore()
        },
        ...SHOWCASE_QUERY_CONFIG,
    })
}
