import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClassroomQuestion, ClassroomStatus, QuestSnapshot } from '@/lib/types'

const classroomApi = vi.hoisted(() => ({
    start: vi.fn(),
    status: vi.fn(),
    next: vi.fn(),
    submit: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: { classroom: classroomApi } }))
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
vi.mock('@/lib/business-events', () => ({
    businessEvents: { emit: vi.fn(), on: vi.fn(() => () => undefined) },
}))
vi.mock('@/stores/workbench', () => ({
    useWorkbenchStore: { getState: () => ({ poemId: '', questions: [] }) },
}))

import { useClassroomStore } from './classroom'

const question = (id: string): ClassroomQuestion => ({
    id,
    poemId: 'poem-chunxiao',
    bloomLevel: '记忆',
    type: '选择',
    stem: `题目 ${id}`,
    options: ['春眠不觉晓', '床前明月光'],
    estimatedTimeSec: 30,
    difficulty: 1,
    aiGenerated: false,
})

const quest = (classPower: number): QuestSnapshot => ({
    currentLevel: '记忆',
    levelTitle: '识句门',
    levelGoal: '准确识记诗句',
    clearedLevels: [],
    levels: [
        { level: '记忆', title: '识句门', goal: '准确识记诗句', questionCount: 1, cleared: false, current: true },
        { level: '理解', title: '会意门', goal: '理解诗意', questionCount: 0, cleared: false, current: false },
        { level: '应用', title: '迁用门', goal: '迁移运用', questionCount: 0, cleared: false, current: false },
        { level: '分析', title: '析境门', goal: '分析意境', questionCount: 0, cleared: false, current: false },
        { level: '评价', title: '品鉴门', goal: '审美评价', questionCount: 0, cleared: false, current: false },
        { level: '创造', title: '创作门', goal: '创造表达', questionCount: 0, cleared: false, current: false },
    ],
    classPower,
    levelPower: classPower,
    levelTarget: 100,
    levelProgress: classPower,
    combo: classPower > 0 ? 1 : 0,
    maxCombo: classPower > 0 ? 1 : 0,
    aiOpponentScore: 12,
    leaderboard: {
        personal: classPower > 0 ? [{ studentId: 'student-1', name: '陈诗涵', score: classPower }] : [],
        teams: [],
    },
    hasTeams: false,
})

const status = (snapshot: QuestSnapshot): ClassroomStatus => ({
    lessonId: 'lesson-new',
    classId: 'class-1',
    mode: 'collective-race',
    phase: 'ongoing',
    currentQuestionIndex: 0,
    totalQuestions: 2,
    currentQuestion: question('question-1'),
    activeStudents: 40,
    responses: [],
    classMood: 'focused',
    cognitiveLoad: 20,
    engagement: 80,
    hintsDelivered: 0,
    joinCode: '123456',
    quest: snapshot,
    aiGenerated: true,
})

beforeEach(() => {
    vi.clearAllMocks()
    useClassroomStore.getState().reset()
})

describe('classroom authoritative quest synchronization', () => {
    it('clears the previous classroom quest before hydrating the new lesson status', async () => {
        const oldQuest = quest(88)
        const newQuest = quest(0)
        useClassroomStore.setState({ quest: oldQuest, lastLevelCleared: { clearedLevel: '记忆', nextLevel: '理解', allCleared: false } })
        classroomApi.start.mockResolvedValue({ lessonId: 'lesson-new', joinCode: '123456', joinUrl: '/join/123456', startedAt: 1 })

        let resolveStatus!: (value: ClassroomStatus) => void
        classroomApi.status.mockReturnValue(new Promise<ClassroomStatus>((resolve) => { resolveStatus = resolve }))

        const pending = useClassroomStore.getState().start('class-1', 'poem-chunxiao', 'collective-race')
        await vi.waitFor(() => expect(classroomApi.status).toHaveBeenCalledWith('lesson-new'))
        expect(useClassroomStore.getState().quest).toBeNull()
        expect(useClassroomStore.getState().lastLevelCleared).toBeNull()

        resolveStatus(status(newQuest))
        await pending
        expect(useClassroomStore.getState().quest).toEqual(newQuest)
    })

    it('uses the submit response immediately when websocket delivery is absent', async () => {
        const oldQuest = quest(0)
        const newQuest = quest(10)
        useClassroomStore.setState({
            lessonId: 'lesson-new',
            currentQuestion: question('question-1'),
            status: status(oldQuest),
            quest: oldQuest,
        })
        classroomApi.submit.mockResolvedValue({
            correct: true,
            feedback: '答对了',
            pendingAiReview: false,
            gradedBy: 'rule',
            quest: newQuest,
            delta: { power: 10, combo: 1, levelCleared: false, nextLevel: null, allCleared: false },
            aiGenerated: false,
        })

        await expect(useClassroomStore.getState().submit('student-1', '春眠不觉晓', '陈诗涵', 1200)).resolves.toBe(true)
        expect(useClassroomStore.getState().quest).toEqual(newQuest)
        expect(useClassroomStore.getState().responses).toMatchObject([{ studentId: 'student-1', studentName: '陈诗涵', correct: true }])
    })

    it('uses the next response immediately and reset removes every quest residue', async () => {
        const previous = quest(20)
        const authoritative = quest(24)
        useClassroomStore.setState({
            lessonId: 'lesson-new',
            status: status(previous),
            quest: previous,
            currentQuestion: question('question-1'),
            lastLevelCleared: { clearedLevel: '记忆', nextLevel: '理解', allCleared: false },
        })
        classroomApi.next.mockResolvedValue({
            currentQuestionIndex: 1,
            currentQuestion: question('question-2'),
            quest: authoritative,
        })

        await useClassroomStore.getState().next()
        expect(useClassroomStore.getState().quest).toEqual(authoritative)
        expect(useClassroomStore.getState().status.currentQuestionIndex).toBe(1)

        useClassroomStore.getState().reset()
        expect(useClassroomStore.getState().quest).toBeNull()
        expect(useClassroomStore.getState().lastLevelCleared).toBeNull()
    })
})
