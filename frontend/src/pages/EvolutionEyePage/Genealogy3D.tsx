/**
 * 进化之眼 · 版本谱系 3D 可视化（规范第 6、10、15 章）
 *
 * 职责（SubTask 26.1 / 26.5）：
 *  - 包装 Scene3D 提供 R3F Canvas 容器
 *  - 节点（球体）：浅色水墨玻璃态，半径由 usage 决定，颜色由 accuracy 决定
 *      - active → accent-primary（金色，当前生效版本）+ MagicRings 光韵
 *      - candidate → accent-warning（琥珀，A/B 测试候选）
 *      - inactive → text-tertiary（淡灰，历史版本）
 *  - 边（连线）：父→子版本演化路径，流动动画（dashed + dashoffset 动画）
 *  - 预测路径（SubTask 26.5）：3D 虚线 + 透明度渐变 + 预测节点半透明闪烁
 *  - 视角切换：1/2/3 键切换正视/侧视/俯视（通过 camera position 变化）
 *  - 交互：OrbitControls 旋转 + 滚轮缩放 + hover tooltip + 点击详情
 *  - 错误边界：3D 渲染失败时降级到 2D 消息（规范 15.2）
 *
 * 性能策略：
 *  - 几何体/材质 useMemo 缓存
 *  - 边合并为单一 LineSegments（一次 draw call）
 *  - frameloop="always"：流动动画需要连续渲染
 *
 * 设计要点（规范第 2、4、6 章）：
 *  - 零硬编码色值：颜色由 CSS 变量派生（usePalette 一次性读取）
 *  - 玻璃态背景：由 Scene3D.css 的 .scene3d-container 提供
 *  - 无障碍：prefers-reduced-motion 时禁用流动动画
 *  - Tabular Numbers：tooltip 内数值显示
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import { Scene3D } from '@/components/three'
import { SectionErrorBoundary } from '@/components/ui'
import { subscribeMediaQuery } from '@/lib/media-query'
import type {
    GenealogyData,
    GenealogyNode,
    GenealogyEdge,
    EvolutionPredictionDirection,
} from '@/lib/types'

/* ============================================================
 * 常量
 * ============================================================ */

/** 节点半径范围：quality 0 → 0.4，quality 1 → 1.2 */
const MIN_RADIUS = 0.4
const MAX_RADIUS = 1.2

/** 时间轴 Z 范围：最早 -8，最新 +8 */
const Z_RANGE = 8

/** agent 通道 X 间距 */
const X_LANE_GAP = 6

/** quality → Y 偏移倍率（让高质量节点浮起，形成"奖励曲线"） */
const Y_QUALITY_SCALE = 1.5

/** 视角预设：1=正视 / 2=侧视 / 3=俯视 */
type ViewPreset = 'front' | 'side' | 'top'

const VIEW_PRESETS: Record<ViewPreset, [number, number, number]> = {
    front: [0, 6, 18],
    side: [18, 6, 0],
    top: [0, 20, 0.01],
}

/* ============================================================
 * Hook —— CSS 变量 → THREE.Color 调色板
 * ============================================================ */

interface GenealogyPalette {
    accentPrimary: THREE.Color
    accentWarning: THREE.Color
    accentSuccess: THREE.Color
    accentInfo: THREE.Color
    textTertiary: THREE.Color
    textPrimary: THREE.Color
}

function usePalette(): GenealogyPalette {
    return useMemo(() => {
        const read = (varName: string, fallback: string): THREE.Color => {
            const c = new THREE.Color(fallback)
            if (typeof window === 'undefined') return c
            try {
                const raw = getComputedStyle(document.documentElement)
                    .getPropertyValue(varName)
                    .trim()
                if (!raw) return c
                const parts = raw.split(/\s+/)
                const r = Number(parts[0]) / 255
                const g = Number(parts[1]) / 255
                const b = Number(parts[2]) / 255
                if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
                    c.setRGB(r, g, b)
                }
            } catch {
                // 降级使用 fallback
            }
            return c
        }
        return {
            accentPrimary: read('--c-accent-primary', '#986227'),
            accentWarning: read('--c-accent-warning', '#8f6a1c'),
            accentSuccess: read('--c-accent-success', '#4a7a4e'),
            accentInfo: read('--c-accent-info', '#5a8aa8'),
            textTertiary: read('--c-text-tertiary', '#6e665c'),
            textPrimary: read('--c-text-primary', '#2c241a'),
        }
    }, [])
}

/**
 * 将 THREE.Color 转换为 CSS rgb() 字符串
 * 用于内联 SVG stroke 属性 —— 替代硬编码 "rgb(197, 133, 59)"（规范 14.2 零硬编码）
 */
function threeColorToCssRgb(c: THREE.Color): string {
    const r = Math.round(c.r * 255)
    const g = Math.round(c.g * 255)
    const b = Math.round(c.b * 255)
    return `rgb(${r}, ${g}, ${b})`
}

/* ============================================================
 * Hook —— prefers-reduced-motion 检测（规范 7.11 / 14.3）
 * 启用时：禁用流动动画、MagicRings 旋转、预测节点闪烁
 * ============================================================ */

function usePrefersReducedMotion(): boolean {
    const [reduced, setReduced] = useState<boolean>(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return false
        }
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    })

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
        const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
        const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
        setReduced(mql.matches)
        return subscribeMediaQuery(mql, onChange)
    }, [])

    return reduced
}

/* ============================================================
 * 性能档位（规范 13.3 / 15.2：低帧率自动降 DPR，提供静态降级）
 * ============================================================ */

type PerfLevel = 'high' | 'low' | 'degraded'

/** 不同性能档位对应的 DPR 范围（规范 13.3） */
const PERF_DPR: Record<PerfLevel, [number, number]> = {
    high: [1, 2],
    low: [1, 1.3],
    degraded: [1, 1],
}

/** FPS 监控阈值：连续低帧率时降级 */
const FPS_LOW_THRESHOLD = 30
const FPS_DEGRADED_THRESHOLD = 15

/* ============================================================
 * 工具 —— 计算节点 3D 位置
 * X = agent 通道（每个 agent 一列）
 * Z = 时间归一化（最早 -Z_RANGE，最新 +Z_RANGE）
 * Y = quality * Y_QUALITY_SCALE（高质量浮起，形成奖励曲线）
 * ============================================================ */

interface NodePosition {
    pos: [number, number, number]
    radius: number
}

function computeNodePositions(
    nodes: GenealogyNode[],
    agentIds: string[],
): Map<string, NodePosition> {
    if (nodes.length === 0) return new Map()

    // 时间归一化
    const timestamps = nodes.map((n) => n.createdAt)
    const tMin = Math.min(...timestamps)
    const tMax = Math.max(...timestamps)
    const tRange = tMax - tMin || 1

    // agent → X 通道索引
    const agentIndex = new Map<string, number>()
    agentIds.forEach((id, i) => agentIndex.set(id, i))
    const agentCount = Math.max(1, agentIds.length)
    const xCenter = (agentCount - 1) / 2

    const map = new Map<string, NodePosition>()
    for (const n of nodes) {
        const agentIdx = agentIndex.get(n.agentId) ?? 0
        const x = (agentIdx - xCenter) * X_LANE_GAP
        const tNorm = (n.createdAt - tMin) / tRange // 0..1
        const z = (tNorm - 0.5) * 2 * Z_RANGE // -Z_RANGE..+Z_RANGE
        const y = n.quality * Y_QUALITY_SCALE
        const radius = MIN_RADIUS + n.quality * (MAX_RADIUS - MIN_RADIUS)
        map.set(n.id, { pos: [x, y, z], radius })
    }
    return map
}

/* ============================================================
 * 工具 —— 节点颜色与透明度（accuracy → 颜色，usage → 大小）
 * ============================================================ */

interface NodeColorResult {
    color: THREE.Color
    emissive: THREE.Color
    opacity: number
}

function computeNodeColor(node: GenealogyNode, pal: GenealogyPalette): NodeColorResult {
    if (node.isActive) {
        return {
            color: pal.accentPrimary.clone(),
            emissive: pal.accentPrimary.clone().multiplyScalar(0.35),
            opacity: 0.95,
        }
    }
    if (node.isCandidate) {
        return {
            color: pal.accentWarning.clone(),
            emissive: pal.accentWarning.clone().multiplyScalar(0.3),
            opacity: 0.85,
        }
    }
    // 历史节点：根据 quality 在 tertiary 和 info 间过渡
    return {
        color: pal.textTertiary.clone(),
        emissive: pal.textTertiary.clone().multiplyScalar(0.15),
        opacity: 0.55,
    }
}

/* ============================================================
 * 内部组件 —— 单个版本节点（球体 + tooltip）
 * ============================================================ */

interface GenealogyNode3DProps {
    node: GenealogyNode
    position: [number, number, number]
    radius: number
    color: THREE.Color
    emissive: THREE.Color
    opacity: number
    isSelected: boolean
    isHovered: boolean
    /** MagicRings 光韵颜色（CSS rgb 字符串，从 palette 派生，零硬编码） */
    ringColor: string
    /** 是否启用动效（prefers-reduced-motion 时为 false） */
    enableMotion: boolean
    onSelect: (node: GenealogyNode) => void
    onHover: (node: GenealogyNode | null) => void
}

function GenealogyNode3D({
    node,
    position,
    radius,
    color,
    emissive,
    opacity,
    isSelected,
    isHovered,
    ringColor,
    enableMotion,
    onSelect,
    onHover,
}: GenealogyNode3DProps) {
    const meshRef = useRef<THREE.Mesh>(null)
    const geometry = useMemo(() => new THREE.SphereGeometry(radius, 24, 24), [radius])
    const material = useMemo(() => {
        return new THREE.MeshStandardMaterial({
            color,
            emissive,
            emissiveIntensity: isSelected ? 0.8 : 0.4,
            transparent: true,
            opacity: isSelected ? 1 : opacity,
            roughness: 0.45,
            metalness: 0.15,
        })
    }, [color, emissive, opacity, isSelected])

    // 资源释放
    useEffect(() => {
        return () => {
            geometry.dispose()
            material.dispose()
        }
    }, [geometry, material])

    // 选中时轻微脉动（prefers-reduced-motion 时禁用脉动，仅保留静态 hover 放大）
    useFrame((state) => {
        if (!meshRef.current) return
        if (isSelected && enableMotion) {
            const s = 1 + Math.sin(state.clock.elapsedTime * 2.5) * 0.08
            meshRef.current.scale.setScalar(s)
        } else if (isHovered) {
            meshRef.current.scale.setScalar(1.15)
        } else {
            meshRef.current.scale.setScalar(1)
        }
    })

    return (
        <group position={position}>
            <mesh
                ref={meshRef}
                geometry={geometry}
                material={material}
                onClick={(e) => {
                    e.stopPropagation()
                    onSelect(node)
                }}
                onPointerOver={(e) => {
                    e.stopPropagation()
                    onHover(node)
                }}
                onPointerOut={() => onHover(null)}
            />
            {/* 激活版本：MagicRings 风格的 SVG 光韵（drei Html）
             * stroke 颜色从 palette 派生（ringColor），替代硬编码 "rgb(197, 133, 59)" —— 规范 14.2 零硬编码
             * prefers-reduced-motion 时移除旋转动画（规范 7.11 动效降级） */}
            {node.isActive && (
                <Html
                    center
                    distanceFactor={14}
                    position={[0, 0, 0]}
                    style={{ pointerEvents: 'none' }}
                >
                    <div
                        style={{
                            width: radius * 60,
                            height: radius * 60,
                            position: 'relative',
                            transform: 'translate(-50%, -50%)',
                        }}
                    >
                        <svg
                            width="100%"
                            height="100%"
                            viewBox="0 0 100 100"
                            style={{ overflow: 'visible' }}
                        >
                            <circle
                                cx="50"
                                cy="50"
                                r="38"
                                fill="none"
                                stroke={ringColor}
                                strokeWidth="1.4"
                                strokeDasharray="14 86"
                                opacity="0.85"
                                style={{
                                    transformOrigin: '50px 50px',
                                    animation: enableMotion ? 'pr-genealogy-ring-spin 4s linear infinite' : 'none',
                                }}
                            />
                            <circle
                                cx="50"
                                cy="50"
                                r="32"
                                fill="none"
                                stroke={ringColor}
                                strokeWidth="1"
                                strokeDasharray="10 90"
                                opacity="0.55"
                                style={{
                                    transformOrigin: '50px 50px',
                                    animation: enableMotion ? 'pr-genealogy-ring-spin 5.5s linear infinite reverse' : 'none',
                                }}
                            />
                            <circle
                                cx="50"
                                cy="50"
                                r="44"
                                fill="none"
                                stroke={ringColor}
                                strokeWidth="0.7"
                                strokeDasharray="6 94"
                                opacity="0.4"
                                style={{
                                    transformOrigin: '50px 50px',
                                    animation: enableMotion ? 'pr-genealogy-ring-spin 7s linear infinite' : 'none',
                                }}
                            />
                        </svg>
                    </div>
                </Html>
            )}
            {/* 选中/悬停时显示 tooltip（drei Html） */}
            {(isSelected || isHovered) && (
                <Html
                    center
                    distanceFactor={10}
                    position={[0, radius + 0.5, 0]}
                    style={{
                        pointerEvents: 'none',
                        padding: '6px 10px',
                        background: 'rgb(var(--c-surface-elevated) / 0.92)',
                        backdropFilter: 'blur(12px)',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 'var(--text-xs)',
                        color: 'rgb(var(--c-text-primary))',
                        whiteSpace: 'nowrap',
                        boxShadow: 'var(--shadow-popover)',
                        fontVariantNumeric: 'tabular-nums',
                    }}
                >
                    <div style={{ fontWeight: 600 }}>{node.version}</div>
                    <div style={{ fontSize: '10px', color: 'rgb(var(--c-text-secondary))', marginTop: 2 }}>
                        质量 {(node.quality * 100).toFixed(0)}%
                        {node.improvementReward !== null && (
                            <> · 奖励 {node.improvementReward.toFixed(3)}</>
                        )}
                    </div>
                </Html>
            )}
        </group>
    )
}

/* ============================================================
 * 内部组件 —— 边（LineSegments，所有边合并为一次 draw call）
 *      带流动动画（dashed + dashoffset）
 * ============================================================ */

interface GenealogyEdges3DProps {
    edges: GenealogyEdge[]
    positions: Map<string, NodePosition>
    color: THREE.Color
    /** 是否启用流动动画（prefers-reduced-motion 时为 false） */
    enableMotion: boolean
}

function GenealogyEdges3D({ edges, positions, color, enableMotion }: GenealogyEdges3DProps) {
    // dashOffset 在 three.js 源码中存在，但 @types/three v0.169 类型缺失，扩展声明
    type LineDashedMaterialWithOffset = THREE.LineDashedMaterial & { dashOffset: number }
    // 使用 T | null 形式以获得 MutableRefObject（.current 可写）
    const materialRef = useRef<LineDashedMaterialWithOffset | null>(null)

    const geometry = useMemo(() => {
        const positionsArr: number[] = []
        const colorsArr: number[] = []
        const lineDistancesArr: number[] = []
        for (const e of edges) {
            const from = positions.get(e.from)
            const to = positions.get(e.to)
            if (!from || !to) continue
            positionsArr.push(...from.pos, ...to.pos)
            // 父端稍深，子端稍淡，模拟信息流
            colorsArr.push(color.r, color.g, color.b, color.r * 0.6, color.g * 0.6, color.b * 0.6)
            // 每个线段独立计算距离：起点 0，终点 = 起终点距离
            const dx = to.pos[0] - from.pos[0]
            const dy = to.pos[1] - from.pos[1]
            const dz = to.pos[2] - from.pos[2]
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
            lineDistancesArr.push(0, dist)
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positionsArr, 3))
        geo.setAttribute('color', new THREE.Float32BufferAttribute(colorsArr, 3))
        // LineDashedMaterial 需 lineDistance 属性（替代旧版 BufferGeometry.computeLineDistances）
        geo.setAttribute('lineDistance', new THREE.Float32BufferAttribute(lineDistancesArr, 1))
        return geo
    }, [edges, positions, color])

    const material = useMemo(() => {
        return new THREE.LineDashedMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.55,
            dashSize: 0.4,
            gapSize: 0.25,
            depthWrite: false,
        })
    }, [])

    // 资源释放
    useEffect(() => {
        return () => {
            geometry.dispose()
            material.dispose()
        }
    }, [geometry, material])

    // 流动动画：dashoffset 持续递减（prefers-reduced-motion 时禁用，规范 7.11）
    useFrame((_state, delta) => {
        if (enableMotion && materialRef.current) {
            materialRef.current.dashOffset -= delta * 0.6
        }
    })

    return <lineSegments geometry={geometry} material={material} ref={(m) => {
        if (m && 'material' in m) {
            ((materialRef as unknown) as { current: LineDashedMaterialWithOffset | null }).current = m.material as LineDashedMaterialWithOffset
        }
    }} />
}

/* ============================================================
 * 内部组件 —— 预测路径（3D 虚线 + 透明度渐变 + 半透明闪烁节点）
 * SubTask 26.5
 * ============================================================ */

interface PredictionPath3DProps {
    /** 预测路径起点节点 id（通常是当前 active 版本） */
    fromId: string | null
    /** 预测的下一个版本节点（虚拟节点，半透明闪烁） */
    predictions: EvolutionPredictionDirection[]
    /** 已有节点位置（用于确定起点坐标） */
    positions: Map<string, NodePosition>
    /** 已有节点 id 集合（避免预测节点与现有节点重叠） */
    existingIds: Set<string>
    color: THREE.Color
    /** 是否启用动效（prefers-reduced-motion 时为 false） */
    enableMotion: boolean
}

function PredictionPath3D({
    fromId,
    predictions,
    positions,
    color,
    enableMotion,
}: PredictionPath3DProps) {
    const fromPos = fromId ? positions.get(fromId) : null
    if (!fromPos || predictions.length === 0) return null

    // 为每个预测方向生成一个虚拟节点位置（沿 X 轴展开，时间向 +Z 推进）
    const predictionNodes = useMemo(() => {
        const startX = fromPos.pos[0]
        const startY = fromPos.pos[1]
        const startZ = fromPos.pos[2]
        const stepX = (predictions.length - 1) / 2
        return predictions.map((p, i) => {
            const offsetX = (i - stepX) * 1.8
            const offsetZ = 3 + p.expectedImprovement * 2 // 向未来推进
            const offsetY = p.confidence * 0.8 // 置信度越高越浮起
            return {
                pos: [startX + offsetX, startY + offsetY, startZ + offsetZ] as [number, number, number],
                prediction: p,
            }
        })
    }, [fromPos, predictions])

    // 合并所有预测路径线段
    const geometry = useMemo(() => {
        const positionsArr: number[] = []
        const colorsArr: number[] = []
        const lineDistancesArr: number[] = []
        for (const node of predictionNodes) {
            positionsArr.push(...fromPos.pos, ...node.pos)
            // 渐变：起点颜色浓 → 终点颜色淡
            colorsArr.push(color.r, color.g, color.b, color.r * 0.3, color.g * 0.3, color.b * 0.3)
            // 每个线段独立计算距离：起点 0，终点 = 起终点距离
            const dx = node.pos[0] - fromPos.pos[0]
            const dy = node.pos[1] - fromPos.pos[1]
            const dz = node.pos[2] - fromPos.pos[2]
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
            lineDistancesArr.push(0, dist)
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positionsArr, 3))
        geo.setAttribute('color', new THREE.Float32BufferAttribute(colorsArr, 3))
        // LineDashedMaterial 需 lineDistance 属性（替代旧版 BufferGeometry.computeLineDistances）
        geo.setAttribute('lineDistance', new THREE.Float32BufferAttribute(lineDistancesArr, 1))
        return geo
    }, [predictionNodes, fromPos.pos, color])

    const material = useMemo(() => {
        return new THREE.LineDashedMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.5,
            dashSize: 0.3,
            gapSize: 0.35,
            depthWrite: false,
        })
    }, [])

    useEffect(() => {
        return () => {
            geometry.dispose()
            material.dispose()
        }
    }, [geometry, material])

    return (
        <>
            <lineSegments geometry={geometry} material={material} />
            {predictionNodes.map((node, i) => (
                <PredictedNode3D
                    key={`pred-${i}`}
                    position={node.pos}
                    prediction={node.prediction}
                    color={color}
                    enableMotion={enableMotion}
                />
            ))}
        </>
    )
}

/* ============================================================
 * 内部组件 —— 预测节点（半透明 + 闪烁动画）
 * ============================================================ */

interface PredictedNode3DProps {
    position: [number, number, number]
    prediction: EvolutionPredictionDirection
    color: THREE.Color
    /** 是否启用动效（prefers-reduced-motion 时为 false） */
    enableMotion: boolean
}

function PredictedNode3D({ position, prediction, color, enableMotion }: PredictedNode3DProps) {
    const meshRef = useRef<THREE.Mesh>(null)
    const radius = 0.45 + prediction.expectedImprovement * 0.4
    const geometry = useMemo(() => new THREE.SphereGeometry(radius, 16, 16), [radius])
    const material = useMemo(() => {
        return new THREE.MeshStandardMaterial({
            color,
            emissive: color.clone().multiplyScalar(0.3),
            emissiveIntensity: 0.5,
            transparent: true,
            opacity: 0.45,
            roughness: 0.4,
            metalness: 0.2,
            wireframe: false,
        })
    }, [color])

    useEffect(() => {
        return () => {
            geometry.dispose()
            material.dispose()
        }
    }, [geometry, material])

    // 闪烁动画：opacity 在 0.25-0.65 之间脉动（prefers-reduced-motion 时静态 opacity=0.45，规范 7.11）
    useFrame((state) => {
        if (!meshRef.current) return
        if (!enableMotion) {
            ; (meshRef.current.material as THREE.MeshStandardMaterial).opacity = 0.45
            return
        }
        const t = state.clock.elapsedTime
        const pulse = 0.45 + Math.sin(t * 2) * 0.2
            ; (meshRef.current.material as THREE.MeshStandardMaterial).opacity = pulse
        // 轻微悬浮
        meshRef.current.position.y = position[1] + Math.sin(t * 1.5) * 0.08
    })

    return (
        <group position={position}>
            <mesh ref={meshRef} geometry={geometry} material={material} />
            <Html
                center
                distanceFactor={12}
                position={[0, radius + 0.4, 0]}
                style={{
                    pointerEvents: 'none',
                    padding: '4px 8px',
                    background: 'rgb(var(--c-surface-elevated) / 0.85)',
                    backdropFilter: 'blur(10px)',
                    borderRadius: 'var(--radius-xs)',
                    fontSize: 'var(--text-2xs)',
                    color: 'rgb(var(--c-accent-primary))',
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    boxShadow: 'var(--shadow-card)',
                    border: '1px solid rgb(var(--c-accent-primary) / 0.20)',
                }}
            >
                <span>预测 · {(prediction.confidence * 100).toFixed(0)}%</span>
            </Html>
        </group>
    )
}

/* ============================================================
 * 内部组件 —— 时间轴参考线（地面网格暗示）
 * ============================================================ */

function TimeAxisHint({ zRange }: { zRange: number }) {
    const points = useMemo(() => {
        const pts: THREE.Vector3[] = []
        for (let z = -zRange; z <= zRange; z += 2) {
            pts.push(new THREE.Vector3(-20, -0.5, z))
            pts.push(new THREE.Vector3(20, -0.5, z))
        }
        return pts
    }, [zRange])

    const geometry = useMemo(() => {
        return new THREE.BufferGeometry().setFromPoints(points)
    }, [points])

    // 颜色从 CSS 变量派生（替代硬编码 0xb4aa9b）—— 规范 14.2 零硬编码
    const material = useMemo(() => {
        const c = new THREE.Color('#b4aa9b')
        try {
            if (typeof window !== 'undefined') {
                const raw = getComputedStyle(document.documentElement)
                    .getPropertyValue('--c-border-primary')
                    .trim()
                if (raw) {
                    const parts = raw.split(/\s+/)
                    const r = Number(parts[0]) / 255
                    const g = Number(parts[1]) / 255
                    const b = Number(parts[2]) / 255
                    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
                        c.setRGB(r, g, b)
                    }
                }
            }
        } catch {
            // 降级使用 fallback
        }
        return new THREE.LineBasicMaterial({
            color: c,
            transparent: true,
            opacity: 0.08,
            depthWrite: false,
        })
    }, [])

    useEffect(() => {
        return () => {
            geometry.dispose()
            material.dispose()
        }
    }, [geometry, material])

    return <lineSegments geometry={geometry} material={material} />
}

/* ============================================================
 * 内部组件 —— 相机视角切换控制器
 * 监听 1/2/3 键切换视角，平滑插值相机位置
 * ============================================================ */

interface ViewSwitchControllerProps {
    targetView: ViewPreset
    onSwitch?: (view: ViewPreset) => void
}

function ViewSwitchController({ targetView, onSwitch }: ViewSwitchControllerProps) {
    const { camera } = useThree()
    const targetRef = useRef<THREE.Vector3>(new THREE.Vector3(...VIEW_PRESETS[targetView]))

    // 监听 1/2/3 键
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
            let next: ViewPreset | null = null
            if (e.key === '1') next = 'front'
            else if (e.key === '2') next = 'side'
            else if (e.key === '3') next = 'top'
            if (next) {
                onSwitch?.(next)
            }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [onSwitch])

    // targetView 变化时更新目标位置
    useEffect(() => {
        targetRef.current.set(...VIEW_PRESETS[targetView])
    }, [targetView])

    // 每帧平滑插值
    useFrame((_state, delta) => {
        const target = targetRef.current
        camera.position.x += (target.x - camera.position.x) * Math.min(1, delta * 2.5)
        camera.position.y += (target.y - camera.position.y) * Math.min(1, delta * 2.5)
        camera.position.z += (target.z - camera.position.z) * Math.min(1, delta * 2.5)
        camera.lookAt(0, 1, 0)
    })

    return null
}

/* ============================================================
 * 内部组件 —— Genealogy3DContent（Canvas 内）
 * ============================================================ */

interface Genealogy3DContentProps {
    data: GenealogyData
    selectedId: string | null
    hoveredId: string | null
    onSelect: (node: GenealogyNode) => void
    onHover: (node: GenealogyNode | null) => void
    predictions: EvolutionPredictionDirection[]
    targetView: ViewPreset
    onViewSwitch: (view: ViewPreset) => void
    /** 是否启用动效（prefers-reduced-motion 时为 false） */
    enableMotion: boolean
    /** 性能档位变化回调（FPS 监控） */
    onPerfLevelChange?: (level: PerfLevel) => void
}

function Genealogy3DContent({
    data,
    selectedId,
    hoveredId,
    onSelect,
    onHover,
    predictions,
    targetView,
    onViewSwitch,
    enableMotion,
    onPerfLevelChange,
}: Genealogy3DContentProps) {
    const pal = usePalette()

    /* ---------- 性能监控：FPS 采样 → 降 DPR / 静态降级（规范 13.3 / 15.2） ---------- */
    const fpsAccumulator = useRef({ frames: 0, lastTime: performance.now(), level: 'high' as PerfLevel })

    useFrame(() => {
        if (!onPerfLevelChange) return
        const acc = fpsAccumulator.current
        acc.frames++
        const now = performance.now()
        const elapsed = now - acc.lastTime
        if (elapsed < 500) return // 每 500ms 采样一次
        const fps = (acc.frames * 1000) / elapsed
        acc.frames = 0
        acc.lastTime = now

        let nextLevel: PerfLevel = 'high'
        if (fps < FPS_DEGRADED_THRESHOLD) nextLevel = 'degraded'
        else if (fps < FPS_LOW_THRESHOLD) nextLevel = 'low'

        if (nextLevel !== acc.level) {
            acc.level = nextLevel
            onPerfLevelChange(nextLevel)
        }
    })

    /* ---------- MagicRings 光韵颜色（CSS rgb 字符串，从 palette 派生） ---------- */
    const ringColor = useMemo(() => threeColorToCssRgb(pal.accentPrimary), [pal.accentPrimary])

    /* ---------- 节点位置 ---------- */
    const positions = useMemo(
        () => computeNodePositions(data.nodes, data.agentIds),
        [data.nodes, data.agentIds],
    )

    /* ---------- 节点颜色缓存 ---------- */
    const nodeColors = useMemo(() => {
        const m = new Map<string, NodeColorResult>()
        for (const n of data.nodes) {
            m.set(n.id, computeNodeColor(n, pal))
        }
        return m
    }, [data.nodes, pal])

    /* ---------- 稳定回调 ---------- */
    const handleSelect = useCallback(
        (node: GenealogyNode) => onSelect(node),
        [onSelect],
    )
    const handleHover = useCallback(
        (node: GenealogyNode | null) => onHover(node),
        [onHover],
    )

    /* ---------- 预测路径起点：当前激活版本 ---------- */
    const activeNodeId = useMemo(() => {
        const active = data.nodes.find((n) => n.isActive)
        return active?.id ?? data.nodes[data.nodes.length - 1]?.id ?? null
    }, [data.nodes])

    const existingIds = useMemo(() => new Set(data.nodes.map((n) => n.id)), [data.nodes])

    /* ---------- 渲染 ---------- */
    return (
        <>
            <TimeAxisHint zRange={Z_RANGE} />

            <GenealogyEdges3D
                edges={data.edges}
                positions={positions}
                color={pal.textPrimary}
                enableMotion={enableMotion}
            />

            {/* 预测路径（SubTask 26.5） */}
            {predictions.length > 0 && (
                <PredictionPath3D
                    fromId={activeNodeId}
                    predictions={predictions}
                    positions={positions}
                    existingIds={existingIds}
                    color={pal.accentInfo}
                    enableMotion={enableMotion}
                />
            )}

            {data.nodes.map((node) => {
                const np = positions.get(node.id)
                const nc = nodeColors.get(node.id)
                if (!np || !nc) return null
                return (
                    <GenealogyNode3D
                        key={node.id}
                        node={node}
                        position={np.pos}
                        radius={np.radius}
                        color={nc.color}
                        emissive={nc.emissive}
                        opacity={nc.opacity}
                        isSelected={selectedId === node.id}
                        isHovered={hoveredId === node.id}
                        ringColor={ringColor}
                        enableMotion={enableMotion}
                        onSelect={handleSelect}
                        onHover={handleHover}
                    />
                )
            })}

            <ViewSwitchController targetView={targetView} onSwitch={onViewSwitch} />
        </>
    )
}

/* ============================================================
 * Error Boundary Fallback
 * ============================================================ */

function GenealogyErrorFallback({ error }: { error: Error }) {
    if (import.meta.env.DEV) console.warn('[Genealogy3D] 渲染失败，降级到 2D:', error)
    return (
        <div className="evolution-eye-canvas-error">
            <div style={{ fontWeight: 600 }}>3D 渲染失败</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'rgb(var(--c-text-tertiary))' }}>
                {import.meta.env.DEV ? error.message : '请刷新页面或检查浏览器 WebGL 支持'}
            </div>
        </div>
    )
}

/* ============================================================
 * Suspense 加载态
 * ============================================================ */

function GenealogyLoading() {
    return (
        <div className="evolution-eye-canvas-error">
            <div style={{ fontSize: 'var(--text-sm)' }}>加载 3D 场景…</div>
        </div>
    )
}

/* ============================================================
 * 静态降级视图（规范 15.2 / 13.3）
 * 当 WebGL 不可用或帧率持续极低（< 15fps）时，展示静态版本谱系树
 * ============================================================ */

interface StaticFallbackProps {
    data: GenealogyData
    selectedId: string | null
    onSelect?: (node: GenealogyNode) => void
}

function GenealogyStaticFallback({ data, selectedId, onSelect }: StaticFallbackProps) {
    // 简易静态树：按时间排序的版本列表，选中高亮
    const sortedNodes = useMemo(() => {
        return [...data.nodes].sort((a, b) => a.createdAt - b.createdAt)
    }, [data.nodes])

    return (
        <div
            className="evolution-eye-canvas-error"
            style={{
                alignItems: 'stretch',
                padding: 'var(--space-md)',
                gap: 'var(--space-xs)',
                overflowY: 'auto',
            }}
            role="list"
            aria-label="版本谱系静态视图"
        >
            <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)', color: 'rgb(var(--c-text-primary))' }}>
                已切换到静态视图
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'rgb(var(--c-text-tertiary))', marginBottom: 'var(--space-sm)' }}>
                当前环境 3D 性能不足，已自动降级
            </div>
            {sortedNodes.map((node) => {
                const isActive = node.isActive
                const isSelected = selectedId === node.id
                return (
                    <button
                        key={node.id}
                        type="button"
                        role="listitem"
                        onClick={() => onSelect?.(node)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 'var(--space-sm)',
                            padding: '8px 10px',
                            border: 0,
                            borderRadius: 'var(--radius-sm)',
                            background: isSelected
                                ? 'rgb(var(--c-accent-primary) / 0.12)'
                                : isActive
                                    ? 'rgb(var(--c-accent-primary) / 0.06)'
                                    : 'transparent',
                            color: 'rgb(var(--c-text-primary))',
                            font: 'inherit',
                            fontSize: 'var(--text-xs)',
                            cursor: 'pointer',
                            textAlign: 'left',
                            transition: 'background var(--dur-micro) var(--ease-out)',
                        }}
                    >
                        <span
                            style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: isActive
                                    ? 'rgb(var(--c-accent-primary))'
                                    : node.isCandidate
                                        ? 'rgb(var(--c-accent-warning))'
                                        : 'rgb(var(--c-text-tertiary) / 0.5)',
                                flexShrink: 0,
                            }}
                            aria-hidden
                        />
                        <span style={{ flex: 1, fontWeight: isSelected ? 600 : 500 }}>
                            {node.version}
                        </span>
                        <span
                            style={{
                                color: 'rgb(var(--c-text-tertiary))',
                                fontVariantNumeric: 'tabular-nums',
                                fontSize: 'var(--text-2xs)',
                            }}
                        >
                            {(node.quality * 100).toFixed(0)}%
                        </span>
                    </button>
                )
            })}
        </div>
    )
}

/* ============================================================
 * 公开组件 —— Genealogy3D
 * ============================================================ */

export interface Genealogy3DProps {
    /** 版本谱系数据 */
    data: GenealogyData
    /** 当前选中节点 id（来自父组件 state） */
    selectedId?: string | null
    /** 选中节点回调 */
    onSelect?: (node: GenealogyNode) => void
    /** 悬停节点回调 */
    onHover?: (node: GenealogyNode | null) => void
    /** 预测方向列表（SubTask 26.5：在 3D 中绘制预测路径） */
    predictions?: EvolutionPredictionDirection[]
    /** 当前视角预设（受控） */
    view?: ViewPreset
    /** 视角切换回调（用户按 1/2/3 键时触发） */
    onViewSwitch?: (view: ViewPreset) => void
}

export function Genealogy3D({
    data,
    selectedId = null,
    onSelect,
    onHover,
    predictions = [],
    view = 'front',
    onViewSwitch,
}: Genealogy3DProps) {
    const [internalSelected, setInternalSelected] = useState<string | null>(null)
    const [internalHovered, setInternalHovered] = useState<string | null>(null)
    const [internalView, setInternalView] = useState<ViewPreset>(view)

    /* ---------- 性能档位 + 可见性追踪（规范 13.3 / 15.2） ---------- */
    const [perfLevel, setPerfLevel] = useState<PerfLevel>('high')
    const [inViewport, setInViewport] = useState(true)
    const [documentVisible, setDocumentVisible] = useState(() => (
        typeof document === 'undefined' || document.visibilityState !== 'hidden'
    ))
    const containerRef = useRef<HTMLDivElement>(null)

    // 同步外部 view 变化
    useEffect(() => {
        setInternalView(view)
    }, [view])

    // IntersectionObserver：不可见时暂停渲染（规范 13.3 WebGL 不可见暂停）
    useEffect(() => {
        const el = containerRef.current
        if (!el || typeof IntersectionObserver === 'undefined') return
        let io: IntersectionObserver | null = null
        try {
            io = new IntersectionObserver(
                (entries) => {
                    for (const entry of entries) setInViewport(entry.isIntersecting)
                },
                { threshold: 0.05 },
            )
            io.observe(el)
        } catch {
            io?.disconnect()
            setInViewport(true)
            return
        }
        return () => io?.disconnect()
    }, [])

    // 页面隐藏时暂停（规范 13.3）
    useEffect(() => {
        if (typeof document === 'undefined') return
        const handler = () => setDocumentVisible(document.visibilityState !== 'hidden')
        handler()
        document.addEventListener('visibilitychange', handler)
        return () => document.removeEventListener('visibilitychange', handler)
    }, [])

    const reducedMotion = usePrefersReducedMotion()
    const isVisible = inViewport && documentVisible
    // 性能降级或不可见时禁用动效（规范 7.11 / 15.2）
    const enableMotion = !reducedMotion && perfLevel !== 'degraded' && isVisible

    const handleSelect = useCallback(
        (node: GenealogyNode) => {
            setInternalSelected(node.id)
            onSelect?.(node)
        },
        [onSelect],
    )
    const handleHover = useCallback(
        (node: GenealogyNode | null) => {
            setInternalHovered(node?.id ?? null)
            onHover?.(node)
        },
        [onHover],
    )

    const handleViewSwitch = useCallback(
        (next: ViewPreset) => {
            setInternalView(next)
            onViewSwitch?.(next)
        },
        [onViewSwitch],
    )

    const handlePerfLevelChange = useCallback((level: PerfLevel) => {
        setPerfLevel(level)
        if (import.meta.env.DEV) {
            console.warn(`[Genealogy3D] 性能档位变化: ${level}`)
        }
    }, [])

    const sel = selectedId ?? internalSelected
    const hov = internalHovered
    const currentView = onViewSwitch ? view : internalView

    // 不可见时切换到 never 暂停渲染（规范 13.3）
    const frameloop: 'always' | 'demand' | 'never' = !isVisible
        ? 'never'
        : enableMotion
            ? 'always'
            : 'demand'
    const dpr = PERF_DPR[perfLevel]

    return (
        <SectionErrorBoundary
            fallback={() => <GenealogyErrorFallback error={new Error('WebGL 渲染失败')} />}
        >
            <Suspense fallback={<GenealogyLoading />}>
                <div
                    ref={containerRef}
                    style={{ width: '100%', height: '100%' }}
                    data-frame-mode={frameloop}
                    data-viewport={inViewport ? 'visible' : 'offscreen'}
                    data-document={documentVisible ? 'visible' : 'hidden'}
                    data-motion={enableMotion ? 'enabled' : 'paused'}
                >
                    {data.nodes.length === 0 ? (
                        <div className="evolution-eye-canvas-error">
                            <div style={{ fontWeight: 600 }}>暂无版本谱系数据</div>
                            <div style={{ fontSize: 'var(--text-xs)', color: 'rgb(var(--c-text-tertiary))' }}>
                                系统将随智能体自我进化自动生成版本树
                            </div>
                        </div>
                    ) : perfLevel === 'degraded' ? (
                        // 静态降级视图（规范 15.2 / 13.3）
                        <GenealogyStaticFallback
                            data={data}
                            selectedId={sel}
                            onSelect={handleSelect}
                        />
                    ) : (
                        <Scene3D
                            cameraPosition={VIEW_PRESETS[currentView]}
                            cameraFov={50}
                            frameloop={frameloop}
                            dpr={dpr}
                            autoRotate
                            autoRotateSpeed={0.03}
                            enableControls
                            enableDamping
                            className="evolution-eye-scene"
                        >
                            <Genealogy3DContent
                                data={data}
                                selectedId={sel}
                                hoveredId={hov}
                                onSelect={handleSelect}
                                onHover={handleHover}
                                predictions={predictions}
                                targetView={currentView}
                                onViewSwitch={handleViewSwitch}
                                enableMotion={enableMotion}
                                onPerfLevelChange={handlePerfLevelChange}
                            />
                        </Scene3D>
                    )}
                </div>
            </Suspense>
        </SectionErrorBoundary>
    )
}

/* ============================================================
 * 默认导出（用于 React.lazy）
 * ============================================================ */

export default Genealogy3D
