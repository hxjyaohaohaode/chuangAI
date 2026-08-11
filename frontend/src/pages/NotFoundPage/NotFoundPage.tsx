/**
 * 404 兜底页面（B3.1：404 兜底路由 + 智能推荐 + 遥测）
 *
 * 设计依据（规范第 2、3、4、6、8、9 章）：
 * - 浅色基底：surface-primary 背景，深石墨色文字，无纯硬色
 * - 非对称构图：左侧巨型 404 数字 + 右侧描述与操作，非左右对称容器
 * - Bento Grid：推荐区采用非等大网格，主推荐 2 倍宽度
 * - Spring 动效：入场 translateY + opacity，ease-out 200ms
 * - 渐进式浏览：首屏钩子（404+操作）→ 展开层（推荐）→ 深化层（遥测）
 * - 玻璃质感：推荐卡片 backdrop-blur + 半透明
 * - 零 emoji：全部使用 Phosphor SVG 图标
 * - 可访问性：语义化 landmark、键盘可达、焦点可见、aria 标签完整
 *
 * 智能推荐算法：
 * - Levenshtein 距离匹配（config/nav.ts recommendRoutes）
 * - 相似度 > 30% 的路由按距离升序展示
 * - 不足 3 条时用默认热门路由补齐
 *
 * 遥测：
 * - localStorage 记录 404 事件（path/timestamp/referrer），FIFO 50 条
 * - 开发模式 console.warn 提示
 * - 不发送后端（避免虚假数据，符合真实性红线）
 */

import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button, Card, Icon } from '@/components/ui'
import { GlowBorder } from '@/components/ui/GlowBorder'
import { StarfieldBackground } from '@/components/ui/StarfieldBackground'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { recommendRoutes } from '@/config/nav'
import '@/components/ui/icons-extended'
import './NotFoundPage.css'

/** 遥测事件结构 */
interface NotFoundEvent {
    path: string
    timestamp: number
    referrer: string
}

/** 遥测存储 key */
const TELEMETRY_KEY = 'pr-404-telemetry'
const TELEMETRY_MAX = 50

/**
 * 记录 404 遥测事件到 localStorage
 * FIFO 队列，最多保留 TELEMETRY_MAX 条
 */
function recordTelemetry(path: string): NotFoundEvent[] {
    if (typeof window === 'undefined') return []
    const event: NotFoundEvent = {
        path,
        timestamp: Date.now(),
        referrer: document.referrer || 'direct',
    }

    try {
        const raw = window.localStorage.getItem(TELEMETRY_KEY)
        const list: NotFoundEvent[] = raw ? JSON.parse(raw) : []
        list.unshift(event)
        const trimmed = list.slice(0, TELEMETRY_MAX)
        window.localStorage.setItem(TELEMETRY_KEY, JSON.stringify(trimmed))
        return trimmed
    } catch {
        // localStorage 不可用（隐私模式/配额满）时静默降级
        return [event]
    }
}

/** 读取遥测历史（用于展示最近 404 计数） */
function readTelemetry(): NotFoundEvent[] {
    if (typeof window === 'undefined') return []
    try {
        const raw = window.localStorage.getItem(TELEMETRY_KEY)
        return raw ? JSON.parse(raw) : []
    } catch {
        return []
    }
}

export function NotFoundPage() {
    const location = useLocation()
    const navigate = useNavigate()
    const wrongPath = location.pathname
    const [telemetryCount, setTelemetryCount] = useState(0)

    // WCAG 2.4.2：404 页面标题（路由标题映射未覆盖通配路径，在此单独设置）
    useDocumentTitle('页面未找到')

    // 智能推荐：基于错误路径计算最接近的有效路由
    const recommendations = useMemo(() => recommendRoutes(wrongPath, 3), [wrongPath])

    // 遥测：记录 404 事件（仅挂载时执行一次）
    useEffect(() => {
        const list = recordTelemetry(wrongPath)
        setTelemetryCount(list.length)
        if (import.meta.env.DEV) {
            console.warn(
                `[404] 页面未找到: "${wrongPath}"，已记录到本地遥测（第 ${list.length} 次）`,
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

    // 判断是否为拼写错误（有高相似度匹配）
    const hasTypoSuggestion = recommendations.some((r) => r.similarity >= 60)
    const topMatch = recommendations[0]

    return (
        <div className="pr-notfound" role="main" aria-labelledby="pr-notfound-title">
            {/* —— 轻量 CSS 星空装饰层；错误页不依赖 Canvas/WebGL —— */}
            <div className="pr-notfound-starfield-layer" aria-hidden="true">
                <StarfieldBackground particleCount={60} speed={0.1} className="pr-starfield--embedded" />
            </div>

            {/* —— 首屏钩子层：非对称构图，左巨型数字 + 右描述操作 —— */}
            <section className="pr-notfound-hero" aria-labelledby="pr-notfound-title">
                <div className="pr-notfound-numeral" aria-hidden="true">
                    <span className="pr-notfound-numeral-main">404</span>
                    <span className="pr-notfound-numeral-glow" />
                </div>

                <GlowBorder active radius={16} color="accent-primary" className="pr-notfound-summary-wrap">
                    <div className="pr-notfound-summary">
                        <div className="pr-notfound-eyebrow">
                            <Icon name="warning-circle" size={16} weight="bold" />
                            <span>页面未找到</span>
                        </div>
                        <h1 id="pr-notfound-title" className="pr-notfound-title">
                            这一页，似乎散落在诗页之外
                        </h1>
                        <p className="pr-notfound-desc">
                            您访问的路径{' '}
                            <code className="pr-notfound-path">{wrongPath}</code>{' '}
                            不存在或已被迁移。{hasTypoSuggestion && topMatch && topMatch.similarity >= 60
                                ? `您是否想前往「${topMatch.item.label}」？`
                                : '请从下方推荐中挑选一个目的地，或返回上一页。'}
                        </p>

                        <div className="pr-notfound-actions">
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
                        </div>
                    </div>
                </GlowBorder>
            </section>

            {/* —— 展开层：智能推荐 Bento Grid —— */}
            <section className="pr-notfound-recommend" aria-labelledby="pr-notfound-recommend-title">
                <div className="pr-notfound-recommend-header">
                    <Icon name="lightbulb" size={18} weight="duotone" />
                    <h2 id="pr-notfound-recommend-title" className="pr-notfound-recommend-title">
                        您可能想去
                    </h2>
                </div>

                <div className="pr-notfound-bento">
                    {recommendations.map((rec, idx) => (
                        <Card
                            key={rec.item.key}
                            interactive
                            padding="md"
                            className={
                                idx === 0
                                    ? 'pr-notfound-bento-card pr-notfound-bento-card--primary'
                                    : 'pr-notfound-bento-card'
                            }
                            onClick={() => navigate(rec.item.to)}
                            role="link"
                            aria-label={`前往 ${rec.item.label}（路径 ${rec.item.to}）`}
                        >
                            <div className="pr-notfound-bento-icon">
                                <Icon
                                    name={rec.item.icon}
                                    size={idx === 0 ? 28 : 22}
                                    weight="duotone"
                                />
                            </div>
                            <div className="pr-notfound-bento-body">
                                <span className="pr-notfound-bento-label">
                                    {rec.item.label}
                                </span>
                                <span className="pr-notfound-bento-path">{rec.item.to}</span>
                            </div>
                            {rec.similarity > 0 && (
                                <span
                                    className="pr-notfound-bento-similarity"
                                    aria-label={`匹配度 ${rec.similarity}%`}
                                >
                                    {rec.similarity}%
                                </span>
                            )}
                        </Card>
                    ))}
                </div>
            </section>

            {/* —— 深化层：遥测信息 + 帮助（开发模式可见） —— */}
            {import.meta.env.DEV && (
                <section className="pr-notfound-telemetry" aria-label="404 遥测信息">
                    <Icon name="info" size={14} />
                    <span>
                        本地遥测已记录 {telemetryCount} 次 404 事件（存储于 localStorage，不发送至服务器）
                    </span>
                </section>
            )}
        </div>
    )
}

export default NotFoundPage
