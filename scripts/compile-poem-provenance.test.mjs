import assert from 'node:assert/strict';
import test from 'node:test';

import { compilePoemProvenance } from './compile-poem-provenance.mjs';

const headers = 'poem_id,title,poet,dynasty,content_sha256,catalog_scope,source_1_title,source_1_url,source_1_level,source_1_accessed_at,source_2_title,source_2_url,source_2_level,source_2_accessed_at,teacher_decision,teacher_reviewer_id,teacher_reviewed_at,evidence_location';
const poem = { id: 'p-1', title: '诗,一', poet: '作者', dynasty: '唐', content: '原文' };
const hashPoem = () => 'a'.repeat(64);
const evaluate = (_poem, record) => {
  const valid = record.catalogScope === 'TEXTBOOK_CORE'
    && record.sources.length === 2
    && record.sources.every((source) => source.url.startsWith('https://') && ['L1', 'L2'].includes(source.authorityLevel))
    && record.teacherReview.decision === 'PASS'
    && record.teacherReview.reviewerId !== '';
  return { status: valid ? 'VERIFIED' : 'INCOMPLETE', message: valid ? 'ok' : 'incomplete' };
};

const validRow = 'p-1,"诗,一",作者,唐,' + 'a'.repeat(64)
  + ',TEXTBOOK_CORE,出版方,https://example.edu/a,L1,2026-08-01,教育平台,https://example.gov/b,L2,2026-08-01,PASS,T-01,2026-08-01,offline/review-1';

test('compiles a complete verified register', () => {
  const result = compilePoemProvenance(`${headers}\n${validRow}\n`, [poem], evaluate, hashPoem);
  assert.equal(result.ok, true);
  assert.equal(result.registry.records.length, 1);
});

test('rejects stale hashes without producing a registry', () => {
  const stale = validRow.replace('a'.repeat(64), 'b'.repeat(64));
  const result = compilePoemProvenance(`${headers}\n${stale}\n`, [poem], evaluate, hashPoem);
  assert.equal(result.ok, false);
  assert.equal(result.registry, null);
  assert.match(result.errors.join('\n'), /哈希已过期/u);
});

test('rejects missing poems and incomplete review records', () => {
  const result = compilePoemProvenance(`${headers}\n`, [poem], evaluate, hashPoem);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /缺少诗篇/u);
});
