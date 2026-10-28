/**
 * 事件聚类：实体/数字信号 + 条件权重相似度 + 并查集（§8.2–§8.5）。
 *
 * 这个模块只依赖向量余弦（由调用方注入），不自己加载模型——
 * 这样可以在没有网络的机器上完整单测，也方便把 provider 换成 tfidf 做对照。
 *
 * 关键设计（§8.3，v1.1 修过的坑）：
 *   不用"缺失信号填 0.5 中性值"的加成式，改为**条件权重归一化**。
 *   否则"双方都有实体但是不同实体"的情形要 cos≥1.0 才能匹配（永不可能），
 *   而"双方都没实体"的情形要 cos≥0.929（几乎不可能）——语义会随信号组合反转。
 *   现在 sim 恒为可用信号的加权平均，实体约束改用显式 gate 表达。
 */

import { readFile } from 'node:fs/promises';

import {
  T_MATCH,
  GATE_COS,
  GATE_ENTITY,
  GATE_NUMBER,
  GATE_ENTITY_COS,
  GATE_NUMBER_MIN_SHARED,
  PREFILTER_COS,
  COHESION_MIN,
  MIN_CLUSTER_COUNTRIES,
} from './constants.mjs';

const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;

function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 年份权重减半（§8.2），避免"同一年的新闻"被误连。 */
function isYear(token) {
  return /^\d{4}$/.test(token) && Number(token) >= 1900 && Number(token) <= 2100;
}

// ---------------------------------------------------------------- 实体

/**
 * 把 entities.json 编译成匹配器。
 * 拉丁别名合并成一个大正则（词边界），CJK 别名走子串匹配。
 */
export function buildEntityIndex(config) {
  const aliasToId = new Map();
  const cjkAliases = [];
  const latinAliases = [];

  for (const entity of config?.entities || []) {
    const id = entity.id;
    if (!id) continue;
    for (const list of Object.values(entity.aliases || {})) {
      for (const raw of list || []) {
        const alias = normalize(raw);
        if (!alias) continue;
        aliasToId.set(alias, id);
        if (CJK_RE.test(alias)) cjkAliases.push(alias);
        else latinAliases.push(alias);
      }
    }
    // canonical 本身也算别名
    const canonical = normalize(entity.canonical);
    if (canonical && !aliasToId.has(canonical)) {
      aliasToId.set(canonical, id);
      if (CJK_RE.test(canonical)) cjkAliases.push(canonical);
      else latinAliases.push(canonical);
    }
  }

  // 长的优先，保证 "USA" 先于 "US" 命中
  latinAliases.sort((a, b) => b.length - a.length);
  cjkAliases.sort((a, b) => b.length - a.length);

  const latinRe =
    latinAliases.length > 0
      ? new RegExp(`(?<![a-z0-9])(?:${latinAliases.map(escapeRegExp).join('|')})(?![a-z0-9])`, 'gu')
      : null;

  return function entitiesOf(title) {
    const text = normalize(title);
    const ids = new Set();
    if (latinRe) {
      latinRe.lastIndex = 0;
      for (const match of text.matchAll(latinRe)) {
        const id = aliasToId.get(match[0]);
        if (id) ids.add(id);
      }
    }
    for (const alias of cjkAliases) {
      if (text.includes(alias)) {
        const id = aliasToId.get(alias);
        if (id) ids.add(id);
      }
    }
    return ids;
  };
}

/** 读取并编译实体表。 */
export async function loadEntityIndex(filePath) {
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  return buildEntityIndex(raw);
}

// ---------------------------------------------------------------- 数字

export function numbersOf(title) {
  const text = normalize(title);
  const set = new Set();
  for (const match of text.matchAll(/\d{1,4}/g)) set.add(match[0]);
  return set;
}

// ---------------------------------------------------------------- 相似度

/**
 * 计算一对条目的相似度与门槛。
 *
 * @param {number} cosine 已 L2 归一化向量的余弦，0..1
 * @param {{entities: Set<string>, numbers: Set<string>}} a
 * @param {{entities: Set<string>, numbers: Set<string>}} b
 */
export function scorePair(cosine, a, b, options = {}) {
  const gateCos = options.gateCos ?? GATE_COS;
  const gateEntity = options.gateEntity ?? GATE_ENTITY;
  const gateNumber = options.gateNumber ?? GATE_NUMBER;
  const gateEntityCos = options.gateEntityCos ?? GATE_ENTITY_COS;
  const gateNumberMinShared = options.gateNumberMinShared ?? GATE_NUMBER_MIN_SHARED;

  const bothEntities = a.entities.size > 0 && b.entities.size > 0;
  const bothNumbers = a.numbers.size > 0 && b.numbers.size > 0;

  let entityScore = 0;
  if (bothEntities) {
    let shared = 0;
    for (const id of a.entities) if (b.entities.has(id)) shared += 1;
    entityScore = shared / Math.min(a.entities.size, b.entities.size);
  }

  let numberScore = 0;
  let sharedNonYear = 0;
  if (bothNumbers) {
    let shared = 0;
    for (const token of a.numbers) {
      if (!b.numbers.has(token)) continue;
      shared += isYear(token) ? 0.5 : 1;
      if (!isYear(token)) sharedNonYear += 1;
    }
    const denom = Math.max(
      [...a.numbers].reduce((sum, t) => sum + (isYear(t) ? 0.5 : 1), 0),
      [...b.numbers].reduce((sum, t) => sum + (isYear(t) ? 0.5 : 1), 0),
    );
    numberScore = denom > 0 ? shared / denom : 0;
    // 只共享年份不算"同一个数字"，否则同一年的任意两条新闻都会被连起来
    if (sharedNonYear === 0) numberScore = 0;
  }

  let weight = 0.78;
  let weighted = 0.78 * cosine;
  if (bothEntities) {
    weight += 0.14;
    weighted += 0.14 * entityScore;
  }
  if (bothNumbers) {
    weight += 0.08;
    weighted += 0.08 * numberScore;
  }

  const sim = weight > 0 ? weighted / weight : 0;

  // 门槛分三路，但共享实体/数字都不能单独无视余弦：
  // 实体还要求余弦不低于 floor，数字还要求至少两个不重复的数字同时吻合。
  const entityGate = bothEntities && entityScore >= gateEntity && cosine >= gateEntityCos;
  const numberGate = bothNumbers && sharedNonYear >= gateNumberMinShared && numberScore >= gateNumber;
  const gate = cosine >= gateCos || entityGate || numberGate;

  return { cosine, entityScore, numberScore, sim, gate };
}

/** 是否达到合并条件（§8.3）：gate && sim ≥ T_MATCH。 */
export function isMatch(signals, threshold = T_MATCH) {
  return signals.gate && signals.sim >= threshold;
}

// ---------------------------------------------------------------- 并查集

function createUnionFind(size) {
  const parent = Array.from({ length: size }, (_, i) => i);
  const rank = new Array(size).fill(0);

  function find(x) {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else {
      parent[rb] = ra;
      rank[ra] += 1;
    }
    return true;
  }

  return { find, union };
}

// ---------------------------------------------------------------- 聚类

function meanVector(vectors) {
  if (vectors.length === 0) return null;
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dim; i += 1) out[i] += vector[i];
  }
  let norm = 0;
  for (let i = 0; i < dim; i += 1) {
    out[i] /= vectors.length;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return out;
  for (let i = 0; i < dim; i += 1) out[i] /= norm;
  return out;
}

function defaultCosine(a, b) {
  if (!a.vector || !b.vector) throw new Error('clusterItems: 未提供 cosine 时每条 item 必须有 vector');
  let dot = 0;
  for (let i = 0; i < a.vector.length; i += 1) dot += a.vector[i] * b.vector[i];
  return dot;
}

function hasEntityOverlap(a, b) {
  if (a.entities.size === 0 || b.entities.size === 0) return false;
  for (const id of a.entities) if (b.entities.has(id)) return true;
  return false;
}

/** 并查集式单链聚类：保留用于对照与历史复现，**默认不用**。 */
function groupBySingleLinkage(enriched, ctx) {
  const uf = createUnionFind(enriched.length);
  for (let i = 0; i < enriched.length; i += 1) {
    for (let j = i + 1; j < enriched.length; j += 1) {
      const a = enriched[i];
      const b = enriched[j];
      const cos = ctx.cosine(a, b);
      if (Number.isNaN(cos)) continue;
      if (cos < ctx.prefilterCos && !hasEntityOverlap(a, b)) continue;
      if (isMatch(scorePair(cos, a, b, ctx), ctx.threshold)) uf.union(i, j);
    }
  }
  const groups = new Map();
  enriched.forEach((item, index) => {
    const root = uf.find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });
  return [...groups.values()];
}

/**
 * 领导者聚类（默认）。
 *
 * 每条只与已存在的**簇代表**比较，够像才加入，否则自己当代表。
 * 于是即使 A~B、B~C 成立，只要 A≁C，C 就不会被拉进 A 的簇——
 * 传递链被结构性挡住，而不是靠 cohesion 事后打标。
 *
 * 为什么必须这样：实测 300 条真实数据（e5、T=0.80）用单链会串出一个 108 条的巨簇，
 * 页面就会宣称"20 国都在报同一件事"。这是本产品最不能犯的错。
 */
function groupByStar(enriched, ctx) {
  const clusters = [];

  for (const item of enriched) {
    let target = null;
    let best = -1;

    for (const cluster of clusters) {
      const leader = cluster.members[0];
      const cos = ctx.cosine(leader, item);
      if (Number.isNaN(cos)) continue;
      if (cos < ctx.prefilterCos && !hasEntityOverlap(leader, item)) continue;

      const signals = scorePair(cos, leader, item, ctx);
      if (!isMatch(signals, ctx.threshold)) continue;
      if (signals.sim > best) {
        best = signals.sim;
        target = cluster;
      }
    }

    if (target) target.members.push(item);
    else clusters.push({ members: [item] });
  }

  return clusters.map((cluster) => cluster.members);
}

/** 用簇内真实两两相似度算凝聚力与 medoid。 */
function describeCluster(members, ctx) {
  let simSum = 0;
  let simPairs = 0;
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const cos = ctx.cosine(members[i], members[j]);
      if (Number.isNaN(cos)) continue;
      simSum += scorePair(cos, members[i], members[j], ctx).sim;
      simPairs += 1;
    }
  }
  const cohesion = simPairs === 0 ? 1 : simSum / simPairs;

  const centroid = meanVector(members.filter((item) => item.vector).map((item) => item.vector));
  let medoid = members[0];
  if (centroid) {
    let best = -Infinity;
    for (const item of members) {
      if (!item.vector) continue;
      const score = ctx.cosine({ vector: centroid }, item);
      if (score > best) {
        best = score;
        medoid = item;
      }
    }
  }

  // 同国多条只保留最接近质心的一条参与计数（§8.4 硬约束）
  const byCountry = new Map();
  for (const item of members) {
    const score = centroid && item.vector ? ctx.cosine({ vector: centroid }, item) : 0;
    const current = byCountry.get(item.country);
    if (!current || score > current.score) byCountry.set(item.country, { item, score });
  }

  return { cohesion, medoid, counted: [...byCountry.values()].map((entry) => entry.item) };
}

/**
 * 跨国家聚类。
 *
 * @param {Array<{id:string, country:string, lang:string, title:string, vector?:number[]}>} items
 * @param {{cosine?: Function, threshold?: number, linkage?: 'star'|'single'}} options
 */
export function clusterItems(items, options = {}) {
  const ctx = {
    cosine: options.cosine || defaultCosine,
    threshold: options.threshold ?? T_MATCH,
    prefilterCos: options.prefilterCos ?? PREFILTER_COS,
    gateCos: options.gateCos,
    gateEntity: options.gateEntity,
    gateNumber: options.gateNumber,
  };

  const entitiesOf = options.entitiesOf || (() => new Set());
  const enriched = items.map((item) => ({
    ...item,
    entities: entitiesOf(item.title),
    numbers: numbersOf(item.title),
  }));

  const groups = options.linkage === 'single' ? groupBySingleLinkage(enriched, ctx) : groupByStar(enriched, ctx);

  const clusters = groups.map((members) => {
    const { cohesion, medoid, counted } = describeCluster(members, ctx);
    return {
      members,
      counted,
      countries: [...new Set(members.map((item) => item.country))],
      cohesion,
      medoid,
      label: medoid.title || medoid.titleOriginal || '',
      lowConfidence: cohesion < COHESION_MIN,
      eligibleForConsensus: counted.length >= MIN_CLUSTER_COUNTRIES,
    };
  });

  clusters.sort((a, b) => b.countries.length - a.countries.length || b.cohesion - a.cohesion);
  return clusters;
}
/** 便捷：从簇列表里取共识计数（≥2 国才算共识）。 */
export function consensusCounts(clusters) {
  return clusters
    .filter((cluster) => cluster.eligibleForConsensus)
    .map((cluster) => ({
      label: cluster.label,
      count: cluster.countries.length,
      countries: cluster.countries,
      cohesion: cluster.cohesion,
      lowConfidence: cluster.lowConfidence,
    }));
}