/**
 * 星图可发布的 AI 诗境图清单。
 *
 * 这里只登记已经完成来源、内容、解码与发布边界审计，并实际固化在
 * frontend/public/images/generated/starmap/ 的精选资源。data/uploads 下的
 * 生成缓存不属于 Git/比赛发布包；未经审核的缓存不得在此冒充可部署资源。
 *
 * 未登记的诗篇会由星图组件显示具名的非空占位。核心诗篇与文化场景只使用
 * 此处登记、随 Git/Render 发布的 WebP；不得再退回低细节 SVG 或 data/ 缓存。
 */
export const GENERATED_POEM_IMAGE_BY_ID: Readonly<Record<string, string>> = {
    'tongbian-002': '/images/generated/starmap/tongbian-002.webp',
    'tongbian-003': '/images/generated/starmap/tongbian-003.webp',
    'tongbian-005': '/images/generated/starmap/tongbian-005.webp',
    'tongbian-006': '/images/generated/starmap/tongbian-006.webp',
    'tongbian-007': '/images/generated/starmap/tongbian-007-v2.webp',
    'tongbian-008': '/images/generated/starmap/tongbian-008.webp',
    'tongbian-011': '/images/generated/starmap/tongbian-011-v2.webp',
    'tongbian-014': '/images/generated/starmap/tongbian-014.webp',
    'tongbian-017': '/images/generated/starmap/tongbian-017.webp',
    'tongbian-025': '/images/generated/starmap/tongbian-025.webp',
    'tongbian-027': '/images/generated/starmap/tongbian-027.webp',
    'tongbian-035': '/images/generated/starmap/tongbian-035.webp',
    'tongbian-036': '/images/generated/starmap/tongbian-036-v2.webp',
    'tongbian-041': '/images/generated/starmap/tongbian-041.webp',
    'tongbian-043': '/images/generated/starmap/tongbian-043-v2.webp',
    'tongbian-061': '/images/generated/starmap/tongbian-061.webp',
    'tongbian-066': '/images/generated/starmap/tongbian-066.webp',
    'tongbian-067': '/images/generated/starmap/tongbian-067.webp',
    'tongbian-078': '/images/generated/starmap/tongbian-078-v2.webp',
    'tongbian-s09': '/images/generated/starmap/tongbian-s09.webp',
    'tongbian-s33': '/images/generated/starmap/tongbian-s33.webp',
    'tongbian-s36': '/images/generated/starmap/tongbian-s36-v2.webp',
}

/** 获取已完成发布审计的星图图片；固定内容配置用它复用唯一映射。 */
export function releasedStarmapImagePath(id: string): string {
    const imagePath = GENERATED_POEM_IMAGE_BY_ID[id]
    if (!imagePath) throw new Error(`未登记可发布的星图图片：${id}`)
    return imagePath
}
