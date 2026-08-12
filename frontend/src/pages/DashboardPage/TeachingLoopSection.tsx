/**
 * 教学闭环六大环节区块
 *
 * ── 职责 ──
 * 1. 使用随发布包交付并逐张核验的六张 WebP，不再等待运行时生图
 * 2. 把 MagicBento 的卡片接成真实可导航的入口
 */

import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MagicBentoCardData } from '@/components/ui/MagicBento'
import { MagicBento } from '@/components/ui/MagicBento'

export type TeachingLoopCard = MagicBentoCardData

export interface TeachingLoopSectionProps {
    cards: TeachingLoopCard[]
}

export function TeachingLoopSection({ cards }: TeachingLoopSectionProps) {
    const navigate = useNavigate()

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
                cards={cards}
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
