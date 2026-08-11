import { beforeEach, describe, expect, it, vi } from 'vitest'

const gradingApi = vi.hoisted(() => ({
    upload: vi.fn(),
    recognize: vi.fn(),
    grade: vi.fn(),
    review: vi.fn(),
    getBatch: vi.fn(),
    scoreMultiDim: vi.fn(),
    ocr: vi.fn(),
    attribute: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: { grading: gradingApi } }))
vi.mock('@/lib/demo-mode', () => ({ isDemoMode: () => false }))
vi.mock('@/stores/toast', () => ({
    toast: {
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
    },
}))
vi.mock('@/stores/notifications', () => ({
    useNotificationStore: { getState: () => ({ push: vi.fn() }) },
}))
vi.mock('@/lib/business-events', () => ({ businessEvents: { emit: vi.fn() } }))

import { useGradingStore } from './grading'

const sampleFile = { name: 'answer.png', type: 'image/png', size: 128 } as File

function makeBatchResponse(overrides: Record<string, unknown> = {}) {
    return {
        status: 'ok',
        batchId: 'batch-a',
        classId: 'class-a',
        lessonId: 'lesson-a',
        questionId: 'question-a',
        batchStatus: 'uploading',
        progress: { total: 1, done: 0 },
        files: [{ id: 'file-a', url: '/api/grading/files/file-a' }],
        recognized: [],
        results: [],
        summary: { total: 0, correct: 0, partial: 0, wrong: 0, needsReview: 0, avgConfidence: 0 },
        ...overrides,
    }
}

function prepareUploadContext() {
    useGradingStore.getState().reset()
    useGradingStore.getState().setClassId('class-a')
    useGradingStore.getState().setContext('lesson-a', 'question-a')
}

describe('grading upload transaction boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        prepareUploadContext()
    })

    it('only reports success after a complete one-to-one upload response', async () => {
        gradingApi.upload.mockResolvedValue({
            batchId: 'batch-a',
            uploadedFiles: [{ id: 'file-a', url: '/api/grading/files/file-a' }],
            pendingRecognition: 1,
        })

        await expect(useGradingStore.getState().uploadFiles([sampleFile])).resolves.toBe(true)
        expect(useGradingStore.getState()).toMatchObject({
            batchId: 'batch-a',
            stage: 'uploaded',
            loading: false,
        })
        expect(useGradingStore.getState().files).toHaveLength(1)
    })

    it('keeps an established batch immutable until reset', async () => {
        gradingApi.upload.mockResolvedValue({
            batchId: 'batch-a',
            uploadedFiles: [{ id: 'file-a', url: '/api/grading/files/file-a' }],
            pendingRecognition: 1,
        })

        await expect(useGradingStore.getState().uploadFiles([sampleFile])).resolves.toBe(true)
        await expect(useGradingStore.getState().uploadFiles([sampleFile])).resolves.toBe(false)
        expect(gradingApi.upload).toHaveBeenCalledTimes(1)
        expect(useGradingStore.getState()).toMatchObject({
            batchId: 'batch-a',
            stage: 'uploaded',
        })
        expect(useGradingStore.getState().files).toHaveLength(1)
    })

    it('returns false and never enters uploaded for a network failure', async () => {
        gradingApi.upload.mockRejectedValue(new Error('network failed'))

        await expect(useGradingStore.getState().uploadFiles([sampleFile])).resolves.toBe(false)
        expect(useGradingStore.getState().stage).toBe('idle')
        expect(useGradingStore.getState().batchId).toBeNull()
        expect(useGradingStore.getState().files).toHaveLength(0)
    })

    it('fails closed when the server omits an uploaded file', async () => {
        gradingApi.upload.mockResolvedValue({
            batchId: 'batch-a',
            uploadedFiles: [],
            pendingRecognition: 0,
        })

        await expect(useGradingStore.getState().uploadFiles([sampleFile])).resolves.toBe(false)
        expect(useGradingStore.getState().stage).toBe('idle')
        expect(useGradingStore.getState().files).toHaveLength(0)
    })

    it('rejects a late recognition response after reset', async () => {
        gradingApi.upload.mockResolvedValue({
            batchId: 'batch-a',
            uploadedFiles: [{ id: 'file-a', url: '/api/grading/files/file-a' }],
            pendingRecognition: 1,
        })
        await useGradingStore.getState().uploadFiles([sampleFile])

        let releaseRecognition!: (value: unknown) => void
        gradingApi.recognize.mockImplementation(() => new Promise((resolve) => {
            releaseRecognition = resolve
        }))
        const recognition = useGradingStore.getState().recognize()
        expect(useGradingStore.getState().stage).toBe('recognizing')

        const resetEpoch = useGradingStore.getState().resetEpoch
        useGradingStore.getState().reset()
        releaseRecognition({
            recognized: [{
                fileId: 'file-a',
                studentId: 'student-a',
                questionId: 'question-a',
                studentAnswer: 'late answer',
                confidence: 1,
                needsManualMatch: false,
            }],
        })
        await recognition

        expect(useGradingStore.getState()).toMatchObject({
            batchId: null,
            stage: 'idle',
            loading: false,
            resetEpoch: resetEpoch + 1,
        })
        expect(useGradingStore.getState().recognized).toHaveLength(0)
    })

    it('does not mark recognition complete when the server omits a file result', async () => {
        gradingApi.upload.mockResolvedValue({
            batchId: 'batch-a',
            uploadedFiles: [{ id: 'file-a', url: '/api/grading/files/file-a' }],
            pendingRecognition: 1,
        })
        await useGradingStore.getState().uploadFiles([sampleFile])
        gradingApi.recognize.mockResolvedValue({ recognized: [] })

        await useGradingStore.getState().recognize()
        expect(useGradingStore.getState()).toMatchObject({
            batchId: 'batch-a',
            stage: 'uploaded',
            loading: false,
        })
        expect(useGradingStore.getState().recognized).toEqual([])
    })

    it('does not mark grading complete when results or summary are incomplete', async () => {
        useGradingStore.setState({
            batchId: 'batch-a',
            stage: 'recognized',
            files: [{ id: 'file-a', url: '/api/grading/files/file-a' }],
            recognized: [{
                fileId: 'file-a',
                questionId: 'question-a',
                studentAnswer: '春眠不觉晓',
                confidence: 0.98,
                needsManualMatch: false,
            }],
        })
        gradingApi.grade.mockResolvedValue({
            results: [],
            summary: { total: 0, correct: 0, partial: 0, wrong: 0, needsReview: 0, avgConfidence: 0 },
        })

        await useGradingStore.getState().grade()
        expect(useGradingStore.getState()).toMatchObject({
            batchId: 'batch-a',
            stage: 'recognized',
            loading: false,
            results: [],
        })
    })

    it('rejects an incomplete history snapshot without installing a fake empty batch', async () => {
        const resetEpoch = useGradingStore.getState().resetEpoch
        gradingApi.getBatch.mockResolvedValue({
            batchId: 'batch-history',
            files: undefined,
            recognized: null,
            results: undefined,
            summary: undefined,
        })

        await expect(useGradingStore.getState().loadBatch('batch-history')).resolves.toBe(false)
        expect(useGradingStore.getState()).toMatchObject({
            batchId: null,
            stage: 'idle',
            loading: false,
            resetEpoch,
            files: [],
            recognized: [],
            results: [],
        })
    })

    it('installs the authoritative class, lesson and question context from a valid history snapshot', async () => {
        const resetEpoch = useGradingStore.getState().resetEpoch
        gradingApi.getBatch.mockResolvedValue(makeBatchResponse({
            batchId: 'batch-history',
            classId: 'class-history',
            lessonId: 'lesson-history',
            questionId: 'question-history',
        }))

        await expect(useGradingStore.getState().loadBatch('batch-history')).resolves.toBe(true)
        expect(useGradingStore.getState()).toMatchObject({
            batchId: 'batch-history',
            classId: 'class-history',
            lessonId: 'lesson-history',
            questionId: 'question-history',
            stage: 'uploaded',
            resetEpoch: resetEpoch + 1,
        })
    })

    it('preserves the recognized stage when refreshing a batch before grading', async () => {
        gradingApi.upload.mockResolvedValue({
            batchId: 'batch-a',
            uploadedFiles: [{ id: 'file-a', url: '/api/grading/files/file-a' }],
            pendingRecognition: 1,
        })
        await useGradingStore.getState().uploadFiles([sampleFile])
        gradingApi.getBatch.mockResolvedValue(makeBatchResponse({
            batchStatus: 'reviewing',
            recognized: [{
                fileId: 'file-a',
                questionId: 'question-a',
                studentAnswer: '春眠不觉晓',
                confidence: 0.98,
                needsManualMatch: false,
            }],
        }))

        await useGradingStore.getState().refreshBatch()
        expect(useGradingStore.getState()).toMatchObject({
            batchId: 'batch-a',
            stage: 'recognized',
            loading: false,
        })
        expect(useGradingStore.getState().recognized).toHaveLength(1)
    })

    it('keeps the current batch and reset epoch when a history load fails', async () => {
        gradingApi.upload.mockResolvedValue({
            batchId: 'batch-a',
            uploadedFiles: [{ id: 'file-a', url: '/api/grading/files/file-a' }],
            pendingRecognition: 1,
        })
        await useGradingStore.getState().uploadFiles([sampleFile])
        const resetEpoch = useGradingStore.getState().resetEpoch
        gradingApi.getBatch.mockRejectedValue(new Error('history unavailable'))

        await expect(useGradingStore.getState().loadBatch('batch-b')).resolves.toBe(false)
        expect(useGradingStore.getState()).toMatchObject({
            batchId: 'batch-a',
            stage: 'uploaded',
            resetEpoch,
            loading: false,
        })
        expect(useGradingStore.getState().files).toHaveLength(1)
    })

    it('serializes reviews for the same file and releases the lock after failure', async () => {
        useGradingStore.setState({
            batchId: 'batch-a',
            stage: 'reviewing',
            results: [{
                fileId: 'file-a',
                questionId: 'question-a',
                correct: false,
                cognitiveAttribution: '原始归因',
                feedback: '原始反馈',
                teacherHint: '原始提示',
                confidence: 0.5,
                needsHumanReview: true,
                aiGenerated: true,
            }],
        })
        let rejectReview!: (reason: unknown) => void
        gradingApi.review.mockImplementation(() => new Promise((_resolve, reject) => {
            rejectReview = reject
        }))

        const first = useGradingStore.getState().review({
            batchId: 'batch-a',
            fileId: 'file-a',
            action: 'confirm',
        })
        await expect(useGradingStore.getState().review({
            batchId: 'batch-a',
            fileId: 'file-a',
            action: 'reference',
        })).resolves.toBe(false)
        expect(gradingApi.review).toHaveBeenCalledTimes(1)
        expect(useGradingStore.getState().reviewPendingByFileId['file-a']).toEqual(expect.any(Number))

        rejectReview(new Error('save failed'))
        await expect(first).resolves.toBe(false)
        expect(useGradingStore.getState().reviewPendingByFileId).toEqual({})
        const restored = useGradingStore.getState().results[0]
        expect(restored).toMatchObject({ feedback: '原始反馈' })
        expect(restored?.reviewed).toBeUndefined()
        expect(restored?.reviewAction).toBeUndefined()
    })

    it('rejects a stale review that does not belong to the open batch', async () => {
        useGradingStore.setState({
            batchId: 'batch-current',
            stage: 'reviewing',
            results: [{
                fileId: 'file-current',
                questionId: 'question-a',
                correct: true,
                cognitiveAttribution: '理解',
                feedback: '当前批次',
                teacherHint: '保持',
                confidence: 0.9,
                needsHumanReview: false,
                aiGenerated: true,
            }],
        })

        await expect(useGradingStore.getState().review({
            batchId: 'batch-stale',
            fileId: 'file-current',
            action: 'confirm',
        })).resolves.toBe(false)
        await expect(useGradingStore.getState().review({
            batchId: 'batch-current',
            fileId: 'file-missing',
            action: 'confirm',
        })).resolves.toBe(false)
        expect(gradingApi.review).not.toHaveBeenCalled()
        expect(useGradingStore.getState().reviewPendingByFileId).toEqual({})
    })

    it('calibrates the optimistic review with the authoritative result and recomputed summary', async () => {
        const original = {
            fileId: 'file-a',
            questionId: 'question-a',
            correct: false,
            cognitiveAttribution: '原始归因',
            feedback: '原始反馈',
            teacherHint: '原始提示',
            confidence: 0.5,
            needsHumanReview: true,
            aiGenerated: true as const,
        }
        const authoritative = {
            ...original,
            correct: true,
            cognitiveAttribution: '教师归因',
            feedback: '教师反馈',
            teacherFeedback: '教师反馈',
            teacherAttribution: '教师归因',
            confidence: 1,
            needsHumanReview: false,
            reviewed: true,
            reviewAction: 'modify' as const,
        }
        useGradingStore.setState({
            batchId: 'batch-a',
            stage: 'reviewing',
            results: [original],
            summary: { total: 1, correct: 0, partial: 0, wrong: 1, needsReview: 1, avgConfidence: 0.5 },
        })
        gradingApi.review.mockResolvedValue({
            status: 'ok',
            success: true,
            batchStatus: 'completed',
            result: authoritative,
            summary: { total: 1, correct: 1, partial: 0, wrong: 0, needsReview: 0, avgConfidence: 1 },
        })

        await expect(useGradingStore.getState().review({
            batchId: 'batch-a',
            fileId: 'file-a',
            action: 'modify',
            correct: true,
            feedback: '教师反馈',
            cognitiveAttribution: '教师归因',
        })).resolves.toBe(true)
        expect(useGradingStore.getState().results[0]).toEqual(authoritative)
        expect(useGradingStore.getState().summary).toEqual({
            total: 1,
            correct: 1,
            partial: 0,
            wrong: 0,
            needsReview: 0,
            avgConfidence: 1,
        })
        expect(useGradingStore.getState().reviewPendingByFileId).toEqual({})
    })
})
