import test from 'node:test';
import assert from 'node:assert/strict';

import { countryCoversCluster, pickSilentEvent } from '../../src/lib/silent.mjs';
import { cosine } from '../../src/lib/embed.mjs';

/** 造一个二维单位向量，方便手写"像/不像"。 */
function vec(x, y) {
  const length = Math.hypot(x, y);
  return [x / length, y / length];
}

const entitiesOf = () => new Set();

function clusterOf(titles, options = {}) {
  const members = titles.map((title, index) => ({
    id: `m${index}`,
    title,
    titleOriginal: title,
    country: options.country || 'US',
    vector: options.vector || vec(1, 0),
    entities: new Set(),
    numbers: new Set(),
  }));
  return {
    eventId: 'evt_test',
    label: titles[0],
    members,
    reportingCodes: options.reportingCodes || ['US', 'GB', 'DE', 'FR', 'IT', 'ES', 'BR'],
    cohesion: 0.9,
  };
}

test('本国没报时，正常给出「未包含」', () => {
  const cluster = clusterOf(['Spain train crash kills 30']);
  const items = [{ titleOriginal: 'Something else entirely', vector: vec(0, 1) }];

  const result = pickSilentEvent({
    countryCode: 'JP',
    items,
    clusters: [cluster],
    tau: 3,
    entitiesOf,
    cosine,
  });

  assert.ok(result.event, '应该给出事件');
  assert.equal(result.event.reportingCountries, 7);
  assert.equal(result.suppressed.length, 0);
});

test('本国其实报了、只是落在别的簇 —— 撤销指控', () => {
  const cluster = clusterOf(['Spain train crash kills 30']);
  const items = [
    {
      titleOriginal: 'Spain train crash kills 30',
      vector: vec(1, 0), // 与领导者几乎完全相同
    },
  ];

  const covered = countryCoversCluster(items, cluster, { entitiesOf, cosine });
  assert.ok(covered, '匹配器认为这就是同一事件，就不能说本国没报');

  const result = pickSilentEvent({
    countryCode: 'JP',
    items,
    clusters: [cluster],
    tau: 3,
    entitiesOf,
    cosine,
  });

  assert.equal(result.event, null, '撤销后不出标记');
  assert.equal(result.suppressed.length, 1);
});

test('本国条目只是话题相近 —— 仍然算没报', () => {
  const cluster = clusterOf(['Spain train crash kills 30']);
  // 正交向量：cos 0，既过不了余弦门槛也没有共享实体
  const items = [{ titleOriginal: 'Unrelated market report', vector: vec(0, 1) }];

  const result = pickSilentEvent({
    countryCode: 'JP',
    items,
    clusters: [cluster],
    tau: 3,
    entitiesOf,
    cosine,
  });

  assert.ok(result.event, '话题相近但不同事件，标记应当保留');
  assert.equal(result.suppressed.length, 0);
});

test('本国已在该簇里的不重复指控', () => {
  const cluster = clusterOf(['Spain train crash kills 30'], { reportingCodes: ['JP', 'US'] });
  const result = pickSilentEvent({
    countryCode: 'JP',
    items: [],
    clusters: [cluster],
    tau: 2,
    entitiesOf,
    cosine,
  });
  assert.equal(result.event, null);
});

test('达不到 tau 的簇不会成为指控对象', () => {
  const cluster = clusterOf(['Only two countries'], { reportingCodes: ['US', 'GB'] });
  const result = pickSilentEvent({
    countryCode: 'JP',
    items: [],
    clusters: [cluster],
    tau: 6,
    entitiesOf,
    cosine,
  });
  assert.equal(result.event, null);
});

test('多个候选中，被撤销的会跳到下一个，而不是直接放弃', () => {
  const coveredCluster = clusterOf(['Spain train crash kills 30'], {
    reportingCodes: ['US', 'GB', 'DE', 'FR', 'IT', 'ES'],
    vector: vec(1, 0),
  });
  const otherCluster = clusterOf(['Election result announced'], {
    reportingCodes: ['US', 'GB', 'DE', 'FR', 'IT'],
    vector: vec(0, 1),
  });

  const items = [{ titleOriginal: 'Spain train crash kills 30', vector: vec(1, 0) }];
  const result = pickSilentEvent({
    countryCode: 'JP',
    items,
    clusters: [coveredCluster, otherCluster],
    tau: 3,
    entitiesOf,
    cosine,
  });

  assert.ok(result.event, '最大的被撤销了，应该退而取次大的');
  assert.equal(result.event.reportingCountries, 5);
  assert.equal(result.suppressed.length, 1);
});