/**
 * 节点形状辅助 —— 统一 SVG path 与 Canvas 绘制
 *
 * 六种节点形状（规范 spec）：
 *   Poem=圆 / Poet=方 / Image=菱形 / Theme=六边形 / Era=三角形 / Rhetoric=星形
 *
 * 全部以原点 (0,0) 为中心、半径 r 定义，便于：
 *   - SVG：在 <g transform="translate(x,y)"> 内用 <path d={shapePath(...)} />
 *   - Canvas：drawShape(ctx, type, x, y, r) 平移后描边/填充
 *
 * 注：Poem 圆形也用 path（两段弧）实现，统一渲染入口，避免 SVG data-join 分支。
 */

import type { NodeType } from '@/lib/types'

/** 节点视觉半径：连接度按对数缩放，防止高连接节点吞没邻居 */
export function nodeRadius(degree: number): number {
    const d = Math.max(0, degree)
    return Math.max(7, Math.min(18, 7 + Math.log2(d + 1) * 2.1))
}

/** 返回以原点为中心、半径 r 的形状 SVG path `d` */
export function shapePath(type: NodeType, r: number): string {
    switch (type) {
        case 'Poem':
            return circlePath(r)
        case 'Poet':
            return squarePath(r)
        case 'Image':
            return diamondPath(r)
        case 'Theme':
            return hexagonPath(r)
        case 'Era':
            return trianglePath(r)
        case 'Rhetoric':
            return starPath(r, r * 0.42, 5)
    }
}

/** 圆 —— 两段大弧拼合，便于统一 path 渲染 */
function circlePath(r: number): string {
    return `M 0 ${-r} A ${r} ${r} 0 1 0 0 ${r} A ${r} ${r} 0 1 0 0 ${-r} Z`
}

/** 方形 —— 边长取 0.9×直径，视觉与圆形面积均衡 */
function squarePath(r: number): string {
    const s = r * 0.9
    return `M ${-s} ${-s} L ${s} ${-s} L ${s} ${s} L ${-s} ${s} Z`
}

/** 菱形 */
function diamondPath(r: number): string {
    return `M 0 ${-r} L ${r} 0 L 0 ${r} L ${-r} 0 Z`
}

/** 六边形 —— 顶点朝上 */
function hexagonPath(r: number): string {
    return Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i - Math.PI / 2
        return `${i === 0 ? 'M' : 'L'} ${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`
    }).join(' ') + ' Z'
}

/** 三角形 —— 等边，顶点朝上 */
function trianglePath(r: number): string {
    const h = r
    const w = r * 0.866 // sin60°
    return `M 0 ${-h} L ${w} ${h * 0.5} L ${-w} ${h * 0.5} Z`
}

/** 五角星 —— outerR 外径，innerR 内径 */
function starPath(outerR: number, innerR: number, points: number): string {
    return Array.from({ length: points * 2 }, (_, i) => {
        const r = i % 2 === 0 ? outerR : innerR
        const a = (Math.PI / points) * i - Math.PI / 2
        return `${i === 0 ? 'M' : 'L'} ${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`
    }).join(' ') + ' Z'
}

/**
 * 在 Canvas 上绘制节点形状（已平移至 x,y）
 * 调用方负责 ctx.fillStyle/strokeStyle 的设置与 fill()/stroke() 调用
 */
export function traceShape(
    ctx: CanvasRenderingContext2D,
    type: NodeType,
    x: number,
    y: number,
    r: number,
): void {
    ctx.beginPath()
    switch (type) {
        case 'Poem':
            ctx.arc(x, y, r, 0, Math.PI * 2)
            break
        case 'Poet': {
            const s = r * 0.9
            ctx.rect(x - s, y - s, s * 2, s * 2)
            break
        }
        case 'Image':
            ctx.moveTo(x, y - r)
            ctx.lineTo(x + r, y)
            ctx.lineTo(x, y + r)
            ctx.lineTo(x - r, y)
            ctx.closePath()
            break
        case 'Theme': {
            for (let i = 0; i < 6; i++) {
                const a = (Math.PI / 3) * i - Math.PI / 2
                const px = x + r * Math.cos(a)
                const py = y + r * Math.sin(a)
                if (i === 0) ctx.moveTo(px, py)
                else ctx.lineTo(px, py)
            }
            ctx.closePath()
            break
        }
        case 'Era': {
            const w = r * 0.866
            ctx.moveTo(x, y - r)
            ctx.lineTo(x + w, y + r * 0.5)
            ctx.lineTo(x - w, y + r * 0.5)
            ctx.closePath()
            break
        }
        case 'Rhetoric': {
            const inner = r * 0.42
            for (let i = 0; i < 10; i++) {
                const rr = i % 2 === 0 ? r : inner
                const a = (Math.PI / 5) * i - Math.PI / 2
                const px = x + rr * Math.cos(a)
                const py = y + rr * Math.sin(a)
                if (i === 0) ctx.moveTo(px, py)
                else ctx.lineTo(px, py)
            }
            ctx.closePath()
            break
        }
    }
}
