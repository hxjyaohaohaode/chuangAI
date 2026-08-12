import { describe, expect, it } from 'vitest'
import { resolveSmartScoreParticipant } from './smart-score-boundary.js'

describe('smart-score participant boundary', () => {
    it('rejects a real student from another class', () => {
        expect(resolveSmartScoreParticipant(
            'class-a',
            'student-b',
            { classId: 'class-b', name: '陈同学', anonymousName: 'B01' },
            undefined,
            '伪造姓名',
        )).toEqual({ accepted: false, reason: 'STUDENT_CLASS_MISMATCH' })
    })

    it('uses the authoritative roster name for a same-class teacher view', () => {
        expect(resolveSmartScoreParticipant(
            'class-a',
            'student-a',
            { classId: 'class-a', name: '林诗涵', anonymousName: 'A01' },
            '旧名字',
            '客户端伪造姓名',
        )).toEqual({ accepted: true, displayName: '林诗涵', persistent: true })
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
