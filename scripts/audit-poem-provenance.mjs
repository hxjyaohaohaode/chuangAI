import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseCsv } from './analyze-pilot-evidence.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

export const REVIEW_HEADERS = [
  'poem_id', 'title', 'poet', 'dynasty', 'content_sha256', 'catalog_scope',
  'source_1_title', 'source_1_url', 'source_1_level', 'source_1_accessed_at',
  'source_2_title', 'source_2_url', 'source_2_level', 'source_2_accessed_at',
  'teacher_decision', 'teacher_reviewer_id', 'teacher_reviewed_at', 'evidence_location',
];

const REVIEW_INPUT_HEADERS = REVIEW_HEADERS.slice(5);

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function renderMarkdown(report) {
  const lines = [
    '# 古诗内容溯源审计',
    '',
    `- 放行门：**${report.gate}**`,
    `- 运行时诗集：${report.totalPoems} 首`,
    `- VERIFIED：${report.statusCounts.VERIFIED}`,
    `- UNVERIFIED：${report.statusCounts.UNVERIFIED}`,
    `- INCOMPLETE：${report.statusCounts.INCOMPLETE}`,
    `- STALE：${report.statusCounts.STALE}`,
    `- 复核工作表：${report.reviewRegister?.state ?? '未检查'}；${report.reviewRegister?.rows ?? 0} 行，已填信源 ${report.reviewRegister?.populatedSourceRows ?? 0} 行，已填教师结论 ${report.reviewRegister?.populatedReviewRows ?? 0} 行`,
    ...(report.reviewRegister?.backupPath ? [`- 显式重置前备份：\`${report.reviewRegister.backupPath}\``] : []),
    `- 生成时间：${report.generatedAt}`,
    '',
    '> “运行时诗集 148 首”只表示系统当前收录量；在逐首登记 `TEXTBOOK_CORE / EXTENDED` 且完成双信源和教师验收前，不得把 148 首整体宣称为统编版必背篇目。',
    '',
  ];
  if (report.integrityErrors.length > 0) {
    lines.push('## 数据结构阻断项', '', ...report.integrityErrors.map((item) => `- ${item}`), '');
  }
  if (report.statusCounts.VERIFIED !== report.totalPoems) {
    lines.push(
      '## 尚未放行', '',
      `仍有 ${report.totalPoems - report.statusCounts.VERIFIED} 首未完成有效复核。系统会在接口和前端显式显示“待逐首复核”，不会把内部研究注释冒充外部验收证据。`,
      '',
      '填写 `evidence/content/poem-review-register-latest.csv` 时，每首诗必须给出两个独立 L1/L2 HTTPS 信源、教材核心/拓展范围、匿名教师编号、PASS 结论、日期和线下证据位置；内容哈希变化会自动使旧结论失效。',
      '',
    );
  }
  lines.push(
    '## 状态明细', '',
    '| ID | 诗题 | 作者 | 状态 | 范围 | 内容 SHA-256 |',
    '|---|---|---|---|---|---|',
    ...report.poems.map((poem) => `| ${poem.id} | ${poem.title} | ${poem.poet} | ${poem.verification.status} | ${poem.verification.catalogScope} | \`${poem.verification.contentSha256}\` |`),
    '',
  );
  return `${lines.join('\n')}\n`;
}

export function renderReviewCsv(poems) {
  const rows = poems.map((poem) => [
    poem.id, poem.title, poem.poet, poem.dynasty, poem.verification.contentSha256, '',
    '', '', '', '', '', '', '', '', '', '', '', '',
  ]);
  return `${[REVIEW_HEADERS, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

/**
 * A provenance template is a signed-review work product, not an audit cache.
 * Never "helpfully" regenerate it over an in-progress teacher review: doing so
 * would make evidence disappear while the audit itself still reports a clean
 * structure. The normal audit therefore validates identity columns only and
 * leaves every human-entered value byte-for-byte intact.
 */
export function inspectReviewRegister(csvText, poems) {
  const errors = [];
  let matrix;
  try {
    matrix = parseCsv(csvText);
  } catch (error) {
    return { ok: false, errors: [`复核工作表无法解析：${error.message}`], rows: 0, populatedSourceRows: 0, populatedReviewRows: 0 };
  }
  const headers = matrix[0].map((header) => header.trim());
  if (headers.length !== REVIEW_HEADERS.length
      || headers.some((header, index) => header !== REVIEW_HEADERS[index])) {
    errors.push('复核工作表表头与受控模板不一致；为防止覆盖人工证据，审计不会自动重建。');
  }
  const currentById = new Map(poems.map((poem) => [poem.id, poem]));
  const seen = new Set();
  let populatedSourceRows = 0;
  let populatedReviewRows = 0;
  for (let index = 1; index < matrix.length; index += 1) {
    const line = index + 1;
    const values = matrix[index];
    if (values.length !== REVIEW_HEADERS.length) {
      errors.push(`复核工作表第 ${line} 行列数错误；为防止覆盖人工证据，审计不会自动重建。`);
      continue;
    }
    const row = Object.fromEntries(REVIEW_HEADERS.map((header, column) => [header, values[column]?.trim() ?? '']));
    const poem = currentById.get(row.poem_id);
    if (!poem) {
      errors.push(`复核工作表第 ${line} 行 poem_id 不属于当前运行时诗集：${row.poem_id || '(空)'}`);
      continue;
    }
    if (seen.has(poem.id)) errors.push(`复核工作表第 ${line} 行 poem_id 重复：${poem.id}`);
    seen.add(poem.id);
    const expected = [poem.id, poem.title, poem.poet, poem.dynasty, poem.verification.contentSha256];
    const actual = [row.poem_id, row.title, row.poet, row.dynasty, row.content_sha256];
    const staleField = REVIEW_HEADERS.slice(0, 5).find((header, column) => actual[column] !== expected[column]);
    if (staleField) {
      errors.push(`复核工作表第 ${line} 行 ${staleField} 与当前诗集不一致；请核实后显式重置模板，人工记录已原样保留。`);
    }
    if (row.source_1_url || row.source_2_url || row.source_1_title || row.source_2_title) populatedSourceRows += 1;
    if (REVIEW_INPUT_HEADERS.slice(9).some((header) => row[header] !== '')) populatedReviewRows += 1;
  }
  for (const poem of poems) {
    if (!seen.has(poem.id)) errors.push(`复核工作表缺少当前诗篇：${poem.id} / ${poem.title}`);
  }
  if (matrix.length - 1 !== poems.length) {
    errors.push(`复核工作表共有 ${matrix.length - 1} 行，当前运行时诗集需要 ${poems.length} 行；审计不会自动删除或补写人工记录。`);
  }
  return { ok: errors.length === 0, errors, rows: matrix.length - 1, populatedSourceRows, populatedReviewRows };
}

async function atomicWrite(targetPath, content, mode = undefined) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  await rename(temporaryPath, targetPath);
}

function parseArguments(argv) {
  const resetTemplate = argv.includes('--reset-review-template');
  const unknown = argv.filter((argument) => argument !== '--reset-review-template');
  if (unknown.length > 0) {
    throw new Error(`未知参数：${unknown.join(' ')}；仅支持 --reset-review-template`);
  }
  return { resetTemplate };
}

async function inspectOrCreateReviewRegister(targetPath, poems, resetTemplate) {
  let existing;
  try {
    existing = await readFile(targetPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      await atomicWrite(targetPath, renderReviewCsv(poems), 0o600);
      return {
        state: 'CREATED',
        backupPath: null,
        inspection: { ok: true, errors: [], rows: poems.length, populatedSourceRows: 0, populatedReviewRows: 0 },
      };
    }
    throw error;
  }

  const inspection = inspectReviewRegister(existing, poems);
  if (!resetTemplate) {
    return { state: inspection.ok ? 'PRESERVED' : 'PRESERVED_INVALID', backupPath: null, inspection };
  }

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const backupPath = `${targetPath}.${stamp}.bak`;
  await atomicWrite(backupPath, existing, 0o600);
  await atomicWrite(targetPath, renderReviewCsv(poems), 0o600);
  return {
    state: 'RESET_WITH_BACKUP',
    backupPath,
    inspection: { ok: true, errors: [], rows: poems.length, populatedSourceRows: 0, populatedReviewRows: 0 },
  };
}

export async function runCli(argv) {
  const { resetTemplate } = parseArguments(argv);
  const seedModulePath = path.join(ROOT, 'backend', 'dist', 'services', 'knowledge-graph', 'seed-poems-full.js');
  const verificationModulePath = path.join(ROOT, 'backend', 'dist', 'services', 'content-verification', 'poem-provenance.js');
  const [{ SEED_POEMS_FULL }, { getPoemVerification }] = await Promise.all([
    import(pathToFileURL(seedModulePath).href),
    import(pathToFileURL(verificationModulePath).href),
  ]);

  const integrityErrors = [];
  const ids = new Set();
  const identityTuples = new Set();
  for (const poem of SEED_POEMS_FULL) {
    if (ids.has(poem.id)) integrityErrors.push(`重复 poem.id：${poem.id}`);
    ids.add(poem.id);
    const tuple = `${poem.title}\u0000${poem.poet}\u0000${poem.content}`;
    if (identityTuples.has(tuple)) integrityErrors.push(`完全重复诗篇：${poem.title} / ${poem.poet}`);
    identityTuples.add(tuple);
    if (!poem.content.trim()) integrityErrors.push(`诗文为空：${poem.id}`);
    if (!/^(一|二|三|四|五|六)年级/u.test(poem.gradeLevel)) integrityErrors.push(`年级格式异常：${poem.id} / ${poem.gradeLevel}`);
    if (!Number.isInteger(poem.difficulty) || poem.difficulty < 1 || poem.difficulty > 5) integrityErrors.push(`难度异常：${poem.id}`);
  }
  const poems = SEED_POEMS_FULL.map((poem) => ({
    id: poem.id,
    title: poem.title,
    poet: poem.poet,
    dynasty: poem.dynasty,
    verification: getPoemVerification(poem),
  }));
  const statusCounts = { VERIFIED: 0, UNVERIFIED: 0, INCOMPLETE: 0, STALE: 0 };
  for (const poem of poems) statusCounts[poem.verification.status] += 1;
  const reviewRegister = await inspectOrCreateReviewRegister(
    path.join(ROOT, 'evidence', 'content', 'poem-review-register-latest.csv'),
    poems,
    resetTemplate,
  );
  if (!reviewRegister.inspection.ok) integrityErrors.push(...reviewRegister.inspection.errors);
  const report = {
    gate: integrityErrors.length === 0 && statusCounts.VERIFIED === poems.length ? 'PASS' : 'FAIL',
    generatedAt: new Date().toISOString(),
    totalPoems: poems.length,
    integrityErrors,
    statusCounts,
    scopeBoundary: '数量是收录量，不是教材口径。只有逐首 VERIFIED 且 catalogScope=TEXTBOOK_CORE 的记录可计入教材核心覆盖。',
    reviewRegister: {
      state: reviewRegister.state,
      rows: reviewRegister.inspection.rows,
      populatedSourceRows: reviewRegister.inspection.populatedSourceRows,
      populatedReviewRows: reviewRegister.inspection.populatedReviewRows,
      backupPath: reviewRegister.backupPath ? path.relative(ROOT, reviewRegister.backupPath) : null,
    },
    poems,
  };
  await Promise.all([
    atomicWrite(path.join(ROOT, 'docs', 'audit', 'poem-provenance-latest.json'), `${JSON.stringify(report, null, 2)}\n`),
    atomicWrite(path.join(ROOT, 'docs', 'audit', 'poem-provenance-latest.md'), renderMarkdown(report)),
  ]);
  process.stdout.write(`Poem provenance gate: ${report.gate}; total=${poems.length}; verified=${statusCounts.VERIFIED}; integrityErrors=${integrityErrors.length}; reviewRegister=${reviewRegister.state}\n`);
  return report.gate === 'PASS' ? 0 : 2;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      process.stderr.write(`Poem provenance audit failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
