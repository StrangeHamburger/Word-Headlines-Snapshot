/**
 * 全局阈值常量表 —— 唯一出处。
 *
 * 设计文档 §5.8 与 §8.3 规定：这些值禁止在别处就地写字面量。
 * 改任一值都必须升 ALGORITHM_VERSION，否则历史快照的偏移分位与连续天数会静默失真。
 *
 * 当前状态：T_MATCH 为初值 0.80，**尚未经真实数据校准**（放行条件 2）。
 * 校准后由 src/scripts/calibrate.mjs 输出的值替换，并注明校准日期。
 */

export const ALGORITHM_VERSION = '1.0.0-dev.1';

// ---------------------------------------------------------------- 样本与分母

/** 进入共识分母的最低条数。低于此值该国半失效。 */
export const MIN_ITEMS_VALID = 10;

/** 有效国家数下限。低于此值关闭"未包含"标记。 */
export const DENOM_MIN = 10;

/** 计算主题分布的最低条数（议程偏移）。 */
export const MIN_ITEMS_TOPIC = 12;

/** 输出"未包含"的最低条数。 */
export const MIN_ITEMS_FULL = 12;

/** 每国抓取的目标条数。 */
export const LIMIT_PER_COUNTRY = 15;

/** 抓取时每国多留的候选条数，供簇级筛查剔除后回补（§7.6.2）。 */
export const CANDIDATE_POOL_EXTRA = 10;

/** 每国展示条数。 */
export const DISPLAY_ITEMS = 3;

// ---------------------------------------------------------------- 聚类

/**
 * 事件合并阈值。
 * 待校准：目标精确率 ≥ 0.90（宁可漏，不可错）。
 * 校准命令：node src/scripts/calibrate.mjs
 */
export const T_MATCH = 0.8;

/** 高余弦直接放行。 */
export const GATE_COS = 0.86;

/** 共享实体比例达到此值直接放行。 */
export const GATE_ENTITY = 0.5;

/** 共享（非年份）数字比例达到此值直接放行。 */
export const GATE_NUMBER = 0.5;

/** 预筛门槛：余弦低于此值且实体也不重合时直接跳过该对，省算力。 */
export const PREFILTER_COS = 0.55;

/** 簇凝聚力下限。低于此值的簇不输出"未包含"，共识计数标低置信。 */
export const COHESION_MIN = 0.72;

/** 簇内至少这么多个国家才参与共识展示。 */
export const MIN_CLUSTER_COUNTRIES = 2;

// ---------------------------------------------------------------- 未包含

/** tau = max(TAU_MIN, ceil(TAU_RATIO × denominator)) */
export const TAU_RATIO = 0.4;
export const TAU_MIN = 6;

// ---------------------------------------------------------------- 跨快照

/** 与历史簇继承所需的相似度。 */
export const LINEAGE_SIM = 0.85;

/** 与历史簇继承所需的国家集合 Jaccard 下限。 */
export const LINEAGE_JACCARD = 0.5;

/** "较上次突变"的事件集合差异门槛。 */
export const SHIFT_SET = 0.7;

/** "较上次突变"的主题分布差异门槛。 */
export const SHIFT_TOPIC = 0.12;

/** 偏移分档地板。 */
export const OFFSET_T1 = 0.05;
export const OFFSET_T2 = 0.12;

/** 显示"连续 N 天"所需天数。 */
export const CONSECUTIVE_TAG = 3;

/** state/history.json 保留的 slot 数（7 天 × 2 次/天）。 */
export const RETENTION_SLOTS = 14;

// ---------------------------------------------------------------- 内容筛查

/** 单次运行 soft 命中数上限，超出告警"规则可能过宽"。 */
export const MAX_SOFT_HITS = 5;

/** review（默认）| auto。非法值按 review 处理。 */
export const SCREEN_MODE = ['review', 'auto'].includes(process.env.SCREEN_MODE)
  ? process.env.SCREEN_MODE
  : 'review';

/** 计算 tau：未包含所需的最小在报国家数。 */
export function tauFor(denominator) {
  return Math.max(TAU_MIN, Math.ceil(TAU_RATIO * denominator));
}