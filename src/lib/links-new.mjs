/**
 * Google News 新格式链接还原（§6.4.1 第 3 步）。
 *
 * 背景（2026-10-28 实测确认）：
 *   RSS 里的链接形如 https://news.google.com/rss/articles/CBMiVkFVX3lxTE0w...
 *   base64 解开是 protobuf {1: 19, 4: "AU_yqL..."}，**里面没有明文 URL**。
 *   所以离线解码注定 0%——必须拿 token 去问 Google 的 batchexecute 接口。
 *
 * 流程（每条）：
 *   1. GET  https://news.google.com/rss/articles/<原始id>  → HTML 里取 data-n-a-sg / data-n-a-ts
 *   2. POST https://news.google.com/_/DotsSplashUi/data/batchexecute  → 得到真实 URL
 *
 * 关键约束（D25）：还原失败绝不回退到 news.google.com 当链接。
 * 这个模块只负责"能不能拿到"，拿不到就返回 null，由上层决定不渲染链接。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BATCHEXECUTE = 'https://news.google.com/_/DotsSplashUi/data/batchexecute';

/** 原始链接 → 文章 id（去掉 query 与 /rss/articles/ 前缀）。 */
export function articleIdOf(link) {
  const match = /\/rss\/articles\/([^/?#]+)/i.exec(String(link || ''));
  return match ? match[1] : null;
}

/** 从文章页 HTML 里取签名与时间戳。 */
export function parseSigTs(html) {
  const sig = /data-n-a-sg="([^"]+)"/.exec(String(html || ''));
  const ts = /data-n-a-ts="([^"]+)"/.exec(String(html || ''));
  if (!sig || !ts) return null;
  return { signature: sig[1], timestamp: ts[1] };
}

/**
 * 构造 batchexecute 的 f.req 表单值。
 * 一次可带多条，Google 会一起返回——所以 45 条只需要 1 个 POST。
 */
export function buildFreq(entries, { locale = 'en-US', gl = 'US', ceid = 'US:en' } = {}) {
  const articles = entries.map((entry) => [
    'Fbv4je',
    JSON.stringify([
      'garturlreq',
      [['X', 'X', ['X', 'X'], null, null, 1, 1, ceid, null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
      entry.articleId,
      entry.timestamp,
      entry.signature,
    ]),
  ]);
  return new URLSearchParams({ 'f.req': JSON.stringify([articles]) }).toString();
}

/**
 * 从 batchexecute 响应里抠出真实 URL。
 * 响应前面有 `)]}'` 防注入前缀，随后是嵌套 JSON 数组；这里不假设固定层级，
 * 而是递归找"像 http(s) URL 的字符串"，避免 Google 换一层包装就全崩。
 */
export function extractUrl(body) {
  const text = String(body || '').replace(/^\)\]\}'/, '');

  // 快路径：常见形态 ["garturlres","https://..."]
  const direct = /\[\\?"garturlres\\?",\\?"(https?:[^"\\]+)/.exec(text);
  if (direct) return unescapeUrl(direct[1]);

  // 慢路径：递归遍历 JSON
  try {
    const parsed = JSON.parse(text);
    const found = findHttpString(parsed);
    if (found) return unescapeUrl(found);
  } catch {
    // 响应可能是"多段 JSON 用换行分隔"，退化为正则
    const loose = /(https?:\/\/(?!news\.google\.com)[^"\\\s]+)/.exec(text);
    if (loose) return unescapeUrl(loose[1]);
  }
  return null;
}

function unescapeUrl(value) {
  return value.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\"/g, '"');
}

function findHttpString(node, depth = 0) {
  if (depth > 8 || node === null || node === undefined) return null;
  if (typeof node === 'string') {
    if (/^https?:\/\//.test(node) && !/news\.google\.com/.test(node)) return node;
    // 字符串里还嵌着 JSON
    if (node.startsWith('[') || node.startsWith('{')) {
      try {
        return findHttpString(JSON.parse(node), depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findHttpString(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const child of Object.values(node)) {
      const found = findHttpString(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'user-agent': UA,
      'accept-language': 'en-US,en;q=0.9',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
  });
  return { status: response.status, text: await response.text() };
}

/**
 * 批量还原。
 *
 * @param {Array<{link: string, id?: string}>} items
 * @returns {Promise<Map<string, {url: string|null, strategy: string, error?: string}>>}
 *          键是 item.link，值是还原结果。url 为 null 表示失败。
 */
export async function resolveArticleUrls(items, options = {}) {
  const results = new Map();
  const locale = options.locale || { locale: 'en-US', gl: 'US', ceid: 'US:en' };
  const concurrency = Math.max(1, options.concurrency ?? 6);

  const prepared = [];
  for (const item of items) {
    const articleId = articleIdOf(item.link);
    if (!articleId) {
      results.set(item.link, { url: null, strategy: 'none', error: '无法提取文章 id' });
      continue;
    }
    prepared.push({ link: item.link, articleId });
  }

  // 第 1 步：并发取签名与时间戳
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, prepared.length) }, async () => {
      while (cursor < prepared.length) {
        const entry = prepared[cursor];
        cursor += 1;
        try {
          const { status, text } = await fetchText(
            `https://news.google.com/rss/articles/${entry.articleId}`,
            { timeoutMs: options.timeoutMs },
          );
          if (status !== 200) {
            results.set(entry.link, { url: null, strategy: 'sig-ts', error: `HTTP ${status}` });
            continue;
          }
          const parsed = parseSigTs(text);
          if (!parsed) {
            results.set(entry.link, { url: null, strategy: 'sig-ts', error: '页面里没有 data-n-a-sg/ts' });
            continue;
          }
          entry.signature = parsed.signature;
          entry.timestamp = parsed.timestamp;
        } catch (error) {
          results.set(entry.link, { url: null, strategy: 'sig-ts', error: String(error?.message || error) });
        }
      }
    }),
  );

  const ready = prepared.filter((entry) => entry.signature && entry.timestamp);
  if (ready.length === 0) return results;

  // 第 2 步：一次 POST 批量换 URL（分批，避免请求体过大）
  const batchSize = options.batchSize ?? 50;
  for (let start = 0; start < ready.length; start += batchSize) {
    const batch = ready.slice(start, start + batchSize);
    try {
      const body = buildFreq(batch, locale);
      const { status, text } = await fetchText(BATCHEXECUTE, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body,
        timeoutMs: options.timeoutMs ?? 30000,
      });
      if (status !== 200) {
        for (const entry of batch) {
          results.set(entry.link, { url: null, strategy: 'batchexecute', error: `HTTP ${status}` });
        }
        continue;
      }
      // 响应按行分段，每段对应一条；顺序与请求一致
      const segments = splitResponseSegments(text);
      batch.forEach((entry, index) => {
        const url = extractUrl(segments[index] ?? text);
        results.set(entry.link, url ? { url, strategy: 'batchexecute' } : { url: null, strategy: 'batchexecute', error: '响应里没找到 URL' });
      });
    } catch (error) {
      for (const entry of batch) {
        results.set(entry.link, { url: null, strategy: 'batchexecute', error: String(error?.message || error) });
      }
    }
  }

  return results;
}

/** batchexecute 的响应是 `)]}'` + 多段 JSON，按行切成 N 段。 */
function splitResponseSegments(text) {
  const cleaned = String(text || '').replace(/^\)\]\}'/, '');
  const lines = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('['));
  return lines.length > 0 ? lines : [cleaned];
}