#!/usr/bin/env node
/**
 * 主流程（§7 → §10）。
 *
 *   node src/run.mjs --fixture tests/fixtures/feeds --offline          # 离线自检，不联网不下载模型
 *   node src/run.mjs --embed e5 --translate deepl                      # 生产
 *
 * 设计取舍：
 *   - 所有外部依赖（模型、翻译、网络）都可注入/可关闭，保证 CI 能在没有密钥的情况下跑通。
 *   - 筛查在**指标之前、按簇**做（§7.6.2）：先剔整簇，再算共识，才不会造出"某国没报"的假象。
 *   - 议程偏移与突变的完整实现留到接上历史快照之后；此处输出 null，契约允许。
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  ALGORITHM_VERSION,
  LIMIT_PER_COUNTRY,
  MIN_ITEMS_VALID,
  DENOM_MIN,
  MIN_ITEMS_FULL,
  MIN_CLUSTER_COUNTRIES,
  COHESION_MIN,
  TAU_MIN,
  DISPLAY_ITEMS,
  SCREEN_MODE,
  tauFor,
} from './lib/constants.mjs';
import { parseRss, tryDecodeOldLink, classifyLink, splitTitleSuffix, LINK_FORM } from './lib/rss.mjs';
import { createScreen } from './lib/screen.mjs';
import { buildEntityIndex, clusterItems } from './lib/cluster.mjs';
import { createEmbedder, cosine } from './lib/embed.mjs';
import { createTranslator } from './lib/translate.mjs';
import { renderHtml, findBannedWords } from './lib/render.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const opts = {
    config: 'src/config/feeds.json',
    out: 'data',
    fixture: null,
    fromRaw: null,
    offline: false,
    embed: 'stub',
    translate: 'stub',
    limit: LIMIT_PER_COUNTRY,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fixture') opts.fixture = argv[++i];
    else if (arg === '--from-raw') opts.fromRaw = argv[++i];
    else if (arg === '--offline') opts.offline = true;
    else if (arg === '--embed') opts.embed = argv[++i];
    else if (arg === '--translate') opts.translate = argv[++i];
    else if (arg === '--limit') opts.limit = Number(argv[++i]) || opts.limit;
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`
用法: node src/run.mjs [选项]

  --fixture <dir>   用本地 XML 代替网络抓取（离线自检）
  --offline         不联网、不解析链接、不下载模型
  --embed <p>       stub | tfidf | e5（默认 stub）
  --translate <p>   stub | fake | deepl | workers-ai（默认 stub）
  --limit <n>       每国保留条数（默认 15）
  --out <dir>       输出目录（默认 data）
`);
      process.exit(0);
    }
  }
  return opts;
}

const log = (...args) => {
  if (!globalThis.__quiet) console.log(...args);
};

/** 把标题变成稳定的短 id，便于前端与历史 lineage 对齐。 */
function shortHash(input) {
  return createHash('sha1').update(input).digest('hex').slice(0, 10);
}

function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function rssUrlOf(country) {
  const { hl, gl, ceid } = country.source || {};
  return `https://news.google.com/rss?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;
}

async function loadFeed(country, opts) {
  if (opts.fixture) {
    const file = path.join(ROOT, opts.fixture, `${country.code}.xml`);
    try {
      return { xml: await readFile(file, 'utf8'), httpStatus: 200, usedFallback: false };
    } catch {
      return { xml: null, httpStatus: null, usedFallback: false, error: 'fixture_missing' };
    }
  }

  const url = rssUrlOf(country);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'world-headlines-snapshot/1.0 (+https://github.com/StrangeHamburger/Word-Headlines-Snapshot)' },
      signal: AbortSignal.timeout(15000),
    });
    const xml = response.ok ? await response.text() : null;
    return { xml, httpStatus: response.status, latencyMs: Date.now() - started, usedFallback: false };
  } catch (error) {
    return {
      xml: null,
      httpStatus: null,
      latencyMs: Date.now() - started,
      usedFallback: false,
      error: String(error?.cause?.code || error?.message || error),
    };
  }
}

/** 解析结果 → 去重 → 截断。feed 与 raw 两条来源共用。 */
function buildItems(country, rawItems, opts) {
  const seen = new Set();
  const items = [];

  for (const raw of rawItems) {
    const full = normalizeTitle(raw.title);
    if (!full) continue;
    // 剥掉 Google 拼接的「 - 发布方」后缀；source 已知时更可靠（§6.3）
    const split = splitTitleSuffix(full, raw.source);
    const title = normalizeTitle(split.title) || full;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: `${country.code}:${items.length + 1}`,
      country: country.code,
      lang: country.lang,
      rank: items.length + 1,
      titleOriginal: title,
      // clusterItems 内部按 item.title 读（实体匹配、medoid 标签都依赖它）
      title,
      publisher: raw.source || split.suffix || country.name,
      googleUrl: raw.link || null,
      linkForm: raw.link ? classifyLink(raw.link) : null,
      publishedAt: raw.pubDate || null,
    });
  }

  return items.slice(0, opts.limit);
}

/** 抓取 → 解析。 */
function prepareItems(country, feed, opts) {
  const parsed = feed.xml ? parseRss(feed.xml) : { items: [] };
  return buildItems(country, parsed.items, opts);
}

/** 链接：能离线解就解，解不出按 D25 标记为不可点。 */
function resolveLinks(items, opts) {
  if (opts.offline) {
    for (const item of items) {
      item.url = null;
      item.linkDecoded = false;
    }
    return;
  }
  for (const item of items) {
    const decoded = item.googleUrl && item.linkForm === LINK_FORM.OLD_BASE64 ? tryDecodeOldLink(item.googleUrl) : null;
    item.url = decoded || item.googleUrl || null;
    item.linkDecoded = Boolean(decoded);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  globalThis.__quiet = opts.quiet;

  const feeds = JSON.parse(await readFile(path.join(ROOT, opts.config), 'utf8'));
  const countries = (feeds.countries || []).filter((country) => country.enabled !== false);

  const ruleset = JSON.parse(await readFile(path.join(ROOT, 'src/config/sensitive.json'), 'utf8'));
  const entitiesConfig = JSON.parse(await readFile(path.join(ROOT, 'src/config/entities.json'), 'utf8'));
  const entitiesOf = buildEntityIndex(entitiesConfig);
  const { screen, screenCluster } = createScreen(ruleset);

  // ---------------------------------------------------------------- 抓取
  const perCountry = [];
  let itemsRaw = 0;

  if (opts.fromRaw) {
    // 直接吃探针抓下来的 raw JSON：无需网络，可复现任何一次真实快照
    const raw = JSON.parse(await readFile(path.resolve(ROOT, opts.fromRaw), 'utf8'));
    for (const entry of raw.countries || []) {
      const country =
        countries.find((candidate) => candidate.code === entry.code) || {
          code: entry.code,
          name: entry.name || entry.code,
          lang: entry.lang || 'en',
          region: 'asia',
          order: 99,
        };
      const feed = { httpStatus: 200, usedFallback: false, latencyMs: null, xml: null };
      const items = buildItems(country, entry.items || [], opts);
      itemsRaw += items.length;
      perCountry.push({ country, feed, items });
      log(`${country.code} ${country.name}: ${items.length} 条（来自 raw）`);
    }
  } else {
    for (const country of countries) {
      const feed = await loadFeed(country, opts);
      const items = prepareItems(country, feed, opts);
      itemsRaw += items.length;
      perCountry.push({ country, feed, items });
      log(`${country.code} ${country.name}: ${items.length} 条（HTTP ${feed.httpStatus ?? 'ERR'}）`);
    }
  }

  const allItems = perCountry.flatMap((entry) => entry.items);
  log(`\n合计 ${allItems.length} 条`);

  // 链接：离线解码（纯本地），解不出就保持不可点（D25）
  resolveLinks(allItems, opts);

  // ---------------------------------------------------------------- 向量化
  const embedder = await createEmbedder({
    provider: opts.embed,
    corpus: allItems.map((item) => item.titleOriginal),
  });
  const vectors = await embedder.embed(allItems.map((item) => item.titleOriginal));
  allItems.forEach((item, index) => {
    item.vector = vectors[index];
  });
  log(`向量化完成（${embedder.name}，${embedder.dim} 维）`);

  // ---------------------------------------------------------------- 聚类
  const clusters = clusterItems(allItems, {
    cosine: (a, b) => cosine(a.vector, b.vector),
    entitiesOf,
  });
  log(`聚类完成：${clusters.length} 个簇`);

  // ---------------------------------------------------------------- 簇级筛查（指标之前）
  const droppedClusters = new Set();
  let softHits = 0;
  for (const cluster of clusters) {
    const verdict = screenCluster(cluster.members);
    if (!verdict.hit) continue;
    if (verdict.severity === 'hard') {
      droppedClusters.add(cluster);
      log(`筛查剔除一簇（hard）：${cluster.members[0]?.titleOriginal?.slice(0, 40)}…`);
    } else {
      softHits += 1;
      if (SCREEN_MODE === 'auto') droppedClusters.add(cluster);
    }
  }

  const keptClusters = clusters.filter((cluster) => !droppedClusters.has(cluster));

  // ---------------------------------------------------------------- 事件 id 与共识计数
  const validCountries = perCountry.filter((entry) => entry.items.length >= MIN_ITEMS_VALID);
  const validCodes = new Set(validCountries.map((entry) => entry.country.code));
  const denominator = validCodes.size >= DENOM_MIN ? validCodes.size : 0;

  for (const cluster of keptClusters) {
    const codes = [...new Set(cluster.members.map((member) => member.country))].filter((code) => validCodes.has(code));
    cluster.reportingCodes = codes;
    cluster.eventId = `evt_${shortHash(codes.join(',') + cluster.members.map((m) => m.titleOriginal).sort().join('|'))}`;
    cluster.clusterId = `cl_${cluster.eventId.slice(4, 12)}`;
  }

  // members 是 clusterItems 内部复制出来的对象，不能用 includes 比对引用，按 id 建索引
  const clusterByItemId = new Map();
  for (const cluster of keptClusters) {
    for (const member of cluster.members) clusterByItemId.set(member.id, cluster);
  }

  for (const item of allItems) {
    const cluster = clusterByItemId.get(item.id) || null;
    item.cluster = cluster || null;
    item.eventId = cluster ? cluster.eventId : `evt_${shortHash(item.titleOriginal)}`;
    item.consensusCount = cluster ? cluster.reportingCodes.length : 1;
    item.consensusRatio = denominator ? Number((item.consensusCount / denominator).toFixed(3)) : null;
  }

  // ---------------------------------------------------------------- 翻译（≤ 展示项 + 共识标签）
  const translator = createTranslator({ provider: opts.translate });
  const consensusCandidate = keptClusters
    .filter(
      (cluster) =>
        cluster.reportingCodes.length >= Math.max(TAU_MIN, Math.ceil(0.6 * (denominator || 1))) &&
        cluster.cohesion >= COHESION_MIN,
    )
    .sort((a, b) => b.reportingCodes.length - a.reportingCodes.length)[0];

  const translateTargets = [];
  for (const entry of perCountry) {
    const pool = entry.items.length >= MIN_ITEMS_FULL ? entry.items : [];
    const picked = [];
    const usedEvents = new Set();
    for (const item of pool) {
      // 一个事件最多占一个位置：否则同一事件的不同报道会把 3 条展示位挤满
      const key = item.eventId;
      if (usedEvents.has(key)) continue;
      usedEvents.add(key);
      picked.push(item);
      if (picked.length >= DISPLAY_ITEMS) break;
    }
    entry.displayItems = picked;
    for (const item of entry.displayItems) translateTargets.push(item);
  }
  if (consensusCandidate) translateTargets.push({ titleOriginal: consensusCandidate.label, lang: 'en' });

  const translationResult =
    translateTargets.length > 0
      ? await translator.translate(translateTargets.map((item) => ({ text: item.titleOriginal, lang: item.lang })))
      : { texts: [], provider: translator.name, chars: 0 };

  translateTargets.forEach((item, index) => {
    const translated = translationResult.texts[index] || null;
    item.titleDisplay = translated || item.titleOriginal;
  });

  if (consensusCandidate) {
    const last = translateTargets[translateTargets.length - 1];
    consensusCandidate.labelZh = last.titleDisplay || last.titleOriginal;
  }

  // ---------------------------------------------------------------- 组装每国结果
  const outputCountries = perCountry.map((entry) => {
    const { country, items, feed } = entry;
    const ok = items.length >= MIN_ITEMS_VALID;
    const displayItems = entry.displayItems || [];
    const displayIds = displayItems.map((item) => item.eventId);

    // 未包含：该国没报、但足够多国家在报的簇里挑最大的一个
    let silentEvent = null;
    if (denominator && items.length >= MIN_ITEMS_FULL) {
      const tau = tauFor(denominator);
      const candidates = keptClusters
        .filter((cluster) => !cluster.reportingCodes.includes(country.code))
        .filter((cluster) => cluster.reportingCodes.length >= tau)
        .sort((a, b) => b.reportingCodes.length - a.reportingCodes.length);
      const top = candidates[0];
      if (top) {
        silentEvent = {
          eventId: top.eventId,
          label: top.label,
          labelZh: top.labelZh || null,
          reportingCountries: top.reportingCodes.length,
          reportingCodes: top.reportingCodes,
          threshold: tau,
          confidence: Number(top.cohesion.toFixed(3)),
          partialSample: items.length < LIMIT_PER_COUNTRY,
        };
      }
    }

    return {
      code: country.code,
      name: country.name,
      region: country.region,
      status: {
        ok,
        usedFallback: Boolean(feed.usedFallback),
        httpStatus: feed.httpStatus ?? null,
        latencyMs: feed.latencyMs ?? null,
        itemsFetched: items.length,
        itemsValid: ok ? items.length : items.length,
        stale: false,
        fetchedAt: new Date().toISOString(),
        consecutiveFailures: 0,
        error: feed.error || null,
      },
      items: items.map((item) => ({
        rank: item.rank,
        eventId: item.eventId,
        clusterId: item.cluster?.clusterId || null,
        titleOriginal: item.titleOriginal,
        titleDisplay: item.titleDisplay || item.titleOriginal,
        lang: item.lang,
        translation:
          item.titleDisplay && item.titleDisplay !== item.titleOriginal
            ? { provider: translationResult.provider, target: 'zh-CN', title: item.titleDisplay, reviewed: false }
            : null,
        publisher: item.publisher,
        url: item.url,
        googleUrl: item.googleUrl,
        linkDecoded: item.linkDecoded === true,
        publishedAt: item.publishedAt,
        publishedAtSource: item.publishedAt ? 'rss' : null,
        consensusCount: item.consensusCount,
        consensusRatio: item.consensusRatio,
        isUnique: item.consensusCount <= 1,
        consecutiveDays: 0,
        matchConfidence: item.cluster ? Number(item.cluster.cohesion.toFixed(3)) : null,
        topic: null,
        topicConfidence: null,
      })),
      displayItems: displayIds,
      silentEvent,
      agendaOffset: null, // 需要历史分位，接上 state/history.json 后再填
      suddenShift: null,
    };
  });

  // 排序：region 顺序 → country.order
  const regionOrder = ['americas', 'europe', 'asia', 'oceania', 'africa'];
  outputCountries.sort((a, b) => {
    const byRegion = regionOrder.indexOf(a.region) - regionOrder.indexOf(b.region);
    if (byRegion !== 0) return byRegion;
    const orderA = countries.find((c) => c.code === a.code)?.order ?? 99;
    const orderB = countries.find((c) => c.code === b.code)?.order ?? 99;
    return orderA - orderB;
  });

  const degradedReasons = [];
  for (const entry of perCountry) {
    if (entry.items.length < MIN_ITEMS_FULL) degradedReasons.push(`${entry.country.code}:items_below_minimum`);
  }
  if (embedder.name === 'stub' || embedder.name === 'tfidf') degradedReasons.push(`embed:${embedder.name}`);

  const now = new Date();
  const slot = new Date(Math.floor(now.getTime() / (6 * 3600 * 1000)) * 6 * 3600 * 1000);

  const snapshot = {
    schemaVersion: '1.0',
    algorithmVersion: ALGORITHM_VERSION,
    model: { name: embedder.name, revision: null, quantized: opts.embed === 'e5' },
    generatedAt: now.toISOString(),
    slot: slot.toISOString(),
    timezone: 'Asia/Shanghai',
    stats: {
      countriesConfigured: perCountry.length,
      countriesValid: denominator,
      countriesFailed: perCountry.filter((entry) => entry.items.length === 0).length,
      itemsRaw,
      itemsAfterDedupe: allItems.length,
      clusters: keptClusters.length,
      degraded: degradedReasons.length > 0,
      degradedReasons,
      screening: { mode: SCREEN_MODE, droppedClusters: droppedClusters.size, softHits },
      denominator,
    },
    topConsensus: consensusCandidate
      ? {
          eventId: consensusCandidate.eventId,
          label: consensusCandidate.label,
          labelZh: consensusCandidate.labelZh || consensusCandidate.label,
          reportingCountries: consensusCandidate.reportingCodes.length,
          reportingCodes: consensusCandidate.reportingCodes,
          cohesion: Number(consensusCandidate.cohesion.toFixed(3)),
        }
      : null,
    countries: outputCountries,
  };

  // ---------------------------------------------------------------- 落盘
  const outDir = path.resolve(ROOT, opts.out);
  await mkdir(path.join(outDir, 'snapshots'), { recursive: true });

  const html = renderHtml(snapshot);
  const banned = findBannedWords(html);
  if (banned.length > 0) throw new Error(`渲染结果含禁用词：${banned.join('、')}`);

  const latestPath = path.join(outDir, 'latest.json');
  try {
    await rename(latestPath, path.join(outDir, 'previous.json'));
  } catch {
    // 首次运行没有 previous，正常
  }

  await writeFile(latestPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outDir, 'snapshots', `${slot.toISOString().replace(/[:.]/g, '')}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outDir, 'index.html'), html, 'utf8');

  log('');
  log(`有效国家 ${denominator}/${countries.length}，簇 ${keptClusters.length} 个，剔除 ${droppedClusters.size} 个`);
  log(`已写出 ${path.relative(ROOT, latestPath)} 与 data/index.html`);
  if (!consensusCandidate) log('（本次没有达到门槛的共识事件，区块不渲染）');
}

main().catch((error) => {
  console.error('运行失败：', error);
  process.exit(1);
});