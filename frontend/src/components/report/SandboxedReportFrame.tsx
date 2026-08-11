import { useEffect, useMemo, useRef, useState } from 'react'
import type { PublicSharePreview } from '@/lib/types'
import { buildSandboxedReportDocument } from '@/lib/report-share-contract'
import './SandboxedReportFrame.css'

export interface SandboxedReportFrameProps {
    preview: PublicSharePreview
    title: string
    /** 公开阅读页按正文高度展开；管理弹窗保持内部滚动。 */
    autoHeight?: boolean
    className?: string
    testId?: string
}

/**
 * 报告正文从不使用 dangerouslySetInnerHTML 进入主 DOM。
 *
 * 这个 iframe 同时拥有三层约束：运行时标签白名单、srcDoc CSP 以及
 * sandbox（仅保留 same-origin 便于父页读取排版高度，不开启 scripts/forms/navigation）。
 */
export function SandboxedReportFrame({
    preview,
    title,
    autoHeight = false,
    className = '',
    testId,
}: SandboxedReportFrameProps) {
    const frameRef = useRef<HTMLIFrameElement>(null)
    const [height, setHeight] = useState<number | null>(null)
    const srcDoc = useMemo(() => buildSandboxedReportDocument(preview), [preview])

    useEffect(() => {
        setHeight(null)
    }, [srcDoc, autoHeight])

    const handleLoad = () => {
        if (!autoHeight) return
        try {
            const measured = frameRef.current?.contentDocument?.documentElement.scrollHeight
            if (typeof measured === 'number' && Number.isFinite(measured)) {
                // 防止异常内容制造无界页面；超过上限时 iframe 自身可键盘滚动。
                setHeight(Math.min(Math.max(Math.ceil(measured), 520), 12_000))
            }
        } catch {
            // 浏览器若对 sandbox origin 采用更严策略，保留固定高度滚动兜底。
        }
    }

    return (
        <iframe
            ref={frameRef}
            data-testid={testId}
            className={`pr-sandboxed-report${autoHeight ? ' pr-sandboxed-report--expanded' : ''}${className ? ` ${className}` : ''}`}
            title={title}
            srcDoc={srcDoc}
            sandbox="allow-same-origin"
            referrerPolicy="no-referrer"
            loading={autoHeight ? 'eager' : 'lazy'}
            onLoad={handleLoad}
            style={height ? { height: `${height}px` } : undefined}
        />
    )
}
