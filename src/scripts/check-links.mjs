#!/usr/bin/env node
/**
 * 离线分析 probe 产出的链接：不解网络，只看载荷结构。
 *
 * 用途：探针报"解码 0%"时，先判断到底是
 *   (a) 载荷里有明文 URL 但解码器写错（纯 bug，好修）
 *   (b) 载荷里根本没有 URL，只有内嵌的 AU_ token（格式变了，要走 batchexecute）
 * 而不是对着 0% 猜。
 *
 *   node src/scripts/check-links.mjs --in data/probe/raw-latest.json
 *   node src/scripts/check-links.mjs --in <file> --samples 5
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { classifyLink, tryDecodeOldLink, extractInnerToken, LINK_FORM } from '../lib/rss.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function parseArgs(argv) {
  const opts = { input: 'data/probe/raw-latest.json', samples: 3 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--in') opts.input = argv[++i] || opts.input;
    else if (arg === '--samples') opts.samples = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === '--help' || arg === '-h') {
      console.log(`
用法: node src/scripts/check-links.mjs [选项]

  --in <file>       probe 的 raw JSON，默认 data/probe/raw-latest.json
  --samples <n>     打印多少条样本的载荷结构，默认 3
`);
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

/** 把载荷前若干字节渲染成 hex + 可读字符，便于肉眼判断结构。 */
function previewPayload(link, maxBytes = 96) {
  const match = /\/rss\/articles\/([^/?#]+)/i.exec(link);
  if (!match) return null;
  const id = match[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = id + '='.repeat((4 - (id.length % 4)) % 4);
  const bytes = Buffer.from(padded, 'base64');
  if (bytes.length === 0) return null;

  const head = bytes.subarray(0, maxBytes);
  const hex = [...head].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const ascii = [...head]
    .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
    .join('');
  return { length: bytes.length, hex, ascii };
}

async function main() {
  const opts = parseArgs(process.argv);
  const inputPath = path.resolve(ROOT, opts.input);

  let raw;
  try {
    raw = JSON.parse(await readFile(inputPath, 'utf8'));
  } catch {
    console.error(`读不到 ${path.relative(ROOT, inputPath)}。先跑探针，或从 Actions artifact 解压出来。`);
    process.exit(1);
  }

  const items = [];
  for (const country of raw.countries || []) {
    for (const item of country.items || []) {
      if (item.link) items.push({ country: country.code, title: item.title, link: item.link });
    }
  }

  if (items.length === 0) {
    console.error('里面没有条目。确认这是 probe 的 raw JSON，而不是报告 md。');
    process.exit(1);
  }

  const stats = {
    total: items.length,
    plain: 0,
    wrappedAu: 0,
    auDirect: 0,
    unknown: 0,
    external: 0,
    invalid: 0,
  };
  const samples = [];

  for (const item of items) {
    const form = classifyLink(item.link);
    if (form === LINK_FORM.EXTERNAL) {
      stats.external += 1;
      continue;
    }
    if (form === LINK_FORM.INVALID) {
      stats.invalid += 1;
      continue;
    }
    if (form === LINK_FORM.NEW_AU) {
      stats.auDirect += 1;
      if (samples.length < opts.samples) samples.push({ ...item, form: 'direct-au', token: null });
      continue;
    }
    if (form !== LINK_FORM.OLD_BASE64) {
      stats.unknown += 1;
      if (samples.length < opts.samples) samples.push({ ...item, form: 'other', token: null });
      continue;
    }

    const url = tryDecodeOldLink(item.link);
    if (url) {
      stats.plain += 1;
      continue;
    }
    const token = extractInnerToken(item.link);
    if (token) {
      stats.wrappedAu += 1;
      if (samples.length < opts.samples) samples.push({ ...item, form: 'wrapped-au', token });
      continue;
    }
    stats.unknown += 1;
    if (samples.length < opts.samples) samples.push({ ...item, form: 'unknown', token: null });
  }

  const pct = (value) => `${Math.round((value / stats.total) * 100)}%`;

  console.log(`文件：${path.relative(ROOT, inputPath)}`);
  console.log(`条目：${stats.total}`);
  console.log('');
  console.log('形态                条数     占比');
  console.log('------------------  ------  ------');
  console.log(`明文 URL 可解       ${String(stats.plain).padEnd(8)}${pct(stats.plain)}`);
  console.log(`CBMi 内嵌 AU_       ${String(stats.wrappedAu).padEnd(8)}${pct(stats.wrappedAu)}`);
  console.log(`直接 AU_            ${String(stats.auDirect).padEnd(8)}${pct(stats.auDirect)}`);
  console.log(`完全无法识别        ${String(stats.unknown).padEnd(8)}${pct(stats.unknown)}`);
  if (stats.external) console.log(`直连外站（非 Google） ${String(stats.external).padEnd(6)}${pct(stats.external)}`);
  if (stats.invalid) console.log(`无效                ${String(stats.invalid).padEnd(8)}${pct(stats.invalid)}`);
  console.log('');

  // 结论
  if (stats.plain === stats.total) {
    console.log('结论：全部可离线还原。解码器没问题。');
  } else if (stats.wrappedAu > 0 && stats.plain === 0) {
    console.log('结论：载荷里没有明文 URL，只有内嵌 AU_ token。');
    console.log('      这不是解码器 bug——必须 POST batchexecute 才能还原真实地址（§6.4.1 第 3 步）。');
    console.log('      按 D25：解析失败的条目一律不渲染为链接，或先做 links-new.mjs。');
  } else if (stats.wrappedAu > 0) {
    console.log('结论：混合形态。一部分可离线还原，另一部分需要 batchexecute。');
  } else if (stats.unknown > 0) {
    console.log('结论：有无法识别的载荷。看下面的样本，可能需要新增解码分支。');
  }

  if (samples.length > 0) {
    console.log('');
    console.log('--- 样本载荷结构 ---');
    for (const sample of samples) {
      console.log('');
      console.log(`[${sample.form}] ${sample.country} :: ${String(sample.title).slice(0, 70)}`);
      console.log(`  link: ${sample.link.slice(0, 120)}${sample.link.length > 120 ? '…' : ''}`);
      if (sample.token) console.log(`  inner token: ${sample.token.slice(0, 40)}…（长度 ${sample.token.length}）`);
      const preview = previewPayload(sample.link);
      if (preview) {
        console.log(`  payload: ${preview.length} 字节`);
        console.log(`  hex : ${preview.hex}`);
        console.log(`  ascii: ${preview.ascii}`);
      }
    }
  }
}

main().catch((error) => {
  console.error('分析失败：', error);
  process.exit(1);
});