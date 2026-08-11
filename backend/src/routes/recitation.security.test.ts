import multipart from '@fastify/multipart'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    asrInvoke: vi.fn(),
    findPoemById: vi.fn(),
    findStudentById: vi.fn(),
    createRecitation: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    unlink: vi.fn(),
    virtualFiles: new Map<string, Buffer>(),
    runtimeStores: new Map<string, Map<unknown, unknown>>(),
    transaction: vi.fn(),
}))

vi.mock('../agents/index.js', () => ({
    eyeAgent: {
        asr: { invoke: mocks.asrInvoke },
        tts: { invoke: vi.fn() },
    },
}))

vi.mock('../db/index.js', () => ({
    db: {
        transaction: mocks.transaction,
        prepare: vi.fn(),
    },
    repos: {
        poems: {
            findById: mocks.findPoemById,
            findAll: vi.fn(() => []),
        },
        students: {
            findById: mocks.findStudentById,
        },
        recitations: {
            create: mocks.createRecitation,
            findById: vi.fn(),
            findByStudentId: vi.fn(() => []),
            delete: vi.fn(),
        },
    },
}))

vi.mock('../db/runtime-store.js', () => ({
    SqliteMap: class<K, V> {
        private readonly store: Map<K, V>

        constructor(options: { table: string }) {
            let store = mocks.runtimeStores.get(options.table) as Map<K, V> | undefined
            if (!store) {
                store = new Map<K, V>()
                mocks.runtimeStores.set(options.table, store as Map<unknown, unknown>)
            }
            this.store = store
        }

        get size(): number {
            return this.store.size
        }

        get(key: K): V | undefined {
            return this.store.get(key)
        }

        has(key: K): boolean {
            return this.store.has(key)
        }

        set(key: K, value: V): this {
            this.store.set(key, value)
            return this
        }

        delete(key: K): boolean {
            return this.store.delete(key)
        }

        entries(): IterableIterator<[K, V]> {
            return this.store.entries()
        }
    },
}))

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
        ...actual,
        writeFile: mocks.writeFile,
        readFile: mocks.readFile,
        unlink: mocks.unlink,
    }
})

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return {
        ...actual,
        existsSync: (filePath: string | Buffer | URL) => (
            mocks.virtualFiles.has(String(filePath)) || actual.existsSync(filePath)
        ),
    }
})

import { recitationRoutes } from './recitation.js'

type MultipartTestPart =
    | { type: 'field'; name: string; value: string }
    | { type: 'file'; name?: string; filename?: string; contentType?: string; data: Buffer }

interface AsrCacheEntryForTest {
    teacherId: string
    studentId: string
    poemId: string
    transcript: string
    audioDurationSec: number
    contentType: string
    audioBuffer?: Buffer
    audioFilePath: string
    audioUrl: string
    createdAt: number
}

const MAX_AUDIO_SIZE = 10 * 1024 * 1024
const DEFAULT_TEACHER_ID = 'teacher-a'

function makeWav(size = 44): Buffer {
    const buffer = Buffer.alloc(size)
    buffer.write('RIFF', 0, 'ascii')
    if (size >= 12) buffer.write('WAVE', 8, 'ascii')
    return buffer
}

function buildMultipart(parts: MultipartTestPart[]): { payload: Buffer; contentType: string } {
    const boundary = `----recitation-security-${Math.random().toString(16).slice(2)}`
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
                `Content-Disposition: form-data; name="${part.name ?? 'file'}"; filename="${part.filename ?? 'recitation.wav'}"\r\n`
                + `Content-Type: ${part.contentType ?? 'audio/wav'}\r\n\r\n`,
                'utf8',
            ))
            chunks.push(part.data, Buffer.from('\r\n', 'utf8'))
        }
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))

    return {
        payload: Buffer.concat(chunks),
        contentType: `multipart/form-data; boundary=${boundary}`,
    }
}

function asrStore(): Map<string, AsrCacheEntryForTest> {
    const store = mocks.runtimeStores.get('recitation_asr_intermediate')
    if (!store) throw new Error('ASR test store was not initialized')
    return store as Map<string, AsrCacheEntryForTest>
}

describe('recitation upload and evaluation security boundary', () => {
    let app: FastifyInstance | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        for (const store of mocks.runtimeStores.values()) store.clear()
        mocks.virtualFiles.clear()

        mocks.transaction.mockImplementation((work: () => unknown) => work)
        mocks.writeFile.mockImplementation(async (filePath: string | Buffer | URL, data: Buffer) => {
            mocks.virtualFiles.set(String(filePath), Buffer.from(data))
        })
        mocks.readFile.mockImplementation(async (filePath: string | Buffer | URL) => {
            const file = mocks.virtualFiles.get(String(filePath))
            if (!file) throw new Error('ENOENT')
            return Buffer.from(file)
        })
        mocks.unlink.mockImplementation(async (filePath: string | Buffer | URL) => {
            if (!mocks.virtualFiles.delete(String(filePath))) throw new Error('ENOENT')
        })
        mocks.findPoemById.mockImplementation((poemId: string) => (
            poemId.startsWith('poem-')
                ? { id: poemId, title: '静夜思', poet: '李白', dynasty: '唐', content: '床前明月光' }
                : null
        ))
        mocks.findStudentById.mockImplementation((studentId: string) => (
            studentId.startsWith('student-') && studentId !== 'student-missing'
                ? { id: studentId, classId: 'class-a', name: studentId }
                : null
        ))
        mocks.asrInvoke.mockResolvedValue({
            output: {
                transcript: '床前明月光',
                audioDurationSec: 2.5,
                pronunciation: 92,
                rhythm: 88,
                emotion: 86,
                mistakes: [],
                suggestion: '节奏自然',
            },
        })
        mocks.createRecitation.mockImplementation((input: Record<string, unknown>) => ({
            id: 'recitation-created',
            ...input,
            createdAt: Date.now(),
        }))
    })

    afterEach(async () => {
        if (app) await app.close()
        app = undefined
    })

    async function createApp(): Promise<FastifyInstance> {
        app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 })
        await app.register(multipart)
        app.addHook('onRequest', async (request) => {
            const header = request.headers['x-test-teacher']
            const teacherId = typeof header === 'string' ? header : DEFAULT_TEACHER_ID
            request.auth = {
                id: teacherId,
                name: '测试教师',
                role: 'teacher',
                issuedAt: 1,
                expiresAt: Number.MAX_SAFE_INTEGER,
                csrfToken: 'csrf-test',
                sessionId: `session-${teacherId}`,
            }
        })
        await app.register(recitationRoutes, { prefix: '/api/recitation' })
        await app.ready()
        return app
    }

    async function transcribe(
        server: FastifyInstance,
        parts: MultipartTestPart[],
        teacherId = DEFAULT_TEACHER_ID,
    ) {
        const body = buildMultipart(parts)
        return server.inject({
            method: 'POST',
            url: '/api/recitation/asr/transcribe',
            headers: {
                'content-type': body.contentType,
                'x-test-teacher': teacherId,
            },
            payload: body.payload,
        })
    }

    async function uploadValid(
        server: FastifyInstance,
        studentId = 'student-a',
        poemId = 'poem-a',
        teacherId = DEFAULT_TEACHER_ID,
    ): Promise<{ audioUrl: string; transcript: string; audioDurationSec: number }> {
        const response = await transcribe(server, [
            { type: 'file', data: makeWav() },
            { type: 'field', name: 'poemId', value: poemId },
            { type: 'field', name: 'studentId', value: studentId },
        ], teacherId)
        expect(response.statusCode).toBe(200)
        return response.json() as { audioUrl: string; transcript: string; audioDurationSec: number }
    }

    function expectNoUploadSideEffects(): void {
        expect(mocks.asrInvoke).not.toHaveBeenCalled()
        expect(mocks.writeFile).not.toHaveBeenCalled()
        expect(mocks.createRecitation).not.toHaveBeenCalled()
        expect(asrStore()).toHaveLength(0)
    }

    it('rejects a second file at the real multipart parser with 413 and no side effects', async () => {
        const server = await createApp()
        const response = await transcribe(server, [
            { type: 'file', data: makeWav() },
            { type: 'file', filename: 'second.wav', data: makeWav() },
        ])

        expect(response.statusCode).toBe(413)
        expect(response.json()).toMatchObject({ error: 'UPLOAD_LIMIT_EXCEEDED' })
        expectNoUploadSideEffects()
    })

    it('rejects an oversized file with 413 before writing or invoking ASR', async () => {
        const server = await createApp()
        const response = await transcribe(server, [
            { type: 'file', data: makeWav(MAX_AUDIO_SIZE + 1) },
            { type: 'field', name: 'poemId', value: 'poem-a' },
        ])

        expect(response.statusCode).toBe(413)
        expect(response.json()).toMatchObject({ error: 'UPLOAD_LIMIT_EXCEEDED' })
        expectNoUploadSideEffects()
    })

    it('fails closed on duplicate fields and does not prune an existing cache entry', async () => {
        const server = await createApp()
        const sentinelUrl = '/api/recitation/audio/recitations/rec_audio_sentinel.wav'
        const sentinel: AsrCacheEntryForTest = {
            teacherId: DEFAULT_TEACHER_ID,
            studentId: 'student-a',
            poemId: 'poem-a',
            transcript: 'sentinel',
            audioDurationSec: 1,
            contentType: 'audio/wav',
            audioFilePath: 'C:\\Users\\LENOVO\\Nutstore\\1\\创AI\\系统\\poetic-realm-v3\\static\\audio\\recitations\\rec_audio_sentinel.wav',
            audioUrl: sentinelUrl,
            createdAt: 0,
        }
        asrStore().set(sentinelUrl, sentinel)

        const response = await transcribe(server, [
            { type: 'file', data: makeWav() },
            { type: 'field', name: 'poemId', value: 'poem-a' },
            { type: 'field', name: 'poemId', value: 'poem-b' },
        ])

        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({ error: 'INVALID_MULTIPART_FORM' })
        expect(mocks.asrInvoke).not.toHaveBeenCalled()
        expect(mocks.writeFile).not.toHaveBeenCalled()
        expect(asrStore().get(sentinelUrl)).toBe(sentinel)
    })

    it('enforces the exact field allowlist and the three-part ceiling', async () => {
        const server = await createApp()
        const unexpected = await transcribe(server, [
            { type: 'file', data: makeWav() },
            { type: 'field', name: 'poemId', value: 'poem-a' },
            { type: 'field', name: 'classId', value: 'class-a' },
        ])
        expect(unexpected.statusCode).toBe(400)
        expect(unexpected.json()).toMatchObject({ error: 'INVALID_MULTIPART_FORM' })
        expectNoUploadSideEffects()

        const tooManyParts = await transcribe(server, [
            { type: 'file', data: makeWav() },
            { type: 'field', name: 'poemId', value: 'poem-a' },
            { type: 'field', name: 'studentId', value: 'student-a' },
            { type: 'field', name: 'extra', value: 'not-allowed' },
        ])
        expect(tooManyParts.statusCode).toBe(413)
        expect(tooManyParts.json()).toMatchObject({ error: 'UPLOAD_LIMIT_EXCEEDED' })
        expectNoUploadSideEffects()
    })

    it('keeps the documented transcript-only flow when studentId is omitted', async () => {
        const server = await createApp()
        const response = await transcribe(server, [
            { type: 'file', data: makeWav() },
            { type: 'field', name: 'poemId', value: 'poem-a' },
        ])

        expect(response.statusCode).toBe(200)
        const uploaded = response.json() as { audioUrl: string }
        expect(asrStore().get(uploaded.audioUrl)).toMatchObject({
            teacherId: DEFAULT_TEACHER_ID,
            studentId: '',
            poemId: 'poem-a',
        })
    })

    it('rejects MIME-spoofed bytes before writing, invoking ASR, or caching', async () => {
        const server = await createApp()
        const response = await transcribe(server, [
            { type: 'file', contentType: 'audio/wav', data: Buffer.from('not a wave file') },
            { type: 'field', name: 'poemId', value: 'poem-a' },
            { type: 'field', name: 'studentId', value: 'student-a' },
        ])

        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({ error: 'INVALID_AUDIO' })
        expectNoUploadSideEffects()
    })

    it('binds the intermediate result and allows exactly one valid evaluation', async () => {
        const server = await createApp()
        const uploaded = await uploadValid(server)
        const cached = asrStore().get(uploaded.audioUrl)

        expect(cached).toMatchObject({
            teacherId: DEFAULT_TEACHER_ID,
            studentId: 'student-a',
            poemId: 'poem-a',
            contentType: 'audio/wav',
            audioUrl: uploaded.audioUrl,
        })
        expect(mocks.writeFile).toHaveBeenCalledTimes(1)
        expect(mocks.asrInvoke).toHaveBeenCalledTimes(1)

        const evaluated = await server.inject({
            method: 'POST',
            url: '/api/recitation/evaluate',
            payload: {
                studentId: 'student-a',
                poemId: 'poem-a',
                audioUrl: uploaded.audioUrl,
                transcript: '调用方不可覆盖的伪造转写',
                audioDurationSec: 999,
            },
        })
        expect(evaluated.statusCode).toBe(200)
        expect(evaluated.json()).toMatchObject({
            status: 'ok',
            recitationId: 'recitation-created',
            transcript: '床前明月光',
            audioDurationSec: 2.5,
        })
        expect(mocks.createRecitation).toHaveBeenCalledWith(expect.objectContaining({
            studentId: 'student-a',
            poemId: 'poem-a',
            transcript: '床前明月光',
            audioDurationSec: 2.5,
        }))
        expect(asrStore().has(uploaded.audioUrl)).toBe(false)

        const replay = await server.inject({
            method: 'POST',
            url: '/api/recitation/evaluate',
            payload: {
                studentId: 'student-a',
                poemId: 'poem-a',
                audioUrl: uploaded.audioUrl,
            },
        })
        expect(replay.statusCode).toBe(410)
        expect(replay.json()).toMatchObject({ error: 'ASR_INTERMEDIATE_UNAVAILABLE' })
        expect(mocks.asrInvoke).toHaveBeenCalledTimes(2)
        expect(mocks.createRecitation).toHaveBeenCalledTimes(1)
    })

    it('restores a persisted intermediate entry without an in-memory Buffer and rechecks its magic bytes', async () => {
        const server = await createApp()
        const uploaded = await uploadValid(server)
        const persisted = asrStore().get(uploaded.audioUrl)
        if (!persisted) throw new Error('Expected an ASR intermediate entry')
        asrStore().set(uploaded.audioUrl, { ...persisted, audioBuffer: undefined })

        const response = await server.inject({
            method: 'POST',
            url: '/api/recitation/evaluate',
            payload: {
                studentId: 'student-a',
                poemId: 'poem-a',
                audioUrl: uploaded.audioUrl,
            },
        })

        expect(response.statusCode).toBe(200)
        expect(mocks.readFile).toHaveBeenCalledWith(persisted.audioFilePath)
        expect(mocks.asrInvoke).toHaveBeenCalledTimes(2)
        expect(asrStore().has(uploaded.audioUrl)).toBe(false)
    })

    it.each([
        ['student', 'student-b', 'poem-a', DEFAULT_TEACHER_ID],
        ['poem', 'student-a', 'poem-b', DEFAULT_TEACHER_ID],
        ['teacher', 'student-a', 'poem-a', 'teacher-b'],
    ])('rejects a cross-%s evaluation without consuming the valid upload', async (_scope, studentId, poemId, teacherId) => {
        const server = await createApp()
        const uploaded = await uploadValid(server)

        const response = await server.inject({
            method: 'POST',
            url: '/api/recitation/evaluate',
            headers: { 'x-test-teacher': teacherId },
            payload: { studentId, poemId, audioUrl: uploaded.audioUrl },
        })

        expect(response.statusCode).toBe(403)
        expect(response.json()).toMatchObject({ error: 'ASR_BINDING_MISMATCH' })
        expect(mocks.asrInvoke).toHaveBeenCalledTimes(1)
        expect(mocks.createRecitation).not.toHaveBeenCalled()
        expect(asrStore().has(uploaded.audioUrl)).toBe(true)
    })

    it('requires the evaluated student to exist before invoking the evaluator', async () => {
        const server = await createApp()
        const uploaded = await uploadValid(server)

        const response = await server.inject({
            method: 'POST',
            url: '/api/recitation/evaluate',
            payload: {
                studentId: 'student-missing',
                poemId: 'poem-a',
                audioUrl: uploaded.audioUrl,
            },
        })

        expect(response.statusCode).toBe(404)
        expect(response.json()).toMatchObject({ error: 'STUDENT_NOT_FOUND' })
        expect(mocks.asrInvoke).toHaveBeenCalledTimes(1)
        expect(mocks.createRecitation).not.toHaveBeenCalled()
        expect(asrStore().has(uploaded.audioUrl)).toBe(true)
    })

    it('retains the one-time intermediate result when persistence fails, then consumes it on retry', async () => {
        const server = await createApp()
        const uploaded = await uploadValid(server)
        mocks.createRecitation.mockImplementationOnce(() => {
            throw new Error('database unavailable')
        })

        const payload = {
            studentId: 'student-a',
            poemId: 'poem-a',
            audioUrl: uploaded.audioUrl,
        }
        const failed = await server.inject({
            method: 'POST',
            url: '/api/recitation/evaluate',
            payload,
        })
        expect(failed.statusCode).toBe(503)
        expect(failed.json()).toMatchObject({ error: 'RECITATION_PERSISTENCE_FAILED', retryable: true })
        expect(asrStore().has(uploaded.audioUrl)).toBe(true)

        const retried = await server.inject({
            method: 'POST',
            url: '/api/recitation/evaluate',
            payload,
        })
        expect(retried.statusCode).toBe(200)
        expect(asrStore().has(uploaded.audioUrl)).toBe(false)
    })

    it('removes the just-written private audio when ASR fails and never creates an intermediate entry', async () => {
        const server = await createApp()
        mocks.asrInvoke.mockRejectedValueOnce(new Error('ASR unavailable'))

        const response = await transcribe(server, [
            { type: 'file', data: makeWav() },
            { type: 'field', name: 'poemId', value: 'poem-a' },
            { type: 'field', name: 'studentId', value: 'student-a' },
        ])

        expect(response.statusCode).toBe(502)
        expect(mocks.writeFile).toHaveBeenCalledTimes(1)
        expect(mocks.unlink).toHaveBeenCalledTimes(1)
        expect(mocks.virtualFiles).toHaveLength(0)
        expect(asrStore()).toHaveLength(0)
    })
})
