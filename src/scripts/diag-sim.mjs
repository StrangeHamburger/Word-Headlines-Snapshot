#!/usr/bin/env node
/**
 * 相似度体检：给几组标题，直接打印余弦与各信号分量。
 *
 * 用于回答"这两条到底是模型觉得像，还是门槛太松"——校准前必须能分开这两件事。
 *
 *   node src/scripts/diag-sim.mjs --pair "Spain train crash kills 30" "Alexander brothers sentenced to 30 years"
 *   node src/scripts/diag-sim.mjs --file pairs.json      # [["a","b"], ...]
 *   node src/scripts/diag-sim.mjs --event evt_xxx        # 从 data/latest.json 取某簇的成员两两对比
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createEmbedder, cosine } from '../lib/embed.mjs';
import { buildEntityIndex, numbersOf, scorePair } from '../lib/cluster.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function parseArgs(argv) {
  const opts = { pairs: [], file: null, event: null, embed: 'e5', limit: 12 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pair') {
      const a = argv[++i];
      const b = argv[++i];
      if (a && b) opts.pairs.push([a, b]);
    } else if (arg === '--file') opts.file = argv[++i];
    else if (arg === '--event') opts.event = argv[++i];
    else if (arg === '--embed') opts.embed = argv[++i];
    else if (arg === '--limit') opts.limit = Number(argv[++i]) || 12;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node src/scripts/diag-sim.mjs [--pair A B]... [--file pairs.json] [--event evt_x] [--embed e5|stub]');
      process.exit(0);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const entitiesOf = buildEntityIndex(
    JSON.parse(await readFile(path.join(ROOT, 'src/config/entities.json'), 'utf8')),
  );

  let pairs = [...opts.pairs];

  if (opts.file) {
    const loaded = JSON.parse(await readFile(path.resolve(ROOT, opts.file), 'utf8'));
    pairs.push(...loaded.map((entry) => (Array.isArray(entry) ? entry : [entry.a, entry.b])));
  }

  if (opts.event) {
    const snapshot = JSON.parse(await readFile(path.join(ROOT, 'data/latest.json'), 'utf8'));
    const members = snapshot.countries
      .flatMap((country) => country.items.map((item) => ({ ...item, country: country.code })))
      .filter((item) => item.eventId === opts.event);
    if (members.length < 2) throw new Error(`事件 ${opts.event} 的成员不足 2 条`);
    const leader = members[0];
    for (const member of members.slice(1, opts.limit)) {
      pairs.push([leader.titleOriginal, member.titleOriginal]);
    }
    console.log(`事件 ${opts.event}：${members.length} 条，与首条对比 ${pairs.length} 组\n`);
  }

  if (pairs.length === 0) {
    console.error('没有可比的组；用 --pair / --file / --event 指定');
    process.exit(1);
  }

  const embedder = await createEmbedder({ provider: opts.embed });
  const flat = pairs.flat();
  const vectors = await embedder.embed(flat);

  console.log(`provider=${embedder.name}\n`);
  console.log('cos     entity  number  sim     gate  判定   A ↔ B');
  console.log('------  ------  ------  ------  -----  ----   ------------------------------');

  pairs.forEach(([a, b], index) => {
    const va = vectors[index * 2];
    const vb = vectors[index * 2 + 1];
    const cos = cosine(va, vb);
    const signals = scorePair(
      cos,
      { entities: entitiesOf(a), numbers: numbersOf(a) },
      { entities: entitiesOf(b), numbers: numbersOf(b) },
    );
    const verdict = signals.gate && signals.sim >= 0.8 ? '合并' : '分开';
    const line = [
      cos.toFixed(3).padEnd(6),
      signals.entityScore.toFixed(2).padEnd(8),
      signals.numberScore.toFixed(2).padEnd(8),
      signals.sim.toFixed(3).padEnd(8),
      String(signals.gate).padEnd(6),
      verdict.padEnd(5),
      `${a.slice(0, 34)} ↔ ${b.slice(0, 34)}`,
    ].join('  ');
    console.log(line);
  });
}

main().catch((error) => {
  console.error('体检失败：', error);
  process.exit(1);
});