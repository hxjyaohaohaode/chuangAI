/**
 * 403 权限拦截页面（B3.5：认证流程 + 403 页面）
 *
 * 设计依据（规范第 2、3、4、6、8、9 章）：
 * - 浅色基底：surface-primary 背景，深石墨色文字，无纯硬色
 * - 非对称构图：左侧巨型 403 数字 + 右侧描述与操作，非左右对称容器
 * - Bento Grid：权限说明区采用非等大网格（主说明 2 倍宽度）
 * - Spring 动效：入场 translateY + opacity，ease-out 200ms，错峰 80ms
 * - 渐进式浏览：首屏钩子（403+操作）→ 展开层（当前身份）→ 深化层（联系方式+遥测）
 * - 玻璃质感：身份卡片 backdrop-blur + 半透明
 * - 零 emoji：全部使用 Phosphor SVG 图标
 * - 可访问性：语义化 landmark、键盘可达、焦点可见、aria 标签完整
 *
 * 触发场景：
 * 1. API 返回 401/403 时由 api.ts 拦截器自动跳转
 * 2. 用户手动访问 /forbidden
 * 3. 路由守卫拦截（演示模式：仅展示，不做真实鉴权）
 *
 * 与 NotFoundPage 的区别：
 * - 404：路径不存在 → 智能推荐接近的路由
 * - 403：路径存在但无权限 → 不推荐路径，展示服务端身份并提供重新登录入口
 *
 * 遥测：
 * - localStorage 记录 403 事件（path/timestamp/teacherId），FIFO 50 条
 * - 开发模式 console.warn 提示
 * - 不发送后端（避免虚假数据，符合真实性红线）
 */

import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button, Card, Icon } from '@/components/ui'
import { GlowBorder } from '@/components/ui/GlowBorder'
import { StarfieldBackground } from '@/components/ui/StarfieldBackground'
import { useAuthStore } from '@/stores/auth'
import { logoutSession } from '@/lib/auth-session'
import '@/components/ui/icons-extended'
import './ForbiddenPage.css'

/** 遥测事件结构 */
interface ForbiddenEvent {
    path: string
    timestamp: number
    teacherId: string
}

/** 遥测存储 key */
const TELEMETRY_KEY = 'pr-403-telemetry'
const TELEMETRY_MAX = 50

/**
 * 记录 403 遥测事件到 localStorage
 * FIFO 队列，最多保留 TELEMETRY_MAX 条
 */
function recordTelemetry(path: string, teacherId: string): ForbiddenEvent[] {
    if (typeof window === 'undefined') return []
    const event: ForbiddenEvent = {
        path,
        timestamp: Date.now(),
        teacherId,
    }

    try {
        const raw = window.localStorage.getItem(TELEMETRY_KEY)
        const list: ForbiddenEvent[] = raw ? JSON.parse(raw) : []
        list.unshift(event)
        const trimmed = list.slice(0, TELEMETRY_MAX)
        window.localStorage.setItem(TELEMETRY_KEY, JSON.stringify(trimmed))
        return trimmed
    } catch {
        // localStorage 不可用（隐私模式/配额满）时静默降级
        return [event]
    }
}

/** 读取遥测历史（用于展示最近 403 计数） */
function readTelemetry(): ForbiddenEvent[] {
    if (typeof window === 'undefined') return []
    try {
        const raw = window.localStorage.getItem(TELEMETRY_KEY)
        return raw ? JSON.parse(raw) : []
    } catch {
        return []
    }
}

/** 从 query string 中提取"被拦截的目标路径"（由 api.ts 拦截器注入） */
function getAttemptedPath(): string {
    if (typeof window === 'undefined') return ''
    const params = new URLSearchParams(window.location.search)
    return params.get('from') ?? ''
}

export function ForbiddenPage() {
    const location = useLocation()
    const navigate = useNavigate()
    const teacherId = useAuthStore((s) => s.teacherId)
    const teacherName = useAuthStore((s) => s.teacherName)
    const logout = useAuthStore((s) => s.logout)
    const [telemetryCount, setTelemetryCount] = useState(0)

    const attemptedPath = useMemo(() => getAttemptedPath(), [])
    const wrongPath = attemptedPath || location.pathname

    // 遥测：记录 403 事件（仅挂载时执行一次）
    useEffect(() => {
        const list = recordTelemetry(wrongPath, teacherId)
        setTelemetryCount(list.length)
        if (import.meta.env.DEV) {
            console.warn(
                `[403] 权限不足: "${wrongPath}"，当前教师 "${teacherId}"，已记录到本地遥测（第 ${list.length} 次）`,
            )
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // 读取已有遥测计数（组件挂载前的历史 + 本次）
    useEffect(() => {
        const list = readTelemetry()
        setTelemetryCount(list.length)
    }, [])

    const handleGoHome = () => navigate('/dashboard')
    const handleGoBack = () => navigate(-1)

    const handleRelogin = () => {
        void logoutSession()
            .catch(() => {
                // 即使网络已断开也必须清除本地缓存，不能保留一个无法验证的身份。
            })
            .finally(() => {
                logout()
                navigate('/login', { replace: true })
            })
    }

    return (
        <div className="pr-forbidden" role="main" aria-labelledby="pr-forbidden-title">
            {/* —— 轻量 CSS 星空装饰层；兜底页不依赖 Canvas/WebGL —— */}
            <div className="pr-forbidden-starfield-layer" aria-hidden="true">
                <StarfieldBackground particleCount={60} speed={0.1} className="pr-starfield--embedded" />
            </div>

            {/* —— 首屏钩子层：非对称构图，左巨型数字 + 右描述操作 —— */}
            <section className="pr-forbidden-hero" aria-labelledby="pr-forbidden-title">
                <div className="pr-forbidden-numeral" aria-hidden="true">
                    <span className="pr-forbidden-numeral-main">403</span>
                    <span className="pr-forbidden-numeral-glow" />
                </div>

                <GlowBorder active radius={16} color="accent-error" className="pr-forbidden-summary-wrap">
                    <div className="pr-forbidden-summary">
                        <div className="pr-forbidden-eyebrow">
                            <Icon name="lock-simple" size={16} weight="fill" />
                            <span>权限不足</span>
                        </div>
                        <h1 id="pr-forbidden-title" className="pr-forbidden-title">
                            这扇门，暂时未向您敞开
                        </h1>
                        <p className="pr-forbidden-desc">
                            您当前身份{' '}
                            <code className="pr-forbidden-identity">{teacherName}</code>{' '}
                            （{teacherId}）没有访问{' '}
                            {attemptedPath ? (
                                <code className="pr-forbidden-path">{attemptedPath}</code>
                            ) : (
                                '该资源'
                            )}{' '}
                            的权限。若您认为这是误判，请重新登录正确账号，或联系管理员开通权限。
                        </p>

                        <div className="pr-forbidden-actions">
                            <Button
                                variant="primary"
                                size="md"
                                leftIcon={<Icon name="graduation" size={16} />}
                                onClick={handleGoHome}
                            >
                                返回教学驾驶舱
                            </Button>
                            <Button
                                variant="ghost"
                                size="md"
                                leftIcon={<Icon name="caret-left" size={16} />}
                                onClick={handleGoBack}
                            >
                                返回上一页
                            </Button>
                            <Button
                                variant="ghost"
                                size="md"
                                leftIcon={<Icon name="user-switch" size={16} />}
                                onClick={handleRelogin}
                            >
                                重新登录
                            </Button>
                        </div>
                    </div>
                </GlowBorder>
            </section>

            {/* —— 展开层：当前身份信息 Bento Grid —— */}
            <section className="pr-forbidden-context" aria-labelledby="pr-forbidden-context-title">
                <div className="pr-forbidden-context-header">
                    <Icon name="info" size={18} weight="bold" />
                    <h2 id="pr-forbidden-context-title" className="pr-forbidden-context-title">
                        当前会话上下文
                    </h2>
                </div>

                <div className="pr-forbidden-bento">
                    <Card
                        padding="md"
                        className="pr-forbidden-bento-card pr-forbidden-bento-card--primary"
                    >
                        <div className="pr-forbidden-bento-icon">
                            <Icon name="user-circle" size={26} weight="duotone" />
                        </div>
                        <div className="pr-forbidden-bento-body">
                            <span className="pr-forbidden-bento-label">当前教师身份</span>
                            <span className="pr-forbidden-bento-detail">
                                {teacherName} <span className="pr-forbidden-bento-sub">({teacherId})</span>
                            </span>
                        </div>
                    </Card>

                    <Card padding="md" className="pr-forbidden-bento-card">
                        <div className="pr-forbidden-bento-icon">
                            <Icon name="navigation-arrow" size={22} weight="duotone" />
                        </div>
                        <div className="pr-forbidden-bento-body">
                            <span className="pr-forbidden-bento-label">被拦截路径</span>
                            <span className="pr-forbidden-bento-path">{wrongPath}</span>
                        </div>
                    </Card>

                    <Card padding="md" className="pr-forbidden-bento-card">
                        <div className="pr-forbidden-bento-icon">
                            <Icon name="clock" size={22} weight="duotone" />
                        </div>
                        <div className="pr-forbidden-bento-body">
                            <span className="pr-forbidden-bento-label">事件时间</span>
                            <span className="pr-forbidden-bento-detail">
                                {new Date().toLocaleString('zh-CN', {
                                    hour12: false,
                                })}
                            </span>
                        </div>
                    </Card>
                </div>
            </section>

            {/* —— 深化层：联系管理员 + 遥测（开发模式可见） —— */}
            <section className="pr-forbidden-help" aria-label="帮助与联系">
                <Card padding="md" className="pr-forbidden-help-card">
                    <div className="pr-forbidden-help-icon">
                        <Icon name="question" size={20} weight="duotone" />
                    </div>
                    <div className="pr-forbidden-help-body">
                        <span className="pr-forbidden-help-title">需要进一步帮助？</span>
                        <span className="pr-forbidden-help-desc">
                            演示模式下无需真实鉴权。如在生产环境中遇到此页面，请联系系统管理员开通对应资源权限，或确认当前账号是否正确。
                        </span>
                    </div>
                </Card>
            </section>

            {import.meta.env.DEV && (
                <section className="pr-forbidden-telemetry" aria-label="403 遥测信息">
                    <Icon name="info" size={14} />
                    <span>
                        本地遥测已记录 {telemetryCount} 次 403 事件（存储于 localStorage，不发送至服务器）
                    </span>
                </section>
            )}
        </div>
    )
}

export default ForbiddenPage
