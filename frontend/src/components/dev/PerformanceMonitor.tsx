/**
 * 性能监控胶囊（工程保障层 / 性能监控 v2）
 *
 * 设计目的：
 * - 吸边胶囊形态：默认 48×48px 胶囊贴右边缘垂直居中，显示实时 FPS
 * - 点击胶囊展开为 320×480px 浮动面板（surface-elevated 玻璃态 + backdrop-blur 20px）
 * - 实时监控 FPS / 内存 / 长任务 / DOM 节点 / 网络请求 / 当前路由
 * - 250ms spring-soft 展开/折叠动画 cubic-bezier(0.25, 0.1, 0.07, 1.45)
 * - localStorage 持久化展开状态
 * - Cmd/Ctrl+Shift+P 全局快捷键唤起（× 关闭后可通过此唤起）
 *
 * 严格遵循：
 * - 玻璃态浮窗：surface-elevated + backdrop-blur 20px（规范 2.2）
 * - 无硬编码色值：所有色值通过 CSS 变量派生
 * - 仅 transform/opacity 动画（规范 15.1）
 * - prefers-reduced-motion 降级
 * - 零 emoji，使用 Phosphor Icons
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { Icon } from '@/components/ui'
import { useAgentRuntimeStore } from '@/stores/agent-runtime'
import { wsDispatcher } from '@/lib/ws-dispatcher'
import { rgba, readCSSColor } from '@/lib/chartPalette'
import './PerformanceMonitor.css'

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const STORAGE_KEY = 'poetic-realm.perf-monitor-expanded'
/** FPS 历史采样上限：60 秒 @ 500ms 采样 = 120 个点 */
const FPS_HISTORY_MAX = 120

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

interface Metrics {
  fps: number
  /** 已使用 JS 堆大小（MB），无 performance.memory 时为 null */
  usedHeapMB: number | null
  /** JS 堆大小限制（MB） */
  heapLimitMB: number | null
  /** 累计 fetch 请求数 */
  requestCount: number
  /** 平均请求延迟（ms） */
  avgRequestLatencyMs: number
  /** 累计 LLM tokens（输入+输出） */
  totalTokens: number
  /** 累计 WebSocket 消息数 */
  wsMessageCount: number
  /** WebSocket 当前连接状态 */
  wsStatus: string
  /** 累计长任务数（>50ms 的任务） */
  longTaskCount: number
  /** 当前 DOM 节点总数 */
  domNodeCount: number
  /** 当前路由路径 */
  currentRoute: string
}

// ─────────────────────────────────────────────────────────────
// fetch 拦截器（单次安装，模块级单例）
// ─────────────────────────────────────────────────────────────

interface FetchStats {
  count: number
  totalLatency: number
}

const fetchStats: FetchStats = { count: 0, totalLatency: 0 }
let fetchInstalled = false

function installFetchInterceptor(): void {
  if (fetchInstalled) return
  if (typeof window === 'undefined' || !window.fetch) return
  fetchInstalled = true

  const originalFetch = window.fetch
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const start = performance.now()
    try {
      const res = await originalFetch(input as RequestInfo, init)
      const latency = performance.now() - start
      fetchStats.count++
      fetchStats.totalLatency += latency
      return res
    } catch (err) {
      const latency = performance.now() - start
      fetchStats.count++
      fetchStats.totalLatency += latency
      throw err
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 迷你图表组件（Canvas 实时折线）
// ─────────────────────────────────────────────────────────────

interface MiniChartProps {
  /** 历史采样数据（最近 N 个） */
  data: number[]
  /** 警戒色（基于阈值判定） */
  status: 'normal' | 'warning' | 'critical'
  /** 图表标签 */
  label: string
  /** Y 轴最大值（用于归一化，FPS 默认 60） */
  yMax?: number
}

function MiniChart({ data, status, label, yMax = 60 }: MiniChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = Math.max(1, Math.floor(w * dpr))
    canvas.height = Math.max(1, Math.floor(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    if (data.length < 2) return

    // 固定 0-yMax 范围归一化，保证视觉刻度稳定
    const min = 0
    const max = yMax
    const range = Math.max(max - min, 1)

    // 选色：normal=success(绿), warning=warning(黄), critical=error(红)
    const colorVar =
      status === 'critical'
        ? '--c-accent-error'
        : status === 'warning'
          ? '--c-accent-warning'
          : '--c-accent-success'
    const channels = readCSSColor(colorVar)

    // 绘制折线
    const stepX = w / (data.length - 1)
    ctx.beginPath()
    data.forEach((v, i) => {
      const x = i * stepX
      const y = h - ((v - min) / range) * (h - 4) - 2
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = rgba(channels, 1)
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.stroke()

    // 渐变填充
    ctx.lineTo(w, h)
    ctx.lineTo(0, h)
    ctx.closePath()
    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, rgba(channels, 0.18))
    grad.addColorStop(1, rgba(channels, 0))
    ctx.fillStyle = grad
    ctx.fill()
  }, [data, status, yMax])

  return (
    <div className="pr-perf-chart" data-status={status}>
      <span className="pr-perf-chart-label">{label}</span>
      <canvas ref={canvasRef} className="pr-perf-chart-canvas" aria-hidden="true" />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────

/** 从 localStorage 读取初始展开状态，无记录时回落到 defaultExpanded */
function getInitialExpanded(defaultExpanded: boolean): boolean {
  if (typeof window === 'undefined') return defaultExpanded
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored !== null) return stored === 'true'
  } catch {
    // localStorage 不可用时静默回落
  }
  return defaultExpanded
}

// ─────────────────────────────────────────────────────────────
// PerformanceMonitor 组件
// ─────────────────────────────────────────────────────────────

export interface PerformanceMonitorProps {
  /** 默认展开状态（生产环境 false，开发环境 true） */
  defaultExpanded?: boolean
  /** 自定义类名 */
  className?: string
}

export function PerformanceMonitor({ defaultExpanded = false, className }: PerformanceMonitorProps) {
  const [isExpanded, setIsExpanded] = useState<boolean>(() => getInitialExpanded(defaultExpanded))
  const [isHidden, setIsHidden] = useState<boolean>(false)

  // FPS 历史采样（state 触发图表重绘，ref 用于内部累加）
  const [fpsHistory, setFpsHistory] = useState<number[]>([])
  const longTaskCountRef = useRef<number>(0)

  // agentCalls 通过 ref 读取，避免 FPS 循环因 store 变化频繁重启
  const agentCalls = useAgentRuntimeStore((s) => s.calls)
  const agentCallsRef = useRef(agentCalls)
  useEffect(() => {
    agentCallsRef.current = agentCalls
  }, [agentCalls])

  // agent-runtime 只有开发性能监视器消费；订阅与消费者同生命周期，避免生产入口
  // 为无人读取的调试数据常驻维护 Store，同时确保 DevTools 打开时事件链完整。
  useEffect(() => wsDispatcher.subscribe((event) => {
    if (event.type.startsWith('agent:')) {
      useAgentRuntimeStore.getState().handleWSEvent(event)
    }
  }), [])

  const [metrics, setMetrics] = useState<Metrics>({
    fps: 60,
    usedHeapMB: null,
    heapLimitMB: null,
    requestCount: 0,
    avgRequestLatencyMs: 0,
    totalTokens: 0,
    wsMessageCount: 0,
    wsStatus: 'idle',
    longTaskCount: 0,
    domNodeCount: 0,
    currentRoute: '/',
  })

  // ── 持久化展开状态到 localStorage ──
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(isExpanded))
    } catch {
      // 写入失败静默忽略
    }
  }, [isExpanded])

  // ── 全局快捷键：Cmd/Ctrl + Shift + P 唤起 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault()
        setIsHidden(false)
        setIsExpanded(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── FPS / 内存 / fetch / tokens / DOM / 路由 监控（500ms 采样） ──
  useEffect(() => {
    if (isHidden) return
    let rafId = 0
    let frames = 0
    let lastUpdate = performance.now()

    const tick = (now: number) => {
      frames++
      if (now - lastUpdate >= 500) {
        const fps = (frames * 1000) / (now - lastUpdate)

        // FPS 历史更新（新数组引用触发图表重绘）
        setFpsHistory((prev) => {
          const next = prev.length >= FPS_HISTORY_MAX ? prev.slice(1) : prev.slice()
          next.push(fps)
          return next
        })

        // 内存
        let usedHeapMB: number | null = null
        let heapLimitMB: number | null = null
        const mem = (
          performance as Performance & {
            memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number }
          }
        ).memory
        if (mem) {
          usedHeapMB = mem.usedJSHeapSize / 1024 / 1024
          heapLimitMB = mem.jsHeapSizeLimit / 1024 / 1024
        }

        // fetch 统计
        const avgLatency = fetchStats.count > 0 ? fetchStats.totalLatency / fetchStats.count : 0

        // 累计 tokens（通过 ref 读取最新值，避免重启循环）
        let totalTokens = 0
        for (const call of agentCallsRef.current) {
          if (call.usage) {
            totalTokens += call.usage.promptTokens + call.usage.completionTokens
          }
        }

        // DOM 节点数
        const domNodeCount =
          typeof document !== 'undefined' ? document.querySelectorAll('*').length : 0

        // 当前路由
        const currentRoute = typeof window !== 'undefined' ? window.location.pathname : '/'

        setMetrics((prev) => ({
          fps,
          usedHeapMB,
          heapLimitMB,
          requestCount: fetchStats.count,
          avgRequestLatencyMs: avgLatency,
          totalTokens,
          wsMessageCount: prev.wsMessageCount,
          wsStatus: wsDispatcher.getStatus(),
          longTaskCount: longTaskCountRef.current,
          domNodeCount,
          currentRoute,
        }))

        frames = 0
        lastUpdate = now
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [isHidden])

  // ── 安装 fetch 拦截 ──
  useEffect(() => {
    if (isHidden) return
    installFetchInterceptor()
  }, [isHidden])

  // ── 监听 WebSocket 消息频率 ──
  useEffect(() => {
    if (isHidden) return
    const unsub = wsDispatcher.subscribe((event) => {
      if (event.type === 'ws:ping' || event.type === 'ws:pong') return
      setMetrics((prev) => ({
        ...prev,
        wsMessageCount: prev.wsMessageCount + 1,
      }))
    })
    return () => {
      unsub()
    }
  }, [isHidden])

  // ── 长任务观察器（PerformanceObserver） ──
  useEffect(() => {
    if (isHidden) return
    if (typeof PerformanceObserver === 'undefined') return

    let observer: PerformanceObserver | null = null
    try {
      observer = new PerformanceObserver((list) => {
        longTaskCountRef.current += list.getEntries().length
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // 某些浏览器不支持 longtask entryType，静默降级
    }
    return () => {
      if (observer) observer.disconnect()
    }
  }, [isHidden])

  // ── 事件处理 ──
  const handleToggle = useCallback(() => {
    setIsExpanded((v) => !v)
  }, [])

  const handleClose = useCallback(() => {
    setIsExpanded(false)
    setIsHidden(true)
  }, [])

  if (isHidden) return null

  // FPS 颜色等级：>50 good / 30-50 medium / <30 bad
  const fpsLevel: 'good' | 'medium' | 'bad' =
    metrics.fps > 50 ? 'good' : metrics.fps >= 30 ? 'medium' : 'bad'
  const fpsStatus: 'normal' | 'warning' | 'critical' =
    fpsLevel === 'good' ? 'normal' : fpsLevel === 'medium' ? 'warning' : 'critical'

  const capsuleClass = [
    'pr-perf-capsule',
    `fps-${fpsLevel}`,
    isExpanded ? 'is-expanded' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  const panelClass = ['pr-perf-panel', isExpanded ? 'expanded' : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  return (
    <>
      {/* 吸边胶囊 —— 显示实时 FPS */}
      <button
        type="button"
        className={capsuleClass}
        onClick={handleToggle}
        aria-label={isExpanded ? '点击折叠性能监控' : '点击展开性能监控'}
        title="点击展开性能监控"
      >
        <span className="pr-perf-capsule-number">{metrics.fps.toFixed(0)}</span>
        <span className="pr-perf-capsule-label">FPS</span>
      </button>

      {/* 展开浮动面板 */}
      <div
        className={panelClass}
        role="dialog"
        aria-label="性能监控面板"
        aria-hidden={!isExpanded}
      >
        <div className="pr-perf-panel-header">
          <span className="pr-perf-panel-title">性能监控</span>
          <button
            type="button"
            className="pr-perf-close-btn"
            onClick={handleClose}
            aria-label="关闭性能监控（Cmd+Shift+P 重新唤起）"
            title="关闭（Cmd+Shift+P 重新唤起）"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        {/* FPS 实时图表（最近 60 秒） */}
        <MiniChart
          label="FPS（最近 60 秒）"
          data={fpsHistory}
          status={fpsStatus}
          yMax={60}
        />

        {/* 指标列表 */}
        <div className="pr-perf-metric">
          <span className="pr-perf-metric-label">FPS</span>
          <span className="pr-perf-metric-value" data-level={fpsLevel}>
            {metrics.fps.toFixed(0)}
          </span>
        </div>

        <div className="pr-perf-metric">
          <span className="pr-perf-metric-label">内存使用</span>
          <span className="pr-perf-metric-value">
            {metrics.usedHeapMB !== null
              ? `${metrics.usedHeapMB.toFixed(0)} / ${metrics.heapLimitMB?.toFixed(0) ?? '?'} MB`
              : 'N/A'}
          </span>
        </div>

        <div className="pr-perf-metric">
          <span className="pr-perf-metric-label">长任务计数</span>
          <span className="pr-perf-metric-value">{metrics.longTaskCount}</span>
        </div>

        <div className="pr-perf-metric">
          <span className="pr-perf-metric-label">DOM 节点数</span>
          <span className="pr-perf-metric-value">{metrics.domNodeCount}</span>
        </div>

        <div className="pr-perf-metric">
          <span className="pr-perf-metric-label">网络请求数</span>
          <span className="pr-perf-metric-value">{metrics.requestCount}</span>
        </div>

        <div className="pr-perf-metric">
          <span className="pr-perf-metric-label">平均延迟</span>
          <span className="pr-perf-metric-value">
            {metrics.avgRequestLatencyMs > 0
              ? `${metrics.avgRequestLatencyMs.toFixed(0)}ms`
              : '—'}
          </span>
        </div>

        <div className="pr-perf-metric">
          <span className="pr-perf-metric-label">LLM tokens</span>
          <span className="pr-perf-metric-value">
            {metrics.totalTokens > 1000
              ? `${(metrics.totalTokens / 1000).toFixed(1)}k`
              : metrics.totalTokens}
          </span>
        </div>

        <div className="pr-perf-metric">
          <span className="pr-perf-metric-label">WS 消息</span>
          <span className="pr-perf-metric-value">{metrics.wsMessageCount}</span>
        </div>

        <div className="pr-perf-metric">
          <span className="pr-perf-metric-label">WS 状态</span>
          <span className="pr-perf-metric-value" data-ws={metrics.wsStatus}>
            {metrics.wsStatus}
          </span>
        </div>

        <div className="pr-perf-metric pr-perf-metric-route">
          <span className="pr-perf-metric-label">当前路由</span>
          <span className="pr-perf-metric-value pr-perf-route-value" title={metrics.currentRoute}>
            {metrics.currentRoute}
          </span>
        </div>
      </div>
    </>
  )
}
