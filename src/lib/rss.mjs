/**
 * 零依赖 RSS 解析 + Google News 链接分类/解码。
 *
 * 只用正则，不引入 XML 库：探测与配对只需要 item 级字段，
 * 这样 probe/make-pairs 可以在任何装了 Node 20 的机器上直接跑，
 * 不需要 npm install，也不需要外网装包。
 *
 * 安全：不展开自定义实体，不解析 DTD，因此不存在 XXE / billion laughs
 * 的展开路径（我们不使用任何实体展开器）。
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  rsquo: '\u2019',
  lsquo: '\u2018',
  ldquo: '\u201C',
  rdquo: '\u201D',
};

/** 解码 XML/HTML 实体。只处理命名实体与数字实体，不做递归展开。 */
export function decodeEntities(input) {
  if (!input) return '';
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.charAt(0) === '#') {
      const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

function unwrapCdata(value) {
  const trimmed = value.trim();
  const match = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(trimmed);
  return match ? match[1] : value;
}

/** 取标签内文本：去 CDATA、解码实体、折叠空白。 */
function textOf(value) {
  if (!value) return '';
  return decodeEntities(unwrapCdata(value)).replace(/\s+/g, ' ').trim();
}

function attrOf(attrString, name) {
  if (!attrString) return '';
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrString);
  if (!match) return '';
  return decodeEntities(match[2] !== undefined ? match[2] : match[3]);
}

/**
 * 取 item 的链接。
 * 兼容三种写法：<link>text</link>、<link href="..."/>、<link href="..."></link>
 */
export function extractItemLink(block) {
  const paired = /<link\b([^>]*)>([\s\S]*?)<\/link>/i.exec(block);
  if (paired) {
    const href = attrOf(paired[1], 'href');
    if (href) return href;
    const inner = textOf(paired[2]);
    if (inner) return inner;
  }
  const selfClosed = /<link\b([^>]*?)\/>/i.exec(block);
  if (selfClosed) {
    const href = attrOf(selfClosed[1], 'href');
    if (href) return href;
  }
  return '';
}

/**
 * 解析 RSS 文档。
 * @returns {{ channelTitle: string, items: RawItem[], rawItemCount: number }}
 */
export function parseRss(xml) {
  if (typeof xml !== 'string' || xml.length === 0) {
    return { channelTitle: '', items: [], rawItemCount: 0 };
  }

  const channelMatch = /<channel\b[^>]*>([\s\S]*?)<\/channel>/i.exec(xml);
  const channelTitle = channelMatch
    ? textOf((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(channelMatch[1]) || ['', ''])[1])
    : '';

  const blocks = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRe.exec(xml)) !== null) blocks.push(match[1]);

  const items = [];
  for (const block of blocks) {
    const title = textOf((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(block) || ['', ''])[1]);
    const link = extractItemLink(block);
    const guid = textOf((/<guid\b[^>]*>([\s\S]*?)<\/guid>/i.exec(block) || ['', ''])[1]);
    const pubDateRaw = textOf((/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i.exec(block) || ['', ''])[1]);

    const sourceMatch = /<source\b([^>]*)>([\s\S]*?)<\/source>/i.exec(block);
    const source = sourceMatch ? textOf(sourceMatch[2]) : '';
    const sourceUrl = sourceMatch ? attrOf(sourceMatch[1], 'url') : '';

    const descriptionMatch = /<description\b[^>]*>([\s\S]*?)<\/description>/i.exec(block);
    const description = descriptionMatch ? textOf(descriptionMatch[1]) : '';

    let publishedAt = null;
    if (pubDateRaw) {
      const parsed = new Date(pubDateRaw);
      if (!Number.isNaN(parsed.getTime())) publishedAt = parsed.toISOString();
    }

    if (!title && !link) continue;

    items.push({
      title,
      link,
      guid,
      pubDateRaw,
      publishedAt,
      source,
      sourceUrl,
      hasDescription: description.length > 0,
    });
  }

  return { channelTitle, items, rawItemCount: blocks.length };
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export const LINK_FORM = {
  EXTERNAL: 'external',
  OLD_BASE64: 'gn-old-base64',
  NEW_AU: 'gn-new-au',
  GN_UNKNOWN: 'gn-unknown',
  INVALID: 'invalid',
};

/** 判断链接形态。用于统计 Google 链接格式是否又变了。 */
export function classifyLink(link) {
  if (!link) return LINK_FORM.INVALID;
  const url = safeUrl(link);
  if (!url) return LINK_FORM.INVALID;
  if (!/(^|\.)news\.google\.com$/i.test(url.hostname)) return LINK_FORM.EXTERNAL;

  const pathMatch = /\/rss\/articles\/([^/?#]+)/i.exec(url.pathname);
  if (!pathMatch) return LINK_FORM.GN_UNKNOWN;

  const id = pathMatch[1];
  if (/^CBMi/i.test(id)) return LINK_FORM.OLD_BASE64;
  if (/^AU_/i.test(id)) return LINK_FORM.NEW_AU;
  return LINK_FORM.GN_UNKNOWN;
}

/**
 * 取出 `/rss/articles/<id>` 的 base64 载荷。
 * @returns {{ latin: string, bytes: Buffer }|null}
 */
function decodeArticlePayload(link) {
  const url = safeUrl(link);
  if (!url) return null;
  const pathMatch = /\/rss\/articles\/([^/?#]+)/i.exec(url.pathname);
  if (!pathMatch) return null;

  const id = pathMatch[1];
  const base64 = id.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);

  let buffer;
  try {
    buffer = Buffer.from(padded, 'base64');
  } catch {
    return null;
  }
  if (buffer.length === 0) return null;
  return { latin: buffer.toString('latin1'), bytes: buffer };
}

/**
 * 提取 `CBMi...` 载荷内嵌的 `AU_...` token。
 *
 * 2024 年之后 Google 的 article id 常是「外层 CBMi 包装 + 内层 AU_ token」：
 * base64 解开后是 `\x08\x13\x22<len>AU_yqL...` 这样的 protobuf，
 * **没有明文 URL**，必须拿这个 token 去 batchexecute 才能还原真实地址。
 * 这种情况下 tryDecodeOldLink 必然返回 null，不能据此认定"链接坏了"。
 *
 * @returns {string|null}
 */
export function extractInnerToken(link) {
  const payload = decodeArticlePayload(link);
  if (!payload) return null;
  const match = /AU_[A-Za-z0-9_-]{10,}/.exec(payload.latin);
  return match ? match[0] : null;
}

/**
 * 尝试本地解码旧格式（CBMi...）链接。
 * 旧格式的 base64 载荷里明文包含原始 URL，可以直接提取，不需要发请求。
 * 若返回 null，应再用 extractInnerToken 判断是否属于"包装 AU"形态。
 * @returns {string|null} 原始 URL，失败返回 null
 */
export function tryDecodeOldLink(link) {
  const payload = decodeArticlePayload(link);
  if (!payload) return null;
  const { latin } = payload;

  const start = latin.search(/https?:\/\//i);
  if (start < 0) return null;

  let end = start;
  while (end < latin.length) {
    const code = latin.charCodeAt(end);
    if (code < 0x21 || code > 0x7e) break;
    end += 1;
  }

  const candidate = latin.slice(start, end).replace(/[),.;'"]+$/, '');
  if (candidate.length < 12) return null;

  const parsed = safeUrl(candidate);
  if (!parsed || !/^https?:$/.test(parsed.protocol)) return null;
  return parsed.href;
}

/** 从 "标题 - 发布方" 后缀里剥出发布方；与 <source> 交叉校验用。 */
export function splitTitleSuffix(title, knownSource) {
  if (!title) return { title: '', suffix: '' };
  const match = /\s[-–—]\s([^-–—]{2,60})$/.exec(title);
  if (!match) return { title, suffix: '' };
  const suffix = match[1].trim();
  if (knownSource && suffix.toLowerCase() !== knownSource.toLowerCase()) {
    return { title, suffix };
  }
  return { title: title.slice(0, match.index).trim(), suffix };
}

/** 归一化标题：用于近似重复统计（不是展示用）。 */
export function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[“”„‟«»"']/g, '')
    .trim();
}