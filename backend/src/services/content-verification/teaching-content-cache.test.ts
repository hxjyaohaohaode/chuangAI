import { describe, expect, it } from 'vitest'

import {
    TEACHING_CONTENT_CACHE_VERSION,
    computeTeachingContentSourceFingerprint,
    isTeachingContentCacheCurrent,
} from './teaching-content-cache.js'

const base = {
    id: 'jing-ye-si',
    title: '静夜思',
    poet: '李白',
    dynasty: '唐',
    content: '床前明月光，疑是地上霜。',
    gradeLevel: '一年级',
    theme: ['思乡'],
    rhetoric: ['比喻'],
    annotation: { 疑: '好像', 举头: '抬起头' },
}

describe('teaching content cache binding', () => {
    it('is stable when annotation object insertion order changes', () => {
        const reordered = { ...base, annotation: { 举头: '抬起头', 疑: '好像' } }
        expect(computeTeachingContentSourceFingerprint(base))
            .toBe(computeTeachingContentSourceFingerprint(reordered))
    })

    it.each([
        ['poem content', { ...base, content: '床前明月光，疑是窗前霜。' }],
        ['grade level', { ...base, gradeLevel: '二年级' }],
        ['theme', { ...base, theme: ['思乡', '月夜'] }],
        ['rhetoric', { ...base, rhetoric: ['比喻', '夸张'] }],
        ['annotation', { ...base, annotation: { ...base.annotation, 疑: '仿佛' } }],
    ])('invalidates cache after %s changes', (_label, changed) => {
        expect(computeTeachingContentSourceFingerprint(changed))
            .not.toBe(computeTeachingContentSourceFingerprint(base))
    })

    it('accepts only cache entries bound to the exact current input and version', () => {
        const fingerprint = computeTeachingContentSourceFingerprint(base)
        expect(isTeachingContentCacheCurrent({
            version: TEACHING_CONTENT_CACHE_VERSION,
            sourceFingerprint: fingerprint,
        }, fingerprint)).toBe(true)
        expect(isTeachingContentCacheCurrent({
            version: TEACHING_CONTENT_CACHE_VERSION - 1,
            sourceFingerprint: fingerprint,
        }, fingerprint)).toBe(false)
        expect(isTeachingContentCacheCurrent({ version: TEACHING_CONTENT_CACHE_VERSION }, fingerprint)).toBe(false)
        expect(isTeachingContentCacheCurrent({
            version: TEACHING_CONTENT_CACHE_VERSION,
            sourceFingerprint: computeTeachingContentSourceFingerprint({ ...base, gradeLevel: '二年级' }),
        }, fingerprint)).toBe(false)
    })
})
