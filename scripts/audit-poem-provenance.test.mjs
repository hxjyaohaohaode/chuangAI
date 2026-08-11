import assert from 'node:assert/strict';
import test from 'node:test';

import { REVIEW_HEADERS, inspectReviewRegister, renderReviewCsv } from './audit-poem-provenance.mjs';

const poem = {
  id: 'p-1',
  title: '示例诗',
  poet: '示例作者',
  dynasty: '唐',
  verification: { contentSha256: 'a'.repeat(64) },
};

function csvRow(values) {
  return values.map((value) => String(value ?? '')).join(',');
}

test('creates a controlled blank review template for the exact poem identity', () => {
  const csv = renderReviewCsv([poem]);
  const inspection = inspectReviewRegister(csv, [poem]);
  assert.equal(csv.split('\n')[0], REVIEW_HEADERS.join(','));
  assert.equal(inspection.ok, true);
  assert.equal(inspection.rows, 1);
  assert.equal(inspection.populatedSourceRows, 0);
  assert.equal(inspection.populatedReviewRows, 0);
});

test('accepts a filled teacher review without treating it as disposable audit output', () => {
  const row = [
    poem.id, poem.title, poem.poet, poem.dynasty, poem.verification.contentSha256,
    'TEXTBOOK_CORE',
    '权威出版社', 'https://publisher.example.edu/poem', 'L1', '2026-08-08',
    '教育主管部门', 'https://education.example.gov/poem', 'L2', '2026-08-08',
    'PASS', 'T-01', '2026-08-09', 'offline-vault/reviews/p-1.pdf',
  ];
  const inspection = inspectReviewRegister(`${REVIEW_HEADERS.join(',')}\n${csvRow(row)}\n`, [poem]);
  assert.equal(inspection.ok, true);
  assert.equal(inspection.populatedSourceRows, 1);
  assert.equal(inspection.populatedReviewRows, 1);
});

test('rejects stale identity data instead of silently overwriting the signed review work product', () => {
  const row = [
    poem.id, poem.title, poem.poet, poem.dynasty, 'b'.repeat(64),
    'TEXTBOOK_CORE',
    '权威出版社', 'https://publisher.example.edu/poem', 'L1', '2026-08-08',
    '教育主管部门', 'https://education.example.gov/poem', 'L2', '2026-08-08',
    'PASS', 'T-01', '2026-08-09', 'offline-vault/reviews/p-1.pdf',
  ];
  const inspection = inspectReviewRegister(`${REVIEW_HEADERS.join(',')}\n${csvRow(row)}\n`, [poem]);
  assert.equal(inspection.ok, false);
  assert.match(inspection.errors.join('\n'), /content_sha256 与当前诗集不一致/u);
  assert.equal(inspection.populatedSourceRows, 1);
  assert.equal(inspection.populatedReviewRows, 1);
});
