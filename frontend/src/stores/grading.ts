/**
 * 智能批改台全局状态（Task 12，规范第 12 章 —— 实时数据同步）
 *
 * 职责：
 * 1. 持有当前批次的全部状态：files / recognized / results / summary
 * 2. 编排上传 → 识别 → 批改 → 审核四阶段流程
 * 3. 教师审核修正后乐观更新本地 results，触发关联视图同步刷新（≤50ms）
 * 4. 加载失败时保留旧数据并提示，不空白
 *
 * 设计要点：
 * - 阶段机：stage ∈ 'idle' | 'uploaded' | 'recognizing' | 'recognized' | 'grading' | 'reviewing'
 * - 乐观更新：review 动作立即反映在 UI，后台异步确认
 * - 失败回滚：review 失败时恢复原 result 并 toast 提示
 * - 图片预览：使用 URL.createObjectURL 生成本地预览 URL，卸载时 revoke
 */

import { getDisplayError } from '@/lib/errors'
import { create } from 'zustand'
import { api } from '@/lib/api'
import { toast } from '@/stores/toast'
import { isDemoMode } from '@/lib/demo-mode'
import { useNotificationStore } from '@/stores/notifications'
import { businessEvents } from '@/lib/business-events'
import type {
    GradingFile,
    RecognizedItem,
    GradingResult,
    GradingSummary,
    GradeRequestItem,
    ReviewRequest,
    CognitiveAttributionStat,
    MultiDimScoreOutput,
    HandwritingOcrOutput,
    ErrorAttributionOutput,
    GradingBatch,
} from '@/lib/types'

/** 批改流程阶段 */
export type GradingStage =
    | 'idle'          // 初始态
    | 'uploaded'      // 已上传，待识别
    | 'recognizing'   // 识别中
    | 'recognized'    // 已识别，待批改
    | 'grading'       // 批改中
    | 'reviewing'     // 批改完成，待教师审核

/** 空摘要初始值 */
const EMPTY_SUMMARY: GradingSummary = {
    total: 0,
    correct: 0,
    partial: 0,
    wrong: 0,
    needsReview: 0,
    avgConfidence: 0,
}

const BATCH_STATUSES = new Set(['uploading', 'recognizing', 'grading', 'reviewing', 'completed'])
const REVIEW_ACTIONS = new Set(['confirm', 'modify', 'reference'])

function isOptionalNonEmptyString(value: unknown): boolean {
    return value === undefined || (typeof value === 'string' && value.trim().length > 0)
}

function isConfidence(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function isGradingSummary(value: unknown, expectedTotal: number): value is GradingSummary {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Partial<GradingSummary>
    const countKeys = ['total', 'correct', 'partial', 'wrong', 'needsReview'] as const
    return countKeys.every((key) => Number.isInteger(candidate[key]) && (candidate[key] as number) >= 0)
        && candidate.total === expectedTotal
        && (candidate.correct as number) + (candidate.partial as number) + (candidate.wrong as number) === candidate.total
        && (candidate.needsReview as number) <= candidate.total
        && isConfidence(candidate.avgConfidence)
}

function computeGradingSummary(results: GradingResult[]): GradingSummary {
    let correct = 0
    let partial = 0
    let wrong = 0
    let needsReview = 0
    let confidenceTotal = 0
    for (const result of results) {
        if (result.needsHumanReview) needsReview += 1
        if (result.correct) correct += 1
        else if (result.partialScore !== undefined && result.partialScore > 0) partial += 1
        else wrong += 1
        confidenceTotal += result.confidence
    }
    return {
        total: results.length,
        correct,
        partial,
        wrong,
        needsReview,
        avgConfidence: results.length > 0
            ? Math.round((confidenceTotal / results.length) * 1000) / 1000
            : 0,
    }
}

function applyReviewToResult(result: GradingResult, req: ReviewRequest): GradingResult {
    const action = req.action ?? 'confirm'
    const next: GradingResult = {
        ...result,
        reviewed: true,
        reviewAction: action,
    }
    if (action === 'modify') {
        if (req.correct !== undefined) next.correct = req.correct
        if (req.feedback !== undefined) {
            next.feedback = req.feedback
            next.teacherFeedback = req.feedback
        }
        if (req.cognitiveAttribution !== undefined) {
            next.cognitiveAttribution = req.cognitiveAttribution
            next.teacherAttribution = req.cognitiveAttribution
        }
        next.confidence = 1
        next.needsHumanReview = false
    } else if (action === 'confirm') {
        next.confidence = Math.max(next.confidence, 0.95)
        next.needsHumanReview = false
    } else {
        next.needsHumanReview = false
    }
    return next
}

function isGradingResultSnapshot(value: unknown, expectedFileId: string, expectedQuestionId: string): value is GradingResult {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Partial<GradingResult>
    return candidate.fileId === expectedFileId
        && candidate.questionId === expectedQuestionId
        && isOptionalNonEmptyString(candidate.studentId)
        && typeof candidate.correct === 'boolean'
        && (candidate.partialScore === undefined || isConfidence(candidate.partialScore))
        && typeof candidate.cognitiveAttribution === 'string'
        && typeof candidate.feedback === 'string'
        && typeof candidate.teacherHint === 'string'
        && isConfidence(candidate.confidence)
        && typeof candidate.needsHumanReview === 'boolean'
        && candidate.aiGenerated === true
        && (candidate.reviewed === undefined || typeof candidate.reviewed === 'boolean')
        && (candidate.reviewAction === undefined || REVIEW_ACTIONS.has(candidate.reviewAction))
        && (candidate.teacherFeedback === undefined || typeof candidate.teacherFeedback === 'string')
        && (candidate.teacherAttribution === undefined || typeof candidate.teacherAttribution === 'string')
}

/**
 * `fetchJSON<T>` 只提供编译期类型，不能把网络响应直接当成可信业务状态。
 * 历史/刷新批次会整体替换当前 UI，因此这里要求完整、互相一致的一次性快照；
 * 任一字段缺失、重复或跨文件引用都失败关闭，保留原批次。
 */
function parseGradingBatch(value: unknown, expectedBatchId: string): GradingBatch {
    if (!value || typeof value !== 'object') throw new Error('批次响应不完整，请重试')
    const batch = value as Partial<GradingBatch>
    if (batch.status !== 'ok'
        || batch.batchId !== expectedBatchId
        || typeof batch.classId !== 'string'
        || batch.classId.trim().length === 0
        || !isOptionalNonEmptyString(batch.lessonId)
        || !isOptionalNonEmptyString(batch.questionId)
        || !isOptionalNonEmptyString(batch.poemId)
        || !isOptionalNonEmptyString(batch.questionStem)
        || typeof batch.batchStatus !== 'string'
        || !BATCH_STATUSES.has(batch.batchStatus)
        || !batch.progress
        || !Number.isInteger(batch.progress.total)
        || batch.progress.total < 0
        || !Number.isInteger(batch.progress.done)
        || batch.progress.done < 0
        || !Array.isArray(batch.files)
        || !Array.isArray(batch.recognized)
        || !Array.isArray(batch.results)) {
        throw new Error('批次响应不完整，请重试')
    }

    const fileIds = new Set<string>()
    if (batch.files.some((item) => {
        if (!item || typeof item !== 'object') return true
        const candidate = item as Partial<GradingFile>
        if (typeof candidate.id !== 'string'
            || candidate.id.trim().length === 0
            || fileIds.has(candidate.id)
            || typeof candidate.url !== 'string'
            || candidate.url.trim().length === 0
            || (candidate.fileName !== undefined && typeof candidate.fileName !== 'string')) return true
        fileIds.add(candidate.id)
        return false
    })) throw new Error('批次文件响应不完整，请重试')

    const recognizedIds = new Set<string>()
    if (batch.recognized.some((item) => {
        if (!item || typeof item !== 'object') return true
        const candidate = item as Partial<RecognizedItem>
        if (typeof candidate.fileId !== 'string'
            || !fileIds.has(candidate.fileId)
            || recognizedIds.has(candidate.fileId)
            || !isOptionalNonEmptyString(candidate.studentId)
            || !isOptionalNonEmptyString(candidate.questionId)
            || typeof candidate.studentAnswer !== 'string'
            || !isConfidence(candidate.confidence)
            || typeof candidate.needsManualMatch !== 'boolean') return true
        recognizedIds.add(candidate.fileId)
        return false
    })) throw new Error('批次识别响应不完整，请重试')

    const resultIds = new Set<string>()
    if (batch.results.some((item) => {
        if (!item || typeof item !== 'object') return true
        const candidate = item as Partial<GradingResult>
        if (typeof candidate.fileId !== 'string'
            || !fileIds.has(candidate.fileId)
            || resultIds.has(candidate.fileId)
            || !isOptionalNonEmptyString(candidate.studentId)
            || typeof candidate.questionId !== 'string'
            || candidate.questionId.trim().length === 0
            || typeof candidate.correct !== 'boolean'
            || (candidate.partialScore !== undefined && !isConfidence(candidate.partialScore))
            || typeof candidate.cognitiveAttribution !== 'string'
            || typeof candidate.feedback !== 'string'
            || typeof candidate.teacherHint !== 'string'
            || !isConfidence(candidate.confidence)
            || typeof candidate.needsHumanReview !== 'boolean'
            || candidate.aiGenerated !== true
            || (candidate.reviewed !== undefined && typeof candidate.reviewed !== 'boolean')
            || (candidate.reviewAction !== undefined && !REVIEW_ACTIONS.has(candidate.reviewAction))
            || (candidate.teacherFeedback !== undefined && typeof candidate.teacherFeedback !== 'string')
            || (candidate.teacherAttribution !== undefined && typeof candidate.teacherAttribution !== 'string')) return true
        resultIds.add(candidate.fileId)
        return false
    })) throw new Error('批次结果响应不完整，请重试')

    if (batch.progress.total !== batch.files.length
        || batch.progress.done !== batch.results.length
        || !isGradingSummary(batch.summary, batch.results.length)) {
        throw new Error('批次汇总响应不完整，请重试')
    }

    return batch as GradingBatch
}

/**
 * 批改请求代次。reset 会令所有旧请求失去写权限；即使底层 fetch 暂未支持
 * AbortSignal，晚到响应也不能把已清空或新建的批次重新“复活”。
 */
let gradingOperationGeneration = 0
let gradingReviewOperationId = 0

interface GradingState {
    // ── 批次元数据 ──
    batchId: string | null
    classId: string
    lessonId?: string
    questionId?: string
    stage: GradingStage

    // ── 批次数据 ──
    /** 上传的文件列表（含本地预览 URL） */
    files: Array<GradingFile & { previewUrl?: string }>
    /** 识别结果（fileId → RecognizedItem） */
    recognized: RecognizedItem[]
    /** 批改结果（fileId → GradingResult） */
    results: GradingResult[]
    /** 统计摘要 */
    summary: GradingSummary

    // ── UI 状态 ──
    /** 当前展开详情的 fileId（null 表示无展开） */
    expandedFileId: string | null
    /** 当前审核面板聚焦的 fileId */
    reviewingFileId: string | null
    /** 加载态（任意阶段进行中） */
    loading: boolean
    /** 错误信息 */
    error: string | null
    /** 每次明确重置批次时递增，供组件清理不属于 store 的本地预览资源。 */
    resetEpoch: number
    /** 同一 fileId 的审核请求必须单飞；数值为当前请求的唯一操作 ID。 */
    reviewPendingByFileId: Record<string, number>

    // ── 批改诊断深化能力数据 ──
    /** 多维度评分结果（fileId → MultiDimScoreOutput） */
    multiDimScores: Record<string, MultiDimScoreOutput>
    /** 手写识别结果（fileId → HandwritingOcrOutput） */
    ocrResults: Record<string, HandwritingOcrOutput>
    /** 错题归因结果（fileId → ErrorAttributionOutput） */
    errorAttributions: Record<string, ErrorAttributionOutput>
    /** 多维度评分加载态 */
    scoringMultiDim: boolean
    /** 手写识别加载态 */
    ocrLoading: boolean
    /** 错题归因加载态 */
    attributing: boolean

    // ── 动作 ──
    /** 设置班级 ID */
    setClassId: (classId: string) => void
    /** 设置课程/题目上下文 */
    setContext: (lessonId?: string, questionId?: string) => void
    /** 上传图片（同时生成本地预览） */
    uploadFiles: (fileList: File[]) => Promise<boolean>
    /** 触发识别 */
    recognize: () => Promise<void>
    /** 触发批改 */
    grade: (items?: GradeRequestItem[]) => Promise<void>
    /** 教师审核单条结果 */
    review: (req: ReviewRequest) => Promise<boolean>
    /** 全部确认（批量审核） */
    confirmAll: () => Promise<void>
    /** 设置展开的详情 fileId */
    setExpanded: (fileId: string | null) => void
    /** 设置审核面板聚焦 fileId */
    setReviewing: (fileId: string | null) => void
    /** 更新单条识别结果（教师编辑识别文本/题目匹配） */
    updateRecognized: (fileId: string, patch: Partial<RecognizedItem>) => void
    /** 重置 store（清理批次） */
    reset: () => void
    /** 从后端重新拉取批次状态 */
    refreshBatch: () => Promise<void>
    /** 打开一个历史批改批次 */
    loadBatch: (batchId: string) => Promise<boolean>

    // ── 批改诊断深化能力动作 ──
    /** 多维度评分（单条） */
    scoreMultiDim: (fileId: string, questionId: string, studentAnswer: string, weights?: Partial<Record<string, number>>) => Promise<void>
    /** 手写识别（单张，含逐字置信度 + 可疑字标记） */
    runOcr: (fileId: string, imageUrl: string, context?: string) => Promise<void>
    /** 错题归因（单条） */
    attributeError: (fileId: string, questionId: string, studentAnswer: string) => Promise<void>
}

/**
 * Grading Zustand store
 *
 * 用法：
 *   const { stage, results, uploadFiles } = useGradingStore()
 *   await useGradingStore.getState().uploadFiles(fileList)
 */
export const useGradingStore = create<GradingState>((set, get) => ({
    batchId: null,
    classId: '',
    lessonId: undefined,
    questionId: undefined,
    stage: 'idle',

    files: [],
    recognized: [],
    results: [],
    summary: EMPTY_SUMMARY,

    expandedFileId: null,
    reviewingFileId: null,
    loading: false,
    error: null,
    resetEpoch: 0,
    reviewPendingByFileId: {},

    // 批改诊断深化能力初始状态
    multiDimScores: {},
    ocrResults: {},
    errorAttributions: {},
    scoringMultiDim: false,
    ocrLoading: false,
    attributing: false,

    setClassId: (classId) => {
        set({ classId })
    },

    setContext: (lessonId, questionId) => {
        set({ lessonId, questionId })
    },

    uploadFiles: async (fileList) => {
        const operationGeneration = gradingOperationGeneration
        const { batchId, classId, files, lessonId, questionId, stage } = get()
        if (batchId || stage !== 'idle' || files.length > 0) {
            toast.warning({
                title: '当前批次已锁定',
                message: '请先新建批次，再上传另一组作业图片',
            })
            return false
        }
        if (!classId) {
            toast.error({ title: '上传失败', message: '请先选择班级' })
            return false
        }
        if (fileList.length === 0) return false
        // v5.0 Task 5.8：DEMO 模式下提示后端不可达
        if (isDemoMode()) {
            toast.warning({
                title: '演示模式下不可上传',
                message: '当前为预览模式，图片上传功能请在完整环境中使用',
            })
            return false
        }

        set({ loading: true, error: null })

        try {
            const res = await api.grading.upload(fileList, classId, lessonId, questionId)
            if (operationGeneration !== gradingOperationGeneration) return false

            // 上传是事务边界：响应缺项或数量漂移不能被防御性降级成“上传成功”。
            const rawUploaded = Array.isArray(res.uploadedFiles) ? res.uploadedFiles : []
            if (typeof res.batchId !== 'string'
                || res.batchId.trim().length === 0
                || rawUploaded.length !== fileList.length
                || rawUploaded.some((file) => (
                    !file
                    || typeof file.id !== 'string'
                    || file.id.trim().length === 0
                    || typeof file.url !== 'string'
                    || file.url.trim().length === 0
                ))) {
                throw new Error('上传响应不完整，请重试')
            }
            // 合并后端返回的文件元数据
            const files: Array<GradingFile & { previewUrl?: string }> = rawUploaded.map((uf) => ({
                id: uf.id,
                url: uf.url,
                // 后端 /files/:fileId 提供图片访问
                previewUrl: undefined,
            }))

            set({
                batchId: res.batchId,
                files,
                stage: 'uploaded',
                loading: false,
                recognized: [],
                results: [],
                summary: EMPTY_SUMMARY,
                expandedFileId: null,
                reviewingFileId: null,
            })

            toast.success({
                title: '上传成功',
                message: `已上传 ${typeof res.pendingRecognition === 'number' ? res.pendingRecognition : files.length} 张图片，可开始识别`,
            })
            return true
        } catch (err) {
            if (operationGeneration !== gradingOperationGeneration) return false
            const message = getDisplayError(err, '上传失败')
            set({ loading: false, error: message })
            toast.error({ title: '上传失败', message })
            return false
        }
    },

    recognize: async () => {
        const operationGeneration = gradingOperationGeneration
        const { batchId, files } = get()
        if (!batchId) {
            toast.warning({ title: '请先上传图片' })
            return
        }
        // v5.0 Task 5.8：DEMO 模式下提示后端不可达
        if (isDemoMode()) {
            toast.warning({
                title: '演示模式下不可识别',
                message: '当前为预览模式，OCR 识别功能请在完整环境中使用',
            })
            return
        }

        set({ loading: true, error: null, stage: 'recognizing' })

        try {
            const res = await api.grading.recognize(batchId)
            if (operationGeneration !== gradingOperationGeneration || get().batchId !== batchId) return
            const rawRecognized: unknown = res.recognized
            const expectedFileIds = new Set(files.map((file) => file.id))
            const seenFileIds = new Set<string>()
            if (!Array.isArray(rawRecognized)
                || rawRecognized.length !== files.length
                || rawRecognized.some((item) => {
                    if (!item || typeof item !== 'object') return true
                    const candidate = item as Partial<RecognizedItem>
                    if (typeof candidate.fileId !== 'string'
                        || !expectedFileIds.has(candidate.fileId)
                        || seenFileIds.has(candidate.fileId)
                        || typeof candidate.studentAnswer !== 'string'
                        || typeof candidate.confidence !== 'number'
                        || !Number.isFinite(candidate.confidence)
                        || candidate.confidence < 0
                        || candidate.confidence > 1
                        || typeof candidate.needsManualMatch !== 'boolean'
                        || (candidate.questionId !== undefined
                            && (typeof candidate.questionId !== 'string' || candidate.questionId.length === 0))) {
                        return true
                    }
                    seenFileIds.add(candidate.fileId)
                    return false
                })) {
                throw new Error('识别响应不完整，请重试')
            }
            const safeRecognized = rawRecognized as RecognizedItem[]
            set({
                recognized: safeRecognized,
                stage: 'recognized',
                loading: false,
            })

            const unmatched = safeRecognized.filter((r) => r.needsManualMatch).length
            if (unmatched > 0) {
                toast.warning({
                    title: '识别完成',
                    message: `${unmatched} 张图片未自动匹配题目，请手动选择`,
                })
            } else {
                toast.success({
                    title: '识别完成',
                    message: `已识别 ${safeRecognized.length} 条答案，可开始批改`,
                })
            }
        } catch (err) {
            if (operationGeneration !== gradingOperationGeneration || get().batchId !== batchId) return
            const message = getDisplayError(err, '识别失败')
            set({ loading: false, error: message, stage: 'uploaded' })
            toast.error({ title: '识别失败', message })
        }
    },

    grade: async (overrideItems) => {
        const operationGeneration = gradingOperationGeneration
        const { batchId, recognized } = get()
        if (!batchId) {
            toast.warning({ title: '请先上传图片' })
            return
        }
        if (recognized.length === 0 && !overrideItems) {
            toast.warning({ title: '请先识别图片' })
            return
        }
        // v5.0 Task 5.8：DEMO 模式下提示后端不可达
        if (isDemoMode()) {
            toast.warning({
                title: '演示模式下不可批改',
                message: '当前为预览模式，智能批改功能请在完整环境中使用',
            })
            return
        }

        // 检查是否有未匹配题目的项
        const items: GradeRequestItem[] = overrideItems ?? recognized
            .filter((r) => !!r.questionId)
            .map((r) => ({
                fileId: r.fileId,
                questionId: r.questionId as string,
                studentId: r.studentId,
                studentAnswer: r.studentAnswer,
            }))

        if (items.length === 0) {
            toast.warning({ title: '无可批改项', message: '请先为识别结果匹配题目' })
            return
        }
        if (new Set(items.map((item) => item.fileId)).size !== items.length) {
            toast.warning({ title: '批改项重复', message: '同一张作业不能在一个批次中重复提交' })
            return
        }

        set({ loading: true, error: null, stage: 'grading' })

        try {
            const res = await api.grading.grade(batchId, items)
            if (operationGeneration !== gradingOperationGeneration || get().batchId !== batchId) return
            const rawResults: unknown = res.results
            const expectedByFileId = new Map(items.map((item) => [item.fileId, item]))
            const seenResultIds = new Set<string>()
            if (!Array.isArray(rawResults)
                || rawResults.length !== items.length
                || rawResults.some((item) => {
                    if (!item || typeof item !== 'object') return true
                    const candidate = item as Partial<GradingResult>
                    const expected = typeof candidate.fileId === 'string'
                        ? expectedByFileId.get(candidate.fileId)
                        : undefined
                    if (!expected
                        || seenResultIds.has(candidate.fileId as string)
                        || candidate.questionId !== expected.questionId
                        || typeof candidate.correct !== 'boolean'
                        || typeof candidate.cognitiveAttribution !== 'string'
                        || typeof candidate.feedback !== 'string'
                        || typeof candidate.teacherHint !== 'string'
                        || typeof candidate.confidence !== 'number'
                        || !Number.isFinite(candidate.confidence)
                        || candidate.confidence < 0
                        || candidate.confidence > 1
                        || typeof candidate.needsHumanReview !== 'boolean'
                        || candidate.aiGenerated !== true
                        || (candidate.partialScore !== undefined
                            && (typeof candidate.partialScore !== 'number'
                                || !Number.isFinite(candidate.partialScore)
                                || candidate.partialScore < 0
                                || candidate.partialScore > 1))) {
                        return true
                    }
                    seenResultIds.add(candidate.fileId as string)
                    return false
                })) {
                throw new Error('批改响应不完整，请重试')
            }
            const rawSummary: unknown = res.summary
            if (!rawSummary || typeof rawSummary !== 'object') {
                throw new Error('批改汇总缺失，请重试')
            }
            const summaryCandidate = rawSummary as Partial<GradingSummary>
            const countKeys = ['total', 'correct', 'partial', 'wrong', 'needsReview'] as const
            if (countKeys.some((key) => !Number.isInteger(summaryCandidate[key]) || (summaryCandidate[key] as number) < 0)
                || summaryCandidate.total !== rawResults.length
                || (summaryCandidate.correct as number)
                    + (summaryCandidate.partial as number)
                    + (summaryCandidate.wrong as number) !== summaryCandidate.total
                || (summaryCandidate.needsReview as number) > summaryCandidate.total
                || typeof summaryCandidate.avgConfidence !== 'number'
                || !Number.isFinite(summaryCandidate.avgConfidence)
                || summaryCandidate.avgConfidence < 0
                || summaryCandidate.avgConfidence > 1) {
                throw new Error('批改汇总不完整，请重试')
            }
            const safeResults = rawResults as GradingResult[]
            const safeSummary = summaryCandidate as GradingSummary
            set({
                results: safeResults,
                summary: safeSummary,
                stage: 'reviewing',
                loading: false,
            })

            if (safeSummary.needsReview > 0) {
                toast.warning({
                    title: '批改完成',
                    message: `${safeSummary.needsReview} 条需人工审核`,
                })
            } else {
                toast.success({
                    title: '批改完成',
                    message: `共 ${safeSummary.total} 条，正确 ${safeSummary.correct} 条`,
                })
            }
            useNotificationStore.getState().push({
                type: safeSummary.needsReview > 0 ? 'warning' : 'success',
                title: '批改已完成',
                description: safeSummary.needsReview > 0
                    ? `${safeSummary.needsReview} 条需人工审核`
                    : `共 ${safeSummary.total} 条，正确 ${safeSummary.correct} 条`,
                linkTo: '/grading',
            })
        } catch (err) {
            if (operationGeneration !== gradingOperationGeneration || get().batchId !== batchId) return
            const message = getDisplayError(err, '批改失败')
            set({ loading: false, error: message, stage: 'recognized' })
            toast.error({ title: '批改失败', message })
        }
    },

    review: async (req) => {
        const operationGeneration = gradingOperationGeneration
        const currentState = get()
        const originalResult = currentState.results.find((result) => result.fileId === req.fileId)
        if (!currentState.batchId
            || currentState.batchId !== req.batchId
            || !originalResult) {
            toast.warning({
                title: '审核对象已变化',
                message: '当前页面已切换批次或该结果不存在，请重新打开后再审核',
            })
            return false
        }
        if (get().reviewPendingByFileId[req.fileId] !== undefined) {
            toast.info({ title: '该项正在保存', message: '请等待当前审核请求完成后再提交' })
            return false
        }
        gradingReviewOperationId += 1
        const reviewOperationId = gradingReviewOperationId

        // 乐观更新：立即反映教师审核
        set((state) => {
            const nextResults = state.results.map((result) => (
                result.fileId === req.fileId ? applyReviewToResult(result, req) : result
            ))
            return {
                reviewPendingByFileId: {
                    ...state.reviewPendingByFileId,
                    [req.fileId]: reviewOperationId,
                },
                results: nextResults,
                summary: computeGradingSummary(nextResults),
            }
        })

        try {
            const response = await api.grading.review(req)
            if (operationGeneration !== gradingOperationGeneration
                || get().reviewPendingByFileId[req.fileId] !== reviewOperationId) return false
            const expectedAction = req.action ?? 'confirm'
            if (response.status !== 'ok'
                || response.success !== true
                || response.batchStatus === undefined
                || !BATCH_STATUSES.has(response.batchStatus)
                || !isGradingResultSnapshot(response.result, req.fileId, originalResult.questionId)
                || response.result.reviewed !== true
                || response.result.reviewAction !== expectedAction
                || response.result.needsHumanReview !== false
                || !isGradingSummary(response.summary, currentState.results.length)) {
                throw new Error('审核响应不完整，请重试')
            }
            set((state) => {
                const nextResults = state.results.map((result) => (
                    result.fileId === req.fileId ? response.result : result
                ))
                return {
                    results: nextResults,
                    // 多文件审核可以并行；以逐条权威结果合并后重新计算，避免较早响应
                    // 携带的批次摘要覆盖另一个仍在保存的乐观结果。
                    summary: computeGradingSummary(nextResults),
                }
            })
            // 静默确认，不弹 toast
            // v5.0 Task 4.6：发射业务事件，通知 diagnosis / dashboard 刷新认知归因与统计
            const { classId } = get()
            businessEvents.emit('grading:reviewed', {
                classId: classId || undefined,
                reviewCount: 1,
            })
            return true
        } catch (err) {
            if (operationGeneration !== gradingOperationGeneration
                || get().reviewPendingByFileId[req.fileId] !== reviewOperationId) return false
            // 仅回滚当前条，避免并发审核失败覆盖其他已经成功的结果。
            set((state) => {
                const nextResults = state.results.map((result) => (
                    result.fileId === req.fileId ? originalResult : result
                ))
                return { results: nextResults, summary: computeGradingSummary(nextResults) }
            })
            const message = getDisplayError(err, '审核保存失败')
            toast.error({ title: '审核失败', message })
            return false
        } finally {
            if (operationGeneration === gradingOperationGeneration) {
                set((state) => {
                    if (state.reviewPendingByFileId[req.fileId] !== reviewOperationId) return state
                    const nextPending = { ...state.reviewPendingByFileId }
                    delete nextPending[req.fileId]
                    return { reviewPendingByFileId: nextPending }
                })
            }
        }
    },

    confirmAll: async () => {
        const operationGeneration = gradingOperationGeneration
        const { batchId, results, review, reviewPendingByFileId } = get()
        if (!batchId) return

        const pending = results.filter((r) => !r.reviewed && reviewPendingByFileId[r.fileId] === undefined)
        if (pending.length === 0) {
            toast.info({
                title: Object.keys(reviewPendingByFileId).length > 0 ? '审核正在保存' : '已全部审核',
            })
            return
        }

        // 并行审核（乐观更新已在 review 中处理）
        const outcomes = await Promise.all(
            pending.map((r) =>
                review({
                    fileId: r.fileId,
                    batchId,
                    action: 'confirm',
                }),
            ),
        )

        if (operationGeneration !== gradingOperationGeneration || get().batchId !== batchId) return
        const confirmedCount = outcomes.filter(Boolean).length

        if (confirmedCount === pending.length) {
            toast.success({
                title: '批量确认完成',
                message: `已确认 ${confirmedCount} 条`,
            })
        } else {
            toast.warning({
                title: '部分审核未保存',
                message: `已确认 ${confirmedCount} 条，${pending.length - confirmedCount} 条请重试`,
            })
        }
    },

    setExpanded: (fileId) => {
        const { expandedFileId } = get()
        set({ expandedFileId: expandedFileId === fileId ? null : fileId })
    },

    setReviewing: (fileId) => {
        set({ reviewingFileId: fileId })
    },

    updateRecognized: (fileId, patch) => {
        const { recognized } = get()
        set({
            recognized: recognized.map((r) =>
                r.fileId === fileId ? { ...r, ...patch } : r,
            ),
        })
    },

    reset: () => {
        gradingOperationGeneration += 1
        set((state) => ({
            batchId: null,
            // 保留教师已选班级/诗篇/题目；清空的是批次，而不是上下文选择。
            stage: 'idle',
            files: [],
            recognized: [],
            results: [],
            summary: EMPTY_SUMMARY,
            expandedFileId: null,
            reviewingFileId: null,
            loading: false,
            error: null,
            resetEpoch: state.resetEpoch + 1,
            reviewPendingByFileId: {},
            multiDimScores: {},
            ocrResults: {},
            errorAttributions: {},
            scoringMultiDim: false,
            ocrLoading: false,
            attributing: false,
        }))
    },

    refreshBatch: async () => {
        const operationGeneration = gradingOperationGeneration
        const { batchId } = get()
        if (!batchId) return

        try {
            const batch = parseGradingBatch(await api.grading.getBatch(batchId), batchId)
            if (operationGeneration !== gradingOperationGeneration || get().batchId !== batchId) return
            set({
                files: batch.files,
                recognized: batch.recognized,
                results: batch.results,
                summary: batch.summary,
                stage: batch.results.length > 0
                    ? 'reviewing'
                    : batch.recognized.length > 0
                        ? 'recognized'
                        : batch.files.length > 0
                            ? 'uploaded'
                            : 'idle',
            })
        } catch {
            // 静默失败，保留旧数据
        }
    },

    loadBatch: async (batchId) => {
        gradingOperationGeneration += 1
        const operationGeneration = gradingOperationGeneration
        set({
            loading: true,
            error: null,
            // 切换批次即撤销旧批次的派生任务 UI；晚到响应还会被 generation 拦截。
            scoringMultiDim: false,
            ocrLoading: false,
            attributing: false,
            expandedFileId: null,
            reviewingFileId: null,
            reviewPendingByFileId: {},
        })
        try {
            const batch = parseGradingBatch(await api.grading.getBatch(batchId), batchId)
            if (operationGeneration !== gradingOperationGeneration) return false
            set((state) => ({
                batchId: batch.batchId,
                classId: batch.classId,
                lessonId: batch.lessonId,
                questionId: batch.questionId,
                files: batch.files,
                recognized: batch.recognized,
                results: batch.results,
                summary: batch.summary,
                multiDimScores: {},
                ocrResults: {},
                errorAttributions: {},
                reviewPendingByFileId: {},
                resetEpoch: state.resetEpoch + 1,
                stage: batch.results.length > 0 ? 'reviewing'
                    : batch.recognized.length > 0 ? 'recognized'
                        : batch.files.length > 0 ? 'uploaded'
                            : 'idle',
                loading: false,
            }))
            return true
        } catch (err) {
            if (operationGeneration !== gradingOperationGeneration) return false
            const message = getDisplayError(err, '历史批次加载失败')
            set({ loading: false, error: message })
            toast.error({ title: '加载失败', message })
            return false
        }
    },

    // ── 批改诊断深化能力动作实现 ──

    scoreMultiDim: async (fileId, questionId, studentAnswer, weights) => {
        const operationGeneration = gradingOperationGeneration
        if (isDemoMode()) {
            toast.warning({
                title: '演示模式不可用',
                message: '多维度评分功能请在完整环境中使用',
            })
            return
        }
        set({ scoringMultiDim: true, error: null })
        try {
            const output = await api.grading.scoreMultiDim({
                fileId,
                questionId,
                studentAnswer,
                weights: weights as Partial<Record<'accuracy' | 'completeness' | 'comprehension' | 'expression' | 'creativity' | 'cultural', number>> | undefined,
            })
            if (operationGeneration !== gradingOperationGeneration) return
            set((s) => ({
                multiDimScores: { ...s.multiDimScores, [fileId]: output },
                scoringMultiDim: false,
            }))
            businessEvents.emit('grading:scored', {
                fileId,
                questionId,
                weightedTotal: output.weightedTotal,
            })
            toast.success({
                title: '多维度评分完成',
                message: `加权总分 ${output.weightedTotal} 分`,
            })
        } catch (err) {
            if (operationGeneration !== gradingOperationGeneration) return
            const message = getDisplayError(err, '多维度评分失败')
            set({ scoringMultiDim: false, error: message })
            toast.error({ title: '多维度评分失败', message })
        }
    },

    runOcr: async (fileId, imageUrl, context) => {
        const operationGeneration = gradingOperationGeneration
        if (isDemoMode()) {
            toast.warning({
                title: '演示模式不可用',
                message: '手写识别功能请在完整环境中使用',
            })
            return
        }
        set({ ocrLoading: true, error: null })
        try {
            const output = await api.grading.ocr({
                imageUrl,
                context,
            })
            if (operationGeneration !== gradingOperationGeneration) return
            set((s) => ({
                ocrResults: { ...s.ocrResults, [fileId]: output },
                ocrLoading: false,
            }))
            businessEvents.emit('grading:ocr-completed', {
                fileId,
                confidence: output.confidence,
                suspiciousCount: output.suspiciousCount,
            })
            if (output.needsManualCheck) {
                toast.warning({
                    title: '识别完成，需人工核对',
                    message: `置信度 ${(output.confidence * 100).toFixed(0)}%，可疑字 ${output.suspiciousCount} 个`,
                })
            } else {
                toast.success({
                    title: '识别完成',
                    message: `置信度 ${(output.confidence * 100).toFixed(0)}%`,
                })
            }
        } catch (err) {
            if (operationGeneration !== gradingOperationGeneration) return
            const message = getDisplayError(err, '手写识别失败')
            set({ ocrLoading: false, error: message })
            toast.error({ title: '手写识别失败', message })
        }
    },

    attributeError: async (fileId, questionId, studentAnswer) => {
        const operationGeneration = gradingOperationGeneration
        if (isDemoMode()) {
            toast.warning({
                title: '演示模式不可用',
                message: '错题归因功能请在完整环境中使用',
            })
            return
        }
        set({ attributing: true, error: null })
        try {
            const output = await api.grading.attribute({
                fileId,
                questionId,
                studentAnswer,
            })
            if (operationGeneration !== gradingOperationGeneration) return
            set((s) => ({
                errorAttributions: { ...s.errorAttributions, [fileId]: output },
                attributing: false,
            }))
            toast.success({
                title: '错题归因完成',
                message: `主导错误：${output.primaryErrorLabel}`,
            })
        } catch (err) {
            if (operationGeneration !== gradingOperationGeneration) return
            const message = getDisplayError(err, '错题归因失败')
            set({ attributing: false, error: message })
            toast.error({ title: '错题归因失败', message })
        }
    },
}))

/**
 * 计算认知归因 Top N（用于 GradingStats 展示）
 */
export function computeAttributionStats(
    results: GradingResult[],
    topN = 3,
): CognitiveAttributionStat[] {
    const counter = new Map<string, number>()
    for (const r of results) {
        // 教师修正优先，否则用 AI 归因
        const label = r.teacherAttribution || r.cognitiveAttribution
        if (!label) continue
        // 截取首句（取第一个逗号或句号前内容作为标签）
        const firstClause = label.split(/[，。；,;]/)[0]?.trim() ?? label
        counter.set(firstClause, (counter.get(firstClause) ?? 0) + 1)
    }
    return Array.from(counter.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, topN)
}
