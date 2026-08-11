import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    config: {
        isRender: true,
        deepseek: { apiKey: 'deepseek-original' },
        mimo: { apiKey: 'mimo-original' },
        wanImage: { apiKey: 'dashscope-original' },
    },
    normalizeCredentialKey: vi.fn((value: string) => value.trim()),
    persistCredentialAtomically: vi.fn(),
}))

vi.mock('../config.js', () => ({ config: mocks.config }))
vi.mock('../security/credential-file.js', () => ({
    normalizeCredentialKey: mocks.normalizeCredentialKey,
    persistCredentialAtomically: mocks.persistCredentialAtomically,
}))

import { getKey, setKey } from './credentials.js'

describe('Render credential mutation defense in depth', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it.each([true, false])('拒绝 setKey（persist=%s），且不改运行态或磁盘', (persist) => {
        expect(() => setKey('deepseek', 'deepseek-replacement', persist))
            .toThrow(/SETTINGS_MANAGED_EXTERNALLY/)

        expect(mocks.normalizeCredentialKey).not.toHaveBeenCalled()
        expect(mocks.persistCredentialAtomically).not.toHaveBeenCalled()
        expect(getKey('deepseek')).toBe('deepseek-original')
    })
})
