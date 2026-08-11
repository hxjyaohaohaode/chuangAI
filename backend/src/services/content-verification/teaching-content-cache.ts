import { createHash } from 'node:crypto'

/**
 * AI 教学内容的缓存结构升级必须显式递增版本。版本只能解决提示词/输出结构变化；
 * 具体诗文及人工注释的变化则由 sourceFingerprint 单独绑定，二者缺一不可。
 */
export const TEACHING_CONTENT_CACHE_VERSION = 2

export interface TeachingContentInput {
    id: string
    title: string
    poet: string
    dynasty: string
    content: string
    gradeLevel?: string | null
    theme: readonly string[]
    rhetoric: readonly string[]
    annotation?: Record<string, string> | null
}

export interface TeachingContentCacheBinding {
    version: number
    sourceFingerprint: string
}

/**
 * Hash the *whole* prompt-relevant teaching context. A hash of poem.content
 * alone is insufficient: an edited grade, annotation, theme or rhetoric label
 * can make an otherwise byte-identical translation/lesson explanation wrong.
 * Annotation entries are sorted so JSON key insertion order cannot cause a
 * needless paid regeneration.
 */
export function computeTeachingContentSourceFingerprint(input: TeachingContentInput): string {
    const annotation = Object.entries(input.annotation ?? {})
        .map(([word, explanation]) => [word, explanation] as const)
        // Deliberately use code-point ordering rather than localeCompare: the
        // cache key must stay byte-stable across competition machines with
        // different ICU/locale bundles.
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    const canonical = JSON.stringify({
        id: input.id,
        title: input.title,
        poet: input.poet,
        dynasty: input.dynasty,
        content: input.content,
        gradeLevel: input.gradeLevel ?? null,
        theme: [...input.theme],
        rhetoric: [...input.rhetoric],
        annotation,
    })
    return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Treat all legacy or malformed cache entries as stale. Returning a stale AI
 * explanation is worse than performing a controlled regeneration or showing
 * the explicit offline fallback, especially for elementary teaching content.
 */
export function isTeachingContentCacheCurrent(
    value: unknown,
    sourceFingerprint: string,
): value is TeachingContentCacheBinding {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Partial<TeachingContentCacheBinding>
    return candidate.version === TEACHING_CONTENT_CACHE_VERSION
        && candidate.sourceFingerprint === sourceFingerprint
}
