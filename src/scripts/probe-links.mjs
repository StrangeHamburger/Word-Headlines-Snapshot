#!/usr/bin/env node
/**
 * 验证「新格式链接能否还原」——只做实测，不做假设。
 *
 *   node src/scripts/probe-links.mjs --in data/probe/raw-latest.json --count 5
 *   node src/scripts/probe-links.mjs --in <file> --count 8 --single   # 逐条请求，排除批量顺序干扰
 *   node src/scripts/probe-links.mjs --in <file> --dump
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { articleIdOf, parseSigTs, buildFreq, parseBatchResponse } from '../lib/links-new.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function parseArgs(argv) {
  const opts = { input: 'data/probe/raw-latest.json', count: 5, dump: false, single: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--in') opts.input = argv[++i] || opts.input;
    else if (arg === '--count') opts.count = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === '--dump') opts.dump = true;
    else if (arg === '--single') opts.single = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node src/scripts/probe-links.mjs [--in file] [--count n] [--single] [--dump]');
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

/** 页面自己的标题，用来确认"这个页面到底是不是这条文章"。 */
function pageTitle(html) {
  const match = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
}

function countMatches(text, pattern) {
  const matches = String(text).match(new RegExp(pattern, 'g'));
  return matches ? matches.length : 0;
}

async function fetchPage(articleId) {
  const response = await fetch(`https://news.google.com/rss/articles/${articleId}`, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  const text = await response.text();
  return { status: response.status, text, finalUrl: response.url };
}

async function batchResolve(entries) {
  const body = buildFreq(entries);
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
  return { status: response.status, text, urls: parseBatchResponse(text), requestBytes: body.length };
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
  console.log(`模式：${opts.single ? '逐条请求（排除批量顺序干扰）' : '一次批量 POST'}`);
  console.log('');

  const prepared = [];
  for (const item of items) {
    const articleId = articleIdOf(item.link);
    let line = `[${item.country}] ${articleId ? `${articleId.slice(0, 14)}…(${articleId.length})` : 'null'}`;
    try {
      const page = await fetchPage(articleId);
      const sigs = countMatches(page.text, 'data-n-a-sg');
      const parsed = parseSigTs(page.text);
      const title = pageTitle(page.text);
      line += `  page=${page.status} ${Math.round(page.text.length / 1024)}KB sigs=${sigs}`;
      if (parsed) {
        line += ` sig=${parsed.signature.slice(0, 12)}… ts=${parsed.timestamp}`;
        prepared.push({ ...item, articleId, ...parsed });
      } else {
        line += ' sig=未找到';
      }
      console.log(line);
      console.log(`     页面标题：${truncate(title || '(无)', 90)}`);
      console.log(`     RSS 标题：${truncate(item.title, 90)}`);
      if (opts.dump && sigs > 1) {
        const all = [...page.text.matchAll(/data-n-a-sg="([^"]+)"/g)].map((m) => m[1].slice(0, 12));
        console.log(`     [dump] 全部 sig：${all.join(', ')}`);
      }
    } catch (error) {
      console.log(`${line}  ERR ${error?.cause?.code || error?.message}`);
    }
  }

  console.log('');
  console.log(`签名/时间戳成功率：${prepared.length}/${items.length}`);
  if (prepared.length === 0) {
    console.log('结论：拿不到 data-n-a-sg/ts，这条路走不通。');
    process.exit(2);
  }

  console.log('');
  let ok = 0;

  if (opts.single) {
    // 逐条：彻底排除"顺序错位"这个变量
    for (const entry of prepared) {
      const result = await batchResolve([entry]);
      const url = result.urls.find(Boolean) || null;
      if (url) {
        ok += 1;
        let host = '';
        try {
          host = new URL(url).host;
        } catch {
          host = '(解析失败)';
        }
        console.log(`✅ [${entry.country}] → ${host}   HTTP ${result.status}`);
        console.log(`   请求：${truncate(entry.title, 62)}`);
        console.log(`   落地：${truncate(url, 130)}`);
      } else {
        console.log(`❌ [${entry.country}] 没抠出 URL   HTTP ${result.status}`);
        console.log(`   请求：${truncate(entry.title, 62)}`);
        if (opts.dump) console.log(`   [dump] ${truncate(result.text, 400)}`);
      }
    }
  } else {
    const result = await batchResolve(prepared);
    console.log(`batchexecute HTTP ${result.status}，响应 ${result.text.length} 字节`);
    console.log(
      `请求 ${prepared.length} 条，解析出 ${result.urls.length} 个元素（其中非空 ${result.urls.filter(Boolean).length} 个）`,
    );
    if (result.urls.length !== prepared.length) {
      console.log('⚠️ 元素数与请求数不一致——说明响应里混了别的元素，不能按下标配对。');
    }
    console.log('');
    prepared.forEach((entry, index) => {
      const url = result.urls[index] || null;
      if (url) {
        ok += 1;
        let host = '';
        try {
          host = new URL(url).host;
        } catch {
          host = '(解析失败)';
        }
        console.log(`✅ [${entry.country}] → ${host}`);
        console.log(`   请求：${truncate(entry.title, 62)}`);
        console.log(`   落地：${truncate(url, 130)}`);
      } else {
        console.log(`❌ [${entry.country}] 第 ${index} 个元素为空`);
        console.log(`   请求：${truncate(entry.title, 62)}`);
      }
    });
  }

  const rate = Math.round((ok / prepared.length) * 100);
  console.log('');
  console.log(`还原成功率：${ok}/${prepared.length}（${rate}%）`);
  process.exitCode = rate >= 95 ? 0 : 3;
}

main().catch((error) => {
  console.error('探测失败：', error);
  process.exit(1);
});