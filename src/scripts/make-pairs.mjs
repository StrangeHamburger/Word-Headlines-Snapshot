#!/usr/bin/env node
/**
 * 从 probe 的原始条目生成"人工标注候选对"。
 *
 * 目的：产出 300 对跨语言标题，让人（而不是模型）判断"是否同一事件"，
 * 作为 calibrate.mjs 的输入。这是放行条件 2 的前置步骤。
 *
 *   node src/scripts/make-pairs.mjs                       # 读 data/probe/raw-latest.json
 *   node src/scripts/make-pairs.mjs --in data/probe/raw-xxx.json --n 300
 *
 * 产出：tests/fixtures/labeled-pairs.csv（label 列为空，待人工填写）
 *
 * 分层设计（为什么不是纯随机）：
 *   - 纯随机跨语言对里正例极少，标 300 行可能只有个位数正例，无法校准。
 *   - 因此按"同源近似/同国不同源/同语言跨国/共享实体token/纯跨语言随机"五层抽样，
 *     既保证有足够正例，也保证负例覆盖真实分布。
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'after', 'over', 'into',
  'will', 'says', 'said', 'new', 'now', 'how', 'why', 'what', 'who', 'its',
  'his', 'her', 'their', 'been', 'has', 'have', 'was', 'were', 'are', 'not',
  'but', 'you', 'can', 'may', 'more', 'than', 'out', 'up', 'on', 'in', 'to',
  'of', 'at', 'as', 'by', 'is', 'it', 'a', 'an', 'be', 'or',
]);

// ---------------------------------------------------------------- 工具

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rng) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function latinTokens(title) {
  const matches = String(title).match(/[A-Za-z][A-Za-z0-9''-]{3,}/g) || [];
  return new Set(
    matches
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 4 && !STOPWORDS.has(token)),
  );
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function pairKey(a, b) {
  const left = `${a.country}|${a.title}`;
  const right = `${b.country}|${b.title}`;
  return left < right ? `${left}||${right}` : `${right}||${left}`;
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const opts = { input: '', n: 300, out: 'tests/fixtures/labeled-pairs.csv', seed: 20261028 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--in') opts.input = argv[++i] || '';
    else if (arg === '--n') opts.n = Math.max(20, Number(argv[++i]) || 300);
    else if (arg === '--out') opts.out = argv[++i] || opts.out;
    else if (arg === '--seed') opts.seed = Number(argv[++i]) || opts.seed;
    else if (arg === '--help' || arg === '-h') {
      console.log(`
用法: node src/scripts/make-pairs.mjs [选项]

  --in <file>    probe 产出的 raw JSON（默认自动找 data/probe/raw-latest.json）
  --n <count>    生成对数，默认 300
  --out <file>   输出 CSV，默认 tests/fixtures/labeled-pairs.csv
  --seed <n>     随机种子，保证可复现，默认 20261028
`);
      process.exit(0);
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

async function resolveInput(explicit) {
  if (explicit) return path.resolve(ROOT, explicit);
  const dir = path.join(ROOT, 'data/probe');
  const latest = path.join(dir, 'raw-latest.json');
  try {
    await readFile(latest);
    return latest;
  } catch {
    const files = (await readdir(dir).catch(() => []))
      .filter((name) => /^raw-.*\.json$/.test(name) && name !== 'raw-latest.json')
      .sort();
    if (files.length === 0) return '';
    return path.join(dir, files[files.length - 1]);
  }
}

// ---------------------------------------------------------------- 分层抽样

function buildStrata(countries, rng) {
  const withItems = countries.filter((country) => Array.isArray(country.items) && country.items.length > 0);
  const pool = [];
  for (const country of withItems) {
    for (const item of country.items) {
      if (!item.title) continue;
      pool.push({
        country: country.code,
        lang: country.lang,
        region: country.region,
        source: item.source || '',
        title: item.title,
      });
    }
  }

  const strata = {
    'same-country-same-source': [],
    'same-country-diff-source': [],
    'same-lang-cross-country': [],
    'shared-latin-token': [],
    'cross-lang-random': [],
  };

  const byCountry = new Map();
  const byLang = new Map();
  for (const entry of pool) {
    if (!byCountry.has(entry.country)) byCountry.set(entry.country, []);
    byCountry.get(entry.country).push(entry);
    if (!byLang.has(entry.lang)) byLang.set(entry.lang, []);
    byLang.get(entry.lang).push(entry);
  }

  // A/B：同国内部对
  for (const [, entries] of byCountry) {
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i];
        const b = entries[j];
        const sameSource = a.source && b.source && a.source === b.source;
        strata[sameSource ? 'same-country-same-source' : 'same-country-diff-source'].push({ a, b });
      }
    }
  }

  // C：同语言跨国
  for (const [lang, entries] of byLang) {
    const countriesWithLang = [...new Set(entries.map((entry) => entry.country))];
    if (countriesWithLang.length < 2) continue;
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        if (entries[i].country === entries[j].country) continue;
        strata['same-lang-cross-country'].push({ a: entries[i], b: entries[j] });
      }
    }
    void lang;
  }

  // E：跨语言但共享拉丁 token（如 Trump / OpenAI / Netflix），正例富集
  const tokenIndex = new Map();
  for (const entry of pool) {
    for (const token of latinTokens(entry.title)) {
      if (!tokenIndex.has(token)) tokenIndex.set(token, []);
      tokenIndex.get(token).push(entry);
    }
  }
  const seen = new Set();
  for (const [, entries] of tokenIndex) {
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i];
        const b = entries[j];
        if (a.lang === b.lang) continue;
        const key = pairKey(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        strata['shared-latin-token'].push({ a, b });
      }
    }
  }

  // D：跨语言随机（真实分布，正例稀疏）
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      if (pool[i].lang === pool[j].lang) continue;
      strata['cross-lang-random'].push({ a: pool[i], b: pool[j] });
    }
  }

  return { strata, pool, rng };
}

function takeFrom(list, count, rng, used) {
  const picked = [];
  for (const pair of shuffle(list, rng)) {
    if (picked.length >= count) break;
    const key = pairKey(pair.a, pair.b);
    if (used.has(key)) continue;
    used.add(key);
    picked.push(pair);
  }
  return picked;
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv);
  const inputPath = await resolveInput(opts.input);
  if (!inputPath) {
    console.error('找不到 probe 输出。先运行：node src/scripts/probe-feeds.mjs');
    process.exit(1);
  }

  const raw = JSON.parse(await readFile(inputPath, 'utf8'));
  const countries = raw.countries || [];
  const { strata, pool } = buildStrata(countries, mulberry32(opts.seed));

  if (pool.length < 20) {
    console.error(`可用的标题只有 ${pool.length} 条，太少。先让 probe 跑出真实数据。`);
    process.exit(1);
  }

  // 目标配额：正例富集层优先，随机层兜底
  const plan = [
    ['same-country-same-source', 0.1],
    ['same-country-diff-source', 0.1],
    ['same-lang-cross-country', 0.15],
    ['shared-latin-token', 0.25],
    ['cross-lang-random', 0.4],
  ];

  const used = new Set();
  const chosen = [];
  let shortage = 0;

  for (const [stratum, share] of plan) {
    const want = Math.round(opts.n * share);
    const got = takeFrom(strata[stratum], want, mulberry32(opts.seed + stratum.length), used);
    if (got.length < want) shortage += want - got.length;
    for (const pair of got) chosen.push({ ...pair, stratum });
  }

  // 不足配额补给随机层
  if (shortage > 0) {
    const extra = takeFrom(strata['cross-lang-random'], shortage, mulberry32(opts.seed + 7), used);
    for (const pair of extra) chosen.push({ ...pair, stratum: 'cross-lang-random' });
  }

  if (chosen.length === 0) {
    console.error('没有任何候选对。可能 probe 只抓到 1 个国家。');
    process.exit(1);
  }

  const rows = chosen.slice(0, opts.n).map((pair, index) => [
    `p${String(index + 1).padStart(3, '0')}`,
    pair.stratum,
    pair.a.country,
    pair.a.lang,
    pair.a.title,
    pair.b.country,
    pair.b.lang,
    pair.b.title,
    '',
  ]);

  const header = ['pairId', 'stratum', 'countryA', 'langA', 'titleA', 'countryB', 'langB', 'titleB', 'label'];
  const csv = [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';

  const outPath = path.resolve(ROOT, opts.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, csv, 'utf8');

  const counts = {};
  for (const pair of chosen.slice(0, opts.n)) counts[pair.stratum] = (counts[pair.stratum] || 0) + 1;

  console.log(`输入：${path.relative(ROOT, inputPath)}`);
  console.log(`标题池：${pool.length} 条，来自 ${countries.filter((c) => c.items?.length).length} 个国家`);
  console.log(`生成：${rows.length} 对`);
  for (const [stratum] of plan) {
    console.log(`  ${stratum.padEnd(26)} ${counts[stratum] || 0}`);
  }
  console.log(`\n已写出：${path.relative(ROOT, outPath)}`);
  console.log(`
下一步（人工，约 40 分钟）：
  1. 用 Excel / Numbers / VS Code 打开该 CSV
  2. 只在 label 列填 1 或 0：
       1 = 两行标题讲的是同一件事（同一事件的两次报道）
       0 = 不同事件（哪怕主题相同、国家相同）
       无法判断就留空，会被 calibrate 跳过
  3. 填完保存，然后运行：
       node src/scripts/calibrate.mjs
`);
}

main().catch((error) => {
  console.error('生成配对失败：', error);
  process.exit(1);
});