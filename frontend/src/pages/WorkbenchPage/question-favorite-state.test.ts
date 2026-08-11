import { describe, expect, it } from 'vitest'
import type { WorkbenchQuestionListResponse, WorkbenchQuestionMeta } from '@/lib/types'
import {
    beginFavoriteOptimisticUpdate,
    reconcileFavoriteResponse,
    rollbackFavoriteOptimisticUpdate,
    setFavoriteInQuestionList,
} from './question-favorite-state'

function createList(favorited = false): WorkbenchQuestionListResponse {
    const question: WorkbenchQuestionMeta = {
        id: 'question-001',
        poemId: 'poem-jingyesi',
        bloomLevel: '理解',
        type: '简答',
        stem: '诗中哪些词表现了思乡之情？',
        answer: '低头、思故乡。',
        analysis: '通过动作描写表现思乡。',
        difficulty: 2,
        estimatedTimeSec: 60,
        aiGenerated: true,
        knowledgePoints: ['思乡'],
        score: 5,
        favorited,
        createdAt: 1,
        updatedAt: 1,
    }
    return { questions: [question], total: 1, page: 1, pageSize: 20 }
}

describe('workbench favorite optimistic state', () => {
    it('applies an explicit target and keeps repeated same-target updates stable', () => {
        const original = createList(false)
        const first = setFavoriteInQuestionList(original, {
            questionId: 'question-001',
            favorited: true,
        })
        const retry = setFavoriteInQuestionList(first, {
            questionId: 'question-001',
            favorited: true,
        })

        expect(original.questions[0]?.favorited).toBe(false)
        expect(first?.questions[0]?.favorited).toBe(true)
        expect(retry).toBe(first)
    })

    it('restores the exact pre-request snapshot when the request fails', () => {
        const original = createList(false)
        const transaction = beginFavoriteOptimisticUpdate(original, {
            questionId: 'question-001',
            favorited: true,
        })

        expect(transaction.optimistic?.questions[0]?.favorited).toBe(true)
        const rolledBack = rollbackFavoriteOptimisticUpdate(transaction)
        expect(rolledBack).toBe(original)
        expect(rolledBack?.questions[0]?.favorited).toBe(false)
    })

    it('reconciles an optimistic value with the authoritative server response', () => {
        const optimistic = createList(true)
        const reconciled = reconcileFavoriteResponse(optimistic, {
            questionId: 'question-001',
            favorited: false,
        })

        expect(reconciled?.questions[0]?.favorited).toBe(false)
    })
})
