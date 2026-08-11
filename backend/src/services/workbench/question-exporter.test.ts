import { describe, expect, it } from 'vitest'
import type { QuestionEntity } from '../../db/types.js'
import { buildQuestionExport, questionsToCsv } from './question-exporter.js'

const question: QuestionEntity = {
    id: 'q-1',
    poemId: 'p-1',
    bloomLevel: '理解',
    type: '选择',
    stem: '<script>alert(1)</script>',
    options: ['春风', '明月'],
    answer: '=HYPERLINK("https://invalid.example")',
    analysis: '+恶意公式',
    distractorsAnalysis: null,
    difficulty: 2,
    estimatedTimeSec: 60,
    aiGenerated: true,
    promptVersion: 'v1',
    createdAt: 1,
    createdBy: null,
    metadata: null,
}

describe('question exporter', () => {
    it('escapes HTML and honours answer visibility', () => {
        const artifact = buildQuestionExport([question], 'pdf', {
            includeAnswer: false,
            includeAnalysis: false,
            layout: 'A4',
        })
        expect(artifact.extension).toBe('html')
        expect(artifact.mimeType).toContain('text/html')
        expect(artifact.content).toContain('&lt;script&gt;')
        expect(artifact.content).not.toContain('<script>')
        expect(artifact.content).not.toContain('参考答案')
        expect(artifact.content).toContain('@page { size: A4')
    })

    it('produces Word-compatible .doc HTML rather than fake DOCX bytes', () => {
        const artifact = buildQuestionExport([question], 'word', {
            includeAnswer: true,
            includeAnalysis: true,
            layout: 'B5',
        })
        expect(artifact.extension).toBe('doc')
        expect(artifact.mimeType).toContain('application/msword')
        expect(artifact.content).toContain('xmlns:w=')
        expect(artifact.content).toContain('参考答案')
    })

    it('produces BOM CSV and neutralizes spreadsheet formulas', () => {
        const csv = questionsToCsv([question])
        expect(csv.startsWith('\uFEFF')).toBe(true)
        expect(csv).toContain(`"'=HYPERLINK(""https://invalid.example"")"`)
        expect(csv).toContain(`"'+恶意公式"`)
    })
})
