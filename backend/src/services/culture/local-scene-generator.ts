/**
 * 本地 SVG 文化场景图库（P0-B 修复）
 *
 * 本地 SVG 文化场景图库，零外部 API 依赖。
 *
 * 设计目标：
 *  - 零外部依赖：纯函数生成 SVG，不调用任何 API
 *  - 同步生成：调用方无需 await
 *  - 视觉精美：暖调色板 + 渐变 + 几何图形 + 文字标注
 *  - 体量受限：每张 SVG ≤ 5KB，保证加载速度
 *  - 内容关联：每张 SVG 含诗题、意象、朝代、诗人等关联信息
 *  - 矢量无损：800x600 画布，任意缩放保持清晰
 *
 * 4 张 SVG 对应 4 个维度：
 *  1. theme-scene   诗的整体主题意境（思乡/山水/送别/田园/边塞等）
 *  2. imagery-scene  核心意象特写（月/柳/雪/花/酒等）
 *  3. poet-scene     诗人境遇（朝代背景 + 诗人剪影 + 书房案台）
 *  4. cultural-scene 文化常识（卷轴印章 + 朝代文化标注）
 *
 * 配色取自《界面设计规范.md》§2.2 暖调中性色 + §2.4 强调色，
 * 与前端 tokens.css 严格对齐，确保 SVG 视觉与系统整体气质一致。
 */

import type { PoemNode } from '../../agents/base/types.js'

// ─────────────────────────────────────────────────────────────
// 设计 token（取自界面设计规范.md §2.2 + §2.4）
// ─────────────────────────────────────────────────────────────

const C = {
    surfacePrimary: '#FAF8F5',
    surfaceSecondary: '#F5F1EC',
    surfaceTertiary: '#EDE8E2',
    accentPrimary: '#C5853B',
    accentPrimaryHover: '#B0752F',
    accentSuccess: '#5B8C5A',
    accentWarning: '#C5963C',
    accentInfo: '#5A8AA8',
    accentError: '#C1554F',
    textPrimary: '#2C241A',
    textSecondary: '#6B6258',
    textTertiary: '#9E968C',
    textInverse: '#FAF8F5',
} as const

// ─────────────────────────────────────────────────────────────
// 公共类型与导出
// ─────────────────────────────────────────────────────────────

/** 场景类型 */
export type SceneType = 'theme' | 'imagery' | 'poet' | 'cultural'

/** 本地场景图条目（与 CultureImage 字段对齐） */
export interface LocalSceneImage {
    id: string
    poemId: string
    /** 图片标题（如"静夜思·主题意境"） */
    title: string
    /** 图片 URL（SVG data URL，无网络依赖） */
    imageUrl: string
    /** 视觉描述 */
    description: string
    /** 文化内涵解读 */
    culturalMeaning: string
    /** 关联诗句 */
    relatedVerse?: string
    /** 图片方向 */
    orientation: 'landscape' | 'portrait'
    /** 场景类型标识 */
    sceneType: SceneType
    /** 本地规则绘制，不得冒充 AI 生成。 */
    aiGenerated: false
    createdAt: number
}

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────

/** XML 转义（防止诗题、诗人名等含特殊字符破坏 SVG） */
function escapeXml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
}

/** SVG 字符串转 data URL（base64 编码，对中文更紧凑） */
function svgToDataUrl(svg: string): string {
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf-8').toString('base64')}`
}

/** UTF-8 字节长度（用于 5KB 上限校验） */
function byteLength(s: string): number {
    return Buffer.byteLength(s, 'utf-8')
}

/** 从主题词推断场景视觉元素 */
interface ThemeVisual {
    /** 主图形类型 */
    shape: 'moon' | 'mountain' | 'river' | 'field' | 'frontier' | 'flower' | 'snow' | 'abstract'
    /** 中文标签（用于底部说明） */
    label: string
}

function detectThemeVisual(theme: string): ThemeVisual {
    if (/思乡|故园|归|乡|月/.test(theme)) return { shape: 'moon', label: '思乡望月' }
    if (/山|登高|峰|岭/.test(theme)) return { shape: 'mountain', label: '登高望远' }
    if (/水|江|河|海|舟|船/.test(theme)) return { shape: 'river', label: '临水送别' }
    if (/田|农|桑|稼/.test(theme)) return { shape: 'field', label: '田园之乐' }
    if (/边|塞|戍|征/.test(theme)) return { shape: 'frontier', label: '边塞苍凉' }
    if (/花|春|芳/.test(theme)) return { shape: 'flower', label: '春日芳菲' }
    if (/雪|寒|冬/.test(theme)) return { shape: 'snow', label: '寒江雪意' }
    return { shape: 'abstract', label: '诗境悠远' }
}

/** 从意象词推断意象视觉元素 */
interface ImageryVisual {
    shape: 'moon' | 'willow' | 'snow' | 'flower' | 'wine' | 'bird' | 'mountain' | 'abstract'
    label: string
}

function detectImageryVisual(imageName: string): ImageryVisual {
    if (/月/.test(imageName)) return { shape: 'moon', label: '明月' }
    if (/柳/.test(imageName)) return { shape: 'willow', label: '杨柳' }
    if (/雪/.test(imageName)) return { shape: 'snow', label: '飞雪' }
    if (/花|桃|梅|荷|杏/.test(imageName)) return { shape: 'flower', label: '繁花' }
    if (/酒|杯/.test(imageName)) return { shape: 'wine', label: '酒盏' }
    if (/鸟|雁|鹂|鹭|莺/.test(imageName)) return { shape: 'bird', label: '飞鸟' }
    if (/山|松|林/.test(imageName)) return { shape: 'mountain', label: '青山' }
    return { shape: 'abstract', label: '意象' }
}

// ─────────────────────────────────────────────────────────────
// SVG 公共骨架
// ─────────────────────────────────────────────────────────────

/** SVG 画布尺寸 */
const W = 800
const H = 600

interface SvgFrameOptions {
    /** 主体 SVG 内容（不含外层 <svg>） */
    body: string
    /** 标题（诗题） */
    title: string
    /** 副标题（场景类型说明） */
    subtitle: string
    /** 底部标注 */
    footer: string
    /** 主图形强调色（默认 accent-primary） */
    accent?: string
    /** 背景渐变起始色（默认 surface-primary） */
    bgFrom?: string
    /** 背景渐变终止色（默认 surface-secondary） */
    bgTo?: string
}

/**
 * 构建 SVG 外壳
 *
 * 结构：
 *  - 渐变背景（暖米色 → 暖灰）
 *  - 顶部装饰条（accent 色，alpha 20%）
 *  - 标题区（诗题 + 副标题）
 *  - 中心主图形（body 内容）
 *  - 底部 footer 标注
 *  - 右下角"演示配图"角标
 */
function buildSvgFrame(opts: SvgFrameOptions): string {
    const {
        body,
        title,
        subtitle,
        footer,
        accent = C.accentPrimary,
        bgFrom = C.surfacePrimary,
        bgTo = C.surfaceSecondary,
    } = opts

    const t = escapeXml(title)
    const st = escapeXml(subtitle)
    const ft = escapeXml(footer)

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" font-family="'Noto Sans SC','PingFang SC','Microsoft YaHei',system-ui,sans-serif">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="${bgFrom}"/>
<stop offset="1" stop-color="${bgTo}"/>
</linearGradient>
<linearGradient id="acc" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="${accent}" stop-opacity="0.18"/>
<stop offset="0.5" stop-color="${accent}" stop-opacity="0.45"/>
<stop offset="1" stop-color="${accent}" stop-opacity="0.18"/>
</linearGradient>
<radialGradient id="vignette" cx="0.5" cy="0.45" r="0.7">
<stop offset="0" stop-color="${C.textPrimary}" stop-opacity="0"/>
<stop offset="1" stop-color="${C.textPrimary}" stop-opacity="0.08"/>
</radialGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect x="0" y="0" width="${W}" height="6" fill="url(#acc)"/>
<rect width="${W}" height="${H}" fill="url(#vignette)"/>
<text x="40" y="56" font-size="32" font-weight="700" fill="${C.textPrimary}" letter-spacing="2">${t}</text>
<text x="40" y="86" font-size="15" font-weight="500" fill="${C.textSecondary}" letter-spacing="1">${st}</text>
${body}
<text x="40" y="${H - 36}" font-size="14" fill="${C.textSecondary}" letter-spacing="0.5">${ft}</text>
<g transform="translate(${W - 156},${H - 40})">
<rect width="120" height="26" rx="13" fill="${accent}" fill-opacity="0.12"/>
<circle cx="18" cy="13" r="3.5" fill="${accent}"/>
<text x="32" y="18" font-size="12" font-weight="500" fill="${accent}">演示配图</text>
</g>
</svg>`
}

// ─────────────────────────────────────────────────────────────
// 场景 1：主题意境
// ─────────────────────────────────────────────────────────────

function buildThemeScene(poem: PoemNode, theme: string): string {
    const v = detectThemeVisual(theme)
    const accent = C.accentPrimary
    const cx = W / 2
    const cy = H / 2 + 20

    // 根据主题类型绘制不同主图形
    let body = ''
    switch (v.shape) {
        case 'moon':
            // 月夜：圆月 + 远山 + 星点
            body = `<circle cx="${cx + 140}" cy="${cy - 60}" r="80" fill="${accent}" fill-opacity="0.85"/>
<circle cx="${cx + 140}" cy="${cy - 60}" r="80" fill="none" stroke="${C.textPrimary}" stroke-opacity="0.12" stroke-width="2"/>
<path d="M0,${H - 80} L160,${H - 200} L320,${H - 120} L480,${H - 240} L640,${H - 140} L800,${H - 180} L800,${H} L0,${H} Z" fill="${C.surfaceTertiary}" fill-opacity="0.7"/>
<g fill="${accent}" fill-opacity="0.5">
<circle cx="120" cy="180" r="1.8"/>
<circle cx="220" cy="140" r="1.5"/>
<circle cx="320" cy="200" r="1.6"/>
<circle cx="500" cy="150" r="1.4"/>
<circle cx="620" cy="190" r="1.7"/>
</g>`
            break
        case 'mountain':
            // 山水：层叠山峰
            body = `<path d="M0,${H - 80} L120,${H - 280} L240,${H - 160} L360,${H - 320} L480,${H - 200} L600,${H - 300} L720,${H - 180} L800,${H - 240} L800,${H} L0,${H} Z" fill="${accent}" fill-opacity="0.45"/>
<path d="M0,${H - 60} L140,${H - 200} L280,${H - 100} L420,${H - 220} L560,${H - 140} L700,${H - 200} L800,${H - 120} L800,${H} L0,${H} Z" fill="${C.surfaceTertiary}" fill-opacity="0.85"/>
<circle cx="${cx}" cy="${cy - 100}" r="42" fill="${accent}" fill-opacity="0.7"/>`
            break
        case 'river':
            // 江河：波浪线 + 小舟
            body = `<path d="M0,${cy + 20} Q200,${cy - 20} 400,${cy + 20} T800,${cy + 20}" fill="none" stroke="${accent}" stroke-width="3" stroke-opacity="0.6"/>
<path d="M0,${cy + 60} Q200,${cy + 20} 400,${cy + 60} T800,${cy + 60}" fill="none" stroke="${accent}" stroke-width="2" stroke-opacity="0.4"/>
<path d="M0,${cy + 100} Q200,${cy + 60} 400,${cy + 100} T800,${cy + 100}" fill="none" stroke="${accent}" stroke-width="2" stroke-opacity="0.3"/>
<g transform="translate(${cx - 50},${cy - 30})">
<path d="M0,20 Q50,40 100,20 L90,30 Q50,45 10,30 Z" fill="${C.textPrimary}" fill-opacity="0.7"/>
<line x1="50" y1="0" x2="50" y2="20" stroke="${C.textPrimary}" stroke-width="2"/>
<rect x="40" y="5" width="20" height="15" fill="${accent}" fill-opacity="0.5"/>
</g>`
            break
        case 'field':
            // 田园：田垄 + 远树
            body = `<path d="M0,${H - 60} L800,${H - 60}" stroke="${accent}" stroke-width="2" stroke-opacity="0.4"/>
<path d="M0,${H - 120} L800,${H - 120}" stroke="${accent}" stroke-width="2" stroke-opacity="0.3"/>
<path d="M0,${H - 180} L800,${H - 180}" stroke="${accent}" stroke-width="2" stroke-opacity="0.25"/>
<g fill="${accent}" fill-opacity="0.55">
<path d="M120,${H - 180} Q140,${H - 240} 160,${H - 180} Z"/>
<path d="M680,${H - 180} Q700,${H - 240} 720,${H - 180} Z"/>
</g>
<circle cx="${cx}" cy="${cy - 40}" r="36" fill="${accent}" fill-opacity="0.6"/>`
            break
        case 'frontier':
            // 边塞：烽火台 + 远山
            body = `<path d="M0,${H - 100} L200,${H - 220} L400,${H - 160} L600,${H - 240} L800,${H - 180} L800,${H} L0,${H} Z" fill="${C.surfaceTertiary}" fill-opacity="0.7"/>
<g transform="translate(${cx - 30},${H - 220})">
<rect x="0" y="0" width="60" height="80" fill="${C.textPrimary}" fill-opacity="0.75"/>
<rect x="-6" y="-10" width="72" height="14" fill="${accent}" fill-opacity="0.8"/>
<rect x="24" y="-30" width="12" height="20" fill="${accent}"/>
</g>`
            break
        case 'flower':
            // 春花：花瓣环
            body = `<g transform="translate(${cx},${cy})">
${Array.from({ length: 6 }, (_, i) => {
                const a = (i * 60 * Math.PI) / 180
                const x = Math.cos(a) * 70
                const y = Math.sin(a) * 70
                return `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="38" ry="22" transform="rotate(${i * 60} ${x.toFixed(1)} ${y.toFixed(1)})" fill="${accent}" fill-opacity="0.5"/>`
            }).join('')}
<circle r="22" fill="${accent}" fill-opacity="0.85"/>
</g>`
            break
        case 'snow':
            // 雪景：六角雪花
            body = `<g transform="translate(${cx},${cy})" stroke="${accent}" stroke-width="3" fill="none" stroke-opacity="0.7" stroke-linecap="round">
${Array.from({ length: 6 }, (_, i) => {
                const a = i * 60
                return `<line x1="0" y1="0" x2="0" y2="-90" transform="rotate(${a})"/>
<line x1="0" y1="-50" x2="-18" y2="-65" transform="rotate(${a})"/>
<line x1="0" y1="-50" x2="18" y2="-65" transform="rotate(${a})"/>
<line x1="0" y1="-75" x2="-12" y2="-85" transform="rotate(${a})"/>
<line x1="0" y1="-75" x2="12" y2="-85" transform="rotate(${a})"/>`
            }).join('')}
</g>
<g fill="${accent}" fill-opacity="0.4">
<circle cx="120" cy="160" r="2.5"/>
<circle cx="240" cy="220" r="2"/>
<circle cx="640" cy="180" r="2.5"/>
<circle cx="700" cy="240" r="2"/>
<circle cx="180" cy="380" r="2"/>
<circle cx="680" cy="400" r="2.5"/>
</g>`
            break
        case 'abstract':
        default:
            // 抽象意境：圆 + 弧线
            body = `<circle cx="${cx}" cy="${cy}" r="90" fill="none" stroke="${accent}" stroke-width="3" stroke-opacity="0.6"/>
<circle cx="${cx}" cy="${cy}" r="60" fill="${accent}" fill-opacity="0.4"/>
<path d="M${cx - 120},${cy + 40} Q${cx},${cy + 80} ${cx + 120},${cy + 40}" fill="none" stroke="${accent}" stroke-width="2" stroke-opacity="0.4"/>
<path d="M${cx - 100},${cy + 70} Q${cx},${cy + 110} ${cx + 100},${cy + 70}" fill="none" stroke="${accent}" stroke-width="2" stroke-opacity="0.3"/>`
            break
    }

    return buildSvgFrame({
        body,
        title: poem.title,
        subtitle: `主题意境 · ${v.label}`,
        footer: `${poem.dynasty} · ${poem.poet} 作 · 主题：${theme}`,
        accent,
    })
}

// ─────────────────────────────────────────────────────────────
// 场景 2：核心意象
// ─────────────────────────────────────────────────────────────

function buildImageryScene(poem: PoemNode, imageName: string): string {
    const v = detectImageryVisual(imageName)
    const accent = C.accentPrimary
    const cx = W / 2
    const cy = H / 2 + 20

    let body = ''
    switch (v.shape) {
        case 'moon':
            body = `<circle cx="${cx}" cy="${cy}" r="100" fill="${accent}" fill-opacity="0.18"/>
<circle cx="${cx}" cy="${cy}" r="80" fill="${accent}" fill-opacity="0.4"/>
<circle cx="${cx}" cy="${cy}" r="62" fill="${accent}" fill-opacity="0.85"/>
<circle cx="${cx - 18}" cy="${cy - 14}" r="10" fill="${C.surfaceTertiary}" fill-opacity="0.4"/>
<circle cx="${cx + 22}" cy="${cy + 8}" r="6" fill="${C.surfaceTertiary}" fill-opacity="0.3"/>`
            break
        case 'willow':
            // 柳条：曲线垂落
            body = `<g stroke="${accent}" stroke-width="3" fill="none" stroke-linecap="round" stroke-opacity="0.7">
${Array.from({ length: 7 }, (_, i) => {
                const x = cx - 120 + i * 40
                const sway = (i % 2 === 0 ? 12 : -8)
                return `<path d="M${x},${cy - 100} Q${x + sway},${cy} ${x + sway * 2},${cy + 110}"/>`
            }).join('')}
</g>
<rect x="${cx - 130}" y="${cy - 130}" width="260" height="8" fill="${C.textPrimary}" fill-opacity="0.6"/>`
            break
        case 'snow':
            body = `<g transform="translate(${cx},${cy})" stroke="${accent}" stroke-width="3" fill="none" stroke-opacity="0.75" stroke-linecap="round">
${Array.from({ length: 6 }, (_, i) => {
                const a = i * 60
                return `<line x1="0" y1="0" x2="0" y2="-100" transform="rotate(${a})"/>
<line x1="0" y1="-60" x2="-20" y2="-78" transform="rotate(${a})"/>
<line x1="0" y1="-60" x2="20" y2="-78" transform="rotate(${a})"/>`
            }).join('')}
</g>
<g fill="${accent}" fill-opacity="0.4">
<circle cx="140" cy="180" r="2.5"/>
<circle cx="240" cy="220" r="2"/>
<circle cx="640" cy="200" r="2.5"/>
<circle cx="700" cy="260" r="2"/>
</g>`
            break
        case 'flower':
            body = `<g transform="translate(${cx},${cy})">
${Array.from({ length: 8 }, (_, i) => {
                const a = (i * 45 * Math.PI) / 180
                const x = Math.cos(a) * 60
                const y = Math.sin(a) * 60
                return `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="38" ry="22" transform="rotate(${i * 45} ${x.toFixed(1)} ${y.toFixed(1)})" fill="${accent}" fill-opacity="0.45"/>`
            }).join('')}
<circle r="28" fill="${accent}" fill-opacity="0.9"/>
<circle r="14" fill="${C.surfaceTertiary}" fill-opacity="0.6"/>
</g>`
            break
        case 'wine':
            // 酒盏
            body = `<g transform="translate(${cx - 60},${cy - 50})">
<path d="M0,0 L120,0 L100,80 Q60,95 20,80 Z" fill="${accent}" fill-opacity="0.7"/>
<path d="M0,0 L120,0 L116,12 L4,12 Z" fill="${C.textPrimary}" fill-opacity="0.8"/>
<ellipse cx="60" cy="0" rx="60" ry="12" fill="${accent}" fill-opacity="0.5"/>
<ellipse cx="60" cy="0" rx="50" ry="9" fill="${accent}" fill-opacity="0.8"/>
<rect x="55" y="80" width="10" height="40" fill="${C.textPrimary}" fill-opacity="0.7"/>
<ellipse cx="60" cy="120" rx="40" ry="8" fill="${C.textPrimary}" fill-opacity="0.6"/>
</g>`
            break
        case 'bird':
            // 飞鸟群
            body = `<g fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round" stroke-opacity="0.8">
<path d="M${cx - 100},${cy - 40} Q${cx - 80},${cy - 60} ${cx - 60},${cy - 40} Q${cx - 40},${cy - 60} ${cx - 20},${cy - 40}"/>
<path d="M${cx + 20},${cy - 80} Q${cx + 40},${cy - 100} ${cx + 60},${cy - 80} Q${cx + 80},${cy - 100} ${cx + 100},${cy - 80}"/>
<path d="M${cx - 60},${cy + 20} Q${cx - 40},${cy + 0} ${cx - 20},${cy + 20} Q${cx},${cy + 0} ${cx + 20},${cy + 20}"/>
<path d="M${cx + 40},${cy + 60} Q${cx + 60},${cy + 40} ${cx + 80},${cy + 60} Q${cx + 100},${cy + 40} ${cx + 120},${cy + 60}"/>
</g>`
            break
        case 'mountain':
            body = `<path d="M${cx - 160},${cy + 100} L${cx - 80},${cy - 60} L${cx},${cy + 40} L${cx + 80},${cy - 100} L${cx + 160},${cy + 60} L${cx + 160},${cy + 120} L${cx - 160},${cy + 120} Z" fill="${accent}" fill-opacity="0.5"/>
<path d="M${cx - 80},${cy - 60} L${cx - 110},${cy + 0} L${cx - 50},${cy - 20} Z" fill="${C.surfacePrimary}" fill-opacity="0.7"/>
<path d="M${cx + 80},${cy - 100} L${cx + 50},${cy - 40} L${cx + 110},${cy - 60} Z" fill="${C.surfacePrimary}" fill-opacity="0.7"/>`
            break
        case 'abstract':
        default:
            body = `<circle cx="${cx}" cy="${cy}" r="80" fill="none" stroke="${accent}" stroke-width="3" stroke-opacity="0.6"/>
<circle cx="${cx}" cy="${cy}" r="50" fill="${accent}" fill-opacity="0.5"/>
<rect x="${cx - 30}" y="${cy - 30}" width="60" height="60" fill="none" stroke="${accent}" stroke-width="2" stroke-opacity="0.3" transform="rotate(45 ${cx} ${cy})"/>`
            break
    }

    return buildSvgFrame({
        body,
        title: poem.title,
        subtitle: `核心意象 · ${v.label}`,
        footer: `意象"${imageName}" · ${poem.dynasty}${poem.poet}诗中之意`,
        accent,
    })
}

// ─────────────────────────────────────────────────────────────
// 场景 3：诗人境遇
// ─────────────────────────────────────────────────────────────

function buildPoetScene(poem: PoemNode): string {
    const accent = C.accentInfo
    const cx = W / 2
    const cy = H / 2 + 30

    // 人物剪影：宽袍大袖侧坐案前
    const body = `<g transform="translate(${cx - 80},${cy - 100})">
<path d="M40,40 Q40,0 80,0 Q120,0 120,40 L120,80 Q120,110 100,120 L100,180 L60,180 L60,120 Q40,110 40,80 Z" fill="${C.textPrimary}" fill-opacity="0.8"/>
<circle cx="80" cy="-20" r="22" fill="${C.textPrimary}" fill-opacity="0.85"/>
<path d="M58,-32 Q80,-44 102,-32 L98,-22 Q80,-30 62,-22 Z" fill="${C.textPrimary}" fill-opacity="0.85"/>
</g>
<g transform="translate(${cx + 40},${cy + 60})">
<rect x="0" y="0" width="180" height="14" rx="2" fill="${accent}" fill-opacity="0.5"/>
<rect x="-8" y="14" width="196" height="6" fill="${C.textPrimary}" fill-opacity="0.6"/>
<rect x="20" y="-30" width="20" height="30" fill="${accent}" fill-opacity="0.4"/>
<rect x="50" y="-25" width="18" height="25" fill="${accent}" fill-opacity="0.55"/>
<rect x="78" y="-32" width="22" height="32" fill="${accent}" fill-opacity="0.45"/>
<rect x="110" y="-26" width="18" height="26" fill="${accent}" fill-opacity="0.5"/>
<rect x="140" y="-30" width="20" height="30" fill="${accent}" fill-opacity="0.6"/>
</g>
<g transform="translate(${cx - 140},${cy + 80})" fill="${accent}" fill-opacity="0.7">
<path d="M0,0 Q10,-8 20,0 Q30,-8 40,0 L40,8 L0,8 Z"/>
<rect x="-4" y="8" width="48" height="6" fill="${C.textPrimary}" fill-opacity="0.5"/>
</g>
<g transform="translate(${cx + 200},${cy + 110})" fill="${C.surfaceTertiary}" fill-opacity="0.6">
<rect x="0" y="0" width="60" height="80" rx="4"/>
<line x1="10" y1="20" x2="50" y2="20" stroke="${C.textPrimary}" stroke-opacity="0.3" stroke-width="1"/>
<line x1="10" y1="35" x2="50" y2="35" stroke="${C.textPrimary}" stroke-opacity="0.3" stroke-width="1"/>
<line x1="10" y1="50" x2="40" y2="50" stroke="${C.textPrimary}" stroke-opacity="0.3" stroke-width="1"/>
<line x1="10" y1="65" x2="45" y2="65" stroke="${C.textPrimary}" stroke-opacity="0.3" stroke-width="1"/>
</g>`

    return buildSvgFrame({
        body,
        title: poem.title,
        subtitle: '诗人境遇 · 伏案吟咏',
        footer: `${poem.dynasty} · ${poem.poet} · 创作此诗时之心境`,
        accent,
        bgFrom: C.surfacePrimary,
        bgTo: C.surfaceTertiary,
    })
}

// ─────────────────────────────────────────────────────────────
// 场景 4：文化常识
// ─────────────────────────────────────────────────────────────

function buildCulturalScene(poem: PoemNode): string {
    const accent = C.accentSuccess
    const cx = W / 2
    const cy = H / 2 + 10

    // 卷轴 + 印章 + 笔墨
    const body = `<g transform="translate(${cx - 180},${cy - 90})">
<rect x="0" y="0" width="360" height="20" rx="3" fill="${C.textPrimary}" fill-opacity="0.85"/>
<rect x="-12" y="-4" width="14" height="28" rx="4" fill="${accent}" fill-opacity="0.8"/>
<rect x="358" y="-4" width="14" height="28" rx="4" fill="${accent}" fill-opacity="0.8"/>
<rect x="0" y="20" width="360" height="160" fill="${C.surfacePrimary}" fill-opacity="0.9"/>
<rect x="0" y="180" width="360" height="14" fill="${C.textPrimary}" fill-opacity="0.7"/>
<g stroke="${C.textSecondary}" stroke-opacity="0.5" stroke-width="1.2">
<line x1="30" y1="50" x2="120" y2="50"/>
<line x1="30" y1="70" x2="160" y2="70"/>
<line x1="30" y1="90" x2="140" y2="90"/>
<line x1="30" y1="110" x2="170" y2="110"/>
<line x1="30" y1="130" x2="100" y2="130"/>
<line x1="30" y1="150" x2="150" y2="150"/>
<line x1="200" y1="50" x2="320" y2="50"/>
<line x1="200" y1="70" x2="300" y2="70"/>
<line x1="200" y1="90" x2="330" y2="90"/>
<line x1="200" y1="110" x2="290" y2="110"/>
<line x1="200" y1="130" x2="310" y2="130"/>
<line x1="200" y1="150" x2="280" y2="150"/>
</g>
</g>
<g transform="translate(${cx - 60},${cy + 130})">
<rect x="0" y="0" width="48" height="48" rx="4" fill="${C.accentError}" fill-opacity="0.85"/>
<text x="24" y="32" font-size="22" font-weight="700" fill="${C.textInverse}" text-anchor="middle" letter-spacing="2">诗</text>
</g>
<g transform="translate(${cx + 20},${cy + 130})" fill="${accent}" fill-opacity="0.85">
<rect x="0" y="40" width="22" height="60" rx="2"/>
<path d="M-4,30 L26,30 L22,40 L0,40 Z"/>
<rect x="-4" y="20" width="30" height="12" rx="2"/>
</g>
<g transform="translate(${cx + 90},${cy + 140})" fill="${C.textPrimary}" fill-opacity="0.7">
<ellipse cx="20" cy="35" rx="22" ry="8"/>
<ellipse cx="20" cy="20" rx="18" ry="6"/>
<ellipse cx="20" cy="8" rx="14" ry="5"/>
</g>`

    return buildSvgFrame({
        body,
        title: poem.title,
        subtitle: '文化常识 · 卷轴印章',
        footer: `${poem.dynasty}代文化 · 诗中所涉典章文物`,
        accent,
        bgFrom: C.surfaceSecondary,
        bgTo: C.surfaceTertiary,
    })
}

// ─────────────────────────────────────────────────────────────
// 主导出：生成 4 张 SVG 场景图
// ─────────────────────────────────────────────────────────────

/**
 * 为指定诗生成 4 张本地 SVG 文化场景图
 *
 * 同步函数，零外部依赖。
 * 输出顺序固定：theme / imagery / poet / cultural
 *
 * @param poemId  诗 ID
 * @param poem    PoemNode 上下文（含 title/poet/dynasty/theme/images）
 * @returns 4 张 LocalSceneImage
 */
export function generateLocalScenes(poemId: string, poem: PoemNode): LocalSceneImage[] {
    const now = Date.now()
    const theme = poem.theme[0] ?? '诗境'
    const imageName = poem.images[0] ?? '意境'

    // 提取关联诗句（首句）
    const verses = (poem.content ?? '').split(/\r?\n/).filter(Boolean)
    const firstVerse = verses[0] ?? ''

    const scenes: LocalSceneImage[] = [
        {
            id: `local-theme-${poemId}`,
            poemId,
            title: `${poem.title}·主题意境`,
            imageUrl: svgToDataUrl(buildThemeScene(poem, theme)),
            description: `以"${theme}"为题的视觉化呈现，展现《${poem.title}》的整体意境。`,
            culturalMeaning: `本图聚焦"${theme}"主题，呈现${poem.dynasty}诗学传统中此类意境的典型视觉表达。`,
            relatedVerse: firstVerse,
            orientation: 'landscape',
            sceneType: 'theme',
            aiGenerated: false,
            createdAt: now,
        },
        {
            id: `local-imagery-${poemId}`,
            poemId,
            title: `${poem.title}·核心意象`,
            imageUrl: svgToDataUrl(buildImageryScene(poem, imageName)),
            description: `诗中核心意象"${imageName}"的特写画面，承载本诗最浓缩的情感符号。`,
            culturalMeaning: `意象"${imageName}"在中国古典诗词中具有深厚的文化积淀，本图以矢量形式呈现其视觉特征。`,
            relatedVerse: firstVerse,
            orientation: 'landscape',
            sceneType: 'imagery',
            aiGenerated: false,
            createdAt: now,
        },
        {
            id: `local-poet-${poemId}`,
            poemId,
            title: `${poem.title}·诗人境遇`,
            imageUrl: svgToDataUrl(buildPoetScene(poem)),
            description: `${poem.dynasty}诗人${poem.poet}伏案吟咏之场景，再现创作此诗时之心境与生活。`,
            culturalMeaning: `${poem.poet}为${poem.dynasty}代代表诗人，其创作多源于切身境遇与文化传承。`,
            relatedVerse: firstVerse,
            orientation: 'landscape',
            sceneType: 'poet',
            aiGenerated: false,
            createdAt: now,
        },
        {
            id: `local-cultural-${poemId}`,
            poemId,
            title: `${poem.title}·文化常识`,
            imageUrl: svgToDataUrl(buildCulturalScene(poem)),
            description: `${poem.dynasty}代文化场景，含卷轴、印章、笔墨等典型文化符号。`,
            culturalMeaning: `本图汇集${poem.dynasty}代文人书房陈设与文化器物，为本诗提供文化背景参照。`,
            relatedVerse: firstVerse,
            orientation: 'landscape',
            sceneType: 'cultural',
            aiGenerated: false,
            createdAt: now,
        },
    ]

    return scenes
}

// ─────────────────────────────────────────────────────────────
// 体积自检（开发期使用，可在测试中调用）
// ─────────────────────────────────────────────────────────────

/**
 * 检查单张 SVG 字符串字节长度是否在阈值内
 * @returns 字节长度
 */
export function inspectSceneByteLength(scene: LocalSceneImage): number {
    // data URL 中 base64 部分
    const prefix = 'data:image/svg+xml;base64,'
    if (!scene.imageUrl.startsWith(prefix)) return -1
    const b64 = scene.imageUrl.slice(prefix.length)
    const svg = Buffer.from(b64, 'base64').toString('utf-8')
    return byteLength(svg)
}
