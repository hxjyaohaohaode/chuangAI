/**
 * 3D 基础场景容器 —— 统一的 R3F Canvas 封装（规范第 6、15 章）
 *
 * 职责：
 *  - 统一 Canvas 配置：自适应 DPR、按需渲染、色彩管理、gl alpha
 *  - 内置光照：环境光（暖色基底）+ 定向光（主光，带阴影）
 *  - 内置 OrbitControls：阻尼、缩放、平移，自动旋转可关闭
 *  - 性能：frameloop="demand" 按需渲染；damping 通过 invalidate 驱动
 *  - 无障碍：prefers-reduced-motion 时禁用自动旋转
 *  - 透传 CSS 变量：从 tokens.css 读取暖调色作为光照与环境色
 *
 * 设计要点（规范第 2、6、15 章）：
 *  - 零硬编码色值：光照颜色由 CSS 变量派生（通过 getComputedStyle 一次性读取）
 *  - 玻璃态背景：Canvas 透明背景，由外层 .scene3d-container 提供玻璃态底色
 *  - 性能优先：dpr [1,2] 自适应、frameloop demand、powerPreference high-performance
 *  - 完整三态：OrbitControls 提供 hover/active 视觉反馈（光标变化）
 *
 * 使用示例：
 *   <Scene3D cameraPosition={[0,0,12]} autoRotate>
 *     <DomainSceneContent />
 *   </Scene3D>
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import * as THREE from 'three'
import './Scene3D.css'

/* ============================================================
 * 常量 —— 默认参数
 * ============================================================ */

const DEFAULT_CAMERA_POSITION: [number, number, number] = [0, 0, 12]
const DEFAULT_CAMERA_FOV = 50
const DEFAULT_CAMERA_NEAR = 0.1
const DEFAULT_CAMERA_FAR = 1000

/** DPR 上限 2，避免高 DPI 设备 GPU 过载（规范 15.2 性能硬指标） */
const DPR_RANGE: [number, number] = [1, 2]

/* ============================================================
 * Hooks —— prefers-reduced-motion 检测
 * ============================================================ */

/**
 * 检测用户是否启用了"减少动效"系统偏好
 * 启用时：禁用自动旋转、缩短动画时长
 * SSR 安全：首渲染返回 false
 */
export function usePrefersReducedMotion(): boolean {
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
        if (typeof mql.addEventListener === 'function') {
            mql.addEventListener('change', onChange)
            return () => mql.removeEventListener('change', onChange)
        }
        if (typeof mql.addListener === 'function') {
            mql.addListener(onChange)
            return () => mql.removeListener(onChange)
        }
        return undefined
    }, [])

    return reduced
}

/* ============================================================
 * Hooks —— CSS 变量 → THREE.Color 派生
 * ============================================================ */

/**
 * 从 tokens.css 读取 RGB 通道（"R G B" 格式）转为 THREE.Color
 * 一次性读取 + 缓存，避免每帧 getComputedStyle 调用
 */
function useTokenColor(varName: string, fallback: THREE.ColorRepresentation): THREE.Color {
    const color = useMemo(() => {
        const c = new THREE.Color(fallback)
        if (typeof window === 'undefined') return c
        try {
            const raw = getComputedStyle(document.documentElement)
                .getPropertyValue(varName)
                .trim()
            if (!raw) return c
            // tokens.css 格式："R G B" 或 "r g b / alpha"
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
    }, [varName, fallback])
    return color
}

/* ============================================================
 * 内部组件 —— 光照系统
 * ============================================================ */

interface LightingProps {
    /** 是否启用阴影（定向光投射阴影，默认 false 以节省性能） */
    castShadow?: boolean
}

/**
 * 光照系统：
 *  - ambientLight：暖调环境光，从 --c-surface-primary 派生（微暖米白）
 *  - directionalLight：主光，暖白倾向，模拟自然光
 *  - pointLight：补光，强调色微暖，营造星图氛围
 */
function Lighting({ castShadow = false }: LightingProps) {
    const ambientColor = useTokenColor('--c-surface-primary', '#FAF8F5')
    const accentColor = useTokenColor('--c-accent-primary', '#986227')
    // 主光使用 surface-elevated 的暖白倾向（设计 token 派生，避免硬编码）
    const directionalColor = useTokenColor('--c-surface-elevated', '#FFFCF8')

    return (
        <>
            <ambientLight color={ambientColor} intensity={0.65} />
            <directionalLight
                position={[10, 12, 8]}
                intensity={1.1}
                color={directionalColor}
                castShadow={castShadow}
                shadow-mapSize-width={1024}
                shadow-mapSize-height={1024}
                shadow-camera-far={50}
                shadow-camera-left={-15}
                shadow-camera-right={15}
                shadow-camera-top={15}
                shadow-camera-bottom={-15}
            />
            {/* 强调色补光 —— 暖调氛围 */}
            <pointLight
                position={[-8, -6, -4]}
                intensity={0.35}
                color={accentColor}
                distance={30}
                decay={2}
            />
        </>
    )
}

/* ============================================================
 * 内部组件 —— 渲染就绪回调
 * ============================================================ */

interface ReadyProbeProps {
    onReady?: () => void
}

/** Canvas 内部触发 onReady 回调（在第一帧渲染后） */
function ReadyProbe({ onReady }: ReadyProbeProps) {
    const { gl } = useThree()
    const firedRef = useRef(false)
    useEffect(() => {
        if (firedRef.current) return
        firedRef.current = true
        // 下一帧触发，确保场景已挂载
        const id = requestAnimationFrame(() => onReady?.())
        return () => cancelAnimationFrame(id)
    }, [gl, onReady])
    return null
}

/* ============================================================
 * 内部组件 —— 自动旋转控制（受 reduced-motion 影响）
 * ============================================================ */

interface AutoRotateProps {
    enabled: boolean
    speed?: number
}

/**
 * 通过 useFrame 持续旋转父 group —— 仅在 enabled 且非 reduced-motion 时生效
 * 注意：此组件需放在 Canvas 内
 */
function AutoRotateGroup({ enabled, speed = 0.05, children }: AutoRotateProps & { children: ReactNode }) {
    const groupRef = useRef<THREE.Group>(null)

    // 旋转并入 R3F 自身帧循环，避免在 demand/hidden 状态下另起永久 RAF。
    // 0.6 将旧实现 60fps × 0.01/frame 的速度换算为与帧率无关的 rad/s。
    useFrame((_state, delta) => {
        if (!enabled || !groupRef.current) return
        const safeSpeed = Number.isFinite(speed) ? Math.max(-4, Math.min(4, speed)) : 0.05
        groupRef.current.rotation.y += safeSpeed * 0.6 * Math.min(delta, 0.1)
    })

    return <group ref={groupRef}>{children}</group>
}

/* ============================================================
 * 主组件 —— Scene3D
 * ============================================================ */

export interface Scene3DProps {
    /** 相机初始位置（默认 [0,0,12]） */
    cameraPosition?: [number, number, number]
    /** 相机视场角（默认 50） */
    cameraFov?: number
    /** 相机近裁面（默认 0.1） */
    cameraNear?: number
    /** 相机远裁面（默认 1000） */
    cameraFar?: number
    /** 是否启用 OrbitControls（默认 true） */
    enableControls?: boolean
    /**
     * 轨道控制模式。
     * free 为知识宇宙等探索场景提供完整旋转、光标缩放和屏幕空间平移；
     * standard 保持其他页面既有手感。
     */
    controlsMode?: 'standard' | 'free'
    /** 是否启用自动旋转（默认 false，受 prefers-reduced-motion 影响） */
    autoRotate?: boolean
    /** 自动旋转速度（默认 0.05） */
    autoRotateSpeed?: number
    /** 是否启用阻尼（默认 true） */
    enableDamping?: boolean
    /** 是否启用阴影（默认 false，节省性能） */
    enableShadow?: boolean
    /** 渲染模式：demand=按需(默认)、always=每帧、never=永不 */
    frameloop?: 'always' | 'demand' | 'never'
    /**
     * DPR 范围（规范 13.3：低帧率自动降 DPR）
     * 默认 [1, 2]，可由父组件动态传入以实现性能降级
     */
    dpr?: [number, number]
    /** 场景就绪回调 */
    onReady?: () => void
    /** 容器 className */
    className?: string
    /** 容器 style */
    style?: CSSProperties
    /** 场景内容 */
    children: ReactNode
}

export function Scene3D({
    cameraPosition = DEFAULT_CAMERA_POSITION,
    cameraFov = DEFAULT_CAMERA_FOV,
    cameraNear = DEFAULT_CAMERA_NEAR,
    cameraFar = DEFAULT_CAMERA_FAR,
    enableControls = true,
    controlsMode = 'standard',
    autoRotate = false,
    autoRotateSpeed = 0.05,
    enableDamping = true,
    enableShadow = false,
    frameloop = 'demand',
    dpr = DPR_RANGE,
    onReady,
    className,
    style,
    children,
}: Scene3DProps) {
    const reduced = usePrefersReducedMotion()
    const containerRef = useRef<HTMLDivElement>(null)
    const [inViewport, setInViewport] = useState(true)
    const [documentVisible, setDocumentVisible] = useState(() => (
        typeof document === 'undefined' || document.visibilityState !== 'hidden'
    ))

    useEffect(() => {
        if (typeof document === 'undefined') return
        const onVisibilityChange = () => setDocumentVisible(document.visibilityState !== 'hidden')
        onVisibilityChange()
        document.addEventListener('visibilitychange', onVisibilityChange)
        return () => document.removeEventListener('visibilitychange', onVisibilityChange)
    }, [])

    useEffect(() => {
        const node = containerRef.current
        if (!node || typeof IntersectionObserver !== 'function') {
            // 老 WebView/测试桩环境 fail-open：功能可用优先，不能因观测器缺失白屏。
            setInViewport(true)
            return
        }

        let observer: IntersectionObserver | null = null
        try {
            observer = new IntersectionObserver(
                ([entry]) => setInViewport(Boolean(entry?.isIntersecting)),
                { rootMargin: '160px 0px', threshold: 0.01 },
            )
            observer.observe(node)
        } catch {
            observer?.disconnect()
            setInViewport(true)
            return
        }
        return () => observer?.disconnect()
    }, [])

    const sceneActive = inViewport && documentVisible
    const effectiveAutoRotate = autoRotate && !reduced && sceneActive
    const effectiveFrameloop: 'always' | 'demand' | 'never' = !sceneActive
        ? 'never'
        : reduced && frameloop === 'always'
            ? 'demand'
            : effectiveAutoRotate && frameloop === 'demand'
                ? 'always'
                : frameloop
    const freeControls = controlsMode === 'free'

    const containerClass = useMemo(() => {
        const cls = ['scene3d-container']
        if (className) cls.push(className)
        return cls.join(' ')
    }, [className])

    return (
        <div
            ref={containerRef}
            className={containerClass}
            style={style}
            role="region"
            aria-label="3D 可视化场景"
            data-scene3d-frame-mode={effectiveFrameloop}
            data-scene3d-viewport={inViewport ? 'visible' : 'hidden'}
            data-scene3d-document={documentVisible ? 'visible' : 'hidden'}
            data-scene3d-motion={reduced ? 'reduced' : 'full'}
        >
            <Canvas
                shadows={enableShadow}
                dpr={dpr}
                frameloop={effectiveFrameloop}
                gl={{
                    antialias: true,
                    alpha: true,
                    powerPreference: 'high-performance',
                    toneMapping: THREE.ACESFilmicToneMapping,
                    toneMappingExposure: 1.0,
                }}
                camera={{
                    position: cameraPosition,
                    fov: cameraFov,
                    near: cameraNear,
                    far: cameraFar,
                }}
                onCreated={({ gl }) => {
                    // 透明背景，由 CSS 容器提供玻璃态底色
                    gl.setClearColor(0x000000, 0)
                }}
            >
                <Lighting castShadow={enableShadow} />

                <AutoRotateGroup enabled={effectiveAutoRotate} speed={autoRotateSpeed}>
                    {children}
                </AutoRotateGroup>

                {enableControls && (
                    <OrbitControls
                        enableDamping={enableDamping}
                        dampingFactor={freeControls ? 0.055 : 0.08}
                        rotateSpeed={freeControls ? 0.9 : 0.7}
                        zoomSpeed={freeControls ? 1.05 : 0.8}
                        panSpeed={freeControls ? 0.82 : 0.6}
                        minDistance={freeControls ? 1.4 : 2}
                        maxDistance={freeControls ? 120 : 80}
                        minPolarAngle={freeControls ? 0.025 : 0}
                        maxPolarAngle={freeControls ? Math.PI - 0.025 : Math.PI}
                        screenSpacePanning={freeControls}
                        zoomToCursor={freeControls}
                        enableRotate
                        enableZoom
                        enablePan
                        makeDefault
                    />
                )}

                <ReadyProbe onReady={onReady} />
            </Canvas>
        </div>
    )
}

/* ============================================================
 * 导出 —— 便捷 hooks 与工具
 * ============================================================ */

export { usePrefersReducedMotion as useScene3DReducedMotion }
