import { describe, expect, it } from 'vitest'
import { normalizeCredentialKey, updateCredentialEnvContent } from './credential-file.js'

describe('credential file protection', () => {
    it('接受常见 token 字符并裁剪首尾空白', () => {
        expect(normalizeCredentialKey('  sk-AbC_123.+=/~  ')).toBe('sk-AbC_123.+=/~')
        expect(normalizeCredentialKey('')).toBe('')
    })

    it.each([
        'safe\nINJECTED=value',
        'safe\rINJECTED=value',
        'contains space',
        'contains#comment',
        '中文密钥',
        '"quoted"',
    ])('拒绝可能改变 dotenv 语义的输入 %#', (value) => {
        expect(() => normalizeCredentialKey(value)).toThrow(/密钥格式无效/)
    })

    it('替换并消除重复变量，保留其他行和注释', () => {
        const source = [
            '# provider keys',
            'DEEPSEEK_API_KEY=old-first',
            'OTHER=value',
            '  DEEPSEEK_API_KEY = old-second',
        ].join('\n')
        const output = updateCredentialEnvContent(source, 'DEEPSEEK_API_KEY', 'new-key')
        expect(output).toBe([
            '# provider keys',
            'DEEPSEEK_API_KEY=new-key',
            'OTHER=value',
        ].join('\n'))
        expect(output.match(/DEEPSEEK_API_KEY/g)).toHaveLength(1)
    })

    it('变量不存在时以独立新行追加', () => {
        expect(updateCredentialEnvContent('A=1', 'MIMO_API_KEY', 'new-key'))
            .toBe('A=1\n\nMIMO_API_KEY=new-key')
    })
})
