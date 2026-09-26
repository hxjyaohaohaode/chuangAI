/**
 * 闯关 HUD —— 导播台七个模式共用的顶部条
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么要有它
 * ─────────────────────────────────────────────────────────────
 * 此前七个模式各玩各的：集体闯关、竞速 PK、飞花令、接龙、六阶沉浸、
 * 意象拼图、诗词转盘之间没有共享的进度与积分，切个模式等于重开，
 * 学生也无从知道"这节课打到哪儿了"。
 *
 * HUD 把四件事同时摆在大屏上，且**跨模式不清零**：
 * 1. 六阶关卡链——这节课要打哪几关、现在在第几关、还剩几关
 * 2. 全班诗力值——统一授课下唯一不分你我的指标，答错不扣分
 * 3. 连击——即时的正反馈，比累计分更能带动课堂情绪
 * 4. 三榜——个人 / 小组 / AI 对手，四类激励同屏并存
 *
 * ─────────────────────────────────────────────────────────────
 * 大屏取向的设计取舍
 * ─────────────────────────────────────────────────────────────
 * 教室里学生离屏幕最远有七八米，所以数字用大号等宽字、关卡链用
 * 明确的"已过/在打/未解锁"三态而非仅靠深浅色（规范 12：颜色不能是
 * 唯一信息载体，这在投影仪色偏严重的教室里尤其致命）。
 * 通关动画只用 transform/opacity，且在 prefers-reduced-motion 下降级。
 */

import { memo, useEffect, useState } from 'react'
import { Icon } from '@/components/ui'
import { useClassroomStore } from '@/stores/classroom'
import './QuestHud.css'

/** 通关横幅停留时长（ms） */
const BANNER_MS = 2600

export const QuestHud = memo(function QuestHud() {
    const quest = useClassroomStore((s) => s.quest)
    const lastCleared = useClassroomStore((s) => s.lastLevelCleared)
    const [banner, setBanner] = useState<typeof lastCleared>(null)

    // 通关横幅：出现后自动消失，不需要教师去关
    useEffect(() => {
        if (!lastCleared) return
        setBanner(lastCleared)
        const t = window.setTimeout(() => setBanner(null), BANNER_MS)
        return () => window.clearTimeout(t)
    }, [lastCleared])

    if (!quest) return null

    const { levels, levelTitle, levelGoal, classPower, levelProgress, levelPower, levelTarget,
        combo, maxCombo, aiOpponentScore, leaderboard, hasTeams } = quest

    // 只显示本堂课真正有题目的关；没有题目的关灰显但仍占位，
    // 让学生看得到"完整的六阶地图"以及本课走了其中哪几段
    const cleared = levels.filter((l) => l.cleared).length
    const playable = levels.filter((l) => l.questionCount > 0).length

    return (
        <section
            className="pr-quest-hud"
            aria-label="闯关进度"
            data-quest-renderer="authoritative"
            data-quest-level={quest.currentLevel}
            data-quest-power={classPower}
        >
            {/* ── 通关横幅 ── */}
            {banner && (
                <div className="pr-quest-banner" role="status">
                    <Icon name="seal-check" size={22} weight="fill" />
                    <strong>
                        {banner.allCleared
                            ? '全关通过！'
                            : `${banner.clearedLevel} 关通过`}
                    </strong>
                    {!banner.allCleared && banner.nextLevel && (
                        <span>下一关 · {banner.nextLevel}</span>
                    )}
                </div>
            )}

            {/* ── 关卡链 ── */}
            <div className="pr-quest-chain" role="list" aria-label="六阶关卡链">
                {levels.map((lv) => {
                    const state = lv.cleared ? 'cleared' : lv.current ? 'current' : lv.questionCount > 0 ? 'locked' : 'absent'
                    const label = lv.cleared ? '已通过' : lv.current ? '进行中' : lv.questionCount > 0 ? '未解锁' : '本课不涉及'
                    return (
                        <div
                            key={lv.level}
                            role="listitem"
                            className={`pr-quest-node pr-quest-node--${state}`}
                            title={`${lv.title} · ${lv.goal} · ${label}`}
                        >
                            <span className="pr-quest-node-mark" aria-hidden="true">
                                {lv.cleared
                                    ? <Icon name="check" size={13} weight="bold" />
                                    : lv.current
                                        ? <Icon name="caret-right" size={13} weight="bold" />
                                        : <Icon name="lock-simple" size={12} />}
                            </span>
                            <span className="pr-quest-node-name">{lv.level}</span>
                            {/* 状态用文字兜底，不依赖颜色（投影仪色偏下这一条尤其重要） */}
                            <span className="pr-quest-node-state">{label}</span>
                        </div>
                    )
                })}
            </div>

            {/* ── 当前关 + 全班诗力值 ── */}
            <div className="pr-quest-main">
                <div className="pr-quest-level">
                    <span className="pr-quest-level-title">{levelTitle}</span>
                    <span className="pr-quest-level-goal">{levelGoal}</span>
                </div>

                <div className="pr-quest-power">
                    <div className="pr-quest-power-head">
                        <span className="pr-quest-power-label">
                            <Icon name="lightning" size={12} weight="fill" />
                            全班诗力值
                        </span>
                        <span className="pr-quest-power-value">{classPower}</span>
                    </div>
                    <div
                        className="pr-quest-power-track"
                        role="progressbar"
                        aria-valuenow={levelProgress}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${levelTitle}进度`}
                    >
                        <div
                            className="pr-quest-power-fill"
                            style={{ transform: `scaleX(${Math.min(1, levelProgress / 100)})` }}
                        />
                    </div>
                    <span className="pr-quest-power-sub">
                        本关 {levelPower} / {levelTarget} · 已通 {cleared} / {playable} 关
                    </span>
                </div>

                {/* 连击：只在连对时出现，避免常驻一个 0 让人分心 */}
                {combo > 1 && (
                    <div className="pr-quest-combo" role="status" aria-live="polite">
                        <span className="pr-quest-combo-num">{combo}</span>
                        <span className="pr-quest-combo-label">连对</span>
                        {maxCombo > combo && (
                            <span className="pr-quest-combo-best">最高 {maxCombo}</span>
                        )}
                    </div>
                )}
            </div>

            {/* ── 三榜 ── */}
            <div className="pr-quest-boards">
                {hasTeams && leaderboard.teams.length > 0 && (
                    <div className="pr-quest-board">
                        <span className="pr-quest-board-title">
                            <Icon name="users" size={11} />小组
                        </span>
                        <ol className="pr-quest-board-list">
                            {leaderboard.teams.slice(0, 4).map((t, i) => (
                                <li key={t.id}>
                                    <span className="pr-quest-rank">{i + 1}</span>
                                    <span className="pr-quest-board-name">{t.name}</span>
                                    <span className="pr-quest-board-score">{t.score}</span>
                                </li>
                            ))}
                        </ol>
                    </div>
                )}

                <div className="pr-quest-board">
                    <span className="pr-quest-board-title">
                        <Icon name="trophy" size={11} />个人
                    </span>
                    {leaderboard.personal.length === 0 ? (
                        <span className="pr-quest-board-empty">还没有人作答</span>
                    ) : (
                        <ol className="pr-quest-board-list">
                            {leaderboard.personal.slice(0, 4).map((p, i) => (
                                <li key={p.studentId}>
                                    <span className="pr-quest-rank">{i + 1}</span>
                                    <span className="pr-quest-board-name">{p.name}</span>
                                    <span className="pr-quest-board-score">{p.score}</span>
                                </li>
                            ))}
                        </ol>
                    )}
                </div>

                {/* AI 对手：给全班一个看得见的追赶目标 */}
                <div className="pr-quest-board pr-quest-board--ai">
                    <span className="pr-quest-board-title">
                        <Icon name="sparkle" size={11} />AI 对手
                    </span>
                    <div className="pr-quest-ai">
                        <span className="pr-quest-ai-score">{aiOpponentScore}</span>
                        <span className="pr-quest-ai-gap">
                            {classPower >= aiOpponentScore
                                ? `全班领先 ${classPower - aiOpponentScore}`
                                : `落后 ${aiOpponentScore - classPower}`}
                        </span>
                    </div>
                </div>
            </div>
        </section>
    )
})

export default QuestHud
