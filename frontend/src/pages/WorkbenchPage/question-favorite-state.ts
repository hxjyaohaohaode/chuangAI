import type {
    WorkbenchFavoriteResponse,
    WorkbenchQuestionListResponse,
} from '@/lib/types'

export interface FavoriteTarget {
    questionId: string
    favorited: boolean
}

export interface FavoriteOptimisticTransaction {
    previous: WorkbenchQuestionListResponse | undefined
    optimistic: WorkbenchQuestionListResponse | undefined
}

/**
 * 以显式目标值更新题库缓存。
 *
 * 找不到题卡或状态已经一致时保留原对象引用，避免同值重试引发无意义重渲染。
 */
export function setFavoriteInQuestionList(
    data: WorkbenchQuestionListResponse | undefined,
    target: FavoriteTarget,
): WorkbenchQuestionListResponse | undefined {
    if (!data) return data
    const targetQuestion = data.questions.find((question) => question.id === target.questionId)
    if (!targetQuestion || targetQuestion.favorited === target.favorited) return data

    return {
        ...data,
        questions: data.questions.map((question) => (
            question.id === target.questionId
                ? { ...question, favorited: target.favorited }
                : question
        )),
    }
}

/** 创建可回滚的乐观更新快照。 */
export function beginFavoriteOptimisticUpdate(
    data: WorkbenchQuestionListResponse | undefined,
    target: FavoriteTarget,
): FavoriteOptimisticTransaction {
    return {
        previous: data,
        optimistic: setFavoriteInQuestionList(data, target),
    }
}

/** 请求失败时恢复 mutation 开始前的精确缓存快照。 */
export function rollbackFavoriteOptimisticUpdate(
    transaction: FavoriteOptimisticTransaction,
): WorkbenchQuestionListResponse | undefined {
    return transaction.previous
}

/** 请求成功时以服务端持久化回执校准乐观状态。 */
export function reconcileFavoriteResponse(
    data: WorkbenchQuestionListResponse | undefined,
    response: WorkbenchFavoriteResponse,
): WorkbenchQuestionListResponse | undefined {
    return setFavoriteInQuestionList(data, response)
}
