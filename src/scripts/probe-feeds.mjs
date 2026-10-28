#!/usr/bin/env node
/**
 * feed 探测：验证"放行条件 1"。
 *
 * 零依赖，任意装了 Node >= 20 的机器可直接运行：
 *   node src/scripts/probe-feeds.mjs                 # 15 个正式国家
 *   node src/scripts/probe-feeds.mjs --all           # 含 5 个备用国家
 *   node src/scripts/probe-feeds.mjs --head          # 额外探测新格式链接能否还原原始 URL
 *   node src/scripts/probe-feeds.mjs --fixture tests/fixtures/feeds   # 离线自测
 *
 * 产出：
 *   data/probe/raw-<stamp>.json   全部条目原文，供 make-pairs 使用
 *   data/probe/raw-latest.json    同上，固定文件名
 *   docs/probe-report.md          人读报告 + 放行判断
 *
 * 退出码：0 = 至少一国有数据；2 = 全灭；1 = 参数/配置错误。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  parseRss,
  classifyLink,
  tryDecodeOldLink,
  extractInnerToken,
  splitTitleSuffix,
  normalizeTitle,
  LINK_FORM,
} from '../lib/rss.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UA = 'WorldHeadlinesSnapshot-Probe/1.0 (+https://example.com/about)';
const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const opts = {
    all: false,
    head: false,
    headMax: 3,
    concurrency: 4,
    fixture: '',
    only: [],
    out: 'data/probe',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') opts.all = true;
    else if (arg === '--head') opts.head = true;
    else if (arg === '--head-max') opts.headMax = Number(argv[++i]) || 3;
    else if (arg === '--concurrency') opts.concurrency = Math.max(1, Number(argv[++i]) || 4);
    else if (arg === '--fixture') opts.fixture = argv[++i] || '';
    else if (arg === '--only') opts.only = String(argv[++i] || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (arg === '--out') opts.out = argv[++i] || 'data/probe';
    else if (arg === '--help' || arg === '-h') {
      console.log(`
用法: node src/scripts/probe-feeds.mjs [选项]

  --all                 同时探测备用池国家
  --only US,GB          只探测指定国家
  --head                对新格式链接做 HEAD 探测（慢，每国最多 --head-max 次）
  --head-max <n>        HEAD 探测上限，默认 3
  --concurrency <n>     并发数，默认 4
  --fixture <dir>       离线模式：从目录读取 <CODE>.xml，不发网络请求
  --out <dir>           输出目录，默认 data/probe
`);
      process.exit(0);
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

// ---------------------------------------------------------------- helpers

function displayWidth(str) {
  let width = 0;
  for (const char of String(str)) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char) ? 2 : 1;
  }
  return width;
}

function pad(str, target, align = 'left') {
  const value = String(str);
  const fill = ' '.repeat(Math.max(0, target - displayWidth(value)));
  return align === 'right' ? fill + value : value + fill;
}

export function feedUrl(country) {
  const { hl, gl, ceid } = country.source;
  return `https://news.google.com/rss?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;
}

function decodeBody(buffer, contentType) {
  let charset = '';
  const headerMatch = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType || '');
  if (headerMatch) charset = headerMatch[1];
  if (!charset) {
    const head = buffer.subarray(0, 220).toString('latin1');
    const declMatch = /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(head);
    if (declMatch) charset = declMatch[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

async function fetchOnce(url, { method = 'GET', redirect = 'follow' } = {}) {
  const response = await fetch(url, {
    method,
    redirect,
    headers: {
      'user-agent': UA,
      accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.1',
      'accept-language': 'en;q=0.8,*;q=0.5',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return response;
}

/** 把 fetch 的错误压成一行可用信息：原因码 + 消息。 */
function formatError(error) {
  const code = error?.cause?.code || error?.code || '';
  const message = error?.message || String(error);
  return code ? `${code}: ${message}` : message;
}

/**
 * 挂了 VPN 仍然 fetch failed 的最常见原因：Node 的 fetch 默认不读代理环境变量。
 * 与其让人对着 "fetch failed" 猜，不如提前说清楚。
 */
function warnAboutProxy() {
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return;
  if (process.env.NODE_USE_ENV_PROXY === '1') return;

  console.warn(`注意：检测到代理环境变量 ${proxy}`);
  console.warn('     但 Node 的 fetch 默认不读取 HTTP(S)_PROXY，代理对这个脚本不生效。');
  console.warn('     二选一：① 让 VPN 走 TUN / 全局（虚拟网卡）模式；');
  console.warn('            ② Node ≥ 24 时设 NODE_USE_ENV_PROXY=1。');
  console.warn('');
}

/** 探测一个国家的 feed。fixture 模式下读本地文件。 */
async function probeCountry(country, opts) {
  const startedAt = Date.now();
  const result = {
    code: country.code,
    name: country.name,
    region: country.region,
    lang: country.lang,
    url: feedUrl(country),
    mode: opts.fixture ? 'fixture' : 'network',
    ok: false,
    httpStatus: null,
    contentType: '',
    bytes: 0,
    ms: 0,
    itemCount: 0,
    rawItemCount: 0,
    channelTitle: '',
    items: [],
    error: null,
    head: null,
    skipped: false,
  };

  let xml = '';
  try {
    if (opts.fixture) {
      const file = path.join(ROOT, opts.fixture, `${country.code}.xml`);
      const buffer = await readFile(file);
      result.bytes = buffer.length;
      result.contentType = 'application/xml (fixture)';
      xml = decodeBody(buffer, '');
      result.httpStatus = 200;
    } else {
      let lastError = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const response = await fetchOnce(result.url);
          result.httpStatus = response.status;
          result.contentType = response.headers.get('content-type') || '';
          const buffer = Buffer.from(await response.arrayBuffer());
          result.bytes = buffer.length;
          if (!response.ok) {
            lastError = new Error(`HTTP ${response.status}`);
            if (response.status < 500 && response.status !== 429) break;
            continue;
          }
          xml = decodeBody(buffer, result.contentType);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 900 * attempt));
        }
      }
      if (lastError) throw lastError;
    }

    const parsed = parseRss(xml);
    result.channelTitle = parsed.channelTitle;
    result.rawItemCount = parsed.rawItemCount;
    result.items = parsed.items.map((item) => {
      const linkForm = classifyLink(item.link);
      const decodedUrl = linkForm === LINK_FORM.OLD_BASE64 ? tryDecodeOldLink(item.link) : null;
      return {
        ...item,
        linkForm,
        decodedUrl,
        innerToken: linkForm === LINK_FORM.OLD_BASE64 && !decodedUrl ? extractInnerToken(item.link) : null,
      };
    });
    result.itemCount = result.items.length;
    result.ok = result.itemCount > 0;
  } catch (error) {
    result.error = formatError(error);
    result.ok = false;
  }

  result.ms = Date.now() - startedAt;
  return result;
}

/** 新格式链接：HEAD 看 Location 是否指向非 Google 域名。 */
async function headProbe(country, opts) {
  const targets = country.items
    .filter((item) => item.linkForm === LINK_FORM.NEW_AU)
    .slice(0, opts.headMax);

  let resolved = 0;
  const samples = [];
  for (const item of targets) {
    try {
      const response = await fetchOnce(item.link, { method: 'HEAD', redirect: 'manual' });
      const location = response.headers.get('location') || '';
      let host = '';
      try {
        host = new URL(location).hostname;
      } catch {
        host = '';
      }
      const usable = Boolean(host) && !/news\.google\.com$/i.test(host);
      if (usable) resolved += 1;
      samples.push({ status: response.status, locationHost: host, usable });
    } catch (error) {
      samples.push({ error: error.message });
    }
  }
  return { tried: targets.length, resolved, samples };
}

// ---------------------------------------------------------------- stats

function computeStats(country) {
  const items = country.items;
  const total = items.length;
  if (total === 0) {
    return {
      total: 0,
      uniqueRatio: 0,
      pubDateRatio: 0,
      sourceRatio: 0,
      descriptionRatio: 0,
      suffixRatio: 0,
      linkForms: {},
      oldDecode: { tried: 0, ok: 0, ratio: 0 },
      linkModes: { plain: 0, wrappedAu: 0, auDirect: 0, unknown: 0 },
    };
  }

  const uniqueTitles = new Set(items.map((item) => normalizeTitle(item.title))).size;
  const withPubDate = items.filter((item) => item.publishedAt).length;
  const withSource = items.filter((item) => item.source).length;
  const withDescription = items.filter((item) => item.hasDescription).length;
  const withSuffix = items.filter((item) => splitTitleSuffix(item.title, item.source).suffix).length;

  const linkForms = {};
  for (const item of items) linkForms[item.linkForm] = (linkForms[item.linkForm] || 0) + 1;

  const oldLinks = items.filter((item) => item.linkForm === LINK_FORM.OLD_BASE64);
  const oldOk = oldLinks.filter((item) => item.decodedUrl).length;
  const wrappedAu = oldLinks.filter((item) => !item.decodedUrl && item.innerToken).length;
  const unknownOld = oldLinks.length - oldOk - wrappedAu;
  const auDirect = items.filter((item) => item.linkForm === LINK_FORM.NEW_AU).length;

  return {
    total,
    uniqueRatio: uniqueTitles / total,
    pubDateRatio: withPubDate / total,
    sourceRatio: withSource / total,
    descriptionRatio: withDescription / total,
    suffixRatio: withSuffix / total,
    linkForms,
    oldDecode: {
      tried: oldLinks.length,
      ok: oldOk,
      ratio: oldLinks.length ? oldOk / oldLinks.length : 0,
    },
    linkModes: { plain: oldOk, wrappedAu, auDirect, unknown: unknownOld },
  };
}

function verdictOf(country, stats) {
  if (!country.ok) return 'FAIL';
  if (stats.total >= 15) return 'OK';
  if (stats.total >= 12) return 'THIN';
  return 'LOW';
}

// ---------------------------------------------------------------- report

function renderConsoleTable(rows) {
  const header = [
    ['code', 6],
    ['国家', 12],
    ['http', 6],
    ['条目', 6],
    ['唯一', 6],
    ['时间', 6],
    ['来源', 6],
    ['后缀', 6],
    ['明文/包装/AU', 14],
    ['解码', 6],
    ['ms', 8],
    ['判定', 6],
  ];

  const lines = [];
  lines.push(header.map(([label, width]) => pad(label, width)).join(' '));
  lines.push(header.map(([, width]) => '-'.repeat(width)).join(' '));

  for (const row of rows) {
    const stats = row.stats;
    const modes = stats.linkModes || { plain: 0, wrappedAu: 0, auDirect: 0, unknown: 0 };
    lines.push(
      [
        pad(row.country.code, 6),
        pad(row.country.name, 12),
        pad(row.country.httpStatus ?? '-', 6, 'right'),
        pad(stats.total, 6, 'right'),
        pad(`${Math.round(stats.uniqueRatio * 100)}%`, 6, 'right'),
        pad(`${Math.round(stats.pubDateRatio * 100)}%`, 6, 'right'),
        pad(`${Math.round(stats.sourceRatio * 100)}%`, 6, 'right'),
        pad(`${Math.round(stats.suffixRatio * 100)}%`, 6, 'right'),
        pad(`${modes.plain}/${modes.wrappedAu}/${modes.auDirect}`, 14, 'right'),
        pad(stats.oldDecode.tried ? `${Math.round(stats.oldDecode.ratio * 100)}%` : '-', 6, 'right'),
        pad(row.country.ms, 8, 'right'),
        pad(row.verdict, 6),
      ].join(' '),
    );
  }
  return lines.join('\n');
}

function renderMarkdown(rows, opts, stamp) {
  const activeRows = rows.filter((row) => !row.country.skipped);
  const ok = activeRows.filter((row) => row.verdict === 'OK').length;
  const thin = activeRows.filter((row) => row.verdict === 'THIN').length;
  const low = activeRows.filter((row) => row.verdict === 'LOW').length;
  const fail = activeRows.filter((row) => row.verdict === 'FAIL').length;

  const validEnough = activeRows.filter((row) => row.stats.total >= 12).length;
  const denominator = activeRows.length;

  const totalItems = activeRows.reduce((sum, row) => sum + row.stats.total, 0);
  const weighted = (pick) => {
    const items = activeRows.reduce((sum, row) => sum + row.stats.total, 0);
    if (!items) return 0;
    return activeRows.reduce((sum, row) => sum + pick(row.stats) * row.stats.total, 0) / items;
  };

  const allLinkForms = {};
  for (const row of activeRows) {
    for (const [form, count] of Object.entries(row.stats.linkForms)) {
      allLinkForms[form] = (allLinkForms[form] || 0) + count;
    }
  }
  const oldTried = activeRows.reduce((sum, row) => sum + row.stats.oldDecode.tried, 0);
  const oldOk = activeRows.reduce((sum, row) => sum + row.stats.oldDecode.ok, 0);

  const lines = [];
  lines.push('# feed 探测报告');
  lines.push('');
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 运行模式：${opts.fixture ? `离线 fixture（${opts.fixture}）` : '真实网络'}`);
  lines.push(`- 国家数：${denominator}${opts.all ? '（含备用池）' : '（仅正式池）'}`);
  lines.push(`- HEAD 探测：${opts.head ? `开启（每国上限 ${opts.headMax}）` : '关闭'}`);
  lines.push(`- 快照标记：${stamp}`);
  lines.push('');
  lines.push('## 1. 逐国结果');
  lines.push('');
  lines.push('| code | 国家 | 地区 | HTTP | 条目 | 原始 item | 唯一率 | 时间 | 来源 | 后缀 | 明文/包装/AU | 明文解码 | ms | 判定 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');

  for (const row of rows) {
    const { country, stats, verdict } = row;
    if (country.skipped) {
      lines.push(`| ${country.code} | ${country.name} | ${country.region} | - | - | - | - | - | - | - | - | - | - | 跳过 |`);
      continue;
    }
    const modes = stats.linkModes || { plain: 0, wrappedAu: 0, auDirect: 0, unknown: 0 };
    lines.push(
      `| ${country.code} | ${country.name} | ${country.region} | ${country.httpStatus ?? '-'} | ${stats.total} | ${country.rawItemCount} | ${Math.round(stats.uniqueRatio * 100)}% | ${Math.round(stats.pubDateRatio * 100)}% | ${Math.round(stats.sourceRatio * 100)}% | ${Math.round(stats.suffixRatio * 100)}% | ${modes.plain}/${modes.wrappedAu}/${modes.auDirect} | ${stats.oldDecode.tried ? `${Math.round(stats.oldDecode.ratio * 100)}%` : '-'} | ${country.ms} | ${verdict} |`,
    );
  }

  lines.push('');
  lines.push('判定口径：`OK` = ≥15 条；`THIN` = 12–14 条；`LOW` = 1–11 条；`FAIL` = 0 条或请求失败。');
  lines.push('');
  lines.push('## 2. 放行判断');
  lines.push('');
  lines.push('| 检查项 | 结果 | 说明 |');
  lines.push('|---|---|---|');
  lines.push(`| 有数据国家数 | ${validEnough}/${denominator} | 达到 \`MIN_ITEMS_FULL\`(12) 的国家数 |`);
  lines.push(`| ≥15 条的国家 | ${ok}/${denominator} | 完整样本，可参与"未包含"判断 |`);
  lines.push(`| 12–14 条 | ${thin} | \`partialSample=true\`，仍可输出未包含 |`);
  lines.push(`| 1–11 条 | ${low} | 不参与未包含与偏移 |`);
  lines.push(`| 0 条或失败 | ${fail} | 需要换源或换国 |`);
  lines.push(`| 条目总数 | ${totalItems} | — |`);
  lines.push(`| \`pubDate\` 覆盖 | ${Math.round(weighted((s) => s.pubDateRatio) * 100)}% | 缺失时排序回退 RSS 顺序 |`);
  lines.push(`| \`<source>\` 覆盖 | ${Math.round(weighted((s) => s.sourceRatio) * 100)}% | 缺失时需要从标题后缀剥离 |`);
  lines.push(`| 标题" - 发布方"后缀 | ${Math.round(weighted((s) => s.suffixRatio) * 100)}% | 用于校验 §6.3 的剥离假设 |`);
  const allModes = activeRows.reduce(
    (acc, row) => {
      const m = row.stats.linkModes || {};
      acc.plain += m.plain || 0;
      acc.wrappedAu += m.wrappedAu || 0;
      acc.auDirect += m.auDirect || 0;
      acc.unknown += m.unknown || 0;
      return acc;
    },
    { plain: 0, wrappedAu: 0, auDirect: 0, unknown: 0 },
  );
  lines.push(`| 明文 URL 解码率 | ${oldTried ? `${Math.round((oldOk / oldTried) * 100)}%（${oldOk}/${oldTried}）` : '无 CBMi 链接'} | 载荷里直接含 \`http\`，可离线还原 |`);
  lines.push(`| **CBMi 内嵌 \`AU_\` token** | **${allModes.wrappedAu} 条** | **>0 说明这些链接必须走 \`batchexecute\` 才能拿到真实地址（§6.4.1 第 3 步），本地解不出属正常** |`);
  lines.push(`| 直接 \`AU_\` 链接 | ${allModes.auDirect} 条 | 已是新格式，无需解包装 |`);
  lines.push(`| 完全无法识别 | ${allModes.unknown} 条 | 载荷里既无 \`http\` 也无 \`AU_\`，需要人工看样本 |`);

  const formEntries = Object.entries(allLinkForms).sort((a, b) => b[1] - a[1]);
  lines.push('');
  lines.push('## 3. 链接格式分布');
  lines.push('');
  lines.push('| 形态 | 条数 | 含义 |');
  lines.push('|---|---|---|');
  const meaning = {
    [LINK_FORM.OLD_BASE64]: '旧格式 `CBMi...`，载荷内含原始 URL，可离线解码',
    [LINK_FORM.NEW_AU]: '新格式 `AU_...`，需请求 Google 内部接口或 HEAD 跳转才能还原',
    [LINK_FORM.EXTERNAL]: '直连原始域名，无跳转',
    [LINK_FORM.GN_UNKNOWN]: 'Google 域名但路径不认识，格式可能又变了',
    [LINK_FORM.INVALID]: '空链接或非法 URL',
  };
  if (formEntries.length === 0) {
    lines.push('| - | 0 | 无数据 |');
  } else {
    for (const [form, count] of formEntries) {
      lines.push(`| ${form} | ${count} | ${meaning[form] || '-'} |`);
    }
  }

  lines.push('');
  lines.push('## 4. 新格式 HEAD 探测');
  lines.push('');
  if (!opts.head) {
    lines.push('本次未开启（未传 `--head`）。若 §2 的"内嵌 `AU_` token"条数为 0，则不需要它；若 > 0，需用它判断能否靠 HEAD 跳转还原。');
  } else {
    lines.push('| code | 探测数 | 可还原 | 样本 |');
    lines.push('|---|---|---|---|');
    for (const row of activeRows) {
      if (!row.country.head || row.country.head.tried === 0) continue;
      const sample = row.country.head.samples
        .map((s) => (s.error ? `err:${s.error}` : `${s.status}→${s.locationHost || '无 Location'}`))
        .join('; ');
      lines.push(`| ${row.country.code} | ${row.country.head.tried} | ${row.country.head.resolved} | ${sample} |`);
    }
  }

  lines.push('');
  lines.push('## 5. 与设计文档的对应关系');
  lines.push('');
  lines.push('- 本报告直接验证 `docs/02-detailed-design.md` §5.2（15 国 `ceid` 是否有效）与 §6.4（链接格式与解码路径）。');
  lines.push('- 若"有数据国家数" < 15，按 §5.2.1 从备用池替换，不要缩减国家数。');
  lines.push('- 若"条目总数"足够但单国 < 12，先查是否 RSS 返回结构变化（看 `原始 item` 列与 `条目` 列的差值）。');
  lines.push('- 报告不构成对内容质量的判断，只反映抓取可行性。');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv);

  const configPath = path.join(ROOT, 'src/config/feeds.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const pool = [...config.countries, ...(opts.all ? config.alternates : [])];
  const selected = opts.only.length
    ? pool.filter((country) => opts.only.includes(country.code))
    : pool;

  if (selected.length === 0) {
    console.error('没有匹配的国家，检查 --only 参数。');
    process.exit(1);
  }

  console.log(`探测 ${selected.length} 个国家${opts.fixture ? `（离线 fixture: ${opts.fixture}）` : ''}…\n`);
  if (!opts.fixture) warnAboutProxy();

  // 并发池
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(opts.concurrency, selected.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= selected.length) return;
      const country = selected[index];
      if (opts.fixture) {
        const exists = await readFile(path.join(ROOT, opts.fixture, `${country.code}.xml`)).then(
          () => true,
          () => false,
        );
        if (!exists) {
          results[index] = { country: { ...country, skipped: true, ok: false }, stats: null, verdict: 'SKIP' };
          continue;
        }
      }
      const probed = await probeCountry(country, opts);
      results[index] = { country: probed, stats: computeStats(probed), verdict: '' };
    }
  });
  await Promise.all(workers);

  for (const row of results) {
    if (row.verdict === 'SKIP') continue;
    row.verdict = verdictOf(row.country, row.stats);
  }

  if (opts.head) {
    for (const row of results) {
      if (row.verdict === 'SKIP' || !row.country.ok) continue;
      row.country.head = await headProbe(row.country, opts);
    }
  }

  console.log(renderConsoleTable(results));
  console.log('');

  const active = results.filter((row) => row.verdict !== 'SKIP');
  const validEnough = active.filter((row) => row.stats.total >= 12).length;
  const failing = active.filter((row) => row.verdict === 'FAIL');
  console.log(`汇总：${validEnough}/${active.length} 国达到 12 条下限；${failing.length} 国失败。`);
  if (failing.length) {
    console.log('失败国家：' + failing.map((row) => `${row.country.code}(${row.country.error || '无条目'})`).join(', '));
  }

  // 落盘
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', 'T');
  const outDir = path.join(ROOT, opts.out);
  await mkdir(outDir, { recursive: true });

  const rawPayload = {
    generatedAt: new Date().toISOString(),
    mode: opts.fixture ? 'fixture' : 'network',
    fixture: opts.fixture || null,
    stamp,
    countries: active.map((row) => ({
      code: row.country.code,
      name: row.country.name,
      nameEn: row.country.nameEn,
      region: row.country.region,
      lang: row.country.lang,
      url: row.country.url,
      ok: row.country.ok,
      httpStatus: row.country.httpStatus,
      itemCount: row.stats.total,
      verdict: row.verdict,
      items: row.country.items.map((item) => ({
        title: item.title,
        link: item.link,
        source: item.source,
        publishedAt: item.publishedAt,
        linkForm: item.linkForm,
        decodedUrl: item.decodedUrl,
      })),
    })),
  };

  const rawPath = path.join(outDir, `raw-${stamp}.json`);
  await writeFile(rawPath, JSON.stringify(rawPayload, null, 2), 'utf8');
  await writeFile(path.join(outDir, 'raw-latest.json'), JSON.stringify(rawPayload, null, 2), 'utf8');

  const docsDir = path.join(ROOT, 'docs');
  await mkdir(docsDir, { recursive: true });
  const reportPath = path.join(docsDir, 'probe-report.md');
  await writeFile(reportPath, renderMarkdown(results, opts, stamp), 'utf8');

  console.log('');
  console.log(`已写出：`);
  console.log(`  ${path.relative(ROOT, reportPath)}`);
  console.log(`  ${path.relative(ROOT, rawPath)}`);
  console.log(`  ${path.relative(ROOT, path.join(outDir, 'raw-latest.json'))}`);
  console.log('');
  console.log('下一步：');
  console.log('  node src/scripts/make-pairs.mjs          # 从 raw-latest.json 生成 300 对标注候选');
  console.log('  …人工标注 label 列（1=同事件 / 0=不同事件）…');
  console.log('  node src/scripts/calibrate.mjs            # 扫阈值，输出精确率/召回率');

  if (active.length === 0 || active.every((row) => !row.country.ok)) process.exit(2);
}

main().catch((error) => {
  console.error('探测失败：', error);
  process.exit(1);
});