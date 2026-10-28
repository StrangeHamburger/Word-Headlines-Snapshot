#!/usr/bin/env node
/**
 * 阈值校准：用人工标注的标题对，扫出满足精确率要求的 T_MATCH。
 *
 *   node src/scripts/calibrate.mjs                     # 默认 e5 向量
 *   node src/scripts/calibrate.mjs --provider tfidf     # 无模型依赖的降级模式（仅同语言有效）
 *   node src/scripts/calibrate.mjs --pairs tests/fixtures/labeled-pairs.csv
 *
 * 产出：
 *   docs/calibration.md          阈值曲线 + 分省/分层结果 + 推荐常量
 *   docs/calibration-scores.csv  逐对得分，便于抽查误判
 *
 * 判据（与 docs/02-detailed-design.md §16.2 一致）：
 *   取"精确率 >= 0.90 的最低阈值"。达不到就是 FAIL，不允许放宽——错标比漏标严重得多。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GATE_COS = 0.86;
const TARGET_PRECISION = 0.9;
const MIN_LABELED = 50;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'after', 'over', 'into',
  'will', 'says', 'said', 'new', 'now', 'how', 'why', 'what', 'who', 'its',
  'his', 'her', 'their', 'been', 'has', 'have', 'was', 'were', 'are', 'not',
  'but', 'you', 'can', 'may', 'more', 'than', 'out', 'up', 'on', 'in', 'to',
  'of', 'at', 'as', 'by', 'is', 'it', 'a', 'an', 'be', 'or',
]);

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const opts = { pairs: 'tests/fixtures/labeled-pairs.csv', provider: 'e5', out: 'docs/calibration.md' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pairs') opts.pairs = argv[++i] || opts.pairs;
    else if (arg === '--provider') opts.provider = (argv[++i] || 'e5').toLowerCase();
    else if (arg === '--out') opts.out = argv[++i] || opts.out;
    else if (arg === '--help' || arg === '-h') {
      console.log(`
用法: node src/scripts/calibrate.mjs [选项]

  --pairs <file>     标注 CSV，默认 tests/fixtures/labeled-pairs.csv
  --provider <name>  e5（多语言向量，推荐）| tfidf（无依赖降级，仅同语言有效）
  --out <file>       报告输出，默认 docs/calibration.md
`);
      process.exit(0);
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(1);
    }
  }
  if (!['e5', 'tfidf'].includes(opts.provider)) {
    console.error(`--provider 只支持 e5 / tfidf，收到 ${opts.provider}`);
    process.exit(1);
  }
  return opts;
}

// ---------------------------------------------------------------- CSV

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const source = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => cell && cell.trim() !== ''));
}

const LABEL_TRUE = new Set(['1', 'true', 'yes', 'y', 'same', '是']);
const LABEL_FALSE = new Set(['0', 'false', 'no', 'n', 'diff', 'different', '否']);

function parseLabel(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  if (LABEL_TRUE.has(value)) return 1;
  if (LABEL_FALSE.has(value)) return 0;
  return null;
}

// ---------------------------------------------------------------- 相似度信号

function numbersOf(title) {
  const set = new Set();
  for (const match of String(title).matchAll(/\d{1,4}/g)) set.add(match[0]);
  return set;
}

function entitiesOf(title) {
  // 代理实现：production 用 src/config/entities.json 的多语言别名表。
  // 这里只取拉丁字母 token，因此对 CJK 标题覆盖率低——报告里会标注这个局限。
  const set = new Set();
  for (const match of String(title).matchAll(/[A-Za-z][A-Za-z0-9''-]{2,}/g)) {
    const token = match[0].toLowerCase();
    if (token.length >= 3 && !STOPWORDS.has(token)) set.add(token);
  }
  return set;
}

function scorePair(cosine, a, b) {
  const bothEntities = a.entities.size > 0 && b.entities.size > 0;
  const bothNumbers = a.numbers.size > 0 && b.numbers.size > 0;

  let entityScore = 0;
  if (bothEntities) {
    let shared = 0;
    for (const token of a.entities) if (b.entities.has(token)) shared += 1;
    entityScore = shared / Math.min(a.entities.size, b.entities.size);
  }

  let numberScore = 0;
  if (bothNumbers) {
    let shared = 0;
    for (const token of a.numbers) if (b.numbers.has(token)) shared += 1;
    numberScore = shared / Math.max(a.numbers.size, b.numbers.size);
  }

  let weight = 0.78;
  let weighted = 0.78 * cosine;
  if (bothEntities) {
    weight += 0.14;
    weighted += 0.14 * entityScore;
  }
  if (bothNumbers) {
    weight += 0.08;
    weighted += 0.08 * numberScore;
  }

  const sim = weighted / weight;
  const gate =
    cosine >= GATE_COS ||
    (bothEntities && entityScore >= 0.5) ||
    (bothNumbers && numberScore >= 0.5);

  return { cosine, entityScore, numberScore, sim, gate };
}

// ---------------------------------------------------------------- provider

function charNgramCosine(textA, textB, n = 3) {
  const build = (text) => {
    const normalized = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
    const map = new Map();
    for (let i = 0; i + n <= normalized.length; i += 1) {
      const gram = normalized.slice(i, i + n);
      map.set(gram, (map.get(gram) || 0) + 1);
    }
    return map;
  };
  const left = build(textA);
  const right = build(textB);
  if (left.size === 0 || right.size === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const value of left.values()) leftNorm += value * value;
  for (const value of right.values()) rightNorm += value * value;
  for (const [gram, value] of left) {
    const other = right.get(gram);
    if (other) dot += value * other;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}

async function loadE5() {
  let mod;
  try {
    mod = await import('@huggingface/transformers');
  } catch {
    console.error(`
找不到 @huggingface/transformers。

两种选择：
  a) 安装后用真实多语言向量校准（推荐）：
       npm install
       node src/scripts/calibrate.mjs
  b) 先用无依赖降级模式确认流程能跑通（结果仅对同语言有效，不能作为跨语言阈值）：
       node src/scripts/calibrate.mjs --provider tfidf
`);
    process.exit(1);
  }

  const { pipeline, env } = mod;
  env.cacheDir = process.env.MODEL_CACHE_DIR || path.join(ROOT, '.cache');
  env.allowLocalModels = false;

  console.log(`加载模型 Xenova/multilingual-e5-small（缓存目录 ${env.cacheDir}）…`);
  let extractor;
  try {
    extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' });
  } catch {
    extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
  }

  return async (texts) => {
    const output = await extractor(texts.map((text) => `query: ${text}`), {
      pooling: 'mean',
      normalize: true,
    });
    return output.tolist();
  };
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

// ---------------------------------------------------------------- 评估

function sweep(scored, thresholds) {
  const positives = scored.filter((pair) => pair.label === 1).length;
  const negatives = scored.length - positives;
  const rows = [];
  for (const threshold of thresholds) {
    let tp = 0;
    let fp = 0;
    for (const pair of scored) {
      const predicted = pair.gate && pair.sim >= threshold;
      if (!predicted) continue;
      if (pair.label === 1) tp += 1;
      else fp += 1;
    }
    const fn = positives - tp;
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = positives === 0 ? 0 : tp / positives;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    rows.push({ threshold, tp, fp, fn, precision, recall, f1, predicted: tp + fp });
  }
  void negatives;
  return { rows, positives };
}

function fmt(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv);
  const csvPath = path.resolve(ROOT, opts.pairs);

  let csvText;
  try {
    csvText = await readFile(csvPath, 'utf8');
  } catch {
    console.error(`读不到 ${path.relative(ROOT, csvPath)}。先运行：node src/scripts/make-pairs.mjs`);
    process.exit(1);
  }

  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    console.error('CSV 是空的。');
    process.exit(1);
  }

  const header = rows[0].map((cell) => cell.trim());
  const index = Object.fromEntries(header.map((name, position) => [name, position]));
  for (const required of ['titleA', 'titleB', 'label']) {
    if (index[required] === undefined) {
      console.error(`CSV 缺少必需列：${required}。表头为 ${header.join(', ')}`);
      process.exit(1);
    }
  }

  const records = [];
  let unlabeled = 0;
  for (const row of rows.slice(1)) {
    const label = parseLabel(row[index.label]);
    if (label === null) {
      unlabeled += 1;
      continue;
    }
    const titleA = row[index.titleA] || '';
    const titleB = row[index.titleB] || '';
    if (!titleA || !titleB) continue;
    records.push({
      pairId: row[index.pairId] ?? '',
      stratum: row[index.stratum] ?? '',
      countryA: row[index.countryA] ?? '',
      countryB: row[index.countryB] ?? '',
      langA: row[index.langA] ?? '',
      langB: row[index.langB] ?? '',
      titleA,
      titleB,
      label,
    });
  }

  console.log(`读入 ${rows.length - 1} 行，已标注 ${records.length} 行，未标注 ${unlabeled} 行。`);
  if (records.length === 0) {
    console.error('一行都没标注。至少标 50 行才有意义。');
    process.exit(1);
  }
  if (records.length < MIN_LABELED) {
    console.warn(`警告：只标注了 ${records.length} 行（建议 ≥ ${MIN_LABELED}），结果仅供参考。`);
  }

  const positives = records.filter((record) => record.label === 1).length;
  console.log(`其中正例（同事件）${positives} 条，负例 ${records.length - positives} 条。`);
  if (positives < 10) {
    console.warn('警告：正例少于 10 条，精确率估计极不稳定。建议补标，或先在 make-pairs 里提高正例富集层的比例。');
  }

  // 向量化
  let embedAll;
  let providerLabel;
  if (opts.provider === 'e5') {
    embedAll = await loadE5();
    providerLabel = 'Xenova/multilingual-e5-small (q8)';
  } else {
    providerLabel = 'char-3gram TF-IDF（降级模式，仅同语言有效）';
    console.log('使用降级 provider：结果不能作为跨语言阈值依据。');
  }

  const uniqueTitles = [...new Set(records.flatMap((record) => [record.titleA, record.titleB]))];
  const vectorByTitle = new Map();

  if (opts.provider === 'e5') {
    const batchSize = 16;
    for (let start = 0; start < uniqueTitles.length; start += batchSize) {
      const batch = uniqueTitles.slice(start, start + batchSize);
      const vectors = await embedAll(batch);
      batch.forEach((title, position) => vectorByTitle.set(title, vectors[position]));
      process.stdout.write(`\r向量化 ${Math.min(start + batchSize, uniqueTitles.length)}/${uniqueTitles.length}`);
    }
    process.stdout.write('\n');
  }

  // 逐对打分
  const scored = records.map((record) => {
    let cosine;
    if (opts.provider === 'e5') {
      cosine = dot(vectorByTitle.get(record.titleA), vectorByTitle.get(record.titleB));
    } else {
      cosine = charNgramCosine(record.titleA, record.titleB);
    }
    const a = { entities: entitiesOf(record.titleA), numbers: numbersOf(record.titleA) };
    const b = { entities: entitiesOf(record.titleB), numbers: numbersOf(record.titleB) };
    const signals = scorePair(cosine, a, b);
    return { ...record, ...signals };
  });

  const thresholds = [];
  for (let value = 0.6; value <= 0.9501; value += 0.01) thresholds.push(Number(value.toFixed(2)));
  const { rows: sweepRows } = sweep(scored, thresholds);

  const feasible = sweepRows.filter((row) => row.precision >= TARGET_PRECISION && row.tp > 0);
  const chosen = feasible.length > 0 ? feasible[0] : null;
  const bestF1 = [...sweepRows].sort((a, b) => b.f1 - a.f1)[0];

  // 分层结果
  const operatingPoint = chosen ? chosen.threshold : bestF1.threshold;
  const strataNames = [...new Set(scored.map((pair) => pair.stratum))].filter(Boolean);
  const stratumStats = strataNames.map((name) => {
    const subset = scored.filter((pair) => pair.stratum === name);
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const pair of subset) {
      const predicted = pair.gate && pair.sim >= operatingPoint;
      if (predicted && pair.label === 1) tp += 1;
      else if (predicted && pair.label === 0) fp += 1;
      else if (!predicted && pair.label === 1) fn += 1;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    return { name, total: subset.length, positives: subset.filter((p) => p.label === 1).length, tp, fp, fn, precision, recall };
  });

  // 门槛灵敏度
  const gateSensitivity = [0.8, 0.86, 0.9].map((gateCos) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const pair of scored) {
      const gate = pair.cosine >= gateCos || pair.entityScore >= 0.5 || pair.numberScore >= 0.5;
      const predicted = gate && pair.sim >= operatingPoint;
      if (predicted && pair.label === 1) tp += 1;
      else if (predicted && pair.label === 0) fp += 1;
      else if (!predicted && pair.label === 1) fn += 1;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    return { gateCos, tp, fp, fn, precision, recall };
  });

  // 控制台
  console.log('');
  console.log(`provider: ${providerLabel}`);
  console.log(`标注对: ${scored.length}（正例 ${positives}）`);
  console.log('');
  console.log('阈值   精确率   召回率   F1      TP   FP');
  for (const row of sweepRows.filter((entry) => Math.abs((entry.threshold * 100) % 4) < 1e-6)) {
    const marker = chosen && row.threshold === chosen.threshold ? ' ← 选定' : '';
    console.log(
      `${fmt(row.threshold, 2)}   ${fmt(row.precision).padEnd(8)} ${fmt(row.recall).padEnd(8)} ${fmt(row.f1).padEnd(6)} ${String(row.tp).padStart(3)}  ${String(row.fp).padStart(3)}${marker}`,
    );
  }
  console.log('');

  if (chosen) {
    console.log(`✓ 选定 T_MATCH = ${fmt(chosen.threshold, 2)}：精确率 ${fmt(chosen.precision)}，召回率 ${fmt(chosen.recall)}`);
  } else {
    console.log(`✗ FAIL：没有任何阈值达到精确率 ${TARGET_PRECISION}。`);
    console.log(`  最佳 F1 出现在 T=${fmt(bestF1.threshold, 2)}（P=${fmt(bestF1.precision)} R=${fmt(bestF1.recall)}）。`);
    console.log('  处理顺序：① 先提高阈值到 P 达标（哪怕召回很低）；② 补标注，尤其补"同主题不同事件"的难负例；');
    console.log('  ③ 加强实体约束；④ 仍不行则关掉"未包含"，只保留共识计数。');
  }

  // 报告
  const lines = [];
  lines.push('# 聚类阈值校准报告');
  lines.push('');
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 标注文件：\`${path.relative(ROOT, csvPath)}\``);
  lines.push(`- provider：${providerLabel}`);
  lines.push(`- 标注对：${scored.length}（正例 ${positives}，负例 ${scored.length - positives}）`);
  lines.push(`- 目标：精确率 ≥ ${TARGET_PRECISION}（宁可漏，不可错）`);
  lines.push('');
  lines.push('## 1. 结论');
  lines.push('');
  if (chosen) {
    lines.push(`**选定 \`T_MATCH = ${fmt(chosen.threshold, 2)}\`**，此时精确率 ${fmt(chosen.precision)}、召回率 ${fmt(chosen.recall)}、F1 ${fmt(chosen.f1)}。`);
    lines.push('');
    lines.push('写入 `src/lib/constants.mjs`：');
    lines.push('');
    lines.push('```js');
    lines.push(`export const T_MATCH = ${fmt(chosen.threshold, 2)};`);
    lines.push(`export const GATE_COS = ${fmt(GATE_COS, 2)};`);
    lines.push('export const GATE_ENTITY = 0.5;');
    lines.push('export const GATE_NUMBER = 0.5;');
    lines.push('```');
  } else {
    lines.push(`**未达标**：没有任何阈值能达到精确率 ${TARGET_PRECISION}。最佳 F1 在 T=${fmt(bestF1.threshold, 2)}（P=${fmt(bestF1.precision)}，R=${fmt(bestF1.recall)}）。`);
    lines.push('');
    lines.push('按可行性文档的放行条件，**此时不应对外发布"共识/未包含"标记**。可选处置见 §4。');
  }
  lines.push('');
  lines.push('## 2. 阈值曲线');
  lines.push('');
  lines.push('| T_MATCH | 精确率 | 召回率 | F1 | TP | FP | FN |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const row of sweepRows.filter((entry) => Math.abs((entry.threshold * 100) % 2) < 1e-6)) {
    const marker = chosen && row.threshold === chosen.threshold ? ' **←**' : '';
    lines.push(`| ${fmt(row.threshold, 2)}${marker} | ${fmt(row.precision)} | ${fmt(row.recall)} | ${fmt(row.f1)} | ${row.tp} | ${row.fp} | ${row.fn} |`);
  }
  lines.push('');
  lines.push('## 3. 分层结果（在选定阈值下）');
  lines.push('');
  lines.push('| 分层 | 对数 | 正例 | P | R | 说明 |');
  lines.push('|---|---|---|---|---|---|');
  const stratumNote = {
    'same-country-same-source': '同国同源，多为近重复，应为高精确率',
    'same-country-diff-source': '同国不同源，同一事件的不同报道',
    'same-lang-cross-country': '同语言跨国，检验语言内一致性',
    'shared-latin-token': '跨语言但共享专名，正例富集',
    'cross-lang-random': '跨语言随机，真实分布，最难',
  };
  for (const entry of stratumStats) {
    lines.push(`| ${entry.name} | ${entry.total} | ${entry.positives} | ${fmt(entry.precision)} | ${fmt(entry.recall)} | ${stratumNote[entry.name] || '-'} |`);
  }
  lines.push('');
  lines.push('## 4. 门槛灵敏度');
  lines.push('');
  lines.push(`固定 T_MATCH = ${fmt(operatingPoint, 2)}，改变余弦门槛：`);
  lines.push('');
  lines.push('| GATE_COS | P | R | TP | FP |');
  lines.push('|---|---|---|---|---|');
  for (const entry of gateSensitivity) {
    lines.push(`| ${fmt(entry.gateCos, 2)} | ${fmt(entry.precision)} | ${fmt(entry.recall)} | ${entry.tp} | ${entry.fp} |`);
  }
  lines.push('');
  lines.push('## 5. 已知局限');
  lines.push('');
  lines.push('- **实体信号是代理实现**：本脚本只用拉丁字母 token 近似实体，production 用 `src/config/entities.json` 的多语言别名表。因此 CJK 标题的 `entityScore` 在本次校准中偏低，真实上线后匹配率会略优于此处结果。');
  lines.push('- **正例分布受分层抽样影响**：`shared-latin-token` 与 `same-lang-cross-country` 层正例比例高于真实世界，整体精确率估计偏乐观。看 `cross-lang-random` 那一行更接近真实。');
  lines.push('- **标注者口径**：什么算"同一事件"没有唯一定义。标的时候以"读者会认为是同一件事"为准，不要以"主题相同"为准。');
  lines.push('- 若 `provider=tfidf`，结果**不能**用于跨语言阈值，只用于验证流程。');
  lines.push('');
  lines.push('## 6. 未达标时的处置顺序');
  lines.push('');
  lines.push('1. 提高 `T_MATCH` 直到精确率达标（召回会掉，先接受）。');
  lines.push('2. 补标注，重点补"同主题不同事件"的难负例——精确率的敌人主要是它们。');
  lines.push('3. 加强实体约束（扩充 `entities.json`），让 `gate` 更可靠。');
  lines.push('4. 仍不达标：关闭"未包含"标记，只保留共识计数（共识错一个数影响小，指控某国漏报影响大）。');
  lines.push('');

  const outPath = path.resolve(ROOT, opts.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, lines.join('\n'), 'utf8');

  const scoresPath = path.join(path.dirname(outPath), 'calibration-scores.csv');
  const scoreLines = ['pairId,stratum,countryA,countryB,langA,langB,cosine,entity,number,sim,gate,label,predictedAtT'];
  for (const pair of [...scored].sort((a, b) => b.sim - a.sim)) {
    const predicted = pair.gate && pair.sim >= operatingPoint ? 1 : 0;
    scoreLines.push(
      [
        pair.pairId,
        pair.stratum,
        pair.countryA,
        pair.countryB,
        pair.langA,
        pair.langB,
        fmt(pair.cosine),
        fmt(pair.entityScore),
        fmt(pair.numberScore),
        fmt(pair.sim),
        pair.gate ? 1 : 0,
        pair.label,
        predicted,
      ].join(','),
    );
  }
  await writeFile(scoresPath, scoreLines.join('\n') + '\n', 'utf8');

  console.log(`已写出：${path.relative(ROOT, outPath)}`);
  console.log(`已写出：${path.relative(ROOT, scoresPath)}（按 sim 降序，方便看误判）`);

  if (!chosen) process.exit(3);
}

main().catch((error) => {
  console.error('校准失败：', error);
  process.exit(1);
});