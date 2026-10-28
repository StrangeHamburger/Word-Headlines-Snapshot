import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildEntityIndex,
  numbersOf,
  scorePair,
  isMatch,
  clusterItems,
  consensusCounts,
} from '../../src/lib/cluster.mjs';

const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `期望 ≈ ${expected}，实际 ${actual}`);

async function loadEntities() {
  const raw = await readFile(new URL('../../src/config/entities.json', import.meta.url), 'utf8');
  return buildEntityIndex(JSON.parse(raw));
}

const none = { entities: new Set(), numbers: new Set() };

// ---------------------------------------------------------------- 实体提取

test('实体提取：拉丁缩写要求词边界', async () => {
  const entitiesOf = await loadEntities();
  assert.deepEqual([...entitiesOf('Trump announces tariffs')], ['trump']);
  // "US" 不应命中 Russia
  assert.equal(entitiesOf('Russia rejects proposal').size, 0);
  // "Fed" 不应命中 federal
  assert.equal(entitiesOf('Federal court rules on case').size, 0);
  assert.deepEqual([...entitiesOf('The Fed holds rates')], ['federal-reserve']);
});

test('实体提取：CJK 别名直接匹配，大小写与全角归一化', async () => {
  const entitiesOf = await loadEntities();
  assert.deepEqual([...entitiesOf('美联储宣布加息')], ['federal-reserve']);
  assert.deepEqual([...entitiesOf('特朗普与普京会面')].sort(), ['putin', 'trump']);
  // 全角字母归一化后仍能命中
  assert.deepEqual([...entitiesOf('ＮＡＴＯ meeting')], ['nato']);
});

test('实体提取：同一条标题命中多个实体时全部返回', async () => {
  const entitiesOf = await loadEntities();
  const ids = [...entitiesOf('EU and NATO discuss Ukraine aid')].sort();
  assert.deepEqual(ids, ['european-union', 'nato', 'ukraine']);
});

// ---------------------------------------------------------------- 数字

test('数字提取与年份识别', () => {
  assert.deepEqual([...numbersOf('12 killed in 2026 storm')].sort(), ['12', '2026']);
  assert.equal(numbersOf('no digits here').size, 0);
});

// ---------------------------------------------------------------- §8.3 回归测试

test('回归：双方都有实体但实体不同时，不再需要 cos=1.0 才能匹配', () => {
  const a = { entities: new Set(['trump']), numbers: new Set() };
  const b = { entities: new Set(['putin']), numbers: new Set() };

  const signals = scorePair(1.0, a, b);
  assert.equal(signals.entityScore, 0);
  // 0.78×1.0 / (0.78+0.14) = 0.8478…
  near(signals.sim, 0.78 / 0.92);
  // cos=1.0 ≥ GATE_COS，所以门槛通过，sim ≥ 0.8 → 可匹配
  assert.equal(signals.gate, true);
  assert.equal(isMatch(signals), true);
});

test('回归：双方都无实体无数字时，不再需要 cos≥0.929', () => {
  const signals = scorePair(0.9, none, none);
  // sim 就是余弦本身，不被中性值拉低
  near(signals.sim, 0.9);
  assert.equal(signals.gate, true, 'cos 0.9 ≥ 0.86');
  assert.equal(isMatch(signals), true);
});

test('条件权重归一化：sim 恒为可用信号的加权平均', () => {
  const a = { entities: new Set(['nato']), numbers: new Set(['12']) };
  const b = { entities: new Set(['nato']), numbers: new Set(['12']) };
  const signals = scorePair(0.8, a, b);
  assert.equal(signals.entityScore, 1);
  assert.equal(signals.numberScore, 1);
  // (0.78×0.8 + 0.14×1 + 0.08×1) / 1.0
  near(signals.sim, 0.78 * 0.8 + 0.14 + 0.08);
  // cos 0.8 < 0.86，但实体全重合使 entityScore=1 ≥ 0.5，门槛应放行
  assert.equal(signals.gate, true);
  assert.equal(isMatch(signals), true);
});

test('门槛：实体或数字达到半数可绕过低余弦', () => {
  const a = { entities: new Set(['nato', 'eu']), numbers: new Set(['7']) };
  const b = { entities: new Set(['nato']), numbers: new Set(['7']) };
  const signals = scorePair(0.3, a, b);
  assert.equal(signals.entityScore, 1); // 1 / min(2,1)
  assert.equal(signals.numberScore, 1);
  assert.equal(signals.gate, true);
});

test('年份不作为"共享数字"的依据，避免同一年被误连', () => {
  const a = { entities: new Set(), numbers: new Set(['2026']) };
  const b = { entities: new Set(), numbers: new Set(['2026']) };
  const signals = scorePair(0.5, a, b);
  assert.equal(signals.numberScore, 0);
  assert.equal(signals.gate, false, 'cos 0.5 < 0.86 且没有有效实体/数字');
});

test('真实数字（非年份）仍能触发门槛', () => {
  const a = { entities: new Set(), numbers: new Set(['2026', '12']) };
  const b = { entities: new Set(), numbers: new Set(['2026', '12']) };
  const signals = scorePair(0.5, a, b);
  assert.equal(signals.numberScore, 1);
  assert.equal(signals.gate, true);
});

// ---------------------------------------------------------------- 聚类

/** 用查表余弦替代真实模型：键是 `${idA}|${idB}`（与顺序无关）。 */
function tableCosine(table) {
  return (a, b) => {
    const key = [a.id, b.id].sort().join('|');
    return table[key] ?? 0;
  };
}

test('聚类：同一事件跨三国合并，不同事件分开', () => {
  const items = [
    { id: 'us1', country: 'US', lang: 'en', title: 'Alpha event' },
    { id: 'de1', country: 'DE', lang: 'de', title: 'Alpha event DE' },
    { id: 'jp1', country: 'JP', lang: 'ja', title: 'Alpha event JP' },
    { id: 'us2', country: 'US', lang: 'en', title: 'Beta event' },
    { id: 'de2', country: 'DE', lang: 'de', title: 'Beta event DE' },
    { id: 'jp2', country: 'JP', lang: 'ja', title: 'Beta event JP' },
  ];
  const cosine = tableCosine({
    'de1|us1': 0.95, 'jp1|us1': 0.95, 'de1|jp1': 0.95,
    'de2|us2': 0.95, 'jp2|us2': 0.95, 'de2|jp2': 0.95,
    // 两组之间明确不同
    'de2|us1': 0.1, 'jp2|us1': 0.1, 'de2|jp1': 0.1, 'jp2|jp1': 0.1,
    'de1|us2': 0.1, 'jp1|us2': 0.1, 'de1|de2': 0.1, 'jp1|jp2': 0.1,
    'de1|de2': 0.1, 'us1|us2': 0.1,
  });

  const clusters = clusterItems(items, { cosine, entitiesOf: () => new Set() });
  assert.equal(clusters.length, 2);
  for (const cluster of clusters) {
    assert.equal(cluster.countries.length, 3);
    assert.equal(cluster.eligibleForConsensus, true);
    assert.ok(cluster.cohesion >= 0.95 - 1e-9);
    assert.equal(cluster.lowConfidence, false);
  }
});

test('聚类：同国多条只计 1 次，但仍留在簇成员里', () => {
  const items = [
    { id: 'us1', country: 'US', lang: 'en', title: 'Alpha' },
    { id: 'us2', country: 'US', lang: 'en', title: 'Alpha again' },
    { id: 'de1', country: 'DE', lang: 'de', title: 'Alpha DE' },
  ];
  const cosine = tableCosine({ 'de1|us1': 0.95, 'de1|us2': 0.95, 'us1|us2': 0.95 });
  const clusters = clusterItems(items, { cosine, entitiesOf: () => new Set() });

  assert.equal(clusters.length, 1);
  const cluster = clusters[0];
  assert.equal(cluster.members.length, 3);
  assert.equal(cluster.countries.length, 2, '同国去重后只有 2 个国家');
  assert.equal(cluster.counted.length, 2, '每个国家只计 1 条');
});

test('聚类：传递链导致凝聚力偏低时标 lowConfidence（§8.4 硬约束）', () => {
  // A-B、B-C 各自匹配，A-C 不匹配 → 通过传递性进同一簇，凝聚力被拉低
  const items = [
    { id: 'a', country: 'US', lang: 'en', title: 'NATO summit begins' },
    { id: 'b', country: 'DE', lang: 'de', title: 'NATO Gipfel beginnt' },
    { id: 'c', country: 'JP', lang: 'ja', title: 'NATO 首脳会議' },
  ];
  const cosine = tableCosine({ 'a|b': 0.9, 'b|c': 0.9, 'a|c': 0.2 });
  const entitiesOf = () => new Set(['nato']);

  const clusters = clusterItems(items, { cosine, entitiesOf });
  assert.equal(clusters.length, 1);
  const cluster = clusters[0];
  assert.equal(cluster.members.length, 3);
  // (0.915 + 0.915 + 0.322) / 3 ≈ 0.717 < 0.72
  near(cluster.cohesion, 0.717391, 1e-4);
  assert.equal(cluster.lowConfidence, true, '传递链应被标记为低置信');
});

test('聚类：单条簇不参与共识', () => {
  const items = [
    { id: 'a', country: 'US', lang: 'en', title: 'Only here' },
    { id: 'b', country: 'DE', lang: 'de', title: 'Different thing' },
  ];
  const clusters = clusterItems(items, { cosine: () => 0.1, entitiesOf: () => new Set() });
  assert.equal(clusters.length, 2);
  assert.equal(consensusCounts(clusters).length, 0);
});

test('聚类：同国条目之间不参与跨语言匹配', () => {
  const items = [
    { id: 'a', country: 'US', lang: 'en', title: 'Same story' },
    { id: 'b', country: 'US', lang: 'en', title: 'Same story' },
  ];
  const calls = [];
  const cosine = (x, y) => {
    calls.push([x.id, y.id]);
    return 1;
  };
  const clusters = clusterItems(items, { cosine, entitiesOf: () => new Set() });
  assert.equal(calls.length, 0, '同国对不应触发余弦计算');
  assert.equal(clusters.length, 2);
});

test('consensusCounts 只输出 ≥2 国的簇，并带凝聚力', () => {
  const items = [
    { id: 'a', country: 'US', lang: 'en', title: 'Shared' },
    { id: 'b', country: 'DE', lang: 'de', title: 'Shared DE' },
    { id: 'c', country: 'JP', lang: 'ja', title: 'Alone' },
  ];
  const cosine = tableCosine({ 'a|b': 0.95, 'a|c': 0.1, 'b|c': 0.1 });
  const clusters = clusterItems(items, { cosine, entitiesOf: () => new Set() });
  const counts = consensusCounts(clusters);
  assert.equal(counts.length, 1);
  assert.equal(counts[0].count, 2);
  assert.equal(counts[0].cohesion >= 0.95 - 1e-9, true);
});