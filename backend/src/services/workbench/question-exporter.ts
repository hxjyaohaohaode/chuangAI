import type { QuestionEntity } from '../../db/types.js'

export type QuestionDocumentFormat = 'word' | 'excel' | 'pdf'

export interface QuestionExportOptions {
    includeAnswer: boolean
    includeAnalysis: boolean
    layout: 'A4' | 'B5'
}

export interface QuestionExportArtifact {
    content: string
    mimeType: string
    extension: 'doc' | 'csv' | 'html'
}

/**
 * 生成与实际字节格式一致的题卡导出物。
 * - word：Word 可打开的 HTML，扩展名 .doc
 * - excel：带 BOM 的 CSV，扩展名 .csv
 * - pdf：打印友好 HTML，用户通过浏览器另存为真实 PDF
 */
export function buildQuestionExport(
    entities: QuestionEntity[],
    format: QuestionDocumentFormat,
    options: QuestionExportOptions,
): QuestionExportArtifact {
    if (format === 'excel') {
        return {
            content: questionsToCsv(entities, options),
            mimeType: 'text/csv; charset=utf-8',
            extension: 'csv',
        }
    }

    const content = questionsToHtml(entities, options, format === 'word')
    return format === 'word'
        ? { content, mimeType: 'application/msword; charset=utf-8', extension: 'doc' }
        : { content, mimeType: 'text/html; charset=utf-8', extension: 'html' }
}

export function questionsToCsv(
    entities: QuestionEntity[],
    options: Pick<QuestionExportOptions, 'includeAnswer' | 'includeAnalysis'> = {
        includeAnswer: true,
        includeAnalysis: true,
    },
): string {
    const headers = ['id', 'poemId', 'bloomLevel', 'type', 'stem', 'difficulty', 'estimatedTimeSec', 'aiGenerated']
    if (options.includeAnswer) headers.push('answer')
    if (options.includeAnalysis) headers.push('analysis')

    const rows = entities.map((entity) => {
        const values: unknown[] = [
            entity.id,
            entity.poemId,
            entity.bloomLevel,
            entity.type,
            entity.stem,
            entity.difficulty,
            entity.estimatedTimeSec,
            entity.aiGenerated ? 'true' : 'false',
        ]
        if (options.includeAnswer) values.push(entity.answer)
        if (options.includeAnalysis) values.push(entity.analysis ?? '')
        return values.map(csvCell).join(',')
    })

    return `\uFEFF${[headers.map(csvCell).join(','), ...rows].join('\r\n')}`
}

function questionsToHtml(
    entities: QuestionEntity[],
    options: QuestionExportOptions,
    wordCompatible: boolean,
): string {
    const namespace = wordCompatible
        ? ' xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"'
        : ''
    const questions = entities.map((entity, index) => {
        const choices = entity.options?.length
            ? `<ol class="options" type="A">${entity.options.map((choice) => `<li>${escapeHtml(choice)}</li>`).join('')}</ol>`
            : ''
        const answer = options.includeAnswer
            ? `<div class="answer"><strong>参考答案：</strong>${escapeHtml(entity.answer)}</div>`
            : ''
        const analysis = options.includeAnalysis && entity.analysis
            ? `<div class="analysis"><strong>解析：</strong>${escapeHtml(entity.analysis)}</div>`
            : ''
        return `<section class="question">
<div class="question-meta">第 ${index + 1} 题 · ${escapeHtml(entity.type)} · ${escapeHtml(entity.bloomLevel)} · 难度 ${entity.difficulty}</div>
<div class="stem">${escapeHtml(entity.stem)}</div>
${choices}${answer}${analysis}
</section>`
    }).join('\n')

    return `<!DOCTYPE html>
<html lang="zh-CN"${namespace}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>诗脉·启明题卡导出</title>
<style>
@page { size: ${options.layout}; margin: 18mm; }
body { margin: 0; color: #2c241a; font: 14px/1.75 "Noto Sans SC", "Microsoft YaHei", sans-serif; }
h1 { margin: 0 0 4px; font-size: 24px; }
.subtitle { margin-bottom: 24px; color: #6b6258; }
.question { break-inside: avoid; margin: 0 0 22px; padding-bottom: 18px; border-bottom: 1px solid #ded6ca; }
.question-meta { margin-bottom: 6px; color: #8b6f47; font-size: 12px; }
.stem { font-size: 16px; font-weight: 600; white-space: pre-wrap; }
.options { margin: 8px 0; }
.answer, .analysis { margin-top: 8px; padding: 8px 10px; background: #f7f1e8; white-space: pre-wrap; }
.ai-note { margin-top: 28px; color: #6b6258; font-size: 11px; }
@media print { .question { break-inside: avoid; } }
</style>
</head>
<body>
<h1>诗脉·启明题卡</h1>
<div class="subtitle">共 ${entities.length} 题 · ${options.layout} 排版</div>
${questions}
<div class="ai-note">题目包含 AI 生成内容，使用前须由教师复核。</div>
</body>
</html>`
}

function csvCell(value: unknown): string {
    const raw = String(value ?? '')
    const safe = /^\s*[=+@-]/.test(raw) ? `'${raw}` : raw
    return `"${safe.replace(/"/g, '""')}"`
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}
