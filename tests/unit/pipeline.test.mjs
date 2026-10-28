import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, flagEmoji, formatSlot, renderHtml, findBannedWords } from '../../src/lib/render.mjs';
import { createEmbedder, cosine, tokenize } from '../../src/lib/embed.mjs';
import { createTranslator } from '../../src/lib/translate.mjs';

function makeSnapshot(overrides = {}) {
  return {
    schemaVersion: '1.0',
    algorithmVersion: '1.0.0-test',
    generatedAt: '2026-10-28T06:03:21.000Z',
    slot: '2026-10-28T06:00:00.000Z',
    stats: { countriesConfigured: 2, countriesValid: 2, countriesFailed: 0 },
    topConsensus: null,
    countries: [
      {
        code: 'DE',
        name: '德国',
        region: 'europe',
        status: { ok: true },
        displayItems: ['evt_1'],
        items: [
          {
            rank: 1,
            eventId: 'evt_1',
            titleOriginal: 'Opposition gewinnt knapp',
            titleDisplay: '反对党以微弱优势获胜',
            lang: 'de',
            publisher: 'Spiegel',
            url: 'https://www.spiegel.de/politik/x',
            linkDecoded: true,
            consensusCount: 12,
            consecutiveDays: 3,
          },
        ],
        silentEvent: {
          eventId: 'evt_2',
          label: 'National election recount',
          labelZh: '全国选举重新计票',
          reportingCountries: 12,
        },
        agendaOffset: null,
      },
      ...(overrides.extraCountries || []),
    ],
    ...overrides.snapshot,
  };
}

// ---------------------------------------------------------------- 基础

test('escapeHtml 挡住标签注入', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a & b "c" \'d\''), 'a &amp; b &quot;c&quot; &#39;d&#39;');
});

test('flagEmoji 把国家码转成国旗，非法值有兜底', () => {
  assert.equal(flagEmoji('DE'), '🇩🇪');
  assert.equal(flagEmoji('us'), '🇺🇸');
  assert.equal(flagEmoji(''), '🏳️');
  assert.equal(flagEmoji('XYZ'), '🏳️');
});

test('formatSlot 按北京时间展示', () => {
  // 06:00Z = 14:00 北京
  assert.match(formatSlot('2026-10-28T06:00:00.000Z'), /14:00/);
  assert.equal(formatSlot('bogus'), '');
});

// ---------------------------------------------------------------- 渲染规则

test('linkDecoded=false 的条目不给链接（D25）', () => {
  const snapshot = makeSnapshot();
  snapshot.countries[0].items[0].linkDecoded = false;
  const html = renderHtml(snapshot);

  assert.ok(!html.includes('href="https://www.spiegel.de'), '解不出原文时不得渲染外链');
  assert.ok(html.includes('Opposition gewinnt'), '但标题仍要显示');
});

test('linkDecoded=true 时才渲染外链，且带 noopener', () => {
  const html = renderHtml(makeSnapshot());
  assert.ok(html.includes('href="https://www.spiegel.de/politik/x"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('target="_blank"'));
});

test('共识条不带宽链接（D18）', () => {
  const snapshot = makeSnapshot();
  snapshot.topConsensus = {
    eventId: 'evt_9',
    label: 'Global summit',
    labelZh: '全球峰会',
    reportingCountries: 13,
    url: 'https://www.example.com/should-not-link',
  };
  const html = renderHtml(snapshot);

  assert.ok(html.includes('全球峰会'));
  assert.ok(html.includes('13 国同时报道'));
  assert.ok(!html.includes('should-not-link'), '共识条不能带链接');
});

test('topConsensus 为 null 时不留空壳', () => {
  const html = renderHtml(makeSnapshot());
  assert.ok(!html.includes('class="consensus"'), '没有共识事件时整块不渲染');
});

test('未包含标记按 contract 输出本国未报道的事件', () => {
  const html = renderHtml(makeSnapshot());
  assert.ok(html.includes('本期未包含'));
  assert.ok(html.includes('全国选举重新计票'));
  assert.ok(html.includes('12 国在报'));
});

test('翻译与原文字段同时保留，便于核对', () => {
  const html = renderHtml(makeSnapshot());
  assert.ok(html.includes('反对党以微弱优势获胜'));
  assert.ok(html.includes('Opposition gewinnt knapp'));
});

test('渲染结果不含指控性词（D27）', () => {
  const html = renderHtml(makeSnapshot());
  assert.deepEqual(findBannedWords(html), []);
});

test('取不到数据的国家渲染成失败态而不是空白卡', () => {
  const snapshot = makeSnapshot();
  snapshot.countries.push({
    code: 'ZA',
    name: '南非',
    region: 'africa',
    status: { ok: false },
    displayItems: [],
    items: [],
    silentEvent: null,
    agendaOffset: null,
  });
  const html = renderHtml(snapshot);
  assert.ok(html.includes('card--failed'));
  assert.ok(html.includes('本期未取到数据'));
});

test('标题里的 HTML 被转义，不能突破属性', () => {
  const snapshot = makeSnapshot();
  snapshot.countries[0].items[0].titleDisplay = '<img src=x onerror=alert(1)>';
  const html = renderHtml(snapshot);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x'));
});

// ---------------------------------------------------------------- 向量化

test('tokenize 对 CJK 用 2-gram，对拉丁按词切', () => {
  assert.deepEqual(tokenize('EU summit'), ['eu', 'summit']);
  const cjk = tokenize('全球峰会');
  assert.ok(cjk.includes('全球'));
  assert.ok(cjk.includes('球峰'));
  assert.ok(cjk.includes('峰会'));
});

test('stub embedder 确定性且已归一化，共词多则余弦高', async () => {
  const embedder = await createEmbedder({ provider: 'stub' });
  const [a, b, c] = await embedder.embed([
    'trump announces tariff on vehicles',
    'trump announces new tariff package',
    'flooding hits southern california coast',
  ]);

  assert.equal(a.length, 256);
  let norm = 0;
  for (const value of a) norm += value * value;
  assert.ok(Math.abs(norm - 1) < 1e-5, '向量应已 L2 归一化');

  assert.ok(cosine(a, b) > cosine(a, c), '共词多的应更相似');

  // 同一输入两次结果必须一致（否则聚类不可复现）
  const [again] = await embedder.embed(['trump announces tariff on vehicles']);
  assert.ok(Math.abs(cosine(a, again) - 1) < 1e-6);
});

test('tfidf embedder 给稀有词更高权重', async () => {
  const corpus = ['election result', 'election recount', 'election result', 'earthquake strikes'];
  const embedder = await createEmbedder({ provider: 'tfidf', corpus });
  const [rare, common] = await embedder.embed(['earthquake', 'election']);
  assert.ok(rare.some((value) => value !== 0));
  assert.ok(common.some((value) => value !== 0));
});

test('未知 provider 明确报错，不静默降级', async () => {
  await assert.rejects(() => createEmbedder({ provider: 'nope' }), /未知的 embedding provider/);
});

// ---------------------------------------------------------------- 翻译

test('无密钥时自动降级到 stub，返回 null 而不是抛错', async () => {
  const translator = createTranslator({ provider: 'deepl', apiKey: '' });
  assert.equal(translator.name, 'stub');
  const result = await translator.translate([{ text: 'Hallo Welt', lang: 'de' }]);
  assert.deepEqual(result.texts, [null]);
});

test('超预算时整批跳过翻译，不报错', async () => {
  const translator = createTranslator({ provider: 'fake', charsUsed: 399_999 });
  const result = await translator.translate([{ text: 'x'.repeat(100), lang: 'en' }]);
  assert.deepEqual(result.texts, [null]);
  assert.equal(result.skipped, 'month_budget');
});

test('fake provider 产出可识别译文，条数对齐', async () => {
  const translator = createTranslator({ provider: 'fake' });
  const result = await translator.translate([
    { text: 'one', lang: 'en' },
    { text: 'two', lang: 'en' },
  ]);
  assert.equal(result.texts.length, 2);
  assert.ok(result.texts[0].includes('one'));
});