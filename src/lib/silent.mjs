/**
 * 「本期未包含」的诚实性守卫（§10.5）。
 *
 * 这个标记是本产品唯一会**指控某国没报道某事**的地方，也最容易出错：
 * 聚类把一个事件拆成两个簇时，A 国的报道落在簇甲、页面却在拿簇乙说"A 国没报"。
 *
 * 判据必须自洽——"没报"的判据要和"合并"的判据同源：
 * 只要本国有任何一条在匹配器眼里就是这个事件（过门槛且相似度达标），
 * 就没有资格说它没报，宁可这个标记不出。
 */

import { T_MATCH } from './constants.mjs';
import { isMatch, numbersOf, scorePair } from './cluster.mjs';

/**
 * 本国是否其实已经报了这件事。
 *
 * @param {Array} items         本国条目（需带 vector 与 titleOriginal）
 * @param {object} cluster      候选簇（members[0] 为领导者）
 * @param {object} options      { entitiesOf, cosine, threshold }
 * @returns {object|null}       命中的本国条目，没有则 null
 */
export function countryCoversCluster(items, cluster, options = {}) {
  const leader = cluster.members && cluster.members[0];
  if (!leader || !leader.vector) return null;

  const cosine = options.cosine;
  const entitiesOf = options.entitiesOf || (() => new Set());
  const threshold = options.threshold ?? T_MATCH;

  // 缓存到条目上：一趟运行里每个国家对 × 每个簇都会问到同一个条目
  const leaderEntities = leader.entities || (leader.entities = entitiesOf(leader.title || leader.titleOriginal));
  const leaderNumbers = leader.numbers || (leader.numbers = numbersOf(leader.title || leader.titleOriginal));

  for (const item of items) {
    if (!item.vector || !item.titleOriginal) continue;

    const cos = cosine(item.vector, leader.vector);
    if (Number.isNaN(cos)) continue;

    const itemEntities = item.entities || (item.entities = entitiesOf(item.titleOriginal));
    const itemNumbers = item.numbers || (item.numbers = numbersOf(item.titleOriginal));

    const signals = scorePair(
      cos,
      { entities: itemEntities, numbers: itemNumbers },
      { entities: leaderEntities, numbers: leaderNumbers },
    );

    if (isMatch(signals, threshold)) return item;
  }

  return null;
}

/**
 * 为一个国家挑选「本期未包含」事件。
 *
 * @param {object} params
 * @param {string} params.countryCode
 * @param {Array}  params.items           本国条目
 * @param {Array}  params.clusters        已筛查后的簇
 * @param {number} params.tau             入选门槛（按分母动态）
 * @param {Function} params.entitiesOf
 * @param {Function} params.cosine
 * @param {number=} params.threshold
 * @returns {{event: object|null, suppressed: string[]}}
 */
export function pickSilentEvent(params) {
  const { countryCode, items, clusters, tau } = params;
  const suppressed = [];

  const candidates = (clusters || [])
    .filter((cluster) => !(cluster.reportingCodes || cluster.countries || []).includes(countryCode))
    .filter((cluster) => (cluster.reportingCodes || cluster.countries || []).length >= tau)
    .sort((a, b) => {
      const sizeA = (a.reportingCodes || a.countries || []).length;
      const sizeB = (b.reportingCodes || b.countries || []).length;
      return sizeB - sizeA || (b.cohesion || 0) - (a.cohesion || 0);
    });

  for (const cluster of candidates) {
    const coveredBy = countryCoversCluster(items, cluster, params);
    if (coveredBy) {
      // 本国其实报了，只是落在别的簇里 —— 撤销这次指控
      suppressed.push(coveredBy.titleOriginal || cluster.eventId);
      continue;
    }

    const codes = cluster.reportingCodes || cluster.countries || [];
    const label = cluster.label || (cluster.medoid && cluster.medoid.title) || '';
    const labelZh = cluster.labelZh || null;

    return {
      event: {
        eventId: cluster.eventId,
        label,
        labelZh,
        reportingCountries: codes.length,
        reportingCodes: codes,
        threshold: tau,
        confidence: Number((cluster.cohesion || 0).toFixed(3)),
        partialSample: (items || []).length < 15,
      },
      suppressed,
    };
  }

  return { event: null, suppressed };
}