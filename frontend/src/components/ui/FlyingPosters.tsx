import { memo, useEffect, useRef, useState } from 'react'
import { Camera, Mesh, Plane, Program, Renderer, Texture, Transform } from 'ogl'
import './FlyingPosters.css'

export interface FlyingPosterItem {
    id: string
    src: string
    alt: string
}

export interface FlyingPostersProps {
    items: readonly FlyingPosterItem[]
    activeIndex?: number
    className?: string
    ariaLabel?: string
    planeWidth?: number
    planeHeight?: number
    distortion?: number
    cameraFov?: number
    cameraZ?: number
    onActiveIndexChange?: (index: number) => void
    onActivate?: (index: number) => void
}

const VERTEX_SHADER = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uPosition;
uniform vec3 distortionAxis;
uniform vec3 rotationAxis;
uniform float uDistortion;
varying vec2 vUv;

const float PI = 3.141592653589793238;

mat4 rotationMatrix(vec3 axis, float angle) {
    axis = normalize(axis);
    float s = sin(angle);
    float c = cos(angle);
    float oc = 1.0 - c;
    return mat4(
        oc * axis.x * axis.x + c,          oc * axis.x * axis.y - axis.z * s, oc * axis.z * axis.x + axis.y * s, 0.0,
        oc * axis.x * axis.y + axis.z * s, oc * axis.y * axis.y + c,          oc * axis.y * axis.z - axis.x * s, 0.0,
        oc * axis.z * axis.x - axis.y * s, oc * axis.y * axis.z + axis.x * s, oc * axis.z * axis.z + c,          0.0,
        0.0,                                0.0,                                0.0,                                1.0
    );
}

float quinticInOut(float value) {
    return value < 0.5
        ? 16.0 * pow(value, 5.0)
        : -0.5 * abs(pow(2.0 * value - 2.0, 5.0)) + 1.0;
}

void main() {
    vUv = uv;
    vec3 nextPosition = position;
    float offset = dot(distortionAxis, position) + 0.25;
    float progress = clamp(
        (fract(uPosition * 0.05) - 0.01 * uDistortion * offset) / (1.0 - 0.01 * uDistortion),
        0.0,
        1.0
    );
    progress = quinticInOut(progress) * PI;
    nextPosition = (rotationMatrix(rotationAxis, progress) * vec4(nextPosition, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(nextPosition, 1.0);
}
`

const FRAGMENT_SHADER = `
precision highp float;
uniform vec2 uImageSize;
uniform vec2 uPlaneSize;
uniform sampler2D tMap;
uniform float uAlpha;
varying vec2 vUv;

void main() {
    float imageAspect = uImageSize.x / max(uImageSize.y, 1.0);
    float planeAspect = uPlaneSize.x / max(uPlaneSize.y, 0.001);
    vec2 scale = vec2(1.0);
    if (planeAspect > imageAspect) scale.x = imageAspect / planeAspect;
    else scale.y = planeAspect / imageAspect;
    vec2 imageUv = vUv * scale + (1.0 - scale) * 0.5;
    vec4 color = texture2D(tMap, imageUv);
    gl_FragColor = vec4(color.rgb, color.a * uAlpha);
}
`

function clampIndex(value: number, count: number): number {
    if (count <= 0 || !Number.isFinite(value)) return 0
    return Math.max(0, Math.min(count - 1, Math.trunc(value)))
}

function wrapIndex(value: number, count: number): number {
    if (count <= 0) return 0
    return ((value % count) + count) % count
}

function shortestIndexDelta(from: number, to: number, count: number): number {
    if (count <= 1) return 0
    const direct = to - from
    const forward = direct + count
    const backward = direct - count
    return [direct, forward, backward].reduce((best, candidate) => (
        Math.abs(candidate) < Math.abs(best) ? candidate : best
    ))
}

export const FlyingPosters = memo(function FlyingPosters({
    items,
    activeIndex = 0,
    className,
    ariaLabel = '3D 诗境画廊',
    planeWidth = 520,
    planeHeight = 292,
    distortion = 3,
    cameraFov = 45,
    cameraZ = 20,
    onActiveIndexChange,
    onActivate,
}: FlyingPostersProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const activeIndexRef = useRef(activeIndex)
    const activeCallbackRef = useRef(onActiveIndexChange)
    const activateCallbackRef = useRef(onActivate)
    const setExternalIndexRef = useRef<((index: number) => void) | null>(null)
    const nudgeRef = useRef<((delta: number) => void) | null>(null)
    const [rendererState, setRendererState] = useState<'ready' | 'fallback'>('ready')

    activeCallbackRef.current = onActiveIndexChange
    activateCallbackRef.current = onActivate

    useEffect(() => {
        const containerNode = containerRef.current
        const canvasNode = canvasRef.current
        if (!containerNode || !canvasNode || items.length === 0) return
        const container: HTMLDivElement = containerNode
        const canvas: HTMLCanvasElement = canvasNode

        let renderer: Renderer
        try {
            renderer = new Renderer({
                canvas,
                alpha: true,
                antialias: window.innerWidth > 640,
                dpr: Math.min(window.devicePixelRatio || 1, 1.25),
                powerPreference: 'high-performance',
            })
        } catch {
            setRendererState('fallback')
            return
        }

        setRendererState('ready')
        const gl = renderer.gl
        gl.clearColor(0, 0, 0, 0)
        const camera = new Camera(gl)
        camera.fov = cameraFov
        camera.position.z = cameraZ
        const scene = new Transform()
        const geometry = new Plane(gl, { widthSegments: 24, heightSegments: 1 })
        let destroyed = false

        // 诗库当前有 148 张图。一次性为全库创建纹理会同时触发 148 次图片解码，
        // 并把所有位图常驻显存。固定纹理池只保留前景附近 7 张（移动端 3 张），
        // 仍可循环浏览全库，但网络、解码、program 与显存成本不再随诗库线性增长。
        const poolSize = Math.min(items.length, window.innerWidth <= 640 ? 3 : 7)
        const poolCenter = Math.floor(poolSize / 2)
        const media = Array.from({ length: poolSize }, (_, poolIndex) => {
            const texture = new Texture(gl, { generateMipmaps: false })
            const program = new Program(gl, {
                depthTest: false,
                depthWrite: false,
                cullFace: false,
                vertex: VERTEX_SHADER,
                fragment: FRAGMENT_SHADER,
                uniforms: {
                    tMap: { value: texture },
                    uPosition: { value: 0 },
                    uPlaneSize: { value: [1, 1] },
                    uImageSize: { value: [16, 9] },
                    uAlpha: { value: 0.78 },
                    rotationAxis: { value: [0, 1, 0] },
                    distortionAxis: { value: [1, 1, 0] },
                    uDistortion: { value: distortion },
                },
            })
            const mesh = new Mesh(gl, { geometry, program })
            mesh.setParent(scene)
            return {
                offset: poolIndex - poolCenter,
                mesh,
                program,
                texture,
                currentItemIndex: -1,
                loadGeneration: 0,
                loaded: false,
                pendingImage: null as HTMLImageElement | null,
            }
        })

        function loadMediaTexture(entry: typeof media[number], itemIndex: number) {
            if (entry.currentItemIndex === itemIndex) return
            entry.currentItemIndex = itemIndex
            entry.loaded = false
            entry.loadGeneration += 1
            const loadGeneration = entry.loadGeneration
            if (entry.pendingImage) {
                entry.pendingImage.onload = null
                entry.pendingImage.onerror = null
                entry.pendingImage.src = ''
            }
            const image = new Image()
            entry.pendingImage = image
            image.decoding = 'async'
            image.onload = () => {
                if (destroyed || loadGeneration !== entry.loadGeneration) return
                entry.texture.image = image
                entry.program.uniforms.uImageSize.value = [image.naturalWidth, image.naturalHeight]
                entry.loaded = true
                entry.pendingImage = null
                image.onload = null
                image.onerror = null
                requestRender()
            }
            image.onerror = () => {
                if (loadGeneration === entry.loadGeneration) {
                    entry.pendingImage = null
                    entry.loaded = false
                }
                image.onload = null
                image.onerror = null
                requestRender()
            }
            image.src = items[itemIndex]?.src ?? ''
        }

        let frameId: number | null = null
        let isVisible = true
        let documentVisible = document.visibilityState !== 'hidden'
        let reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
        let viewportWidth = 1
        let viewportHeight = 1
        let itemSpacing = 1
        let scrollCurrent = 0
        let scrollTarget = 0
        let pointerStartY = 0
        let pointerStartTarget = 0
        let pointerMoved = false
        let pointerId: number | null = null
        let lastReportedIndex = clampIndex(activeIndexRef.current, items.length)

        function renderFrame() {
            frameId = null
            if (destroyed || !isVisible || !documentVisible) return

            const difference = scrollTarget - scrollCurrent
            scrollCurrent = reducedMotion || Math.abs(difference) < 0.0005
                ? scrollTarget
                : scrollCurrent + difference * 0.095

            const viewportWorldHeight = Math.max(1, 2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.z)
            const scrollUnits = scrollCurrent / Math.max(itemSpacing, 0.001)
            const centerIndex = Math.round(scrollUnits)
            const fractionalOffset = scrollUnits - centerIndex
            for (const entry of media) {
                const itemIndex = wrapIndex(centerIndex + entry.offset, items.length)
                loadMediaTexture(entry, itemIndex)
                const positionY = (entry.offset - fractionalOffset) * itemSpacing
                entry.mesh.position.y = positionY
                const distance = Math.min(1, Math.abs(positionY) / Math.max(viewportWorldHeight * 0.5, 0.001))
                // 中心卡必须以正面完整展示。旧基值 10 会令 fract(10 * .05)=.5，
                // 恰好把中心平面旋转 90° 成一条细线；只让离中心距离驱动侧卡旋转。
                entry.program.uniforms.uPosition.value = positionY * 0.42
                entry.program.uniforms.uAlpha.value = entry.loaded ? 1 - distance * 0.62 : 0
            }
            renderer.render({ scene, camera })

            const nextIndex = wrapIndex(Math.round(scrollCurrent / itemSpacing), items.length)
            if (nextIndex !== lastReportedIndex) {
                lastReportedIndex = nextIndex
                activeIndexRef.current = nextIndex
                activeCallbackRef.current?.(nextIndex)
            }

            if (!reducedMotion && Math.abs(scrollTarget - scrollCurrent) >= 0.0005) requestRender()
        }

        function requestRender() {
            if (destroyed || frameId !== null || !isVisible || !documentVisible) return
            frameId = window.requestAnimationFrame(renderFrame)
        }

        function resize() {
            const rect = container.getBoundingClientRect()
            viewportWidth = Math.max(1, rect.width)
            viewportHeight = Math.max(1, rect.height)
            renderer.setSize(viewportWidth, viewportHeight)
            camera.perspective({ aspect: viewportWidth / viewportHeight })
            const worldHeight = 2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.z
            const worldWidth = worldHeight * camera.aspect
            const scaleX = worldWidth * Math.min(0.72, planeWidth / viewportWidth)
            const scaleY = worldHeight * Math.min(0.43, planeHeight / viewportHeight)
            itemSpacing = scaleY + Math.max(0.72, worldHeight * 0.035)
            for (const entry of media) {
                entry.mesh.scale.x = scaleX
                entry.mesh.scale.y = scaleY
                entry.program.uniforms.uPlaneSize.value = [scaleX, scaleY]
            }
            const normalizedIndex = clampIndex(activeIndexRef.current, items.length)
            scrollCurrent = normalizedIndex * itemSpacing
            scrollTarget = scrollCurrent
            requestRender()
        }

        function setExternalIndex(index: number) {
            const next = clampIndex(index, items.length)
            const current = wrapIndex(Math.round(scrollTarget / itemSpacing), items.length)
            scrollTarget += shortestIndexDelta(current, next, items.length) * itemSpacing
            requestRender()
        }

        function nudge(delta: number) {
            scrollTarget = Math.round(scrollTarget / itemSpacing) * itemSpacing + delta * itemSpacing
            requestRender()
        }

        function handleWheel(event: WheelEvent) {
            event.preventDefault()
            const direction = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
            scrollTarget += direction * itemSpacing * 0.0018
            requestRender()
        }

        function handlePointerDown(event: PointerEvent) {
            pointerId = event.pointerId
            pointerStartY = event.clientY
            pointerStartTarget = scrollTarget
            pointerMoved = false
            canvas.setPointerCapture(event.pointerId)
        }

        function handlePointerMove(event: PointerEvent) {
            if (pointerId !== event.pointerId) return
            const distance = pointerStartY - event.clientY
            pointerMoved ||= Math.abs(distance) > 5
            scrollTarget = pointerStartTarget + distance * itemSpacing / Math.max(72, viewportHeight * 0.18)
            requestRender()
        }

        function handlePointerEnd(event: PointerEvent) {
            if (pointerId !== event.pointerId) return
            pointerId = null
            if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
            scrollTarget = Math.round(scrollTarget / itemSpacing) * itemSpacing
            requestRender()
            if (!pointerMoved) activateCallbackRef.current?.(lastReportedIndex)
        }

        function handleKeyDown(event: KeyboardEvent) {
            if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                event.preventDefault()
                nudge(-1)
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                event.preventDefault()
                nudge(1)
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                activateCallbackRef.current?.(lastReportedIndex)
            }
        }

        function handleVisibilityChange() {
            documentVisible = document.visibilityState !== 'hidden'
            if (!documentVisible && frameId !== null) {
                window.cancelAnimationFrame(frameId)
                frameId = null
            } else requestRender()
        }

        const resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(resize)
            : null
        resizeObserver?.observe(container)
        const intersectionObserver = typeof IntersectionObserver === 'function'
            ? new IntersectionObserver(([entry]) => {
                isVisible = entry?.isIntersecting ?? true
                if (!isVisible && frameId !== null) {
                    window.cancelAnimationFrame(frameId)
                    frameId = null
                } else requestRender()
            }, { rootMargin: '160px' })
            : null
        intersectionObserver?.observe(container)

        const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)')
        const handleMotionChange = (event: MediaQueryListEvent) => {
            reducedMotion = event.matches
            scrollCurrent = scrollTarget
            requestRender()
        }
        motionQuery?.addEventListener?.('change', handleMotionChange)
        if (!resizeObserver) window.addEventListener('resize', resize)
        canvas.addEventListener('wheel', handleWheel, { passive: false })
        canvas.addEventListener('pointerdown', handlePointerDown)
        canvas.addEventListener('pointermove', handlePointerMove)
        canvas.addEventListener('pointerup', handlePointerEnd)
        canvas.addEventListener('pointercancel', handlePointerEnd)
        canvas.addEventListener('keydown', handleKeyDown)
        document.addEventListener('visibilitychange', handleVisibilityChange)
        setExternalIndexRef.current = setExternalIndex
        nudgeRef.current = nudge
        resize()

        return () => {
            destroyed = true
            setExternalIndexRef.current = null
            nudgeRef.current = null
            if (frameId !== null) window.cancelAnimationFrame(frameId)
            resizeObserver?.disconnect()
            intersectionObserver?.disconnect()
            motionQuery?.removeEventListener?.('change', handleMotionChange)
            if (!resizeObserver) window.removeEventListener('resize', resize)
            canvas.removeEventListener('wheel', handleWheel)
            canvas.removeEventListener('pointerdown', handlePointerDown)
            canvas.removeEventListener('pointermove', handlePointerMove)
            canvas.removeEventListener('pointerup', handlePointerEnd)
            canvas.removeEventListener('pointercancel', handlePointerEnd)
            canvas.removeEventListener('keydown', handleKeyDown)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
            for (const entry of media) {
                entry.loadGeneration += 1
                if (entry.pendingImage) {
                    entry.pendingImage.onload = null
                    entry.pendingImage.onerror = null
                    entry.pendingImage.src = ''
                    entry.pendingImage = null
                }
                entry.mesh.setParent(null)
                if (entry.texture.texture) gl.deleteTexture(entry.texture.texture)
            }
            gl.getExtension('WEBGL_lose_context')?.loseContext()
        }
    }, [ariaLabel, cameraFov, cameraZ, distortion, items, planeHeight, planeWidth])

    useEffect(() => {
        activeIndexRef.current = activeIndex
        setExternalIndexRef.current?.(activeIndex)
    }, [activeIndex])

    const safeIndex = clampIndex(activeIndex, items.length)
    const activeItem = items[safeIndex]
    const rootClassName = ['pr-flying-posters', className].filter(Boolean).join(' ')

    return (
        <section
            ref={containerRef}
            className={rootClassName}
            data-flying-posters="ogl"
            data-renderer-state={rendererState}
            aria-label={ariaLabel}
        >
            {activeItem && (
                <img
                    className="pr-flying-posters__fallback"
                    data-visible={rendererState === 'fallback' ? 'true' : 'false'}
                    src={activeItem.src}
                    alt={activeItem.alt}
                    aria-hidden={rendererState === 'fallback' ? undefined : true}
                />
            )}
            <canvas
                ref={canvasRef}
                className="pr-flying-posters__canvas"
                tabIndex={0}
                role="img"
                aria-label={activeItem ? `${activeItem.alt}，拖动或使用方向键浏览，按回车查看诗脉` : ariaLabel}
            />
            <div className="pr-flying-posters__controls" role="group" aria-label="3D 诗境浏览控制">
                <button type="button" onClick={() => nudgeRef.current?.(-1)} aria-label="上一幅诗境图">←</button>
                <button
                    type="button"
                    className="pr-flying-posters__current"
                    onClick={() => activateCallbackRef.current?.(safeIndex)}
                    disabled={!activeItem}
                >
                    <strong>{activeItem?.alt ?? '暂无诗境图'}</strong>
                    <span>{items.length > 0 ? `${safeIndex + 1} / ${items.length}` : '0 / 0'}</span>
                </button>
                <button type="button" onClick={() => nudgeRef.current?.(1)} aria-label="下一幅诗境图">→</button>
            </div>
        </section>
    )
})
