/**
 * Accessible, dependency-free streaming text renderer.
 *
 * This component deliberately owns presentation timing only.  The caller owns
 * the actual model/network stream, so pausing this view can never discard or
 * fabricate generated content.  Content is revealed from a React state cursor
 * and is rendered as ordinary text (not via DOM mutation or an animation
 * library), which keeps recovery, assistive technology and reduced-motion
 * behaviour deterministic.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import './StreamText.css'
import { Icon } from './Icon'
import { cn } from '@/lib/cn'
import { subscribeMediaQuery } from '@/lib/media-query'

export interface StreamTextProps {
    /** 完整内容（流式目标） */
    content: string
    /** 每次显示下一组字符前的延迟（ms），默认 15ms */
    charStagger?: number
    /** 新内容块的视觉过渡时长（ms），默认 300ms */
    charDuration?: number
    /** 换行后的额外停顿（ms），默认 100ms */
    paragraphDelay?: number
    /** 是否显示光标，默认 true */
    showCursor?: boolean
    /** 输出完成回调 */
    onComplete?: () => void
    /** 用户主动中断回调（仅暂停本地展示，不会篡改上游流） */
    onInterrupt?: () => void
    /** 用户从中断态继续回调 */
    onResume?: () => void
    /** 自定义类名 */
    className?: string
    /** 是否启用结构化拆分（段落/列表/代码块），默认 true */
    structured?: boolean
}

type BlockType = 'paragraph' | 'list-item' | 'code-line' | 'heading' | 'blank'

interface ContentBlock {
    type: BlockType
    text: string
}

const clamp = (value: number, minimum: number, maximum: number) =>
    Math.min(Math.max(value, minimum), maximum)

const toCharacters = (text: string) => Array.from(text)

/** Preserve readable source structure without evaluating or injecting markup. */
function parseBlocks(content: string): ContentBlock[] {
    if (!content) return []

    return content.split('\n').map((line) => {
        const trimmed = line.trim()
        if (!trimmed) return { type: 'blank' as const, text: '' }
        if (trimmed.startsWith('```') || trimmed.startsWith('    ') || trimmed.startsWith('\t')) {
            return { type: 'code-line' as const, text: line }
        }
        if (/^#{1,6}\s+/.test(trimmed)) {
            return { type: 'heading' as const, text: trimmed.replace(/^#{1,6}\s+/, '') }
        }
        if (/^(?:-|\*|•)\s+/.test(trimmed)) {
            return { type: 'list-item' as const, text: trimmed.replace(/^(?:-|\*|•)\s+/, '') }
        }
        return { type: 'paragraph' as const, text: line }
    })
}

export const StreamText = memo(function StreamText({
    content,
    charStagger = 15,
    charDuration = 300,
    paragraphDelay = 100,
    showCursor = true,
    onComplete,
    onInterrupt,
    onResume,
    className,
    structured = true,
}: StreamTextProps) {
    const [reducedMotion, setReducedMotion] = useState(false)
    const [visibleLength, setVisibleLength] = useState(0)
    const [interrupted, setInterrupted] = useState(false)
    const [cursorVisible, setCursorVisible] = useState(true)
    const visibleLengthRef = useRef(0)
    const previousContentRef = useRef<string | null>(null)
    const completedContentRef = useRef<string | null>(null)
    const onCompleteRef = useRef(onComplete)
    const onInterruptRef = useRef(onInterrupt)
    const onResumeRef = useRef(onResume)

    const characters = useMemo(() => toCharacters(content), [content])
    const targetLength = characters.length
    const visibleContent = useMemo(
        () => characters.slice(0, visibleLength).join(''),
        [characters, visibleLength],
    )
    const isComplete = visibleLength >= targetLength
    const isStreaming = !interrupted && !isComplete
    const isPaused = interrupted && !isComplete

    const setVisibleCursor = useCallback((nextLength: number) => {
        visibleLengthRef.current = nextLength
        setVisibleLength(nextLength)
    }, [])

    useEffect(() => {
        onCompleteRef.current = onComplete
    }, [onComplete])

    useEffect(() => {
        onInterruptRef.current = onInterrupt
    }, [onInterrupt])

    useEffect(() => {
        onResumeRef.current = onResume
    }, [onResume])

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
        const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
        const updatePreference = () => setReducedMotion(mediaQuery.matches)

        updatePreference()
        return subscribeMediaQuery(mediaQuery, updatePreference)
    }, [])

    /**
     * Retain progress for an appended server stream; reset only when the caller
     * replaces the response. This is intentionally content-based rather than
     * timer-based, so delayed chunks and retries cannot expose stale text.
     */
    useEffect(() => {
        const previousContent = previousContentRef.current
        const isAppend = previousContent !== null && content.startsWith(previousContent)
        previousContentRef.current = content

        if (reducedMotion) {
            setVisibleCursor(targetLength)
            return
        }

        const nextLength = isAppend
            ? Math.min(visibleLengthRef.current, targetLength)
            : 0

        setVisibleCursor(nextLength)
        if (!isAppend) {
            setInterrupted(false)
        }
    }, [content, reducedMotion, setVisibleCursor, targetLength])

    /**
     * A single cancellable timer advances a code-point cursor. Batching bounds
     * render work for long AI answers while preserving the perception of a
     * stream. There is no requestAnimationFrame loop, DOM query or global input
     * listener to leak when a route changes.
     */
    useEffect(() => {
        if (reducedMotion || interrupted || isComplete || targetLength === 0) return

        let timerId: number | undefined
        let cancelled = false
        const interval = clamp(charStagger, 8, 120)
        const breakDelay = clamp(paragraphDelay, 0, 800)
        const batchSize = Math.max(1, Math.ceil(targetLength / 220))

        const advance = () => {
            if (cancelled) return

            const nextLength = Math.min(targetLength, visibleLengthRef.current + batchSize)
            setVisibleCursor(nextLength)
            if (nextLength >= targetLength) return

            const lastCharacter = characters[nextLength - 1]
            const delay = lastCharacter === '\n' ? Math.max(interval, breakDelay) : interval
            timerId = window.setTimeout(advance, delay)
        }

        timerId = window.setTimeout(advance, interval)
        return () => {
            cancelled = true
            if (timerId !== undefined) window.clearTimeout(timerId)
        }
    }, [characters, charStagger, interrupted, isComplete, paragraphDelay, reducedMotion, setVisibleCursor, targetLength])

    /** Announce phase changes once, and keep the visual cursor for 200 ms after completion. */
    useEffect(() => {
        if (!isComplete) {
            setCursorVisible(true)
            return
        }

        if (completedContentRef.current !== content) {
            completedContentRef.current = content
            onCompleteRef.current?.()
        }

        const fadeTimer = window.setTimeout(() => setCursorVisible(false), 200)
        return () => window.clearTimeout(fadeTimer)
    }, [content, isComplete])

    const blocks = useMemo<ContentBlock[]>(() => {
        if (!visibleContent) return []
        return structured
            ? parseBlocks(visibleContent)
            : [{ type: 'paragraph', text: visibleContent }]
    }, [structured, visibleContent])

    const handleInterrupt = useCallback(() => {
        setInterrupted(true)
        onInterruptRef.current?.()
    }, [])

    const handleResume = useCallback(() => {
        setInterrupted(false)
        onResumeRef.current?.()
    }, [])

    const renderBlock = useCallback((block: ContentBlock, blockIndex: number): ReactNode => {
        if (block.type === 'blank') {
            return <div key={`blank-${blockIndex}`} className="pr-stream-blank" aria-hidden="true" />
        }

        const classNames: Record<Exclude<BlockType, 'blank'>, string> = {
            paragraph: 'pr-stream-paragraph',
            'list-item': 'pr-stream-list-item',
            'code-line': 'pr-stream-code-line',
            heading: 'pr-stream-heading',
        }

        return (
            <div
                key={`block-${blockIndex}`}
                className={cn('pr-stream-block', classNames[block.type])}
            >
                {block.text}
            </div>
        )
    }, [])

    const statusMessage = isComplete
        ? '内容生成完成'
        : isPaused
            ? '生成已暂停，可继续'
            : 'AI 正在生成内容'

    const style = {
        '--pr-stream-reveal-duration': `${clamp(charDuration, 0, 700)}ms`,
    } as CSSProperties

    return (
        <div
            className={cn('pr-stream-text', isStreaming && 'is-streaming', className)}
            data-stream-state={isComplete ? 'complete' : isPaused ? 'paused' : 'streaming'}
            style={style}
        >
            <span className="pr-sr-only" role="status" aria-live="polite" aria-atomic="true">
                {statusMessage}
            </span>
            <div className="pr-stream-content" aria-live="off">
                {blocks.map(renderBlock)}
                {showCursor && cursorVisible && (
                    <span
                        className={cn('pr-stream-cursor', isComplete && 'is-fading')}
                        aria-hidden="true"
                    />
                )}
            </div>
            {isStreaming && (
                <button
                    type="button"
                    className="pr-stream-action pr-stream-stop"
                    onClick={handleInterrupt}
                    aria-label="中断生成"
                >
                    <Icon name="stop" size={12} />
                    <span>停止</span>
                </button>
            )}
            {isPaused && (
                <button type="button" className="pr-stream-action pr-stream-resume" onClick={handleResume}>
                    <Icon name="play" size={12} />
                    <span>继续生成</span>
                </button>
            )}
        </div>
    )
})
