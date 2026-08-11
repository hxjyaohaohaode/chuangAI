/**
 * Append items while retaining only the newest bounded window.
 *
 * Long-running classrooms and AI conversations must not grow React state and
 * rendered DOM without limit. The authoritative lesson/session history remains
 * on the backend; this helper constrains the live UI window deterministically.
 */
export function appendBoundedHistory<T>(
    current: readonly T[],
    additions: readonly T[],
    maxItems: number,
): T[] {
    const safeMax = Number.isFinite(maxItems)
        ? Math.max(0, Math.floor(maxItems))
        : 0

    if (safeMax === 0) return []
    if (additions.length >= safeMax) return additions.slice(-safeMax)

    const retainedCurrentCount = safeMax - additions.length
    return [
        ...current.slice(-retainedCurrentCount),
        ...additions,
    ]
}
