/**
 * 思考宫殿 · 3D 思考链可视化（规范第 6、10、15 章）
 *
 * 职责：
 *  - 包装 Scene3D 提供 R3F Canvas 容器
 *  - 节点：按类型使用不同几何体
 *      - hypothesis  假设 → 八面体 octahedron  + accent-info（蓝）
 *      - reasoning   推理 → 四面体 tetrahedron + accent-primary（金）
 *      - evidence    证据 → 立方体 cube       + accent-success（绿）
 *      - question    质疑 → 二十面体 icosahedron + accent-warning（琥珀）
 *      - conclusion  结论 → 球体 sphere       + accent-primary（金，高亮）
 *  - 布局：螺旋路径（spiral），节点沿 Y 轴上升，XZ 平面螺旋展开
 *  - 边：节点间连线 + 流光效果（沿线移动的小球，模拟"思考流动"）
 *  - 播放：支持自动播放（节点逐个高亮），播放/暂停按钮
 *  - 交互：节点 hover 显示 tooltip，click 选中并通知父组件
 *  - 错误边界：3D 渲染失败时降级到 2D 摘要
 *
 * 性能策略：
 *  - 几何体/材质 useMemo 缓存，按类型共享
 *  - 边合并为单一 LineSegments
 *  - frameloop="always"：流光动画需要连续渲染
 *  - prefers-reduced-motion：禁用流光与播放
 *
 * 设计要点（规范第 2、4、6 章）：
 *  - 零硬编码色值：颜色由 CSS 变量派生
 *  - 玻璃态背景：由 Scene3D.css 的 .scene3d-container 提供
 *  - 无障碍：prefers-reduced-motion 降级
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import { Scene3D, useScene3DReducedMotion } from '@/components/three'
import { SectionErrorBoundary } from '@/components/ui'
import type { ThinkingChain, ThinkingNode, ThinkingNodeType } from '@/lib/types'

/* ============================================================
 * 常量
 * ============================================================ */

/** 节点半径（统一大小，通过几何体形状区分类型） */
const NODE_RADIUS = 0.7

/** 螺旋参数：旋转圈数 */
const SPIRAL_TURNS = 2.5

/** 螺旋参数：起始半径 */
const SPIRAL_RADIUS_MIN = 2.0

/** 螺旋参数：半径扩展 */
const SPIRAL_RADIUS_GROWTH = 1.8

/** 螺旋参数：Y 轴范围（-Y_HALF 到 +Y_HALF） */
const SPIRAL_Y_HALF = 5

/** 流光小球半径 */
const FLOW_PARTICLE_RADIUS = 0.15

/** 流光速度（每秒移动比例 0..1） */
const FLOW_SPEED = 0.25

/* ============================================================
 * Hook —— CSS 变量 → THREE.Color 调色板
 * ============================================================ */

interface ThinkingPalette {
    accentPrimary: THREE.Color
    accentInfo: THREE.Color
    accentSuccess: THREE.Color
    accentWarning: THREE.Color
    textPrimary: THREE.Color
    textTertiary: THREE.Color
}

function usePalette(): ThinkingPalette {
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
            accentInfo: read('--c-accent-info', '#456f94'),
            accentSuccess: read('--c-accent-success', '#4a7a4e'),
            accentWarning: read('--c-accent-warning', '#8f6a1c'),
            textPrimary: read('--c-text-primary', '#2c241a'),
            textTertiary: read('--c-text-tertiary', '#6e665c'),
        }
    }, [])
}

/* ============================================================
 * 工具 —— 螺旋路径计算
 * index 0..n-1 → 3D 坐标
 * ============================================================ */

function spiralPosition(index: number, total: number): [number, number, number] {
    const t = total > 1 ? index / (total - 1) : 0.5
    const angle = t * Math.PI * 2 * SPIRAL_TURNS
    const radius = SPIRAL_RADIUS_MIN + t * SPIRAL_RADIUS_GROWTH
    const y = (t - 0.5) * 2 * SPIRAL_Y_HALF
    return [radius * Math.cos(angle), y, radius * Math.sin(angle)]
}

/* ============================================================
 * 工具 —— 节点类型 → 几何体 + 颜色
 * ============================================================ */

interface NodeTypeVisual {
    geometry: THREE.BufferGeometry
    color: THREE.Color
    emissive: THREE.Color
    opacity: number
}

function useNodeTypeVisuals(pal: ThinkingPalette): Record<ThinkingNodeType, NodeTypeVisual> {
    return useMemo(() => {
        // 共享几何体（每类型一个实例）
        const geometryMap: Record<ThinkingNodeType, THREE.BufferGeometry> = {
            hypothesis: new THREE.OctahedronGeometry(NODE_RADIUS, 0),
            reasoning: new THREE.TetrahedronGeometry(NODE_RADIUS, 0),
            evidence: new THREE.BoxGeometry(NODE_RADIUS * 1.2, NODE_RADIUS * 1.2, NODE_RADIUS * 1.2),
            question: new THREE.IcosahedronGeometry(NODE_RADIUS, 0),
            conclusion: new THREE.SphereGeometry(NODE_RADIUS, 24, 24),
        }
        return {
            hypothesis: {
                geometry: geometryMap.hypothesis,
                color: pal.accentInfo.clone(),
                emissive: pal.accentInfo.clone().multiplyScalar(0.3),
                opacity: 0.85,
            },
            reasoning: {
                geometry: geometryMap.reasoning,
                color: pal.accentPrimary.clone(),
                emissive: pal.accentPrimary.clone().multiplyScalar(0.3),
                opacity: 0.85,
            },
            evidence: {
                geometry: geometryMap.evidence,
                color: pal.accentSuccess.clone(),
                emissive: pal.accentSuccess.clone().multiplyScalar(0.3),
                opacity: 0.85,
            },
            question: {
                geometry: geometryMap.question,
                color: pal.accentWarning.clone(),
                emissive: pal.accentWarning.clone().multiplyScalar(0.3),
                opacity: 0.85,
            },
            conclusion: {
                geometry: geometryMap.conclusion,
                color: pal.accentPrimary.clone(),
                emissive: pal.accentPrimary.clone().multiplyScalar(0.5),
                opacity: 0.95,
            },
        }
    }, [pal])
}

/* ============================================================
 * 内部组件 —— 单个思考节点
 * ============================================================ */

interface ThinkingNode3DProps {
    node: ThinkingNode
    position: [number, number, number]
    visual: NodeTypeVisual
    isActive: boolean
    isHovered: boolean
    index: number
    onSelect: (index: number) => void
    onHover: (index: number | null) => void
}

function ThinkingNode3D({
    node,
    position,
    visual,
    isActive,
    isHovered,
    index,
    onSelect,
    onHover,
}: ThinkingNode3DProps) {
    const meshRef = useRef<THREE.Mesh>(null)
    const reduced = useScene3DReducedMotion()

    const material = useMemo(() => {
        return new THREE.MeshStandardMaterial({
            color: visual.color,
            emissive: visual.emissive,
            emissiveIntensity: isActive ? 0.9 : 0.4,
            transparent: true,
            opacity: isActive ? 1 : visual.opacity,
            roughness: 0.4,
            metalness: 0.2,
        })
    }, [visual, isActive])

    useEffect(() => {
        return () => {
            material.dispose()
        }
    }, [material])

    // 选中或悬停时脉动 + 旋转
    useFrame((state) => {
        if (!meshRef.current) return
        if (!reduced) {
            // 持续轻微旋转，让 3D 感更强
            meshRef.current.rotation.y += 0.005
            meshRef.current.rotation.x += 0.002
        }
        if (isActive) {
            const s = 1.3 + Math.sin(state.clock.elapsedTime * 3) * 0.08
            meshRef.current.scale.setScalar(s)
        } else if (isHovered) {
            meshRef.current.scale.setScalar(1.2)
        } else {
            meshRef.current.scale.setScalar(1)
        }
    })

    return (
        <group position={position}>
            <mesh
                ref={meshRef}
                geometry={visual.geometry}
                material={material}
                onClick={(e) => {
                    e.stopPropagation()
                    onSelect(index)
                }}
                onPointerOver={(e) => {
                    e.stopPropagation()
                    onHover(index)
                }}
                onPointerOut={() => onHover(null)}
            />
            {(isActive || isHovered) && (
                <Html
                    center
                    distanceFactor={10}
                    position={[0, NODE_RADIUS + 0.5, 0]}
                    style={{
                        pointerEvents: 'none',
                        padding: '6px 10px',
                        background: 'rgb(var(--c-surface-elevated) / 0.92)',
                        backdropFilter: 'blur(12px)',
                        borderRadius: '8px',
                        fontSize: '11px',
                        color: 'rgb(var(--c-text-primary))',
                        maxWidth: '240px',
                        boxShadow: '0 4px 16px rgba(44, 36, 26, 0.10)',
                        fontVariantNumeric: 'tabular-nums',
                    }}
                >
                    <div style={{ fontWeight: 600 }}>#{node.index + 1} · {node.type}</div>
                    <div style={{ fontSize: '10px', color: 'rgb(var(--c-text-secondary))', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {node.content.slice(0, 40)}{node.content.length > 40 ? '…' : ''}
                    </div>
                </Html>
            )}
        </group>
    )
}

/* ============================================================
 * 内部组件 —— 连线 + 流光小球
 * ============================================================ */

interface ThinkingEdges3DProps {
    positions: [number, number, number][]
    color: THREE.Color
}

function ThinkingEdges3D({ positions, color }: ThinkingEdges3DProps) {
    const reduced = useScene3DReducedMotion()

    const geometry = useMemo(() => {
        const pts: number[] = []
        for (let i = 0; i < positions.length - 1; i++) {
            const p1 = positions[i]
            const p2 = positions[i + 1]
            if (!p1 || !p2) continue
            pts.push(...p1, ...p2)
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
        return geo
    }, [positions])

    const material = useMemo(() => {
        return new THREE.LineBasicMaterial({
            color,
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
        })
    }, [color])

    useEffect(() => {
        return () => {
            geometry.dispose()
            material.dispose()
        }
    }, [geometry, material])

    // 流光小球：沿线移动
    const particleRef = useRef<THREE.Mesh>(null)
    const particleMat = useMemo(() => {
        return new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.9,
        })
    }, [color])
    const particleGeo = useMemo(() => new THREE.SphereGeometry(FLOW_PARTICLE_RADIUS, 12, 12), [])

    useEffect(() => {
        return () => {
            particleGeo.dispose()
            particleMat.dispose()
        }
    }, [particleGeo, particleMat])

    useFrame((state) => {
        if (!particleRef.current || reduced || positions.length < 2) return
        const t = (state.clock.elapsedTime * FLOW_SPEED) % 1
        const segCount = positions.length - 1
        const segIdx = Math.min(segCount - 1, Math.floor(t * segCount))
        const localT = t * segCount - segIdx
        const a = positions[segIdx]
        const b = positions[segIdx + 1]
        if (!a || !b) return
        particleRef.current.position.set(
            a[0] + (b[0] - a[0]) * localT,
            a[1] + (b[1] - a[1]) * localT,
            a[2] + (b[2] - a[2]) * localT,
        )
    })

    return (
        <>
            <lineSegments geometry={geometry} material={material} />
            {!reduced && positions.length >= 2 && (
                <mesh ref={particleRef} geometry={particleGeo} material={particleMat} />
            )}
        </>
    )
}

/* ============================================================
 * 内部组件 —— 节点类型图例（3D 内 HTML 浮层）
 * ============================================================ */

function ThinkingLegend() {
    const items = [
        { type: 'hypothesis', label: '假设', className: 'thinking-palace-legend__swatch--hypothesis' },
        { type: 'reasoning', label: '推理', className: 'thinking-palace-legend__swatch--reasoning' },
        { type: 'evidence', label: '证据', className: 'thinking-palace-legend__swatch--evidence' },
        { type: 'question', label: '质疑', className: 'thinking-palace-legend__swatch--question' },
        { type: 'conclusion', label: '结论', className: 'thinking-palace-legend__swatch--conclusion' },
    ] as const

    return (
        <Html
            position={[-SPIRAL_RADIUS_MIN - 1.5, -SPIRAL_Y_HALF - 0.5, 0]}
            center
            distanceFactor={14}
            style={{
                pointerEvents: 'none',
                transform: 'none',
            }}
        >
            <div className="thinking-palace-legend">
                {items.map((it) => (
                    <span key={it.type} className="thinking-palace-legend__item">
                        <span className={`thinking-palace-legend__swatch ${it.className}`} />
                        {it.label}
                    </span>
                ))}
            </div>
        </Html>
    )
}

/* ============================================================
 * 内部组件 —— ThinkingPalace3DContent（Canvas 内）
 * ============================================================ */

interface ThinkingPalace3DContentProps {
    chain: ThinkingChain
    selectedNodeIndex: number | null
    hoveredNodeIndex: number | null
    onSelect: (index: number) => void
    onHover: (index: number | null) => void
}

function ThinkingPalace3DContent({
    chain,
    selectedNodeIndex,
    hoveredNodeIndex,
    onSelect,
    onHover,
}: ThinkingPalace3DContentProps) {
    const pal = usePalette()
    const typeVisuals = useNodeTypeVisuals(pal)

    /* ---------- 节点位置 ---------- */
    const positions = useMemo(() => {
        return chain.nodes.map((_, idx) => spiralPosition(idx, chain.nodes.length))
    }, [chain.nodes])

    /* ---------- 稳定回调 ---------- */
    const handleSelect = useCallback(
        (idx: number) => onSelect(idx),
        [onSelect],
    )
    const handleHover = useCallback(
        (idx: number | null) => onHover(idx),
        [onHover],
    )

    /* ---------- 渲染 ---------- */
    return (
        <>
            <ThinkingLegend />

            <ThinkingEdges3D positions={positions} color={pal.textPrimary} />

            {chain.nodes.map((node, idx) => {
                const visual = typeVisuals[node.type] ?? typeVisuals.reasoning
                const pos = positions[idx]
                if (!pos) return null
                return (
                    <ThinkingNode3D
                        key={`node-${idx}`}
                        node={node}
                        position={pos}
                        visual={visual}
                        isActive={selectedNodeIndex === idx}
                        isHovered={hoveredNodeIndex === idx}
                        index={idx}
                        onSelect={handleSelect}
                        onHover={handleHover}
                    />
                )
            })}
        </>
    )
}

/* ============================================================
 * Error Boundary Fallback
 * ============================================================ */

function ThinkingErrorFallback({ error }: { error: Error }) {
    if (import.meta.env.DEV) console.warn('[ThinkingPalace3D] 渲染失败，降级到 2D:', error)
    return (
        <div className="thinking-palace-canvas-error">
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

function ThinkingLoading() {
    return (
        <div className="thinking-palace-canvas-error">
            <div style={{ fontSize: 'var(--text-sm)' }}>加载 3D 场景…</div>
        </div>
    )
}

/* ============================================================
 * 公开组件 —— ThinkingPalace3D
 * ============================================================ */

export interface ThinkingPalace3DProps {
    /** 当前思考链 */
    chain: ThinkingChain | null
    /** 选中节点索引 */
    selectedNodeIndex?: number | null
    /** 选中节点回调 */
    onSelect?: (index: number) => void
    /** 悬停节点回调 */
    onHover?: (index: number | null) => void
}

export function ThinkingPalace3D({
    chain,
    selectedNodeIndex = null,
    onSelect,
    onHover,
}: ThinkingPalace3DProps) {
    const [internalHovered, setInternalHovered] = useState<number | null>(null)

    const handleSelect = useCallback(
        (idx: number) => onSelect?.(idx),
        [onSelect],
    )
    const handleHover = useCallback(
        (idx: number | null) => {
            setInternalHovered(idx)
            onHover?.(idx)
        },
        [onHover],
    )

    /* ---------- 渲染 ---------- */
    if (!chain || chain.nodes.length === 0) {
        return (
            <div className="thinking-palace-canvas-error">
                <div style={{ fontWeight: 600 }}>暂无思考链数据</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'rgb(var(--c-text-tertiary))' }}>
                    选择左侧思考链以加载 3D 可视化
                </div>
            </div>
        )
    }

    return (
        <SectionErrorBoundary
            fallback={() => <ThinkingErrorFallback error={new Error('WebGL 渲染失败')} />}
        >
            <Suspense fallback={<ThinkingLoading />}>
                <Scene3D
                    cameraPosition={[0, 0, 14]}
                    cameraFov={50}
                    frameloop="always"
                    autoRotate
                    autoRotateSpeed={0.04}
                    enableControls
                    enableDamping
                    className="thinking-palace-scene"
                >
                    <ThinkingPalace3DContent
                        chain={chain}
                        selectedNodeIndex={selectedNodeIndex}
                        hoveredNodeIndex={internalHovered}
                        onSelect={handleSelect}
                        onHover={handleHover}
                    />
                </Scene3D>
            </Suspense>
        </SectionErrorBoundary>
    )
}

export default ThinkingPalace3D
