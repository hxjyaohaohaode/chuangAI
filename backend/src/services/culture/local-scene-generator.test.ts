/**
 * services/culture/local-scene-generator.ts 单元测试
 *
 * 覆盖：
 * - generateLocalScenes：4 张场景图生成、字段完整性、ID/Title 格式、SVG 有效性、5KB 上限
 * - inspectSceneByteLength：字节长度计算、非 data URL 返回 -1
 * - detectThemeVisual（间接）：8 种主题类型的视觉标签
 * - detectImageryVisual（间接）：8 种意象类型的视觉标签
 * - escapeXml（间接）：XML 特殊字符转义
 * - svgToDataUrl（间接）：base64 编码与可解码性
 * - 边界条件：空 theme/images 数组、空 content、多行 content、特殊字符
 *
 * 设计原则：
 * - 纯函数测试，无需 mock（零外部依赖）
 * - 验证 SVG 字符串结构（开头/结尾标签、xmlns、viewBox）
 * - 验证 data URL 可解码回原始 SVG
 * - 验证所有 4 张 SVG 字节长度 ≤ 5KB
 */

import { describe, expect, it } from 'vitest'
import {
    generateLocalScenes,
    inspectSceneByteLength,
    type LocalSceneImage,
} from './local-scene-generator.js'
import type { PoemNode } from '../../agents/base/types.js'

// ─────────────────────────────────────────────────────────────
// 辅助：构造 PoemNode
// ─────────────────────────────────────────────────────────────

function makePoem(overrides: Partial<PoemNode> = {}): PoemNode {
    return {
        id: 'poem-001',
        title: '静夜思',
        poet: '李白',
        dynasty: '唐',
        theme: ['思乡'],
        images: ['月'],
        content: '床前明月光，疑是地上霜。\n举头望明月，低头思故乡。',
        gradeLevel: '三年级',
        difficulty: 3,
        ...overrides,
    }
}

/** 从 data URL 解码 SVG 字符串 */
function decodeDataUrl(dataUrl: string): string {
    const prefix = 'data:image/svg+xml;base64,'
    if (!dataUrl.startsWith(prefix)) {
        throw new Error('不是 data URL')
    }
    const b64 = dataUrl.slice(prefix.length)
    return Buffer.from(b64, 'base64').toString('utf-8')
}

describe('local-scene-generator', () => {
    // ─────────────────────────────────────────────────────────
    // generateLocalScenes 基础行为
    // ─────────────────────────────────────────────────────────

    describe('generateLocalScenes 基础行为', () => {
        it('返回 4 张场景图', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            expect(scenes).toHaveLength(4)
        })

        it('场景顺序为 theme / imagery / poet / cultural', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            expect(scenes[0]!.sceneType).toBe('theme')
            expect(scenes[1]!.sceneType).toBe('imagery')
            expect(scenes[2]!.sceneType).toBe('poet')
            expect(scenes[3]!.sceneType).toBe('cultural')
        })

        it('每张场景图的 id 格式正确', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            expect(scenes[0]!.id).toBe('local-theme-poem-001')
            expect(scenes[1]!.id).toBe('local-imagery-poem-001')
            expect(scenes[2]!.id).toBe('local-poet-poem-001')
            expect(scenes[3]!.id).toBe('local-cultural-poem-001')
        })

        it('每张场景图的 poemId 与传入的 poemId 一致', () => {
            const scenes = generateLocalScenes('custom-poem-id', makePoem())
            for (const scene of scenes) {
                expect(scene.poemId).toBe('custom-poem-id')
            }
        })

        it('每张场景图的 title 包含诗题与场景类型', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ title: '静夜思' }))
            expect(scenes[0]!.title).toBe('静夜思·主题意境')
            expect(scenes[1]!.title).toBe('静夜思·核心意象')
            expect(scenes[2]!.title).toBe('静夜思·诗人境遇')
            expect(scenes[3]!.title).toBe('静夜思·文化常识')
        })

        it('每张场景图的 orientation 为 landscape', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                expect(scene.orientation).toBe('landscape')
            }
        })

        it('本地规则绘制场景不得冒充 AI 生成', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                expect(scene.aiGenerated).toBe(false)
            }
        })

        it('每张场景图的 createdAt 为数字（接近当前时间）', () => {
            const before = Date.now()
            const scenes = generateLocalScenes('poem-001', makePoem())
            const after = Date.now()
            for (const scene of scenes) {
                expect(typeof scene.createdAt).toBe('number')
                expect(scene.createdAt).toBeGreaterThanOrEqual(before)
                expect(scene.createdAt).toBeLessThanOrEqual(after)
            }
        })

        it('所有 4 张图的 createdAt 一致（同一调用内时间快照）', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            const first = scenes[0]!.createdAt
            for (const scene of scenes) {
                expect(scene.createdAt).toBe(first)
            }
        })
    })

    // ─────────────────────────────────────────────────────────
    // imageUrl 与 SVG 有效性
    // ─────────────────────────────────────────────────────────

    describe('imageUrl 与 SVG 有效性', () => {
        it('imageUrl 为 data:image/svg+xml;base64, 前缀', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                expect(scene.imageUrl).toMatch(/^data:image\/svg\+xml;base64,/)
            }
        })

        it('解码后的 SVG 以 <svg 开头', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                const svg = decodeDataUrl(scene.imageUrl)
                expect(svg.startsWith('<svg')).toBe(true)
            }
        })

        it('解码后的 SVG 以 </svg> 结尾', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                const svg = decodeDataUrl(scene.imageUrl)
                expect(svg.endsWith('</svg>')).toBe(true)
            }
        })

        it('SVG 含 xmlns 命名空间', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                const svg = decodeDataUrl(scene.imageUrl)
                expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
            }
        })

        it('SVG 含 viewBox="0 0 800 600"', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                const svg = decodeDataUrl(scene.imageUrl)
                expect(svg).toContain('viewBox="0 0 800 600"')
            }
        })

        it('SVG 含 preserveAspectRatio="xMidYMid meet"', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                const svg = decodeDataUrl(scene.imageUrl)
                expect(svg).toContain('preserveAspectRatio="xMidYMid meet"')
            }
        })

        it('SVG 含 font-family 定义', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                const svg = decodeDataUrl(scene.imageUrl)
                expect(svg).toContain('font-family=')
            }
        })

        it('每张 SVG 字节长度 ≤ 5KB（5120 字节）', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                const byteLen = inspectSceneByteLength(scene)
                expect(byteLen).toBeGreaterThan(0)
                expect(byteLen).toBeLessThanOrEqual(5120)
            }
        })
    })

    // ─────────────────────────────────────────────────────────
    // description 与 culturalMeaning
    // ─────────────────────────────────────────────────────────

    describe('description 与 culturalMeaning', () => {
        it('theme 场景的 description 包含主题词', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ theme: ['思乡'] }))
            expect(scenes[0]!.description).toContain('思乡')
        })

        it('theme 场景的 culturalMeaning 包含主题词与朝代', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ theme: ['思乡'], dynasty: '唐' }))
            expect(scenes[0]!.culturalMeaning).toContain('思乡')
            expect(scenes[0]!.culturalMeaning).toContain('唐')
        })

        it('imagery 场景的 description 包含意象名', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ images: ['月'] }))
            expect(scenes[1]!.description).toContain('月')
        })

        it('imagery 场景的 culturalMeaning 包含意象名', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ images: ['月'] }))
            expect(scenes[1]!.culturalMeaning).toContain('月')
        })

        it('poet 场景的 description 包含朝代与诗人', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ dynasty: '唐', poet: '李白' }))
            expect(scenes[2]!.description).toContain('唐')
            expect(scenes[2]!.description).toContain('李白')
        })

        it('poet 场景的 culturalMeaning 包含诗人与朝代', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ dynasty: '宋', poet: '苏轼' }))
            expect(scenes[2]!.culturalMeaning).toContain('苏轼')
            expect(scenes[2]!.culturalMeaning).toContain('宋')
        })

        it('cultural 场景的 description 包含朝代', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ dynasty: '唐' }))
            expect(scenes[3]!.description).toContain('唐')
        })

        it('cultural 场景的 culturalMeaning 包含朝代', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ dynasty: '汉' }))
            expect(scenes[3]!.culturalMeaning).toContain('汉')
        })
    })

    // ─────────────────────────────────────────────────────────
    // relatedVerse（首句提取）
    // ─────────────────────────────────────────────────────────

    describe('relatedVerse 首句提取', () => {
        it('多行 content 取首行作为 relatedVerse', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({
                content: '床前明月光，疑是地上霜。\n举头望明月，低头思故乡。',
            }))
            for (const scene of scenes) {
                expect(scene.relatedVerse).toBe('床前明月光，疑是地上霜。')
            }
        })

        it('单行 content 作为 relatedVerse', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({
                content: '春眠不觉晓',
            }))
            for (const scene of scenes) {
                expect(scene.relatedVerse).toBe('春眠不觉晓')
            }
        })

        it('空 content 时 relatedVerse 为空字符串', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ content: '' }))
            for (const scene of scenes) {
                expect(scene.relatedVerse).toBe('')
            }
        })

        it('undefined content 时 relatedVerse 为空字符串', () => {
            const poem = makePoem()
            delete poem.content
            const scenes = generateLocalScenes('poem-001', poem)
            for (const scene of scenes) {
                expect(scene.relatedVerse).toBe('')
            }
        })

        it('含 \r\n 换行符的首行提取', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({
                content: '白日依山尽\r\n黄河入海流',
            }))
            for (const scene of scenes) {
                expect(scene.relatedVerse).toBe('白日依山尽')
            }
        })

        it('仅含空白行的 content 跳过空白行取首个非空行', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({
                content: '\n\n实际首句',
            }))
            for (const scene of scenes) {
                expect(scene.relatedVerse).toBe('实际首句')
            }
        })
    })

    // ─────────────────────────────────────────────────────────
    // 默认值（空 theme/images）
    // ─────────────────────────────────────────────────────────

    describe('默认值（空 theme/images）', () => {
        it('空 theme 数组时使用 "诗境" 作为默认主题', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ theme: [] }))
            expect(scenes[0]!.description).toContain('诗境')
            expect(scenes[0]!.culturalMeaning).toContain('诗境')
        })

        it('空 images 数组时使用 "意境" 作为默认意象', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ images: [] }))
            expect(scenes[1]!.description).toContain('意境')
        })

        it('空 theme + 空 images 时仍生成 4 张有效 SVG', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ theme: [], images: [] }))
            expect(scenes).toHaveLength(4)
            for (const scene of scenes) {
                const svg = decodeDataUrl(scene.imageUrl)
                expect(svg.startsWith('<svg')).toBe(true)
                expect(svg.endsWith('</svg>')).toBe(true)
            }
        })
    })

    // ─────────────────────────────────────────────────────────
    // XML 特殊字符转义（escapeXml 间接验证）
    // ─────────────────────────────────────────────────────────

    describe('XML 特殊字符转义', () => {
        it('诗题含 & 时被转义为 &amp;', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ title: 'A&B' }))
            const svg = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg).toContain('A&amp;B')
            expect(svg).not.toContain('A&B')
        })

        it('诗题含 < 时被转义为 &lt;', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ title: 'A<B' }))
            const svg = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg).toContain('A&lt;B')
        })

        it('诗题含 > 时被转义为 &gt;', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ title: 'A>B' }))
            const svg = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg).toContain('A&gt;B')
        })

        it('诗题含 " 时被转义为 &quot;', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ title: 'A"B' }))
            const svg = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg).toContain('A&quot;B')
        })

        it("诗题含 ' 时被转义为 &apos;", () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ title: "A'B" }))
            const svg = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg).toContain('A&apos;B')
        })

        it('诗人名含特殊字符时被转义', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ poet: '李白<>&"' }))
            const svg = decodeDataUrl(scenes[2]!.imageUrl)
            expect(svg).toContain('李白&lt;&gt;&amp;&quot;')
        })
    })

    // ─────────────────────────────────────────────────────────
    // 主题视觉检测（detectThemeVisual 间接验证）
    // ─────────────────────────────────────────────────────────

    describe('主题视觉检测（detectThemeVisual）', () => {
        it('思乡/月 → 月夜场景', () => {
            const scenes = generateLocalScenes('p', makePoem({ theme: ['思乡'] }))
            const svg = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg).toContain('思乡望月')
        })

        it('山/登高 → 山水场景', () => {
            const scenes = generateLocalScenes('p', makePoem({ theme: ['登高望远'] }))
            const svg = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg).toContain('登高望远')
        })

        it('水/江/河 → 江河场景', () => {
            const scenes = generateLocalScenes('p', makePoem({ theme: ['江水'] }))
            const svg = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg).toContain('临水送别')
        })

        it('田/农 → 田园场景', () => {
            const scenes = generateLocalScenes('p', makePoem({ theme: ['田园'] }))
            const svg = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg).toContain('田园之乐')
        })

        it('边/塞 → 边塞场景', () => {
            const scenes = generateLocalScenes('p', makePoem({ theme: ['边塞'] }))
            const svg = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg).toContain('边塞苍凉')
        })

        it('花/春 → 春花场景', () => {
            const scenes = generateLocalScenes('p', makePoem({ theme: ['春花'] }))
            const svg = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg).toContain('春日芳菲')
        })

        it('雪/寒/冬 → 雪景场景', () => {
            const scenes = generateLocalScenes('p', makePoem({ theme: ['寒雪'] }))
            const svg = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg).toContain('寒江雪意')
        })

        it('未知主题 → 抽象场景', () => {
            const scenes = generateLocalScenes('p', makePoem({ theme: ['哲学'] }))
            const svg = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg).toContain('诗境悠远')
        })
    })

    // ─────────────────────────────────────────────────────────
    // 意象视觉检测（detectImageryVisual 间接验证）
    // ─────────────────────────────────────────────────────────

    describe('意象视觉检测（detectImageryVisual）', () => {
        it('月 → 明月', () => {
            const scenes = generateLocalScenes('p', makePoem({ images: ['明月'] }))
            const svg = decodeDataUrl(scenes[1]!.imageUrl)
            expect(svg).toContain('明月')
        })

        it('柳 → 杨柳', () => {
            const scenes = generateLocalScenes('p', makePoem({ images: ['柳条'] }))
            const svg = decodeDataUrl(scenes[1]!.imageUrl)
            expect(svg).toContain('杨柳')
        })

        it('雪 → 飞雪', () => {
            const scenes = generateLocalScenes('p', makePoem({ images: ['雪花'] }))
            const svg = decodeDataUrl(scenes[1]!.imageUrl)
            expect(svg).toContain('飞雪')
        })

        it('花/桃/梅 → 繁花', () => {
            const scenes = generateLocalScenes('p', makePoem({ images: ['桃花'] }))
            const svg = decodeDataUrl(scenes[1]!.imageUrl)
            expect(svg).toContain('繁花')
        })

        it('酒/杯 → 酒盏', () => {
            const scenes = generateLocalScenes('p', makePoem({ images: ['酒杯'] }))
            const svg = decodeDataUrl(scenes[1]!.imageUrl)
            expect(svg).toContain('酒盏')
        })

        it('鸟/雁 → 飞鸟', () => {
            const scenes = generateLocalScenes('p', makePoem({ images: ['大雁'] }))
            const svg = decodeDataUrl(scenes[1]!.imageUrl)
            expect(svg).toContain('飞鸟')
        })

        it('山/松 → 青山', () => {
            const scenes = generateLocalScenes('p', makePoem({ images: ['青山'] }))
            const svg = decodeDataUrl(scenes[1]!.imageUrl)
            expect(svg).toContain('青山')
        })

        it('未知意象 → 抽象', () => {
            const scenes = generateLocalScenes('p', makePoem({ images: ['石头'] }))
            const svg = decodeDataUrl(scenes[1]!.imageUrl)
            expect(svg).toContain('意象')
        })
    })

    // ─────────────────────────────────────────────────────────
    // inspectSceneByteLength
    // ─────────────────────────────────────────────────────────

    describe('inspectSceneByteLength', () => {
        it('返回正数（有效 SVG）', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                const len = inspectSceneByteLength(scene)
                expect(typeof len).toBe('number')
                expect(len).toBeGreaterThan(0)
            }
        })

        it('返回值与手动解码后 Buffer.byteLength 一致', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            const scene = scenes[0]!
            const prefix = 'data:image/svg+xml;base64,'
            const b64 = scene.imageUrl.slice(prefix.length)
            const svg = Buffer.from(b64, 'base64').toString('utf-8')
            const expected = Buffer.byteLength(svg, 'utf-8')

            expect(inspectSceneByteLength(scene)).toBe(expected)
        })

        it('非 data URL 前缀返回 -1', () => {
            const invalidScene: LocalSceneImage = {
                id: 'invalid',
                poemId: 'p',
                title: 't',
                imageUrl: 'https://example.com/image.png',
                description: 'd',
                culturalMeaning: 'cm',
                orientation: 'landscape',
                sceneType: 'theme',
                aiGenerated: false,
                createdAt: Date.now(),
            }
            expect(inspectSceneByteLength(invalidScene)).toBe(-1)
        })

        it('空字符串 imageUrl 返回 -1', () => {
            const invalidScene: LocalSceneImage = {
                id: 'invalid',
                poemId: 'p',
                title: 't',
                imageUrl: '',
                description: 'd',
                culturalMeaning: 'cm',
                orientation: 'landscape',
                sceneType: 'theme',
                aiGenerated: false,
                createdAt: Date.now(),
            }
            expect(inspectSceneByteLength(invalidScene)).toBe(-1)
        })

        it('UTF-8 字节长度（含中文）正确计算', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ title: '静夜思' }))
            const scene = scenes[0]!
            const len = inspectSceneByteLength(scene)
            expect(len).toBeGreaterThan(9)
        })
    })

    // ─────────────────────────────────────────────────────────
    // SVG 内容包含必备元素
    // ─────────────────────────────────────────────────────────

    describe('SVG 内容包含必备元素', () => {
        it('SVG 含渐变背景定义（linearGradient id="bg"）', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                const svg = decodeDataUrl(scene.imageUrl)
                expect(svg).toContain('id="bg"')
                expect(svg).toContain('linearGradient')
            }
        })

        it('SVG 含装饰条渐变（linearGradient id="acc"）', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                const svg = decodeDataUrl(scene.imageUrl)
                expect(svg).toContain('id="acc"')
            }
        })

        it('SVG 含暗角渐变（radialGradient id="vignette"）', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                const svg = decodeDataUrl(scene.imageUrl)
                expect(svg).toContain('id="vignette"')
                expect(svg).toContain('radialGradient')
            }
        })

        it('SVG 含 "演示配图" 角标', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            for (const scene of scenes) {
                const svg = decodeDataUrl(scene.imageUrl)
                expect(svg).toContain('演示配图')
            }
        })

        it('SVG 含诗题文本（已转义）', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ title: '静夜思' }))
            for (const scene of scenes) {
                const svg = decodeDataUrl(scene.imageUrl)
                expect(svg).toContain('静夜思')
            }
        })

        it('SVG 含副标题（场景类型说明）', () => {
            const scenes = generateLocalScenes('poem-001', makePoem())
            const svg0 = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg0).toContain('主题意境')
            const svg1 = decodeDataUrl(scenes[1]!.imageUrl)
            expect(svg1).toContain('核心意象')
            const svg2 = decodeDataUrl(scenes[2]!.imageUrl)
            expect(svg2).toContain('诗人境遇')
            const svg3 = decodeDataUrl(scenes[3]!.imageUrl)
            expect(svg3).toContain('文化常识')
        })

        it('SVG 含底部 footer 标注', () => {
            const scenes = generateLocalScenes('poem-001', makePoem({ dynasty: '唐', poet: '李白' }))
            const svg0 = decodeDataUrl(scenes[0]!.imageUrl)
            expect(svg0).toContain('唐')
            expect(svg0).toContain('李白')
        })
    })

    // ─────────────────────────────────────────────────────────
    // 不同 poemId 生成独立场景
    // ─────────────────────────────────────────────────────────

    describe('不同 poemId 生成独立场景', () => {
        it('不同 poemId 生成不同 id', () => {
            const scenes1 = generateLocalScenes('poem-A', makePoem())
            const scenes2 = generateLocalScenes('poem-B', makePoem())
            for (let i = 0; i < 4; i++) {
                expect(scenes1[i]!.id).not.toBe(scenes2[i]!.id)
            }
        })

        it('不同 poemId 的 poemId 字段不同', () => {
            const scenes1 = generateLocalScenes('poem-A', makePoem())
            const scenes2 = generateLocalScenes('poem-B', makePoem())
            for (let i = 0; i < 4; i++) {
                expect(scenes1[i]!.poemId).toBe('poem-A')
                expect(scenes2[i]!.poemId).toBe('poem-B')
            }
        })

        it('不同 poemId 的 SVG 内容应不同（id 嵌入 SVG 文本中）', () => {
            const scenes1 = generateLocalScenes('poem-A', makePoem({ title: '诗A' }))
            const scenes2 = generateLocalScenes('poem-B', makePoem({ title: '诗B' }))
            const svg1 = decodeDataUrl(scenes1[0]!.imageUrl)
            const svg2 = decodeDataUrl(scenes2[0]!.imageUrl)
            expect(svg1).not.toBe(svg2)
        })
    })
})
