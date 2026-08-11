/**
 * 意象接口的目录边界策略。
 *
 * AI 刷新只能作用于本地可追溯目录中的意象。这样既避免把任意路径参数
 * 直接送入模型，也能让未知资源稳定收敛为 404，而不是产生高延迟外呼。
 */

import { IMAGE_CULTURAL_MEANINGS, SEED_POEMS } from '../knowledge-graph/seed-data.js'

/** 判断意象是否能由本地词典或统编版诗词种子数据追溯。 */
export function isKnownImagery(imageName: string): boolean {
    const normalized = imageName.trim()
    if (!normalized) return false

    const catalogMatch = Object.keys(IMAGE_CULTURAL_MEANINGS).some(
        (key) => key === normalized || key.includes(normalized) || normalized.includes(key),
    )
    if (catalogMatch) return true

    return SEED_POEMS.some((poem) => poem.images.some(
        (image) => image === normalized || image.includes(normalized) || normalized.includes(image),
    ))
}
