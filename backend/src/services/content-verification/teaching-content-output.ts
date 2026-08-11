import { countHanChars } from '../../lib/poem-lines.js'

interface TeachingLineOutput {
    lineIndex: number
    pinyin: string[]
    translation: string
}

interface TeachingCharacterOutput {
    char: string
    pinyin: string
    meaning: string
    partOfSpeech: string
    usage: string
}

interface TeachingRhetoricOutput {
    type: string
    example: string
    effect: string
}

export interface TeachingContentOutput {
    lines: TeachingLineOutput[]
    characters: TeachingCharacterOutput[]
    overallTranslation: string
    rhetoricAnalysis?: TeachingRhetoricOutput[]
}

function hasMeaningfulText(value: string, maxLength: number): boolean {
    return value.trim().length > 0 && value.length <= maxLength
}

function normalizePoemFragment(value: string): string {
    return value.replace(/[\s，。、“”‘’；：！？,.!?'";:()[\]{}]/gu, '')
}

/**
 * The LLM schema verifies JSON shape. This additional gate verifies that the
 * output still belongs to the exact poem that was sent to the model. It stops
 * a syntactically valid but hallucinated/partial response from becoming a
 * long-lived cache entry in elementary teaching flows.
 */
export function assertTeachingContentMatchesPoem(
    output: TeachingContentOutput,
    rawLines: readonly string[],
): void {
    if (output.lines.length !== rawLines.length) {
        throw new Error(`教学内容行数 ${output.lines.length} 与原文行数 ${rawLines.length} 不一致`)
    }
    const seenLineIndices = new Set<number>()
    for (const line of output.lines) {
        if (!Number.isInteger(line.lineIndex) || line.lineIndex < 0 || line.lineIndex >= rawLines.length) {
            throw new Error(`教学内容包含越界行号 ${line.lineIndex}`)
        }
        if (seenLineIndices.has(line.lineIndex)) {
            throw new Error(`教学内容重复行号 ${line.lineIndex}`)
        }
        seenLineIndices.add(line.lineIndex)
        const sourceLine = rawLines[line.lineIndex]
        if (!sourceLine) throw new Error(`教学内容无法定位原文行 ${line.lineIndex}`)
        const expectedPinyinCount = countHanChars(sourceLine)
        if (line.pinyin.length !== expectedPinyinCount) {
            throw new Error(`第 ${line.lineIndex + 1} 行拼音数 ${line.pinyin.length} 与汉字数 ${expectedPinyinCount} 不一致`)
        }
        if (line.pinyin.some((item) => !hasMeaningfulText(item, 24) || /\s/u.test(item))) {
            throw new Error(`第 ${line.lineIndex + 1} 行存在空白或异常长度的拼音`)
        }
        if (!hasMeaningfulText(line.translation, 500)) {
            throw new Error(`第 ${line.lineIndex + 1} 行译文为空或过长`)
        }
    }
    if (seenLineIndices.size !== rawLines.length) {
        throw new Error('教学内容未覆盖全部原文行')
    }

    if (output.characters.length === 0 || output.characters.length > 12) {
        throw new Error(`生字条目数必须在 1–12 之间，当前为 ${output.characters.length}`)
    }
    const poemCharacters = new Set([...rawLines.join('')].filter((character) => /\p{Script=Han}/u.test(character)))
    const seenCharacters = new Set<string>()
    for (const item of output.characters) {
        if (!/^\p{Script=Han}$/u.test(item.char)) {
            throw new Error(`生字“${item.char}”不是单个汉字`)
        }
        if (!poemCharacters.has(item.char)) {
            throw new Error(`生字“${item.char}”不属于当前诗文`)
        }
        if (seenCharacters.has(item.char)) {
            throw new Error(`生字“${item.char}”重复`)
        }
        seenCharacters.add(item.char)
        if (!hasMeaningfulText(item.pinyin, 24) || /\s/u.test(item.pinyin)
            || !hasMeaningfulText(item.meaning, 240)
            || !hasMeaningfulText(item.partOfSpeech, 24)
            || !hasMeaningfulText(item.usage, 240)) {
            throw new Error(`生字“${item.char}”的教学字段为空或超长`)
        }
    }

    if (!hasMeaningfulText(output.overallTranslation, 800)) {
        throw new Error('全诗大意为空或过长')
    }
    const normalizedPoem = normalizePoemFragment(rawLines.join(''))
    for (const rhetoric of output.rhetoricAnalysis ?? []) {
        const normalizedExample = normalizePoemFragment(rhetoric.example)
        if (!hasMeaningfulText(rhetoric.type, 80)
            || normalizedExample === ''
            || !normalizedPoem.includes(normalizedExample)
            || !hasMeaningfulText(rhetoric.effect, 400)) {
            throw new Error('修辞分析必须含有当前原文中的非空例句、类型与效果')
        }
    }
}
