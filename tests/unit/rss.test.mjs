import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRss,
  classifyLink,
  tryDecodeOldLink,
  extractInnerToken,
  splitTitleSuffix,
  decodeEntities,
  LINK_FORM,
} from '../../src/lib/rss.mjs';

/** 构造一条旧格式（CBMi...）链接，便于往返测试。 */
function makeOldLink(url) {
  const payload = Buffer.concat([
    Buffer.from([0x08, 0x13, 0x22, Buffer.byteLength(url, 'utf8')]),
    Buffer.from(url, 'utf8'),
    Buffer.from([0x08, 0x01]),
  ]);
  const id = payload.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `https://news.google.com/rss/articles/${id}?oc=5`;
}

test('decodeEntities 处理命名实体与数字实体', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt;'), 'a & b <c>');
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
  // 未知实体原样保留，不炸
  assert.equal(decodeEntities('&unknownentity;'), '&unknownentity;');
});

test('parseRss 解析 item、CDATA 与 source', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
    <title>Top stories</title>
    <item>
      <title><![CDATA[Hello & World - Publisher]]></title>
      <link>https://example.com/a</link>
      <pubDate>Mon, 27 Oct 2026 22:10:00 GMT</pubDate>
      <source url="https://example.com">Publisher</source>
    </item>
    <item>
      <title>Second</title>
      <link>https://example.com/b</link>
    </item>
  </channel></rss>`;

  const parsed = parseRss(xml);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].title, 'Hello & World - Publisher');
  assert.equal(parsed.items[0].publishedAt, '2026-10-27T22:10:00.000Z');
  assert.equal(parsed.items[0].source, 'Publisher');
  assert.equal(parsed.items[0].sourceUrl, 'https://example.com');
  // 缺 pubDate 时为 null，不抛错
  assert.equal(parsed.items[1].publishedAt, null);
  assert.equal(parsed.items[1].source, '');
});

test('parseRss 兼容 <link href> 写法与空输入', () => {
  const xml = `<rss><channel><item><title>T</title><link href="https://x.test/p"/></item></channel></rss>`;
  assert.equal(parseRss(xml).items[0].link, 'https://x.test/p');
  assert.deepEqual(parseRss(''), { channelTitle: '', items: [], rawItemCount: 0 });
});

test('classifyLink 区分四种形态', () => {
  assert.equal(classifyLink(makeOldLink('https://a.test/x')), LINK_FORM.OLD_BASE64);
  assert.equal(classifyLink('https://news.google.com/rss/articles/AU_yqLabc?oc=5'), LINK_FORM.NEW_AU);
  assert.equal(classifyLink('https://www.spiegel.de/politik/x'), LINK_FORM.EXTERNAL);
  assert.equal(classifyLink(''), LINK_FORM.INVALID);
  assert.equal(classifyLink('not a url'), LINK_FORM.INVALID);
});

test('tryDecodeOldLink 能还原原始 URL', () => {
  const target = 'https://www.reuters.com/world/example-article-12345';
  assert.equal(tryDecodeOldLink(makeOldLink(target)), target);
  // 新格式不可离线解码
  assert.equal(tryDecodeOldLink('https://news.google.com/rss/articles/AU_yqLabc?oc=5'), null);
});

test('splitTitleSuffix 剥离已知来源后缀', () => {
  assert.deepEqual(splitTitleSuffix('Hello world - Reuters', 'Reuters'), {
    title: 'Hello world',
    suffix: 'Reuters',
  });
  // 后缀与已知来源不符时保留原样，交由上层判断
  assert.equal(splitTitleSuffix('Hello - Other', 'Reuters').title, 'Hello - Other');
  // 无后缀
  assert.equal(splitTitleSuffix('Plain title', '').title, 'Plain title');
});

/** 构造「CBMi 包装 + 内嵌 AU_ token」的链接（2024 年后的真实形态）。 */
function makeWrappedLink(token) {
  const payload = Buffer.concat([
    Buffer.from([0x08, 0x13, 0x22, Buffer.byteLength(token, 'ascii')]),
    Buffer.from(token, 'ascii'),
  ]);
  const id = payload.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `https://news.google.com/rss/articles/${id}?oc=5`;
}

test('extractInnerToken 能取回 CBMi 内嵌的 AU_ token', () => {
  const token = 'AU_yqL9Xk3mQ7vRt2Bc5Nd8Fg1Hj4Kl6';
  const link = makeWrappedLink(token);

  assert.equal(classifyLink(link), LINK_FORM.OLD_BASE64, '外层前缀仍是 CBMi');
  // 关键：这种载荷里没有明文 URL，离线解不出来是正常的
  assert.equal(tryDecodeOldLink(link), null);
  assert.equal(extractInnerToken(link), token);
});

test('extractInnerToken 对明文 URL 载荷返回 null', () => {
  const link = makeOldLink('https://www.reuters.com/world/example-12345');
  assert.equal(extractInnerToken(link), null);
});

test('extractInnerToken 对非 Google 链接与垃圾输入返回 null', () => {
  assert.equal(extractInnerToken('https://www.spiegel.de/politik/x'), null);
  assert.equal(extractInnerToken(''), null);
  assert.equal(extractInnerToken('not a url'), null);
});