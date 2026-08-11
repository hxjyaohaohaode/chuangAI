import { describe, expect, it, vi } from 'vitest'
import type { WSBroadcaster } from './websocket/broadcaster.js'
import { DanceStage, DanceStageError } from './dance-stage.js'

describe('DanceStage 生命周期', () => {
    it('关闭后清理课堂、拒绝旧引用写入，并保持幂等', () => {
        const broadcaster = { broadcast: vi.fn() } as unknown as WSBroadcaster
        const stage = new DanceStage(broadcaster)

        stage.startSession({ lessonId: 'lesson-1', classId: 'class-1', poemId: 'poem-1', teacherLabel: '教师' })
        stage.endSession('lesson-1')
        expect(stage.sessionCount).toBe(1)

        stage.closeAll()
        stage.closeAll()
        expect(stage.isClosed).toBe(true)
        expect(stage.sessionCount).toBe(0)
        expect(stage.getSession('lesson-1')).toBeUndefined()
        expect(stage.getTimeline('lesson-1')).toEqual([])
        expect(stage.submitEvent('lesson-1', {
            name: 'teacher:assign',
            actor: 'teacher',
            subType: 'assign',
            actorId: 'teacher-1',
            actorLabel: '教师',
            content: '旧引用不应写入',
            aiGenerated: false,
        })).toBeUndefined()
        try {
            stage.startSession({
                lessonId: 'lesson-2',
                classId: 'class-1',
                poemId: 'poem-1',
                teacherLabel: '教师',
            })
            throw new Error('预期关闭后的 DanceStage 拒绝创建会话')
        } catch (error) {
            expect(error).toBeInstanceOf(DanceStageError)
            expect(error).toMatchObject({ code: 'STAGE_CLOSED' })
        }
    })

    it('并发容量耗尽时抛出稳定的类型化错误码', () => {
        const broadcaster = { broadcast: vi.fn() } as unknown as WSBroadcaster
        const stage = new DanceStage(broadcaster)

        for (let index = 0; index < 50; index += 1) {
            stage.startSession({
                lessonId: `lesson-${index}`,
                classId: 'class-1',
                poemId: 'poem-1',
                teacherLabel: '教师',
            })
        }

        try {
            stage.startSession({
                lessonId: 'lesson-over-capacity',
                classId: 'class-1',
                poemId: 'poem-1',
                teacherLabel: '教师',
            })
            throw new Error('预期超出并发容量时拒绝创建会话')
        } catch (error) {
            expect(error).toBeInstanceOf(DanceStageError)
            expect(error).toMatchObject({ code: 'SESSION_LIMIT_REACHED' })
        } finally {
            stage.closeAll()
        }
    })
})
