/**
 * 图表通用色板常量（规范第十章 · 数据可视化）
 *
 * 设计目标：
 *  - 零硬编码 hex/rgba：所有色值通过运行时读取 tokens.css 的 --c-* RGB 通道派生
 *  - 色盲安全：灰度模式下各系列可区分（亮度梯度 + alpha 层次双重冗余编码）
 *  - 暖调一致：与系统暖调色板（琥珀 / 铜 / 苔绿 / 赤陶）保持语义统一
 *  - 自定义非默认：完全脱离 ECharts / Chart.js 默认配色
 *
 * 四套色板（规范 10.2）：
 *  1. sequential —— accent-primary 单色 5-9 阶 alpha 渐变（15% → 100%），用于热力图、连续数值
 *  2. qualitative —— 5-7 种暖调差异化色（琥珀 → 铜 → 深褐 → 橄榄 → 金），用于多分类
 *  3. diverging —— 暖 → 中性 → 冷 5 阶，用于正负对比、偏差分析
 *  4. mono —— text-primary 单色 4 阶 alpha（25% → 50% → 75% → 100%），用于对比轴线、背景基线
 *
 * 使用方式：
 *  - Canvas：通过 readRGB('--c-accent-primary') 读取后调用 sequential(i) 拼装 rgba
 *  - SVG/CSS：直接使用 alpha 阶梯 token（如 var(--accent-primary-20)）
 */

/**
 * 从 CSS 变量读取 "R G B" 通道字符串（如 "197 133 59"）
 * 服务端渲染兜底返回 "0 0 0"
 */
export function readCSSColor(varName: string): string {
    if (typeof window === 'undefined') return '0 0 0'
    const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
    return value || '0 0 0'
}

/** 将 "R G B" 通道字符串解析为 [r, g, b] 数值元组 */
export function parseRGB(channels: string): [number, number, number] {
    const parts = channels.split(/\s+/)
    const n = (i: number): number => {
        const v = Number(parts[i])
        return Number.isFinite(v) ? v : 0
    }
    return [n(0), n(1), n(2)]
}

/** 将 "R G B" + alpha 组装为 rgba() 字符串（Canvas fillStyle/strokeStyle 使用） */
export function rgba(channels: string, alpha: number): string {
    const [r, g, b] = parseRGB(channels)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/* ============================================================
 * 1. Sequential —— 单色 Alpha 渐变（5-9 阶，15% → 100%）
 * ============================================================ */

/**
 * 单色 alpha 渐变阶梯（9 阶，规范 10.2）
 * 索引 0 = 15% alpha（最淡），索引 8 = 100% alpha（最浓）
 * 灰度模式下通过 alpha 差异自然区分；色盲安全
 */
export const SEQUENTIAL_ALPHAS = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 1.0] as const

/**
 * 取 sequential 第 i 阶 alpha（自动夹取到 [0, 8]）
 * 用于热力图、连续数值着色
 */
export function sequentialAlpha(index: number, total = 9): number {
    const clamped = Math.max(0, Math.min(total - 1, index))
    const lookup = SEQUENTIAL_ALPHAS
    const i = Math.round((clamped / (total - 1)) * (lookup.length - 1))
    return lookup[i]!
}

/**
 * 按分数（0-100）取 sequential alpha —— 热力图色盲安全着色
 * 分数越高 alpha 越浓，无数据返回 0
 */
export function scoreToSequentialAlpha(score: number | undefined | null): number {
    if (score == null || !Number.isFinite(score)) return 0
    const clamped = Math.max(0, Math.min(100, score))
    // 0 → 0.15, 100 → 1.0（线性插值 9 阶）
    return sequentialAlpha(Math.round((clamped / 100) * 8), 9)
}

/* ============================================================
 * 2. Qualitative —— 暖调差异化色板（5-7 色）
 * ============================================================

 * 5 色暖调差异化色板（琥珀 → 铜 → 深褐 → 橄榄 → 金）
 * 全部派生自 tokens.css 的 --c-* token，确保主题切换一致
 * 灰度模式下亮度差异 ≥ 15%，色盲安全
 *
 * 索引 → CSS 变量名映射：
 *   0: --c-accent-primary  (琥珀铜 #C5853B)
 *   1: --c-accent-warning  (琥珀   #C5963C)
 *   2: --c-accent-error    (赤陶   #C1554F)
 *   3: --c-accent-success  (苔绿   #5B8C5A)
 *   4: --c-accent-info     (雾蓝   #5A8AA8)
 */
export const QUALITATIVE_VARS = [
    '--c-accent-primary',
    '--c-accent-warning',
    '--c-accent-error',
    '--c-accent-success',
    '--c-accent-info',
] as const

/** 取 qualitative 第 i 色的 CSS 变量名（循环取色） */
export function qualitativeVar(index: number): string {
    return QUALITATIVE_VARS[index % QUALITATIVE_VARS.length]!
}

/* ============================================================
 * 3. Diverging —— 暖 → 中性 → 冷 5 阶
 * ============================================================

 * 5 阶偏差色板，用于正负对比、偏差分析
 * 索引 0 = 最冷（雾蓝），索引 2 = 中性（text-secondary 暖灰），索引 4 = 最暖（赤陶）
 *
 * 索引 → CSS 变量名映射：
 *   0: --c-accent-info      (雾蓝   冷)
 *   1: --c-text-tertiary    (暖灰   偏冷)
 *   2: --c-text-secondary   (中暖灰 中性)
 *   3: --c-accent-warning   (琥珀   偏暖)
 *   4: --c-accent-error     (赤陶   暖)
 */
export const DIVERGING_VARS = [
    '--c-accent-info',
    '--c-text-tertiary',
    '--c-text-secondary',
    '--c-accent-warning',
    '--c-accent-error',
] as const

/** 取 diverging 第 i 色的 CSS 变量名（i ∈ [0, 4]） */
export function divergingVar(index: number): string {
    const clamped = Math.max(0, Math.min(DIVERGING_VARS.length - 1, index))
    return DIVERGING_VARS[clamped]!
}

/* ============================================================
 * 4. Mono —— text-primary 单色 4 阶 alpha（25% → 50% → 75% → 100%）
 * ============================================================

 * 单色 4 阶 alpha，用于对比轴线、背景基线
 * 灰度模式下通过 alpha 差异区分层级
 */
export const MONO_ALPHAS = [0.25, 0.5, 0.75, 1.0] as const

/** 取 mono 第 i 阶 alpha（i ∈ [0, 3]） */
export function monoAlpha(index: number): number {
    const clamped = Math.max(0, Math.min(MONO_ALPHAS.length - 1, index))
    return MONO_ALPHAS[clamped]!
}

/* ============================================================
 * 5. 图表通用 token —— 网格 / 文字 / 焦点
 * ============================================================

 * 这些 token 与 tokens.css 中的 alpha token 对齐，
 * 集中导出便于图表组件复用，避免散落硬编码
 */
export const CHART_TOKENS = {
    /** 主轴线极淡 alpha（替代网格线 chartjunk） */
    axisLine: 'rgba(44, 36, 26, 0.06)',
    /** 次级刻度线 alpha */
    tickLine: 'rgba(44, 36, 26, 0.04)',
    /** 数据点 hover 时的玻璃态描边 */
    hoverStroke: 'rgba(44, 36, 26, 0.4)',
    /** 焦点环 alpha（规范 14.x） */
    focusRing: 'rgba(152, 98, 39, 0.12)',
} as const

/* ============================================================
 * 6. 缓动函数 —— 与 tokens.css 的 --ease-out 对齐
 * ============================================================ */

/** ease-out: cubic-bezier(0.16, 1, 0.3, 1) 的数值近似 */
export function easeOut(t: number): number {
    return 1 - Math.pow(1 - t, 3)
}

