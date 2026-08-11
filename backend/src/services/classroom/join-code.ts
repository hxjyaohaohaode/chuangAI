import { randomInt } from 'node:crypto'

export const CLASSROOM_JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CLASSROOM_JOIN_CODE_LENGTH = 6
export const CLASSROOM_JOIN_CODE_MAX_ATTEMPTS = 128

export class ClassroomJoinCodeExhaustedError extends Error {
    constructor() {
        super('无法分配唯一课堂加入码')
        this.name = 'ClassroomJoinCodeExhaustedError'
    }
}

type RandomIndex = (maxExclusive: number) => number

export interface GenerateClassroomJoinCodeOptions {
    alphabet?: string
    length?: number
    maxAttempts?: number
    randomIndex?: RandomIndex
}

/**
 * Generate a bounded, ambiguity-free classroom locator.
 *
 * `randomInt` avoids the bias and predictability of `Math.random`; a bounded
 * retry loop prevents an unavailable/corrupt uniqueness index from recursing
 * until the process stack is exhausted. The callback keeps persistence as the
 * sole source of truth and makes collision handling independently testable.
 */
export function generateUniqueClassroomJoinCode(
    isInUse: (code: string) => boolean,
    options: GenerateClassroomJoinCodeOptions = {},
): string {
    const alphabet = options.alphabet ?? CLASSROOM_JOIN_CODE_ALPHABET
    const length = options.length ?? CLASSROOM_JOIN_CODE_LENGTH
    const maxAttempts = options.maxAttempts ?? CLASSROOM_JOIN_CODE_MAX_ATTEMPTS
    const randomIndex = options.randomIndex ?? ((maxExclusive) => randomInt(maxExclusive))

    if (alphabet.length < 2 || !Number.isSafeInteger(length) || length < 1 || length > 32) {
        throw new TypeError('课堂加入码配置无效')
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10_000) {
        throw new TypeError('课堂加入码重试上限无效')
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        let code = ''
        for (let position = 0; position < length; position += 1) {
            const index = randomIndex(alphabet.length)
            if (!Number.isSafeInteger(index) || index < 0 || index >= alphabet.length) {
                throw new TypeError('课堂加入码随机源返回了越界索引')
            }
            code += alphabet[index]
        }
        if (!isInUse(code)) return code
    }

    throw new ClassroomJoinCodeExhaustedError()
}
