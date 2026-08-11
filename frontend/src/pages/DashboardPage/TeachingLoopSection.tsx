/**
 * 教学闭环六大环节区块
 *
 * ── 职责 ──
 * 1. 拉取六张卡的场景插画（后端 wan2.7-image 生成 + 落盘缓存）
 * 2. 把 MagicBento 的卡片接成真实可导航的入口
 *
 * ── 为什么每个场景各发一条请求，而不是一个批量接口 ──
 * 六个场景相互独立，分开请求可以**逐张就位**：先缓存命中的（约 0.4 秒）
 * 立刻显示，需要现生成的（约 6 秒）稍后补上，页面全程不阻塞。
 * 换成批量接口就得等最慢的那张，首次进页面会空 30 秒以上。
 *
 * 图片地址与 prompt 一一对应且服务端固定，因此 `staleTime: Infinity`——
 * 同一会话内不会重复请求，也不会因为窗口聚焦而重新生成。
 */

import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import type { MagicBentoCardData } from '@/components/ui/MagicBento'
import { MagicBento } from '@/components/ui/MagicBento'
import { api } from '@/lib/api'

export interface TeachingLoopCard extends MagicBentoCardData {
    /** 后端受控插画场景 id */
    sceneId: string
}

export interface TeachingLoopSectionProps {
    cards: TeachingLoopCard[]
}

export function TeachingLoopSection({ cards }: TeachingLoopSectionProps) {
    const navigate = useNavigate()

    const illustrations = useQueries({
        queries: cards.map((card) => ({
            queryKey: ['illustration', 'scene', card.sceneId],
            queryFn: () => api.illustration.scene(card.sceneId),
            staleTime: Infinity,
            gcTime: Infinity,
            // 生图失败时后端返回 url: null 而非 5xx，所以这里几乎不会进 error 分支；
            // 真的失败了也只重试一次——没有配图不值得反复烧生图额度。
            retry: 1,
        })),
    })

    /**
     * 把插画地址并回卡片数据
     *
     * 没取到地址（还在生成 / 生成失败 / 密钥未配置）时不传 imageUrl。
     * MagicBento 会保留同尺寸的 CSS 山水底图；真实图片就位后只做图层替换，
     * 因此接口慢、404 或离线都不会留下空白，也不会引发布局跳变。
     */
    const cardsWithMedia: MagicBentoCardData[] = cards.map((card, i) => {
        const url = illustrations[i]?.data?.url
        return url ? { ...card, imageUrl: url } : card
    })

    /**
     * 卡片激活 —— 走 SPA 路由而不是让 `<a href>` 整页刷新
     *
     * MagicBento 只在「普通左键点击」时调这里；Ctrl/Cmd/中键点击不会触发，
     * 交由浏览器原生打开新标签页。
     */
    const handleCardActivate = useCallback(
        (card: MagicBentoCardData) => {
            if (card.href) navigate(card.href)
        },
        [navigate],
    )

    return (
        <section
            className="pr-dashboard-magic-bento"
            aria-label="教学闭环六大环节"
            data-anchor
            data-anchor-label="教学闭环"
        >
            <header className="pr-dashboard-magic-bento-header">
                <span className="pr-dashboard-magic-bento-eyebrow">业务闭环</span>
                <h2 className="pr-dashboard-magic-bento-title">教学闭环六大环节</h2>
                <p className="pr-dashboard-magic-bento-subtitle">
                    诊断定起点、命题补短板、备课成方案、授课看反应、批改验效果、复盘回流下一轮——
                    六个环节首尾相接，点击任一环节直达对应工作台。
                </p>
            </header>
            <MagicBento
                cards={cardsWithMedia}
                enableStars={true}
                enableSpotlight={true}
                enableBorderGlow={true}
                enableTilt={true}
                enableMagnetism={true}
                clickEffect={true}
                spotlightRadius={320}
                particleCount={10}
                glowColor="152, 98, 39"
                className="pr-dashboard-magic-bento-grid"
                onCardActivate={handleCardActivate}
            />
        </section>
    )
}

export default TeachingLoopSection
