/**
 * 课堂讲解面板（Phase 4.3 —— 教师课堂讲解工具）
 *
 * 回应"我是老师，这篇诗课堂上如何逐句讲"的核心追问
 * 提供逐句讲解 + 正音要点 + 讨论提示 + 意象分析四维讲解数据
 *
 * 数据流：
 * - api.poemContent.get(poemId) 获取 LineContent[]（原文/拼音/译文/注释）
 * - api.classroom.explain(poemId) 获取 ExplainLine[]（教学要点/正音要点/讨论提示/意象分析）
 * - 两者通过 lineIndex 对齐合并显示
 *
 * 视图模式：
 * - explain（逐句讲解）：完整四维数据，教师讲课主线
 * - pronunciation（正音专练）：高亮易错字 + 正音清单汇总，正音课专项
 *
 * 设计要点（规范第 5、9、13 章）：
 * - 松紧得当：诗句内部紧带（ruby+rt），句子间稳带，章节间松带
 * - Markdown 渲染品质：拼音用 ruby/rt 标注，原文/译文/注释层级分明
 * - 无 emoji，全部 Phosphor SVG 图标
 * - 透明度驱动：区域分隔用背景色差 + alpha，无硬边框
 */

import { memo, useCallback, useEffect, useState, useMemo } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api } from '@/lib/api'
import type {
    PoemContent,
    LineContent,
    ExplainResponse,
    ExplainLine,
    PronunciationNote,
} from '@/lib/types'
import { Icon } from '@/components/ui'
import {
    PoemVerificationDisclosure,
    PoemVerificationStatusBadge,
} from '@/components/ui/PoemVerification'
import '@/components/ui/icons-extended'
import './ExplainPanel.css'

/** 视图模式：逐句讲解 / 正音专练 */
type ViewMode = 'explain' | 'pronunciation'

const VIEW_MODES: readonly ViewMode[] = ['explain', 'pronunciation']

interface ExplainPanelProps {
    /** 诗篇 ID */
    poemId: string
    /** 可选：是否默认展开正音模式 */
    defaultMode?: ViewMode
}

/** 行对齐合并结果 */
interface MergedLine {
    lineIndex: number
    content: LineContent | undefined
    explain: ExplainLine | undefined
}

export const ExplainPanel = memo(function ExplainPanel({ poemId, defaultMode = 'explain' }: ExplainPanelProps) {
    const [poemContent, setPoemContent] = useState<PoemContent | null>(null)
    const [explainData, setExplainData] = useState<ExplainResponse | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [viewMode, setViewMode] = useState<ViewMode>(defaultMode)
    const [requestVersion, setRequestVersion] = useState(0)

    // 拉取诗内容 + 讲解数据（并行）
    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        Promise.all([
            api.poemContent.get(poemId),
            api.classroom.explain(poemId),
        ])
            .then(([content, explain]) => {
                if (cancelled) return
                setPoemContent(content)
                setExplainData(explain)
                setLoading(false)
            })
            .catch((err) => {
                if (cancelled) return
                if (import.meta.env.DEV) console.error('[ExplainPanel] 数据加载失败', err)
                setError('讲解数据加载失败，请稍后重试')
                setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [poemId, requestVersion])

    const retryLoad = useCallback(() => {
        setRequestVersion((previous) => previous + 1)
    }, [])

    const handleViewModeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
        const currentIndex = VIEW_MODES.indexOf(viewMode)
        let nextIndex: number
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                nextIndex = (currentIndex + 1) % VIEW_MODES.length
                break
            case 'ArrowLeft':
            case 'ArrowUp':
                nextIndex = (currentIndex - 1 + VIEW_MODES.length) % VIEW_MODES.length
                break
            case 'Home':
                nextIndex = 0
                break
            case 'End':
                nextIndex = VIEW_MODES.length - 1
                break
            default:
                return
        }
        event.preventDefault()
        const nextMode = VIEW_MODES[nextIndex]
        if (!nextMode) return
        setViewMode(nextMode)
        event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-explain-view-tab="${nextMode}"]`)
            ?.focus()
    }, [viewMode])

    // 行对齐合并：按两类数据真实给出的 lineIndex 并集排序，避免上游缺行或
    // 非连续索引时把有效讲解悄悄丢弃。
    const mergedLines: MergedLine[] = useMemo(() => {
        if (!poemContent || !explainData) return []
        const contentMap = new Map<number, LineContent>()
        poemContent.lines.forEach((l) => contentMap.set(l.lineIndex, l))
        const explainMap = new Map<number, ExplainLine>()
        explainData.lines.forEach((l) => explainMap.set(l.lineIndex, l))
        const indices = new Set([...contentMap.keys(), ...explainMap.keys()])
        return [...indices]
            .sort((left, right) => left - right)
            .map((lineIndex) => ({
                lineIndex,
                content: contentMap.get(lineIndex),
                explain: explainMap.get(lineIndex),
            }))
    }, [poemContent, explainData])

    // 正音字集合（用于原文高亮）—— PronunciationNote.char 可能是单字或词组，拆分为单字
    const pronunciationChars = useMemo(() => {
        const set = new Set<string>()
        explainData?.lines.forEach((line) => {
            line.pronunciationNotes.forEach((note) => {
                for (const ch of note.char) {
                    set.add(ch)
                }
            })
        })
        return set
    }, [explainData])

    // 全诗正音清单（正音模式汇总卡片）
    const allPronunciationNotes = useMemo(() => {
        if (!explainData) return [] as Array<{ note: PronunciationNote; lineIndex: number }>
        const list: Array<{ note: PronunciationNote; lineIndex: number }> = []
        explainData.lines.forEach((line) => {
            line.pronunciationNotes.forEach((note) => {
                list.push({ note, lineIndex: line.lineIndex })
            })
        })
        return list
    }, [explainData])

    // ── 加载态：骨架屏 ──
    if (loading) {
        return (
            <div className="pr-explain-panel pr-explain-panel--loading" role="status" aria-busy="true" aria-label="正在加载课堂讲解">
                <div className="pr-explain-skeleton pr-explain-skeleton--header" />
                <div className="pr-explain-skeleton pr-explain-skeleton--advice" />
                <div className="pr-explain-skeleton pr-explain-skeleton--line" />
                <div className="pr-explain-skeleton pr-explain-skeleton--line" />
                <div className="pr-explain-skeleton pr-explain-skeleton--line" />
            </div>
        )
    }

    // ── 错误态 ──
    if (error || !poemContent || !explainData) {
        return (
            <div className="pr-explain-panel pr-explain-panel--error" role="alert">
                <div className="pr-explain-error-icon">
                    <Icon name="warning-circle" size={32} />
                </div>
                <p className="pr-explain-error-text">
                    {error ?? '讲解数据不可用'}
                </p>
                <button type="button" className="pr-explain-error-retry" onClick={retryLoad}>
                    重新加载讲解
                </button>
            </div>
        )
    }

    return (
        <div className="pr-explain-panel">
            {/* Header：诗题 + 视图切换 */}
            <header className="pr-explain-header">
                <div className="pr-explain-header-meta">
                    <h3 className="pr-explain-header-title">
                        {poemContent.poemTitle}
                        <span className="pr-explain-header-poet">· {poemContent.poet}</span>
                    </h3>
                    <div className="pr-explain-header-badges">
                        <span className="pr-explain-badge pr-explain-badge--duration">
                            <Icon name="clock" size={12} />
                            建议 {explainData.suggestedDurationMin} 分钟
                        </span>
                        {explainData.aiGenerated && (
                            <span className="pr-explain-badge pr-explain-badge--ai">
                                <Icon name="sparkle" size={12} />
                                AI 讲解
                            </span>
                        )}
                        {poemContent.teachingContentReviewStatus === 'AI_UNVERIFIED' && (
                            <span className="pr-explain-badge pr-explain-badge--ai">
                                <Icon name="warning-circle" size={12} />
                                待教师复核
                            </span>
                        )}
                        <PoemVerificationStatusBadge verification={poemContent.sourceVerification} />
                    </div>
                </div>

                {/* 视图模式切换 */}
                <div
                    className="pr-explain-view-switch"
                    role="tablist"
                    aria-label="讲解视图模式"
                    onKeyDown={handleViewModeKeyDown}
                >
                    <button
                        type="button"
                        role="tab"
                        id="pr-explain-view-tab-explain"
                        data-explain-view-tab="explain"
                        aria-selected={viewMode === 'explain'}
                        aria-controls="pr-explain-view-panel"
                        tabIndex={viewMode === 'explain' ? 0 : -1}
                        className={`pr-explain-view-tab ${viewMode === 'explain' ? 'pr-explain-view-tab--active' : ''}`}
                        onClick={() => setViewMode('explain')}
                    >
                        <Icon name="book-open" size={14} />
                        逐句讲解
                    </button>
                    <button
                        type="button"
                        role="tab"
                        id="pr-explain-view-tab-pronunciation"
                        data-explain-view-tab="pronunciation"
                        aria-selected={viewMode === 'pronunciation'}
                        aria-controls="pr-explain-view-panel"
                        tabIndex={viewMode === 'pronunciation' ? 0 : -1}
                        className={`pr-explain-view-tab ${viewMode === 'pronunciation' ? 'pr-explain-view-tab--active' : ''}`}
                        onClick={() => setViewMode('pronunciation')}
                    >
                        <Icon name="microphone" size={14} />
                        正音专练
                    </button>
                </div>
            </header>

            {/* 课堂是教师高频决策场景：状态徽标用于快速扫读，完整披露确保
                内容来源边界不依赖悬停、记忆或跳转到其他页面才能得知。 */}
            <PoemVerificationDisclosure verification={poemContent.sourceVerification} />

            <div
                id="pr-explain-view-panel"
                className="pr-explain-view-panel"
                role="tabpanel"
                aria-labelledby={`pr-explain-view-tab-${viewMode}`}
            >
            {/* 整体教学建议（仅逐句讲解模式显示） */}
            {viewMode === 'explain' && (
                <section className="pr-explain-advice" aria-labelledby="pr-explain-advice-title">
                    <div className="pr-explain-advice-icon">
                        <Icon name="lightbulb" size={16} />
                    </div>
                    <div className="pr-explain-advice-body">
                        <h4 id="pr-explain-advice-title" className="pr-explain-advice-title">
                            整体教学建议
                        </h4>
                        <p className="pr-explain-advice-text">
                            {explainData.overallTeachingAdvice}
                        </p>
                    </div>
                </section>
            )}

            {/* 正音模式：全诗正音清单汇总 */}
            {viewMode === 'pronunciation' && allPronunciationNotes.length > 0 && (
                <section className="pr-explain-pron-summary" aria-labelledby="pr-explain-pron-summary-title">
                    <h4 id="pr-explain-pron-summary-title" className="pr-explain-pron-summary-title">
                        <Icon name="microphone" size={14} />
                        全诗正音清单
                        <span className="pr-explain-pron-summary-count">
                            {allPronunciationNotes.length} 处
                        </span>
                    </h4>
                    <div className="pr-explain-pron-grid">
                        {allPronunciationNotes.map(({ note, lineIndex }, idx) => (
                            <div
                                key={`${lineIndex}-${note.char}-${idx}`}
                                className="pr-explain-pron-card"
                            >
                                <div className="pr-explain-pron-card-char">{note.char}</div>
                                <div className="pr-explain-pron-card-info">
                                    <div className="pr-explain-pron-card-correct">
                                        {note.correctPinyin}
                                    </div>
                                    <div className="pr-explain-pron-card-error">
                                        易错：{note.commonError}
                                    </div>
                                </div>
                                <p className="pr-explain-pron-card-note">{note.note}</p>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {/* 逐句讲解列表 */}
            <div className="pr-explain-lines">
                {mergedLines.map((line) => (
                    <ExplainLineItem
                        key={line.lineIndex}
                        line={line}
                        viewMode={viewMode}
                        pronunciationChars={pronunciationChars}
                    />
                ))}
            </div>
            </div>
        </div>
    )
})

/** 单句讲解项 */
interface ExplainLineItemProps {
    line: MergedLine
    viewMode: ViewMode
    pronunciationChars: Set<string>
}

const ExplainLineItem = memo(function ExplainLineItem({ line, viewMode, pronunciationChars }: ExplainLineItemProps) {
    const { content, explain } = line
    if (!content && !explain) return null

    // 渲染原文（含正音高亮 + 拼音 ruby）
    const renderOriginal = () => {
        if (!content) return null
        const chars = Array.from(content.original)
        const pinyins = content.pinyin ?? []
        return (
            <div className="pr-explain-line-original">
                {chars.map((ch, idx) => {
                    const pinyin = pinyins[idx]
                    const needsPron = pronunciationChars.has(ch)
                    return (
                        <ruby
                            key={idx}
                            className={needsPron ? 'pr-explain-ruby pr-explain-ruby--pron' : 'pr-explain-ruby'}
                        >
                            {ch}
                            {pinyin && <rt>{pinyin}</rt>}
                        </ruby>
                    )
                })}
            </div>
        )
    }

    return (
        <article className="pr-explain-line">
            {/* 行号标识 */}
            <div className="pr-explain-line-index" aria-label={`第 ${line.lineIndex + 1} 句`}>
                {line.lineIndex + 1}
            </div>

            <div className="pr-explain-line-body">
                {/* 原文 + 译文 + 注释 */}
                {content && (
                    <div className="pr-explain-line-text">
                        {renderOriginal()}
                        <p className="pr-explain-line-translation">
                            {content.translation}
                        </p>
                        {content.annotations && content.annotations.length > 0 && (
                            <ul className="pr-explain-line-annotations">
                                {content.annotations.map((ann, idx) => (
                                    <li key={idx}>
                                        <span className="pr-explain-ann-word">{ann.word}</span>
                                        <span className="pr-explain-ann-explanation">{ann.explanation}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}

                {/* 正音要点（正音模式下置顶显示，含详细说明） */}
                {viewMode === 'pronunciation' && explain && explain.pronunciationNotes.length > 0 && (
                    <div className="pr-explain-line-section pr-explain-line-prons">
                        <div className="pr-explain-line-section-label">
                            <Icon name="microphone" size={12} />
                            正音要点
                        </div>
                        <div className="pr-explain-pron-list">
                            {explain.pronunciationNotes.map((note, idx) => (
                                <PronunciationDetailCard key={idx} note={note} />
                            ))}
                        </div>
                    </div>
                )}

                {/* 教学要点（仅逐句讲解模式） */}
                {viewMode === 'explain' && explain && explain.teachingPoints.length > 0 && (
                    <div className="pr-explain-line-section pr-explain-line-teaching">
                        <div className="pr-explain-line-section-label">
                            <Icon name="lightbulb" size={12} />
                            教学要点
                        </div>
                        <ul className="pr-explain-points">
                            {explain.teachingPoints.map((point, idx) => (
                                <li key={idx}>{point}</li>
                            ))}
                        </ul>
                    </div>
                )}

                {/* 正音提示（逐句讲解模式下紧凑显示） */}
                {viewMode === 'explain' && explain && explain.pronunciationNotes.length > 0 && (
                    <div className="pr-explain-line-section pr-explain-line-prons-compact">
                        <div className="pr-explain-line-section-label">
                            <Icon name="microphone" size={12} />
                            正音提示
                        </div>
                        <div className="pr-explain-pron-inline">
                            {explain.pronunciationNotes.map((note, idx) => (
                                <span key={idx} className="pr-explain-pron-chip">
                                    <span className="pr-explain-pron-chip-char">{note.char}</span>
                                    <span className="pr-explain-pron-chip-pinyin">{note.correctPinyin}</span>
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {/* 意象分析（仅逐句讲解模式） */}
                {viewMode === 'explain' && explain?.imageryAnalysis && (
                    <div className="pr-explain-line-section pr-explain-line-imagery">
                        <div className="pr-explain-line-section-label">
                            <Icon name="mountains" size={12} />
                            意象分析
                        </div>
                        <p className="pr-explain-imagery-text">{explain.imageryAnalysis}</p>
                    </div>
                )}

                {/* 讨论提示（仅逐句讲解模式） */}
                {viewMode === 'explain' && explain && explain.discussionPrompts.length > 0 && (
                    <div className="pr-explain-line-section pr-explain-line-discussion">
                        <div className="pr-explain-line-section-label">
                            <Icon name="chat" size={12} />
                            讨论提示
                        </div>
                        <ul className="pr-explain-prompts">
                            {explain.discussionPrompts.map((prompt, idx) => (
                                <li key={idx}>
                                    <span className="pr-explain-prompt-marker">Q{idx + 1}</span>
                                    {prompt}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </article>
    )
})

/** 正音详情卡片（正音模式专用，含完整说明） */
const PronunciationDetailCard = memo(function PronunciationDetailCard({ note }: { note: PronunciationNote }) {
    return (
        <div className="pr-explain-pron-detail">
            <div className="pr-explain-pron-detail-header">
                <span className="pr-explain-pron-detail-char">{note.char}</span>
                <span className="pr-explain-pron-detail-correct">{note.correctPinyin}</span>
                <span className="pr-explain-pron-detail-error">易错：{note.commonError}</span>
            </div>
            <p className="pr-explain-pron-detail-note">{note.note}</p>
        </div>
    )
})
