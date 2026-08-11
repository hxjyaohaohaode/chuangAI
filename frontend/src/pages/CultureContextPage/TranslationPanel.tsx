/**
 * TranslationPanel 逐句译文面板（Phase 2.5 —— CultureContextPage 增强）
 *
 * 回应"我是学生/老师，这首诗每一句到底什么意思"的核心追问
 * 展示诗篇的逐句原文（带拼音标注）、现代汉语译文、关键字词注释
 *
 * 数据来源：PoemContent.lines（Phase 2 已实现的类型）
 *   - original: 原文诗句
 *   - pinyin: 逐字拼音数组
 *   - translation: 现代汉语译文
 *   - annotations: 关键词注释
 *
 * 设计要点（规范第 5、9、13 章）：
 * - ruby 拼音标注：原文上方显示拼音，符合小学语文教学规范
 * - 松紧得当：诗句之间松带，单句内部稳带
 * - 无 emoji，全部 Phosphor SVG 图标
 * - 透明度驱动：区域分隔用背景色差 + alpha
 * - 流体响应：clamp() 尺寸
 * - 完整三态：loading（骨架屏）/ data / empty / error
 */

import { memo, useEffect, useState } from 'react'
import { Icon } from '@/components/ui'
import { PoemVerificationDisclosure } from '@/components/ui/PoemVerification'
import { api } from '@/lib/api'
import { useCultureStore } from '@/stores/culture'
import type { PoemContent, LineContent } from '@/lib/types'
import { cn } from '@/lib/cn'
import './TranslationPanel.css'

interface TranslationPanelProps {
    className?: string
}

export const TranslationPanel = memo(function TranslationPanel({ className }: TranslationPanelProps) {
    const selectedPoemId = useCultureStore((s) => s.selectedPoemId)
    const [content, setContent] = useState<PoemContent | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // 拉取诗内容数据（含逐句原文+拼音+译文+注释）
    useEffect(() => {
        if (!selectedPoemId) {
            setContent(null)
            return
        }
        let cancelled = false
        setLoading(true)
        setError(null)
        api.poemContent.get(selectedPoemId)
            .then((data) => {
                if (cancelled) return
                setContent(data)
                setLoading(false)
            })
            .catch((err) => {
                if (cancelled) return
                if (import.meta.env.DEV) console.error('[TranslationPanel] 数据加载失败', err)
                setError('译文正在准备中，请稍候再试')
                setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [selectedPoemId])

    return (
        <section className={cn('pr-culture-section pr-culture-trans', className)}>
            <div className="pr-culture-section-header">
                <h2 className="pr-culture-section-title">
                    <span className="pr-culture-section-title-icon">
                        <Icon name="book-open" size={16} />
                    </span>
                    <span>逐句译文</span>
                </h2>
                <div className="pr-culture-section-meta">
                    {content?.teachingContentReviewStatus === 'AI_UNVERIFIED' && (
                        <span className="pr-culture-ai-badge">
                            <Icon name="sparkle" size={10} />
                            AI 内容·待教师复核
                        </span>
                    )}
                </div>
            </div>

            {loading ? (
                <div className="pr-culture-trans-skeleton-wrap">
                    {[0, 1, 2, 3].map((i) => (
                        <div key={i} className="pr-culture-trans-skeleton" />
                    ))}
                </div>
            ) : error ? (
                <div className="pr-culture-empty">
                    <div className="pr-culture-empty-icon">
                        <Icon name="book-open" size={24} />
                    </div>
                    <p className="pr-culture-empty-title">{error}</p>
                    <p className="pr-culture-empty-desc">
                        可稍候片刻重新选诗，系统会再次尝试生成逐句译文。
                    </p>
                </div>
            ) : content ? (
                <div className="pr-culture-trans-content pr-culture-fade-in">
                    <PoemVerificationDisclosure verification={content.sourceVerification} />

                    {/* 全诗大意卡片 */}
                    {content.overallTranslation && (
                        <div className="pr-culture-trans-overall">
                            <div className="pr-culture-trans-overall-header">
                                <Icon name="lightbulb" size={12} />
                                <span>全诗大意</span>
                            </div>
                            <p className="pr-culture-trans-overall-text">
                                {content.overallTranslation}
                            </p>
                        </div>
                    )}

                    {/* 逐行内容列表 */}
                    <div className="pr-culture-trans-lines">
                        {content.lines.map((line) => (
                            <TranslationLine key={line.lineIndex} line={line} />
                        ))}
                    </div>

                    {/* 主题思想卡片 */}
                    {content.theme && (
                        <div className="pr-culture-trans-theme">
                            <div className="pr-culture-trans-theme-header">
                                <Icon name="sparkle" size={12} />
                                <span>主题思想</span>
                            </div>
                            <p className="pr-culture-trans-theme-text">
                                {content.theme}
                            </p>
                        </div>
                    )}
                </div>
            ) : (
                <div className="pr-culture-empty">
                    <div className="pr-culture-empty-icon">
                        <Icon name="text-aa" size={24} />
                    </div>
                    <p className="pr-culture-empty-title">选诗后展示逐句原文、拼音与译文</p>
                    <p className="pr-culture-empty-desc">
                        每句配关键字词注释，便于学生逐字理解诗意。
                    </p>
                </div>
            )}
        </section>
    )
})

/**
 * 单行译文组件
 * 展示：行号 + 原文（ruby 拼音标注）+ 译文 + 注释
 */
interface TranslationLineProps {
    line: LineContent
}

const TranslationLine = memo(function TranslationLine({ line }: TranslationLineProps) {
    // 将原文拆分为单字数组，与拼音数组对应
    const chars = Array.from(line.original)

    return (
        <article className="pr-culture-trans-line">
            {/* 行号 */}
            <div className="pr-culture-trans-line-number" aria-hidden>
                {line.lineIndex + 1}
            </div>

            {/* 行内容 */}
            <div className="pr-culture-trans-line-body">
                {/* 原文（ruby 拼音标注） */}
                <div className="pr-culture-trans-original">
                    <ruby className="pr-culture-trans-ruby">
                        {chars.map((char, i) => (
                            <span key={i} className="pr-culture-trans-char">
                                {char}
                                <rt className="pr-culture-trans-pinyin">
                                    {line.pinyin?.[i] ?? ''}
                                </rt>
                            </span>
                        ))}
                    </ruby>
                </div>

                {/* 译文 */}
                <p className="pr-culture-trans-translation">
                    {line.translation}
                </p>

                {/* 注释（关键字词解释） */}
                {line.annotations && line.annotations.length > 0 && (
                    <div className="pr-culture-trans-annotations">
                        <div className="pr-culture-trans-annotations-label">
                            <Icon name="text-aa" size={11} />
                            <span>注释</span>
                        </div>
                        <ul className="pr-culture-trans-annotation-list">
                            {line.annotations.map((ann, i) => (
                                <li key={i} className="pr-culture-trans-annotation">
                                    <span className="pr-culture-trans-annotation-word">
                                        {ann.word}
                                    </span>
                                    <span className="pr-culture-trans-annotation-explanation">
                                        {ann.explanation}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </article>
    )
})
