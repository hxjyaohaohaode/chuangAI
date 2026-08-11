import { access, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseCsv } from './analyze-pilot-evidence.mjs';

const REQUIRED_HEADERS = [
  'poem_id', 'title', 'poet', 'dynasty', 'content_sha256', 'catalog_scope',
  'source_1_title', 'source_1_url', 'source_1_level', 'source_1_accessed_at',
  'source_2_title', 'source_2_url', 'source_2_level', 'source_2_accessed_at',
  'teacher_decision', 'teacher_reviewer_id', 'teacher_reviewed_at', 'evidence_location',
];

export function compilePoemProvenance(csvText, poems, evaluateRecord, hashPoem) {
  const errors = [];
  let matrix;
  try {
    matrix = parseCsv(csvText);
  } catch (error) {
    return { ok: false, errors: [error.message], registry: null };
  }
  const headers = matrix[0].map((header) => header.trim());
  if (headers.length !== REQUIRED_HEADERS.length
      || headers.some((header, index) => header !== REQUIRED_HEADERS[index])) {
    errors.push(`CSV 表头必须严格等于模板：${REQUIRED_HEADERS.join(',')}`);
  }
  const poemById = new Map(poems.map((poem) => [poem.id, poem]));
  const seen = new Set();
  const records = [];
  for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
    const values = matrix[rowIndex];
    const line = rowIndex + 1;
    if (values.length !== headers.length) {
      errors.push(`第 ${line} 行列数错误`);
      continue;
    }
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index].trim()]));
    const poem = poemById.get(row.poem_id);
    if (!poem) {
      errors.push(`第 ${line} 行 poem_id 不属于当前运行时诗集：${row.poem_id || '(空)'}`);
      continue;
    }
    if (seen.has(poem.id)) errors.push(`第 ${line} 行 poem_id 重复：${poem.id}`);
    seen.add(poem.id);
    for (const key of ['title', 'poet', 'dynasty']) {
      if (row[key] !== poem[key]) errors.push(`第 ${line} 行 ${key} 与当前代码不一致`);
    }
    const expectedHash = hashPoem(poem);
    if (row.content_sha256 !== expectedHash) errors.push(`第 ${line} 行内容哈希已过期，必须重新生成工作表并复核`);
    const record = {
      poemId: poem.id,
      contentSha256: row.content_sha256,
      catalogScope: row.catalog_scope,
      sources: [1, 2].map((number) => ({
        title: row[`source_${number}_title`],
        url: row[`source_${number}_url`],
        authorityLevel: row[`source_${number}_level`],
        accessedAt: row[`source_${number}_accessed_at`],
      })),
      teacherReview: {
        decision: row.teacher_decision,
        reviewerId: row.teacher_reviewer_id,
        reviewedAt: row.teacher_reviewed_at,
        evidenceLocation: row.evidence_location,
      },
    };
    const verification = evaluateRecord(poem, record);
    if (verification.status !== 'VERIFIED') errors.push(`第 ${line} 行未达到 VERIFIED：${verification.message}`);
    records.push(record);
  }
  for (const poem of poems) {
    if (!seen.has(poem.id)) errors.push(`缺少诗篇：${poem.id} / ${poem.title}`);
  }
  if (matrix.length - 1 !== poems.length) errors.push(`工作表共有 ${matrix.length - 1} 行，当前运行时诗集需要 ${poems.length} 行`);
  return {
    ok: errors.length === 0,
    errors,
    registry: errors.length === 0 ? { version: 1, records } : null,
  };
}

function parseArguments(argv) {
  const inputIndex = argv.indexOf('--input');
  const outputIndex = argv.indexOf('--out');
  const input = inputIndex >= 0 ? argv[inputIndex + 1] : null;
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : null;
  if (!input || !output) throw new Error('用法：node scripts/compile-poem-provenance.mjs --input <已签字工作表.csv> --out <registry.json> [--replace]');
  return { input: path.resolve(input), output: path.resolve(output), replace: argv.includes('--replace') };
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function runCli(argv) {
  const root = path.resolve(import.meta.dirname, '..');
  const options = parseArguments(argv);
  if (await exists(options.output) && !options.replace) {
    throw new Error('输出文件已存在；确认要替换时必须显式添加 --replace');
  }
  const [{ SEED_POEMS_FULL }, verification] = await Promise.all([
    import(pathToFileURL(path.join(root, 'backend/dist/services/knowledge-graph/seed-poems-full.js')).href),
    import(pathToFileURL(path.join(root, 'backend/dist/services/content-verification/poem-provenance.js')).href),
  ]);
  const result = compilePoemProvenance(
    await readFile(options.input, 'utf8'),
    SEED_POEMS_FULL,
    (poem, record) => verification.evaluatePoemVerification(poem, [record]),
    verification.computePoemContentSha256,
  );
  if (!result.ok) {
    const visibleErrors = result.errors.slice(0, 20);
    for (const error of visibleErrors) process.stderr.write(`[FAIL] ${error}\n`);
    if (result.errors.length > visibleErrors.length) {
      process.stderr.write(`[FAIL] 另有 ${result.errors.length - visibleErrors.length} 项未显示；请填写工作表后重试\n`);
    }
    return 2;
  }
  const temporary = `${options.output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result.registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, options.output);
  process.stdout.write(`Compiled ${result.registry.records.length} VERIFIED poem provenance records to ${options.output}\n`);
  return 0;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      process.stderr.write(`Poem provenance compiler failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
