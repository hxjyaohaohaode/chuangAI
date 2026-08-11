import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    findClassById: vi.fn(),
    findStudentById: vi.fn(),
    dbPrepare: vi.fn(),
    kgConstruct: vi.fn(),
    detectorConstruct: vi.fn(),
    kgClose: vi.fn(async () => undefined),
}))

vi.mock('../db/index.js', () => ({
    db: { prepare: mocks.dbPrepare },
    repos: {
        classes: { findById: mocks.findClassById },
        students: {
            findById: mocks.findStudentById,
            findByClassId: vi.fn(() => []),
        },
        poems: {},
        lessons: {},
        questions: {},
        answers: {},
        mastery: {},
        events: {},
    },
    services: {
        mastery: {},
        event: {},
    },
}))

vi.mock('../services/knowledge-graph/knowledge-graph-service.js', () => ({
    KnowledgeGraphService: class {
        constructor(...args: unknown[]) {
            mocks.kgConstruct(...args)
        }

        close() {
            return mocks.kgClose()
        }
    },
}))

vi.mock('../services/knowledge-graph/dark-matter-detector.js', () => ({
    DarkMatterDetector: class {
        constructor(...args: unknown[]) {
            mocks.detectorConstruct(...args)
        }
    },
}))

vi.mock('../services/profile/student-profile-3d.js', () => ({
    generateStudentProfile3D: vi.fn(),
}))

vi.mock('../services/grading/learning-path-generator.js', () => ({
    learningPathGenerator: {},
}))

vi.mock('../services/grading/prescription-generator.js', () => ({
    prescriptionGenerator: {},
}))

import { diagnosisRoutes } from './diagnosis.js'

describe('diagnosis entity truth boundary', () => {
    let app: Awaited<ReturnType<typeof Fastify>> | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.findClassById.mockReturnValue(null)
        mocks.findStudentById.mockReturnValue(null)
    })

    afterEach(async () => {
        if (app) await app.close()
        app = undefined
    })

    async function createApp() {
        app = Fastify({ logger: false })
        await app.register(diagnosisRoutes, { prefix: '/api/diagnosis' })
        return app
    }

    it.each([
        '/api/diagnosis/classes/missing-class/bloom-distribution',
        '/api/diagnosis/classes/missing-class/heatmap',
        '/api/diagnosis/classes/missing-class/dark-matter',
        '/api/diagnosis/classes/missing-class/dark-matter/report',
        '/api/diagnosis/classes/missing-class/prescription/missing-pattern',
        '/api/diagnosis/classes/missing-class/suggestions',
    ])('returns CLASS_NOT_FOUND before computing %s', async (url) => {
        const server = await createApp()
        const response = await server.inject({ method: 'GET', url })

        expect(response.statusCode).toBe(404)
        expect(response.json()).toEqual({
            status: 'error',
            error: 'CLASS_NOT_FOUND',
            message: '班级不存在',
        })
        expect(mocks.findClassById).toHaveBeenCalledWith('missing-class')
        expect(mocks.dbPrepare).not.toHaveBeenCalled()
        expect(mocks.kgConstruct).not.toHaveBeenCalled()
        expect(mocks.detectorConstruct).not.toHaveBeenCalled()
    })

    it.each([
        '/api/diagnosis/students/missing-student/profile',
        '/api/diagnosis/students/missing-student/gaps',
        '/api/diagnosis/students/missing-student/learning-path',
    ])('returns STUDENT_NOT_FOUND before computing %s', async (url) => {
        const server = await createApp()
        const response = await server.inject({ method: 'GET', url })

        expect(response.statusCode).toBe(404)
        expect(response.json()).toEqual({
            status: 'error',
            error: 'STUDENT_NOT_FOUND',
            message: '学生不存在',
        })
        expect(mocks.findStudentById).toHaveBeenCalledWith('missing-student')
        expect(mocks.dbPrepare).not.toHaveBeenCalled()
        expect(mocks.kgConstruct).not.toHaveBeenCalled()
        expect(mocks.detectorConstruct).not.toHaveBeenCalled()
    })

    it('keeps the documented empty-data degradation for an existing class when aggregation fails', async () => {
        mocks.findClassById.mockReturnValue({ id: 'real-class', name: '真实班级' })
        mocks.dbPrepare.mockImplementation(() => {
            throw new Error('database temporarily unavailable')
        })
        const server = await createApp()
        const response = await server.inject({
            method: 'GET',
            url: '/api/diagnosis/classes/real-class/bloom-distribution',
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({
            classId: 'real-class',
            aiGenerated: false,
        })
        expect(response.json().levels).toHaveLength(6)
    })
})
