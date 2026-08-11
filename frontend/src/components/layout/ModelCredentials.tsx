/**
 * 模型接入配置 —— 设置面板中的「模型密钥」分区
 *
 * 本地部署中，教师可以在这里换成自己的 API Key；Render 部署中，密钥只由
 * Dashboard Environment 管理，前端保持只读且不渲染任何明文输入入口。
 *
 * ─────────────────────────────────────────────────────────────
 * 安全设计
 * ─────────────────────────────────────────────────────────────
 * - 密钥**明文只在一个方向流动**：输入框 → 后端。任何 GET 响应都只带掩码
 *   （`sk-****3f2a`），前端从不持有完整密钥，也不写入 localStorage；
 * - 输入框在未聚焦时展示掩码占位，聚焦后清空等待重新输入 ——
 *   避免教师误以为掩码就是真实值而去编辑它；
 * - 「测试连通」由后端发起（前端不直接连供应商），既避免跨域，
 *   也避免密钥出现在浏览器的网络面板里。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么把错误原因原样透出
 * ─────────────────────────────────────────────────────────────
 * 「密钥无效」「账户欠费」「触发限流」对教师是三种完全不同的处置动作。
 * 笼统显示「连接失败」等于把排查成本转嫁给用户，因此这里保留后端解析出的
 * 结论文案 + 供应商原始 detail（折叠展示）。
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/ui/Icon'
import { toast } from '@/stores/toast'
import { ApiError, getDisplayError } from '@/lib/errors'
import { api } from '@/lib/api'
import type {
    ModelCredentialManagement,
    ModelCredentialStatus,
    CredentialTestResult,
} from '@/lib/types'

/** 单个供应商的本地编辑态 */
interface DraftState {
    /** 输入框当前值（空串代表未改动） */
    value: string
    saving: boolean
    testing: boolean
    result: CredentialTestResult | null
}

const EMPTY_DRAFT: DraftState = { value: '', saving: false, testing: false, result: null }

const RENDER_MANAGEMENT: ModelCredentialManagement = {
    mutable: false,
    managedBy: 'render-dashboard',
}

/**
 * 只有后端明确声明“本地环境可变”时才允许浏览器提交密钥。
 * 缺字段、未知组合与请求失败都按只读处理，避免部署契约漂移时意外暴露写入口。
 */
export function canEditModelCredentials(
    management: ModelCredentialManagement | null | undefined,
): boolean {
    return management?.mutable === true && management.managedBy === 'local-env'
}

/** 保存端点的 409 在该专用契约中表示部署平台已经接管密钥。 */
export function isExternallyManagedCredentialError(error: unknown): boolean {
    return error instanceof ApiError && error.status === 409
}

interface CredentialManagementNoticeProps {
    management: ModelCredentialManagement | null | undefined
}

/** 导出纯展示组件，便于在 Node 环境稳定验证只读文案，不依赖脆弱的 DOM 模拟。 */
export function CredentialManagementNotice({ management }: CredentialManagementNoticeProps) {
    if (canEditModelCredentials(management)) return null

    const renderManaged = management?.mutable === false
        && management.managedBy === 'render-dashboard'

    return (
        <section className="pr-cred-item" role="note" aria-label="模型密钥管理位置">
            <header className="pr-cred-item-head">
                <span className="pr-cred-item-name">
                    {renderManaged ? '模型密钥由 Render Environment 托管' : '模型密钥暂时只读'}
                </span>
                <span className="pr-cred-item-state is-set">只读</span>
            </header>
            <p className="pr-cred-item-powers">
                {renderManaged
                    ? '请前往 Render Dashboard → 对应服务 → Environment 修改密钥；本页面不会接收或保存密钥明文。'
                    : '服务端未明确授权浏览器修改密钥。请刷新后重试，或联系部署管理员检查配置。'}
            </p>
            {renderManaged && (
                <a
                    className="pr-cred-item-console"
                    href="https://dashboard.render.com/"
                    target="_blank"
                    rel="noreferrer noopener"
                >
                    <span>打开 Render Dashboard</span>
                    <Icon name="arrow-square-out" size={11} />
                </a>
            )}
        </section>
    )
}

interface CredentialProviderCardProps {
    provider: ModelCredentialStatus
    draft: DraftState
    mutable: boolean
    onDraftChange: (value: string) => void
    onSave: () => void
    onTest: () => void
}

/** 单个供应商卡片；只读态在结构层面完全不渲染密钥输入与保存动作。 */
export function CredentialProviderCard({
    provider: p,
    draft,
    mutable,
    onDraftChange,
    onSave,
    onTest,
}: CredentialProviderCardProps) {
    return (
        <section className="pr-cred-item">
            <header className="pr-cred-item-head">
                <span className="pr-cred-item-name">{p.label}</span>
                <span
                    className={`pr-cred-item-state${p.configured ? ' is-set' : ''}`}
                    title={p.configured ? `已配置：${p.masked}` : '尚未配置'}
                >
                    {p.configured ? p.masked : '未配置'}
                </span>
            </header>
            <p className="pr-cred-item-powers">{p.powers}</p>

            <div className="pr-cred-item-form">
                {mutable && (
                    <>
                        <input
                            type="password"
                            className="pr-cred-input"
                            value={draft.value}
                            placeholder={p.configured ? '输入新密钥以替换' : '粘贴 API Key'}
                            onChange={(event) => onDraftChange(event.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            aria-label={`${p.label} API Key`}
                        />
                        <button
                            type="button"
                            className="pr-cred-btn pr-cred-btn--save"
                            onClick={onSave}
                            disabled={draft.saving || !draft.value.trim()}
                        >
                            {draft.saving ? '保存中…' : '保存'}
                        </button>
                    </>
                )}
                <button
                    type="button"
                    className="pr-cred-btn"
                    onClick={onTest}
                    disabled={draft.testing || !p.configured}
                    title={p.configured ? '用当前生效的密钥发一次最小请求' : '请先配置密钥'}
                >
                    {draft.testing ? '检测中…' : '测试连通'}
                </button>
            </div>

            {draft.result && (
                <div
                    className={`pr-cred-result${draft.result.ok ? ' is-ok' : ' is-fail'}`}
                    role="status"
                >
                    <Icon name={draft.result.ok ? 'check-circle' : 'warning-circle'} size={12} />
                    <span className="pr-cred-result-msg">{draft.result.message}</span>
                    {draft.result.latencyMs > 0 && (
                        <span className="pr-cred-result-latency">{draft.result.latencyMs}ms</span>
                    )}
                    {draft.result.detail && (
                        <details className="pr-cred-result-detail">
                            <summary>供应商原始返回</summary>
                            <code>{draft.result.detail}</code>
                        </details>
                    )}
                </div>
            )}

            <a
                className="pr-cred-item-console"
                href={p.console}
                target="_blank"
                rel="noreferrer noopener"
            >
                <span>前往控制台申请</span>
                <Icon name="arrow-square-out" size={11} />
            </a>
        </section>
    )
}

export const ModelCredentials = memo(function ModelCredentials() {
    const [providers, setProviders] = useState<ModelCredentialStatus[]>([])
    const [management, setManagement] = useState<ModelCredentialManagement | null>(null)
    const [loading, setLoading] = useState(true)
    const [drafts, setDrafts] = useState<Record<string, DraftState>>({})
    // 一旦本页面观察到 Render 托管，任何较早发出但较晚返回的 GET 都不得
    // 重新开启写入口。ref 在整页重载时自然重置，恰好对应重新取权威状态。
    const renderReadOnlyLocked = useRef(false)

    const load = useCallback(async (forceRenderReadOnly = false) => {
        setLoading(true)
        try {
            const res = await api.settings.listCredentials()
            // PUT 已经明确返回 409 后，本次页面生命周期内不接受可能陈旧的 GET
            // 将写入口重新打开；重新加载整页后再以新的服务端状态为准。
            if (forceRenderReadOnly
                || (res.management.mutable === false
                    && res.management.managedBy === 'render-dashboard')) {
                renderReadOnlyLocked.current = true
            }
            const nextManagement = renderReadOnlyLocked.current
                ? RENDER_MANAGEMENT
                : res.management
            setProviders(res.providers)
            setManagement(nextManagement)
            if (!canEditModelCredentials(nextManagement)) {
                // 服务端切到外部托管后，不让尚未提交的明文继续滞留在组件状态中。
                setDrafts({})
            }
        } catch (err) {
            // 已确认的 Render 托管结论可以保留；其余旧的可写状态一律撤销。
            setManagement((current) => (
                current?.mutable === false && current.managedBy === 'render-dashboard'
                    ? current
                    : null
            ))
            setDrafts({})
            toast.error({ title: '读取模型配置失败', message: getDisplayError(err, '请稍后重试') })
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    const draftOf = useCallback(
        (id: string): DraftState => drafts[id] ?? EMPTY_DRAFT,
        [drafts],
    )

    const patchDraft = useCallback((id: string, patch: Partial<DraftState>) => {
        setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_DRAFT), ...patch } }))
    }, [])

    const handleSave = useCallback(
        async (id: string) => {
            if (!canEditModelCredentials(management)) {
                toast.warning({
                    title: '模型密钥为只读',
                    message: management?.managedBy === 'render-dashboard'
                        ? '请前往 Render Environment 修改密钥'
                        : '服务端尚未授权浏览器修改密钥',
                })
                return
            }
            const draft = draftOf(id)
            if (!draft.value.trim()) {
                toast.warning({ title: '请先填写密钥', message: '密钥不能为空' })
                return
            }
            patchDraft(id, { saving: true })
            try {
                await api.settings.saveCredential(id, draft.value.trim())
                toast.success({ title: '密钥已保存', message: '新密钥即刻生效，无需重启服务' })
                patchDraft(id, { value: '', saving: false, result: null })
                await load()
            } catch (err) {
                if (isExternallyManagedCredentialError(err)) {
                    // 部署策略可能在页面打开后发生变化：立即失败关闭、清空明文并刷新权威状态。
                    renderReadOnlyLocked.current = true
                    setManagement(RENDER_MANAGEMENT)
                    setDrafts({})
                    toast.warning({
                        title: '密钥已由 Render 接管',
                        message: '本次未保存，请前往 Render Environment 修改',
                    })
                    await load(true)
                    return
                }
                patchDraft(id, { saving: false })
                toast.error({ title: '保存失败', message: getDisplayError(err, '请稍后重试') })
            }
        },
        [draftOf, patchDraft, load, management],
    )

    const handleTest = useCallback(
        async (id: string) => {
            patchDraft(id, { testing: true, result: null })
            try {
                const result = await api.settings.testCredential(id)
                patchDraft(id, { testing: false, result })
            } catch (err) {
                patchDraft(id, {
                    testing: false,
                    result: { ok: false, message: getDisplayError(err, '检测失败'), latencyMs: 0 },
                })
            }
        },
        [patchDraft],
    )

    if (loading) {
        return (
            <div className="pr-cred-loading" aria-busy="true">
                <Icon name="circle-notch" size={14} className="pr-app-spin" />
                <span>读取模型配置…</span>
            </div>
        )
    }

    return (
        <div className="pr-cred">
            <CredentialManagementNotice management={management} />
            {providers.map((p) => {
                const draft = draftOf(p.provider)
                return (
                    <CredentialProviderCard
                        key={p.provider}
                        provider={p}
                        draft={draft}
                        mutable={canEditModelCredentials(management)}
                        onDraftChange={(value) => patchDraft(p.provider, { value })}
                        onSave={() => void handleSave(p.provider)}
                        onTest={() => void handleTest(p.provider)}
                    />
                )
            })}
            <p className="pr-cred-note">
                {canEditModelCredentials(management)
                    ? '密钥保存在服务端并持久化到 .env，浏览器不留存明文；此处仅回显掩码。'
                    : '密钥仅由部署环境读取；本页不接收、不保存明文，仅回显服务端提供的掩码。'}
            </p>
        </div>
    )
})
