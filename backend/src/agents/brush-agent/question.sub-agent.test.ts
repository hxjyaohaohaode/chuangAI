import { describe, expect, it } from 'vitest'
import { QuestionSubAgent, type QuestionOutput } from './question.sub-agent.js'

function validOutput(): QuestionOutput {
    return {
        questions: [{
            id: 'question-001',
            poemId: 'poem-jingyesi',
            bloomLevel: '理解',
            type: '选择',
            stem: '“低头思故乡”表达了什么感情？',
            options: ['思乡', '喜悦', '愤怒', '惊讶'],
            answer: '思乡',
            analysis: '“思故乡”直接点明思乡之情。',
            distractorsAnalysis: ['忽略关键词', '误判语气', '脱离诗境'],
            difficulty: 2,
            estimatedTimeSec: 60,
            aiGenerated: true,
        }],
        coverage: {
            记忆: 20,
            理解: 20,
            应用: 20,
            分析: 20,
            评价: 10,
            创造: 10,
        },
    }
}

function validate(raw: string): QuestionOutput {
    const agent = new QuestionSubAgent() as unknown as {
        validateOutput(value: string): QuestionOutput
    }
    return agent.validateOutput(raw)
}

describe('QuestionSubAgent output boundary', () => {
    it('accepts a strict, bounded question and exact six-tier coverage', () => {
        const output = validOutput()
        output.questions[0]!.options = Array.from({ length: 8 }, (_, index) => `选项${index + 1}`)
        output.questions[0]!.distractorsAnalysis = Array.from(
            { length: 8 },
            (_, index) => `干扰项分析${index + 1}`,
        )
        output.questions[0]!.estimatedTimeSec = 5

        expect(validate(JSON.stringify(output))).toEqual(output)
    })

    it.each([
        ['nine options', (output: QuestionOutput) => {
            output.questions[0]!.options = Array.from({ length: 9 }, (_, index) => `选项${index}`)
        }],
        ['nine distractor analyses', (output: QuestionOutput) => {
            output.questions[0]!.distractorsAnalysis = Array.from({ length: 9 }, (_, index) => `分析${index}`)
        }],
        ['too-short estimated time', (output: QuestionOutput) => {
            output.questions[0]!.estimatedTimeSec = 4
        }],
        ['too-long estimated time', (output: QuestionOutput) => {
            output.questions[0]!.estimatedTimeSec = 3601
        }],
        ['blank stem', (output: QuestionOutput) => {
            output.questions[0]!.stem = '   '
        }],
        ['coverage sum drift', (output: QuestionOutput) => {
            output.coverage.创造 = 9
        }],
    ])('rejects malformed model output: %s', (_label, mutate) => {
        const output = validOutput()
        mutate(output)
        expect(() => validate(JSON.stringify(output))).toThrow(/六阶命题输出校验失败/)
    })

    it('rejects non-finite coverage and unknown fields instead of silently stripping them', () => {
        const nonFinite = JSON.stringify(validOutput()).replace('"记忆":20', '"记忆":1e400')
        expect(() => validate(nonFinite)).toThrow(/六阶命题输出校验失败/)

        const extraQuestion = validOutput() as QuestionOutput & {
            questions: Array<QuestionOutput['questions'][number] & { hidden?: string }>
        }
        extraQuestion.questions[0]!.hidden = 'must-not-be-silently-accepted'
        expect(() => validate(JSON.stringify(extraQuestion))).toThrow(/六阶命题输出校验失败/)

        const extraRoot = { ...validOutput(), hidden: true }
        expect(() => validate(JSON.stringify(extraRoot))).toThrow(/六阶命题输出校验失败/)
    })

    it('requires at least one question', () => {
        const output = validOutput()
        output.questions = []
        expect(() => validate(JSON.stringify(output))).toThrow(/六阶命题输出校验失败/)
    })
})
