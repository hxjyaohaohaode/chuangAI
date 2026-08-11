/**
 * 星图 AI 诗境图清单。
 *
 * 每一个 key 都是知识图谱中的真实诗篇 ID，图片只允许按同 ID 一一对应。
 * 原批次中 6 张已发现错字、提示词残留或时代错配，使用重新生成的 v2 位图；
 * 其余已有批次全部固化到 frontend/public/images/generated/starmap/，但仍须
 * 继续做逐张原尺寸文字与语义复核，不能把“文件存在”写成“内容已审定”。
 *
 * 不允许 SVG、通用占位或跨诗复用。下列 26 个标准编号是原始诗库的重复记录，
 * 在最终 148 首去重诗库中没有对应节点；它们不是缺图，也不得凭空生成凑数。
 */
const DEDUPLICATED_STANDARD_IMAGE_NUMBERS = new Set([
    49, 53, 54, 56, 60, 68, 70, 71, 76, 77, 81, 82, 94,
    100, 101, 105, 106, 108, 109, 110, 111, 112, 113, 114, 115, 131,
])

const REVIEWED_REPLACEMENTS: Readonly<Record<string, string>> = {
    'tongbian-007': 'tongbian-007-v2.webp',
    'tongbian-011': 'tongbian-011-v2.webp',
    'tongbian-036': 'tongbian-036-v2.webp',
    'tongbian-043': 'tongbian-043-v2.webp',
    'tongbian-078': 'tongbian-078-v2.webp',
    'tongbian-s36': 'tongbian-s36-v2.webp',
}

const existingStandardIds = Array.from({ length: 132 }, (_, index) => index + 1)
    .filter((number) => !DEDUPLICATED_STANDARD_IMAGE_NUMBERS.has(number))
    .map((number) => `tongbian-${String(number).padStart(3, '0')}`)

const existingSupplementIds = Array.from({ length: 42 }, (_, index) => (
    `tongbian-s${String(index + 1).padStart(2, '0')}`
))

export const GENERATED_POEM_IMAGE_BY_ID: Readonly<Record<string, string>> = Object.fromEntries(
    [...existingStandardIds, ...existingSupplementIds].map((id) => {
        const filename = REVIEWED_REPLACEMENTS[id] ?? `${id}.webp`
        return [id, `/images/generated/starmap/${filename}`]
    }),
)

/** 获取已随包固化的同诗星图图片；内容审定状态由独立逐图证据负责。 */
export function releasedStarmapImagePath(id: string): string {
    const imagePath = GENERATED_POEM_IMAGE_BY_ID[id]
    if (!imagePath) throw new Error(`未登记可发布的星图图片：${id}`)
    return imagePath
}
