/**
 * 诗词意境 SVG 插画体系（视觉创新层 3/4）
 *
 * 在既有 src/assets/illustrations/PoemIllustrations.tsx 基础上扩展：
 * - 复用 13 种场景插画（含本次新增的大漠孤烟/红豆相思/草原敕勒）
 * - 提供 <PoemScene poem="静夜思" size="md" /> 中文诗名直查接口
 * - 支持三档尺寸：sm(64) / md(128) / lg(256)
 * - 纯 SVG 手绘，零外部图片依赖
 *
 * 设计规范合规：
 * - 暖调色板（surface-primary → text-primary 的 alpha 渐变），零硬编码
 * - 透明度驱动分层（规范 2.x）
 * - 8 幅核心诗意境覆盖：静夜思/望庐山瀑布/春晓/使至塞上/江雪/相思/登鹳雀楼/敕勒歌
 */

import { memo } from 'react'
import type { CSSProperties } from 'react'
import {
    PoemIllustration,
    type PoemSceneType,
} from '@/assets/illustrations/PoemIllustrations'
import { cn } from '@/lib/cn'

/* ============================================================
 * 中文诗名 → 场景类型映射
 * 覆盖任务要求的 8 首经典诗 + 若干扩展
 * ============================================================ */
export const POEM_NAME_SCENE_MAP: Record<string, PoemSceneType> = {
    // 8 首核心诗
    '静夜思': 'moon-night',
    '望庐山瀑布': 'waterfall',
    '春晓': 'birds-spring',
    '使至塞上': 'desert-smoke',
    '江雪': 'snow',
    '相思': 'red-bean',
    '登鹳雀楼': 'waterfall',
    '敕勒歌': 'grassland',
    // 扩展诗（复用既有场景）
    '枫桥夜泊': 'moon-night',
    '咏柳': 'spring-willow',
    '清明': 'spring-willow',
    '绝句': 'birds-spring',
    '鹿柴': 'forest-mountain',
    '山居秋暝': 'forest-mountain',
    '寻隐者不遇': 'forest-mountain',
    '出塞': 'frontier',
    '芙蓉楼送辛渐': 'frontier',
    '九月九日忆山东兄弟': 'festival',
    '望天门山': 'river-gate',
    '早发白帝城': 'river-boat',
    '赠汪伦': 'river-boat',
    '黄鹤楼送孟浩然之广陵': 'river-boat',
    '送元二使安西': 'river-boat',
}

/* ============================================================
 * 尺寸定义 —— sm(64) / md(128) / lg(256)
 * ============================================================ */
export type PoemSceneSize = 'sm' | 'md' | 'lg'

const SIZE_PX: Record<PoemSceneSize, number> = {
    sm: 64,
    md: 128,
    lg: 256,
}

/* ============================================================
 * PoemScene —— 中文诗名直查插画组件
 * ============================================================ */
export interface PoemSceneProps {
    /** 中文诗名（如"静夜思"），未匹配时回退到月夜场景 */
    poem: string
    /** 尺寸，默认 md(128) */
    size?: PoemSceneSize
    /** 自定义宽度（覆盖 size），高度按 140/240 比例自适应 */
    width?: number | string
    /** 额外 className */
    className?: string
    /** 额外 style */
    style?: CSSProperties
}

export const PoemScene = memo(function PoemScene({
    poem,
    size = 'md',
    width,
    className,
    style,
}: PoemSceneProps) {
    const scene = POEM_NAME_SCENE_MAP[poem] ?? 'moon-night'
    const px = SIZE_PX[size]
    // viewBox 比例 240:140，高度按比例计算
    const w = width ?? px
    const h = typeof w === 'number' ? (w * 140) / 240 : 'auto'

    return (
        <div
            className={cn('pr-poem-scene', className)}
            style={{
                width: typeof w === 'number' ? `${w}px` : w,
                height: typeof h === 'number' ? `${h}px` : h,
                borderRadius: 'var(--radius-sm)',
                overflow: 'hidden',
                ...style,
            }}
            role="img"
            aria-label={`《${poem}》意境插画`}
        >
            <PoemIllustration scene={scene} width="100%" height="100%" />
        </div>
    )
})

/* ============================================================
 * 辅助导出 —— 便于外部按诗名取场景类型
 * ============================================================ */
export function getPoemSceneByName(poemName: string): PoemSceneType {
    return POEM_NAME_SCENE_MAP[poemName] ?? 'moon-night'
}

export { PoemIllustration, type PoemSceneType } from '@/assets/illustrations/PoemIllustrations'
