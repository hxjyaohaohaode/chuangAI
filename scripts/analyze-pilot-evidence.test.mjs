import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzePilotEvidence, parseCsv } from './analyze-pilot-evidence.mjs';

function manifest(overrides = {}) {
  return JSON.stringify({
    dataKind: 'REAL',
    pilotId: 'P-AWARD-01',
    classId: 'C-5A',
    systemVersion: 'sha256:test-only',
    pilotStartDate: '2026-07-01',
    pilotEndDate: '2026-07-14',
    expectedStudents: 1,
    requiredMetrics: ['knowledge_accuracy'],
    consentAndAuthorizationConfirmed: true,
    piiRemoved: true,
    independentReviewer: 'R-01',
    authorizationEvidenceLocation: 'offline-vault/reference-001',
    ...overrides,
  });
}

const header = 'pilot_id,class_id,student_id,metric,pre_assessed_at,post_assessed_at,pre_score,post_score,scale_min,scale_max,missing_reason';
const pairedRow = 'P-AWARD-01,C-5A,S-7F3K9Q,knowledge_accuracy,2026-07-01,2026-07-14,60,80,0,100,';

test('CSV parser preserves quoted commas and escaped quotes', () => {
  assert.deepEqual(parseCsv('a,b\n"x,y","z""q"\n'), [['a', 'b'], ['x,y', 'z"q']]);
});

test('valid paired REAL evidence passes', () => {
  const csv = `${header}\n${pairedRow}\n`;
  const result = analyzePilotEvidence(csv, manifest());
  assert.equal(result.gate, 'PASS');
  assert.equal(result.metrics[0].normalizedMeanChangePercentagePoints, 20);
  assert.equal(result.metrics[0].claimLevel, 'DESCRIPTIVE_ONLY');
  assert.equal(result.dataset.schemaVersion, 2);
  assert.equal(result.dataset.measurementWindow.pairedRecordsWithVerifiedDates, 1);
});

test('partial pair and undeclared missingness fail closed', () => {
  const csv = `${header}\nP-AWARD-01,C-5A,S-7F3K9Q,knowledge_accuracy,2026-07-01,,60,,0,100,\n`;
  const result = analyzePilotEvidence(csv, manifest());
  assert.equal(result.gate, 'FAIL');
  assert.match(result.errors.join('\n'), /成对存在/u);
  assert.match(result.errors.join('\n'), /missing_reason/u);
});

test('unverified or demo manifest cannot produce a real-effect report', () => {
  const csv = `${header}\n${pairedRow}\n`;
  const result = analyzePilotEvidence(csv, manifest({ dataKind: 'UNVERIFIED' }));
  assert.equal(result.gate, 'FAIL');
  assert.match(result.errors.join('\n'), /必须明确为 REAL/u);
});

test('PII-like columns are rejected', () => {
  const csv = `${header},student_name\n${pairedRow},张同学\n`;
  const result = analyzePilotEvidence(csv, manifest());
  assert.equal(result.gate, 'FAIL');
  assert.match(result.errors.join('\n'), /个人信息列/u);
});

test('every required metric must retain all expected students including missing rows', () => {
  const csv = `${header}\n${pairedRow}\n`;
  const result = analyzePilotEvidence(csv, manifest({ expectedStudents: 2 }));
  assert.equal(result.gate, 'FAIL');
  assert.match(result.errors.join('\n'), /全部 2 名学生/u);
});

test('measurement dates must be chronological and inside the registered pilot window', () => {
  const csv = `${header}\nP-AWARD-01,C-5A,S-7F3K9Q,knowledge_accuracy,2026-07-15,2026-06-30,60,80,0,100,\n`;
  const result = analyzePilotEvidence(csv, manifest());
  assert.equal(result.gate, 'FAIL');
  assert.match(result.errors.join('\n'), /前测日期不得晚于后测日期/u);
  assert.match(result.errors.join('\n'), /试点窗口内/u);
});

test('missing samples require an approved reason and cannot retain a partial measurement date', () => {
  const csv = `${header}\nP-AWARD-01,C-5A,S-7F3K9Q,knowledge_accuracy,2026-07-01,,60,,0,100,临时请假\n`;
  const result = analyzePilotEvidence(csv, manifest());
  assert.equal(result.gate, 'FAIL');
  assert.match(result.errors.join('\n'), /孤立测量日期/u);
  assert.match(result.errors.join('\n'), /ABSENT/u);
});

test('unexpected columns are rejected even when they do not look like PII', () => {
  const csv = `${header},teacher_note\n${pairedRow},表现不错\n`;
  const result = analyzePilotEvidence(csv, manifest());
  assert.equal(result.gate, 'FAIL');
  assert.match(result.errors.join('\n'), /未声明列/u);
});

test('each metric must retain the identical anonymous student membership', () => {
  const csv = `${header}\n`
    + 'P-AWARD-01,C-5A,S-7F3K9Q,knowledge_accuracy,2026-07-01,2026-07-14,60,80,0,100,\n'
    + 'P-AWARD-01,C-5A,S-9K2L7M,knowledge_accuracy,2026-07-01,2026-07-14,60,80,0,100,\n'
    + 'P-AWARD-01,C-5A,S-1R8T6V,knowledge_accuracy,2026-07-01,2026-07-14,60,80,0,100,\n'
    + 'P-AWARD-01,C-5A,S-7F3K9Q,engagement,2026-07-01,2026-07-14,60,80,0,100,\n'
    + 'P-AWARD-01,C-5A,S-9K2L7M,engagement,2026-07-01,2026-07-14,60,80,0,100,\n'
    + 'P-AWARD-01,C-5A,S-5W4X3Y,engagement,2026-07-01,2026-07-14,60,80,0,100,\n';
  const result = analyzePilotEvidence(csv, manifest({
    expectedStudents: 3,
    requiredMetrics: ['knowledge_accuracy', 'engagement'],
  }));
  assert.equal(result.gate, 'FAIL');
  assert.match(result.errors.join('\n'), /匿名学生集合与全体不一致/u);
});

test('a metric with no usable pairs cannot pass as a real pilot', () => {
  const csv = `${header}\nP-AWARD-01,C-5A,S-7F3K9Q,knowledge_accuracy,,,,0,100,ABSENT\n`;
  const result = analyzePilotEvidence(csv, manifest());
  assert.equal(result.gate, 'FAIL');
  assert.match(result.errors.join('\n'), /没有可分析的配对样本/u);
});
