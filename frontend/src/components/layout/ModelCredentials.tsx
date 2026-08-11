/**
 * 模型接入配置 —— 设置面板中的「模型密钥」分区
 *
 * 系统所有者可以在这里换成自己的 API Key；本地部署原子写入 .env，Render
 * 部署写入持久盘上的 AES-256-GCM 加密保险柜。演示账号始终只读。
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

import { memo, useCallback, useEffect, useState } from 'react'
import { Icon } from '@/components/ui/Icon'
import { toast } from '@/stores/toast'
import { getDisplayError } from '@/lib/errors'
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

/**
 * 只有后端明确声明“本地环境可变”时才允许浏览器提交密钥。
 * 缺字段、未知组合与请求失败都按只读处理，避免部署契约漂移时意外暴露写入口。
 */
export function canEditModelCredentials(
    management: ModelCredentialManagement | null | undefined,
): boolean {
    return management?.mutable === true
        && (management.managedBy === 'local-env' || management.managedBy === 'encrypted-vault')
}

interface CredentialManagementNoticeProps {
    management: ModelCredentialManagement | null | undefined
}

/** 导出纯展示组件，便于在 Node 环境稳定验证只读文案，不依赖脆弱的 DOM 模拟。 */
export function CredentialManagementNotice({ management }: CredentialManagementNoticeProps) {
    if (canEditModelCredentials(management)) return null

    return (
        <section className="pr-cred-item" role="note" aria-label="模型密钥管理位置">
            <header className="pr-cred-item-head">
                <span className="pr-cred-item-name">
                    演示账号为只读体验
                </span>
                <span className="pr-cred-item-state is-set">只读</span>
            </header>
            <p className="pr-cred-item-powers">
                请使用系统所有者账号登录后管理模型凭据；公开演示账号不会接触密钥掩码或付费连通测试。
            </p>
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
                            type={p.inputKind === 'url' ? 'url' : 'password'}
                            className="pr-cred-input"
                            value={draft.value}
                            placeholder={p.configured
                                ? (p.inputKind === 'url' ? '输入新的 Workspace HTTPS 地址' : '输入新密钥以替换')
                                : (p.inputKind === 'url' ? '粘贴 Workspace 同步生图地址' : '粘贴 API Key')}
                            onChange={(event) => onDraftChange(event.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            aria-label={p.inputKind === 'url' ? `${p.label}` : `${p.label} API Key`}
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
                {p.inputKind !== 'url' && (
                    <button
                        type="button"
                        className="pr-cred-btn"
                        onClick={onTest}
                        disabled={draft.testing || !p.configured}
                        title={p.configured ? '用当前生效的密钥发一次最小请求' : '请先配置密钥'}
                    >
                        {draft.testing ? '检测中…' : '测试连通'}
                    </button>
                )}
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

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await api.settings.listCredentials()
            setProviders(res.providers)
            setManagement(res.management)
            if (!canEditModelCredentials(res.management)) {
                setDrafts({})
            }
        } catch (err) {
            setManagement(null)
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
                    message: '请使用系统所有者账号登录后修改模型凭据',
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
                    ? (management?.managedBy === 'encrypted-vault'
                        ? '凭据经认证加密后保存在持久盘保险柜，浏览器不留存明文；修改后立即生效。'
                        : '凭据保存在服务端并持久化到 .env，浏览器不留存明文；此处仅回显掩码。')
                    : '演示账号不能接触模型密钥；请使用系统所有者账号登录。'}
            </p>
        </div>
    )
})
