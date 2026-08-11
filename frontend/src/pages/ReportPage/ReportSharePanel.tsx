import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/lib/errors'
import { api } from '@/lib/api'
import {
    buildPublicShareUrl,
    isSecurePublicShareOrigin,
} from '@/lib/report-share-contract'
import type {
    PreviewShareResponse,
    SharedReport,
} from '@/lib/types'
import { useReportStore } from '@/stores/report'
import { Button, Card, Icon, Modal } from '@/components/ui'
import { SandboxedReportFrame } from '@/components/report/SandboxedReportFrame'
import './ReportSharePanel.css'

const DATE_FORMAT = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
})
const DATE_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
})

type CopyStatus = 'idle' | 'copied' | 'manual'
type PanelFeedback = { kind: 'success' | 'error'; text: string }

export function ReportSharePanel() {
    const currentReport = useReportStore((state) => state.currentReport)
    const [shares, setShares] = useState<SharedReport[]>([])
    const [listLoading, setListLoading] = useState(true)
    const [listError, setListError] = useState(false)
    const [flowOpen, setFlowOpen] = useState(false)
    const [expireDays, setExpireDays] = useState<number>(7)
    const [previewResponse, setPreviewResponse] = useState<PreviewShareResponse | null>(null)
    const [previewing, setPreviewing] = useState(false)
    const [creating, setCreating] = useState(false)
    const [confirmed, setConfirmed] = useState(false)
    const [createdUrl, setCreatedUrl] = useState<string | null>(null)
    const [createdExpireAt, setCreatedExpireAt] = useState<number | null>(null)
    const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')
    const [flowError, setFlowError] = useState<string | null>(null)
    const [liveMessage, setLiveMessage] = useState('')
    const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)
    const [revokingId, setRevokingId] = useState<string | null>(null)
    const [panelFeedback, setPanelFeedback] = useState<PanelFeedback | null>(null)
    const mountedRef = useRef(true)
    const listRequestRef = useRef(0)
    const previewRequestRef = useRef(0)
    const manualCopyRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        // React StrictMode 会执行一次 setup → cleanup → setup；每次 setup 都必须复位。
        mountedRef.current = true
        return () => {
            mountedRef.current = false
        }
    }, [])

    const loadShares = useCallback(async () => {
        const requestId = ++listRequestRef.current
        setListLoading(true)
        setListError(false)
        setPanelFeedback(null)
        try {
            const response = await api.share.list()
            if (!mountedRef.current || requestId !== listRequestRef.current) return
            setShares(response.shares)
        } catch {
            if (!mountedRef.current || requestId !== listRequestRef.current) return
            setListError(true)
        } finally {
            if (mountedRef.current && requestId === listRequestRef.current) setListLoading(false)
        }
    }, [])

    useEffect(() => {
        void loadShares()
    }, [loadShares])

    const resetFlow = useCallback(() => {
        // Any late preview response belongs to the flow being discarded and
        // must never populate a newly selected report's confirmation dialog.
        previewRequestRef.current += 1
        setFlowOpen(false)
        setExpireDays(7)
        setPreviewResponse(null)
        setPreviewing(false)
        setCreating(false)
        setConfirmed(false)
        setCreatedUrl(null)
        setCreatedExpireAt(null)
        setCopyStatus('idle')
        setFlowError(null)
        setLiveMessage('')
    }, [])

    // 切换报告时清空尚可重建的预览。创建请求开始后则必须保留流程：服务端
    // 可能已经生成只返回一次的 bearer，丢弃响应会让教师永久失去该链接。
    const currentReportId = currentReport?.id ?? null
    const previousReportIdRef = useRef(currentReportId)
    useEffect(() => {
        if (previousReportIdRef.current !== currentReportId) {
            previousReportIdRef.current = currentReportId
            if (creating || createdUrl) {
                setLiveMessage('报告已切换；当前弹窗仍保留上一份报告正在创建或仅显示一次的链接，请先保存并关闭。')
                return
            }
            resetFlow()
        }
    }, [createdUrl, creating, currentReportId, resetFlow])

    useEffect(() => {
        if (!createdUrl && !creating) return
        const warnBeforeUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault()
            event.returnValue = ''
        }
        window.addEventListener('beforeunload', warnBeforeUnload)
        return () => window.removeEventListener('beforeunload', warnBeforeUnload)
    }, [createdUrl, creating])

    const canShare = Boolean(
        currentReport
        && currentReport.status === 'completed'
        && currentReport.output,
    )

    const openFlow = () => {
        if (!canShare) return
        setExpireDays(7)
        setPreviewResponse(null)
        setConfirmed(false)
        setCreatedUrl(null)
        setCreatedExpireAt(null)
        setCopyStatus('idle')
        setFlowError(null)
        setLiveMessage('')
        setFlowOpen(true)
    }

    const requestClose = () => {
        if (creating) {
            setLiveMessage('链接正在创建，请等待结果，避免丢失仅显示一次的地址。')
            return
        }
        if (createdUrl) {
            setLiveMessage('该链接只显示这一次。请先复制或手动保存，再使用“我已保存，关闭”。')
            return
        }
        resetFlow()
    }

    const handlePreview = async () => {
        if (!currentReport || !canShare || previewing) return
        const requestId = ++previewRequestRef.current
        setPreviewing(true)
        setFlowError(null)
        setConfirmed(false)
        setPreviewResponse(null)
        setLiveMessage('正在生成服务端脱敏预览。')
        try {
            const response = await api.share.preview({
                reportId: currentReport.id,
            })
            if (!mountedRef.current || requestId !== previewRequestRef.current) return
            setPreviewResponse(response)
            setLiveMessage('脱敏预览已生成，请人工逐项核对。')
        } catch {
            if (!mountedRef.current || requestId !== previewRequestRef.current) return
            setFlowError('脱敏预览失败，未创建任何分享链接。请稍后重试。')
            setLiveMessage('脱敏预览失败，已失败关闭。')
        } finally {
            if (mountedRef.current && requestId === previewRequestRef.current) setPreviewing(false)
        }
    }

    const handleCreate = async () => {
        const validExpireDays = Number.isInteger(expireDays) && expireDays >= 1 && expireDays <= 90
        if (!currentReport || !previewResponse || !confirmed || creating || !validExpireDays) return
        setCreating(true)
        setFlowError(null)
        setLiveMessage('正在重新脱敏并创建一次性链接。')
        try {
            const response = await api.share.create({
                reportId: currentReport.id,
                expireDays,
                previewFingerprint: previewResponse.previewFingerprint,
            })
            if (!mountedRef.current) return
            const url = buildPublicShareUrl(response.shared.token, window.location.origin)
            setCreatedUrl(url)
            setCreatedExpireAt(response.shared.expireAt)
            setCopyStatus('idle')
            setLiveMessage('一次性分享链接已创建。关闭后系统不会再次显示该链接。')
            void loadShares()
        } catch (error: unknown) {
            if (!mountedRef.current) return
            if (error instanceof ApiError && error.status === 409) {
                setPreviewResponse(null)
                setConfirmed(false)
                setFlowError('报告或脱敏结果已变化，请重新生成预览并确认。')
            } else {
                setFlowError('分享链接创建失败，未产生可用链接。请稍后重试。')
            }
            setLiveMessage('分享链接创建失败。')
        } finally {
            if (mountedRef.current) setCreating(false)
        }
    }

    const handleCopy = async () => {
        if (!createdUrl) return
        try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable')
            await navigator.clipboard.writeText(createdUrl)
            if (!mountedRef.current) return
            setCopyStatus('copied')
            setLiveMessage('链接已安全复制到剪贴板。')
        } catch {
            if (!mountedRef.current) return
            // 该只读字段在复制按钮点击前已存在，故可在失败分支同步建立焦点与
            // 选区；不能只等 requestAnimationFrame，否则可见提示会先提交，
            // 键盘用户与自动化检查会短暂落在仍聚焦的复制按钮上。
            manualCopyRef.current?.focus({ preventScroll: true })
            manualCopyRef.current?.select()
            setCopyStatus('manual')
            setLiveMessage('浏览器未允许写入剪贴板，请手动复制已选中的链接。')
            window.requestAnimationFrame(() => {
                manualCopyRef.current?.focus({ preventScroll: true })
                manualCopyRef.current?.select()
            })
        }
    }

    const handleRevoke = async (shareId: string) => {
        if (revokingId) return
        setRevokingId(shareId)
        setPanelFeedback(null)
        setLiveMessage('正在撤销分享链接。')
        try {
            await api.share.revoke(shareId)
            if (!mountedRef.current) return
            setShares((items) => items.filter((item) => item.shareId !== shareId))
            setConfirmRevokeId(null)
            setLiveMessage('分享已撤销，原链接立即失效（仅阻断后续访问）；已经打开或保存的副本无法远程收回。')
            setPanelFeedback({
                kind: 'success',
                text: '分享已撤销，原链接立即失效（仅阻断后续访问）；已经打开或保存的副本无法远程收回。',
            })
        } catch {
            if (!mountedRef.current) return
            setLiveMessage('撤销失败，原链接状态未改变。请重试。')
            setPanelFeedback({ kind: 'error', text: '撤销失败，原链接状态未改变。请重试。' })
        } finally {
            if (mountedRef.current) setRevokingId(null)
        }
    }

    const secureOrigin = typeof window !== 'undefined'
        ? isSecurePublicShareOrigin(window.location.origin)
        : false
    const expireDaysValid = Number.isInteger(expireDays) && expireDays >= 1 && expireDays <= 90

    return (
        <>
            <Card className="pr-rpt-share-panel" padding="md" data-testid="report-share-panel">
                <div className="pr-rpt-share-panel__head">
                    <span className="pr-rpt-share-panel__icon" aria-hidden="true">
                        <Icon name="share-network" size={17} />
                    </span>
                    <div>
                        <h3>隐私分享</h3>
                        <p>先预览脱敏副本，再创建限时链接</p>
                    </div>
                </div>

                <div className="pr-rpt-share-panel__guardrail">
                    <Icon name="shield-check" size={16} />
                    <span>链接只在创建成功后显示一次；列表不保存 bearer token。</span>
                </div>

                <Button
                    variant="primary"
                    size="md"
                    block
                    leftIcon={<Icon name="share-network" size={16} />}
                    onClick={openFlow}
                    disabled={!canShare}
                    aria-describedby={!canShare ? 'report-share-disabled-reason' : undefined}
                    data-testid="report-share-open"
                >
                    预览并创建分享
                </Button>
                {!canShare && (
                    <p id="report-share-disabled-reason" className="pr-rpt-share-panel__disabled">
                        请先在中间预览区打开一份已完成报告。
                    </p>
                )}

                <div className="pr-rpt-share-panel__list-head">
                    <h4>有效分享</h4>
                    <Button
                        variant="ghost"
                        size="md"
                        iconOnly
                        aria-label="刷新分享列表"
                        onClick={() => void loadShares()}
                        disabled={listLoading}
                    >
                        <Icon name="arrows-clockwise" size={16} />
                    </Button>
                </div>

                {listLoading && (
                    <div className="pr-rpt-share-panel__state" role="status" aria-live="polite">
                        <Icon name="circle-notch" size={18} className="pr-app-spin" />
                        <span>正在读取分享摘要…</span>
                    </div>
                )}
                {!listLoading && listError && (
                    <div className="pr-rpt-share-panel__state pr-rpt-share-panel__state--error" role="alert">
                        <Icon name="warning-circle" size={18} />
                        <span>分享摘要加载失败。</span>
                        <Button variant="ghost" size="md" onClick={() => void loadShares()}>重试</Button>
                    </div>
                )}
                {!listLoading && !listError && shares.length === 0 && (
                    <div className="pr-rpt-share-panel__empty">
                        <Icon name="shield-check" size={20} />
                        <span>暂无有效分享</span>
                    </div>
                )}
                {!listLoading && !listError && shares.length > 0 && (
                    <ul className="pr-rpt-share-list" aria-label="有效分享摘要">
                        {shares.map((share) => (
                            <li key={share.shareId} className="pr-rpt-share-list__item" data-testid="report-share-summary">
                                <div className="pr-rpt-share-list__title">
                                    <strong>{share.title}</strong>
                                    <span>{share.className}</span>
                                </div>
                                <dl className="pr-rpt-share-list__meta">
                                    <div><dt>到期</dt><dd>{DATE_FORMAT.format(share.expireAt)}</dd></div>
                                    <div><dt>访问</dt><dd>{share.viewCount} 次</dd></div>
                                    <div>
                                        <dt>最近</dt>
                                        <dd>{share.lastViewedAt ? DATE_TIME_FORMAT.format(share.lastViewedAt) : '尚未访问'}</dd>
                                    </div>
                                </dl>
                                <div className="pr-rpt-share-list__actions">
                                    {confirmRevokeId === share.shareId ? (
                                        <>
                                            <Button
                                                variant="danger"
                                                size="md"
                                                loading={revokingId === share.shareId}
                                                loadingLabel="撤销中"
                                                onClick={() => void handleRevoke(share.shareId)}
                                                data-testid="report-share-revoke-confirm"
                                            >
                                                确认撤销
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="md"
                                                disabled={Boolean(revokingId)}
                                                onClick={() => setConfirmRevokeId(null)}
                                            >
                                                取消
                                            </Button>
                                        </>
                                    ) : (
                                        <Button
                                            variant="ghost"
                                            size="md"
                                            leftIcon={<Icon name="trash" size={15} />}
                                            onClick={() => setConfirmRevokeId(share.shareId)}
                                            aria-label={`撤销分享「${share.title}」`}
                                            data-testid="report-share-revoke"
                                        >
                                            撤销
                                        </Button>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
                {panelFeedback && (
                    <p
                        className={`pr-rpt-share-panel__feedback pr-rpt-share-panel__feedback--${panelFeedback.kind}`}
                        role={panelFeedback.kind === 'error' ? 'alert' : 'status'}
                        data-testid="report-share-feedback"
                    >
                        {panelFeedback.text}
                    </p>
                )}
            </Card>

            <p className="pr-sr-only" role="status" aria-live="polite" aria-atomic="true">
                {liveMessage}
            </p>

            <Modal
                open={flowOpen}
                onClose={requestClose}
                size="lg"
                title={createdUrl ? '一次性分享链接' : '公开分享隐私确认'}
                closable={!createdUrl && !creating}
                maskClosable={!createdUrl && !creating}
                className="pr-rpt-share-modal"
                bodyClassName="pr-rpt-share-modal__body"
            >
                {createdUrl ? (
                    <section className="pr-rpt-share-created" aria-labelledby="report-share-created-title">
                        <span className="pr-rpt-share-created__seal" aria-hidden="true">
                            <Icon name="check-circle" size={28} />
                        </span>
                        <div>
                            <span className="pr-rpt-share-modal__eyebrow">仅显示这一次</span>
                            <h3 id="report-share-created-title">链接已创建，请立即保存</h3>
                            <p>
                                {previewResponse
                                    ? `本链接对应《${previewResponse.preview.title}》（${previewResponse.preview.className}）。`
                                    : ''}
                                关闭本弹窗后，系统只保留无 token 的管理摘要，无法为你找回这条链接。
                            </p>
                        </div>

                        {!secureOrigin && (
                            <div className="pr-rpt-share-modal__warning" role="alert">
                                <Icon name="warning-circle" size={18} />
                                <span>当前不是 HTTPS 或本机演示环境，请勿对外发送。正式公网部署必须启用 TLS。</span>
                            </div>
                        )}

                        <label className="pr-rpt-share-created__field" htmlFor="created-share-url">
                            <span>分享地址</span>
                            <input
                                ref={manualCopyRef}
                                id="created-share-url"
                                type="text"
                                value={createdUrl}
                                readOnly
                                autoComplete="off"
                                spellCheck={false}
                                onFocus={(event) => event.currentTarget.select()}
                                data-testid="report-share-created-url"
                            />
                        </label>
                        <p className="pr-rpt-share-created__expiry">
                            <Icon name="clock" size={15} />
                            {createdExpireAt ? `有效至 ${DATE_TIME_FORMAT.format(createdExpireAt)}` : '限时链接'}
                        </p>
                        <div className="pr-rpt-share-created__actions">
                            <Button
                                variant="primary"
                                size="md"
                                leftIcon={<Icon name="copy" size={16} />}
                                onClick={() => void handleCopy()}
                                data-testid="report-share-copy"
                            >
                                {copyStatus === 'copied' ? '已复制' : '复制链接'}
                            </Button>
                            <a
                                className="pr-rpt-share-created__open"
                                href={createdUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                referrerPolicy="no-referrer"
                            >
                                <Icon name="arrow-square-out" size={16} />
                                新窗口校验
                            </a>
                        </div>
                        {copyStatus === 'manual' && (
                            <p className="pr-rpt-share-created__manual" role="alert">
                                剪贴板权限不可用。链接已全选：电脑请按 Ctrl+C（macOS 为 Command+C），手机请长按后选择“复制”。
                            </p>
                        )}
                        <Button
                            variant="secondary"
                            size="md"
                            block
                            onClick={resetFlow}
                            data-testid="report-share-saved-close"
                        >
                            我已保存，关闭
                        </Button>
                    </section>
                ) : (
                    <section className="pr-rpt-share-flow">
                        {!secureOrigin && (
                            <div className="pr-rpt-share-modal__warning" role="alert">
                                <Icon name="warning-circle" size={18} />
                                <span>当前不是 HTTPS 或本机演示环境。正式公网分享必须先配置可信 TLS，再创建并发送链接。</span>
                            </div>
                        )}
                        <div className="pr-rpt-share-modal__notice">
                            <Icon name="shield-check" size={20} />
                            <div>
                                <strong>分享的是当下报告的独立脱敏快照</strong>
                                <ul>
                                    <li>系统会删除命中班级花名册、学号、联系方式与个体诊断的整行。</li>
                                    <li>链接持有者无需登录即可阅读，请只发送给预期对象。</li>
                                    <li>链接到期或手动撤销后失效；公开页禁止缓存、索引与 Referrer 外发。</li>
                                    <li>撤销只阻断后续访问；已打开、打印、截图或保存的副本无法远程收回。</li>
                                </ul>
                            </div>
                        </div>

                        <div className="pr-rpt-share-modal__controls">
                            <label htmlFor="report-share-expire-days">链接有效期</label>
                            <input
                                id="report-share-expire-days"
                                type="number"
                                min={1}
                                max={90}
                                step={1}
                                inputMode="numeric"
                                value={expireDays}
                                onChange={(event) => {
                                    setExpireDays(Number(event.target.value))
                                    setConfirmed(false)
                                }}
                                aria-invalid={!expireDaysValid}
                                aria-describedby="report-share-expire-help"
                                data-testid="report-share-expire-days"
                            />
                            <span id="report-share-expire-help">
                                {expireDaysValid
                                    ? '可输入 1–90 天；建议仅保留完成评审所需时间。'
                                    : '请输入 1 到 90 之间的整数天数。'}
                            </span>
                        </div>

                        <div className="pr-rpt-share-modal__preview-head">
                            <div>
                                <span className="pr-rpt-share-modal__eyebrow">人工复核关口</span>
                                <h3>脱敏后公开版预览</h3>
                            </div>
                            <Button
                                variant={previewResponse ? 'secondary' : 'primary'}
                                size="md"
                                loading={previewing}
                                loadingLabel="脱敏中"
                                leftIcon={<Icon name="eye" size={16} />}
                                onClick={() => void handlePreview()}
                                data-testid="report-share-preview"
                            >
                                {previewResponse ? '重新预览' : '生成脱敏预览'}
                            </Button>
                        </div>

                        {flowError && (
                            <div className="pr-rpt-share-modal__error" role="alert">
                                <Icon name="warning-circle" size={18} />
                                <span>{flowError}</span>
                            </div>
                        )}

                        {previewResponse ? (
                            <>
                                <div className="pr-rpt-share-modal__preview-meta">
                                    <strong>{previewResponse.preview.title}</strong>
                                    <span>{previewResponse.preview.className}</span>
                                </div>
                                <SandboxedReportFrame
                                    preview={previewResponse.preview}
                                    title={`脱敏预览：${previewResponse.preview.title}`}
                                    testId="report-share-preview-frame"
                                />
                                <label className="pr-rpt-share-modal__confirm">
                                    <input
                                        type="checkbox"
                                        checked={confirmed}
                                        onChange={(event) => setConfirmed(event.target.checked)}
                                        data-testid="report-share-confirm"
                                    />
                                    <span>
                                        <strong>我已人工检查上方完整公开版。</strong>
                                        确认不含学生、家长、教师私密信息，且对外分享目的与 {expireDays} 天有效期合适。
                                    </span>
                                </label>
                                <Button
                                    variant="primary"
                                    size="md"
                                    block
                                    loading={creating}
                                    loadingLabel="创建中"
                                    disabled={!confirmed || !expireDaysValid}
                                    leftIcon={<Icon name="share-network" size={16} />}
                                    onClick={() => void handleCreate()}
                                    data-testid="report-share-create"
                                >
                                    确认并创建一次性链接
                                </Button>
                            </>
                        ) : (
                            <div className="pr-rpt-share-modal__preview-empty" role="status">
                                <Icon name="eye" size={24} />
                                <span>预览成功前不会创建链接或写入分享记录。</span>
                            </div>
                        )}
                    </section>
                )}
            </Modal>
        </>
    )
}
