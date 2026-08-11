/**
 * A small, framework-agnostic guard for async work whose result belongs to a
 * particular UI entity.  A token is valid only while its generation, context
 * and component lifetime all still match.
 */
export interface AsyncGenerationToken {
    readonly generation: number
    readonly contextKey: string
}

interface MutableGeneration {
    current: number
}

export function beginAsyncGeneration(
    generation: MutableGeneration,
    contextKey: string,
): AsyncGenerationToken {
    generation.current += 1
    return { generation: generation.current, contextKey }
}

export function invalidateAsyncGeneration(generation: MutableGeneration): void {
    generation.current += 1
}

export function isAsyncGenerationCurrent(
    token: AsyncGenerationToken,
    currentGeneration: number,
    currentContextKey: string,
    mounted: boolean,
): boolean {
    return mounted
        && token.generation === currentGeneration
        && token.contextKey === currentContextKey
}
