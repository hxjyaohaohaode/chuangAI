import { createHash } from 'node:crypto';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_COLUMNS = [
  'pilot_id',
  'class_id',
  'student_id',
  'metric',
  'pre_assessed_at',
  'post_assessed_at',
  'pre_score',
  'post_score',
  'scale_min',
  'scale_max',
  'missing_reason',
];

const ALLOWED_MISSING_REASONS = new Set([
  'ABSENT',
  'WITHDREW',
  'TECHNICAL',
  'OTHER_APPROVED',
]);

const FORBIDDEN_HEADER_PATTERNS = [
  /(^|_)(name|姓名|名字)($|_)/iu,
  /(phone|mobile|手机号|电话)/iu,
  /(address|住址|地址)/iu,
  /(id_card|身份证)/iu,
  /(face|人脸|photo|照片)/iu,
  /(email|邮箱)/iu,
];

const T_CRITICAL_975 = [
  null, null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306,
  2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101,
  2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045,
];

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const normalized = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (quoted) {
      if (character === '"' && normalized[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      if (field.length > 0) throw new Error(`CSV 第 ${rows.length + 1} 行引号位置无效`);
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('CSV 存在未闭合的引号');
  row.push(field);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  if (rows.length === 0) throw new Error('CSV 为空');
  return rows;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint];
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  const variance = values.reduce((total, value) => total + (value - average) ** 2, 0)
    / (values.length - 1);
  return Math.sqrt(variance);
}

function round(value, digits = 4) {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function criticalT(sampleSize) {
  const degreesOfFreedom = sampleSize - 1;
  if (degreesOfFreedom <= 0) return null;
  if (degreesOfFreedom <= 30) return T_CRITICAL_975[degreesOfFreedom + 1] ?? null;
  if (degreesOfFreedom <= 40) return 2.021;
  if (degreesOfFreedom <= 60) return 2;
  if (degreesOfFreedom <= 120) return 1.98;
  return 1.96;
}

function parseFiniteNumber(value, label, errors, allowBlank = false) {
  const trimmed = value.trim();
  if (allowBlank && trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    errors.push(`${label} 必须是有限数值`);
    return null;
  }
  return parsed;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function dateIsInsideInclusiveRange(value, start, end) {
  return value >= start && value <= end;
}

function isOpaqueStudentId(value) {
  return /^S-[A-Z0-9]{6,20}$/u.test(value)
    && /[A-Z]/u.test(value.slice(2))
    && /\d/u.test(value.slice(2));
}

function setsAreEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function daySpan(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

function validateManifest(manifest, errors, warnings) {
  const requiredStrings = [
    'pilotId', 'classId', 'systemVersion', 'pilotStartDate', 'pilotEndDate',
    'independentReviewer', 'authorizationEvidenceLocation',
  ];
  for (const key of requiredStrings) {
    if (typeof manifest[key] !== 'string' || manifest[key].trim() === '') {
      errors.push(`manifest.${key} 必须填写`);
    }
  }
  if (manifest.dataKind !== 'REAL') errors.push('manifest.dataKind 必须明确为 REAL；DEMO/UNVERIFIED 不得生成真实成效结论');
  if (manifest.consentAndAuthorizationConfirmed !== true) errors.push('manifest.consentAndAuthorizationConfirmed 必须为 true');
  if (manifest.piiRemoved !== true) errors.push('manifest.piiRemoved 必须为 true');
  if (!Number.isInteger(manifest.expectedStudents) || manifest.expectedStudents < 1) {
    errors.push('manifest.expectedStudents 必须是大于 0 的整数');
  }
  if (!Array.isArray(manifest.requiredMetrics) || manifest.requiredMetrics.length === 0
      || manifest.requiredMetrics.some((metric) => typeof metric !== 'string' || metric.trim() === '')) {
    errors.push('manifest.requiredMetrics 必须是非空字符串数组');
  } else if (new Set(manifest.requiredMetrics).size !== manifest.requiredMetrics.length) {
    errors.push('manifest.requiredMetrics 不得重复');
  }
  if (isIsoDate(manifest.pilotStartDate) && isIsoDate(manifest.pilotEndDate)) {
    const days = daySpan(manifest.pilotStartDate, manifest.pilotEndDate);
    if (days < 1) errors.push('试点结束日期不得早于开始日期');
    else if (days < 14) warnings.push(`试点仅 ${days} 天，低于建议的 14 天；结果只能作为早期证据`);
  } else {
    errors.push('manifest.pilotStartDate / pilotEndDate 必须使用 YYYY-MM-DD');
  }
}

export function analyzePilotEvidence(csvText, manifestText) {
  const errors = [];
  const warnings = [];
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    return { gate: 'FAIL', errors: [`manifest JSON 无法解析：${error.message}`], warnings, metrics: [] };
  }
  validateManifest(manifest, errors, warnings);

  let matrix;
  try {
    matrix = parseCsv(csvText);
  } catch (error) {
    return { gate: 'FAIL', errors: [...errors, error.message], warnings, metrics: [], manifest };
  }
  const headers = matrix[0].map((header) => header.trim());
  const headerSet = new Set(headers);
  if (headerSet.size !== headers.length) errors.push('CSV 表头不得重复');
  for (const column of REQUIRED_COLUMNS) {
    if (!headerSet.has(column)) errors.push(`CSV 缺少必需列 ${column}`);
  }
  const unexpectedColumns = headers.filter((header) => !REQUIRED_COLUMNS.includes(header));
  if (unexpectedColumns.length > 0) {
    errors.push(`CSV 不得包含未声明列：${unexpectedColumns.join('、')}；最小化数据原则禁止附带备注或个人信息`);
  }
  for (const header of headers) {
    if (FORBIDDEN_HEADER_PATTERNS.some((pattern) => pattern.test(header))) {
      errors.push(`CSV 禁止包含疑似个人信息列 ${header}`);
    }
  }
  if (matrix.length === 1) errors.push('CSV 没有试点记录');
  const records = [];
  const seen = new Set();
  const metricScales = new Map();

  for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
    const values = matrix[rowIndex];
    const line = rowIndex + 1;
    if (values.length !== headers.length) {
      errors.push(`CSV 第 ${line} 行列数 ${values.length} 与表头 ${headers.length} 不一致`);
      continue;
    }
    const raw = Object.fromEntries(headers.map((header, index) => [header, values[index].trim()]));
    if (!/^P-[A-Z0-9-]{3,30}$/u.test(raw.pilot_id ?? '')) errors.push(`第 ${line} 行 pilot_id 格式无效`);
    if (!/^C-[A-Z0-9-]{2,30}$/u.test(raw.class_id ?? '')) errors.push(`第 ${line} 行 class_id 格式无效`);
    if (!isOpaqueStudentId(raw.student_id ?? '')) {
      errors.push(`第 ${line} 行 student_id 必须是至少 6 位且同时含字母和数字的匿名编号，如 S-7F3K9Q；格式不能单独证明不可反推身份`);
    }
    if ((raw.pilot_id ?? '') !== manifest.pilotId) errors.push(`第 ${line} 行 pilot_id 与 manifest 不一致`);
    if ((raw.class_id ?? '') !== manifest.classId) errors.push(`第 ${line} 行 class_id 与 manifest 不一致`);
    if (!manifest.requiredMetrics?.includes(raw.metric)) errors.push(`第 ${line} 行 metric ${raw.metric || '(空)'} 不在 requiredMetrics 中`);

    const uniqueKey = `${raw.student_id}\u0000${raw.metric}`;
    if (seen.has(uniqueKey)) errors.push(`第 ${line} 行 student_id + metric 重复`);
    seen.add(uniqueKey);

    const scaleMin = parseFiniteNumber(raw.scale_min ?? '', `第 ${line} 行 scale_min`, errors);
    const scaleMax = parseFiniteNumber(raw.scale_max ?? '', `第 ${line} 行 scale_max`, errors);
    const preScore = parseFiniteNumber(raw.pre_score ?? '', `第 ${line} 行 pre_score`, errors, true);
    const postScore = parseFiniteNumber(raw.post_score ?? '', `第 ${line} 行 post_score`, errors, true);
    const preAssessedAt = raw.pre_assessed_at ?? '';
    const postAssessedAt = raw.post_assessed_at ?? '';
    const missingReason = raw.missing_reason ?? '';
    if (scaleMin !== null && scaleMax !== null && scaleMax <= scaleMin) errors.push(`第 ${line} 行 scale_max 必须大于 scale_min`);
    const hasPre = preScore !== null;
    const hasPost = postScore !== null;
    if (hasPre !== hasPost) errors.push(`第 ${line} 行前后测必须成对存在；不能静默使用非配对样本`);
    if (hasPre && hasPost) {
      if (!isIsoDate(preAssessedAt)) errors.push(`第 ${line} 行 pre_assessed_at 必须使用 YYYY-MM-DD`);
      if (!isIsoDate(postAssessedAt)) errors.push(`第 ${line} 行 post_assessed_at 必须使用 YYYY-MM-DD`);
      if (isIsoDate(preAssessedAt) && isIsoDate(postAssessedAt)) {
        if (preAssessedAt > postAssessedAt) errors.push(`第 ${line} 行前测日期不得晚于后测日期`);
        if (!dateIsInsideInclusiveRange(preAssessedAt, manifest.pilotStartDate, manifest.pilotEndDate)) {
          errors.push(`第 ${line} 行 pre_assessed_at 必须落在试点窗口内`);
        }
        if (!dateIsInsideInclusiveRange(postAssessedAt, manifest.pilotStartDate, manifest.pilotEndDate)) {
          errors.push(`第 ${line} 行 post_assessed_at 必须落在试点窗口内`);
        }
      }
      if (missingReason !== '') errors.push(`第 ${line} 行有完整前后测分数时 missing_reason 必须为空`);
    } else {
      if (preAssessedAt !== '' || postAssessedAt !== '') {
        errors.push(`第 ${line} 行缺失样本不得保留孤立测量日期；请使用受控 missing_reason 说明未完成原因`);
      }
      if (missingReason === '') errors.push(`第 ${line} 行任一测次缺失时必须填写 missing_reason`);
      else if (!ALLOWED_MISSING_REASONS.has(missingReason)) {
        errors.push(`第 ${line} 行 missing_reason 必须是 ${[...ALLOWED_MISSING_REASONS].join(' / ')} 之一`);
      }
    }
    if (hasPre && scaleMin !== null && scaleMax !== null
        && (preScore < scaleMin || preScore > scaleMax || postScore < scaleMin || postScore > scaleMax)) {
      errors.push(`第 ${line} 行分数超出量表范围`);
    }
    const scaleKey = `${scaleMin}:${scaleMax}`;
    const priorScale = metricScales.get(raw.metric);
    if (priorScale && priorScale !== scaleKey) errors.push(`指标 ${raw.metric} 的量表范围不一致`);
    else metricScales.set(raw.metric, scaleKey);
    records.push({ ...raw, preScore, postScore, scaleMin, scaleMax, line });
  }

  const studentIds = new Set(records.map((record) => record.student_id));
  if (Number.isInteger(manifest.expectedStudents) && studentIds.size !== manifest.expectedStudents) {
    errors.push(`实际匿名学生数 ${studentIds.size} 与 manifest.expectedStudents ${manifest.expectedStudents} 不一致`);
  }

  const metrics = [];
  for (const metric of manifest.requiredMetrics ?? []) {
    const metricRecords = records.filter((record) => record.metric === metric);
    const metricStudentIds = new Set(metricRecords.map((record) => record.student_id));
    if (Number.isInteger(manifest.expectedStudents) && metricRecords.length !== manifest.expectedStudents) {
      errors.push(`指标 ${metric} 有 ${metricRecords.length} 行，应显式包含全部 ${manifest.expectedStudents} 名学生（缺失也要保留行）`);
    }
    if (metricRecords.length > 0 && !setsAreEqual(metricStudentIds, studentIds)) {
      errors.push(`指标 ${metric} 的匿名学生集合与全体不一致；不得以另一批学生替代前后测指标样本`);
    }
    const paired = metricRecords.filter((record) => record.preScore !== null && record.postScore !== null);
    if (paired.length === 0) {
      errors.push(`指标 ${metric} 没有可分析的配对样本，不能形成完整试点评估`);
      metrics.push({ metric, total: metricRecords.length, paired: 0, missing: metricRecords.length });
      continue;
    }
    const deltas = paired.map((record) => record.postScore - record.preScore);
    const normalizedDeltas = paired.map((record) => (
      ((record.postScore - record.preScore) / (record.scaleMax - record.scaleMin)) * 100
    ));
    const deltaMean = mean(deltas);
    const deltaSd = sampleStandardDeviation(deltas);
    const normalizedMean = mean(normalizedDeltas);
    const normalizedSd = sampleStandardDeviation(normalizedDeltas);
    const t = criticalT(paired.length);
    const margin = normalizedSd === null || t === null ? null : t * normalizedSd / Math.sqrt(paired.length);
    const confidenceInterval95 = margin === null ? null : [normalizedMean - margin, normalizedMean + margin];
    const claimLevel = paired.length >= 20 && confidenceInterval95?.[0] > 0
      ? 'POSITIVE_ASSOCIATION'
      : paired.length >= 20
        ? 'NO_CLEAR_POSITIVE_ASSOCIATION'
        : 'DESCRIPTIVE_ONLY';
    metrics.push({
      metric,
      total: metricRecords.length,
      paired: paired.length,
      missing: metricRecords.length - paired.length,
      missingRate: round((metricRecords.length - paired.length) / metricRecords.length),
      scaleMin: paired[0].scaleMin,
      scaleMax: paired[0].scaleMax,
      preMean: round(mean(paired.map((record) => record.preScore))),
      postMean: round(mean(paired.map((record) => record.postScore))),
      rawMeanChange: round(deltaMean),
      rawMedianChange: round(median(deltas)),
      normalizedMeanChangePercentagePoints: round(normalizedMean),
      normalizedChangeCi95: confidenceInterval95?.map((value) => round(value)) ?? null,
      pairedEffectSizeDz: deltaSd && deltaSd > 0 ? round(deltaMean / deltaSd) : null,
      claimLevel,
    });
  }

  if ((manifest.expectedStudents ?? 0) < 20) warnings.push('样本量少于 20，不应作显著改善或推广性表述');
  const missingRates = metrics.filter((metric) => metric.total > 0).map((metric) => metric.missing / metric.total);
  if (missingRates.some((rate) => rate > 0.2)) warnings.push('至少一个指标缺失率超过 20%，必须解释失访机制并做敏感性分析');

  return {
    gate: errors.length === 0 ? 'PASS' : 'FAIL',
    generatedAt: new Date().toISOString(),
    analysisBoundary: '单组配对前后测仅能描述关联，不能单独证明因果；不得外推到未参与人群。',
    manifest,
    dataset: {
      schemaVersion: 2,
      sha256: sha256(csvText),
      manifestSha256: sha256(manifestText),
      rows: records.length,
      students: studentIds.size,
      columns: headers,
      measurementWindow: {
        startsOn: manifest.pilotStartDate,
        endsOn: manifest.pilotEndDate,
        pairedRecordsWithVerifiedDates: records.filter((record) => (
          record.preScore !== null
          && record.postScore !== null
          && isIsoDate(record.pre_assessed_at)
          && isIsoDate(record.post_assessed_at)
          && record.pre_assessed_at <= record.post_assessed_at
          && dateIsInsideInclusiveRange(record.pre_assessed_at, manifest.pilotStartDate, manifest.pilotEndDate)
          && dateIsInsideInclusiveRange(record.post_assessed_at, manifest.pilotStartDate, manifest.pilotEndDate)
        )).length,
      },
      missingReasonPolicy: [...ALLOWED_MISSING_REASONS],
    },
    metrics,
    errors,
    warnings,
  };
}

function renderMarkdown(result, inputPath, manifestPath) {
  const measurementWindow = result.dataset?.measurementWindow;
  const measurementStartsOn = measurementWindow?.startsOn || '未填写';
  const measurementEndsOn = measurementWindow?.endsOn || '未填写';
  const lines = [
    '# 真实试点证据分析',
    '',
    `- 结论门：**${result.gate}**`,
    `- 数据文件：\`${path.basename(inputPath)}\``,
    `- 数据 SHA-256：\`${result.dataset?.sha256 ?? '不可用'}\``,
    `- 清单文件：\`${path.basename(manifestPath)}\``,
    `- 清单 SHA-256：\`${result.dataset?.manifestSha256 ?? '不可用'}\``,
    `- 测量窗口：${measurementStartsOn} 至 ${measurementEndsOn}；已验证日期的配对记录 ${measurementWindow?.pairedRecordsWithVerifiedDates ?? 0}`,
    `- 生成时间：${result.generatedAt ?? new Date().toISOString()}`,
    '',
    '> 统计边界：单组配对前后测仅能描述关联，不能单独证明因果；不得外推到未参与人群。',
    '',
  ];
  if (result.errors.length > 0) {
    lines.push('## 阻断问题', '', ...result.errors.map((error) => `- ${error}`), '');
  }
  if (result.warnings.length > 0) {
    lines.push('## 风险提示', '', ...result.warnings.map((warning) => `- ${warning}`), '');
  }
  if (result.metrics.length > 0) {
    lines.push(
      '## 指标结果', '',
      '| 指标 | 配对/总数 | 缺失率 | 前测均值 | 后测均值 | 标准化变化百分点（95% CI） | 可声明等级 |',
      '|---|---:|---:|---:|---:|---:|---|',
      ...result.metrics.map((metric) => {
        const ci = metric.normalizedChangeCi95
          ? `${metric.normalizedMeanChangePercentagePoints} [${metric.normalizedChangeCi95[0]}, ${metric.normalizedChangeCi95[1]}]`
          : '样本不足';
        return `| ${metric.metric} | ${metric.paired}/${metric.total} | ${round((metric.missingRate ?? 0) * 100, 1)}% | ${metric.preMean ?? '—'} | ${metric.postMean ?? '—'} | ${ci} | ${metric.claimLevel ?? '不可分析'} |`;
      }),
      '',
      '声明等级解释：`POSITIVE_ASSOCIATION` 仅表示本试点配对样本呈正向关联；`NO_CLEAR_POSITIVE_ASSOCIATION` 不支持正向结论；`DESCRIPTIVE_ONLY` 只能报告原始描述值。',
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

async function atomicWrite(targetPath, content) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, targetPath);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--input', '--manifest', '--out'].includes(argument)) throw new Error(`未知参数 ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少值`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  for (const required of ['input', 'manifest', 'out']) {
    if (!values[required]) throw new Error(`缺少 --${required}`);
  }
  return values;
}

export async function runCli(argv) {
  const options = parseArguments(argv);
  const inputPath = path.resolve(options.input);
  const manifestPath = path.resolve(options.manifest);
  const outputBase = path.resolve(options.out).replace(/\.(json|md)$/iu, '');
  const [csvText, manifestText] = await Promise.all([
    readFile(inputPath, 'utf8'),
    readFile(manifestPath, 'utf8'),
  ]);
  const result = analyzePilotEvidence(csvText, manifestText);
  await Promise.all([
    atomicWrite(`${outputBase}.json`, `${JSON.stringify(result, null, 2)}\n`),
    atomicWrite(`${outputBase}.md`, renderMarkdown(result, inputPath, manifestPath)),
  ]);
  process.stdout.write(`Pilot evidence gate: ${result.gate}; errors=${result.errors.length}; warnings=${result.warnings.length}\n`);
  return result.gate === 'PASS' ? 0 : 2;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      process.stderr.write(`Pilot evidence analyzer failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
