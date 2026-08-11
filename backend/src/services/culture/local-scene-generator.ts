/**
 * 文化页离线图片边界。
 *
 * 旧实现会针对同一首诗现场拼出 4 张 SVG，并把它们作为“教学插画”展示。
 * 这既违反产品的位图要求，也会让用户误以为四个场景都有真实生成结果。
 * 现在只返回当前诗篇 ID 唯一对应、随前端发布的 Wan WebP；没有对应关系时
 * 返回空数组，绝不跨诗借图、绝不生成 SVG、绝不复制同一张图凑数量。
 */

import type { PoemNode } from '../../agents/base/types.js'

export type SceneType = 'poetic'

export interface LocalSceneImage {
    id: string
    poemId: string
    title: string
    imageUrl: string
    description: string
    culturalMeaning: string
    relatedVerse?: string
    orientation: 'landscape'
    sceneType: SceneType
    /** 这是已随包固化的 Wan 生成图，不是规则绘制占位。 */
    aiGenerated: true
    model: 'wan2.7-image'
    createdAt: number
}

const REVIEWED_REPLACEMENTS: Readonly<Record<string, string>> = {
    'tongbian-007': 'tongbian-007-v2.webp',
    'tongbian-011': 'tongbian-011-v2.webp',
    'tongbian-036': 'tongbian-036-v2.webp',
    'tongbian-043': 'tongbian-043-v2.webp',
    'tongbian-078': 'tongbian-078-v2.webp',
    'tongbian-s36': 'tongbian-s36-v2.webp',
}

const PACKAGED_POEM_ID = /^tongbian-(?:\d{3}|s\d{2})$/u

export function packagedPoemImageUrl(poemId: string): string | null {
    if (!PACKAGED_POEM_ID.test(poemId)) return null
    const filename = REVIEWED_REPLACEMENTS[poemId] ?? `${poemId}.webp`
    return `/images/generated/starmap/${filename}`
}

export function generateLocalScenes(poemId: string, poem: PoemNode): LocalSceneImage[] {
    const imageUrl = packagedPoemImageUrl(poemId)
    if (!imageUrl) return []

    const themes = poem.theme.length > 0 ? poem.theme.join('、') : '诗歌意境'
    const images = poem.images.length > 0 ? poem.images.join('、') : '诗中景物'
    const firstVerse = (poem.content ?? '').split('\n').map((line) => line.trim()).find(Boolean)
    const createdAt = Date.now()

    return [{
        id: `packaged-poetic-${poemId}`,
        poemId,
        title: `${poem.title}·诗境图`,
        imageUrl,
        description: `依据《${poem.title}》的${images}与${themes}生成并随包固化的专属诗境图。`,
        culturalMeaning: `画面只服务于${poem.dynasty}代${poem.poet}《${poem.title}》的文本观察；课堂解读仍应以教材原文和可靠史料为准。`,
        ...(firstVerse ? { relatedVerse: firstVerse } : {}),
        orientation: 'landscape',
        sceneType: 'poetic',
        aiGenerated: true,
        model: 'wan2.7-image',
        createdAt,
    }]
}
