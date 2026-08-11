import Fastify, { type FastifyRequest } from 'fastify'
import multipart from '@fastify/multipart'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    batches: new Map<string, Record<string, unknown>>(),
    findClassById: vi.fn(),
    findLessonById: vi.fn(),
    findStudentById: vi.fn(),
    findStudentsByClassId: vi.fn(() => []),
    findQuestionById: vi.fn(),
    findQuestionsByPoemId: vi.fn((_poemId: string): ReturnType<typeof createQuestion>[] => []),
    eyeInvoke: vi.fn(),
    brushInvoke: vi.fn(),
    answerCreate: vi.fn(),
    mapSet: vi.fn(),
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async () => Buffer.alloc(0)),
    realpath: vi.fn(async (value: string) => value),
    rmdir: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    existsSync: vi.fn(() => true),
    batchScore: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
    mkdir: mocks.mkdir,
    readFile: mocks.readFile,
    realpath: mocks.realpath,
    rmdir: mocks.rmdir,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
}))
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }))

vi.mock('../db/index.js', () => ({
    db: {
        prepare: vi.fn(),
        transaction: vi.fn((fn: () => unknown) => fn),
    },
    repos: {
        classes: { findById: mocks.findClassById },
        lessons: { findById: mocks.findLessonById },
        students: {
            findById: mocks.findStudentById,
            findByClassId: mocks.findStudentsByClassId,
        },
        questions: {
            findById: mocks.findQuestionById,
            findByPoemId: mocks.findQuestionsByPoemId,
        },
        answers: { create: mocks.answerCreate },
        mastery: {
            upsertScore: vi.fn(),
            findByStudentId: vi.fn(() => []),
            findByStudentPoemBloom: vi.fn(),
            update: vi.fn(),
        },
    },
}))

vi.mock('../db/runtime-store.js', () => ({
    SqliteMap: class {
        get size() {
            return mocks.batches.size
        }

        get(key: string) {
            return mocks.batches.get(key)
        }

        set(key: string, value: Record<string, unknown>) {
            mocks.batches.set(key, value)
            mocks.mapSet(key, value)
            return this
        }

        delete(key: string) {
            return mocks.batches.delete(key)
        }

        values() {
            return mocks.batches.values()
        }
    },
}))

vi.mock('../agents/index.js', () => ({
    eyeAgent: { visionAnnotate: { invoke: mocks.eyeInvoke } },
    brushAgent: { grade: { invoke: mocks.brushInvoke } },
}))

vi.mock('../agents/base/events.js', () => ({ agentEvents: { emit: vi.fn() } }))
vi.mock('../agents/base/proactive-intelligence.js', () => ({
    proactiveIntelligence: { checkMasteryDarkMatter: vi.fn() },
}))
vi.mock('./error-notebook.js', () => ({ syncErrorsFromAnswers: vi.fn() }))
vi.mock('../services/grading/multi-dimension-scorer.js', () => ({
    multiDimensionScorer: { score: vi.fn(), batchScore: mocks.batchScore },
}))
vi.mock('../services/grading/handwriting-ocr.js', () => ({
    handwritingOcr: { recognize: vi.fn(), batchRecognize: vi.fn() },
}))
vi.mock('../services/grading/error-attribution.js', () => ({
    errorAttribution: { attribute: vi.fn() },
}))

import { gradingRoutes } from './grading.js'

function createBatch(classId = 'class-a') {
    return {
        batchId: 'batch-a',
        classId,
        lessonId: 'lesson-a',
        questionId: 'question-a',
        status: 'uploading',
        files: [{
            id: 'file-a',
            url: '/api/grading/files/file-a',
            filePath: 'C:\\controlled\\file-a.png',
            fileName: 'answer.png',
            contentType: 'image/png',
            size: 8,
        }],
        recognized: [],
        results: [],
        createdAt: 1,
        updatedAt: 1,
    }
}

function createQuestion(id = 'question-a', createdBy: string | null = 'teacher-a') {
    return {
        id,
        poemId: 'poem-a',
        bloomLevel: '理解',
        type: 'short-answer',
        stem: '题干',
        options: null,
        answer: '答案',
        analysis: null,
        distractorsAnalysis: null,
        difficulty: 0.5,
        estimatedTimeSec: 60,
        aiGenerated: false,
        promptVersion: null,
        createdAt: 1,
        createdBy,
        metadata: null,
    }
}

type MultipartTestPart =
    | { type: 'field'; name: string; value: string }
    | { type: 'file'; name?: string; filename?: string; contentType?: string; data: Buffer }

function buildMultipart(parts: MultipartTestPart[], closeBoundary = true): {
    payload: Buffer
    contentType: string
} {
    const boundary = `----grading-boundary-${Math.random().toString(16).slice(2)}`
    const chunks: Buffer[] = []
    for (const part of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'))
        if (part.type === 'field') {
            chunks.push(Buffer.from(
                `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
                'utf8',
            ))
        } else {
            chunks.push(Buffer.from(
                `Content-Disposition: form-data; name="${part.name ?? 'files'}"; filename="${part.filename ?? 'answer.png'}"\r\n`
                + `Content-Type: ${part.contentType ?? 'image/png'}\r\n\r\n`,
                'utf8',
            ))
            chunks.push(part.data, Buffer.from('\r\n', 'utf8'))
        }
    }
    if (closeBoundary) chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
    return {
        payload: Buffer.concat(chunks),
        contentType: `multipart/form-data; boundary=${boundary}`,
    }
}

async function makePng(): Promise<Buffer> {
    return sharp({
        create: { width: 4, height: 4, channels: 3, background: '#ffffff' },
    }).png().toBuffer()
}

describe('grading route aggregate boundary', () => {
    let app: Awaited<ReturnType<typeof Fastify>> | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.batchScore.mockReset()
        mocks.batches.clear()
        mocks.findClassById.mockImplementation((id: string) => id === 'class-a'
            ? { id, teacherId: 'teacher-a' }
            : id === 'class-b'
                ? { id, teacherId: 'teacher-b' }
                : null)
        mocks.findStudentById.mockImplementation((id: string) => id === 'student-a'
            ? { id, classId: 'class-a' }
            : id === 'student-b'
                ? { id, classId: 'class-b' }
                : null)
        mocks.findLessonById.mockImplementation((id: string) => id === 'lesson-a'
            ? { id, classId: 'class-a', teacherId: 'teacher-a' }
            : null)
        mocks.findQuestionById.mockImplementation((id: string) => id === 'question-a'
            ? createQuestion()
            : null)
    })

    afterEach(async () => {
        if (app) await app.close()
        app = undefined
    })

    async function createApp() {
        app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 })
        await app.register(multipart)
        app.addHook('onRequest', async (request: FastifyRequest) => {
            request.auth = {
                id: 'teacher-a',
                name: '测试教师',
                role: 'teacher',
                issuedAt: 1,
                expiresAt: Number.MAX_SAFE_INTEGER,
                csrfToken: 'test-csrf-token',
                sessionId: 'test-session',
            }
        })
        await app.register(gradingRoutes, { prefix: '/api/grading' })
        return app
    }

    async function upload(server: Awaited<ReturnType<typeof Fastify>>, parts: MultipartTestPart[]) {
        const body = buildMultipart(parts)
        return server.inject({
            method: 'POST',
            url: '/api/grading/upload',
            headers: { 'content-type': body.contentType },
            payload: body.payload,
        })
    }

    function expectNoUploadPersistence(): void {
        expect(mocks.writeFile).not.toHaveBeenCalled()
        expect(mocks.mapSet).not.toHaveBeenCalled()
        expect(mocks.eyeInvoke).not.toHaveBeenCalled()
        expect(mocks.brushInvoke).not.toHaveBeenCalled()
        expect(mocks.answerCreate).not.toHaveBeenCalled()
        expect(mocks.batches).toHaveLength(0)
    }

    it('accepts the exact 1-file + three-field multipart contract and persists only after validation', async () => {
        const server = await createApp()
        const png = await makePng()
        const response = await upload(server, [
            { type: 'file', data: png },
            { type: 'field', name: 'classId', value: 'class-a' },
            { type: 'field', name: 'lessonId', value: 'lesson-a' },
            { type: 'field', name: 'questionId', value: 'question-a' },
        ])

        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({
            status: 'ok',
            pendingRecognition: 1,
            uploadedFiles: [{ url: expect.stringMatching(/^\/api\/grading\/files\//u) }],
        })
        expect(mocks.writeFile).toHaveBeenCalledTimes(1)
        expect(mocks.mapSet).toHaveBeenCalledTimes(1)
        expect(mocks.batches).toHaveLength(1)
    })

    it('rejects unknown and duplicate fields with stable 400 before any persistence', async () => {
        const server = await createApp()
        const png = await makePng()

        const unknown = await upload(server, [
            { type: 'file', data: png },
            { type: 'field', name: 'classId', value: 'class-a' },
            { type: 'field', name: 'teacherId', value: 'teacher-a' },
        ])
        expect(unknown.statusCode).toBe(400)
        expect(unknown.json()).toMatchObject({ error: 'INVALID_MULTIPART_FORM' })
        expectNoUploadPersistence()

        const duplicate = await upload(server, [
            { type: 'file', data: png },
            { type: 'field', name: 'classId', value: 'class-a' },
            { type: 'field', name: 'classId', value: 'class-b' },
        ])
        expect(duplicate.statusCode).toBe(400)
        expect(duplicate.json()).toMatchObject({ error: 'INVALID_MULTIPART_FORM' })
        expectNoUploadPersistence()

        const wrongFileField = await upload(server, [
            { type: 'file', name: 'file', data: png },
            { type: 'field', name: 'classId', value: 'class-a' },
        ])
        expect(wrongFileField.statusCode).toBe(400)
        expect(wrongFileField.json()).toMatchObject({ error: 'INVALID_MULTIPART_FORM' })
        expectNoUploadPersistence()
    })

    it('retains MIME plus decoded-image verification before disk or batch writes', async () => {
        const server = await createApp()
        const png = await makePng()
        const mismatch = await upload(server, [
            { type: 'file', filename: 'forged.jpg', contentType: 'image/jpeg', data: png },
            { type: 'field', name: 'classId', value: 'class-a' },
        ])
        expect(mismatch.statusCode).toBe(400)
        expect(mismatch.json()).toMatchObject({ error: 'INVALID_IMAGE' })
        expectNoUploadPersistence()

        const invalidBytes = await upload(server, [
            { type: 'file', data: Buffer.from('<script>not-an-image</script>') },
            { type: 'field', name: 'classId', value: 'class-a' },
        ])
        expect(invalidBytes.statusCode).toBe(400)
        expect(invalidBytes.json()).toMatchObject({ error: 'INVALID_IMAGE' })
        expectNoUploadPersistence()
    })

    it('maps the real files limit to stable 413 and never persists a partial batch', async () => {
        const server = await createApp()
        const png = await makePng()
        const response = await upload(server, Array.from({ length: 31 }, (_, index) => ({
            type: 'file' as const,
            filename: `answer-${index}.png`,
            data: png,
        })))

        expect(response.statusCode).toBe(413)
        expect(response.json()).toMatchObject({ error: 'UPLOAD_LIMIT_EXCEEDED' })
        expectNoUploadPersistence()
    })

    it('maps field count/value limits to stable 413 without exposing parser details', async () => {
        const server = await createApp()
        const tooManyFields = await upload(server, [
            { type: 'field', name: 'classId', value: 'class-a' },
            { type: 'field', name: 'lessonId', value: 'lesson-a' },
            { type: 'field', name: 'questionId', value: 'question-a' },
            { type: 'field', name: 'extra', value: 'fourth' },
        ])
        expect(tooManyFields.statusCode).toBe(413)
        expect(tooManyFields.json()).toMatchObject({ error: 'UPLOAD_LIMIT_EXCEEDED' })
        expect(tooManyFields.body).not.toContain('FST_FIELDS_LIMIT')
        expectNoUploadPersistence()

        const oversizedField = await upload(server, [
            { type: 'field', name: 'classId', value: 'x'.repeat(257) },
        ])
        expect(oversizedField.statusCode).toBe(413)
        expect(oversizedField.json()).toMatchObject({ error: 'UPLOAD_LIMIT_EXCEEDED' })
        expectNoUploadPersistence()
    })

    it('enforces the aggregate 33-part ceiling with a real multipart parser', async () => {
        const server = await createApp()
        const png = await makePng()
        const parts: MultipartTestPart[] = [
            ...Array.from({ length: 30 }, (_, index) => ({
                type: 'file' as const,
                filename: `answer-${index}.png`,
                data: png,
            })),
            { type: 'field', name: 'classId', value: 'class-a' },
            { type: 'field', name: 'lessonId', value: 'lesson-a' },
            { type: 'field', name: 'questionId', value: 'question-a' },
            { type: 'file', filename: 'part-34.png', data: png },
        ]
        const response = await upload(server, parts)

        expect(response.statusCode).toBe(413)
        expect(response.json()).toMatchObject({ error: 'UPLOAD_LIMIT_EXCEEDED' })
        expectNoUploadPersistence()
    })

    it('maps an oversized file to 413 and malformed multipart to a non-leaking 400', async () => {
        const server = await createApp()
        const oversized = await upload(server, [
            {
                type: 'file',
                filename: 'oversized.png',
                data: Buffer.alloc(10 * 1024 * 1024 + 1),
            },
            { type: 'field', name: 'classId', value: 'class-a' },
        ])
        expect(oversized.statusCode).toBe(413)
        expect(oversized.json()).toMatchObject({ error: 'UPLOAD_LIMIT_EXCEEDED' })
        expectNoUploadPersistence()

        const malformedBody = buildMultipart([
            { type: 'field', name: 'classId', value: 'class-a' },
        ], false)
        const malformed = await server.inject({
            method: 'POST',
            url: '/api/grading/upload',
            headers: { 'content-type': malformedBody.contentType },
            payload: malformedBody.payload,
        })
        expect(malformed.statusCode).toBe(400)
        expect(malformed.json()).toEqual({
            status: 'error',
            error: 'INVALID_MULTIPART_FORM',
            message: '批改上传表单格式无效',
        })
        expect(malformed.body).not.toContain('Unexpected end')
        expectNoUploadPersistence()
    })

    it('does not expose a foreign class student list or history', async () => {
        const server = await createApp()
        for (const url of [
            '/api/grading/students?classId=class-b',
            '/api/grading/history?classId=class-b',
        ]) {
            const response = await server.inject({ method: 'GET', url })
            expect(response.statusCode).toBe(404)
            expect(response.json()).toMatchObject({ status: 'error', error: 'CLASS_NOT_FOUND' })
        }
        expect(mocks.findStudentsByClassId).not.toHaveBeenCalled()
    })

    it('returns authoritative poem and question context for owned history and batch detail', async () => {
        mocks.batches.set('batch-a', createBatch())
        const server = await createApp()

        const history = await server.inject({
            method: 'GET',
            url: '/api/grading/history?classId=class-a',
        })
        expect(history.statusCode).toBe(200)
        expect(history.json().batches[0]).toMatchObject({
            batchId: 'batch-a',
            classId: 'class-a',
            lessonId: 'lesson-a',
            questionId: 'question-a',
            poemId: 'poem-a',
            questionStem: '题干',
        })

        const detail = await server.inject({
            method: 'GET',
            url: '/api/grading/batch/batch-a',
        })
        expect(detail.statusCode).toBe(200)
        expect(detail.json()).toMatchObject({
            batchId: 'batch-a',
            classId: 'class-a',
            lessonId: 'lesson-a',
            questionId: 'question-a',
            poemId: 'poem-a',
            questionStem: '题干',
        })
    })

    it('returns the authoritative reviewed result and updated summary after teacher modification', async () => {
        const batch = {
            ...createBatch(),
            status: 'reviewing',
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
        }
        mocks.batches.set('batch-a', batch)
        const server = await createApp()

        const response = await server.inject({
            method: 'POST',
            url: '/api/grading/review',
            payload: {
                batchId: 'batch-a',
                fileId: 'file-a',
                action: 'modify',
                correct: true,
                feedback: '教师反馈',
                cognitiveAttribution: '教师归因',
            },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
            status: 'ok',
            success: true,
            batchStatus: 'completed',
            result: {
                fileId: 'file-a',
                questionId: 'question-a',
                correct: true,
                cognitiveAttribution: '教师归因',
                feedback: '教师反馈',
                teacherHint: '原始提示',
                confidence: 1,
                needsHumanReview: false,
                aiGenerated: true,
                teacherFeedback: '教师反馈',
                teacherAttribution: '教师归因',
                reviewed: true,
                reviewAction: 'modify',
            },
            summary: {
                total: 1,
                correct: 1,
                partial: 0,
                wrong: 0,
                needsReview: 0,
                avgConfidence: 1,
            },
        })
        expect(batch.status).toBe('completed')
        expect(batch.results[0]).toMatchObject({
            correct: true,
            reviewed: true,
            needsHumanReview: false,
            confidence: 1,
        })
    })

    it('never returns raw provider output from a failed batch scoring call', async () => {
        const secret = 'provider-secret-key=do-not-expose raw-model-prefix={"score":'
        mocks.batchScore.mockRejectedValue(new Error(secret))
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/grading/batch-score',
            payload: {
                items: [{ questionId: 'question-a', studentAnswer: '学生作答' }],
            },
        })

        expect(response.statusCode).toBe(500)
        expect(response.json()).toEqual({
            status: 'error',
            error: 'BATCH_SCORING_FAILED',
            message: '批量评分失败，请稍后重试',
        })
        expect(response.body).not.toContain('provider-secret-key')
        expect(response.body).not.toContain('raw-model-prefix')
        expect(mocks.batchScore).toHaveBeenCalledTimes(1)
    })

    it('filters teacher-private questions while keeping shared questions', async () => {
        mocks.findQuestionsByPoemId.mockReturnValue([
            createQuestion('question-a', 'teacher-a'),
            createQuestion('question-b', 'teacher-b'),
            createQuestion('question-shared', null),
        ])
        const server = await createApp()
        const response = await server.inject({
            method: 'GET',
            url: '/api/grading/questions?poemId=poem-a',
        })

        expect(response.statusCode).toBe(200)
        expect(response.json().questions.map((question: { id: string }) => question.id)).toEqual([
            'question-a',
            'question-shared',
        ])
    })

    it('rejects a file from another batch before state mutation or Agent invocation', async () => {
        const batch = createBatch()
        mocks.batches.set('batch-a', batch)
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/grading/grade',
            payload: {
                batchId: 'batch-a',
                items: [{ fileId: 'file-foreign', questionId: 'question-a', studentAnswer: '作答' }],
            },
        })

        expect(response.statusCode).toBe(409)
        expect(response.json()).toMatchObject({ error: 'BATCH_FILE_MISMATCH' })
        expect(batch.status).toBe('uploading')
        expect(mocks.mapSet).not.toHaveBeenCalled()
        expect(mocks.brushInvoke).not.toHaveBeenCalled()
        expect(mocks.answerCreate).not.toHaveBeenCalled()
    })

    it('rejects a student from another class before state mutation or persistence', async () => {
        const batch = createBatch()
        mocks.batches.set('batch-a', batch)
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/grading/grade',
            payload: {
                batchId: 'batch-a',
                items: [{
                    fileId: 'file-a',
                    questionId: 'question-a',
                    studentId: 'student-b',
                    studentAnswer: '作答',
                }],
            },
        })

        expect(response.statusCode).toBe(409)
        expect(response.json()).toMatchObject({ error: 'STUDENT_CLASS_MISMATCH' })
        expect(batch.status).toBe('uploading')
        expect(mocks.brushInvoke).not.toHaveBeenCalled()
        expect(mocks.answerCreate).not.toHaveBeenCalled()
    })

    it.each([
        ['grading', [], 'BATCH_GRADING_IN_PROGRESS'],
        ['reviewing', [{ fileId: 'file-a', questionId: 'question-a' }], 'BATCH_ALREADY_GRADED'],
        ['completed', [], 'BATCH_ALREADY_GRADED'],
    ] as const)('prevents duplicate answer persistence from a %s batch', async (status, results, error) => {
        const batch = { ...createBatch(), status, results }
        mocks.batches.set('batch-a', batch)
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/grading/grade',
            payload: {
                batchId: 'batch-a',
                items: [{ fileId: 'file-a', questionId: 'question-a', studentAnswer: '作答' }],
            },
        })

        expect(response.statusCode).toBe(409)
        expect(response.json()).toMatchObject({ error })
        expect(mocks.brushInvoke).not.toHaveBeenCalled()
        expect(mocks.answerCreate).not.toHaveBeenCalled()
    })

    it('returns the persisted recognition result on retry without paying for a second vision call', async () => {
        const batch = {
            ...createBatch(),
            status: 'reviewing',
            recognized: [{
                fileId: 'file-a',
                questionId: 'question-a',
                studentAnswer: '已识别作答',
                confidence: 0.9,
                needsManualMatch: false,
            }],
        }
        mocks.batches.set('batch-a', batch)
        const server = await createApp()
        const response = await server.inject({
            method: 'POST',
            url: '/api/grading/recognize',
            payload: { batchId: 'batch-a' },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({ replayed: true, recognized: batch.recognized })
        expect(mocks.eyeInvoke).not.toHaveBeenCalled()
        expect(mocks.mapSet).not.toHaveBeenCalled()
    })

    it.each([
        ['GET', '/api/grading/batch/batch-a'],
        ['DELETE', '/api/grading/batch/batch-a'],
        ['GET', '/api/grading/files/file-a'],
    ] as const)('hides foreign batch resources: %s %s', async (method, url) => {
        mocks.batches.set('batch-a', createBatch('class-b'))
        const server = await createApp()
        const response = await server.inject({ method, url })

        expect(response.statusCode).toBe(404)
        expect(response.json()).toMatchObject({ error: 'CLASS_NOT_FOUND' })
    })
})
