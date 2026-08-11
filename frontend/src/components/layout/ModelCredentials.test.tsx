import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/errors'
import type { ModelCredentialStatus } from '@/lib/types'
import {
    canEditModelCredentials,
    CredentialManagementNotice,
    CredentialProviderCard,
    isExternallyManagedCredentialError,
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

describe('ModelCredentials Render management guard', () => {
    it('fails closed unless the server explicitly grants local-env mutation', () => {
        expect(canEditModelCredentials(undefined)).toBe(false)
        expect(canEditModelCredentials(null)).toBe(false)
        expect(canEditModelCredentials({
            mutable: false,
            managedBy: 'render-dashboard',
        })).toBe(false)
        expect(canEditModelCredentials({
            mutable: true,
            managedBy: 'render-dashboard',
        })).toBe(false)
        expect(canEditModelCredentials({
            mutable: true,
            managedBy: 'local-env',
        })).toBe(true)
    })

    it('renders Render instructions without any API-key input or save action', () => {
        const notice = renderToStaticMarkup(
            <CredentialManagementNotice management={{
                mutable: false,
                managedBy: 'render-dashboard',
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

        expect(notice).toContain('Render Environment')
        expect(notice).toContain('https://dashboard.render.com/')
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

    it('recognizes the authoritative 409 as externally managed and not a success', () => {
        expect(isExternallyManagedCredentialError(new ApiError(409, 'Conflict'))).toBe(true)
        expect(isExternallyManagedCredentialError(new ApiError(500, 'Server Error'))).toBe(false)
        expect(isExternallyManagedCredentialError(new Error('Conflict'))).toBe(false)
    })
})
