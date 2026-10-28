import test from 'node:test';
import assert from 'node:assert/strict';

import { createScreen, validateRuleset } from '../../src/lib/screen.mjs';

const ruleset = {
  rules: [
    { id: 'cjk', kind: 'term', severity: 'soft', terms: ['坠机现场'], note: '中文子串' },
    { id: 'latin', kind: 'term', severity: 'soft', terms: ['beheading'] },
    { id: 'en-only', kind: 'term', severity: 'soft', langs: ['en'], terms: ['shooting'] },
    { id: 're', kind: 'regex', severity: 'soft', pattern: '(minor|underage)\\s+(victim|abuse)', flags: 'iu' },
    { id: 'hard-rule', kind: 'term', severity: 'hard', terms: ['forbidden-token'] },
  ],
  whitelist: { terms: ['whitelisted phrase'] },
};

test('CJK 用子串匹配', () => {
  const engine = createScreen(ruleset);
  assert.equal(engine.screen('某地坠机现场画面曝光', 'zh').hit, true);
  assert.equal(engine.screen('某地坠机', 'zh').hit, false);
});

test('拉丁文字用词边界，不会被更长单词误命中', () => {
  const engine = createScreen({ rules: [{ id: 'war', severity: 'soft', terms: ['war'] }] });
  assert.equal(engine.screen('War in Europe', 'en').hit, true);
  // software 里含 war，但不应命中
  assert.equal(engine.screen('New software release', 'en').hit, false);
  // 标点分隔应命中
  assert.equal(engine.screen('war, again', 'en').hit, true);
});

test('langs 限定规则的生效语言', () => {
  const engine = createScreen(ruleset);
  assert.equal(engine.screen('shooting downtown', 'en').hit, true);
  assert.equal(engine.screen('shooting downtown', 'de').hit, false);
  // 不传 lang 时只匹配通配规则
  assert.equal(engine.screen('shooting downtown').hit, false);
});

test('regex 规则可用，且坏正则不会让编译崩溃', () => {
  const engine = createScreen(ruleset);
  assert.equal(engine.screen('underage victim identified', 'en').hit, true);
  assert.equal(engine.screen('underage suspect', 'en').hit, false);

  const broken = createScreen({ rules: [{ id: 'bad', severity: 'soft', kind: 'regex', pattern: '([' }] });
  assert.equal(broken.screen('anything', 'en').hit, false);
  assert.equal(broken.ruleCount, 0);
});

test('大小写与空白归一化', () => {
  const engine = createScreen(ruleset);
  assert.equal(engine.screen('  BEHEADING   video  ', 'en').hit, true);
  // NFKC：全角字母归一化后仍能命中
  assert.equal(engine.screen('ｂｅｈｅａｄｉｎｇ', 'en').hit, true);
});

test('白名单只压 soft，压不住 hard', () => {
  const engine = createScreen(ruleset);
  const suppressed = engine.screen('beheading whitelisted phrase', 'en');
  assert.equal(suppressed.hit, false);
  assert.equal(suppressed.whitelisted, true);

  const hard = engine.screen('forbidden-token whitelisted phrase', 'en');
  assert.equal(hard.hit, true);
  assert.equal(hard.severity, 'hard');
});

test('簇级筛查：任一成员命中则整簇命中', () => {
  const engine = createScreen(ruleset);
  const cluster = [
    { title: 'Ordinary story', lang: 'en' },
    { title: '另一条普通标题', lang: 'zh' },
    { title: '坠机现场最新消息', lang: 'zh' },
  ];
  const verdict = engine.screenCluster(cluster);
  assert.equal(verdict.hit, true);
  assert.equal(verdict.matched.length, 1);

  const clean = engine.screenCluster([{ title: 'Ordinary story', lang: 'en' }]);
  assert.equal(clean.hit, false);
});

test('validateRuleset 找出结构性错误', () => {
  assert.deepEqual(validateRuleset({ rules: [] }), []);
  assert.deepEqual(
    validateRuleset({ rules: [{ id: 'a', severity: 'soft', terms: ['x'] }] }),
    [],
  );

  const problems = validateRuleset({
    rules: [
      { id: 'a', severity: 'nope', terms: ['x'] },
      { id: 'a', severity: 'soft', terms: ['y'] },
      { severity: 'soft', terms: ['z'] },
      { id: 'r', severity: 'soft', kind: 'regex', pattern: '([' },
      { id: 'e', severity: 'soft', terms: [] },
    ],
  });
  const joined = problems.join('\n');
  assert.match(joined, /severity 必须是 hard 或 soft/);
  assert.match(joined, /id 重复/);
  assert.match(joined, /缺少 id/);
  assert.match(joined, /无法编译/);
  assert.match(joined, /非空的 terms/);
});

test('仓库自带的规则文件合法，且默认不含 hard 规则', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(new URL('../../src/config/sensitive.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw);
  assert.deepEqual(validateRuleset(parsed), []);
  const hard = (parsed.rules || []).filter((rule) => rule.severity === 'hard');
  assert.equal(hard.length, 0, '默认规则集不应自动剔除任何内容');
});