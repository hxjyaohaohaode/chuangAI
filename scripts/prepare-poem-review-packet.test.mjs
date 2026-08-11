import assert from 'node:assert/strict'
import test from 'node:test'

import { REVIEW_HEADERS } from './audit-poem-provenance.mjs'
import { renderPoemReviewPacket } from './prepare-poem-review-packet.mjs'

const poem = {
    id: 'p-1',
    title: '示例|诗',
    poet: '作者',
    dynasty: '唐',
    content: '第一句，\n第二句。',
    gradeLevel: '一年级上册',
    difficulty: 1,
    themes: ['自然'],
    contentSha256: 'a'.repeat(64),
}

function row(overrides = {}) {
    const values = {
        poem_id: poem.id,
        title: poem.title,
        poet: poem.poet,
        dynasty: poem.dynasty,
        content_sha256: poem.contentSha256,
        catalog_scope: '',
        source_1_title: '',
        source_1_url: '',
        source_1_level: '',
        source_1_accessed_at: '',
        source_2_title: '',
        source_2_url: '',
        source_2_level: '',
        source_2_accessed_at: '',
        teacher_decision: '',
        teacher_reviewer_id: '',
        teacher_reviewed_at: '',
        evidence_location: '',
        ...overrides,
    }
    const escape = (value) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
    return REVIEW_HEADERS.map((header) => escape(values[header])).join(',')
}

test('renders a printable review view without turning blanks into verification', () => {
    const csv = `${REVIEW_HEADERS.join(',')}\n${row()}\n`
    const packet = renderPoemReviewPacket([poem], csv, '2026-08-11T00:00:00.000Z')
    assert.match(packet, /当前运行时收录：1 首/u)
    assert.match(packet, /已填写双信源：0\/1/u)
    assert.match(packet, /已填写教师结论：0\/1/u)
    assert.match(packet, /示例\\\|诗/u)
    assert.match(packet, /> 第一句，\n>\n> 第二句。/u)
    assert.match(packet, /待填写/u)
})

test('surfaces current source and teacher progress without signing for the reviewer', () => {
    const csv = `${REVIEW_HEADERS.join(',')}\n${row({
        catalog_scope: 'EXTENDED',
        source_1_title: '来源一',
        source_1_url: 'https://one.example.edu/a',
        source_1_level: 'L1',
        source_1_accessed_at: '2026-08-10',
        source_2_title: '来源二',
        source_2_url: 'https://two.example.gov/b',
        source_2_level: 'L2',
        source_2_accessed_at: '2026-08-10',
        teacher_decision: 'PASS',
        teacher_reviewer_id: 'T-01',
        teacher_reviewed_at: '2026-08-11',
        evidence_location: 'offline-vault/p-1.pdf',
    })}\n`
    const packet = renderPoemReviewPacket([poem], csv, '2026-08-11T00:00:00.000Z')
    assert.match(packet, /已填写双信源：1\/1/u)
    assert.match(packet, /已填写教师结论：1\/1/u)
    assert.match(packet, /EXTENDED/u)
    assert.match(packet, /T-01/u)
})

test('fails closed when the controlled CSV identity is stale', () => {
    const csv = `${REVIEW_HEADERS.join(',')}\n${row({ content_sha256: 'b'.repeat(64) })}\n`
    assert.throws(
        () => renderPoemReviewPacket([poem], csv),
        /身份校验失败.*content_sha256 与当前诗集不一致/u,
    )
})
