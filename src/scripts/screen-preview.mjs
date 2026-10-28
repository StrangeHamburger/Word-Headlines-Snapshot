#!/usr/bin/env node
/**
 * 内容筛查预检。
 *
 * 用途：把"搬进来之前检查一遍"变成一件 5 分钟能做完、且有记录的事。
 *   - 机器先按规则筛一遍，只把可能有问题的事件挑出来；
 *   - 人只审被挑出来的，不用看全部 45 条；
 *   - 输出一张带勾选框的预检表，审完写入决定文件，流水线照单执行。
 *
 *   node src/scripts/screen-preview.mjs            # 用 data/probe/raw-latest.json
 *   node src/scripts/screen-preview.mjs --check     # 只校验规则文件
 *   node src/scripts/screen-preview.mjs --in <file>
 *
 * 注意：这是**预检**，不是剔除。真正的剔除发生在 run.mjs 的 screen 步骤，
 * 且必须按事件簇整簇剔除（见 §7.6），否则"未包含"会变成错误指控。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createScreen, validateRuleset } from '../lib/screen.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 标题指纹，用作决定文件的稳定键。 */
function hashId(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

function parseArgs(argv) {
  const opts = { input: '', check: false, out: 'data/review' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--in') opts.input = argv[++i] || '';
    else if (arg === '--check') opts.check = true;
    else if (arg === '--out') opts.out = argv[++i] || opts.out;
    else if (arg === '--help' || arg === '-h') {
      console.log(`
用法: node src/scripts/screen-preview.mjs [选项]

  --in <file>    待筛查数据，默认 data/probe/raw-latest.json
  --check        只校验规则文件结构，不筛查
  --out <dir>    预检表输出目录，默认 data/review
`);
      process.exit(0);
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 合并全局规则与本地规则（本地文件已 gitignore）。 */
async function loadRuleset() {
  const basePath = path.join(ROOT, 'src/config/sensitive.json');
  const localPath = path.join(ROOT, 'src/config/sensitive.local.json');

  const base = await readJsonIfExists(basePath);
  if (!base) {
    console.error('读不到 src/config/sensitive.json');
    process.exit(1);
  }
  const local = await readJsonIfExists(localPath);

  const merged = {
    version: base.version ?? 1,
    rules: [...(base.rules || []), ...((local && local.rules) || [])],
    whitelist: {
      terms: [...(base.whitelist?.terms || []), ...((local && local.whitelist?.terms) || [])],
    },
  };

  return { merged, baseCount: (base.rules || []).length, localCount: (local?.rules || []).length, hasLocal: Boolean(local) };
}

async function main() {
  const opts = parseArgs(process.argv);
  const { merged, baseCount, localCount, hasLocal } = await loadRuleset();

  const problems = validateRuleset(merged);
  if (problems.length > 0) {
    console.error('规则文件有问题：');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  if (opts.check) {
    console.log(`规则校验通过。全局 ${baseCount} 条${hasLocal ? ` + 本地 ${localCount} 条` : ''}，共 ${merged.rules.length} 条。`);
    const hard = merged.rules.filter((rule) => rule.severity === 'hard');
    if (hard.length === 0) {
      console.log('当前没有 hard 规则：所有命中都只做标记，不会自动剔除。这是默认的安全状态。');
    } else {
      console.log(`注意：有 ${hard.length} 条 hard 规则会自动剔除条目：`);
      for (const rule of hard) console.log(`  - ${rule.id}${rule.note ? `：${rule.note}` : ''}`);
    }
    return;
  }

  const inputPath = opts.input ? path.resolve(ROOT, opts.input) : path.join(ROOT, 'data/probe/raw-latest.json');
  const data = await readJsonIfExists(inputPath);
  if (!data) {
    console.error(`读不到 ${path.relative(ROOT, inputPath)}。先运行：node src/scripts/probe-feeds.mjs`);
    process.exit(1);
  }

  const engine = createScreen(merged);
  const rows = [];
  let totalItems = 0;

  for (const country of data.countries || []) {
    for (const item of country.items || []) {
      totalItems += 1;
      const verdict = engine.screen(item.title, country.lang);
      if (!verdict.hit) continue;
      rows.push({
        id: hashId(item.title),
        country: country.code,
        name: country.name,
        lang: country.lang,
        title: item.title,
        source: item.source || '',
        severity: verdict.severity,
        rules: verdict.rules.map((rule) => rule.id),
      });
    }
  }

  const soft = rows.filter((row) => row.severity === 'soft');
  const hard = rows.filter((row) => row.severity === 'hard');

  console.log(`筛查 ${totalItems} 条标题（${(data.countries || []).length} 国），规则 ${merged.rules.length} 条。`);
  console.log(`命中：hard ${hard.length} 条，soft ${soft.length} 条。`);

  if (rows.length === 0) {
    console.log('\n没有命中。可以直接进入下一步；如需复核，把 --check 显示的规则清单过一眼即可。');
  } else {
    for (const row of [...hard, ...soft]) {
      console.log(`  [${row.severity}] ${row.country} ${row.id} ${row.rules.join(',')} :: ${row.title}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const lines = [];
  lines.push(`# 内容筛查预检 ${stamp}`);
  lines.push('');
  lines.push(`- 数据：\`${path.relative(ROOT, inputPath)}\``);
  lines.push(`- 规则：全局 ${baseCount} 条${hasLocal ? ` + 本地 ${localCount} 条` : '（无本地规则）'}，合计 ${merged.rules.length} 条`);
  lines.push(`- 扫描：${totalItems} 条标题 / ${(data.countries || []).length} 国`);
  lines.push(`- 命中：hard ${hard.length}，soft ${soft.length}`);
  lines.push('');
  lines.push('## 1. 自动剔除（hard）');
  lines.push('');
  if (hard.length === 0) {
    lines.push('无。');
  } else {
    lines.push('| 国家 | 标题 | 命中规则 | id |');
    lines.push('|---|---|---|---|');
    for (const row of hard) lines.push(`| ${row.country} | ${row.title.replace(/\|/g, '\\|')} | ${row.rules.join(', ')} | ${row.id} |`);
  }
  lines.push('');
  lines.push('## 2. 需要人工确认（soft）');
  lines.push('');
  if (soft.length === 0) {
    lines.push('无。');
  } else {
    lines.push('逐行判断：保留就留空，剔除就在最后一列写 `x`。');
    lines.push('');
    lines.push('| 国家 | 标题 | 来源 | 命中规则 | id | 剔除 |');
    lines.push('|---|---|---|---|---|---|');
    for (const row of soft) {
      lines.push(`| ${row.country} | ${row.title.replace(/\|/g, '\\|')} | ${row.source || '-'} | ${row.rules.join(', ')} | \`${row.id}\` |  |`);
    }
  }
  lines.push('');
  lines.push('## 3. 审完之后');
  lines.push('');
  lines.push('把勾掉的条目写进 `src/config/screen-decisions.json`，键是标题的 sha256 前 16 位（`screen-preview` 会随表输出）：');
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "decisions": [');
  lines.push('    { "id": "<hash>", "action": "exclude", "reason": "运营者判断", "decidedAt": "2026-10-28" }');
  lines.push('  ]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('## 4. 必须遵守的一条');
  lines.push('');
  lines.push('**剔除按事件簇整簇执行，不按条。** 只剔某国那一条，会让页面显示"这件事 12 国在报，该国没报"，');
  lines.push('而事实是该国报了、只是被剔掉了——这等于产品自己制造一条错误指控。详见 §7.6。');
  lines.push('');

  const outDir = path.resolve(ROOT, opts.out);
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `screen-${stamp}.md`);
  await writeFile(outPath, lines.join('\n'), 'utf8');

  console.log(`\n已写出：${path.relative(ROOT, outPath)}`);
  if (soft.length > 0) {
    console.log(`需要人工看 ${soft.length} 条。全部保留就不用改任何文件。`);
  }
}

main().catch((error) => {
  console.error('筛查失败：', error);
  process.exit(1);
});