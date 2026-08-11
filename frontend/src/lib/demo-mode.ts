/**
 * DEMO 模式检测器（v5.0 Task 5.8 —— DEMO 模式深度优化）
 *
 * 设计目的：
 * - 当后端服务不可达时，自动进入 DEMO 模式，前端各页面降级到演示数据
 * - 提供"演示模式"全局横幅，告知评委当前为预览状态
 * - 减少后端不可达时的无效重试（避免 270+ 个 500 错误雪崩）
 *
 * 检测策略（多重信号融合）：
 * 1. 心跳检测：定期 GET /api/health，连续失败 N 次进入 DEMO 模式
 * 2. WS 状态：wsDispatcher 进入 error 状态且重连失败 → DEMO 模式信号
 * 3. API 错误率：fetchJSON 累计错误数超过阈值 → DEMO 模式信号
 *
 * 退出策略：
 * - 心跳恢复（GET /api/health 成功）→ 自动退出 DEMO 模式
 * - 退出后清除错误计数，恢复正常 API 调用
 *
 * 性能：
 * - 心跳间隔 30s（首次延迟 3s，避免与首屏渲染争抢资源）
 * - 失败计数阈值 2（连续 2 次失败进入 DEMO，避免单次抖动误判）
 * - DEMO 模式下心跳间隔延长至 60s（减少无效请求）
 * - 心跳请求超时 3s（快速失败，不阻塞）
 */

import { create } from 'zustand'
import type { WSStatus } from './types'

/* ============================================================
 * 一、DEMO 模式全局状态
 * ============================================================ */

export interface DemoModeState {
    /** 是否处于 DEMO 模式（后端不可达） */
    isDemoMode: boolean
    /** 后端是否可用（最近一次心跳成功） */
    backendAvailable: boolean
    /** 最近一次错误信息（用于横幅 tooltip） */
    lastError: string | null
    /** 最近一次心跳时间戳（ms） */
    lastCheckTime: number | null
    /** 连续失败次数 */
    consecutiveFailures: number
    /** 是否已启动心跳检测（避免重复启动） */
    started: boolean

    /** 进入 DEMO 模式 */
    enterDemoMode: (reason?: string) => void
    /** 退出 DEMO 模式（后端恢复） */
    exitDemoMode: () => void
    /** 记录一次心跳成功 */
    recordHeartbeatSuccess: () => void
    /** 记录一次心跳失败 */
    recordHeartbeatFailure: (reason?: string) => void
    /** 记录一次 API 错误（非心跳） */
    recordApiError: (reason?: string) => void
    /** 启动心跳检测（幂等） */
    startHeartbeat: () => void
    /** 停止心跳检测 */
    stopHeartbeat: () => void
    /** 根据 WS 状态变化更新 DEMO 模式 */
    syncWithWSStatus: (status: WSStatus) => void
}

/* ============================================================
 * 二、常量
 * ============================================================ */

/** 心跳间隔（ms）—— 正常模式 */
const HEARTBEAT_INTERVAL_MS = 30_000
/** 心跳间隔（ms）—— DEMO 模式（延长，减少无效请求） */
const HEARTBEAT_INTERVAL_DEMO_MS = 60_000
/** 首次心跳延迟（ms）—— 避免与首屏渲染争抢资源 */
const HEARTBEAT_INITIAL_DELAY_MS = 3_000
/** 心跳请求超时（ms）—— 快速失败 */
const HEARTBEAT_TIMEOUT_MS = 3_000
/** 连续失败阈值 —— 达到后进入 DEMO 模式 */
const FAILURE_THRESHOLD = 2
/** API 错误累计阈值 —— 达到后进入 DEMO 模式 */
const API_ERROR_THRESHOLD = 5
/** API 错误计数衰减时间（ms）—— 5 分钟内的错误才累计 */
const API_ERROR_DECAY_MS = 5 * 60_000

/** localStorage 持久化 DEMO 模式状态（避免页面重载后重新等待 33s 激活） */
const DEMO_MODE_STORAGE_KEY = 'pr-demo-mode'
/** DEMO 模式持久化过期时间（ms）—— 5 分钟，超过后需重新检测 */
const DEMO_MODE_EXPIRY_MS = 5 * 60_000

/* ============================================================
 * 三、内部状态（非响应式）
 * ============================================================ */

let heartbeatTimer: number | null = null
/** 当前正在执行的心跳请求；停止或隐藏页面时立即中断。 */
let heartbeatController: AbortController | null = null
/**
 * 心跳生命周期代次。
 *
 * React StrictMode 会执行 start → stop → start。仅检查 started 无法阻止第一轮
 * 已在飞请求的 finally 为第二轮重新挂定时器，因此所有异步续体都必须同时验证代次。
 */
let heartbeatGeneration = 0
let heartbeatVisibilityListenerBound = false
let apiErrorCount = 0
let apiErrorFirstTime = 0

/* ============================================================
 * 三-A、localStorage 持久化（避免页面重载后 DEMO 模式重置）
 * ------------------------------------------------------------
 * 设计目的：
 * - 评委预览时若刷新页面或直接访问 URL，页面重载会重置 Zustand store
 * - 无持久化时，每次重载需重新等待 ~33 秒（2 次心跳失败）才激活 DEMO 模式
 * - 持久化后，5 分钟内曾进入 DEMO 模式的页面重载后立即激活
 * - 后端恢复后，心跳成功会清除持久化并退出 DEMO 模式
 * ============================================================ */

interface PersistedDemoMode {
    /** 激活时间戳（ms） */
    timestamp: number
    /** 激活原因（用于横幅 tooltip） */
    reason: string
}

/** 将 DEMO 模式状态持久化到 localStorage（页面重载后可恢复） */
function persistDemoMode(reason: string): void {
    try {
        const data: PersistedDemoMode = {
            timestamp: Date.now(),
            reason,
        }
        localStorage.setItem(DEMO_MODE_STORAGE_KEY, JSON.stringify(data))
    } catch {
        // localStorage 不可用（隐私模式/存储已满等），静默降级
    }
}

/** 从 localStorage 读取持久化的 DEMO 模式状态（未过期则返回） */
function loadPersistedDemoMode(): PersistedDemoMode | null {
    try {
        const raw = localStorage.getItem(DEMO_MODE_STORAGE_KEY)
        if (!raw) return null
        const data = JSON.parse(raw) as PersistedDemoMode
        // 检查过期
        if (Date.now() - data.timestamp > DEMO_MODE_EXPIRY_MS) {
            localStorage.removeItem(DEMO_MODE_STORAGE_KEY)
            return null
        }
        return data
    } catch {
        return null
    }
}

/** 清除持久化的 DEMO 模式状态 */
function clearPersistedDemoMode(): void {
    try {
        localStorage.removeItem(DEMO_MODE_STORAGE_KEY)
    } catch {
        // 静默降级
    }
}

/* ============================================================
 * 四、心跳检测逻辑
 * ============================================================ */

function pageIsHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function heartbeatCanRun(generation: number): boolean {
    return generation === heartbeatGeneration
        && useDemoModeStore.getState().started
        && !pageIsHidden()
}

function clearHeartbeatTimer(): void {
    if (heartbeatTimer !== null) {
        window.clearTimeout(heartbeatTimer)
        heartbeatTimer = null
    }
}

/** 执行一次心跳检测。生命周期中断不计为后端失败。 */
async function performHeartbeat(generation: number): Promise<void> {
    if (!heartbeatCanRun(generation)) return

    const controller = new AbortController()
    heartbeatController = controller
    let timedOut = false
    const timeoutId = window.setTimeout(() => {
        timedOut = true
        controller.abort()
    }, HEARTBEAT_TIMEOUT_MS)

    try {
        const res = await fetch('/api/health', {
            method: 'GET',
            signal: controller.signal,
            // 心跳请求不携带 credentials，避免 cookie 交互
            credentials: 'omit',
            // 心跳请求不计入性能指标
            cache: 'no-store',
        })

        // stop/hidden/新一代 start 后，旧响应不得改写可用性状态。
        if (!heartbeatCanRun(generation) || heartbeatController !== controller) return

        if (res.ok) {
            useDemoModeStore.getState().recordHeartbeatSuccess()
        } else {
            useDemoModeStore.getState().recordHeartbeatFailure(`HTTP ${res.status}`)
        }
    } catch (err) {
        // stopHeartbeat / 页面隐藏导致的 abort 属于生命周期清理，不能误判后端故障。
        if (!heartbeatCanRun(generation) || heartbeatController !== controller) return
        const reason = err instanceof Error
            ? (err.name === 'AbortError' && timedOut ? '心跳超时' : err.message)
            : String(err)
        useDemoModeStore.getState().recordHeartbeatFailure(reason)
    } finally {
        window.clearTimeout(timeoutId)
        if (heartbeatController === controller) heartbeatController = null
    }
}

/** 调度下一次心跳（根据当前 DEMO 模式状态选择间隔） */
function scheduleHeartbeat(generation: number, delayMs?: number): void {
    // 必须先验代次；否则旧请求的 finally 会清掉新一代已安排的 timer。
    if (!heartbeatCanRun(generation)) return
    clearHeartbeatTimer()
    const { isDemoMode } = useDemoModeStore.getState()
    const interval = delayMs ?? (isDemoMode ? HEARTBEAT_INTERVAL_DEMO_MS : HEARTBEAT_INTERVAL_MS)
    heartbeatTimer = window.setTimeout(() => {
        heartbeatTimer = null
        void performHeartbeat(generation).finally(() => scheduleHeartbeat(generation))
    }, interval)
}

function handleHeartbeatVisibilityChange(): void {
    const state = useDemoModeStore.getState()
    if (!state.started) return

    if (pageIsHidden()) {
        clearHeartbeatTimer()
        // catch 会因 pageIsHidden() 为 true 而忽略这次生命周期中断。
        heartbeatController?.abort()
        return
    }

    // 恢复可见时立即重新校验后端；scheduleHeartbeat 会保证全局只有一个 timer。
    scheduleHeartbeat(heartbeatGeneration, 0)
}

function bindHeartbeatVisibilityListener(): void {
    if (
        heartbeatVisibilityListenerBound
        || typeof document === 'undefined'
        || typeof document.addEventListener !== 'function'
    ) return
    heartbeatVisibilityListenerBound = true
    document.addEventListener('visibilitychange', handleHeartbeatVisibilityChange)
}

function unbindHeartbeatVisibilityListener(): void {
    if (
        !heartbeatVisibilityListenerBound
        || typeof document === 'undefined'
        || typeof document.removeEventListener !== 'function'
    ) return
    heartbeatVisibilityListenerBound = false
    document.removeEventListener('visibilitychange', handleHeartbeatVisibilityChange)
}

/* ============================================================
 * 五、Zustand Store
 * ============================================================ */

export const useDemoModeStore = create<DemoModeState>((set, get) => {
    // 页面加载时从 localStorage 恢复 DEMO 模式状态
    // 避免页面重载后重新等待 33 秒激活（评委预览体验关键优化）
    const persisted = loadPersistedDemoMode()
    const initialIsDemoMode = !!persisted
    const initialBackendAvailable = !persisted
    const initialLastError = persisted?.reason ?? null

    if (persisted && import.meta.env.DEV) {
        const elapsedSec = Math.round((Date.now() - persisted.timestamp) / 1000)
        console.info(`[demo-mode] 从 localStorage 恢复 DEMO 模式（${elapsedSec}s 前激活：${persisted.reason}）`)
    }

    return {
        isDemoMode: initialIsDemoMode,
        backendAvailable: initialBackendAvailable,
        lastError: initialLastError,
        lastCheckTime: null,
        consecutiveFailures: 0,
        started: false,

        enterDemoMode: (reason) => {
            const state = get()
            if (state.isDemoMode) return
            if (import.meta.env.DEV) {
                console.warn('[demo-mode] 进入 DEMO 模式', reason ? `— ${reason}` : '')
            }
            // 持久化到 localStorage（页面重载后可恢复）
            persistDemoMode(reason ?? '后端服务不可达')
            set({
                isDemoMode: true,
                backendAvailable: false,
                lastError: reason ?? '后端服务不可达',
                consecutiveFailures: state.consecutiveFailures, // 保留计数
            })
        },

        exitDemoMode: () => {
            const state = get()
            if (!state.isDemoMode) {
                // 即使未进入 DEMO，也清除错误状态
                if (state.consecutiveFailures > 0 || state.lastError) {
                    set({
                        backendAvailable: true,
                        lastError: null,
                        consecutiveFailures: 0,
                    })
                }
                return
            }
            if (import.meta.env.DEV) {
                console.info('[demo-mode] 退出 DEMO 模式 — 后端恢复')
            }
            // 清除 localStorage 持久化（后端已恢复）
            clearPersistedDemoMode()
            set({
                isDemoMode: false,
                backendAvailable: true,
                lastError: null,
                consecutiveFailures: 0,
            })
            // 重置 API 错误计数
            apiErrorCount = 0
            apiErrorFirstTime = 0
        },

        recordHeartbeatSuccess: () => {
            set({
                lastCheckTime: Date.now(),
            })
            const state = get()
            if (state.isDemoMode || state.consecutiveFailures > 0) {
                get().exitDemoMode()
            }
        },

        recordHeartbeatFailure: (reason) => {
            const failures = get().consecutiveFailures + 1
            set({
                consecutiveFailures: failures,
                lastCheckTime: Date.now(),
                lastError: reason ?? '心跳失败',
            })
            if (failures >= FAILURE_THRESHOLD) {
                get().enterDemoMode(reason ?? `连续 ${failures} 次心跳失败`)
            }
        },

        recordApiError: (reason) => {
            const now = Date.now()
            // 错误计数衰减
            if (now - apiErrorFirstTime > API_ERROR_DECAY_MS) {
                apiErrorCount = 0
                apiErrorFirstTime = now
            }
            if (apiErrorCount === 0) {
                apiErrorFirstTime = now
            }
            apiErrorCount += 1

            // 已在 DEMO 模式则不重复触发
            if (get().isDemoMode) return

            if (apiErrorCount >= API_ERROR_THRESHOLD) {
                get().enterDemoMode(reason ?? `API 错误累计 ${apiErrorCount} 次`)
            }
        },

        startHeartbeat: () => {
            if (get().started) return
            const generation = ++heartbeatGeneration
            set({ started: true })
            bindHeartbeatVisibilityListener()
            // 首次延迟 3s，避免与首屏渲染争抢资源
            scheduleHeartbeat(generation, HEARTBEAT_INITIAL_DELAY_MS)
        },

        stopHeartbeat: () => {
            // 先令旧异步续体失效，再清 timer / abort，避免 finally 重新武装。
            heartbeatGeneration += 1
            set({ started: false })
            clearHeartbeatTimer()
            const controller = heartbeatController
            heartbeatController = null
            controller?.abort()
            unbindHeartbeatVisibilityListener()
        },

        syncWithWSStatus: (status) => {
            // WS 错误或断连作为 DEMO 模式信号之一
            // 但仅在已确认 DEMO 模式时强化，不单独触发（避免 WS 抖动误判）
            if (status === 'error' && get().consecutiveFailures >= FAILURE_THRESHOLD) {
                get().enterDemoMode('WebSocket 连接失败，后端可能不可达')
            }
        },
    }
})

/* ============================================================
 * 六、便捷 API
 * ============================================================ */

/** 当前是否处于 DEMO 模式（非响应式，适用于一次性判断） */
export function isDemoMode(): boolean {
    return useDemoModeStore.getState().isDemoMode
}

/**
 * 包装 API 调用：失败时记录错误并降级到 fallback
 *
 * 用法：
 *   const data = await withDemoFallback(
 *     () => api.classroom.listClasses(),
 *     () => ({ classes: DEMO_CLASSES }),
 *   )
 *
 * - 后端可用时：正常调用 API
 * - API 失败时：记录错误 + 返回 fallback 数据
 * - 已在 DEMO 模式时：跳过 API 调用，直接返回 fallback（减少无效请求）
 */
export async function withDemoFallback<T>(
    apiCall: () => Promise<T>,
    /**
     * 兜底数据来源
     *
     * 允许返回 Promise：DEMO 数据模块已改为惰性 dynamic import（见 demo-registry），
     * 兜底函数因此常写成 `() => loadDemo().then((d) => d.getDemoX())`。
     * 本函数是 async 的，`return fallback()` 会自动展开 Promise，行为不变。
     */
    fallback: () => T | Promise<T>,
): Promise<T> {
    // 已在 DEMO 模式 → 直接返回 fallback，避免无效请求
    if (useDemoModeStore.getState().isDemoMode) {
        return fallback()
    }
    try {
        return await apiCall()
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        useDemoModeStore.getState().recordApiError(reason)
        return fallback()
    }
}
