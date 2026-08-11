/**
 * 生成图片的落盘缓存
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么必须落盘，而不能只存 URL
 * ─────────────────────────────────────────────────────────────
 * wan2.7-image 返回的是阿里云 OSS 的**限时签名 URL**：
 *   https://dashscope-*.oss-accelerate.aliyuncs.com/...png?Expires=1785076077&Signature=...
 * `Expires` 是秒级时间戳，过期后该地址直接 403。若只把这个 URL 存进数据库，
 * 生成当天一切正常，隔天演示时整页就全是破图——而且因为缓存"命中"了，
 * 系统还不会重新生成，故障是静默且不可自愈的。
 *
 * 因此这里在生成成功后立刻把图片字节下载到本地，之后一律引用本地路径。
 *
 * ─────────────────────────────────────────────────────────────
 * 缓存键
 * ─────────────────────────────────────────────────────────────
 * key = sha1(prompt + orientation + model)。同一段 prompt 只会真正生成一次，
 * 重复请求直接命中磁盘文件，既省钱也让演示可复现。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { generateWanImage } from './wan-image.js'
import { logger } from '../../lib/logger/index.js'
import { downloadTrustedDashscopeImage } from '../../security/remote-image-download.js'
import { atomicWriteFileSync } from '../../lib/atomic-file.js'
import { SingleFlight } from '../../lib/single-flight.js'
import { config } from '../../config.js'

const log = logger.child({ component: 'image-cache' })
const imageFlights = new SingleFlight<string, CachedImage | null>()

/**
 * 落盘前的压缩规格
 *
 * wan2.7 出图固定 2048×1152 PNG，实测单张约 1.8–2.4 MB。而这些图在界面上
 * 最大也就占到一张卡片的宽度（约 530 CSS px，2 倍屏 1060 物理 px）。
 * 六张卡直接引用原图 = 首屏白白拉 12 MB，这是明确不可接受的。
 *
 * 因此落盘时统一转成 1280 宽的 WebP：
 * - 1280 足够覆盖 2 倍屏下最大卡片的物理像素，再大是纯浪费
 * - WebP 对这种大面积平涂 + 水墨渐变的画面压缩率极高，实测能到 PNG 的 5% 上下
 * - `withoutEnlargement` 保证万一模型出图更小时不会被放大糊掉
 */
const TARGET_WIDTH = 1280
const WEBP_QUALITY = 90

/** 图片落盘目录（与 uploads 同级，便于静态托管与备份） */
function cacheDir(): string {
    const dir = config.runtimePaths.generatedUploadsDir
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
}

/** 缓存索引文件：key → { file, prompt, createdAt } */
function indexPath(): string {
    return join(cacheDir(), 'index.json')
}

interface CacheEntry {
    /** 相对 URL，前端可直接用作 <img src> */
    url: string
    prompt: string
    model: string
    /** DashScope 侧的请求追踪号，出问题时可凭它找服务商排查 */
    requestId?: string
    createdAt: number
}

type CacheIndex = Record<string, CacheEntry>

function readIndex(): CacheIndex {
    try {
        const p = indexPath()
        if (!existsSync(p)) return {}
        return JSON.parse(readFileSync(p, 'utf8')) as CacheIndex
    } catch {
        return {}
    }
}

function writeIndex(idx: CacheIndex): void {
    try {
        atomicWriteFileSync(indexPath(), JSON.stringify(idx, null, 2), { encoding: 'utf8' })
    } catch (err) {
        log.warn({ err }, '生图缓存索引写入失败（不影响本次返回）')
    }
}

function cacheKey(prompt: string, orientation: string, model: string): string {
    return createHash('sha1').update(`${model}|${orientation}|${prompt}`).digest('hex').slice(0, 16)
}

export interface CachedImage {
    /** 可直接用于 <img src> 的地址（本地静态路径） */
    url: string
    /** 是否命中缓存（未真正调用大模型） */
    cached: boolean
    model: string
    /**
     * 本次生成拿到的**远程原始地址**（仅本次新生成时有值，命中缓存时为 undefined）
     *
     * 存在的唯一理由：视觉标注类 Agent（eye.vision-annotate）要把图片交给
     * 云端多模态模型去看，模型必须能自己抓取该地址——本地的
     * `/uploads/...` 路径它够不着。所以"给模型看"用远程地址、
     * "给浏览器看"用本地地址，两者分开。
     *
     * 这个地址**带有效期**，只可用于当次同步调用，绝不能持久化。
     */
    remoteUrl?: string
    /** 供应商请求追踪号（缓存命中时取自索引） */
    requestId?: string
}

/**
 * 获取生成图片（带落盘缓存）
 *
 * @returns 成功时返回本地图片地址；密钥未配置或生成失败时返回 null，
 *          由调用方决定降级方案（通常是本地 SVG 插画）。
 */
export function getOrCreateImage(
    prompt: string,
    orientation: 'landscape' | 'portrait' = 'landscape',
    options?: { signal?: AbortSignal },
): Promise<CachedImage | null> {
    const model = 'wan2.7-image'
    const key = cacheKey(prompt, orientation, model)
    return imageFlights.run(key, () => getOrCreateImageUncoalesced(prompt, orientation, options))
}

async function getOrCreateImageUncoalesced(
    prompt: string,
    orientation: 'landscape' | 'portrait',
    options?: { signal?: AbortSignal },
): Promise<CachedImage | null> {
    const model = 'wan2.7-image'
    const key = cacheKey(prompt, orientation, model)
    const idx = readIndex()

    // ── 命中缓存：文件仍在磁盘上才算有效 ──
    const hit = idx[key]
    if (hit) {
        const file = join(cacheDir(), `${key}.webp`)
        if (existsSync(file)) {
            return {
                url: `/uploads/generated/${key}.webp`,
                cached: true,
                model,
                requestId: typeof hit.requestId === 'string' ? hit.requestId.slice(0, 256) : undefined,
            }
        }
        // 索引有记录但文件已被清理：删掉脏索引，走重新生成
        delete idx[key]
        writeIndex(idx)
    }

    // ── 真实生成 ──
    let remoteUrl: string
    let requestId: string | undefined
    try {
        const result = await generateWanImage({ prompt, orientation }, options)
        if (!result) return null
        remoteUrl = result.imageUrl
        requestId = result.requestId
    } catch (err) {
        log.warn({ err, promptHead: prompt.slice(0, 40) }, '生图失败，调用方应降级为本地插画')
        return null
    }

    // ── 立即下载 + 压缩落盘：签名 URL 会过期，绝不能只存地址 ──
    try {
        const original = await downloadTrustedDashscopeImage(remoteUrl, options)

        const webp = await sharp(original, { failOn: 'error', limitInputPixels: 25_000_000 })
            .resize({ width: TARGET_WIDTH, withoutEnlargement: true })
            .webp({ quality: WEBP_QUALITY })
            .toBuffer()
        atomicWriteFileSync(join(cacheDir(), `${key}.webp`), webp)

        const entry: CacheEntry = {
            url: `/uploads/generated/${key}.webp`,
            prompt,
            model,
            requestId,
            createdAt: Date.now(),
        }
        // 不复用生成开始前的 idx：不同 key 可并发生成，完成时必须重新合并最新索引，
        // 否则后完成者会用旧快照覆盖先完成者的记录。
        const latestIndex = readIndex()
        latestIndex[key] = entry
        writeIndex(latestIndex)
        log.info(
            { key, originalBytes: original.length, storedBytes: webp.length },
            '生图已压缩落盘缓存',
        )
        return { url: entry.url, cached: false, model, remoteUrl, requestId }
    } catch (err) {
        log.warn({ err }, '生成图片下载落盘失败，调用方应降级为本地插画')
        return null
    }
}
