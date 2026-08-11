import { describe, expect, it } from 'vitest'

import { assertTeachingContentMatchesPoem, type TeachingContentOutput } from './teaching-content-output.js'

const rawLines = ['床前明月光', '疑是地上霜']

function validOutput(): TeachingContentOutput {
    return {
        lines: [
            { lineIndex: 0, pinyin: ['chuáng', 'qián', 'míng', 'yuè', 'guāng'], translation: '月光照在床前。' },
            { lineIndex: 1, pinyin: ['yí', 'shì', 'dì', 'shàng', 'shuāng'], translation: '好像地上有一层白霜。' },
        ],
        characters: [
            { char: '疑', pinyin: 'yí', meaning: '好像', partOfSpeech: '动', usage: '疑是' },
            { char: '霜', pinyin: 'shuāng', meaning: '水汽凝结的白色冰晶', partOfSpeech: '名', usage: '地上霜' },
        ],
        overallTranslation: '诗人把月光看成白霜，表达了夜晚思念家乡的心情。',
        rhetoricAnalysis: [{ type: '比喻', example: '疑是地上霜', effect: '把月光写得像白霜一样明亮。' }],
    }
}

describe('teaching content output binding', () => {
    it('accepts complete content that can be traced to every source line', () => {
        expect(() => assertTeachingContentMatchesPoem(validOutput(), rawLines)).not.toThrow()
    })

    it.each([
        ['missing source line', () => ({ ...validOutput(), lines: validOutput().lines.slice(0, 1) })],
        ['duplicate line index', () => ({ ...validOutput(), lines: [validOutput().lines[0]!, { ...validOutput().lines[1]!, lineIndex: 0 }] })],
        ['wrong pinyin cardinality', () => ({ ...validOutput(), lines: [{ ...validOutput().lines[0]!, pinyin: ['chuáng'] }, validOutput().lines[1]!] })],
        ['hallucinated character', () => ({ ...validOutput(), characters: [{ ...validOutput().characters[0]!, char: '海' }, validOutput().characters[1]!] })],
        ['non-source rhetoric example', () => ({ ...validOutput(), rhetoricAnalysis: [{ type: '比喻', example: '海上生明月', effect: '不应被接受' }] })],
    ])('rejects %s before it can be cached', (_label, mutate) => {
        expect(() => assertTeachingContentMatchesPoem(mutate(), rawLines)).toThrow()
    })
})
