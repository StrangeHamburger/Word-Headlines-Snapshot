#!/usr/bin/env node
/**
 * 验证「新格式链接能否还原」——只做实测，不做假设。
 *
 * 分三步打印每一步的真实结果，失败时 dump 原始响应片段，
 * 这样一次运行就能判断该改哪里，不用来回猜。
 *
 *   node src/scripts/probe-links.mjs --in data/probe/raw-latest.json --count 5
 *   node src/scripts/probe-links.mjs --in <file> --count 8 --dump
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { articleIdOf, parseSigTs, buildFreq, extractUrl } from '../lib/links-new.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function parseArgs(argv) {
  const opts = { input: 'data/probe/raw-latest.json', count: 5, dump: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--in') opts.input = argv[++i] || opts.input;
    else if (arg === '--count') opts.count = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === '--dump') opts.dump = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node src/scripts/probe-links.mjs [--in file] [--count n] [--dump]');
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

function truncate(text, length = 700) {
  const value = String(text ?? '');
  return value.length > length ? `${value.slice(0, length)}…（共 ${value.length} 字符）` : value;
}

async function main() {
  const opts = parseArgs(process.argv);
  const inputPath = path.resolve(ROOT, opts.input);
  const raw = JSON.parse(await readFile(inputPath, 'utf8'));

  const items = [];
  for (const country of raw.countries || []) {
    for (const item of country.items || []) {
      if (item.link && /\/rss\/articles\//.test(item.link)) {
        items.push({ country: country.code, title: item.title, link: item.link });
      }
      if (items.length >= opts.count) break;
    }
    if (items.length >= opts.count) break;
  }

  if (items.length === 0) {
    console.error('raw JSON 里没有 /rss/articles/ 链接');
    process.exit(1);
  }

  console.log(`样本 ${items.length} 条，来自 ${path.relative(ROOT, inputPath)}`);
  console.log('');

  const prepared = [];
  let sigOk = 0;

  for (const item of items) {
    const articleId = articleIdOf(item.link);
    const line = { country: item.country, articleId: articleId ? `${articleId.slice(0, 18)}…(${articleId.length})` : 'null' };

    // 步骤 1：拿签名与时间戳
    try {
      const response = await fetch(`https://news.google.com/rss/articles/${articleId}`, {
        headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(20000),
        redirect: 'manual',
      });
      const text = await response.text();
      const parsed = parseSigTs(text);
      line.pageStatus = response.status;
      line.pageBytes = text.length;
      if (parsed) {
        line.sig = `${parsed.signature.slice(0, 16)}…(${parsed.signature.length})`;
        line.ts = parsed.timestamp;
        sigOk += 1;
        prepared.push({ ...item, articleId, ...parsed });
      } else {
        line.sig = '未找到';
        if (opts.dump) {
          const hint = /data-n-a-[a-z]+/i.exec(text);
          console.log(`  [dump] 页面里 data-n-a-* 的存在性：${hint ? hint[0] : '完全没有'}`);
          console.log(`  [dump] location: ${response.headers.get('location') || 'none'}`);
          console.log(`  [dump] head: ${truncate(text.replace(/\s+/g, ' '), 400)}`);
        }
      }
    } catch (error) {
      line.pageStatus = `ERR ${error?.cause?.code || error?.message}`;
      line.sig = '-';
    }

    console.log(
      `[${line.country}] ${line.articleId}  page=${line.pageStatus}  ${line.pageBytes || 0}B  sig=${line.sig}${line.ts ? `  ts=${line.ts}` : ''}`,
    );
  }

  console.log('');
  console.log(`签名/时间戳成功率：${sigOk}/${items.length}`);

  if (prepared.length === 0) {
    console.log('');
    console.log('结论：拿不到 data-n-a-sg / data-n-a-ts，说明这条路走不通，');
    console.log('      Google 已经改了文章页结构，需要重新找入口。');
    process.exit(2);
  }

  // 步骤 2：批量换 URL
  console.log('');
  const body = buildFreq(prepared);
  console.log(`batchexecute 请求体 ${body.length} 字节（${prepared.length} 条）`);

  const response = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'accept-language': 'en-US,en;q=0.9',
    },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  console.log(`batchexecute HTTP ${response.status}，响应 ${text.length} 字节`);

  if (opts.dump && response.status !== 200) {
    console.log(`[dump] ${truncate(text)}`);
  }

  if (response.status !== 200) {
    console.log('');
    console.log('结论：batchexecute 被拒。可能需要对文章页带 cookie/sig，或换了 RPC id。');
    process.exit(2);
  }

  // 步骤 3：逐条抠 URL
  const segments = String(text)
    .replace(/^\)\]\}'/, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('['));

  console.log(`响应切成 ${segments.length} 段`);
  console.log('');

  let ok = 0;
  prepared.forEach((entry, index) => {
    const url = extractUrl(segments[index] ?? text);
    if (url) {
      ok += 1;
      let host = '';
      try {
        host = new URL(url).host;
      } catch {
        host = '(无法解析)';
      }
      console.log(`✅ [${entry.country}] → ${host}`);
      console.log(`   ${truncate(url, 140)}`);
    } else {
      console.log(`❌ [${entry.country}] 没抠出 URL`);
      if (opts.dump) console.log(`   [dump] ${truncate(segments[index] ?? text, 500)}`);
    }
  });

  const rate = Math.round((ok / prepared.length) * 100);
  console.log('');
  console.log(`还原成功率：${ok}/${prepared.length}（${rate}%）`);
  console.log('');
  if (rate >= 95) {
    console.log('结论：达标（D25 要求 ≥95%）。可以把这条路径接进 run.mjs。');
  } else if (rate > 0) {
    console.log('结论：部分成功，需要看失败样本的响应结构。加 --dump 再跑一次。');
    process.exitCode = 3;
  } else {
    console.log('结论：一条都没成。加 --dump 看响应结构再改解析。');
    process.exitCode = 3;
  }
}

main().catch((error) => {
  console.error('探测失败：', error);
  process.exit(1);
});