import { memo, useId } from 'react'
import type { CSSProperties, ComponentType } from 'react'

/**
 * 古诗配图 SVG 插画集（SubTask 5.2.1 / 5.2.2）
 *
 * 视觉概念：为 20 首核心古诗生成主题化水墨风 SVG 插画
 * - 每首诗根据核心意象（月、柳、山、水、雪、舟等）渲染独特场景
 * - 全部使用设计 token + currentColor，严禁纯黑纯白、严禁 emoji
 * - 透明度驱动分层，呼应规范第 2 章
 * - 配合 PoemImage 组件标注"AI 生成"水印
 *
 * 场景类型：
 * - moon-night   月夜（静夜思、枫桥夜泊）
 * - spring-willow 春柳（咏柳、清明）
 * - waterfall     瀑布（望庐山瀑布、登鹳雀楼）
 * - river-boat    江舟（早发白帝城、赠汪伦、黄鹤楼送孟浩然之广陵、送元二使安西）
 * - snow          雪景（江雪）
 * - forest-mountain 山林（鹿柴、山居秋暝、寻隐者不遇）
 * - frontier      边塞（出塞、芙蓉楼送辛渐）
 * - birds-spring  鸟鸣春晓（春晓、绝句）
 * - festival      登高（九月九日忆山东兄弟）
 * - river-gate    天门山（望天门山）
 */
export interface PoemIllustrationProps {
    className?: string
    style?: CSSProperties
    width?: number | string
    height?: number | string
}

/* ============================================================
 * 场景类型定义
 * ============================================================ */
export type PoemSceneType =
    | 'moon-night'
    | 'spring-willow'
    | 'waterfall'
    | 'river-boat'
    | 'snow'
    | 'forest-mountain'
    | 'frontier'
    | 'birds-spring'
    | 'festival'
    | 'river-gate'
    | 'desert-smoke'
    | 'red-bean'
    | 'grassland'

/** 20 首核心古诗 -> 场景类型映射 */
export const POEM_SCENE_MAP: Record<string, PoemSceneType> = {
    'poem-jingyesi': 'moon-night',
    'poem-yongliu': 'spring-willow',
    'poem-chunxiao': 'birds-spring',
    'poem-wanglushanpubu': 'waterfall',
    'poem-dengguanquelou': 'waterfall',
    'poem-jueju': 'birds-spring',
    'poem-jiangxue': 'snow',
    'poem-xunyinzhebuyu': 'forest-mountain',
    'poem-fengqiaoyebo': 'moon-night',
    'poem-qingming': 'spring-willow',
    'poem-jiuyuejiuyi': 'festival',
    'poem-songyuanershianxi': 'river-boat',
    'poem-chusai': 'frontier',
    'poem-furonglousongxinjian': 'frontier',
    'poem-luzhai': 'forest-mountain',
    'poem-shanjuqiuming': 'forest-mountain',
    'poem-wangtianmenshan': 'river-gate',
    'poem-zaofabaidicheng': 'river-boat',
    'poem-zengwanglun': 'river-boat',
    'poem-huanghelousongmenghaoran': 'river-boat',
    'poem-shizhishang': 'desert-smoke',
    'poem-xiangsi': 'red-bean',
    'poem-chilege': 'grassland',
}

/* ============================================================
 * 共享 SVG 元素
 * ============================================================ */

/** 远山轮廓 —— 多层叠加，近浓远淡 */
function MountainLayers() {
    return (
        <g>
            {/* 最远山 —— 极淡 */}
            <path d="M0 110 L40 88 L80 100 L120 84 L160 96 L200 86 L240 104 L240 140 L0 140 Z"
                fill="rgb(var(--c-text-tertiary))" fillOpacity="0.10" />
            {/* 中山 —— 中淡 */}
            <path d="M0 122 L50 100 L90 114 L140 96 L180 110 L220 102 L240 118 L240 140 L0 140 Z"
                fill="rgb(var(--c-text-tertiary))" fillOpacity="0.18" />
            {/* 近山 —— 较浓 */}
            <path d="M0 132 L60 116 L110 128 L160 112 L210 124 L240 130 L240 140 L0 140 Z"
                fill="rgb(var(--c-text-tertiary))" fillOpacity="0.28" />
        </g>
    )
}

/** 水面波纹 —— 横向极淡线条 */
function WaterRipples({ y = 120 }: { y?: number }) {
    return (
        <g stroke="rgb(var(--c-accent-info))" strokeWidth="0.5" strokeOpacity="0.30" strokeLinecap="round" fill="none">
            <path d={`M10 ${y} L60 ${y}`} />
            <path d={`M80 ${y + 4} L130 ${y + 4}`} />
            <path d={`M150 ${y} L210 ${y}`} />
            <path d={`M30 ${y + 8} L90 ${y + 8}`} />
            <path d={`M160 ${y + 8} L220 ${y + 8}`} />
        </g>
    )
}

/** 留白题跋印章 —— 右下角小红印，体现水墨画意 */
function SealStamp() {
    return (
        <g>
            <rect x="214" y="124" width="10" height="10" rx="1"
                fill="rgb(var(--c-accent-error))" fillOpacity="0.55" />
            <text x="219" y="131" fontSize="5" fontFamily="var(--font-sans)" fontWeight="700"
                fill="rgb(var(--c-text-inverse))" textAnchor="middle" fillOpacity="0.9">诗</text>
        </g>
    )
}

/* ============================================================
 * 各场景 SVG
 * ============================================================ */

/** 月夜场景 —— 静夜思、枫桥夜泊 */
const MoonNightScene = memo(function MoonNightScene() {
    return (
        <>
            <defs>
                <radialGradient id="pr-poem-moon-glow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="rgb(var(--c-accent-warning))" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="rgb(var(--c-accent-warning))" stopOpacity="0" />
                </radialGradient>
            </defs>
            {/* 夜空底色 —— 极淡 info */}
            <rect x="0" y="0" width="240" height="140" fill="rgb(var(--c-accent-info))" fillOpacity="0.04" />
            {/* 月亮光晕 */}
            <circle cx="180" cy="42" r="28" fill="url(#pr-poem-moon-glow)" />
            {/* 月亮本体 */}
            <circle cx="180" cy="42" r="10" fill="rgb(var(--c-accent-warning))" fillOpacity="0.75" />
            <circle cx="183" cy="40" r="9" fill="rgb(var(--c-surface-primary))" fillOpacity="0.55" />
            {/* 床榻/建筑剪影 —— 极淡 */}
            <path d="M20 100 L20 80 L50 80 L50 100 Z M50 90 L70 90 L70 100"
                fill="rgb(var(--c-text-tertiary))" fillOpacity="0.16" />
            {/* 月光投影 —— 斜线 */}
            <g stroke="rgb(var(--c-accent-warning))" strokeWidth="0.6" strokeOpacity="0.18" strokeLinecap="round">
                <path d="M60 70 L100 110" />
                <path d="M70 68 L110 108" />
                <path d="M80 66 L120 106" />
            </g>
            {/* 远山 */}
            <MountainLayers />
            {/* 星点 */}
            <g fill="rgb(var(--c-accent-warning))" opacity="0.5">
                <circle cx="40" cy="24" r="0.8" />
                <circle cx="90" cy="18" r="0.6" />
                <circle cx="130" cy="30" r="0.7" />
                <circle cx="210" cy="20" r="0.6" />
            </g>
            <SealStamp />
        </>
    )
})

/** 春柳场景 —— 咏柳、清明 */
const SpringWillowScene = memo(function SpringWillowScene() {
    return (
        <>
            {/* 春意底色 —— 极淡 success */}
            <rect x="0" y="0" width="240" height="140" fill="rgb(var(--c-accent-success))" fillOpacity="0.03" />
            {/* 柳树主干 */}
            <path d="M60 140 Q58 100 62 70 Q60 50 64 30"
                stroke="rgb(var(--c-text-tertiary))" strokeWidth="2.5" fill="none"
                strokeOpacity="0.45" strokeLinecap="round" />
            {/* 柳枝 —— 下垂曲线 */}
            <g stroke="rgb(var(--c-accent-success))" strokeWidth="0.9" fill="none"
                strokeLinecap="round" opacity="0.55">
                <path d="M62 50 Q50 70 48 100" />
                <path d="M63 45 Q72 65 76 95" />
                <path d="M62 55 Q40 75 36 105" />
                <path d="M63 40 Q80 60 86 90" />
                <path d="M62 60 Q54 80 52 110" />
                <path d="M63 48 Q68 68 70 100" />
            </g>
            {/* 柳叶点缀 */}
            <g fill="rgb(var(--c-accent-success))" opacity="0.5">
                <ellipse cx="50" cy="78" rx="1.5" ry="0.6" transform="rotate(30 50 78)" />
                <ellipse cx="74" cy="82" rx="1.5" ry="0.6" transform="rotate(-20 74 82)" />
                <ellipse cx="44" cy="92" rx="1.5" ry="0.6" transform="rotate(40 44 92)" />
                <ellipse cx="80" cy="76" rx="1.5" ry="0.6" transform="rotate(-30 80 76)" />
            </g>
            {/* 飞燕 —— 春天意象 */}
            <g stroke="rgb(var(--c-text-tertiary))" strokeWidth="0.8" fill="none"
                strokeLinecap="round" opacity="0.5">
                <path d="M140 40 Q144 37 148 40 Q152 37 156 40" />
                <path d="M170 32 Q173 30 176 32 Q179 30 182 32" />
            </g>
            {/* 地面春草 */}
            <g stroke="rgb(var(--c-accent-success))" strokeWidth="0.6" strokeOpacity="0.4" strokeLinecap="round">
                <path d="M100 135 L102 128" />
                <path d="M108 135 L110 129" />
                <path d="M120 135 L122 127" />
                <path d="M150 135 L152 130" />
                <path d="M180 135 L182 128" />
            </g>
            <SealStamp />
        </>
    )
})

/** 瀑布场景 —— 望庐山瀑布、登鹳雀楼 */
const WaterfallScene = memo(function WaterfallScene() {
    const gradientId = useId().replace(/:/g, '')
    return (
        <>
            <defs>
                <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="rgb(var(--c-accent-info))" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="rgb(var(--c-accent-info))" stopOpacity="0.05" />
                </linearGradient>
            </defs>
            {/* 高山轮廓 —— 左右夹峙 */}
            <path d="M0 140 L0 60 L40 30 L70 50 L70 140 Z"
                fill="rgb(var(--c-text-tertiary))" fillOpacity="0.22" />
            <path d="M240 140 L240 50 L200 25 L170 45 L170 140 Z"
                fill="rgb(var(--c-text-tertiary))" fillOpacity="0.22" />
            {/* 瀑布 —— 中间垂直水流 */}
            <path d="M100 35 L100 120 L140 120 L140 35 Z"
                fill={`url(#${gradientId})`} />
            {/* 瀑布水线 */}
            <g stroke="rgb(var(--c-accent-info))" strokeWidth="0.6" strokeOpacity="0.45" strokeLinecap="round">
                <path d="M108 40 L108 115" />
                <path d="M116 38 L116 118" />
                <path d="M124 40 L124 115" />
                <path d="M132 38 L132 118" />
            </g>
            {/* 水花飞溅 */}
            <g fill="rgb(var(--c-accent-info))" opacity="0.4">
                <circle cx="96" cy="118" r="1.2" />
                <circle cx="146" cy="120" r="1" />
                <circle cx="104" cy="124" r="0.8" />
                <circle cx="138" cy="126" r="0.9" />
            </g>
            {/* 水雾 —— 底部模糊 */}
            <ellipse cx="120" cy="125" rx="30" ry="6"
                fill="rgb(var(--c-accent-info))" fillOpacity="0.10" />
            {/* 远处楼阁剪影 —— 登高意 */}
            <path d="M180 95 L180 80 L188 76 L196 80 L196 95 Z"
                fill="rgb(var(--c-accent-primary))" fillOpacity="0.20" />
            {/* 太阳/云 —— 顶部 */}
            <circle cx="50" cy="22" r="6" fill="rgb(var(--c-accent-warning))" fillOpacity="0.35" />
            <SealStamp />
        </>
    )
})

/** 江舟场景 —— 早发白帝城、赠汪伦、黄鹤楼送孟浩然之广陵、送元二使安西 */
const RiverBoatScene = memo(function RiverBoatScene() {
    return (
        <>
            {/* 天空底色 */}
            <rect x="0" y="0" width="240" height="80" fill="rgb(var(--c-accent-info))" fillOpacity="0.03" />
            {/* 远山 */}
            <path d="M0 85 L50 60 L100 75 L150 58 L200 72 L240 80 L240 90 L0 90 Z"
                fill="rgb(var(--c-text-tertiary))" fillOpacity="0.14" />
            {/* 水面 —— 占下半部分 */}
            <rect x="0" y="85" width="240" height="55" fill="rgb(var(--c-accent-info))" fillOpacity="0.06" />
            <WaterRipples y={100} />
            <WaterRipples y={115} />
            {/* 孤舟 —— 小船剪影 */}
            <g fill="rgb(var(--c-text-tertiary))" fillOpacity="0.45">
                <path d="M90 108 Q100 116 120 116 Q140 116 150 108 L146 106 L94 106 Z" />
                {/* 船篷 */}
                <path d="M104 106 Q112 98 128 98 Q136 98 140 106 Z" fillOpacity="0.55" />
                {/* 桅杆 */}
                <path d="M122 98 L122 86" stroke="rgb(var(--c-text-tertiary))" strokeWidth="0.8" opacity="0.4" fill="none" />
            </g>
            {/* 飞鸟 —— 远飞 */}
            <g stroke="rgb(var(--c-text-tertiary))" strokeWidth="0.7" fill="none"
                strokeLinecap="round" opacity="0.4">
                <path d="M180 35 Q184 32 188 35 Q192 32 196 35" />
                <path d="M60 28 Q63 26 66 28 Q69 26 72 28" />
            </g>
            {/* 岸边柳树/送别人影 —— 送别意 */}
            <g fill="rgb(var(--c-text-tertiary))" fillOpacity="0.30">
                <path d="M20 90 L20 75 L24 75 L24 90 Z" />
                <circle cx="22" cy="72" r="2.5" />
            </g>
            <SealStamp />
        </>
    )
})

/** 雪景 —— 江雪 */
const SnowScene = memo(function SnowScene() {
    return (
        <>
            {/* 寒空底色 —— 冷调 */}
            <rect x="0" y="0" width="240" height="140" fill="rgb(var(--c-accent-info))" fillOpacity="0.05" />
            {/* 雪山 —— 一片白茫茫 */}
            <path d="M0 100 L60 70 L120 90 L180 65 L240 95 L240 140 L0 140 Z"
                fill="rgb(var(--c-surface-secondary))" fillOpacity="0.55" />
            {/* 江面 —— 结冰 */}
            <rect x="0" y="100" width="240" height="40" fill="rgb(var(--c-surface-secondary))" fillOpacity="0.40" />
            {/* 孤舟 —— 寒江独钓 */}
            <g fill="rgb(var(--c-text-tertiary))" fillOpacity="0.50">
                <path d="M100 116 Q110 122 126 122 Q138 122 144 116 L140 114 L104 114 Z" />
            </g>
            {/* 钓鱼线 */}
            <path d="M122 114 L122 128" stroke="rgb(var(--c-text-tertiary))"
                strokeWidth="0.4" strokeOpacity="0.45" />
            {/* 渔翁蓑笠 */}
            <g fill="rgb(var(--c-text-tertiary))" fillOpacity="0.55">
                <ellipse cx="122" cy="108" rx="4" ry="2" />
                <path d="M118 110 Q122 104 126 110" />
            </g>
            {/* 雪花散落 */}
            <g fill="rgb(var(--c-text-inverse))" opacity="0.6">
                <circle cx="30" cy="20" r="0.9" />
                <circle cx="70" cy="35" r="0.7" />
                <circle cx="110" cy="15" r="0.8" />
                <circle cx="150" cy="40" r="0.7" />
                <circle cx="190" cy="20" r="0.9" />
                <circle cx="210" cy="50" r="0.6" />
                <circle cx="50" cy="55" r="0.6" />
                <circle cx="170" cy="60" r="0.7" />
                <circle cx="90" cy="45" r="0.5" />
                <circle cx="220" cy="30" r="0.6" />
            </g>
            {/* 千山鸟绝 —— 空旷寂寥 */}
            <SealStamp />
        </>
    )
})

/** 山林场景 —— 鹿柴、山居秋暝、寻隐者不遇 */
const ForestMountainScene = memo(function ForestMountainScene() {
    return (
        <>
            {/* 山林底色 —— 淡绿 */}
            <rect x="0" y="0" width="240" height="140" fill="rgb(var(--c-accent-success))" fillOpacity="0.03" />
            {/* 远山 */}
            <MountainLayers />
            {/* 松柏树林 —— 多株 */}
            <g>
                {/* 树1 */}
                <path d="M30 120 L30 90" stroke="rgb(var(--c-text-tertiary))" strokeWidth="1.5" strokeOpacity="0.4" />
                <path d="M22 95 L30 80 L38 95 Z" fill="rgb(var(--c-accent-success))" fillOpacity="0.30" />
                <path d="M24 88 L30 74 L36 88 Z" fill="rgb(var(--c-accent-success))" fillOpacity="0.35" />
                {/* 树2 */}
                <path d="M70 125 L70 88" stroke="rgb(var(--c-text-tertiary))" strokeWidth="1.5" strokeOpacity="0.4" />
                <path d="M61 92 L70 76 L79 92 Z" fill="rgb(var(--c-accent-success))" fillOpacity="0.32" />
                <path d="M63 84 L70 70 L77 84 Z" fill="rgb(var(--c-accent-success))" fillOpacity="0.38" />
                {/* 树3 */}
                <path d="M180 122 L180 85" stroke="rgb(var(--c-text-tertiary))" strokeWidth="1.5" strokeOpacity="0.4" />
                <path d="M172 90 L180 72 L188 90 Z" fill="rgb(var(--c-accent-success))" fillOpacity="0.30" />
                <path d="M174 82 L180 66 L186 82 Z" fill="rgb(var(--c-accent-success))" fillOpacity="0.36" />
                {/* 树4 */}
                <path d="M210 125 L210 92" stroke="rgb(var(--c-text-tertiary))" strokeWidth="1.4" strokeOpacity="0.38" />
                <path d="M203 96 L210 80 L217 96 Z" fill="rgb(var(--c-accent-success))" fillOpacity="0.28" />
            </g>
            {/* 山间小径 */}
            <path d="M100 135 Q110 120 105 105 Q100 90 115 80"
                stroke="rgb(var(--c-text-tertiary))" strokeWidth="0.8" strokeOpacity="0.25"
                fill="none" strokeDasharray="2 3" />
            {/* 隐者茅庐 */}
            <g fill="rgb(var(--c-accent-primary))" fillOpacity="0.22">
                <path d="M120 100 L120 88 L136 88 L136 100 Z" />
                <path d="M118 90 L128 80 L138 90 Z" fillOpacity="0.30" />
            </g>
            {/* 山雾 —— 留白意境 */}
            <ellipse cx="120" cy="78" rx="50" ry="8"
                fill="rgb(var(--c-surface-primary))" fillOpacity="0.40" />
            <SealStamp />
        </>
    )
})

/** 边塞场景 —— 出塞、芙蓉楼送辛渐 */
const FrontierScene = memo(function FrontierScene() {
    return (
        <>
            {/* 大漠底色 —— 暖黄 */}
            <rect x="0" y="0" width="240" height="140" fill="rgb(var(--c-accent-primary))" fillOpacity="0.04" />
            {/* 远处烽火台/关隘 */}
            <path d="M0 100 L0 70 L20 65 L40 72 L40 100 Z"
                fill="rgb(var(--c-text-tertiary))" fillOpacity="0.25" />
            <rect x="12" y="58" width="6" height="10" fill="rgb(var(--c-accent-error))" fillOpacity="0.30" />
            {/* 大漠地平线 */}
            <path d="M0 105 L240 105 L240 140 L0 140 Z"
                fill="rgb(var(--c-accent-primary))" fillOpacity="0.08" />
            {/* 沙丘起伏 */}
            <path d="M0 118 Q60 110 120 116 Q180 122 240 114 L240 140 L0 140 Z"
                fill="rgb(var(--c-accent-primary))" fillOpacity="0.10" />
            {/* 明月 —— 边塞冷月 */}
            <circle cx="200" cy="35" r="9" fill="rgb(var(--c-accent-warning))" fillOpacity="0.50" />
            <circle cx="203" cy="33" r="8" fill="rgb(var(--c-surface-primary))" fillOpacity="0.40" />
            {/* 孤雁 —— 远飞 */}
            <g stroke="rgb(var(--c-text-tertiary))" strokeWidth="0.8" fill="none"
                strokeLinecap="round" opacity="0.45">
                <path d="M150 25 Q154 22 158 25 Q162 22 166 25" />
            </g>
            {/* 城墙剪影 */}
            <g fill="rgb(var(--c-text-tertiary))" fillOpacity="0.30">
                <rect x="60" y="85" width="80" height="20" />
                <rect x="64" y="80" width="4" height="6" />
                <rect x="74" y="80" width="4" height="6" />
                <rect x="84" y="80" width="4" height="6" />
                <rect x="94" y="80" width="4" height="6" />
                <rect x="104" y="80" width="4" height="6" />
                <rect x="114" y="80" width="4" height="6" />
                <rect x="124" y="80" width="4" height="6" />
                <rect x="134" y="80" width="4" height="6" />
                {/* 城门 */}
                <path d="M95 105 L95 92 Q100 86 105 92 L105 105 Z" fillOpacity="0.15" />
            </g>
            <SealStamp />
        </>
    )
})

/** 鸟鸣春晓场景 —— 春晓、绝句 */
const BirdsSpringScene = memo(function BirdsSpringScene() {
    return (
        <>
            {/* 春意底色 */}
            <rect x="0" y="0" width="240" height="140" fill="rgb(var(--c-accent-success))" fillOpacity="0.04" />
            {/* 朝日 */}
            <circle cx="50" cy="30" r="8" fill="rgb(var(--c-accent-warning))" fillOpacity="0.35" />
            {/* 远山 */}
            <MountainLayers />
            {/* 花枝 —— 从左上斜出 */}
            <path d="M0 50 Q20 45 40 50 Q60 58 80 48"
                stroke="rgb(var(--c-text-tertiary))" strokeWidth="1.2" fill="none" strokeOpacity="0.40" />
            <path d="M40 50 Q48 40 56 30" stroke="rgb(var(--c-text-tertiary))" strokeWidth="1" fill="none" strokeOpacity="0.38" />
            {/* 花朵点缀 —— 含蓄 */}
            <g fill="rgb(var(--c-accent-primary))" opacity="0.55">
                <circle cx="28" cy="46" r="1.8" />
                <circle cx="52" cy="50" r="1.6" />
                <circle cx="48" cy="38" r="1.5" />
                <circle cx="56" cy="32" r="1.4" />
                <circle cx="66" cy="52" r="1.3" />
            </g>
            {/* 飞鸟 —— 两行黄鹂 */}
            <g stroke="rgb(var(--c-accent-primary))" strokeWidth="1" fill="none"
                strokeLinecap="round" opacity="0.65">
                <path d="M130 35 Q134 31 138 35 Q142 31 146 35" />
                <path d="M155 30 Q158 27 161 30 Q164 27 167 30" />
                <path d="M140 50 Q143 48 146 50 Q149 48 152 50" />
            </g>
            {/* 地面落花 —— 春晓落红意 */}
            <g fill="rgb(var(--c-accent-primary))" opacity="0.30">
                <circle cx="100" cy="132" r="1.2" />
                <circle cx="130" cy="134" r="1" />
                <circle cx="160" cy="132" r="1.1" />
                <circle cx="190" cy="135" r="0.9" />
            </g>
            {/* 春草 */}
            <g stroke="rgb(var(--c-accent-success))" strokeWidth="0.6" strokeOpacity="0.35" strokeLinecap="round">
                <path d="M90 135 L92 128" />
                <path d="M110 135 L112 129" />
                <path d="M140 135 L142 127" />
                <path d="M170 135 L172 130" />
            </g>
            <SealStamp />
        </>
    )
})

/** 登高场景 —— 九月九日忆山东兄弟 */
const FestivalScene = memo(function FestivalScene() {
    return (
        <>
            {/* 秋意底色 —— 淡黄 */}
            <rect x="0" y="0" width="240" height="140" fill="rgb(var(--c-accent-warning))" fillOpacity="0.04" />
            {/* 高山 —— 陡峭 */}
            <path d="M0 140 L0 60 L40 20 L80 50 L80 140 Z"
                fill="rgb(var(--c-text-tertiary))" fillOpacity="0.22" />
            <path d="M240 140 L240 50 L200 15 L160 45 L160 140 Z"
                fill="rgb(var(--c-text-tertiary))" fillOpacity="0.22" />
            {/* 山间登高小径 */}
            <path d="M120 135 Q130 110 120 90 Q110 70 130 50"
                stroke="rgb(var(--c-text-tertiary))" strokeWidth="0.8" strokeOpacity="0.30"
                fill="none" strokeDasharray="2 3" />
            {/* 登高人影 —— 山顶独立 */}
            <g fill="rgb(var(--c-text-tertiary))" fillOpacity="0.50">
                <circle cx="125" cy="40" r="2" />
                <path d="M124 42 L124 52 M122 48 L128 48 M124 52 L121 58 M124 52 L127 58"
                    stroke="rgb(var(--c-text-tertiary))" strokeWidth="0.8" strokeOpacity="0.50" fill="none" />
            </g>
            {/* 茱萸枝 —— 手持意象 */}
            <g stroke="rgb(var(--c-accent-success))" strokeWidth="0.7" strokeOpacity="0.45" fill="none">
                <path d="M127 44 L132 38" />
                <circle cx="132" cy="38" r="1" fill="rgb(var(--c-accent-success))" fillOpacity="0.5" />
                <circle cx="134" cy="36" r="0.8" fill="rgb(var(--c-accent-success))" fillOpacity="0.5" />
            </g>
            {/* 远处兄弟乡愁 —— 虚化村落 */}
            <g fill="rgb(var(--c-text-tertiary))" fillOpacity="0.12">
                <rect x="90" y="125" width="6" height="8" />
                <rect x="100" y="127" width="5" height="6" />
                <rect x="150" y="126" width="6" height="7" />
            </g>
            {/* 秋雁南飞 */}
            <g stroke="rgb(var(--c-text-tertiary))" strokeWidth="0.7" fill="none"
                strokeLinecap="round" opacity="0.4">
                <path d="M170 25 Q174 22 178 25 Q182 22 186 25" />
                <path d="M195 20 Q198 18 201 20 Q204 18 207 20" />
            </g>
            <SealStamp />
        </>
    )
})

/** 天门山场景 —— 望天门山 */
const RiverGateScene = memo(function RiverGateScene() {
    return (
        <>
            <defs>
                <linearGradient id="pr-poem-river" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="rgb(var(--c-accent-info))" stopOpacity="0.10" />
                    <stop offset="100%" stopColor="rgb(var(--c-accent-info))" stopOpacity="0.03" />
                </linearGradient>
            </defs>
            {/* 两岸青山夹江 —— 天门中断楚江开 */}
            <path d="M0 140 L0 40 L50 25 L80 45 L80 140 Z"
                fill="rgb(var(--c-text-tertiary))" fillOpacity="0.24" />
            <path d="M240 140 L240 35 L190 20 L160 40 L160 140 Z"
                fill="rgb(var(--c-text-tertiary))" fillOpacity="0.24" />
            {/* 江水 —— 中间贯穿 */}
            <path d="M80 60 L160 60 L160 140 L80 140 Z"
                fill="url(#pr-poem-river)" />
            <WaterRipples y={85} />
            <WaterRipples y={105} />
            <WaterRipples y={125} />
            {/* 孤帆 —— 一片日边来 */}
            <g fill="rgb(var(--c-accent-primary))" fillOpacity="0.50">
                <path d="M115 100 Q122 108 132 108 Q140 108 145 100 L142 98 L118 98 Z" />
                <path d="M128 98 L128 86" stroke="rgb(var(--c-text-tertiary))" strokeWidth="0.7" opacity="0.4" fill="none" />
                <path d="M128 88 L138 94 L128 94 Z" fillOpacity="0.40" />
            </g>
            {/* 太阳 —— 远处 */}
            <circle cx="120" cy="20" r="7" fill="rgb(var(--c-accent-warning))" fillOpacity="0.40" />
            {/* 回流旋涡 —— 楚江回旋 */}
            <g stroke="rgb(var(--c-accent-info))" strokeWidth="0.5" strokeOpacity="0.30" fill="none">
                <ellipse cx="100" cy="115" rx="8" ry="3" />
                <ellipse cx="140" cy="120" rx="6" ry="2.5" />
            </g>
            <SealStamp />
        </>
    )
})

/** 大漠孤烟场景 —— 使至塞上（大漠孤烟直，长河落日圆） */
const DesertSmokeScene = memo(function DesertSmokeScene() {
    return (
        <>
            <defs>
                <radialGradient id="pr-poem-desert-sun" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="rgb(var(--c-accent-warning))" stopOpacity="0.45" />
                    <stop offset="100%" stopColor="rgb(var(--c-accent-warning))" stopOpacity="0" />
                </radialGradient>
            </defs>
            {/* 大漠底色 —— 暖黄，浓淡渐变（surface-primary → text-primary alpha） */}
            <rect x="0" y="0" width="240" height="140" fill="rgb(var(--c-accent-primary))" fillOpacity="0.05" />
            {/* 长河落日 —— 圆日 + 光晕 */}
            <circle cx="178" cy="58" r="26" fill="url(#pr-poem-desert-sun)" />
            <circle cx="178" cy="58" r="11" fill="rgb(var(--c-accent-warning))" fillOpacity="0.55" />
            {/* 大漠地平线 —— 近浓远淡 */}
            <path d="M0 100 L240 100 L240 140 L0 140 Z"
                fill="rgb(var(--c-text-primary))" fillOpacity="0.06" />
            <path d="M0 112 Q60 106 120 112 Q180 118 240 110 L240 140 L0 140 Z"
                fill="rgb(var(--c-text-primary))" fillOpacity="0.09" />
            {/* 大漠孤烟直 —— 一柱垂直烟柱（核心意象） */}
            <rect x="78" y="40" width="3" height="62" rx="1.5"
                fill="rgb(var(--c-text-tertiary))" fillOpacity="0.32" />
            {/* 烟柱顶端飘散 */}
            <path d="M79 40 Q 82 34 78 28 Q 74 22 80 18"
                stroke="rgb(var(--c-text-tertiary))" strokeWidth="1.2" fill="none"
                strokeOpacity="0.22" strokeLinecap="round" />
            {/* 长河 —— 横贯水面 */}
            <path d="M0 104 L240 104 L240 116 L0 116 Z"
                fill="rgb(var(--c-accent-info))" fillOpacity="0.08" />
            <WaterRipples y={108} />
            {/* 远处商旅驼影 —— 极淡 */}
            <g fill="rgb(var(--c-text-primary))" fillOpacity="0.22">
                <path d="M30 98 L30 92 L33 92 L33 98 Z" />
                <circle cx="31.5" cy="90" r="1.5" />
                {/* 驼峰 */}
                <path d="M28 94 Q 31.5 88 35 94" stroke="rgb(var(--c-text-primary))" strokeWidth="0.6" fill="none" strokeOpacity="0.22" />
            </g>
            {/* 雁阵 —— 归雁 */}
            <g stroke="rgb(var(--c-text-tertiary))" strokeWidth="0.7" fill="none"
                strokeLinecap="round" opacity="0.4">
                <path d="M120 28 Q 124 25 128 28 Q 132 25 136 28" />
                <path d="M140 24 Q 143 22 146 24 Q 149 22 152 24" />
            </g>
            <SealStamp />
        </>
    )
})

/** 红豆相思场景 —— 相思（红豆生南国，春来发几枝） */
const RedBeanScene = memo(function RedBeanScene() {
    return (
        <>
            {/* 暖意底色 —— 极淡琥珀 */}
            <rect x="0" y="0" width="240" height="140" fill="rgb(var(--c-accent-primary))" fillOpacity="0.03" />
            {/* 相思树枝干 —— 从右下斜出 */}
            <path d="M220 130 Q 180 110 150 80 Q 120 50 90 30"
                stroke="rgb(var(--c-text-tertiary))" strokeWidth="2" fill="none"
                strokeOpacity="0.42" strokeLinecap="round" />
            {/* 细枝分叉 */}
            <path d="M150 80 Q 140 70 128 64"
                stroke="rgb(var(--c-text-tertiary))" strokeWidth="1.2" fill="none"
                strokeOpacity="0.36" strokeLinecap="round" />
            <path d="M120 50 Q 108 44 100 38"
                stroke="rgb(var(--c-text-tertiary))" strokeWidth="1" fill="none"
                strokeOpacity="0.32" strokeLinecap="round" />
            {/* 红豆 —— 朱砂红，核心意象（复用 accent-error 朱砂色） */}
            <g fill="rgb(var(--c-accent-error))">
                <ellipse cx="150" cy="80" rx="2.4" ry="3" fillOpacity="0.78" />
                <ellipse cx="128" cy="64" rx="2.2" ry="2.8" fillOpacity="0.72" />
                <ellipse cx="120" cy="50" rx="2.4" ry="3" fillOpacity="0.80" />
                <ellipse cx="100" cy="38" rx="2.2" ry="2.8" fillOpacity="0.74" />
                <ellipse cx="90" cy="30" rx="2" ry="2.6" fillOpacity="0.68" />
                <ellipse cx="162" cy="92" rx="2" ry="2.6" fillOpacity="0.66" />
            </g>
            {/* 红豆高光 —— 极小白点 */}
            <g fill="rgb(var(--c-surface-elevated))" opacity="0.6">
                <circle cx="149.5" cy="79" r="0.6" />
                <circle cx="119.5" cy="49" r="0.6" />
                <circle cx="127.5" cy="63" r="0.5" />
            </g>
            {/* 嫩叶 —— 春来发几枝 */}
            <g fill="rgb(var(--c-accent-success))" opacity="0.42">
                <ellipse cx="140" cy="72" rx="2" ry="0.8" transform="rotate(30 140 72)" />
                <ellipse cx="110" cy="44" rx="2" ry="0.8" transform="rotate(-20 110 44)" />
                <ellipse cx="158" cy="88" rx="2" ry="0.8" transform="rotate(40 158 88)" />
            </g>
            {/* 飘落红豆 —— 相思意 */}
            <g fill="rgb(var(--c-accent-error))" opacity="0.45">
                <circle cx="60" cy="80" r="1.4" />
                <circle cx="50" cy="105" r="1.2" />
                <circle cx="180" cy="118" r="1.1" />
            </g>
            <SealStamp />
        </>
    )
})

/** 草原敕勒场景 —— 敕勒歌（天似穹庐，风吹草低见牛羊） */
const GrasslandScene = memo(function GrasslandScene() {
    return (
        <>
            <defs>
                <linearGradient id="pr-poem-sky" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="rgb(var(--c-accent-info))" stopOpacity="0.08" />
                    <stop offset="100%" stopColor="rgb(var(--c-accent-info))" stopOpacity="0.02" />
                </linearGradient>
                <linearGradient id="pr-poem-grass" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="rgb(var(--c-accent-success))" stopOpacity="0.10" />
                    <stop offset="100%" stopColor="rgb(var(--c-accent-success))" stopOpacity="0.22" />
                </linearGradient>
            </defs>
            {/* 穹庐天空 —— 弧形穹顶 */}
            <path d="M0 0 L240 0 L240 80 Q 120 40 0 80 Z" fill="url(#pr-poem-sky)" />
            {/* 草原 —— 广袤绿野 */}
            <path d="M0 80 Q 120 60 240 80 L240 140 L0 140 Z" fill="url(#pr-poem-grass)" />
            {/* 远山 —— 阴山轮廓 */}
            <path d="M0 84 L40 70 L80 78 L130 66 L180 76 L220 70 L240 80 L240 86 L0 86 Z"
                fill="rgb(var(--c-text-tertiary))" fillOpacity="0.16" />
            {/* 草浪 —— 风吹草低（斜向线条） */}
            <g stroke="rgb(var(--c-accent-success))" strokeWidth="0.7" strokeOpacity="0.35" strokeLinecap="round" fill="none">
                <path d="M20 120 Q 30 112 40 118" />
                <path d="M60 128 Q 70 120 80 126" />
                <path d="M110 124 Q 120 116 130 122" />
                <path d="M160 130 Q 170 122 180 128" />
                <path d="M200 122 Q 210 114 220 120" />
            </g>
            {/* 牛羊 —— 风吹草低见牛羊（散点白影） */}
            <g fill="rgb(var(--c-text-inverse))" opacity="0.55">
                <ellipse cx="70" cy="116" rx="3" ry="2" />
                <circle cx="67" cy="114" r="1.2" />
                <ellipse cx="130" cy="120" rx="2.6" ry="1.8" />
                <circle cx="127.5" cy="118.5" r="1" />
                <ellipse cx="180" cy="118" rx="3" ry="2" />
                <circle cx="177" cy="116" r="1.2" />
                <ellipse cx="100" cy="126" rx="2.4" ry="1.6" />
            </g>
            {/* 蒙古包/穹庐 —— 远处 */}
            <g fill="rgb(var(--c-text-tertiary))" fillOpacity="0.20">
                <path d="M200 96 Q 210 86 220 96 Z" />
                <rect x="206" y="92" width="8" height="6" fillOpacity="0.12" />
            </g>
            {/* 飞鸟 —— 天苍苍野茫茫 */}
            <g stroke="rgb(var(--c-text-tertiary))" strokeWidth="0.7" fill="none"
                strokeLinecap="round" opacity="0.4">
                <path d="M50 30 Q 54 27 58 30 Q 62 27 66 30" />
                <path d="M150 22 Q 153 20 156 22 Q 159 20 162 22" />
            </g>
            <SealStamp />
        </>
    )
})

/* ============================================================
 * 场景注册表
 * ============================================================ */
const SCENE_COMPONENTS: Record<PoemSceneType, ComponentType> = {
    'moon-night': MoonNightScene,
    'spring-willow': SpringWillowScene,
    'waterfall': WaterfallScene,
    'river-boat': RiverBoatScene,
    'snow': SnowScene,
    'forest-mountain': ForestMountainScene,
    'frontier': FrontierScene,
    'birds-spring': BirdsSpringScene,
    'festival': FestivalScene,
    'river-gate': RiverGateScene,
    'desert-smoke': DesertSmokeScene,
    'red-bean': RedBeanScene,
    'grassland': GrasslandScene,
}

/* ============================================================
 * 主组件 —— 根据场景类型渲染对应 SVG
 * ============================================================ */
export interface PoemIllustrationSceneProps extends PoemIllustrationProps {
    /** 场景类型 */
    scene: PoemSceneType
}

export const PoemIllustration = memo(function PoemIllustration({
    className,
    style,
    width = '100%',
    height = 'auto',
    scene,
}: PoemIllustrationSceneProps) {
    const SceneComp = SCENE_COMPONENTS[scene] ?? MoonNightScene
    return (
        <svg
            className={className}
            style={style}
            width={width}
            height={height}
            viewBox="0 0 240 140"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label={`古诗配图：${scene}`}
        >
            {/* 宣纸底纹 —— 极淡暖色 */}
            <rect x="0" y="0" width="240" height="140" fill="rgb(var(--c-surface-primary))" />
            <rect x="0" y="0" width="240" height="140" fill="rgb(var(--c-surface-secondary))" fillOpacity="0.30" />
            <SceneComp />
        </svg>
    )
})

/** 根据诗 ID 获取对应场景的插画组件 */
export function getPoemIllustration(poemId: string): PoemSceneType {
    return POEM_SCENE_MAP[poemId] ?? 'moon-night'
}
