import test from 'node:test';
import assert from 'node:assert/strict';

import {
  articleIdOf,
  parseSigTs,
  buildFreq,
  extractUrl,
  parseBatchResponse,
} from '../../src/lib/links-new.mjs';

test('articleIdOf 从四种真实链接形态里取 id', () => {
  assert.equal(
    articleIdOf('https://news.google.com/rss/articles/CBMiVkFVX3lxTE0wcDl2?oc=5'),
    'CBMiVkFVX3lxTE0wcDl2',
  );
  assert.equal(
    articleIdOf('https://news.google.com/rss/articles/CBMiVkFVX3lxTE0wcDl2'),
    'CBMiVkFVX3lxTE0wcDl2',
  );
  assert.equal(articleIdOf('https://www.reuters.com/world/x'), null);
  assert.equal(articleIdOf(''), null);
});

test('parseSigTs 取 data-n-a-sg 与 data-n-a-ts', () => {
  const html = '<c-wiz><div data-n-a-sg="AbIaSL_SvgrmI415" data-n-a-ts="1793191996" class="x"></div></c-wiz>';
  assert.deepEqual(parseSigTs(html), { signature: 'AbIaSL_SvgrmI415', timestamp: '1793191996' });
  assert.equal(parseSigTs('<html>没有这两个属性</html>'), null);
  assert.equal(parseSigTs('<div data-n-a-sg="only-sig"></div>'), null, '缺 ts 也算失败');
});

test('buildFreq 把多条打包进一个 f.req，且字段正确', () => {
  const entries = [
    { articleId: 'CBMiAAA', signature: 'sig-a', timestamp: '1793191996' },
    { articleId: 'CBMiBBB', signature: 'sig-b', timestamp: '1793191997' },
  ];
  const encoded = buildFreq(entries, { ceid: 'US:en' });
  const parsed = JSON.parse(new URLSearchParams(encoded).get('f.req'));

  assert.equal(parsed.length, 1, '外层是一段');
  assert.equal(parsed[0].length, 2, '里面两条');
  assert.deepEqual(parsed[0][0].slice(0, 1), ['Fbv4je']);
  const inner = JSON.parse(parsed[0][0][1]);
  assert.equal(inner[0], 'garturlreq');
  assert.equal(inner[2], 'CBMiAAA');
  assert.equal(inner[3], '1793191996');
  assert.equal(inner[4], 'sig-a');
  assert.equal(inner[1][0][7], 'US:en');
});

test('parseBatchResponse 按请求顺序返回，不会所有条目都取第一个 URL', () => {
  // 这是真实踩到的 bug：整个响应只有一行 JSON 数组，
  // 早先按换行切分只得到 1 段，于是 6 条全部解析出同一个地址。
  const body =
    ")]}'\n" +
    JSON.stringify([
      ['wrb.fr', 'Fbv4je', JSON.stringify(['garturlres', 'https://www.reuters.com/a', null]), null, null, null, 'generic'],
      ['wrb.fr', 'Fbv4je', JSON.stringify(['garturlres', 'https://www.bbc.com/b', null]), null, null, null, 'generic'],
      ['wrb.fr', 'Fbv4je', null, null, null, null, 'generic'],
    ]);

  const urls = parseBatchResponse(body);
  assert.equal(urls.length, 3);
  assert.equal(urls[0], 'https://www.reuters.com/a');
  assert.equal(urls[1], 'https://www.bbc.com/b');
  assert.equal(urls[2], null, '该条没有结果');
  assert.notEqual(urls[0], urls[1], '不同条目必须拿到不同地址');
});

test('extractUrl 不会把 news.google.com 当成落地页', () => {
  const body = JSON.stringify(['garturlres', 'https://news.google.com/foo']);
  assert.equal(extractUrl(body), null);
});

test('extractUrl 能处理转义过的 URL', () => {
  const body = '["garturlres","https:\\/\\/www.example.com\\/a?b=1\\u0026c=2",null]';
  assert.equal(extractUrl(body), 'https://www.example.com/a?b=1&c=2');
});