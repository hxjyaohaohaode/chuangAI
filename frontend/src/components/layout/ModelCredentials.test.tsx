import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ModelCredentialStatus } from '@/lib/types'
import {
    canEditModelCredentials,
    CredentialManagementNotice,
    CredentialProviderCard,
} from './ModelCredentials'

const PROVIDER: ModelCredentialStatus = {
    provider: 'deepseek',
    label: 'DeepSeek',
    powers: '文本推理',
    console: 'https://platform.deepseek.com/',
    configured: true,
    masked: 'sk-****abcd',
}

const EMPTY_DRAFT = {
    value: '',
    saving: false,
    testing: false,
    result: null,
}

describe('ModelCredentials encrypted-vault management guard', () => {
    it('fails closed unless the server explicitly grants local or encrypted-vault mutation', () => {
        expect(canEditModelCredentials(undefined)).toBe(false)
        expect(canEditModelCredentials(null)).toBe(false)
        expect(canEditModelCredentials({
            mutable: true,
            managedBy: 'local-env',
        })).toBe(true)
        expect(canEditModelCredentials({
            mutable: true,
            managedBy: 'encrypted-vault',
        })).toBe(true)
    })

    it('renders demo-account instructions without any API-key input or save action', () => {
        const notice = renderToStaticMarkup(
            <CredentialManagementNotice management={{
                mutable: false,
                managedBy: 'encrypted-vault',
            }} />,
        )
        const card = renderToStaticMarkup(
            <CredentialProviderCard
                provider={PROVIDER}
                draft={EMPTY_DRAFT}
                mutable={false}
                onDraftChange={vi.fn()}
                onSave={vi.fn()}
                onTest={vi.fn()}
            />,
        )

        expect(notice).toContain('演示账号为只读体验')
        expect(notice).not.toContain('dashboard.render.com')
        expect(card).not.toContain('type="password"')
        expect(card).not.toContain('API Key')
        expect(card).not.toContain('>保存<')
        expect(card).toContain('测试连通')
    })

    it('keeps the local-env editor available when mutation is explicitly allowed', () => {
        const card = renderToStaticMarkup(
            <CredentialProviderCard
                provider={PROVIDER}
                draft={EMPTY_DRAFT}
                mutable
                onDraftChange={vi.fn()}
                onSave={vi.fn()}
                onTest={vi.fn()}
            />,
        )

        expect(card).toContain('type="password"')
        expect(card).toContain('DeepSeek API Key')
        expect(card).toContain('>保存</button>')
    })

    it('renders the Wan endpoint as a URL editor without a misleading provider test action', () => {
        const card = renderToStaticMarkup(
            <CredentialProviderCard
                provider={{
                    ...PROVIDER,
                    provider: 'wanBaseUrl',
                    label: 'Wan 2.7 Workspace 地址',
                    inputKind: 'url',
                    masked: 'workspace.cn-beijing.maas.aliyuncs.com',
                }}
                draft={EMPTY_DRAFT}
                mutable
                onDraftChange={vi.fn()}
                onSave={vi.fn()}
                onTest={vi.fn()}
            />,
        )

        expect(card).toContain('type="url"')
        expect(card).toContain('Workspace HTTPS 地址')
        expect(card).not.toContain('测试连通')
    })
})
