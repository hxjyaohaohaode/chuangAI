import { describe, expect, it } from 'vitest'
import type { PoemNode } from '../../agents/base/types.js'
import { generateLocalScenes, packagedPoemImageUrl } from './local-scene-generator.js'

function makePoem(overrides: Partial<PoemNode> = {}): PoemNode {
    return {
        id: 'tongbian-003',
        title: '静夜思',
        poet: '李白',
        dynasty: '唐',
        theme: ['思乡'],
        images: ['明月', '霜'],
        content: '床前明月光，疑是地上霜。\n举头望明月，低头思故乡。',
        gradeLevel: '一年级',
        difficulty: 2,
        ...overrides,
    }
}

describe('packaged culture image boundary', () => {
    it('returns exactly one poem-specific packaged WebP and never SVG', () => {
        const scenes = generateLocalScenes('tongbian-003', makePoem())
        expect(scenes).toHaveLength(1)
        expect(scenes[0]).toMatchObject({
            id: 'packaged-poetic-tongbian-003',
            poemId: 'tongbian-003',
            imageUrl: '/images/generated/starmap/tongbian-003.webp',
            sceneType: 'poetic',
            aiGenerated: true,
            model: 'wan2.7-image',
        })
        expect(scenes[0]?.imageUrl).not.toContain('.svg')
        expect(scenes[0]?.description).toContain('明月、霜')
        expect(scenes[0]?.relatedVerse).toBe('床前明月光，疑是地上霜。')
    })

    it('uses reviewed replacements for rejected originals', () => {
        expect(packagedPoemImageUrl('tongbian-007'))
            .toBe('/images/generated/starmap/tongbian-007-v2.webp')
        expect(packagedPoemImageUrl('tongbian-s36'))
            .toBe('/images/generated/starmap/tongbian-s36-v2.webp')
    })

    it('fails closed for malformed or foreign IDs instead of cross-poem reuse', () => {
        expect(generateLocalScenes('../tongbian-003', makePoem())).toEqual([])
        expect(generateLocalScenes('poem-001', makePoem())).toEqual([])
        expect(packagedPoemImageUrl('tongbian-3')).toBeNull()
    })
})
