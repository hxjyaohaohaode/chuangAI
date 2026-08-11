import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import '@/components/ui/icons-extended'
import { Button, Icon } from '@/components/ui'
import { SandboxedReportFrame } from '@/components/report/SandboxedReportFrame'
import { fetchPublicSharedReport } from '@/lib/public-report-client'
import { schedulePublicShareExpiry } from '@/lib/report-share-expiry'
import {
    isValidShareToken,
    PublicShareAccessError,
    type PublicShareAccessFailure,
} from '@/lib/report-share-contract'
import type { PublicSharedReport } from '@/lib/types'
import './SharedReportPage.css'

type PageState =
    | { kind: 'loading' }
    | { kind: 'ready'; report: PublicSharedReport }
    | { kind: 'error'; reason: PublicShareAccessFailure }

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
})

function usePublicDocumentPrivacy(): void {
    useEffect(() => {
        const previousTitle = document.title
        document.title = '公开教研报告 · 诗脉·启明'
        document.body.classList.add('pr-shared-report-document')

        const configureMeta = (name: string, content: string) => {
            const existing = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
            const element = existing ?? document.createElement('meta')
            const previous = existing?.content
            if (!existing) {
                element.name = name
                document.head.appendChild(element)
            }
            element.content = content
            return () => {
                if (existing && previous !== undefined) element.content = previous
                else element.remove()
            }
        }

        const restoreRobots = configureMeta('robots', 'noindex,nofollow,noarchive')
        const restoreReferrer = configureMeta('referrer', 'no-referrer')
        return () => {
            document.title = previousTitle
            document.body.classList.remove('pr-shared-report-document')
            restoreRobots()
            restoreReferrer()
        }
    }, [])
}

function errorCopy(reason: PublicShareAccessFailure): { title: string; body: string; icon: 'x-circle' | 'warning-circle' } {
    if (reason === 'unavailable') {
        return {
            title: '这份分享已不可访问',
            body: '链接可能已过期、已被教师撤销，或地址不完整。为保护隐私，系统不会区分具体原因。',
            icon: 'x-circle',
        }
    }
    if (reason === 'invalid-response') {
        return {
            title: '公开内容未通过安全校验',
            body: '服务返回的内容与脱敏公开版契约不一致。系统已失败关闭，不会展示未校验正文。',
            icon: 'warning-circle',
        }
    }
    return {
        title: '暂时无法连接报告服务',
        body: '请检查网络后重试。本页不会用缓存或演示内容代替真实报告。',
        icon: 'warning-circle',
    }
}

export default function SharedReportPage() {
    const { token = '' } = useParams<{ token: string }>()
    const [state, setState] = useState<PageState>({ kind: 'loading' })
    const [retryKey, setRetryKey] = useState(0)
    const stateHeadingRef = useRef<HTMLHeadingElement>(null)
    usePublicDocumentPrivacy()

    useEffect(() => {
        if (!isValidShareToken(token)) {
            setState({ kind: 'error', reason: 'unavailable' })
            return
        }

        const controller = new AbortController()
        let active = true
        setState({ kind: 'loading' })
        void fetchPublicSharedReport(token, controller.signal)
            .then(({ shared }) => {
                if (!active) return
                if (shared.expireAt <= Date.now()) {
                    setState({ kind: 'error', reason: 'unavailable' })
                    return
                }
                setState({ kind: 'ready', report: shared })
            })
            .catch((error: unknown) => {
                if (!active || controller.signal.aborted) return
                setState({
                    kind: 'error',
                    reason: error instanceof PublicShareAccessError ? error.reason : 'network',
                })
            })
        return () => {
            active = false
            controller.abort()
        }
    }, [token, retryKey])

    useEffect(() => {
        if (state.kind === 'loading') return
        window.requestAnimationFrame(() => stateHeadingRef.current?.focus({ preventScroll: true }))
    }, [state.kind])

    // 页面长时打开时也在到期瞬间失效；超过浏览器 32 位 timeout 上限时
    // 分段重排，绝不能把 30/60/90 天链接在第一段结束时提前判失效。
    useEffect(() => {
        if (state.kind !== 'ready') return
        return schedulePublicShareExpiry(
            state.report.expireAt,
            () => setState({ kind: 'error', reason: 'unavailable' }),
        )
    }, [state])

    const retry = useCallback(() => setRetryKey((value) => value + 1), [])

    return (
        <div className="pr-shared-report-page" data-testid="shared-report-page">
            <a className="pr-skip-link" href="#shared-report-main">跳到报告正文</a>
            <header className="pr-shared-report-header">
                <div className="pr-shared-report-brand" aria-label="诗脉·启明 PoeticRealm AI">
                    <span className="pr-shared-report-brand__mark" aria-hidden="true">
                        <Icon name="scroll" size={22} />
                    </span>
                    <span className="pr-shared-report-brand__copy">
                        <strong>诗脉·启明</strong>
                        <span>PoeticRealm AI</span>
                    </span>
                </div>
                <div className="pr-shared-report-privacy-mark">
                    <Icon name="shield-check" size={16} />
                    <span>脱敏公开副本</span>
                </div>
            </header>

            <main id="shared-report-main" className="pr-shared-report-main">
                {state.kind === 'loading' && (
                    <section className="pr-shared-report-state" data-testid="shared-report-loading" role="status" aria-live="polite" aria-busy="true">
                        <span className="pr-shared-report-state__seal" aria-hidden="true">
                            <Icon name="circle-notch" size={28} className="pr-app-spin" />
                        </span>
                        <h1>正在验证脱敏报告</h1>
                        <p>系统正在检查链接有效期与公开内容契约。</p>
                    </section>
                )}

                {state.kind === 'error' && (() => {
                    const copy = errorCopy(state.reason)
                    return (
                        <section className="pr-shared-report-state pr-shared-report-state--error" data-testid={`shared-report-error-${state.reason}`} role="alert">
                            <span className="pr-shared-report-state__seal" aria-hidden="true">
                                <Icon name={copy.icon} size={30} />
                            </span>
                            <span className="pr-shared-report-eyebrow">隐私保护边界</span>
                            <h1 ref={stateHeadingRef} tabIndex={-1}>{copy.title}</h1>
                            <p>{copy.body}</p>
                            <div className="pr-shared-report-state__actions">
                                <Button
                                    variant="primary"
                                    size="md"
                                    leftIcon={<Icon name="arrows-clockwise" size={16} />}
                                    onClick={retry}
                                    data-testid="shared-report-retry"
                                >
                                    重新尝试
                                </Button>
                            </div>
                            <p className="pr-shared-report-state__help">如果问题持续，请联系分享这份报告的教师重新创建链接。</p>
                        </section>
                    )
                })()}

                {state.kind === 'ready' && (
                    <article className="pr-shared-report-sheet" data-testid="shared-report-ready" aria-labelledby="shared-report-title">
                        <header className="pr-shared-report-sheet__header">
                            <div className="pr-shared-report-sheet__heading">
                                <span className="pr-shared-report-eyebrow">教研成果 · 公开阅读版</span>
                                <h1 id="shared-report-title" ref={stateHeadingRef} tabIndex={-1}>
                                    {state.report.title}
                                </h1>
                                <div className="pr-shared-report-meta" aria-label="报告分享信息">
                                    <span><Icon name="graduation" size={15} />{state.report.className}</span>
                                    <span><Icon name="calendar" size={15} />快照创建于 {DATE_TIME_FORMAT.format(state.report.createdAt)}</span>
                                    <span><Icon name="clock" size={15} />有效至 {DATE_TIME_FORMAT.format(state.report.expireAt)}</span>
                                </div>
                            </div>
                            <div className="pr-shared-report-sheet__actions no-print">
                                <Button
                                    variant="secondary"
                                    size="md"
                                    leftIcon={<Icon name="printer" size={16} />}
                                    onClick={() => window.print()}
                                    data-testid="shared-report-print"
                                >
                                    打印公开副本
                                </Button>
                            </div>
                        </header>

                        <aside className="pr-shared-report-disclosure" aria-label="AI 与隐私说明">
                            <Icon name="shield-check" size={18} />
                            <p>
                                <strong>本页为 AI 生成报告的脱敏快照。</strong>
                                已隐藏个体学生信息、内部主键和家长联系信息；最终解释与对外使用由分享教师负责。
                                教师撤销链接只会阻断后续访问，无法远程收回已经打开、打印、截图或保存的副本。
                            </p>
                        </aside>

                        <SandboxedReportFrame
                            preview={state.report}
                            title={`报告正文：${state.report.title}`}
                            autoHeight
                            testId="shared-report-frame"
                        />

                        <footer className="pr-shared-report-sheet__footer">
                            <span>诗脉·启明 · 教研证据留痕</span>
                            <span>到期后本页失效；撤销会阻断后续访问</span>
                        </footer>
                    </article>
                )}
            </main>
        </div>
    )
}
