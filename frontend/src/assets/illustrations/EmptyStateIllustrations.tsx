import { memo } from 'react'
import type { CSSProperties } from 'react'

/**
 * Empty State 插画集（SubTask 5.3.1）
 *
 * 视觉概念：统一的"空白卷轴 + 淡墨意象"语言，各页面主题化点缀
 * - 共享基底：半卷卷轴 + 极淡星尘，象征"待填充的诗意空间"
 * - 每个页面主题化点缀不同元素（如 StarMap 加星点、Workbench 加笔触）
 * - 全部使用设计 token + currentColor，严禁纯黑纯白、严禁 emoji
 * - 透明度驱动分层，呼应规范第 2 章
 *
 * 用于 Dashboard / StarMap / Workbench / Grading / Classroom / AICopilot 等核心页面。
 */
export interface EmptyStateIllustrationProps {
    className?: string
    style?: CSSProperties
    width?: number | string
    height?: number | string
}

/* ============================================================
 * 共享基底组件 —— 半卷卷轴 + 极淡星尘
 * ============================================================ */

/** 卷轴基底 —— 所有 Empty State 共享的"空白卷轴"主形 */
const ScrollBase = memo(function ScrollBase() {
    return (
        <>
            {/* 卷轴主体 —— 圆角矩形，surface-secondary 透明叠加 */}
            <rect
                x="60"
                y="40"
                width="120"
                height="84"
                rx="6"
                fill="rgb(var(--c-surface-secondary))"
                fillOpacity="0.55"
                stroke="rgb(var(--c-text-tertiary))"
                strokeWidth="0.8"
                strokeOpacity="0.22"
            />
            {/* 卷轴左右轴 —— 圆柱端 */}
            <rect x="54" y="36" width="8" height="92" rx="4" fill="rgb(var(--c-accent-primary))" fillOpacity="0.22" />
            <rect x="178" y="36" width="8" height="92" rx="4" fill="rgb(var(--c-accent-primary))" fillOpacity="0.22" />
            {/* 卷轴内的留白行 —— 象征"待书写" */}
            <g stroke="rgb(var(--c-text-tertiary))" strokeWidth="0.6" strokeOpacity="0.20" strokeLinecap="round">
                <path d="M78 60 L150 60" />
                <path d="M78 72 L140 72" />
                <path d="M78 84 L146 84" />
                <path d="M78 96 L132 96" />
            </g>
        </>
    )
})

/** 极淡星尘 —— 散落点缀 */
const Dust = memo(function Dust() {
    return (
        <g fill="rgb(var(--c-text-tertiary))" opacity="0.4">
            <circle cx="36" cy="48" r="0.8" />
            <circle cx="204" cy="56" r="0.7" />
            <circle cx="40" cy="124" r="0.7" />
            <circle cx="200" cy="120" r="0.8" />
            <circle cx="28" cy="84" r="0.6" />
            <circle cx="212" cy="92" r="0.6" />
        </g>
    )
})

/* ============================================================
 * 各页面主题化 Empty State
 * ============================================================ */

/** 通用 Empty State —— 空白卷轴，无主题点缀 */
export const EmptyStateGeneric = memo(function EmptyStateGeneric({
    className, style, width = '100%', height = 'auto',
}: EmptyStateIllustrationProps) {
    return (
        <svg className={className} style={style} width={width} height={height}
            viewBox="0 0 240 160" fill="none" xmlns="http://www.w3.org/2000/svg"
            role="img" aria-label="暂无数据">
            <ScrollBase />
            <Dust />
        </svg>
    )
})

/** Dashboard 教学驾驶舱 —— 卷轴 + 仪表盘指针点缀 */
export const EmptyStateDashboard = memo(function EmptyStateDashboard({
    className, style, width = '100%', height = 'auto',
}: EmptyStateIllustrationProps) {
    return (
        <svg className={className} style={style} width={width} height={height}
            viewBox="0 0 240 160" fill="none" xmlns="http://www.w3.org/2000/svg"
            role="img" aria-label="教学驾驶舱暂无数据">
            <ScrollBase />
            <Dust />
            {/* 仪表盘弧线 —— accent-info */}
            <path d="M104 108 A 16 16 0 0 1 136 108" fill="none"
                stroke="rgb(var(--c-accent-info))" strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
            {/* 指针 */}
            <path d="M120 108 L128 96" stroke="rgb(var(--c-accent-primary))" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="120" cy="108" r="2" fill="rgb(var(--c-accent-primary))" />
        </svg>
    )
})

/** StarMap 诗脉星图 —— 卷轴 + 散落星点连线 */
export const EmptyStateStarMap = memo(function EmptyStateStarMap({
    className, style, width = '100%', height = 'auto',
}: EmptyStateIllustrationProps) {
    return (
        <svg className={className} style={style} width={width} height={height}
            viewBox="0 0 240 160" fill="none" xmlns="http://www.w3.org/2000/svg"
            role="img" aria-label="星图暂无节点">
            <ScrollBase />
            {/* 星点连线 —— 体现"待连接的知识图谱" */}
            <g stroke="rgb(var(--c-text-tertiary))" strokeWidth="0.6" strokeOpacity="0.3" strokeLinecap="round">
                <path d="M88 56 L112 64 L100 84" />
                <path d="M140 60 L156 76" />
            </g>
            <g fill="rgb(var(--c-accent-primary))">
                <circle cx="88" cy="56" r="2" opacity="0.7" />
                <circle cx="112" cy="64" r="1.6" opacity="0.55" />
                <circle cx="100" cy="84" r="1.8" opacity="0.6" />
                <circle cx="140" cy="60" r="1.6" opacity="0.55" />
                <circle cx="156" cy="76" r="2" opacity="0.7" />
            </g>
            <Dust />
        </svg>
    )
})

/** Workbench 命题工坊 —— 卷轴 + 毛笔笔触点缀 */
export const EmptyStateWorkbench = memo(function EmptyStateWorkbench({
    className, style, width = '100%', height = 'auto',
}: EmptyStateIllustrationProps) {
    return (
        <svg className={className} style={style} width={width} height={height}
            viewBox="0 0 240 160" fill="none" xmlns="http://www.w3.org/2000/svg"
            role="img" aria-label="命题工坊暂无题目">
            <ScrollBase />
            <Dust />
            {/* 毛笔 —— 斜置，accent-primary */}
            <g opacity="0.75">
                {/* 笔杆 */}
                <path d="M150 52 L168 34" stroke="rgb(var(--c-accent-primary))" strokeWidth="2" strokeLinecap="round" />
                {/* 笔锋 */}
                <path d="M150 52 L146 58" stroke="rgb(var(--c-accent-primary))" strokeWidth="2.4" strokeLinecap="round" />
                {/* 墨点 */}
                <circle cx="144" cy="60" r="1.6" fill="rgb(var(--c-accent-primary))" opacity="0.5" />
            </g>
        </svg>
    )
})

/** Grading 智能批改 —— 卷轴 + 批改勾选点缀 */
export const EmptyStateGrading = memo(function EmptyStateGrading({
    className, style, width = '100%', height = 'auto',
}: EmptyStateIllustrationProps) {
    return (
        <svg className={className} style={style} width={width} height={height}
            viewBox="0 0 240 160" fill="none" xmlns="http://www.w3.org/2000/svg"
            role="img" aria-label="批改队列为空">
            <ScrollBase />
            <Dust />
            {/* 批改勾 —— accent-success */}
            <path d="M148 56 L154 62 L164 50" fill="none"
                stroke="rgb(var(--c-accent-success))" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.8" />
        </svg>
    )
})

/** Classroom 课堂导播 —— 卷轴 + 涟漪点缀（象征课堂互动） */
export const EmptyStateClassroom = memo(function EmptyStateClassroom({
    className, style, width = '100%', height = 'auto',
}: EmptyStateIllustrationProps) {
    return (
        <svg className={className} style={style} width={width} height={height}
            viewBox="0 0 240 160" fill="none" xmlns="http://www.w3.org/2000/svg"
            role="img" aria-label="尚未开启课堂会话">
            <ScrollBase />
            <Dust />
            {/* 涟漪 —— 同心弧，象征课堂互动尚未开启 */}
            <g fill="none" stroke="rgb(var(--c-accent-primary))" strokeLinecap="round">
                <path d="M112 68 A 8 8 0 0 1 128 68" strokeWidth="1.2" opacity="0.7" />
                <path d="M106 64 A 14 14 0 0 1 134 64" strokeWidth="1" opacity="0.45" />
                <path d="M100 60 A 20 20 0 0 1 140 60" strokeWidth="0.8" opacity="0.25" />
            </g>
            <circle cx="120" cy="74" r="1.8" fill="rgb(var(--c-accent-primary))" opacity="0.7" />
        </svg>
    )
})

/** AICopilot AI 副驾 —— 卷轴 + 对话气泡点缀 */
export const EmptyStateAICopilot = memo(function EmptyStateAICopilot({
    className, style, width = '100%', height = 'auto',
}: EmptyStateIllustrationProps) {
    return (
        <svg className={className} style={style} width={width} height={height}
            viewBox="0 0 240 160" fill="none" xmlns="http://www.w3.org/2000/svg"
            role="img" aria-label="尚无对话，开始与 AI 副驾交流">
            <ScrollBase />
            <Dust />
            {/* 对话气泡 —— accent-info */}
            <path d="M140 50 Q140 44 146 44 L168 44 Q174 44 174 50 L174 62 Q174 68 168 68 L152 68 L146 74 L147 68 Q140 68 140 62 Z"
                fill="rgb(var(--c-accent-info))" fillOpacity="0.16"
                stroke="rgb(var(--c-accent-info))" strokeWidth="1" strokeOpacity="0.5" />
            {/* 气泡内的对话点 */}
            <g fill="rgb(var(--c-accent-info))" opacity="0.7">
                <circle cx="151" cy="56" r="1.4" />
                <circle cx="157" cy="56" r="1.4" />
                <circle cx="163" cy="56" r="1.4" />
            </g>
        </svg>
    )
})

/** Empty State 插画注册表 —— 按页面 key 索引 */
export const EMPTY_STATE_ILLUSTRATIONS = {
    generic: EmptyStateGeneric,
    dashboard: EmptyStateDashboard,
    starmap: EmptyStateStarMap,
    workbench: EmptyStateWorkbench,
    grading: EmptyStateGrading,
    classroom: EmptyStateClassroom,
    copilot: EmptyStateAICopilot,
} as const

export type EmptyStateKey = keyof typeof EMPTY_STATE_ILLUSTRATIONS
