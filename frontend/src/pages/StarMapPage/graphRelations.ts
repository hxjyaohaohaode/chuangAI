import type { EdgeType, GraphEdge } from '@/lib/types'

export type RelationLens = 'all' | 'context' | 'image' | 'theme' | 'rhetoric' | 'resonance'

export const RELATION_LENSES: ReadonlyArray<{
    id: RelationLens
    label: string
    description: string
}> = [
    { id: 'all', label: '全部诗脉', description: '显示全部可验证关系' },
    { id: 'context', label: '人物与时代', description: '作者、师承、同时代与朝代' },
    { id: 'image', label: '意象流转', description: '诗篇使用或共享的意象' },
    { id: 'theme', label: '主题回声', description: '诗篇主题与共同母题' },
    { id: 'rhetoric', label: '修辞技法', description: '修辞使用与诗篇技法共鸣' },
    { id: 'resonance', label: '诗篇共鸣', description: '诗与诗之间有证据的关联' },
] as const

const LENS_TYPES: Record<Exclude<RelationLens, 'all'>, ReadonlySet<EdgeType>> = {
    context: new Set(['AUTHORED_BY', 'BELONGS_TO_ERA', 'MENTORS', 'CONTEMPORARY']),
    image: new Set(['USES_IMAGE', 'SHARES_IMAGE']),
    theme: new Set(['USES_THEME', 'SHARES_THEME']),
    rhetoric: new Set(['USES_RHETORIC', 'SHARES_RHETORIC']),
    resonance: new Set(['SHARES_IMAGE', 'SHARES_THEME', 'SHARES_RHETORIC']),
}

export function relationMatchesLens(edge: Pick<GraphEdge, 'type'>, lens: RelationLens): boolean {
    return lens === 'all' || LENS_TYPES[lens].has(edge.type)
}

/**
 * 浅色星图关系色 —— 存储对应 CSS 变量名（来自 tokens.css 的 accent 色）。
 *
 * 设计要点（规范第 2.4、10.2 章）：
 *  - 零硬编码 hex/rgba：所有色值引用 CSS 变量
 *  - 暖调一致：与系统 accent 色板语义统一（铜/琥珀/赤陶/苔绿/雾蓝）
 *  - 色盲安全：灰度模式下亮度差异 ≥ 15%，可区分
 *  - USES_X / SHARES_X 同语义不同方向，采用不同 accent 色增强可读性
 *
 * 使用方式：
 *  - SVG stroke / CSS background：`relationCss(type)` → `rgb(var(--c-accent-X))`
 *  - Canvas strokeStyle：`rgba(readCSSColor(relationVar(type)), alpha)`
 *  - THREE.Color：通过 readCSSColor + parseRGB 构造数值
 */
export const RELATION_COLORS: Record<EdgeType, string> = {
    AUTHORED_BY: '--c-accent-primary',
    BELONGS_TO_ERA: '--c-accent-info',
    MENTORS: '--c-accent-error',
    CONTEMPORARY: '--c-accent-warning',
    USES_IMAGE: '--c-accent-success',
    SHARES_IMAGE: '--c-accent-info',
    USES_THEME: '--c-accent-primary',
    SHARES_THEME: '--c-accent-warning',
    USES_RHETORIC: '--c-accent-info',
    SHARES_RHETORIC: '--c-accent-error',
    RELATED_TO: '--c-text-tertiary',
}

/** 取关系色的 CSS 变量名（用于 readCSSColor / css var() 引用） */
export function relationVar(type: EdgeType): string {
    return RELATION_COLORS[type] ?? '--c-text-tertiary'
}

/** 取关系色的 CSS 字符串形式 —— 适用于 SVG stroke / React style.background / canvas fillStyle */
export function relationCss(type: EdgeType, alpha: number = 1): string {
    const varName = relationVar(type)
    return alpha >= 1 ? `rgb(var(${varName}))` : `rgb(var(${varName}) / ${alpha})`
}

export function relationEvidence(edge: GraphEdge): string {
    if (edge.evidence?.length) return edge.evidence.join('、')
    if (edge.note) return edge.note
    switch (edge.type) {
        case 'AUTHORED_BY': return '作品作者信息'
        case 'BELONGS_TO_ERA': return '作品或人物朝代信息'
        case 'MENTORS': return '人工核验的诗学影响记录'
        case 'CONTEMPORARY': return '生卒年代与活动时期'
        case 'USES_IMAGE': return '诗篇文本中的意象标注'
        case 'USES_THEME': return '诗篇主题标注'
        case 'USES_RHETORIC': return '诗篇修辞标注'
        case 'SHARES_IMAGE': return '两首诗共享意象'
        case 'SHARES_THEME': return '两首诗共享主题'
        case 'SHARES_RHETORIC': return '两首诗共享修辞'
        default: return '知识库关联记录'
    }
}
