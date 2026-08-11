import { describe, expect, it } from 'vitest'
import { resolveSmartScoreParticipant } from './smart-score-boundary.js'

describe('smart-score participant boundary', () => {
    it('rejects a real student from another class', () => {
        expect(resolveSmartScoreParticipant(
            'class-a',
            'student-b',
            { classId: 'class-b', anonymousName: 'B01' },
            undefined,
            '伪造姓名',
        )).toEqual({ accepted: false, reason: 'STUDENT_CLASS_MISMATCH' })
    })

    it('uses the authoritative anonymized name for a same-class real student', () => {
        expect(resolveSmartScoreParticipant(
            'class-a',
            'student-a',
            { classId: 'class-a', anonymousName: 'A01' },
            '旧名字',
            '真实姓名不应进入广播',
        )).toEqual({ accepted: true, displayName: 'A01', persistent: true })
    })

    it('keeps an explicit in-class synthetic participant non-persistent', () => {
        expect(resolveSmartScoreParticipant(
            'class-a',
            'puzzle-player',
            null,
            '拼图参与者',
            '客户端别名',
        )).toEqual({ accepted: true, displayName: '拼图参与者', persistent: false })
    })
})
