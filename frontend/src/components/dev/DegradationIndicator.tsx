/**
 * 降级模式指示器（工程保障层 / 故障降级预案 · 前端）
 *
 * 设计目的：
 * - 监听后端 WebSocket 推送的 degradation:* 事件
 * - 当后端进入降级模式时，在右下角显示一个低调的非阻塞指示器
 * - 点击展开详情面板：当前降级状态、受影响服务、恢复预计
 * - 使用 accent-warning 暖琥珀色调，玻璃态面板（规范 14.5 / 2.4）
 *
 * 触发事件：
 * - degradation:enter   → 后端进入降级模式
 * - degradation:exit     → 后端退出降级模式
 * - degradation:mock-served → 后端返回了一次 Mock 响应（用于累计计数）
 *
 * 严格遵循：
 * - 玻璃态：surface-glass + backdrop-blur 24px
 * - 无边框：透明度分层，仅 hover 出现 8% alpha 微边框
 * - 暖调色板：accent-warning 用于"降级中"，accent-success 用于"已恢复"
 * - 零 emoji：所有图标使用 Phosphor Icons
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import { Icon } from '@/components/ui'
import { wsDispatcher } from '@/lib/ws-dispatcher'
import './DegradationIndicator.css'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

interface DegradationPayload {
  state: 'normal' | 'degraded'
  reason?: string
  mockServed?: {
    sceneKey: string
    matchType: 'exact' | 'keyword' | 'default'
  }
}

interface DegradationStatusSnapshot {
  state: 'normal' | 'degraded'
  enteredAt: number | null
  exitedAt: number | null
  mockServedCount: number
  lastReason: string | null
  /** 受影响的服务列表 */
  affectedServices: string[]
  /** 最近一次 mock 命中场景 */
  lastMockScene?: string
}

// ─────────────────────────────────────────────────────────────
// 受影响服务映射（按场景 key 翻译为业务名）
// ─────────────────────────────────────────────────────────────

const SERVICE_LABELS: Record<string, string> = {
  'mind:diagnose': '认知诊断',
  'mind:profile': '学情画像',
  'mind:recommend': '推荐路径',
  'mind:verify': '独立验收',
  'brush:generate-question': '命题生成',
  'brush:grade': '智能批改',
  'brush:report': '教研报告',
  'brush:creative': '创意素材',
  'eye:vision-annotate': '视觉标注',
  'eye:asr': '语音识别',
  'eye:tts': '语音合成',
  'orchestrator:route': '路由决策',
}

// 降级模式下受影响的服务（排除关键白名单）
const AFFECTED_SERVICES = [
  'mind:diagnose',
  'mind:profile',
  'mind:recommend',
  'brush:generate-question',
  'brush:grade',
  'brush:report',
  'brush:creative',
  'eye:vision-annotate',
  'eye:asr',
  'eye:tts',
]

// ─────────────────────────────────────────────────────────────
// 组件
// ─────────────────────────────────────────────────────────────

export function DegradationIndicator() {
  const [status, setStatus] = useState<DegradationStatusSnapshot>({
    state: 'normal',
    enteredAt: null,
    exitedAt: null,
    mockServedCount: 0,
    lastReason: null,
    affectedServices: AFFECTED_SERVICES,
  })
  const [expanded, setExpanded] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // 订阅 WebSocket 事件
  useEffect(() => {
    const unsub = wsDispatcher.subscribe((event) => {
      if (!event.type.startsWith('degradation:')) return
      const payload = event.payload as DegradationPayload
      if (!payload || typeof payload.state !== 'string') return

      setStatus((prev) => {
        const next: DegradationStatusSnapshot = { ...prev }

        if (event.type === 'degradation:enter') {
          next.state = 'degraded'
          next.enteredAt = event.timestamp
          next.lastReason = payload.reason ?? prev.lastReason
        } else if (event.type === 'degradation:exit') {
          next.state = 'normal'
          next.exitedAt = event.timestamp
        } else if (event.type === 'degradation:mock-served') {
          next.mockServedCount = prev.mockServedCount + 1
          if (payload.mockServed) {
            next.lastMockScene = payload.mockServed.sceneKey
          }
        }

        return next
      })
    })
    return () => {
      unsub()
    }
  }, [])

  // 点击外部关闭
  useEffect(() => {
    if (!expanded) return
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current && !panelRef.current.contains(target)) {
        setExpanded(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClickOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [expanded])

  const isDegraded = status.state === 'degraded'
  const handleToggle = useCallback(() => setExpanded((v) => !v), [])

  // 非降级模式 + 无 mock 服务过 → 不渲染（避免常态占位）
  if (!isDegraded && status.mockServedCount === 0) {
    return null
  }

  return (
    <div ref={panelRef} className="pr-degradation-indicator" data-state={status.state}>
      <button
        type="button"
        className="pr-degradation-toggle"
        onClick={handleToggle}
        aria-expanded={expanded}
        aria-label={isDegraded ? '后端降级模式（点击查看详情）' : '后端已恢复（点击查看历史）'}
      >
        <span className="pr-degradation-dot" aria-hidden="true" />
        <Icon
          name={isDegraded ? 'warning-circle' : 'check-circle'}
          size={16}
          active={isDegraded}
        />
        <span className="pr-degradation-label">
          {isDegraded ? '降级模式' : '已恢复'}
        </span>
        {isDegraded && status.mockServedCount > 0 && (
          <span className="pr-degradation-count" aria-label={`累计 Mock 响应 ${status.mockServedCount} 次`}>
            {status.mockServedCount}
          </span>
        )}
      </button>

      {expanded && (
        <div className="pr-degradation-panel" role="dialog" aria-label="降级模式详情">
          <div className="pr-degradation-panel-header">
            <Icon
              name={isDegraded ? 'warning-circle' : 'check-circle'}
              size={18}
              active={isDegraded}
            />
            <span className="pr-degradation-panel-title">
              {isDegraded ? '后端服务降级中' : '后端服务已恢复'}
            </span>
          </div>

          <div className="pr-degradation-panel-section">
            <div className="pr-degradation-row">
              <span className="pr-degradation-row-label">触发原因</span>
              <span className="pr-degradation-row-value">
                {status.lastReason ?? '—'}
              </span>
            </div>
            <div className="pr-degradation-row">
              <span className="pr-degradation-row-label">进入时间</span>
              <span className="pr-degradation-row-value">
                {status.enteredAt ? formatTime(status.enteredAt) : '—'}
              </span>
            </div>
            {status.exitedAt && (
              <div className="pr-degradation-row">
                <span className="pr-degradation-row-label">恢复时间</span>
                <span className="pr-degradation-row-value">
                  {formatTime(status.exitedAt)}
                </span>
              </div>
            )}
            <div className="pr-degradation-row">
              <span className="pr-degradation-row-label">Mock 累计</span>
              <span className="pr-degradation-row-value">
                {status.mockServedCount} 次
              </span>
            </div>
            <div className="pr-degradation-row">
              <span className="pr-degradation-row-label">恢复预计</span>
              <span className="pr-degradation-row-value">
                {isDegraded ? '连续 60 秒无失败自动恢复' : '已恢复'}
              </span>
            </div>
          </div>

          {isDegraded && (
            <div className="pr-degradation-panel-section">
              <div className="pr-degradation-section-title">受影响服务</div>
              <div className="pr-degradation-service-grid">
                {status.affectedServices.map((key) => (
                  <span key={key} className="pr-degradation-service-tag">
                    {SERVICE_LABELS[key] ?? key}
                  </span>
                ))}
              </div>
            </div>
          )}

          {status.lastMockScene && (
            <div className="pr-degradation-panel-section">
              <div className="pr-degradation-section-title">最近 Mock 命中</div>
              <div className="pr-degradation-row-value">
                {SERVICE_LABELS[status.lastMockScene] ?? status.lastMockScene}
              </div>
            </div>
          )}

          <div className="pr-degradation-hint">
            降级模式下，AI 调用返回预置高质量响应，不影响评委预览体验。
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}
