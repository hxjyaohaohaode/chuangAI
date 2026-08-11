import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GENERATED_POEM_IMAGE_BY_ID, releasedStarmapImagePath } from './poem-generated-images'
import { CULTURE_SCENES, getPoemImage, getPreferredPoeticImageUrl, POEM_IMAGES } from './poem-images'

describe('poem image release boundary', () => {
    it('packages one unique WebP for every one of the 148 production poem IDs', () => {
        const entries = Object.entries(GENERATED_POEM_IMAGE_BY_ID)

        expect(entries).toHaveLength(148)
        expect(new Set(entries.map(([, imagePath]) => imagePath)).size).toBe(148)
        for (const [, imagePath] of entries) {
            expect(imagePath).toMatch(/^\/images\/generated\/starmap\/tongbian-[\w-]+\.webp$/)
            expect(imagePath).not.toContain('/uploads/')
            const publicFile = fileURLToPath(new URL(`../../public${imagePath}`, import.meta.url))
            expect(existsSync(publicFile), `缺少随包位图 ${imagePath}`).toBe(true)
        }
        expect(GENERATED_POEM_IMAGE_BY_ID['tongbian-007']).toBe('/images/generated/starmap/tongbian-007-v2.webp')
        expect(GENERATED_POEM_IMAGE_BY_ID['tongbian-011']).toBe('/images/generated/starmap/tongbian-011-v2.webp')
        expect(GENERATED_POEM_IMAGE_BY_ID['tongbian-036']).toBe('/images/generated/starmap/tongbian-036-v2.webp')
        expect(GENERATED_POEM_IMAGE_BY_ID['tongbian-043']).toBe('/images/generated/starmap/tongbian-043-v2.webp')
        expect(GENERATED_POEM_IMAGE_BY_ID['tongbian-078']).toBe('/images/generated/starmap/tongbian-078-v2.webp')
        expect(GENERATED_POEM_IMAGE_BY_ID['tongbian-s36']).toBe('/images/generated/starmap/tongbian-s36-v2.webp')
        expect(releasedStarmapImagePath('tongbian-007')).toBe('/images/generated/starmap/tongbian-007-v2.webp')
        expect(releasedStarmapImagePath('tongbian-011')).toBe('/images/generated/starmap/tongbian-011-v2.webp')
        expect(releasedStarmapImagePath('tongbian-036')).toBe('/images/generated/starmap/tongbian-036-v2.webp')
        expect(releasedStarmapImagePath('tongbian-043')).toBe('/images/generated/starmap/tongbian-043-v2.webp')
        expect(releasedStarmapImagePath('tongbian-078')).toBe('/images/generated/starmap/tongbian-078-v2.webp')
        expect(releasedStarmapImagePath('tongbian-s36')).toBe('/images/generated/starmap/tongbian-s36-v2.webp')
    })

    it('replaces rejected legacy candidates with reviewed packaged WebP assets', () => {
        expect(POEM_IMAGES).toHaveLength(20)
        expect(CULTURE_SCENES).toHaveLength(4)
        expect(getPoemImage('poem-jueju')?.imagePath).toBe(releasedStarmapImagePath('tongbian-036'))
        expect(getPoemImage('poem-jiangxue')?.imagePath).toBe(releasedStarmapImagePath('tongbian-007'))
        expect(getPoemImage('poem-jiuyuejiuyi')?.imagePath).toBe(releasedStarmapImagePath('tongbian-011'))
        expect(getPoemImage('poem-chusai')?.imagePath).toBe(releasedStarmapImagePath('tongbian-078'))
        expect(CULTURE_SCENES.find((scene) => scene.id === 'guqin-playing')?.imagePath)
            .toBe(releasedStarmapImagePath('tongbian-043'))
        expect(CULTURE_SCENES.find((scene) => scene.id === 'tang-study')?.imagePath)
            .toBe(releasedStarmapImagePath('tongbian-s36'))

        expect(getPreferredPoeticImageUrl('/images/poems/jueju.svg')).toBe(releasedStarmapImagePath('tongbian-036'))
        expect(getPreferredPoeticImageUrl('/images/poems/jiangxue.svg')).toBe(releasedStarmapImagePath('tongbian-007'))
        expect(getPreferredPoeticImageUrl('/images/poems/jiuyuejiuyi.svg')).toBe(releasedStarmapImagePath('tongbian-011'))
        expect(getPreferredPoeticImageUrl('/images/poems/chusai.svg')).toBe(releasedStarmapImagePath('tongbian-078'))
        expect(getPreferredPoeticImageUrl('/images/culture/guqin-playing.svg')).toBe(releasedStarmapImagePath('tongbian-043'))
        expect(getPreferredPoeticImageUrl('/images/culture/tang-study.svg')).toBe(releasedStarmapImagePath('tongbian-s36'))
    })

    it('upgrades reviewed legacy SVGs through the single release mapping', () => {
        expect(getPreferredPoeticImageUrl('/images/poems/jingyesi.svg'))
            .toBe(releasedStarmapImagePath('tongbian-003'))
        expect(getPreferredPoeticImageUrl('https://example.invalid/images/poems/chunxiao.svg?legacy=1'))
            .toBe(releasedStarmapImagePath('tongbian-002'))
    })
})
